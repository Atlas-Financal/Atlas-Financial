'use strict';
/* Hub-account current-pay-period contract — owner 2026-09-21.
 *
 * Current Balance is posted canonical chequing-a / BILLS ACCOUNT only.
 * Weekly, Savings, and pooled A+B never enter that headline.
 *
 * Household remaining is Balance After Deductions:
 *   displayed period income − assigned bills − Household Budget hold
 *
 * Independent arithmetic (L-002 / L-006). Synthetic fixtures only.
 * Do not treat the worked example cents as product policy.
 *
 * `node test/test-hub-account-balance-after-deductions.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const Assistant = require('../scripts/assistant-packet.js');
const TalkPresentation = require('../scripts/talk-presentation.js');
const TalkSession = require('../scripts/talk-session.js');
const TalkWhy = require('../scripts/talk-why.js');
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
    `${source}\n({ calendarWaterfallsHtml, calendarWaterfallHtml, liveCurrentBalanceHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-09-11';
const AS_OF = '2026-09-18';
const HUB = 593.29;
const WEEKLY = -403.05;
const SAVINGS = 772.58;
const POOLED_AB = roundCent(HUB + WEEKLY);
const POOLED_ABS = roundCent(HUB + WEEKLY + SAVINGS);
const INCOME = 6652.30;
const BILLS = 3413.07;
const HOLD_PLAN = 2287.17;
const INDEPENDENT_BAD = roundCent(INCOME - BILLS - HOLD_PLAN);

const DALE = 4274.98;
const AMANDA = 2168.85;
const CHILD = 208.47;

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
  const hub = extra.hub != null ? extra.hub : HUB;
  const weekly = extra.weekly != null ? extra.weekly : WEEKLY;
  const savings = extra.savings != null ? extra.savings : SAVINGS;
  const breakdown = extra.breakdown !== undefined ? extra.breakdown : [
    { id: 'chequing-a', label: 'BILLS ACCOUNT', value: hub },
    { id: 'chequing-b', label: 'WEEKLY SPENDING', value: weekly },
    { id: 'savings', label: 'EMERGENCY SAVING', value: savings },
  ];
  return {
    defaults: { targetBuffer: 0 },
    windowDays: 14,
    startingCash: extra.startingCash || {
      amount: extra.amount != null ? extra.amount : roundCent(hub + weekly + savings),
      breakdown,
    },
    opening: extra.opening || {
      asOf: AS_OF,
      priorAsOf: PAYDAY,
      representedEvents: extra.representedEvents || [],
      paydaySnapshot: {
        periodStart: PAYDAY,
        asOf: PAYDAY,
        opening: extra.openingAmount != null ? extra.openingAmount : 310.47,
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
        id: 'synthetic-bills', label: 'Assigned period bills',
        frequency: 'once', date: '2026-09-12', amount: BILLS, confidence: 'confirmed',
      },
    ],
    obligations: extra.obligations || [],
    commitments: extra.commitments || [],
    budget: {
      categories: extra.categories || [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: HOLD_PLAN, ownerLine: 'Groceries',
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

function independentHub(plan) {
  const rows = ((plan.startingCash && plan.startingCash.breakdown) || []);
  const matches = rows.filter(row => row && row.id === 'chequing-a');
  if (matches.length !== 1) return null;
  const value = Number(matches[0].value);
  return Number.isFinite(value) ? roundCent(value) : null;
}

function independentBad(income, bills, hold) {
  return roundCent(income - bills - hold);
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const forecastSrc = read('public/forecast.js');
const accountFacts = read('docs/ACCOUNT_FACTS.md');

console.log('=== A/B/C. Current Balance is the planning hub only ===');
{
  ok(/BILLS ACCOUNT/.test(accountFacts) && /Chequing A/.test(accountFacts),
    'ACCOUNT_FACTS maps BILLS ACCOUNT to Chequing A');
  ok(/const BILLS_ACCOUNT_ID = 'chequing-a'/.test(forecastSrc)
      && /function postedBillsAccountCash\(plan\)/.test(forecastSrc),
    'Forecast hub identity is canonical chequing-a, not a scattered account number');
  const privacy = require('../scripts/privacy-guard.js');
  ok(typeof privacy.CONTENT_PATTERNS === 'string' && privacy.CONTENT_PATTERNS.length > 0,
    'privacy-guard still publishes the sole identifier policy');
  ok(!(new RegExp(privacy.CONTENT_PATTERNS)).test(forecastSrc)
      && !(new RegExp(privacy.CONTENT_PATTERNS)).test(planSrc),
    'Forecast and Plan do not scatter blocked hub identifiers');

  const plan = fixturePlan();
  const expectedHub = independentHub(plan);
  ok(near(expectedHub, HUB),
    'independent hub reconstruction is the BILLS ACCOUNT row', String(expectedHub));
  ok(near(POOLED_AB, 190.24) && near(POOLED_ABS, 962.82),
    'independent pooled A+B and A+B+Savings are different from the hub');
  const advice = recommend(plan, []);
  const row = activeOf(advice);
  ok(near(advice.paydayAllocation.liveCurrentBalance, expectedHub)
      && near(advice.defaultView.liveCurrentBalance, expectedHub)
      && row && near(row.liveCurrentBalance, expectedHub),
    'published Current Balance independently equals hub cash only',
    `${advice.paydayAllocation.liveCurrentBalance} vs ${expectedHub}`);
  ok(!near(advice.paydayAllocation.liveCurrentBalance, POOLED_AB)
      && !near(advice.paydayAllocation.liveCurrentBalance, POOLED_ABS),
    'Current Balance is not pooled A+B and not A+B+Savings');
  const html = composer.liveCurrentBalanceHtml(
    advice.defaultView, null, advice.paydayAllocation
  );
  ok(html.includes(composer.money2(expectedHub))
      && !html.includes(composer.money2(POOLED_AB))
      && !html.includes(composer.money2(POOLED_ABS)),
    'Budget Current Balance prints the hub figure');
}

console.log('\n=== B. Weekly balance does not alter headline Current Balance ===');
{
  const base = fixturePlan({ weekly: WEEKLY });
  const bumped = fixturePlan({ weekly: WEEKLY - 200 });
  const before = recommend(base, []);
  const after = recommend(bumped, []);
  ok(near(before.paydayAllocation.liveCurrentBalance, HUB)
      && near(after.paydayAllocation.liveCurrentBalance, HUB)
      && near(after.paydayAllocation.liveCurrentBalance,
        before.paydayAllocation.liveCurrentBalance),
    'Weekly register movement does not change Current Balance');
}

console.log('\n=== C. Savings balance does not alter headline Current Balance ===');
{
  const base = fixturePlan({ savings: SAVINGS });
  const bumped = fixturePlan({ savings: SAVINGS + 400 });
  const before = recommend(base, []);
  const after = recommend(bumped, []);
  ok(near(before.paydayAllocation.liveCurrentBalance, HUB)
      && near(after.paydayAllocation.liveCurrentBalance, HUB),
    'Savings movement does not change Current Balance');
}

console.log('\n=== D. Missing hub evidence fails closed ===');
{
  const noHub = fixturePlan({
    breakdown: [
      { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY },
      { id: 'savings', label: 'EMERGENCY SAVING', value: SAVINGS },
    ],
    amount: POOLED_AB,
  });
  const advice = recommend(noHub, []);
  ok(advice.paydayAllocation.liveCurrentBalance == null
      && advice.defaultView.liveCurrentBalance == null,
    'Current Balance is unavailable when chequing-a is missing');
  ok(F.postedHouseholdChequingCash(noHub) !== advice.paydayAllocation.liveCurrentBalance
      || advice.paydayAllocation.liveCurrentBalance == null,
    'missing hub does not fall through to pooled chequing or startingCash.amount');
  const untrusted = fixturePlan({
    breakdown: [
      { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 'not-a-number' },
      { id: 'chequing-b', label: 'WEEKLY SPENDING', value: WEEKLY },
    ],
  });
  const untrustedAdvice = recommend(untrusted, []);
  ok(untrustedAdvice.paydayAllocation.liveCurrentBalance == null,
    'untrusted hub value fails closed rather than becoming $0 or Weekly');
}

console.log('\n=== E. Waterfall arithmetic closes: Income − Bills − HB = BAD ===');
{
  const plan = fixturePlan();
  const advice = recommend(plan, []);
  const row = activeOf(advice);
  const expectedIncome = roundCent(DALE + AMANDA + CHILD);
  ok(near(expectedIncome, INCOME),
    'synthetic Dale + Amanda + Child independently equals the income term');
  ok(near(INDEPENDENT_BAD, 952.06),
    'independent identity 6652.30 − 3413.07 − 2287.17 = 952.06');
  ok(row && near(row.incomeTotal, expectedIncome) && near(row.available, expectedIncome),
    'Payday balance / incomeTotal is the displayed income term');
  ok(near(row.periodBillLoad, BILLS),
    'assigned period bill load is the bills term');
  ok(near(row.budgetHold, HOLD_PLAN),
    'Household Budget hold is the planned reserve when nothing has posted');
  const expected = independentBad(row.incomeTotal, row.periodBillLoad, row.budgetHold);
  ok(near(row.afterBills, roundCent(row.incomeTotal - row.periodBillLoad)),
    'Balance after bills = income − bills');
  ok(near(row.afterHouseholdBudget, expected)
      && near(row.balanceAfterDeductions, expected)
      && near(row.predictedEndingBalance, expected),
    'Balance After Deductions = income − bills − hold',
    `${row.afterHouseholdBudget} vs ${expected}`);
  ok(row.predictedEndingBalanceTerms
      && row.predictedEndingBalanceTerms.identity === 'balance-after-deductions'
      && row.predictedEndingBalanceTerms.closes === true,
    'inspectable terms close on the income-led identity');
  ok(!near(row.afterHouseholdBudget,
      roundCent((Number(row.opening) || 0) + (row.incomeAdded || 0)
        - row.periodBillLoad - row.budgetHold)),
    'Balance After Deductions is not the superseded pooled payday-boundary leftover');
}

console.log('\n=== F. Household label is Balance After Deductions ===');
{
  const plan = fixturePlan();
  const advice = recommend(plan, []);
  const html = composer.calendarWaterfallHtml(
    activeOf(advice), null, advice.paydayAllocation, plan
  );
  ok(/data-operating-prompt="Balance After Deductions"/.test(html),
    'Q07 prompt is exactly Balance After Deductions');
  ok(!/Predicted Ending Balance/.test(html),
    'household waterfall no longer labels this figure Predicted Ending Balance');
  ok(html.includes(composer.money2(activeOf(advice).afterHouseholdBudget)),
    'Q07 reprints the Forecast remainder');
}

console.log('\n=== G. Spending below plan keeps the full planned reserve ===');
{
  const none = activeOf(recommend(fixturePlan(), []));
  const under = activeOf(recommend(fixturePlan(), [groceryTx(100)]));
  ok(near(under.budgetHold, HOLD_PLAN)
      && near(under.afterHouseholdBudget, none.afterHouseholdBudget),
    'under-plan groceries keep the planned hold; BAD does not rise');
}

console.log('\n=== H. Category overspend lowers BAD by the overage ===');
{
  const atPlan = activeOf(recommend(fixturePlan(), [groceryTx(HOLD_PLAN)]));
  const over = activeOf(recommend(fixturePlan(), [groceryTx(HOLD_PLAN + 150)]));
  ok(near(atPlan.budgetHold, HOLD_PLAN) && near(over.budgetHold, HOLD_PLAN + 150),
    'at-plan hold stays planned; overspend hold is planned + overage');
  ok(near(atPlan.afterHouseholdBudget - over.afterHouseholdBudget, 150),
    'BAD falls exactly $150 for the grocery overage');
}

console.log('\n=== I. Other Spending lowers BAD dollar-for-dollar ===');
{
  const base = activeOf(recommend(fixturePlan(), [groceryTx(100)]));
  const withOther = activeOf(recommend(fixturePlan(), [groceryTx(100), otherTx(75)]));
  ok(near(withOther.budgetHold - base.budgetHold, 75)
      && near(base.afterHouseholdBudget - withOther.afterHouseholdBudget, 75),
    'Other Spending $75 reduces BAD by $75 and does not touch the grocery reserve');
}

console.log('\n=== J. Eligible Weekly transaction affects Household Budget once ===');
{
  const weeklyGroc = groceryTx(80, {
    id: 'tx-weekly-groc',
    atlasAccountId: 'chequing-b',
    accountRole: 'household-cash',
  });
  const none = activeOf(recommend(fixturePlan(), []));
  const weekly = activeOf(recommend(fixturePlan(), [weeklyGroc]));
  ok(near(weekly.budgetHold, HOLD_PLAN)
      && near(weekly.afterHouseholdBudget, none.afterHouseholdBudget),
    'Weekly grocery under plan still fills the planned reserve, once');
  const overWeekly = groceryTx(HOLD_PLAN + 40, {
    id: 'tx-weekly-over',
    atlasAccountId: 'chequing-b',
  });
  const over = activeOf(recommend(fixturePlan(), [overWeekly]));
  ok(near(over.budgetHold, HOLD_PLAN + 40)
      && near(none.afterHouseholdBudget - over.afterHouseholdBudget, 40),
    'Weekly grocery overage lowers BAD once');
}

console.log('\n=== K. Eligible Travel Visa transaction affects Household Budget once ===');
{
  const cardSpend = groceryTx(HOLD_PLAN + 25, {
    id: 'tx-visa-groc',
    accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    categoryLabel: 'Groceries',
  });
  const none = activeOf(recommend(fixturePlan(), []));
  const cardOnly = activeOf(recommend(fixturePlan(), [cardSpend], {
    debts: [{
      id: 'travelvisa', label: 'Travel Visa', structure: 'Revolving',
      rate: 19.99, balance: HOLD_PLAN + 25, pending: 0, limit: 5000,
    }],
  }));
  ok(near(cardOnly.budgetHold, HOLD_PLAN + 25)
      && near(none.afterHouseholdBudget - cardOnly.afterHouseholdBudget, 25),
    'Travel Visa grocery overage lowers BAD once');
}

console.log('\n=== L. Hub → Weekly transfer does not itself reduce HB / BAD ===');
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
    'hub → Weekly is an internal allocation, not Household Budget spending');
}

console.log('\n=== M. Hub → Savings transfer does not itself reduce HB / BAD ===');
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
  ok(near(moved.afterHouseholdBudget, none.afterHouseholdBudget)
      && near(moved.budgetHold, none.budgetHold),
    'hub → Savings is location, not consumption');
}

console.log('\n=== N. Credit-card payment does not duplicate underlying card spending ===');
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
  ok(near(cardOnly.budgetHold, HOLD_PLAN)
      && near(cardOnly.afterHouseholdBudget, none.afterHouseholdBudget),
    'Travel Visa grocery $200 under plan does not change BAD');
  ok(near(afterPay.afterHouseholdBudget, cardOnly.afterHouseholdBudget)
      && near(afterPay.budgetHold, cardOnly.budgetHold),
    'later hub → Travel Visa payment does not deduct the $200 again');
}

console.log('\n=== O. HELOC funding/payment does not duplicate an assigned obligation ===');
{
  const helocBill = 400;
  const plan = fixturePlan({
    bills: [
      {
        id: 'heloc', label: 'HELOC', frequency: 'once', date: '2026-09-15',
        amount: helocBill, confidence: 'confirmed', debtId: 'heloc',
      },
    ],
  });
  const transfer = {
    id: 'tx-heloc-pay',
    date: '2026-09-15',
    amount: helocBill,
    pending: false,
    categoryLabel: 'Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    kindHint: 'transfer',
    excludeFromTotals: true,
    displayedPayee: 'HELOC PAYMENT',
    originalMerchant: 'HELOC PAYMENT',
  };
  const none = activeOf(recommend(plan, []));
  const paid = activeOf(recommend(plan, [transfer], {
    debts: [{
      id: 'heloc', label: 'HELOC', structure: 'Heloc', secured: true,
      rate: 5.5, balance: 20000, pending: 0, limit: 50000,
    }],
  }));
  ok(near(none.periodBillLoad, helocBill),
    'assigned HELOC bill is the one deduction');
  ok(near(paid.periodBillLoad, none.periodBillLoad)
      && near(paid.afterHouseholdBudget, none.afterHouseholdBudget)
      && near(paid.budgetHold, none.budgetHold),
    'later hub → HELOC transfer does not deduct the assigned bill again');
}

console.log('\n=== P. Lunch Money signed credit is not negative household income ===');
{
  const paydayOpening = {
    asOf: PAYDAY,
    representedEvents: [{ id: 'payroll', date: PAYDAY }],
    paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: 310.47 },
  };
  const signed = activeOf(recommend(fixturePlan({
    opening: paydayOpening,
    representedEvents: [{ id: 'payroll', date: PAYDAY }],
  }), [], {
    asOf: PAYDAY,
    actualsExtra: {
      observationAsOf: PAYDAY,
      coverageThrough: PAYDAY,
      representedActuals: [{ id: 'payroll', date: PAYDAY, actual: -DALE }],
    },
  }));
  ok(signed.incomeTotal > 0 && near(signed.incomeTotal, roundCent(DALE + AMANDA + CHILD)),
    'displayed Payday balance stays a positive income total');
  ok(signed.afterHouseholdBudget > 0
      && !near(signed.afterHouseholdBudget, roundCent(-DALE - BILLS - HOLD_PLAN)),
    'signed Lunch Money credit is not converted into negative BAD');
}

console.log('\n=== Q. Internal transfer into/out of hub is not manufactured as income/spending ===');
{
  const inbound = {
    id: 'in-to', date: PAYDAY, amount: 80, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'chequing-a', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'EF789 TFR-TO', originalMerchant: 'EF789 TFR-TO',
    tfrReference: 'EF789', tfrDirection: 'TO',
  };
  const inboundFr = {
    id: 'in-fr', date: PAYDAY, amount: -80, pending: false,
    categoryLabel: 'Payment, Transfer', accountRole: 'household-cash',
    atlasAccountId: 'chequing-b', excludeFromTotals: true, kindHint: 'transfer',
    displayedPayee: 'EF789 TFR-FR', originalMerchant: 'EF789 TFR-FR',
    tfrReference: 'EF789', tfrDirection: 'FR',
  };
  const none = activeOf(recommend(fixturePlan(), []));
  const moved = activeOf(recommend(fixturePlan(), [inbound, inboundFr]));
  ok(near(moved.incomeTotal, none.incomeTotal)
      && near(moved.afterHouseholdBudget, none.afterHouseholdBudget)
      && near(moved.budgetHold, none.budgetHold),
    'Weekly → hub transfer is not income and not Household Budget spending');
}

console.log('\n=== R. Talk and Budget/Plan reprint the same Forecast BAD ===');
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
    'recommend.defaultView remainder equals the calendar BAD');
  const packet = Assistant.projectPredictedEndingBalance
    ? null
    : {
      forecast: {
        predictedEndingBalance: {
          status: 'ok',
          source: 'Forecast.calendarPeriodWaterfalls',
          identity: 'balance-after-deductions',
          amount: row.afterHouseholdBudget,
        },
      },
    };
  const projected = {
    forecast: {
      predictedEndingBalance: {
        status: 'ok',
        source: 'Forecast.calendarPeriodWaterfalls',
        identity: 'balance-after-deductions',
        amount: row.afterHouseholdBudget,
      },
    },
  };
  void packet;
  const claims = TalkWhy.publishablePaths([TalkSession.LEFTOVER_PATH], projected);
  const presented = TalkPresentation.presentVerifiedClaims(
    { status: 'explained', claims },
    projected
  );
  ok(TalkSession.LEFTOVER_PATH === 'forecast.predictedEndingBalance.amount',
    'Talk leftover path still reads the Forecast remainder field');
  ok(presented && presented.answer
      && /Balance after deductions for this pay period is/.test(presented.answer)
      && presented.answer.indexOf(TalkPresentation.formatCurrency(row.afterHouseholdBudget)) >= 0,
    'Talk leftover reprints the same Forecast BAD amount and wording');
  ok(!/Predicted ending balance for this pay period is/.test(presented.answer),
    'Talk no longer names Predicted Ending Balance');
}

console.log('\n=== S. Long-horizon Forecast / Road Ahead arithmetic is unchanged ===');
{
  const plan = fixturePlan();
  const asOf = AS_OF;
  const opts = {
    targetBuffer: 0,
    debts: [],
    currentPeriodActuals: actuals([]),
  };
  let baseline = null;
  let threw = false;
  try {
    baseline = F.baselineTrajectory(plan, [], asOf, opts);
  } catch (err) {
    threw = true;
  }
  ok(!threw, 'baselineTrajectory does not throw');
  ok(!baseline || !baseline.balanceAfterDeductions,
    'long-horizon trajectory does not own Balance After Deductions');
  const hubOnly = fixturePlan({ weekly: WEEKLY, savings: SAVINGS });
  const weeklyMoved = fixturePlan({ weekly: WEEKLY - 250, savings: SAVINGS + 250 });
  const baseWalk = F.startingCashAmount(hubOnly);
  const movedWalk = F.startingCashAmount(weeklyMoved);
  ok(near(baseWalk, roundCent(HUB + WEEKLY))
      && near(movedWalk, roundCent(HUB + (WEEKLY - 250))),
    'walk spendable opening remains pooled chequing A+B, not hub Current Balance');
  const advice = F.recommend(plan, asOf, opts);
  ok(advice && advice.defaultView && advice.defaultView.predictedEndingBalance != null
      && advice.paydayAllocation && advice.paydayAllocation.runningLeftover,
    'current-pay-period BAD and paydayAllocation coexist; trajectory is separate');
  const next = period(advice.defaultView, 'next-pay-period');
  ok(!next || !near(next.opening, advice.defaultView.predictedEndingBalance),
    'next period does not open from Balance After Deductions');
}

console.log('\n=== T. Household UI ends at BAD and hides the reconciliation fluff ===');
{
  const plan = fixturePlan();
  const advice = recommend(plan, []);
  const html = composer.calendarWaterfallHtml(
    activeOf(advice), null, advice.paydayAllocation, plan
  );
  ok(/data-operating-prompt="Balance After Deductions"/.test(html),
    'waterfall prints Balance After Deductions');
  ok(!/data-operating-cash-explanation/.test(html)
      && !/operatingCashExplanationHtml\(period\.operatingCashExplanation\)/.test(
        grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml')),
    'active household waterfall does not print the operating-cash explanation');
  ok(!/data-operating-prompt="Opening balance"/.test(html),
    'active household waterfall does not print payday-boundary opening as Q01');
  ok(!/payday-boundary|Predicted Ending Balance|Bills ACCOUNT plus WEEKLY/i.test(html),
    'household UI does not print the technical leftover identity under Q07');
}

console.log('\n=== Cross-account: Weekly/Savings balances do not change BAD; eligible spend does ===');
{
  const base = activeOf(recommend(fixturePlan({ weekly: WEEKLY, savings: SAVINGS }), []));
  const balancesOnly = activeOf(recommend(fixturePlan({
    weekly: WEEKLY - 300,
    savings: SAVINGS + 300,
  }), []));
  ok(near(base.afterHouseholdBudget, balancesOnly.afterHouseholdBudget)
      && near(base.budgetHold, balancesOnly.budgetHold)
      && near(recommend(fixturePlan({ weekly: WEEKLY - 300, savings: SAVINGS + 300 }), [])
        .paydayAllocation.liveCurrentBalance, HUB),
    'Weekly/Savings balance-only moves change neither Current Balance nor BAD');
  const spend = activeOf(recommend(fixturePlan(), [groceryTx(HOLD_PLAN + 12, {
    id: 'tx-weekly-real',
    atlasAccountId: 'chequing-b',
  })]));
  ok(near(base.afterHouseholdBudget - spend.afterHouseholdBudget, 12),
    'a real eligible Weekly grocery overage does change Household Budget / BAD');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures ? 1 : 0;
