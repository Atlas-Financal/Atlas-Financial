'use strict';
/* An eligible debit labelled exactly Uncategorised enters Other Spending once.
 *
 * Synthetic payday Sep 11–Sep 24, read on Sep 18. Expected remainders are
 * fixture arithmetic, not a reading of the residual helper (L-002 / L-006):
 *   income $2,000 − assigned bill $400 − Groceries plannedPayday $450 = $1,150
 *   the same plan plus one $40 Uncategorised debit = $1,110
 *
 * The second method sums the Other Spending recon the page prints and
 * rebuilds income − bills − Groceries hold − that sum.
 *
 * `node test/test-uncategorised-other-spending.js`
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
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarBudgetHtml, runningLeftoverHtml, money2 });`,
    { Forecast: F }
  );
}

const composer = loadComposer();

const PAYDAY = '2026-09-11';
const AS_OF = '2026-09-18';
const INCOME = 2000;
const BILL = 400;
const GROCERY_PLAN = 450;
const UNCAT = 40;
const BLANK = 40;
const BLANK_WITH_UNCAT = 15;
const CONTROL_REMAINDER = roundCent(INCOME - BILL - GROCERY_PLAN);
const UNCAT_REMAINDER = roundCent(CONTROL_REMAINDER - UNCAT);
const BLANK_REMAINDER = roundCent(CONTROL_REMAINDER - BLANK);
const BOTH_REMAINDER = roundCent(CONTROL_REMAINDER - UNCAT - BLANK_WITH_UNCAT);

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 500 },
        { id: 'chequing-b', label: 'Weekly', value: 300 },
      ],
    },
    opening: {
      asOf: AS_OF,
      priorAsOf: PAYDAY,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: 800 },
      representedEvents: [],
    },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: INCOME, confidence: 'confirmed',
    }],
    bills: [{
      id: 'hydro', label: 'BC Hydro', frequency: 'once',
      date: '2026-09-12', amount: BILL, confidence: 'confirmed',
      payingAccount: 'chequing-a',
    }],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: GROCERY_PLAN, ownerLine: 'Groceries',
        },
        {
          id: 'uncategorised', label: 'Uncategorised', class: 'discretionary',
          from: ['Uncategorised'],
        },
        { id: 'health', label: 'Health', class: 'essential', from: ['Health'] },
        {
          id: 'household', label: 'Household', class: 'essential',
          from: ['Household'], plannedMonthly: 0,
        },
      ],
    },
  };
}

function packet(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: PAYDAY,
    coverageThrough: AS_OF,
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    representedActuals: [],
    transactions: txs,
  };
}

function debit(extra) {
  return Object.assign({
    id: 'tx-uncat',
    date: '2026-09-12',
    amount: UNCAT,
    pending: false,
    categoryLabel: 'Uncategorised',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'Corner Store',
    originalMerchant: 'Corner Store',
  }, extra || {});
}

function recommend(txs) {
  return F.recommend(syntheticPlan(), AS_OF, {
    targetBuffer: 0,
    debts: [],
    currentPeriodActuals: packet(txs),
  });
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r && r.id === id) || null;
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function reconIds(p) {
  const ids = [];
  for (const row of (p && p.householdBudget) || []) {
    for (const tx of row.recon || []) {
      if (tx && tx.id) ids.push(tx.id);
    }
  }
  return ids;
}
function reconSum(row) {
  return roundCent((row && row.recon || []).reduce((s, tx) => {
    if (tx && tx.pendingPostedDuplicate === true && tx.pending === true) return s;
    return s + (Number(tx && tx.amount) || 0);
  }, 0));
}
function active(txs) {
  return period(recommend(txs).defaultView, 'this-pay-period');
}

function assertIncomeAndBill(p, label) {
  ok(p && near(p.incomeTotal, INCOME) && near(p.periodBillLoad, BILL)
      && near(p.afterBills, roundCent(INCOME - BILL)),
    label || 'period income is $2,000 and the assigned bill is $400');
}

console.log('\n=== 1. the $40 debit stays spend / uncategorised ===');
{
  ok(near(CONTROL_REMAINDER, 1150) && near(UNCAT_REMAINDER, 1110),
    'independent remainder is $2,000 − $400 − $450 = $1,150, then − $40 = $1,110');
  const tx = debit();
  const plan = syntheticPlan();
  const cls = F.classifyCurrentPeriodTransaction(tx, plan, { packet: packet([tx]) });
  ok(cls.kind === 'spend' && cls.categoryId === 'uncategorised'
      && cls.needsConfirmation === false && cls.atlasRow === 'uncategorised',
    'Lunch Money Uncategorised stays the incumbent remainder category as spend');
  ok(cls.kind !== 'income' && cls.kind !== 'bill' && cls.kind !== 'transfer'
      && cls.kind !== 'internal-movement' && cls.kind !== 'card-payment',
    'the debit is not income, a bill, a transfer, or a card payment');
  ok(tx.representedBill !== true,
    'the debit is not a represented bill actual');
}

console.log('\n=== 2. Uncategorised enters Other Spending once and lowers the remainder $40 ===');
{
  const control = active([]);
  const treated = active([debit()]);
  const groceries = budgetRow(treated, 'groceries');
  const other = otherRow(treated);
  const ids = reconIds(treated);
  const summed = reconSum(other);
  const rebuilt = roundCent(
    treated.incomeTotal - treated.periodBillLoad - groceries.hold - summed
  );
  assertIncomeAndBill(control, 'control income and bill load are the fixture amounts');
  assertIncomeAndBill(treated, 'Uncategorised debit does not change income or the bill load');
  ok(!otherRow(control) && near(control.budgetHold, GROCERY_PLAN)
      && near(control.afterHouseholdBudget, CONTROL_REMAINDER)
      && near(control.balanceAfterDeductions, CONTROL_REMAINDER),
    'control remainder is $1,150 with no Other Spending row');
  ok(groceries && near(groceries.planned, GROCERY_PLAN) && near(groceries.hold, GROCERY_PLAN)
      && near(groceries.spent, 0),
    'Groceries hold remains the $450 planned reserve');
  ok(other && other.id === 'other-spending' && other.planned == null
      && near(other.spent, UNCAT) && near(other.hold, UNCAT) && near(summed, UNCAT),
    'Other Spending actual is the recon sum $40, with no planned reserve');
  ok(ids.filter(id => id === 'tx-uncat').length === 1 && new Set(ids).size === ids.length,
    'the debit appears on Other Spending exactly once and on no other row');
  ok(!budgetRow(treated, 'uncategorised'),
    'no planned-category reserve is created for Uncategorised');
  ok(near(treated.budgetHold, roundCent(GROCERY_PLAN + UNCAT))
      && near(treated.afterHouseholdBudget, UNCAT_REMAINDER)
      && near(treated.balanceAfterDeductions, UNCAT_REMAINDER)
      && near(control.afterHouseholdBudget - treated.afterHouseholdBudget, UNCAT)
      && near(rebuilt, UNCAT_REMAINDER),
    'published remainder falls $40, matching income − bills − Groceries hold − recon sum');
  const terms = treated.predictedEndingBalanceTerms;
  ok(terms && terms.identity === 'balance-after-deductions' && terms.closes === true
      && near(terms.periodIncome, INCOME) && near(terms.assignedBills, BILL)
      && near(terms.householdBudgetHold, roundCent(GROCERY_PLAN + UNCAT))
      && near(terms.balanceAfterDeductions, UNCAT_REMAINDER),
    'Balance After Deductions closes on the fixture identity');
  ok(!near(treated.afterHouseholdBudget, CONTROL_REMAINDER)
      && !near(treated.afterHouseholdBudget, roundCent(UNCAT_REMAINDER - UNCAT)),
    'the debit is not omitted and is not deducted twice');
}

console.log('\n=== 3. a blank category still enters Other Spending once ===');
{
  const tx = debit({ id: 'tx-blank', amount: BLANK });
  delete tx.categoryLabel;
  const plan = syntheticPlan();
  const cls = F.classifyCurrentPeriodTransaction(tx, plan);
  ok(cls.needsConfirmation === true && cls.kind === 'unclassified'
      && cls.kind !== 'spend',
    'a blank category stays the incumbent needsConfirmation residual');
  const treated = active([tx]);
  const control = active([]);
  const other = otherRow(treated);
  const ids = reconIds(treated);
  assertIncomeAndBill(treated);
  ok(budgetRow(treated, 'groceries') && near(budgetRow(treated, 'groceries').hold, GROCERY_PLAN),
    'blank-category spend leaves the Groceries hold at $450');
  ok(other && near(other.spent, BLANK) && near(reconSum(other), BLANK)
      && other.planned == null
      && ids.filter(id => id === 'tx-blank').length === 1,
    'blank category is in Other Spending once for $40');
  ok(near(treated.afterHouseholdBudget, BLANK_REMAINDER)
      && near(control.afterHouseholdBudget - treated.afterHouseholdBudget, BLANK),
    'blank category lowers the published remainder by $40');
}

console.log('\n=== 4. blank and Uncategorised add once each ===');
{
  const blank = debit({ id: 'tx-blank', amount: BLANK_WITH_UNCAT });
  delete blank.categoryLabel;
  const treated = active([debit(), blank]);
  const other = otherRow(treated);
  const ids = reconIds(treated);
  const summed = reconSum(other);
  ok(near(summed, roundCent(UNCAT + BLANK_WITH_UNCAT))
      && other && near(other.spent, summed) && near(other.hold, summed),
    'Other Spending is $40 + $15 = $55');
  ok(ids.filter(id => id === 'tx-uncat').length === 1
      && ids.filter(id => id === 'tx-blank').length === 1
      && new Set(ids).size === ids.length,
    'each debit is listed once');
  ok(near(budgetRow(treated, 'groceries').hold, GROCERY_PLAN)
      && near(treated.afterHouseholdBudget, BOTH_REMAINDER)
      && near(treated.incomeTotal - treated.periodBillLoad
        - budgetRow(treated, 'groceries').hold - summed, BOTH_REMAINDER),
    'the published remainder falls $55 against the same income, bill, and Groceries hold');
}

console.log('\n=== 5. non-calendar and $0-target spend lands in Other once ===');
{
  const health = debit({
    id: 'tx-health', categoryLabel: 'Health', amount: 40,
    displayedPayee: 'Clinic', originalMerchant: 'Clinic',
  });
  const household = debit({
    id: 'tx-household', categoryLabel: 'Household', amount: 40,
    displayedPayee: 'Hardware', originalMerchant: 'Hardware',
  });
  const plan = syntheticPlan();
  const healthCls = F.classifyCurrentPeriodTransaction(health, plan);
  const householdCls = F.classifyCurrentPeriodTransaction(household, plan);
  ok(healthCls.kind === 'spend' && healthCls.categoryId === 'health',
    'Health stays a named non-calendar spend');
  ok(householdCls.kind === 'spend' && householdCls.categoryId === 'household',
    'Household stays its own category');
  // Owner (Dale, 2026-11-11; ARCHITECTURE.md Household Budget amendment):
  // what fits no budget category lands in Other spending and counts as spend.
  // Health is a named category with no calendar Budget row, so its $40 lands
  // in Other once: $1,150 - $40 = $1,110.
  const healthOnly = active([health]);
  const healthOther = otherRow(healthOnly);
  ok(!budgetRow(healthOnly, 'health') && healthOther && near(healthOther.spent, 40)
      && near(healthOther.hold, 40)
      && reconIds(healthOnly).filter(id => id === 'tx-health').length === 1,
    'Health (non-calendar) has no row of its own and lands its $40 in Other Spending once');
  ok(near(budgetRow(healthOnly, 'groceries').hold, GROCERY_PLAN)
      && near(healthOnly.afterHouseholdBudget, roundCent(CONTROL_REMAINDER - 40))
      && near(healthOnly.periodBillLoad, BILL),
    'the remainder falls $40 to $1,110');
  // Household is a calendar category whose explicit $0 monthly baseline gives
  // it no row this period; its $40 also lands in Other. Together with Health:
  // Other = 80, once each, and the remainder is $1,150 - $80 = $1,070.
  const treated = active([health, household]);
  const other = otherRow(treated);
  const ids = reconIds(treated);
  ok(!budgetRow(treated, 'household') && other && near(other.spent, 80) && near(other.hold, 80)
      && ids.filter(id => id === 'tx-household').length === 1
      && ids.filter(id => id === 'tx-health').length === 1,
    'Health and the $0 Household baseline each land once in Other spending, $80 in all');
  ok(near(budgetRow(treated, 'groceries').hold, GROCERY_PLAN)
      && near(treated.afterHouseholdBudget, roundCent(CONTROL_REMAINDER - 80))
      && near(treated.periodBillLoad, BILL),
    'the remainder falls $80 to $1,070');
}

console.log('\n=== 6. the page prints the $40 residual and the $1,110 remainder ===');
{
  const treated = active([debit()]);
  const html = composer.calendarBudgetHtml(treated);
  const leftover = composer.runningLeftoverHtml(treated.afterHouseholdBudget);
  ok(/data-other-spending/.test(html)
      && /data-tx-id="tx-uncat"/.test(html)
      && (html.match(/data-tx-id="tx-uncat"/g) || []).length === 1
      && /data-budget-spent-total="other-spending">\$40\.00</.test(html),
    'Household Budget prints the Uncategorised debit once inside Other Spending at $40.00');
  ok(/data-budget-category="groceries"/.test(html)
      && /<dt>Planned<\/dt>[\s\S]*\$450\.00/.test(html)
      && !/data-budget-category="uncategorised"/.test(html),
    'Groceries still prints its $450 planned reserve, and Uncategorised has no planned row');
  ok(leftover.includes(composer.money2(UNCAT_REMAINDER))
      && leftover.includes('$1,110.00'),
    'Balance After Deductions prints the published $1,110.00 remainder');
}

if (failures) {
  console.log('\nFAILED ' + failures);
  process.exit(1);
}
console.log('\nOK');
