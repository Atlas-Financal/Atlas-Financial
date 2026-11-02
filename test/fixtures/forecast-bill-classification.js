'use strict';
// Invented ledger only. Canonical roles and incumbent merchant aliases exercise
// the real observation -> sanitized actuals -> Forecast path without live data.
const source = require('./card-backfill-data');
module.exports = function fixture() {
  const x = source();
  x.asOf = '2026-09-30';
  x.data.debts = [{ id: 'heloc', label: 'Invented secured line', structure: 'Revolving',
    secured: true, balance: 1000, pending: 0, rate: 0, limit: 5000 }];
  x.data.plan.startingCash.breakdown[1].value = 200;
  x.data.plan.budget.categories = [
    { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 0, confidence: 'confirmed' },
    { id: 'telecom', label: 'Telecom', class: 'essential', from: ['Telecom'], plannedMonthly: 19 },
  ];
  x.data.plan.bills = [
    { id: 'invented-phone', label: 'Invented telephone bill', frequency: 'monthly', day: 28,
      amount: 19, payingAccount: 'chequing-a', budgetCategory: 'telecom', confidence: 'confirmed' },
    { id: 'google-storage-100gb', label: 'Invented storage bill', frequency: 'monthly', day: 30,
      amount: 4, payingAccount: 'chequing-b', budgetCategory: 'subscriptions', confidence: 'confirmed' },
  ];
  x.data.plan.obligations = [{ id: 'heloc', debtId: 'heloc', label: 'Invented line interest',
    effect: 'capitalise', nonCash: true, frequency: 'monthly', day: 30, amount: 83,
    confidence: 'confirmed', payingAccount: 'chequing-a', cashPayment: 85,
    cashDay: 28, cashFirstDue: '2026-09-28', cashConfidence: 'confirmed' }];
  x.accountMap.mappings = x.accountMap.mappings.slice(0, 3);
  x.accountMap.mappings.push({ providerAccountId: '3004',
    canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' });
  x.payload.accounts.forEach((a, i) => {
    a.balance = [390, 189, 0, 992][i];
    a.updated_at = x.asOf + 'T17:00:00Z';
    if (i === 3) { a.type = 'loan'; a.subtype = 'line of credit'; a.credit_limit = 5000; }
  });
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow.endDate = x.asOf;
  x.payload.transactions = [
    { id: 91001, account_id: 3001, payee: 'Invented telephone co', amount: 19, category_name: 'Telephone' },
    { id: 91002, account_id: 3004, payee: 'INTEREST', amount: 83, category_name: 'Uncategorized' },
    { id: 91003, account_id: 3001, payee: 'IP470 TFR-TO INVENTED LINE', amount: 91, category_name: 'Transfer' },
    { id: 91004, account_id: 3004, payee: 'Invented payment received', amount: -91, category_name: 'Transfer' },
    { id: 91005, account_id: 3002, payee: 'Bill - Google One', original_name: 'Invented preserved bank descriptor',
      amount: 4, category_name: 'Online Purchases', recurring_id: null },
    { id: 91006, account_id: 3002, payee: 'Invented unrelated merchant', amount: 7, category_name: 'Shopping' },
  ].map(t => ({ date: '2026-09-28', currency: 'cad', is_pending: false, ...t }));
  return x;
};
