'use strict';
// H2-8b: the Bills-only period balance (MCP billsEndingBalance) keeps a
// scheduled fee allowance's unspent part after a fee posts, the same amount
// the period view's remainingBills holds. Invented values only.
//
// Hand-derived: chequing-a 490 after a 10 fee posted against a 30 monthly
// allowance (20 left), plus an unpaid 25 card minimum. No Bills income left in
// the period. Ending = 490 - 25 - 20 = 445.
const F = require('../public/forecast.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
function world({ feePosted = 10, cash = 490, extraBill = null } = {}) {
  const plan = {
    opening: { asOf: '2026-09-20', paydaySnapshot: { periodStart: '2026-09-18', asOf: '2026-09-18', opening: 500 } },
    startingCash: { asOf: '2026-09-20', breakdown: [
      { id: 'chequing-a', value: cash, confidence: 'confirmed', evidenceDate: '2026-09-20' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-09-20' },
    ] },
    income: [
      { id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-09-18', amount: 1000, confidence: 'confirmed', depositAccount: 'chequing-a' },
    ],
    bills: [{ id: 'tdfees', label: 'Bank Fees', frequency: 'monthly', day: 19, amount: 30, confidence: 'confirmed' }]
      .concat(extraBill ? [extraBill.bill] : []),
    obligations: [{ id: 'card-min', label: 'Card Min', debtId: 'travelvisa', effect: 'payment', frequency: 'once', date: '2026-09-25', amount: 25, confidence: 'confirmed', payingAccount: 'chequing-a' }],
    commitments: [], budget: { categories: [] },
  };
  const transactions = [{ id: 'tx-fee', date: '2026-09-19', amount: feePosted, currency: 'CAD', atlasAccountId: 'chequing-a', accountRole: 'household-cash', pending: false, category: 'Bank Fees' }];
  const representedActuals = [{ id: 'tdfees', date: '2026-09-19', actual: feePosted, postedOn: '2026-09-19', transactionId: 'tx-fee' }];
  const representedEvents = [{ id: 'tdfees', date: '2026-09-19', postedOn: '2026-09-19', effectiveAsOf: '2026-09-19' }];
  if (extraBill) {
    transactions.push(extraBill.tx); representedActuals.push(extraBill.actual); representedEvents.push(extraBill.event);
  }
  const a = F.recommend(plan, '2026-09-20', {
    weeklyVariable: 0, debts: [{ id: 'travelvisa', label: 'Card', structure: 'Revolving', secured: false, balance: 400, pending: 0, rate: 0.2, limit: 2000 }],
    currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-09-20', coverageStart: '2026-09-18', coverageThrough: '2026-09-20',
      currency: 'CAD', transactionCoverage: 'complete', pendingCoverage: 'complete', transactions, representedActuals },
    representedEvents,
  });
  const cur = a.payPeriodViews.find(v => v.role === 'active');
  return { view: cur, b: cur.billsAccountPeriodBalance };
}

console.log('\n=== 1. a posted fee leaves its unspent allowance in the Bills-only balance ===');
{
  const { view, b } = world();
  ok(b.status === 'ready', 'balance ready', b.status);
  ok(b.remainingBills === 45, 'Bills-only remainingBills 45 (25 minimum + 20 allowance left)', b.remainingBills);
  ok(b.remainingBills === view.remainingBills, 'matches the period view remainingBills', { b: b.remainingBills, view: view.remainingBills });
  ok(b.amount === 445, 'ending 445 (490 - 25 - 20)', b.amount);
}

console.log('\n=== 2. controls ===');
{
  const used = world({ feePosted: 30, cash: 470 }).b;
  ok(used.remainingBills === 25 && used.amount === 445, 'allowance fully used: adds 0 (470 - 25)', { remainingBills: used.remainingBills, amount: used.amount });
  const other = world({ cash: 450, extraBill: {
    bill: { id: 'phone', label: 'Phone', frequency: 'monthly', day: 19, amount: 40, confidence: 'confirmed', payingAccount: 'chequing-a' },
    tx: { id: 'tx-phone', date: '2026-09-19', amount: 40, currency: 'CAD', atlasAccountId: 'chequing-a', accountRole: 'household-cash', pending: false, category: 'Phone' },
    actual: { id: 'phone', date: '2026-09-19', actual: 40, postedOn: '2026-09-19', transactionId: 'tx-phone' },
    event: { id: 'phone', date: '2026-09-19', postedOn: '2026-09-19', effectiveAsOf: '2026-09-19' },
  } }).b;
  ok(other.remainingBills === 45 && other.amount === 405, 'a paid non-fee bill is still not deducted again (450 - 25 - 20)', { remainingBills: other.remainingBills, amount: other.amount });
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
