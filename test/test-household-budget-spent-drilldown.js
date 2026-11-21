'use strict';
/* Household Budget Spent drill-down: Forecast row.recon is the membership.
 *
 * Forecast already classifies current-period actuals and attaches supporting
 * transactions on each calendar Household Budget row. This suite proves that
 * membership at the Forecast level: the supporting rows independently sum to
 * Spent, the classifier excludes bills / transfers / income / outside-cycle
 * rows, and the sanitizer carries merchant identity only on eligible rows.
 *
 * The classic page markup that used to render those rows (details/summary,
 * payee, date, Pending and Total markup) retired with the classic page
 * (C1 S4 batch B1); what the household reads now is the Stack budget sheet,
 * proved by test-stack-budget-sheet-figures.js (printed Spent / budget / Left
 * or Over against independent arithmetic) and test-stack-budget-transactions.js
 * (list = recon less the pending twin, summing to published Spent).
 *
 * `node test/test-household-budget-spent-drilldown.js`
 */
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }, { id: 'chequing-b', value: 0 }],
    },
    opening: { asOf: '2026-08-28', representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4264, confidence: 'confirmed',
    }],
    bills: [],
    // A planned mortgage payment falls due in the Aug 28 "Mortgage" row's own
    // spending cycle, so that row is that payment, not household spending
    // (finish-line audit finding 4 and the #1071 follow-up: the guard holds
    // only while an occurrence is planned in the row's cycle).
    obligations: [{ id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Mortgage',
      frequency: 'monthly', day: 28, amount: 1600, confidence: 'confirmed',
      payingAccount: 'chequing-a' }],
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
        date: '2026-08-31', amount: -2500, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Income',
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
  const income = (packet.transactions || []).find(tx => Number(tx.amount) === -2500);
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
}

console.log('\n=== 6. Planned, Remaining and the hold sum stay put (Forecast level) ===');
{
  const advice = recommend(fixtureTxs);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  ok(near(groceries.planned, 900), 'Groceries Planned remains the cycle hold $900.00');
  const remaining = roundCent(900 - GROCERY_TOTAL);
  ok(near(groceries.remaining, remaining),
    'Groceries Remaining is still planned minus the constructed spent');
  ok(near(active.budgetHold, (active.householdBudget || []).reduce(
    (s, r) => roundCent(s + (Number(r.hold) || 0)), 0)),
    'budgetHold remains the sum of row.hold values');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
