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
// 4. Without a valid note (missing, unknown name, two cards, no card named) the
// debit pays no card. Since the lead's 2026-11-18 dispatch (Dale) that degrades
// instead of withholding: the purchase stays reserved, coverage is an estimate,
// and the debit is To confirm (test/test-card-payment-destination-estimate.js).
for (const [name, extra] of [['no note', {}], ['unknown card', { notes: 'card payment: Invented Personal Card ...9999' }],
  ['two cards', { notes: TRAVEL + '; ' + CASHBACK }], ['names no card', { notes: 'Invented memo' }]]) {
  const s = run(world([purchase, cashLeg(105, extra)]));
  check(s.coverage.status === 'ready' && s.coverage.trust === 'estimated', name + ', credit absent: an estimate');
  check(s.coverage.reservedCash === 80 && s.coverage.toConfirm.length === 1, name + ': the purchase stays reserved, one To-confirm row');
  check(s.period.fromTodayFunding.availableNow === 220 && s.period.fromTodayFunding.trust === 'estimated',
    name + ': available now 395 - 25 - 70 - 80 = 220, estimated');
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
{
  // It pays no card, so (lead dispatch 2026-11-18) it degrades exactly as a debit with no note.
  const s = run(world([purchase, ['bills', 105, null, 'cash', { payee: 'Invented card payment', category_name: 'Credit Card Payment',
    notes: TRAVEL }]]));
  check(s.coverage.trust === 'estimated' && s.coverage.reservedCash === 80 && s.coverage.toConfirm.length === 1,
    'a non-TD debit with the note names no card: applied to no card, To confirm');
}
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
    // Each payment names its card by accountLabel (the fixture's Travel Visa
    // account is "Invented card"; the added one is "Invented Cash Back").
    const byCard = label => s.coverage.payments.filter(p => p.accountLabel === label);
    check(s.coverage.payments.length === 2, why + ': two payments (got ' + s.coverage.payments.length + ')');
    const total = s.coverage.payments.reduce((a, p) => a + p.minimumPayment + p.backfill + p.cardPayment, 0);
    check(Math.round(total * 100) === 14500, why + ': 105 + 40 = 145 applied once each (got ' + total + ')');
    check(s.period.fromTodayFunding.availableNow === 325, why + ': available now 355 - 0 - 30 - 0 = 325 (got '
      + s.period.fromTodayFunding.availableNow + ')');
    const [travel] = byCard('Invented card'), [cashback] = byCard('Invented Cash Back');
    check(byCard('Invented card').length === 1 && byCard('Invented Cash Back').length === 1,
      why + ': exactly one payment per card (got ' + JSON.stringify(s.coverage.payments.map(p => p.accountLabel)) + ')');
    check(travel && travel.amount === 105 && travel.minimumPayment === 25 && travel.backfill === 80 && travel.cardPayment === 0,
      why + ': Travel Visa takes the 105: minimum 25 first, then its 80 purchase');
    check(cashback && cashback.amount === 40 && cashback.minimumPayment === 0 && cashback.backfill === 40 && cashback.cardPayment === 0,
      why + ': Cash Back takes the 40: its 40 purchase, no minimum');
  }
  // The Cash Back note on a debit whose credit landed on Travel Visa: the debit
  // pays Cash Back by its note; the Travel Visa credit has no source and withholds.
  withheld(run(world([purchase, cashLeg(105, { notes: CASHBACK }), cardCredit(105)], { edit: addCashback })),
    'coverage-payment-source-unconfirmed', 'note names another card than the credit: the credit stays unsourced');
}
// 8. Opening rollover (#1298 review). A noted debit pays its card on the
// debit's own date, so its credit arriving after the opening rolls cannot
// count it again. Run A (as of 10-01, opening 09-18): 80 purchase and the 25
// minimum on 09-20, a 105 noted debit on 10-01 -> one payment, minimum 25 then
// the 80; available now 395 - 0 - 70 - 0 = 325. Run B (as of 10-03, confirmed
// opening 10-02, nothing carried): the credit lands 10-02 and a new 75 purchase
// follows. The 10-01 debit belongs to run A's period: no payment in run B, the
// 75 stays uncovered (reserve 75). Bills 395; the 09-20 minimum is not
// represented in this invented opening, so it stays To confirm (25);
// groceries left 150 - 75 = 75; available now 395 - 25 - 75 - 75 = 220.
// Counting the debit again would cover the 75 and overstate it by 75.
{
  const debit = ['bills', 105, '2026-10-01', 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
    ...transfer, notes: TRAVEL }];
  const a = run(world([['card', 80, '2026-09-20', 'purchase'], debit], { asOf: '2026-10-01', minimumDate: '2026-09-20' }));
  ready(a, 'rollover run A');
  check(a.coverage.payments.length === 1 && a.coverage.payments[0].minimumPayment === 25
    && a.coverage.payments[0].backfill === 80, 'rollover run A: the noted debit pays minimum 25 then the 80');
  check(a.period.fromTodayFunding.availableNow === 325, 'rollover run A: available now 325 (got '
    + a.period.fromTodayFunding.availableNow + ')');
  const policy = { rule: 'aggregate-per-card-per-pay-period', opening: { asOf: '2026-10-02', confirmed: true,
    currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
  for (const order of [true, false]) {
    const rows = [['card', 80, '2026-09-20', 'purchase'], debit, ['card', -105, '2026-10-02', 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }],
      ['card', 75, '2026-10-02', 'purchase']];
    const b = run(world(order ? rows : rows.slice().reverse(), { asOf: '2026-10-03', minimumDate: '2026-09-20', policy }));
    const why = 'rollover run B, ' + (order ? 'in order' : 'reversed');
    ready(b, why);
    check(b.coverage.payments.length === 0, why + ': the 10-01 debit is not counted again (got '
      + b.coverage.payments.length + ')');
    check(b.coverage.reservedCash === 75, why + ': the new 75 purchase stays uncovered (got ' + b.coverage.reservedCash + ')');
    check(b.period.fromTodayFunding.availableNow === 220, why + ': available now 395 - 25 - 75 - 75 = 220 (got '
      + b.period.fromTodayFunding.availableNow + ')');
  }
}
// 8b. The mirror: the credit posts 10-01, before the opening rolls; the noted
// debit posts 10-02, after. It pays once, in run B's period, by the debit's
// date: the 75 purchase first, 30 to debt; reserve 0; available now
// 395 - 25 (the old minimum, To confirm) - 75 - 0 = 295.
{
  const policy = { rule: 'aggregate-per-card-per-pay-period', opening: { asOf: '2026-10-02', confirmed: true,
    currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
  const b = run(world([['card', -105, '2026-10-01', 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }],
    ['bills', 105, '2026-10-02', 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer, notes: TRAVEL }],
    ['card', 75, '2026-10-02', 'purchase']], { asOf: '2026-10-03', minimumDate: '2026-09-20', policy }));
  ready(b, 'mirror rollover');
  check(b.coverage.payments.length === 1 && b.coverage.payments[0].backfill === 75 && b.coverage.payments[0].cardPayment === 30,
    'mirror rollover: one payment, the 75 purchase then 30 to debt ' + JSON.stringify(b.coverage.payments.map(p => [p.minimumPayment, p.backfill, p.cardPayment])));
  check(b.coverage.reservedCash === 0, 'mirror rollover: reserve 0');
  check(b.period.fromTodayFunding.availableNow === 295, 'mirror rollover: available now 295 (got '
    + b.period.fromTodayFunding.availableNow + ')');
}
// 9. A note naming a card the plan does not map as a revolving card pays
// nothing by its note: TD Personal is in the name table but not this plan.
{
  // It pays no card, so (lead dispatch 2026-11-18) it degrades as a debit with no note.
  const s = run(world([purchase, cashLeg(105, { notes: 'card payment: TD Personal Credit Card ...7777' })]));
  check(s.coverage.trust === 'estimated' && s.coverage.reservedCash === 80 && s.coverage.toConfirm.length === 1,
    'a note naming an unmapped card pays no card: applied to no card, To confirm');
}

console.log(`  PASS  a "card payment: <card>" note alone names the card (${checks} checks)`);
