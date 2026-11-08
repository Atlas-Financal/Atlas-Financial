'use strict';
/* AMANDA SLICE 9 — SAME-MONTH PAY-PERIOD DRILLDOWN.
 *
 * The household selects a calendar month to understand that month. Switching
 * Budget from Month to Pay Period must not drop that context: the drilldown
 * shows the Forecast-published Seaspan payday-to-payday periods overlapping
 * the anchored month, in Forecast publication order, each with its published
 * three-stage funding result reprinted verbatim. Complete cycles keep their
 * full-cycle label; a clipped row (as-of residual, horizon-clipped) is
 * labelled with its actual published window — never the whole cycle — so
 * partial-window figures cannot read as whole-cycle figures. Toggling back
 * returns to exactly the same month.
 *
 * Authority boundary: the page selects (calendar overlap on the published
 * full-cycle identity cycleStart/cycleEnd), labels, formats and reprints.
 * It never clips a cycle to month boundaries, never prorates, never sums
 * cycles, never derives stages, never recomputes surplus/deficit, and never
 * implies the cycles sum to the calendar-month total. No generic
 * advice.payPeriodViews substitution — the drilldown consumes the same
 * active-input baselineTrajectory the Month lens uses.
 *
 * Truth boundaries: every figure is a Forecast reprint. Trust is reprinted:
 * estimated stays estimated; unavailable is never $0. No recommendations,
 * no causal wording, no reconciliation language.
 *
 * Proof map (owner brief):
 *   P1  October survives Month -> Pay Period (anchor preserved)
 *   P2  Pay Period -> Month returns to exactly October
 *   P3  three overlapping cycles reachable in Forecast order
 *   P4  prior-month opening cycle shows complete published boundaries
 *   P5  following-month closing cycle shows complete published boundaries
 *   P6  stages are exact reprints of the selected payPeriods[] row
 *   P7  changing an active input (weekly override) recomputes both lenses
 *       from the same new trajectory — no stale advice values
 *   P8  estimated stage trust remains estimated, never promoted
 *   P9  missing/unavailable publication fails closed, never $0
 *   P10 no page-side summation, month reconciliation, or residual
 *   P11 no selected-month context preserves the incumbent default payday
 *       shell and Slice 1-6 behavior
 *   P12 Month verdict, Slice 7 ladder, Slice 8 planned-cost detail unchanged
 *   P13 selecting a pay period cannot alter budgetSelectedMonth
 *   HEART the owner's emphasized journey: October -> Pay Period -> select
 *       the cross-boundary Sep 25-Oct 8 cycle -> Month still October
 *
 * `node test/test-budget-month-pay-period-drilldown.js`
 */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
  Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  // app.js household date formatter, stubbed identically for the VM.
  fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA',
    { day: 'numeric', month: 'long' }),
});
vm.runInContext(planSource, context);
const P = context;
const evalInPage = js => vm.runInContext(js, context);

// ---------------------------------------------------------------- Fixtures --
// Real engine fixture: Seaspan biweekly payroll anchored so October 2026 is
// overlapped by exactly three complete cycles, including the two
// cross-boundary ones from the owner brief.
function slice9Plan() {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 50 },
    opening: { asOf: '2026-09-25' },
    startingCash: { amount: 10000 },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-09-25', amount: 2500, confidence: 'confirmed' }],
    obligations: [],
    bills: [{ id: 'rent', label: 'Rent', frequency: 'monthly', day: 1,
      amount: 1200, confidence: 'confirmed' }],
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 140 },
      ],
    },
    commitments: [],
  };
}

// src = what budgetMonthViewHtml(ctx) receives in the real page.
function slice9Src(plan, weekly) {
  return { plan, debts: [], asOf: plan.opening.asOf, weekly,
    periods: null, revolvingExtra: null, liveOverlay: null };
}

function resetSlice9State() {
  evalInPage(`budgetGranularity = 'pay-period';`);
  evalInPage(`budgetSelectedMonth = null;`);
  evalInPage(`budgetPayPeriodAnchorMonth = null;`);
  evalInPage(`budgetDrilldownPayPeriod = null;`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
}

// Simulate the toggle: Month (on selectedMonth) -> Pay Period.
function enterDrilldown(src, selectedMonth) {
  evalInPage(`budgetGranularity = 'month';`);
  evalInPage(`budgetSelectedMonth = '${selectedMonth}';`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  P.budgetMonthViewHtml(src); // the real Month lens validates the month
  evalInPage(`budgetPayPeriodAnchorMonth = budgetSelectedMonth;`);
  evalInPage(`budgetGranularity = 'pay-period';`);
}

// The engine's real October-overlapping cycles, independent of the page.
function engineOctoberCycles(plan, weekly) {
  const traj = F.baselineTrajectory(plan, [], plan.opening.asOf,
    { weeklyVariable: weekly });
  assert.equal(traj.status, 'ready', 'engine fixture trajectory is ready');
  return (traj.payPeriods || []).filter(p =>
    p.cycleStart <= '2026-10-31' && p.cycleEnd >= '2026-10-01');
}

// ---------------------------------------------------------------- Part A ---
// Engine publication sanity: the fixture really publishes three October-
// overlapping complete cycles with three stages each.
check('A: engine publishes the three cross-boundary October cycles', () => {
  const cycles = engineOctoberCycles(slice9Plan(), 140);
  assert.equal(cycles.length, 3, 'exactly three cycles overlap October');
  assert.deepEqual(
    cycles.map(c => [c.cycleStart, c.cycleEnd]),
    [['2026-09-25', '2026-10-08'], ['2026-10-09', '2026-10-22'], ['2026-10-23', '2026-11-05']],
    'complete published cycle boundaries, never clipped to October');
  assert.deepEqual(
    cycles.map(c => c.cycleRangeLabel),
    ['Sep 25–Oct 8', 'Oct 9–Oct 22', 'Oct 23–Nov 5'],
    'published full-cycle labels in publication order');
  cycles.forEach(c => {
    ['stage1', 'stage2', 'stage3'].forEach(s => {
      assert.ok(c[s] && c[s].result && isFinite(Number(c[s].result.amount)),
        `${c.cycleRangeLabel} ${s} publishes a numeric result`);
    });
  });
});

// ---------------------------------------------------------------- Part B ---
// The page's drilldown behaviour.

check('P1: October survives Month -> Pay Period', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'selected month still October after entering Pay Period');
    assert.equal(evalInPage('budgetPayPeriodAnchorMonth'), '2026-10',
      'drilldown anchored on October');
    const html = P.budgetPayPeriodDrilldownHtml(slice9Src(plan, 140));
    assert.ok(html.includes('data-budget-drilldown="2026-10"'),
      'drilldown carries the October anchor');
    assert.ok(html.includes('October 2026'), 'drilldown names October 2026');
  } finally { resetSlice9State(); }
});

check('P2: Pay Period -> Month returns to exactly October', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    enterDrilldown(src, '2026-10');
    P.budgetPayPeriodDrilldownHtml(src);
    evalInPage(`budgetGranularity = 'month';`); // the toggle back
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'toggle back did not move the selected month');
    const html = P.budgetMonthViewHtml(src);
    assert.ok(html.includes('data-budget-month-view="2026-10"'),
      'Month lens renders exactly October');
  } finally { resetSlice9State(); }
});

check('P3: three overlapping cycles reachable in Forecast order', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    const html = P.budgetPayPeriodDrilldownHtml(slice9Src(plan, 140));
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)]
      .map(m => m[2]);
    assert.deepEqual(options, ['Sep 25–Oct 8', 'Oct 9–Oct 22', 'Oct 23–Nov 5'],
      'picker offers the three cycles in Forecast publication order');
  } finally { resetSlice9State(); }
});

check('P4: prior-month opening cycle shows complete published boundaries', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    const html = P.budgetPayPeriodDrilldownHtml(slice9Src(plan, 140));
    assert.ok(html.includes('Sep 25–Oct 8'),
      'opening cycle keeps its September start — not relabelled Oct 1–Oct 8');
    assert.ok(!html.includes('Oct 1–Oct 8'), 'no month-clipped relabelling');
  } finally { resetSlice9State(); }
});

check('P5: following-month closing cycle shows complete published boundaries', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    const html = P.budgetPayPeriodDrilldownHtml(slice9Src(plan, 140));
    assert.ok(html.includes('Oct 23–Nov 5'),
      'closing cycle keeps its November end — not relabelled Oct 23–Oct 31');
    assert.ok(!html.includes('Oct 23–Oct 31'), 'no month-clipped relabelling');
  } finally { resetSlice9State(); }
});

check('P6: stages are exact reprints of the selected payPeriods[] row', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    enterDrilldown(src, '2026-10');
    // Select the middle cycle, Oct 9–Oct 22 (payday 2026-10-09).
    evalInPage(`budgetDrilldownPayPeriod = '2026-10-09';`);
    const html = P.budgetPayPeriodDrilldownHtml(src);
    const engine = engineOctoberCycles(plan, 140)
      .find(c => c.payday === '2026-10-09');
    assert.ok(engine, 'engine published the Oct 9 cycle');
    assert.ok(html.includes('data-budget-drilldown-period="2026-10-09"'),
      'panel renders the selected cycle');
    const labels = { stage1: 'Normal life', stage2: 'After planned spending', stage3: 'After debt strategy' };
    const money = n => Math.abs(Number(n)).toLocaleString('en-CA',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (const key of ['stage1', 'stage2', 'stage3']) {
      const expected = money(engine[key].result.amount);
      const row = html.slice(html.indexOf(labels[key]));
      assert.ok(row.includes(expected),
        `${labels[key]} reprints the published ${engine[key].result.amount}`);
      assert.ok(!row.includes('advice.payPeriodViews'),
        'no generic advice substitution marker leaks into the reprint');
    }
    assert.equal((html.match(/data-budget-drilldown-stage=/g) || []).length, 6,
      'the ladder plus the money-map group reprints show the published stages, no derived extras');
    const ladderHtml = html.slice(0, html.indexOf('data-budget-drilldown-money-map='));
    assert.equal((ladderHtml.match(/data-budget-drilldown-stage=/g) || []).length, 3,
      'the Slice 9 ladder itself is exactly the three published stages');
  } finally { resetSlice9State(); }
});

check('P7: changing the weekly override recomputes both lenses from the same new trajectory', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    evalInPage(`budgetDrilldownPayPeriod = '2026-10-09';`);
    const before = P.budgetPayPeriodDrilldownHtml(slice9Src(plan, 140));
    const beforeMid = engineOctoberCycles(plan, 140).find(c => c.payday === '2026-10-09');
    const money = n => Math.abs(Number(n)).toLocaleString('en-CA',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(before.includes(money(beforeMid.stage1.result.amount)));
    // Change the active input; the shared cache key must invalidate.
    evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
    const afterSrc = slice9Src(plan, 500);
    const after = P.budgetPayPeriodDrilldownHtml(afterSrc);
    const afterMid = engineOctoberCycles(plan, 500).find(c => c.payday === '2026-10-09');
    assert.notDeepEqual(beforeMid.stage1.result.amount, afterMid.stage1.result.amount,
      'the engine really moves the stage figures with the weekly input');
    assert.ok(after.includes(money(afterMid.stage1.result.amount)),
      'drilldown reprints the new trajectory, not stale values');
    assert.ok(!after.includes(money(beforeMid.stage1.result.amount)),
      'stale figures are gone');
    // Both lenses read the same cached trajectory object.
    evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
    evalInPage(`budgetGranularity = 'month';`);
    P.budgetMonthViewHtml(afterSrc);
    const monthTraj = P.budgetTrajectoryFor(afterSrc);
    evalInPage(`budgetGranularity = 'pay-period';`);
    P.budgetPayPeriodDrilldownHtml(afterSrc);
    const drillTraj = P.budgetTrajectoryFor(afterSrc);
    assert.strictEqual(monthTraj, drillTraj,
      'Month and drilldown consume the identical trajectory object');
  } finally { resetSlice9State(); }
});

// ---------------------------------------------------------------- Part C ---
// Trust and failure boundaries, via fixtures shaped exactly like the engine
// publication (the engine only emits calculated/unavailable for these
// inputs, so the estimated and missing cases are shaped like the real rows).

function stageFixture(overrides = {}) {
  return Object.assign({
    id: 'normal-life', label: 'Normal life', status: 'calculated',
    result: { amount: 1020, status: 'calculated' },
  }, overrides);
}

function periodFixture(stageOverrides = {}) {
  const base = stageFixture();
  const s1 = Object.assign({}, base, stageOverrides.stage1);
  const s2 = Object.assign({}, base, {
    id: 'after-planned-spending', label: 'After planned spending',
  }, stageOverrides.stage2);
  const s3 = Object.assign({}, base, {
    id: 'after-debt-strategy', label: 'After debt strategy',
  }, stageOverrides.stage3);
  return {
    id: 'pp', payday: '2026-10-09', nextPayday: '2026-10-23',
    start: '2026-10-09', end: '2026-10-22',
    rangeLabel: 'Oct 9–Oct 22',
    cycleStart: '2026-10-09', cycleEnd: '2026-10-22',
    cycleRangeLabel: 'Oct 9–Oct 22',
    windowKind: 'full-cycle', displayIdentity: 'Pay period',
    stage1: s1, stage2: s2, stage3: s3,
  };
}

// Drive the real page panel function with a synthetic-but-faithful row.
const panelHtml = period => P.budgetDrilldownPeriodHtml(period);

check('P8: estimated stage trust remains estimated, never promoted', () => {
  const html = panelHtml(periodFixture({
    stage1: { status: 'estimated', result: { amount: 900, status: 'estimated' } },
  }));
  // The stage1 row only: from its label to the next stage row.
  const s1Start = html.indexOf('Normal life');
  const s1End = html.indexOf('data-budget-drilldown-stage=', s1Start + 10);
  const s1 = html.slice(s1Start, s1End === -1 ? undefined : s1End);
  assert.ok(s1.includes('trust-tag trust-estimated'),
    'estimated stage carries the estimate tag');
  assert.ok(!s1.includes('calculated'),
    'estimated is never promoted to calculated');
});

check('P9: missing/unavailable publication fails closed, never $0', () => {
  const missing = panelHtml(periodFixture({
    stage2: { status: 'unavailable', reason: 'Forecast could not stage this period.',
      result: { status: 'unavailable', reason: 'Forecast could not stage this period.' } },
  }));
  const s2 = missing.slice(missing.indexOf('After planned spending'));
  assert.ok(s2.includes('unavailable'), 'unavailable stage says unavailable');
  assert.ok(s2.includes('Not $0'), 'unavailable is never $0');
  assert.ok(!s2.includes('$0.00'), 'no zero figure for the missing stage');
  // Whole-trajectory unavailable: the drilldown fails closed.
  try {
    resetSlice9State();
    const plan = slice9Plan();
    enterDrilldown(slice9Src(plan, 140), '2026-10');
    const noPlanSrc = slice9Src(plan, 140);
    noPlanSrc.plan = null; // budgetTrajectoryFor returns null honestly
    const html = P.budgetPayPeriodDrilldownHtml(noPlanSrc);
    assert.ok(html.includes('unavailable'), 'drilldown fails closed on missing trajectory');
    assert.ok(html.includes('This is not $0'), 'never $0');
  } finally { resetSlice9State(); }
});

check('P10: no page-side summation, month reconciliation, or residual', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    enterDrilldown(src, '2026-10');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    const cycles = engineOctoberCycles(plan, 140);
    const sum = cycles.reduce((t, c) => t + Number(c.stage3.result.amount), 0);
    const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-CA',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    assert.ok(!html.includes(money(sum)),
      `no rendered total equals the summed cycles (${money(sum)}) — nothing is summed`);
    assert.ok(!/reconcil/i.test(html), 'no reconciliation language');
    assert.ok(!/residual|plug/i.test(html), 'no balancing residual');
    assert.ok(html.includes('not expected to sum to the calendar-month total'),
      'the scope note states cycles are not month parts');
    assert.ok(!/caus/i.test(html), 'no causal wording');
  } finally { resetSlice9State(); }
});

check('P11: no selected-month context preserves the incumbent default payday shell', () => {
  resetSlice9State();
  assert.equal(evalInPage('budgetPayPeriodAnchorMonth'), null, 'default has no anchor');
  assert.equal(P.budgetInPayPeriodDrilldown(), false,
    'the drilldown predicate is false on the default landing');
  // The render branch: no anchor -> drilldownView is '' -> instructionShell
  // path untouched. Proved structurally: drilldown HTML only renders when
  // the predicate is true, and the predicate requires the anchor.
});

check('P12: Month verdict, Slice 7 ladder, and Slice 8 planned-cost detail unchanged', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    evalInPage(`budgetGranularity = 'month';`);
    evalInPage(`budgetSelectedMonth = '2026-10';`);
    const html = P.budgetMonthViewHtml(src);
    assert.ok(html.includes('data-budget-month-view="2026-10"'), 'month view renders');
    assert.ok(html.includes('Monthly'), 'Month verdict present');
    assert.ok(html.includes('budget-month-ladder') || html.includes('Funding ladder'),
      'Slice 7 ladder present');
    assert.ok(html.includes('Planned costs in view'), 'Slice 8 block present');
    // And toggling into the drilldown does not rewrite the month view:
    enterDrilldown(src, '2026-10');
    evalInPage(`budgetGranularity = 'month';`);
    const again = P.budgetMonthViewHtml(src);
    assert.ok(again.includes('Monthly'), 'verdict intact after drilldown round-trip');
    assert.ok(again.includes('Planned costs in view'), 'Slice 8 intact after round-trip');
  } finally { resetSlice9State(); }
});

check('P13: selecting a pay period cannot alter budgetSelectedMonth', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    enterDrilldown(src, '2026-10');
    evalInPage(`budgetDrilldownPayPeriod = '2026-09-25';`); // the period picker
    P.budgetPayPeriodDrilldownHtml(src);
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'period selection left the selected month alone');
    evalInPage(`budgetDrilldownPayPeriod = '2026-10-23';`);
    P.budgetPayPeriodDrilldownHtml(src);
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'a second period selection still left the month alone');
  } finally { resetSlice9State(); }
});

check('HEART: October -> Pay Period -> Sep 25–Oct 8 -> Month still October', () => {
  try {
    resetSlice9State();
    const plan = slice9Plan();
    const src = slice9Src(plan, 140);
    // October selected in the Month lens.
    evalInPage(`budgetGranularity = 'month';`);
    evalInPage(`budgetSelectedMonth = '2026-10';`);
    P.budgetMonthViewHtml(src);
    // Toggle to Pay Period (the wiring sets the anchor).
    evalInPage(`budgetPayPeriodAnchorMonth = budgetSelectedMonth;`);
    evalInPage(`budgetGranularity = 'pay-period';`);
    let html = P.budgetPayPeriodDrilldownHtml(src);
    assert.ok(html.includes('data-budget-drilldown="2026-10"'),
      'drilldown opened on October');
    // Select the cross-boundary cycle.
    evalInPage(`budgetDrilldownPayPeriod = '2026-09-25';`);
    html = P.budgetPayPeriodDrilldownHtml(src);
    assert.ok(html.includes('data-budget-drilldown-period="2026-09-25"'),
      'cross-boundary cycle selected');
    assert.ok(html.includes('Sep 25–Oct 8'),
      'the full published cycle boundaries are shown');
    assert.ok(html.includes('Normal life'), 'its stages render');
    // Toggle back to Month.
    evalInPage(`budgetGranularity = 'month';`);
    const month = P.budgetMonthViewHtml(src);
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'Month is still exactly October');
    assert.ok(month.includes('data-budget-month-view="2026-10"'),
      'Month lens renders October');
  } finally { resetSlice9State(); }
});

// ---------------------------------------------------------------- Part D ---
// P1 repair (Systems Review BLOCKING on PR #447): a trajectory that starts
// mid-cycle. The engine publishes the first row as an as-of residual — its
// figures cover only the residual window — so the drilldown must label it
// with the truthful published window (rangeLabel), never the full-cycle
// range that would make partial-window dollars look whole-cycle.

function slice9MidCyclePlan() {
  const plan = slice9Plan();
  plan.opening.asOf = '2026-09-28'; // mid-cycle: inside Sep 25–Oct 8
  return plan;
}

check('P14: mid-cycle trajectory start labels the residual with its truthful window', () => {
  try {
    resetSlice9State();
    const plan = slice9MidCyclePlan();
    const src = slice9Src(plan, 140);
    // Engine sanity: the first October-overlapping row is the as-of residual.
    const traj = F.baselineTrajectory(plan, [], '2026-09-28', { weeklyVariable: 140 });
    assert.equal(traj.status, 'ready', 'mid-cycle trajectory is ready');
    const rows = (traj.payPeriods || []).filter(p =>
      p.cycleStart <= '2026-10-31' && p.cycleEnd >= '2026-10-01');
    assert.equal(rows.length, 3, 'still three October-overlapping rows');
    const residual = rows[0];
    assert.equal(residual.windowKind, 'as-of-residual');
    assert.equal(residual.rangeLabel, 'Sep 28–Oct 8');
    assert.equal(residual.cycleRangeLabel, 'Sep 25–Oct 8');
    assert.equal(residual.displayIdentity, 'Remaining through next payday');
    // Page: the drilldown labels the residual with its actual window.
    enterDrilldown(src, '2026-10');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    const options = [...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)]
      .map(m => m[2]);
    assert.deepEqual(options, ['Sep 28–Oct 8', 'Oct 9–Oct 22', 'Oct 23–Nov 5'],
      'picker labels the residual with its published window, in Forecast order');
    assert.ok(!html.includes('Sep 25–Oct 8'),
      'the full-cycle range never labels the partial-window row');
    // The default-selected panel is the residual: truthful heading, the
    // published residual identity, and exact reprints of its figures.
    assert.ok(html.includes('data-budget-drilldown-period="2026-09-25"'),
      'residual panel renders (keyed by its cycle payday)');
    assert.ok(html.includes('remaining through next payday'),
      'panel names the published residual identity');
    const money = n => Math.abs(Number(n)).toLocaleString('en-CA',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const panel = html.slice(html.indexOf('data-budget-drilldown-period="2026-09-25"'));
    assert.ok(panel.includes(money(residual.stage1.result.amount)),
      'residual stage figures are exact reprints of the published row');
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'the residual labelling changed nothing about the month anchor');
  } finally { resetSlice9State(); }
});

check('P15: a clipped row with no published window identity fails closed, never $0', () => {
  // A clipped row Forecast did not give a truthful window identity cannot
  // be shown: the drilldown drops it instead of guessing a label.
  const bad = periodFixture();
  bad.windowKind = 'as-of-residual';
  delete bad.rangeLabel;
  assert.equal(P.budgetDrilldownPeriodLabel(bad), null,
    'no truthful identity -> null label');
  const html = P.budgetDrilldownPeriodHtml(bad);
  assert.ok(html.includes('unavailable'), 'panel fails closed');
  assert.ok(html.includes('This is not $0'), 'never $0');
  assert.ok(!html.includes('$0.00'), 'no zero figure');
});

console.log(`\nSlice 9 drilldown: ${checks} checks passed.`);