'use strict';
/* Forecast.baselineTrajectory calendar-month funding stages, read straight from
 * the engine.
 *
 * The Budget no longer renders a Month view, but baselineTrajectory months[]
 * still feeds the Forecast page and the assistant packet. These checks kept the
 * engine's month contract observed independently of any page: the three stages
 * and the standalone-period contract, the date-order result that can diverge
 * from the arithmetic identity, and a month with no closing pay period reading
 * Unknown, never $0.00.
 *
 * Every expected figure is hand arithmetic from the invented inputs below, not a
 * second call to the producer.
 *
 * `node test/test-baseline-trajectory-month-stages.js`
 */
const assert = require('assert/strict');
const F = require('../public/forecast.js');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

/* ---- stages, the standalone contract and date-order truth ------------------ */

function basePlan() {
  return {
    windowDays: 91,
    defaults: { targetBuffer: 0, extraDebtMonthly: 50, scenario: 'expected' },
    opening: { asOf: '2026-09-25' },
    startingCash: { amount: 1000 },
    income: [
      { id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: '2026-09-11', amount: 2500, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 1,
        amount: 1200, confidence: 'confirmed' },
    ],
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 140 },
      ],
    },
    commitments: [],
  };
}

function periodsFixture() {
  return { periods: { ytd: { label: 'YTD fixture', months: 1, spending: [{ label: 'Groceries', total: 50000 }] } } };
}

function runTrajectory(plan) {
  return F.baselineTrajectory(plan, [], '2026-09-25', {
    periods: periodsFixture(), extraFacilities: null, currentPeriodActuals: null,
  });
}

let traj = null;
check('A1: Forecast publishes months[] with stage1/stage2/stage3', () => {
  traj = runTrajectory(basePlan());
  assert.equal(traj.status, 'ready');
  assert.ok(Array.isArray(traj.months) && traj.months.length > 0);
  // As-of 2026-09-25 is itself a payday, so no pay period closes in September
  // any more: that first month is Unknown (a month with no closing period never
  // prints a confident $0.00). The funding decomposition is read from the first
  // month in which a pay period closes.
  assert.equal(traj.months[0].stage1.status, 'unavailable', 'September has no closing pay period: Unknown, not $0');
  const m = traj.months.find(x => x.closingPayPeriods && x.closingPayPeriods.length);
  assert.ok(m, 'a month with a closing pay period exists');
  assert.ok(m.stage1 && m.stage1.income, 'stage1.income present');
  assert.ok(m.stage1.householdBudget, 'stage1.householdBudget present');
  assert.ok(m.stage1.bills, 'stage1.bills present');
  assert.ok(m.stage1.obligations, 'stage1.obligations present');
  assert.ok(m.stage2 && m.stage2.commitments, 'stage2.commitments present');
  assert.ok(m.stage3 && m.stage3.result, 'stage3.result present');
  assert.ok(m.stage3 && m.stage3.dateOrderResult, 'stage3.dateOrderResult present');
});

check('A2: roadAheadSurplusDeficit names the standalone-period contract', () => {
  const rs = traj.roadAheadSurplusDeficit;
  assert.equal(rs.identity, 'standalone-period-surplus-deficit');
  assert.equal(rs.priorPeriodSurplus, 'excluded');
  assert.equal(rs.source, 'stage3.result');
  assert.equal(rs.cumulativeCash, 'not-this-result');
});

check('A3: the date-order result diverges from the arithmetic identity, with exact hand-worked figures', () => {
  // A $2,000 dated commitment due 2026-10-05: the October pay periods close on
  // 10-08 and 10-22, so no period surplus has closed by the due date. Two
  // 14-day periods close in October.
  //   income        2 x 2,500                   = 5,000
  //   household     $140 a week = $20 a day x 28 =   560
  //   bills         rent on Oct 1                = 1,200
  //   stage 1       5,000 - 560 - 1,200 - 0      = 3,240
  //   stage 2       3,240 - 2,000                = 1,240 (arithmetic identity)
  //   date order    nothing has closed by 10-05  = -2,000
  //   stage 3       extra debt $50: 1,240 - 50   = 1,190; date order -2,000 - 50 = -2,050
  const plan = basePlan();
  plan.startingCash = { amount: 10000 };
  plan.commitments = [
    { id: 'roof', label: 'Roof repair', date: '2026-10-05', amount: 2000, confidence: 'confirmed' },
  ];
  const t = runTrajectory(plan);
  assert.equal(t.status, 'ready');
  const m = t.months.find(x => x.month === '2026-10');
  assert.ok(m, 'october published');
  assert.equal(m.stage1.income.amount, 5000);
  assert.equal(m.stage1.householdBudget.amount, 560);
  assert.equal(m.stage1.bills.amount, 1200);
  assert.equal(m.stage1.obligations.amount, 0);
  assert.equal(m.stage1.result.amount, 3240);
  assert.equal(m.stage2.commitments.amount, 2000);
  assert.equal(m.stage2.result.amount, 1240, 'stage 2 arithmetic identity is a surplus');
  assert.equal(m.stage2.dateOrderResult.amount, -2000, 'stage 2 date-order result is a deficit');
  assert.equal(m.stage3.extras.amount, 50);
  assert.equal(m.stage3.result.amount, 1190, 'stage 3 arithmetic identity is a surplus');
  assert.equal(m.stage3.dateOrderResult.amount, -2050, 'stage 3 date-order result is a deficit');
  assert.equal(m.stage3.dateOrderResult.identity, 'date-order-month-funding');
});

/* ---- a month with no closing pay period is Unknown, never $0.00 ----------- */

const plan = (asOf, income) => ({
  defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' }, windowDays: 200,
  opening: { asOf }, startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 5000, class: 'spendable' }] },
  budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 100 }] },
  obligations: [], commitments: [],
  bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 1, amount: 900, confidence: 'confirmed', payingAccount: 'chequing-a' }],
  income: [income],
});
const biweekly = { id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-02', amount: 1400, confidence: 'confirmed' };
const monthly = { id: 'payroll', label: 'Invented pay', frequency: 'monthly', day: 15, amount: 1400, confidence: 'confirmed' };
const trajectory = (asOf, income) => F.baselineTrajectory(plan(asOf, income), [], asOf, { weeklyVariable: 100,
  periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 50000 }] } } } });
const monthOf = (t, key) => (t.months || []).find(m => m.month === key);

// Invented world: biweekly 1,400 payroll anchored Fri 2026-10-02 (paydays Oct 2,
// 16, 30, Nov 13, 27, Dec 11, 25). As of Oct 14 the October pay periods still
// ahead are funded by one 1,400 payday (October $1,400); November closes two
// periods (the Oct 30 and Nov 13 paydays) = $2,800; December closes two
// (Nov 27 and Dec 11) = $2,800.
check('N1: months in which pay periods close keep their hand-worked Total income', () => {
  const t = trajectory('2026-10-14', biweekly);
  assert.equal(t.status, 'ready');
  for (const [key, income] of [['2026-10', 1400], ['2026-11', 2800], ['2026-12', 2800]]) {
    const m = monthOf(t, key);
    assert.equal(m.stage1.status, 'calculated', key);
    assert.equal(m.stage1.income.amount, income, key + ' Total income');
    assert.equal(m.stage1.income.status, 'calculated', key);
  }
});

check('N2: a payday on the 30th with no pay period closing in October reads Unknown with the plain reason', () => {
  const t = trajectory('2026-10-30', biweekly);
  const oct = monthOf(t, '2026-10');
  assert.equal(oct.income.amount, 1400, 'a payday falls inside October (calendar income 1,400)');
  assert.equal(oct.stage1.status, 'unavailable');
  assert.match(oct.stage1.reason, /No Seaspan pay period closes in this month/);
  assert.equal(oct.stage2.status, 'unavailable');
  assert.equal(oct.stage3.status, 'unavailable');
  for (const stage of [oct.stage1, oct.stage2, oct.stage3]) {
    assert.equal(stage.income, undefined, 'no confident component rides an unavailable stage');
    assert.equal(stage.result, undefined, 'no $0.00 result rides an unavailable stage');
  }
});

check('N3: a monthly-paid household has no Seaspan pay periods: every month is Unknown, never $0.00', () => {
  const t = trajectory('2026-10-14', monthly);
  const nov = monthOf(t, '2026-11');
  assert.equal(nov.stage1.status, 'unavailable');
  assert.equal(nov.stage1.income, undefined);
});

console.log(`\n${checks} baselineTrajectory month-stage checks passed.`);
