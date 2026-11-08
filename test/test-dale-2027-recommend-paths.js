'use strict';
/* The recommend paths beyond the cap walk read the one 2027 Dale payroll
 * figure: funding sequence, major plans, planned debt, payday allocation,
 * plan-spend payday funding and the current-period action.
 *
 * Invented world only: a 1,400 biweekly payroll stream (anchor
 * 2026-12-04), an invented 9,000 roof on 2027-05-20 and an invented 6,000
 * flexible car on 2027-03-10, so the 2027 cash decides the plan verdicts.
 * The 2027 estimate itself comes from Forecast's salary evidence, a
 * household fact, so no 2027 amount is printed: every check is an equality
 * between two paths, or a trust tag.
 *
 * Oracle (independent of the code under test): the same world with no
 * 2027 regime, where the caller writes the Budget timeline's own 2027 rows
 * (payPeriodViews, a separate path) into every walk by hand through
 * incomeOccurrenceAdjust / additionalIncomeEvents. The six published
 * results must equal the oracle's.
 *
 * The Budget timeline publishes full pay periods only, so each as-of is
 * chosen with the next payday the day after it: the 365-day knowledge
 * horizon then ends on a period's last day and every in-regime payday in
 * the horizon has a Budget row for the oracle to copy. B authorizes 2028
 * so its horizon's January 2028 paydays are in the regime too.
 *
 * `node test/test-dale-2027-recommend-paths.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const STREAM = 1400;
const PATHS = ['fundingSequence', 'majorPlans', 'plannedDebt', 'planSpendPaydayFunding'];
const ALLOC_PARTS = ['futureCosts', 'risks', 'allocatedTotal', 'remainder', 'movable'];

function world(asOf, assumptions) {
  const plan = {
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    windowDays: 91,
    startingCash: { breakdown: [
      { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 3000, class: 'spendable' },
    ] },
    opening: { asOf },
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 100 },
    ] },
    obligations: [],
    bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 5, amount: 900,
      confidence: 'confirmed', payingAccount: 'chequing-a' }],
    commitments: [
      { id: 'roof', label: 'Invented roof', date: '2027-05-20', amount: 9000, confidence: 'confirmed' },
      { id: 'car', label: 'Invented car', date: '2027-03-10', amount: 6000, confidence: 'estimated',
        flexibility: 'flexible' },
    ],
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-12-04', amount: STREAM, confidence: 'confirmed' }],
  };
  if (assumptions !== false) {
    plan.payrollPlanningAssumptions = Object.assign(
      { salaryRaiseFactor: 1, bonusRate: 0, authorizedThroughYear: 2027 }, assumptions || {});
  }
  return plan;
}

const isDale = e => e && e.kind === 'income' && (e.id === 'payroll' || e.id === 'payrollBonus');

function budgetRows(advice) {
  const rows = new Map();
  for (const view of advice.payPeriodViews || []) {
    for (const row of (view && view.income) || []) {
      if (!isDale(row) || !(row.date >= '2027-01-01')) continue;
      if (rows.has(row.id + '@' + row.date)) continue;
      rows.set(row.id + '@' + row.date, row);
    }
  }
  return rows;
}

function oracleOptions(ref) {
  return {
    debts: [],
    incomeOccurrenceAdjust: (stream, date) => {
      if (!isDale(stream) && stream.id !== 'payroll') return null;
      if (date < '2027-01-01') return null;
      const row = ref.get(stream.id + '@' + date);
      return row ? { amount: row.amount, confidence: 'estimated' } : { omit: true };
    },
    additionalIncomeEvents: Array.from(ref.values())
      .filter(row => row.id === 'payrollBonus')
      .map(row => ({ kind: 'income', id: row.id, label: row.label, date: row.date,
        amount: row.amount, confidence: 'estimated' })),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const allocParts = alloc => ALLOC_PARTS.map(k => alloc && alloc[k]);

function compareWithOracle(label, asOf, assumptions) {
  console.log(label);
  const plan = world(asOf, assumptions);
  const advice = F.recommend(plan, asOf, { debts: [] });
  const ref = budgetRows(advice);
  ok(ref.size > 0 && Array.from(ref.values()).every(r => r.confidence === 'estimated'),
    'the Budget timeline publishes estimated 2027 Dale rows');
  const oracle = F.recommend(world(asOf, false), asOf, oracleOptions(ref));
  const plain = F.recommend(world(asOf, false), asOf, { debts: [] });
  for (const key of PATHS) {
    ok(same(advice[key], oracle[key]), key + ' equals the walk fed the Budget rows by hand');
  }
  ok(same(allocParts(advice.paydayAllocation), allocParts(oracle.paydayAllocation)),
    'paydayAllocation future costs, risks and totals equal the oracle');
  ok(same(advice.currentPeriodAction, oracle.currentPeriodAction),
    'currentPeriodAction equals the oracle');
  ok(!same(advice.majorPlans, plain.majorPlans)
      || !same(allocParts(advice.paydayAllocation), allocParts(plain.paydayAllocation)),
    'the plain-stream world publishes different plans here, so the check discriminates');
  return { plan, advice, ref };
}

compareWithOracle('A. as-of 2026-12-31 (next payday Jan 1 2027)', '2026-12-31');
compareWithOracle('B. as-of 2027-01-14 (current period holds the Jan 1 2027 payday)',
  '2027-01-14', { authorizedThroughYear: 2028 });
compareWithOracle('C. with a calculator bonus (no plan bonus stream)', '2026-12-31', { bonusRate: 0.1 });

console.log('D. the published planOptions stay the household assumptions');
{
  const asOf = '2026-12-31';
  const advice = F.recommend(world(asOf), asOf, { debts: [] });
  ok(!('dalePayrollWalk' in advice.planOptions) && !('incomeOccurrenceAdjust' in advice.planOptions),
    'planOptions carries no derived 2027 walk data');
  let cloned = null;
  try { cloned = structuredClone(advice); } catch (error) { cloned = null; }
  ok(cloned !== null, 'the advice stays structured-cloneable');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
