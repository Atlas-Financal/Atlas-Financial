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
  startingCash: { breakdown: [
    { id: 'chequing-a', label: 'Invented chequing', value: 2500, class: 'spendable' },
    { id: 'chequing-b', value: 0 },
  ] },
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

console.log('\n=== as-of later than a stale opening: only periods after today are released ===');
{
  // Opening dated 2026-10-09, Forecast run on 2026-11-08. Today's period is
  // 2026-11-06..11-19; 2026-10-23..11-05 is already finished. Hand-derived:
  // the finished and current periods stay withheld; 2026-11-20 (3000 - 1200
  // Dec 1 rent - 200) = 1600 is the first released estimate.
  const LATE = '2026-11-08';
  for (const [label, extra] of [['plan unavailable', UNCONFIRMED], ['opening unknown', OPENING_UNKNOWN]]) {
    const advice = F.recommend(plan(), LATE, Object.assign({ targetBuffer: 500, debts: [] }, extra));
    const finished = row(advice, '2026-10-23');
    ok(!!finished && !Object.hasOwn(finished, 'currentCashUnconfirmed')
      && (extra !== OPENING_UNKNOWN || (finished.balanceAfterDeductions == null
        && finished.balanceAfterDeductionsTrust === 'unavailable')),
      `late ${label}: the finished 2026-10-23 period is not released as an estimate`,
      finished && `${finished.balanceAfterDeductions}/${finished.balanceAfterDeductionsTrust}`);
    const today = (advice.defaultView.calendarPeriods || []).find(p => p && p.start === '2026-11-06');
    ok(!!today && today.balanceAfterDeductions == null && !Object.hasOwn(today, 'currentCashUnconfirmed'),
      `late ${label}: today's 2026-11-06 period stays withheld, not an estimate`);
    const next = row(advice, '2026-11-20');
    ok(!!next && next.balanceAfterDeductions === 1600 && next.balanceAfterDeductionsTrust === 'estimated'
      && next.currentCashUnconfirmed && next.currentCashUnconfirmed.status === 'estimated',
      `late ${label}: the 2026-11-20 period after today is the released estimate, 1600`, next && next.balanceAfterDeductions);
    const releasedEarly = (advice.payPeriodViews || []).filter(p => p && p.currentCashUnconfirmed && p.start <= LATE);
    ok(releasedEarly.length === 0, `late ${label}: no period starting on or before today is released`,
      releasedEarly.map(p => p.start).join());
  }
}

// Not a cash-only failure: every later period stays fully withheld, exactly as
// before this change. afterHouseholdBudget is Balance After Deductions by
// another name, so it, its parts and the rows must all stay unpublished.
function expectWithheldFuture(advice, label) {
  const asOf = advice.defaultView && advice.defaultView.asOf;
  const later = (advice.payPeriodViews || []).filter(p => p && p.start > asOf).slice(0, 3);
  ok(later.length === 3, `${label}: three later periods are present to check`);
  for (const p of later) {
    const at = `${label} ${p.start}`;
    ok(p.operatingPlanUnavailable === true && !Object.hasOwn(p, 'currentCashUnconfirmed'),
      `${at}: the later period stays unavailable, not an estimate`);
    ok(['incomeTotal', 'available', 'periodBillLoad', 'afterBills', 'afterRemainingBills', 'budgetHold',
      'afterHouseholdBudget', 'balanceAfterDeductions'].every(k => p[k] == null),
      `${at}: income, bills, Household and every total built on them stay withheld`,
      JSON.stringify([p.incomeTotal, p.afterBills, p.afterHouseholdBudget, p.balanceAfterDeductions]));
    ok(['income', 'bills', 'householdBudget'].every(k => (p[k] || []).length === 0),
      `${at}: no income, bill or Household row is listed`);
    const progress = p.budgetProgress || {};
    ok(['income', 'bills', 'household'].every(k => !progress[k] || !progress[k].planned
      || (progress[k].planned.amount == null && progress[k].planned.trust === 'unavailable')),
      `${at}: no planned progress figure is published`);
  }
}

console.log('\n=== an unresolved income occurrence still withholds the future (not a cash-only failure) ===');
{
  const income = { status: 'unavailable', asOf: AS_OF, reason: 'Invented: a scheduled receipt is unresolved.' };
  expectWithheldFuture(run({ ...UNCONFIRMED, incomeReconciliation: income }), 'income unresolved');
  expectWithheldFuture(run({ ...OPENING_UNKNOWN, incomeReconciliation: income }), 'income unresolved, opening unknown');
}

console.log('\n=== an unresolved card minimum still withholds the future (not a cash-only failure) ===');
{
  // Invented card-minimum world (test/fixtures/card-backfill-data): a confirmed
  // send whose issuer minimum is unconfirmed leaves card minimums unavailable.
  const Live = require('../scripts/live-plan');
  const source = require('./fixtures/card-backfill-data');
  const x = source('triangle', 'triangle');
  x.asOf = '2026-10-05';
  x.data.meta.asOf = x.data.plan.opening.asOf = '2026-10-02';
  x.data.plan.windowDays = 28;
  x.data.plan.income[0].anchor = '2026-10-02';
  x.data.plan.startingCash.breakdown[1].value = 100;
  x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
    label: 'Invented card minimum', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
    amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
      minimum: 91.23, currency: 'cad', confidence: 'confirmed' }],
    sentPayments: [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
      debitId: 'invented-bank-debit', postedOn: '2026-10-05', amount: 100, currency: 'cad',
      fundingAccountId: 'chequing-a', pending: false }] };
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2026-10-02', endDate: x.asOf, complete: true, hasMore: false, truncated: false };
  x.payload.transactions = [];
  x.payload.accounts.forEach(a => { a.updated_at = a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  const live = Live.fromObservation(x);
  const advice = F.recommend(live.data.plan, x.asOf, { debts: live.data.debts,
    currentPeriodActuals: live.data.liveOverlay.currentPeriodActuals, ...UNCONFIRMED });
  ok(advice.cardMinimumPayments && advice.cardMinimumPayments.status === 'unavailable',
    'card minimum world: card minimums are unavailable');
  expectWithheldFuture(advice, 'card minimum unresolved');
}

console.log('\n=== a released later period never counts an unknown bill amount as $0 (#1312 review note 4) ===');
{
  // The same invented plan plus one bill whose amount is unknown. The period that holds it publishes its bill load,
  // bills total, remaining bills and Balance After Deductions as unknown (null, unavailable), never an estimate that
  // reads the unknown bill as $0. Released periods without it keep their own hand-derived estimates:
  //   2026-10-23: 3000 - 1200 (Nov 1) - 200 = 1600;  2026-11-20: 3000 - 1200 (Dec 1) - 200 = 1600;
  //   2026-12-04 and 2026-12-18: 3000 - 0 - 200 = 2800.
  // An undated unknown could fall in any released period, so every one of them is unknown.
  const withBill = bill => Object.assign(plan(), { bills: plan().bills.concat([bill]) });
  const views = advice => [...new Set([...(advice.payPeriodViews || []), ...(advice.defaultView.calendarPeriods || []),
    advice.nextPeriodView, ...(advice.weekViews || [])])].filter(p => p && p.start > AS_OF && p.currentCashUnconfirmed);
  const unknownIn = p => ['periodBillLoad', 'totalBillsThisPeriod', 'remainingBills', 'balanceAfterDeductions'].every(k => p[k] == null)
    && p.periodBillLoadTrust === 'unavailable' && p.balanceAfterDeductionsTrust === 'unavailable';
  const water = { id: 'water', label: 'Invented water', payingAccount: 'chequing-a' };
  const SHAPES = [
    ['a once bill with a null amount on Nov 10', { ...water, amount: null, frequency: 'once', date: '2026-11-10', confidence: 'unknown' }, ['2026-11-06']],
    ['a monthly bill with a null amount on the 10th', { ...water, amount: null, frequency: 'monthly', day: 10, confidence: 'unknown' }, ['2026-11-06', '2026-12-04']],
    ['a monthly bill with no amount on the 10th', { ...water, frequency: 'monthly', day: 10, confidence: 'estimated' }, ['2026-11-06', '2026-12-04']],
  ];
  const ESTIMATES = { '2026-10-23': 1600, '2026-11-06': 2800, '2026-11-20': 1600, '2026-12-04': 2800, '2026-12-18': 2800 };
  for (const [label, bill, unknownStarts] of SHAPES) {
    const a = F.recommend(withBill(bill), AS_OF, Object.assign({ targetBuffer: 500, debts: [] }, OPENING_UNKNOWN));
    ok(a.scheduledAmounts && a.scheduledAmounts.status === 'unavailable', `${label}: the scheduled amount reads unknown`);
    const released = views(a);
    for (const start of unknownStarts) {
      const hit = released.filter(p => p.start === start);
      ok(hit.length > 0 && hit.every(unknownIn), `${label}: the ${start} period that holds it publishes its bills and BAD as unknown, never as $0`,
        JSON.stringify(hit.map(p => [p.periodBillLoad, p.balanceAfterDeductions, p.balanceAfterDeductionsTrust])));
    }
    const others = released.filter(p => !unknownStarts.includes(p.start) && Object.hasOwn(ESTIMATES, p.start));
    ok(others.length > 0 && others.every(p => p.balanceAfterDeductions === ESTIMATES[p.start] && p.balanceAfterDeductionsTrust === 'estimated'),
      `${label}: every other released period keeps its own hand-derived estimate`,
      JSON.stringify(others.map(p => [p.start, p.balanceAfterDeductions])));
  }
  const undated = F.recommend(withBill({ ...water, amount: 40, frequency: 'monthly', confidence: 'estimated' }), AS_OF,
    Object.assign({ targetBuffer: 500, debts: [] }, OPENING_UNKNOWN));
  const releasedUndated = views(undated);
  ok(releasedUndated.length > 0 && releasedUndated.every(unknownIn),
    'an undated bill could fall in any released period: every released period publishes its bills and BAD as unknown',
    JSON.stringify(releasedUndated.map(p => [p.start, p.balanceAfterDeductions])));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll estimated-future-period checks passed.');
