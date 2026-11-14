'use strict';
// Entirely invented acceptance reproduction; no household data or identifiers.
const posted = require('./card-posted-period-movement-data');
const previous = require('./card-period-movements-data');
const copy = posted.copy;
function fixture() {
  const x = posted.fixture();
  const seed = copy(x.packet.transactions.find(tx => tx.account === 'travelvisa'));
  x.packet.coverageStart = '2026-08-01';
  x.packet.transactionWindow.startDate = x.packet.coverageStart;
  x.packet.transactions = x.packet.transactions.filter(tx => tx.account !== 'travelvisa');
  const row = (id, date, amount, kindHint) => ({ ...seed, id, coverageRef: 'invented-' + id,
    date, amount, kindHint, savingsPostingEvidence: 'posted', pending: false });
  x.packet.transactions.push(row('old-charge', '2026-08-10', 80),
    row('payment-one', '2026-08-19', -60, 'payment'),
    row('payment-two', '2026-08-20', -40, 'payment'));
  x.packet.transactions.find(tx => tx.id === 'cashback-charge').date = '2026-08-19';
  for (const id of ['travelvisa', 'tdcc'])
    x.overlay.overlays.find(row => row.locator === 'debts:' + id).evidenceDate = '2026-08-01';
  return x;
}
function served() {
  const data = previous.helocServed(), x = fixture();
  const other = data.liveOverlay.currentPeriodActuals.transactions.filter(tx =>
    tx.accountRole !== 'revolving-credit' && tx.accountRole !== 'household-cash');
  data.liveOverlay.currentPeriodActuals = { ...data.liveOverlay.currentPeriodActuals, ...copy(x.packet),
    transactions: [...other, ...copy(x.packet.transactions)] };
  delete data.liveOverlay.cardPeriodBalanceEvidence;
  data.liveOverlay.overlays = copy(x.overlay.overlays);
  return data;
}
module.exports = { fixture, served, copy };
