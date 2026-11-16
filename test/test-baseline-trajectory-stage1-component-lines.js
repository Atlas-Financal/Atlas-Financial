'use strict';
/* Financial Trajectory — Stage 1 bills / obligations / householdBudget lines.
 *
 * Forecast.baselineTrajectory stage1 bills, obligations, and householdBudget
 * keep the incumbent rollup amounts and publish attributable named lines
 * from the same span events / budgetBreakdown identity already used for
 * those rollups. Planning reprints those lines and does not invent splits.
 * Independent of the publisher: expandEvents grouped by id, plus planned
 * remainder × walkDays / 7 from budgetBreakdown.
 * `node test/test-baseline-trajectory-stage1-component-lines.js`
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
const JUL = '2026-07';
const SEP = '2026-09';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;
const DALE_LABEL = 'Dale — Seaspan payroll';
const AMANDA_LABEL = 'Amanda — Tennis BC salary';

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
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
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
          id: 'fuel', label: 'Fuel & transport', class: 'essential',
          from: ['Fuel'], plannedWeekly: 70,
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
        id: 'payroll', label: 'Payroll — Seaspan',
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
      {
        id: 'heloc-min', debtId: 'heloc', effect: 'payment',
        label: 'HELOC interest', frequency: 'monthly', day: 22,
        amount: 200, confidence: 'estimated',
      },
    ],
    bills: [
      {
        id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 5,
        amount: 120, confidence: 'confirmed',
      },
      {
        id: 'internet', label: 'Internet', frequency: 'monthly', day: 12,
        amount: 80, confidence: 'estimated',
      },
      {
        id: 'card-stream', label: 'Card-paid stream', frequency: 'monthly', day: 8,
        amount: 50, jointCash: false, confidence: 'confirmed',
      },
    ],
    commitments: [],
  }, extraPlan || {});
  const debts = extraDebts || [
    {
      id: 'card', label: 'Synthetic card',
      balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic', secured: false, limit: 1500,
    },
    {
      id: 'heloc', label: 'Synthetic HELOC',
      balance: 20000, pending: 0, rate: 5.45, rateConvention: 'variable',
      structure: 'HELOC', secured: true, limit: 50000,
    },
  ];
  return { plan, debts };
}

function ask(plan, debts) {
  return F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
}

function independentWeekly(plan) {
  const bd = F.budgetBreakdown(plan, periodsFixture(), { asOf: START });
  const plannedMonthly = (bd.categories || [])
    .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (Number(c.planned) || 0), 0);
  return roundCent(plannedMonthly / WEEKS_PER_MONTH);
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function independentCashWalkDate(event, start) {
  if (event && start && event.date < start
      && event.amount < 0 && event.kind !== 'noncash' && event.jointCash !== false) {
    return start;
  }
  return event && event.date;
}

function independentWalkEvents(plan, debts) {
  const weekly = independentWeekly(plan);
  const horizon = F.knowledgeHorizon(plan, START);
  const extraDebtMonthly = (plan.defaults && plan.defaults.extraDebtMonthly) || 0;
  const debtWalk = F.projectDebts(plan, debts, START, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    debtHorizonDays: horizon.days,
    periods: periodsFixture(),
  });
  const events = F.expandEvents(plan, horizon.start, horizon.end, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    extraAbsorbed: debtWalk && debtWalk.extraAbsorbed,
    obligationAbsorbed: debtWalk && debtWalk.obligationAbsorbed,
    periods: periodsFixture(),
  });
  return { weekly, horizon, events, extraAbsorbed: debtWalk && debtWalk.extraAbsorbed };
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

function groupOutflows(events) {
  const byId = new Map();
  for (const event of events) {
    const key = event.id || event.label || 'untitled';
    if (!byId.has(key)) byId.set(key, { label: event.label || key, amount: 0, events: [] });
    const row = byId.get(key);
    row.amount = roundCent(row.amount + (-Number(event.amount) || 0));
    row.events.push(event);
  }
  const lines = Array.from(byId.keys()).sort().map(id => {
    const row = byId.get(id);
    const status = row.events.some(e => e.confidence !== 'confirmed')
      ? 'estimated' : 'calculated';
    return { id, label: row.label, amount: row.amount, status };
  });
  return {
    lines,
    total: roundCent(lines.reduce((s, row) => s + row.amount, 0)),
  };
}

function independentSpanComponents(plan, debts, span) {
  const walk = independentWalkEvents(plan, debts);
  const events = (walk.events || []).filter(e => {
    if (!e) return false;
    const apply = independentCashWalkDate(e, START);
    return apply >= span.start && apply <= span.end;
  });
  const walkDays = independentWalkDays(
    walk.horizon.start, walk.horizon.end, span.start, span.end);
  const priorWalkDays = span.start > walk.horizon.start
    ? independentWalkDays(
      walk.horizon.start, walk.horizon.end, walk.horizon.start, addDays(span.start, -1))
    : 0;
  const bills = events.filter(e =>
    e.kind === 'bill' && e.jointCash !== false && !e.cardPaid);
  const obligations = events.filter(e => e.kind === 'obligation');
  const income = events.filter(e => e.kind === 'income');
  const bd = F.budgetBreakdown(plan, periodsFixture(), { asOf: START });
  const cats = (bd.categories || []).filter(c =>
    c && c.class !== 'reserve' && c.source !== 'historical-actual'
    && isFinite(Number(c.planned)) && Number(c.planned) > 0);
  const categoryThroughDays = (weekly, days, weightCents) => {
    const W = weightCents.reduce((s, w) => s + w, 0);
    const seats = weightCents.map(() => 0);
    if (!(days > 0) || !(W > 0)) return seats;
    let remainder = 7;
    const fortnightCents = Math.round(weekly * 200);
    for (let d = 0; d < days; d++) {
      remainder += fortnightCents;
      const pennies = Math.floor(remainder / 14);
      remainder %= 14;
      if (pennies <= 0) continue;
      let given = 0;
      const parts = weightCents.map((w, i) => {
        const num = pennies * w;
        const floor = Math.floor(num / W);
        seats[i] += floor;
        given += floor;
        return { i, rem: num % W };
      });
      parts.sort((a, b) => b.rem - a.rem || a.i - b.i);
      for (let k = 0; k < pennies - given; k++) seats[parts[k].i] += 1;
    }
    return seats;
  };
  const weightCents = cats.map(c => Math.round(Number(c.planned) * 100));
  const after = categoryThroughDays(walk.weekly, priorWalkDays + walkDays, weightCents);
  const before = categoryThroughDays(walk.weekly, priorWalkDays, weightCents);
  const householdBudget = (after.reduce((s, n) => s + n, 0)
    - before.reduce((s, n) => s + n, 0)) / 100;
  const budgetLines = cats.map((c, i) => ({
    label: c.label || c.id,
    amount: (after[i] - before[i]) / 100,
    status: 'calculated',
  }));
  return {
    weekly: walk.weekly,
    walkDays,
    householdBudget,
    bills: groupOutflows(bills),
    obligations: groupOutflows(obligations),
    budgetLines,
    contributingLabels: cats.map(c => c.label || c.id),
    incomeTotal: roundCent(income.reduce((s, e) => s + (Number(e.amount) || 0), 0)),
    events,
  };
}

function lineByLabel(lines, label) {
  return (lines || []).find(row => row && row.label === label) || null;
}

function lineSum(lines) {
  return roundCent((lines || []).reduce((s, row) => s + (Number(row.amount) || 0), 0));
}

console.log('=== 1. Publisher is Forecast-owned and unexported ===');
{
  const src = read('public/forecast.js');
  ok(/function baselineTrajectoryEventLines\(/.test(src)
    && /function baselineTrajectoryHouseholdBudgetLines\(/.test(src),
    'bills / obligations / householdBudget lines live inside public/forecast.js');
  ok(typeof F.baselineTrajectoryEventLines !== 'function'
    && typeof F.baselineTrajectoryHouseholdBudgetLines !== 'function'
    && typeof F.baselineTrajectoryMonthFunding !== 'function',
    'the line helpers are not a second exported engine');
  const funding = src.slice(
    src.indexOf('function baselineTrajectoryMonthFunding('),
    src.indexOf('function baselineTrajectorySpanPicture('));
  ok(/baselineTrajectoryEventLines\(bills/.test(funding)
    && /baselineTrajectoryEventLines\(obligations/.test(funding)
    && /householdBudgetLines.length/.test(funding),
    'MonthFunding attaches event lines on bills and obligations and category lines on householdBudget');
  ok(/jointCash !== false && !e.cardPaid/.test(funding),
    'bill lines still use the same joint-cash non-card-paid filter as the rollup');
  ok(/source === 'historical-actual'/.test(src.slice(
    src.indexOf('function baselineTrajectoryHouseholdBudgetLines('),
    src.indexOf('function baselineTrajectoryWalkVariableDays('))),
    'householdBudget lines skip historical-actual categories');
}

console.log('\n=== 2. July fixture: multiple bills + obligations, sums and statuses honest ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  ok(traj.status === 'ready', 'multi-line fixture trajectory is ready');
  const july = traj.months.find(m => m.month === JUL);
  ok(july && july.stage1 && july.stage1.status !== 'unavailable',
    'July 2026 publishes Stage 1');
  const expected = independentSpanComponents(plan, debts, july);
  const bills = july.stage1.bills;
  const obligations = july.stage1.obligations;
  const billLines = bills.lines || [];
  const obligationLines = obligations.lines || [];

  ok(expected.bills.lines.length >= 2 && expected.obligations.lines.length >= 2,
    'independent July has multiple joint-cash bills and multiple obligations',
    `bills ${expected.bills.lines.length} obligations ${expected.obligations.lines.length}`);
  ok(billLines.length >= 2 && obligationLines.length >= 2,
    'stage1.bills.lines and stage1.obligations.lines are present');

  const hydro = lineByLabel(billLines, 'Hydro');
  const internet = lineByLabel(billLines, 'Internet');
  const cardPaid = lineByLabel(billLines, 'Card-paid stream');
  ok(hydro && near(hydro.amount, 120) && hydro.status === 'calculated',
    'Hydro line is the confirmed $120 July outflow',
    hydro ? `${hydro.amount} ${hydro.status}` : 'missing');
  ok(internet && near(internet.amount, 80) && internet.status === 'estimated',
    'Internet line is the estimated $80 July outflow',
    internet ? `${internet.amount} ${internet.status}` : 'missing');
  ok(!cardPaid && !billLines.some(row => /card-paid/i.test(row.label || '')),
    'card-paid / non-joint-cash bills are not invented as Stage 1 bill lines');
  ok(near(lineSum(billLines), bills.amount)
    && near(bills.amount, expected.bills.total)
    && near(bills.amount, 200),
    'sum(bills.lines) reconciles to stage1.bills.amount and independent expandEvents',
    `${lineSum(billLines)} vs ${bills.amount} vs ${expected.bills.total}`);
  ok(bills.status === 'estimated',
    'bills rollup stays estimated when any contributing event is estimated');

  const cardMin = lineByLabel(obligationLines, 'Card minimum');
  const heloc = lineByLabel(obligationLines, 'HELOC interest');
  ok(cardMin && near(cardMin.amount, expected.obligations.lines.find(r => r.label === 'Card minimum').amount)
    && cardMin.status === 'calculated',
    'Card minimum line matches independent obligation sum and confirmed trust');
  ok(heloc && near(heloc.amount, expected.obligations.lines.find(r => r.label === 'HELOC interest').amount)
    && heloc.status === 'estimated',
    'HELOC interest line matches independent obligation sum and estimated trust');
  ok(near(lineSum(obligationLines), obligations.amount)
    && near(obligations.amount, expected.obligations.total),
    'sum(obligations.lines) reconciles to stage1.obligations.amount',
    `${lineSum(obligationLines)} vs ${obligations.amount} vs ${expected.obligations.total}`);
  ok(obligations.status === 'estimated',
    'obligations rollup stays estimated when any contributing event is estimated');
}

console.log('\n=== 3. Household budget lines attribute planned remainder across categories ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const july = traj.months.find(m => m.month === JUL);
  const expected = independentSpanComponents(plan, debts, july);
  const hb = july.stage1.householdBudget;
  const lines = hb.lines || [];
  ok(expected.contributingLabels.includes('Groceries')
    && expected.contributingLabels.includes('Fuel & transport')
    && !expected.contributingLabels.includes('Travel')
    && !expected.contributingLabels.includes('Undated telecom'),
    'independent contributing cats are owner-target Groceries and Fuel, not historical Travel or reserved telecom');
  ok(lines.length >= 2, 'householdBudget.lines are present when contributing categories exist');
  const groceries = lineByLabel(lines, 'Groceries');
  const fuel = lineByLabel(lines, 'Fuel & transport');
  const travel = lineByLabel(lines, 'Travel');
  const telecom = lineByLabel(lines, 'Undated telecom');
  const expectedGroceries = expected.budgetLines.find(r => r.label === 'Groceries');
  const expectedFuel = expected.budgetLines.find(r => r.label === 'Fuel & transport');
  ok(groceries && groceries.status === 'calculated' && groceries.amount > 0,
    'Groceries line is published from the closing pay periods, calculated',
    groceries ? String(groceries.amount) : 'missing');
  ok(fuel && fuel.status === 'calculated' && fuel.amount > 0,
    'Fuel line is published from the closing pay periods, calculated',
    fuel ? String(fuel.amount) : 'missing');
  ok(!travel && !telecom,
    'historical-actual Travel and reserved current-regime telecom are not invented as Household Budget lines');
  ok(near(lineSum(lines), hb.amount)
    && hb.identity === 'seaspan pay periods closing in month',
    'sum(householdBudget.lines) reconciles to the closing-pay-period household budget',
    `${lineSum(lines)} vs ${hb.amount}`);
  ok(near(july.stage1.result.amount,
    roundCent(july.stage1.income.amount - july.stage1.bills.amount
      - july.stage1.obligations.amount - hb.amount)),
    'Stage 1 result identity is unchanged after attaching lines');
}

console.log('\n=== 4. Empty bills / obligations omit lines rather than inventing $0 rows ===');
{
  const { plan, debts } = fixture({ bills: [], obligations: [] });
  const traj = ask(plan, debts);
  const july = traj.months.find(m => m.month === JUL);
  ok(july && july.stage1 && july.stage1.bills && july.stage1.obligations,
    'July still publishes bills and obligations rollups when the sets are empty');
  ok(near(july.stage1.bills.amount, 0) && !Array.isArray(july.stage1.bills.lines),
    'empty bills omit lines rather than publishing an invented $0 Hydro row');
  ok(near(july.stage1.obligations.amount, 0) && !Array.isArray(july.stage1.obligations.lines),
    'empty obligations omit lines rather than publishing an invented $0 debt row');
  ok(Array.isArray(july.stage1.householdBudget.lines)
    && july.stage1.householdBudget.lines.length > 0,
    'householdBudget lines remain when budget categories still contribute');
}

console.log('\n=== 5. Only card-paid bills → no invented Stage 1 bill lines ===');
{
  const { plan, debts } = fixture({
    bills: [{
      id: 'card-stream', label: 'Card-paid stream', frequency: 'monthly', day: 8,
      amount: 50, jointCash: false, confidence: 'confirmed',
    }],
  });
  const traj = ask(plan, debts);
  const july = traj.months.find(m => m.month === JUL);
  ok(near(july.stage1.bills.amount, 0) && !Array.isArray(july.stage1.bills.lines),
    'card-paid-only span omits bills.lines and does not invent the excluded stream');
}

console.log('\n=== 6. No contributing budget categories omits householdBudget lines ===');
{
  const { plan, debts } = fixture({
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'travel', label: 'Travel', class: 'discretionary',
        from: ['Travel'],
      }],
    },
  });
  const traj = ask(plan, debts);
  ok(traj.status === 'ready', 'historical-only budget still forms a $0 planned weeklyVariable trajectory');
  const july = traj.months.find(m => m.month === JUL);
  ok(july && july.stage1 && july.stage1.householdBudget
    && near(july.stage1.householdBudget.amount, 0)
    && !Array.isArray(july.stage1.householdBudget.lines),
    'historical-actual-only budget omits householdBudget.lines rather than inventing Travel');
}

console.log('\n=== 7. Income lines from the Stage 1 income outcome still reconcile ===');
{
  const { plan, debts } = fixture({
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan',
        frequency: 'biweekly', anchor: '2026-06-12',
        amount: 2000, confidence: 'estimated',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
        frequency: 'monthly', day: 15,
        amount: 1000, confidence: 'confirmed',
      },
    ],
  });
  const traj = ask(plan, debts);
  const july = traj.months.find(m => m.month === JUL);
  const income = july.stage1.income;
  const lines = income.lines || [];
  const dale = lineByLabel(lines, DALE_LABEL);
  const amanda = lineByLabel(lines, AMANDA_LABEL);
  const expected = independentSpanComponents(plan, debts, july);
  ok(dale && dale.amount > 0 && amanda && near(amanda.amount, 1000),
    'Dale and Amanda income lines still publish on the same Stage 1 component');
  ok(near(lineSum(lines), income.amount)
    && near(income.amount, expected.incomeTotal),
    'income sum(lines) still reconciles to the unchanged income rollup');
}

console.log('\n=== 8. Pay-period Stage 1 uses the same bill / obligation / budget lines ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const period = (traj.payPeriods || []).find(p =>
    p && p.start <= '2026-07-12' && p.end >= '2026-07-12');
  ok(period && period.stage1 && period.stage1.status !== 'unavailable',
    'the Seaspan pay-period containing 12 Jul publishes Stage 1');
  const expected = independentSpanComponents(plan, debts, period);
  const billLines = period.stage1.bills.lines || [];
  const obligationLines = period.stage1.obligations.lines || [];
  const budgetLines = period.stage1.householdBudget.lines || [];
  ok(expected.bills.lines.some(r => r.label === 'Internet' && near(r.amount, 80)),
    'independent pay-period includes the 12 Jul Internet bill');
  ok(lineByLabel(billLines, 'Internet')
    && near(lineByLabel(billLines, 'Internet').amount, 80),
    'pay-period Internet line matches the independent span event');
  ok(near(lineSum(billLines), period.stage1.bills.amount)
    && near(period.stage1.bills.amount, expected.bills.total),
    'pay-period sum(bills.lines) reconciles to the bills rollup');
  ok(near(lineSum(obligationLines), period.stage1.obligations.amount)
    && near(period.stage1.obligations.amount, expected.obligations.total),
    'pay-period sum(obligations.lines) reconciles to the obligations rollup');
  ok(budgetLines.length && near(lineSum(budgetLines), period.stage1.householdBudget.amount)
    && near(period.stage1.householdBudget.amount, expected.householdBudget),
    'pay-period householdBudget lines sum to walk-applied weeklyVariable / 7');
}

console.log('\n=== 9. Unavailable stages still omit component lines rather than $0 ===');
{
  const { plan, debts } = fixture({
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-06-12',
      amount: 2000, confidence: 'estimated',
    }],
  });
  const traj = ask(plan, debts);
  const jan = traj.months.find(m => m.month === '2027-01');
  ok(jan && jan.stage1 && jan.stage1.status === 'unavailable',
    'synthetic Seaspan without 2027 assumptions still withholds January 2027');
  ok(jan.stage1.bills == null && jan.stage1.obligations == null
    && jan.stage1.householdBudget == null && jan.stage1.income == null,
    'unavailable Stage 1 does not invent bills, obligations, or budget lines at $0');
}

console.log('\n=== 10. Live household September reconciles by event id and planned remainder ===');
{
  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const periods = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/periods.json'), 'utf8'));
  ok(hashFile(DATA) === liveHash, 'live data.json was not written');
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods,
    extraFacilities: live.revolvingExtra,
  });
  const sep = (traj.months || []).find(m => m.month === SEP);
  ok(traj.status === 'ready' && sep && sep.stage1 && sep.stage1.status !== 'unavailable',
    'live September Stage 1 is published');

  const asOf = live.meta.asOf;
  const weekly = (() => {
    const bd = F.budgetBreakdown(live.plan, periods, { asOf, extraFacilities: live.revolvingExtra });
    const plannedMonthly = (bd.categories || [])
      .filter(c => c && c.class !== 'reserve' && c.source !== 'historical-actual')
      .reduce((s, c) => s + (Number(c.planned) || 0), 0);
    return roundCent(plannedMonthly / WEEKS_PER_MONTH);
  })();
  const horizon = F.knowledgeHorizon(live.plan, asOf);
  const extraDebtMonthly = (live.plan.defaults && live.plan.defaults.extraDebtMonthly) || 0;
  const debtWalk = F.projectDebts(live.plan, live.debts, asOf, {
    weeklyVariable: weekly,
    extraDebtMonthly,
    extraFacilities: live.revolvingExtra,
    debtHorizonDays: horizon.days,
    periods,
  });
  const closing = (traj.payPeriods || []).filter(p =>
    p.cycleEnd && p.cycleEnd.slice(0, 7) === SEP
    && p.windowKind !== 'horizon-clipped' && p.end === p.cycleEnd
    && p.stage1 && p.stage1.status !== 'unavailable');
  const sumPart = (pick) => Math.round(closing.reduce((s, p) => s + Number(pick(p) || 0), 0) * 100) / 100;
  const publishedBills = sep.stage1.bills.lines || [];
  const publishedObligations = sep.stage1.obligations.lines || [];
  ok(closing.length > 0 && publishedBills.length > 1,
    'live September bill lines come from pay periods that close in September');
  ok(near(sep.stage1.bills.amount, sumPart(p => p.stage1.bills.amount))
    && near(lineSum(publishedBills), sep.stage1.bills.amount),
    'live September bill lines reconcile to the closing pay periods');
  ok(near(sep.stage1.obligations.amount, sumPart(p => p.stage1.obligations.amount))
    && near(lineSum(publishedObligations), sep.stage1.obligations.amount),
    'live September obligation lines reconcile to the closing pay periods');

  const publishedBudget = sep.stage1.householdBudget.lines || [];
  ok(publishedBudget.length > 1,
    'live September publishes more than one Household Budget line');
  ok(near(lineSum(publishedBudget), sep.stage1.householdBudget.amount)
    && near(sep.stage1.householdBudget.amount, sumPart(p => p.stage1.householdBudget.amount))
    && sep.stage1.householdBudget.identity === 'seaspan pay periods closing in month',
    'live September Household Budget lines reconcile to the closing pay periods');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll stage1 bills / obligations / householdBudget named-line checks passed.');
