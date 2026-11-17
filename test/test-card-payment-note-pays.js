'use strict';
// A "card payment: <card>" note alone names the card (lead dispatch; census
// rank 1). A posted household-cash TD "TFR-TO C/C" debit whose note names
// exactly one card in the fixed name table (#1275/#1277) is a payment to that
// card even when the card's own "PAYMENT - THANK YOU" credit is not (yet) in
// the feed. It covers that card once. If the credit is there, the two pair
// once, as before. A missing, unknown or two-card note behaves as today.
// Invented numbers only; every expected figure is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// Travel Visa minimum due on the as-of 2026-09-20, one 80 card purchase.
//
// Hand-derived for a 105 Bills -> Travel Visa payment: the 25 minimum is
// covered first, then the 80 purchase; reserve 0; Bills observed
// 500 - 105 = 395; available now = 395 - 0 (covered minimum) - 70 (groceries
// left, 150 - 80) - 0 (reserve) = 325. Exactly one payment.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const transfer = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const cashLeg = (amount, extra = {}) => ['bills', amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer, ...extra }];
const cardCredit = (amount, extra = {}) => ['card', -amount, null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer, ...extra }];
const TRAVEL = 'card payment: Travel Visa ...9999';
const CASHBACK = 'card payment: TD Cash Back Visa ...8888';
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const ready = (s, why) => check(s.coverage.status === 'ready', why + ': ' + JSON.stringify(s.coverage.issues));
const withheld = (s, code, why) => {
  check(s.coverage.status === 'unavailable', why + ': withheld');
  check(s.coverage.reservedCash === null, why + ': no reserve claim');
  check(s.period.fromTodayFunding.availableNow === null, why + ': no available-cash claim');
  check(issues(s).includes(code), why + ': ' + code + ' in ' + JSON.stringify(issues(s)));
};
const travelPaidOnce = (s, why) => {
  ready(s, why);
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 1, why + ': exactly one payment (got ' + s.coverage.payments.length + ')');
  const p = s.coverage.payments[0];
  check(p.minimumPayment === 25 && p.backfill === 80 && p.cardPayment === 0, why + ': minimum 25 first, then the 80 purchase');
  check(s.period.householdBudget[0].spent === 80, why + ': the purchase counts once');
  check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 395 - 0 - 70 - 0 = 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
  for (const code of ['coverage-payment-destination-unconfirmed', 'coverage-payment-pair-ambiguous']) {
    check(!issues(s).includes(code), why + ': no ' + code);
  }
};

// 1. The note alone: no PAYMENT - THANK YOU credit in the feed.
travelPaidOnce(run(world([purchase, cashLeg(105, { notes: TRAVEL })])), 'note alone, credit absent');
travelPaidOnce(run(world([cashLeg(105, { notes: TRAVEL }), purchase])), 'note alone, other row order');
// 2. The credit appears later: it pairs with the same debit, once, either order.
travelPaidOnce(run(world([purchase, cashLeg(105, { notes: TRAVEL }), cardCredit(105)])), 'note and credit, debit first');
travelPaidOnce(run(world([purchase, cardCredit(105), cashLeg(105, { notes: TRAVEL })])), 'note and credit, credit first');
// 3. A pending card credit keeps its own existing hold (its purpose is
// unconfirmed until it posts); the noted debit itself no longer adds a
// destination issue. Once the credit posts, case 2 applies.
{
  const s = run(world([purchase, cashLeg(105, { notes: TRAVEL }), cardCredit(105, { is_pending: true })]));
  withheld(s, 'coverage-payment-or-credit-purpose-unconfirmed', 'note with a pending credit: the pending credit still withholds');
  check(!issues(s).includes('coverage-payment-destination-unconfirmed'), 'note with a pending credit: the debit has a destination');
}
// 4. Unchanged without a valid note: missing, unknown name, two cards, no card named.
for (const [name, extra] of [['no note', {}], ['unknown card', { notes: 'card payment: Invented Personal Card ...9999' }],
  ['two cards', { notes: TRAVEL + '; ' + CASHBACK }], ['names no card', { notes: 'Invented memo' }]]) {
  withheld(run(world([purchase, cashLeg(105, extra)])), 'coverage-payment-destination-unconfirmed',
    name + ', credit absent: as today');
}
// 5. A pending debit is never a payment by its note: the result is exactly
// that of the same pending debit with no note.
{
  const noted = run(world([purchase, cashLeg(105, { notes: TRAVEL, is_pending: true })]));
  const plain = run(world([purchase, cashLeg(105, { is_pending: true })]));
  check(noted.coverage.payments.length === 0, 'a pending noted debit pays nothing');
  check(JSON.stringify(noted.coverage.issues) === JSON.stringify(plain.coverage.issues)
    && noted.coverage.reservedCash === plain.coverage.reservedCash
    && noted.period.fromTodayFunding.availableNow === plain.period.fromTodayFunding.availableNow,
  'a pending noted debit reads exactly as the same debit without a note');
}
// 6. Only a TD "TFR-TO C/C" debit: the same note on another payment-like debit names nothing.
withheld(run(world([purchase, ['bills', 105, null, 'cash', { payee: 'Invented card payment', category_name: 'Credit Card Payment',
  notes: TRAVEL }]])), 'coverage-payment-destination-unconfirmed', 'a non-TD debit with the note is unchanged');
// 7. Two TD cards. Purchases 80 on Travel Visa and 40 on Cash Back; debits 105
// noted Travel Visa and 40 noted Cash Back, no credits. Hand-derived: Travel
// Visa covers its 25 minimum and the 80; Cash Back covers its 40. Bills
// 500 - 105 - 40 = 355; groceries left 150 - 80 - 40 = 30; available now
// 355 - 0 - 30 - 0 = 325. Two payments, one per card.
{
  const addCashback = x => {
    x.data.debts.push({ id: 'cashback', label: 'Invented Cash Back', structure: 'Revolving', secured: false,
      balance: 0, pending: 0, rate: 0, limit: 1000, statementCloseDay: 17 });
    x.accountMap.mappings.push({ providerAccountId: '3005', canonical: { collection: 'debts', id: 'cashback' },
      atlasRole: 'revolving-credit' });
    x.payload.accounts.push({ ...x.payload.accounts[3], id: 3005, name: 'Invented Cash Back', balance: 40 });
  };
  const rows = order => {
    const base = [purchase, ['card2', 40, null, 'purchase'], cashLeg(105, { notes: TRAVEL }),
      cashLeg(40, { payee: 'CD456 TFR-TO C/C', original_name: 'CD456 TFR-TO C/C', notes: CASHBACK })];
    return order ? base : base.slice().reverse();
  };
  for (const order of [true, false]) {
    const s = run(world(rows(order), { edit: addCashback }));
    const why = 'two TD cards, ' + (order ? 'purchases first' : 'debits first');
    ready(s, why);
    check(s.coverage.reservedCash === 0, why + ': reserve 0');
    const byCard = account => s.coverage.payments.filter(p => p.account === account || p.cardId === account || p.debtId === account);
    check(s.coverage.payments.length === 2, why + ': two payments (got ' + s.coverage.payments.length + ')');
    const total = s.coverage.payments.reduce((a, p) => a + p.minimumPayment + p.backfill + p.cardPayment, 0);
    check(Math.round(total * 100) === 14500, why + ': 105 + 40 = 145 applied once each (got ' + total + ')');
    check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 355 - 0 - 30 - 0 = 325 (got '
      + s.period.fromTodayFunding.availableNow + ')');
    check(byCard('cashback').length <= 1 && byCard('travelvisa').length <= 1, why + ': at most one payment per card');
  }
  // The Cash Back note on a debit whose credit landed on Travel Visa: the debit
  // pays Cash Back by its note; the Travel Visa credit has no source and withholds.
  withheld(run(world([purchase, cashLeg(105, { notes: CASHBACK }), cardCredit(105)], { edit: addCashback })),
    'coverage-payment-source-unconfirmed', 'note names another card than the credit: the credit stays unsourced');
}

console.log(`  PASS  a "card payment: <card>" note alone names the card (${checks} checks)`);
