'use strict';
// Invented data only. Positive transaction evidence is independent of balances.
const previous = require('./card-period-movements-data');
const copy = previous.copy;
function fixture() {
  const x = previous.fixture();
  delete x.balanceEvidence;
  x.overlay = { applied: true, overlays: x.debts.map(debt => ({ locator: 'debts:' + debt.id,
    field: 'balance', proposedValue: debt.balance, evidenceDate: debt.evidenceDate || x.asOf })) };
  x.packet.transactionWindow = { startDate: x.window.start, endDate: x.asOf,
    complete: true, hasMore: false, truncated: false };
  x.packet.syncEvidence = x.debts.map(({ id }) => ({ id, role: 'revolving-credit',
    syncEvidence: ['triangle', 'mbna'].includes(id) ? 'absent' : 'proven',
    fields: { last_fetch: !['triangle', 'mbna'].includes(id),
      plaid_last_successful_update: false, status: false } }));
  x.packet.transactions.forEach(tx => { tx.savingsPostingEvidence = tx.pending ? 'pending' : 'posted'; });
  return x;
}
function served() {
  const data = previous.served(), x = fixture();
  const cash = data.liveOverlay.currentPeriodActuals.transactions.filter(tx => tx.accountRole !== 'revolving-credit');
  data.liveOverlay.currentPeriodActuals = { ...data.liveOverlay.currentPeriodActuals, ...copy(x.packet),
    transactions: [...cash, ...copy(x.packet.transactions.filter(tx => tx.accountRole === 'revolving-credit'))] };
  delete data.liveOverlay.cardPeriodBalanceEvidence;
  return data;
}
module.exports = { fixture, served, copy };
