'use strict';
/* Household Budget overlay-fed Spent: the Forecast-level membership rules.
 *
 * When Forecast withheld row.recon (remaining claim unavailable) the classic
 * page listed overlay currentPeriodActuals.transactions under Spent. That
 * page behaviour retired with the classic page (C1 S4 batch B1, owner ruling:
 * V1-only behaviour retires with no rebuild); the Stack budget sheet lists
 * Forecast recon only and prints nothing for withheld Spent, which
 * test-stack-budget-sheet-figures.js proves (withheld Spent beside overlay
 * transactions prints no Spent and no overlay sum).
 *
 * What stays is the Forecast-owned membership: the classifier, the split-parent
 * skip and the supporting-spend eligibility helpers (L-001 / L-002 / L-006).
 *
 * `node test/test-household-budget-overlay-spent-drilldown.js`
 */
const F = require('../public/forecast.js');

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
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
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

const GROCERY = 42.10;
const FUEL = 55.75;
const EATING = 19.99;
const DALE = 12.00;
const AMANDA = 8.50;
const GROCERY_PLANNED = 900;
const FUEL_PLANNED = 325;
const EATING_PLANNED = 200;
const DALE_PLANNED = 150;
const AMANDA_PLANNED = 150;
const PETS_PLANNED = 100;

const overlayTxs = [
  {
    id: 'tx-groc', date: '2026-08-29', amount: GROCERY, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
  },
  {
    id: 'tx-fuel', date: '2026-08-29', amount: FUEL, pending: false,
    categoryLabel: 'Fuel', accountRole: 'household-cash',
    displayedPayee: 'Shell', originalMerchant: 'Shell',
  },
  {
    id: 'tx-eat', date: '2026-08-31', amount: EATING, pending: false,
    categoryLabel: 'Restaurants', accountRole: 'household-cash',
    displayedPayee: 'White Spot', originalMerchant: 'White Spot',
  },
  {
    id: 'tx-dale', date: '2026-08-30', amount: DALE, pending: false,
    categoryLabel: 'Dale', accountRole: 'household-cash',
    displayedPayee: 'Steam', originalMerchant: 'Steam',
  },
  {
    id: 'tx-amanda', date: '2026-08-30', amount: AMANDA, pending: false,
    categoryLabel: 'Amanda', accountRole: 'household-cash',
    displayedPayee: 'Sephora', originalMerchant: 'Sephora',
  },
  {
    id: 'tx-mortgage', date: '2026-08-28', amount: 1600, pending: false,
    categoryLabel: 'Mortgage', accountRole: 'household-cash',
  },
  {
    id: 'tx-before', date: '2026-08-01', amount: 9.99, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Too Early', originalMerchant: 'Too Early',
  },
];

const plan = syntheticPlan();

console.log('\n=== 1. Forecast classifier, not page-side label equality, owns membership ===');
{
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[0], plan).categoryId === 'groceries',
    'Groceries categoryLabel classifies as groceries');
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[1], plan).categoryId === 'fuel',
    'Fuel categoryLabel classifies as fuel');
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[2], plan).categoryId === 'restaurants'
      && overlayTxs[2].categoryLabel === 'Restaurants',
    'Restaurants categoryLabel classifies as eating out, not a row-label match');
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[3], plan).categoryId === 'dale-guilt-free',
    'Dale categoryLabel classifies as dale-guilt-free');
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[4], plan).categoryId === 'amanda-guilt-free',
    'Amanda categoryLabel classifies as amanda-guilt-free');
  ok(F.classifyCurrentPeriodTransaction(overlayTxs[5], plan).kind === 'bill',
    'Mortgage is an excluded bill kind');
}

const PARENT = 70.10;
const CHILD_A = 40.00;
const CHILD_B = 30.10;
const splitParent = {
  id: 'tx-groc-parent', date: '2026-08-29', amount: PARENT, pending: false,
  isGroup: true, categoryLabel: 'Groceries', accountRole: 'household-cash',
  displayedPayee: 'Save-On-Foods group', originalMerchant: 'Save-On-Foods group',
};
const splitChildA = {
  id: 'tx-groc-child-a', date: '2026-08-29', amount: CHILD_A, pending: false,
  parentId: 'tx-groc-parent', categoryLabel: 'Groceries',
  accountRole: 'household-cash',
  displayedPayee: 'Save-On-Foods produce', originalMerchant: 'Save-On-Foods produce',
};
const splitChildB = {
  id: 'tx-groc-child-b', date: '2026-08-29', amount: CHILD_B, pending: false,
  parentId: 'tx-groc-parent', categoryLabel: 'Groceries',
  accountRole: 'household-cash',
  displayedPayee: 'Save-On-Foods dairy', originalMerchant: 'Save-On-Foods dairy',
};
const splitPacket = [splitParent, splitChildA, splitChildB];

console.log('\n=== 2. split parent excluded; children stay supporting-spend members ===');
{
  const skip = F.classifyCurrentPeriodTransaction.skipSplitParent;
  ok(typeof skip === 'function'
      && skip(splitParent, { transactions: splitPacket }) === true
      && skip(splitChildA, { transactions: splitPacket }) === false
      && skip(splitChildB, { transactions: splitPacket }) === false,
    'Forecast skipSplitParent excludes the group parent and keeps both children');
  const childACls = F.classifyCurrentPeriodTransaction(splitChildA, plan);
  const childBCls = F.classifyCurrentPeriodTransaction(splitChildB, plan);
  const parentCls = F.classifyCurrentPeriodTransaction(splitParent, plan);
  const eligible = F.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible;
  ok(childACls.categoryId === 'groceries' && childBCls.categoryId === 'groceries'
      && eligible(childACls) === true && eligible(childBCls) === true,
    'children classify onto Groceries and remain HH-budget eligible as Forecast recon would');
  ok(parentCls.categoryId === 'groceries' && eligible(parentCls) === true,
    'parent would classify onto Groceries if skipSplitParent did not exclude it');
  ok(near(roundCent(CHILD_A + CHILD_B), PARENT),
    'constructed parent amount equals the child sum (independent of the page)');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
