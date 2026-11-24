'use strict';
// A week with known spending for numeric Stack controls. Use smaller purchases
// and no standalone credits, keeping the same posted movements and balances
// as the card-period fixture (Travel 107.40 and Amazon 44.00).
const { fixture: ledgerWeek, copy } = require('./card-posted-period-movement-data');
function fixture() {
  const week = ledgerWeek();
  week.packet.transactions = week.packet.transactions.filter(tx => tx.id !== 'refund-a' && tx.id !== 'amazon-refund');
  week.packet.transactions.find(tx => tx.id === 'charge-b').amount = 28.75;
  week.packet.transactions.find(tx => tx.id === 'amazon-a').amount = 44;
  return week;
}
module.exports = { fixture, copy };
