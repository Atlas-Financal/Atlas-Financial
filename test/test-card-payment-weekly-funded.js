'use strict';
// A card paid from the Weekly account no longer blanks the plan (lead dispatch
// U3; census 11). The payment comes off Weekly once and covers the card once;
// Bills gets no fictitious debit; the non-household share of a Weekly payment
// comes off the Bills-to-Weekly money already counted against the household
// hold, so it is not released twice (Codex P1, #849). An unpaired Weekly debit
// and a payment reversal back to Weekly still withhold.
// Invented numbers only; every expected figure is written from the rule by hand.
//
// World (test/fixtures/card-coverage-aggregate-world.js): Bills 500, Travel
// Visa debt 400 with a 25 minimum due on the as-of, groceries allowance 150,
// one 80 card purchase. Weekly is given an invented 300 opening here.
// Available now reads Bills + Weekly; the Bills period end reads Bills only:
//   Bills end = Bills cash - remaining bills - remaining household hold,
//   remaining household hold = max(0, 150 - funded, uncovered card purchases),
//   funded = Bills-to-Weekly transfers (less Weekly card payments' non-
//   household share) + Bills card payments' household share.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const T = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const pay = (account, amount) => [[account, amount, null, 'cash'], ['card', -amount, null, 'credit']];
const xfer = amount => [['bills', amount, null, 'cash', { payee: 'AB123 TFR-TO 0000', original_name: 'AB123 TFR-TO 0000', ...T }],
  ['weekly', -amount, null, 'cash', { payee: 'AB123 TFR-FR 0000', original_name: 'AB123 TFR-FR 0000', ...T }]];
const weeklyOpening = x => { x.payload.accounts[1].balance += 300; };
const go = rows => run(world(rows, { edit: weeklyOpening }));
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };
const issues = s => (s.coverage.issues || []).map(i => i.code);
const figures = (s, avail, billsEnd, why) => {
  check(s.coverage.status === 'ready', why + ': ready ' + JSON.stringify(s.coverage.issues));
  check(s.coverage.reservedCash === 0, why + ': reserve 0');
  check(s.coverage.payments.length === 1, why + ': one payment (got ' + s.coverage.payments.length + ')');
  const p = s.coverage.payments[0];
  check(p.minimumPayment === 25 && p.backfill === 80 && p.cardPayment === 0, why + ': minimum 25 first, then the 80 purchase');
  check(s.period.fromTodayFunding.availableNow === avail, why + ': available now ' + avail + ' (got '
    + s.period.fromTodayFunding.availableNow + ')');
  const b = s.period.billsAccountPeriodBalance;
  check(b.status === 'ready' && b.amount === billsEnd, why + ': Bills period end ' + billsEnd + ' (got ' + b.amount + ')');
  check(b.remainingBills === 0, why + ': the covered minimum is no longer a Bills requirement');
  return b;
};
const orders = rows => [['in order', rows], ['reversed', rows.slice().reverse()]];

// 1. Weekly-funded pair, no transfer this period. Weekly pays 105: the 25
// minimum, then the 80 purchase. Bills stays 500 (no fictitious debit).
// Available now: Bills 500 + Weekly 195 - 0 - 70 groceries left - 0 = 625.
// Bills end: 500 - 0 - max(0, 150 - 0, 0) = 350.
for (const [name, rows] of orders([purchase, ...pay('weekly', 105)])) {
  const b = figures(go(rows), 625, 350, 'Weekly-funded, ' + name);
  check(b.observedCash === 500, 'Weekly-funded, ' + name + ': Bills cash 500, untouched by the Weekly payment');
  check(!issues(go(rows)).includes('coverage-weekly-funded-payment-unmodeled'), 'Weekly-funded, ' + name + ': no Weekly hold');
}
// 2. Bills-funded control, the same payment from Bills.
// Available now: Bills 395 + Weekly 300 - 0 - 70 - 0 = 625 (the same household money).
// Bills end: 395 - 0 - max(0, 150 - 80, 0) = 325.
for (const [name, rows] of orders([purchase, ...pay('bills', 105)])) {
  const b = figures(go(rows), 625, 325, 'Bills-funded control, ' + name);
  check(b.observedCash === 395, 'Bills-funded control, ' + name + ': Bills cash 395');
}
// 3. Bills sends 150 to Weekly, then Weekly pays the card 105. Its non-
// household share is 105 - 80 = 25 (the minimum), so funded = 150 - 25 = 125.
// Available now: Bills 350 + Weekly 345 - 0 - 70 - 0 = 625.
// Bills end: 350 - 0 - max(0, 150 - 125, 0) = 325. Without the reconciliation
// it would read 350: the 25 released once as household funding and again as
// the paid minimum.
for (const [name, rows] of orders([purchase, ...xfer(150), ...pay('weekly', 105)])) {
  figures(go(rows), 625, 325, 'transfer then Weekly payment, ' + name);
}
// 4. An unpaired Weekly debit (no card credit) still holds, as today.
for (const [name, rows] of orders([purchase, ['weekly', 105, null, 'cash']])) {
  const s = go(rows);
  check(s.coverage.status === 'unavailable' && s.period.fromTodayFunding.availableNow === null,
    'unpaired Weekly debit, ' + name + ': withheld');
  check(issues(s).includes('coverage-payment-destination-unconfirmed'),
    'unpaired Weekly debit, ' + name + ': ' + JSON.stringify(issues(s)));
}
// 5. A payment reversal back to Weekly has no funding reconciliation and still
// withholds; the same reversal back to Bills is a control (the 80 purchase is
// uncovered again: reserve 80).
{
  const rows = to => [purchase, ['bills', 105, '2026-09-19', 'cash'], ['card', -105, '2026-09-19', 'credit'],
    [to, -105, null, 'cash'], ['card', 105, null, 'credit']];
  const weekly = go(rows('weekly'));
  check(weekly.coverage.status === 'unavailable' && issues(weekly).includes('coverage-weekly-funded-payment-unmodeled'),
    'a reversal back to Weekly still withholds: ' + JSON.stringify(issues(weekly)));
  const bills = go(rows('bills'));
  check(bills.coverage.status === 'ready' && bills.coverage.reservedCash === 80, 'a reversal back to Bills uncovers the 80 purchase');
}

console.log(`  PASS  a card paid from Weekly covers the card once and no longer blanks the plan (${checks} checks)`);
