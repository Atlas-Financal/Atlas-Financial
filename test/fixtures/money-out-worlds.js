'use strict';
// Invented worlds for "Money out, to confirm": the Budget surface household (observed
// 2026-08-20) plus extra legs on its two chequing accounts. A leg is a debit when its amount is
// positive (money out) and a credit when negative. A POSTED leg moves the opening of its account
// by the same amount so the observed closing balance stays as invented; a pending one does not.
const fx = require('./budget-surface-data');
const Live = require('../../scripts/live-plan');

const ACCOUNT = { 1001: 'chequing-a', 1002: 'chequing-b' };
const CATEGORY = { shopping: 14, transfer: 17, payment: 18 };

// Options: `confirmed` makes every estimated input of the household confirmed (so the remainder and
// planned close read calculated until a money-out term makes them estimated); `refile` is a map of
// an existing transaction id to a label, re-filing only that transaction as Transfer or Payment.
function world(legs = [], { confirmed = false, refile = {} } = {}) {
  const data = fx.canonical();
  const payload = fx.payload();
  payload.categories.push({ id: 17, name: 'Transfer', is_income: false, exclude_from_totals: true });
  payload.categories.push({ id: 18, name: 'Payment, Transfer', is_income: false, exclude_from_totals: true });
  if (confirmed) {
    data.plan.income.find(row => row.id === 'partner').confidence = 'confirmed';
    data.plan.bills.find(row => row.id === 'hydro').confidence = 'confirmed';
    data.plan.commitments.forEach(row => { row.confidence = 'confirmed'; });
  }
  for (const [txId, label] of Object.entries(refile)) {
    payload.transactions.find(tx => String(tx.id) === String(txId)).category_id = CATEGORY[label];
  }
  let id = 94000;
  for (const leg of legs) {
    payload.transactions.push({ id: ++id, account_id: leg.account || 1002, date: leg.date || '2026-08-19',
      amount: leg.amount, currency: 'cad', payee: leg.payee || 'Synthetic recipient',
      ...(leg.original ? { original_name: leg.original } : {}),
      ...(leg.kind ? { kind: leg.kind } : {}),
      category_id: CATEGORY[leg.category], is_pending: leg.pending === true, status: leg.pending ? 'pending' : 'cleared' });
    if (leg.pending !== true) {
      data.plan.startingCash.breakdown.find(row => row.id === ACCOUNT[leg.account || 1002]).value += leg.amount;
    }
  }
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity: fx.identity }).data;
}

module.exports = { world };
