'use strict';
/* AMANDA SLICE 3 — Month <-> Pay Period consolidated planning view.
 *
 * The default Budget surface lets the household switch between:
 * - Month: one consolidated calendar-month picture from
 *   Forecast.baselineTrajectory months[] (stage1/stage2/stage3).
 * - Pay Period: the existing payday/pay-period operating picture.
 *
 * The page selects the Forecast row, formats values, labels them, and
 * arranges them visually. It never sums income, subtracts expenses,
 * calculates surplus/deficit, reconstructs stage totals, or carries
 * surplus between months. The monthly surplus/deficit is Forecast
 * stage3.dateOrderResult (the household-facing date-order result), copied
 * verbatim. Unavailable is not $0.
 *
 * Part A (Forecast authority): the trajectory months[] carry stage1/2/3
 * with the standalone-period contract (priorPeriodSurplus excluded).
 * Part B (page presentation): plan.js reprints those figures with zero
 * page-side arithmetic.
 * Part C (cross-view consistency): Budget reprints the same Forecast
 * authority used elsewhere.
 *
 * `node test/test-budget-month-view.js`
 */
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let checks = 0;
function check(label, run) { run(); checks++; console.log('  PASS  ' + label); }

const cent = x => Math.round(Number(x) * 100);

// ---------------------------------------------------------------- Part A ---
// Forecast publishes months[] with stage1/2/3 and the standalone contract.

function basePlan() {
  return {
    windowDays: 91,
    defaults: { targetBuffer: 0, extraDebtMonthly: 50, scenario: 'expected' },
    opening: { asOf: '2026-09-25' },
    startingCash: { amount: 1000 },
    income: [
      { id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: '2026-09-11', amount: 2500, confidence: 'confirmed' },
    ],
    obligations: [],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 1,
        amount: 1200, confidence: 'confirmed' },
    ],
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

function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [{ label: 'Groceries', total: 50000 }],
      },
    },
  };
}

function runTrajectory(plan) {
  return F.baselineTrajectory(plan, [], '2026-09-25', {
    periods: periodsFixture(),
    extraFacilities: null,
    currentPeriodActuals: null,
  });
}

let traj = null;
check('A1: Forecast publishes months[] with stage1/stage2/stage3', () => {
  traj = runTrajectory(basePlan());
  assert.equal(traj.status, 'ready');
  assert.ok(Array.isArray(traj.months) && traj.months.length > 0);
  const m = traj.months[0];
  assert.ok(m.stage1 && m.stage1.income, 'stage1.income present');
  assert.ok(m.stage1.householdBudget, 'stage1.householdBudget present');
  assert.ok(m.stage1.bills, 'stage1.bills present');
  assert.ok(m.stage1.obligations, 'stage1.obligations present');
  assert.ok(m.stage2 && m.stage2.commitments, 'stage2.commitments present');
  assert.ok(m.stage3 && m.stage3.result, 'stage3.result present');
  assert.ok(m.stage3 && m.stage3.dateOrderResult, 'stage3.dateOrderResult present');
});

check('A2: roadAheadSurplusDeficit names the standalone-period contract', () => {
  const rs = traj.roadAheadSurplusDeficit;
  assert.equal(rs.identity, 'standalone-period-surplus-deficit');
  assert.equal(rs.priorPeriodSurplus, 'excluded');
  assert.equal(rs.source, 'stage3.result');
  assert.equal(rs.cumulativeCash, 'not-this-result');
});

check('A3: date-order result can diverge from the arithmetic identity (intra-month timing)', () => {
  // A $2,000 dated commitment due 2026-10-05: no pay-period surplus has
  // closed by then (closes are 10-08 and 10-22), so the date-order result
  // is a deficit even though stage1 minus commitments is a surplus.
  const plan = basePlan();
  plan.startingCash = { amount: 10000 };
  plan.commitments = [
    { id: 'roof', label: 'Roof repair', date: '2026-10-05', amount: 2000, confidence: 'confirmed' },
  ];
  const t = runTrajectory(plan);
  assert.equal(t.status, 'ready');
  const m = t.months.find(x => x.month === '2026-10');
  assert.ok(m, 'october published');
  assert.ok(m.stage3.result && m.stage3.dateOrderResult, 'both results published');
  assert.ok(Number(m.stage3.result.amount) > 0, 'arithmetic identity is a surplus');
  assert.ok(Number(m.stage3.dateOrderResult.amount) < 0, 'date-order result is a deficit');
  assert.equal(m.stage3.dateOrderResult.identity, 'date-order-month-funding');
});

// ---------------------------------------------------------------- Part B ---
// Page reprint behaviour. Deterministic fixture figures.

const planSource = sourceText(fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8'));
const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
  Forecast: F,
  money2: n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
});
vm.runInContext(planSource, context);
const P = context;

// The page's module-scope bindings (state, budgetGranularity,
// budgetSelectedMonth, budgetTrajectoryCache/Key) are top-level let/const in
// plan.js: visible to in-context evaluation, not as properties of the vm
// global. Drive and read them by evaluating in the same context.
function evalInPage(js) { return vm.runInContext(js, context); }
function setGranularity(g) { evalInPage(`budgetGranularity = ${JSON.stringify(g)};`); }
function setSelectedMonth(m) { evalInPage(`budgetSelectedMonth = ${JSON.stringify(m)};`); }
function setKnobs(knobs) {
  evalInPage(Object.entries(knobs)
    .map(([k, v]) => `state[${JSON.stringify(k)}] = ${JSON.stringify(v)};`)
    .join('\n'));
}
function pageCacheKey() { return evalInPage('budgetTrajectoryCacheKey'); }

// The active Budget planning controls live in plan.js `state`. Reset them so
// control-state tests are isolated from each other.
function resetKnobs() {
  setKnobs({
    scenario: null, targetBuffer: null, extraDebtMonthly: null,
    weeklyVariable: null, incomeOverrides: {}, disabled: [],
    extraDebtTarget: null,
  });
}

// Reset module state between tests.
function resetState() {
  setGranularity('pay-period');
  setSelectedMonth(null);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  resetKnobs();
}

function srcFixture() {
  return {
    plan: basePlan(),
    debts: [],
    asOf: '2026-09-25',
    meta: { asOf: '2026-09-25' },
    liveOverlay: null,
    revolvingExtra: null,
    periods: periodsFixture(),
  };
}

check('B1: month view copies stage3.dateOrderResult verbatim as the verdict', () => {
  resetState();
  setGranularity('month');
  const html = P.budgetMonthViewHtml(srcFixture());
  const month = P.budgetTrajectoryFor(srcFixture()).months[0];
  const expected = P.money2(month.stage3.dateOrderResult.amount);
  assert.ok(html.includes(expected), `verdict shows Forecast stage3.dateOrderResult ${expected}`);
  // The verdict label matches the sign of the date-order result.
  const amount = Number(month.stage3.dateOrderResult.amount);
  if (amount > 0) assert.ok(html.includes('Monthly surplus'), 'surplus label');
  else if (amount < 0) assert.ok(html.includes('Monthly deficit'), 'deficit label');
});

check('B1b: verdict follows the date-order result when it diverges from the arithmetic identity', () => {
  resetState();
  // Unit: a fabricated month where the arithmetic identity is a surplus but
  // the household-facing date-order decision result is a deficit — the page
  // must show the deficit, never the surplus.
  const html = P.budgetMonthVerdictHtml({
    stage3: {
      result: { amount: 1190, status: 'calculated' },
      dateOrderResult: { amount: -2050, status: 'calculated' },
    },
  });
  assert.ok(html.includes('Monthly deficit'), 'deficit label from date-order result');
  assert.ok(html.includes('data-budget-month-verdict="deficit"'), 'deficit sign');
  assert.ok(html.includes(P.money2(2050)), 'date-order amount shown');
  assert.ok(!html.includes('>Monthly surplus</span>'), 'arithmetic surplus not shown');
});

check('B1c: end-to-end divergence — page renders Forecast\'s date-order deficit, not the arithmetic surplus', () => {
  resetState();
  setGranularity('month');
  const src = srcFixture();
  src.plan.startingCash = { amount: 10000 };
  src.plan.commitments = [
    { id: 'roof', label: 'Roof repair', date: '2026-10-05', amount: 2000, confidence: 'confirmed' },
  ];
  setSelectedMonth('2026-10');
  const html = P.budgetMonthViewHtml(src);
  const month = P.budgetTrajectoryFor(src).months.find(m => m.month === '2026-10');
  assert.ok(Number(month.stage3.result.amount) > 0, 'fixture: arithmetic identity is a surplus');
  assert.ok(Number(month.stage3.dateOrderResult.amount) < 0, 'fixture: date-order result is a deficit');
  assert.ok(html.includes('Monthly deficit'), 'page shows the date-order deficit');
  assert.ok(html.includes(P.money2(Math.abs(Number(month.stage3.dateOrderResult.amount)))),
    'page shows the date-order amount');
});

check('B2: month view copies each component amount (no recomputation)', () => {
  resetState();
  setGranularity('month');
  const src = srcFixture();
  const html = P.budgetMonthViewHtml(src);
  const month = P.budgetTrajectoryFor(src).months[0];
  // Total income is the Stage 1 funding-decomposition income, not the
  // separate calendar-window month.income.
  const components = [
    month.stage1.income,
    month.stage1.householdBudget,
    month.stage1.bills,
    month.stage1.obligations,
    month.stage2.commitments,
  ];
  for (const c of components) {
    if (!c || c.status === 'unavailable' || c.amount == null) continue;
    const expected = P.money2(c.amount);
    assert.ok(html.includes(expected), `component ${expected} copied`);
  }
});

check('B2b: Total income is stage1.income, not calendar-window month.income', () => {
  resetState();
  setGranularity('month');
  // December: three pay periods close in-month (stage1.income $7,500) while
  // only two paydays are dated inside the calendar month (month.income
  // $5,000). The row must show the funding-decomposition figure.
  const src = srcFixture();
  src.plan.windowDays = 120;
  setSelectedMonth('2026-12');
  const html = P.budgetMonthViewHtml(src);
  const month = P.budgetTrajectoryFor(src).months.find(m => m.month === '2026-12');
  assert.equal(Number(month.stage1.income.amount), 7500, 'fixture: stage1.income is 7500');
  assert.equal(Number(month.income.amount), 5000, 'fixture: month.income is 5000');
  const row = html.match(/data-budget-month-component="Total income"[\s\S]*?<\/div>/);
  assert.ok(row, 'Total income row present');
  assert.ok(row[0].includes(P.money2(7500)), 'row shows stage1.income');
  assert.ok(!row[0].includes(P.money2(5000)), 'row does not show month.income');
});

check('B3: month view contains no page-side arithmetic on financial values', () => {
  // Static check: the Slice 3 month-view functions must not combine figures.
  // They select, format, label, and arrange — never sum or subtract.
  const monthFns = planSource.slice(
    planSource.indexOf('AMANDA SLICE 3'),
    planSource.indexOf('function paydayInstructionShellHtml')
  );
  // Forbid arithmetic combining two financial values in the month view.
  // Single-operand formatting (Math.abs, Number()) is presentation.
  const lines = monthFns.split('\n');
  const bad = lines.filter(line => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return false;
    // Look for amount-to-amount arithmetic: e.g. "a.amount + b.amount"
    // or "income - bills". Allow money2(), Number(), Math.abs().
    return /\bamount\s*[-+*/]\s*[^=]/.test(t) && !/money2|Math\.abs|Number\(/.test(t);
  });
  assert.deepEqual(bad, [], `no amount arithmetic in month view, found: ${bad.join(' | ')}`);
});

check('B4: estimated trust state is preserved on month components', () => {
  // Test the component row directly — the VM's let-bound cache is not
  // settable from outside, so we exercise the renderer with a fixture.
  const rowHtml = P.budgetMonthComponentRow('Total income', { amount: 5000, status: 'estimated' });
  assert.ok(rowHtml.includes('trust-estimated'), 'estimated tag present');
  assert.ok(rowHtml.includes('estimate</span>'), 'estimate label present');
  const verdictHtml = P.budgetMonthVerdictHtml({
    stage3: { dateOrderResult: { amount: 2950, status: 'estimated' } },
  });
  assert.ok(verdictHtml.includes('trust-estimated'), 'verdict carries estimated trust');
  assert.ok(verdictHtml.includes('data-budget-month-verdict="surplus"'), 'verdict sign preserved');
});

check('B5: unavailable trajectory fails closed (not $0)', () => {
  resetState();
  setGranularity('month');
  // A src with no plan forces budgetTrajectoryFor to return null.
  const html = P.budgetMonthViewHtml({ plan: null });
  assert.ok(html.includes('unavailable'), 'unavailable shown');
  assert.ok(html.includes('not $0'), 'not presented as $0');
});

check('B6: unavailable month result fails closed (not $0)', () => {
  const html = P.budgetMonthVerdictHtml({
    stage3: { dateOrderResult: { status: 'unavailable', reason: 'No cash walk.' } },
  });
  assert.ok(html.includes('data-budget-month-verdict="unavailable"'), 'verdict unavailable');
  assert.ok(!/Monthly surplus.*\$0\.00/.test(html), 'no $0 surplus');
  assert.ok(html.includes('Not $0'), 'explicit not-$0');
});

check('B6b: missing date-order result fails closed even when the arithmetic identity exists', () => {
  // The decision result is required; a present arithmetic identity must not
  // stand in for it.
  const html = P.budgetMonthVerdictHtml({
    stage3: { result: { amount: 1190, status: 'calculated' } },
  });
  assert.ok(html.includes('data-budget-month-verdict="unavailable"'), 'verdict unavailable');
  assert.ok(!html.includes('>Monthly surplus</span>'), 'arithmetic surplus not shown as the decision');
});

// ---------------------------------------------------------------- Part C ---
// Cross-view consistency: Budget reprints the same Forecast authority.

check('C1: month verdict equals incumbent Forecast date-order result', () => {
  resetState();
  setGranularity('month');
  const src = srcFixture();
  // Independent path: call Forecast directly (not through the page cache)
  // with the same active-control opts the page feeds the authority.
  const direct = F.baselineTrajectory(src.plan, src.debts, src.asOf,
    Object.assign(P.simOpts(), {
      weeklyVariable: src.weekly,
      periods: periodsFixture(), extraFacilities: null, currentPeriodActuals: null,
    }));
  const directMonth = direct.months[0];
  const html = P.budgetMonthViewHtml(src);
  const expected = P.money2(directMonth.stage3.dateOrderResult.amount);
  assert.ok(html.includes(expected), 'page verdict matches direct Forecast call');
});

check('C2: granularity toggle defaults to pay-period (existing experience preserved)', () => {
  resetState();
  assert.equal(evalInPage('budgetGranularity'), 'pay-period');
  const html = P.budgetGranularityToggleHtml();
  assert.ok(html.includes('data-budget-granularity="month"'), 'month button present');
  assert.ok(html.includes('data-budget-granularity="pay-period"'), 'pay-period button present');
  assert.ok(html.includes('aria-pressed="true"') && html.indexOf('pay-period') < html.indexOf('aria-pressed="true"') + 200
    || html.includes('data-budget-granularity="pay-period" aria-pressed="true"'), 'pay-period pressed by default');
});

check('C3: switching granularity does not change Forecast values', () => {
  resetState();
  const src = srcFixture();
  setGranularity('pay-period');
  const trajBefore = P.budgetTrajectoryFor(src);
  setGranularity('month');
  const html = P.budgetMonthViewHtml(src);
  const trajAfter = P.budgetTrajectoryFor(src);
  assert.equal(trajBefore, trajAfter, 'same cached trajectory object');
  const month = trajAfter.months[0];
  assert.ok(html.includes(P.money2(month.stage3.dateOrderResult.amount)), 'values unchanged after switch');
});

check('C4: month picker lists all Forecast months', () => {
  resetState();
  setGranularity('month');
  const src = srcFixture();
  const html = P.budgetMonthViewHtml(src);
  const traj = P.budgetTrajectoryFor(src);
  for (const m of traj.months.slice(0, 3)) {
    assert.ok(html.includes(`value="${m.month}"`), `month ${m.month} in picker`);
  }
});

check('C5: active Budget controls flow into the Month trajectory (no stale cache)', () => {
  resetState();
  setGranularity('month');
  const src = srcFixture();
  const t1 = P.budgetTrajectoryFor(src);
  const key1 = pageCacheKey();
  const before = t1.months.find(m => m.month === '2026-10').stage1.income.amount;
  // Change one active planning control: a payroll income override.
  setKnobs({ incomeOverrides: { payroll: 3000 } });
  const t2 = P.budgetTrajectoryFor(src);
  assert.notEqual(t2, t1, 'cache key includes controls — no stale trajectory');
  assert.notEqual(pageCacheKey(), key1, 'cache identity changes with the control');
  const after = t2.months.find(m => m.month === '2026-10').stage1.income.amount;
  assert.notEqual(after, before, 'month income follows the override');
  // The rendered view shows the overridden figure.
  setSelectedMonth('2026-10');
  const html = P.budgetMonthViewHtml(src);
  const row = html.match(/data-budget-month-component="Total income"[\s\S]*?<\/div>/);
  assert.ok(row && row[0].includes(P.money2(after)), 'view shows overridden income');
  // Reverting the control restores the original cache identity.
  resetKnobs();
  const t3 = P.budgetTrajectoryFor(src);
  assert.equal(pageCacheKey(), key1, 'cache key deterministic — same controls, same key');
  assert.deepEqual(t3.months, t1.months, 'recompute agrees with the original trajectory');
});

check('C6: Month trajectory equals the same Forecast authority call the Pay Period lens is built from', () => {
  resetState();
  const src = srcFixture();
  // Exercise the wired controls: scenario, target buffer, extra debt,
  // weekly spending, income override, disabled commitments.
  setKnobs({
    scenario: 'expected', targetBuffer: 500, extraDebtMonthly: 250,
    weeklyVariable: 1200, incomeOverrides: { payroll: 3000 }, disabled: [],
  });
  // The page's trajectory must deep-equal an independent Forecast call
  // with the identical active-control opts — Month and Pay Period are
  // two views of one selected plan. Forecast computes; the page reprints.
  const pageTraj = P.budgetTrajectoryFor(src);
  const direct = F.baselineTrajectory(src.plan, src.debts, src.asOf,
    Object.assign(P.simOpts(), {
      weeklyVariable: src.weekly,
      periods: src.periods,
      extraFacilities: src.revolvingExtra,
      currentPeriodActuals: null,
    }));
  assert.deepEqual(pageTraj.months, direct.months, 'page trajectory matches direct Forecast call under active controls');
  assert.ok(pageTraj.months.length > 0, 'months published under active controls');
  resetKnobs();
});

check('C7: the Pay Period lens selected weekly pins the Month walk when no override exists', () => {
  resetState();
  // The adjacent lens's selected value flows through even though the
  // household set no explicit weekly override (state.weeklyVariable null).
  const src = srcFixture();
  src.weekly = 1200;
  const traj = P.budgetTrajectoryFor(src);
  assert.equal(traj.weeklyVariable.amount, 1200, 'walk uses the selected weekly');
  assert.equal(traj.weeklyVariable.source, 'user-planning-setting', 'published as a planning setting');
  // Without a selected weekly the incumbent provisional/planned basis applies.
  resetState();
  const traj2 = P.budgetTrajectoryFor(srcFixture());
  assert.notEqual(traj2.weeklyVariable.amount, 1200, 'fallback basis without a selected weekly');
});

console.log(`\n${checks} checks passed.`);
