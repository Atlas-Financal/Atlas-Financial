'use strict';
/* Forecast spending-basis regression for the secondary (month and pay-period)
 * trajectory. The Budget no longer renders a Month view, so the trajectory and
 * its funding walk are read here straight from Forecast.baselineTrajectory and
 * the Forecast funding chain, fed the same inputs the Budget page builds
 * (budgetMonthKnobOpts).
 * Synthetic ledger: $70/week is $10/day. October's closing windows
 * contain 22 walk days and $100 income: $100 - $220 = -$120.
 * The full Oct 9-22 cycle contains 14 days: $100 - $140 = -$40.
 * These expectations are hand arithmetic, not a second producer call.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast');
const AS_OF = '2026-10-01';
const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'public/plan.js'), 'utf8');
const dataBefore = fs.readFileSync(path.join(ROOT, 'data.json'));
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('  PASS  ' + name); };
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(n).toFixed(2);
const calls = [];
const forecast = Object.assign({}, F);
for (const name of ['simulate', 'fundingSequence', 'majorPlans', 'paydayAllocation']) {
  forecast[name] = (plan, asOf, opts) => {
    calls.push({ name, weekly: opts && opts.weeklyVariable });
    return F[name](plan, asOf, opts);
  };
}
const P = vm.createContext({ escapeHtml: require('./app-escape-html'), Forecast: forecast, money2,
  money: money2, fmtDate: s => s, fmtDateLong: s => s, fmtDateFull: s => s });
vm.runInContext(source, P);
const page = js => vm.runInContext(js, P);
function reset() {
  calls.length = 0;
  page(`state.weeklyVariable = null; state.scenario = null;
    state.targetBuffer = null; state.extraDebtMonthly = null;
    state.incomeOverrides = {}; state.disabled = []; state.debts = [];
    budgetMonthScheduleCache = null; budgetMonthScheduleCacheKey = null;`);
}
// The trajectory exactly as the Budget's inputs describe it, read from Forecast.
function traj(s) {
  return F.baselineTrajectory(s.plan, s.debts, s.asOf, P.budgetMonthKnobOpts(s));
}
// The planned-cost funding walk at the trajectory's own resolved spending
// basis, through the same Forecast chain the Budget uses for its funding
// schedule. Fails closed, never zero, when Forecast published no basis.
function secondarySchedule(s) {
  const t = traj(s);
  const spending = t && t.weeklyVariable;
  if (!t || t.status !== 'ready' || !spending
      || typeof spending.amount !== 'number' || !Number.isFinite(spending.amount)
      || spending.amount < 0
      || (spending.status !== 'calculated' && spending.status !== 'estimated')) {
    return { status: 'unavailable', paydays: [], costs: [], gap: null };
  }
  const opts = Object.assign({}, P.budgetMonthKnobOpts(s), {
    weeklyVariable: spending.amount, weeklyVariableBasis: spending });
  const horizon = forecast.knowledgeHorizon(s.plan, AS_OF, opts);
  const walk = horizon && horizon.days > 0
    ? Object.assign({}, opts, { horizonDays: horizon.days, viewDays: horizon.days }) : opts;
  const sim = forecast.simulate(s.plan, AS_OF, walk);
  const seq = forecast.fundingSequence(s.plan, AS_OF, opts);
  const plans = forecast.majorPlans(s.plan, AS_OF, opts);
  const alloc = forecast.paydayAllocation(s.plan, AS_OF, Object.assign({}, opts, { majorPlans: plans }));
  return forecast.planSpendPaydayFunding(s.plan, AS_OF, sim, seq, plans, alloc);
}
function fixture() {
  return {
    plan: {
      windowDays: 91,
      defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
      startingCash: { amount: 5000 }, opening: { asOf: AS_OF },
      income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 100, confidence: 'confirmed' }],
      obligations: [], bills: [], commitments: [],
      budget: { basis: 'ytd', categories: [{ id: 'groceries', label: 'Groceries',
        class: 'essential', from: ['Groceries'], plannedWeekly: 70 }] },
      nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    },
    debts: [], asOf: AS_OF, meta: { asOf: AS_OF },
    periods: { periods: { ytd: { months: 1, spending: [] } } },
    weekly: 0, weeklyOverride: null, advice: { weekly: 0, holds: false },
    liveOverlay: null, revolvingExtra: null,
  };
}
const october = t => t.months.find(m => m.month === '2026-10');
const fullCycle = t => t.payPeriods.find(p => p.start === '2026-10-09');
function confirmedFundingFixture(recentActuals = false) {
  const s = fixture();
  s.plan.commitments = [{ id: 'synthetic-dated-cost', label: 'Synthetic dated cost',
    date: '2026-10-16', amount: 50, confidence: 'confirmed' }];
  if (recentActuals) s.liveOverlay = { applied: true, currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: '2026-09-11', coverageThrough: AS_OF,
    pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [], transactions: [{
      id: 'synthetic-grocery', date: '2026-09-18', amount: 300,
      pending: false, accountRole: 'household-cash', categoryLabel: 'Groceries',
    }],
  } };
  return s;
}

check('failed implicit cap keeps planned household spending and both deficits', () => {
  reset();
  const s = fixture();
  const t = traj(s), m = october(t), p = fullCycle(t);
  assert.equal(t.status, 'ready');
  assert.equal(t.weeklyVariable.amount, 70);
  assert.equal(t.weeklyVariable.source, 'budgetBreakdown.planned');
  assert.equal(m.stage1.householdBudget.amount, 220);
  assert.equal(m.stage3.dateOrderResult.amount, -120);
  assert.equal(p.stage1.householdBudget.amount, 140);
  assert.equal(p.stage3.result.amount, -40);
});

check('the engine owns recommended-zero rejection; direct callers get the same basis', () => {
  const s = fixture();
  const t = F.baselineTrajectory(s.plan, [], AS_OF, { periods: s.periods,
    weeklyVariable: 0, weeklyVariableIsRecommendation: true, weeklyCapHolds: false });
  assert.equal(fullCycle(t).stage1.householdBudget.amount, 140);
  assert.equal(fullCycle(t).stage3.result.amount, -40);
});

check('a genuine failed Forecast cap cannot flip an earlier secondary month into surplus', () => {
  reset(); const s = fixture();
  s.plan.commitments = [{ id: 'future-cost', label: 'Synthetic future cost',
    date: '2026-12-15', amount: 100000, confidence: 'confirmed' }];
  const fundingSources = [{ id: 'empty-cash', label: 'Synthetic empty cash source',
    available: 0, rank: 1 }];
  s.advice = F.recommend(s.plan, AS_OF, { periods: s.periods, debts: [], fundingSources });
  assert.equal(s.advice.weekly, 0);
  assert.equal(s.advice.holds, false);
  assert.equal(october(traj(s)).stage3.dateOrderResult.amount, -120);
});

check('explicit owner zero stays a valid setting in both secondary granularities', () => {
  reset();
  const s = fixture(); s.weeklyOverride = 0;
  page('state.weeklyVariable = 0;');
  const t = traj(s), m = october(t), p = fullCycle(t);
  assert.equal(t.weeklyVariable.amount, 0);
  assert.equal(t.weeklyVariable.source, 'user-planning-setting');
  assert.equal(m.stage1.householdBudget.amount, 0);
  assert.equal(m.stage3.dateOrderResult.amount, 100);
  assert.equal(p.stage1.householdBudget.amount, 0);
  assert.equal(p.stage3.result.amount, 100);
});

check('a supported implicit zero and positive selected cap keep their incumbent behavior', () => {
  reset();
  const s = fixture(); s.advice.holds = true;
  assert.equal(traj(s).weeklyVariable.amount, 0);
  s.weekly = 20;
  assert.equal(traj(s).weeklyVariable.amount, 20);
});

check('missing cap validity cannot promote an implicit zero to a spending setting', () => {
  reset(); const s = fixture(); s.advice = null;
  assert.equal(traj(s).weeklyVariable.amount, 70);
});

check('failed, supported, and explicit zero with identical raw amounts publish distinct bases', () => {
  reset(); const s = fixture();
  const failed = traj(s);
  assert.equal(failed.weeklyVariable.amount, 70);
  assert.equal(failed.weeklyVariable.source, 'budgetBreakdown.planned');
  s.advice.holds = true;
  const supported = traj(s);
  assert.equal(supported.weeklyVariable.amount, 0);
  s.advice.holds = false; s.weeklyOverride = 0;
  const explicit = traj(s);
  assert.equal(explicit.weeklyVariable.amount, 0);
  assert.equal(explicit.weeklyVariable.source, 'user-planning-setting');
});

check('funding detail uses Forecast-resolved weekly spending for every incumbent call', () => {
  reset(); const s = fixture();
  const schedule = secondarySchedule(s);
  assert(schedule && schedule.status);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.weekly, 70, call.name);
  calls.length = 0;
  s.weeklyOverride = 0;
  secondarySchedule(s);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.weekly, 0, call.name);
});

check('covered recent actuals retain the provisional estimate and estimated trust', () => {
  reset(); const s = fixture();
  s.liveOverlay = { applied: true, currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: '2026-09-11', coverageThrough: AS_OF,
    pendingCoverage: 'complete', transactionCoverage: 'complete', representedActuals: [], transactions: [{
      id: 'synthetic-grocery', date: '2026-09-18', amount: 300,
      pending: false, accountRole: 'household-cash', categoryLabel: 'Groceries',
    }],
  } };
  // Completed $300 + current full-period reserve $140, divided by 2 = $220.
  const t = traj(s), p = fullCycle(t);
  assert.equal(t.weeklyVariable.amount, 110);
  assert.equal(t.weeklyVariable.source, 'provisional-recent-pay-period');
  assert.equal(p.stage1.householdBudget.amount, 220);
  assert.equal(p.stage1.householdBudget.status, 'estimated');
  assert.equal(p.stage3.result.amount, -120);
  secondarySchedule(s);
  for (const call of calls) assert.equal(call.weekly, 110, call.name);
});

check('estimated spending basis stays estimated in confirmed-cost funding projections', () => {
  reset(); const s = confirmedFundingFixture(true);
  const t = traj(s), schedule = secondarySchedule(s);
  assert.equal(t.weeklyVariable.amount, 110); // ($300 + $140) / 2 periods / 2 weeks
  assert.equal(t.weeklyVariable.status, 'estimated');
  assert.equal(schedule.status, 'ready');
  assert.equal(schedule.fundingTrust, 'estimated');
  assert.deepEqual(schedule.weeklyVariableBasis, {
    amount: 110, status: 'estimated', source: 'provisional-recent-pay-period',
  });
  const cost = schedule.costs.find(c => c.id === 'synthetic-dated-cost');
  assert.equal(cost.confidence, 'confirmed');
  assert.deepEqual(cost.nextContribution, { payday: '2026-10-09', amount: 50 });
  assert.equal(cost.projectedFullyFunded, '2026-10-09');
  const operating = P.budgetMonthPlanSpendSchedule(s);
  assert.equal(operating.fundingTrust, 'calculated', 'main cap does not inherit the secondary estimate');
  assert(!Object.hasOwn(operating, 'weeklyVariableBasis'));
});

check('planned calculated basis and explicit zero keep calculated funding trust', () => {
  for (const explicitZero of [false, true]) {
    reset(); const s = confirmedFundingFixture();
    if (explicitZero) s.weeklyOverride = 0;
    const t = traj(s), schedule = secondarySchedule(s);
    assert.equal(t.weeklyVariable.amount, explicitZero ? 0 : 70);
    assert.equal(t.weeklyVariable.status, 'calculated');
    assert.equal(schedule.fundingTrust, 'calculated');
    assert.equal(schedule.weeklyVariableBasis.amount, explicitZero ? 0 : 70);
    assert.equal(schedule.weeklyVariableBasis.source, explicitZero
      ? 'user-planning-setting' : 'budgetBreakdown.planned');
  }
});

check('unknown or mismatched spending-basis provenance fails funding closed', () => {
  const s = confirmedFundingFixture();
  for (const basis of [null,
    { amount: 70, source: 'synthetic-basis' },
    { amount: 70, status: 'unknown', source: 'synthetic-basis' },
    { amount: 110, status: 'estimated', source: 'synthetic-basis' }]) {
    const opts = { weeklyVariable: 70, weeklyVariableBasis: basis, horizonDays: 60, viewDays: 60 };
    const sim = F.simulate(s.plan, AS_OF, opts);
    assert.equal(sim.weeklyVariableBasis.status, 'unavailable');
    const schedule = F.planSpendPaydayFunding(s.plan, AS_OF, sim,
      F.fundingSequence(s.plan, AS_OF, opts), F.majorPlans(s.plan, AS_OF, opts));
    assert.equal(schedule.status, 'unavailable');
    assert.equal(schedule.fundingTrust, undefined);
    assert.equal(schedule.costs.length, 0);
  }
  reset(); const original = F.baselineTrajectory;
  F.baselineTrajectory = (...args) => {
    const t = original(...args);
    return Object.assign({}, t, { weeklyVariable: Object.assign({}, t.weeklyVariable, { status: 'unknown' }) });
  };
  try {
    const schedule = secondarySchedule(s);
    assert.equal(schedule.status, 'unavailable');
    assert.equal(calls.length, 0, 'unknown trust never starts a funding walk');
  } finally { F.baselineTrajectory = original; }
});

check('main operating funding retains its cap and cannot reuse the secondary cache', () => {
  reset(); const s = fixture();
  secondarySchedule(s);
  const count = calls.length;
  P.budgetMonthPlanSpendSchedule(s);
  assert.equal(calls.length, count + 4);
  for (const call of calls.slice(count)) assert.equal(call.weekly, 0, call.name);
  secondarySchedule(s);
  for (const call of calls.slice(count + 4)) assert.equal(call.weekly, 70, call.name);
});

check('missing spending basis fails trajectory and funding detail closed, never zero', () => {
  reset(); const s = fixture(); s.periods = null;
  const t = traj(s);
  assert.equal(t.status, 'unavailable');
  assert.equal(secondarySchedule(s).status, 'unavailable');
  assert.equal(calls.length, 0, 'no zero-spending funding walk');
});

check('main operating publication and financial inputs stay unchanged after secondary views', () => {
  reset(); const s = fixture();
  const before = JSON.stringify(s);
  // Real recommend signature, with the same ordinary controls as the main surface.
  const main = F.recommend(s.plan, AS_OF, { periods: s.periods, debts: [] });
  const publication = JSON.stringify(main.defaultView);
  traj(s); secondarySchedule(s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(JSON.stringify(F.recommend(s.plan, AS_OF, { periods: s.periods, debts: [] }).defaultView), publication);
  const current = main.defaultView.calendarPeriods[0];
  assert.equal(current.incomeTotal, 100);
  assert.equal(current.periodBillLoad, 0);
  assert.equal(current.budgetHold, 140);
  assert.equal(current.balanceAfterDeductions, -40);
  const ctx = Object.assign({}, s, { advice: main, planView: main.defaultView,
    planLook: 'this-period' });
  calls.length = 0;
  const html = P.operatingSurfaceHtml(ctx);
  assert(html.includes('data-current-payday-details'));
  for (const call of calls) assert.equal(call.weekly, 0, call.name);
});

assert(dataBefore.equals(fs.readFileSync(path.join(ROOT, 'data.json'))));
console.log(`\n${checks} secondary Budget spending-basis checks passed.`);
