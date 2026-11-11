'use strict';
/* Financial Trajectory — Forecast-owned pay-period series on
 * Forecast.baselineTrajectory. Month and Pay Period are two views of
 * the same prepareBaselineTrajectoryWalk / simulate / projectDebts walk.
 * Three-stage funding reuses the monthly helpers; Household Budget is
 * walk-applied weeklyVariable / 7 on simulate days in the Seaspan span,
 * not a 14-day calendar smear. Unavailable is not $0.
 * `node test/test-baseline-trajectory-pay-period-series.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const liveHash = hashFile(DATA);
const START = '2026-06-15';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;
const JUL = '2026-07';
const JUL_10 = '2026-07-10';

function roundCent(n) {
  return Math.round(n * 100) / 100;
}

function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [
          { label: 'Groceries', total: 50000 },
          { label: 'Travel', total: 18000 },
          { label: 'Phone', total: 9000 },
        ],
      },
    },
  };
}

function fixture(extraPlan, extraDebts) {
  const plan = Object.assign({
    windowDays: 91,
    startingCash: { amount: 2500 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 75, scenario: 'expected' },
    opening: { asOf: START },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    budget: {
      basis: 'ytd',
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 140,
        },
        {
          id: 'travel', label: 'Travel', class: 'discretionary',
          from: ['Travel'],
        },
        {
          id: 'telecom-undated', label: 'Undated telecom', class: 'essential',
          from: ['Phone'], currentMonthly: 400,
        },
      ],
    },
    income: [
      {
        id: 'payroll', label: 'Synthetic payroll',
        frequency: 'biweekly', anchor: '2026-06-12',
        amount: 2000, confidence: 'estimated',
      },
    ],
    obligations: [
      {
        id: 'card-min', debtId: 'card', effect: 'payment',
        label: 'Card minimum', frequency: 'monthly', day: 20,
        amount: 80, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 5,
        amount: 120, confidence: 'confirmed',
      },
      {
        id: 'card-stream', label: 'Card-paid stream', frequency: 'monthly', day: 8,
        amount: 50, jointCash: false, confidence: 'confirmed',
      },
    ],
    commitments: [
      {
        id: 'camp', label: 'Required camp', date: '2026-07-10',
        amount: 400, flexibility: 'required', confidence: 'confirmed',
      },
      {
        id: 'optional-trip', label: 'Optional trip', date: '2026-07-12',
        amount: 999, flexibility: 'optional', confidence: 'confirmed',
      },
    ],
  }, extraPlan || {});
  const debts = extraDebts || [
    {
      id: 'card', label: 'Synthetic card',
      balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic', secured: false, limit: 1500,
    },
  ];
  return { plan, debts };
}

function ask(plan, debts) {
  return F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
}

function independentWeekly(plan, asOf, periods) {
  asOf = asOf || START;
  periods = periods || periodsFixture();
  const bd = F.budgetBreakdown(plan, periods, { asOf });
  const plannedMonthly = (bd.categories || [])
    .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (Number(c.planned) || 0), 0);
  return roundCent(plannedMonthly / WEEKS_PER_MONTH);
}

function independentWalkEvents(plan, debts, asOf, periods) {
  asOf = asOf || START;
  periods = periods || periodsFixture();
  const weekly = independentWeekly(plan, asOf, periods);
  const horizon = F.knowledgeHorizon(plan, asOf);
  const extraDebtMonthly = (plan.defaults && plan.defaults.extraDebtMonthly) || 0;
  const debtWalk = F.projectDebts(plan, debts, asOf, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    debtHorizonDays: horizon.days,
    periods,
  });
  const events = F.expandEvents(plan, horizon.start, horizon.end, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    extraAbsorbed: debtWalk && debtWalk.extraAbsorbed,
    obligationAbsorbed: debtWalk && debtWalk.obligationAbsorbed,
    periods,
  });
  return { weekly, horizon, events, extraAbsorbed: debtWalk && debtWalk.extraAbsorbed };
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function independentWalkDays(walkStart, walkEnd, spanStart, spanEnd) {
  let n = 0;
  let date = walkStart;
  while (date <= walkEnd) {
    if (date >= spanStart && date <= spanEnd) n += 1;
    date = addDays(date, 1);
  }
  return n;
}

// Independent of Forecast.cashWalkDate: joint-cash outflows scheduled
// before the walk start apply at the opening; income / non-cash / in-window
// events keep their scheduled date.
function independentCashWalkDate(event, start) {
  if (event && start && event.date < start
      && event.amount < 0 && event.kind !== 'noncash' && event.jointCash !== false) {
    return start;
  }
  return event && event.date;
}

function independentSpan(plan, debts, span, asOf, periods) {
  const walk = independentWalkEvents(plan, debts, asOf, periods);
  const walkStart = asOf || START;
  const events = (walk.events || []).filter(e => {
    if (!e) return false;
    const apply = independentCashWalkDate(e, walkStart);
    return apply >= span.start && apply <= span.end;
  });
  const walkDays = independentWalkDays(
    walk.horizon.start, walk.horizon.end, span.start, span.end);
  const sumKind = (pred, sign) => roundCent(events.filter(pred)
    .reduce((s, e) => s + sign * (Number(e.amount) || 0), 0));
  const income = sumKind(e => e.kind === 'income', 1);
  const bills = sumKind(e => e.kind === 'bill' && e.jointCash !== false && !e.cardPaid, -1);
  const obligations = sumKind(e => e.kind === 'obligation', -1);
  const commitments = sumKind(e => e.kind === 'commitment', -1);
  const extras = sumKind(e => e.kind === 'extra' && e.id !== 'hypothetical-extra', -1);
  const householdBudget = roundCent(walk.weekly * walkDays / 7);
  const stage1 = roundCent(income - bills - obligations - householdBudget);
  const stage2 = roundCent(stage1 - commitments);
  const stage3 = roundCent(stage2 - extras);
  return {
    weekly: walk.weekly,
    walkDays,
    income,
    bills,
    obligations,
    householdBudget,
    commitments,
    extras,
    stage1,
    stage2,
    stage3,
    events,
    horizon: walk.horizon,
  };
}

// Reconstruct Seaspan payday-to-payday windows from the payroll stream
// and incumbent spendingCycle, independently of baselineTrajectory.
function independentPayPeriods(plan, walkStart, walkEnd) {
  const stream = ((plan && plan.income) || []).find(row =>
    row && (row.id === 'payroll' || /seaspan/i.test(row.label || '')));
  if (!stream || !stream.anchor) return [];
  const dates = F.occurrences(stream, addDays(walkStart, -14), addDays(walkEnd, 14));
  const periods = [];
  for (let i = 0; i < dates.length; i++) {
    const payday = dates[i];
    const nextPayday = dates[i + 1] || addDays(payday, 14);
    if (nextPayday <= payday) continue;
    const cycleEnd = addDays(nextPayday, -1);
    if (cycleEnd < walkStart || payday > walkEnd) continue;
    const start = payday < walkStart ? walkStart : payday;
    const end = cycleEnd > walkEnd ? walkEnd : cycleEnd;
    if (start > end) continue;
    const cycle = F.spendingCycle(plan, payday);
    periods.push({ payday, nextPayday, start, end, cycleEnd, cycle });
  }
  return periods;
}

function stageReady(stage) {
  return stage && (stage.status === 'calculated' || stage.status === 'estimated')
    && stage.result && isFinite(stage.result.amount);
}

function monthFingerprint(row) {
  if (!row) return null;
  return JSON.stringify({
    month: row.month,
    start: row.start,
    end: row.end,
    income: row.income,
    cash: row.cash,
    spend: row.spend,
    stage1: row.stage1,
    stage2: row.stage2,
    stage3: row.stage3,
    debtStatus: row.debt && row.debt.status,
    debtAsOf: row.debt && row.debt.asOf,
    debtConsumer: row.debt && row.debt.consumer,
  });
}

console.log('=== 1. Forecast is the sole calculator; pay-period helper is not exported ===');
{
  const src = read('public/forecast.js');
  const spanFn = src.slice(
    src.indexOf('function seaspanPayPeriodsIntersecting('),
    src.indexOf('function trajectoryUnavailable('));
  const pictureFn = src.slice(
    src.indexOf('function baselineTrajectorySpanPicture('),
    src.indexOf('function baselineTrajectory('));
  ok(/function seaspanPayPeriodsIntersecting\(/.test(src)
    && /function baselineTrajectorySpanPicture\(/.test(src),
    'pay-period series lives inside public/forecast.js');
  ok(typeof F.seaspanPayPeriodsIntersecting !== 'function'
    && typeof F.baselineTrajectorySpanPicture !== 'function'
    && typeof F.baselineTrajectoryMonthFunding !== 'function',
    'pay-period series is not a second exported planner');
  ok(/biweeklyDates/.test(spanFn) && /seaspanPayroll/.test(spanFn),
    'pay-period spans come from the incumbent Seaspan payroll calendar');
  ok(!/calendarMonthsIntersecting/.test(spanFn),
    'pay-period spans are not calendar-month windows');
  ok(/baselineTrajectorySpanPicture\(/.test(
    src.slice(src.indexOf('function baselineTrajectory('),
      src.indexOf('function baselineTrajectoryScenario('))),
    'baselineTrajectory composes the shared span picture for months and pay periods');
  ok(/prepareBaselineTrajectoryWalk\(/.test(
    src.slice(src.indexOf('function baselineTrajectory('),
      src.indexOf('function baselineTrajectoryScenario('))),
    'pay-period series uses the same prepareBaselineTrajectoryWalk as months');
  ok(!/recommend\(/.test(pictureFn) && !/paydayAllocation\(/.test(pictureFn)
    && !/nextDollar/.test(pictureFn) && !/baselineTrajectoryScenario\(/.test(pictureFn),
    'span picture does not search recommend, paydayAllocation, nextDollar, or the scenario');
  ok(!/safeToSpend|breathingRoom|minCash|\bryg\b/.test(pictureFn),
    'pay-period helper invents no min-cash / breathing-room / safe-to-spend / RYG');
  ok(/cashWalkDate\(/.test(pictureFn),
    'span picture attributes funding events by incumbent cashWalkDate, not scheduled date alone');
  const planning = read('public/planning.js');
  const packet = read('scripts/assistant-packet.js');
  ok(/traj\.payPeriods/.test(planning) && /payPeriods\.map/.test(planning),
    'Planning reprints payPeriods[] in Pay period view (B105m)');
  ok(!/payPeriods/.test(packet),
    'assistant packet does not project pay-period series in this PR');
}

console.log('\n=== 2. Independent Jul 10–23 2026 Seaspan period reconciliation ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  ok(traj.status === 'ready', 'trajectory is ready on the pay-period fixture');
  ok(Array.isArray(traj.payPeriods) && traj.payPeriods.length > 0,
    'ready trajectory publishes payPeriods[]');
  ok(traj.ranking === null && traj.recommendation === null && traj.affordability === null,
    'ranking / recommendation / affordability stay null');
  ok(traj.provenance.payPeriodSeries === 'seaspan-spending-cycle'
    && traj.provenance.payPeriodFundingStages === 'walk-derived'
    && traj.provenance.fundingStage3 === 'plan.defaults.extraDebtMonthly'
    && traj.provenance.fundingStage3Scenario === 'not-used',
    'provenance names Seaspan spending-cycle spans and walk-derived extras');

  const expectedSpans = independentPayPeriods(plan, traj.horizon.start, traj.horizon.end);
  ok(expectedSpans.length === traj.payPeriods.length,
    'published pay-period count matches independent Seaspan clip of the knowledge horizon',
    `${traj.payPeriods.length} vs ${expectedSpans.length}`);
  ok(expectedSpans.every((span, i) => {
    const row = traj.payPeriods[i];
    const cycle = span.cycle;
    return row && row.payday === span.payday
      && row.nextPayday === span.nextPayday
      && row.start === span.start
      && row.end === span.end
      && cycle && cycle.start === span.payday
      && cycle.end === span.cycleEnd
      && cycle.nextPayday === span.nextPayday;
  }), 'each published span matches independent occurrences + spendingCycle, clipped like months');

  const period = traj.payPeriods.find(p => p.payday === JUL_10);
  ok(period && period.start === JUL_10 && period.end === '2026-07-23'
    && period.nextPayday === '2026-07-24'
    && period.calendar === 'seaspan-spending-cycle',
    'Jul 10 period is the incumbent Seaspan window through the day before Jul 24');
  const expected = independentSpan(plan, debts, period);
  ok(stageReady(period.stage1) && stageReady(period.stage2) && stageReady(period.stage3),
    'Jul 10 period publishes ready stage1 / stage2 / stage3 results');
  ok(near(period.stage1.income.amount, expected.income)
    && near(period.income.amount, expected.income)
    && near(expected.income, 2000),
    'Stage 1 income matches independent expandEvents income in the pay-period',
    `${period.stage1.income.amount} vs ${expected.income}`);
  ok(near(period.stage1.bills.amount, expected.bills) && near(expected.bills, 0),
    'Jul 10 period bills exclude Hydro on Jul 5 (prior Seaspan window) and the card-paid stream',
    String(period.stage1.bills.amount));
  ok(near(period.stage1.obligations.amount, expected.obligations) && near(expected.obligations, 80),
    'Stage 1 obligations match the Jul 20 card minimum inside this window',
    String(period.stage1.obligations.amount));
  ok(period.stage1.householdBudget.walkDays === expected.walkDays
    && expected.walkDays === 14,
    'Jul 10 Household Budget uses the 14 walk days simulate already drained');
  ok(period.stage1.householdBudget.identity
    === 'simulate weeklyVariable applied days in pay-period',
    'pay-period Household Budget names the walk-applied identity, not a calendar smear');
  ok(near(period.stage1.householdBudget.amount, expected.householdBudget)
    && near(expected.householdBudget, expected.weekly * 14 / 7),
    'Household Budget equals walk-applied weeklyVariable / 7 × 14 pay-period walk days',
    `${period.stage1.householdBudget.amount} vs ${expected.householdBudget}`);
  ok(near(period.stage1.result.amount, expected.stage1)
    && near(period.stage1.result.amount,
      period.stage1.income.amount
      - period.stage1.bills.amount
      - period.stage1.obligations.amount
      - period.stage1.householdBudget.amount),
    'Stage 1 result is income − bills − obligations − Household Budget');
  ok(near(period.stage2.commitments.amount, expected.commitments)
    && near(expected.commitments, 400),
    'Stage 2 commitments are the required camp on Jul 10, not the $999 optional trip',
    String(period.stage2.commitments.amount));
  ok(near(period.stage2.result.amount, expected.stage2)
    && near(period.stage2.result.amount,
      period.stage1.result.amount - period.stage2.commitments.amount),
    'Stage 2 result is Stage 1 − commitments');
  ok(near(period.stage3.extras.amount, expected.extras)
    && period.stage3.extras.source === 'plan.defaults.extraDebtMonthly',
    'Stage 3 extras match independent absorbed kind:extra in this pay-period',
    `${period.stage3.extras.amount} vs ${expected.extras}`);
  ok(near(period.stage3.result.amount, expected.stage3)
    && near(period.stage3.result.amount,
      period.stage2.result.amount - period.stage3.extras.amount),
    'Stage 3 result is Stage 2 − extras — the projected result of this pay-period');
  ok(period.stage1.status === 'estimated' && period.stage2.status === 'estimated'
    && period.stage3.status === 'estimated',
    'estimated payroll keeps every pay-period stage estimated — estimates are not promoted');
  ok(!period.stage1.ranking && !period.stage1.recommendation && !period.stage1.affordability
    && period.stage1.minCash == null && period.stage1.ryg == null,
    'pay-period stages invent no ranking / recommendation / affordability / min-cash policy');
}

console.log('\n=== 3. Month series unchanged; clipped first period is not a 14-day smear ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const july = traj.months.find(m => m.month === JUL);
  const expectedJuly = independentSpan(plan, debts, july);
  ok(july && !july.payday && !july.calendar && !july.nextPayday
    && !july.windowKind && !july.displayIdentity && !july.cycleStart
    && !july.cycleEnd && !july.cycleRangeLabel,
    'month rows did not grow pay-period identity fields');
  ok(stageReady(july.stage1)
    && july.start === '2026-07-01' && july.end === '2026-07-31'
    && expectedJuly.walkDays === 31
    && july.stage1.householdBudget.identity === 'seaspan pay periods closing in month'
    && near(july.stage1.result.amount,
      july.stage1.income.amount - july.stage1.bills.amount
      - july.stage1.obligations.amount - july.stage1.householdBudget.amount),
    'July month stages reconcile as pay-period-close funding; the cash window stays 31 days');

  const first = traj.payPeriods[0];
  const expectedFirst = independentPayPeriods(plan, traj.horizon.start, traj.horizon.end)[0];
  ok(first && first.payday === '2026-06-12' && first.start === START
    && first.end === '2026-06-25' && expectedFirst.start === START
    && first.windowKind === 'as-of-residual'
    && first.displayIdentity === 'Remaining through next payday'
    && first.cycleStart === '2026-06-12' && first.cycleEnd === '2026-06-25'
    && first.cycleRangeLabel === 'Jun 12–Jun 25',
    'first pay-period is clipped to as-of the same way June is clipped to month-start');
  const expected = independentSpan(plan, debts, first);
  ok(expected.walkDays === 11 && first.stage1.householdBudget.walkDays === 11,
    'clipped Jun 15–25 period has 11 walk-applied days, not the unclipped 14-day cycle');
  const smear14 = roundCent(expected.weekly * 14 / 7);
  ok(!near(first.stage1.householdBudget.amount, smear14, 1)
    && near(first.stage1.householdBudget.amount, expected.weekly * 11 / 7),
    'clipped first-period Household Budget is not a 14-day calendar smear',
    `${first.stage1.householdBudget.amount} vs smear ${smear14}`);
  ok(near(first.stage1.result.amount, expected.stage1)
    && near(first.stage3.result.amount, expected.stage3),
    'clipped first-period stages still reconcile to independent walk events + walk days');

  const interior = traj.payPeriods.find(p => p.payday === '2026-06-26');
  ok(interior && interior.start === '2026-06-26' && interior.end === '2026-07-09'
    && interior.stage1.householdBudget.walkDays === 14
    && interior.windowKind === 'full-cycle'
    && interior.displayIdentity === 'Pay period',
    'an interior Seaspan window keeps 14 walk-applied days');
}

console.log('\n=== 4. Fail closed when income/cash is unavailable — not $0 ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const jan = traj.payPeriods.find(p => p.payday >= '2027-01-01' && p.payday < '2027-02-01');
  ok(jan && jan.income.status === 'unavailable' && jan.cash.status === 'unavailable',
    'a 2027 Seaspan period withholds income and cash on the synthetic Dale fixture');
  ok(jan.stage1 && jan.stage1.status === 'unavailable'
    && jan.stage2.status === 'unavailable'
    && jan.stage3.status === 'unavailable',
    'unavailable income/cash withholds all three pay-period stages');
  ok(!jan.stage1.result && !jan.stage2.result && !jan.stage3.result,
    'unavailable pay-period stages omit a result rather than publishing $0');
  ok(jan.stage1.income == null && jan.stage1.householdBudget == null,
    'unavailable Stage 1 omits component amounts rather than inventing $0');
  ok(/Not \$0/.test(jan.stage1.reason),
    'unavailable pay-period stages keep the fail-closed Not $0 reason');

  const noSeaspan = fixture({
    income: [{
      id: 'side-gig', label: 'Confirmed side income',
      frequency: 'monthly', day: 3, amount: 1800, confidence: 'confirmed',
    }],
  });
  const trajNo = ask(noSeaspan.plan, noSeaspan.debts);
  ok(trajNo.status === 'ready' && Array.isArray(trajNo.months) && trajNo.months.length > 0,
    'a plan without Seaspan payroll still publishes the month series');
  ok(Array.isArray(trajNo.payPeriods) && trajNo.payPeriods.length === 0
    && trajNo.provenance.payPeriodSeries === 'unavailable',
    'missing Seaspan calendar fails the pay-period series closed — not invented calendar halves');
}

console.log('\n=== 5. Stage 3 extras stay extraDebtMonthly / walk kind:extra; months stay stable ===');
{
  const { plan: basePlan, debts: baseDebts } = fixture();
  const before = ask(basePlan, baseDebts);
  const scenario = F.baselineTrajectoryScenario(basePlan, baseDebts, START, {
    nature: 'additional-debt-payment',
    amount: 200,
    debtId: 'card',
    periods: periodsFixture(),
  });
  ok(scenario.status === 'ready', 'additional-debt-payment scenario is ready on this fixture');
  const after = ask(basePlan, baseDebts);
  const monthsBefore = before.months.map(monthFingerprint).join('\n');
  const monthsAfter = after.months.map(monthFingerprint).join('\n');
  ok(monthsBefore === monthsAfter,
    'calling baselineTrajectoryScenario does not change the published month series');
  const jul10Before = before.payPeriods.find(p => p.payday === JUL_10);
  const jul10After = after.payPeriods.find(p => p.payday === JUL_10);
  ok(near(jul10After.stage3.extras.amount, jul10Before.stage3.extras.amount)
    && near(jul10After.stage3.result.amount, jul10Before.stage3.result.amount),
    'calling baselineTrajectoryScenario with $200 does not change pay-period Stage 3');
  ok(!near(jul10After.stage3.extras.amount, jul10Before.stage3.extras.amount + 200, 1),
    'pay-period Stage 3 extras are not the planned extra plus the scenario amount');
}

console.log('\n=== 6. Carried unresolved joint-cash outflow uses cashWalkDate, not scheduled date ===');
{
  const CARRY_DATE = '2026-06-10';
  const CARRY = 237;
  const LATER_DATE = '2026-06-28';
  const LATER = 41;
  const shared = {
    startingCash: { amount: 10000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
  };
  const base = fixture(shared);
  const carried = fixture(Object.assign({}, shared, {
    bills: (base.plan.bills || []).concat([{
      id: 'carried-once-joint',
      label: 'Carried once joint-cash bill',
      frequency: 'once',
      date: CARRY_DATE,
      amount: CARRY,
      confidence: 'confirmed',
    }]),
  }));
  const withLater = fixture(Object.assign({}, shared, {
    bills: (base.plan.bills || []).concat([{
      id: 'later-once-joint',
      label: 'In-window once joint-cash bill',
      frequency: 'once',
      date: LATER_DATE,
      amount: LATER,
      confidence: 'confirmed',
    }]),
  }));
  const withPastIncome = fixture(Object.assign({}, shared, {
    income: (base.plan.income || []).concat([{
      id: 'past-once-income',
      label: 'Past once income',
      frequency: 'once',
      date: CARRY_DATE,
      amount: 500,
      confidence: 'confirmed',
    }]),
  }));

  const walk = independentWalkEvents(carried.plan, carried.debts);
  const carriedEvent = (walk.events || []).find(e => e.id === 'carried-once-joint');
  ok(carriedEvent && carriedEvent.date === CARRY_DATE && carriedEvent.kind === 'bill'
    && carriedEvent.amount === -CARRY && carriedEvent.date < START,
    'expandEvents keeps the unresolved once bill on its scheduled date before the walk start');
  ok(independentCashWalkDate(carriedEvent, START) === START,
    'independent cashWalkDate applies that joint-cash outflow at the opening');

  const trajBase = ask(base.plan, base.debts);
  const traj = ask(carried.plan, carried.debts);
  const first = traj.payPeriods[0];
  const firstBase = trajBase.payPeriods[0];
  ok(first && first.start === START && CARRY_DATE < first.start
    && firstBase && firstBase.start === START,
    'scheduled date sits before the clipped first pay-period');
  const scheduledHits = (walk.events || []).filter(e =>
    e.id === 'carried-once-joint' && e.date >= first.start && e.date <= first.end);
  ok(scheduledHits.length === 0,
    'a scheduled-date span filter would omit the carried bill from the first period');
  const appliedHits = (walk.events || []).filter(e =>
    e.id === 'carried-once-joint'
    && independentCashWalkDate(e, START) >= first.start
    && independentCashWalkDate(e, START) <= first.end);
  ok(appliedHits.length === 1,
    'cashWalkDate places the carried bill inside the clipped first period');

  const expected = independentSpan(carried.plan, carried.debts, first);
  ok(near(expected.bills, firstBase.stage1.bills.amount + CARRY)
    && near(first.stage1.bills.amount, expected.bills)
    && near(first.stage1.bills.amount, firstBase.stage1.bills.amount + CARRY),
    'first-period Stage 1 bills include the carried amount applied at opening',
    `${first.stage1.bills.amount} vs base ${firstBase.stage1.bills.amount} + ${CARRY}`);
  ok(near(first.stage1.result.amount, firstBase.stage1.result.amount - CARRY)
    && near(first.stage1.result.amount, expected.stage1),
    'first-period Stage 1 result is lower by the carried amount');

  const weekly = independentWeekly(carried.plan);
  const sim = F.simulate(carried.plan, START, {
    weeklyVariable: weekly,
    extraDebtMonthly: 0,
    periods: periodsFixture(),
  });
  const simBase = F.simulate(base.plan, START, {
    weeklyVariable: independentWeekly(base.plan),
    extraDebtMonthly: 0,
    periods: periodsFixture(),
  });
  const close = (sim.daily || []).find(d => d.date === first.end);
  const closeBase = (simBase.daily || []).find(d => d.date === first.end);
  ok(close && closeBase && near(close.balance, closeBase.balance - CARRY),
    'incumbent simulate period-end cash deducts the carried amount at opening');
  ok(near(first.cash.amount, close.balance)
    && near(first.cash.amount, firstBase.cash.amount - CARRY)
    && near(firstBase.cash.amount - first.cash.amount,
      first.stage1.bills.amount - firstBase.stage1.bills.amount),
    'published first-period cash matches simulate and the Stage 1 bills increase');

  const june = traj.months.find(m => m.month === '2026-06');
  const juneBase = trajBase.months.find(m => m.month === '2026-06');
  const expectedJune = independentSpan(carried.plan, carried.debts, june);
  ok(june && june.start === START && CARRY_DATE < june.start
    && near(june.stage1.bills.amount, juneBase.stage1.bills.amount + CARRY)
    && near(june.stage1.bills.amount, expectedJune.bills)
    && near(june.cash.amount, juneBase.cash.amount - CARRY),
    'clipped first month Stage 1 bills and cash also include the opening-applied carry');

  const interior = traj.payPeriods.find(p => p.payday === '2026-06-26');
  const interiorBase = trajBase.payPeriods.find(p => p.payday === '2026-06-26');
  ok(interior && interiorBase
    && near(interior.stage1.bills.amount, interiorBase.stage1.bills.amount)
    && near(interior.cash.amount, interiorBase.cash.amount - CARRY),
    'later periods do not re-count the carried bill; cash already moved at opening');

  const trajLater = ask(withLater.plan, withLater.debts);
  const firstLater = trajLater.payPeriods[0];
  const laterPeriod = trajLater.payPeriods.find(p => p.payday === '2026-06-26');
  ok(LATER_DATE > firstLater.start
    && near(firstLater.stage1.bills.amount, firstBase.stage1.bills.amount)
    && near(laterPeriod.stage1.bills.amount, interiorBase.stage1.bills.amount + LATER),
    'a joint-cash bill scheduled after opening keeps scheduled-date attribution');

  const trajIncome = ask(withPastIncome.plan, withPastIncome.debts);
  const firstIncome = trajIncome.payPeriods[0];
  const pastIncomeEvents = independentWalkEvents(withPastIncome.plan, withPastIncome.debts)
    .events.filter(e => e.id === 'past-once-income');
  ok(pastIncomeEvents.length === 0
    && near(firstIncome.stage1.income.amount, firstBase.stage1.income.amount)
    && near(firstIncome.cash.amount, firstBase.cash.amount),
    'once income before start keeps window semantics — it is not carried onto opening Stage 1 or cash');
}

console.log('\n=== 7. Live Seaspan series: clipped opening, honest $0 extras, 2027 fail-closed ===');
{
  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
  const asOf = live.meta.asOf;
  const traj = F.baselineTrajectory(live.plan, live.debts, asOf, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  ok(traj.status === 'ready', 'live baselineTrajectory is ready');
  ok(Array.isArray(traj.payPeriods) && traj.payPeriods.length > 0,
    'live trajectory publishes pay-period series');
  const expectedSpans = independentPayPeriods(live.plan, traj.horizon.start, traj.horizon.end);
  ok(expectedSpans.length === traj.payPeriods.length,
    'live pay-period count matches independent Seaspan clip',
    `${traj.payPeriods.length} vs ${expectedSpans.length}`);
  ok(traj.payPeriods[0].start === asOf || traj.payPeriods[0].start === traj.payPeriods[0].payday,
    'live first pay-period starts on as-of or on that payday');
  const cycle = F.spendingCycle(live.plan, asOf);
  ok(cycle && traj.payPeriods[0].payday === cycle.start,
    'live first pay-period identity is the incumbent spendingCycle payday');
  const published = traj.payPeriods.filter(p =>
    p.income && p.income.status !== 'unavailable'
    && p.cash && p.cash.status !== 'unavailable');
  ok(published.length > 0, 'live trajectory has published-income pay periods');
  ok(published.every(p => stageReady(p.stage1) && stageReady(p.stage3)
    && near(p.stage3.extras.amount, 0)
    && near(p.stage3.result.amount, p.stage2.result.amount)),
    'every published live pay-period has honest $0 Stage 3 extras');
  const estimated2027 = traj.payPeriods.filter(p => p.payday >= '2027-01-01');
  ok(estimated2027.length > 0 && estimated2027.every(p =>
    p.income.status === 'estimated' && p.cash.status === 'estimated'
    && p.stage1.status === 'estimated' && stageReady(p.stage1)
    && p.stage3.status === 'estimated' && stageReady(p.stage3)),
    'live 2027 pay periods stay estimated with results — not promoted, not withheld as $0');

  const interior = traj.payPeriods.find(p =>
    p.start === p.payday && p.nextPayday === addDays(p.payday, 14)
    && p.end === addDays(p.nextPayday, -1)
    && p.income.status !== 'unavailable');
  if (interior) {
    const expected = independentSpan(live.plan, live.debts, interior, asOf, periods);
    ok(interior.stage1.householdBudget.walkDays === expected.walkDays
      && expected.walkDays === 14
      && near(interior.stage1.result.amount, expected.stage1)
      && near(interior.stage3.result.amount, expected.stage3),
      'a live interior 14-day period reconciles to the same walk independently',
      interior.payday);
  } else {
    ok(false, 'live trajectory has an interior 14-day published pay-period to reconcile');
  }

  const julyMonth = traj.months.find(m => m.month === '2026-08' || m.month === traj.months[0].month);
  ok(julyMonth && julyMonth.stage1 && julyMonth.stage1.householdBudget
    && julyMonth.stage1.householdBudget.identity
      === 'seaspan pay periods closing in month',
    'live month series uses pay-period-close Household Budget');
  ok(hashFile(DATA) === liveHash, 'pay-period tests did not write data.json');
}

if (failures) {
  console.log(`\n${failures} failure${failures === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('\nAll tests passed');
