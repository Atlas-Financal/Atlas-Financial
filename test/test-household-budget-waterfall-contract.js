'use strict';
/* Payday Household Budget waterfall — owner 2026-09-04 contract.
 *
 * For a frozen payday plan:
 *   afterHouseholdBudget
 *     = afterBills
 *     − Σ max(plannedCategory, actualCategory)
 *     − Other Spending actual
 *
 * Under plan → reserve full plan.
 * At plan → reserve full plan.
 * Over plan → deduct full actual.
 * Other Spending has no planned reserve; deduct current-period actual.
 * Remaining-only leftover and planned-plus-actual are both wrong.
 *
 * Expected leftovers are independent arithmetic (L-002 / L-006).
 * Do not read Forecast's producing helper to invent the expected value.
 *
 * `node test/test-household-budget-waterfall-contract.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const liveData = require('../data.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  }
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

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
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallsHtml, calendarBudgetHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-08-28';
const MID = '2026-09-04';
const FROZEN_OPENING = 5000;
const AFTER_BILLS = 0;
const LIVE_CASH = 4123.45;
const GROCERY_PLAN = 900;
const FUEL_PLAN = 325;
const EATING_PLAN = 200;

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r && r.id === id) || null;
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}

function groceryTx(id, amount, extra) {
  return Object.assign({
    id,
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Groceries',
    accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods',
    originalMerchant: 'Save-On-Foods',
  }, extra || {});
}

function fuelTx(amount) {
  return {
    id: 'tx-fuel',
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Fuel',
    accountRole: 'household-cash',
    displayedPayee: 'Shell',
    originalMerchant: 'Shell',
  };
}

function eatingTx(amount) {
  return {
    id: 'tx-eat',
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Restaurants',
    accountRole: 'household-cash',
  };
}

function otherTx(id, amount) {
  return {
    id,
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Gifts',
    accountRole: 'household-cash',
  };
}

function actualsPacket(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: MID,
    coverageStart: '2026-07-01',
    coverageThrough: MID,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
  };
}

function isolatedCategories(extraCats) {
  return [
    {
      id: 'groceries', label: 'Groceries', class: 'essential',
      from: ['Groceries'], plannedWeekly: 450, ownerLine: 'Groceries',
    },
  ].concat(extraCats || []);
}

function isolatedPlan(extraCats) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: LIVE_CASH },
    opening: {
      asOf: MID,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: FROZEN_OPENING },
      representedEvents: [],
    },
    income: [{
      id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
      anchor: PAYDAY, amount: 0, confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: isolatedCategories(extraCats) },
  };
}

function recommend(plan, txs) {
  return F.recommend(plan, MID, {
    targetBuffer: 0,
    debts: [],
    currentPeriodActuals: actualsPacket(txs || []),
  });
}

function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function independentSeaspanDates(anchor, from, to) {
  const out = [];
  let t = anchor;
  while (t > from) t = addDays(t, -14);
  while (t <= to) {
    if (t >= from) out.push(t);
    t = addDays(t, 14);
  }
  return out;
}

function independentDogFoodPlanned(anchor, start) {
  const [y, m] = String(start).split('-').map(Number);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const first = independentSeaspanDates(anchor, monthStart, monthEnd)
    .find(d => String(d).slice(0, 7) === String(start).slice(0, 7));
  return first === start ? 100 : 0;
}

const composer = loadComposer();

function assertAfterBills(active, label) {
  ok(active && active.openingKnown === true && active.openingSource === 'snapshot'
      && near(active.afterBills, AFTER_BILLS) && !near(active.available, LIVE_CASH),
    label || 'Balance after bills is displayed income minus assigned bills, not payday opening or live cash');
}

console.log('=== 1. under plan reserves the full planned amount ===');
{
  const spent = 600;
  const expectedHold = Math.max(GROCERY_PLAN, spent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 900) && near(expectedAfter, -900),
    'independent: max(900, 600) = $900; income $0 − $0 − $900 = −$900');
  const advice = recommend(isolatedPlan(), [groceryTx('tx-groc', spent)]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  assertAfterBills(active);
  ok(groc && near(groc.planned, GROCERY_PLAN) && near(groc.spent, spent)
      && near(groc.hold, expectedHold) && near(groc.overspend, 0),
    'Groceries hold is $900, not remaining $300');
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter),
    'Balance After Deductions is −$900');
  ok(!near(active.afterHouseholdBudget, 4700),
    'Forecast does not subtract only the $300 remaining hold');
  ok(!near(active.afterHouseholdBudget, 3500),
    'Forecast does not subtract plan + actual ($1,500)');
}

console.log('=== 2. exactly at plan reserves the planned amount ===');
{
  const spent = 900;
  const expectedHold = Math.max(GROCERY_PLAN, spent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 900) && near(expectedAfter, -900),
    'independent: max(900, 900) = $900; leftover −$900');
  const advice = recommend(isolatedPlan(), [groceryTx('tx-groc', spent)]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  assertAfterBills(active);
  ok(groc && near(groc.hold, 900) && near(groc.overspend, 0)
      && near(active.afterHouseholdBudget, expectedAfter),
    'at-plan Groceries hold stays $900; leftover −$900');
}

console.log('=== 3. overspend deducts the full actual ===');
{
  const spent = 1000;
  const expectedHold = Math.max(GROCERY_PLAN, spent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 1000) && near(expectedAfter, -1000),
    'independent: max(900, 1000) = $1,000; leftover −$1,000');
  const advice = recommend(isolatedPlan(), [groceryTx('tx-groc', spent)]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  assertAfterBills(active);
  ok(groc && near(groc.hold, 1000) && near(groc.overspend, 100)
      && near(active.budgetHold, 1000)
      && near(active.afterHouseholdBudget, expectedAfter),
    'overspend $100 reduces Balance After Deductions to −$1,000');
  ok(!near(active.afterHouseholdBudget, -900)
      && !near(groc.hold, 0),
    'overspend does not floor the grocery hold at $0 and forget the $100');
  ok(!near(active.afterHouseholdBudget, 3100),
    'Forecast does not subtract plan + actual ($1,900)');
}

console.log('=== 4. Other Spending actual is added once ===');
{
  const grocerySpent = 600;
  const otherSpent = 250;
  const expectedHold = roundCent(Math.max(GROCERY_PLAN, grocerySpent) + otherSpent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 1150) && near(expectedAfter, -1150),
    'independent: $900 + $250 Other = $1,150; leftover −$1,150');
  const advice = recommend(isolatedPlan(), [
    groceryTx('tx-groc', grocerySpent),
    otherTx('tx-other', otherSpent),
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  const other = otherRow(active);
  assertAfterBills(active);
  ok(groc && near(groc.hold, 900) && other && near(other.spent, otherSpent)
      && near(other.hold, otherSpent) && other.planned == null,
    'Other Spending has no planned reserve; hold equals actual $250');
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter),
    'Balance After Deductions is −$1,150');
}

console.log('=== 5. overspend plus Other Spending ===');
{
  const grocerySpent = 1000;
  const otherSpent = 250;
  const expectedHold = roundCent(Math.max(GROCERY_PLAN, grocerySpent) + otherSpent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 1250) && near(expectedAfter, -1250),
    'independent: $1,000 + $250 = $1,250; leftover −$1,250');
  const advice = recommend(isolatedPlan(), [
    groceryTx('tx-groc', grocerySpent),
    otherTx('tx-other', otherSpent),
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  assertAfterBills(active);
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter),
    'overspend + Other Spending leftover is −$1,250');
}

console.log('=== 6. multiple planned categories plus Other Spending ===');
{
  const grocerySpent = 1000;
  const fuelSpent = 200;
  const eatingSpent = 250;
  const otherSpent = 100;
  const expectedHold = roundCent(
    Math.max(GROCERY_PLAN, grocerySpent)
    + Math.max(FUEL_PLAN, fuelSpent)
    + Math.max(EATING_PLAN, eatingSpent)
    + otherSpent
  );
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 1675) && near(expectedAfter, -1675),
    'independent: 1000+325+250+100 = $1,675; leftover −$1,675');
  const plan = isolatedPlan([
    { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 325, ownerLine: 'Fuel' },
    {
      id: 'restaurants', label: 'Dining', class: 'discretionary',
      from: ['Restaurants', 'Fast Food', 'Food Delivery'],
      plannedPayday: 200, ownerLine: 'Eating out',
    },
  ]);
  const advice = recommend(plan, [
    groceryTx('tx-groc', grocerySpent),
    fuelTx(fuelSpent),
    eatingTx(eatingSpent),
    otherTx('tx-other', otherSpent),
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  const fuel = budgetRow(active, 'fuel');
  const eating = budgetRow(active, 'restaurants');
  const other = otherRow(active);
  assertAfterBills(active);
  ok(groc && near(groc.hold, 1000) && fuel && near(fuel.hold, 325)
      && eating && near(eating.hold, 250)
      && other && near(other.hold, 100),
    'each category uses max(planned, actual); Other uses actual');
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter),
    'Forecast effective Household Budget deduction is independently $1,675');
}

console.log('=== 7. reclassification does not double-count ===');
{
  const groceryBase = 850;
  const moving = 100;
  const stateAHold = roundCent(Math.max(GROCERY_PLAN, groceryBase) + moving);
  const stateBHold = roundCent(Math.max(GROCERY_PLAN, groceryBase + moving));
  ok(near(stateAHold, 1000) && near(stateBHold, 950),
    'independent: unassigned $1,000; classified grocery $950');
  const stateA = recommend(isolatedPlan(), [
    groceryTx('tx-groc', groceryBase),
    otherTx('tx-move', moving),
  ]);
  const a = period(stateA.defaultView, 'this-pay-period');
  const aGroc = budgetRow(a, 'groceries');
  const aOther = otherRow(a);
  ok(aGroc && near(aGroc.hold, 900) && aOther && near(aOther.hold, 100)
      && near(a.budgetHold, stateAHold),
    'STATE A: unused grocery reserve $900 plus unassigned $100 = $1,000');
  const stateB = recommend(isolatedPlan(), [
    groceryTx('tx-groc', groceryBase),
    groceryTx('tx-move', moving),
  ]);
  const b = period(stateB.defaultView, 'this-pay-period');
  const bGroc = budgetRow(b, 'groceries');
  const bOther = otherRow(b);
  ok(bGroc && near(bGroc.spent, 950) && near(bGroc.hold, 950) && !bOther
      && near(b.budgetHold, stateBHold),
    'STATE B: same $100 is groceries; effective hold $950; Other gone');
  const reconA = [];
  const reconB = [];
  for (const row of a.householdBudget || []) {
    for (const tx of row.recon || []) if (tx && tx.id) reconA.push(tx.id);
  }
  for (const row of b.householdBudget || []) {
    for (const tx of row.recon || []) if (tx && tx.id) reconB.push(tx.id);
  }
  ok(new Set(reconA).size === reconA.length && reconA.includes('tx-move'),
    'STATE A lists tx-move once');
  ok(new Set(reconB).size === reconB.length && reconB.includes('tx-move')
      && reconB.includes('tx-groc'),
    'STATE B lists each grocery tx once and does not keep tx-move on Other');
}

console.log('=== 8. Dog food first-Seaspan-of-month cadence is unchanged ===');
{
  const petsCat = {
    id: 'pets', label: 'Pets', class: 'essential', from: ['Pets'],
    plannedPayday: 100, paydayCadence: 'first-seaspan-of-month', ownerLine: 'Dog food',
  };
  const firstStart = '2026-08-14';
  const laterStart = '2026-08-28';
  ok(independentDogFoodPlanned('2026-08-14', firstStart) === 100
      && independentDogFoodPlanned('2026-08-14', laterStart) === 0,
    'independent cadence: Aug 14 holds $100; Aug 28 holds $0');
  const firstPlan = isolatedPlan([petsCat]);
  firstPlan.opening.paydaySnapshot = {
    periodStart: firstStart, asOf: firstStart, opening: FROZEN_OPENING,
  };
  firstPlan.opening.asOf = '2026-08-16';
  firstPlan.income[0].anchor = '2026-08-14';
  const firstAdvice = F.recommend(firstPlan, '2026-08-16', {
    targetBuffer: 0, debts: [],
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: '2026-08-16',
      coverageStart: '2026-07-01',
      coverageThrough: '2026-08-16',
      transactionCoverage: 'complete', pendingCoverage: 'complete',
      transactions: [],
    },
  });
  const first = period(firstAdvice.defaultView, 'this-pay-period');
  const firstPets = budgetRow(first, 'pets');
  ok(firstPets && near(firstPets.planned, 100)
      && near(firstPets.hold, Math.max(100, 0)),
    'first Seaspan payday of August plans and holds $100 Dog food');

  const laterPlan = isolatedPlan([petsCat]);
  const laterAdvice = recommend(laterPlan, []);
  const later = period(laterAdvice.defaultView, 'this-pay-period');
  const laterPets = budgetRow(later, 'pets');
  ok(laterPets && near(laterPets.planned, 0)
      && near(laterPets.hold, Math.max(0, 0)),
    'later Seaspan payday in August plans and holds $0 Dog food');
}

console.log('=== 9. removed Household $37.50 does not return ===');
{
  const cats = ((liveData.plan && liveData.plan.budget && liveData.plan.budget.categories) || []);
  const household = cats.find(c => c && c.id === 'household');
  ok(household && household.plannedMonthly === 0
      && household.plannedPayday == null && household.plannedWeekly == null,
    'live plan keeps Household as explicit $0 monthly, not $37.50');
  const advice = F.recommend(liveData.plan, liveData.plan.opening.asOf, {
    debts: liveData.debts || [],
  });
  const active = period(advice.defaultView, 'this-pay-period')
    || ((advice.defaultView && advice.defaultView.calendarPeriods) || [])[0];
  const row = active && budgetRow(active, 'household');
  ok(!row,
    'live payday Household Budget has no Household $37.50 planned row');
  const isolated = isolatedPlan();
  const isolatedAdvice = recommend(isolated, []);
  const isolatedActive = period(isolatedAdvice.defaultView, 'this-pay-period');
  ok(!budgetRow(isolatedActive, 'household')
      && near(isolatedActive.budgetHold, GROCERY_PLAN),
    'isolated proof hold is groceries $900 only; Household $37.50 is absent');
}

console.log('=== 10. pending→posted identity counts actual spend once ===');
{
  const amount = 80;
  const twins = [
    groceryTx('tx-post', amount, {
      pending: false,
      pendingPostedDuplicate: true,
      atlasAccountId: 'chequing-a',
      account: 'chequing-a',
    }),
    groceryTx('tx-pend', amount, {
      pending: true,
      pendingPostedDuplicate: true,
      atlasAccountId: 'chequing-a',
      account: 'chequing-a',
    }),
  ];
  const advice = recommend(isolatedPlan(), twins);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  const expectedHold = Math.max(GROCERY_PLAN, amount);
  ok(groc && near(groc.spent, amount) && !near(groc.spent, amount * 2)
      && near(groc.hold, expectedHold)
      && (groc.recon || []).length === 2
      && (groc.recon || []).some(r => r.pending === true && r.pendingPostedDuplicate === true),
    'pending+posted flagged pair contributes $80 once; hold stays $900');
  const similarButDistinct = recommend(isolatedPlan(), [
    groceryTx('tx-a', amount, {
      date: PAYDAY,
      displayedPayee: 'Save-On-Foods',
      originalMerchant: 'Save-On-Foods',
      atlasAccountId: 'chequing-a',
      account: 'chequing-a',
    }),
    groceryTx('tx-b', amount, {
      date: '2026-08-29',
      displayedPayee: 'Save-On-Foods',
      originalMerchant: 'Save-On-Foods',
      atlasAccountId: 'chequing-a',
      account: 'chequing-a',
    }),
  ]);
  const two = budgetRow(period(similarButDistinct.defaultView, 'this-pay-period'), 'groceries');
  ok(two && near(two.spent, 160) && near(two.hold, Math.max(GROCERY_PLAN, 160)),
    'two distinct grocery txs still count separately; merchant/date/amount is not a new identity');
}

console.log('=== 11. bills do not enter Household Budget actuals ===');
{
  const plan = isolatedPlan();
  plan.bills = [{
    id: 'bill-cash', label: 'Cash bill', frequency: 'once',
    date: '2026-09-01', amount: 200, confidence: 'confirmed',
    payingAccount: 'chequing-a',
  }];
  const advice = recommend(plan, [
    groceryTx('tx-groc', 600),
    {
      id: 'tx-mortgage', date: PAYDAY, amount: 1600, pending: false,
      categoryLabel: 'Mortgage', accountRole: 'household-cash',
    },
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  const groc = budgetRow(active, 'groceries');
  const reconIds = [];
  for (const row of active.householdBudget || []) {
    for (const tx of row.recon || []) if (tx && tx.id) reconIds.push(tx.id);
  }
  ok(groc && near(groc.spent, 600) && !reconIds.includes('tx-mortgage'),
    'mortgage bill is absent from Household Budget recon');
  ok(near(active.budgetHold, 900),
    'bill dollars do not inflate the Household Budget hold');
}

function displayedHouseholdBudgetTotal(html) {
  const match = /data-household-budget-total-amount>([^<]+)</.exec(html || '');
  return match ? match[1] : null;
}

console.log('=== 12. Plan renders Forecast leftovers; it does not recalculate them ===');
{
  const spent = 1000;
  const otherSpent = 250;
  const expectedHold = roundCent(Math.max(GROCERY_PLAN, spent) + otherSpent);
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  const advice = recommend(isolatedPlan(), [
    groceryTx('tx-groc', spent),
    otherTx('tx-other', otherSpent),
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter),
    'operating pay period uses the owner contract through Forecast');
  const html = composer.calendarWaterfallsHtml(advice.defaultView, 'this-pay-period');
  ok(html && html.includes(composer.money2(active.afterHouseholdBudget))
      && html.includes(composer.money2(active.afterBills)),
    'page prints Forecast afterBills and afterHouseholdBudget');
  const planSrc = read('public/plan.js');
  const waterfallFn = /function calendarWaterfallHtml\([\s\S]*?\n\}/.exec(planSrc);
  const budgetFn = /function calendarBudgetHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(waterfallFn && /period\.afterHouseholdBudget/.test(waterfallFn[0])
      && !/Math\.max\s*\(\s*row\.planned/.test(waterfallFn[0])
      && !/budgetHold\s*=/.test(waterfallFn[0]),
    'calendarWaterfallHtml prints Forecast afterHouseholdBudget and does not recompute hold');
  ok(budgetFn && !/Math\.max\s*\(\s*.*planned/.test(budgetFn[0]),
    'calendarBudgetHtml does not compute max(planned, spent)');
}

console.log('=== 13. Protective spending reserve is Forecast budgetHold, not a page sum ===');
{
  const grocerySpent = 1000;
  const fuelSpent = 200;
  const eatingSpent = 250;
  const otherSpent = 100;
  const expectedHold = roundCent(
    Math.max(GROCERY_PLAN, grocerySpent)
    + Math.max(FUEL_PLAN, fuelSpent)
    + Math.max(EATING_PLAN, eatingSpent)
    + otherSpent
  );
  const expectedAfter = roundCent(AFTER_BILLS - expectedHold);
  ok(near(expectedHold, 1675) && near(expectedAfter, -1675),
    'independent: 1000+325+250+100 = $1,675; leftover −$1,675');
  const plan = isolatedPlan([
    { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 325, ownerLine: 'Fuel' },
    {
      id: 'restaurants', label: 'Dining', class: 'discretionary',
      from: ['Restaurants', 'Fast Food', 'Food Delivery'],
      plannedPayday: 200, ownerLine: 'Eating out',
    },
  ]);
  const advice = recommend(plan, [
    groceryTx('tx-groc', grocerySpent),
    fuelTx(fuelSpent),
    eatingTx(eatingSpent),
    otherTx('tx-other', otherSpent),
  ]);
  const active = period(advice.defaultView, 'this-pay-period');
  assertAfterBills(active);
  ok(near(active.budgetHold, expectedHold)
      && near(active.afterHouseholdBudget, expectedAfter)
      && near(roundCent(active.afterBills - active.budgetHold), active.afterHouseholdBudget),
    'Forecast leftover identity: afterBills − budgetHold = afterHouseholdBudget');
  const html = composer.calendarBudgetHtml(active);
  const printed = displayedHouseholdBudgetTotal(html);
  ok(/Protective spending reserve/.test(html)
      && printed === composer.money2(active.budgetHold)
      && printed === composer.money2(expectedHold),
    'protective spending reserve prints Forecast budgetHold $1,675.00',
    printed);
  ok(/data-budget-category="groceries"/.test(html)
      && /data-budget-category="fuel"/.test(html)
      && /data-budget-category="restaurants"/.test(html)
      && /data-other-spending/.test(html)
      && /<dt>Planned<\/dt>/.test(html)
      && /<dt>Spent<\/dt>/.test(html)
      && /<dt>Remaining<\/dt>/.test(html),
    'category rows and drilldowns remain on the section');
  const waterfall = composer.calendarWaterfallsHtml(advice.defaultView, 'this-pay-period');
  ok(displayedHouseholdBudgetTotal(waterfall) === composer.money2(expectedHold)
      && waterfall.includes(composer.money2(active.afterBills))
      && waterfall.includes(composer.money2(active.afterHouseholdBudget)),
    'waterfall prints afterBills, Household Budget Total, and afterHouseholdBudget from Forecast');
  const planSrc = read('public/plan.js');
  const budgetFn = /function calendarBudgetHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(budgetFn && /period\.budgetHold/.test(budgetFn[0])
      && /Protective spending reserve/.test(budgetFn[0])
      && /data-household-budget-total/.test(budgetFn[0])
      && !/\.reduce\s*\(/.test(budgetFn[0])
      && !/row\.hold/.test(budgetFn[0])
      && !/row\.planned/.test(budgetFn[0])
      && !/row\.spent\s*[+\-]/.test(budgetFn[0])
      && /row\.spent\s*!=\s*null/.test(budgetFn[0]),
    'calendarBudgetHtml consumes period.budgetHold and does not sum category rows');
  const snapSrc = read('scripts/figures-snapshot.js');
  ok(/operating\.this\.householdBudgetTotal/.test(snapSrc)
      && /thisPeriod\.budgetHold/.test(snapSrc)
      && /operating\.next\.householdBudgetTotal/.test(snapSrc)
      && /nextPeriod\.budgetHold/.test(snapSrc),
    'figures snapshot keys Household Budget Total from Forecast budgetHold');
}

console.log('=== 14. unavailable and empty sections do not invent a total ===');
{
  const unavailable = composer.calendarBudgetHtml({
    operatingPlanUnavailable: true,
    budgetHold: 1825,
    householdBudget: [{ id: 'groceries', label: 'Groceries', planned: 900 }],
  });
  ok(/data-operating-plan="unavailable"/.test(unavailable)
      && !/Household Budget Total/.test(unavailable)
      && !/data-household-budget-total/.test(unavailable),
    'unavailable Household Budget section does not print a deduction total');
  const emptyHold = composer.calendarBudgetHtml({
    householdBudget: [],
    budgetHold: 0,
  });
  ok(/No household budget lines on this plan/.test(emptyHold)
      && displayedHouseholdBudgetTotal(emptyHold) === composer.money2(0),
    'empty rows still print Forecast budgetHold $0.00');
  const emptyNull = composer.calendarBudgetHtml({
    householdBudget: [],
    budgetHold: null,
  });
  ok(/No household budget lines on this plan/.test(emptyNull)
      && !/Household Budget Total/.test(emptyNull),
    'null budgetHold does not print Household Budget Total');
}

if (failures) {
  console.log('\n' + failures + ' FAILURE(S)');
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
