'use strict';
/* Estimated future pay periods while today's cash is unconfirmed.
 *
 * Owner decision (Dale, 2026-11-17, #821 6964438984): when today's cash
 * cannot be confirmed, only the current period is withheld. Each later pay
 * period still publishes its own income, bills, Household budget and Balance
 * After Deductions, tagged estimated, never calculated or verified. Its opening
 * stays unknown, so every opening-dependent close, carry and sweep stays
 * unknown, and decision figures (extra debt, big-purchase set-asides) stay
 * withheld.
 *
 * Invented plan, hand-derived figures. Pay periods are 14 days starting on
 * the invented biweekly payday 2026-10-09:
 *   payroll   3000 every 14 days (10-09, 10-23, 11-06, 11-20, ...)
 *   rent      1200 on the 1st of each month
 *   groceries  100 a week -> 200 per 14-day cycle
 *   2026-10-23..11-05: 3000 - 1200 (Nov 1) - 200 = 1600
 *   2026-11-06..11-19: 3000 -    0          - 200 = 2800
 *   2026-11-20..12-03: 3000 - 1200 (Dec 1) - 200 = 1600
 *
 * `node test/test-estimated-future-periods.js`
 */
const F = require('../public/forecast.js');

const AS_OF = '2026-10-09';
const plan = () => ({
  defaults: { targetBuffer: 500 },
  windowDays: 91,
  startingCash: { breakdown: [{ id: 'chequing-a', label: 'Invented chequing', value: 2500, class: 'spendable' }] },
  opening: { asOf: AS_OF },
  nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
  income: [{ id: 'payroll', label: 'Invented payroll', frequency: 'biweekly', anchor: '2026-10-09', amount: 3000, confidence: 'confirmed' }],
  bills: [{ id: 'rent', label: 'Invented rent', amount: 1200, frequency: 'monthly', day: 1, confidence: 'confirmed', payingAccount: 'chequing-a' }],
  obligations: [], commitments: [],
  budget: { categories: [{ id: 'groceries', label: 'Invented groceries', plannedWeekly: 100 }] },
});
const run = opts => F.recommend(plan(), AS_OF, Object.assign({ targetBuffer: 500, debts: [] }, opts || {}));
const EXPECTED = [
  { start: '2026-10-23', income: 3000, bills: 1200, hold: 200, bad: 1600 },
  { start: '2026-11-06', income: 3000, bills: 0, hold: 200, bad: 2800 },
  { start: '2026-11-20', income: 3000, bills: 1200, hold: 200, bad: 1600 },
];
const UNCONFIRMED = { operatingPlan: 'unavailable', operatingPlanNote: 'Invented: the dated opening is stale.' };
const OPENING_UNKNOWN = { ...UNCONFIRMED, openingCash: { status: 'unavailable', asOf: AS_OF, reason: 'Invented: chequing opening unknown.' } };

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};
const row = (advice, start) => (advice.payPeriodViews || []).find(p => p && p.start === start) || null;
const current = advice => (advice.payPeriodViews || []).find(p => p && p.timelineRole === 'current') || null;
const TRUSTS = ['incomeTrust', 'periodBillLoadTrust', 'afterBillsTrust', 'balanceAfterDeductionsTrust', 'budgetHoldTrust'];

function expectEstimatedFuture(advice, label) {
  for (const spec of EXPECTED) {
    const p = row(advice, spec.start);
    const at = `${label} ${spec.start}`;
    ok(!!p, `${at}: the future period is published`);
    if (!p) continue;
    ok(p.incomeTotal === spec.income && p.periodBillLoad === spec.bills && p.budgetHold === spec.hold,
      `${at}: income, bills and Household are the hand-derived plan`, `${p.incomeTotal}/${p.periodBillLoad}/${p.budgetHold}`);
    ok(p.balanceAfterDeductions === spec.bad, `${at}: Balance After Deductions = income − bills − Household`, p.balanceAfterDeductions);
    ok(TRUSTS.every(k => p[k] === 'estimated'), `${at}: every released total is tagged estimated`,
      JSON.stringify(TRUSTS.map(k => p[k])));
    const progress = p.budgetProgress || {};
    ok(['income', 'bills', 'household'].every(k => progress[k] && progress[k].planned && progress[k].planned.trust === 'estimated'),
      `${at}: the period's planned figures are estimated too, never calculated`);
    ok(!/"(calculated|verified)"/.test(JSON.stringify(p)), `${at}: no figure in the period is calculated or verified`);
    ok(p.operatingPlanUnavailable === false && p.currentCashUnconfirmed && p.currentCashUnconfirmed.status === 'estimated',
      `${at}: the period says why it is estimated`);
    // Anything built on the unknown opening stays unknown.
    ok(p.openingKnown === false && p.opening == null, `${at}: the opening stays unknown`);
    ok(p.plannedPeriodClose == null && p.paydaySweep == null, `${at}: the planned cash close and the sweep stay unknown`,
      `${p.plannedPeriodClose}/${p.paydaySweep}`);
    ok(p.extraDebt && p.extraDebt.allocated == null && p.extraDebt.status === 'unavailable'
      && p.afterDebtRepayment == null && p.afterBigPurchases == null && p.projectedEnding == null,
      `${at}: decision figures stay withheld`);
  }
}

function expectCurrentWithheld(advice, label) {
  const p = current(advice);
  ok(!!p && p.operatingPlanUnavailable === true, `${label}: the current period is still marked unavailable`);
  ok(p && p.incomeTotal == null && p.periodBillLoad == null && p.budgetHold == null && p.balanceAfterDeductions == null
    && p.balanceAfterDeductionsTrust === 'unavailable', `${label}: today's period figures stay withheld`);
  ok(advice.weekly == null, `${label}: the weekly spending figure stays withheld`);
  ok(advice.paydayAllocation && advice.paydayAllocation.extraDebt && advice.paydayAllocation.extraDebt.status === 'unavailable',
    `${label}: the payday extra-debt decision stays withheld`);
}

console.log('=== control: healthy cash publishes the hand-derived future periods, unchanged ===');
{
  const advice = run({});
  for (const spec of EXPECTED) {
    const p = row(advice, spec.start);
    ok(!!p && p.balanceAfterDeductions === spec.bad && p.incomeTotal === spec.income
      && p.periodBillLoad === spec.bills && p.budgetHold === spec.hold, `healthy ${spec.start}: hand-derived figures`,
      p && p.balanceAfterDeductions);
    ok(!!p && !Object.hasOwn(p, 'currentCashUnconfirmed') && p.operatingPlanUnavailable === false,
      `healthy ${spec.start}: no unconfirmed-cash estimate is applied`);
  }
  ok(current(advice) && current(advice).balanceAfterDeductions != null, 'healthy: the current period is published');
}

console.log('\n=== one current-cash failure: future periods visible and estimated, today withheld ===');
{
  const advice = run(UNCONFIRMED);
  expectCurrentWithheld(advice, 'plan unavailable');
  expectEstimatedFuture(advice, 'plan unavailable');
}

console.log('\n=== the opening itself unknown: same release, opening-dependent figures unknown ===');
{
  const advice = run(OPENING_UNKNOWN);
  expectCurrentWithheld(advice, 'opening unknown');
  expectEstimatedFuture(advice, 'opening unknown');
}

console.log('\n=== an unresolved income occurrence still withholds the future (not a cash-only failure) ===');
{
  const advice = run({ ...OPENING_UNKNOWN, incomeReconciliation: { status: 'unavailable', asOf: AS_OF,
    reason: 'Invented: a scheduled receipt is unresolved.' } });
  for (const spec of EXPECTED) {
    const p = row(advice, spec.start);
    ok(!!p && p.balanceAfterDeductions == null && p.balanceAfterDeductionsTrust === 'unavailable',
      `income unresolved ${spec.start}: Balance After Deductions stays withheld`, p && p.balanceAfterDeductions);
  }
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll estimated-future-period checks passed.');
