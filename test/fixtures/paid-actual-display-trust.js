'use strict';
// Independent invented ledger. August opening Bills cash 15 + payroll 2600
// - mortgage 1400 - current variable receipt 61.27 = observed Bills 1153.73.
// The historical receipt 59.83 predates that opening. Both future schedules
// remain estimated at 183.61; neither receipt is a new planning assumption.
const source = require('./budget-surface-data');
const Live = require('../../scripts/live-plan');
function input() {
  const data = source.canonical(), payload = source.payload();
  const identity = { ...source.identity, rules: [...source.identity.rules] };
  payload.transactionWindow.startDate = '2026-07-31';
  payload.accounts.find(a => a.id === 1001).balance = 1153.73;
  for (const [id, day, date, amount, txId] of [
    ['invented-past-utility', 7, '2026-08-07', 59.83, 93001],
    ['invented-current-utility', 19, '2026-08-19', 61.27, 93002],
  ]) {
    const label = id === 'invented-past-utility' ? 'Invented historical utility' : 'Invented current utility';
    data.plan.bills.push({ id, label, frequency: 'monthly', day, firstDue: date,
      amount: 183.61, confidence: 'estimated', payingAccount: 'chequing-a' });
    payload.transactions.push({ id: txId, account_id: 1001, date, amount, currency: 'cad',
      payee: label, category_id: 16, is_pending: false, status: 'cleared' });
    identity.rules.push({ eventId: id, payeePattern: label, atlasAccountId: 'chequing-a', direction: 'debit',
      settlesWhen: 'variable-amount' });
  }
  return { data, payload, identity, accountMap: source.map };
}
function served(changeInput) {
  const x = input();
  if (changeInput) changeInput(x);
  return Live.fromObservation(x).data;
}
function replacement(pendingCurrency = 'usd') {
  return served(x => {
    const pending = x.payload.transactions.find(t => t.id === 93002);
    Object.assign(pending, { date: '2026-08-18', currency: pendingCurrency, is_pending: true,
      plaid_metadata: { transaction_id: 'invented-utility-pending' } });
    x.payload.transactions.push({ ...pending, id: 93003, date: '2026-08-19', currency: 'cad', is_pending: false,
      plaid_metadata: { transaction_id: 'invented-utility-posted', pending_transaction_id: 'invented-utility-pending' } });
  });
}
module.exports = { input, served, replacement };
