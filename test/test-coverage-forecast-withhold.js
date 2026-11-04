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
    ok(typeof v.budgetHold === 'number' && v.budgetHold > 0 && v.householdActualsUnavailable === true && v.budgetHoldTrust === 'estimated',
      `${mode}: the household hold stays visible, stamped estimated (max of plan and known posted), and flagged as having lost its actuals`, String(v.budgetHold));
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

console.log('\n=== 4. The coverage gate is its own gate: current Unknown, later periods estimated ===');
{
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { sourceText } = require('./test-source-text');
  // 'alone': a world where NO other withhold fires (no card policy, no card coverage gate, no
  // operating-plan or scheduled-amount gate), so only the coverage gate can act.
  const advice = (mode, alone) => {
    const data = fx.served({ withUndatedCost: true });
    const pa = data.liveOverlay.currentPeriodActuals;
    if (alone) { pa.cardCoverageRequired = false; delete data.plan.cardPurchaseCoverage; }
    if (mode === 'incomplete' || mode === 'truncated') pa.transactionCoverage = mode;
    if (mode === 'absent') delete pa.transactionCoverage;
    const a = F.recommend(data.plan, data.meta.asOf, { debts: alone ? [] : data.debts, weeklyVariable: 0, ...data.liveOverlay });
    return { a, data };
  };
  const planSrc = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
  const page = Object.assign({ fmtDate: v => v, fmtDateLong: v => v, money2: n => (n < 0 ? '-$' : '$') + Math.abs(Number(n)).toFixed(2),
    liveCurrentBalanceHtml: () => '', calendarWaterfallHtml: () => '', periodBillLine: () => '' });
  const ctx = vm.createContext(Object.assign({ Forecast: F }, page));
  vm.runInContext(planSrc, ctx);
  const pageCtx = vm.createContext({ fmtDate: v => v, fmtDateLong: v => v, money2: n => '$' + Number(n).toFixed(2), Forecast: F, window: {} });
  vm.runInContext(planSrc, pageCtx);

  for (const alone of [false, true]) {
    const tag = alone ? 'alone' : 'fixture';
    const control = advice('complete', alone).a;
    ok(control.coverageLost == null && control.coverageEstimate == null && control.paydayAllocation.paydayShellTrust.household === 'calculated'
        && control.majorPlans.every(r => r.verdict === 'ON TRACK' && r.verdictTrust == null)
        && typeof control.defaultView.balanceAfterDeductions === 'number',
      `${tag} control: with complete coverage nothing is qualified and every figure is published as before`);
    for (const mode of ['truncated', 'incomplete', 'absent']) {
      const { a, data } = advice(mode, alone);
      const label = `${tag}/${mode}`;
      if (alone) {
        ok(!a.cardCoverageUnavailable && !a.operatingPlanUnavailable && a.weekly != null,
          `${label}: no other gate fires in this world (the coverage gate acts on its own)`);
      }
      const pa = a.paydayAllocation;
      ok(pa.paydayShellTrust.household === 'unknown', `${label}: the payday household spending is Unknown, not the plan labelled calculated`);
      const current = a.payPeriodViews.find(row => row.timelineRole === 'current');
      const later = a.payPeriodViews.filter(row => row.start > current.end);
      ok([a.defaultView, current].every(v => v.balanceAfterDeductions === null && v.predictedEndingBalance === null && v.balanceAfterDeductionsTrust === 'unavailable'),
        `${label}: the current period's remainder and close are Unknown`);
      ok(later.length > 3 && later.every(v => typeof v.balanceAfterDeductions === 'number' && typeof v.predictedEndingBalance === 'number'
          && v.balanceAfterDeductionsTrust === 'estimated' && v.coverageEstimate && /spending is incomplete/.test(v.coverageEstimate.reason)),
        `${label}: every later period keeps a numeric opening/close, stamped estimated with the reason (never null, never calculated)`,
        JSON.stringify(later.slice(0, 2).map(v => [v.balanceAfterDeductions, v.balanceAfterDeductionsTrust])));
      ok(a.payPeriodViews.every(v => typeof v.available === 'number') && typeof current.afterBills === 'number',
        `${label}: period income (available), bills and balance after bills stay published on every period`);
      ok(a.coverageEstimate && a.coverageEstimate.status === 'estimated' && a.coverageEstimate.reason.includes(`transaction coverage: ${mode === 'absent' ? 'not established' : mode}`),
        `${label}: the reason names the coverage state`, a.coverageEstimate && a.coverageEstimate.reason);
      ok(a.majorPlans.length > 0 && a.majorPlans.every(r => r.verdictTrust === 'estimated' && r.estimateReason === a.coverageEstimate.reason),
        `${label}: major plans are estimates carrying the reason, not certain verdicts`);
      // Guard (b): in the current view the estimated hold reaches no figure labelled calculated.
      const calculatedKeys = view => Object.keys(view).filter(k => /Trust$/.test(k) && view[k] === 'calculated');
      const independent = new Set(['incomeTrust', 'periodBillLoadTrust', 'afterBillsTrust', 'afterRemainingBillsTrust']);
      ok([a.defaultView, current].every(v => calculatedKeys(v).every(k => independent.has(k)) && v.budgetHoldTrust !== 'calculated'),
        `${label}: in the current view only spending-independent figures may be labelled calculated`,
        JSON.stringify(calculatedKeys(current)));
      // Guard (b), whole chain: the payday allocation's remainder chain, its shell trust and the
      // packet block carry no calculated figure that rests on the unknown spending.
      const rl = pa.runningLeftover || {};
      ok(pa.runningLeftover == null || (rl.afterHouseholdBudget === null && rl.afterDebtRepayment === null && rl.afterBigPurchases === null
          && typeof rl.afterBills === 'number'),
        `${label}: the leftover chain after the household budget, debt repayment and big purchases is Unknown (afterBills stays)`,
        JSON.stringify(rl));
      ok(pa.protectedPath.status === 'unavailable' && pa.protectedPath.allocated === null
          && pa.extraDebt.allocated === null && pa.remainder === null && pa.unallocated === null
          && pa.optional.length === 0 && !pa.lines.some(l => ['future-path', 'extra-debt', 'optional', 'unassigned'].includes(l.kind)),
        `${label}: keep, extra debt and the unassigned remainder are Unknown and carry no allocation line`);
      ok(['household', 'extraDebt', 'optional', 'remainder'].every(k => pa.paydayShellTrust[k] === 'unknown')
          && a.paydayShellTrust.remainder === 'unknown' && a.paydayShellTrust.extraDebt === 'unknown',
        `${label}: the shell trust for household, extra debt, optional and remainder is unknown, never calculated`,
        JSON.stringify(pa.paydayShellTrust));
      const shellHtml = ctx.paydayInstructionShellHtml(a, current, a.planSpendPaydayFunding);
      ok(!/Extra on focus debt[\s\S]{0,120}\$0\.00/.test(shellHtml) && !/Truly unassigned[\s\S]{0,120}\$0\.00/.test(shellHtml),
        `${label}: the page prints no \$0.00 for extra debt or the unassigned remainder`);
      // Guard (a): an estimate is never more optimistic than the measured answer.
      ok(a.majorPlans.every((r, i) => r.margin == null || control.majorPlans[i] == null || r.margin <= control.majorPlans[i].margin + 0.005),
        `${label}: no estimated margin exceeds the measured one`);
      const html = ctx.paydayInstructionShellHtml(a, current, a.planSpendPaydayFunding);
      const block = (html.match(/<details[^>]*data-payday-breakdown="Current household spending"[\s\S]*?<\/details>/) || [''])[0];
      ok(block.length > 0 && /unavailable/i.test(block) && !/calculated/.test(block) && !/instruction-amount">\$/.test(block),
        `${label}: the page prints Current household spending as unavailable, never a calculated dollar figure`);
      for (const [name, per] of [['current', current], ['later', later[0]]]) {
        const waterfall = pageCtx.calendarWaterfallHtml(per, data.liveOverlay, a.paydayAllocation, data.plan);
        ok(!/Forecast did not publish a valid total/.test(waterfall) && /data-budget-bar-state="known"/.test(waterfall),
          `${label}: the page's Income step is visible on the ${name} period`);
      }
      const chips = pageCtx.futureGravityHtml(a);
      ok(/≈ ON TRACK \(estimate\)/.test(chips) && !/>ON TRACK</.test(chips),
        `${label}: the page labels the verdict an estimate (≈), never a bare ON TRACK`);
    }
  }
  // A withheld future cost never prints as a zero set-aside.
  const gated = advice('truncated', false).a.paydayAllocation;
  ok(gated.futureCosts.length > 0 && gated.futureCosts.every(r => r.allocated === null)
      && !/data-allocation-state="future:/.test(pageCtx.paydayAllocationSheetHtml(gated) || ''),
    'a withheld future cost is null and prints no zero-valued set-aside row');
  ok(advice('truncated', true).a.payPeriodViews.every(v => !(v.bigPurchases || []).some(r => r.setAsideThisPayday === 0 && v.householdActualsUnavailable === true)),
    'a big-purchase set-aside in the lost period is Unknown, never 0');
  // The assistant packet, through the real builder: estimated with the reason, never ok; the
  // current period's predicted ending balance is Unknown.
  const Assistant = require('../scripts/assistant-packet.js');
  const packetFor = mode => {
    const { data } = advice(mode, true);
    return Assistant.buildPacket({ data, periods: Assistant.loadPeriods(), questionsMarkdown: '',
      now: '2026-08-20T12:00:00.000Z', env: {} }).forecast;
  };
  const okPacket = packetFor('complete');
  ok(okPacket.majorPlanFunding.status === 'ok' && okPacket.predictedEndingBalance.status === 'ok' && okPacket.paydayAllocation.status === 'ok',
    'packet control: complete coverage publishes ok, unchanged');
  for (const mode of ['truncated', 'incomplete', 'absent']) {
    const f = packetFor(mode);
    ok(f.majorPlanFunding.status === 'estimated' && f.upcomingModeledCommitments.status === 'estimated'
        && /spending is incomplete/.test(f.majorPlanFunding.reason) && f.majorPlanFunding.items.every(i => i.verdictTrust === 'estimated'),
      `packet ${mode}: major plans are marked estimated with a reason, not ok`);
    ok(f.predictedEndingBalance.status === 'unavailable', `packet ${mode}: the current period's predicted ending balance is Unknown`);
    ok(f.paydayAllocation.status === 'estimated' && /spending is incomplete/.test(f.paydayAllocation.reason)
        && f.paydayAllocation.runningLeftover.afterHouseholdBudget === null
        && f.paydayAllocation.runningLeftover.afterBigPurchases === null && f.paydayAllocation.extraDebt.allocated === null,
      `packet ${mode}: the payday allocation block says estimated with the reason and carries no Unknown-dependent figure`);
  }
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
