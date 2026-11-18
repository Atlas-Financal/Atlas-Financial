'use strict';
// Where the household consistently goes over plan, from saved closes only
// (owner direction, Dale, 2026-11-18; lead ruling option C on #1384).
// Forecast.categorySpendingTrends works out each category's over-plan amount
// from the saved row's planned and spent (a saved lookback row stores
// overspend null), and counts a row only when its saved plan trust
// (plannedTrust ?? trust) and its own trust are both 'calculated' and
// planned and spent are finite numbers.
//
// Real-shaped closes: one invented close is captured through captureClosing
// and projected by the store, exactly as a payday refresh saves it. Each case
// then sets that record's period, completeness and category numbers / tags.
// Every expected count and average below is worked out by hand.
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

// The saved shape this trend must read.
{
  const rows = template.content.publication.householdBudget;
  ok(template.content.kind === 'closing' && rows.length > 0, 'a real capture saves a closing record with category rows');
  ok(rows.every(row => row.overspend === null), 'a saved lookback row stores overspend null');
  ok(rows.every(row => row.trust === 'calculated' && typeof row.planned === 'number'),
    'each saved row keeps its plan amount and its stored trust');
}

// One saved close: period n (2-week cycles back from 2030-06-07), its state,
// and its rows as [id, label, planned, spent, tags].
const startOf = n => { const d = new Date(Date.UTC(2030, 5, 7)); d.setUTCDate(d.getUTCDate() - 14 * n); return d.toISOString().slice(0, 10); };
const endOf = n => { const d = new Date(startOf(n) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 13); return d.toISOString().slice(0, 10); };
function close(n, rows, { state = 'complete-at-capture', kind = 'closing', capturedAt } = {}) {
  const record = JSON.parse(JSON.stringify(template));
  record.content.kind = kind;
  record.content.period.start = startOf(n); record.content.period.end = endOf(n);
  record.content.publication.start = startOf(n); record.content.publication.end = endOf(n);
  record.content.closingState = state;
  record.capturedAt = capturedAt || endOf(n) + 'T20:00:00Z';
  const base = template.content.publication.householdBudget[0];
  record.content.publication.householdBudget = rows.map(([id, label, planned, spent, tags]) => {
    const row = { ...base, id, label, planned, spent, remaining: null, overspend: null, hold: spent, trust: 'calculated' };
    delete row.plannedTrust;
    return tags === 'untagged' ? (delete row.trust, row) : Object.assign(row, tags || {});
  });
  return record;
}
const T = history => F.categorySpendingTrends(history);
const fuel = (planned, spent, tags) => ['fuel', 'Fuel', planned, spent, tags];

// Fewer than 3 qualifying closes: no trend.
{
  ok(T(undefined).status === 'insufficient' && T([]).categories.length === 0, 'no history: insufficient, nothing listed');
  const two = T([close(1, [fuel(100, 120)]), close(2, [fuel(100, 120)])]);
  ok(two.status === 'insufficient' && two.trust === 'unavailable' && two.qualifyingCloses === 2 && two.minimum === 3,
    'two qualifying closes: insufficient, with the count (2 of 3)');
  const provisional = T([close(1, [fuel(100, 120)]), close(2, [fuel(100, 120)]), close(3, [fuel(100, 120)], { state: 'provisional' })]);
  ok(provisional.status === 'insufficient' && provisional.savedCloses === 3 && provisional.qualifyingCloses === 2,
    'a provisional close is saved but does not qualify');
  const notClosing = T([close(1, [fuel(100, 120)]), close(2, [fuel(100, 120)]), close(3, [fuel(100, 120)], { kind: 'reconstructed' })]);
  ok(notClosing.status === 'insufficient' && notClosing.savedCloses === 2, 'a reconstructed record is not a saved close');
}

// A close with no usable row does not qualify, so "No category went over
// plan" can never come from closes the trend cannot read.
{
  const older = T([close(1, [fuel(100, 90)]), close(2, [fuel(100, 90)]), close(3, [fuel(100, 90, 'untagged')])]);
  ok(older.status === 'insufficient' && older.qualifyingCloses === 2,
    'a close saved before row trust (untagged rows) does not qualify');
  const estimated = T([close(1, [fuel(100, 90)]), close(2, [fuel(100, 90)]), close(3, [fuel(100, 90, { trust: 'estimated' })])]);
  ok(estimated.status === 'insufficient' && estimated.qualifyingCloses === 2,
    'a close whose only row has an estimated plan (a carried budget) does not qualify');
  const nullPlan = T([close(1, [fuel(100, 90)]), close(2, [fuel(100, 90)]), close(3, [fuel(null, 90, { trust: 'unavailable' })])]);
  ok(nullPlan.status === 'insufficient' && nullPlan.qualifyingCloses === 2, 'a close whose only row has no plan does not qualify');
  const nullSpent = T([close(1, [fuel(100, 90)]), close(2, [fuel(100, 90)]), close(3, [fuel(100, null)])]);
  ok(nullSpent.status === 'insufficient' && nullSpent.qualifyingCloses === 2, 'a close whose only row has no spent does not qualify');
}

// Three qualifying closes. Hand arithmetic, over = max(0, spent - planned):
//   Fuel:       120 - 100 = 20.00; 90 - 100 -> 0; 110.01 - 100 = 10.01
//               -> over in 2 of 3, average (20.00 + 10.01) / 2 = 15.005 -> 15.01 (cents 3001 / 2 = 1500.5 -> 1501)
//   Groceries:  under plan in all three -> over in 0 of 3, no average
//   Eating out: 45 - 40 = 5 in close 1; missing in close 2; carried (trust estimated) in close 3 -> over in 1 of 1
//   Pets:       possible duplicate in close 1 (trust estimated, plannedTrust calculated) is not counted;
//               12 - 10 = 2 in close 2 -> over in 1 of 1, average 2
{
  const r = T([
    close(1, [fuel(100, 120), ['groceries', 'Groceries', 80, 70], ['eating-out', 'Eating out', 40, 45],
      ['pets', 'Pets', 10, 99, { trust: 'estimated', plannedTrust: 'calculated' }]]),
    close(2, [fuel(100, 90), ['groceries', 'Groceries', 80, 80], ['pets', 'Pets', 10, 12]]),
    close(3, [fuel(100, 110.01), ['groceries', 'Groceries', 80, 79.99],
      ['eating-out', 'Eating out', 40, 99, { trust: 'estimated' }]]),
  ]);
  const row = id => r.categories.find(c => c.id === id);
  ok(r.status === 'ready' && r.trust === 'calculated' && r.periodsUsed === 3, 'three qualifying closes: a calculated trend');
  ok(row('fuel').periodsOver === 2 && row('fuel').periodsCounted === 3 && row('fuel').averageOverspend === 15.01,
    'Fuel: over in 2 of 3, 15.01 over on average, worked out from saved planned and spent');
  ok(row('groceries').periodsOver === 0 && row('groceries').averageOverspend === null, 'Groceries: never over, no average');
  ok(row('eating-out').periodsCounted === 1 && row('eating-out').periodsOver === 1 && row('eating-out').averageOverspend === 5,
    'Eating out: a missing row and a carried (estimated) plan are not counted');
  ok(row('pets').periodsCounted === 1 && row('pets').averageOverspend === 2,
    'Pets: a possible duplicate (estimated spent, calculated plan) is not counted');
  ok(r.categories[0].id === 'fuel' && r.categories[r.categories.length - 1].id === 'groceries',
    'sorted by periods over, then average');
  ok(r.from === startOf(3) && r.through === endOf(1), 'the span runs from the oldest to the newest close used');
  const under = T([1, 2, 3].map(n => close(n, [fuel(100, 50)])));
  ok(under.status === 'ready' && under.categories.every(c => c.periodsOver === 0),
    'three readable closes, all under plan: ready, and nothing over plan');
}

// Window, one close per period, newest label.
{
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(n => close(n, [fuel(100, n >= 7 ? 150 : 100)]));
  eight[0].content.publication.householdBudget[0].label = 'Fuel & transit';
  const r = T(eight);
  ok(r.periodsUsed === 6 && r.qualifyingCloses === 8, 'the latest 6 of 8 qualifying closes are used');
  ok(r.categories[0].periodsOver === 0 && r.categories[0].periodsCounted === 6,
    'the two older over-plan periods fall outside the window');
  ok(r.categories[0].label === 'Fuel & transit', 'the label is the newest close\'s');
  const later = close(1, [fuel(100, 1099)], { capturedAt: endOf(1) + 'T23:00:00Z' });
  const once = T([close(1, [fuel(100, 101)]), later, close(2, [fuel(100, 101)]), close(3, [fuel(100, 101)])]);
  ok(once.periodsUsed === 3 && once.categories[0].averageOverspend === 1, 'one close per period: the first captured');
}

// Published by recommend, and printed on the page.
{
  const history = [1, 2, 3].map(n => close(n, [fuel(100, n === 2 ? 100 : 112.5), ['groceries', 'Groceries', 80, 60]]));
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
  const few = vm.runInContext('budgetCategoryTrendsHtml(ctx)', context);
  ok(/Not enough saved periods yet \(1 of 3\)/.test(few) && !/No category went over plan/.test(few),
    'with too few saved periods the page says so, with the count, and never "No category went over plan"');
  const unreadable = [close(1, [fuel(100, 90)]), close(2, [fuel(100, 90)]), close(3, [fuel(100, 90, 'untagged')])];
  context.ctx = { advice: { categorySpendingTrends: F.categorySpendingTrends(unreadable) } };
  const notEnough = vm.runInContext('budgetCategoryTrendsHtml(ctx)', context);
  ok(/Not enough saved periods yet \(2 of 3\)/.test(notEnough) && !/No category went over plan/.test(notEnough),
    'three saved closes with one unreadable: the not-enough line, never "No category went over plan"');
  context.ctx = { advice: { categorySpendingTrends: F.categorySpendingTrends([1, 2, 3].map(n => close(n, [fuel(100, 50)]))) } };
  ok(/No category went over plan/.test(vm.runInContext('budgetCategoryTrendsHtml(ctx)', context)),
    'with three readable closes all under plan, the page says no category went over plan');
  context.ctx = { advice: { categorySpendingTrends: { status: 'ready', periodsUsed: 3,
    categories: [{ id: 'x', label: 'X', periodsOver: '<b>2</b>', periodsCounted: 3, averageOverspend: 1, trust: 'calculated' }] } } };
  ok(!/<b>2<\/b>/.test(vm.runInContext('budgetCategoryTrendsHtml(ctx)', context)), 'a non-integer count is never printed');
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
