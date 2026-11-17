'use strict';
// Grok Bot ruling (Plan #6, rule 17, 2026-11-17): a POSTED credit on a mapped
// TD card whose ORIGINAL bank description is exactly "PAYMENT - THANK YOU"
// (case and surrounding spaces ignored) is a payment onto that card. It pairs
// only with a TD "TFR-TO C/C" debit of the exact amount within the existing
// +/-3 day window. Anything that does not pair stays unconfirmed and is never
// inferred from the amount alone. Invented numbers only; every expected figure
// is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// card minimum due on the as-of 2026-09-20, one 80 card purchase.
// Both legs are filed "Transfer" (as the live ledger files them), so neither
// leg is a payment by category.
//
// Hand-derived for a 105 Bills -> card pair: the 25 minimum is covered first,
// then the 80 purchase; reserve 0; Bills observed 500 - 105 = 395; available
// now = 395 - 0 (covered minimum, not deducted again) - 70 (groceries left)
// - 0 (reserve) = 325. Exactly one payment is published.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const transfer = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const cashLeg = (amount, date, extra = {}) => ['bills', amount, date || null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer, ...extra }];
const cardCredit = (amount, date, extra = {}) => ['card', -amount, date || null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer, ...extra }];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const ready = (s, why) => check(s.coverage.status === 'ready', why + ': ' + JSON.stringify(s.coverage.issues));
const withheld = (s, code, why) => {
  check(s.coverage.status === 'unavailable', why + ': withheld');
  check(s.coverage.reservedCash === null, why + ': no reserve claim');
  check(s.period.fromTodayFunding.availableNow === null, why + ': no available-cash claim');
  if (code) check(issues(s).includes(code), why + ': ' + code + ' in ' + JSON.stringify(issues(s)));
};

// 1. The ruled pair: TFR-TO C/C debit + posted PAYMENT - THANK YOU credit.
{
  const s = run(world([purchase, cashLeg(105), cardCredit(105)]));
  const credit = s.packet.transactions.find(t => t.amount === -105);
  check(credit && credit.tdCardPaymentCredit === true, 'the observer stamps the card credit');
  check(!('original_name' in credit) && !('originalName' in credit), 'the bank description itself never enters the packet');
  ready(s, 'ruled pair');
  check(s.coverage.reservedCash === 0, 'reserve 0');
  check(s.coverage.payments.length === 1, 'exactly one payment: counted once');
  check(s.coverage.payments[0].minimumPayment === 25 && s.coverage.payments[0].backfill === 80
    && s.coverage.payments[0].cardPayment === 0, 'minimum 25 first, then the 80 purchase');
  check(s.period.householdBudget[0].spent === 80, 'the purchase counts once in its category');
  check(s.period.fromTodayFunding.availableNow === 325, 'available now 395 - 0 - 70 - 0 = 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
}
// 2. Case and surrounding spaces are ignored; nothing else is.
ready(run(world([purchase, cashLeg(105), cardCredit(105, null, { original_name: '  payment - thank you ' })])),
  'case and surrounding spaces ignored');
for (const original of ['PAYMENT THANK YOU', 'PAYMENT - THANK YOU REFUND', 'PAYMENT -  THANK YOU', 'Invented credit']) {
  withheld(run(world([purchase, cashLeg(105), cardCredit(105, null, { original_name: original })])),
    'coverage-payment-destination-unconfirmed', 'original "' + original + '" is not the ruled description');
}
// 3. The displayed payee alone is not the bank description.
withheld(run(world([purchase, cashLeg(105), cardCredit(105, null, { original_name: 'INVENTED CREDIT' })])),
  'coverage-payment-or-credit-purpose-unconfirmed', 'payee "PAYMENT - THANK YOU" over another bank description');
// 4. Pending does not count: the posted cash leg has no card leg.
withheld(run(world([purchase, cashLeg(105), cardCredit(105, null, { is_pending: true })])),
  'coverage-payment-destination-unconfirmed', 'a pending PAYMENT - THANK YOU credit is not a payment');
// 5. Never inferred from the amount alone: a cent apart, or outside +/-3 days.
withheld(run(world([purchase, cashLeg(105), cardCredit(104.99)])),
  'coverage-payment-destination-unconfirmed', 'unequal cents never pair');
withheld(run(world([['card', 80, '2026-09-20', 'purchase'], cashLeg(105, '2026-09-20'), cardCredit(105, '2026-09-24')],
  { asOf: '2026-09-25' })), 'coverage-payment-destination-unconfirmed', 'four days apart never pair');
ready(run(world([['card', 80, '2026-09-20', 'purchase'], cashLeg(105, '2026-09-20'), cardCredit(105, '2026-09-23')],
  { asOf: '2026-09-25' })), 'control: three days apart pairs');
// 6. It pairs only with a TD "TFR-TO C/C" debit, not with any other payment-like debit.
withheld(run(world([purchase, ['bills', 105, null, 'cash', { payee: 'Invented card payment', category_name: 'Credit Card Payment' }],
  cardCredit(105)])), 'coverage-payment-source-unconfirmed', 'a non-TD cash leg does not pair with it');
// 7. Only on a mapped TD card: the same credit on another card is no payment.
withheld(run(world([['card', 80, null, 'purchase'], ['card2', 40, null, 'purchase'], cashLeg(40),
  ['card2', -40, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }]],
  { twoCards: true })), 'coverage-payment-destination-unconfirmed', 'not a mapped TD card (invented mbna)');
// 8. Two TD cards, one amount: ambiguous, never guessed.
withheld(run(world([purchase, cashLeg(105), cardCredit(105), cashLeg(105, null, { payee: 'CD456 TFR-TO C/C', original_name: 'CD456 TFR-TO C/C' })])),
  'coverage-payment-pair-ambiguous', 'two candidate TFR-TO C/C debits for one credit');
// 9. Codex P1 on #1275 / Grok Bot: an existing "card payment: <card>" note on
// the debit wins. Fixed name table: "TD Cash Back Visa" -> cashback, "Travel
// Visa" -> travelvisa (the world's card is travelvisa); any other name is
// unknown and pairs with nothing. Only the result enters the packet.
{
  const noted = note => run(world([purchase, cashLeg(105, null, { notes: note }), cardCredit(105)]));
  const same = noted('card payment: Travel Visa ...9999');
  ready(same, 'note names the credit\'s own card: pairs');
  const debit = same.packet.transactions.find(t => t.amount === 105);
  check(debit.cardPaymentNoteDestination === 'travelvisa', 'the observer stamps the named card');
  check(!JSON.stringify(same.packet).includes('card payment:'), 'the note text never enters the packet');
  ready(noted('  CARD PAYMENT: travel visa  '), 'note name is case-insensitive');
  withheld(noted('card payment: TD Cash Back Visa ...9999'), 'coverage-payment-destination-unconfirmed',
    'note names another card: the amount match does not override it');
  withheld(noted('card payment: Invented Personal Card ...9999'), 'coverage-payment-destination-unconfirmed',
    'note names a card outside the table: unknown, never guessed');
  withheld(noted('card payment: Travel Visa; card payment: TD Cash Back Visa'), 'coverage-payment-destination-unconfirmed',
    'two different named cards: unknown');
  ready(noted('Invented memo'), 'a note that names no card leaves the pairing as without one');
  // The name table is an own-key lookup: built-in object keys are not card names.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const s = noted('card payment: ' + name);
    check(s.packet.transactions.find(t => t.amount === 105).cardPaymentNoteDestination === 'unknown', name + ' stamps unknown');
    withheld(s, 'coverage-payment-destination-unconfirmed', 'note naming "' + name + '" never pairs');
  }
}
// 10. Control: the recorded convention (both legs "Credit Card Payment") is unchanged.
ready(run(world([purchase, ['bills', 105, null, 'cash'], ['card', -105, null, 'credit']])), 'recorded category convention still pairs');

console.log(`  PASS  TD "PAYMENT - THANK YOU" card credit pairs per Grok Bot's ruling (${checks} checks)`);
