'use strict';
/* HELOC cash minimum is Forecast Required debt via expandEvents.
 *
 * Owner-stated 2026-09-18: encoded cashPayment / cashDay / cashFirstDue on
 * plan.obligations id heloc is one chequing obligation (kind:obligation).
 * Day-31 capitalise stays nonCash. Cash walk deducts the minimum once.
 *
 * Behaviour uses a synthetic 80-dollar fixture (L-006). Live October is a
 * reconciliation against the encoded cashPayment, not a specification.
 *
 * `node test/test-heloc-forecast-cash-minimum.js`
 */
const F = require('../public/forecast.js');
const live = require('../data.json');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round(Number(n) * 100) / 100;
const money = n => '$' + Number(n).toFixed(2);

const START = '2026-08-19';
const OCT_START = '2026-10-01';
const OCT_END = '2026-10-31';
const CASH = 80;
const CHARGE = 80;

function syntheticPlan() {
  return {
    windowDays: 91,
    defaults: { scenario: 'expected', targetBuffer: 500, extraDebtMonthly: 0 },
    opening: { asOf: START },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 20000 }, { id: 'chequing-b', value: 0 }],
    },
    income: [
      {
        id: 'payroll', label: 'Payroll', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 2000, confidence: 'confirmed',
      },
    ],
    obligations: [
      {
        id: 'mortgage', debtId: 'mortgage', effect: 'payment',
        label: 'Mortgage', frequency: 'biweekly', anchor: '2026-08-14',
        amount: 100, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
      {
        id: 'heloc', debtId: 'heloc', effect: 'capitalise',
        label: 'HELOC interest', frequency: 'monthly', day: 31,
        amount: CHARGE, confidence: 'confirmed', nonCash: true,
        payingAccount: 'chequing-a',
        cashPayment: CASH, cashDay: 21, cashFirstDue: '2026-09-21',
        cashLabel: 'HELOC minimum', cashConfidence: 'estimated',
      },
      {
        id: 'card', debtId: 'card', effect: 'payment',
        label: 'Card minimum', frequency: 'monthly', day: 7,
        amount: 40, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    bills: [
      {
        id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 5,
        amount: 50, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    commitments: [],
    budget: { categories: [] },
  };
}

function independentCashSum(plan, start, end) {
  const heloc = (plan.obligations || []).find(o => o.id === 'heloc');
  return roundCent((F.capitalisingCashMinimumOccurrences(heloc, start, end) || [])
    .reduce((s, occ) => s + Number(occ.amount || 0), 0));
}

console.log('=== expandEvents: one cash hit + noncash capitalise ===');
{
  const plan = syntheticPlan();
  const events = F.expandEvents(plan, START, OCT_END);
  const cash = events.filter(e => e.id === 'heloc' && e.kind === 'obligation');
  const noncash = events.filter(e => e.id === 'heloc' && e.kind === 'noncash');
  const independent = F.capitalisingCashMinimumOccurrences(
    plan.obligations.find(o => o.id === 'heloc'), START, OCT_END);
  ok(independent.length === 2
      && independent.every(occ => occ.amount === CASH)
      && independent[0].date === '2026-09-21'
      && independent[1].date === '2026-10-21',
    'independent cash occurrences are 21 Sep and 21 Oct at the encoded amount');
  ok(cash.length === independent.length
      && cash.every(e => e.effect === 'payment' && e.cashMinimum === true)
      && cash.every(e => near(-e.amount, CASH)),
    'expandEvents emits one kind:obligation cash event per cashDay occurrence');
  ok(cash.every((e, i) => e.date === independent[i].date),
    'cash event dates match capitalisingCashMinimumOccurrences');
  ok(noncash.length === 3
      && noncash.every(e => e.effect === 'capitalise' && near(-e.amount, CHARGE))
      && noncash.map(e => e.date).join(',') === '2026-08-31,2026-09-30,2026-10-31',
    'month-end capitalise remains noncash on the 31st');
  ok(!events.some(e => e.id === 'heloc' && e.kind === 'bill'),
    'HELOC cash is not a bill event');
  ok(!events.some(e => e.id === 'heloc' && e.date === '2026-08-21'),
    'cashFirstDue skips August — Q19 remaining August cash is $0 additional');
}

console.log('\n=== cash walk deducts the minimum once; capitalise is not a second hit ===');
{
  const plan = syntheticPlan();
  const withCash = F.simulate(plan, START, { weeklyVariable: 0, targetBuffer: 500 });
  const stripped = JSON.parse(JSON.stringify(plan));
  stripped.obligations.find(o => o.id === 'heloc').cashPayment = 0;
  const withoutCash = F.simulate(stripped, START, { weeklyVariable: 0, targetBuffer: 500 });
  const wantCash = independentCashSum(plan, START, withCash.end);
  ok(wantCash > 0 && near(wantCash, 2 * CASH),
    'independent 91-day HELOC cash is two encoded minima', money(wantCash));
  ok(near(withoutCash.ending - withCash.ending, wantCash),
    'ending cash falls by exactly the independent cash-minimum sum',
    `${money(withoutCash.ending)} − ${money(withCash.ending)} vs ${money(wantCash)}`);
  ok(near(withCash.totals.obligations - withoutCash.totals.obligations, wantCash),
    'simulate obligations include the cash minimum once');
  ok(near(withCash.totals.noncash, withoutCash.totals.noncash)
      && near(withCash.totals.noncash, 3 * CHARGE),
    'noncash capitalise total is unchanged by emitting cash',
    money(withCash.totals.noncash));
  ok(near(withCash.totals.bills, withoutCash.totals.bills),
    'HELOC cash is not parked in bills');
}

console.log('\n=== October Required debt includes HELOC cash; Bills do not ===');
{
  const plan = syntheticPlan();
  const events = F.expandEvents(plan, OCT_START, OCT_END);
  const cash = events.filter(e => e.kind === 'obligation');
  const bills = events.filter(e => e.kind === 'bill' && e.jointCash !== false && !e.cardPaid);
  const helocCash = cash.filter(e => e.id === 'heloc');
  const helocBills = bills.filter(e => e.id === 'heloc');
  const independent = independentCashSum(plan, OCT_START, OCT_END);
  ok(helocCash.length === 1 && helocCash[0].date === '2026-10-21'
      && near(-helocCash[0].amount, CASH) && near(independent, CASH),
    'October expandEvents Required-debt stream includes one HELOC cash hit');
  ok(helocBills.length === 0,
    'October HELOC cash is not under Bills');
  const noncash = events.filter(e => e.id === 'heloc' && e.kind === 'noncash');
  ok(noncash.length === 1 && noncash[0].date === '2026-10-31',
    'October capitalise is still present and noncash');
}

console.log('\n=== Budget bills list still prints HELOC cash once ===');
{
  const plan = syntheticPlan();
  const view = F.recommend(plan, '2026-09-20', {
    targetBuffer: 500,
    debts: [
      { id: 'mortgage', label: 'Mortgage', secured: true, balance: 1000, pending: 0, rate: 3.64, payment: 100 },
      { id: 'heloc', label: 'HELOC', secured: true, balance: 1000, pending: 0, rate: 4.9,
        payment: 0, cashPayment: 0, interestTreatment: 'capitalised' },
      { id: 'card', label: 'Card', secured: false, balance: 200, pending: 0, rate: 19.99, payment: 40 },
    ],
  }).defaultView;
  const rows = ((view && view.bills) || []).filter(r => r.id === 'heloc' || r.cashMinimum);
  ok(view && rows.length === 1 && rows[0].date === '2026-09-21' && near(rows[0].amount, CASH),
    'Budget payday bills list still shows the September HELOC cash once',
    rows.map(r => `${r.date}:${r.amount}`).join(','));
  const acrossPeriods = ((view && view.calendarPeriods) || [])
    .flatMap(p => p.bills || [])
    .filter(r => r.id === 'heloc' || r.cashMinimum);
  ok(acrossPeriods.length === 1,
    'calendar period bills do not double-print HELOC cash after expandEvents emits it',
    acrossPeriods.map(r => `${r.date}:${r.amount}`).join(','));
}

console.log('\n=== live October Required debt reconciles to encoded cashPayment ===');
{
  const plan = live.plan;
  const heloc = (plan.obligations || []).find(o => o.id === 'heloc');
  const encoded = Number(heloc && heloc.cashPayment);
  ok(heloc && heloc.nonCash === true && heloc.effect === 'capitalise'
      && heloc.cashDay === 21 && heloc.cashFirstDue === '2026-09-21'
      && near(encoded, 814.18),
    'live encoding is still cashPayment 814.18 / cashDay 21 / cashFirstDue 2026-09-21');
  const independent = F.capitalisingCashMinimumOccurrences(heloc, OCT_START, OCT_END);
  ok(independent.length === 1 && independent[0].date === '2026-10-21'
      && near(independent[0].amount, encoded),
    'independent October cash occurrence is one encoded minimum on the 21st',
    money(independent[0] && independent[0].amount));
  const events = F.expandEvents(plan, OCT_START, OCT_END);
  const cash = events.filter(e => e.id === 'heloc' && e.kind === 'obligation');
  const noncash = events.filter(e => e.id === 'heloc' && e.kind === 'noncash');
  const bills = events.filter(e => e.id === 'heloc' && e.kind === 'bill');
  ok(cash.length === 1 && near(-cash[0].amount, encoded) && cash[0].date === '2026-10-21'
      && cash[0].effect === 'payment',
    'live October expandEvents emits one HELOC cash obligation');
  ok(noncash.length === 1 && noncash[0].date === '2026-10-31' && near(-noncash[0].amount, encoded),
    'live October capitalise is still noncash on the 31st');
  ok(bills.length === 0, 'live October HELOC cash is not a bill');

  const traj = F.baselineTrajectory(plan, live.debts, live.meta.asOf, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const oct = (traj.months || []).find(m => m.month === '2026-10');
  const lines = (oct && oct.stage1 && oct.stage1.obligations && oct.stage1.obligations.lines) || [];
  const helocLine = lines.find(row => row.id === 'heloc' || /HELOC/i.test(row.label || ''));
  const billLines = (oct && oct.stage1 && oct.stage1.bills && oct.stage1.bills.lines) || [];
  ok(oct && oct.stage1 && oct.stage1.obligations,
    'live October Forecast month publishes stage1.obligations');
  ok(helocLine && near(helocLine.amount, encoded),
    'live October Required debt includes HELOC cash ≈ encoded cashPayment',
    helocLine ? money(helocLine.amount) : 'missing');
  ok(!billLines.some(row => row.id === 'heloc' || /HELOC/i.test(row.label || '')),
    'live October Forecast Bills does not also list HELOC');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
