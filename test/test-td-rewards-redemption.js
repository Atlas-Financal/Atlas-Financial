'use strict';
// Grok Bot ruling (Plan #6, rule 17, 2026-11-17): a POSTED credit on any
// mapped TD card (tdcc, cashback, travelvisa) whose ORIGINAL bank description
// is exactly "REWARDS REDEMPTION" or "TD Points Redemption" (case and
// surrounding spaces ignored, nothing looser) is a known non-payment credit.
// It covers no purchase, pays no minimum, is not income, cash or a refund,
// stays in its "Payment, Transfer" category, and raises no coverage issue. A
// pending one keeps today's behaviour. Any other wording, and a DEBIT with
// either description, still reads To confirm. Only a boolean enters the
// packet. Invented numbers only; every expected figure is written by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): payday anchor
// 2026-09-18, Bills 500, Travel Visa debt 400, groceries allowance 150, a 25
// card minimum due on the as-of 2026-09-20, one 80 card purchase, and the
// ruled 105 TFR-TO C/C -> PAYMENT - THANK YOU pair (#1275).
// Hand-derived with the pair: the 25 minimum is covered first, then the 80
// purchase; reserve 0; Bills observed 500 - 105 = 395; available now
// = 395 - 0 - 70 (groceries left) - 0 = 325. A 30 rewards credit changes
// none of that: it is not a payment, so the minimum and purchase are still
// covered only by the 105, and it is no Bills cash.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const transfer = { category_name: 'Payment, Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const cashLeg = amount => ['bills', amount, null, 'cash',
  { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer' }];
const paymentCredit = amount => ['card', -amount, null, 'credit',
  { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_name: 'Transfer' }];
const rewards = (amount, extra = {}, account = 'card') => [account, -amount, null, 'credit',
  { payee: 'Invented rewards', original_name: 'REWARDS REDEMPTION', ...transfer, ...extra }];
const pair = [purchase, cashLeg(105), paymentCredit(105)];
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const ruled = (s, why) => {
  check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 1, why + ': exactly one payment, the 105 pair');
  check(s.coverage.payments[0].minimumPayment === 25 && s.coverage.payments[0].backfill === 80
    && s.coverage.payments[0].cardPayment === 0, why + ': the 105 covers minimum 25 then the 80 purchase');
  check(s.period.householdBudget[0].spent === 80, why + ': spending is the 80 purchase only (no refund)');
  check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 325 (got '
    + s.period.fromTodayFunding.availableNow + ')');
};
const withheld = (s, code, why) => {
  check(s.coverage.status === 'unavailable', why + ': withheld');
  check(s.period.fromTodayFunding.availableNow === null, why + ': no available-cash claim');
  if (code) check(issues(s).includes(code), why + ': ' + code + ' in ' + JSON.stringify(issues(s)));
};

// 0. Control: the pair alone.
ruled(run(world(pair)), 'pair alone');
// 1. Today's behaviour without the ruling's wording: To confirm.
withheld(run(world([...pair, rewards(30, { original_name: 'Invented credit' })])),
  'coverage-payment-or-credit-purpose-unconfirmed', 'an unruled card credit');
// 2. Both ruled descriptions, case and surrounding spaces ignored.
for (const original of ['REWARDS REDEMPTION', 'TD Points Redemption', '  rewards redemption ', 'TD POINTS REDEMPTION']) {
  const s = run(world([...pair, rewards(30, { original_name: original })]));
  ruled(s, '"' + original + '"');
  const credit = s.packet.transactions.find(t => t.amount === -30);
  check(credit.tdRewardsRedemptionCredit === true, original + ': the observer stamps the flag');
  check(!('original_name' in credit) && !('originalName' in credit), original + ': the description never enters the packet');
  check(credit.tdCardPaymentCredit !== true, original + ': not a payment credit');
}
// 3. Nothing looser.
for (const original of ['REWARDS REDEMPTION REVERSAL', 'REWARD REDEMPTION', 'REWARDS  REDEMPTION', 'TD POINTS',
  'POINTS REDEMPTION', 'PAYMENT - THANK YOU REWARDS REDEMPTION']) {
  withheld(run(world([...pair, rewards(30, { original_name: original })])),
    'coverage-payment-or-credit-purpose-unconfirmed', '"' + original + '" is not a ruled description');
}
// 4. The displayed payee alone is not the bank description.
withheld(run(world([...pair, rewards(30, { payee: 'REWARDS REDEMPTION', original_name: 'Invented credit' })])),
  'coverage-payment-or-credit-purpose-unconfirmed', 'payee wording over another bank description');
// 5. Pending keeps today's behaviour (To confirm).
withheld(run(world([...pair, rewards(30, { is_pending: true })])),
  'coverage-payment-or-credit-purpose-unconfirmed', 'a pending rewards redemption');
// 6. A debit with either description is not covered: To confirm.
for (const original of ['REWARDS REDEMPTION', 'TD Points Redemption']) {
  withheld(run(world([...pair, ['card', 30, null, 'purchase', { payee: 'Invented rewards', original_name: original, ...transfer }]])),
    'coverage-purchase-purpose-unconfirmed', 'a debit described "' + original + '"');
}
// 7. It is never a payment: equal to a TFR-TO C/C debit, it does not pair.
{
  // The debit then pays no card. Since the lead's 2026-11-18 dispatch (Dale)
  // that degrades: an estimate, the debit To confirm, never paired.
  const s = run(world([purchase, cashLeg(105), rewards(105)]));
  check(s.coverage.trust === 'estimated' && s.coverage.toConfirm.length === 1 && s.coverage.payments.length === 0,
    'a 105 rewards credit beside a 105 TFR-TO C/C debit: never a payment; the debit is To confirm');
}
// 8. It pays no minimum: alone, the 25 minimum stays unpaid exactly as with no credit.
{
  const none = run(world([purchase]));
  const withCredit = run(world([purchase, rewards(30)]));
  check(withCredit.coverage.status === none.coverage.status, 'status as with no credit: ' + none.coverage.status);
  check(JSON.stringify(withCredit.coverage.issues) === JSON.stringify(none.coverage.issues), 'issues as with no credit');
  check(withCredit.coverage.payments.length === 0, 'no payment published');
  check(withCredit.coverage.reservedCash === none.coverage.reservedCash, 'reserve as with no credit');
  check(withCredit.period.fromTodayFunding.availableNow === none.period.fromTodayFunding.availableNow,
    'available now as with no credit');
  check(withCredit.period.householdBudget[0].spent === 80, 'no refund against groceries');
}
// 9. Only on a mapped TD card: the same credit on another card is To confirm.
withheld(run(world([...pair, ['card2', 40, null, 'purchase'], rewards(30, {}, 'card2')], { twoCards: true })),
  'coverage-payment-or-credit-purpose-unconfirmed', 'not a mapped TD card (invented mbna)');
// 10. Every mapped TD card: the world's card mapped as tdcc and as cashback.
for (const card of ['tdcc', 'cashback']) {
  const s = run(world([purchase, rewards(30)], { card }));
  check(!issues(s).includes('coverage-payment-or-credit-purpose-unconfirmed'), card + ': no purpose issue '
    + JSON.stringify(issues(s)));
  check(s.packet.transactions.find(t => t.amount === -30).tdRewardsRedemptionCredit === true, card + ': flag stamped');
}

console.log(`  PASS  TD rewards redemption credit is a known non-payment credit per Grok Bot's ruling (${checks} checks)`);
