'use strict';
/* Standalone Road Ahead surplus / deficit.
 *
 * Owner direction 2026-09-22: each future Seaspan pay period and calendar
 * month funds itself. Prior-period surplus is not opening money for the
 * next period. The cumulative walk close may still carry that surplus
 * for Forecast internals. Road Ahead's household result is stage3.result.
 *
 * Independent of baselineTrajectoryMonthFunding: the expected results
 * below are the owner's period arithmetic, not a replay of that helper.
 * `node test/test-standalone-road-ahead-surplus.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Assistant = require('../scripts/assistant-packet.js');
const { buildFiguresSnapshot } = require('../scripts/figures-snapshot.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

const IDENTITY = 'standalone-period-surplus-deficit';
const PHRASE_SURPLUS = 'This period can set aside this surplus for future needs. Earlier surplus is not included.';
const PHRASE_DEFICIT = 'This period needs this amount saved before it arrives. Earlier surplus is not applied.';
const PERIOD_A = { payday: '2026-10-02', start: '2026-10-02', end: '2026-10-15' };
const PERIOD_B = { payday: '2026-10-16', start: '2026-10-16', end: '2026-10-29' };

function periodsFixture() {
  return {
    periods: {
      ytd: { label: 'YTD fixture', months: 1, spending: [] },
    },
  };
}

function basePlan(extra) {
  return Object.assign({
    windowDays: 60,
    startingCash: { amount: 0 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: '2026-10-02' },
    budget: {
      basis: 'ytd',
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 0,
        },
      ],
    },
    income: [
      {
        id: 'payroll', label: 'Dale — Seaspan',
        frequency: 'biweekly', anchor: '2026-10-02',
        amount: 6000, confidence: 'confirmed',
      },
    ],
    obligations: [],
    bills: [
      {
        id: 'period-a-costs', label: 'Period A costs',
        frequency: 'once', date: '2026-10-05',
        amount: 4500, confidence: 'confirmed',
      },
      {
        id: 'period-b-costs', label: 'Period B costs',
        frequency: 'once', date: '2026-10-20',
        amount: 4800, confidence: 'confirmed',
      },
    ],
    commitments: [
      {
        id: 'christmas', label: 'Christmas',
        date: '2026-10-22', amount: 2000,
        flexibility: 'required', confidence: 'confirmed',
      },
    ],
  }, extra || {});
}

function ask(plan, asOf, debts) {
  return F.baselineTrajectory(plan, debts || [], asOf || plan.opening.asOf, {
    periods: periodsFixture(),
  });
}

function pay(traj, payday) {
  return (traj.payPeriods || []).find(row => row.payday === payday) || null;
}

function month(traj, key) {
  return (traj.months || []).find(row => row.month === key) || null;
}

function resultAmount(period) {
  return period && period.stage3 && period.stage3.result
    ? period.stage3.result.amount : null;
}


console.log('=== 1. Pay periods fund themselves; Period B stays −800 ===');
{
  const plan = basePlan();
  const traj = ask(plan, '2026-10-02');
  const a = pay(traj, PERIOD_A.payday);
  const b = pay(traj, PERIOD_B.payday);
  ok(traj.status === 'ready' && a && b, 'two Seaspan pay periods publish');
  ok(a.start === PERIOD_A.start && a.end === PERIOD_A.end
    && b.start === PERIOD_B.start && b.end === PERIOD_B.end,
    'period windows are the payday-to-day-before-next-payday spans');
  ok(near(a.income.amount, 6000) && near(a.stage1.bills.amount, 4500)
    && near(a.stage2.commitments.amount, 0) && near(a.stage3.extras.amount, 0)
    && near(a.stage1.householdBudget.amount, 0) && near(a.stage1.obligations.amount, 0),
    'Period A envelope is income 6,000 minus costs 4,500');
  ok(near(resultAmount(a), 1500),
    'Period A standalone result is +1,500', String(resultAmount(a)));
  ok(near(b.income.amount, 6000) && near(b.stage1.bills.amount, 4800)
    && near(b.stage2.commitments.amount, 2000) && near(b.stage3.extras.amount, 0),
    'Period B envelope is income 6,000 minus bills 4,800 minus Christmas 2,000');
  const christmas = (b.stage2.commitments.lines || []).find(row => row.id === 'christmas');
  ok(christmas && christmas.label === 'Christmas' && near(christmas.amount, 2000)
    && christmas.date === '2026-10-22'
    && !(a.stage2.commitments.lines || []).some(row => row.id === 'christmas'),
    'Christmas stays named on Period B only');
  ok(near(resultAmount(b), -800),
    'Period B standalone result is −800', String(resultAmount(b)));
  ok(!near(resultAmount(b), 700),
    'Period B is not +700 from carrying Period A +1,500');
  ok(near(b.cash.amount, 700) && b.cash.identity === 'cumulative-walk-close'
    && b.cash.roadAheadFunding === false,
    'opening 0 makes the cumulative close +700, which is not the Road Ahead result',
    String(b.cash.amount));
  ok(a.stage3.result.identity === IDENTITY
    && a.stage3.result.priorPeriodSurplus === 'excluded'
    && a.stage3.result.phrase === PHRASE_SURPLUS
    && b.stage3.result.identity === IDENTITY
    && b.stage3.result.priorPeriodSurplus === 'excluded'
    && b.stage3.result.phrase === PHRASE_DEFICIT,
    'stage3 publishes the standalone identity and the matching phrase');
  ok(a.stage1.result.identity === IDENTITY && a.stage2.result.identity === IDENTITY
    && b.stage1.result.priorPeriodSurplus === 'excluded',
    'stage1 and stage2 use the same standalone identity');
  ok(traj.roadAheadSurplusDeficit
    && traj.roadAheadSurplusDeficit.identity === IDENTITY
    && traj.roadAheadSurplusDeficit.priorPeriodSurplus === 'excluded'
    && traj.roadAheadSurplusDeficit.source === 'stage3.result'
    && traj.roadAheadSurplusDeficit.cumulativeCash === 'not-this-result',
    'the trajectory names stage3.result as the Road Ahead result');
  ok(traj.weeklyVariable.source === 'budgetBreakdown.planned'
    && traj.normalSpending && traj.normalSpending.status === 'unavailable'
    && a.spend && a.spend.source === 'budgetBreakdown.planned'
    && b.spend && b.spend.source === 'budgetBreakdown.planned',
    'without recent-actuals coverage the PR #407 planned fallback still applies');

  const rich = ask(basePlan({ startingCash: { amount: 10000 } }), '2026-10-02');
  const richA = pay(rich, PERIOD_A.payday);
  const richB = pay(rich, PERIOD_B.payday);
  ok(near(resultAmount(richA), 1500) && near(resultAmount(richB), -800)
    && near(richB.cash.amount, 10700) && !near(richB.cash.amount, resultAmount(richB)),
    'raising opening cash moves the cumulative close and leaves both stage3 results unchanged',
    `stage3 ${resultAmount(richB)} cash ${richB.cash.amount}`);

  const easierA = ask(basePlan({
    bills: basePlan().bills.map(row => row.id === 'period-a-costs'
      ? Object.assign({}, row, { amount: 4000 }) : row),
  }), '2026-10-02');
  ok(near(resultAmount(pay(easierA, PERIOD_A.payday)), 2000)
    && near(resultAmount(pay(easierA, PERIOD_B.payday)), -800),
    'a larger Period A surplus does not reduce Period B’s −800');
}

console.log('\n=== 2. Named inflows, obligations, and scheduled extra stay in their period ===');
{
  const withBonus = basePlan({
    income: basePlan().income.concat([{
      id: 'known-bonus', label: 'Known bonus',
      frequency: 'once', date: '2026-10-20',
      amount: 500, confidence: 'confirmed',
    }]),
  });
  const bonus = ask(withBonus, '2026-10-02');
  const bonusA = pay(bonus, PERIOD_A.payday);
  const bonusB = pay(bonus, PERIOD_B.payday);
  const bonusLine = (bonusB.stage1.income.lines || []).find(row => row.label === 'Known bonus');
  ok(near(bonusA.income.amount, 6000) && near(bonusB.income.amount, 6500)
    && bonusLine && near(bonusLine.amount, 500)
    && near(resultAmount(bonusA), 1500) && near(resultAmount(bonusB), -300),
    'a named one-off bonus counts only in the pay period that contains its date');

  const withObligation = basePlan({
    obligations: [{
      id: 'card-min', debtId: 'card', effect: 'payment',
      label: 'Card minimum', frequency: 'monthly', day: 20,
      amount: 100, confidence: 'confirmed',
    }],
  });
  const obliged = ask(withObligation, '2026-10-02');
  const obA = pay(obliged, PERIOD_A.payday);
  const obB = pay(obliged, PERIOD_B.payday);
  ok(near(obA.stage1.obligations.amount, 0) && near(obB.stage1.obligations.amount, 100)
    && near(resultAmount(obA), 1500) && near(resultAmount(obB), -900),
    'a required obligation on the 20th stays in Period B and is not paid by Period A surplus');

  const withExtra = basePlan({
    defaults: { targetBuffer: 0, extraDebtMonthly: 100, scenario: 'expected' },
  });
  const extra = ask(withExtra, '2026-10-02');
  const exA = pay(extra, PERIOD_A.payday);
  const exB = pay(extra, PERIOD_B.payday);
  ok(near(exA.stage3.extras.amount, 100) && near(exB.stage3.extras.amount, 0)
    && near(resultAmount(exA), 1400) && near(resultAmount(exB), -800)
    && near(exA.stage3.result.amount, exA.stage2.result.amount - exA.stage3.extras.amount),
    'the 15th scheduled extra stays in Period A; Period B remains −800');
}

console.log('\n=== 3. Adjacent months keep a later deficit ===');
{
  const plan = basePlan({
    opening: { asOf: '2026-10-01' },
    income: [
      {
        id: 'payroll', label: 'Dale — Seaspan',
        frequency: 'biweekly', anchor: '2026-10-02',
        amount: 0, confidence: 'confirmed',
      },
      {
        id: 'oct-seaspan', label: 'Dale — Seaspan',
        frequency: 'once', date: '2026-10-10',
        amount: 6000, confidence: 'confirmed',
      },
      {
        id: 'nov-seaspan', label: 'Dale — Seaspan',
        frequency: 'once', date: '2026-11-06',
        amount: 3500, confidence: 'confirmed',
      },
      {
        id: 'amanda-salary', label: 'Amanda — Tennis BC',
        frequency: 'once', date: '2026-11-13',
        amount: 2000, confidence: 'confirmed',
      },
      {
        id: 'child-benefit', label: 'Child benefit',
        frequency: 'once', date: '2026-11-03',
        amount: 500, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'october-costs', label: 'October costs',
        frequency: 'once', date: '2026-10-12',
        amount: 4500, confidence: 'confirmed',
      },
      {
        id: 'november-costs', label: 'November costs',
        frequency: 'once', date: '2026-11-12',
        amount: 4800, confidence: 'confirmed',
      },
    ],
    commitments: [
      {
        id: 'christmas', label: 'Christmas',
        date: '2026-11-20', amount: 2000,
        flexibility: 'required', confidence: 'confirmed',
      },
    ],
  });
  const traj = ask(plan, '2026-10-01');
  const oct = month(traj, '2026-10');
  const nov = month(traj, '2026-11');
  ok(traj.status === 'ready' && oct && nov, 'October and November both publish');
  ok(near(oct.income.amount, 6000) && near(oct.stage1.bills.amount, 4500)
    && near(oct.stage2.commitments.amount, 0) && near(resultAmount(oct), 1500),
    'October standalone result is +1,500', String(resultAmount(oct)));
  const novLines = nov.stage1.income.lines || [];
  const line = label => novLines.find(row => row.label === label);
  ok(line('Dale — Seaspan payroll') && near(line('Dale — Seaspan payroll').amount, 3500)
    && line('Amanda — Tennis BC salary') && near(line('Amanda — Tennis BC salary').amount, 2000)
    && line('Child benefit') && near(line('Child benefit').amount, 500),
    'November income is Dale, Amanda, and child benefit occurring in that month');
  ok(!(oct.stage1.income.lines || []).some(row => row.label === 'Child benefit'
    || row.label === 'Amanda — Tennis BC salary'),
    'November Amanda and child benefit are not October income');
  const novChristmas = (nov.stage2.commitments.lines || []).find(row => row.id === 'christmas');
  ok(near(nov.income.amount, 6000) && near(nov.stage1.bills.amount, 4800)
    && novChristmas && near(novChristmas.amount, 2000) && novChristmas.date === '2026-11-20'
    && !(oct.stage2.commitments.lines || []).some(row => row.id === 'christmas')
    && near(resultAmount(nov), -800),
    'November Christmas stays in November and the month result stays −800',
    String(resultAmount(nov)));
  ok(near(nov.cash.amount, 700) && !near(nov.cash.amount, resultAmount(nov)),
    'November cumulative close is +700 and is not the month funding result',
    String(nov.cash.amount));

  const carried = ask(Object.assign({}, plan, { startingCash: { amount: 10000 } }), '2026-10-01');
  const carriedNov = month(carried, '2026-11');
  ok(near(resultAmount(month(carried, '2026-10')), 1500)
    && near(resultAmount(carriedNov), -800)
    && near(carriedNov.cash.amount, 10700),
    'November stays −800 when prior closing cash is 10,700 rather than 700');
}

console.log('\n=== 4. Month and Pay Period are one Forecast authority; the walk still carries cash ===');
{
  const traj = ask(basePlan(), '2026-10-02');
  const october = month(traj, '2026-10');
  const november = month(traj, '2026-11');
  const periodB = pay(traj, PERIOD_B.payday);
  const inOctober = (october.stage2.commitments.lines || []).some(row => row.id === 'christmas');
  const inNovember = (november.stage2.commitments.lines || []).some(row => row.id === 'christmas');
  const inB = (periodB.stage2.commitments.lines || []).some(row => row.id === 'christmas');
  ok(inOctober && inB && !inNovember,
    'the same Christmas commitment is on October and on its Seaspan pay period, not on November');
  ok(october.debt && october.debt.status === 'calculated' && near(october.debt.consumer, 0),
    'the coupled debt picture still publishes when the walk has no debts');
  ok(traj.payPeriods.length > 1 && traj.months.length > 1
    && traj.roadAheadSurplusDeficit.source === 'stage3.result',
    'Month and Pay Period series come from the one baselineTrajectory result');

  const src = read('public/forecast.js');
  const funding = src.slice(
    src.indexOf('function baselineTrajectoryMonthFunding('),
    src.indexOf('function baselineTrajectorySpanPicture('),
  );
  ok(/function baselineTrajectoryMonthFunding\(/.test(funding)
    && !/openingCash|close\.balance/.test(funding),
    'the stage amount helper does not add opening cash or the cumulative close');
  ok(/standalone-period-surplus-deficit/.test(funding)
    && /priorPeriodSurplus: 'excluded'/.test(funding),
    'the stage helper is where the standalone identity is published');
}

console.log('\n=== 5. Road Ahead reprints stage3, not cumulative cash ===');
{
  const traj = ask(basePlan(), '2026-10-02');
  const periodB = pay(traj, PERIOD_B.payday);


  const packet = Assistant.projectBaselineTrajectory({
    plan: basePlan(),
    debts: [],
    meta: { asOf: '2026-10-02' },
  }, periodsFixture());
  const packetB = (packet.months || []).find(row => row.month === '2026-10');
  ok(packet && packet.roadAheadSurplusDeficit
    && packet.roadAheadSurplusDeficit.identity === IDENTITY
    && packet.roadAheadSurplusDeficit.priorPeriodSurplus === 'excluded'
    && packet.roadAheadSurplusDeficit.amount == null
    && packetB && packetB.cash && packetB.cash.identity === 'cumulative-walk-close'
    && packetB.cash.roadAheadFunding === false
    && packetB.stage3 == null,
    'the assistant packet labels cumulative cash and does not reprint stage cents');

  const live = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
  const livePeriods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
  const snap = buildFiguresSnapshot(live, livePeriods);
  ok(snap['planning.trajectory.roadAheadSurplusDeficit.identity'] === IDENTITY
    && snap['planning.trajectory.roadAheadSurplusDeficit.priorPeriodSurplus'] === 'excluded',
    'figures snapshot publishes the Road Ahead identity and not a new cent amount');
  ok(!Object.keys(snap).some(key => /stage3|standalone-phrase/.test(key)),
    'figures snapshot does not add per-period stage cent keys');
}

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll standalone Road Ahead checks passed.');
