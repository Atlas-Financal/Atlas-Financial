'use strict';
/* Financial Trajectory Outcome 4 — Forecast-owned additional-debt-payment
 * scenario against the same baselineTrajectory planned-HB walk.
 *
 * Caller supplies explicit nature + amount + debtId. Forecast composes
 * the shared internal walk helper plus projectDebts / simulate
 * hypotheticalExtra-style absorption. Independent of a second call of
 * the producing helper: planned weekly, last published cash close,
 * and a daily named-debt walk. Recommend weekly is not the baseline.
 * `node test/test-baseline-trajectory-scenario.js`
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
const START = '2026-06-15';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function roundCent(n) {
  return Math.round(n * 100) / 100;
}

function periodsFixture(extraSpending) {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [
          { label: 'Groceries', total: 50000 },
          { label: 'Travel', total: 18000 },
          { label: 'Fuel & transport', total: 9000 },
        ].concat(extraSpending || []),
      },
    },
  };
}

function fixture(extraPlan, extraDebts) {
  const plan = Object.assign({
    windowDays: 91,
    startingCash: { amount: 2500 },
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
          id: 'travel', label: 'Travel', class: 'discretionary',
          from: ['Travel'],
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
      {
        id: 'store-min', debtId: 'store', effect: 'payment',
        label: 'Store minimum', frequency: 'monthly', day: 22,
        amount: 40, confidence: 'confirmed',
      },
    ],
    bills: [],
    commitments: [],
  }, extraPlan || {});
  const debts = extraDebts || [
    {
      id: 'card', label: 'Synthetic card',
      balance: 5000, pending: 0, rate: 19.99, rateConvention: 'card',
      structure: 'Revolving — synthetic', secured: false, limit: 8000,
    },
    {
      id: 'store', label: 'Store card',
      balance: 3000, pending: 0, rate: 29.99, rateConvention: 'card',
      structure: 'Revolving — synthetic store', secured: false, limit: 4000,
    },
  ];
  return { plan, debts };
}

function amandaFixture(extraPlan, extraDebts) {
  return fixture(Object.assign({
    income: [
      {
        id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
        frequency: 'monthly', day: 15, amount: 2000, confidence: 'confirmed',
      },
    ],
  }, extraPlan || {}), extraDebts);
}

function lastPublishedCash(traj) {
  const months = (traj && traj.months) || [];
  for (let i = months.length - 1; i >= 0; i--) {
    const cash = months[i] && months[i].cash;
    if (cash && (cash.status === 'calculated' || cash.status === 'estimated')
        && typeof cash.amount === 'number') {
      return {
        status: cash.status,
        amount: cash.amount,
        asOf: cash.asOf || months[i].end,
        trust: cash.trust || null,
      };
    }
  }
  return null;
}

function lastNamedDebt(traj, debtId) {
  const months = (traj && traj.months) || [];
  for (let i = months.length - 1; i >= 0; i--) {
    const debt = months[i] && months[i].debt;
    if (!debt || debt.status !== 'calculated' || !Array.isArray(debt.debts)) continue;
    const row = debt.debts.find(d => d && d.id === debtId);
    if (row) {
      return {
        asOf: debt.asOf,
        balance: row.balance,
        paid: row.paid,
        interest: row.interest,
      };
    }
  }
  return null;
}

function walkCard(opening, rate, extraDate, extraAmount, paymentDay, paymentAmount, start, end) {
  let balance = opening;
  let interest = 0;
  let paid = 0;
  let date = start;
  while (date <= end) {
    const daily = balance * (rate / 100) / 365;
    balance += daily;
    interest += daily;
    if (extraDate && date === extraDate && extraAmount > 0) {
      const take = Math.min(extraAmount, balance);
      balance -= take;
      paid += take;
    }
    if (paymentAmount > 0 && Number(date.slice(8, 10)) === paymentDay && balance > 0) {
      const take = Math.min(paymentAmount, balance);
      balance -= take;
      paid += take;
    }
    date = addDays(date, 1);
  }
  return {
    balance: roundCent(balance),
    interest: roundCent(interest),
    paid: roundCent(paid),
  };
}

function ask(plan, debts, amount, debtId, extraInput) {
  return F.baselineTrajectoryScenario(plan, debts, START, Object.assign({
    amount, debtId, nature: 'additional-debt-payment',
    periods: periodsFixture(),
  }, extraInput || {}));
}

function trajOf(plan, debts) {
  return F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
}

console.log('=== 1. Forecast is the sole calculator; helper not exported ===');
{
  const src = read('public/forecast.js');
  ok(/function baselineTrajectoryScenario\(/.test(src),
    'Forecast.baselineTrajectoryScenario is defined in public/forecast.js');
  ok(typeof F.baselineTrajectoryScenario === 'function',
    'Forecast.baselineTrajectoryScenario is exported');
  ok(/function prepareBaselineTrajectoryWalk\(/.test(src),
    'the shared walk helper lives inside Forecast');
  ok(typeof F.prepareBaselineTrajectoryWalk !== 'function',
    'the shared walk helper is not a second exported engine');
  ok(typeof F.trajectoryPublishedCashClose !== 'function'
      && typeof F.trajectoryScenarioCashView !== 'function',
    'scenario cash helpers are not exported');
  const body = src.slice(src.indexOf('function baselineTrajectoryScenario('),
    src.indexOf('function hypotheticalExtraPayment('));
  ok(/prepareBaselineTrajectoryWalk\(/.test(body),
    'the scenario composes the shared baselineTrajectory walk helper');
  ok(/projectDebts\(/.test(body) && /simulate\(/.test(body),
    'the scenario composes projectDebts and simulate');
  ok(/hypotheticalExtra:/.test(body) && /honorCallerExtraDebtTarget/.test(body),
    'absorption is the incumbent hypotheticalExtra path');
  ok(!/recommend\(/.test(body) && !/recommendWeekly\(/.test(body),
    'the scenario does not search Forecast.recommend for a weekly cap');
  ok(!/counterfactuals\(/.test(body),
    'the scenario does not call counterfactuals');
  ok(!/hypotheticalExtraPayment\(/.test(body),
    'the scenario does not call the recommend-weekly hypotheticalExtraPayment seam');
  ok(/typeof input\.amount !== 'number'/.test(body)
      && /Number\.isFinite\(input\.amount\)/.test(body)
      && !/Number\(input\.amount\)/.test(body),
    'amount requires typeof number and Number.isFinite; no Number() coercion');
  ok(!/writeFileSync|writeFile\(/.test(body),
    'it does not write files');
  ok(/budgetBreakdown-planned-weekly/.test(body)
      && /recommendWeeklyCap: 'not-used'/.test(body),
    'provenance names the planned-HB baseline and unused recommend cap');
}

console.log('\n=== 2. Baseline key matches baselineTrajectory planned-HB walk ===');
{
  const { plan, debts } = fixture();
  const before = JSON.stringify({ plan, debts });
  const traj = trajOf(plan, debts);
  const result = ask(plan, debts, 100, 'card');
  const after = JSON.stringify({ plan, debts });
  ok(traj.status === 'ready', 'baselineTrajectory is ready on this fixture');
  ok(result.status === 'ready', 'a valid additional-debt-payment is ready', result.reason);
  ok(after === before, 'plan and debts are not mutated');

  ok(result.baseline.weeklyVariable.source === 'budgetBreakdown.planned'
      && result.baseline.weeklyVariable.historicalActuals === 'excluded',
    'scenario baseline weeklyVariable is planned Household Budget');
  ok(near(result.baseline.weeklyVariable.amount, traj.weeklyVariable.amount),
    'scenario weeklyVariable equals baselineTrajectory planned weekly',
    `${result.baseline.weeklyVariable.amount} vs ${traj.weeklyVariable.amount}`);
  ok(result.baseline.horizon.start === traj.horizon.start
      && result.baseline.horizon.end === traj.horizon.end
      && result.baseline.horizon.days === traj.horizon.days,
    'scenario horizon equals baselineTrajectory knowledgeHorizon');

  const bd = F.budgetBreakdown(plan, periodsFixture());
  const plannedMonthly = bd.categories
    .filter(c => c.class !== 'reserve' && c.source !== 'historical-actual')
    .reduce((s, c) => s + (c.planned || 0), 0);
  const expectedWeekly = roundCent(plannedMonthly / WEEKS_PER_MONTH);
  ok(near(result.baseline.weeklyVariable.amount, expectedWeekly),
    'weeklyVariable equals independently summed planned remainder / calendar weeks',
    `${result.baseline.weeklyVariable.amount} vs ${expectedWeekly}`);

  const published = lastPublishedCash(traj);
  ok(!!published && result.baseline.cash.status === published.status,
    'scenario cash uses the last published trajectory cash status');
  ok(published && result.baseline.cash.asOf === published.asOf
      && near(result.baseline.cash.ending, published.amount),
    'scenario baseline cash ending matches last published baselineTrajectory close',
    published
      ? `${result.baseline.cash.ending} vs ${published.amount} on ${published.asOf}`
      : 'no published cash');

  const named = lastNamedDebt(traj, 'card');
  ok(!!named && near(result.baseline.debt.ending, named.balance)
      && near(result.baseline.debt.paid, named.paid)
      && near(result.baseline.debt.interest, named.interest),
    'scenario baseline named-debt matches last published coupled mark',
    named
      ? `${result.baseline.debt.ending} vs ${named.balance}`
      : 'no named debt mark');

  const advice = F.recommend(plan, START, {
    debts,
    extraDebtMonthly: 0,
    targetBuffer: 200,
  });
  ok(advice && typeof advice.weekly === 'number',
    'recommend still answers a feasible weekly cap beside the trajectory');
  ok(result.provenance.recommendWeeklyCap === 'not-used'
      && result.provenance.cashBaseline === 'budgetBreakdown-planned-weekly',
    'scenario provenance says the recommend weekly cap was not used');
  ok(!near(result.baseline.weeklyVariable.amount, advice.weekly, 1)
      || near(advice.weekly, expectedWeekly),
    'when recommend weekly differs, the scenario still uses planned HB',
    `planned ${result.baseline.weeklyVariable.amount} vs recommend ${advice.weekly}`);
}

console.log('\n=== 3. One explicit extra returns baseline + scenario + walk-established deltas ===');
{
  const { plan, debts } = fixture();
  const amount = 100;
  const traj = trajOf(plan, debts);
  const result = ask(plan, debts, amount, 'card');
  const card = debts.find(d => d.id === 'card');
  const store = debts.find(d => d.id === 'store');
  const expectedCard = walkCard(card.balance, card.rate, START, amount, 20, 80,
    START, traj.horizon.end);
  const expectedCardBase = walkCard(card.balance, card.rate, START, 0, 20, 80,
    START, traj.horizon.end);
  const expectedStore = walkCard(store.balance, store.rate, START, 0, 22, 40,
    START, traj.horizon.end);

  ok(near(result.absorbed.amount, expectedCard.paid - expectedCardBase.paid)
      || near(result.absorbed.amount, amount),
    'absorbed is the independent named-debt take of the extra',
    `${result.absorbed.amount}`);
  ok(near(result.scenario.debt.ending, expectedCard.balance),
    'scenario named-debt ending matches the independent daily walk',
    `${result.scenario.debt.ending} vs ${expectedCard.balance}`);
  ok(near(result.scenario.debt.interest, expectedCard.interest),
    'scenario named-debt interest matches the independent daily walk',
    `${result.scenario.debt.interest} vs ${expectedCard.interest}`);
  ok(near(result.baseline.debt.ending, expectedCardBase.balance),
    'baseline named-debt ending matches the independent no-extra walk',
    `${result.baseline.debt.ending} vs ${expectedCardBase.balance}`);
  ok(near(result.delta.debt.ending, expectedCard.balance - expectedCardBase.balance),
    'named-debt ending delta matches independent baseline-vs-extra walks');
  ok(near(result.delta.debt.interest, expectedCard.interest - expectedCardBase.interest),
    'named-debt interest delta matches those walks');
  ok(result.scenario.debt.ending < result.baseline.debt.ending - 0.5,
    'the scenario named-debt ending falls only when the extra is applied');

  const storeBase = lastNamedDebt(traj, 'store');
  ok(storeBase && near(storeBase.balance, expectedStore.balance),
    'untouched store card matches its independent no-extra walk');
  ok(result.input.debtId === 'card',
    'the caller-named card is the recorded target');

  const published = lastPublishedCash(traj);
  ok(published && result.delta.cash
      && near(result.delta.cash.ending, -result.absorbed.amount),
    'last published cash ending falls by the independently absorbed extra',
    result.delta.cash
      ? `${result.delta.cash.ending} vs ${-result.absorbed.amount}`
      : 'no cash delta');
  ok(result.scenario.cash.status === result.baseline.cash.status
      && result.scenario.cash.asOf === result.baseline.cash.asOf,
    'scenario cash is compared on the same published as-of as the baseline');
}

console.log('\n=== 4. Amanda-only horizon cash is fully published and extra-only ===');
{
  const { plan, debts } = amandaFixture();
  const traj = trajOf(plan, debts);
  const last = traj.months[traj.months.length - 1];
  ok(last.cash.status === 'calculated' && last.end === traj.horizon.end,
    'Amanda-only last month cash is calculated through horizon end');
  const result = ask(plan, debts, 80, 'card');
  ok(result.status === 'ready', 'Amanda-only additional payment is ready');
  ok(result.baseline.cash.status === 'calculated'
      && result.baseline.cash.asOf === traj.horizon.end
      && near(result.baseline.cash.ending, last.cash.amount),
    'full-horizon cash ending matches baselineTrajectory last month');
  ok(result.baseline.cash.extra != null
      && result.scenario.cash.extra != null
      && near(result.delta.cash.extra, result.absorbed.amount),
    'cash extra delta is the absorbed extra on a fully published cash walk');
  ok(near(result.delta.cash.ending, -result.absorbed.amount),
    'cash ending delta is −absorbed on the planned-HB walk');
}

console.log('\n=== 5. Ranking / permission / policy unused; amount is not cash ===');
{
  const { plan, debts } = fixture();
  const result = ask(plan, debts, 100, 'card');
  const blob = JSON.stringify(result);
  ok(result.recommendation == null && result.ranking == null
      && result.affordability == null
      && result.actionPermission === 'not-granted'
      && result.writesCanonicalState === false,
    'ranking, recommendation, and affordability stay null; no write or permission');
  ok(result.provenance.ranking == null && result.provenance.recommendation == null
      && result.provenance.affordability == null,
    'provenance repeats those nulls');
  ok(result.input.amountIsNotSpendableCash === true
      && result.provenance.amountIsNotSpendableCash === true,
    'amount is labelled not spendable cash');
  ok(result.input.availableCreditIsNotCash === true
      && result.provenance.availableCreditIsNotCash === true,
    'available credit is labelled not cash');
  ok(!/should pay|put every|permission to|recommended/i.test(blob),
    'the structured result has no free-form recommendation language');
  ok(!Object.prototype.hasOwnProperty.call(result, 'extraDebtCapacity')
      && !/safeToSpend|breathingRoom|RYG|minCash/.test(blob),
    'min-cash / breathing-room / safe-to-spend / RYG are not published');

  const withPosture = clone(plan);
  withPosture.decisionPosture = {
    posture: 'aggressive-not-brittle',
    velocity: 'fastest-to-goal',
    numericThreshold: 'none',
    leftover: 400,
  };
  const stripped = clone(plan);
  delete stripped.decisionPosture;
  const a = ask(withPosture, debts, 100, 'card');
  const b = ask(stripped, debts, 100, 'card');
  ok(JSON.stringify(a) === JSON.stringify(b),
    'adding or removing a policy posture row does not change the result');

  const buffered = clone(plan);
  buffered.defaults = Object.assign({}, plan.defaults, { targetBuffer: 1 });
  const c = ask(buffered, debts, 100, 'card');
  ok(c.input.amount === 100 && c.input.debtId === 'card'
      && near(c.absorbed.amount, a.absorbed.amount)
      && near(c.delta.debt.paid, a.delta.debt.paid)
      && near(c.delta.cash.ending, a.delta.cash.ending),
    'defaults.targetBuffer does not choose the amount, target, or extra');

  const priority = F.debtPriority(plan, debts);
  ok(priority.status === 'ready' && priority.target.id === 'store',
    'owner policy on this fixture targets the higher-rate store card');
  const onLow = ask(plan, debts, 100, 'card');
  ok(onLow.input.debtId === 'card'
      && onLow.provenance.targetSource === 'caller'
      && onLow.provenance.ownerNextDollarNotUsedForScenarioTarget === true
      && onLow.delta.debt.paid > 50,
    'the caller-named card receives the extra; leftover does not follow nextDollar');
}

console.log('\n=== 6. Unavailable / inferred / HELOC-funding / missing-input fail closed ===');
{
  const { plan, debts } = fixture();
  const cases = [
    [{ amount: 100, debtId: 'card', nature: 'hypothetical', periods: periodsFixture() },
      'Slice 6 hypothetical nature is the wrong seam'],
    [{ amount: 100, debtId: 'card', nature: 'trajectory-scenario', periods: periodsFixture() },
      'unknown nature'],
    [{ amount: 0, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'zero amount'],
    [{ amount: -50, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'negative amount'],
    [{ amount: Infinity, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'non-finite amount'],
    [{ amount: 100.001, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'sub-cent amount'],
    [{ amount: 1000001, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'absurd amount'],
    [{ amount: 100, debtId: 'missing', nature: 'additional-debt-payment', periods: periodsFixture() },
      'unknown debt'],
    [{ amount: 100, debtId: '', nature: 'additional-debt-payment', periods: periodsFixture() },
      'empty debt id'],
    [{ amount: 100, nature: 'additional-debt-payment', periods: periodsFixture() },
      'missing debt id'],
    [{ debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'missing amount'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), pickBestDebt: true },
      'pick-best-debt extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), fundFrom: 'heloc' },
      'HELOC-to-card extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), amountFrom: 'cash' },
      'infer-from-cash extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), ignoreCommitments: true },
      'ignore-commitments extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), applyDecisionPosture: true },
      'apply-posture extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), useBuffer: 500 },
      'use-buffer extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), maxAfford: true },
      'max-afford extra field'],
    [{ amount: 100, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture(), extraDebtTarget: 'store' },
      'extraDebtTarget extra field'],
    [{ amount: true, debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'boolean true amount'],
    [{ amount: '100', debtId: 'card', nature: 'additional-debt-payment', periods: periodsFixture() },
      'string amount'],
    [{ amount: { value: 100 }, debtId: 'card', nature: 'additional-debt-payment',
      periods: periodsFixture() },
      'object amount'],
  ];
  for (const [input, label] of cases) {
    const result = F.baselineTrajectoryScenario(plan, debts, START, input);
    ok(result.status === 'unavailable' && result.recommendation == null
        && result.ranking == null && result.affordability == null
        && result.actionPermission === 'not-granted'
        && !Object.prototype.hasOwnProperty.call(result, 'delta'),
      `${label} fails closed`);
    ok(!result.baseline && !result.scenario,
      `${label} does not publish a $0 baseline or scenario`);
  }

  ok(F.baselineTrajectoryScenario(plan, debts, START, {
    amount: 100, debtId: 'card', nature: 'additional-debt-payment',
  }).status === 'unavailable',
    'missing periods/breakdown is unavailable, not a $0 weekly walk');
  ok(F.baselineTrajectory(plan, debts, START, {}).status === 'unavailable',
    'that same missing breakdown makes baselineTrajectory unavailable');

  const mortgage = [{
    id: 'mortgage', label: 'Mortgage',
    balance: 5000, pending: 0, rate: 3.64, rateConvention: 'variable',
    structure: 'Amortising — synthetic', secured: true, limit: null,
  }];
  ok(ask(plan, mortgage, 100, 'mortgage').status === 'unavailable',
    'an amortising mortgage is an unsupported type');

  const unknownPending = clone(debts);
  unknownPending[0].pendingUnknown = true;
  ok(ask(plan, unknownPending, 100, 'card').status === 'unavailable',
    'unknown pending fails closed');

  const duplicate = debts.concat(clone(debts[0]));
  ok(ask(plan, duplicate, 100, 'card').status === 'unavailable',
    'an ambiguous duplicate id fails closed');

  const cleared = clone(debts);
  cleared[0].balance = 0;
  ok(ask(plan, cleared, 100, 'card').status === 'unavailable',
    'a cleared debt fails closed');

  ok(F.baselineTrajectoryScenario(null, debts, START, {
    amount: 100, debtId: 'card', nature: 'additional-debt-payment',
    periods: periodsFixture(),
  }).status === 'unavailable', 'a missing plan fails closed');
}

console.log('\n=== 7. HELOC is an eligible target; HELOC-as-funding is not ===');
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
    'an explicit HELOC extra is an eligible named-debt scenario');
  ok(F.baselineTrajectoryScenario(plan, debts, START, {
    amount: 50, debtId: 'heloc', nature: 'additional-debt-payment',
    periods: periodsFixture(), fundFrom: 'heloc',
  }).status === 'unavailable',
    'using HELOC as a funding source to pay debt fails closed');
}

console.log('\n=== 8. Planning / packet reprint stay out of scope ===');
{
  for (const file of [
    'scripts/assistant-packet.js',
    'scripts/assistant-mcp.js',
    'server.js',
  ]) {
    const src = read(file);
    ok(!/baselineTrajectoryScenario/.test(src),
      `${file} does not consume Forecast.baselineTrajectoryScenario`);
  }
}

console.log('\n=== 9. Architecture names the new Forecast owner ===');
{
  const architecture = read('ARCHITECTURE.md');
  ok(/Forecast\.baselineTrajectoryScenario/.test(architecture),
    'ARCHITECTURE.md names Forecast.baselineTrajectoryScenario');
  ok(/not `Forecast\.hypotheticalExtraPayment`/.test(architecture)
      && /not `Forecast\.counterfactuals`/.test(architecture),
    'the row distinguishes this from hypotheticalExtraPayment and counterfactuals');
  ok(/B105f/.test(read('BACKLOG.md')),
    'BACKLOG.md records B105f');
}

ok(hashFile(DATA) === liveHash, 'live data.json bytes unchanged at suite end');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
