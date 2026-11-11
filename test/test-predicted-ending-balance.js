'use strict';
/* Current-pay-period Balance After Deductions — owner 2026-09-21.
 *
 * Supersedes the pooled Predicted Ending Balance leftover
 * (opening + incomeAdded − bills − hold). Household remaining is:
 *
 *   displayed period income (incomeTotal / available)
 *   − assigned bills (periodBillLoad)
 *   − Household Budget hold
 *   = Balance After Deductions
 *   identity 'balance-after-deductions'
 *
 * Payday balance remains the income identity and is not this answer.
 * The payday-boundary opening is recorded cash and is not a BAD term.
 * paydayAllocation.runningLeftover remains the current-cash allocation
 * chain and is not this answer. Long-horizon baselineTrajectory is
 * untouched. Independent arithmetic (L-002 / L-006). No live cents as
 * the specification.
 *
 * `node test/test-predicted-ending-balance.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Assistant = require('../scripts/assistant-packet.js');
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
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
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
    grab(planSrc, /^function operatingCashExplanationHtml\([\s\S]*?\n\}$/m, 'operatingCashExplanationHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallsHtml, calendarWaterfallHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-09-11';
const AS_OF = '2026-09-18';
const OPENING = 800;
const DALE = 2000;
const AMANDA = 1500;
const CHILD = 219.45;
const BILL = 400;
const GROCERY_PLAN = 900;
const LIVE_CASH = 1234.56;

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}

function groceryTx(amount, extra) {
  return Object.assign({
    id: 'tx-groc',
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Groceries',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'Save-On-Foods',
    originalMerchant: 'Save-On-Foods',
  }, extra || {});
}

function otherTx(amount, extra) {
  return Object.assign({
    id: 'tx-other',
    date: PAYDAY,
    amount,
    pending: false,
    categoryLabel: 'Gifts',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'Unassigned shop',
    originalMerchant: 'Unassigned shop',
  }, extra || {});
}

function actuals(transactions, extra) {
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: PAYDAY,
    coverageThrough: AS_OF,
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    transactions: transactions || [],
    representedActuals: [],
  }, extra || {});
}

function fixturePlan(extra) {
  extra = extra || {};
  return {
    defaults: { targetBuffer: 0 },
    windowDays: 14,
    startingCash: extra.startingCash || {
      amount: LIVE_CASH,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 900 },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 334.56 },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 100 },
      ],
    },
    opening: extra.opening || {
      asOf: AS_OF,
      priorAsOf: PAYDAY,
      representedEvents: extra.representedEvents || [],
      paydaySnapshot: {
        periodStart: PAYDAY,
        asOf: PAYDAY,
        opening: extra.openingAmount != null ? extra.openingAmount : OPENING,
      },
    },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: extra.income || [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Canada Child Benefit', frequency: 'once',
        date: '2026-09-20', amount: CHILD, confidence: 'confirmed',
      },
    ],
    bills: extra.bills || [
      {
        id: 'netflix', label: 'Netflix', frequency: 'once', date: '2026-09-12',
        amount: BILL, confidence: 'confirmed',
      },
    ],
    obligations: extra.obligations || [],
    commitments: extra.commitments || [],
    budget: {
      categories: extra.categories || [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
}

function recommend(plan, txs, extraOpts) {
  return F.recommend(plan, extraOpts && extraOpts.asOf || AS_OF, Object.assign({
    targetBuffer: 0,
    debts: extraOpts && extraOpts.debts || [],
    currentPeriodActuals: actuals(txs, extraOpts && extraOpts.actualsExtra),
  }, extraOpts || {}));
}

function activeOf(advice) {
  return period(advice && advice.defaultView, 'this-pay-period');
}

function independentBad(income, bills, hold) {
  return roundCent(income - bills - hold);
}

const composer = loadComposer();

console.log('=== A. Day-1 leftover is the income-led remainder ===');
{
  const plan = fixturePlan();
  const advice = recommend(plan, []);
  const row = activeOf(advice);
  const income = DALE + AMANDA + CHILD;
  const hold = GROCERY_PLAN;
  const expected = independentBad(income, BILL, hold);
  ok(row && row.openingKnown === true && near(row.opening, OPENING),
    'payday-boundary opening is the recorded snapshot');
  ok(near(row.available, income),
    'Payday balance stays the income identity');
  ok(near(row.budgetHold, hold),
    'Day-1 Household Budget hold is the full grocery plan');
  ok(near(row.afterHouseholdBudget, expected)
      && near(row.predictedEndingBalance, expected)
      && near(row.balanceAfterDeductions, expected),
    'BAD = displayed income − bills − full plan hold',
    `${row && row.afterHouseholdBudget} vs ${expected}`);
  ok(!near(row.afterHouseholdBudget, roundCent(OPENING + income - BILL - hold)),
    'opening is recorded but is not a BAD term');
}

console.log('\n=== B. Spending below plan does not increase leftover ===');
{
  const none = activeOf(recommend(fixturePlan(), []));
  const under = activeOf(recommend(fixturePlan(), [groceryTx(100)]));
  ok(near(under.budgetHold, GROCERY_PLAN)
      && near(under.afterHouseholdBudget, none.afterHouseholdBudget),
    'under-plan groceries keep the $900 hold; BAD does not rise');
}

console.log('\n=== C. Spending above plan reduces leftover by the overage ===');
{
  const atPlan = activeOf(recommend(fixturePlan(), [groceryTx(900)]));
  const over = activeOf(recommend(fixturePlan(), [groceryTx(1050)]));
  ok(near(atPlan.budgetHold, 900) && near(over.budgetHold, 1050),
    'at-plan hold stays $900; overspend hold is $1,050');
  ok(near(atPlan.afterHouseholdBudget - over.afterHouseholdBudget, 150),
    'BAD falls exactly $150 for the grocery overage');
}

console.log('\n=== D. Other Spending reduces leftover dollar-for-dollar ===');
{
  const base = activeOf(recommend(fixturePlan(), [groceryTx(100)]));
  const withOther = activeOf(recommend(fixturePlan(), [
    groceryTx(100),
    otherTx(75),
  ]));
  ok(near(withOther.budgetHold - base.budgetHold, 75)
      && near(base.afterHouseholdBudget - withOther.afterHouseholdBudget, 75),
    'Other Spending $75 reduces BAD by $75 and does not touch the grocery reserve');
}

console.log('\n=== E/F. Cross-account card spend counts once; later payment does not ===');
{
  const cardSpend = groceryTx(200, {
    id: 'tx-visa-groc',
    accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    categoryLabel: 'Groceries',
  });
  const cardPay = {
    id: 'tx-visa-pay',
    date: '2026-09-16',
    amount: 200,
    pending: false,
    categoryLabel: 'Credit Card Payment',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    kindHint: 'card-payment',
    excludeFromTotals: true,
    displayedPayee: 'TRAVEL VISA PAYMENT',
    originalMerchant: 'TRAVEL VISA PAYMENT',
  };
  const none = activeOf(recommend(fixturePlan(), []));
  const cardOnly = activeOf(recommend(fixturePlan(), [cardSpend], {
    debts: [{
      id: 'travelvisa', label: 'Travel Visa', structure: 'Revolving',
      rate: 19.99, balance: 200, pending: 0, limit: 5000,
    }],
  }));
  const afterPay = activeOf(recommend(fixturePlan(), [cardSpend, cardPay], {
    debts: [{
      id: 'travelvisa', label: 'Travel Visa', structure: 'Revolving',
      rate: 19.99, balance: 0, pending: 0, limit: 5000,
    }],
  }));
  ok(near(cardOnly.budgetHold, GROCERY_PLAN)
      && near(cardOnly.afterHouseholdBudget, none.afterHouseholdBudget),
    'Travel Visa grocery $200 under plan does not change BAD (hold stays plan)');
  ok(near(afterPay.afterHouseholdBudget, cardOnly.afterHouseholdBudget)
      && near(afterPay.budgetHold, cardOnly.budgetHold),
    'later Bills → Travel Visa payment does not deduct the $200 again');
}

console.log('\n=== G. Bills → Weekly does not change household leftover ===');
{
  const tfrTo = {
    id: 'tfr-to', date: PAYDAY, amount: 120, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'chequing-b', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'AB123 TFR-TO', originalMerchant: 'AB123 TFR-TO',
    tfrReference: 'AB123', tfrDirection: 'TO',
  };
  const tfrFr = {
    id: 'tfr-fr', date: PAYDAY, amount: -120, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'chequing-a', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'AB123 TFR-FR', originalMerchant: 'AB123 TFR-FR',
    tfrReference: 'AB123', tfrDirection: 'FR',
  };
  const none = activeOf(recommend(fixturePlan(), []));
  const moved = activeOf(recommend(fixturePlan(), [tfrTo, tfrFr]));
  ok(near(moved.afterHouseholdBudget, none.afterHouseholdBudget)
      && near(moved.budgetHold, none.budgetHold),
    'Bills → Weekly is an internal movement, not consumption');
}

console.log('\n=== H. Bills → Savings does not destroy household money ===');
{
  const tfrTo = {
    id: 'sav-to', date: PAYDAY, amount: 450, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'savings', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'CD456 TFR-TO SAVE01', originalMerchant: 'CD456 TFR-TO SAVE01',
    tfrReference: 'CD456', tfrDirection: 'TO',
  };
  const tfrFr = {
    id: 'sav-fr', date: PAYDAY, amount: -450, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'chequing-a', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'CD456 TFR-FR BILLS', originalMerchant: 'CD456 TFR-FR BILLS',
    tfrReference: 'CD456', tfrDirection: 'FR',
  };
  const none = activeOf(recommend(fixturePlan(), []));
  const moved = activeOf(recommend(fixturePlan(), [tfrTo, tfrFr]));
  const expl = moved.operatingCashExplanation;
  ok(near(moved.afterHouseholdBudget, none.afterHouseholdBudget),
    'Bills → Savings does not reduce Balance After Deductions');
  ok(expl && expl.leftoverIdentity === 'balance-after-deductions'
      && expl.sameContract === false
      && /Savings/.test(expl.leftoverNote),
    'reconciliation names BAD and keeps leftover ≠ cash; Savings stays household money');
  ok(expl && expl.sameContract === false && !('gap' in expl) && !('plug' in expl),
    'Savings location stays an explanation fact; no leftover plug is introduced');
}

console.log('\n=== I. Positive and negative payday-boundary positions do not change BAD ===');
{
  const pos = activeOf(recommend(fixturePlan({ openingAmount: 250 }), []));
  const neg = activeOf(recommend(fixturePlan({ openingAmount: -180 }), []));
  const income = DALE + AMANDA + CHILD;
  const expected = independentBad(income, BILL, GROCERY_PLAN);
  ok(near(pos.opening, 250) && near(neg.opening, -180),
    'payday-boundary opening still publishes, including a negative Weekly/operating position');
  ok(near(pos.afterHouseholdBudget, expected)
      && near(neg.afterHouseholdBudget, expected)
      && near(pos.afterHouseholdBudget, neg.afterHouseholdBudget),
    'positive and negative openings do not change BAD; same income-led remainder');
  ok(neg.budgetHold === pos.budgetHold,
    'negative Weekly is not Household Budget spending');
}

console.log('\n=== J. Actual income variance updates the living prediction ===');
{
  const paydayOpening = {
    asOf: PAYDAY,
    representedEvents: [{ id: 'payroll', date: PAYDAY }],
    paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
  };
  const modeled = activeOf(recommend(fixturePlan({ opening: paydayOpening }), [], {
    asOf: PAYDAY,
    actualsExtra: { observationAsOf: PAYDAY, coverageThrough: PAYDAY },
  }));
  const actualDale = 2140;
  const varied = activeOf(recommend(fixturePlan({
    opening: paydayOpening,
    representedEvents: [{ id: 'payroll', date: PAYDAY }],
  }), [], {
    asOf: PAYDAY,
    actualsExtra: {
      observationAsOf: PAYDAY,
      coverageThrough: PAYDAY,
      representedActuals: [{ id: 'payroll', date: PAYDAY, actual: actualDale }],
    },
  }));
  ok(near(varied.afterHouseholdBudget, independentBad(
      varied.incomeTotal, varied.periodBillLoad, varied.budgetHold))
      && near(modeled.afterHouseholdBudget, independentBad(
        modeled.incomeTotal, modeled.periodBillLoad, modeled.budgetHold)),
    'BAD follows displayed income − bills − hold; represented actual does not invent a fourth leftover engine');
  ok(near(varied.available, varied.incomeTotal)
      && near(modeled.available, modeled.incomeTotal),
    'Payday balance stays the displayed income term for both modeled and actual Dale');
}

console.log('\n=== K. Budget/Plan reprints the Forecast leftover ===');
{
  const plan = fixturePlan();
  const advice = recommend(plan, [groceryTx(100), otherTx(40)]);
  const row = activeOf(advice);
  const html = composer.calendarWaterfallHtml(row, null, advice.paydayAllocation, plan);
  ok(/data-operating-prompt="Balance After Deductions"/.test(html)
      && html.includes(composer.money2(row.afterHouseholdBudget)),
    'Budget Q07 reprints Forecast Balance After Deductions');
  ok(near(advice.defaultView.predictedEndingBalance, row.afterHouseholdBudget)
      && advice.defaultView.predictedEndingBalanceIdentity === 'balance-after-deductions',
    'recommend.defaultView leftover identity is balance-after-deductions');
  // BAD is its own income-led answer (independent arithmetic: income − bills
  // − plan hold − $40 Other). On this fixture the current-cash allocation
  // chain is a different number, so a copy of it cannot pass.
  const runningLeftover = advice.paydayAllocation.runningLeftover.afterHouseholdBudget;
  ok(near(row.afterHouseholdBudget, roundCent(independentBad(DALE + AMANDA + CHILD, BILL, GROCERY_PLAN) - 40))
      && Number.isFinite(runningLeftover) && !near(row.afterHouseholdBudget, runningLeftover),
    'BAD does not copy paydayAllocation.runningLeftover as a third engine',
    `${row.afterHouseholdBudget} vs runningLeftover ${runningLeftover}`);
}

console.log('\n=== L. Long-horizon baselineTrajectory remains intact ===');
{
  const plan = fixturePlan();
  const asOf = AS_OF;
  const opts = {
    targetBuffer: 0,
    debts: [],
    currentPeriodActuals: actuals([]),
  };
  let baseline = null;
  let baselineThrew = false;
  try {
    baseline = F.baselineTrajectory(plan, [], asOf, opts);
  } catch (err) {
    baselineThrew = true;
  }
  ok(!baselineThrew,
    'baselineTrajectory does not throw after the current-pay-period leftover restore');
  ok(!baseline || !baseline.predictedEndingBalance,
    'long-horizon trajectory does not own Predicted Ending Balance');
  const advice = F.recommend(plan, asOf, opts);
  ok(advice && advice.defaultView && advice.defaultView.predictedEndingBalance != null
      && advice.paydayAllocation && advice.paydayAllocation.runningLeftover,
    'current-pay-period leftover and paydayAllocation coexist; trajectory is separate');
}

console.log('\n=== M. Missing payday-boundary opening still publishes BAD ===');
{
  const plan = fixturePlan({
    opening: { asOf: AS_OF, priorAsOf: PAYDAY, representedEvents: [] },
  });
  const row = activeOf(recommend(plan, []));
  ok(row && row.openingKnown !== true && row.opening == null,
    'no snapshot and a live-advanced mid-period opening fail closed');
  ok(row.available != null && near(row.available, row.incomeTotal),
    'Payday balance still publishes the income identity');
  const expected = independentBad(row.incomeTotal, row.periodBillLoad, row.budgetHold);
  ok(row.afterHouseholdBudget != null && near(row.afterHouseholdBudget, expected)
      && near(row.predictedEndingBalance, expected)
      && near(row.afterBills, roundCent(row.incomeTotal - row.periodBillLoad)),
    'BAD publishes without payday-boundary opening as income − bills − hold');
}

console.log('\n=== O. Mid-period cutover cash does not double-count pre-cutover spend ===');
{
  // Named household facts, independent of Forecast leftover terms.
  // Payday-morning cash is known to the test and is not given to Forecast
  // as a snapshot. The dated opening is mid-period cash after $100 of
  // the $900 grocery target has already left the accounts.
  const PAYDAY_MORNING_CASH = 1000;
  const GROCERY_TARGET = 900;
  const PRE_CUTOVER_GROCERY = 100;
  const CUTOVER_CASH = PAYDAY_MORNING_CASH - PRE_CUTOVER_GROCERY;
  const independentPaydayRemainder = PAYDAY_MORNING_CASH - GROCERY_TARGET;
  const doubleCountTrap = CUTOVER_CASH - GROCERY_TARGET;
  ok(near(CUTOVER_CASH, 900) && near(independentPaydayRemainder, 100)
      && near(doubleCountTrap, 0) && !near(independentPaydayRemainder, doubleCountTrap),
    'independent facts: payday remainder $100; cutover minus full hold is $0');
  const plan = {
    defaults: { targetBuffer: 0 },
    windowDays: 14,
    startingCash: {
      amount: CUTOVER_CASH,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: CUTOVER_CASH },
      ],
    },
    opening: { asOf: AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 0, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedWeekly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
  const row = activeOf(recommend(plan, []));
  ok(row && row.start === PAYDAY && row.openingKnown === true
      && row.openingSource === 'cutover-opening' && near(row.opening, CUTOVER_CASH)
      && row.paydayBoundaryOpening !== true,
    'Q01 still publishes the mid-period cutover; it is not a payday-boundary opening');
  ok(near(row.budgetHold, GROCERY_TARGET),
    'Household Budget hold remains the full-period grocery target');
  const expectedBad = independentBad(row.incomeTotal || 0, row.periodBillLoad || 0, row.budgetHold);
  ok(near(expectedBad, -900) && near(row.afterHouseholdBudget, expectedBad)
      && near(row.predictedEndingBalance, expectedBad),
    'BAD publishes as income − bills − hold; income 0 bills 0 hold 900 → −$900');
  ok(!near(row.predictedEndingBalance, doubleCountTrap),
    'BAD is not the $0 cutover-minus-hold trap');
  ok(!near(row.predictedEndingBalance, independentPaydayRemainder),
    'BAD does not invent a payday-morning remainder from unrecorded payday cash');
  ok(near(row.opening, CUTOVER_CASH)
      && !near(row.predictedEndingBalance, roundCent(row.opening - row.budgetHold)),
    'household BAD does not use cutover cash; cash leftover from cutover may stay internal');
}

console.log('\n=== N. No unexplained balancing adjustment ===');
{
  const src = read('public/forecast.js');
  ok(!/leftover\s*=\s*operatingCash|plugAdjustment|forceEqual|balancingPlug\s*=/.test(src),
    'Forecast does not introduce a leftover balancing plug');
  const row = activeOf(recommend(fixturePlan(), [groceryTx(100)]));
  const expl = row.operatingCashExplanation;
  const reconstructed = independentBad(
    row.incomeTotal, row.periodBillLoad, row.budgetHold);
  ok(near(row.afterHouseholdBudget, reconstructed),
    'BAD equals the named-facts reconstruction with no residual plug');
  ok(expl && expl.sameContract === false
      && expl.leftoverSameAsBillsCash === false
      && expl.leftoverIdentity === 'balance-after-deductions',
    'explanation keeps BAD, Current Balance, and BILLS cash as different contracts');
}

console.log('\n=== Sep 11–24 acceptance: BAD is income-led and stays fluid ===');
{
  const plan = fixturePlan();
  const day1 = activeOf(recommend(plan, []));
  const later = activeOf(recommend(plan, [groceryTx(100), otherTx(80)]));
  const expectedDay1 = independentBad(
    DALE + AMANDA + CHILD, BILL, GROCERY_PLAN);
  ok(day1.start === PAYDAY && day1.end === '2026-09-24',
    'fixture is the Sep 11–24 Seaspan window');
  ok(near(day1.afterHouseholdBudget, expectedDay1)
      && !near(day1.afterHouseholdBudget, roundCent(expectedDay1 + OPENING)),
    'Sep 11–24 BAD does not include the payday-boundary opening');
  ok(near(day1.afterHouseholdBudget - later.afterHouseholdBudget, 80),
    'later Other Spending updates the living prediction dollar-for-dollar');
}

console.log('\n=== Live reconstruction: leftover follows named income facts, never hardcoded Q07 ===');
{
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const asOf = (live.plan && live.plan.opening && live.plan.opening.asOf)
    || (live.meta && live.meta.asOf);
  const advice = F.recommend(live.plan, asOf, { debts: live.debts || [] });
  const row = activeOf(advice);
  if (!row) {
    ok(false, 'live This Pay Period exists');
  } else if (row.incomeTotal != null && row.periodBillLoad != null
      && row.budgetHold != null) {
    const reconstructed = independentBad(
      row.incomeTotal, row.periodBillLoad, row.budgetHold);
    ok(near(row.afterHouseholdBudget, reconstructed)
        && near(row.predictedEndingBalance, reconstructed),
      'live BAD equals incomeTotal − periodBillLoad − hold even without proven payday-boundary opening');
  } else {
    ok(row.available != null || row.operatingPlanUnavailable === true,
      'income identity or unavailable operating plan remains explicit');
  }
}

console.log('\n=== Production signed-actual regression: −$7,158.13 cannot recur ===');
{
  // Independently invented signed-credit regression. No household receipt values.
  // Actual receipts replace planned contributions; unproven salary retains its plan.
  const PROD_OPENING = 281.36;
  const DALE_LM_SIGNED = -1937.28;
  const DALE_INFLOW = 1937.28;
  const AMANDA_PLANNED = 1033.44;
  const CHILD_AMT = 147.62;
  const PROD_BILLS = 1147.35;
  const PROD_HOLD = 817.26;
  const BROKEN_INCOME = roundCent(DALE_LM_SIGNED + CHILD_AMT);
  const BROKEN_AFTER_BILLS = roundCent(PROD_OPENING + BROKEN_INCOME - PROD_BILLS);
  const BROKEN_PEB = roundCent(BROKEN_AFTER_BILLS - PROD_HOLD);
  ok(near(BROKEN_INCOME, -1789.66) && near(BROKEN_AFTER_BILLS, -2655.65)
      && near(BROKEN_PEB, -3472.91),
    'independent reconstruction of the published broken equation must not recur');

  const plan = fixturePlan({
    openingAmount: PROD_OPENING,
    startingCash: {
      amount: 163.24,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 351.28 },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: -188.04 },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 562.82 },
      ],
    },
    opening: {
      asOf: '2026-09-21',
      priorAsOf: '2026-08-19',
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'childBenefit', date: '2026-09-20' },
      ],
      notReliedUponEvents: [
        { id: 'amandaSalary15', date: '2026-09-15', reason: 'unconfirmed-transfer' },
      ],
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: PROD_OPENING },
    },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: 1900, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda income', frequency: 'once',
        date: '2026-09-15', amount: AMANDA_PLANNED, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Canada Child Benefit', frequency: 'once',
        date: '2026-09-20', amount: CHILD_AMT, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'period-bills', label: 'Assigned period bills', frequency: 'once',
        date: '2026-09-12', amount: PROD_BILLS, confidence: 'confirmed',
      },
    ],
    categories: [],
  });
  const row = activeOf(recommend(plan, [otherTx(PROD_HOLD)], {
    asOf: '2026-09-21',
    representedEvents: [
      { id: 'payroll', date: PAYDAY },
      { id: 'childBenefit', date: '2026-09-20' },
    ],
    notReliedUponEvents: [
      { id: 'amandaSalary15', date: '2026-09-15', reason: 'unconfirmed-transfer' },
    ],
    actualsExtra: {
      observationAsOf: '2026-09-21',
      coverageStart: PAYDAY,
      coverageThrough: '2026-09-21',
      representedActuals: [
        { id: 'payroll', date: PAYDAY, actual: DALE_LM_SIGNED, postedOn: PAYDAY },
        { id: 'childBenefit', date: '2026-09-20', actual: CHILD_AMT, postedOn: '2026-09-20' },
      ],
    },
  }));
  const plannedIncome = roundCent(1900 + AMANDA_PLANNED + CHILD_AMT);
  const displayedIncome = roundCent(DALE_INFLOW + AMANDA_PLANNED + CHILD_AMT);
  const correctAfterBills = roundCent(displayedIncome - PROD_BILLS);
  const correctBad = independentBad(displayedIncome, PROD_BILLS, PROD_HOLD);
  ok(row && near(row.opening, PROD_OPENING) && row.openingSource === 'snapshot'
      && row.paydayBoundaryOpening === true,
    'payday-boundary opening stays the Sep 11 snapshot, not live cash');
  ok(!near(row.opening, 163.24) && !near(row.opening, 351.28),
    'today\'s Current Balance / Bills-only cash is not the payday-boundary opening');
  ok(near(row.incomeTotal, displayedIncome) && near(row.available, displayedIncome)
      && !near(row.incomeTotal, plannedIncome)
      && near(row.income.find(x => x.id === 'payroll').amount, 1900),
    'income uses positive confirmed payroll receipt plus unproven salary/child plans; original payroll plan stays intact',
    `${row && row.incomeTotal} vs ${displayedIncome}`);
  ok(row.incomeAdded != null && row.incomeAdded > 0
      && !near(row.incomeAdded, BROKEN_INCOME),
    'Lunch Money signed Dale actual is not converted into negative period income',
    `${row && row.incomeAdded} vs ${BROKEN_INCOME}`);
  ok(near(row.afterBills, correctAfterBills) && !near(row.afterBills, BROKEN_AFTER_BILLS),
    'Balance after bills is not the production −$7,158.13');
  ok(near(row.afterHouseholdBudget, correctBad) && !near(row.afterHouseholdBudget, BROKEN_PEB),
    'BAD is not the production −$9,445.30');
  ok(!near(row.afterHouseholdBudget, 351.28) && !near(row.predictedEndingBalance, 351.28),
    'leftover is not the hub Current Balance 351.28');
  ok(row.predictedEndingBalanceTerms
      && row.predictedEndingBalanceTerms.identity === 'balance-after-deductions'
      && row.predictedEndingBalanceTerms.closes === true
      && near(row.predictedEndingBalanceTerms.periodIncome, displayedIncome)
      && near(row.predictedEndingBalanceTerms.assignedBills, PROD_BILLS)
      && near(row.predictedEndingBalanceTerms.householdBudgetHold, PROD_HOLD)
      && near(row.predictedEndingBalanceTerms.balanceAfterDeductions, correctBad)
      && row.predictedEndingBalanceTerms.paydayBoundaryPosition == null,
    'Forecast publishes the closed BAD identity; paydayBoundaryPosition is not a term');
}

console.log('\n=== P. Live-advanced unproven period income still increments leftover ===');
{
  // Structural reconstruction of the Sep 11–24 production failure:
  // overlay advanced past payday, salaries still on Payday balance, but
  // incomeAdded was wiped to $0 and a transfer-net was treated as opening.
  // Synthetic amounts (L-006). Independent arithmetic, not live cents.
  const BILLS_MORNING = 800;
  const WEEKLY_MORNING = -200;
  const POOLED = roundCent(BILLS_MORNING + WEEKLY_MORNING);
  const TRANSFER_NET = -3600;
  const LIVE_BILLS = 500;
  const LIVE_WEEKLY = -310;
  const LIVE_POOLED = roundCent(LIVE_BILLS + LIVE_WEEKLY);
  const CHEQUING_A_POSTED = 2310;
  const DALE_AMT = 2000;
  const AMANDA_AMT = 1500;
  const CHILD_AMT = 200;
  const PERIOD_INCOME = roundCent(DALE_AMT + AMANDA_AMT + CHILD_AMT);
  const PERIOD_BILLS = 400;
  const GROCERY_HOLD = 900;
  const plan = fixturePlan({
    openingAmount: POOLED,
    startingCash: {
      amount: LIVE_POOLED,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: LIVE_BILLS },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: LIVE_WEEKLY },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 100 },
      ],
    },
    opening: {
      asOf: '2026-09-21',
      priorAsOf: '2026-08-19',
      representedEvents: [],
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: POOLED },
      paydayAccountObservations: {
        periodStart: PAYDAY,
        asOf: PAYDAY,
        accounts: [{
          id: 'chequing-a',
          value: CHEQUING_A_POSTED,
          evidenceDate: PAYDAY,
          temporalClaim: 'posted-balance-observed-on-household-date',
          source: 'synthetic',
        }],
      },
    },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE_AMT, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA_AMT, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Canada Child Benefit', frequency: 'once',
        date: '2026-09-20', amount: CHILD_AMT, confidence: 'confirmed',
      },
    ],
  });
  // The observation window moves with the as-of date: a packet dated before the as-of is stale
  // coverage, whose dependent remainder is rightly Unknown.
  const row = activeOf(recommend(plan, [], { asOf: '2026-09-21',
    actualsExtra: { observationAsOf: '2026-09-21', coverageThrough: '2026-09-21' } }));
  const expectedAfterBills = roundCent(PERIOD_INCOME - PERIOD_BILLS);
  const expectedBad = independentBad(PERIOD_INCOME, PERIOD_BILLS, GROCERY_HOLD);
  const incomeWipedTrap = independentBad(0, PERIOD_BILLS, GROCERY_HOLD);
  const pooledOpeningTrap = roundCent(POOLED + PERIOD_INCOME - PERIOD_BILLS - GROCERY_HOLD);
  ok(row && near(row.opening, POOLED) && row.openingSource === 'snapshot'
      && row.paydayBoundaryOpening === true,
    'payday-boundary opening is pooled Bills + Weekly, including negative Weekly carry');
  ok(near(row.incomeTotal, PERIOD_INCOME) && near(row.available, PERIOD_INCOME),
    'Payday balance still shows Dale + Amanda + Child Benefit');
  ok(near(row.incomeAdded, PERIOD_INCOME),
    'live-advanced unproven period income still increments incomeAdded',
    `${row && row.incomeAdded} vs ${PERIOD_INCOME}`);
  ok(near(row.afterBills, expectedAfterBills)
      && near(row.predictedEndingBalance, expectedBad),
    'BAD = period income − bills − hold, not pooled opening + income',
    `${row && row.predictedEndingBalance} vs ${expectedBad}`);
  ok(!near(row.predictedEndingBalance, pooledOpeningTrap),
    'pooled opening is cash opening, not a BAD term');
  ok(!near(row.afterBills, roundCent(POOLED - PERIOD_BILLS))
      && !near(row.predictedEndingBalance, incomeWipedTrap),
    'elapsed-unproven settlement does not wipe period income from leftover');
  ok(!near(row.opening, TRANSFER_NET)
      && !near(row.predictedEndingBalance, TRANSFER_NET),
    'a Bills transfer-history net is not the payday-boundary opening and is not leftover');
  ok(!near(row.opening, LIVE_POOLED)
      && !near(row.predictedEndingBalance, LIVE_POOLED),
    'today\'s live Current Balance is not leftover');
  ok(!near(row.opening, CHEQUING_A_POSTED)
      && !near(row.predictedEndingBalance, CHEQUING_A_POSTED),
    'chequing-a posted-on-payday observation is not leftover');
  const dale = (row.income || []).find(r => r && r.id === 'payroll');
  const amanda = (row.income || []).find(r => r && r.id === 'amandaPayday');
  const child = (row.income || []).find(r => r && r.id === 'childBenefit');
  ok(dale && dale.settlement === 'relied-upon' && dale.alreadyInCash !== true,
    'Dale remains relied-upon after payday; not treated as already inside live cash');
  ok(amanda && (amanda.notReliedUpon === true || amanda.settlement === 'not-relied-upon')
      && near(amanda.amount, AMANDA_AMT),
    'Amanda settlement can stay unproven without erasing her from incomeAdded');
  ok(child && near(child.amount, CHILD_AMT)
      && (child.notReliedUpon === true || child.settlement === 'not-relied-upon'
        || child.status === 'unresolved' || child.status === 'arriving'),
    'Child Benefit belongs to the period once; it is not dropped from leftover');
}

console.log('\n=== Q. Negative Weekly carry is opening, not a manufactured expense ===');
{
  const bills = 500;
  const weekly = -175;
  const pooled = roundCent(bills + weekly);
  const plan = fixturePlan({
    openingAmount: pooled,
    startingCash: {
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 900 },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 334.56 },
      ],
    },
  });
  const row = activeOf(recommend(plan, []));
  const incomeAdded = DALE + AMANDA + CHILD;
  const expected = independentBad(incomeAdded, BILL, GROCERY_PLAN);
  ok(near(row.opening, pooled) && weekly < 0,
    'opening is Bills + negative Weekly, not Bills alone');
  ok(near(row.predictedEndingBalance, expected)
      && near(row.afterHouseholdBudget, expected),
    'negative Weekly does not change BAD; leftover equals income − bills − hold regardless of weekly sign');
  ok(near(row.budgetHold, GROCERY_PLAN),
    'negative Weekly carry does not inflate the Household Budget hold');
}

console.log('\n=== R. Inspectable BAD terms arithmetically close ===');
{
  const row = activeOf(recommend(fixturePlan(), [groceryTx(100), otherTx(40)]));
  ok(row.incomeTotal != null && row.periodBillLoad != null
      && row.budgetHold != null && row.predictedEndingBalance != null
      && row.balanceAfterDeductions != null,
    'Forecast exposes incomeTotal, periodBillLoad, hold, and leftover');
  ok(near(row.afterBills, roundCent(row.incomeTotal - row.periodBillLoad)),
    'afterBills independently equals incomeTotal − periodBillLoad');
  ok(near(row.predictedEndingBalance,
      independentBad(row.incomeTotal, row.periodBillLoad, row.budgetHold)),
    'BAD independently equals those three named facts with no residual plug');
  const terms = row.predictedEndingBalanceTerms;
  ok(terms && terms.closes === true && terms.identity === 'balance-after-deductions'
      && near(terms.periodIncome, row.incomeTotal)
      && near(terms.assignedBills, row.periodBillLoad)
      && near(terms.householdBudgetHold, row.budgetHold)
      && near(terms.balanceAfterDeductions, row.predictedEndingBalance)
      && terms.paydayBoundaryPosition == null,
    'predictedEndingBalanceTerms reprints displayed income, bills, hold, and closes');
}

console.log('\n=== S. Transfer-net gap packet is not a payday-morning stock ===');
{
  const dated = '2026-08-19';
  const billsOpen = 629.27;
  const weeklyOpen = 309.77;
  const pooledOpen = roundCent(billsOpen + weeklyOpen);
  const grocery = 80;
  const transferOut = -350;
  const transferIn = 350;
  const plan = {
    defaults: { targetBuffer: 0 },
    windowDays: 14,
    startingCash: {
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: billsOpen },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: weeklyOpen },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 0.58 },
      ],
    },
    opening: { asOf: dated, representedEvents: [] },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  };
  const complete = {
    complete: true,
    coverageStart: '2026-08-20',
    coverageThrough: '2026-09-10',
    movements: [
      { date: '2026-08-25', amount: -grocery, accountRole: 'household-cash', atlasAccountId: 'chequing-a' },
      { date: '2026-09-08', amount: transferOut, accountRole: 'household-cash', atlasAccountId: 'chequing-a' },
      { date: '2026-09-08', amount: transferIn, accountRole: 'household-cash', atlasAccountId: 'chequing-b' },
    ],
  };
  const snap = F.establishPaydaySnapshot(plan, PAYDAY, { paydayGapCash: complete });
  const expectedMorning = roundCent(pooledOpen - grocery);
  const transferNetAsOpening = roundCent(transferOut);
  ok(snap && near(snap.opening, expectedMorning),
    'complete walk is pooled A+B plus gap spendable flows; Bills→Weekly nets to zero');
  ok(snap && !near(snap.opening, transferNetAsOpening)
      && !near(snap.opening, roundCent(billsOpen + transferOut - grocery)),
    'Bills transfer-out without Weekly is not the reconstructed opening');

  const mixed = {
    complete: true,
    coverageStart: '2026-08-20',
    coverageThrough: '2026-09-10',
    movements: [
      { date: '2026-08-25', amount: -grocery, accountRole: 'household-cash', atlasAccountId: 'chequing-a' },
      { date: '2026-09-01', amount: -500, accountRole: 'household-cash' },
    ],
  };
  const withheld = F.establishPaydaySnapshot(plan, PAYDAY, { paydayGapCash: mixed });
  ok(withheld == null,
    'identified chequing movements mixed with unidentified household-cash fail closed');
}

console.log('\n=== T. Incompatible snapshot dates still publish income-led BAD ===');
{
  const plan = fixturePlan({
    opening: {
      asOf: AS_OF,
      priorAsOf: PAYDAY,
      representedEvents: [],
      paydaySnapshot: {
        periodStart: '2026-08-28',
        asOf: '2026-08-28',
        opening: OPENING,
      },
    },
  });
  const row = activeOf(recommend(plan, []));
  ok(row && row.start === PAYDAY,
    'active window is still Sep 11–24');
  ok(row.openingKnown !== true || row.paydayBoundaryOpening !== true,
    'a snapshot for a different payday is not combined into this period\'s leftover');
  const expected = independentBad(row.incomeTotal, row.periodBillLoad, row.budgetHold);
  ok(row.predictedEndingBalance != null && near(row.predictedEndingBalance, expected)
      && near(row.afterBills, roundCent(row.incomeTotal - row.periodBillLoad)),
    'incompatible evidence dates still publish income-led BAD; snapshot is not mixed into leftover');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures ? 1 : 0;
