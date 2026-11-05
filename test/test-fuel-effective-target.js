'use strict';
// Independent synthetic cents prove date selection and max(plan, actual).
// The separate canonical assertions prove Dale's explicit 555/Oct 9 policy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Math.round(value * 100) / 100;
const effective = '2026-10-09';
const emptyHistory = { periods: { ytd: { months: 1, spending: [] } } };

function fixture(date, spent = 31.47) {
  const plan = {
    opening: { asOf: date, representedEvents: [] },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 8000 }] },
    income: [{ id: 'payroll', label: 'Invented payroll', frequency: 'biweekly',
      anchor: '2026-09-25', amount: 3000, confidence: 'confirmed' }],
    bills: [], obligations: [], commitments: [], groups: [], funding: { options: [] },
    budget: { categories: [
      { id: 'groceries', label: 'Invented groceries', class: 'essential', from: ['Groceries'],
        plannedPayday: 220, plannedMonthly: null },
      { id: 'fuel', label: 'Invented fuel', class: 'essential', from: ['Fuel & transport'],
        plannedPayday: 215, plannedMonthly: null, targetEffectiveFrom: effective,
        targetHistory: [{ effectiveThrough: '2026-10-08', plannedPayday: 85, plannedMonthly: null }] },
      { id: 'restaurants', label: 'Invented dining', class: 'discretionary', from: ['Restaurants'],
        plannedPayday: 60, plannedMonthly: null },
    ] },
  };
  const cycle = F.spendingCycle(plan, date);
  const packet = {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: date,
    coverageStart: '2026-09-01', coverageThrough: date, transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [{ id: 'invented-fuel', date: cycle.start, amount: spent, pending: false,
      categoryLabel: 'Fuel & transport', originalMerchant: 'Invented fuel station',
      displayedPayee: 'Invented fuel station', merchantKnown: true,
      account: 'chequing-a', accountRole: 'household-cash' }],
  };
  return { plan, packet, date };
}
function options(f) {
  return { ...f.plan.defaults, debts: [], periods: emptyHistory, currentPeriodActuals: f.packet };
}
function advice(f) { return F.recommend(f.plan, f.date, options(f)); }
function legacy(f) {
  const previous = clone(f);
  const fuel = previous.plan.budget.categories.find(row => row.id === 'fuel');
  fuel.plannedPayday = 85;
  delete fuel.targetEffectiveFrom;
  delete fuel.targetHistory;
  return previous;
}
function current(f) { return advice(f).payPeriodViews.find(row => row.timelineRole === 'current'); }

for (const date of ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-22', '2026-10-23', '2026-11-06']) {
  const f = fixture(date), before = JSON.stringify(f), period = current(f);
  const target = date < effective ? 85 : 215;
  const window = date < effective ? ['2026-09-25', '2026-10-08']
    : date <= '2026-10-22' ? ['2026-10-09', '2026-10-22']
      : date <= '2026-11-05' ? ['2026-10-23', '2026-11-05'] : ['2026-11-06', '2026-11-19'];
  assert.deepEqual([period.start, period.end], window, 'independently dated 14-day boundary');
  const fuel = period.householdBudget.find(row => row.id === 'fuel');
  assert.equal(fuel.planned, target, `${date}: exact dated payday amount`);
  assert.equal(fuel.plannedPayday, target, 'printed metadata selects the same historical policy');
  assert.equal(fuel.monthly, round(target * (365.25 / 12) / 14));
  assert.equal(fuel.spent, 31.47);
  assert.equal(fuel.hold, target);
  assert.equal(fuel.remaining, round(target - 31.47));
  // Independent dollars: salary - groceries - dining - max(fuel plan, actual).
  assert.equal(period.budgetHold, 220 + 60 + target);
  assert.equal(period.balanceAfterDeductions, 3000 - 220 - 60 - target);
  assert.equal(period.budgetProgress.household.planned.amount, 220 + 60 + target);
  const old = current(legacy(f));
  assert.deepEqual(period.householdBudget.filter(row => row.id !== 'fuel'),
    old.householdBudget.filter(row => row.id !== 'fuel'), 'other categories are unchanged');
  assert.deepEqual(fuel.recon, old.householdBudget.find(row => row.id === 'fuel').recon,
    'changing the target leaves actual membership unchanged');
  const allocation = F.paydayAllocation(f.plan, date, options(f));
  const cash = allocation.essentials.items.find(row => row.id === 'fuel');
  assert.equal(cash.planned, target);
  assert.equal(cash.posted, 31.47);
  assert.equal(cash.required, round(target - 31.47));
  const action = F.currentPeriodAction(f.plan, date, options(f));
  assert.equal(action.categories.find(row => row.id === 'fuel').planned, target);
  const budget = F.budgetBreakdown(f.plan, emptyHistory, { asOf: date });
  assert.equal(budget.categories.find(row => row.id === 'fuel').target,
    round(target * (365.25 / 12) / 14), 'monthly publication selects the dated target');
  assert.equal(JSON.stringify(f), before, 'Forecast does not rewrite inputs or observations');
}

for (const spent of [0, 31.47, 215, 278.63]) {
  const f = fixture('2026-10-10', spent), period = current(f);
  const fuel = period.householdBudget.find(row => row.id === 'fuel');
  assert.equal(fuel.hold, Math.max(215, spent), 'actual fulfills the hold once, including overspend');
  assert.equal(period.budgetHold, round(280 + Math.max(215, spent)));
  assert.equal(period.balanceAfterDeductions, round(3000 - 280 - Math.max(215, spent)));
}

const f = fixture('2026-10-10'), published = advice(f), prior = advice(legacy(f));
assert.deepEqual(published.payPeriodViews.filter(row => row.end < effective),
  prior.payPeriodViews.filter(row => row.end < effective), 'completed pre-Oct 9 publications are unchanged');
for (const period of published.payPeriodViews.filter(row => row.start >= effective)) {
  assert.equal(period.householdBudget.find(row => row.id === 'fuel').planned, 215);
}
const later = fixture('2026-10-24');
const completed = advice(later).payPeriodViews.find(row => row.start === effective);
assert.equal(completed.householdBudget.find(row => row.id === 'fuel').planned, 215);
assert.equal(completed.householdBudget.find(row => row.id === 'fuel').hold, 0,
  'uncovered completed spending is not invented or converted into a present reserve');
assert.equal(completed.budgetProgress.household.planned.amount, null,
  'dated policy does not fabricate a retained original historical household plan');

// The same live Forecast helpers feed Plan's named spans. An October month
// starts before Oct 9; its two payday holds must still both use the new target.
const source = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8');
const context = { module: { exports: {} }, console };
vm.runInNewContext(source.replace('const Forecast = {',
  'globalThis.fuelSpanProof = { ownerTargetHoldForSpan, householdBudgetScaled }; const Forecast = {'), context);
for (const [start, end, days, expected] of [
  ['2026-09-25', '2026-10-08', 14, 85],
  ['2026-10-09', '2026-10-22', 14, 215],
  ['2026-09-25', '2026-10-22', 28, 300], // one old + one new whole payday
  ['2026-10-01', '2026-10-31', 31, 430], // Oct 9 + Oct 23
  ['2026-11-01', '2026-11-30', 30, 430], // Nov 6 + Nov 20
]) {
  assert.equal(context.fuelSpanProof.ownerTargetHoldForSpan(f.plan, days, start, end)
    .find(row => row.id === 'fuel').planned, expected, 'span sums independently enumerated dated paydays');
  assert.equal(context.fuelSpanProof.householdBudgetScaled(f.plan, days, start, end)
    .find(row => row.id === 'fuel').amount, expected, 'Plan glance uses the same dated spans');
}

const canonical = require('../data.json');
const fuel = canonical.plan.budget.categories.find(row => row.id === 'fuel');
const historicalFuel = require('./fixtures/retired-fuel-policy');
assert.equal(historicalFuel(canonical).plan.budget.categories.find(row => row.id === 'fuel').plannedPayday, 325);
const activeCanonical = clone(canonical);
activeCanonical.meta.asOf = '2026-10-10';
assert.throws(() => historicalFuel(activeCanonical), /bounded historical asOf/,
  'historical test adapter refuses to substitute retired policy for an active period');
assert.equal(fuel.plannedPayday, 555, 'explicit owner-approved budget');
assert.equal(fuel.plannedMonthly, null, 'monthly amount stays derived');
assert.equal(fuel.targetEffectiveFrom, effective);
assert.equal(fuel.targetSource, 'owner-stated-2026-10-10');
assert.deepEqual(fuel.targetHistory, [{ effectiveThrough: '2026-10-08', plannedPayday: 325,
  plannedMonthly: null, targetSource: 'owner-stated-2026-08-31' }]);
for (const [date, expected] of [['2026-08-28', 325], ['2026-10-08', 325], ['2026-10-09', 555], ['2026-11-06', 555]]) {
  const periods = F.recommend(canonical.plan, date, { ...canonical.plan.defaults, debts: canonical.debts }).payPeriodViews;
  const period = periods.find(row => row.timelineRole === 'current');
  assert.equal(period.householdBudget.find(row => row.id === 'fuel').planned, expected,
    'canonical input reaches the household payday publication');
}
console.log('PASS Fuel: pre-Oct 9/current/future boundaries, independent max hold and surplus, unchanged actuals/history/other categories, mixed-date spans, canonical 555 policy');
