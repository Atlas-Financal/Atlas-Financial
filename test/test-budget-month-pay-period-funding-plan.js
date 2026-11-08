'use strict';
/* AMANDA SLICE 11 — SELECTED PAY-PERIOD FUNDING PLAN.
 *
 * Slice 9 lets Amanda select a Forecast-published pay-period row and Slice
 * 10 maps what happens inside it. Slice 11 answers a different question:
 * what does Forecast plan to earmark FROM this payday toward future
 * planned costs? The authority is Forecast.planSpendPaydayFunding,
 * consumed through the incumbent Slice 8 helper
 * budgetMonthPlanSpendSchedule — the same active inputs as the selected
 * Month, the Slice 9 pay period, and the Slice 10 money map. The page
 * never duplicates that chain and performs no funding arithmetic.
 *
 * Proof map (owner brief):
 *   P1  a complete future pay period matches the exact funding payday
 *   P2  contribution is an exact Forecast reprint
 *   P3  named allocation amounts are exact Forecast reprints
 *   P4  allocation order remains Forecast publication order
 *   P5  page does not sum allocations to derive contribution
 *   P6  a deliberately non-reconciling fixture still shows the
 *       Forecast-published contribution unchanged
 *   P7  contribution = $0 renders as a known zero when trust says known
 *   P8  missing funding row renders unavailable, not $0
 *   P9  residual pay-period case cannot silently substitute another payday
 *   P10 a residual with no authoritative corresponding funding row fails closed
 *   P11 estimated funding trust remains estimated
 *   P12 unknown/unrecognized trust fails closed
 *   P13 malformed amounts cannot coerce false, "", null or strings into currency
 *   P14 named allocation with malformed amount fails closed rather than
 *       disappearing or rendering $0
 *   A1  (Systems Review 5353073945) a missing/non-array allocations
 *       collection fails closed; a genuine $0 with allocations: [] renders
 *       normally
 *   P15 active weekly/scenario input change recomputes both trajectory and
 *       funding schedule from the same input set
 *   P16 Slice 10 money map remains unchanged
 *   P17 Slice 9 Month <-> Pay Period anchor/navigation remains unchanged
 *   P18 default current-payday shell remains unchanged
 *   P19 no transfer language or reserve-balance claim
 *   P20 no page ranking, prioritisation, affordability or recommendation
 *
 * `node test/test-budget-month-pay-period-funding-plan.js`
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
  fmtDateLong: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-CA',
    { day: 'numeric', month: 'long' }),
});
vm.runInContext(planSource, context);
const P = context;
const evalInPage = js => vm.runInContext(js, context);
const money = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------- Fixtures --

function slice11Plan(asOf, estimatedCost) {
  return {
    defaults: { targetBuffer: 0, extraDebtMonthly: 400 },
    opening: { asOf: asOf || '2026-09-25' },
    startingCash: { amount: 10000 },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: '2026-09-25', amount: 2600, confidence: 'confirmed' }],
    obligations: [{ id: 'visa-min', label: 'Travel Visa minimum', amount: 150,
      frequency: 'monthly', day: 15, confidence: 'confirmed', debtId: 'travel-visa' }],
    bills: [
      { id: 'rent', label: 'Rent', frequency: 'monthly', day: 1,
        amount: 1200, confidence: 'confirmed' },
      { id: 'power', label: 'BC Hydro', frequency: 'monthly', day: 20,
        amount: 90, confidence: 'estimated' },
    ],
    budget: { basis: 'ytd', categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 140 },
    ] },
    commitments: [
      { id: 'fusion', label: 'Fusion tournament', amount: 900,
        date: '2026-10-15', confidence: 'confirmed' },
      { id: 'proptax', label: 'Property tax contribution', amount: 500,
        date: '2026-10-18', confidence: estimatedCost ? 'estimated' : 'confirmed' },
    ],
  };
}

const slice11Debts = [{ id: 'travel-visa', label: 'Travel Visa', balance: 5200 }];

function slice11Src(plan, weekly, debts) {
  return { plan, debts: debts || [], asOf: plan.opening.asOf, weekly,
    periods: null, revolvingExtra: null, liveOverlay: null };
}

function resetSlice11State() {
  evalInPage(`budgetGranularity = 'pay-period';`);
  evalInPage(`budgetSelectedMonth = null;`);
  evalInPage(`budgetPayPeriodAnchorMonth = null;`);
  evalInPage(`budgetDrilldownPayPeriod = null;`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  evalInPage('budgetMonthScheduleCache = null; budgetMonthScheduleCacheKey = null;');
  // Restore the incumbent same-input schedule helper if a test patched it.
  evalInPage(`if (typeof __slice11SavedScheduleFn === 'function') { budgetMonthPlanSpendSchedule = __slice11SavedScheduleFn; __slice11SavedScheduleFn = null; }`);
  delete context.__slice11Doctored;
}

function enterDrilldown(src, selectedMonth) {
  evalInPage(`budgetGranularity = 'month';`);
  evalInPage(`budgetSelectedMonth = '${selectedMonth}';`);
  evalInPage(`budgetPayPeriodAnchorMonth = null;`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  evalInPage('budgetMonthScheduleCache = null; budgetMonthScheduleCacheKey = null;');
  P.budgetMonthViewHtml(src);
  evalInPage(`budgetPayPeriodAnchorMonth = budgetSelectedMonth;`);
  evalInPage(`budgetGranularity = 'pay-period';`);
}

function selectPayPeriod(payday) {
  evalInPage(`budgetDrilldownPayPeriod = '${payday}';`);
}

// The funding-plan block is the last section of the drilldown panel.
function fundingBlock(html) {
  const at = html.indexOf('data-budget-drilldown-funding-plan=');
  assert.ok(at !== -1, 'the funding plan renders inside the drilldown');
  return html.slice(at);
}

// The engine's own publication for one payday, independent of the page.
function engineFundingRow(plan, weekly, payday) {
  const asOf = plan.opening.asOf;
  const knob = { weeklyVariable: weekly };
  const horizon = F.knowledgeHorizon(plan, asOf, knob);
  const walkOpts = horizon && horizon.days > 0
    ? Object.assign({}, knob, { horizonDays: horizon.days, viewDays: horizon.days }) : knob;
  const sim = F.simulate(plan, asOf, walkOpts);
  const seq = F.fundingSequence(plan, asOf, knob);
  const plans = F.majorPlans(plan, asOf, knob);
  const alloc = F.paydayAllocation(plan, asOf, Object.assign({}, knob, { majorPlans: plans }));
  const schedule = F.planSpendPaydayFunding(plan, asOf, sim, seq, plans, alloc);
  assert.equal(schedule.status, 'ready', 'engine funding schedule is ready');
  const row = (schedule.paydays || []).find(r => r && r.payday === payday);
  return { schedule, row };
}

// Doctor the incumbent helper's publication without touching Forecast:
// the page must treat the doctored publication exactly as published.
function withDoctoredSchedule(src, mutate, run) {
  const real = P.budgetMonthPlanSpendSchedule(src);
  assert.ok(real, 'incumbent helper publishes a schedule to doctor');
  const doctored = JSON.parse(JSON.stringify(real));
  mutate(doctored);
  context.__slice11Doctored = doctored;
  evalInPage(`__slice11SavedScheduleFn = budgetMonthPlanSpendSchedule;`);
  evalInPage(`budgetMonthPlanSpendSchedule = function () { return __slice11Doctored; };`);
  try {
    run();
  } finally {
    resetSlice11State();
  }
}

// ------------------------------------------------------------------- Proof --

check('P1: a complete future pay period matches the exact funding payday', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    const block = fundingBlock(html);
    assert.ok(block.includes('data-budget-drilldown-funding-plan="2026-10-09"'),
      'the funding plan is keyed to the exact selected payday, 2026-10-09');
    assert.ok(block.includes('Future-cost funding from the October 9 payday'),
      'the heading names the matched payday');
  } finally { resetSlice11State(); }
});

check('P2: contribution is an exact Forecast reprint', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    const { row } = engineFundingRow(plan, 140, '2026-10-09');
    assert.ok(row, 'engine publishes a 2026-10-09 funding row');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
    assert.ok(block.includes('data-budget-funding-contribution="published"'),
      'the contribution renders as a published figure');
    assert.ok(block.includes(money(row.contribution)),
      `contribution reprints the engine figure ${money(row.contribution)} exactly`);
  } finally { resetSlice11State(); }
});

check('P3: named allocation amounts are exact Forecast reprints', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    const { row } = engineFundingRow(plan, 140, '2026-10-09');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
    for (const a of row.allocations) {
      assert.ok(block.includes(a.label), `allocation label reprinted: ${a.label}`);
      assert.ok(block.includes(money(a.amount)),
        `allocation amount reprints the engine figure ${money(a.amount)} exactly`);
    }
  } finally { resetSlice11State(); }
});

check('P4: allocation order remains Forecast publication order', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    const { row } = engineFundingRow(plan, 140, '2026-10-09');
    assert.ok(row.allocations.length >= 2, 'engine publishes at least two allocations');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
    let last = -1;
    for (const a of row.allocations) {
      const at = block.indexOf(a.label);
      assert.ok(at > last, `allocation order preserved: ${a.label} follows publication order`);
      last = at;
    }
  } finally { resetSlice11State(); }
});

check('P5: page does not sum allocations to derive contribution', () => {
  const fns = ['budgetPayPeriodFundingRow', 'budgetPayPeriodFundingLineHtml',
    'budgetPayPeriodFundingPlanHtml'].map(n => P[n].toString()).join('\n');
  assert.ok(!fns.includes('.reduce('), 'no allocation summation in the funding-plan code');
  assert.ok(!/namedSum|allocationSum|sumAlloc/.test(fns), 'no sum variable in the funding-plan code');
});

check('P6: a deliberately non-reconciling fixture still shows the Forecast-published contribution unchanged', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    withDoctoredSchedule(src, doctored => {
      const row = doctored.paydays.find(r => r && r.payday === '2026-10-09');
      row.contribution = 1400;
      // Deliberately non-reconciling: lines sum to 1300, not 1400.
      row.allocations = [
        { id: 'fusion', label: 'Fusion tournament', amount: 900 },
        { id: 'proptax', label: 'Property tax contribution', amount: 400 },
      ];
    }, () => {
      const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
      assert.ok(block.includes(money(1400)), 'the published contribution is shown unchanged');
      assert.ok(block.includes(money(900)) && block.includes(money(400)),
        'both published allocation lines are reprinted as published');
      assert.ok(!block.includes(money(1300)), 'the page never derives or shows a summed figure');
    });
  } finally { resetSlice11State(); }
});

check('P7: contribution = $0 renders as a known zero when trust says it is known', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    const { schedule, row } = engineFundingRow(plan, 140, '2026-10-23');
    assert.ok(row, 'engine publishes a 2026-10-23 funding row');
    assert.equal(row.contribution, 0, 'engine publishes a zero contribution');
    assert.ok(schedule.fundingTrust === 'calculated' || schedule.fundingTrust === 'estimated',
      'schedule trust is a known published tag');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-23');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
    assert.ok(block.includes('data-budget-funding-contribution="published"'),
      'the zero renders as a published figure, not unavailable');
    assert.ok(block.includes(money(0)), 'the known zero renders as $0.00');
    assert.ok(block.includes('trust-tag'), 'the known zero carries its trust tag');
    assert.ok(!block.includes('unavailable from the current Forecast opening'),
      'a known zero is never confused with unavailable');
  } finally { resetSlice11State(); }
});

check('P8: missing funding row renders unavailable, not $0', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    withDoctoredSchedule(src, doctored => {
      doctored.paydays = doctored.paydays.filter(r => !(r && r.payday === '2026-10-09'));
    }, () => {
      const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
      assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
        'a missing funding row fails the funding plan closed');
      assert.ok(block.includes('Funding plan for this payday is unavailable from the current Forecast opening.'),
        'the truthful unavailable copy renders');
      assert.ok(block.includes('This is not $0'), 'unavailable is never $0');
      assert.ok(!block.includes('data-budget-funding-contribution="published"'),
        'no contribution figure renders');
    });
  } finally { resetSlice11State(); }
});

check('P9/P10: residual pay-period case cannot substitute another payday and fails closed', () => {
  resetSlice11State();
  try {
    // Sep 28 opening: the first row is the residual Sep 28–Oct 8 whose
    // underlying cycle payday (Sep 25) predates the Forecast opening, so
    // the funding schedule publishes no Sep 25 row.
    const plan = slice11Plan('2026-09-28');
    const src = slice11Src(plan, 140, slice11Debts);
    const { schedule } = engineFundingRow(plan, 140, '2026-10-09');
    assert.ok(!(schedule.paydays || []).some(r => r && r.payday === '2026-09-25'),
      'engine publishes no Sep 25 funding row from the Sep 28 opening');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-09-25');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    assert.ok(html.includes('Sep 28'), 'the residual row keeps its truthful window identity');
    const block = fundingBlock(html);
    assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
      'the residual funding plan fails closed');
    assert.ok(block.includes('Funding plan for this payday is unavailable from the current Forecast opening.'),
      'the truthful unavailable copy renders');
    assert.ok(!block.includes('data-budget-funding-contribution="published"'),
      'no contribution figure renders for the residual');
    assert.ok(!block.includes(money(1400)),
      'the Oct 9 payday plan is never substituted into the residual view');
    assert.ok(!block.includes('$0.00'), 'the residual is never shown as $0');
  } finally { resetSlice11State(); }
});

check('P11: estimated funding trust remains estimated', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25', true);
    const src = slice11Src(plan, 140, slice11Debts);
    const { schedule } = engineFundingRow(plan, 140, '2026-10-09');
    assert.equal(schedule.fundingTrust, 'estimated', 'engine publishes estimated schedule trust');
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
    assert.ok(block.includes('trust-tag trust-estimated'),
      'funding figures carry the estimate tag');
    assert.ok(!block.includes('>calculated<'),
      'estimated funding trust is never promoted to calculated');
  } finally { resetSlice11State(); }
});

check('P12: unknown/unrecognized trust fails closed', () => {
  for (const badTrust of ['unknown', 'banana', undefined]) {
    resetSlice11State();
    try {
      const plan = slice11Plan('2026-09-25');
      const src = slice11Src(plan, 140, slice11Debts);
      enterDrilldown(src, '2026-10');
      selectPayPeriod('2026-10-09');
      withDoctoredSchedule(src, doctored => { doctored.fundingTrust = badTrust; }, () => {
        const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
        assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
          `fundingTrust ${String(badTrust)} fails the funding plan closed`);
        assert.ok(!block.includes('data-budget-funding-contribution="published"'),
          'no figure renders under unknown/unrecognized trust');
      });
    } finally { resetSlice11State(); }
  }
});

check('P13: malformed amounts cannot coerce false, "", null or strings into currency', () => {
  for (const bad of [false, '', null, '1400']) {
    resetSlice11State();
    try {
      const plan = slice11Plan('2026-09-25');
      const src = slice11Src(plan, 140, slice11Debts);
      enterDrilldown(src, '2026-10');
      selectPayPeriod('2026-10-09');
      withDoctoredSchedule(src, doctored => {
        doctored.paydays.find(r => r && r.payday === '2026-10-09').contribution = bad;
      }, () => {
        const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
        assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
          `contribution ${JSON.stringify(bad)} fails closed`);
        assert.ok(!block.includes('$0.00'), 'malformed is never $0');
      });
    } finally { resetSlice11State(); }
  }
});

check('P14: named allocation with malformed amount fails closed rather than disappearing or rendering $0', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    withDoctoredSchedule(src, doctored => {
      doctored.paydays.find(r => r && r.payday === '2026-10-09').allocations[0].amount = false;
    }, () => {
      const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
      assert.ok(block.includes(money(1400)),
        'the contribution is independent of the lines and still reprints exactly');
      assert.ok(block.includes('data-budget-funding-allocation="unavailable"'),
        'the malformed allocation fails closed visibly');
      assert.ok(block.includes('Not $0.'), 'the malformed allocation is never $0');
      assert.ok(block.includes(money(500)),
        'the valid sibling allocation still renders');
    });
  } finally { resetSlice11State(); }
});

check('A1 (Systems Review 5353073945): a missing or non-array allocations collection fails closed — bad publication, never "no allocations"', () => {
  // Forecast's contract always publishes allocations as an array on each
  // payday row. Showing the trusted contribution with no named purposes
  // and no warning would make an incomplete answer look complete.
  for (const badAlloc of [null, 'Fusion tournament', 1400, {}]) {
    resetSlice11State();
    try {
      const plan = slice11Plan('2026-09-25');
      const src = slice11Src(plan, 140, slice11Debts);
      enterDrilldown(src, '2026-10');
      selectPayPeriod('2026-10-09');
      withDoctoredSchedule(src, doctored => {
        doctored.paydays.find(r => r && r.payday === '2026-10-09').allocations = badAlloc;
      }, () => {
        const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
        assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
          `allocations ${JSON.stringify(badAlloc)} fails the funding plan closed`);
        assert.ok(block.includes('This is not $0'), 'bad publication is never $0');
        assert.ok(!block.includes('data-budget-funding-contribution="published"'),
          'the trusted $1,400 does not render without its named purposes');
      });
    } finally { resetSlice11State(); }
  }
  // A deleted collection is the same bad-publication state.
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    withDoctoredSchedule(src, doctored => {
      delete doctored.paydays.find(r => r && r.payday === '2026-10-09').allocations;
    }, () => {
      const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
      assert.ok(block.includes('data-budget-drilldown-funding-plan="unavailable"'),
        'a deleted allocations collection fails closed');
      assert.ok(!block.includes('data-budget-funding-contribution="published"'),
        'no trusted figure renders without its published purposes');
    });
  } finally { resetSlice11State(); }
  // A genuine $0 contribution with a published empty collection renders
  // normally — [] is the contract's legitimate "no allocations" state,
  // and the page never reconciles the collection against the figure.
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-23');
    withDoctoredSchedule(src, doctored => {
      const row = doctored.paydays.find(r => r && r.payday === '2026-10-23');
      row.contribution = 0;
      row.allocations = [];
    }, () => {
      const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src));
      assert.ok(block.includes('data-budget-funding-contribution="published"'),
        'a $0 contribution with allocations: [] renders as a known figure');
      assert.ok(block.includes(money(0)), 'the known zero renders as $0.00');
      assert.ok(!block.includes('data-budget-drilldown-funding-plan="unavailable"'),
        'the legitimate empty collection does not fail closed');
    });
  } finally { resetSlice11State(); }
});

check('P15: active input change recomputes both trajectory and funding schedule from the same input set', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src140 = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src140, '2026-10');
    selectPayPeriod('2026-10-09');
    P.budgetPayPeriodDrilldownHtml(src140);
    const trajKey140 = evalInPage('budgetTrajectoryCacheKey');
    const schedKey140 = evalInPage('budgetMonthScheduleCacheKey');
    assert.ok(trajKey140 && schedKey140, 'both caches keyed after the first render');
    assert.equal(schedKey140, trajKey140,
      'the funding schedule shares the trajectory input key — same input set');
    const src200 = slice11Src(plan, 200, slice11Debts);
    enterDrilldown(src200, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src200));
    const trajKey200 = evalInPage('budgetTrajectoryCacheKey');
    const schedKey200 = evalInPage('budgetMonthScheduleCacheKey');
    assert.ok(trajKey200 !== trajKey140, 'the trajectory is recomputed for the new weekly input');
    assert.ok(schedKey200 !== schedKey140, 'the funding schedule is recomputed, never served stale');
    assert.equal(schedKey200, trajKey200, 'recomputed schedule still shares the trajectory input key');
    assert.ok(block.includes('data-budget-funding-contribution="published"'),
      'the funding plan still renders from the recomputed schedule');
  } finally { resetSlice11State(); }
});

check('P16: Slice 10 money map remains unchanged', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    assert.ok(html.includes('data-budget-drilldown-money-map="2026-10-09"'),
      'the Slice 10 money map still renders for the selected period');
    assert.ok(html.includes('Total income'), 'the money-map components are intact');
    const ladderEnd = html.indexOf('data-budget-drilldown-money-map=');
    const ladder = html.slice(0, ladderEnd);
    assert.equal((ladder.match(/data-budget-drilldown-stage=/g) || []).length, 3,
      'the Slice 9 ladder still shows exactly the three published stages');
    const mapAt = html.indexOf('data-budget-drilldown-money-map=');
    const fundingAt = html.indexOf('data-budget-drilldown-funding-plan=');
    assert.ok(fundingAt > mapAt, 'the funding plan follows the money map without displacing it');
  } finally { resetSlice11State(); }
});

check('P17: Slice 9 Month <-> Pay Period anchor/navigation remains unchanged', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    assert.equal(evalInPage('budgetPayPeriodAnchorMonth'), '2026-10',
      'the pay-period anchor still follows the selected month');
    const html = P.budgetPayPeriodDrilldownHtml(src);
    assert.ok(html.includes('data-budget-drilldown-picker'), 'the period picker still renders');
    assert.ok(html.includes('2026-10-09') && html.includes('2026-10-23'),
      'the picker still lists the published pay periods');
    enterDrilldown(src, '2026-11');
    assert.equal(evalInPage('budgetPayPeriodAnchorMonth'), '2026-11',
      'month-to-pay-period navigation still re-anchors');
  } finally { resetSlice11State(); }
});

check('P18: default current-payday shell remains unchanged', () => {
  const shellSrc = P.paydayInstructionShellHtml.toString();
  assert.ok(!shellSrc.includes('budget-drilldown-funding-plan'),
    'the default payday shell does not carry the drilldown funding plan');
  assert.ok(/earmark/i.test(shellSrc), 'the Slice 2 earmark wording is intact');
});

check('P19: no transfer language or reserve-balance claim', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src)).toLowerCase();
    for (const phrase of ['transfer $', 'transferring', 'move $', 'move money to',
        'already saved', 'already set aside', 'set aside', 'nest money balance',
        'you have $', 'reserved', 'reserve balance', 'withdraw']) {
      assert.ok(!block.includes(phrase), `no transfer/reserve language: "${phrase}"`);
    }
    assert.ok(block.includes('earmarked in forecast'), 'the allowed earmark wording is used');
    assert.ok(block.includes('funding plan'), 'the allowed funding-plan wording is used');
  } finally { resetSlice11State(); }
});

check('P20: no page ranking, prioritisation, affordability or recommendation', () => {
  resetSlice11State();
  try {
    const plan = slice11Plan('2026-09-25');
    const src = slice11Src(plan, 140, slice11Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const block = fundingBlock(P.budgetPayPeriodDrilldownHtml(src)).toLowerCase();
    for (const phrase of ['priorit', 'afford', 'recommend', 'should ', 'skip ',
        'reduce', 'cut back', 'caused by', 'because of', 'safe to spend']) {
      assert.ok(!block.includes(phrase), `no ranking/prescription language: "${phrase}"`);
    }
  } finally { resetSlice11State(); }
});

console.log(`\nSlice 11 funding plan: ${checks} checks passed.`);
