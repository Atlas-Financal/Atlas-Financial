'use strict';
/* Operating Pay Periods are Seaspan payday-to-payday windows.
 *
 * Independently constructed expected boundaries, income membership, and
 * leftover identities (L-002). Synthetic current cash is the fixture;
 * live bank balances are never the specification (L-006).
 *
 * `node test/test-payday-operating-periods.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function lastCalendarDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function periodFromPayday(payday) {
  const next = addCalendarDays(payday, 14);
  return { start: payday, end: addCalendarDays(next, -1), nextPayday: next };
}
function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const SEASPAN_ANCHOR = '2026-08-14';
const SEASPAN_AMT = 4264;
const AMANDA_15_AMT = 2168.85;
const AMANDA_END_AMT = 2387.99;
const CHILD_BENEFIT_AMT = 153.59;
const CURRENT_CASH = 3857.04;
const AS_OF = '2026-09-01';
const WRONG_AVAILABLE = roundCent(CURRENT_CASH + SEASPAN_AMT + AMANDA_15_AMT);
const MOVED = roundCent(SEASPAN_AMT + AMANDA_15_AMT);

const REQUIRED_BOUNDARIES = [
  ['2026-08-28', '2026-09-10'],
  ['2026-09-11', '2026-09-24'],
  ['2026-09-25', '2026-10-08'],
  ['2026-10-09', '2026-10-22'],
  ['2026-10-23', '2026-11-05'],
  ['2026-11-06', '2026-11-19'],
  ['2026-11-20', '2026-12-03'],
  ['2026-12-04', '2026-12-17'],
  ['2026-12-18', '2026-12-31'],
  ['2027-01-01', '2027-01-14'],
  ['2027-01-15', '2027-01-28'],
  ['2027-01-29', '2027-02-11'],
];

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 100, rate: 21.99, payment: 250, pending: 0 },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising',
    balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

function septemberPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: CURRENT_CASH, class: 'spendable',
      }],
      heldElsewhere: [{
        id: 'amanda-debt-payments',
        label: 'TENNIS INCOME',
        value: 1234.56,
        class: 'operational',
      }],
    },
    opening: {
      asOf: AS_OF,
      representedEvents: [
        { id: 'payroll', date: '2026-08-28' },
        { id: 'amandaSalaryMonthEnd', date: '2026-08-31' },
      ],
    },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: SEASPAN_ANCHOR, amount: SEASPAN_AMT, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
        frequency: 'monthly', day: 15, amount: AMANDA_15_AMT,
        confidence: 'confirmed', firstDue: '2026-09-15',
      },
      {
        id: 'amandaSalaryMonthEnd', label: 'Amanda salary — Tennis BC — month end',
        frequency: 'monthly', day: 31, amount: AMANDA_END_AMT,
        confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'monthly',
        day: 20, amount: CHILD_BENEFIT_AMT, confidence: 'confirmed',
      },
    ],
    obligations: [],
    bills: [
      {
        id: 'youtube-premium', label: 'YouTube Premium', frequency: 'monthly',
        day: 2, amount: 17, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
      {
        id: 'netflix', label: 'Netflix', frequency: 'monthly',
        day: 17, amount: 26.87, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    commitments: [],
    groups: [],
    funding: { options: [] },
    budget: {
      weeklyVariable: 0,
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 450, plannedMonthly: 900 },
        { id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 325 },
      ],
    },
  };
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function incomeRow(p, id, date) {
  return ((p && p.income) || []).find(r => r && r.id === id && r.date === date);
}
function tx(id, date, amount, extra) {
  return Object.assign({
    id, transactionId: id, date, amount, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    merchantKnown: true,
  }, extra || {});
}

console.log('=== 1. Independent Seaspan payday-to-payday grid ===');
{
  const independent = [];
  let payday = '2026-08-28';
  for (let i = 0; i < REQUIRED_BOUNDARIES.length; i++) {
    independent.push(periodFromPayday(payday));
    payday = addCalendarDays(payday, 14);
  }
  for (let i = 0; i < REQUIRED_BOUNDARIES.length; i++) {
    const [start, end] = REQUIRED_BOUNDARIES[i];
    const got = independent[i];
    ok(got.start === start && got.end === end,
      `${start} through ${end} from +14 calendar steps, end = next payday - 1`,
      `${got.start}–${got.end}`);
  }
  ok(addCalendarDays('2026-09-11', -1) === '2026-09-10',
    'periodEnd for Aug 28 cycle is Sep 10, not Sep 11');
}

console.log('\n=== 2. Killer September: active available is current cash only ===');
{
  const plan = septemberPlan();
  const tennis = plan.startingCash.heldElsewhere[0].value;
  const spendable = (plan.startingCash.breakdown || []).reduce(
    (s, r) => s + (Number(r.value) || 0), 0);
  ok(near(spendable, CURRENT_CASH) && !near(spendable, CURRENT_CASH + tennis),
    'synthetic Current Balance is household cash; TENNIS INCOME is excluded');
  const expectedThis = periodFromPayday('2026-08-28');
  const expectedNext = periodFromPayday('2026-09-11');
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const view = advice.defaultView;
  const active = period(view, 'this-pay-period');
  const next = period(view, 'next-pay-period');
  ok(active && active.role === 'active'
      && active.start === expectedThis.start && active.end === expectedThis.end,
    'This Pay Period is Aug 28–Sep 10',
    active && `${active.start}–${active.end}`);
  ok(next && next.role === 'future'
      && next.start === expectedNext.start && next.end === expectedNext.end,
    'Next Pay Period is Sep 11–Sep 24',
    next && `${next.start}–${next.end}`);
  ok(view.periodStart === expectedThis.start && view.periodEnd === expectedThis.end,
    'defaultView periodStart/End follow the Seaspan cycle, not calendar halves');
  ok(near(active.currentBalance, CURRENT_CASH)
      && near(active.opening, CURRENT_CASH)
      && near(active.opening, advice.paydayAllocation.available),
    'active Current Balance is trusted posted cash now');
  const aug28 = incomeRow(active, 'payroll', '2026-08-28');
  const aug31 = incomeRow(active, 'amandaSalaryMonthEnd', '2026-08-31');
  ok(aug28 && aug28.alreadyInCash === true && near(aug28.remaining, 0),
    'Aug 28 Seaspan is represented / remaining $0');
  ok(aug31 && aug31.alreadyInCash === true && near(aug31.remaining, 0),
    'Aug 31 Amanda is represented / remaining $0');
  ok(!incomeRow(active, 'payroll', '2026-09-11'),
    'Sep 11 Seaspan is absent from the active period');
  ok(!incomeRow(active, 'amandaSalary15', '2026-09-15'),
    'Sep 15 Amanda is absent from the active period');
  ok(near(active.incomeAdded, 0),
    'no unrepresented future income before Sep 11 is added',
    `incomeAdded=${active.incomeAdded}`);
  ok(near(active.available, roundCent(SEASPAN_AMT + AMANDA_END_AMT))
      && near(active.available, active.incomeTotal),
    'Payday balance is Aug 28 Seaspan + Aug 31 Amanda, not Current Balance');
  ok(!near(active.available, CURRENT_CASH) && !near(active.available, WRONG_AVAILABLE),
    `active Payday balance is not Current Balance or the calendar-half ${WRONG_AVAILABLE.toFixed(2)}`);
  ok(near(WRONG_AVAILABLE, 10289.89) && near(MOVED, 6432.85),
    'the retired wrong available independently equals cash + Sep 11 + Sep 15');
}

console.log('\n=== 3. Next period receives the moved salaries once ===');
{
  const plan = septemberPlan();
  const expectedNext = periodFromPayday('2026-09-11');
  const following = periodFromPayday('2026-09-25');
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const sep11 = incomeRow(next, 'payroll', '2026-09-11');
  const sep15 = incomeRow(next, 'amandaSalary15', '2026-09-15');
  const sep20 = incomeRow(next, 'childBenefit', '2026-09-20');
  const sep25 = incomeRow(next, 'payroll', '2026-09-25');
  ok(sep11 && near(sep11.amount, SEASPAN_AMT) && sep11.alreadyInCash !== true,
    'Sep 11 Seaspan appears exactly once in Next Pay Period');
  ok(sep15 && near(sep15.amount, AMANDA_15_AMT) && sep15.alreadyInCash !== true,
    'Sep 15 Amanda appears exactly once in Next Pay Period');
  ok(sep20 && near(sep20.amount, CHILD_BENEFIT_AMT),
    'Sep 20 child benefit appears exactly once in Next Pay Period');
  ok(!sep25 && following.start === '2026-09-25',
    'Sep 25 Seaspan is absent: it begins the following period');
  const payrollCount = (next.income || []).filter(r => r.id === 'payroll').length;
  const amanda15Count = (next.income || []).filter(r => r.id === 'amandaSalary15').length;
  ok(payrollCount === 1 && amanda15Count === 1,
    'no start-day income double count in the next period');
  const independentIncome = roundCent(SEASPAN_AMT + AMANDA_15_AMT + CHILD_BENEFIT_AMT);
  ok(near(next.incomeAdded, independentIncome),
    'next incomeAdded independently equals Sep 11 + Sep 15 + Sep 20');
  ok(active.openingSource === 'cutover-opening'
      && active.paydayBoundaryOpening !== true
      && active.predictedEndingBalance != null
      && near(active.predictedEndingBalance, roundCent(
        active.incomeTotal - active.periodBillLoad - active.budgetHold)),
    'mid-period cutover still publishes income-led BAD; leftover is not cutover cash');
  ok(next.opening == null || next.openingSource === 'cutover-walk'
      || next.openingSource === 'carry-forward'
      || (active.paydayBoundaryOpening !== true && next.openingSource !== 'carry-forward'),
    'next opening is walk/carry, not a BAD remainder from mid-period cutover cash');
  ok(near(next.available, next.incomeTotal)
      && near(next.available, independentIncome),
    'next Payday balance independently equals next-cycle income, not carryover plus income');
  const youtube = (active.bills || []).find(r => r.id === 'youtube-premium');
  const netflix = (next.bills || []).find(r => r.id === 'netflix');
  const youtubeNext = (next.bills || []).find(r => r.id === 'youtube-premium');
  const netflixActive = (active.bills || []).find(r => r.id === 'netflix');
  ok(youtube && youtube.date === '2026-09-02' && !youtubeNext,
    'Sep 2 bill stays in Aug 28–Sep 10');
  ok(netflix && netflix.date === '2026-09-17' && !netflixActive,
    'Sep 17 bill belongs to Sep 11–Sep 24, not the active period');
}

console.log('\n=== 4. Forecast period boundaries follow the independent 14-day grid ===');
{
  const plan = septemberPlan();
  for (const [start, end] of REQUIRED_BOUNDARIES) {
    const advice = F.recommend(plan, start, { targetBuffer: 500, debts });
    const active = period(advice.defaultView, 'this-pay-period');
    const nextPayday = addCalendarDays(start, 14);
    const next = period(advice.defaultView, 'next-pay-period');
    ok(active && active.start === start && active.end === end,
      `as-of ${start}: This Pay Period is ${start}–${end}`,
      active && `${active.start}–${active.end}`);
    ok(next && next.start === nextPayday && next.end === addCalendarDays(nextPayday, 13),
      `as-of ${start}: Next Pay Period starts on the next Seaspan payday ${nextPayday}`,
      next && `${next.start}–${next.end}`);
    ok(active && active.id !== 'calendar-1-15' && active.id !== 'calendar-16-end',
      `as-of ${start}: operating period is not a calendar half id`);
  }
}

console.log('\n=== 5. January 2027 income cadence composes with payday periods ===');
{
  const plan = septemberPlan();
  plan.opening.asOf = '2027-01-01';
  plan.opening.representedEvents = [{ id: 'payroll', date: '2027-01-01' }];
  plan.startingCash.breakdown[0].value = 8000;
  const jan1 = F.recommend(plan, '2027-01-01', { targetBuffer: 500, debts }).defaultView;
  const thisJan = period(jan1, 'this-pay-period');
  const nextJan = period(jan1, 'next-pay-period');
  ok(thisJan && thisJan.start === '2027-01-01' && thisJan.end === '2027-01-14',
    'Jan 1–14 is the payday period starting on Seaspan Jan 1');
  const thisSalary = (thisJan.income || []).filter(r =>
    r.id === 'payroll' || r.id === 'amandaSalary15' || r.id === 'amandaSalaryMonthEnd');
  ok(thisSalary.length === 1 && thisSalary[0].id === 'payroll' && thisSalary[0].date === '2027-01-01',
    'Jan 1–14 contains Seaspan Jan 1 and neither Jan 15 paycheck',
    thisSalary.map(r => `${r.id}@${r.date}`).join(', '));
  ok(nextJan && nextJan.start === '2027-01-15' && nextJan.end === '2027-01-28',
    'Next from Jan 1 is Jan 15–28');
  const nextSalary = (nextJan.income || []).filter(r =>
    r.id === 'payroll' || r.id === 'amandaSalary15' || r.id === 'amandaSalaryMonthEnd');
  ok(nextSalary.some(r => r.id === 'payroll' && r.date === '2027-01-15')
      && nextSalary.some(r => r.id === 'amandaSalary15' && r.date === '2027-01-15')
      && !nextSalary.some(r => r.date === '2027-01-29'),
    'Jan 15–28 contains Seaspan Jan 15 and Amanda Jan 15, not Jan 29 Seaspan',
    nextSalary.map(r => `${r.id}@${r.date}`).join(', '));
  const jan15 = F.recommend(plan, '2027-01-15', { targetBuffer: 500, debts }).defaultView;
  const later = period(jan15, 'next-pay-period');
  ok(later && later.start === '2027-01-29' && later.end === '2027-02-11',
    'from Jan 15, the following period is Jan 29–Feb 11');
  const laterSalary = (later.income || []).filter(r =>
    r.id === 'payroll' || r.id === 'amandaSalary15' || r.id === 'amandaSalaryMonthEnd');
  const jan31 = iso(2027, 1, lastCalendarDay(2027, 1));
  ok(laterSalary.some(r => r.id === 'payroll' && r.date === '2027-01-29')
      && laterSalary.some(r => r.id === 'amandaSalaryMonthEnd' && r.date === jan31)
      && !laterSalary.some(r => r.id === 'amandaSalary15'),
    'Jan 29–Feb 11 contains Seaspan Jan 29 and Amanda month-end, not Amanda Jan 15',
    laterSalary.map(r => `${r.id}@${r.date}`).join(', '));
}

console.log('\n=== 6. Current-period actuals stay inside the payday window ===');
{
  const plan = septemberPlan();
  const expectedThis = periodFromPayday('2026-08-28');
  const txs = [
    tx('tx-before', '2026-08-27', 80),
    tx('tx-cycle', '2026-08-29', 350),
    tx('tx-asof', '2026-09-01', 25),
    tx('tx-next', '2026-09-11', 90),
  ];
  const advice = F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts,
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: AS_OF,
      coverageStart: '2026-08-01',
      coverageThrough: AS_OF,
      transactionCoverage: 'complete', pendingCoverage: 'complete',
      transactions: txs,
    },
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = (active.householdBudget || []).find(r => r.id === 'groceries');
  const independentSpent = 350 + 25;
  const independentPlanned = 450;
  const independentRemaining = roundCent(independentPlanned - independentSpent);
  ok(groceries && near(groceries.planned, independentPlanned),
    'fixture Groceries planned is the declared Seaspan-cycle target on this plan');
  ok(groceries && near(groceries.spent, independentSpent),
    'only Aug 28–asOf grocery txs reduce remaining',
    groceries && `spent=${groceries.spent}`);
  ok(groceries && near(groceries.remaining, independentRemaining)
      && near(groceries.hold, independentPlanned)
      && !near(groceries.hold, independentRemaining),
    'remaining independently equals planned − committed; hold reserves the full plan');
  const reconIds = ((groceries && groceries.recon) || []).map(r => r.id);
  ok(reconIds.includes('tx-cycle') && reconIds.includes('tx-asof')
      && !reconIds.includes('tx-before') && !reconIds.includes('tx-next'),
    'identity-keyed recon excludes pre-cycle and next-payday txs');
  const youtube = (active.bills || []).find(r => r.id === 'youtube-premium');
  ok(youtube && youtube.status !== 'PAID' && youtube.remaining > 0,
    'future bill through Sep 10 remains');
  const netflix = (active.bills || []).find(r => r.id === 'netflix');
  ok(!netflix, 'Sep 11+ bill does not leak backward into the active period');
}

console.log('\n=== 7. Active leftover identity and represented zeros ===');
{
  const plan = septemberPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const remainingBills = (active.bills || [])
    .filter(r => r && r.status !== 'PAID' && !r.needsDate)
    .reduce((s, r) => s + Math.abs(Number(r.remaining) || 0), 0);
  ok(near(active.remainingBills, remainingBills),
    'remaining bills equal unpaid rows only');
  const paid = (active.bills || []).filter(r => r.status === 'PAID');
  ok(paid.every(r => near(r.remaining, 0)),
    'represented paid bills contribute remaining $0');
  const independentLoad = (active.bills || []).reduce((s, r) => {
    if (!r || r.needsDate) return s;
    if (r.settledInOpening === true || r.settlement === 'opening') return s;
    const paid = r.status === 'PAID' || r.settlement === 'represented';
    if (paid && active.openingAsOf && r.date && r.date < active.openingAsOf) return s;
    const assigned = r.planned != null ? Math.abs(Number(r.planned))
      : Math.abs(Number(r.amount) || 0);
    return s + assigned;
  }, 0);
  ok(near(active.periodBillLoad, independentLoad),
    'assigned period load excludes bills already inside the dated opening');
  ok(active.openingSource === 'cutover-opening'
      && active.afterBills != null
      && near(active.afterBills, roundCent(active.incomeTotal - active.periodBillLoad))
      && active.afterHouseholdBudget != null
      && near(active.afterHouseholdBudget, roundCent(active.afterBills - active.budgetHold))
      && near(active.predictedEndingBalance, active.afterHouseholdBudget),
    'mid-period cutover publishes income-led BAD rather than treating cutover cash as payday morning');
  const received = (active.income || []).filter(r => r.alreadyInCash === true
    || r.status === 'received' || r.settlement === 'represented');
  ok(received.every(r => near(r.remaining, 0)),
    'represented income contribution is $0');
}

console.log('\n=== 8. Unpaid once cash before periodStart stays reserved after payday ===');
{
  const ONCE_AMT = 82.96;
  const ONCE_POST = '2026-08-16';
  const ONCE_DUE = '2026-08-15';
  const ROLLOVER = '2026-08-29';
  const thisWindow = periodFromPayday('2026-08-28');
  ok(thisWindow.start === '2026-08-28' && thisWindow.end === '2026-09-10',
    'independent rollover as-of still sits in Aug 28–Sep 10');
  ok(ONCE_DUE < thisWindow.start,
    'independent scheduled due is before this payday window');

  function planWithOnce(extraBills) {
    const plan = septemberPlan();
    plan.opening.asOf = ROLLOVER;
    plan.bills = (plan.bills || []).concat(extraBills || []);
    return plan;
  }
  const monthly = {
    id: 'bcaa', label: 'BCAA insurance', frequency: 'monthly',
    day: 15, firstDue: '2026-09-15', amount: ONCE_AMT, confidence: 'confirmed',
    payingAccount: 'chequing-a',
  };
  const onceRow = {
    id: 'bcaa-aug15-outstanding',
    label: 'BCAA insurance — 15 August posting unknown',
    frequency: 'once', date: ONCE_POST, amount: ONCE_AMT, confidence: 'confirmed',
    payingAccount: 'chequing-a',
  };
  const control = planWithOnce([monthly]);
  const unpaid = planWithOnce([monthly, onceRow]);
  ok(F.carriedOnceJointCashOutflow(unpaid, onceRow.id, ONCE_POST, thisWindow.start),
    'incumbent carry predicate still names the unresolved once outflow');
  const carried = F.expandEvents(unpaid, thisWindow.start, thisWindow.end)
    .filter(e => e && e.id === onceRow.id);
  ok(carried.length === 1 && carried[0].date === ONCE_POST
      && near(-carried[0].amount, ONCE_AMT),
    'expandEvents still emits the once outflow at its reservation date');

  const controlView = F.recommend(control, ROLLOVER, { targetBuffer: 500, debts }).defaultView;
  const unpaidAdvice = F.recommend(unpaid, ROLLOVER, { targetBuffer: 500, debts });
  const unpaidView = unpaidAdvice.defaultView;
  const controlActive = period(controlView, 'this-pay-period');
  const unpaidActive = period(unpaidView, 'this-pay-period');
  const unpaidNext = period(unpaidView, 'next-pay-period');
  const row = (unpaidActive.bills || []).find(r => r.id === onceRow.id);
  ok(unpaidActive && unpaidActive.start === thisWindow.start
      && unpaidActive.end === thisWindow.end,
    'active operating period is still Aug 28–Sep 10');
  // #887 contract (lead rule-6 decision): row.date is the real reservation
  // occurrence; the original scheduled due is the printed scheduledDue.
  ok(row && row.date === ONCE_POST && row.scheduledDue === ONCE_DUE && row.status !== 'PAID'
      && near(row.remaining, ONCE_AMT) && near(row.amount, ONCE_AMT),
    'unpaid once stays in This Pay Period, printed on its original scheduled due, not the new payday');
  ok(!(unpaidNext.bills || []).some(r => r.id === onceRow.id),
    'overdue once is not moved into Next Pay Period');
  ok(near(unpaidActive.remainingBills, roundCent(controlActive.remainingBills + ONCE_AMT)),
    'remaining bills independently rise by the unpaid once amount');
  ok(near(unpaidActive.available, controlActive.available),
    'Current Balance is unchanged; the once row is not reconstructed cash');
  ok(near(unpaidActive.periodBillLoad, roundCent(controlActive.periodBillLoad + ONCE_AMT)),
    'unpaid overdue once is still in the assigned period load');
  ok(unpaidActive.afterBills != null && controlActive.afterBills != null
      && near(unpaidActive.afterBills, roundCent(
        unpaidActive.incomeTotal - unpaidActive.periodBillLoad))
      && !near(unpaidActive.periodBillLoad, controlActive.periodBillLoad)
      && near(unpaidActive.afterBills, roundCent(
        controlActive.afterBills - ONCE_AMT)),
    'income-led afterBills publishes on mid-period cutover; dropping the overdue once shrinks the assigned load');

  const settled = F.recommend(unpaid, ROLLOVER, {
    targetBuffer: 500, debts,
    representedEvents: [{ id: onceRow.id, date: ONCE_POST }],
  }).defaultView;
  const settledActive = period(settled, 'this-pay-period');
  ok(!(settledActive.bills || []).some(r => r.id === onceRow.id),
    'the same once row disappears once represented/settled');
  ok(near(settledActive.remainingBills, controlActive.remainingBills),
    'represented once no longer reduces remaining bills');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll payday-operating-period checks passed.');
