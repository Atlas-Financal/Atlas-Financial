'use strict';
// Equal same-day payments to two cards stop colliding (lead dispatch; census
// rank 1). A TD "PAYMENT - THANK YOU" credit pairs only with a TD "TFR-TO C/C"
// debit whose note names no card or this card. The reverse check (is this
// debit near exactly one card credit?) now uses that same predicate, so a debit
// noted for one card is not also counted as near an equal credit on the other.
// Without notes the two pairs stay genuinely ambiguous and withhold, as today.
// Invented numbers only; every expected figure is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): Bills 500, Travel
// Visa debt 400 with a 25 minimum due on the as-of, groceries allowance 150,
// plus an invented TD Cash Back card (no minimum).
// Purchases: 55 on Travel Visa, 80 on Cash Back. Payments: 80 to each card,
// same day. Hand-derived: Travel Visa covers its 25 minimum then the 55;
// Cash Back covers its 80. Bills 500 - 80 - 80 = 340; groceries left
// 150 - 55 - 80 = 15; available now 340 - 0 - 15 - 0 = 325. Two payments.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const transfer = { category_name: 'Transfer' };
const TRAVEL = 'card payment: Travel Visa ...9999';
const CASHBACK = 'card payment: TD Cash Back Visa ...8888';
const debit = (ref, extra = {}) => ['bills', 80, null, 'cash',
  { payee: ref + ' TFR-TO C/C', original_name: ref + ' TFR-TO C/C', ...transfer, ...extra }];
const credit = account => [account, -80, null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }];
const purchases = [['card', 55, null, 'purchase'], ['card2', 80, null, 'purchase']];
const addCashback = x => {
  x.data.debts.push({ id: 'cashback', label: 'Invented Cash Back', structure: 'Revolving', secured: false,
    balance: 0, pending: 0, rate: 0, limit: 1000, statementCloseDay: 17 });
  x.accountMap.mappings.push({ providerAccountId: '3005', canonical: { collection: 'debts', id: 'cashback' },
    atlasRole: 'revolving-credit' });
  x.payload.accounts.push({ ...x.payload.accounts[3], id: 3005, name: 'Invented Cash Back', balance: 80 });
};
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const go = rows => run(world(rows, { edit: addCashback }));
const orders = rows => [['in order', rows], ['reversed', rows.slice().reverse()]];

// 1. Two settled noted pairs, equal and same-day: each debit pairs with its
// own card's credit. Both row orders, and credits listed before the debits.
const noted = [...purchases, debit('AB123', { notes: TRAVEL }), debit('CD456', { notes: CASHBACK }),
  credit('card'), credit('card2')];
const creditsFirst = [...purchases, credit('card2'), credit('card'),
  debit('CD456', { notes: CASHBACK }), debit('AB123', { notes: TRAVEL })];
for (const [name, rows] of [...orders(noted), ['credits first', creditsFirst]]) {
  const s = go(rows);
  const why = 'two noted pairs, ' + name;
  check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
  check(!issues(s).includes('coverage-payment-pair-ambiguous'), why + ': no pair-ambiguous');
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 2, why + ': two payments (got ' + s.coverage.payments.length + ')');
  const total = s.coverage.payments.reduce((a, p) => a + p.minimumPayment + p.backfill + p.cardPayment, 0);
  check(Math.round(total * 100) === 16000, why + ': 80 + 80 = 160 applied once each (got ' + total + ')');
  const travel = s.coverage.payments.find(p => p.minimumPayment === 25);
  check(travel && travel.backfill === 55, why + ': Travel Visa: minimum 25, then the 55 purchase');
  check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 340 - 0 - 15 - 0 = 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
}
// 2. The genuinely ambiguous control: the same rows without notes. Nothing
// says which debit paid which card, so the plan withholds, as today.
// 3. One debit noted, one not: the un-noted debit could still be either
// card's, so it stays ambiguous, as today.
for (const [label, a, b] of [['no notes', {}, {}], ['one note only', { notes: TRAVEL }, {}]]) {
  const rows = [...purchases, debit('AB123', a), debit('CD456', b), credit('card'), credit('card2')];
  for (const [name, r] of orders(rows)) {
    const s = go(r);
    const why = label + ', ' + name;
    check(s.coverage.status === 'unavailable', why + ': withheld');
    check(s.coverage.reservedCash === null, why + ': no reserve claim');
    check(s.period.fromTodayFunding.availableNow === null, why + ': no available-cash claim');
    check(issues(s).includes('coverage-payment-pair-ambiguous'), why + ': pair-ambiguous in ' + JSON.stringify(issues(s)));
  }
}

console.log(`  PASS  equal same-day payments to two cards pair by their notes (${checks} checks)`);
