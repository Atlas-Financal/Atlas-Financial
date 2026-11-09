'use strict';
/* AMANDA SLICE 10 — SELECTED PAY-PERIOD MONEY MAP.
 *
 * Slice 9 lets Amanda select a Forecast-published pay-period row. Slice 10
 * explains what is inside that row's three-stage result: the money map
 * reprints the Forecast-published component totals (income, household
 * budget, bills, obligations, commitments, extras) and, when Forecast
 * publishes them, the component line items in Forecast publication order —
 * for the exact selected row, never a re-lookup by cycle dates.
 *
 * Authority boundary: the page selects, labels, formats and reprints. It
 * never subtracts, never sums lines into a total, never derives a missing
 * total, never classifies a payment, never names a debt target Forecast did
 * not publish (stage3.extras carries an amount only), never promotes line
 * trust to the parent, and never explains or prescribes — no causal
 * language. Unavailable is never $0.
 *
 * Proof map (owner brief):
 *   P1  exact selected-period identity (full-cycle row)
 *   P2  residual identity — residual figures, never full-cycle substitution
 *   P3  Stage 1 component reprint matches Forecast exactly
 *   P4  Stage 2 commitments: total matches, lines in order, total not computed
 *   P5  Stage 3 extras: amount matches, not calculated or chosen page-side
 *   P6  no invented debt target on the extras figure
 *   P7  named debt attribution omitted when the publication has none
 *   P8  lines vs total: a non-reconciling fixture is reprinted, never "fixed"
 *   P9  trust: estimated stays estimated, line trust not promoted, no $0
 *   P10 missing lines: total shown, no lines invented
 *   P11 one unavailable component fails closed; others survive
 *   P12 active-input identity: weekly override recomputes the map
 *   P13 no financial arithmetic in the new page code
 *   P14 no causal / recommendation language
 *   P15 Slice 9 navigation regression (October round trip with the map)
 *   P16 existing Month surface unchanged
 *
 * `node test/test-budget-month-pay-period-money-map.js`
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
function slice10Plan(asOf) {
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
        date: '2026-10-18', confidence: 'confirmed' },
    ],
  };
}

// A focus debt exists elsewhere (Slice 6 publishes a target) — the map must
// never join the extras figure to it.
const slice10Debts = [{ id: 'travel-visa', label: 'Travel Visa', balance: 5200 }];

function slice10Src(plan, weekly, debts) {
  return { plan, debts: debts || [], asOf: plan.opening.asOf, weekly,
    periods: null, revolvingExtra: null, liveOverlay: null };
}

function resetSlice10State() {
  evalInPage(`budgetGranularity = 'pay-period';`);
  evalInPage(`budgetSelectedMonth = null;`);
  evalInPage(`budgetPayPeriodAnchorMonth = null;`);
  evalInPage(`budgetDrilldownPayPeriod = null;`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
}

function enterDrilldown(src, selectedMonth) {
  evalInPage(`budgetGranularity = 'month';`);
  evalInPage(`budgetSelectedMonth = '${selectedMonth}';`);
  evalInPage('budgetTrajectoryCache = null; budgetTrajectoryCacheKey = null;');
  P.budgetMonthViewHtml(src);
  evalInPage(`budgetPayPeriodAnchorMonth = budgetSelectedMonth;`);
  evalInPage(`budgetGranularity = 'pay-period';`);
}

function selectPayPeriod(payday) {
  evalInPage(`budgetDrilldownPayPeriod = '${payday}';`);
}

// The engine row, independent of the page.
function engineRow(plan, weekly, payday, debts) {
  const traj = F.baselineTrajectory(plan, debts || [], plan.opening.asOf,
    { weeklyVariable: weekly });
  assert.equal(traj.status, 'ready', 'engine fixture trajectory is ready');
  const row = (traj.payPeriods || []).find(p => p.payday === payday);
  assert.ok(row, `engine publishes row ${payday}`);
  return row;
}

// The money-map slice of the full drilldown HTML.
function drilldownMapHtml(src) {
  const html = P.budgetPayPeriodDrilldownHtml(src);
  const at = html.indexOf('data-budget-drilldown-money-map=');
  assert.ok(at !== -1, 'the money map renders inside the drilldown');
  return html.slice(at);
}

// ------------------------------------------------------------------- P1 ----
check('P1: every map figure belongs to the exact selected full-cycle row', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    assert.equal(row.windowKind, 'full-cycle');
    const map = drilldownMapHtml(src);
    assert.ok(map.startsWith('data-budget-drilldown-money-map="2026-10-09"'),
      'map is keyed to the exact selected row identity');
    assert.ok(map.includes('What is inside Oct 9–Oct 22'),
      'map names the truthful full-cycle window');
    for (const [label, comp] of [
      ['Total income', row.stage1.income],
      ['Regular household spending', row.stage1.householdBudget],
      ['Bills', row.stage1.bills],
      ['Required debt payments', row.stage1.obligations],
      ['Planned spending', row.stage2.commitments],
      ['Planned extra debt payment', row.stage3.extras],
    ]) {
      assert.ok(map.includes(label), `map shows ${label}`);
      assert.ok(map.includes(money(comp.amount)),
        `${label} reprints the row's published ${money(comp.amount)}`);
    }
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------- P2 ----
check('P2: a mid-cycle residual shows residual figures, never the full-cycle row', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan('2026-09-28'); // trajectory starts mid-cycle
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-09-25'); // the residual row, keyed by payday
    const residual = engineRow(plan, 140, '2026-09-25', slice10Debts);
    assert.equal(residual.windowKind, 'as-of-residual');
    assert.equal(residual.rangeLabel, 'Sep 28–Oct 8');
    const fullCycle = engineRow(slice10Plan('2026-09-25'), 140, '2026-09-25', slice10Debts);
    assert.equal(fullCycle.windowKind, 'full-cycle');
    assert.notEqual(residual.stage1.income.amount, fullCycle.stage1.income.amount,
      'fixture: residual and full-cycle incomes differ, so substitution is detectable');
    const map = drilldownMapHtml(src);
    assert.ok(map.includes('What is inside Sep 28–Oct 8'),
      'map names the residual window, not the cycle');
    assert.ok(!map.includes('Sep 25–Oct 8'),
      'the full-cycle range never appears in the residual map');
    assert.ok(map.includes(money(residual.stage1.income.amount)),
      'map reprints the residual income figure');
    assert.ok(!map.includes(money(fullCycle.stage1.income.amount)),
      'the full-cycle income figure is not substituted into the residual map');
    assert.ok(map.includes(money(residual.stage1.householdBudget.amount)),
      'map reprints the residual household-budget figure');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------- P3 ----
check('P3: Stage 1 components are exact Forecast reprints', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    const map = drilldownMapHtml(src);
    assert.ok(map.includes(money(row.stage1.income.amount)), 'income exact');
    assert.ok(map.includes(money(row.stage1.householdBudget.amount)), 'household budget exact');
    assert.ok(map.includes(money(row.stage1.bills.amount)), 'bills exact');
    assert.ok(map.includes(money(row.stage1.obligations.amount)), 'obligations exact');
    assert.ok(map.includes(money(row.stage1.result.amount)), 'stage 1 result exact');
    // Named lines appear in Forecast publication order.
    const fusionAt = map.indexOf('Fusion tournament');
    const taxAt = map.indexOf('Property tax contribution');
    assert.ok(fusionAt !== -1 && taxAt !== -1 && fusionAt < taxAt,
      'commitment lines reprinted in Forecast order');
    assert.ok(map.includes('BC Hydro'), 'estimated bill line reprinted');
    assert.ok(map.includes('Travel Visa minimum'), 'obligation line reprinted');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------- P4 ----
check('P4: commitments total is reprinted, never computed from lines', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    const map = drilldownMapHtml(src);
    assert.ok(map.includes(money(row.stage2.commitments.amount)),
      'commitments total reprints the published figure');
    // Behavioural proof the page does not sum lines: a deliberately
    // non-reconciling component keeps its published total.
    const bad = { amount: 1000, status: 'calculated',
      lines: [
        { label: 'Line A', amount: 600, status: 'calculated' },
        { label: 'Line B', amount: 500, status: 'calculated' },
      ] };
    const html = P.budgetDrilldownComponentHtml('Planned spending', bad);
    assert.ok(html.includes(money(1000)), 'published total shown');
    assert.ok(!html.includes(money(1100)), 'page does not sum lines into a total');
    assert.ok(html.includes('Line A') && html.includes('Line B'),
      'lines still reprinted verbatim');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------- P5 ----
check('P5: extras amount is reprinted, not calculated or chosen page-side', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    const map = drilldownMapHtml(src);
    assert.ok(map.includes(money(row.stage3.extras.amount)),
      'extras amount reprints the published figure');
    assert.ok(map.includes(money(row.stage3.result.amount)),
      'stage 3 result reprints the published figure');
  } finally { resetSlice10State(); }
});

// ---------------------------------------------------------------- P6 + P7 --
check('P6/P7: the extras figure never gains an invented debt target', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts); // focus debt present
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    assert.ok(!('target' in row.stage3.extras) && !('debtId' in row.stage3.extras),
      'contract check: Forecast publishes no target attribution on extras');
    const extrasHtml = P.budgetDrilldownComponentHtml(
      'Planned extra debt payment', row.stage3.extras);
    assert.ok(extrasHtml.includes('Planned extra debt payment'),
      'truthful amount-only label renders');
    assert.ok(extrasHtml.includes(money(row.stage3.extras.amount)),
      'published amount renders');
    assert.ok(!extrasHtml.includes('Travel Visa'),
      'the Slice 6 focus debt is not joined to the extras figure');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------- P8 ----
check('P8: line items are reprints; the page never reconciles them', () => {
  const comp = { amount: 1400, status: 'calculated', lines: [
    { id: 'fusion', label: 'Fusion tournament', amount: 900, status: 'calculated' },
    { id: 'proptax', label: 'Property tax contribution', amount: 500, status: 'calculated' },
  ] };
  const html = P.budgetDrilldownComponentHtml('Planned spending', comp);
  assert.ok(html.indexOf('Fusion tournament') < html.indexOf('Property tax contribution'),
    'publication order preserved');
  const skewed = { amount: 1400, status: 'calculated', lines: [
    { label: 'Only line', amount: 1, status: 'calculated' },
  ] };
  const html2 = P.budgetDrilldownComponentHtml('Planned spending', skewed);
  assert.ok(html2.includes(money(1400)), 'published total kept when lines disagree');
  assert.ok(!html2.includes(money(1) + '</span></div><div'), 'no recomputed total');
});

// ------------------------------------------------------------------- P9 ----
check('P9: trust is reprinted per figure, never promoted, never $0', () => {
  // A weaker line under a stronger parent keeps its own weaker tag.
  const comp = { amount: 100, status: 'calculated', lines: [
    { label: 'Estimated line', amount: 100, status: 'estimated' },
  ] };
  const html = P.budgetDrilldownComponentHtml('Bills', comp);
  const totalRow = html.slice(0, html.indexOf('Estimated line'));
  const lineRow = html.slice(html.indexOf('Estimated line'));
  assert.ok(!totalRow.includes('estimate'), 'calculated total not weakened by its line');
  assert.ok(lineRow.includes('estimate'), 'estimated line keeps its estimate tag');
  // Estimated parent stays estimated.
  const est = { amount: 90, status: 'estimated', lines: [] };
  assert.ok(P.budgetDrilldownComponentHtml('Bills', est).includes('estimate'),
    'estimated component stays estimated');
  // Unavailable is never $0.
  const un = P.budgetDrilldownComponentHtml('Bills', { status: 'unavailable', reason: 'x' });
  assert.ok(un.includes('unavailable') && un.includes('Not $0'), 'fails closed');
  assert.ok(!un.includes('$0.00'), 'no zero figure');
  const noAmount = P.budgetDrilldownLineHtml({ label: 'Ghost line', status: 'estimated' });
  assert.ok(noAmount.includes('unavailable') && !noAmount.includes('$0.00'),
    'line without an amount fails closed');
});

// ------------------------------------------------------------------ P10 ----
check('P10: a published total with no lines shows the total, invents nothing', () => {
  const html = P.budgetDrilldownComponentHtml(
    'Planned extra debt payment', { amount: 400, status: 'calculated' });
  assert.ok(html.includes(money(400)), 'total appears');
  assert.ok(!html.includes('data-budget-drilldown-line="named"'), 'no lines invented');
});

// ------------------------------------------------------------------ P11 ----
check('P11: one unavailable component fails closed; the rest survive', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    const broken = Object.assign({}, row, {
      stage1: Object.assign({}, row.stage1, {
        bills: { status: 'unavailable', reason: 'Forecast could not read bills.' },
      }),
    });
    const map = P.budgetPayPeriodMoneyMapHtml(broken);
    assert.ok(map.includes('Bills') && map.includes('unavailable'),
      'bills fails closed visibly');
    assert.ok(map.includes('Not $0'), 'never $0');
    assert.ok(map.includes(money(row.stage1.income.amount)),
      'income survives beside the failed component');
    assert.ok(map.includes(money(row.stage2.commitments.amount)),
      'planned spending survives beside the failed component');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------ P12 ----
check('P12: an active input change recomputes the map from the same trajectory', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src140 = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src140, '2026-10');
    selectPayPeriod('2026-10-09');
    const map140 = drilldownMapHtml(src140);
    resetSlice10State();
    const src200 = slice10Src(plan, 200, slice10Debts);
    enterDrilldown(src200, '2026-10');
    selectPayPeriod('2026-10-09');
    const map200 = drilldownMapHtml(src200);
    const row200 = engineRow(plan, 200, '2026-10-09', slice10Debts);
    assert.ok(map200.includes(money(row200.stage1.householdBudget.amount)),
      'map uses the recomputed trajectory household budget');
    assert.ok(map140 !== map200, 'the map is not stale across input changes');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------ P13 ----
check('P13: the new page code performs no financial arithmetic', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
  const start = src.indexOf('function budgetDrilldownLineHtml');
  const end = src.indexOf('function budgetPayPeriodDrilldownHtml');
  assert.ok(start !== -1 && end !== -1 && end > start, 'new code block located');
  const block = src.slice(start, end);
  assert.ok(!block.includes('.reduce('), 'no line-item summation');
  assert.ok(!/amount\s*[-*\/]\s/.test(block), 'no amount subtraction/multiplication/division');
  // AMANDA SLICE 13 contract change (owner-authorized): the map now reprints
  // Forecast-published allocation lines, so it reads line.debtId for shape
  // and duplicate-identity validation only. It must never resolve a debt id
  // to a label itself — labels reprint from the publication, proved
  // behaviorally by the Slice 13 suite (label fidelity check).
  assert.ok(!/\bdebts\b\s*\[/.test(block), 'no debt-registry index lookup');
  assert.ok(!/\.find\s*\(\s*(d|debt)/.test(block), 'no debt-registry find lookup');
  assert.ok(!block.includes('debtById') && !block.includes('debtMap'),
    'no debt-registry map lookup');
});

// ------------------------------------------------------------------ P14 ----
check('P14: no causal or recommendation language in the money map', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const map = drilldownMapHtml(src);
    const banned = /\b(caused|causing|cut |reduce |reducing|skip |skipping|afford|safe to spend|you should|tight|blame|instead of)\b/i;
    assert.ok(!banned.test(map), 'no causal or prescriptive wording');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------ P15 ----
check('P15: October -> Pay Period -> cross-boundary row -> map -> Month still October', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-09-25'); // cross-boundary full cycle
    const map = drilldownMapHtml(src);
    assert.ok(map.includes('What is inside Sep 25–Oct 8'), 'map for the cross-boundary row');
    evalInPage(`budgetGranularity = 'month';`);
    const monthHtml = P.budgetMonthViewHtml(src);
    assert.ok(monthHtml.includes('data-budget-month-view="2026-10"'),
      'Month lens still October after inspecting the map');
    assert.equal(evalInPage('budgetSelectedMonth'), '2026-10',
      'selected month untouched by period selection');
  } finally { resetSlice10State(); }
});

// ------------------------------------------------------------------ P16 ----
check('P16: the Month lens component surface is unchanged', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    evalInPage(`budgetGranularity = 'month';`);
    evalInPage(`budgetSelectedMonth = '2026-10';`);
    const html = P.budgetMonthViewHtml(src);
    for (const label of ['Total income', 'Regular household spending', 'Bills',
      'Required debt payments', 'Planned spending', 'Planned extra debt payment']) {
      assert.ok(html.includes(label), `Month lens still shows ${label}`);
    }
    assert.ok(!html.includes('data-budget-drilldown-money-map'),
      'the money map is drilldown-only');
  } finally { resetSlice10State(); }
});

// ---------------------------------------------------------------- Adversarial -
// Systems Review BLOCKING (PR #448, head befc66c): the money map must fail
// closed on malformed data — no coercion of false/""/null into $0.00, no
// bare currency without an explicit published trust state, no silent
// omission of unavailable or malformed figures.
check('A1: coerced-falsy line amounts never become $0.00', () => {
  for (const bad of [false, '', null, undefined, NaN, '123.45', Infinity]) {
    const html = P.budgetDrilldownLineHtml({ label: 'Bad line', amount: bad, status: 'estimated' });
    assert.ok(html.includes('unavailable') && html.includes('Not $0'),
      `line amount ${String(bad)} fails closed`);
    assert.ok(!html.includes('$0.00'), `line amount ${String(bad)} never renders $0.00`);
  }
});

check('A2: a line without an explicit published trust state never renders bare currency', () => {
  for (const line of [
    { label: 'No trust', amount: 123.45 },
    { label: 'Bogus trust', amount: 123.45, status: 'bogus' },
    { label: 'Unavailable trust', amount: 123.45, status: 'unavailable' },
  ]) {
    const html = P.budgetDrilldownLineHtml(line);
    assert.ok(!html.includes('$123.45'), `${line.label}: no bare currency`);
    assert.ok(html.includes('unavailable'), `${line.label}: fails closed`);
  }
});

check('A3: present-but-malformed lines render unavailable; genuinely absent lines render nothing', () => {
  const comp = { amount: 100, status: 'calculated', lines: [null, {}, { label: 'Ghost' }, { label: 'Priceless', amount: 5 }] };
  const html = P.budgetDrilldownComponentHtml('Bills', comp);
  assert.equal((html.match(/data-budget-drilldown-line="unavailable"/g) || []).length, 4,
    'each malformed line entry fails closed visibly, none silently dropped');
  assert.ok(!html.includes('$5.00'), 'the trust-less line does not render bare currency');
  assert.ok(html.includes(money(100)), 'the valid component total still reprints');
  const noLines = P.budgetDrilldownComponentHtml('Bills', { amount: 100, status: 'calculated' });
  assert.ok(!noLines.includes('data-budget-drilldown-line='),
    'genuinely absent lines invent no rows');
});

check('A4: malformed component amounts and missing trust fail closed', () => {
  const badAmount = P.budgetDrilldownComponentHtml('Bills', { amount: false, status: 'estimated' });
  assert.ok(badAmount.includes('unavailable') && badAmount.includes('Not $0'), 'false amount fails closed');
  assert.ok(!badAmount.includes('$0.00'), 'false amount never becomes $0.00');
  const noTrust = P.budgetDrilldownComponentHtml('Bills', { amount: 100 });
  assert.ok(!noTrust.includes('$100.00'), 'no bare currency without trust');
  assert.ok(noTrust.includes('unavailable'), 'missing trust fails closed');
  const bogusTrust = P.budgetDrilldownComponentHtml('Bills', { amount: 100, status: 'received' });
  assert.ok(!bogusTrust.includes('$100.00'), 'unrecognized trust never renders currency');
});

check('A5: malformed stage results fail closed', () => {
  const badAmount = P.budgetDrilldownStageHtml({ label: 'Normal life',
    result: { amount: false, status: 'estimated' } });
  assert.ok(badAmount.includes('unavailable'), 'false stage amount fails closed');
  assert.ok(!badAmount.includes('$0.00'), 'false stage amount never renders $0.00 projected balance');
  const noTrust = P.budgetDrilldownStageHtml({ label: 'Normal life',
    result: { amount: 100, status: 'whatever' } });
  assert.ok(noTrust.includes('unavailable'), 'stage without explicit trust fails closed');
  assert.ok(!noTrust.includes('$100.00'), 'no bare stage currency');
});

check('A6: explicitly unavailable extras renders its reason, never silence', () => {
  const row = { payday: '2026-10-09', rangeLabel: 'Oct 9–Oct 22', windowKind: 'full-cycle',
    stage1: { label: 'Normal life', result: { amount: 10, status: 'calculated' },
      income: { amount: 10, status: 'calculated' } },
    stage2: { label: 'After planned spending', result: { amount: 10, status: 'calculated' },
      commitments: { amount: 0, status: 'calculated' } },
    stage3: { label: 'After debt strategy', result: { amount: 10, status: 'calculated' },
      extras: { status: 'unavailable', reason: 'Forecast could not read extra-debt input.' } } };
  const map = P.budgetPayPeriodMoneyMapHtml(row);
  assert.ok(map.includes('Planned extra debt payment'), 'the extras row is present');
  assert.ok(map.includes('Forecast could not read extra-debt input.'), 'its reason is shown');
  assert.ok(map.includes('Not $0'), 'never $0');
});

check('A7: a malformed component inside a real map fails closed without destroying the rest', () => {
  try {
    resetSlice10State();
    const plan = slice10Plan();
    const src = slice10Src(plan, 140, slice10Debts);
    enterDrilldown(src, '2026-10');
    selectPayPeriod('2026-10-09');
    const row = engineRow(plan, 140, '2026-10-09', slice10Debts);
    const broken = Object.assign({}, row, {
      stage1: Object.assign({}, row.stage1, {
        bills: { amount: '', status: 'estimated' }, // malformed: coerces to 0 under Number()
        obligations: { amount: 150 }, // malformed: no trust state
      }),
    });
    const map = P.budgetPayPeriodMoneyMapHtml(broken);
    for (const label of ['Bills', 'Required debt payments']) {
      const at = map.indexOf(label);
      assert.ok(at !== -1, `${label} row is present`);
      const rowHtml = map.slice(at, at + 500);
      assert.ok(rowHtml.includes('unavailable'), `${label} fails closed visibly`);
      assert.ok(!rowHtml.includes('$0.00'),
        `${label}: the malformed amount never becomes $0.00`);
    }
    assert.ok(map.includes(money(row.stage1.income.amount)), 'income survives');
  } finally { resetSlice10State(); }
});

console.log(`\nSlice 10 money map: ${checks} checks passed.`);
