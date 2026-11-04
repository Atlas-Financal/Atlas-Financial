'use strict';
// Independent invented ledger and identity. No canonical household data.
const base = require('./card-backfill-data');
module.exports = function fixture(mode = 'pending', early = false) {
  const x = base();
  const nextPeriod = early === 'next-period';
  const asOf = nextPeriod ? '2034-10-12' : early ? '2034-11-01' : '2034-10-06';
  const opening = early && !nextPeriod ? '2034-10-18' : '2034-09-18';
  const firstDue = nextPeriod ? '2034-10-14' : early ? '2034-11-03' : '2034-10-03';
  const p = x.data.plan;
  x.data.meta.asOf = p.opening.asOf = opening;
  p.windowDays = 90;
  p.income[0].anchor = early && !nextPeriod ? '2034-10-27' : '2034-09-29';
  p.income[0].amount = 0;
  p.budget.categories = [];
  p.obligations = [];
  p.commitments = [];
  p.bills = [{ id: 'invented-card-service', label: 'Invented subscription',
    amount: 73.21, frequency: 'monthly', day: nextPeriod ? 14 : 3, firstDue,
    confidence: 'confirmed', payingAccount: 'travelvisa', jointCash: false,
    budgetCategory: null, subscription: true }];
  p.cardPurchaseCoverage = { opening: { asOf: opening, confirmed: true,
    currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] },
    payments: [], refunds: [], reversals: [] };
  x.identity = { rules: [{ eventId: 'invented-card-service',
    payeePattern: 'Invented subscription', payeePatterns: ['Invented subscription'],
    payeeMatchMode: 'exact', atlasAccountId: 'travelvisa', direction: 'debit',
    requiredCurrency: 'cad', settlesWhen: 'exact-scheduled-amount',
    postingDateRule: 'covers-early-or-due-on-or-before-posting', earlyPayLookaheadDays: 2 }] };
  const tx = { id: 81001, account_id: 3004, currency: 'cad',
    date: early ? asOf : '2034-10-05', amount: 73.21,
    is_pending: mode !== 'posted', payee: 'Invented subscription',
    original_name: 'Invented subscription', category_name: 'Personal Care' };
  x.payload.transactions = mode === 'absent' ? [] : [tx];
  if (mode === 'unrelated') x.payload.transactions.push({ ...tx, id: 81002,
    amount: 19.37, payee: 'Invented unrelated purchase', original_name: 'Invented unrelated purchase' });
  if (mode === 'duplicate') x.payload.transactions.push({ ...tx, id: 81002 });
  if (mode === 'wrong-merchant') tx.payee = tx.original_name = 'Invented different merchant';
  if (mode === 'wrong-amount') tx.amount = 74.21;
  if (mode === 'authorization') tx.amount = 1;
  if (mode === 'wrong-account') tx.account_id = 3001;
  if (mode === 'foreign-currency') tx.currency = 'usd';
  x.payload.fetchedAt = asOf + 'T18:00:00Z';
  x.payload.accounts.forEach(a => { a.updated_at = asOf + 'T17:00:00Z'; a.balance_last_update = asOf + 'T17:00:00Z'; });
  x.payload.accounts[0].balance = mode === 'insufficient-backing' ? 30 : 500;
  x.payload.accounts[3].balance = mode === 'posted' ? 473.21 : 400;
  x.payload.transactionWindow = { startDate: opening, endDate: asOf,
    complete: true, hasMore: false, truncated: false };
  if (mode === 'incomplete') x.payload.pendingCoverage.complete = false;
  x.asOf = asOf;
  return x;
};

module.exports.withBackfill = function withBackfill(amount, early = true) {
  const x = module.exports('posted', early);
  const O = require('../../scripts/provider-observe');
  const ref = id => O.cardCoverageReference(O.normalizeLunchMoneyTransaction(
    x.payload.transactions.find(row => row.id === id)));
  const fields = { currency: 'cad', date: x.asOf, is_pending: false,
    category_name: 'Credit Card Payment' };
  x.payload.transactions.push(
    { ...fields, id: 81002, account_id: 3001, amount, payee: 'TFR-TO C/C' },
    { ...fields, id: 81003, account_id: 3004, amount: -amount, payee: 'PAYMENT - THANK YOU' });
  x.payload.accounts[0].balance = Math.round((500 - amount) * 100) / 100;
  x.payload.accounts[3].balance = Math.round((473.21 - amount) * 100) / 100;
  x.data.plan.cardPurchaseCoverage.payments = [{ id: 'invented-confirmed-backfill',
    confirmed: true, debitRef: ref(81002), creditRef: ref(81003),
    allocations: [{ purchaseRef: ref(81001), amount }], otherAmount: 0, otherPurpose: null }];
  return x;
};
