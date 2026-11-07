'use strict';
/* Other Income in the payday waterfall.
 *
 * Forecast owns irregular household-resource inflows that are not Dale
 * payroll, Amanda salary, transfers, card payments, TENNIS INCOME staging,
 * spend-reversal refunds, or cash flows already represented by another
 * event. plan.js renders that Forecast group; it does not classify or total.
 * Independent arithmetic / membership (L-002 / L-006).
 *
 * `node test/test-other-income.js` — 13 cases, including post-date
 * reconcile-once, received-over-estimated render, external ATM-deposit
 * vs internal TFR identity, and the Lunch Money Income correction path.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
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
    `${source}\n({ calendarIncomeHtml, calendarWaterfallHtml, calendarWaterfallsHtml, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-09-11';
const OPENING_CASH = 1000;
const DALE = 2000;
const AMANDA = 1500;
const GIFT = 350;
const REBATE = 40;
const EXPECTED_REFUND = 175;
const TRANSFER = 300;
const CARD_PAY = 500;
const SALARY_DEPOSIT = DALE;
const GROCERY_REFUND = -12.50;
const TENNIS_DEPOSIT = 2168.85;

const debts = [
  {
    id: 'cashback', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 200, rate: 19.99, payment: 20, pending: 0,
  },
  {
    id: 'mortgage', label: 'Mortgage', secured: true,
    structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0,
  },
];

function paydayPlan(extraIncome) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: OPENING_CASH,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: OPENING_CASH },
      ],
      heldElsewhere: [
        { id: 'amanda-debt-payments', label: 'TENNIS INCOME', value: 4000 },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ].concat(extraIncome || []),
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedMonthly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
}

function actualsPacket(txs, representedActuals) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: PAYDAY,
    coverageThrough: PAYDAY,
    pendingCoverage: 'complete',
    transactions: txs,
    representedActuals: representedActuals || [],
  };
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}

function recommend(plan, txs, extraOpts) {
  return F.recommend(plan, PAYDAY, Object.assign({
    targetBuffer: 0,
    debts,
    currentPeriodActuals: actualsPacket(txs || []),
  }, extraOpts || {}));
}

const composer = loadComposer();
const planSrc = read('public/plan.js');

console.log('=== 1. A genuine irregular deposit is included once ===');
{
  const gift = {
    id: 'tx-gift',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Gifts',
    accountRole: 'household-cash',
    isIncome: true,
    displayedPayee: 'Parents — back to school',
    originalMerchant: 'Parents — back to school',
  };
  const advice = recommend(paydayPlan(), [gift]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const independentOther = GIFT;
  const independentTotal = roundCent(DALE + AMANDA + GIFT);
  const independentAfter = roundCent(DALE + AMANDA + GIFT);
  ok(items.length === 1 && items[0].id === 'other-income:tx-gift',
    'gift deposit is one Other Income item', JSON.stringify(items.map(r => r.id)));
  ok(near(active.otherIncome.amount, independentOther),
    'Other Income amount independently equals the gift');
  ok(items.filter(r => r.id === 'other-income:tx-gift').length === 1,
    'the gift is not duplicated inside Other Income');
  ok(near(active.incomeTotal, independentTotal),
    'period incomeTotal independently equals Dale + Amanda + gift');
  ok(near(active.incomeAdded, independentTotal)
      && near(active.available, independentAfter),
    'Payday balance independently equals Dale + Amanda + gift');
}

console.log('\n=== 2. Multiple Other Income items total correctly ===');
{
  const gift = {
    id: 'tx-gift-2', date: PAYDAY, amount: -GIFT, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash', isIncome: true,
    displayedPayee: 'Parents', originalMerchant: 'Parents',
  };
  const rebate = {
    id: 'tx-rebate', date: PAYDAY, amount: -REBATE, pending: false,
    categoryLabel: 'Rebate', accountRole: 'household-cash',
    displayedPayee: 'Insurance rebate', originalMerchant: 'Insurance rebate',
  };
  const independentOther = roundCent(GIFT + REBATE);
  const advice = recommend(paydayPlan(), [gift, rebate]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const handSum = roundCent(items.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  ok(items.length === 2, 'two Other Income items', String(items.length));
  ok(near(handSum, independentOther) && near(active.otherIncome.amount, independentOther),
    'Forecast Other Income total independently equals gift + rebate');
  ok(near(active.incomeTotal, roundCent(DALE + AMANDA + independentOther)),
    'incomeTotal independently equals Dale + Amanda + other items');
}

console.log('\n=== 3. An internal transfer is not income ===');
{
  const xfer = {
    id: 'tx-xfer', date: PAYDAY, amount: TRANSFER, pending: false,
    categoryLabel: 'Transfer', accountRole: 'household-cash',
    kindHint: 'transfer', excludeFromTotals: true,
    displayedPayee: 'INTERNAL TRANSFER', originalMerchant: 'INTERNAL TRANSFER',
  };
  const card = {
    id: 'tx-cardpay', date: PAYDAY, amount: CARD_PAY, pending: false,
    categoryLabel: 'Payment', accountRole: 'household-cash',
    kindHint: 'card-payment', excludeFromTotals: true,
    displayedPayee: 'VISA PAYMENT', originalMerchant: 'VISA PAYMENT',
  };
  const groceryRefund = {
    id: 'tx-groc-refund', date: PAYDAY, amount: GROCERY_REFUND, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'REFUND GROCER', originalMerchant: 'REFUND GROCER',
  };
  const refundLabeledSpendReversal = {
    id: 'tx-refund-label', date: PAYDAY, amount: -8.25, pending: false,
    categoryLabel: 'Refund', accountRole: 'household-cash',
    displayedPayee: 'STORE CREDIT', originalMerchant: 'STORE CREDIT',
  };
  const tennis = {
    id: 'tx-tennis', date: PAYDAY, amount: TENNIS_DEPOSIT, pending: false,
    categoryLabel: 'Income', accountRole: 'household-external',
    isIncome: true, atlasAccountId: 'amanda-debt-payments',
    displayedPayee: 'TENNIS BC', originalMerchant: 'TENNIS BC',
  };
  const advice = recommend(paydayPlan(), [xfer, card, groceryRefund, refundLabeledSpendReversal, tennis]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  ok(items.length === 0 && near(active.otherIncome.amount, 0),
    'transfer, card payment, grocery refund, refund-label spend reversal, and TENNIS INCOME are not Other Income');
  ok(near(active.incomeAdded, roundCent(DALE + AMANDA))
      && near(active.available, roundCent(DALE + AMANDA)),
    'Payday balance is still only Dale + Amanda');
}

console.log('\n=== 4. Regular salary is not duplicated into Other Income ===');
{
  const seaspan = {
    id: 'tx-seaspan', date: PAYDAY, amount: SALARY_DEPOSIT, pending: false,
    categoryLabel: 'Income', accountRole: 'household-cash', isIncome: true,
    displayedPayee: 'SEASPAN PAYROLL', originalMerchant: 'SEASPAN PAYROLL',
  };
  const amandaXfer = {
    id: 'tx-amanda-xfer', date: PAYDAY, amount: AMANDA, pending: false,
    categoryLabel: 'Transfer', accountRole: 'household-cash',
    kindHint: 'transfer', excludeFromTotals: true,
    displayedPayee: 'TFR FROM TENNIS', originalMerchant: 'TFR FROM TENNIS',
  };
  const advice = recommend(paydayPlan(), [seaspan, amandaXfer], {
    representedEvents: [
      { id: 'payroll', date: PAYDAY },
      { id: 'amandaPayday', date: PAYDAY },
    ],
    currentPeriodActuals: actualsPacket([seaspan, amandaXfer], [
      { id: 'payroll', date: PAYDAY, actual: SALARY_DEPOSIT, transactionId: 'tx-seaspan', postedOn: PAYDAY },
      { id: 'amandaPayday', date: PAYDAY, actual: AMANDA, transactionId: 'tx-amanda-xfer', postedOn: PAYDAY },
    ]),
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const payrollRows = (active.income || []).filter(r => r && r.id === 'payroll');
  const amandaRows = (active.income || []).filter(r => r && r.id === 'amandaPayday');
  ok(payrollRows.length === 1 && amandaRows.length === 1,
    'Dale and Amanda salary remain one scheduled row each');
  ok(items.length === 0 && near(active.otherIncome.amount, 0),
    'Seaspan deposit and Amanda BILLS transfer are not Other Income');
  ok(near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'incomeTotal is Dale + Amanda once, not duplicated');
}

console.log('\n=== 5. Expected income is not presented as already received ===');
{
  const expected = {
    id: 'expected-refund',
    label: 'Expected refund',
    frequency: 'once',
    date: PAYDAY,
    amount: EXPECTED_REFUND,
    confidence: 'estimated',
    incomeClass: 'other',
  };
  const advice = recommend(paydayPlan([expected]), []);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const row = items.find(r => r && r.id === 'expected-refund');
  ok(row && near(row.amount, EXPECTED_REFUND),
    'expected refund is in Other Income');
  ok(row.status === 'arriving' && row.alreadyInCash !== true
      && row.settlement !== 'represented',
    'expected refund is arriving, not received',
    row && `${row.status} / ${row.settlement} / alreadyInCash=${row.alreadyInCash}`);
  ok(near(active.otherIncome.amount, EXPECTED_REFUND)
      && near(active.incomeAdded, roundCent(DALE + AMANDA + EXPECTED_REFUND)),
    'expected refund is planned into Payday balance and is not treated as cash on hand');
  const html = composer.calendarIncomeHtml(active);
  ok(/Expected refund|Other income/.test(html)
      && /arriving|Expected/.test(html)
      && !/data-other-income-item="expected-refund"[^>]*data-income-status="received"/.test(html),
    'page does not print the expected refund as received');
}

console.log('\n=== 6. Reconciling expected to observed does not double-count ===');
{
  const expected = {
    id: 'expected-refund',
    label: 'Expected refund',
    frequency: 'once',
    date: PAYDAY,
    amount: EXPECTED_REFUND,
    confidence: 'estimated',
    incomeClass: 'other',
  };
  const observed = {
    id: 'tx-refund', date: PAYDAY, amount: -EXPECTED_REFUND, pending: false,
    categoryLabel: 'Reimbursement', accountRole: 'household-cash',
    displayedPayee: 'Tax refund', originalMerchant: 'Tax refund',
  };
  const advice = recommend(paydayPlan([expected]), [observed]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const expectedRows = items.filter(r => r && r.id === 'expected-refund');
  const observedRows = items.filter(r => r && String(r.id).indexOf('tx-refund') !== -1);
  ok(expectedRows.length === 1 && observedRows.length === 0,
    'observed deposit is reconciled onto the expected row, not added again',
    JSON.stringify(items.map(r => r.id)));
  ok(near(active.otherIncome.amount, EXPECTED_REFUND),
    'Other Income is the refund once');
  ok(near(active.incomeTotal, roundCent(DALE + AMANDA + EXPECTED_REFUND)),
    'incomeTotal counts the refund once');
  ok(expectedRows[0].reconciledFrom
      && expectedRows[0].status === 'received',
    'reconciled expected row is received',
    expectedRows[0] && `${expectedRows[0].reconciledFrom} / ${expectedRows[0].status}`);
  const html = composer.calendarIncomeHtml(active);
  const itemHtml = html.match(/data-other-income-item="expected-refund"[\s\S]*?<\/li>/);
  ok(itemHtml && /other-income-tx-received">Received</.test(itemHtml[0])
      && !/other-income-tx-pending">Expected</.test(itemHtml[0])
      && !/about /.test(itemHtml[0])
      && itemHtml[0].includes(composer.money2(EXPECTED_REFUND)),
    'reconciled received row renders Received and an exact amount, not Expected/about');
}

console.log('\n=== 8. After cashAsOf advances, expected Other Income still counts once ===');
{
  const laterAsOf = '2026-09-12';
  const expected = {
    id: 'expected-refund',
    label: 'Expected refund',
    frequency: 'once',
    date: PAYDAY,
    amount: EXPECTED_REFUND,
    confidence: 'estimated',
    incomeClass: 'other',
  };
  const observed = {
    id: 'tx-refund-post-date', date: PAYDAY, amount: -EXPECTED_REFUND, pending: false,
    categoryLabel: 'Reimbursement', accountRole: 'household-cash',
    displayedPayee: 'Tax refund', originalMerchant: 'Tax refund',
  };
  const plan = paydayPlan([expected]);
  plan.opening.asOf = laterAsOf;
  plan.opening.paydaySnapshot = {
    periodStart: PAYDAY,
    asOf: PAYDAY,
    opening: OPENING_CASH,
  };
  const advice = F.recommend(plan, laterAsOf, {
    targetBuffer: 0,
    debts,
    paydaySnapshot: plan.opening.paydaySnapshot,
    currentPeriodActuals: actualsPacket([observed]),
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const expectedRows = items.filter(r => r && r.id === 'expected-refund');
  const observedRows = items.filter(r => r && String(r.id).indexOf('tx-refund-post-date') !== -1);
  const independentOther = EXPECTED_REFUND;
  const independentTotal = roundCent(DALE + AMANDA + EXPECTED_REFUND);
  const independentAfter = roundCent(DALE + AMANDA + EXPECTED_REFUND);
  ok(expectedRows.length === 1 && observedRows.length === 0 && items.length === 1,
    'post-date expected refund stays eligible and reconciles to one Other Income row',
    JSON.stringify(items.map(r => ({ id: r.id, status: r.status, alreadyInCash: r.alreadyInCash }))));
  ok(expectedRows[0] && expectedRows[0].reconciledFrom
      && expectedRows[0].status === 'received',
    'post-date expected row is received by unique observed evidence, not by date passing',
    expectedRows[0] && `${expectedRows[0].reconciledFrom} / ${expectedRows[0].status}`);
  ok(near(active.otherIncome.amount, independentOther),
    'Other Income counts the refund once after cashAsOf advances');
  ok(near(active.incomeTotal, independentTotal),
    'incomeTotal counts the refund once after cashAsOf advances');
  ok(near(active.incomeAdded, independentTotal)
      && near(active.available, independentAfter),
    'Payday balance counts the refund once after cashAsOf advances');
}

console.log('\n=== 7. Displayed Other Income total reconciles to authoritative rows ===');
{
  const gift = {
    id: 'tx-gift-3', date: PAYDAY, amount: -GIFT, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash', isIncome: true,
    displayedPayee: 'Parents — back to school', originalMerchant: 'Parents — back to school',
  };
  const rebate = {
    id: 'tx-rebate-3', date: PAYDAY, amount: -REBATE, pending: false,
    categoryLabel: 'Rebate', accountRole: 'household-cash',
    displayedPayee: 'Insurance rebate', originalMerchant: 'Insurance rebate',
  };
  const independentOther = roundCent(GIFT + REBATE);
  const independentTotal = roundCent(DALE + AMANDA + independentOther);
  const advice = recommend(paydayPlan(), [gift, rebate]);
  const active = period(advice.defaultView, 'this-pay-period');
  const html = composer.calendarIncomeHtml(active);
  const itemSum = roundCent(((active.otherIncome && active.otherIncome.items) || [])
    .reduce((s, r) => s + (Number(r.amount) || 0), 0));
  ok(near(itemSum, independentOther) && near(active.otherIncome.amount, itemSum),
    'Forecast otherIncome.amount equals the independent item sum');
  ok(/data-other-income/.test(html) && /other-income-detail/.test(html),
    'page renders Other Income as an expandable disclosure');
  ok(html.includes(composer.money2(independentOther)),
    'page prints Forecast Other Income total; it does not invent a second total');
  ok(/data-payday-balance/.test(html) && html.includes(composer.money2(independentTotal)),
    'page prints Forecast Payday balance from period.available');
  const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/period\.otherIncome/.test(incomeFn) && /period\.available/.test(incomeFn)
      && /Payday balance/i.test(incomeFn)
      && !/otherItems\.reduce/.test(incomeFn) && !/other\.items\.reduce/.test(incomeFn)
      && !/Assigned income/i.test(incomeFn) && !/Total income/i.test(incomeFn),
    'plan.js renders Forecast otherIncome / Payday balance; it does not sum the rows');
  const waterfallFn = grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');
  ok(!/Balance after payday/i.test(waterfallFn) && !/\.opening\s*\+/.test(waterfallFn),
    'plan.js does not publish a competing Balance after payday or compute opening + income');
}

console.log('\n=== 9. External ATM deposit vs internal TFR-FR is counted once ===');
{
  // Lunch Money v2: negative = credit / inflow. Category Payment, Transfer
  // is the incumbent mislabel. Synthetic ids; amount reuses GIFT.
  const atmDep = {
    id: 'tx-atm-dep',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    excludeFromTotals: true,
    displayedPayee: 'TD ATM DEP 100001',
    originalMerchant: 'TD ATM DEP 100001',
  };
  const tfrTo = {
    id: 'tx-tfr-to',
    date: PAYDAY,
    amount: GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    excludeFromTotals: true,
    kindHint: 'transfer',
    displayedPayee: 'SY001 TFR-TO BILLSA',
    originalMerchant: 'SY001 TFR-TO BILLSA',
  };
  const tfrFr = {
    id: 'tx-tfr-fr',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    excludeFromTotals: true,
    kindHint: 'transfer',
    displayedPayee: 'SY001 TFR-FR CASHB',
    originalMerchant: 'SY001 TFR-FR CASHB',
  };
  const independentOther = GIFT;
  const independentTotal = roundCent(DALE + AMANDA + GIFT);
  const independentAfter = roundCent(DALE + AMANDA + GIFT);
  const advice = recommend(paydayPlan(), [atmDep, tfrTo, tfrFr]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const atmRows = items.filter(r => r && String(r.id).indexOf('tx-atm-dep') !== -1);
  const tfrRows = items.filter(r => r && /tx-tfr/.test(String(r.id)));
  ok(atmRows.length === 1 && tfrRows.length === 0 && items.length === 1,
    'ATM deposit is the one Other Income item; both TFR legs stay out',
    JSON.stringify(items.map(r => r.id)));
  ok(near(active.otherIncome.amount, independentOther),
    'Other Income independently equals the ATM deposit once');
  ok(near(active.incomeTotal, independentTotal)
      && near(active.incomeAdded, independentTotal)
      && near(active.available, independentAfter),
    'Payday balance adds the ATM deposit once and not the TFR-FR');
}

console.log('\n=== 10. Overlay-stripped ATM deposit flag still counts; TFR flag does not ===');
{
  const atmDep = {
    id: 'tx-atm-flag',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    excludeFromTotals: true,
    externalCashDeposit: true,
  };
  const tfrFr = {
    id: 'tx-tfr-flag',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    excludeFromTotals: true,
    internalTransferIdentity: true,
  };
  const advice = recommend(paydayPlan(), [atmDep, tfrFr]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  ok(items.length === 1 && items[0].id === 'other-income:tx-atm-flag',
    'stripped ATM deposit flag is Other Income; stripped TFR flag is not',
    JSON.stringify(items.map(r => r.id)));
  ok(near(active.otherIncome.amount, GIFT),
    'flag-only ATM deposit independently equals GIFT once');
}

console.log('\n=== 11. Ambiguous credit categorized Income enters Other Income ===');
{
  const manual = {
    id: 'tx-manual-income',
    date: PAYDAY,
    amount: -REBATE,
    pending: false,
    categoryLabel: 'Income',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    isIncome: true,
    displayedPayee: 'UNKNOWN CREDIT',
    originalMerchant: 'UNKNOWN CREDIT',
  };
  const advice = recommend(paydayPlan(), [manual]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  ok(items.length === 1 && items[0].id === 'other-income:tx-manual-income',
    'explicit Lunch Money Income credit is one Other Income item',
    JSON.stringify(items.map(r => r.id)));
  ok(near(active.otherIncome.amount, REBATE)
      && near(active.incomeTotal, roundCent(DALE + AMANDA + REBATE)),
    'manual Income correction independently equals the credit');
}

console.log('\n=== 12. Internal transfer labeled Income is still not Other Income ===');
{
  const tfrFr = {
    id: 'tx-tfr-income-label',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Income',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    isIncome: true,
    excludeFromTotals: true,
    displayedPayee: 'SY001 TFR-FR CASHB',
    originalMerchant: 'SY001 TFR-FR CASHB',
  };
  const tfrTo = {
    id: 'tx-tfr-income-out',
    date: PAYDAY,
    amount: GIFT,
    pending: false,
    categoryLabel: 'Income',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    isIncome: true,
    excludeFromTotals: true,
    displayedPayee: 'SY001 TFR-TO BILLSA',
    originalMerchant: 'SY001 TFR-TO BILLSA',
  };
  const advice = recommend(paydayPlan(), [tfrFr, tfrTo]);
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  ok(items.length === 0 && near(active.otherIncome.amount, 0),
    'TFR legs labeled Income do not become household resources');
  ok(near(active.incomeAdded, roundCent(DALE + AMANDA))
      && near(active.available, roundCent(DALE + AMANDA)),
    'Payday balance is still only Dale + Amanda');
}

console.log('\n=== 13. Same-day ATM withdrawal keeps automatic ATM deposit closed ===');
{
  const atmDep = {
    id: 'tx-atm-redeposit',
    date: PAYDAY,
    amount: -GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    excludeFromTotals: true,
    displayedPayee: 'TD ATM DEP 100001',
    originalMerchant: 'TD ATM DEP 100001',
  };
  const atmWd = {
    id: 'tx-atm-wd',
    date: PAYDAY,
    amount: GIFT,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
    excludeFromTotals: true,
    displayedPayee: 'ATM W/D 100001',
    originalMerchant: 'ATM W/D 100001',
  };
  const autoAdvice = recommend(paydayPlan(), [atmDep, atmWd]);
  const autoActive = period(autoAdvice.defaultView, 'this-pay-period');
  const autoItems = (autoActive.otherIncome && autoActive.otherIncome.items) || [];
  ok(autoItems.length === 0 && near(autoActive.otherIncome.amount, 0),
    'same-day ATM W/D of the same amount fails the automatic deposit closed');
  const manualDep = Object.assign({}, atmDep, {
    id: 'tx-atm-redeposit-income',
    categoryLabel: 'Income',
    isIncome: true,
  });
  const manualAdvice = recommend(paydayPlan(), [manualDep, atmWd]);
  const manualActive = period(manualAdvice.defaultView, 'this-pay-period');
  const manualItems = (manualActive.otherIncome && manualActive.otherIncome.items) || [];
  ok(manualItems.length === 1 && near(manualActive.otherIncome.amount, GIFT),
    'Lunch Money Income still admits the deposit when the household corrects it',
    JSON.stringify(manualItems.map(r => r.id)));
}

console.log('\n=== 14. An invalid adjustment does not break reconciliation (ATLAS-026 provenance) ===');
{
  // The expected refund carries an incomeOccurrenceAdjust whose amount
  // is a positive string: the substituted event is marked privately and
  // must not gain a contribution through coercion, but occurrence
  // identity is preserved until the genuine deposit reconciles — and
  // then the row and the totals publish from the actual, exactly as
  // case 6 does with no adjustment.
  const expected = {
    id: 'expected-refund',
    label: 'Expected refund',
    frequency: 'once',
    date: PAYDAY,
    amount: EXPECTED_REFUND,
    confidence: 'estimated',
    incomeClass: 'other',
  };
  const observed = {
    id: 'tx-refund', date: PAYDAY, amount: -EXPECTED_REFUND, pending: false,
    categoryLabel: 'Reimbursement', accountRole: 'household-cash',
    displayedPayee: 'Tax refund', originalMerchant: 'Tax refund',
  };
  const advice = recommend(paydayPlan([expected]), [observed], {
    incomeOccurrenceAdjust: (s) => s && s.id === 'expected-refund'
      ? { amount: '250', confidence: 'estimated' } : null,
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const items = (active.otherIncome && active.otherIncome.items) || [];
  const expectedRows = items.filter(r => r && r.id === 'expected-refund');
  ok(expectedRows.length === 1 && items.length === 1,
    'invalid adjustment: the deposit still reconciles onto the expected row',
    JSON.stringify(items.map(r => r.id)));
  ok(expectedRows[0] && expectedRows[0].reconciledFrom
      && expectedRows[0].status === 'received'
      && near(expectedRows[0].amount, EXPECTED_REFUND),
    'invalid adjustment: the genuine actual replaces the coerced row figure',
    expectedRows[0] && `${expectedRows[0].amount} / ${expectedRows[0].reconciledFrom}`);
  ok(near(active.otherIncome.amount, EXPECTED_REFUND)
      && near(active.incomeTotal, roundCent(DALE + AMANDA + EXPECTED_REFUND))
      && active.incomeTrust !== 'unavailable',
    'invalid adjustment: period totals publish from the actual once',
    `${active.incomeTotal} / ${active.incomeTrust}`);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Other Income checks passed.');
