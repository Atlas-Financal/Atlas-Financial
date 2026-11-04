'use strict';
// Invented values and identifiers; real evidence supplies identity/timing only.
const source = require('./card-backfill-data');
module.exports = function fixture(postedOn = '2026-09-29') {
  const x = source();
  x.asOf = '2026-09-30';
  x.data.debts = []; x.data.plan.obligations = [];
  x.data.plan.budget.categories = [{ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 0, confidence: 'confirmed' }];
  x.data.plan.bills = [
    { id: 'tdfees', label: 'Invented paired account fees', frequency: 'monthly', day: 30,
      amount: 24, payingAccount: 'chequing-a', confidence: 'confirmed' },
    { id: 'google-storage-100gb', label: 'Invented storage bill', frequency: 'monthly', day: 31,
      amount: 4, payingAccount: 'chequing-a', confidence: 'confirmed', budgetCategory: 'subscriptions' }
  ];
  x.accountMap.mappings = x.accountMap.mappings.slice(0,3);
  x.accountMap.mappings.push({ providerAccountId: '3005', atlasRole: 'household-external', externalId: 'tennis-income' });
  x.payload.accounts = x.payload.accounts.slice(0,3);
  x.payload.accounts.forEach((a,i) => { a.balance = [488, -23, 0][i]; a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow.endDate = x.asOf;
  x.payload.transactions = [
    { id: 82001, account_id: 3001, payee: 'MONTHLY ACCOUNT FEE', amount: 12 },
    { id: 82002, account_id: 3002, payee: 'MONTHLY ACCOUNT FEE', amount: 12 },
    { id: 82003, account_id: 3002, payee: 'O.D.P. FEE', amount: 7, category_name: 'Overdraft fees' },
    { id: 82004, account_id: 3005, payee: 'MONTHLY ACCOUNT FEE', amount: 6 },
    { id: 82005, account_id: 3005, payee: 'CHQ RETURN FEE', amount: 3 },
    { id: 82006, account_id: 3002, payee: 'Google', original_name: 'SERVICE _V', amount: 4, category_name: 'Online Purchases' }
  ].map(t => ({ date: postedOn, currency: 'cad', is_pending: false, category_name: 'Other bank fees', ...t }));
  return x;
};
