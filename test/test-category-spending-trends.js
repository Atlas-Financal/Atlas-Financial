'use strict';
// Where the household consistently goes over plan, from saved closes only
// (owner direction, Dale, 2026-11-18). Forecast.categorySpendingTrends reads
// each saved close's stored per-category `overspend`; nothing is recomputed.
// Invented household only: one real fixture close is the template, and its
// period, completeness and category rows are set per case. Every expected
// count and average below is worked out by hand.
//
// `node test/test-category-spending-trends.js`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, input } = require('./fixtures/private-period-history-input');

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

const raw = input({ day: '2030-02-16', kind: 'closing', periodStart: START });
delete raw.kind; delete raw.periodStart;
const time = raw.capturedAt; delete raw.capturedAt;
const template = Pg.project(History.captureClosing(raw, { now: () => new Date(time) }));

// One saved close: period n (2-week cycles back from 2030-06-07), its state,
// and its category rows as [id, label, overspend].
const startOf = n => { const d = new Date(Date.UTC(2030, 5, 7)); d.setUTCDate(d.getUTCDate() - 14 * n); return d.toISOString().slice(0, 10); };
const endOf = n => { const d = new Date(startOf(n) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 13); return d.toISOString().slice(0, 10); };
function close(n, rows, { state = 'complete-at-capture', kind = 'closing', capturedAt } = {}) {
  const record = JSON.parse(JSON.stringify(template));
  record.content.kind = kind;
  record.content.period.start = startOf(n); record.content.period.end = endOf(n);
  record.content.closingState = state;
  record.capturedAt = capturedAt || endOf(n) + 'T20:00:00Z';
  record.content.publication.householdBudget = rows.map(([id, label, overspend]) =>
    ({ id, label, planned: 100, spent: 100 + (typeof overspend === 'number' ? overspend : 0), overspend }));
  return record;
}
const T = history => F.categorySpendingTrends(history);

// Fewer than 3 qualifying closes: no trend.
{
  ok(T(undefined).status === 'insufficient' && T([]).categories.length === 0, 'no history: insufficient, nothing listed');
  const two = T([close(1, [['fuel', 'Fuel', 20]]), close(2, [['fuel', 'Fuel', 20]])]);
  ok(two.status === 'insufficient' && two.trust === 'unavailable' && two.qualifyingCloses === 2 && two.minimum === 3,
    'two qualifying closes: insufficient, with the count (2 of 3)');
  const provisional = T([close(1, [['fuel', 'Fuel', 20]]), close(2, [['fuel', 'Fuel', 20]]),
    close(3, [['fuel', 'Fuel', 20]], { state: 'provisional' })]);
  ok(provisional.status === 'insufficient' && provisional.savedCloses === 3 && provisional.qualifyingCloses === 2,
    'a provisional close is saved but does not qualify');
  const notClosing = T([close(1, [['fuel', 'Fuel', 20]]), close(2, [['fuel', 'Fuel', 20]]),
    close(3, [['fuel', 'Fuel', 20]], { kind: 'reconstructed' })]);
  ok(notClosing.status === 'insufficient' && notClosing.savedCloses === 2, 'a reconstructed record is not a saved close');
}

// Three qualifying closes. Hand arithmetic:
//   Fuel:      over 20.00, 0, over 10.01  -> over in 2 of 3, average (20.00 + 10.01) / 2 = 15.005 -> 15.01 (half-cent up via cents: 3001 / 2 = 1500.5 -> 1501)
//   Groceries: 0, 0, 0                    -> over in 0 of 3, no average
//   Eating out: over 5 in one, row missing in another, overspend null in the third -> over in 1 of 1
{
  const r = T([
    close(1, [['fuel', 'Fuel', 20], ['groceries', 'Groceries', 0], ['eating-out', 'Eating out', 5]]),
    close(2, [['fuel', 'Fuel', 0], ['groceries', 'Groceries', 0]]),
    close(3, [['fuel', 'Fuel', 10.01], ['groceries', 'Groceries', 0], ['eating-out', 'Eating out', null]]),
  ]);
  const row = id => r.categories.find(c => c.id === id);
  ok(r.status === 'ready' && r.trust === 'calculated' && r.periodsUsed === 3, 'three qualifying closes: a calculated trend');
  ok(row('fuel').periodsOver === 2 && row('fuel').periodsCounted === 3 && row('fuel').averageOverspend === 15.01,
    'Fuel: over in 2 of 3, 15.01 over on average (from cents)');
  ok(row('groceries').periodsOver === 0 && row('groceries').averageOverspend === null, 'Groceries: never over, no average');
  ok(row('eating-out').periodsCounted === 1 && row('eating-out').periodsOver === 1 && row('eating-out').averageOverspend === 5,
    'Eating out: a missing row and a null overspend are not counted');
  ok(r.categories[0].id === 'fuel' && r.categories[r.categories.length - 1].id === 'groceries',
    'sorted by periods over, then average');
  ok(r.from === startOf(3) && r.through === endOf(1), 'the span runs from the oldest to the newest close used');
}

// Window, one close per period, newest label.
{
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(n => close(n, [['fuel', n === 1 ? 'Fuel & transit' : 'Fuel', n >= 7 ? 50 : 0]]));
  const r = T(eight);
  ok(r.periodsUsed === 6 && r.qualifyingCloses === 8, 'the latest 6 of 8 qualifying closes are used');
  ok(r.categories[0].periodsOver === 0 && r.categories[0].periodsCounted === 6,
    'the two older over-plan periods fall outside the window');
  ok(r.categories[0].label === 'Fuel & transit', 'the label is the newest close\'s');
  const later = close(1, [['fuel', 'Fuel', 999]], { capturedAt: endOf(1) + 'T23:00:00Z' });
  const once = T([close(1, [['fuel', 'Fuel', 1]]), later, close(2, [['fuel', 'Fuel', 1]]), close(3, [['fuel', 'Fuel', 1]])]);
  ok(once.periodsUsed === 3 && once.categories[0].averageOverspend === 1, 'one close per period: the first captured');
}

// Published by recommend, and printed on the page.
{
  const history = [1, 2, 3].map(n => close(n, [['fuel', 'Fuel', n === 2 ? 0 : 12.5], ['groceries', 'Groceries', 0]]));
  const today = input({ day: '2030-06-10', kind: 'first-observed', periodStart: '2030-06-10' });
  const advice = F.recommend(today.data.plan, '2030-06-10', { debts: [], periods: [], periodHistory: history });
  ok(advice.categorySpendingTrends && advice.categorySpendingTrends.status === 'ready'
    && advice.categorySpendingTrends.categories[0].averageOverspend === 12.5, 'recommend publishes the trend');
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  context.ctx = { advice, asOf: '2030-06-10', plan: today.data.plan };
  const html = vm.runInContext('budgetCategoryTrendsHtml(ctx)', context);
  ok(/data-budget-category-trends="ready"/.test(html) && /Fuel/.test(html) && /over in 2 of 3/.test(html)
    && /\$12\.50 over on average/.test(html), 'the page lists Fuel: over in 2 of 3, $12.50 over on average');
  ok(!/Groceries/.test(html), 'a category never over plan is not listed');
  ok(!/≈|estimated/.test(html), 'no estimate mark: the figures are calculated from saved closes');
  context.ctx = { advice: { categorySpendingTrends: F.categorySpendingTrends(history.slice(0, 1)) } };
  ok(/Not enough saved periods yet \(1 of 3\)/.test(vm.runInContext('budgetCategoryTrendsHtml(ctx)', context)),
    'with too few saved periods the page says so, with the count');
  const current = advice.payPeriodViews.find(view => view.timelineRole === 'current');
  const past = advice.payPeriodViews.find(view => view.timelineRole === 'past');
  context.ctx = { advice, asOf: '2030-06-10', plan: today.data.plan };
  context.cur = current; context.past = past;
  ok(/data-budget-category-trends/.test(vm.runInContext('budgetSpendingSectionHtml(cur, ctx)', context)),
    'the household section shows it with the current period');
  ok(!/data-budget-category-trends/.test(vm.runInContext('budgetSpendingSectionHtml(past, ctx)', context)),
    'and not with a past period');
}

console.log(`All ${checks} category trend checks passed`);
