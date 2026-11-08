'use strict';
/* Other spending reuses the incumbent current-period residual.
 *
 * The calendar Household Budget `needsConfirmation` bucket is unassigned
 * current-cycle household spend. It is not a total of every dollar outside
 * the planned category rows. This suite proves that contract independently
 * of `calendarHouseholdBudget` (L-002 / L-006).
 *
 * `node test/test-household-budget-other-spending.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ calendarBudgetHtml, money2 });`, { Forecast: F });
}

const composer = loadComposer();

const PLANNED_IDS = [
  'groceries', 'fuel', 'household', 'pets', 'restaurants',
  'dale-guilt-free', 'amanda-guilt-free',
];
const HOLD_TOTAL = roundCent(900 + 325 + 37.50 + 100 + 200 + 150 + 150);

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: '2026-08-28', representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4264, confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' },
        { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 325, ownerLine: 'Fuel' },
        { id: 'household', label: 'Household', class: 'essential', plannedPayday: 37.5, ownerLine: 'Household' },
        { id: 'pets', label: 'Pets', class: 'essential', plannedPayday: 100, ownerLine: 'Dog food' },
        { id: 'restaurants', label: 'Dining', class: 'discretionary', from: ['Restaurants', 'Dining', 'Fast Food', 'Food Delivery'], plannedPayday: 200, ownerLine: 'Eating out' },
        { id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Dale guilt-free spending' },
        { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Amanda guilt-free spending' },
        { id: 'shopping', label: 'Shopping', class: 'discretionary', from: ['Shopping', 'Personal'] },
        { id: 'health', label: 'Health', class: 'essential', from: ['Health'] },
        { id: 'sport', label: 'Sport', class: 'discretionary', from: ['Sport & fitness'] },
      ],
    },
  };
}

const debts = [
  { id: 'tdcc', label: 'TD personal Visa', secured: false, structure: 'Revolving', balance: 90, rate: 24.99, payment: 94.03, pending: 0 },
  { id: 'heloc', label: 'HELOC', secured: true, structure: 'Interest-only revolving', balance: 1000, rate: 4.9, payment: 0, pending: 0, cashPayment: 0, interestTreatment: 'capitalised' },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

function actualsPacket(txs, asOf, extra) {
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: asOf,
    coverageStart: '2026-07-01',
    coverageThrough: asOf,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
  }, extra || {});
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r.id === id) || null;
}

const AS_OF = '2026-09-01';
const GROCERY = 100;
const FUEL = 50;
const EATING = 25;
const OTHER_A = 40;
const OTHER_B = 60;
const OTHER_TOTAL = OTHER_A + OTHER_B;
const RELEVANT_TOTAL = GROCERY + FUEL + EATING + OTHER_TOTAL;

const fixtureTxs = [
  {
    id: 'tx-grocery', date: '2026-08-28', amount: GROCERY, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
  },
  {
    id: 'tx-fuel', date: '2026-08-29', amount: FUEL, pending: false,
    categoryLabel: 'Fuel', accountRole: 'household-cash',
    displayedPayee: 'Shell', originalMerchant: 'Shell',
  },
  {
    id: 'tx-eat', date: '2026-08-30', amount: EATING, pending: false,
    categoryLabel: 'Restaurants', accountRole: 'household-cash',
  },
  {
    id: 'tx-other-a', date: '2026-08-31', amount: OTHER_A, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash',
  },
  {
    id: 'tx-other-b', date: '2026-09-01', amount: OTHER_B, pending: false,
    categoryLabel: 'Shopping', accountRole: 'household-cash',
  },
  {
    id: 'tx-mortgage', date: '2026-08-28', amount: 1600, pending: false,
    categoryLabel: 'Mortgage', accountRole: 'household-cash',
  },
  {
    id: 'tx-card', date: '2026-08-28', amount: 500, pending: false,
    categoryLabel: 'Payment', accountRole: 'household-cash',
    kindHint: 'card-payment',
  },
  {
    id: 'tx-transfer', date: '2026-08-28', amount: 300, pending: false,
    categoryLabel: 'Transfer', accountRole: 'household-cash',
    kindHint: 'transfer', excludeFromTotals: true,
  },
  {
    id: 'tx-income', date: '2026-08-28', amount: -4264, pending: false,
    categoryLabel: 'Income', accountRole: 'household-cash', isIncome: true,
  },
  {
    id: 'tx-before', date: '2026-08-27', amount: 88, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash',
  },
  {
    id: 'tx-after', date: '2026-09-11', amount: 77, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash',
  },
];

function recommend(txs, extraPacket, extraOpts) {
  return F.recommend(syntheticPlan(), AS_OF, Object.assign({
    targetBuffer: 500,
    debts,
    currentPeriodActuals: actualsPacket(txs, AS_OF, extraPacket),
  }, extraOpts || {}));
}

console.log('\n=== 1. independent fixture membership, not the production residual helper ===');
{
  ok(near(OTHER_TOTAL, 100) && near(RELEVANT_TOTAL, 275),
    'constructed Other spending is $40+$60=$100; relevant household spend is $275');
  const plan = syntheticPlan();
  const groceryCls = F.classifyCurrentPeriodTransaction(fixtureTxs[0], plan);
  const fuelCls = F.classifyCurrentPeriodTransaction(fixtureTxs[1], plan);
  const eatCls = F.classifyCurrentPeriodTransaction(fixtureTxs[2], plan);
  const otherA = F.classifyCurrentPeriodTransaction(fixtureTxs[3], plan);
  const otherB = F.classifyCurrentPeriodTransaction(fixtureTxs[4], plan);
  const mortgage = F.classifyCurrentPeriodTransaction(fixtureTxs[5], plan);
  const card = F.classifyCurrentPeriodTransaction(fixtureTxs[6], plan);
  const transfer = F.classifyCurrentPeriodTransaction(fixtureTxs[7], plan);
  const income = F.classifyCurrentPeriodTransaction(fixtureTxs[8], plan);
  ok(groceryCls.kind === 'spend' && groceryCls.categoryId === 'groceries',
    'grocery tx classifies as Groceries');
  ok(fuelCls.kind === 'spend' && fuelCls.categoryId === 'fuel',
    'fuel tx classifies as Fuel');
  ok(eatCls.kind === 'spend' && eatCls.categoryId === 'restaurants',
    'eating-out tx classifies as Eating out');
  ok(otherA.needsConfirmation === true && otherA.categoryId !== 'groceries',
    'unmapped Gifts is the incumbent residual, not a planned category');
  ok(otherB.needsConfirmation === true && otherB.kind !== 'spend',
    'unlabeled Shopping is the incumbent residual, not guilt-free');
  ok(mortgage.kind === 'bill' && mortgage.householdSpending === false,
    'mortgage is a bill, not Other spending');
  ok(card.kind === 'card-payment' && transfer.kind === 'transfer' && income.kind === 'income',
    'card payment, household transfer, and income are excluded kinds');
}

console.log('\n=== 2. calendar Household Budget publishes the constructed amounts once ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const fuel = budgetRow(active, 'fuel');
  const eating = budgetRow(active, 'restaurants');
  const other = (active.householdBudget || []).find(r => r.otherSpending);
  ok(active && active.spendingCycle && active.spendingCycle.start === '2026-08-28'
      && active.spendingCycle.end === '2026-09-10'
      && active.spendingCycle.rangeLabel === 'Aug 28–Sep 10',
    'active cycle is the independent Aug 28–Sep 10 window');
  ok(groceries && near(groceries.spent, GROCERY) && near(groceries.planned, 900)
      && near(groceries.remaining, 800),
    'Groceries spent is the constructed $100');
  ok(fuel && near(fuel.spent, FUEL), 'Fuel spent is the constructed $50');
  ok(eating && near(eating.spent, EATING), 'Eating out spent is the constructed $25');
  ok(other && other.id === 'other-spending' && other.label === 'Other spending'
      && other.note === 'Not yet assigned to a budget category'
      && other.planned == null && other.remaining == null
      && near(other.hold, OTHER_TOTAL) && other.needsConfirmation === true
      && near(other.spent, OTHER_TOTAL),
    'Other spending is the constructed $100 residual, hold equals actual, no planned/remaining');
  const namedSpent = roundCent(GROCERY + FUEL + EATING);
  ok(near(namedSpent + OTHER_TOTAL, RELEVANT_TOTAL),
    '100+50+25+100 independently equals total Household-Budget-relevant spending');
  const reconIds = [];
  for (const row of active.householdBudget || []) {
    for (const tx of row.recon || []) {
      if (tx && tx.id) reconIds.push(tx.id);
    }
  }
  const unique = new Set(reconIds);
  ok(reconIds.length === unique.size,
    'no transaction appears on two Household Budget rows');
  ok(unique.has('tx-grocery') && unique.has('tx-fuel') && unique.has('tx-eat')
      && unique.has('tx-other-a') && unique.has('tx-other-b'),
    'each constructed relevant tx is represented once');
  ok(!unique.has('tx-mortgage') && !unique.has('tx-card') && !unique.has('tx-transfer')
      && !unique.has('tx-income') && !unique.has('tx-before') && !unique.has('tx-after'),
    'bills, transfers, income, and outside-cycle txs are absent from every row');
  const nextOther = (next.householdBudget || []).find(r => r.otherSpending || r.needsConfirmation);
  ok(!nextOther,
    'Next Pay Period does not invent projected Other spending');
}

console.log('\n=== 3. Other spending actual is deducted once from the waterfall ===');
{
  const without = recommend(fixtureTxs.filter(tx => tx.id !== 'tx-other-a' && tx.id !== 'tx-other-b'));
  const withOther = recommend(fixtureTxs);
  const a = period(without.defaultView, 'this-pay-period');
  const b = period(withOther.defaultView, 'this-pay-period');
  const holdWithout = PLANNED_IDS.reduce((s, id) => {
    const row = budgetRow(a, id);
    return roundCent(s + (row && Number(row.hold) || 0));
  }, 0);
  const holdWithNamed = PLANNED_IDS.reduce((s, id) => {
    const row = budgetRow(b, id);
    return roundCent(s + (row && Number(row.hold) || 0));
  }, 0);
  const other = (b.householdBudget || []).find(r => r.otherSpending);
  ok(near(a.budgetHold, holdWithout) && near(holdWithNamed, holdWithout),
    'named-category holds are unchanged by Other spending');
  ok(other && near(other.hold, OTHER_TOTAL)
      && near(b.budgetHold, roundCent(a.budgetHold + OTHER_TOTAL)),
    'Other spending actual is deducted once and added to budgetHold');
  ok(near(b.afterHouseholdBudget, roundCent(a.afterHouseholdBudget - OTHER_TOTAL)),
    'Balance after Household Budget falls by Other spending actual');
  ok(!near(a.afterHouseholdBudget, b.afterHouseholdBudget)
      && !near(a.projectedEnding, b.projectedEnding),
    'downstream leftovers move with the Other spending deduction');
  ok(near(HOLD_TOTAL, 1862.50),
    'independent unused cycle reserve is still $1,862.50 before spent');
}

console.log('\n=== 4. incomplete actuals coverage does not invent Other spending ===');
{
  const stale = recommend(fixtureTxs, {
    coverageStart: '2026-07-01',
    coverageThrough: '2026-08-24',
  });
  const staleActive = period(stale.defaultView, 'this-pay-period');
  // A known posted unassigned debit is a lower bound on the hold (so an estimate is never more
  // optimistic than a measured answer), but it is never published as spending: no spent figure,
  // no reconciliation rows, no measured Other spending.
  ok(!(staleActive.householdBudget || []).some(r => (r.otherSpending && (r.spent != null || (r.recon || []).length > 0))
      || (r.needsConfirmation && Number(r.spent) > 0)),
    'coverage through Aug 24, before the Aug 28 cycle, does not invent Other spending');
  ok((staleActive.householdBudget || []).every(r => r.spent == null || r.otherSpending),
    'stale coverage does not publish cycle spent from missing days');
  const lateStart = recommend(fixtureTxs, {
    coverageStart: '2026-08-29',
    coverageThrough: AS_OF,
  });
  const lateActive = period(lateStart.defaultView, 'this-pay-period');
  ok(!(lateActive.householdBudget || []).some(r => r.otherSpending && Number(r.spent) > 0),
    'coverage that starts after the cycle origin does not manufacture Other spending');
}

console.log('\n=== 5. page prints structured Planned / Spent / Remaining and Other spending ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarBudgetHtml(active);
  ok(/household-budget-cycle/.test(html) && /Aug 28–Sep 10/.test(html)
      && !/Spending cycle:/.test(html),
    'cycle subtitle is the date range, not Spending cycle:');
  ok(/data-budget-category="groceries"/.test(html)
      && /\$450(?:\.00)?\/week/.test(html)
      && /<dt>Planned<\/dt>/.test(html)
      && /<dt>Spent<\/dt>/.test(html)
      && /<dt>Remaining<\/dt>/.test(html)
      && /household-budget-remaining/.test(html),
    'Groceries is a scan block with weekly context and Planned / Spent / Remaining');
  ok(/data-other-spending/.test(html)
      && /Other spending/.test(html)
      && /Not yet assigned to a budget category/.test(html)
      && !/Spending outside the budget categories above/.test(html)
      && !/Personal spending — needs confirmation/.test(html)
      && !/needs confirmation/.test(html),
    'Other spending is labelled as unassigned, not as a total of spending outside the planned rows');
  const planSrc = read('public/plan.js');
  const engineSrc = read('public/forecast.js');
  ok(!/Spending outside the budget categories above/.test(planSrc)
      && !/Spending outside the budget categories above/.test(engineSrc),
    'Plan and Forecast no longer publish the totality copy');
  ok(!/planned this period/.test(html) && !/spent this period/.test(html),
    'category rows are not sentence-dense this-period lines');
  const css = read('public/styles.css');
  ok(/\.household-budget-metrics \{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*auto\)/.test(css)
      && /min-width:\s*0/.test(css)
      && /household-budget-metrics dd[\s\S]*tabular-nums/.test(css),
    'CSS keeps a wrapping two-column metric grid with tabular amounts');
}

console.log('\n=== 6. Other spending is not a total of spending outside planned rows ===');
{
  const HEALTH = 50;
  const SPORT = 22;
  const hidden = [
    {
      id: 'tx-health', date: '2026-08-28', amount: HEALTH, pending: false,
      categoryLabel: 'Health', accountRole: 'household-cash',
    },
    {
      id: 'tx-sport', date: '2026-08-29', amount: SPORT, pending: false,
      categoryLabel: 'Sport & fitness', accountRole: 'household-cash',
    },
  ];
  const plan = syntheticPlan();
  const healthCls = F.classifyCurrentPeriodTransaction(hidden[0], plan);
  const sportCls = F.classifyCurrentPeriodTransaction(hidden[1], plan);
  ok(healthCls.kind === 'spend' && healthCls.categoryId === 'health'
      && healthCls.needsConfirmation !== true,
    'Health classifies as a named non-calendar spend, not the unassigned residual');
  ok(sportCls.kind === 'spend' && sportCls.categoryId === 'sport'
      && sportCls.needsConfirmation !== true,
    'Sport classifies as a named non-calendar spend, not the unassigned residual');
  const advice = recommend(fixtureTxs.concat(hidden));
  const active = period(advice.defaultView, 'this-pay-period');
  const other = (active.householdBudget || []).find(r => r.otherSpending);
  const reconIds = [];
  for (const row of active.householdBudget || []) {
    for (const tx of row.recon || []) {
      if (tx && tx.id) reconIds.push(tx.id);
    }
  }
  const naiveOutside = roundCent(OTHER_TOTAL + HEALTH + SPORT);
  ok(other && near(other.spent, OTHER_TOTAL) && !near(other.spent, naiveOutside),
    'Other spending stays the unassigned $100; it is not $100 plus classified Health/sport',
    other && String(other.spent));
  ok(!reconIds.includes('tx-health') && !reconIds.includes('tx-sport')
      && !budgetRow(active, 'health') && !budgetRow(active, 'sport'),
    'Health and sport txs appear on neither a planned row nor Other spending');
  const html = composer.calendarBudgetHtml(active);
  ok(!/Spending outside the budget categories above/.test(html)
      && !/all spending outside/.test(html)
      && !/total (household )?spend(ing)? outside/.test(html)
      && /Not yet assigned to a budget category/.test(html),
    'printed copy does not claim a total of spending outside the planned categories');
}

console.log('\n=== 7. ATLAS-043: Coffee Shops is an Eating Out label alias, counted once ===');
{
  const COFFEE = 30;
  const coffeeTx = {
    id: 'tx-coffee', date: '2026-08-30', amount: COFFEE, pending: false,
    categoryLabel: 'Coffee Shops', accountRole: 'household-cash',
    displayedPayee: 'Starbucks', originalMerchant: 'Starbucks',
  };
  const plan = syntheticPlan();
  const coffeeCls = F.classifyCurrentPeriodTransaction(coffeeTx, plan);
  const eatCls = F.classifyCurrentPeriodTransaction(fixtureTxs[2], plan);
  ok(coffeeCls.kind === 'spend' && coffeeCls.categoryId === 'restaurants',
    'Coffee Shops tx classifies as Eating out');
  ok(JSON.stringify(coffeeCls) === JSON.stringify(eatCls),
    'Coffee Shops classification is identical to the Restaurants classification',
    JSON.stringify(coffeeCls));
  const variant = label => F.classifyCurrentPeriodTransaction(
    Object.assign({}, coffeeTx, { categoryLabel: label }), plan);
  ok(variant(' Coffee Shops ').categoryId === 'restaurants'
      && variant('COFFEE SHOPS').categoryId === 'restaurants'
      && variant('coffee shops').categoryId === 'restaurants',
    'trim/case variants of Coffee Shops classify as Eating out under the incumbent normalization');
  ok(variant(' Restaurants ').categoryId === 'restaurants'
      && variant('FAST FOOD').categoryId === 'restaurants',
    'the same trim/case variants behave identically for the incumbent Eating Out labels');
  ok(variant('Coffee Shop').categoryId !== 'restaurants'
      && variant('Coffee Shop').needsConfirmation === true,
    'singular Coffee Shop is not the Lunch Money label and stays unassigned');
  ok(variant('Coffee  Shops').categoryId !== 'restaurants'
      && variant('Coffee  Shops').needsConfirmation === true,
    'double-spaced Coffee  Shops is not normalized into the alias (trim/lowercase only)');
  ok(variant('Fast Food').categoryId === 'restaurants'
      && variant('Food Delivery').categoryId === 'restaurants',
    'Fast Food and Food Delivery still classify as Eating out');
  const alcoholCls = variant('Alcohol, Bars');
  ok(alcoholCls.categoryId !== 'restaurants' && alcoholCls.needsConfirmation === true,
    'Alcohol, Bars is not aliased into Eating Out; it stays in the unassigned residual');

  const advice = recommend(fixtureTxs.concat([coffeeTx]));
  const active = period(advice.defaultView, 'this-pay-period');
  const eating = budgetRow(active, 'restaurants');
  const other = (active.householdBudget || []).find(r => r.otherSpending);
  ok(eating && near(eating.spent, EATING + COFFEE),
    'Eating out spent is the constructed $25 Restaurants + $30 Coffee Shops = $55',
    eating && String(eating.spent));
  ok(other && near(other.spent, OTHER_TOTAL) && near(other.hold, OTHER_TOTAL),
    'Other spending stays the constructed $100 residual — Coffee Shops is excluded from it',
    other && String(other.spent));
  let spentSum = 0;
  const reconIds = [];
  for (const row of active.householdBudget || []) {
    spentSum = roundCent(spentSum + (Number(row.spent) || 0));
    for (const tx of row.recon || []) {
      if (tx && tx.id) reconIds.push(tx.id);
    }
  }
  ok(near(spentSum, RELEVANT_TOTAL + COFFEE),
    'bucket totals conserve: $275 relevant + $30 Coffee Shops = $305 across all rows',
    String(spentSum));
  ok(reconIds.filter(id => id === 'tx-coffee').length === 1,
    'the Coffee Shops tx appears exactly once across Household Budget rows');
  ok((eating.recon || []).some(tx => tx.id === 'tx-coffee'),
    'the Coffee Shops tx is represented on the Eating out row');
  ok(!(other.recon || []).some(tx => tx.id === 'tx-coffee'),
    'the Coffee Shops tx is not represented on the Other spending row');
}

console.log('\n=== 8. ATLAS-043: the alias also moves hold/waterfall figures when the named budget has capacity ===');
{
  // Round-2 pins (Atlas card/test completeness finding on PR #659): the
  // bucket move is not the whole story. Eating Out is a named budget whose
  // hold is max(planned, spent); while it has spare capacity the coffee $30
  // is absorbed inside the existing $200 hold, so the residual no longer
  // retains an extra $30 hold and the downstream waterfall rises by $30.
  // Every expected value below was produced by executing Forecast.
  const COFFEE = 30;
  const coffeeTx = {
    id: 'tx-coffee', date: '2026-08-30', amount: COFFEE, pending: false,
    categoryLabel: 'Coffee Shops', accountRole: 'household-cash',
    displayedPayee: 'Starbucks', originalMerchant: 'Starbucks',
  };
  const spentSumOf = p => (p.householdBudget || []).reduce(
    (s, row) => roundCent(s + (Number(row.spent) || 0)), 0);

  console.log('  -- 8a. base fixture: coffee absorbed by Eating Out capacity --');
  const withCoffee = period(recommend(fixtureTxs.concat([coffeeTx])).defaultView, 'this-pay-period');
  const noCoffee = period(recommend(fixtureTxs).defaultView, 'this-pay-period');
  ok(near(withCoffee.budgetHold, 1962.50),
    'with coffee, budgetHold is $1,962.50 — the $30 residual hold is released, not added',
    String(withCoffee.budgetHold));
  ok(near(withCoffee.afterHouseholdBudget, 6565.50),
    'with coffee, Balance after Household Budget is $6,565.50',
    String(withCoffee.afterHouseholdBudget));
  ok(near(withCoffee.projectedEnding, 5475.50),
    'with coffee, projected ending is $5,475.50',
    String(withCoffee.projectedEnding));
  ok(near(spentSumOf(withCoffee), RELEVANT_TOTAL + COFFEE),
    'total purchase spent is conserved at $275 + $30 = $305 across all rows',
    String(spentSumOf(withCoffee)));
  ok(near(noCoffee.budgetHold, withCoffee.budgetHold)
      && near(noCoffee.afterHouseholdBudget, withCoffee.afterHouseholdBudget)
      && near(noCoffee.projectedEnding, withCoffee.projectedEnding),
    'the no-coffee waterfall is identical: existing Eating Out capacity absorbs the coffee $30 with no extra hold');

  console.log('  -- 8b. over-budget Eating Out: coffee moves rows, not waterfall totals --');
  const BIG_EAT = 250;
  const overTxs = fixtureTxs.map(tx => tx.id === 'tx-eat'
    ? Object.assign({}, tx, { amount: BIG_EAT }) : tx);
  const over = period(recommend(overTxs.concat([coffeeTx])).defaultView, 'this-pay-period');
  const overEating = budgetRow(over, 'restaurants');
  const overOther = (over.householdBudget || []).find(r => r.otherSpending);
  ok(overEating && near(overEating.spent, BIG_EAT + COFFEE),
    'over-budget Eating Out spent is the constructed $250 Restaurants + $30 Coffee Shops = $280',
    overEating && String(overEating.spent));
  ok(overEating && near(overEating.hold, BIG_EAT + COFFEE),
    'an over-budget named category holds its full spent: Eating Out hold is $280',
    overEating && String(overEating.hold));
  ok(overEating && near(overEating.overspend, BIG_EAT + COFFEE - 200)
      && near(overEating.remaining, 200 - (BIG_EAT + COFFEE)),
    'Eating Out overspend is $80 and remaining is -$80 against the $200 plan',
    overEating && String(overEating.overspend));
  ok(overOther && near(overOther.spent, OTHER_TOTAL) && near(overOther.hold, OTHER_TOTAL),
    'Other spending stays the $100 residual even when Eating Out is over budget',
    overOther && String(overOther.spent));
  ok(near(over.budgetHold, 2042.50) && near(over.afterHouseholdBudget, 6485.50)
      && near(over.projectedEnding, 5395.50),
    'over-budget waterfall totals are $2,042.50 / $6,485.50 / $5,395.50: with no spare capacity the coffee $30 raises a hold on either side, so totals do not move — only the carrying row changes',
    String(over.budgetHold));
  ok(near(spentSumOf(over), 530),
    'over-budget total purchase spent is conserved at $530 across all rows',
    String(spentSumOf(over)));

  console.log('  -- 8c. dated Other target: coffee no longer consumes the target --');
  const OTHER_TARGET = 120;
  const targetPlan = syntheticPlan();
  targetPlan.budget.categories.push({
    id: 'other-spend', label: 'Other spend',
    plannedPayday: OTHER_TARGET, targetEffectiveFrom: '2026-08-28',
  });
  const targeted = period(F.recommend(targetPlan, AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: actualsPacket(fixtureTxs.concat([coffeeTx]), AS_OF),
  }).defaultView, 'this-pay-period');
  const targetOther = (targeted.householdBudget || []).find(r => r.otherSpending);
  ok(targetOther && near(targetOther.planned, OTHER_TARGET),
    'the dated Other target still selects its $120 planned amount',
    targetOther && String(targetOther.planned));
  ok(targetOther && near(targetOther.spent, OTHER_TOTAL),
    'dated-target Other spent is the $100 genuine residual only — coffee is not residual evidence',
    targetOther && String(targetOther.spent));
  ok(targetOther && near(targetOther.hold, OTHER_TARGET)
      && near(targetOther.remaining, OTHER_TARGET - OTHER_TOTAL)
      && near(targetOther.overspend, 0),
    'coffee does not consume the dated Other target: hold stays at the $120 target, $20 remains, no overspend',
    targetOther && String(targetOther.hold));
  ok(near(targeted.budgetHold, 1982.50) && near(targeted.afterHouseholdBudget, 6545.50)
      && near(targeted.projectedEnding, 5455.50),
    'dated-target waterfall totals are $1,982.50 / $6,545.50 / $5,455.50 with coffee in Eating Out',
    String(targeted.budgetHold));
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
