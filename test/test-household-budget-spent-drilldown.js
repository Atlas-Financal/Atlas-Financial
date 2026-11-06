'use strict';
/* Household Budget Spent drill-down is presentation of Forecast row.recon.
 *
 * Forecast already classifies current-period actuals and attaches supporting
 * transactions on each calendar Household Budget row. This suite proves the
 * Plan page renders those supplied rows as an inline Spent disclosure, and
 * that the disclosed amounts independently sum to the displayed Spent figure.
 * plan.js must not reclassify membership (L-001 / L-002).
 *
 * `node test/test-household-budget-spent-drilldown.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');

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
  return vm.runInNewContext(`${source}\n({ calendarBudgetHtml, householdBudgetMetric, money2 });`, {
    Forecast: F,
  });
}

const composer = loadComposer();

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
      ],
    },
  };
}

const debts = [
  { id: 'tdcc', label: 'TD personal Visa', secured: false, structure: 'Revolving', balance: 90, rate: 24.99, payment: 94.03, pending: 0 },
  { id: 'heloc', label: 'HELOC', secured: true, structure: 'Interest-only revolving', balance: 1000, rate: 4.9, payment: 0, pending: 0, cashPayment: 0, interestTreatment: 'capitalised' },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

function actualsPacket(txs, asOf) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: asOf,
    coverageStart: '2026-07-01',
    coverageThrough: asOf,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
  };
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r.id === id) || null;
}
function block(html, id) {
  const marker = `data-budget-category="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const from = html.lastIndexOf('<div', at);
  const next = html.indexOf('data-budget-category="', at + marker.length);
  if (next < 0) return html.slice(from);
  const to = html.lastIndexOf('<div', next);
  return html.slice(from, to > from ? to : next);
}
function txIds(html) {
  return [...html.matchAll(/data-tx-id="([^"]+)"/g)].map(m => m[1]);
}
function txPayees(html) {
  return [...html.matchAll(/household-budget-tx-payee">([^<]*)/g)].map(m => m[1]);
}

const AS_OF = '2026-09-01';
const GROCERY_A = 84.32;
const GROCERY_B = 163.44;
const GROCERY_P = 12.50;
const GROCERY_TOTAL = roundCent(GROCERY_A + GROCERY_B + GROCERY_P);
const FUEL = 55.75;
const EATING = 19.99;
const OTHER_A = 40.01;
const OTHER_B = 11.11;
const OTHER_TOTAL = roundCent(OTHER_A + OTHER_B);
const RELEVANT_TOTAL = roundCent(GROCERY_TOTAL + FUEL + EATING + OTHER_TOTAL);

const fixtureTxs = [
  {
    id: 'tx-grocery-a', date: '2026-08-29', amount: GROCERY_A, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
  },
  {
    id: 'tx-grocery-b', date: '2026-08-30', amount: GROCERY_B, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Costco', originalMerchant: 'Costco',
  },
  {
    id: 'tx-grocery-p', date: '2026-09-01', amount: GROCERY_P, pending: true,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Walmart', originalMerchant: 'Walmart',
  },
  {
    id: 'tx-fuel', date: '2026-08-29', amount: FUEL, pending: false,
    categoryLabel: 'Fuel', accountRole: 'household-cash',
    displayedPayee: 'Shell', originalMerchant: 'Shell',
  },
  {
    id: 'tx-eat', date: '2026-08-31', amount: EATING, pending: false,
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
    id: 'tx-income', date: '2026-08-28', amount: 4264, pending: false,
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

function recommend(txs) {
  return F.recommend(syntheticPlan(), AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: actualsPacket(txs, AS_OF),
  });
}

console.log('\n=== 1. constructed amounts reconcile independently of the renderer ===');
{
  ok(near(GROCERY_TOTAL, 260.26) && near(OTHER_TOTAL, 51.12) && near(RELEVANT_TOTAL, 387.12),
    'constructed Groceries $84.32+$163.44+$12.50=$260.26; Other $40.01+$11.11=$51.12; relevant $387.12');
  const plan = syntheticPlan();
  ok(F.classifyCurrentPeriodTransaction(fixtureTxs[0], plan).categoryId === 'groceries'
      && F.classifyCurrentPeriodTransaction(fixtureTxs[1], plan).categoryId === 'groceries'
      && F.classifyCurrentPeriodTransaction(fixtureTxs[2], plan).categoryId === 'groceries',
    'three grocery fixtures classify as Groceries');
  ok(F.classifyCurrentPeriodTransaction(fixtureTxs[3], plan).categoryId === 'fuel',
    'fuel fixture classifies as Fuel');
  ok(F.classifyCurrentPeriodTransaction(fixtureTxs[4], plan).categoryId === 'restaurants',
    'eating-out fixture classifies as Eating out');
  const otherA = F.classifyCurrentPeriodTransaction(fixtureTxs[5], plan);
  const otherB = F.classifyCurrentPeriodTransaction(fixtureTxs[6], plan);
  ok(otherA.needsConfirmation === true && otherB.needsConfirmation === true,
    'Gifts and unlabeled Shopping are the incumbent residual');
  ok(F.classifyCurrentPeriodTransaction(fixtureTxs[7], plan).kind === 'bill'
      && F.classifyCurrentPeriodTransaction(fixtureTxs[8], plan).kind === 'card-payment'
      && F.classifyCurrentPeriodTransaction(fixtureTxs[9], plan).kind === 'transfer'
      && F.classifyCurrentPeriodTransaction(fixtureTxs[10], plan).kind === 'income',
    'mortgage, card payment, transfer, and income are excluded kinds');
}

console.log('\n=== 2. Forecast row.recon is the membership the page must print ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const fuel = budgetRow(active, 'fuel');
  const eating = budgetRow(active, 'restaurants');
  const pets = budgetRow(active, 'pets');
  const other = (active.householdBudget || []).find(r => r.otherSpending);
  ok(groceries && near(groceries.spent, GROCERY_TOTAL)
      && groceries.recon && groceries.recon.length === 3,
    'Groceries spent and recon length match the constructed $260.26 / 3 txs');
  ok(fuel && near(fuel.spent, FUEL) && fuel.recon.length === 1,
    'Fuel spent is the constructed $55.75');
  ok(eating && near(eating.spent, EATING) && eating.recon.length === 1,
    'Eating out spent is the constructed $19.99');
  ok(pets && near(pets.spent, 0) && Array.isArray(pets.recon) && pets.recon.length === 0,
    'Pets has zero supporting transactions');
  ok(other && near(other.spent, OTHER_TOTAL) && other.recon.length === 2,
    'Other spending residual is the constructed $51.12');
  const reconSum = row => roundCent((row.recon || []).reduce((s, tx) => s + (Number(tx.amount) || 0), 0));
  ok(near(reconSum(groceries), groceries.spent)
      && near(reconSum(fuel), fuel.spent)
      && near(reconSum(eating), eating.spent)
      && near(reconSum(other), other.spent),
    'each row.recon independently sums to that row.spent');
  ok(groceries.recon[0].displayedPayee === 'Save-On-Foods'
      && groceries.recon[1].displayedPayee === 'Costco'
      && groceries.recon[2].displayedPayee === 'Walmart'
      && fuel.recon[0].displayedPayee === 'Shell',
    'Forecast recon copies sanitized displayedPayee from the actuals packet');
  ok(groceries.recon.every(tx => tx.categoryLabel === 'Groceries')
      && groceries.recon.every(tx => tx.displayedPayee !== 'Groceries'),
    'categoryLabel stays classification; it is not copied as merchant identity');
}

console.log('\n=== 3. rendered Spent is interactive only when recon exists ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarBudgetHtml(active);
  const groceries = block(html, 'groceries');
  const pets = block(html, 'pets');
  const other = block(html, 'other-spending');
  ok(/<dt>Spent<\/dt>/.test(groceries)
      && /<details class="household-budget-spent-detail" data-budget-spent="groceries">/.test(groceries)
      && /<summary class="household-budget-spent-summary">/.test(groceries)
      && groceries.indexOf('<details') < groceries.indexOf('data-budget-spent-detail'),
    'Groceries Spent is a native details/summary disclosure');
  ok(!/\sopen(>| )/.test(groceries) && !/\sopen="/.test(groceries),
    'Groceries disclosure starts collapsed');
  ok(!/<details/.test(pets) && /<dt>Spent<\/dt>/.test(pets)
      && /<dd>\$0\.00<\/dd>/.test(pets),
    'Pets Spent is a static $0.00 metric, not a false clickable breakdown');
  ok(/data-budget-spent="other-spending"/.test(other) && /<summary /.test(other),
    'Other spending Spent is also an interactive disclosure');
}

console.log('\n=== 4. disclosed rows are exactly Forecast recon, summing to Spent ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarBudgetHtml(active);
  const groceriesHtml = block(html, 'groceries');
  const fuelHtml = block(html, 'fuel');
  const eatingHtml = block(html, 'restaurants');
  const otherHtml = block(html, 'other-spending');
  const groceries = budgetRow(active, 'groceries');
  const groceryIds = txIds(groceriesHtml);
  ok(groceryIds.length === 3
      && groceryIds.includes('tx-grocery-a')
      && groceryIds.includes('tx-grocery-b')
      && groceryIds.includes('tx-grocery-p'),
    'Groceries detail lists the three incumbent recon ids');
  ok(groceriesHtml.includes(composer.money2(GROCERY_A))
      && groceriesHtml.includes(composer.money2(GROCERY_B))
      && groceriesHtml.includes(composer.money2(GROCERY_P))
      && groceriesHtml.includes(`data-budget-spent-total="groceries">${composer.money2(GROCERY_TOTAL)}`),
    'Groceries detail prints constructed amounts and Total equals displayed Spent');
  ok(/data-tx-id="tx-grocery-p"[^>]*data-tx-pending="true"/.test(groceriesHtml)
      && /data-tx-id="tx-grocery-p"[\s\S]*household-budget-tx-pending">Pending</.test(groceriesHtml)
      && !/data-tx-id="tx-grocery-a"[\s\S]*Pending/.test(groceriesHtml.split('data-tx-id="tx-grocery-p"')[0]),
    'pending state is shown only on the pending grocery tx');
  ok(txIds(fuelHtml).join() === 'tx-fuel' && fuelHtml.includes(composer.money2(FUEL)),
    'Fuel detail is the one incumbent fuel tx');
  ok(txIds(eatingHtml).join() === 'tx-eat' && eatingHtml.includes(composer.money2(EATING)),
    'Eating out detail is the one incumbent eating-out tx');
  const otherIds = txIds(otherHtml);
  ok(otherIds.length === 2 && otherIds.includes('tx-other-a') && otherIds.includes('tx-other-b')
      && otherHtml.includes(composer.money2(OTHER_A))
      && otherHtml.includes(composer.money2(OTHER_B))
      && otherHtml.includes(composer.money2(OTHER_TOTAL)),
    'Other spending detail uses its incumbent residual txs');
  const allIds = txIds(html);
  ok(new Set(allIds).size === allIds.length,
    'a transaction appears in only one Household Budget disclosure');
  ok(!allIds.includes('tx-mortgage') && !allIds.includes('tx-card')
      && !allIds.includes('tx-transfer') && !allIds.includes('tx-income')
      && !allIds.includes('tx-before') && !allIds.includes('tx-after'),
    'bills, transfers, income, and outside-cycle txs are absent from every disclosure');
  ok(txPayees(groceriesHtml).includes('Save-On-Foods')
      && txPayees(groceriesHtml).includes('Costco')
      && txPayees(groceriesHtml).includes('Walmart')
      && !txPayees(groceriesHtml).includes('Groceries'),
    'Groceries detail identifies Save-On-Foods / Costco / Walmart, not Groceries');
  ok(txPayees(fuelHtml).includes('Shell') && !txPayees(fuelHtml).includes('Fuel'),
    'Fuel detail identifies Shell, not Fuel');
  ok(txPayees(eatingHtml).includes('Merchant unavailable')
      && !txPayees(eatingHtml).includes('Restaurants'),
    'missing merchant identity is a neutral fallback, not the Restaurants label');
  ok(/datetime="2026-08-29"/.test(groceriesHtml) && /datetime="2026-08-30"/.test(groceriesHtml),
    'disclosed grocery rows keep their incumbent dates');
  const grocerySpent = composer.money2(groceries.spent);
  ok(groceriesHtml.includes(grocerySpent),
    'collapsed Spent control still shows the incumbent Groceries spent figure');
}

console.log('\n=== 5. merchant identity uses displayedPayee, then originalMerchant ===');
{
  const saveOn = composer.householdBudgetMetric('Spent', 18.56, {
    recon: [{
      id: 'tx-save-on', date: '2026-08-31', amount: 18.56,
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
      categoryLabel: 'Groceries', pending: false,
    }],
    id: 'groceries',
  });
  ok(txPayees(saveOn).join() === 'Save-On-Foods'
      && saveOn.includes(composer.money2(18.56))
      && /datetime="2026-08-31"/.test(saveOn)
      && !txPayees(saveOn).includes('Groceries')
      && !/>Groceries</.test(saveOn.replace(/<h3[\s\S]*?<\/h3>/, '')),
    'constructed Aug 31 Save-On-Foods $18.56; Groceries is not the transaction identity');

  const displayedWins = composer.householdBudgetMetric('Spent', 22.00, {
    recon: [{
      id: 'tx-display-wins', date: '2026-08-31', amount: 22.00,
      displayedPayee: 'Thrifty Foods', originalMerchant: 'THRIFTY FOODS #88',
      categoryLabel: 'Groceries', pending: false,
    }],
    id: 'groceries',
  });
  ok(txPayees(displayedWins).join() === 'Thrifty Foods'
      && !txPayees(displayedWins).includes('THRIFTY FOODS #88')
      && !txPayees(displayedWins).includes('Groceries'),
    'displayedPayee wins when both merchant fields are present');

  const originalFallback = composer.householdBudgetMetric('Spent', 9.41, {
    recon: [{
      id: 'tx-original-only', date: '2026-08-30', amount: 9.41,
      originalMerchant: 'Safeway', categoryLabel: 'Groceries', pending: false,
    }],
    id: 'groceries',
  });
  ok(txPayees(originalFallback).join() === 'Safeway'
      && !txPayees(originalFallback).includes('Groceries'),
    'originalMerchant is used when displayedPayee is unavailable');

  const missing = composer.householdBudgetMetric('Spent', 5.00, {
    recon: [{ id: 'tx-label', date: '2026-08-30', amount: 5.00, categoryLabel: 'Fuel', pending: false }],
    id: 'fuel',
  });
  ok(txPayees(missing).join() === 'Merchant unavailable'
      && !txPayees(missing).includes('Fuel')
      && !/>Fuel</.test(missing),
    'missing merchant identity is Merchant unavailable; categoryLabel is not substituted');

  const empty = composer.householdBudgetMetric('Spent', 0, { recon: [], id: 'pets' });
  ok(!/<details/.test(empty) && /<dt>Spent<\/dt>/.test(empty),
    'empty recon is not an interactive breakdown');
  const planSrc = read('public/plan.js');
  const metricSrc = grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric');
  const categorySrc = grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml');
  ok(!/classifyCurrentPeriodTransaction/.test(metricSrc + categorySrc)
      && !/sumCategoryActuals/.test(metricSrc + categorySrc)
      && /row\.recon/.test(categorySrc)
      && /displayedPayee/.test(metricSrc)
      && /originalMerchant/.test(metricSrc)
      && /Merchant unavailable/.test(metricSrc)
      && !/categoryLabel \|\|/.test(metricSrc),
    'Plan Household Budget renderer consumes row.recon merchant fields and does not classify');
}

console.log('\n=== 5b. Forecast recon originalMerchant fallback is independent of the renderer ===');
{
  const txs = [{
    id: 'tx-safeway-only', date: '2026-08-31', amount: 18.56, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    originalMerchant: 'Safeway',
  }];
  const advice = recommend(txs);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  ok(groceries && groceries.recon && groceries.recon.length === 1
      && groceries.recon[0].displayedPayee == null
      && groceries.recon[0].originalMerchant === 'Safeway'
      && groceries.recon[0].categoryLabel === 'Groceries'
      && !Object.prototype.hasOwnProperty.call(groceries.recon[0], 'payee')
      && near(groceries.spent, 18.56),
    'Forecast recon keeps originalMerchant when displayedPayee is absent; membership and spent unchanged');
  const groceriesHtml = block(composer.calendarBudgetHtml(active), 'groceries');
  ok(txPayees(groceriesHtml).join() === 'Safeway'
      && !txPayees(groceriesHtml).includes('Groceries')
      && groceriesHtml.includes(composer.money2(18.56)),
    'rendered originalMerchant fallback is Safeway $18.56, not Groceries');
}

console.log('\n=== 5c. sanitizer omits merchant on excluded rows; eligible spend still renders ===');
{
  const plan = syntheticPlan();
  plan.budget.excluded = [{ from: 'Business', why: 'not household' }];
  const packet = O.sanitizedCurrentPeriodActuals({
    fetchedAt: AS_OF + 'T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: AS_OF, complete: true },
    pendingCoverage: { complete: true, hasMore: false, truncated: false },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 18.56, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Groceries',
        payee: 'Save-On-Foods', originalName: 'Save-On-Foods',
        providerAccountId: '1001', providerTransactionId: 'groc-render',
      },
      {
        date: '2026-08-31', amount: 2500, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Income',
        payee: 'SEASPAN PAYROLL', originalName: 'SEASPAN PAYROLL',
        isIncome: true, providerAccountId: '1001', providerTransactionId: 'inc-render',
      },
      {
        date: '2026-08-31', amount: 80, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Business',
        payee: 'ACME CORP', originalName: 'ACME CORP',
        providerAccountId: '1001', providerTransactionId: 'biz-render',
      },
    ],
    representedEventCandidates: [],
  }, {
    asOf: AS_OF,
    plan,
    accountMap: {
      mappings: [{
        providerAccountId: '1001',
        canonical: { collection: 'cash', id: 'chequing-a' },
        atlasRole: 'household-cash',
      }],
    },
  });
  packet.coverageStart = '2026-07-01';
  packet.coverageThrough = AS_OF;
  packet.pendingCoverage = 'complete';
  const grocery = (packet.transactions || []).find(tx => Number(tx.amount) === 18.56);
  const income = (packet.transactions || []).find(tx => Number(tx.amount) === 2500);
  const business = (packet.transactions || []).find(tx => Number(tx.amount) === 80);
  ok(grocery && grocery.displayedPayee === 'Save-On-Foods',
    'sanitizer keeps Save-On-Foods on the eligible grocery');
  ok(income && income.displayedPayee == null && business && business.displayedPayee == null,
    'sanitizer omits merchant identity on income and excluded business');
  const advice = F.recommend(plan, AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: packet,
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  ok(groceries && near(groceries.spent, 18.56) && groceries.recon.length === 1
      && groceries.recon[0].displayedPayee === 'Save-On-Foods',
    'Forecast Spent and recon still use the eligible grocery merchant');
  const groceriesHtml = block(composer.calendarBudgetHtml(active), 'groceries');
  ok(txPayees(groceriesHtml).includes('Save-On-Foods')
      && !txPayees(groceriesHtml).includes('SEASPAN PAYROLL')
      && !txPayees(groceriesHtml).includes('ACME CORP')
      && !txPayees(groceriesHtml).includes('Groceries'),
    'rendered Spent row is Aug 31 Save-On-Foods, not income/business counterparties');
}

console.log('\n=== 6. Planned, Remaining, and waterfall figures stay put ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarBudgetHtml(active);
  const groceries = budgetRow(active, 'groceries');
  const groceriesHtml = block(html, 'groceries');
  ok(near(groceries.planned, 900) && groceriesHtml.includes(composer.money2(900))
      && /<dt>Planned<\/dt>/.test(groceriesHtml),
    'Groceries Planned remains the cycle hold $900.00');
  const remaining = roundCent(900 - GROCERY_TOTAL);
  ok(near(groceries.remaining, remaining)
      && groceriesHtml.includes(composer.money2(remaining))
      && /<dt>Remaining<\/dt>/.test(groceriesHtml)
      && /household-budget-remaining/.test(groceriesHtml),
    'Groceries Remaining is still planned minus the constructed spent');
  ok(near(active.budgetHold, (active.householdBudget || []).reduce(
    (s, r) => roundCent(s + (Number(r.hold) || 0)), 0)),
    'budgetHold remains the sum of row.hold values');
  const planSrc = read('public/plan.js');
  ok(/householdBudgetMetric\('Planned'/.test(planSrc)
      && /householdBudgetMetric\('Spent'/.test(planSrc)
      && /householdBudgetMetric\('Remaining'/.test(planSrc),
    'structured Planned / Spent / Remaining calls remain');
  const css = read('public/styles.css');
  ok(/household-budget-spent-summary[\s\S]*min-height:\s*44px/.test(css)
      && /household-budget-spent-summary[\s\S]*cursor:\s*pointer/.test(css)
      && /\.household-budget-tx \{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/.test(css),
    'Spent control is a 44px disclosure and tx rows keep amount right-aligned');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
