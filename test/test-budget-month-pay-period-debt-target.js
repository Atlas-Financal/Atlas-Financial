// AMANDA SLICE 13 — SELECTED PAY-PERIOD DEBT TARGET ATTRIBUTION (PAGE).
//
// Deterministic proof that the pay-period money map renders Forecast's
// stage3.extras.allocations as a pure reprint layer: the published amount
// stays authoritative (never summed from lines), lines render in Forecast
// order with Forecast-owned labels and trust, known $0 never invents a
// target, and any malformed or incomplete allocation publication fails
// the attribution closed as a whole — never a partial target list.
//
// The end-to-end checks run the real Forecast trajectory and prove exact
// selected-pay-period identity: only the period containing the extra event
// carries its attribution, and a later period shows its own next target.
//
// Run: node test/test-budget-month-pay-period-debt-target.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..');
const planPath = path.join(repoRoot, 'public', 'plan.js');
const forecastPath = path.join(repoRoot, 'public', 'forecast.js');
const planSource = fs.readFileSync(planPath, 'utf8');

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label}\n    ${e.message}`);
  }
};

function makeContext() {
  const Forecast = require(forecastPath);
  const context = vm.createContext({ escapeHtml: require('./app-escape-html'),
    Forecast,
    money2: n => '$' + Number(n).toFixed(2),
    fmtDateLong: iso => iso,
  });
  vm.runInContext(planSource, context);
  const P = {};
  for (const name of ['budgetPayPeriodMoneyMapHtml']) {
    P[name] = vm.runInContext(name, context);
  }
  return P;
}

const P = makeContext();
const money = n => '$' + Number(n).toFixed(2);

function periodWith(extras) {
  return {
    payday: '2026-01-02',
    start: '2026-01-02',
    end: '2026-01-15',
    stage3: {
      id: 'after-debt-strategy',
      label: 'After debt strategy',
      status: 'calculated',
      extras,
      result: { amount: 0, status: 'calculated' },
    },
  };
}

function validAllocations() {
  return [
    { debtId: 'tri', label: 'Triangle Mastercard', amount: 201.65, status: 'calculated' },
    { debtId: 'mbna', label: 'MBNA Mastercard', amount: 798.35, status: 'calculated' },
  ];
}

// ------------------------------------------------------------ positive ----
check('positive attribution renders every line in Forecast order', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: validAllocations(),
  }));
  assert.ok(html.includes('Going to'), 'attribution section present');
  assert.ok(html.includes('Triangle Mastercard'), 'first target label reprinted');
  assert.ok(html.includes('MBNA Mastercard'), 'second target label reprinted');
  assert.ok(html.indexOf('Triangle Mastercard') < html.indexOf('MBNA Mastercard'),
    'Forecast publication order preserved');
  assert.ok(html.includes(money(201.65)) && html.includes(money(798.35)),
    'allocation amounts reprinted exactly');
  assert.ok(html.includes(money(1000)), 'published total renders');
});

check('the published amount stays authoritative; the page never sums lines', () => {
  // Deliberately non-reconciling: lines sum to 990, amount publishes 1000.
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: [
      { debtId: 'tri', label: 'Triangle Mastercard', amount: 200, status: 'calculated' },
      { debtId: 'mbna', label: 'MBNA Mastercard', amount: 790, status: 'calculated' },
    ],
  }));
  assert.ok(html.includes(money(1000)), 'published total unchanged');
  assert.ok(!html.includes(money(990)), 'no summed total invented');
});

check('nextTarget renders Forecast continuity once the touched debts clear', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: validAllocations(),
    nextTarget: { debtId: 'visa', label: 'Travel Visa', status: 'calculated' },
  }));
  assert.ok(html.includes('After MBNA Mastercard clears'),
    'continuity follows the last allocation debt');
  assert.ok(html.includes('Travel Visa'), 'Forecast next target reprinted');
});

check('null nextTarget omits the continuity line', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: validAllocations(), nextTarget: null,
  }));
  assert.ok(!html.includes('clears'), 'no continuity invented');
});

check('malformed nextTarget omits the line but keeps the allocations', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: validAllocations(),
    nextTarget: { debtId: 'visa', label: '', status: 'calculated' },
  }));
  assert.ok(html.includes('Triangle Mastercard'), 'valid allocations still render');
  assert.ok(!html.includes('clears'), 'malformed continuity omitted, not repaired');
});

check('trust propagates per line; estimated stays estimated', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'estimated', source: 'plan.defaults.extraDebtMonthly',
    allocations: [
      { debtId: 'tri', label: 'Triangle Mastercard', amount: 201.65, status: 'calculated' },
      { debtId: 'mbna', label: 'MBNA Mastercard', amount: 798.35, status: 'estimated' },
    ],
  }));
  assert.ok(html.includes('estimate'), 'estimated line keeps its trust tag');
  assert.ok(html.includes('calculated'), 'calculated line keeps its trust tag');
});

check('labels reprint from the publication; no debt-id resolution page-side', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: [
      { debtId: 'tri', label: 'A Completely Different Name', amount: 1000, status: 'calculated' },
    ],
  }));
  assert.ok(html.includes('A Completely Different Name'),
    'the Forecast-published label renders verbatim');
  assert.ok(!html.includes('Triangle Mastercard'),
    'the page does not resolve the debt id to its own label');
});

// ---------------------------------------------------------------- zero ----
check('known $0 never invents a debt target', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 0, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
  }));
  assert.ok(html.includes('No extra debt payment planned in this pay period.'),
    'explicit zero wording');
  assert.ok(!html.includes('Going to'), 'no attribution section');
  assert.ok(!html.includes('Triangle Mastercard'), 'no target invented');
});

check('known $0 with bogus allocations still shows no target', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 0, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
    allocations: validAllocations(),
  }));
  assert.ok(html.includes('No extra debt payment planned in this pay period.'),
    'zero statement wins');
  assert.ok(!html.includes('Triangle Mastercard'), 'allocations ignored on known zero');
});

// ------------------------------------------------------- fail closed ----
check('missing allocations fail the attribution closed; amount still renders', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
  }));
  assert.ok(html.includes(money(1000)), 'published total still renders');
  assert.ok(html.includes('Forecast did not publish which debt this payment goes to'),
    'explicit unavailable attribution');
  assert.ok(html.includes('Not $0'), 'unavailable is not $0');
});

for (const [name, allocations] of [
  ['null', null],
  ['non-array', 'tri'],
  ['empty array', []],
]) {
  check(`allocations ${name} fail closed`, () => {
    const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
      amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
      allocations,
    }));
    assert.ok(html.includes('Forecast did not publish which debt this payment goes to'),
      'unavailable attribution');
    assert.ok(!html.includes('Triangle Mastercard'), 'no partial target list');
  });
}

const malformedLines = [
  ['null debtId', [{ debtId: null, label: 'Triangle Mastercard', amount: 201.65, status: 'calculated' }]],
  ['numeric debtId', [{ debtId: 7, label: 'Triangle Mastercard', amount: 201.65, status: 'calculated' }]],
  ['empty label', [{ debtId: 'tri', label: '', amount: 201.65, status: 'calculated' }]],
  ['numeric-string amount', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: '201.65', status: 'calculated' }]],
  ['false amount', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: false, status: 'calculated' }]],
  ['NaN amount', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: NaN, status: 'calculated' }]],
  ['Infinity amount', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: Infinity, status: 'calculated' }]],
  ['bad trust', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: 201.65, status: 'verified' }]],
  ['missing trust', [{ debtId: 'tri', label: 'Triangle Mastercard', amount: 201.65 }]],
  ['duplicate identities', [
    { debtId: 'tri', label: 'Triangle Mastercard', amount: 500, status: 'calculated' },
    { debtId: 'tri', label: 'Triangle Mastercard', amount: 500, status: 'calculated' },
  ]],
  ['one bad line poisons the whole list', [
    { debtId: 'tri', label: 'Triangle Mastercard', amount: 201.65, status: 'calculated' },
    { debtId: 'mbna', label: '', amount: 798.35, status: 'calculated' },
  ]],
];
for (const [name, allocations] of malformedLines) {
  check(`malformed publication (${name}) fails closed as a whole`, () => {
    const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
      amount: 1000, status: 'calculated', source: 'plan.defaults.extraDebtMonthly',
      allocations,
    }));
    assert.ok(html.includes('Forecast did not publish which debt this payment goes to'),
      'unavailable attribution');
    assert.ok(!html.includes('Triangle Mastercard'),
      'no partial target list is shown as complete');
    assert.ok(html.includes(money(1000)), 'published total still renders');
  });
}

check('unavailable extras stay unavailable; no attribution section', () => {
  const html = P.budgetPayPeriodMoneyMapHtml(periodWith({
    status: 'unavailable', reason: 'Forecast could not read extra-debt input.',
  }));
  assert.ok(html.includes('unavailable'), 'unavailable component renders');
  assert.ok(!html.includes('Going to'), 'no attribution section on unavailable');
});

// --------------------------------------------- end-to-end identity ----
function e2ePlan() {
  return {
    windowDays: 91,
    startingCash: { amount: 20000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 1000 },
    income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly', anchor: '2026-01-02',
      amount: 2600, confidence: 'confirmed' }],
    obligations: [], bills: [], commitments: [],
    budget: { basis: 'ytd', categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
    ] },
    opening: { asOf: '2026-01-01' },
    nextDollar: { policy: 'true-surplus-highest-interest',
      eligibleDebts: 'revolving-cards-and-heloc', provenance: 'owner-stated' },
  };
}
function e2eDebts() {
  return [
    { id: 'tri', label: 'Triangle Mastercard', structure: 'Revolving card',
      balance: 200, pending: 0, rate: 19.99, minimumPayment: 25, paymentDay: 15,
      confidence: 'verified' },
    { id: 'mbna', label: 'MBNA Mastercard', structure: 'Revolving card',
      balance: 5000, pending: 0, rate: 12.99, minimumPayment: 100, paymentDay: 15,
      confidence: 'verified' },
  ];
}
function e2eTrajectory() {
  const Forecast = require(forecastPath);
  return Forecast.baselineTrajectory(e2ePlan(), e2eDebts(), '2026-01-01', { weeklyVariable: 400 });
}

check('end-to-end: only the period containing the extra event carries its attribution', () => {
  const traj = e2eTrajectory();
  assert.ok(traj.status === 'ready', 'trajectory ready');
  const withExtra = traj.payPeriods.find(pp =>
    pp.stage3 && pp.stage3.extras && pp.stage3.extras.amount > 0);
  assert.ok(withExtra, 'a pay period with an extra payment exists');
  const html = P.budgetPayPeriodMoneyMapHtml(withExtra);
  assert.ok(html.includes('Triangle Mastercard') && html.includes('MBNA Mastercard'),
    'the exact selected period shows both Forecast targets');
  assert.ok(html.includes(money(withExtra.stage3.extras.amount)),
    'the published total renders unchanged');
  const without = traj.payPeriods.find(pp =>
    pp !== withExtra && pp.stage3 && pp.stage3.extras
    && pp.stage3.extras.status === 'calculated' && pp.stage3.extras.amount === 0);
  assert.ok(without, 'a zero-extra period exists');
  const zeroHtml = P.budgetPayPeriodMoneyMapHtml(without);
  assert.ok(zeroHtml.includes('No extra debt payment planned in this pay period.'),
    'zero period states no plan');
  assert.ok(!zeroHtml.includes('Triangle Mastercard') && !zeroHtml.includes('MBNA Mastercard'),
    'no cross-period target leakage');
});

check('end-to-end: a later period shows its own next target, not the earlier one', () => {
  const traj = e2eTrajectory();
  const periods = traj.payPeriods.filter(pp =>
    pp.stage3 && pp.stage3.extras && pp.stage3.extras.amount > 0);
  assert.ok(periods.length >= 2, 'two extra-payment periods exist');
  const later = periods[1];
  const html = P.budgetPayPeriodMoneyMapHtml(later);
  assert.ok(html.includes('MBNA Mastercard'), 'later period names its own target');
  assert.ok(!html.includes('Triangle Mastercard'),
    'the cleared earlier target is not borrowed into the later period');
});

check('end-to-end: knob recompute changes the attribution from the same inputs', () => {
  const Forecast = require(forecastPath);
  const lo = Forecast.baselineTrajectory(e2ePlan(), e2eDebts(), '2026-01-01',
    { weeklyVariable: 400, extraDebtMonthly: 600 });
  const hi = Forecast.baselineTrajectory(e2ePlan(), e2eDebts(), '2026-01-01',
    { weeklyVariable: 400, extraDebtMonthly: 1000 });
  const find = t => t.payPeriods.find(pp =>
    pp.stage3 && pp.stage3.extras && pp.stage3.extras.amount > 0);
  const loRow = find(lo);
  const hiRow = find(hi);
  assert.ok(loRow && hiRow, 'both knob settings publish an extra period');
  assert.ok(loRow.stage3.extras.amount === 600 && hiRow.stage3.extras.amount === 1000,
    'totals follow the knob');
  assert.ok(JSON.stringify(loRow.stage3.extras.allocations)
    !== JSON.stringify(hiRow.stage3.extras.allocations),
    'attribution recomputes from the same input set (residual into the next debt differs)');
});

if (failures) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nSlice 13 debt-target page checks passed.');
