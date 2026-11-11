'use strict';
/* Walk-derived additionalCashRequired (owner 2026-09-18).
 *
 * Independent of Forecast.simulate.additionalCashRequired: reconstruct the
 * chequing-only carry-forward min from known dated amounts, then
 * max(0, 0 − min). Period stage deficits are summed independently from
 * published stage*.result amounts so this suite can prove they are not the
 * requirement. Funding floor is $0, not targetBuffer.
 *
 * `node test/test-additional-cash-required.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const AS_OF = '2026-01-01';
const CHEQUING_IDS = ['chequing-a', 'chequing-b'];
const DESIGNATED_RESERVE_ID = 'savings';
const BUFFER_NOT_USED = 500;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function independentChequing(plan) {
  const rows = ((plan.startingCash && plan.startingCash.breakdown) || []);
  return roundCent(rows.reduce((sum, row) => {
    if (!row || CHEQUING_IDS.indexOf(row.id) === -1) return sum;
    return sum + (Number(row.value) || 0);
  }, 0));
}

function independentBreakdownSum(plan) {
  const rows = ((plan.startingCash && plan.startingCash.breakdown) || []);
  return roundCent(rows.reduce((sum, row) => sum + (Number(row && row.value) || 0), 0));
}

function independentReserve(plan) {
  const rows = ((plan.startingCash && plan.startingCash.breakdown) || []);
  const row = rows.find(item => item && item.id === DESIGNATED_RESERVE_ID);
  return roundCent(Number(row && row.value) || 0);
}

// Independent of Forecast.additionalCashRequiredPacket: remaining need is
// max(0, required − min(required, max(0, designated-savings evidence))).
function independentBacked(required, reserve) {
  const req = roundCent(required);
  const fundable = roundCent(Math.max(0, Number(reserve) || 0));
  const funded = roundCent(Math.min(req, fundable));
  return {
    funded,
    remaining: roundCent(Math.max(0, req - funded)),
  };
}

function trajAcr(plan) {
  const traj = F.baselineTrajectory(plan, [], AS_OF, { periods: periodsStub() });
  return { traj, acr: traj && traj.additionalCashRequired };
}

// Independent of Forecast.simulate: dated cash events, income-first within
// a day, then a constant reserved daily smear and weeklyVariable / 7.
function independentWalkMin(opening, start, days, events, weeklyVariable, reservedDaily) {
  const byDate = new Map();
  for (const event of events || []) {
    if (!event || !event.date) continue;
    if (!byDate.has(event.date)) byDate.set(event.date, []);
    byDate.get(event.date).push(event);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => (b.amount > 0 ? 1 : 0) - (a.amount > 0 ? 1 : 0));
  }
  const dailyDrain = (Number(weeklyVariable) || 0) / 7 + (Number(reservedDaily) || 0);
  let balance = Number(opening);
  let min = { date: start, balance };
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const todays = byDate.get(date) || [];
    for (const event of todays) {
      balance += Number(event.amount) || 0;
      if (balance < min.balance) min = { date, balance };
    }
    balance -= dailyDrain;
    if (balance < min.balance) min = { date, balance };
  }
  const required = min.balance < 0 ? -min.balance : 0;
  return { min, additionalCashRequired: required };
}

function summedNegativeStageResults(rows, stageKey) {
  let sum = 0;
  for (const row of rows || []) {
    const result = row && row[stageKey] && row[stageKey].result;
    if (!result || result.amount == null || !isFinite(Number(result.amount))) continue;
    if (Number(result.amount) < 0) sum += -Number(result.amount);
  }
  return roundCent(sum);
}

function periodsStub() {
  return {
    periods: {
      ytd: { label: 'stub', months: 1, spending: [] },
    },
  };
}

function cashPlan(chequingA, savings, extra) {
  return Object.assign({
    windowDays: 120,
    defaults: { targetBuffer: BUFFER_NOT_USED, extraDebtMonthly: 0, scenario: 'expected' },
    startingCash: {
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: chequingA, class: 'spendable' },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 0, class: 'spendable' },
        { id: 'savings', label: 'EMERGENCY SAVING', value: savings, class: 'spendable' },
      ],
    },
    opening: { asOf: AS_OF },
    budget: { basis: 'ytd', categories: [] },
    income: [],
    bills: [],
    obligations: [],
    commitments: [],
  }, extra || {});
}

function onceBill(id, date, amount) {
  return {
    id, label: id, frequency: 'once', date, amount, confidence: 'confirmed',
  };
}

function onceIncome(id, date, amount) {
  return {
    id, label: id, frequency: 'once', date, amount, confidence: 'confirmed',
  };
}

const src = read('public/forecast.js');
const helperStart = src.indexOf('function additionalCashRequiredFromWalkMin(');
const helperEnd = src.indexOf('function simulate(', helperStart);
const helperSrc = helperStart >= 0 && helperEnd > helperStart
  ? src.slice(helperStart, helperEnd)
  : '';

console.log('=== authority: walk min at $0, never Σ period stage deficits ===');
{
  ok(/function additionalCashRequiredFromWalkMin\(minBalance\)/.test(src),
    'Forecast owns additionalCashRequiredFromWalkMin from the walk min');
  ok(helperSrc.length > 0
      && /below\(n, 0\) \? -n : 0/.test(helperSrc)
      && !/stage1|stage2|stage3|result\.amount/.test(helperSrc),
    'the helper is max(0, −min) with half-cent float noise read as $0, and does not mention period stage results');
  ok(/additionalCashRequired: additionalCashRequiredFromWalkMin\(min\.balance\)/.test(src),
    'simulate publishes additionalCashRequired from that walk min');
  ok(/periodStageDeficits: 'must-not-be-summed'/.test(src),
    'baselineTrajectory records that period stage deficits must not be summed');
  ok(/fundingFloor: 0/.test(src)
      && !/additionalCashRequiredFromWalkMin\([^)]*targetBuffer/.test(src),
    'funding floor is $0 and the helper is not passed targetBuffer');
  ok(/DESIGNATED_RESERVE_ID = 'savings'/.test(src)
      && /HOUSEHOLD_CHEQUING_IDS/.test(src),
    'designated reserve is incumbent savings; spendable opening aligns with household chequing ids');
  ok(/function designatedReserveEvidence\(plan\)/.test(src)
      && /function additionalCashRequiredPacket\(plan, minBalance\)/.test(src),
    'Forecast owns designated-reserve evidence and the ACR funded/remaining packet');
  ok(/plannedContribution: 'not-used'/.test(src),
    'planned reserve contributions are not treated as funded');
  ok(/additionalCashRequired: additionalCashRequiredPacket\(plan, sim\.min && sim\.min\.balance\)/.test(src),
    'baselineTrajectory publishes the funded/remaining packet from the same walk min');
}

console.log('\n=== 1. one future deficit ===');
{
  const plan = cashPlan(100, 10000, {
    bills: [onceBill('jan-hole', '2026-01-20', 150)],
  });
  const opening = independentChequing(plan);
  const independent = independentWalkMin(
    opening, AS_OF, plan.windowDays, [{ date: '2026-01-20', amount: -150 }], 0, 0);
  ok(near(opening, 100) && near(independentReserve(plan), 10000),
    'independent chequing opening is $100; designated savings $10,000 stays on the breakdown');
  ok(near(independent.additionalCashRequired, 50)
      && near(independent.min.balance, -50),
    'independent chequing walk min is −$50, so $50 additional cash is required',
    String(independent.additionalCashRequired));
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0, targetBuffer: BUFFER_NOT_USED });
  ok(near(sim.additionalCashRequired, independent.additionalCashRequired)
      && near(sim.shortfall, independent.additionalCashRequired)
      && near(sim.min.balance, independent.min.balance),
    'Forecast additionalCashRequired equals the independent zero-floor walk min, not savings rescue');
  const ifSavingsSpent = independentWalkMin(
    independentBreakdownSum(plan), AS_OF, plan.windowDays,
    [{ date: '2026-01-20', amount: -150 }], 0, 0);
  ok(near(ifSavingsSpent.additionalCashRequired, 0)
      && !near(sim.additionalCashRequired, 0),
    'Case K: silently spending designated savings would report $0 required; Forecast does not');
  const traj = F.baselineTrajectory(plan, [], AS_OF, { periods: periodsStub() });
  ok(traj.status === 'ready' && traj.additionalCashRequired
      && near(traj.additionalCashRequired.amount, independent.additionalCashRequired)
      && traj.additionalCashRequired.fundingFloor === 0
      && traj.additionalCashRequired.periodStageDeficits === 'must-not-be-summed',
    'baselineTrajectory republishes that same walk-derived amount at funding floor $0');
  const summed = summedNegativeStageResults(traj.months, 'stage3');
  ok(!near(summed, independent.additionalCashRequired),
    'summing the displayed month stage results is not the $50 cash requirement',
    `${summed} vs ${independent.additionalCashRequired}`);
}

console.log('\n=== 2. consecutive deficits ===');
{
  const plan = cashPlan(100, 8000, {
    bills: [
      onceBill('jan-hole', '2026-01-20', 80),
      onceBill('feb-hole', '2026-02-20', 80),
    ],
  });
  const events = [
    { date: '2026-01-20', amount: -80 },
    { date: '2026-02-20', amount: -80 },
  ];
  const independent = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
  ok(near(independent.min.balance, -60) && near(independent.additionalCashRequired, 60),
    'carry-forward min after two consecutive $80 holes from $100 is −$60',
    String(independent.additionalCashRequired));
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(near(sim.additionalCashRequired, 60) && near(sim.shortfall, 60),
    'Forecast additionalCashRequired is the trough ($60), not $80+$80');
  const traj = F.baselineTrajectory(plan, [], AS_OF, { periods: periodsStub() });
  const summed = summedNegativeStageResults(traj.months, 'stage3');
  ok(!near(sim.additionalCashRequired, summed),
    'summing displayed month results is not the $60 cash requirement',
    `${summed} vs ${sim.additionalCashRequired}`);
}

console.log('\n=== 3. deficits separated by intervening surplus ===');
{
  const plan = cashPlan(50, 9000, {
    bills: [
      onceBill('jan-hole', '2026-01-20', 80),
      onceBill('mar-hole', '2026-03-20', 80),
    ],
    income: [onceIncome('feb-in', '2026-02-15', 100)],
  });
  const events = [
    { date: '2026-01-20', amount: -80 },
    { date: '2026-02-15', amount: 100 },
    { date: '2026-03-20', amount: -80 },
  ];
  const independent = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
  // 50 − 80 = −30; −30 + 100 = 70; 70 − 80 = −10. Trough is −30.
  ok(near(independent.min.balance, -30) && near(independent.additionalCashRequired, 30),
    'intervening surplus nets the later hole; independent required cash is the −$30 trough',
    String(independent.additionalCashRequired));
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(near(sim.additionalCashRequired, 30),
    'Forecast additionalCashRequired follows the carry-forward trough, not each red month');
  const traj = F.baselineTrajectory(plan, [], AS_OF, { periods: periodsStub() });
  const summed = summedNegativeStageResults(traj.months, 'stage3');
  ok(!near(summed, 30),
    'summing displayed month results is not the $30 cash requirement',
    `${summed} vs 30`);
}

console.log('\n=== 4. later deficit that creates additional required funding ===');
{
  const plan = cashPlan(50, 9000, {
    bills: [
      onceBill('jan-hole', '2026-01-20', 80),
      onceBill('mar-hole', '2026-03-20', 80),
    ],
    income: [onceIncome('feb-in', '2026-02-15', 20)],
  });
  const events = [
    { date: '2026-01-20', amount: -80 },
    { date: '2026-02-15', amount: 20 },
    { date: '2026-03-20', amount: -80 },
  ];
  const independent = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
  // 50 − 80 = −30; −30 + 20 = −10; −10 − 80 = −90. Later hole deepens the trough.
  ok(near(independent.min.balance, -90) && near(independent.additionalCashRequired, 90),
    'the later deficit creates additional required funding: trough −$90, not the Jan-only −$30',
    String(independent.additionalCashRequired));
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(near(sim.additionalCashRequired, 90),
    'Forecast additionalCashRequired rises with the later deeper trough');
  const janOnly = independentWalkMin(
    independentChequing(plan), AS_OF, 40, [{ date: '2026-01-20', amount: -80 }], 0, 0);
  ok(near(janOnly.additionalCashRequired, 30)
      && sim.additionalCashRequired > janOnly.additionalCashRequired + 0.005,
    'a Jan-only window would require $30; the later hole adds required cash beyond that');
}

console.log('\n=== 5. summing displayed deficits overstates when the walk stays funded ===');
{
  const plan = cashPlan(1000, 50, {
    bills: [
      onceBill('jan', '2026-01-20', 200),
      onceBill('feb', '2026-02-20', 200),
      onceBill('mar', '2026-03-20', 200),
    ],
  });
  const events = [
    { date: '2026-01-20', amount: -200 },
    { date: '2026-02-20', amount: -200 },
    { date: '2026-03-20', amount: -200 },
  ];
  const independent = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
  ok(near(independent.min.balance, 400) && near(independent.additionalCashRequired, 0),
    'three $200 displayed holes from $1,000 never go below $0; required cash is $0');
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  ok(near(sim.additionalCashRequired, 0) && near(sim.shortfall, 0),
    'Forecast additionalCashRequired is $0 on a funded trajectory');
  const traj = F.baselineTrajectory(plan, [], AS_OF, { periods: periodsStub() });
  const summed = summedNegativeStageResults(traj.months, 'stage3');
  ok(!near(summed, 600),
    'the close-month card is not a $600 sum of calendar-month holes',
    String(summed));
  ok(traj.additionalCashRequired && near(traj.additionalCashRequired.amount, 0),
    'the published trajectory figure stays $0 and is not that $600 sum');
}

console.log('\n=== paydayAllocation opening is chequing-only; savings is not spent ===');
{
  const plan = cashPlan(80, 5000, {
    bills: [onceBill('hole', '2026-01-10', 100)],
  });
  const alloc = F.paydayAllocation(plan, AS_OF, { weeklyVariable: 0, debts: [] });
  const chequing = independentChequing(plan);
  const withSavings = independentBreakdownSum(plan);
  ok(near(alloc.opening, chequing) && !near(alloc.opening, withSavings),
    'paydayAllocation.opening is chequing-only, not chequing + designated savings',
    `${alloc.opening} vs chequing ${chequing} vs pooled ${withSavings}`);
  const before = F.simulate(plan, AS_OF, { weeklyVariable: 0 }).additionalCashRequired;
  const bumped = cashPlan(80, 5000 + 2500, {
    bills: [onceBill('hole', '2026-01-10', 100)],
  });
  const after = F.simulate(bumped, AS_OF, { weeklyVariable: 0 }).additionalCashRequired;
  ok(near(before, 20) && near(after, 20),
    'raising designated savings does not change additionalCashRequired (no silent rescue)');
}

console.log('\n=== synthetic fixtures without household chequing ids still open ===');
{
  const tiny = {
    windowDays: 7,
    defaults: { targetBuffer: 0 },
    startingCash: { breakdown: [{ id: 'a', value: 100, class: 'spendable' }] },
    income: [], obligations: [], bills: [],
    commitments: [{ id: 'due', date: AS_OF, amount: 40, label: 'due' }],
  };
  const sim = F.simulate(tiny, AS_OF, { weeklyVariable: 0, targetBuffer: 0 });
  ok(near(sim.daily[0].balance, 60) && near(sim.additionalCashRequired, 0),
    'a synthetic non-chequing breakdown still funds the walk; designated savings is not invented');
}

console.log('\n=== amount-only fixtures are unchanged ===');
{
  const plan = {
    windowDays: 14,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 500 },
    income: [], obligations: [], bills: [], commitments: [],
  };
  ok(near(F.startingCashAmount(plan), 500)
      && near(F.postedHouseholdChequingCash(plan), 500),
    'amount-only synthetic openings still equal the declared amount');
}

console.log('\n=== designated-savings backing of additionalCashRequired ===');
{
  function prove(label, chequing, savings, bill, extra) {
    const plan = cashPlan(chequing, savings, Object.assign({
      bills: bill ? [onceBill('hole', '2026-01-20', bill)] : [],
    }, extra || {}));
    const events = bill ? [{ date: '2026-01-20', amount: -bill }] : [];
    const independent = independentWalkMin(
      independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
    const backed = independentBacked(independent.additionalCashRequired, savings);
    const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
    const { traj, acr } = trajAcr(plan);
    ok(typeof sim.additionalCashRequired === 'number'
        && near(sim.additionalCashRequired, independent.additionalCashRequired)
        && near(sim.shortfall, independent.additionalCashRequired),
      `${label}: simulate additionalCashRequired stays the chequing-only total`,
      String(sim.additionalCashRequired));
    ok(traj.status === 'ready' && acr && acr.status === 'calculated'
        && near(acr.amount, independent.additionalCashRequired)
        && acr.fundingFloor === 0,
      `${label}: trajectory amount equals independent zero-floor walk min`,
      acr && String(acr.amount));
    ok(acr.fundedByDesignatedSavings && acr.fundedByDesignatedSavings.status === 'calculated'
        && near(acr.fundedByDesignatedSavings.amount, backed.funded)
        && acr.fundedByDesignatedSavings.plannedContribution === 'not-used',
      `${label}: fundedByDesignatedSavings equals min(required, actual savings)`,
      acr.fundedByDesignatedSavings && String(acr.fundedByDesignatedSavings.amount));
    ok(acr.remainingAdditionalCashRequired
        && acr.remainingAdditionalCashRequired.status === 'calculated'
        && near(acr.remainingAdditionalCashRequired.amount, backed.remaining)
        && acr.remainingAdditionalCashRequired.amount >= -0.005,
      `${label}: remainingAdditionalCashRequired is max(0, required − funded)`,
      acr.remainingAdditionalCashRequired
        && String(acr.remainingAdditionalCashRequired.amount));
    return { plan, sim, acr, independent, backed };
  }

  prove('zero required / zero savings', 200, 0, 50);
  prove('requirement with zero savings', 100, 0, 150);
  prove('partially backed', 100, 20, 150);
  prove('exactly backed', 100, 50, 150);
  const over = prove('savings greater than requirement', 100, 80, 150);
  ok(near(over.acr.remainingAdditionalCashRequired.amount, 0)
      && over.acr.remainingAdditionalCashRequired.amount >= 0
      && near(over.acr.fundedByDesignatedSavings.amount, over.independent.additionalCashRequired)
      && over.acr.fundedByDesignatedSavings.amount + 0.005 < 80,
    'excess designated savings is not remaining credit and does not over-fund past required');
}

console.log('\n=== changing designated savings moves funded/remaining, not chequing-only ACR ===');
{
  const low = cashPlan(100, 10, { bills: [onceBill('hole', '2026-01-20', 150)] });
  const high = cashPlan(100, 40, { bills: [onceBill('hole', '2026-01-20', 150)] });
  const events = [{ date: '2026-01-20', amount: -150 }];
  const required = independentWalkMin(
    independentChequing(low), AS_OF, low.windowDays, events, 0, 0).additionalCashRequired;
  ok(near(required, 50), 'independent required cash is $50 from $100 − $150');
  const simLow = F.simulate(low, AS_OF, { weeklyVariable: 0 }).additionalCashRequired;
  const simHigh = F.simulate(high, AS_OF, { weeklyVariable: 0 }).additionalCashRequired;
  ok(near(simLow, required) && near(simHigh, required),
    'raising designated savings does not change simulate additionalCashRequired');
  const acrLow = trajAcr(low).acr;
  const acrHigh = trajAcr(high).acr;
  const backedLow = independentBacked(required, 10);
  const backedHigh = independentBacked(required, 40);
  ok(near(acrLow.amount, required) && near(acrHigh.amount, required),
    'trajectory amount stays the chequing-only total when savings changes');
  ok(near(acrLow.fundedByDesignatedSavings.amount, backedLow.funded)
      && near(acrHigh.fundedByDesignatedSavings.amount, backedHigh.funded)
      && acrHigh.fundedByDesignatedSavings.amount > acrLow.fundedByDesignatedSavings.amount + 0.005,
    'higher designated savings raises fundedByDesignatedSavings',
    `${acrLow.fundedByDesignatedSavings.amount} → ${acrHigh.fundedByDesignatedSavings.amount}`);
  ok(near(acrLow.remainingAdditionalCashRequired.amount, backedLow.remaining)
      && near(acrHigh.remainingAdditionalCashRequired.amount, backedHigh.remaining)
      && acrLow.remainingAdditionalCashRequired.amount > acrHigh.remainingAdditionalCashRequired.amount + 0.005,
    'higher designated savings lowers remainingAdditionalCashRequired',
    `${acrLow.remainingAdditionalCashRequired.amount} → ${acrHigh.remainingAdditionalCashRequired.amount}`);
}

console.log('\n=== non-designated cash does not fund this reserve ===');
{
  const plan = cashPlan(100, 10, {
    bills: [onceBill('hole', '2026-01-20', 150)],
  });
  plan.startingCash.heldElsewhere = [
    { id: 'amanda-debt-payments', label: 'TENNIS INCOME', value: 2691.85, class: 'operational' },
    { id: 'savings-dont-touch', label: 'SAVINGS-DONT TOUCH', value: 74.2, class: 'staging' },
    { id: 'wise', label: 'Wise', value: 205.92, class: 'other-liquid' },
  ];
  const events = [{ date: '2026-01-20', amount: -150 }];
  const required = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0).additionalCashRequired;
  ok(near(required, 50), 'independent required cash stays $50 on the chequing-only walk');
  const acr = trajAcr(plan).acr;
  const backed = independentBacked(required, 10);
  ok(near(acr.amount, 50)
      && near(acr.fundedByDesignatedSavings.amount, backed.funded)
      && near(acr.remainingAdditionalCashRequired.amount, backed.remaining)
      && !near(acr.fundedByDesignatedSavings.amount, 10 + 2691.85 + 74.2 + 205.92),
    'TENNIS INCOME, SAVINGS-DONT TOUCH, and Wise do not fund designated-reserve backing',
    String(acr.fundedByDesignatedSavings.amount));
  const extraChequing = cashPlan(100, 10, { bills: [onceBill('hole', '2026-01-20', 150)] });
  extraChequing.startingCash.breakdown.find(row => row.id === 'chequing-b').value = 400;
  extraChequing.startingCash.heldElsewhere = plan.startingCash.heldElsewhere;
  const extraRequired = independentWalkMin(
    independentChequing(extraChequing), AS_OF, extraChequing.windowDays, events, 0, 0);
  ok(near(independentChequing(extraChequing), 500)
      && near(extraRequired.additionalCashRequired, 0)
      && near(trajAcr(extraChequing).acr.fundedByDesignatedSavings.amount, 0),
    'extra chequing reduces the chequing-only requirement; it does not become reserve funding');
}

console.log('\n=== planned contribution intent is not funded ===');
{
  const plan = cashPlan(100, 10, {
    bills: [onceBill('hole', '2026-01-20', 150)],
    income: [onceIncome('planned-savings-contribution', '2026-02-01', 5000)],
  });
  const events = [
    { date: '2026-01-20', amount: -150 },
    { date: '2026-02-01', amount: 5000 },
  ];
  const independent = independentWalkMin(
    independentChequing(plan), AS_OF, plan.windowDays, events, 0, 0);
  const acr = trajAcr(plan).acr;
  const backed = independentBacked(independent.additionalCashRequired, 10);
  ok(near(acr.amount, independent.additionalCashRequired),
    'planned contribution events still only affect the chequing walk total');
  ok(near(acr.fundedByDesignatedSavings.amount, backed.funded)
      && near(acr.fundedByDesignatedSavings.amount, 10)
      && !near(acr.fundedByDesignatedSavings.amount, 10 + 5000),
    'funded uses actual designated savings $10, not the planned $5,000 contribution');
}

console.log('\n=== Case K: savings still outside the ordinary Forecast walk ===');
{
  const plan = cashPlan(80, 5000, { bills: [onceBill('hole', '2026-01-10', 100)] });
  const sim = F.simulate(plan, AS_OF, { weeklyVariable: 0 });
  const ifSpent = independentWalkMin(
    independentBreakdownSum(plan), AS_OF, plan.windowDays,
    [{ date: '2026-01-10', amount: -100 }], 0, 0);
  ok(near(sim.daily[0].balance, 80) && !near(sim.daily[0].balance, 5080),
    'opening walk balance is chequing-only $80, not chequing plus designated savings');
  ok(near(ifSpent.additionalCashRequired, 0) && near(sim.additionalCashRequired, 20),
    'silently spending designated savings would zero ACR; Forecast still requires $20');
  const acr = trajAcr(plan).acr;
  ok(near(acr.amount, 20)
      && near(acr.fundedByDesignatedSavings.amount, 20)
      && near(acr.remainingAdditionalCashRequired.amount, 0),
    'Case K: savings backs the published remaining need without rescuing the walk total');
}

console.log('\n=== unavailable / untrusted inputs fail closed, not $0 funded ===');
{
  const missing = cashPlan(100, 10, { bills: [onceBill('hole', '2026-01-20', 150)] });
  missing.startingCash.breakdown = missing.startingCash.breakdown.filter(
    row => row.id !== DESIGNATED_RESERVE_ID);
  const missingAcr = trajAcr(missing).acr;
  ok(missingAcr && missingAcr.status === 'calculated' && near(missingAcr.amount, 50)
      && missingAcr.fundedByDesignatedSavings
      && missingAcr.fundedByDesignatedSavings.status === 'unavailable'
      && missingAcr.fundedByDesignatedSavings.amount == null
      && missingAcr.remainingAdditionalCashRequired.status === 'unavailable'
      && missingAcr.remainingAdditionalCashRequired.amount == null,
    'missing designated savings on a household chequing opening fails funded/remaining closed');

  const untrusted = cashPlan(100, 10, { bills: [onceBill('hole', '2026-01-20', 150)] });
  untrusted.startingCash.breakdown.find(row => row.id === DESIGNATED_RESERVE_ID).value = null;
  const untrustedAcr = trajAcr(untrusted).acr;
  ok(untrustedAcr && near(untrustedAcr.amount, 50)
      && untrustedAcr.fundedByDesignatedSavings.status === 'unavailable'
      && untrustedAcr.fundedByDesignatedSavings.amount == null
      && untrustedAcr.remainingAdditionalCashRequired.status === 'unavailable'
      && untrustedAcr.remainingAdditionalCashRequired.amount == null,
    'null designated savings value fails funded/remaining closed, not $0 funded');

  const nanPlan = cashPlan(100, 10, { bills: [onceBill('hole', '2026-01-20', 150)] });
  nanPlan.startingCash.breakdown.find(row => row.id === DESIGNATED_RESERVE_ID).value = Number.NaN;
  const nanAcr = trajAcr(nanPlan).acr;
  ok(nanAcr.fundedByDesignatedSavings.status === 'unavailable'
      && nanAcr.fundedByDesignatedSavings.amount == null
      && nanAcr.remainingAdditionalCashRequired.amount == null,
    'NaN designated savings fails closed rather than publishing funded $0');

  const closed = F.baselineTrajectory(null, [], AS_OF, { periods: periodsStub() });
  ok(closed && closed.status === 'unavailable'
      && closed.additionalCashRequired
      && closed.additionalCashRequired.status === 'unavailable'
      && closed.additionalCashRequired.amount == null
      && closed.additionalCashRequired.fundedByDesignatedSavings.amount == null
      && closed.additionalCashRequired.remainingAdditionalCashRequired.amount == null,
    'unavailable trajectory fails the whole ACR packet closed, not $0 / funded');

  ok(/minBalance == null \|\| !isFinite\(Number\(minBalance\)\)/.test(src),
    'unreadable walk min fails the ACR packet closed rather than coercing to $0');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nAll additional-cash-required proofs passed.');
