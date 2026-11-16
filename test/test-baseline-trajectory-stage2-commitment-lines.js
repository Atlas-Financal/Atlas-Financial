'use strict';
/* Financial Trajectory — Stage 2 commitment named lines.
 *
 * Forecast.baselineTrajectory stage2.commitments keeps the incumbent
 * rollup amount and publishes attributable named lines from the same
 * span commitment events already used for that rollup. Planning reprints
 * those lines and does not invent splits. Independent of the publisher:
 * expandEvents grouped by id, with the event date when the group has one.
 * `node test/test-baseline-trajectory-stage2-commitment-lines.js`
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
const START = '2026-08-19';
const DEC = '2026-12';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;
const SEATTLE_DEC = {
  id: 'seattle-dec',
  label: 'Seattle tournament #2',
  date: '2026-12-09',
  amount: 1200,
};
const CHRISTMAS_2026 = {
  id: 'christmas-2026',
  label: 'Christmas 2026',
  date: '2026-12-25',
  amount: 3500,
};

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
        ],
      },
    },
  };
}

function fixture(extraPlan) {
  const plan = Object.assign({
    windowDays: 91,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: START },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 140,
      }],
    },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan',
        frequency: 'biweekly', anchor: '2026-08-14',
        amount: 2000, confidence: 'estimated',
      },
    ],
    obligations: [],
    bills: [],
    commitments: [
      {
        id: SEATTLE_DEC.id, label: SEATTLE_DEC.label,
        date: SEATTLE_DEC.date, amount: SEATTLE_DEC.amount,
        confidence: 'estimated',
      },
      {
        id: CHRISTMAS_2026.id, label: CHRISTMAS_2026.label,
        date: CHRISTMAS_2026.date, amount: CHRISTMAS_2026.amount,
        confidence: 'estimated',
      },
      {
        id: 'optional-trip', label: 'Optional trip',
        date: '2026-12-10', amount: 999, optional: true,
        confidence: 'estimated',
      },
    ],
  }, extraPlan || {});
  return { plan, debts: [] };
}

function ask(plan, debts) {
  return F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
}

function independentWeekly(plan, periods, extraFacilities, asOf) {
  const bd = F.budgetBreakdown(plan, periods || periodsFixture(), {
    asOf: asOf || START,
    extraFacilities,
  });
  const plannedMonthly = (bd.categories || [])
    .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (Number(c.planned) || 0), 0);
  return roundCent(plannedMonthly / WEEKS_PER_MONTH);
}

function independentCashWalkDate(event, start) {
  if (event && start && event.date < start
      && event.amount < 0 && event.kind !== 'noncash' && event.jointCash !== false) {
    return start;
  }
  return event && event.date;
}

function independentWalkEvents(plan, debts, asOf, periods, extraFacilities) {
  const weekly = independentWeekly(plan, periods, extraFacilities, asOf);
  const horizon = F.knowledgeHorizon(plan, asOf);
  const extraDebtMonthly = (plan.defaults && plan.defaults.extraDebtMonthly) || 0;
  const debtWalk = F.projectDebts(plan, debts, asOf, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    extraFacilities,
    debtHorizonDays: horizon.days,
    periods,
  });
  const events = F.expandEvents(plan, horizon.start, horizon.end, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    extraFacilities,
    extraAbsorbed: debtWalk && debtWalk.extraAbsorbed,
    obligationAbsorbed: debtWalk && debtWalk.obligationAbsorbed,
    periods,
  });
  return { weekly, horizon, events };
}

function groupCommitmentLines(events) {
  const byId = new Map();
  for (const event of events) {
    if (!event || event.kind !== 'commitment') continue;
    const key = event.id || event.label || 'untitled';
    if (!byId.has(key)) {
      byId.set(key, {
        id: event.id || key,
        label: event.label || key,
        amount: 0,
        dates: [],
        events: [],
      });
    }
    const row = byId.get(key);
    row.amount = roundCent(row.amount + (-Number(event.amount) || 0));
    if (event.date && row.dates.indexOf(event.date) === -1) row.dates.push(event.date);
    row.events.push(event);
  }
  const lines = Array.from(byId.keys()).sort().map(id => {
    const row = byId.get(id);
    const status = row.events.some(e => e.confidence !== 'confirmed')
      ? 'estimated' : 'calculated';
    const line = { id: row.id, label: row.label, amount: row.amount, status };
    if (row.dates.length === 1) line.date = row.dates[0];
    return line;
  });
  return {
    lines,
    total: roundCent(lines.reduce((s, row) => s + row.amount, 0)),
  };
}

function independentSpanCommitments(plan, debts, span, asOf, periods, extraFacilities) {
  const walk = independentWalkEvents(plan, debts, asOf, periods, extraFacilities);
  const events = (walk.events || []).filter(e => {
    if (!e) return false;
    const apply = independentCashWalkDate(e, asOf);
    return apply >= span.start && apply <= span.end;
  });
  return Object.assign({ events }, groupCommitmentLines(events));
}

function lineById(lines, id) {
  return (lines || []).find(row => row && row.id === id) || null;
}

function lineSum(lines) {
  return roundCent((lines || []).reduce((s, row) => s + (Number(row.amount) || 0), 0));
}

console.log('=== 1. Publisher is Forecast-owned and unexported ===');
{
  const src = read('public/forecast.js');
  ok(/function baselineTrajectoryEventLines\(/.test(src),
    'commitment lines live inside public/forecast.js via the event-lines helper');
  ok(typeof F.baselineTrajectoryEventLines !== 'function'
    && typeof F.baselineTrajectoryMonthFunding !== 'function',
    'the line helpers are not a second exported engine');
  const helper = src.slice(
    src.indexOf('function baselineTrajectoryEventLines('),
    src.indexOf('function baselineTrajectoryHouseholdBudgetLines('));
  ok(/id: rows\[0\]\.id \|\| id/.test(helper)
    && /label: rows\[0\]\.label \|\| id/.test(helper)
    && /line\.date = dates\[0\]/.test(helper)
    && /status: trajectoryEventsStatus\(rows\)/.test(helper),
    'event lines carry id / label / date / amount / status');
  const funding = src.slice(
    src.indexOf('function baselineTrajectoryMonthFunding('),
    src.indexOf('function baselineTrajectorySpanPicture('));
  ok(/baselineTrajectoryEventLines\(bills/.test(funding)
    && /baselineTrajectoryEventLines\(obligations/.test(funding)
    && /baselineTrajectoryEventLines\(commitments/.test(funding),
    'MonthFunding attaches event lines on bills, obligations, and Stage2 commitments');
  ok(/kind === 'commitment'/.test(funding),
    'commitment lines still use the same kind:commitment filter as the rollup');
}

console.log('\n=== 2. December fixture: seattle-dec / christmas-2026 with dates ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  ok(traj.status === 'ready', 'fixture trajectory is ready');
  const dec = traj.months.find(m => m.month === DEC);
  ok(dec && dec.stage2 && dec.stage2.status !== 'unavailable',
    'December 2026 publishes Stage 2');
  const expected = independentSpanCommitments(
    plan, debts, dec, START, periodsFixture());
  const commitments = dec.stage2.commitments;
  const lines = commitments.lines || [];
  const seattle = lineById(lines, SEATTLE_DEC.id);
  const xmas = lineById(lines, CHRISTMAS_2026.id);
  const optional = lineById(lines, 'optional-trip');
  const independentSeattle = expected.lines.find(r => r.id === SEATTLE_DEC.id);
  const independentXmas = expected.lines.find(r => r.id === CHRISTMAS_2026.id);

  ok(independentSeattle && independentSeattle.date === SEATTLE_DEC.date
    && independentXmas && independentXmas.date === CHRISTMAS_2026.date,
    'independent December expandEvents includes seattle-dec 2026-12-09 and christmas-2026 2026-12-25');
  ok(seattle && seattle.date === SEATTLE_DEC.date
    && seattle.label === SEATTLE_DEC.label
    && near(seattle.amount, SEATTLE_DEC.amount)
    && seattle.status === 'estimated',
    'published seattle-dec line carries id / label / date / amount / status',
    seattle ? `${seattle.date} ${seattle.amount} ${seattle.status}` : 'missing');
  ok(xmas && xmas.date === CHRISTMAS_2026.date
    && xmas.label === CHRISTMAS_2026.label
    && near(xmas.amount, CHRISTMAS_2026.amount)
    && xmas.status === 'estimated',
    'published christmas-2026 line carries id / label / date / amount / status',
    xmas ? `${xmas.date} ${xmas.amount} ${xmas.status}` : 'missing');
  ok(!optional && !lines.some(row => /optional/i.test(row.label || '')),
    'optional commitments are not invented as Stage 2 lines');
  ok(near(lineSum(lines), commitments.amount)
    && near(commitments.amount, expected.total)
    && near(commitments.amount, SEATTLE_DEC.amount + CHRISTMAS_2026.amount),
    'sum(commitments.lines) reconciles to stage2.commitments.amount and independent expandEvents',
    `${lineSum(lines)} vs ${commitments.amount} vs ${expected.total}`);
  ok(near(dec.stage2.result.amount,
    roundCent(dec.stage1.result.amount - commitments.amount)),
    'Stage 2 result identity is unchanged after attaching lines');
}

console.log('\n=== 3. Pay-period Stage 2 uses the same commitment lines ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const seattlePeriod = (traj.payPeriods || []).find(p =>
    p && p.start <= SEATTLE_DEC.date && p.end >= SEATTLE_DEC.date);
  const xmasPeriod = (traj.payPeriods || []).find(p =>
    p && p.start <= CHRISTMAS_2026.date && p.end >= CHRISTMAS_2026.date);
  ok(seattlePeriod && seattlePeriod.stage2 && seattlePeriod.stage2.status !== 'unavailable',
    'the Seaspan pay-period containing 9 Dec publishes Stage 2');
  ok(xmasPeriod && xmasPeriod.stage2 && xmasPeriod.stage2.status !== 'unavailable',
    'the Seaspan pay-period containing 25 Dec publishes Stage 2');

  const seattleExpected = independentSpanCommitments(
    plan, debts, seattlePeriod, START, periodsFixture());
  const xmasExpected = independentSpanCommitments(
    plan, debts, xmasPeriod, START, periodsFixture());
  const seattleLines = seattlePeriod.stage2.commitments.lines || [];
  const xmasLines = xmasPeriod.stage2.commitments.lines || [];
  const seattle = lineById(seattleLines, SEATTLE_DEC.id);
  const xmasOnSeattle = lineById(seattleLines, CHRISTMAS_2026.id);
  const xmas = lineById(xmasLines, CHRISTMAS_2026.id);
  const seattleOnXmas = lineById(xmasLines, SEATTLE_DEC.id);

  ok(seattleExpected.lines.some(r => r.id === SEATTLE_DEC.id && r.date === SEATTLE_DEC.date)
    && !seattleExpected.lines.some(r => r.id === CHRISTMAS_2026.id),
    'independent 9 Dec pay-period includes seattle-dec and not christmas-2026');
  ok(seattle && seattle.date === SEATTLE_DEC.date
    && near(seattle.amount, SEATTLE_DEC.amount) && !xmasOnSeattle,
    '9 Dec pay-period publishes seattle-dec with its date and omits Christmas');
  ok(near(lineSum(seattleLines), seattlePeriod.stage2.commitments.amount)
    && near(seattlePeriod.stage2.commitments.amount, seattleExpected.total),
    '9 Dec pay-period sum(commitments.lines) reconciles to the commitments rollup');

  ok(xmasExpected.lines.some(r => r.id === CHRISTMAS_2026.id && r.date === CHRISTMAS_2026.date)
    && !xmasExpected.lines.some(r => r.id === SEATTLE_DEC.id),
    'independent 25 Dec pay-period includes christmas-2026 and not seattle-dec');
  ok(xmas && xmas.date === CHRISTMAS_2026.date
    && near(xmas.amount, CHRISTMAS_2026.amount) && !seattleOnXmas,
    '25 Dec pay-period publishes christmas-2026 with its date and omits Seattle');
  ok(near(lineSum(xmasLines), xmasPeriod.stage2.commitments.amount)
    && near(xmasPeriod.stage2.commitments.amount, xmasExpected.total),
    '25 Dec pay-period sum(commitments.lines) reconciles to the commitments rollup');
  ok(near(seattlePeriod.stage2.result.amount,
      roundCent(seattlePeriod.stage1.result.amount - seattlePeriod.stage2.commitments.amount))
    && near(xmasPeriod.stage2.result.amount,
      roundCent(xmasPeriod.stage1.result.amount - xmasPeriod.stage2.commitments.amount)),
    'pay-period Stage 2 result identity is unchanged after attaching lines');
}

console.log('\n=== 4. Empty commitments omit lines rather than inventing $0 rows ===');
{
  const { plan, debts } = fixture({ commitments: [] });
  const traj = ask(plan, debts);
  const dec = traj.months.find(m => m.month === DEC);
  ok(dec && dec.stage2 && dec.stage2.commitments,
    'December still publishes a commitments rollup when the set is empty');
  ok(near(dec.stage2.commitments.amount, 0)
    && !Array.isArray(dec.stage2.commitments.lines),
    'empty commitments omit lines rather than publishing an invented $0 Seattle row');
}

console.log('\n=== 5. Unavailable stages still omit component lines rather than $0 ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const jan = traj.months.find(m => m.month === '2027-01');
  ok(jan && jan.stage2 && jan.stage2.status === 'unavailable',
    'synthetic Seaspan without 2027 assumptions still withholds January 2027');
  ok(jan.stage2.commitments == null,
    'unavailable Stage 2 does not invent commitment lines at $0');
}

console.log('\n=== 6. Live household December reconciles seattle-dec / christmas-2026 by event id and date ===');
{
  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
  ok(hashFile(DATA) === liveHash, 'live data.json was not written');
  const asOf = live.meta.asOf;
  const traj = F.baselineTrajectory(live.plan, live.debts, asOf, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const dec = (traj.months || []).find(m => m.month === DEC);
  ok(traj.status === 'ready' && dec && dec.stage2 && dec.stage2.status !== 'unavailable',
    'live December Stage 2 is published');

  const expected = independentSpanCommitments(
    live.plan, live.debts, dec, asOf, periods, live.revolvingExtra);
  const published = dec.stage2.commitments.lines || [];
  const independentSeattle = expected.lines.find(r => r.id === SEATTLE_DEC.id);
  const independentXmas = expected.lines.find(r => r.id === CHRISTMAS_2026.id);
  const independentLinden = expected.lines.find(r => r.id === 'linden-birthday');
  ok(independentSeattle && independentSeattle.date === SEATTLE_DEC.date
    && independentXmas && independentXmas.date === CHRISTMAS_2026.date,
    'independent live December expandEvents includes seattle-dec / christmas-2026 with their dates');
  ok(independentLinden && independentLinden.date === '2026-12-09'
    && near(independentLinden.amount, 500)
    && independentLinden.label === 'Linden birthday',
    'independent live December expandEvents includes linden-birthday $500 on 2026-12-09');
  ok(expected.lines.filter(r => r.id === 'linden-birthday').length === 1
      && expected.lines.filter(r => r.id === SEATTLE_DEC.id).length === 1,
    'live December has one Linden birthday line and one seattle-dec line');
  ok(expected.lines.length > 1 && published.length === expected.lines.length,
    'live December publishes one commitment line per independent commitment id');
  for (const row of expected.lines) {
    const found = lineById(published, row.id);
    ok(found && found.label === row.label
      && found.date === row.date
      && near(found.amount, row.amount)
      && found.status === row.status,
      `live commitment ${row.id} matches independent expandEvents`,
      found ? `${found.date} ${found.amount} ${found.status}` : 'missing');
  }
  ok(near(lineSum(published), dec.stage2.commitments.amount)
    && near(dec.stage2.commitments.amount, expected.total),
    'live December sum(commitments.lines) equals rollup and independent commitment total');
  ok(near(dec.stage2.result.amount,
    roundCent(dec.stage1.result.amount - dec.stage2.commitments.amount)),
    'live December Stage 2 result remains Stage 1 minus commitments');

  const seattlePeriod = (traj.payPeriods || []).find(p =>
    p && p.start <= SEATTLE_DEC.date && p.end >= SEATTLE_DEC.date);
  ok(seattlePeriod && seattlePeriod.stage2 && seattlePeriod.stage2.status !== 'unavailable',
    'live pay-period containing 9 Dec publishes Stage 2');
  const periodExpected = independentSpanCommitments(
    live.plan, live.debts, seattlePeriod, asOf, periods, live.revolvingExtra);
  const periodLines = seattlePeriod.stage2.commitments.lines || [];
  const periodSeattle = lineById(periodLines, SEATTLE_DEC.id);
  ok(periodExpected.lines.some(r => r.id === SEATTLE_DEC.id && r.date === SEATTLE_DEC.date),
    'independent live 9 Dec pay-period includes seattle-dec on 2026-12-09');
  ok(periodSeattle && periodSeattle.date === SEATTLE_DEC.date
    && near(periodSeattle.amount, independentSeattle.amount),
    'live 9 Dec pay-period publishes seattle-dec with its date');
  const periodLinden = lineById(periodLines, 'linden-birthday');
  ok(periodExpected.lines.filter(r => r.id === 'linden-birthday').length === 1
      && periodExpected.lines.some(r => r.id === 'linden-birthday'
        && r.date === '2026-12-09' && near(r.amount, 500)),
    'independent live 9 Dec pay-period includes linden-birthday $500 once');
  ok(periodLinden && periodLinden.date === '2026-12-09' && near(periodLinden.amount, 500)
      && periodLinden.label === 'Linden birthday',
    'live 9 Dec pay-period publishes linden-birthday with its date');
  ok(near(lineSum(periodLines), seattlePeriod.stage2.commitments.amount)
    && near(seattlePeriod.stage2.commitments.amount, periodExpected.total),
    'live 9 Dec pay-period sum(commitments.lines) equals rollup and independent total');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll stage2 commitment named-line checks passed.');
