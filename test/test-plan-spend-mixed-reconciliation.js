'use strict';
/* Plan Spend mixed-source current-payday reconciliation.
 *
 * Proves the repaired identity: on the current payday,
 *   planSpendPaydayFunding.paydays[current].contribution
 *     = Σ(paydayAllocation.futureCosts[].allocated)
 *     + paydayAllocation.protectedPath.allocated   [when calculated]
 *
 * Before the repair, a valid mixed-source payday (ordinary commitment in
 * futureCosts AND reserve-planning/yearly-bill protection in protectedPath)
 * returned status 'unavailable' because reconciliation compared the full
 * contribution only to the futureCosts portion.
 *
 * Deterministic fixtures only. No live household figures.
 */
const assert = require('assert');
const F = require('../public/forecast.js');

const cent = x => Math.round(Number(x) * 100);
let checks = 0;
function ok(value, label) { assert.ok(value, label); checks++; }

function basePlan(pay) {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf: '2026-01-16' }, // a Seaspan payday (anchor 2026-01-02 + 14d)
    startingCash: { breakdown: [{ id: 'chequing-a', value: 0 }, { id: 'chequing-b', value: 0 }] },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-01-02', amount: pay, confidence: 'confirmed' }],
    obligations: [], bills: [], budget: { categories: [] },
    commitments: [],
  };
}

function runFixture(plan) {
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 60, viewDays: 60, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf, {});
  const plans = F.majorPlans(plan, asOf, { weeklyVariable: 0 });
  const alloc = F.paydayAllocation(plan, asOf, {
    weeklyVariable: 0, majorPlans: plans,
    plannedDebt: F.plannedDebt(plan, asOf, { weeklyVariable: 0, majorPlans: plans }),
  });
  const sched = F.planSpendPaydayFunding(plan, asOf, sim, seq, plans, alloc);
  const live = sched.paydays.find(p => p.payday === asOf) || null;
  const fcTotal = alloc.futureCosts.reduce((s, r) => s + cent(r.allocated || 0), 0);
  const pathAmt = alloc.protectedPath && alloc.protectedPath.status === 'calculated'
    ? cent(alloc.protectedPath.allocated || 0) : 0;
  return { asOf, sched, live, alloc, fcTotal, pathAmt };
}

function namedSum(live) {
  return (live.allocations || []).reduce((s, a) => s + cent(a.amount), 0);
}

function namedFor(live, id) {
  const row = (live.allocations || []).find(a => a.id === id);
  return row ? cent(row.amount) : 0;
}

// --- Case A: ordinary commitment only -------------------------------------
// $150 due 2026-01-31, $100/payday. Backward induction requires $50 today.
{
  const plan = basePlan(100);
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-01-31',
    amount: 150, confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status === 'ready', 'A: schedule ready');
  ok(live && cent(live.contribution) === 5000, 'A: contribution $50', live && live.contribution);
  ok(fcTotal === 5000 && pathAmt === 0, 'A: all in futureCosts, none in path');
  ok(namedSum(live) === 5000, 'A: named allocations sum to contribution');
  ok(namedFor(live, 'trip') === 5000, 'A: trip named exactly $50');
}

// --- Case B: dated reserve-planning only ----------------------------------
// Property-tax-shaped: $150 planning date 2026-01-31, $100/payday.
{
  const plan = basePlan(100);
  plan.budget.categories = [{ id: 'propertytax', label: 'Property tax', class: 'reserve',
    plannedAmount: 150, planningDate: '2026-01-31', confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status === 'ready', 'B: schedule ready');
  ok(live && cent(live.contribution) === 5000, 'B: contribution $50', live && live.contribution);
  ok(fcTotal === 0 && pathAmt === 5000, 'B: all in protectedPath, none in futureCosts');
  ok(namedSum(live) === 5000, 'B: named allocations sum to contribution');
  ok(namedFor(live, 'propertytax') === 5000, 'B: propertytax named exactly $50');
}

// --- Case C: yearly card-paid bill only -----------------------------------
// Square-One-shaped: $150 yearly, due 2026-01-31, $100/payday.
{
  const plan = basePlan(100);
  plan.bills = [{ id: 'square-one', label: 'Square One', frequency: 'yearly',
    month: 1, day: 31, amount: 150, jointCash: false,
    firstDue: '2026-01-31', confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status === 'ready', 'C: schedule ready');
  ok(live && cent(live.contribution) === 5000, 'C: contribution $50', live && live.contribution);
  ok(fcTotal === 0 && pathAmt === 5000, 'C: all in protectedPath, none in futureCosts');
  ok(namedSum(live) === 5000, 'C: named allocations sum to contribution');
  ok(namedFor(live, 'square-one') === 5000, 'C: square-one named exactly $50');
}

// --- Case D: mixed ordinary + reserve -------------------------------------
// Trip $250 due 1/31 (needs $50 today; 1/30 covers $200) +
// property tax $150 due 1/20 (needs $150 today). $200/payday.
// This is the defect case: previously 'unavailable'.
{
  const plan = basePlan(200);
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-01-31',
    amount: 250, confidence: 'confirmed' }];
  plan.budget.categories = [{ id: 'propertytax', label: 'Property tax', class: 'reserve',
    plannedAmount: 150, planningDate: '2026-01-20', confidence: 'confirmed' }];
  const { sched, live, alloc, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status === 'ready', 'D: schedule ready (was unavailable before repair)');
  ok(live && cent(live.contribution) === 20000, 'D: contribution $200', live && live.contribution);
  ok(fcTotal === 5000, 'D: futureCosts $50 (trip)');
  ok(pathAmt === 15000, 'D: protectedPath $150');
  ok(cent(live.contribution) === fcTotal + pathAmt, 'D: identity contribution = futureCosts + path');
  ok(namedSum(live) === 20000, 'D: named allocations sum exactly to $200');
  ok(namedFor(live, 'trip') === 5000, 'D: trip named exactly $50 (incumbent preserved)');
  ok(namedFor(live, 'propertytax') === 15000, 'D: propertytax named exactly $150 (path remainder)');
  // No dollar twice: each cost id appears at most once in named allocations.
  const ids = (live.allocations || []).map(a => a.id);
  ok(new Set(ids).size === ids.length, 'D: no cost id attributed twice');
}

// --- Case E: mixed ordinary + yearly bill ---------------------------------
// Trip $100 due 1/31 + card-paid yearly bill $150 due 1/31. $100/payday.
// paydayAllocation: futureCosts $50 (trip) + protectedPath $50 (sq).
// The schedule reports a funding gap (total need exceeds total pay), but the
// live payday must still reconcile — not go 'unavailable'.
{
  const plan = basePlan(100);
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-01-31',
    amount: 100, confidence: 'confirmed' }];
  plan.bills = [{ id: 'sq', label: 'SQ', frequency: 'yearly',
    month: 1, day: 31, amount: 150, jointCash: false,
    firstDue: '2026-01-31', confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status !== 'unavailable', 'E: schedule reconciles (not unavailable)');
  ok(live, 'E: live payday row exists');
  ok(fcTotal === 5000, 'E: futureCosts $50 (trip)');
  ok(pathAmt === 5000, 'E: protectedPath $50 (yearly bill)');
  ok(cent(live.contribution) === fcTotal + pathAmt, 'E: identity contribution = futureCosts + path');
  ok(namedSum(live) === cent(live.contribution), 'E: named allocations sum exactly to contribution');
  ok(namedFor(live, 'trip') === 5000, 'E: trip named exactly $50 (incumbent preserved)');
  ok(namedFor(live, 'sq') === 5000, 'E: sq named exactly $50 (path remainder)');
  const ids = (live.allocations || []).map(a => a.id);
  ok(new Set(ids).size === ids.length, 'E: no cost id attributed twice');
}

// --- Case F: three-way mixed ----------------------------------------------
// Ordinary commitment + reserve planning + yearly bill.
// Verifies the repaired identity and attribution rules hold with three
// sources: incumbent futureCosts preserved, path remainder attributed to
// non-incumbent costs, named sum equals contribution, no duplication,
// no cost exceeds its base requirement.
{
  const plan = basePlan(150);
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-01-31',
    amount: 150, confidence: 'confirmed' }];
  plan.budget.categories = [{ id: 'ptax', label: 'PTax', class: 'reserve',
    plannedAmount: 100, planningDate: '2026-01-31', confidence: 'confirmed' }];
  plan.bills = [{ id: 'sq', label: 'SQ', frequency: 'yearly',
    month: 1, day: 31, amount: 100, jointCash: false,
    firstDue: '2026-01-31', confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(sched.status !== 'unavailable', 'F: schedule reconciles (not unavailable)');
  ok(live, 'F: live payday row exists');
  if (live) {
    ok(cent(live.contribution) === fcTotal + pathAmt,
      'F: identity contribution = futureCosts + path',
      `contrib=${live.contribution} fc=${fcTotal} path=${pathAmt}`);
    ok(namedSum(live) === cent(live.contribution), 'F: named allocations sum exactly to contribution');
    ok(namedFor(live, 'trip') === fcTotal, 'F: trip named exactly the incumbent futureCosts amount');
    const ids = (live.allocations || []).map(a => a.id);
    ok(new Set(ids).size === ids.length, 'F: no cost id attributed twice');
    for (const a of live.allocations) {
      const cost = sched.costs.find(c => c.id === a.id);
      ok(cost && cent(a.amount) <= cent(cost.baseRequirement),
        `F: ${a.id} does not exceed base requirement`);
    }
  }
}

// --- Case G: genuine mismatch stays unavailable ----------------------------
// Corrupt the incumbent: claim futureCosts protection the schedule cannot
// match. Fail closed — status must remain 'unavailable'.
{
  const plan = basePlan(100);
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-01-31',
    amount: 150, confidence: 'confirmed' }];
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 60, viewDays: 60, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf, {});
  const plans = F.majorPlans(plan, asOf, { weeklyVariable: 0 });
  const alloc = F.paydayAllocation(plan, asOf, {
    weeklyVariable: 0, majorPlans: plans,
    plannedDebt: F.plannedDebt(plan, asOf, { weeklyVariable: 0, majorPlans: plans }),
  });
  // Tamper: inflate the incumbent named allocation beyond what the
  // schedule's backward induction requires.
  const tampered = JSON.parse(JSON.stringify(alloc));
  tampered.futureCosts = tampered.futureCosts.map(r =>
    r.id === 'trip' ? Object.assign({}, r, { allocated: 99999 }) : r);
  const sched = F.planSpendPaydayFunding(plan, asOf, sim, seq, plans, tampered);
  ok(sched.status === 'unavailable', 'G: genuine mismatch stays unavailable (fail closed)');
}

// --- Case H: buffer-only protection + later commitment needing $0 today ----
// $50 target buffer; $150 commitment due 2026-03-31 fully coverable by future
// paydays, so the current schedule contribution is $0. The protectedPath
// ($100: buffer plus general protection) is NOT Plan Spend money. The
// schedule must stay valid (not 'unavailable') with empty allocations.
{
  const plan = basePlan(100);
  plan.defaults.targetBuffer = 50;
  plan.commitments = [{ id: 'trip', label: 'Trip', date: '2026-03-31',
    amount: 150, confidence: 'confirmed' }];
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 90, viewDays: 90, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf, {});
  const plans = F.majorPlans(plan, asOf, { weeklyVariable: 0 });
  const alloc = F.paydayAllocation(plan, asOf, {
    weeklyVariable: 0, majorPlans: plans,
    plannedDebt: F.plannedDebt(plan, asOf, { weeklyVariable: 0, majorPlans: plans }),
  });
  const sched = F.planSpendPaydayFunding(plan, asOf, sim, seq, plans, alloc);
  const live = sched.paydays.find(p => p.payday === asOf) || null;
  const pathAmt = alloc.protectedPath && alloc.protectedPath.status === 'calculated'
    ? cent(alloc.protectedPath.allocated || 0) : 0;
  ok(pathAmt > 0, 'H: protectedPath is positive (buffer/general protection)');
  ok(live && cent(live.contribution) === 0, 'H: contribution $0 (nothing needed today)');
  ok(sched.status !== 'unavailable', 'H: schedule stays valid, not unavailable');
  ok(namedSum(live) === 0, 'H: no Plan Spend dollars attributed from buffer protection');
}

// --- Case I: unrelated buffer protection + reserve cost needing $50 -------
// $30 target buffer (unrelated to Plan Spend) + $150 property-tax reserve
// needing $50 today. protectedPath = $80 ($30 buffer + $50 reserve). Only
// the $50 attributable portion may enter the Plan Spend identity; the $30
// buffer must not be attributed to the reserve cost.
{
  const plan = basePlan(100);
  plan.defaults.targetBuffer = 30;
  plan.startingCash = { breakdown: [{ id: 'chequing-a', value: 200 }, { id: 'chequing-b', value: 0 }] };
  plan.budget.categories = [{ id: 'propertytax', label: 'Property tax', class: 'reserve',
    plannedAmount: 150, planningDate: '2026-01-31', confidence: 'confirmed' }];
  const { sched, live, fcTotal, pathAmt } = runFixture(plan);
  ok(pathAmt === 8000, 'I: protectedPath $80 (buffer + reserve protection)');
  ok(fcTotal === 0, 'I: no futureCosts');
  ok(live && cent(live.contribution) === 5000, 'I: contribution $50');
  ok(sched.status === 'ready', 'I: schedule ready (not unavailable)');
  ok(namedSum(live) === 5000, 'I: named allocations sum to $50, not $80');
  ok(namedFor(live, 'propertytax') === 5000, 'I: only the $50 attributable portion named');
}

// --- Case J: unrelated pending-cash protection + later bill needing $0 -----
// $60 observed pending household debit (general cash protection held in the
// incumbent protectedPath) + $100 yearly bill due 2026-03-31 needing $0
// today. The pending debit must not be attributed to Plan Spend, and the
// schedule must stay valid. Required by the PR #436 repair spec (regression
// B): pending protection is never Plan Spend money merely because a
// schedulable cost exists.
{
  const plan = basePlan(200);
  plan.bills = [{ id: 'sq', label: 'SQ', frequency: 'yearly',
    month: 3, day: 31, amount: 100, jointCash: false,
    firstDue: '2026-03-31', confidence: 'confirmed' }];
  const actuals = { transactions: [
    { id: 'pend1', date: '2026-01-16', amount: 60, pending: true,
      accountRole: 'household-cash', description: 'Pending merchant debit' },
  ] };
  const asOf = plan.opening.asOf;
  const sim = F.simulate(plan, asOf, { horizonDays: 120, viewDays: 120, weeklyVariable: 0 });
  const seq = F.fundingSequence(plan, asOf, {});
  const plans = F.majorPlans(plan, asOf, { weeklyVariable: 0 });
  const alloc = F.paydayAllocation(plan, asOf, {
    weeklyVariable: 0, majorPlans: plans,
    plannedDebt: F.plannedDebt(plan, asOf, { weeklyVariable: 0, majorPlans: plans }),
    currentPeriodActuals: actuals,
  });
  const sched = F.planSpendPaydayFunding(plan, asOf, sim, seq, plans, alloc);
  const live = sched.paydays.find(p => p.payday === asOf) || null;
  const pathAmt = alloc.protectedPath && alloc.protectedPath.status === 'calculated'
    ? cent(alloc.protectedPath.allocated || 0) : 0;
  ok(pathAmt === 6000, 'J: incumbent path holds the $60 pending debit',
    alloc.protectedPath && alloc.protectedPath.allocated);
  ok(live && cent(live.contribution) === 0, 'J: live contribution $0', live && live.contribution);
  ok(sched.status !== 'unavailable', 'J: pending-cash path keeps schedule valid');
  ok(namedSum(live) === 0, 'J: pending cash not attributed to Plan Spend');
  ok(namedFor(live, 'sq') === 0, 'J: sq named $0 on the live payday');
}

console.log(`\nplan-spend mixed reconciliation: ${checks} checks passed`);
