'use strict';
/* Owner-directed payday waterfall contract, 2026-09-09.
 *
 * Payday balance remains the pay-period income identity:
 *
 *   Dale salary + Amanda salary + recognized Other Income = Payday balance
 *
 * Owner 2026-09-21: Balance After Deductions is the household remaining
 *   displayed period income − assigned bills − Household Budget hold.
 * Current Balance remains a separate live hub-cash fact. A salary may remain
 * visibly unproven/not-relied-upon for settlement while still belonging to
 * Payday balance. Other Income is fluid through Payday balance and
 * through Balance After Deductions. Forecast owns all arithmetic;

 * plan.js only renders Forecast output.
 *
 * This is synthetic independent arithmetic. No household cents are used as a
 * behaviour oracle.
 */
const fs = require('fs');
const path = require('path');
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

const PAYDAY = '2026-09-11';
const OPENING = 632.22;
const DALE = 2000;
const AMANDA = 1500;
const OTHER = 350;
const BILL = 80;

const debts = [
  {
    id: 'cashback', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 500, rate: 19.99, payment: 20, pending: 0,
  },
];

function plan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: OPENING,
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: OPENING }],
    },
    opening: {
      asOf: PAYDAY,
      representedEvents: [],
      // This explicitly models an income occurrence whose settlement is not
      // proven. That status must remain truthful without deleting the salary
      // from the pay-period planning identity.
      notReliedUponEvents: [
        { id: 'amandaPayday', date: PAYDAY, reason: 'synthetic-unproven-settlement' },
      ],
    },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'netflix', label: 'Netflix', frequency: 'once', date: '2026-09-12',
        amount: BILL, confidence: 'confirmed',
      },
    ],
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

function actuals(other) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: PAYDAY,
    coverageThrough: PAYDAY,
    pendingCoverage: 'complete', transactionCoverage: 'complete',
    transactions: [
      {
        id: 'tx-other', date: PAYDAY, amount: -other, pending: false,
        categoryLabel: 'Income', accountRole: 'household-cash', isIncome: true,
        displayedPayee: 'Synthetic external deposit',
        originalMerchant: 'Synthetic external deposit',
      },
    ],
    representedActuals: [],
  };
}

function recommend(other) {
  const p = plan();
  return F.recommend(p, PAYDAY, {
    targetBuffer: 0,
    debts,
    currentPeriodActuals: actuals(other),
    notReliedUponEvents: p.opening.notReliedUponEvents,
  });
}

function active(advice) {
  return ((advice && advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(row => row && row.id === 'this-pay-period');
}

console.log('=== 1. Payday balance is the pay-period income identity, not Current Balance ===');
{
  const row = active(recommend(OTHER));
  const expectedIncome = roundCent(DALE + AMANDA + OTHER);
  ok(row && row.role === 'active', 'This Pay Period exists');
  ok(near(row.currentBalance, OPENING),
    'Current Balance stays the separate live/factual opening');
  ok(near(row.incomeTotal, expectedIncome),
    'incomeTotal independently equals Dale + Amanda + Other Income',
    `${row && row.incomeTotal} vs ${expectedIncome}`);
  ok(near(row.available, expectedIncome),
    'Payday balance equals Dale + Amanda + Other Income — opening cash is not added',
    `${row && row.available} vs ${expectedIncome}`);
  ok(!near(row.available, roundCent(OPENING + expectedIncome)),
    'Payday balance does not reuse Current Balance as an opening term');

  const amanda = ((row && row.income) || []).find(item => item && item.id === 'amandaPayday');
  ok(amanda && (amanda.notReliedUpon === true || amanda.settlement === 'not-relied-upon'),
    'Amanda settlement uncertainty remains visible');
  ok(amanda && near(amanda.amount, AMANDA),
    'settlement uncertainty does not erase Amanda from the planning salary row');
}

console.log('\n=== 2. Bills and Household Budget are downstream of Payday balance ===');
{
  const row = active(recommend(OTHER));
  const expectedPayday = roundCent(DALE + AMANDA + OTHER);
  ok(near(row.afterBills, roundCent(row.incomeTotal - row.periodBillLoad)),
    'Balance after bills = Payday balance − period bill load');
  ok(near(row.afterHouseholdBudget, roundCent(row.afterBills - row.budgetHold)),
    'Balance After Deductions = Balance after bills − Household Budget');
  ok(near(row.afterHouseholdBudget, roundCent(expectedPayday - row.periodBillLoad - row.budgetHold)),
    'Balance After Deductions is the income-led remainder');

}

console.log('\n=== 3. Other Income is fluid through the whole waterfall ===');
{
  const before = active(recommend(OTHER));
  const after = active(recommend(OTHER + 100));
  ok(near(after.currentBalance, before.currentBalance),
    'Current Balance does not move when only planning Other Income changes');
  ok(near(after.otherIncome.amount - before.otherIncome.amount, 100),
    'recognized Other Income rises by exactly $100');
  ok(near(after.available - before.available, 100),
    'Payday balance rises dollar-for-dollar with Other Income');
  ok(near(after.afterBills - before.afterBills, 100),
    'Balance after bills rises dollar-for-dollar with Other Income');
  ok(near(after.afterHouseholdBudget - before.afterHouseholdBudget, 100),
    'Balance after household budget rises dollar-for-dollar with Other Income');
}

console.log('\n=== 4. Plan presents one simple income equation and renders Forecast values ===');
{
  const src = read('public/plan.js');
  const incomeFn = grab(src, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  const waterfallFn = grab(src, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');

  ok(/Payday balance/i.test(incomeFn),
    'Income section labels the Forecast total as Payday balance');
  ok(!/Assigned income/i.test(incomeFn) && !/Total income/i.test(incomeFn),
    'Income section does not publish competing Assigned income / Total income totals');
  ok(/period\.available/.test(incomeFn),
    'Payday balance is rendered from Forecast period.available');
  ok(!/Balance after payday/i.test(waterfallFn),
    'waterfall does not publish a second competing Balance after payday row');
  ok(/Balance after bills/i.test(waterfallFn)
      && /Balance After Deductions/i.test(waterfallFn),
    'downstream waterfall balances remain visible, ending at Balance After Deductions');

}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures ? 1 : 0;
