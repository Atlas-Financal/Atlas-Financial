'use strict';
/* Talk Slice 6 — Forecast-owned hypothetical extra-payment boundary.
 *
 * One caller-supplied extra against one eligible debt. Forecast is the
 * only calculator. Controlled fixtures; independent daily walk and cash
 * identity, not a second call of the producing helper.
 * `node test/test-hypothetical-extra-payment.js`
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

function ask(plan, debts, amount, debtId, extraInput) {
  return F.hypotheticalExtraPayment(plan, debts, START, Object.assign({
    amount, debtId, nature: 'hypothetical',
  }, extraInput || {}));
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

console.log('=== 1. Forecast is the sole calculator ===');
{
  const src = read('public/forecast.js');
  ok(/function hypotheticalExtraPayment\(/.test(src),
    'Forecast.hypotheticalExtraPayment is defined in public/forecast.js');
  const body = src.slice(src.indexOf('function hypotheticalExtraPayment('),
    src.indexOf('const Forecast = {'));
  ok(/projectDebts\(/.test(body) && /simulate\(/.test(body),
    'the boundary composes projectDebts and simulate');
  ok(/recommend\(/.test(body) && /weeklyVariable:\s*advice\.weekly/.test(body),
    'cash walks copy incumbent recommend simOptions and advice.weekly');
  ok(!/weeklyVariable:\s*0/.test(body),
    'it does not hard-code weeklyVariable: 0');
  ok(!/counterfactuals\(/.test(body) && !/paydayAllocation\(/.test(body),
    'it does not call counterfactuals or paydayAllocation');
  ok(!/writeFileSync|writeFile\(/.test(body),
    'it does not write files');
  ok(/typeof input\.amount !== 'number'/.test(body)
      && /Number\.isFinite\(input\.amount\)/.test(body)
      && !/Number\(input\.amount\)/.test(body),
    'amount requires typeof number and Number.isFinite; no Number() coercion');
  ok(!/decisionPosture/.test(src),
    'public/forecast.js still does not read plan.decisionPosture');
}

console.log('\n=== 2–4. Baseline identity, scenario moves only with the hyp, restore ===');
{
  const { plan, debts } = fixture();
  const before = JSON.stringify({ plan, debts });
  const result = ask(plan, debts, 100, 'low');
  const after = JSON.stringify({ plan, debts });
  ok(result.status === 'ready', 'a valid hypothetical is ready', result.reason);
  ok(after === before, 'plan and debts are not mutated');

  const baseWalk = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  const household = householdCash(plan, debts);
  ok(near(result.baseline.debt.ending, baseWalk.byId.low.balance),
    'baseline named-debt ending matches an independent projectDebts walk');
  ok(near(result.baseline.cash.ending, household.sim.ending),
    'baseline cash ending matches the incumbent recommend weekly walk');
  ok(near(result.baseline.debt.paid, baseWalk.byId.low.paid)
      && near(result.baseline.debt.interest, baseWalk.byId.low.interest),
    'baseline paid and interest match that same walk');

  const noHyp = F.hypotheticalExtraPayment(plan, debts, START, {
    amount: 0, debtId: 'low', nature: 'hypothetical',
  });
  ok(noHyp.status === 'unavailable',
    'a zero amount is not a silent baseline-as-scenario');
  ok(result.scenario.debt.ending < result.baseline.debt.ending - 0.5,
    'the scenario named-debt ending falls only when the hyp is applied');
  ok(result.scenario.cash.ending < result.baseline.cash.ending - 0.5,
    'the scenario cash ending falls only when the hyp is applied');
}

console.log('\n=== 5–7. Named-debt reduction, interest, cash — independent walk ===');
{
  const { plan, debts } = fixture();
  const amount = 100;
  const result = ask(plan, debts, amount, 'low');
  const low = debts.find(d => d.id === 'low');
  const high = debts.find(d => d.id === 'high');
  const expectedLow = walkCard(low.balance, low.rate, START, amount, DAYS, START);
  const expectedHigh = walkCard(high.balance, high.rate, START, 0, DAYS, START);
  const expectedLowBase = walkCard(low.balance, low.rate, START, 0, DAYS, START);

  ok(near(result.absorbed.amount, expectedLow.paid),
    'absorbed equals the independent named-debt take',
    `${result.absorbed.amount} vs ${expectedLow.paid}`);
  ok(near(result.scenario.debt.ending, expectedLow.balance),
    'scenario named-debt ending matches the independent daily walk');
  ok(near(result.scenario.debt.interest, expectedLow.interest),
    'scenario named-debt interest matches the independent daily walk');
  ok(near(result.scenario.debt.paid, expectedLow.paid),
    'scenario named-debt paid matches the independent daily walk');
  ok(near(result.delta.debt.ending, expectedLow.balance - expectedLowBase.balance),
    'named-debt ending delta matches independent baseline-vs-extra walks');
  ok(near(result.delta.debt.interest, expectedLow.interest - expectedLowBase.interest),
    'named-debt interest delta matches those walks');

  const baseWalk = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  ok(near(baseWalk.byId.high.balance, expectedHigh.balance),
    'the untouched high-rate card matches its independent no-extra walk');
  const scenarioWalk = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: result.absorbed.amount
      ? { [START]: result.absorbed.amount } : null,
    honorCallerExtraDebtTarget: true,
    extraDebtTarget: 'low',
    hypotheticalExtra: { amount, date: START, debtId: 'low' },
    debtHorizonDays: DAYS,
  });
  ok(near(scenarioWalk.byId.high.paid, baseWalk.byId.high.paid)
      && near(scenarioWalk.byId.high.balance, baseWalk.byId.high.balance),
    'the high-rate card is unchanged — leftover does not follow nextDollar');

  const household = householdCash(plan, debts);
  const expectedCashEnd = household.sim.ending - expectedLow.paid;
  ok(near(result.scenario.cash.ending, expectedCashEnd),
    'scenario cash ending is incumbent household cash minus independently absorbed extra',
    `${result.scenario.cash.ending} vs ${expectedCashEnd}`);
  ok(near(result.delta.cash.ending, -expectedLow.paid),
    'cash ending delta is exactly −absorbed on top of the household weekly walk');
  ok(near(result.delta.cash.extra, expectedLow.paid),
    'published extra cash out equals the independent take');
}

console.log('\n=== caller target is honored when nextDollar would substitute ===');
{
  const { plan, debts } = fixture();
  const priority = F.debtPriority(plan, debts);
  ok(priority.status === 'ready' && priority.target.id === 'high',
    'owner policy on this fixture targets the high-rate card');
  const substituted = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 100, extraDebtTarget: 'low',
    extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  const base = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  ok(substituted.byId.high.paid > base.byId.high.paid + 50
      && near(substituted.byId.low.paid, base.byId.low.paid),
    'incumbent extraDebtTarget is still substituted to the policy target');
  const result = ask(plan, debts, 100, 'low');
  ok(result.status === 'ready'
      && result.input.debtId === 'low'
      && result.provenance.targetSource === 'caller'
      && result.provenance.ownerNextDollarNotUsedForHypotheticalTarget === true,
    'the hypothetical records the caller target, not the policy target');
  ok(result.delta.debt.paid > 50,
    'the caller-named low-rate card is the one that received the extra');
}

console.log('\n=== 8–11. Amount is not spendable; no advice; policy unused ===');
{
  const { plan, debts } = fixture();
  const result = ask(plan, debts, 100, 'low');
  const blob = JSON.stringify(result);
  ok(result.input.amountIsNotSpendableCash === true
      && result.provenance.amountIsNotSpendableCash === true,
    'amount is labelled not spendable / available cash');
  ok(result.input.availableCreditIsNotCash === true
      && result.provenance.availableCreditIsNotCash === true,
    'available credit is labelled not cash');
  ok(result.recommendation === null && result.actionPermission === 'not-granted',
    'no recommendation and no action permission');
  ok(!/should pay|put every|afford|permission to|recommended/i.test(blob),
    'the structured result has no free-form recommendation language');
  ok(!Object.prototype.hasOwnProperty.call(result, 'extraDebtCapacity')
      && !/extraDebtCapacity|endingSurplus|safeToSpend|breathingRoom/.test(blob),
    'targetBuffer-derived room is not published as affordability');

  const withPosture = clone(plan);
  withPosture.decisionPosture = {
    posture: 'aggressive-not-brittle',
    velocity: 'fastest-to-goal',
    numericThreshold: 'none',
    leftover: 400,
  };
  const stripped = clone(plan);
  delete stripped.decisionPosture;
  const a = ask(withPosture, debts, 100, 'low');
  const b = ask(stripped, debts, 100, 'low');
  ok(JSON.stringify(a) === JSON.stringify(b),
    'adding or removing a policy posture row does not change the result');

  const buffered = clone(plan);
  buffered.defaults = Object.assign({}, plan.defaults, { targetBuffer: 1 });
  const c = ask(buffered, debts, 100, 'low');
  ok(c.input.amount === 100 && c.input.debtId === 'low'
      && near(c.absorbed.amount, a.absorbed.amount)
      && near(c.delta.debt.paid, a.delta.debt.paid)
      && near(c.delta.cash.ending, a.delta.cash.ending),
    'defaults.targetBuffer does not choose the amount, target, or extra');
}

console.log('\n=== cash baseline uses incumbent weekly spend, not zero ===');
{
  const { plan, debts } = fixture({
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
  });
  const household = householdCash(plan, debts);
  ok(household.advice.weekly > 0,
    'the spend fixture has a non-zero incumbent weekly',
    String(household.advice.weekly));
  ok(Math.abs(household.sim.ending - household.zeroWeekly.ending) > 1,
    'zero weekly overstates household cash on this fixture');
  const result = ask(plan, debts, 100, 'low');
  ok(result.status === 'ready', 'the spend fixture hypothetical is ready');
  ok(near(result.baseline.cash.ending, household.sim.ending),
    'published baseline cash matches the incumbent weekly walk');
  ok(!near(result.baseline.cash.ending, household.zeroWeekly.ending),
    'published baseline cash is not the zero-weekly overstatement');
  ok(near(result.scenario.cash.ending, household.sim.ending - result.absorbed.amount),
    'scenario cash is the same household walk minus the hyp extra');
  ok(result.recommendation === null && result.actionPermission === 'not-granted',
    'copying recommend settings does not publish a recommendation or permission');
  ok(!Object.prototype.hasOwnProperty.call(result, 'weekly')
      && !Object.prototype.hasOwnProperty.call(result, 'paydayAllocation'),
    'the result does not publish payday or weekly-cap advice');
}

console.log('\n=== 12–13. Invalid debt and amount fail closed ===');
{
  const { plan, debts } = fixture();
  const cases = [
    [{ amount: 100, debtId: 'low', nature: 'actual' }, 'non-hypothetical nature'],
    [{ amount: 0, debtId: 'low', nature: 'hypothetical' }, 'zero amount'],
    [{ amount: -50, debtId: 'low', nature: 'hypothetical' }, 'negative amount'],
    [{ amount: Infinity, debtId: 'low', nature: 'hypothetical' }, 'non-finite amount'],
    [{ amount: 100.001, debtId: 'low', nature: 'hypothetical' }, 'sub-cent amount'],
    [{ amount: 1000001, debtId: 'low', nature: 'hypothetical' }, 'absurd amount'],
    [{ amount: 100, debtId: 'missing', nature: 'hypothetical' }, 'unknown debt'],
    [{ amount: 100, debtId: '', nature: 'hypothetical' }, 'empty debt id'],
    [{ amount: 100, nature: 'hypothetical' }, 'missing debt id'],
    [{ debtId: 'low', nature: 'hypothetical' }, 'missing amount'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', pickBestDebt: true },
      'pick-best-debt extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', fundFrom: 'heloc' },
      'HELOC-to-card extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', amountFrom: 'cash' },
      'infer-from-cash extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', ignoreCommitments: true },
      'ignore-commitments extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', applyDecisionPosture: true },
      'apply-posture extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', useBuffer: 500 },
      'use-buffer extra field'],
    [{ amount: 100, debtId: 'low', nature: 'hypothetical', maxAfford: true },
      'max-afford extra field'],
    [{ amount: true, debtId: 'low', nature: 'hypothetical' }, 'boolean true amount'],
    [{ amount: false, debtId: 'low', nature: 'hypothetical' }, 'boolean false amount'],
    [{ amount: '100', debtId: 'low', nature: 'hypothetical' }, 'string amount'],
    [{ amount: { value: 100 }, debtId: 'low', nature: 'hypothetical' }, 'object amount'],
    [{ amount: [100], debtId: 'low', nature: 'hypothetical' }, 'array amount'],
  ];
  for (const [input, label] of cases) {
    const result = F.hypotheticalExtraPayment(plan, debts, START, input);
    ok(result.status === 'unavailable' && result.recommendation === null
        && result.actionPermission === 'not-granted',
      `${label} fails closed`);
  }

  const mortgage = [{
    id: 'mortgage', label: 'Mortgage',
    balance: 5000, pending: 0, rate: 3.64, rateConvention: 'variable',
    structure: 'Amortising — synthetic', secured: true, limit: null,
  }];
  ok(ask(plan, mortgage, 100, 'mortgage').status === 'unavailable',
    'an amortising mortgage is an unsupported type');

  const unknownPending = clone(debts);
  unknownPending[1].pendingUnknown = true;
  ok(ask(plan, unknownPending, 100, 'low').status === 'unavailable',
    'unknown pending fails closed');

  const duplicate = debts.concat(clone(debts[1]));
  ok(ask(plan, duplicate, 100, 'low').status === 'unavailable',
    'an ambiguous duplicate id fails closed');

  const cleared = clone(debts);
  cleared[1].balance = 0;
  ok(ask(plan, cleared, 100, 'low').status === 'unavailable',
    'a cleared debt fails closed');
}

console.log('\n=== 14. Unavailable / stale baseline fails closed ===');
{
  const { plan, debts } = fixture();
  ok(F.hypotheticalExtraPayment(plan, debts, '2026-02-01', {
    amount: 100, debtId: 'low', nature: 'hypothetical',
  }).status === 'unavailable', 'a mismatched as-of fails closed');
  const noOpening = clone(plan);
  delete noOpening.opening;
  ok(ask(noOpening, debts, 100, 'low').status === 'unavailable',
    'a missing opening as-of fails closed');
  const noCash = clone(plan);
  delete noCash.startingCash;
  ok(ask(noCash, debts, 100, 'low').status === 'unavailable',
    'a missing cash baseline fails closed');
  ok(F.hypotheticalExtraPayment(plan, [], START, {
    amount: 100, debtId: 'low', nature: 'hypothetical',
  }).status === 'unavailable', 'missing debts fail closed');
  ok(F.hypotheticalExtraPayment(null, debts, START, {
    amount: 100, debtId: 'low', nature: 'hypothetical',
  }).status === 'unavailable', 'a missing plan fails closed');
}

console.log('\n=== 15. No state mutation of live data.json ===');
{
  const { plan, debts } = fixture();
  ask(plan, debts, 100, 'low');
  ask(plan, debts, 100, 'missing');
  ok(hashFile(DATA) === liveHash, 'this suite does not rewrite data.json');
}

console.log('\n=== overflow stays on the named debt ===');
{
  const { plan, debts } = fixture();
  const result = ask(plan, debts, 10000, 'low');
  const low = debts.find(d => d.id === 'low');
  const expected = walkCard(low.balance, low.rate, START, 10000, DAYS, START);
  ok(result.status === 'ready', 'an extra larger than the balance is still a hyp');
  ok(near(result.absorbed.amount, expected.paid)
      && result.absorbed.unabsorbed > 0,
    'only the named balance is absorbed; leftover is reported, not redirected');
  ok(near(result.scenario.debt.ending, 0) || result.scenario.debt.ending < 0.01,
    'the named debt is cleared rather than overpaid onto another card');
  const base = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0, extraAbsorbed: null, obligationAbsorbed: null,
    debtHorizonDays: DAYS,
  });
  const scenarioWalk = F.projectDebts(plan, debts, START, {
    extraDebtMonthly: 0,
    extraAbsorbed: { [START]: result.absorbed.amount },
    honorCallerExtraDebtTarget: true,
    extraDebtTarget: 'low',
    hypotheticalExtra: { amount: 10000, date: START, debtId: 'low' },
    debtHorizonDays: DAYS,
  });
  ok(near(scenarioWalk.byId.high.paid, base.byId.high.paid),
    'overflow does not pay the policy-preferred card');
}

console.log('\n=== HELOC is an eligible target; HELOC-as-funding is not ===');
{
  const { plan } = fixture();
  const debts = [
    {
      id: 'heloc', label: 'HELOC',
      balance: 400, pending: 0, rate: 4.9, rateConvention: 'variable',
      structure: 'Interest-only revolving — never amortises',
      secured: true, limit: 500, interestByEvent: true,
    },
  ];
  const result = ask(plan, debts, 50, 'heloc');
  ok(result.status === 'ready' && result.input.debtId === 'heloc',
    'an explicit HELOC extra is an eligible named-debt hyp');
  ok(F.hypotheticalExtraPayment(plan, debts, START, {
    amount: 50, debtId: 'heloc', nature: 'hypothetical', fundFrom: 'heloc',
  }).status === 'unavailable',
    'using HELOC as a funding source to pay debt fails closed');
}

console.log('\n=== 16. Auth isolation — no server fan-out in this slice ===');
{
  for (const file of [
    'server.js',
    'scripts/assistant-packet.js',
    'scripts/assistant-mcp.js',
  ]) {
    const src = read(file);
    ok(!/hypotheticalExtraPayment/.test(src),
      `${file} does not consume the new Forecast boundary`);
  }
}

console.log('\n=== architecture names the new Forecast owner ===');
{
  const architecture = read('ARCHITECTURE.md');
  ok(/Forecast\.hypotheticalExtraPayment/.test(architecture),
    'ARCHITECTURE.md names Forecast.hypotheticalExtraPayment');
  ok(/not `Forecast\.counterfactuals`/.test(architecture)
      || /Not `Forecast\.counterfactuals`/.test(architecture),
    'the row distinguishes this from counterfactuals');
}

ok(hashFile(DATA) === liveHash, 'live data.json bytes unchanged at suite end');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
