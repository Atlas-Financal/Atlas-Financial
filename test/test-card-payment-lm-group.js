'use strict';
// Lunch Money's own card-payment link (lead dispatch U5). A posted LM
// transaction group (both rows carry the v2 group_parent_id) that spans two
// accounts and holds exactly one household-cash debit and one card-payment
// credit of equal amount proves where the payment went: the two rows pair with
// each other, whatever their payees or notes. An ungrouped pair behaves as
// today; a group of any other shape withholds; a same-account group (an LM
// split, which shares the parent field) reads as if ungrouped.
// Invented numbers only; every expected figure is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): Bills 500, Travel
// Visa debt 400 with a 25 minimum due on the as-of, groceries allowance 150,
// one 80 card purchase. Hand-derived for a 105 Bills -> Travel Visa payment:
// the 25 minimum first, then the 80 purchase; reserve 0; Bills 395; available
// now = 395 - 0 - 70 (groceries left) - 0 = 325.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const generic = { payee: 'Invented card payment', original_name: 'Invented card payment', category_name: 'Payment, Transfer' };
const group = { group_parent_id: 777001 };
const purchase = ['card', 80, null, 'purchase'];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const paidOnce = (s, why) => {
  check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 1, why + ': exactly one payment (got ' + s.coverage.payments.length + ')');
  const p = s.coverage.payments[0] || {};
  check(p.minimumPayment === 25 && p.backfill === 80 && p.cardPayment === 0, why + ': minimum 25 first, then the 80 purchase');
  check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 395 - 0 - 70 - 0 = 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
};
const withheld = (s, why, code) => {
  check(s.coverage.status === 'unavailable' && s.period.fromTodayFunding.availableNow === null, why + ': withheld');
  if (code) check(issues(s).includes(code), why + ': ' + code + ' in ' + JSON.stringify(issues(s)));
};
const orders = rows => [['in order', rows], ['reversed', rows.slice().reverse()]];

// 1. A grouped generic card payment (no TD identity, no note): the group alone proves it.
const grouped = [purchase, ['bills', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]];
for (const [name, rows] of orders(grouped)) paidOnce(run(world(rows)), 'grouped pair, ' + name);
// 2. The same rows ungrouped behave as today: the generic credit's purpose is unconfirmed.
withheld(run(world([purchase, ['bills', 105, null, 'cash', generic], ['card', -105, null, 'credit', generic]])),
  'ungrouped generic pair (as today)', 'coverage-payment-or-credit-purpose-unconfirmed');
// 3. A grouped TD pair pays once, and an extra ungrouped TD debit of the same amount
// does not join it: it has no destination of its own and withholds.
const tdDebit = ref => ['bills', 105, null, 'cash', { payee: ref + ' TFR-TO C/C', original_name: ref + ' TFR-TO C/C', category_name: 'Transfer' }];
const tdCredit = ['card', -105, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_name: 'Transfer', ...group }];
paidOnce(run(world([purchase, [...tdDebit('AB123').slice(0, 4), { ...tdDebit('AB123')[4], ...group }], tdCredit])), 'grouped TD pair');
{
  const s = run(world([purchase, [...tdDebit('AB123').slice(0, 4), { ...tdDebit('AB123')[4], ...group }], tdCredit, tdDebit('CD456')]));
  withheld(s, 'grouped TD pair + an outside equal TD debit', 'coverage-payment-destination-unconfirmed');
  check(s.coverage.payments.length === 1, 'the grouped pair is still the one payment; the outside debit never joins it');
}
// 4. Any other group shape withholds.
withheld(run(world([purchase, ['bills', 105, null, 'cash', { ...generic, ...group }], ['card', -100, null, 'credit', { ...generic, ...group }]])),
  'grouped, unequal amounts');
withheld(run(world([...grouped, ['bills', 10, null, 'cash', { ...generic, ...group }]])), 'grouped, three members');
withheld(run(world([purchase, ['bills', 105, null, 'cash', { ...generic, ...group }],
  ['card', -105, null, 'credit', { ...generic, ...group, is_pending: true }]])), 'grouped, pending credit');
withheld(run(world([purchase, ['savings', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]],
  { savingsOpening: 1000 })), 'grouped, a Savings (not household-cash) debit', 'coverage-payment-group-unconfirmed');
// 5. A Weekly household-cash debit in a group is a Weekly-funded payment (#1304):
// it covers the card once. Weekly is -105 in this world, so pooled cash is
// 500 - 105 = 395 and available now is 325, as for Bills.
paidOnce(run(world([purchase, ['weekly', 105, null, 'cash', { ...generic, ...group }], ['card', -105, null, 'credit', { ...generic, ...group }]])),
  'grouped Weekly debit');
// 6. A same-account group is an LM split: it reads exactly as the same rows ungrouped.
{
  const split = run(world([purchase, ['bills', 60, null, 'cash', { ...generic, ...group }], ['bills', 45, null, 'cash', { ...generic, ...group }]]));
  const plain = run(world([purchase, ['bills', 60, null, 'cash', generic], ['bills', 45, null, 'cash', generic]]));
  check(split.coverage.status === plain.coverage.status && JSON.stringify(issues(split)) === JSON.stringify(issues(plain))
    && split.period.fromTodayFunding.availableNow === plain.period.fromTodayFunding.availableNow,
  'same-account group (a split) reads as ungrouped (available ' + split.period.fromTodayFunding.availableNow + ')');
}

console.log(`  PASS  a Lunch Money card-payment group proves the payment's destination (${checks} checks)`);
