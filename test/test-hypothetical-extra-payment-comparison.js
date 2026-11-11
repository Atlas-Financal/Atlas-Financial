'use strict';
/* Decision Intelligence foundation — Forecast-owned comparison of two
 * or more caller-supplied hypothetical extras on one household baseline.
 *
 * Composes Forecast.hypotheticalExtraPayment. Controlled fixtures;
 * independent daily walk + incumbent weekly cash identity, not a second
 * call of the producing helper as the only proof.
 * `node test/test-hypothetical-extra-payment-comparison.js`
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
const clone = value => JSON.parse(JSON.stringify(value));
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const liveHash = hashFile(DATA);
const START = '2026-01-15';
const DAYS = 91;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Independent of Forecast: accrue daily, then apply a same-day extra.
function walkCard(opening, rate, extraDate, extraAmount, days, start) {
  let balance = opening;
  let interest = 0;
  let paid = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const daily = balance * (rate / 100) / 365;
    balance += daily;
    interest += daily;
    if (date === extraDate && extraAmount > 0) {
      const take = Math.min(extraAmount, balance);
      balance -= take;
      paid += take;
    }
  }
  return { balance, interest, paid };
}

function fixture(extraPlan, extraDebts) {
  const plan = Object.assign({
    windowDays: DAYS,
    startingCash: { amount: 2000 },
    defaults: { targetBuffer: 500, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: START },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    income: [],
    obligations: [],
    bills: [],
    commitments: [],
  }, extraPlan || {});
  const debts = extraDebts || [
    {
      id: 'high', label: 'High-rate card',
      balance: 800, pending: 0, rate: 26.99, rateConvention: 'card',
      structure: 'Revolving — synthetic high', secured: false, limit: 1200,
    },
    {
      id: 'low', label: 'Low-rate card',
      balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic low', secured: false, limit: 1000,
    },
  ];
  return { plan, debts };
}

function compare(plan, debts, scenarios, extraInput) {
  return F.hypotheticalExtraPaymentComparison(plan, debts, START, Object.assign({
    nature: 'hypothetical-comparison',
    scenarios,
  }, extraInput || {}));
}

function slice6(plan, debts, amount, debtId) {
  return F.hypotheticalExtraPayment(plan, debts, START, {
    amount, debtId, nature: 'hypothetical',
  });
}

function householdCash(plan, debts) {
  const advice = F.recommend(plan, START, {
    debts,
    scenario: (plan.defaults && plan.defaults.scenario) || 'expected',
    extraDebtMonthly: (plan.defaults && plan.defaults.extraDebtMonthly) || 0,
    targetBuffer: plan.defaults && plan.defaults.targetBuffer,
    fundingSources: plan.funding && plan.funding.options,
  });
  const sim = F.simulate(plan, START, Object.assign({}, advice.simOptions, {
    weeklyVariable: advice.weekly,
  }));
  const zeroWeekly = F.simulate(plan, START, Object.assign({}, advice.simOptions, {
    weeklyVariable: 0,
  }));
  return { advice, sim, zeroWeekly };
}

function resultPack(scenarios) {
  return scenarios.map(row => JSON.stringify({
    id: row.id || null,
    amount: row.input.amount,
    debtId: row.input.debtId,
    result: row.result,
  })).sort();
}

function financialEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

console.log('=== 1. Forecast is the sole calculator; compose only ===');
{
  const src = read('public/forecast.js');
  ok(/function hypotheticalExtraPaymentComparison\(/.test(src),
    'Forecast.hypotheticalExtraPaymentComparison is defined in public/forecast.js');
  const body = src.slice(src.indexOf('function hypotheticalExtraPaymentComparison('),
    src.indexOf('const Forecast = {'));
  ok(/hypotheticalExtraPayment\(/.test(body),
    'the comparison composes hypotheticalExtraPayment');
  ok(!/projectDebts\(/.test(body) && !/simulate\(/.test(body) && !/recommend\(/.test(body),
    'it does not invent a second projectDebts / simulate / recommend walk');
  ok(!/counterfactuals\(/.test(body) && !/paydayAllocation\(/.test(body),
    'it does not call counterfactuals or paydayAllocation');
  ok(!/writeFileSync|writeFile\(/.test(body),
    'it does not write files');
  ok(!/decisionPosture/.test(src),
    'public/forecast.js still does not read plan.decisionPosture');
  ok(!/weeklyVariable:\s*0/.test(body),
    'it does not hard-code weeklyVariable: 0');
}

console.log('\n=== 2. Each result equals an independent Slice 6 call ===');
{
  const { plan, debts } = fixture();
  const before = JSON.stringify({ plan, debts });
  const result = compare(plan, debts, [
    { id: 'A', amount: 100, debtId: 'low' },
    { id: 'B', amount: 100, debtId: 'high' },
    { id: 'C', amount: 200, debtId: 'low' },
  ]);
  const after = JSON.stringify({ plan, debts });
  ok(result.status === 'ready', 'a valid three-scenario comparison is ready', result.reason);
  ok(after === before, 'plan and debts are not mutated by the comparison');
  ok(result.scenarios.length === 3, 'three caller scenarios are returned');

  const independent = {
    A: slice6(plan, debts, 100, 'low'),
    B: slice6(plan, debts, 100, 'high'),
    C: slice6(plan, debts, 200, 'low'),
  };
  for (const row of result.scenarios) {
    const expected = independent[row.id];
    ok(expected.status === 'ready', `independent Slice 6 ${row.id} is ready`);
    ok(financialEqual(row.result.absorbed, expected.absorbed),
      `scenario ${row.id} absorbed equals independent Slice 6`);
    ok(financialEqual(row.result.baseline, expected.baseline),
      `scenario ${row.id} baseline equals independent Slice 6`);
    ok(financialEqual(row.result.scenario, expected.scenario),
      `scenario ${row.id} walk equals independent Slice 6`);
    ok(financialEqual(row.result.delta, expected.delta),
      `scenario ${row.id} delta equals independent Slice 6`);
    ok(row.input.amount === expected.input.amount
        && row.input.debtId === expected.input.debtId,
      `scenario ${row.id} input matches the independent Slice 6 call`);
  }
}

console.log('\n=== 3–5. Independent daily walk + household cash, not helper-twice ===');
{
  const { plan, debts } = fixture();
  const result = compare(plan, debts, [
    { id: 'low-100', amount: 100, debtId: 'low' },
    { id: 'high-100', amount: 100, debtId: 'high' },
  ]);
  const low = debts.find(d => d.id === 'low');
  const high = debts.find(d => d.id === 'high');
  const expectedLow = walkCard(low.balance, low.rate, START, 100, DAYS, START);
  const expectedHigh = walkCard(high.balance, high.rate, START, 100, DAYS, START);
  const expectedLowBase = walkCard(low.balance, low.rate, START, 0, DAYS, START);
  const expectedHighBase = walkCard(high.balance, high.rate, START, 0, DAYS, START);
  const household = householdCash(plan, debts);
  const byId = Object.fromEntries(result.scenarios.map(row => [row.id, row]));

  ok(near(byId['low-100'].result.scenario.debt.ending, expectedLow.balance)
      && near(byId['low-100'].result.scenario.debt.interest, expectedLow.interest)
      && near(byId['low-100'].result.scenario.debt.paid, expectedLow.paid),
    'low-target scenario matches the independent daily walk');
  ok(near(byId['high-100'].result.scenario.debt.ending, expectedHigh.balance)
      && near(byId['high-100'].result.scenario.debt.interest, expectedHigh.interest)
      && near(byId['high-100'].result.scenario.debt.paid, expectedHigh.paid),
    'high-target scenario matches the independent daily walk');
  ok(near(byId['low-100'].result.delta.debt.ending,
      expectedLow.balance - expectedLowBase.balance)
      && near(byId['high-100'].result.delta.debt.ending,
      expectedHigh.balance - expectedHighBase.balance),
    'named-debt ending deltas match independent baseline-vs-extra walks');

  ok(near(result.baseline.cash.ending, household.sim.ending),
    'shared cash ending matches the incumbent recommend weekly walk');
  ok(near(byId['low-100'].result.baseline.cash.ending, household.sim.ending)
      && near(byId['high-100'].result.baseline.cash.ending, household.sim.ending),
    'each scenario baseline cash matches that same independent walk');
  ok(near(byId['low-100'].result.scenario.cash.ending,
      household.sim.ending - expectedLow.paid)
      && near(byId['high-100'].result.scenario.cash.ending,
      household.sim.ending - expectedHigh.paid),
    'scenario cash endings are household cash minus independently absorbed extras');
  ok(!near(result.baseline.cash.ending, household.zeroWeekly.ending)
      || household.advice.weekly === 0,
    'shared baseline is not a zero-weekly overstatement unless weekly is already 0');
}

console.log('\n=== 6. Baseline A = B = C ===');
{
  const { plan, debts } = fixture({
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
  });
  const household = householdCash(plan, debts);
  ok(household.advice.weekly > 0,
    'the spend fixture has a non-zero incumbent weekly',
    String(household.advice.weekly));
  const result = compare(plan, debts, [
    { id: 'A', amount: 50, debtId: 'low' },
    { id: 'B', amount: 75, debtId: 'high' },
    { id: 'C', amount: 125, debtId: 'low' },
  ]);
  ok(result.status === 'ready', 'three-scenario spend fixture is ready');
  const cashA = result.scenarios[0].result.baseline.cash;
  const cashB = result.scenarios[1].result.baseline.cash;
  const cashC = result.scenarios[2].result.baseline.cash;
  ok(financialEqual(cashA, cashB) && financialEqual(cashB, cashC),
    'Baseline A cash = B cash = C cash');
  ok(financialEqual(cashA, result.baseline.cash)
      || (cashA.ending === result.baseline.cash.ending
        && financialEqual(cashA.min || null, result.baseline.cash.min || null)),
    'shared baseline cash is that same household packet');
  ok(result.scenarios.every(row => row.result.baseline.asOf === result.baseline.asOf),
    'every scenario as-of matches the shared baseline as-of');
  ok(result.baseline.horizonDays === DAYS,
    'shared horizon is the incumbent plan window');
  ok(near(result.baseline.cash.ending, household.sim.ending),
    'shared baseline cash independently equals recommend+simulate');
  ok(result.baseline.cashBaseline === 'incumbent-simOptions-weekly'
      && result.provenance.cashBaseline === 'incumbent-simOptions-weekly',
    'provenance records the incumbent weekly cash baseline');
}

console.log('\n=== 7. Scenario order does not change results ===');
{
  const { plan, debts } = fixture();
  const forward = compare(plan, debts, [
    { id: 'A', amount: 100, debtId: 'low' },
    { id: 'B', amount: 150, debtId: 'high' },
    { id: 'C', amount: 80, debtId: 'low' },
  ]);
  const reverse = compare(plan, debts, [
    { id: 'C', amount: 80, debtId: 'low' },
    { id: 'B', amount: 150, debtId: 'high' },
    { id: 'A', amount: 100, debtId: 'low' },
  ]);
  ok(forward.status === 'ready' && reverse.status === 'ready',
    'both orders are ready');
  ok(financialEqual(resultPack(forward.scenarios), resultPack(reverse.scenarios)),
    'reordering scenarios does not change any scenario result');
  ok(financialEqual(forward.baseline, reverse.baseline),
    'shared baseline is unchanged by scenario order');
  ok(forward.scenarios.map(row => row.id).join(',') === 'A,B,C'
      && reverse.scenarios.map(row => row.id).join(',') === 'C,B,A',
    'caller order is preserved for correlation; math is not');
}

console.log('\n=== 8. Isolation — A does not mutate B/C/plan/debts/data.json ===');
{
  const { plan, debts } = fixture();
  const planHash = JSON.stringify(plan);
  const debtHash = JSON.stringify(debts);
  const result = compare(plan, debts, [
    { id: 'A', amount: 10000, debtId: 'low' },
    { id: 'B', amount: 50, debtId: 'high' },
    { id: 'C', amount: 25, debtId: 'low' },
  ]);
  ok(result.status === 'ready', 'overflow comparison is ready');
  ok(JSON.stringify(plan) === planHash, 'plan is unchanged after overflow A');
  ok(JSON.stringify(debts) === debtHash, 'debts are unchanged after overflow A');
  const againB = slice6(plan, debts, 50, 'high');
  const againC = slice6(plan, debts, 25, 'low');
  const byId = Object.fromEntries(result.scenarios.map(row => [row.id, row]));
  ok(financialEqual(byId.B.result.delta, againB.delta),
    'scenario B still matches a later independent Slice 6 call');
  ok(financialEqual(byId.C.result.delta, againC.delta),
    'scenario C still matches a later independent Slice 6 call');
  ok(hashFile(DATA) === liveHash, 'comparison does not rewrite data.json');
}

console.log('\n=== 9. Named-target isolation — no unexpected spill ===');
{
  const { plan, debts } = fixture();
  const result = compare(plan, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  const base = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  const lowScenario = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0,
    extraAbsorbed: { [START]: result.scenarios[0].result.absorbed.amount },
    honorCallerExtraDebtTarget: true,
    extraDebtTarget: 'low',
    hypotheticalExtra: { amount: 100, date: START, debtId: 'low' },
    debtHorizonDays: DAYS,
  });
  ok(near(lowScenario.byId.high.paid, base.byId.high.paid)
      && near(lowScenario.byId.high.balance, base.byId.high.balance),
    'low-target leftover does not follow nextDollar onto the high-rate card');
  ok(result.scenarios[0].result.delta.debt.paid > 50
      && result.scenarios[0].input.debtId === 'low',
    'the low-target row is the one that received that extra');
  ok(result.scenarios[1].input.debtId === 'high'
      && result.scenarios[1].result.delta.debt.paid > 50,
    'the high-target row is independently the one that received its extra');
}

console.log('\n=== 10. No ranking / recommend / afford / policy ===');
{
  const { plan, debts } = fixture();
  const result = compare(plan, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  const blob = JSON.stringify(result);
  ok(result.ranking === null && result.recommendation === null
      && result.affordability === null
      && result.actionPermission === 'not-granted',
    'ranking, recommendation, and affordability are null; permission not granted');
  ok(result.provenance.ranking === null
      && result.provenance.recommendation === null
      && result.provenance.affordability === null,
    'provenance repeats those withheld decision fields');
  const language = blob.replace(/"affordability":null/g, '');
  ok(!/should pay|put every|afford|permission to|recommended|best debt|saves most/i.test(language),
    'the structured result has no free-form recommendation language');
  ok(!Object.prototype.hasOwnProperty.call(result, 'extraDebtCapacity')
      && !/extraDebtCapacity|endingSurplus|safeToSpend|breathingRoom|decisionPosture/.test(blob),
    'targetBuffer-derived room and posture are not published as affordability');

  const withPosture = clone(plan);
  withPosture.decisionPosture = {
    posture: 'aggressive-not-brittle',
    velocity: 'fastest-to-goal',
    numericThreshold: 'none',
    leftover: 400,
  };
  const stripped = clone(plan);
  delete stripped.decisionPosture;
  const a = compare(withPosture, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  const b = compare(stripped, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  ok(JSON.stringify(a) === JSON.stringify(b),
    'adding or removing a policy posture row does not change the comparison');

  const buffered = clone(plan);
  buffered.defaults = Object.assign({}, plan.defaults, { targetBuffer: 1 });
  const c = compare(buffered, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  ok(c.status === 'ready'
      && c.scenarios[0].input.amount === 100
      && c.scenarios[1].input.amount === 100
      && near(c.scenarios[0].result.absorbed.amount, a.scenarios[0].result.absorbed.amount)
      && near(c.scenarios[1].result.absorbed.amount, a.scenarios[1].result.absorbed.amount),
    'defaults.targetBuffer does not choose amounts, targets, or extras');
}

console.log('\n=== 11. Slice 6 fields preserved; unestablished fields omitted ===');
{
  const { plan, debts } = fixture();
  const result = compare(plan, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  const row = result.scenarios[0].result;
  ok(row.scenario.debt
      && typeof row.scenario.debt.ending === 'number'
      && typeof row.scenario.debt.interest === 'number'
      && typeof row.scenario.debt.paid === 'number',
    'named-debt ending / interest / paid are preserved');
  ok(typeof row.scenario.cash.ending === 'number',
    'cash ending is preserved');
  ok(row.scenario.cash.min == null
      || (row.scenario.cash.min.date && typeof row.scenario.cash.min.balance === 'number'),
    'cash min is present only if Slice 6 established it');
  ok(row.scenario.debt.availableCredit == null
      || typeof row.scenario.debt.availableCredit === 'number',
    'available credit is present only if Slice 6 established it');
  ok(row.delta.payoff == null
      || row.delta.payoff.clearedWithinWindow === true,
    'clear-within-window is present only if Slice 6 established it');
  ok(row.provenance && row.provenance.calculator === 'Forecast'
      && result.baseline.asOf === START
      && result.baseline.horizonDays === DAYS,
    'provenance / as-of / horizon are preserved');
  ok(!Object.prototype.hasOwnProperty.call(result, 'velocity')
      && !Object.prototype.hasOwnProperty.call(result, 'resilience')
      && !Object.prototype.hasOwnProperty.call(result, 'decisionPosture')
      && !Object.prototype.hasOwnProperty.call(result, 'safeToSpend'),
    'comparison does not invent Slice 6-unestablished decision fields');
}

console.log('\n=== 12–16. Fail closed — malformed / <2 / amount / debt / extra fields ===');
{
  const { plan, debts } = fixture();
  const cases = [
    [{ nature: 'hypothetical', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'non-comparison nature'],
    [{ nature: 'hypothetical-comparison' }, 'missing scenarios'],
    [{ nature: 'hypothetical-comparison', scenarios: [] }, 'empty scenarios'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' },
    ] }, 'single scenario'],
    [{ nature: 'hypothetical-comparison', scenarios: { amount: 100, debtId: 'low' } },
      'scenarios object instead of array'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], pickBestDebts: true }, 'best-two-debts extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], rankBy: 'interest-saved' }, 'wherever-saves-most extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], afford: true }, 'afford extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], amountFrom: 'all-extra-cash' }, 'all-extra-cash extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], useBuffer: 'above-buffer' }, 'above-buffer extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], applyDecisionPosture: true }, 'posture-creates-options extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], fundFrom: 'heloc' }, 'HELOC-funds-best-card extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low', pickBestDebt: true },
      { amount: 100, debtId: 'high' },
    ] }, 'per-scenario pick-best-debt extra field'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 0, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'zero amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: -50, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'negative amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: Infinity, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'non-finite amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100.001, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'sub-cent amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: '100', debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'string amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: true, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'boolean amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { debtId: 'low' }, { amount: 100, debtId: 'high' },
    ] }, 'missing amount'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100 }, { amount: 100, debtId: 'high' },
    ] }, 'missing debt id'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'missing' }, { amount: 100, debtId: 'high' },
    ] }, 'unknown debt'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low', id: '' },
      { amount: 100, debtId: 'high' },
    ] }, 'empty scenario id'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low', id: 'dup' },
      { amount: 150, debtId: 'high', id: 'dup' },
    ] }, 'duplicate scenario id'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      'pay the best two', { amount: 100, debtId: 'high' },
    ] }, 'non-object scenario'],
  ];
  for (const [input, label] of cases) {
    const result = F.hypotheticalExtraPaymentComparison(plan, debts, START, input);
    ok(result.status === 'unavailable'
        && result.recommendation === null
        && result.ranking === null
        && result.affordability === null
        && result.actionPermission === 'not-granted'
        && !Object.prototype.hasOwnProperty.call(result, 'scenarios'),
      `${label} fails closed without a scenarios payload`);
  }

  const mortgage = [{
    id: 'mortgage', label: 'Mortgage',
    balance: 5000, pending: 0, rate: 3.64, rateConvention: 'variable',
    structure: 'Amortising — synthetic', secured: true, limit: null,
  }, {
    id: 'low', label: 'Low-rate card',
    balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
    structure: 'Revolving — synthetic low', secured: false, limit: 1000,
  }];
  ok(compare(plan, mortgage, [
    { amount: 100, debtId: 'mortgage' },
    { amount: 100, debtId: 'low' },
  ]).status === 'unavailable',
    'an amortising mortgage among the scenarios fails the comparison');
}

console.log('\n=== 17. One unavailable scenario fails the comparison; unavailable ≠ zero ===');
{
  const { plan, debts } = fixture();
  const result = compare(plan, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'missing' },
  ]);
  ok(result.status === 'unavailable',
    'one missing-debt scenario fails the whole comparison');
  ok(!Object.prototype.hasOwnProperty.call(result, 'scenarios'),
    'the failed comparison does not publish a partial scenarios list');
  ok(!/0/.test(JSON.stringify(result.delta || {}))
      && result.recommendation === null,
    'unavailable is not coerced to a zero delta or a recommendation');

  const ready = slice6(plan, debts, 100, 'low');
  ok(ready.status === 'ready',
    'the valid sibling remains independently computable as Slice 6');
  ok(result.status === 'unavailable',
    'that independent ready sibling does not become a comparison result');
}

console.log('\n=== 18. Adversarial fail-closed — inference and policy asks ===');
{
  const { plan, debts } = fixture();
  const adversarial = [
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], bestTwoDebts: true }, 'best two debts'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], whereverSavesMost: true }, 'wherever saves most'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], maxAfford: true }, 'afford'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], allExtraCash: true }, 'all extra cash'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], aboveBuffer: true }, 'above buffer'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], postureCreatesOptions: true }, 'posture creates options'],
    [{ nature: 'hypothetical-comparison', scenarios: [
      { amount: 100, debtId: 'low' }, { amount: 100, debtId: 'high' },
    ], helocFundsBestCard: true }, 'HELOC funds best card'],
  ];
  for (const [input, label] of adversarial) {
    const result = F.hypotheticalExtraPaymentComparison(plan, debts, START, input);
    ok(result.status === 'unavailable' && result.ranking === null,
      `${label} fails closed`);
  }
}

console.log('\n=== 19. HELOC is an eligible named target; HELOC-as-funding is not ===');
{
  const { plan } = fixture();
  const debts = [
    {
      id: 'heloc', label: 'HELOC',
      balance: 400, pending: 0, rate: 4.9, rateConvention: 'variable',
      structure: 'Interest-only revolving — never amortises',
      secured: true, limit: 500, interestByEvent: true,
    },
    {
      id: 'low', label: 'Low-rate card',
      balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic low', secured: false, limit: 1000,
    },
  ];
  const result = compare(plan, debts, [
    { id: 'heloc-50', amount: 50, debtId: 'heloc' },
    { id: 'low-50', amount: 50, debtId: 'low' },
  ]);
  ok(result.status === 'ready'
      && result.scenarios[0].input.debtId === 'heloc'
      && result.scenarios[1].input.debtId === 'low',
    'explicit HELOC and card extras may be compared as named targets');
  ok(F.hypotheticalExtraPaymentComparison(plan, debts, START, {
    nature: 'hypothetical-comparison',
    scenarios: [
      { amount: 50, debtId: 'heloc' },
      { amount: 50, debtId: 'low' },
    ],
    fundFrom: 'heloc',
  }).status === 'unavailable',
    'using HELOC as a funding source to pay the best card fails closed');
}

console.log('\n=== 20. Optional scenario id is correlation only ===');
{
  const { plan, debts } = fixture();
  const labelled = compare(plan, debts, [
    { id: 'card-low', amount: 100, debtId: 'low' },
    { id: 'card-high', amount: 100, debtId: 'high' },
  ]);
  const plain = compare(plan, debts, [
    { amount: 100, debtId: 'low' },
    { amount: 100, debtId: 'high' },
  ]);
  ok(labelled.scenarios[0].id === 'card-low'
      && labelled.scenarios[1].id === 'card-high',
    'caller ids are echoed for correlation');
  ok(plain.scenarios[0].id === undefined
      && plain.scenarios[1].id === undefined,
    'ids are omitted when the caller does not supply them');
  ok(financialEqual(labelled.scenarios[0].result, plain.scenarios[0].result)
      && financialEqual(labelled.scenarios[1].result, plain.scenarios[1].result),
    'correlation ids do not change the Forecast results');
}

console.log('\n=== 21. No server or assistant surface consumes the comparison ===');
{
  for (const file of [
    'server.js',
    'scripts/assistant-packet.js',
    'scripts/assistant-mcp.js',
  ]) {
    const src = read(file);
    ok(!/hypotheticalExtraPaymentComparison/.test(src),
      `${file} does not reopen the comparison Forecast call`);
  }
}

console.log('\n=== 22. Architecture names the comparison owner ===');
{
  const architecture = read('ARCHITECTURE.md');
  ok(/Forecast\.hypotheticalExtraPaymentComparison/.test(architecture),
    'ARCHITECTURE.md names Forecast.hypotheticalExtraPaymentComparison');
  ok(/not `Forecast\.counterfactuals`/.test(architecture)
      || /Not `Forecast\.counterfactuals`/.test(architecture),
    'the row distinguishes this from counterfactuals');
}

ok(hashFile(DATA) === liveHash, 'live data.json bytes unchanged at suite end');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
