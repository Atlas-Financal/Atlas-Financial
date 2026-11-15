'use strict';
// Invented worlds for "Money out, to confirm": the Budget surface household (observed
// 2026-08-20) plus extra legs on its two chequing accounts. A leg is a debit when its amount is
// positive (money out) and a credit when negative. A POSTED leg moves the opening of its account
// by the same amount so the observed closing balance stays as invented; a pending one does not.
const fx = require('./budget-surface-data');
const Live = require('../../scripts/live-plan');
const O = require('../../scripts/provider-observe');

const ACCOUNT = { 1001: 'chequing-a', 1002: 'chequing-b' };
const CATEGORY = { shopping: 14, transfer: 17, payment: 18 };

// Options: `confirmed` makes every estimated input of the household confirmed (so the remainder and
// planned close read calculated until a money-out term makes them estimated); `refile` is a map of
// an existing transaction id to a label, re-filing only that transaction as Transfer or Payment.
// `card` adds an invented card purchase (id 94801, on the card, dated Aug 18) and a card-side payment credit
// (id 94802, Aug 19) of the given amount; `card.declare` is a function (refs) -> payment record to declare in the
// card-coverage ledger, where refs = { debit, credit, purchase } are the coverage references of the first leg, the
// credit and the purchase. The leg that pays it is an ordinary Transfer leg in `legs`.
function world(legs = [], { confirmed = false, refile = {}, card = null, minimumOwner = false } = {}) {
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
  // `minimumOwner` gives the travel-visa minimum obligation (chequing-a, due Aug 22) the household's ledger identity rule for its
  // issuer, and the card a statement close, so a debit in the exact category 'Minimum payment - TD Travel Visa' (both exclude
  // flags set) is accepted by the minimum-payment owner (scripts/card-minimum-category.js) as that obligation's payment.
  const identity = minimumOwner ? { ...fx.identity, rules: [...fx.identity.rules,
    { eventId: 'card-minimum', payeePattern: 'Synthetic card issuer', atlasAccountId: 'chequing-a', direction: 'debit' }] } : fx.identity;
  if (minimumOwner) data.debts.find(debt => debt.id === 'travelvisa').statementCloseDay = 15;
  let id = 94000;
  for (const leg of legs) {
    // A leg may carry its own ledger category: { categoryName, excludeBudget, excludeTotals } (the name is the whole label).
    if (leg.categoryName && !payload.categories.some(c => c.name === leg.categoryName)) {
      payload.categories.push({ id: 9100 + payload.categories.length, name: leg.categoryName, is_income: false, is_group: false,
        exclude_from_budget: leg.excludeBudget !== false, exclude_from_totals: leg.excludeTotals !== false });
    }
    payload.transactions.push({ id: ++id, account_id: leg.account || 1002, date: leg.date || '2026-08-19',
      amount: leg.amount, currency: 'cad', payee: leg.payee || 'Synthetic recipient',
      ...(leg.original ? { original_name: leg.original } : {}),
      ...(leg.kind ? { kind: leg.kind } : {}),
      category_id: leg.categoryName ? payload.categories.find(c => c.name === leg.categoryName).id : CATEGORY[leg.category], is_pending: leg.pending === true, status: leg.pending ? 'pending' : 'cleared' });
    if (leg.pending !== true) {
      data.plan.startingCash.breakdown.find(row => row.id === ACCOUNT[leg.account || 1002]).value += leg.amount;
    }
  }
  if (card) {
    payload.transactions.push({ id: 94801, account_id: 2001, date: '2026-08-18', amount: card.amount, currency: 'cad',
      payee: 'Synthetic card purchase', category_id: CATEGORY.shopping, is_pending: false, status: 'cleared' });
    payload.transactions.push({ id: 94802, account_id: 2001, date: '2026-08-19', amount: -card.amount, currency: 'cad',
      payee: 'PAYMENT - THANK YOU', category_id: CATEGORY.payment, is_pending: false, status: 'cleared' });
    if (card.declare) {
      const ref = id => O.cardCoverageReference(O.normalizeLunchMoneyTransaction(payload.transactions.find(tx => tx.id === id)));
      const made = card.declare({ debit: ref(94001), credit: ref(94802), purchase: ref(94801) });
      data.plan.cardPurchaseCoverage.payments = Array.isArray(made) ? made : [made];
    }
  }
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}

module.exports = { world };
