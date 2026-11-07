'use strict';
/* One 2027 Dale payroll figure across the weekly cap, the Plan chart, the
 * Plan next-period view and the Budget timeline.
 *
 * Invented world only. The payroll stream is an invented 1,400 biweekly
 * cheque (anchor 2026-12-04, so paydays Dec 4, Dec 18, Jan 1, Jan 15 ...).
 * The 2027 estimate itself comes from Forecast's salary evidence, which is
 * a household fact, so this file never prints it: every 2027 check is an
 * equality between two paths, or a trust tag. The reference is the Budget
 * timeline row (payPeriodViews), a separate path from the cap walk.
 *
 * Hand facts used below, from the invented inputs alone:
 *   - 2026 Dale cheques stay 1,400 and confirmed.
 *   - an income override of 2,600 / month on a biweekly stream is
 *     2,600 × 12 / 26 = 1,200 per cheque.
 *
 * `node test/test-dale-2027-one-payroll-figure.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const STREAM = 1400;

function world(asOf, extra) {
  extra = extra || {};
  const plan = {
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    windowDays: 91,
    startingCash: { breakdown: [
      { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 3000, class: 'spendable' },
    ] },
    opening: Object.assign({ asOf }, extra.opening || {}),
    budget: { categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 100 },
    ] },
    obligations: [],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 5, amount: 900, confidence: 'confirmed',
        payingAccount: 'chequing-a' },
    ],
    // A large invented 2027 cost makes the weekly cap bind on 2027 cash,
    // so the cap answer depends on the 2027 payroll figure.
    commitments: [
      { id: 'roof', label: 'Invented roof', date: '2027-05-20', amount: 9000, confidence: 'confirmed' },
    ],
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-12-04', amount: STREAM, confidence: 'confirmed',
    }],
  };
  if (extra.assumptions !== false) {
    plan.payrollPlanningAssumptions = Object.assign(
      { salaryRaiseFactor: 1, bonusRate: 0, authorizedThroughYear: 2027 }, extra.assumptions || {});
  }
  return plan;
}

const isDale = e => e && e.kind === 'income' && (e.id === 'payroll' || e.id === 'payrollBonus');

// Budget timeline reference: id@date -> { amount, confidence } for 2027 rows.
function budgetRows(advice) {
  const rows = new Map();
  for (const view of advice.payPeriodViews || []) {
    for (const row of (view && view.income) || []) {
      if (!isDale(row) || !(row.date >= '2027-01-01')) continue;
      rows.set(row.id + '@' + row.date, { amount: row.amount, confidence: row.confidence });
    }
  }
  return rows;
}

function capWalkEvents(plan, asOf, advice) {
  const sim = F.simulate(plan, asOf, Object.assign({}, advice.simOptions, {
    weeklyVariable: advice.weekly,
    horizonDays: advice.knowledge.days, viewDays: advice.knowledge.days,
    viewStart: asOf,
  }));
  return (sim.events || []).filter(isDale);
}

function agreeWithBudget(events, ref, label) {
  const in2027 = events.filter(e => e.date >= '2027-01-01');
  const covered = in2027.filter(e => ref.has(e.id + '@' + e.date));
  ok(covered.length > 0, label + ': has 2027 Dale cheques on Budget dates');
  ok(covered.every(e => e.amount === ref.get(e.id + '@' + e.date).amount),
    label + ': every 2027 Dale cheque equals the Budget timeline row');
  ok(in2027.every(e => e.confidence === 'estimated'),
    label + ': every 2027 Dale cheque is tagged estimated');
  const in2026 = events.filter(e => e.date < '2027-01-01');
  ok(in2026.every(e => e.amount === STREAM && e.confidence === 'confirmed'),
    label + ': 2026 Dale cheques stay 1,400 confirmed (' + in2026.length + ')');
  return in2027;
}

function nextPeriodIncome(advice, date) {
  const view = advice.nextPeriodView;
  const found = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (o.kind === 'income' && o.id === 'payroll' && o.date === date) found.push(o);
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(view, 0);
  return found;
}

console.log('A. the brief repro: as-of 2026-12-24, next payday Jan 1 2027');
{
  const asOf = '2026-12-24';
  const plan = world(asOf);
  const advice = F.recommend(plan, asOf, { debts: [] });
  const ref = budgetRows(advice);
  const jan1 = ref.get('payroll@2027-01-01');
  ok(!!jan1 && jan1.confidence === 'estimated' && jan1.amount !== STREAM,
    'Budget Jan 1 2027 row is the estimate, not the plain stream, tagged estimated');
  agreeWithBudget(capWalkEvents(plan, asOf, advice), ref, 'weekly-cap walk');
  agreeWithBudget((advice.sim.events || []).filter(isDale), ref, 'Plan chart sim');
  const rows = nextPeriodIncome(advice, '2027-01-01');
  ok(advice.nextPeriodView && advice.nextPeriodView.periodStart === '2027-01-01',
    'next-period view opens on Jan 1 2027');
  ok(rows.length > 0 && rows.every(r => r.planned === jan1.amount && r.confidence === 'estimated'),
    'next-period Jan 1 cheque equals the Budget row and is tagged estimated');

  // Cap oracle: the same world with no regime, and a hand-written caller
  // adjustment that writes the Budget's own 2027 rows into the walk. Equal
  // caps mean the cap reads exactly the Budget figure.
  const bare = world(asOf, { assumptions: false });
  const oracle = F.recommend(bare, asOf, { debts: [],
    incomeOccurrenceAdjust: (stream, date) => {
      if (stream.id !== 'payroll' || date < '2027-01-01') return null;
      const row = ref.get('payroll@' + date);
      return row ? { amount: row.amount, confidence: 'estimated' } : { omit: true };
    } });
  ok(oracle.weekly === advice.weekly, 'weekly cap equals the cap of a walk fed the Budget rows by hand');
  const plain = F.recommend(bare, asOf, { debts: [] });
  ok(plain.weekly !== advice.weekly,
    'the cap answer depends on the 2027 figure in this world (plain stream gives a different cap)');
}

console.log('B. as-of 2026-12-10: 2026 paydays in view stay incumbent');
{
  const asOf = '2026-12-10';
  const plan = world(asOf);
  const advice = F.recommend(plan, asOf, { debts: [] });
  const ref = budgetRows(advice);
  const walk = capWalkEvents(plan, asOf, advice);
  ok(walk.some(e => e.date === '2026-12-18'), 'the Dec 18 2026 cheque is in the walk');
  agreeWithBudget(walk, ref, 'weekly-cap walk');
  const rows = nextPeriodIncome(advice, '2026-12-18');
  ok(rows.length > 0 && rows.every(r => r.planned === STREAM && r.confidence === 'confirmed'),
    'next-period Dec 18 2026 cheque stays 1,400 confirmed');
  // 2026 is unchanged: identical to the same world with no 2027 regime.
  const bare = F.recommend(world(asOf, { assumptions: false }), asOf, { debts: [] });
  const bareRows = nextPeriodIncome(bare, '2026-12-18');
  ok(JSON.stringify(bareRows) === JSON.stringify(rows),
    'next-period 2026 view is identical with and without the 2027 regime');
}

console.log('C. no regime: the incumbent stream stays as it was');
{
  const asOf = '2026-12-24';
  const plan = world(asOf, { assumptions: false });
  const advice = F.recommend(plan, asOf, { debts: [] });
  const events = capWalkEvents(plan, asOf, advice);
  ok(events.length > 0 && events.every(e => e.amount === STREAM && e.confidence === 'confirmed'),
    'without payroll planning assumptions every cheque stays 1,400 as declared');
}

console.log('D. household income override keeps its what-if amount, tagged estimated in 2027');
{
  const asOf = '2026-12-24';
  const plan = world(asOf);
  const advice = F.recommend(plan, asOf, { debts: [], incomeOverrides: { payroll: 2600 } });
  const events = capWalkEvents(plan, asOf, advice);
  const in2027 = events.filter(e => e.date >= '2027-01-01');
  ok(in2027.length > 0 && in2027.every(e => e.amount === 1200 && e.confidence === 'estimated'),
    '2027 cheques under a 2,600/month override are 1,200 and estimated');
}

console.log('E. a calculator bonus with no plan bonus stream enters the walk once, as the Budget row');
{
  const asOf = '2026-12-24';
  const plan = world(asOf, { assumptions: { bonusRate: 0.1 } });
  const advice = F.recommend(plan, asOf, { debts: [] });
  const ref = budgetRows(advice);
  const bonusKeys = Array.from(ref.keys()).filter(k => k.startsWith('payrollBonus@'));
  ok(bonusKeys.length === 1, 'the Budget timeline publishes one 2027 bonus row');
  const events = capWalkEvents(plan, asOf, advice);
  const bonus = events.filter(e => e.id === 'payrollBonus');
  ok(bonus.length === 1 && bonusKeys.length === 1
      && bonus[0].id + '@' + bonus[0].date === bonusKeys[0]
      && bonus[0].amount === ref.get(bonusKeys[0]).amount
      && bonus[0].confidence === 'estimated',
    'the walk carries that bonus once, same date and amount, estimated');
  agreeWithBudget(events, ref, 'weekly-cap walk with bonus');
}

console.log('G. the advice stays structured-cloneable for the live-read cache');
{
  const asOf = '2026-12-24';
  const plan = world(asOf, { assumptions: { bonusRate: 0.1 } });
  const advice = F.recommend(plan, asOf, { debts: [] });
  let cloned = null;
  try { cloned = structuredClone(advice); } catch (error) { cloned = null; }
  ok(cloned !== null, 'structuredClone(advice) succeeds with a ready 2027 regime');
  // A page re-simulation from the cloned simOptions still reads the estimate.
  const fromClone = cloned ? capWalkEvents(plan, asOf, cloned) : [];
  const fromLive = capWalkEvents(plan, asOf, advice);
  ok(fromClone.length > 0 && JSON.stringify(fromClone) === JSON.stringify(fromLive),
    're-simulating from the cloned simOptions gives the same Dale cheques');
}

console.log('I. one live read with a ready 2027 regime asks Forecast once (cache hit)');
{
  const OA = require('../scripts/operating-answer');
  const Fixture = require('./fixtures/budget-surface-data');
  const original = F.recommend;
  let calls = 0;
  F.recommend = function () { calls++; return original.apply(this, arguments); };
  try {
    const data = Fixture.canonical();
    data.meta.asOf = '2026-08-20';
    data.plan.opening.asOf = '2026-08-20';
    data.plan.payrollPlanningAssumptions = { salaryRaiseFactor: 1, bonusRate: 0.1, authorizedThroughYear: 2027 };
    data.liveOverlay = { applied: true, effectiveAsOf: '2026-08-20', operatingPlan: 'live',
      currentPeriodActuals: { observationAsOf: '2026-08-20', transactions: [] },
      observedCash: { asOf: '2026-08-20', accounts: [] } };
    const evaluation = OA.createRefreshEvaluation();
    evaluation.fromRefreshedState(data);
    evaluation.fromRefreshedState(structuredClone(data));
  } finally {
    F.recommend = original;
  }
  ok(calls === 1, 'two identical evaluations run Forecast.recommend once (' + calls + ')');
}

console.log('H. a "payroll stops" what-if (override 0) carries no estimated bonus');
{
  const asOf = '2026-12-24';
  const plan = world(asOf, { assumptions: { bonusRate: 0.1 } });
  const advice = F.recommend(plan, asOf, { debts: [], incomeOverrides: { payroll: 0 } });
  const events = capWalkEvents(plan, asOf, advice);
  ok(!events.some(e => e.date >= '2027-01-01'),
    'no 2027 Dale income at all under a zero payroll override');
  // A later re-simulation reads its own override, not the original call's.
  const base = F.recommend(plan, asOf, { debts: [] });
  const sim = F.simulate(plan, asOf, Object.assign({}, base.simOptions, {
    weeklyVariable: base.weekly, horizonDays: base.knowledge.days, viewDays: base.knowledge.days,
    viewStart: asOf, incomeOverrides: { payroll: 2600 } }));
  const later = (sim.events || []).filter(isDale).filter(e => e.date >= '2027-01-01');
  ok(later.length > 0 && later.every(e => e.id === 'payroll' && e.amount === 1200 && e.confidence === 'estimated'),
    'a re-simulation with a 2,600/month override reads 1,200 estimated and no bonus');
}

console.log('J. caller-supplied 2027 payroll extras are reconciled once, as the Budget rows are');
{
  const asOf = '2026-12-24';
  const plan = world(asOf, { assumptions: { bonusRate: 0.1 } });
  const bonusDate = Array.from(budgetRows(F.recommend(plan, asOf, { debts: [] })).keys())
    .filter(k => k.startsWith('payrollBonus@')).map(k => k.split('@')[1])[0];
  const supplied = { kind: 'income', id: 'payrollBonus', label: 'Invented bonus', date: bonusDate,
    amount: 100, confidence: 'estimated' };
  const other = { kind: 'income', id: 'invented-gift', label: 'Invented gift', date: '2027-03-03',
    amount: 250, confidence: 'estimated' };
  const advice = F.recommend(plan, asOf, { debts: [],
    additionalIncomeEvents: [supplied, { ...supplied }, other] });
  const ref = budgetRows(advice);
  const events = (F.simulate(plan, asOf, Object.assign({}, advice.simOptions, {
    weeklyVariable: advice.weekly, horizonDays: advice.knowledge.days,
    viewDays: advice.knowledge.days, viewStart: asOf })).events || []);
  const bonus = events.filter(e => e.id === 'payrollBonus');
  const row = ref.get('payrollBonus@' + bonusDate);
  ok(!!bonusDate && bonus.length === 1 && !!row && bonus[0].amount === row.amount
      && bonus[0].amount !== 100 && bonus[0].confidence === 'estimated',
    'a bonus supplied twice at an invented 100 walks once, at the Budget row amount, estimated');
  const gift = events.filter(e => e.id === 'invented-gift');
  ok(gift.length === 1 && gift[0].amount === 250, 'an unrelated supplied extra passes through unchanged');
}

console.log('F. a represented 2027 cheque keeps its incumbent event (evidence wins)');
{
  const asOf = '2027-01-01';
  const plan = world(asOf, { opening: { representedEvents: [{ id: 'payroll', date: '2027-01-01' }] } });
  const advice = F.recommend(plan, asOf, { debts: [] });
  const events = capWalkEvents(plan, asOf, advice);
  ok(!events.some(e => e.date === '2027-01-01'),
    'the received Jan 1 cheque is not walked again as an estimate');
  agreeWithBudget(events, budgetRows(advice), 'weekly-cap walk after Jan 1 evidence');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
