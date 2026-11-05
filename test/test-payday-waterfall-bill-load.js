'use strict';
/* Frozen payday waterfall bill load (owner-observed leftover defect).
 *
 * Payday balance is the period income identity (here $0). The frozen
 * payday opening stays a separate snapshot fact. The Bills step subtracts
 * the assigned period bill load, including subsequently PAID rows that
 * are not already inside that opening. Remaining is settlement status.
 *
 * Independent expected leftover:
 *   afterBills = PAYDAY_BALANCE − LOAD (0 − 1500 = −1500)
 * Frozen payday opening stays a snapshot fact but is not a term in
 * afterBills. Settlement must not raise that leftover. Remaining $0
 * must not subtract $0 from the frozen snapshot.
 *
 * `node test/test-payday-waterfall-bill-load.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  }
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallsHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-08-28';
const MID = '2026-09-04';
const FROZEN = 6000;
const BILL_A = 1000;
const BILL_B = 500;
const LOAD = roundCent(BILL_A + BILL_B);
const PAYDAY_BALANCE = 0;
const AFTER_BILLS = roundCent(PAYDAY_BALANCE - LOAD);
const WRONG_REMAINING_ONLY = roundCent(FROZEN + PAYDAY_BALANCE - BILL_B);
const BUDGET_HOLD = 200;
const LIVE_CASH = 4123.45;

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}

function assignedAmount(row) {
  if (!row) return 0;
  if (row.planned != null && isFinite(Number(row.planned))) {
    return Math.abs(Number(row.planned));
  }
  return Math.abs(Number(row.amount) || 0);
}

function independentPeriodLoad(rows, openingAsOf, openingSource) {
  return roundCent((rows || []).reduce((sum, row) => {
    if (!row || row.needsDate) return sum;
    if (row.settledInOpening === true || row.settlement === 'opening') return sum;
    const paid = row.status === 'PAID' || row.settlement === 'represented';
    if (paid && openingAsOf && row.date) {
      if (row.date < openingAsOf) return sum;
      if (row.date === openingAsOf
          && openingSource !== 'snapshot'
          && openingSource !== 'cutover-walk'
          && openingSource !== 'carry-forward') {
        return sum;
      }
    }
    return sum + assignedAmount(row);
  }, 0));
}

function frozenPlan(extraBills, representedEvents) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: LIVE_CASH },
    opening: {
      asOf: MID,
      priorAsOf: '2026-08-19',
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: FROZEN },
      representedEvents: representedEvents || [],
    },
    income: [
      {
        id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: PAYDAY, amount: 0, confidence: 'confirmed',
      },
    ],
    bills: extraBills || [
      {
        id: 'bill-a', label: 'Bill A', frequency: 'once',
        date: '2026-09-01', amount: BILL_A, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'bill-b', label: 'Bill B', frequency: 'once',
        date: '2026-09-03', amount: BILL_B, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedPayday: BUDGET_HOLD,
        },
      ],
    },
  };
}

function recommend(plan, extra) {
  return F.recommend(plan, MID, Object.assign({
    targetBuffer: plan.defaults && plan.defaults.targetBuffer,
    debts: [],
  }, extra || {}));
}

const composer = loadComposer();

console.log('=== 1. Paid bill still leaves the frozen payday snapshot ===');
{
  const plan = frozenPlan(null, [{ id: 'bill-a', date: '2026-09-01' }]);
  const advice = recommend(plan);
  const active = period(advice.defaultView, 'this-pay-period');
  const rowA = (active.bills || []).find(r => r.id === 'bill-a');
  const rowB = (active.bills || []).find(r => r.id === 'bill-b');
  ok(active && active.openingKnown === true && active.openingSource === 'snapshot'
      && near(active.opening, FROZEN) && near(active.available, PAYDAY_BALANCE),
    'This Pay Period opens from the frozen payday snapshot; Payday balance is period income');
  ok(!near(active.available, LIVE_CASH),
    'live Current Balance is not the waterfall opening');
  ok(rowA && rowA.status === 'PAID' && near(rowA.remaining, 0)
      && near(assignedAmount(rowA), BILL_A),
    'Bill A is listed PAID with remaining $0; planned amount is unchanged');
  ok(rowB && rowB.status !== 'PAID' && near(rowB.remaining, BILL_B),
    'Bill B remains unpaid');
  ok(near(active.remainingBills, BILL_B) && near(active.paidBills, BILL_A)
      && near(active.totalBillsThisPeriod, LOAD),
    'disclosure: paid $1,000, remaining $500, total $1,500');
  const independent = independentPeriodLoad(
    active.bills, active.openingAsOf, active.openingSource);
  ok(near(independent, LOAD) && near(active.periodBillLoad, LOAD),
    'authoritative period bill load is $1,500, not the $500 remaining');
  ok(near(active.afterBills, AFTER_BILLS)
      && near(active.afterRemainingBills, AFTER_BILLS),
    'after bills is Payday balance $0 − $1,500');
  ok(!near(active.afterBills, WRONG_REMAINING_ONLY),
    'Forecast does not return $5,500 from remaining-only arithmetic');
  ok(near(active.afterHouseholdBudget, roundCent(AFTER_BILLS - BUDGET_HOLD)),
    'Household Budget starts from the corrected post-bills balance');
}

console.log('\n=== 2. Settlement invariance: unpaid vs one bill paid ===');
{
  const unpaid = recommend(frozenPlan(null, []));
  const onePaid = recommend(frozenPlan(null, [{ id: 'bill-a', date: '2026-09-01' }]));
  const stateA = period(unpaid.defaultView, 'this-pay-period');
  const stateB = period(onePaid.defaultView, 'this-pay-period');
  ok(near(stateA.available, PAYDAY_BALANCE) && near(stateB.available, PAYDAY_BALANCE),
    'both states share the same Payday balance');
  ok(near(stateA.periodBillLoad, LOAD) && near(stateB.periodBillLoad, LOAD),
    'authoritative bill load is identical before and after settlement');
  ok(near(stateA.afterBills, AFTER_BILLS) && near(stateB.afterBills, AFTER_BILLS)
      && near(stateA.afterBills, stateB.afterBills),
    'post-Bills leftover is identical in State A and State B');
  ok(near(stateA.remainingBills, LOAD) && near(stateB.remainingBills, BILL_B)
      && near(stateA.paidBills, 0) && near(stateB.paidBills, BILL_A),
    'only settlement disclosure changes');
}

console.log('\n=== 3. All-paid does not restore the $6,000 snapshot ===');
{
  const advice = recommend(frozenPlan(null, [
    { id: 'bill-a', date: '2026-09-01' },
    { id: 'bill-b', date: '2026-09-03' },
  ]));
  const active = period(advice.defaultView, 'this-pay-period');
  ok(near(active.remainingBills, 0) && near(active.paidBills, LOAD)
      && near(active.periodBillLoad, LOAD),
    'remaining $0, paid $1,500, load still $1,500');
  ok(near(active.afterBills, AFTER_BILLS),
    'all-paid leftover stays Payday balance minus the full bill load');
  ok(!near(active.afterBills, FROZEN),
    'remaining $0 does not subtract $0 from the frozen snapshot');
}

console.log('\n=== 4. Observed actual does not rewrite the assigned load ===');
{
  const plan = frozenPlan(null, [{ id: 'bill-a', date: '2026-09-01' }]);
  const advice = recommend(plan, {
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: MID,
      coverageStart: PAYDAY,
      coverageThrough: MID,
      pendingCoverage: 'complete',
      representedActuals: [
        // Invented final invoice, distinct from the frozen planned allowance.
        { id: 'bill-a', date: '2026-09-01', actual: 900, due: 900,
          amountRule: 'variable-amount', postedOn: '2026-09-01' },
      ],
      transactions: [],
    },
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const rowA = (active.bills || []).find(r => r.id === 'bill-a');
  ok(rowA && rowA.status === 'PAID' && rowA.actual != null && near(rowA.actual, 900)
      && near(assignedAmount(rowA), BILL_A),
    'actual $900 is settlement evidence; planned assignment stays $1,000');
  ok(near(active.periodBillLoad, LOAD) && near(active.afterBills, AFTER_BILLS),
    'waterfall still deducts the assigned $1,500, not the $900 actual');
  ok(!near(active.afterBills, roundCent(FROZEN - 900 - BILL_B)),
    'a cheaper actual does not shrink the frozen period bill load');
}

console.log('\n=== 5. Card-paid reserved bill is not deducted twice ===');
{
  const CARD_BILL = 121;
  const CARD_MIN = 17;
  const bills = [
    {
      id: 'bell', label: 'Bell Mobility', frequency: 'once',
      date: '2026-09-01', amount: CARD_BILL, confidence: 'confirmed',
      payingAccount: 'travelvisa',
    },
    {
      id: 'bill-b', label: 'Bill B', frequency: 'once',
      date: '2026-09-03', amount: BILL_B, confidence: 'confirmed',
      payingAccount: 'chequing-a',
    },
  ];
  const obligations = [
    {
      id: 'travel-min', label: 'Travel Visa minimum', frequency: 'once',
      date: '2026-09-02', amount: CARD_MIN, confidence: 'confirmed',
      debtId: 'travelvisa', effect: 'payment', payingAccount: 'chequing-a',
    },
  ];
  const debts = [
    {
      id: 'travelvisa', label: 'Travel Visa', secured: false,
      structure: 'Revolving', balance: 200, rate: 19.99, payment: CARD_MIN,
      pending: 0, rateConvention: 'card',
    },
  ];
  function cardPlan(representedEvents) {
    const plan = frozenPlan(bills, representedEvents);
    plan.obligations = obligations;
    return plan;
  }
  const unpaid = F.recommend(cardPlan([]), MID, { targetBuffer: 0, debts });
  const paidBell = F.recommend(cardPlan([{ id: 'bell', date: '2026-09-01' }]), MID, {
    targetBuffer: 0, debts,
  });
  const stateA = period(unpaid.defaultView, 'this-pay-period');
  const stateB = period(paidBell.defaultView, 'this-pay-period');
  const bell = (stateA.bills || []).find(r => r.id === 'bell');
  const minRow = (stateA.bills || []).find(r => r.id === 'travel-min');
  ok(bell && bell.cardPaid === true && minRow && minRow.cardPaid !== true,
    'Bell is the reserved card-paid bill; the card minimum is a separate cash row');
  const independent = roundCent(CARD_BILL + CARD_MIN + BILL_B);
  ok(near(stateA.periodBillLoad, independent) && near(stateB.periodBillLoad, independent),
    'card-paid bill + card minimum + cash bill are each counted once');
  ok(near(stateA.afterBills, stateB.afterBills)
      && near(stateA.afterBills, roundCent(PAYDAY_BALANCE - independent)),
    'marking Bell PAID does not change the bills step or add a third hit');
  ok(!near(stateB.afterBills, roundCent(PAYDAY_BALANCE - independent - CARD_BILL)),
    'settlement does not deduct Bell a second time');
}

console.log('\n=== 6. Paid-before-opening stays inside mid-period cutover cash ===');
{
  const plan = {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 8000 },
    opening: { asOf: MID },
    income: [
      {
        id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: PAYDAY, amount: 0, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'pre-open', label: 'Paid before as-of', frequency: 'once',
        date: '2026-09-01', amount: BILL_A, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
      {
        id: 'still-due', label: 'Still due', frequency: 'once',
        date: '2026-09-05', amount: BILL_B, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  };
  const advice = F.recommend(plan, MID, {
    targetBuffer: 0,
    debts: [],
    representedEvents: [{ id: 'pre-open', date: '2026-09-01' }],
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const paid = (active.bills || []).find(r => r.id === 'pre-open');
  ok(active.openingSource === 'cutover-opening' && near(active.opening, 8000),
    'mid-period dated opening is posted cash on as-of');
  ok(paid && paid.status === 'PAID' && near(active.remainingBills, BILL_B),
    'the earlier settlement stays listed as PAID');
  ok(near(active.periodBillLoad, BILL_B),
    'paid-before-opening is not deducted again from the period bill load');
  ok(active.paydayBoundaryOpening !== true,
    'mid-period cutover cash is not treated as the payday-boundary leftover opening');
  ok(near(active.afterBills, roundCent((active.incomeTotal || 0) - active.periodBillLoad))
      && active.predictedEndingBalance != null
      && near(active.predictedEndingBalance, roundCent(
        active.afterBills - (Number(active.budgetHold) || 0))),
    'BAD still publishes (income-led); cash leftover / payday-boundary leftover may still be withheld');
  ok(!near(roundCent(active.opening + (active.incomeAdded || 0) - LOAD),
      roundCent(active.opening + (active.incomeAdded || 0) - BILL_B)),
    'blind total-bills subtraction would double-count the already-cleared $1,000');
}

console.log('\n=== 7. Plan integration: Forecast leftover, truthful label, no page math ===');
{
  const plan = frozenPlan(null, [{ id: 'bill-a', date: '2026-09-01' }]);
  const advice = recommend(plan);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarWaterfallsHtml(
    advice.defaultView, 'this-pay-period', {
      applied: true,
      operatingPlan: 'live',
      fetchedAt: '2026-09-04T18:00:00.000Z',
      observedAsOf: MID,
      observedCash: {
        complete: true,
        asOf: MID,
        accounts: [{ id: 'chequing-a', value: LIVE_CASH, evidenceDate: MID }],
      },
    }, advice.paydayAllocation);
  ok(active.openingKnown === true && near(active.opening, FROZEN) && near(active.available, PAYDAY_BALANCE)
      && (active.bills || []).some(r => r.id === 'bill-a' && r.status === 'PAID')
      && (active.bills || []).some(r => r.id === 'bill-b' && r.status !== 'PAID'),
    'operating period earns the frozen opening and contains paid plus unpaid bills');
  ok(/data-operating-prompt="Balance after bills"/.test(html)
      && !/data-operating-prompt="Balance after remaining bills"/.test(html),
    'household-facing leftover label is Balance after bills');
  ok(html.includes(composer.money2(AFTER_BILLS))
      && html.includes(composer.money2(active.afterHouseholdBudget))
      && html.includes(composer.money2(BILL_A))
      && html.includes(composer.money2(BILL_B)),
    'page prints Forecast after-bills, after-budget, and paid/remaining amounts');
  ok(/Total bills this period/.test(html) && /Paid bills this period/.test(html)
      && /Remaining bills to pay/.test(html),
    'Bills disclosure still prints total, paid, and remaining');
  ok(!near(active.afterBills, WRONG_REMAINING_ONLY)
      && html.includes(composer.money2(AFTER_BILLS)),
    'page publishes Forecast afterBills, not remaining-only leftover');
  const planSrc = read('public/plan.js');
  const waterfallFn = grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');
  const billsFn = grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml');
  ok(/period\.afterBills/.test(waterfallFn)
      && !/available\s*-/.test(waterfallFn)
      && !/remainingBills/.test(waterfallFn),
    'plan.js renders Forecast afterBills; it does not subtract remaining itself');
  ok(/period\.totalBillsThisPeriod/.test(billsFn)
      && /period\.paidBills/.test(billsFn)
      && /period\.remainingBills/.test(billsFn)
      && !/periodBillLoad/.test(billsFn),
    'page prints settlement totals and does not add periodBillLoad as a second deduction');
}

console.log('\n=== 8. Remaining is not added after the full load ===');
{
  const advice = recommend(frozenPlan(null, [{ id: 'bill-a', date: '2026-09-01' }]));
  const active = period(advice.defaultView, 'this-pay-period');
  const double = roundCent((active.incomeTotal || 0)
    - active.periodBillLoad - active.remainingBills);
  ok(near(active.afterBills, roundCent((active.incomeTotal || 0) - active.periodBillLoad)),
    'after bills subtracts the load once');
  ok(!near(active.afterBills, double),
    'remaining is not a second deduction after the full load');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll payday-waterfall bill-load checks passed.');
