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

console.log('\n=== (ii) a page open past the household day reloads ===');
{
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const start = app.indexOf('function householdDayNow()');
  const end = app.indexOf('/* ------------------------------------------------------------------ boot */');
  assert.ok(start > 0 && end > start, 'the day watcher is present in app.js');
  let now = Date.parse('2026-08-20T20:00:00Z'); // 13:00 on Aug 20 in Vancouver (UTC-7)
  const listeners = [], intervals = [];
  let reloads = 0, visibility = 'visible';
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const ctx = vm.createContext({ Intl, Date: FakeDate, setInterval: fn => { intervals.push(fn); }, addEventListener: (n, fn) => listeners.push([n, fn]),
    document: { addEventListener: (n, fn) => listeners.push([n, fn]), get visibilityState() { return visibility; } },
    location: { reload() { reloads++; } } });
  vm.runInContext(app.slice(start, end) + '\nwatchHouseholdDay();', ctx);
  const tick = () => intervals.forEach(fn => fn());
  tick();
  ok(reloads === 0, 'same household day: no reload');
  now = Date.parse('2026-08-21T06:30:00Z'); // 23:30 Aug 20 in Vancouver: still the same household day
  tick();
  ok(reloads === 0, 'UTC midnight is not the household day: no reload at 23:30 Vancouver');
  now = Date.parse('2026-08-21T07:05:00Z'); // 00:05 on Aug 21 in Vancouver
  tick();
  ok(reloads === 1, 'past the household day: the page reloads to re-fetch', String(reloads));
  const wake = listeners.filter(([n]) => n === 'visibilitychange');
  ok(wake.length === 1, 'a tab that becomes visible again checks the day');
  reloads = 0; now = Date.parse('2026-08-20T20:00:00Z');
  const ctx2 = vm.createContext({ Intl, Date: FakeDate, setInterval: fn => intervals.push(fn), addEventListener() {},
    document: { addEventListener: (n, fn) => listeners.push([n, fn]), get visibilityState() { return visibility; } },
    location: { reload() { reloads++; } } });
  const before = listeners.length;
  vm.runInContext(app.slice(start, end) + '\nwatchHouseholdDay();', ctx2);
  now = Date.parse('2026-08-21T15:00:00Z');
  listeners.slice(before).filter(([n]) => n === 'visibilitychange').forEach(([, fn]) => fn());
  ok(reloads === 1, 'resuming the tab on the next household day reloads');
}

console.log('\n=== (iii) after a failed refresh the old balance keeps its own date ===');
{
  const html = page().render(fx.served({ unavailablePlan: true }));
  const line = (text(html).match(/Latest recorded Bills balance[^.]*\.\d\d?[^.]*\./) || [''])[0];
  const m = /Latest recorded Bills balance: (\$[\d,]+\.\d\d)(?:\s*,\s*dated ([A-Za-z]+ \d+))?/.exec(text(html));
  ok(m && m[1] === '$15.00' && m[2] === 'August 13', 'the invented $15.00 opening is dated August 13, its own row', m ? m[0] : 'no line');
  ok(!/Latest recorded Bills balance: \$15\.00\s*,\s*dated August 20/.test(text(html)), 'never the later observation date (August 20) beside the old balance');
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
