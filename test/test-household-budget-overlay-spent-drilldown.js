'use strict';
/* Household Budget Spent drill-down from overlay txs when Forecast
 * withheld row.recon (remaining claim unavailable).
 *
 * Presentation only: plan.js lists overlay currentPeriodActuals.transactions
 * in the existing Spent details path. It does not invent spent or remaining.
 * Membership follows Forecast.classifyCurrentPeriodTransaction,
 * householdBudgetSupportingSpendEligible, and skipSplitParent — the same
 * helpers Forecast already owns (L-001). Overlay fallback is withheld-Spent
 * only (`row.spent == null`). Independent arithmetic for the withheld
 * remaining figure (L-002 / L-006).
 *
 * `node test/test-household-budget-overlay-spent-drilldown.js`
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
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
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
    // A planned mortgage payment exists, so the "Mortgage" row is that
    // payment, not household spending (finish-line audit finding 4: the guard
    // holds only while one is planned). Dated beyond this suite's horizon so
    // it moves no figure here.
    obligations: [{ id: 'mortgage', debtId: 'mortgage', effect: 'payment', label: 'Mortgage',
      frequency: 'once', date: '2030-01-15', amount: 1600, confidence: 'confirmed',
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

function block(html, id) {
  const marker = `data-budget-category="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const from = html.lastIndexOf('<div', at);
  const next = html.indexOf('data-budget-category="', at + marker.length);
  if (next < 0) {
    const reserve = html.indexOf('<details class="household-budget-reserve-info"', at);
    return html.slice(from, reserve < 0 ? undefined : reserve);
  }
  const to = html.lastIndexOf('<div', next);
  return html.slice(from, to > from ? to : next);
}
function txIds(html) {
  return [...html.matchAll(/data-tx-id="([^"]+)"/g)].map(m => m[1]);
}
function txPayees(html) {
  return [...html.matchAll(/household-budget-tx-payee">([^<]*)/g)].map(m => m[1]);
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

function withheldPeriod(extraRows) {
  return {
    id: 'this-pay-period',
    role: 'active',
    start: '2026-08-28',
    end: '2026-09-10',
    spendingCycle: { start: '2026-08-28', end: '2026-09-10', rangeLabel: '28 Aug – 10 Sep' },
    householdBudget: [
      { id: 'groceries', label: 'Groceries', planned: GROCERY_PLANNED, spent: null, remaining: GROCERY_PLANNED, recon: [] },
      { id: 'fuel', label: 'Fuel', planned: FUEL_PLANNED, spent: null, remaining: FUEL_PLANNED, recon: [] },
      { id: 'restaurants', label: 'Eating out', planned: EATING_PLANNED, spent: null, remaining: EATING_PLANNED, recon: [] },
      { id: 'dale-guilt-free', label: 'Dale guilt-free spending', planned: DALE_PLANNED, spent: null, remaining: DALE_PLANNED, recon: [] },
      { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', planned: AMANDA_PLANNED, spent: null, remaining: AMANDA_PLANNED, recon: [] },
      { id: 'pets', label: 'Dog food', planned: PETS_PLANNED, spent: null, remaining: PETS_PLANNED, recon: [] },
    ].concat(extraRows || []),
    budgetHold: roundCent(
      GROCERY_PLANNED + FUEL_PLANNED + EATING_PLANNED + DALE_PLANNED + AMANDA_PLANNED + PETS_PLANNED
    ),
  };
}

function overlay(txs) {
  return {
    applied: true,
    currentPeriodActuals: { transactions: txs },
  };
}

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
  const metricSrc = grab(read('public/plan.js'), /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric');
  const categorySrc = grab(read('public/plan.js'), /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml');
  ok(!/classifyCurrentPeriodTransaction/.test(metricSrc + categorySrc)
      && /row\.recon/.test(categorySrc),
    'Spent renderer still consumes recon and does not classify');
}

console.log('\n=== 2. withheld recon + matching overlay txs → expandable Spent details ===');
{
  const html = composer.calendarBudgetHtml(withheldPeriod(), overlay(overlayTxs), plan);
  const groceries = block(html, 'groceries');
  const fuel = block(html, 'fuel');
  const eating = block(html, 'restaurants');
  const dale = block(html, 'dale-guilt-free');
  const amanda = block(html, 'amanda-guilt-free');
  const pets = block(html, 'pets');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="groceries">/.test(groceries)
      && txIds(groceries).join() === 'tx-groc'
      && txPayees(groceries).join() === 'Save-On-Foods'
      && groceries.includes(composer.money2(GROCERY)),
    'Groceries Spent lists the overlay Save-On-Foods tx');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="fuel">/.test(fuel)
      && txIds(fuel).join() === 'tx-fuel'
      && txPayees(fuel).join() === 'Shell',
    'Fuel Spent lists the overlay Shell tx');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="restaurants">/.test(eating)
      && txIds(eating).join() === 'tx-eat'
      && txPayees(eating).join() === 'White Spot'
      && !txPayees(eating).includes('Restaurants')
      && !txPayees(eating).includes('Eating out'),
    'Eating out Spent lists the Restaurants-labelled White Spot tx by Forecast classification');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="dale-guilt-free">/.test(dale)
      && txIds(dale).join() === 'tx-dale'
      && txPayees(dale).join() === 'Steam',
    'Dale guilt-free Spent lists the Dale-labelled overlay tx');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="amanda-guilt-free">/.test(amanda)
      && txIds(amanda).join() === 'tx-amanda'
      && txPayees(amanda).join() === 'Sephora',
    'Amanda guilt-free Spent lists the Amanda-labelled overlay tx');
  ok(!/<details/.test(pets) && !/data-budget-spent="pets"/.test(pets)
      && /<dt>Planned<\/dt>/.test(pets),
    'Pets with no matching overlay tx stays non-expandable');
  ok(!txIds(html).includes('tx-mortgage') && !txIds(html).includes('tx-before'),
    'bills and outside-window overlay txs are absent from every disclosure');
  ok(!/\sopen(>| )/.test(groceries) && !/\sopen="/.test(groceries),
    'overlay disclosure starts collapsed');
}

console.log('\n=== 3. Planned / Remaining stay Forecast-published; spent is not invented ===');
{
  const html = composer.calendarBudgetHtml(withheldPeriod(), overlay(overlayTxs), plan);
  const groceries = block(html, 'groceries');
  const overlaySpent = roundCent(GROCERY);
  const inventedRemaining = roundCent(GROCERY_PLANNED - overlaySpent);
  ok(groceries.includes(composer.money2(GROCERY_PLANNED))
      && /<dt>Planned<\/dt>/.test(groceries)
      && /<dt>Remaining<\/dt>/.test(groceries)
      && /household-budget-remaining/.test(groceries),
    'Groceries Planned and Remaining remain the withheld Forecast figures');
  ok(near(GROCERY_PLANNED, 900) && groceries.includes(composer.money2(900)),
    'fail-closed Remaining is still Planned $900.00');
  ok(!groceries.includes(composer.money2(inventedRemaining))
      && !/data-budget-spent-total="groceries">/.test(groceries),
    'page does not publish overlay-sum remaining or a Spent total');
  ok(/household-budget-spent-amount">—</.test(groceries),
    'withheld Spent amount is an em dash, not $0.00 and not the overlay sum');
  ok(!near(overlaySpent, GROCERY_PLANNED),
    'constructed overlay grocery amount is not the withheld remaining');
}

console.log('\n=== 4. Forecast recon wins; empty overlay keeps the row flat ===');
{
  const period = withheldPeriod();
  period.householdBudget[0] = {
    id: 'groceries', label: 'Groceries',
    planned: GROCERY_PLANNED, spent: GROCERY, remaining: roundCent(GROCERY_PLANNED - GROCERY),
    recon: [{
      id: 'tx-forecast-groc', date: '2026-08-29', amount: GROCERY, pending: false,
      categoryLabel: 'Groceries', displayedPayee: 'Costco', originalMerchant: 'Costco',
    }],
  };
  const html = composer.calendarBudgetHtml(period, overlay(overlayTxs), plan);
  const groceries = block(html, 'groceries');
  ok(txIds(groceries).join() === 'tx-forecast-groc'
      && txPayees(groceries).join() === 'Costco'
      && !txIds(groceries).includes('tx-groc')
      && groceries.includes(`data-budget-spent-total="groceries">${composer.money2(GROCERY)}`),
    'populated Forecast recon is the disclosure; overlay is not a second membership');

  const empty = composer.calendarBudgetHtml(withheldPeriod(), overlay([]), plan);
  ok(!/<details/.test(block(empty, 'groceries'))
      && !/<details/.test(block(empty, 'fuel'))
      && !/<details/.test(block(empty, 'restaurants')),
    'matching-none overlay leaves every HH category non-expandable');

  const future = withheldPeriod();
  future.role = 'future';
  const futureHtml = composer.calendarBudgetHtml(future, overlay(overlayTxs), plan);
  // A reserve Info disclosure is not a transaction disclosure. Prove the
  // original membership boundary directly, including absence of tx evidence.
  ok(!/data-budget-spent=/.test(futureHtml) && !/household-budget-spent-detail/.test(futureHtml)
      && txIds(futureHtml).length === 0,
    'next-period rows do not inherit this-period overlay txs');
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

console.log('\n=== 5. split parent excluded; children stay overlay disclosure members ===');
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

  const html = composer.calendarBudgetHtml(
    withheldPeriod(), overlay(splitPacket.concat([overlayTxs[1]])), plan
  );
  const groceries = block(html, 'groceries');
  const fuel = block(html, 'fuel');
  const grocIds = txIds(groceries);
  const grocPayees = txPayees(groceries);
  ok(/<details class="household-budget-spent-detail" data-budget-spent="groceries">/.test(groceries)
      && grocIds.length === 2
      && grocIds.includes('tx-groc-child-a') && grocIds.includes('tx-groc-child-b')
      && !grocIds.includes('tx-groc-parent')
      && grocPayees.includes('Save-On-Foods produce')
      && grocPayees.includes('Save-On-Foods dairy')
      && !grocPayees.includes('Save-On-Foods group'),
    'Groceries overlay disclosure lists children and omits the LM group parent');
  ok(groceries.includes(composer.money2(CHILD_A))
      && groceries.includes(composer.money2(CHILD_B))
      && !groceries.includes(composer.money2(PARENT))
      && !/data-budget-spent-total="groceries">/.test(groceries)
      && /household-budget-spent-amount">—</.test(groceries),
    'child amounts list; parent total is not printed; Spent stays em dash with no Total');
  ok(txIds(fuel).join() === 'tx-fuel',
    'sibling withheld-Spent Fuel row still lists its overlay tx');
}

console.log('\n=== 6. Forecast-published spent:0 does not attach overlay disclosure ===');
{
  const period = withheldPeriod();
  period.householdBudget[0] = {
    id: 'groceries', label: 'Groceries',
    planned: GROCERY_PLANNED, spent: 0, remaining: GROCERY_PLANNED, recon: [],
  };
  const html = composer.calendarBudgetHtml(period, overlay(overlayTxs), plan);
  const groceries = block(html, 'groceries');
  const fuel = block(html, 'fuel');
  ok(!/<details/.test(groceries) && !/data-budget-spent="groceries"/.test(groceries)
      && !txIds(groceries).length
      && !/data-budget-spent-total/.test(groceries),
    'published spent:0 stays non-expandable; overlay txs are not listed and no Total is printed');
  ok(/<dt>Spent<\/dt>/.test(groceries)
      && groceries.includes(composer.money2(0))
      && !groceries.includes(composer.money2(GROCERY)),
    'Forecast-published Spent $0.00 is printed; overlay grocery amount is absent');
  ok(groceries.includes(composer.money2(GROCERY_PLANNED))
      && /<dt>Planned<\/dt>/.test(groceries)
      && /<dt>Remaining<\/dt>/.test(groceries),
    'Planned and Remaining stay the Forecast-published figures');
  ok(/<details class="household-budget-spent-detail" data-budget-spent="fuel">/.test(fuel)
      && txIds(fuel).join() === 'tx-fuel',
    'sibling withheld-Spent rows still expand from overlay txs');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
