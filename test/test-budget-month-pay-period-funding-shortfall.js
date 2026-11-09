// AMANDA SLICE 12 — SELECTED PAY-PERIOD FUNDING SHORTFALL DETAIL.
//
// Deterministic proof (27 checks) that the pay-period drilldown renders
// Forecast's planSpendPaydayFunding gap publication for the EXACT
// selected payday only: shortBy and cashDate are exact reprints, affected
// IDs resolve through the same schedule publication's costs[] in
// gap.affected[] order, and every malformed or untrusted publication
// state fails closed visibly. The page never derives the shortfall from
// required - available, never totals affected costs, and uses neutral
// attribution language only. Slice 9/10/11 surfaces are unchanged.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..');
const planPath = path.join(repoRoot, 'public', 'plan.js');
const forecastPath = path.join(repoRoot, 'public', 'forecast.js');

const planSource = fs.readFileSync(planPath, 'utf8');

// Comfortable fixture: ready funding schedule, no engine gap (doctored
// gaps are applied on top). Reuses the Slice 11 comfortable inputs.
function comfortablePlan(asOf) {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 400 },
    opening: { asOf },
    startingCash: { amount: 10000 },
    income: [
      { id: 'payroll', label: 'Seaspan', frequency: 'biweekly', anchor: '2026-09-25',
        amount: 2600, confidence: 'confirmed' },
    ],
    obligations: [
      { id: 'visa-min', label: 'Travel Visa minimum', amount: 150, frequency: 'monthly',
        day: 15, confidence: 'confirmed', debtId: 'travel-visa' },
    ],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 1, amount: 1200, confidence: 'confirmed' },
      { id: 'power', label: 'BC Hydro', frequency: 'monthly', day: 20, amount: 90, confidence: 'estimated' },
    ],
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
      ],
    },
    commitments: [
      { id: 'fusion', label: 'Fusion tournament', amount: 900, date: '2026-10-15', confidence: 'confirmed' },
      { id: 'proptax', label: 'Property tax contribution', amount: 500, date: '2026-10-18', confidence: 'confirmed' },
    ],
  };
}

// Tight fixture: the real Forecast engine publishes a genuine funding-gap
// on the 2026-09-25 payday (shortBy $3,160.00, cashDate 2026-10-12,
// affected [sandiego, fusion], trust calculated).
function tightPlan(asOf) {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 400 },
    opening: { asOf },
    startingCash: { amount: 500 },
    income: [
      { id: 'payroll', label: 'Seaspan', frequency: 'biweekly', anchor: '2026-09-25',
        amount: 900, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [],
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
      ],
    },
    commitments: [
      { id: 'sandiego', label: 'San Diego', amount: 4000, date: '2026-10-12', confidence: 'confirmed' },
      { id: 'fusion', label: 'Fusion tournament', amount: 900, date: '2026-10-15', confidence: 'confirmed' },
    ],
  };
}

function engineGap(plan, weekly) {
  const Forecast = require(forecastPath);
  const knob = { weeklyVariable: weekly };
  const asOf = plan.opening.asOf;
  const horizon = Forecast.knowledgeHorizon(plan, asOf, knob);
  const walkOpts = horizon && horizon.days > 0
    ? Object.assign({}, knob, { horizonDays: horizon.days, viewDays: horizon.days }) : knob;
  const sim = Forecast.simulate(plan, asOf, walkOpts);
  const seq = Forecast.fundingSequence(plan, asOf, knob);
  const plans = Forecast.majorPlans(plan, asOf, knob);
  const alloc = Forecast.paydayAllocation(plan, asOf, Object.assign({}, knob, { majorPlans: plans }));
  return Forecast.planSpendPaydayFunding(plan, asOf, sim, seq, plans, alloc);
}

function makeContext() {
  const Forecast = require(forecastPath);
  const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
    Forecast,
    money2: n => '$' + Number(n).toFixed(2),
    fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA', { day: 'numeric', month: 'long' }),
  });
  const run = js => vm.runInContext(js, context);
  run(planSource);
  const P = {};
  for (const name of [
    'budgetMonthViewHtml', 'budgetPayPeriodDrilldownHtml', 'budgetMonthPlanSpendSchedule',
    'budgetPayPeriodFundingShortfallHtml',
  ]) {
    P[name] = vm.runInContext(name, context);
  }
  P.__run = run;
  P.__ctx = context;
  return P;
}

function enterDrilldown(P, src, month) {
  P.__run(`budgetGranularity='month'; budgetSelectedMonth='${month}';`
    + ` budgetPayPeriodAnchorMonth=null; budgetDrilldownPayPeriod=null;`
    + ` budgetTrajectoryCache=null; budgetTrajectoryCacheKey=null;`
    + ` budgetMonthScheduleCache=null; budgetMonthScheduleCacheKey=null;`);
  P.budgetMonthViewHtml(src);
  P.__run(`budgetPayPeriodAnchorMonth=budgetSelectedMonth; budgetGranularity='pay-period';`);
}

function selectPayPeriod(P, payday) {
  P.__run(`budgetDrilldownPayPeriod=${JSON.stringify(payday)};`);
  return P.budgetPayPeriodDrilldownHtml(globalThis.__slice12src);
}

function resetSlice12State(P) {
  if (P.__ctx.__slice12SavedScheduleFn) {
    vm.runInContext('budgetMonthPlanSpendSchedule = __slice12SavedScheduleFn;', P.__ctx);
    delete P.__ctx.__slice12SavedScheduleFn;
    delete P.__ctx.__slice12Doctored;
  }
  P.__run(`budgetGranularity='month'; budgetSelectedMonth=null; budgetPayPeriodAnchorMonth=null;`
    + ` budgetDrilldownPayPeriod=null;`
    + ` budgetTrajectoryCache=null; budgetTrajectoryCacheKey=null;`
    + ` budgetMonthScheduleCache=null; budgetMonthScheduleCacheKey=null;`);
}

// Doctor the schedule the shortfall renderer consumes: same incumbent
// helper, same active inputs, gap/status/trust overridden. Returns the
// doctored schedule for expectation building.
function withDoctoredGap(P, src, mutate) {
  const real = P.budgetMonthPlanSpendSchedule(src);
  assert.ok(real, 'incumbent helper publishes a schedule to doctor');
  const doctored = JSON.parse(JSON.stringify(real));
  mutate(doctored);
  P.__ctx.__slice12Doctored = doctored;
  vm.runInContext('__slice12SavedScheduleFn = budgetMonthPlanSpendSchedule;', P.__ctx);
  vm.runInContext('budgetMonthPlanSpendSchedule = function () { return __slice12Doctored; };', P.__ctx);
  return doctored;
}

function shortfallBlock(html) {
  const start = html.indexOf('data-budget-drilldown-funding-shortfall=');
  assert.ok(start !== -1, 'expected a funding-shortfall block in the drilldown');
  return html.slice(Math.max(0, start - 400), start + 2600);
}

function fundingBlock(html) {
  const start = html.indexOf('data-budget-drilldown-funding-plan=');
  assert.ok(start !== -1, 'expected a Slice 11 funding-plan block in the drilldown');
  return html.slice(Math.max(0, start - 400), start + 2600);
}

const money = n => '$' + Number(n).toFixed(2);

const T = [];
function proof(name, fn) { T.push([name, fn]); }

// P1 — Exact selected-payday gap match renders (real engine publication).
proof('P1 exact selected-payday gap renders from the real engine', () => {
  const P = makeContext();
  const plan = tightPlan('2026-09-25');
  const src = { plan, debts: [], asOf: '2026-09-25', weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  const sched = engineGap(plan, 140);
  const gap = sched.gap;
  assert.equal(sched.status, 'funding-gap', 'fixture must publish a real funding gap');
  enterDrilldown(P, src, '2026-09');
  const html = selectPayPeriod(P, gap.payday);
  const block = shortfallBlock(html);
  assert.ok(block.includes(`data-budget-drilldown-funding-shortfall="${gap.payday}"`),
    'shortfall block carries the exact selected payday');
  assert.ok(block.includes(money(gap.shortBy)), 'real published shortBy reprinted');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P2 — shortBy is an exact Forecast reprint.
proof('P2 shortBy is an exact Forecast reprint', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  const doctored = withDoctoredGap(P, src, sched => {
    const ids = sched.costs.map(c => c.id);
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: ids, cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(block.includes(money(doctored.gap.shortBy)), 'published $750.00 shown');
  assert.ok(!block.includes('$1,000.00') || block.includes('Forecast available'),
    'shortBy is not confused with the available line');
  const shortByLine = block.slice(block.indexOf('Short by'), block.indexOf('Short by') + 120);
  assert.ok(shortByLine.includes(money(750)), 'Short-by line shows exactly $750.00');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P3 — cashDate is an exact Forecast reprint.
proof('P3 cashDate is an exact Forecast reprint', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  const neededByLine = block.slice(block.indexOf('Needed by'), block.indexOf('Needed by') + 140);
  assert.ok(neededByLine.includes('January 8'), 'published cashDate reprinted as January 8');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P3a — impossible cashDate fails the Needed by line closed, shortfall kept.
proof('P3a impossible cashDate fails the Needed by line closed', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-99-99' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(block.includes('Short by'), 'shortfall amount still renders');
  assert.ok(block.includes(money(750)), 'published $750.00 still shown');
  const neededByLine = block.slice(block.indexOf('Needed by'), block.indexOf('Needed by') + 140);
  assert.ok(neededByLine.includes('unavailable'), 'Needed by line fails closed');
  assert.ok(!block.includes('Invalid Date'), 'no trusted Invalid Date renders');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P3b — cashDate with trailing junk fails the Needed by line closed.
proof('P3b cashDate trailing junk fails the Needed by line closed', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08junk' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(block.includes(money(750)), 'published $750.00 still shown');
  const neededByLine = block.slice(block.indexOf('Needed by'), block.indexOf('Needed by') + 140);
  assert.ok(neededByLine.includes('unavailable'), 'Needed by line fails closed');
  assert.ok(!block.includes('Invalid Date'), 'no trusted Invalid Date renders');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P3c — a valid exact ISO calendar date renders; nothing is substituted.
proof('P3c valid cashDate renders exactly, never substituted', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  const neededByLine = block.slice(block.indexOf('Needed by'), block.indexOf('Needed by') + 140);
  assert.ok(neededByLine.includes('January 8'), 'published date rendered exactly');
  assert.ok(!neededByLine.includes('unavailable'), 'valid date is not treated as unavailable');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P4 — Affected IDs resolve through the same schedule.costs[] publication.
proof('P4 affected IDs resolve through the same schedule costs publication', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  const doctored = withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  for (const cost of doctored.costs) {
    assert.ok(block.includes(cost.label), `affected label shown: ${cost.label}`);
  }
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P5 — Affected-cost order remains Forecast gap.affected[] order.
proof('P5 affected order follows gap.affected[] order', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  const doctored = withDoctoredGap(P, src, sched => {
    const ids = sched.costs.map(c => c.id).reverse();
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: ids, cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  const labelById = new Map(doctored.costs.map(c => [c.id, c.label]));
  const expected = doctored.gap.affected.map(id => labelById.get(id));
  let cursor = 0;
  for (const label of expected) {
    const at = block.indexOf(label, cursor);
    assert.ok(at !== -1, `label in order: ${label}`);
    cursor = at + label.length;
  }
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P6 — A gap on another payday does NOT render as the selected payday's shortfall.
proof('P6 gap on another payday does not render', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-23', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-10-09');
  assert.ok(!html.includes('data-budget-drilldown-funding-shortfall'),
    'no shortfall block when the gap belongs to another payday');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P7 — No nearest-payday fallback, before or after.
proof('P7 no nearest-payday fallback', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-23', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  for (const payday of ['2026-10-09', '2026-11-06']) {
    const html = selectPayPeriod(P, payday);
    assert.ok(!html.includes('data-budget-drilldown-funding-shortfall'),
      `no shortfall block for ${payday} when the gap is on 2026-10-23`);
  }
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P8 — Residual selected period does not borrow a future gap.
proof('P8 residual period does not borrow a future gap', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-28'), debts: [], asOf: '2026-09-28',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-09-25');
  assert.ok(!html.includes('data-budget-drilldown-funding-shortfall'),
    'residual Sep 25 row borrows no future gap');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P9 — gap.payday === null does not attach to a visible payday.
proof('P9 pre-opening gap never attaches to a visible payday', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: null, required: 900, available: 0, shortBy: 900,
      affected: sched.costs.map(c => c.id), cashDate: '2026-09-10' };
  });
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-10-09');
  assert.ok(!html.includes('data-budget-drilldown-funding-shortfall'),
    'pre-opening gap (payday null) attaches to no visible payday');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P10 — The page never derives shortBy from required - available.
proof('P10 no page-side derivation of shortBy', () => {
  const fnSrc = planSource.slice(
    planSource.indexOf('function budgetPayPeriodFundingShortfallHtml'),
    planSource.indexOf('function budgetPayPeriodDrilldownHtml'));
  assert.ok(fnSrc.includes('gap.shortBy'), 'shortBy is reprinted from the gap publication');
  // Strip comments: the arithmetic check must apply to code, not prose.
  const code = fnSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\brequired\b\s*-\s*\bavailable\b/.test(code),
    'renderer never computes required - available');
  assert.ok(!/shortBy\s*=\s*[^;]*required[^;]*available/.test(code),
    'renderer never assigns shortBy from required/available');
});

// P11 — Deliberately non-reconciling fixture: page shows $750, not $1,000.
proof('P11 non-reconciling fixture keeps Forecast shortBy', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  const shortByLine = block.slice(block.indexOf('Short by'), block.indexOf('Short by') + 140);
  assert.ok(shortByLine.includes('$750.00'), 'Short-by line shows Forecast $750.00');
  assert.ok(!shortByLine.includes('$1,000.00'), 'Short-by line never shows required - available');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P12 — Estimated fundingTrust remains estimated.
proof('P12 estimated trust remains estimated', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.fundingTrust = 'estimated';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(block.includes('trust-estimated'), 'estimated tag carried on the shortfall figures');
  assert.ok(!block.includes('>calculated<'), 'no calculated tag on the shortfall figures');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P13 — Unknown/unrecognized trust fails closed visibly.
proof('P13 unrecognized trust fails closed', () => {
  for (const bad of ['mystery', null, undefined, 42]) {
    const P = makeContext();
    const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
      weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
    globalThis.__slice12src = src;
    withDoctoredGap(P, src, sched => {
      sched.status = 'funding-gap';
      sched.fundingTrust = bad;
      sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
        affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
    });
    enterDrilldown(P, src, '2026-10');
    const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
    assert.ok(block.includes('data-budget-drilldown-funding-shortfall="unavailable"'),
      `trust ${String(bad)} fails closed visibly`);
    assert.ok(block.includes('This is not $0'), 'fail-closed note names the unknown boundary');
    assert.ok(!block.includes('Short by</span><span>$750.00'),
      'no shortfall figure renders without recognized trust');
    resetSlice12State(P);
    delete globalThis.__slice12src;
  }
});

// P14 — Malformed shortBy values fail closed: false, "", null, numeric string, NaN, Infinity.
proof('P14 malformed shortBy fails closed', () => {
  for (const bad of [false, '', null, '750', NaN, Infinity, -Infinity, undefined, {}, []]) {
    const P = makeContext();
    const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
      weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
    globalThis.__slice12src = src;
    withDoctoredGap(P, src, sched => {
      sched.status = 'funding-gap';
      sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: bad,
        affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
    });
    enterDrilldown(P, src, '2026-10');
    const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
    assert.ok(block.includes('data-budget-drilldown-funding-shortfall="unavailable"'),
      `shortBy ${String(bad)} fails closed visibly`);
    assert.ok(!block.includes('Short by</span><span>$'), 'no shortfall figure renders from malformed shortBy');
    resetSlice12State(P);
    delete globalThis.__slice12src;
  }
});

// P15 — Malformed/missing affected collection does not silently become "no affected costs".
proof('P15 malformed affected collection fails the detail closed', () => {
  for (const bad of [null, 'fusion', 42, {}, undefined]) {
    const P = makeContext();
    const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
      weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
    globalThis.__slice12src = src;
    withDoctoredGap(P, src, sched => {
      sched.status = 'funding-gap';
      sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
        affected: bad, cashDate: '2027-01-08' };
    });
    enterDrilldown(P, src, '2026-10');
    const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
    assert.ok(block.includes('Affected planned costs'), 'affected section still named');
    assert.ok(block.includes('unavailable — Forecast did not publish this detail in a usable form.'),
      `affected ${String(bad)} fails the detail closed visibly`);
    assert.ok(!block.includes('none named in this Forecast publication'),
      'malformed collection never becomes "no affected costs"');
    resetSlice12State(P);
    delete globalThis.__slice12src;
  }
});

// P16 — Unresolved affected ID fails the detail closed rather than disappearing.
proof('P16 unresolved affected ID fails the detail closed', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: [sched.costs[0].id, 'not-a-real-cost'], cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(block.includes('unavailable — Forecast did not publish this detail in a usable form.'),
    'unknown affected ID fails the affected detail closed visibly');
  assert.ok(!block.includes('class="affected-cost"'),
    'no partial affected list renders that could look complete');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P17 — Malformed cost label fails closed visibly.
proof('P17 malformed cost label fails closed', () => {
  for (const bad of ['', 42, null]) {
    const P = makeContext();
    const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
      weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
    globalThis.__slice12src = src;
    withDoctoredGap(P, src, sched => {
      sched.status = 'funding-gap';
      sched.costs = sched.costs.map(c => ({ ...c, label: bad }));
      sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
        affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
    });
    enterDrilldown(P, src, '2026-10');
    const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
    assert.ok(block.includes('unavailable — Forecast did not publish this detail in a usable form.'),
      `label ${String(bad)} fails the affected detail closed visibly`);
    resetSlice12State(P);
    delete globalThis.__slice12src;
  }
});

// P18 — No affected-cost total is calculated.
proof('P18 no affected-cost total is calculated', () => {
  const src = planSource.slice(
    planSource.indexOf('function budgetPayPeriodFundingShortfallHtml'),
    planSource.indexOf('function budgetPayPeriodDrilldownHtml'));
  assert.ok(!src.includes('reduce('), 'renderer never reduces over affected costs');
  const P = makeContext();
  const source = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = source;
  withDoctoredGap(P, source, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, source, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09'));
  assert.ok(!/total/i.test(block), 'rendered block contains no total');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P19 — No causal language; the shortfall is never equated to other deficits.
proof('P19 no causal or conflating language', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09')).toLowerCase();
  for (const phrase of ['caused the shortfall', 'is the problem', 'making this payday negative',
      'stage 3', 'monthly deficit', 'bank balance', 'household deficit']) {
    assert.ok(!block.includes(phrase), `no conflating/causal phrase: "${phrase}"`);
  }
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P20 — No recommendation / defer / borrow / cancel language.
proof('P20 no prescriptive language', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const block = shortfallBlock(selectPayPeriod(P, '2026-10-09')).toLowerCase();
  for (const phrase of ['cut this', 'delay this', 'put this on the card', 'borrow',
      'you cannot afford', 'cancel']) {
    assert.ok(!block.includes(phrase), `no prescriptive phrase: "${phrase}"`);
  }
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P21 — Slice 11 funding contribution and allocations remain unchanged.
proof('P21 Slice 11 funding plan unchanged', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  withDoctoredGap(P, src, sched => {
    sched.status = 'funding-gap';
    sched.gap = { payday: '2026-10-09', required: 2000, available: 1000, shortBy: 750,
      affected: sched.costs.map(c => c.id), cashDate: '2027-01-08' };
  });
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-10-09');
  const funding = fundingBlock(html);
  assert.ok(funding.includes('data-budget-drilldown-funding-plan="2026-10-09"'),
    'Slice 11 funding plan still keyed to the selected payday');
  assert.ok(funding.includes(money(1400)), 'published contribution unchanged');
  assert.ok(funding.includes('Fusion tournament'), 'named allocations unchanged');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P22 — Slice 10 money map remains unchanged.
proof('P22 Slice 10 money map unchanged', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-10-09');
  assert.ok(html.includes('data-budget-drilldown-money-map="2026-10-09"'),
    'Slice 10 money map still keyed to the selected payday');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P23 — Slice 9 selected-window identity/navigation remains unchanged.
proof('P23 Slice 9 identity and navigation unchanged', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  globalThis.__slice12src = src;
  enterDrilldown(P, src, '2026-10');
  const html = selectPayPeriod(P, '2026-10-09');
  assert.ok(html.includes('data-budget-drilldown="2026-10"'), 'drilldown still anchored to 2026-10');
  assert.ok(html.includes('data-budget-drilldown-period="2026-10-09"'),
    'selected period panel still keyed to the exact Slice 9 row');
  // Round trip: selecting a period must not move the Month lens.
  P.__run(`budgetGranularity = 'month';`);
  const monthHtml = P.budgetMonthViewHtml(src);
  assert.ok(monthHtml.includes('data-budget-month-view="2026-10"'),
    'Month lens still October after inspecting the shortfall drilldown');
  assert.equal(P.__run('budgetSelectedMonth'), '2026-10',
    'selected month untouched by period selection');
  resetSlice12State(P);
  delete globalThis.__slice12src;
});

// P24 — Same active inputs drive trajectory + funding schedule.
proof('P24 same active inputs drive trajectory and funding schedule', () => {
  const P = makeContext();
  const src = { plan: comfortablePlan('2026-09-25'), debts: [], asOf: '2026-09-25',
    weekly: 140, periods: null, revolvingExtra: null, liveOverlay: null };
  P.__run(`budgetGranularity='month'; budgetSelectedMonth='2026-10';`
    + ` budgetPayPeriodAnchorMonth=null; budgetDrilldownPayPeriod=null;`
    + ` budgetTrajectoryCache=null; budgetTrajectoryCacheKey=null;`
    + ` budgetMonthScheduleCache=null; budgetMonthScheduleCacheKey=null;`);
  P.budgetMonthViewHtml(src);
  const tKey = vm.runInContext('budgetTrajectoryCacheKey', P.__ctx);
  const sKey = vm.runInContext('budgetMonthScheduleCacheKey', P.__ctx);
  assert.ok(typeof tKey === 'string' && tKey.length > 0, 'trajectory cache key published');
  assert.equal(sKey, tKey, 'funding schedule reuses the trajectory active-input key');
  resetSlice12State(P);
});

let passed = 0;
let failed = 0;
for (const [name, fn] of T) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${String(e && e.message || e).split('\n').join('\n  ')}`);
  }
}
console.log(`\n${passed}/${T.length} Slice 12 checks passed`);
process.exit(failed ? 1 : 0);
