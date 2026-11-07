'use strict';
// C1 (acceptance 7.6): a dropped household row withholds the one budget
// category it belongs to, and every total that sums it, never a precise
// figure missing the row. Any doubt about the row's category keeps main's
// global withhold. Invented household from test/acceptance/harness.js,
// through the real observer (scripts/provider-observe.js via live-plan) and
// Forecast; no household figure enters this file.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

const DROP = { date: '2026-10-11', amount: 'unavailable', category: 'Groceries', payee: 'Invented grocer B',
  originalName: 'INVENTED GROCER B 4521' };
function run(extra, patch) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ date: '2026-10-10', amount: 40, category: 'Groceries', payee: 'Invented grocer A' }),
    H.lm({ date: '2026-10-12', amount: 25.5, category: 'Restaurants', payee: 'Invented diner' }),
    ...extra.map(fields => H.lm(fields))];
  if (patch) patch(w);
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null, 'the observation is applied');
  const opts = { debts: data.debts, currentPeriodActuals: packet };
  const advice = F.recommend(data.plan, w.asOf, opts);
  const period = advice.payPeriodViews.find(r => r.start === '2026-10-09');
  const action = F.currentPeriodAction(data.plan, w.asOf, opts);
  const row = id => period.householdBudget.find(r => r.id === id);
  return { packet, period, action, row, advice };
}
// Every total that sums Groceries. Hand expectation: none is a number.
function totalsUnknown(r, why) {
  assert.equal(r.period.balanceAfterDeductions ?? null, null, why + ': Balance After Deductions is not a number');
  assert.equal(r.period.balanceAfterDeductionsTrust, 'unavailable', why + ': Balance After Deductions is Unknown');
  assert.equal(r.period.budgetProgress.household.actual.amount, null, why + ': the Household total is Unknown');
  assert.equal(r.period.budgetProgress.household.actual.trust, 'unavailable');
  assert.equal(r.period.afterHouseholdBudget ?? null, null, why + ': the household remainder is not a number');
  assert.notEqual(r.period.fromTodayFunding.status, 'ready', why + ': From-today funding is not published');
  assert.equal(r.period.fromTodayFunding.availableNow ?? null, null, why + ': available now is not a number');
  assert.equal(r.action.remainingClaim, 'unavailable', why + ': the payday category remaining is withheld');
  const groceries = (r.action.categories || []).find(c => c.id === 'groceries');
  assert.ok(!groceries || groceries.remaining == null, why + ': payday Groceries remaining is not a number');
  const later = r.advice.payPeriodViews.filter(v => v.start > '2026-10-09');
  assert.ok(later.length > 0 && later.every(v => v.balanceAfterDeductionsTrust !== 'calculated'),
    why + ': the forward walk never reads the withheld hold as calculated');
}
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== C1. a dropped row with a certain category withholds that category only ===');
const base = run([]);
check('control: with no drop, every figure is precise', () => {
  assert.equal(base.packet.transactionCoverage, 'complete');
  assert.equal(base.packet.droppedCategoryRows, undefined);
  assert.equal(base.row('groceries').spent, 40);
  assert.equal(base.row('restaurants').spent, 25.5);
  assert.equal(base.period.budgetProgress.household.actual.amount, 65.5);
});
const local = run([DROP]);
check('the stamp still reads incomplete and names only the dropped category', () => {
  assert.equal(local.packet.transactionCoverage, 'incomplete', 'never "complete" with a dropped row');
  assert.equal(local.packet.coverageExceptCategories, true);
  assert.deepEqual(local.packet.droppedCategoryRows, [{ date: '2026-10-11', categoryId: 'groceries', reason: 'amount-unreadable' }]);
});
check('privacy: droppedCategoryRows carries no amount, payee, merchant or provider id', () => {
  for (const row of local.packet.droppedCategoryRows) assert.deepEqual(Object.keys(row).sort(), ['categoryId', 'date', 'reason']);
  const blob = JSON.stringify(local.packet.droppedCategoryRows);
  for (const leak of ['Invented grocer B', 'INVENTED GROCER B', '4521', '"unavailable"', 'payee', 'merchant', 'providerTransactionId', 'tx-'])
    assert.ok(!blob.includes(leak), 'no ' + leak);
});
check('Groceries is Unknown; Eating out (25.50 of 100) stays precise', () => {
  const g = local.row('groceries'), e = local.row('restaurants');
  assert.equal(g.spent, null); assert.equal(g.remaining, null); assert.equal(g.overspend, null);
  assert.equal(g.withheldReason, 'dropped-row');
  assert.equal(e.spent, 25.5); assert.equal(e.remaining, 74.5);
});
check('every total that sums Groceries is Unknown', () => totalsUnknown(local, 'localised drop'));
// The same totals under main's global withhold (an undated drop): identical,
// so localising moves no total, only the unaffected category rows.
const global = run([{ ...DROP, date: 'not-a-date' }]);
check('totals equal the global withhold exactly', () => {
  for (const key of ['balanceAfterDeductions', 'balanceAfterDeductionsTrust', 'afterHouseholdBudget'])
    assert.deepEqual(local.period[key], global.period[key], key);
  assert.deepEqual(local.period.budgetProgress.household, global.period.budgetProgress.household);
  assert.deepEqual([local.period.fromTodayFunding.status, local.period.fromTodayFunding.availableNow],
    [global.period.fromTodayFunding.status, global.period.fromTodayFunding.availableNow]);
  assert.equal(local.action.remainingClaim, global.action.remainingClaim);
});
check('a drop in an earlier period leaves this period precise; that period stays withheld', () => {
  const r = run([{ ...DROP, date: '2026-09-20' }]);
  assert.deepEqual(r.packet.droppedCategoryRows, [{ date: '2026-09-20', categoryId: 'groceries', reason: 'amount-unreadable' }]);
  assert.equal(r.row('groceries').spent, 40, 'the open period has no drop');
  const closed = r.advice.payPeriodViews.find(v => v.start === '2026-09-25');
  const priorGroceries = closed && closed.householdBudget.find(x => x.id === 'groceries');
  assert.ok(!priorGroceries || priorGroceries.spent == null, 'the period holding the drop is not precise');
});

console.log('\n=== C1. any doubt about the category keeps the global withhold (as on main) ===');
const fallbacks = [
  ['undated row', [{ ...DROP, date: 'not-a-date' }]],
  ['no provider category', [{ ...DROP, category: null }]],
  ['Uncategorised category', [{ ...DROP, category: 'Uncategorised' }]],
  ['category with no budget row', [{ ...DROP, category: 'Gifts' }]],
  ['transfer category', [{ ...DROP, category: 'Transfer' }]],
  ['income category', [{ ...DROP, category: 'Payroll' }]],
  ['pending row', [{ ...DROP, pending: true }]],
  ['card-payment kind', [{ ...DROP, raw: { kind: 'payment' } }]],
  ['split child', [{ ...DROP, raw: { parent_id: 700001 } }]],
];
for (const [name, extra] of fallbacks) {
  check(name + ': no localisation, every category withheld', () => {
    const r = run(extra);
    assert.notEqual(r.packet.transactionCoverage, 'complete');
    assert.equal(r.packet.droppedCategoryRows, undefined, 'no droppedCategoryRows');
    assert.equal(r.packet.coverageExceptCategories, undefined);
    assert.equal(r.row('restaurants').spent, null, 'Eating out is withheld too, as on main');
    assert.equal(r.row('groceries').spent, null);
    totalsUnknown(r, name);
  });
}
check('no provider id: the observation is refused outright (as on main), never localised', () => {
  const w = H.baseWorld();
  w.transactions = [H.lm({ ...DROP, omitId: true })];
  const r = H.dataOf(w);
  assert.match(String(r.error && r.error.message), /stable id/);
  assert.equal(r.packet, null);
});
check('savings reserve account: never localised (coverage as on main for that account)', () => {
  // Pre-existing on main: a dropped row on the reserve does not reach the
  // household coverage stamp at all (reported separately). This PR only
  // proves it is never localised to a household category.
  const r = run([{ ...DROP, account: 'savings' }]);
  assert.equal(r.packet.droppedCategoryRows, undefined);
  assert.equal(r.packet.coverageExceptCategories, undefined);
});
check('another coverage gap alongside a certain drop: global withhold', () => {
  const r = run([DROP, { date: '2026-10-13', amount: 5, category: 'Groceries', payee: 'Invented mystery', account: 'not-mapped', providerAccountId: 9999 }]);
  assert.equal(r.packet.droppedCategoryRows, undefined);
  assert.equal(r.row('restaurants').spent, null);
  totalsUnknown(r, 'second gap');
});
check('a packet claiming localised drops for a category outside the plan: global withhold', () => {
  const plan = run([DROP]);
  const opts = { debts: [], currentPeriodActuals: { ...plan.packet, droppedCategoryRows: [{ date: '2026-10-11', categoryId: 'not-a-budget-row', reason: 'amount-unreadable' }] } };
  const w = H.baseWorld();
  const data = H.dataOf(Object.assign(w, { transactions: [] })).data;
  const view = F.recommend(data.plan, w.asOf, opts).payPeriodViews.find(v => v.start === '2026-10-09');
  assert.equal(view.householdBudget.find(x => x.id === 'restaurants').spent, null);
});
check('consumers reading the stamp alone still withhold, exactly as under the global withhold', () => {
  assert.equal(local.packet.transactionCoverage, 'incomplete');
  // currentPeriodAction reads coverage without the opt-in.
  assert.equal(local.action.remainingClaim, 'unavailable');
  assert.equal(local.action.remainingClaim, global.action.remainingClaim);
  // Card coverage reads the stamp alone: same publication as the global withhold.
  const card = r => F.visaPaymentReconciliation(r.packet.transactions,
    { plan: H.dataOf(Object.assign(H.baseWorld(), { transactions: [] })).data.plan, asOf: '2026-10-14', packet: r.packet, debts: [] });
  assert.deepEqual([card(local).status, card(local).reservedCash], [card(global).status, card(global).reservedCash]);
});

console.log(`\nAll ${passed} dropped-row category proofs passed.`);
