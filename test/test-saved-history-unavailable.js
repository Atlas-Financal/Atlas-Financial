'use strict';
// A3 (owner-approved audit, 1.0): past periods never silently rebuild. When the hosted
// period-history archive is in use, a completed period's saved close is expected. If it
// cannot be read (first load after a restart, a failed read, an integrity failure) the
// served document carries `periodHistoryStatus` (a fixed code only), Forecast marks each
// completed period that has no saved close `savedHistoryUnavailable`, and the Budget header
// says "Saved history unavailable. This period is rebuilt from today's plan, not the saved
// close." for that period. A rebuilt figure is never presented as the saved close. What gets
// saved is not changed. Invented data only; the real page and Forecast, no archive access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');
const Read = require('../scripts/period-history-read');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
function stubEl() {
  return { innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] };
}

// Load the Budget page scripts in index.html order.
function page() {
  const els = new Map();
  const context = vm.createContext({ Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  // In a browser window is the global object; page scripts register on it.
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), context);
  }
  // Charts need a real SVG DOM; they are not part of this surface.
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext(`globalThis.__retainedCalls = 0;
    const __retained = operatingSurfaceHtml;
    operatingSurfaceHtml = function (ctx) { globalThis.__retainedCalls++; return __retained(ctx); };
    const __active = budgetSurfaceHtml;
    budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };`, context);
  return {
    context,
    render(served) {
      context.served = served;
      // App.boot sets App.data to the served packet before renderPlan runs.
      vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
      return els.get('operating-surface-body').innerHTML;
    },
    rerender(js) { return vm.runInContext(`${js}; budgetSurfaceHtml(__ctx)`, context); },
  };
}

(async () => {

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const NOTICE = /Saved history unavailable\. This period is rebuilt from today's plan, not the saved close\./;
const NOTICE_HTML = /data-budget-saved-history-unavailable/;

// Render the page, then show one period by id through the real window header.
function showing(data, pick) {
  const p = page();
  p.render(data);
  const views = p.context.__ctx.advice.payPeriodViews;
  const view = pick(views);
  const html = p.rerender(`__ctx.planPayPeriodId = ${JSON.stringify(view.id)}`);
  return { html, view, views, p };
}
const past = views => views.filter(v => v.timelineRole === 'past').at(-1);
const current = views => views.find(v => v.timelineRole === 'current');

console.log('\n=== a read failure is stated on every completed period ===');
{
  const data = fx.served();
  data.periodHistoryStatus = { status: 'unavailable', reason: 'history-read-failed' };
  const { html, view, views } = showing(data, past);
  ok(view.timelineRole === 'past' && view.savedHistoryUnavailable?.status === 'unavailable'
    && view.savedHistoryUnavailable.reason === 'history-read-failed',
  'Forecast marks the completed period as having no saved history', JSON.stringify(view.savedHistoryUnavailable));
  ok(NOTICE_HTML.test(html) && NOTICE.test(text(html)), 'the Budget page says Saved history unavailable for the selected period, above the surface (not in the hidden window header)',
    (text(html).match(/Saved history[^.]*\./) || [''])[0]);
  ok(!/data-budget-captured-close/.test(html) && !/Shown as captured when this period closed/.test(html),
    'the rebuild is never presented as the saved close');
  ok(views.filter(v => v.timelineRole === 'past').every(v => v.savedHistoryUnavailable?.status === 'unavailable'),
    'every completed period without a saved close carries the marker');
  const now = showing(data, current);
  ok(!now.view.savedHistoryUnavailable && !NOTICE_HTML.test(now.html), 'the current period, which is live and never a saved close, carries no notice');
}

console.log('\n=== control: no status, no notice ===');
{
  const { html, view } = showing(fx.served(), past);
  ok(!view.savedHistoryUnavailable && !NOTICE_HTML.test(html), 'archive off or read fine: no marker and no notice');
}

console.log('\n=== only a fixed code can reach the page ===');
{
  const data = fx.served();
  data.periodHistoryStatus = { status: 'unavailable', reason: 'Bearer PRIVATE-text' };
  const { html, view } = showing(data, past);
  ok(view.savedHistoryUnavailable.reason === 'history-unavailable' && !html.includes('PRIVATE'),
    'an unrecognised reason becomes a fixed code and no raw text is printed', view.savedHistoryUnavailable.reason);
  const ready = fx.served();
  ready.periodHistoryStatus = { status: 'read' };
  ok(!showing(ready, past).view.savedHistoryUnavailable, 'any status other than unavailable marks nothing');
}

console.log('\n=== a period that has a saved close never reads as unavailable ===');
{
  const data = fx.served();
  data.periodHistoryStatus = { status: 'unavailable', reason: 'history-read-failed' };
  const { html } = showing(data, past);
  const closed = html.replace(/<p class="note-box budget-saved-history-unavailable"[^>]*>[^<]*<\/p>/, '');
  ok(NOTICE_HTML.test(html) && !NOTICE_HTML.test(closed), 'control: the notice is exactly that one paragraph');
  const p = page(); p.render(data);
  const target = past(p.context.__ctx.advice.payPeriodViews);
  const withClose = p.rerender(`(() => { const v = __ctx.advice.payPeriodViews.find(x => x.id === ${JSON.stringify(target.id)});
    v.capturedClose = { source: 'period-history', kind: 'closing', capturedAt: '2026-08-14T12:00:00.000Z', closingState: 'complete-at-capture' };
    __ctx.planPayPeriodId = v.id; })()`);
  ok(!NOTICE_HTML.test(withClose), 'a completed period that does have its saved close prints no unavailable notice');
}

console.log('\n=== the archive reader states the failure on the served document ===');
{
  const doc = { meta: { asOf: '2026-10-14' } };
  const failing = Read.create({ env: { ATLAS_PERIOD_HISTORY_CAPTURE: 'on' }, openStore: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'history-integrity-failed' }); }, log: () => {} });
  const first = failing.withHistory(doc);
  ok(first.periodHistoryStatus?.reason === 'history-not-loaded', 'first load after a restart: not loaded yet', JSON.stringify(first.periodHistoryStatus));
  await new Promise(resolve => setTimeout(resolve, 20));
  const later = failing.withHistory(doc);
  ok(later.periodHistoryStatus?.reason === 'history-integrity-failed' && !JSON.stringify(later).includes('PRIVATE'),
    'an integrity failure is stated by its fixed code only', JSON.stringify(later.periodHistoryStatus));
  const off = Read.create({ env: {}, openStore: async () => { throw new Error('never'); }, log: () => {} });
  ok(off.withHistory(doc) === doc, 'archive off: the document is untouched (no history is expected)');
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');

})();
