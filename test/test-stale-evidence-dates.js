'use strict';
// A1 (owner-approved audit, 1.0): stale evidence must never read as "Now" or "today".
// The CI half of test/browser-stale-evidence-never-now.js, in the page harness, invented
// data only: (i) a dated/retained view marks its evidence day (the chip reads "As of",
// public/budget-blend.js), a fresh one does not; (ii) a page open past the household
// day (America/Vancouver) reloads, the same day does not, and a stale feed served for
// an older day cannot loop it; (iii) after a failed refresh the Bills balance is dated
// by its own row. Expected values are the fixture's own literals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');

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


const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

console.log('\n=== (i) a dated view marks its evidence day; a fresh one does not ===');
{
  const fresh = fx.served();
  const freshHtml = page().render(fresh);
  ok(!/data-budget-evidence-dated/.test(freshHtml), 'a fresh answer carries no dated-view marker (the chip stays Now)');
  const stale = JSON.parse(JSON.stringify(fresh));
  stale.liveOverlay.currentPeriodActuals.lastSuccessfulSyncAt = '2026-08-17T17:55:00.000Z';
  stale.liveOverlay.retainedRefresh = { source: 'provider', qualified: false, observedAt: '2026-08-17T17:55:00.000Z',
    checkedAt: '2026-08-20T18:00:00.000Z', reason: 'stale-live-cash-evidence' };
  const staleHtml = page().render(stale);
  ok(/data-budget-evidence-dated="2026-08-20"/.test(staleHtml), 'a retained/dated answer marks its evidence day for the chip', (staleHtml.match(/data-budget-evidence-dated[^>]*/) || [''])[0]);
  ok(/Last updated[^<]*Aug(ust)? 17/.test(text(staleHtml)) && !/Last updated[^<]*Aug(ust)? 20/.test(text(staleHtml)),
    'Last updated is the older sync day, never the observation day', (text(staleHtml).match(/Last updated[^.]{0,40}/) || [''])[0]);
  // The blend script reads the marker; assert it is wired to the chip and to nothing else.
  const blend = fs.readFileSync(path.join(ROOT, 'public/budget-blend.js'), 'utf8');
  ok(/data-budget-evidence-dated/.test(blend) && /'As of '/.test(blend) && /: 'Now'/.test(blend),
    'budget-blend.js prints As of <day> for a dated view and Now only otherwise');
}

console.log('\n=== (ii) a page open past the household day marks itself dated; it never reloads or fetches by itself ===');
{
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const start = app.indexOf('function householdDayNow()');
  const end = app.indexOf('/* ------------------------------------------------------------------ boot */');
  assert.ok(start > 0 && end > start, 'the day watcher is present in app.js');
  let now = Date.parse('2026-08-20T20:00:00Z'); // 13:00 on Aug 20 in Vancouver (UTC-7)
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  // A tiny document: enough DOM for the chip, the notice and its button.
  function world() {
    const listeners = [], intervals = [], inserted = [], attrs = {};
    let reloads = 0, fetches = 0, visibility = 'visible';
    const chip = { textContent: 'Now', attrs: {}, hasAttribute(n) { return n in this.attrs; }, setAttribute(n, v) { this.attrs[n] = v; } };
    const el = tag => ({ tag, children: [], attrs: {}, className: '', textContent: '', listeners: {},
      setAttribute(n, v) { this.attrs[n] = v; }, append(...n) { this.children.push(...n); },
      addEventListener(n, fn) { this.listeners[n] = fn; } });
    const document = {
      documentElement: { setAttribute(n, v) { attrs[n] = v; }, getAttribute: n => attrs[n] || '' },
      body: { firstChild: null, insertBefore(node) { inserted.push(node); } },
      createElement: el, createTextNode: text => ({ text }),
      querySelector: sel => sel === '.blend-now' ? chip : sel === '[data-page-day-notice]' ? inserted[0] || null : null,
      addEventListener: (n, fn) => listeners.push([n, fn]), get visibilityState() { return visibility; } };
    const ctx = vm.createContext({ Intl, Date: FakeDate, setInterval: fn => { intervals.push(fn); }, addEventListener: (n, fn) => listeners.push([n, fn]),
      fetch() { fetches++; return Promise.reject(new Error('no request expected')); }, XMLHttpRequest: function () { fetches++; },
      document, location: { reload() { reloads++; } } });
    vm.runInContext(app.slice(start, end) + '\nwatchHouseholdDay();', ctx);
    return { listeners, intervals, inserted, attrs, chip, counts: () => ({ reloads, fetches }), setVisible: v => { visibility = v; } };
  }
  const w = world();
  const tick = () => w.intervals.forEach(fn => fn());
  tick();
  ok(w.inserted.length === 0 && !w.attrs['data-page-day-passed'], 'same household day: nothing is marked');
  now = Date.parse('2026-08-21T06:30:00Z'); // 23:30 Aug 20 in Vancouver: still the same household day
  tick();
  ok(w.inserted.length === 0, 'UTC midnight is not the household day: nothing at 23:30 Vancouver');
  // The tab is HIDDEN when the household day changes (nobody is there): no request, no reload, and
  // nothing visible is needed yet.
  w.setVisible('hidden');
  now = Date.parse('2026-08-21T07:05:00Z'); // 00:05 on Aug 21 in Vancouver
  tick();
  ok(w.counts().reloads === 0 && w.counts().fetches === 0, 'a hidden tab across the household day makes no request and does not reload', JSON.stringify(w.counts()));
  ok(w.attrs['data-page-day-passed'] === '2026-08-20', 'the page marks itself as from the day it loaded', String(w.attrs['data-page-day-passed']));
  ok(w.chip.textContent === 'As of Aug 20' && w.chip.attrs['data-blend-now-dated'] === '2026-08-20', 'the chip reads As of Aug 20, not Now', w.chip.textContent);
  const notice = w.inserted[0];
  const text = node => node.text !== undefined ? node.text : [node.textContent || '', ...(node.children || []).map(text)].join('');
  ok(notice && /^This page is from Aug 20\. Reload for today$/.test(text(notice)) && notice.attrs['data-page-day-notice'] === '2026-08-20',
    'a visible notice says This page is from Aug 20 and offers Reload for today', notice ? text(notice) : 'none');
  // Coming back to the tab shows it (already shown) and still reloads nothing.
  w.setVisible('visible');
  w.listeners.filter(([n]) => n === 'visibilitychange').forEach(([, fn]) => fn());
  tick(); tick();
  ok(w.inserted.length === 1 && w.counts().reloads === 0 && w.counts().fetches === 0,
    'returning to the tab, and every later tick, add no second notice, no reload and no request', JSON.stringify(w.counts()));
  // Only a click reloads.
  const button = notice.children.find(child => child.tag === 'button');
  ok(button && button.attrs['data-page-day-reload'] === '' && typeof button.listeners.click === 'function', 'the notice carries a Reload button');
  button.listeners.click();
  ok(w.counts().reloads === 1, 'a click on Reload for today reloads, once', String(w.counts().reloads));
  // A tab resumed on the next day, with no timer ever having fired, shows the notice and does not reload.
  now = Date.parse('2026-08-20T20:00:00Z');
  const w2 = world();
  now = Date.parse('2026-08-21T15:00:00Z');
  w2.listeners.filter(([n]) => n === 'visibilitychange').forEach(([, fn]) => fn());
  ok(w2.inserted.length === 1 && w2.counts().reloads === 0 && w2.counts().fetches === 0,
    'resuming the tab on the next household day shows the notice and does not reload', JSON.stringify(w2.counts()));
  // A chip that already reads a dated As of keeps its older evidence day.
  now = Date.parse('2026-08-20T20:00:00Z');
  const w3 = world();
  w3.chip.textContent = 'As of Aug 17'; w3.chip.attrs['data-blend-now-dated'] = '2026-08-17';
  now = Date.parse('2026-08-21T15:00:00Z');
  w3.listeners.filter(([n]) => n === 'visibilitychange').forEach(([, fn]) => fn());
  ok(w3.chip.textContent === 'As of Aug 17', 'a dated chip keeps its older evidence day', w3.chip.textContent);
  // A re-render after the day passed must not read Now again (the blend reads the page marker).
  const blend = fs.readFileSync(path.join(ROOT, 'public/budget-blend.js'), 'utf8');
  ok(/data-page-day-passed/.test(blend) && /markedDay < passedDay/.test(blend), 'budget-blend.js reads the page marker, so a re-render stays dated');
  ok(!/location\.reload\(\)\s*;?\s*}\s*;?\s*\n\s*if \(typeof document/.test(app) && !/const check = \(\) => \{[^}]*location\.reload/.test(app),
    'the timer and visibility handlers never call location.reload');
}

console.log('\n=== (iii) after a failed refresh the old balance keeps its own date ===');
{
  const html = page().render(fx.served({ unavailablePlan: true }));
  const line = (text(html).match(/Latest recorded Bills balance[^.]*\.\d\d?[^.]*\./) || [''])[0];
  const m = /Latest recorded Bills balance: (\$[\d,]+\.\d\d)(?:\s*,\s*dated ([A-Za-z]+ \d+))?/.exec(text(html));
  ok(m && m[1] === '$15.00' && m[2] === 'August 13', 'the invented $15.00 opening is dated August 13, its own row', m ? m[0] : 'no line');
  ok(!/Latest recorded Bills balance: \$15\.00\s*,\s*dated August 20/.test(text(html)), 'never the later observation date (August 20) beside the old balance');
}

console.log('\n=== (iii-b) with no plan opening date, a mismatched observation never lends its date ===');
{
  // The plan's Bills value is 15.00 with no opening date; a different observation (20.00) is dated Aug 20.
  // The old value never borrows that date: its date is unavailable, and so is the balance it would carry.
  const data = fx.canonical();
  delete data.plan.opening;
  const bills = data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a');
  const out = F.billsAccountPeriodBalance(data.plan, '2026-08-20',
    { observedCash: { accounts: [{ accountId: 'chequing-a', value: bills.value + 5, evidenceDate: '2026-08-20' }] } });
  ok(out.status === 'unavailable' && out.observedAsOf == null, 'the old balance carries no date at all (never August 20)', String(out.observedAsOf));
  ok((out.issues || []).some(row => row.code === 'bills-cash-unavailable') && (out.issues || []).some(row => row.code === 'cash-observation-misaligned'),
    'it says why: a dated posted Bills balance is unavailable and the observation does not match');
  // Control: with the opening date present, the old value is dated by its own row.
  const withOpening = fx.canonical();
  const dated = F.billsAccountPeriodBalance(withOpening.plan, '2026-08-20',
    { observedCash: { accounts: [{ accountId: 'chequing-a', value: withOpening.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value + 5, evidenceDate: '2026-08-20' }] } });
  ok(dated.observedAsOf === withOpening.plan.opening.asOf && dated.observedAsOf !== '2026-08-20', 'control: with an opening date it is that date, still never August 20', String(dated.observedAsOf));
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
