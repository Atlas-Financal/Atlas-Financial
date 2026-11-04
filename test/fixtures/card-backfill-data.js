'use strict';
// Independent invented ledger: 500 Bills cash, 400 card debt, an 80 purchase,
// and an 80 Bills-to-card transfer. Closing cash is 420 and card debt is 400.
const identity = require('../../docs/connectivity/transaction-identity.json');
module.exports = function fixture(cardId = 'travelvisa', eventId = 'travel') {
  const asOf = '2026-09-20';
  const data = { meta: { asOf: '2026-09-18' }, accounts: [], revolvingExtra: [],
    debts: [{ id: cardId, label: 'Invented card', structure: 'Revolving', secured: false, balance: 400,
      pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }],
    plan: { opening: { asOf: '2026-09-18' }, windowDays: 28,
      startingCash: { breakdown: [
        { id: 'chequing-a', label: 'Invented Bills', value: 500 },
        { id: 'chequing-b', label: 'Invented spending', value: 0 },
        { id: 'savings', label: 'Invented savings', value: 0 }] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Seaspan - invented', frequency: 'biweekly',
        anchor: '2026-09-18', amount: 1000, confidence: 'confirmed' }],
      bills: [], commitments: [],
      obligations: [{ id: eventId, label: 'Invented minimum', debtId: cardId,
        effect: 'payment', frequency: 'once', date: asOf, amount: 25,
        payingAccount: 'chequing-a', confidence: 'confirmed' }],
      budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
        plannedPayday: 150, plannedWeekly: 75, confidence: 'confirmed' }] } } };
  const ids = ['chequing-a', 'chequing-b', 'savings', cardId];
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney',
    scope: 'fixture', mappings: ids.map((id, i) => ({ providerAccountId: String(3001 + i),
      canonical: { collection: i === 3 ? 'debts' : 'cash', id },
      atlasRole: i === 3 ? 'revolving-credit' : 'household-cash' })) };
  const transactions = [
    { id: 80001, account_id: 3004, date: asOf, amount: 80,
      payee: 'Invented grocer', category_name: 'Groceries' },
    { id: 80002, account_id: 3001, date: asOf, amount: 80,
      payee: cardId === 'triangle' ? 'CAN TIRE MC' : cardId === 'mbna' ? 'MBNA M/C' : 'TFR-TO C/C',
      category_name: 'Credit Card Payment' },
    { id: 80003, account_id: 3004, date: asOf, amount: -80,
      payee: cardId === 'mbna' ? 'payment' : 'PAYMENT - THANK YOU',
      category_name: 'Credit Card Payment' }
  ].map(tx => ({ ...tx, is_pending: false, status: 'reviewed',
    notes: tx.id === 80001 ? null : 'Backfill for new purchases; not earmarked for the minimum.' }));
  const payload = { provider: 'lunchmoney', fetchedAt: asOf + 'T18:00:00Z',
    source: 'Independent invented purchase and transfer fixture',
    accounts: ids.map((id, i) => ({ id: 3001 + i, name: 'Invented ' + id,
      type: i === 3 ? 'credit' : 'cash', subtype: i === 3 ? 'credit_card' : 'checking',
      institution_name: 'Invented institution', currency: 'cad', balance: [420, 0, 0, 400][i],
      credit_limit: i === 3 ? 2000 : null, updated_at: asOf + 'T17:00:00Z', balance_last_update: asOf + 'T17:00:00Z' })),
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false,
      startDate: null, endDate: null }, transactions,
    transactionWindow: { startDate: '2026-09-18', endDate: asOf,
      complete: true, hasMore: false, truncated: false } };
  return { data, payload, identity, accountMap: map, asOf, cardId, eventId };
};
