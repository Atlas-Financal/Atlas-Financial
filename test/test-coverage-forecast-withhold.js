'use strict';
/* C2 + N3 + the futureCosts/liquidity gap — the Forecast half of the coverage authority.
 *
 * Invented fixtures only. Under a coverage stamp that is not established (absent, null,
 * unknown, contradictory, incomplete or truncated):
 *  - C2: the current-period claim is unavailable, never 'precise';
 *  - N3: the household reserve falls back to its plan TARGET, which stays visible as a
 *    target, but the remainder built on it is Unknown, never a 'calculated' number;
 *  - futureCosts requiredNow/allocated and liquidity are withheld, never 0 beside "ON TRACK".
 * A complete stamp keeps every figure exactly as before.
 *
 * `node test/test-coverage-forecast-withhold.js`
 */
const F = require('../public/forecast.js');
const fx = require('./fixtures/budget-surface-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const PAYDAY = '2026-09-01', MID = '2026-09-08', NEXT = '2026-09-15';
const plan = {
  windowDays: 40, defaults: { targetBuffer: 0 }, startingCash: { amount: 4000 },
  opening: { asOf: PAYDAY, priorAsOf: PAYDAY, representedEvents: [] },
  income: [{ id: 'pay', label: 'Pay', frequency: 'once', date: PAYDAY, amount: 2500, confidence: 'confirmed' },
    { id: 'pay2', label: 'Pay 2', frequency: 'once', date: NEXT, amount: 2500, confidence: 'confirmed' }],
  obligations: [], bills: [], commitments: [],
  budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: 1800 }], excluded: [] },
};
const packet = (over, drop) => {
  const p = Object.assign({ schema: 'atlas-current-period-actuals/v1', observationAsOf: MID, coverageStart: PAYDAY,
    coverageThrough: MID, pendingCoverage: 'complete', transactionCoverage: 'complete', transactions: [],
    savingsMovementUnconfirmed: [], cardCoverageUnconfirmed: [], outgoingETransferUnconfirmed: [], currencyUnconfirmed: [] }, over || {});
  for (const key of drop || []) delete p[key];
  return p;
};
const claim = (over, drop) => F.currentPeriodAction(plan, MID,
  { currentPeriodActuals: packet(over, drop), weeklyVariable: 0, debts: [] }).remainingClaim;

console.log('=== 1. C2: a stamp that is not established is not complete ===');
{
  ok(claim() === 'precise', 'control: a complete stamp stays precise');
  ok(claim({}, ['transactionCoverage']) === 'unavailable', 'an absent stamp is unavailable');
  ok(claim({ transactionCoverage: null }) === 'unavailable', 'a null stamp is unavailable');
  ok(claim({ transactionCoverage: 'unknown' }) === 'unavailable', "an 'unknown' stamp is unavailable");
  ok(claim({ transactionCoverage: { complete: true, hasMore: true } }) === 'unavailable',
    'a contradictory object stamp (complete beside hasMore) is unavailable');
  ok(claim({ transactionCoverage: 'incomplete' }) === 'unavailable' && claim({ transactionCoverage: 'truncated' }) === 'unavailable',
    'incomplete and truncated stay unavailable');
  ok(claim({ transactionCoverage: { complete: true, startDate: PAYDAY, endDate: MID } }) === 'precise',
    'a qualifying object stamp bound to the packet window is complete');
}

console.log('\n=== 2. N3: the target stays a target; the remainder is Unknown ===');
{
  const view = mode => {
    const data = fx.served();
    const pa = data.liveOverlay.currentPeriodActuals;
    if (mode === 'truncated') pa.transactionCoverage = 'truncated';
    if (mode === 'incomplete') pa.transactionCoverage = 'incomplete';
    if (mode === 'absent') delete pa.transactionCoverage;
    const advice = F.recommend(data.plan, data.meta.asOf, { debts: data.debts, weeklyVariable: 0, ...data.liveOverlay });
    return advice.payPeriodViews.find(row => row.timelineRole === 'current');
  };
  const control = view('complete');
  ok(typeof control.balanceAfterDeductions === 'number' && ['calculated', 'estimated', null].includes(control.balanceAfterDeductionsTrust)
      && control.budgetHoldTrust == null,
    'control: with complete coverage the remainder is a number with a calculated or estimated stamp');
  for (const mode of ['truncated', 'incomplete', 'absent']) {
    const v = view(mode);
    ok(v.balanceAfterDeductionsTrust === 'unavailable' && v.balanceAfterDeductions === null && v.predictedEndingBalance === null,
      `${mode}: Balance After Deductions is Unknown (unavailable, no number)`, JSON.stringify([v.balanceAfterDeductionsTrust, v.balanceAfterDeductions]));
    ok(typeof v.budgetHold === 'number' && v.budgetHold > 0 && v.householdActualsUnavailable === true && v.budgetHoldTrust == null,
      `${mode}: the household target stays visible as a target and is flagged as having lost its actuals`, String(v.budgetHold));
    ok(Array.isArray(v.householdBudget) && v.householdBudget.length > 0, `${mode}: the category rows (targets) are still published`);
    ok(v.predictedEndingBalanceTerms === null, `${mode}: no closing identity is published for the withheld remainder`);
  }
}

console.log('\n=== 3. futureCosts and liquidity are withheld, never zero beside ON TRACK ===');
{
  const alloc = mode => {
    const data = fx.served({ withUndatedCost: true });
    const pa = data.liveOverlay.currentPeriodActuals;
    if (mode === 'dropped-card') {
      pa.cardCoverageUnconfirmed = [{ ref: 'invented-row', date: '2026-08-18', reason: 'transaction-amount-or-date-unconfirmed' }];
      pa.transactionCoverage = 'incomplete';
    }
    if (mode === 'absent') delete pa.transactionCoverage;
    return F.recommend(data.plan, data.meta.asOf, { debts: data.debts, weeklyVariable: 0, ...data.liveOverlay }).paydayAllocation;
  };
  const control = alloc('complete');
  ok(control.futureCosts.length > 0 && control.futureCosts.every(r => typeof r.requiredNow === 'number' && r.requiredNow > 0 && r.verdict === 'ON TRACK')
      && typeof control.liquidity.wanted === 'number',
    'control: with complete coverage the future costs carry required-now figures and verdicts');
  for (const mode of ['dropped-card', 'absent']) {
    const a = alloc(mode);
    ok(a.futureCosts.length === control.futureCosts.length
        && a.futureCosts.every(r => r.requiredNow === null && r.allocated === null && r.verdict === null && r.status === 'unavailable'),
      `${mode}: every future cost is withheld (null required-now and allocated, no verdict), not 0 with ON TRACK`,
      JSON.stringify(a.futureCosts.map(r => [r.requiredNow, r.allocated, r.verdict])));
    ok(a.liquidity.wanted === null && a.liquidity.allocated === null, `${mode}: liquidity is withheld while the protected path is unavailable`);
    ok(a.protectedPath.status === 'unavailable', `${mode}: the protected path is unavailable (the figures above depend on it)`);
  }
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
