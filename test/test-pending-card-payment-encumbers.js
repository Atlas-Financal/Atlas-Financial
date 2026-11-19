'use strict';
/* Lead dispatch (ATLAS LEAD 11, 2026-11-19; #1401 finding i): a PENDING household-chequing card payment has left
 * household cash as surely as any pending debit, so it joins Forecast's pendingCash, and From-today funding
 * withholds until it posts, exactly as for a pending grocery charge. Before, a pending debit classed transfer or
 * card-payment never encumbered, so From-today published money that had already left. "Card payment" here is
 * #1388's unproven class (a generic Transfer / Payment label or kind hint, a card-payment category) or an
 * identified card payment. A pending leg of a household internal movement (the same TD reference pairing as a posted
 * one), a represented bill and anything posted are unchanged.
 *
 * Path: invented raw Lunch Money rows -> scripts/live-plan.js fromObservation -> the served packet ->
 * Forecast.recommend (sumCategoryActuals' pendingCash -> From-today funding).
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js; as of 2026-09-20): Bills 500, groceries 150, an MBNA
 * payDown card with a 25 minimum due on the as-of. A pending row is not yet in the bank balance (the world adds it
 * back). By hand:
 *   - nothing: available now = 500 - 25 - 150 = 325.
 *   - a pending 60 card payment (no identity, or the MBNA payee identity): withheld, "Unresolved pending household-
 *     cash debits of $60.00 still encumber household cash", as a pending 60 grocery charge already is.
 *   - the same 60 posted: no identity 440 - 25 - 150 = 265 (held, #1388); MBNA identity 440 - 150 = 290 (pays the
 *     minimum, #1394). Unchanged.
 *   - a pending 60 Bills -> Weekly transfer whose TD reference pairs with the Weekly leg: an own-account move, not a
 *     card payment, so 325 as before.
 *   - a pending 60 that has since posted (its posted copy links the pending id): counted once, as posted, 265.
 *
 * `node test/test-pending-card-payment-encumbers.js`
 */
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

const policy = { rule: 'aggregate-per-card-per-pay-period', payDownOnly: ['mbna'],
  opening: { asOf: '2026-09-18', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] } };
const P = { is_pending: true, status: 'pending' };
const notInBalance = amount => x => { x.payload.accounts[0].balance += amount; };
function funding(rows, edit) {
  const s = run(world(rows, { card: 'mbna', policy, ...(edit ? { edit } : {}) }));
  const f = s.period.fromTodayFunding;
  return { status: f.status, available: f.availableNow, reason: f.reason || '' };
}
const WITHHELD_60 = 'Unresolved pending household-cash debits of $60.00 still encumber household cash';
const withheld60 = x => x.status === 'unavailable' && x.available == null && x.reason.startsWith(WITHHELD_60);

const plain = extra => ['bills', 60, null, 'cash', { payee: 'Invented card co', category_name: 'Credit Card Payment', ...extra }];
const mbna = extra => ['bills', 60, null, 'cash', { payee: 'MBNA PAYMENT', category_name: 'Credit Card Payment', ...extra }];

console.log('1. A pending card payment encumbers household cash, as any pending debit does');
{
  const none = funding([]);
  ok(none.status === 'ready' && none.available === 325, 'control: nothing pending, available 325', JSON.stringify(none));
  const grocery = funding([['bills', 60, null, 'cash', { payee: 'Invented grocer', category_name: 'Groceries', ...P }]], notInBalance(60));
  ok(withheld60(grocery), 'reference: a pending 60 grocery charge withholds (incumbent)', grocery.reason);
  const pendingPlain = funding([plain(P)], notInBalance(60));
  ok(withheld60(pendingPlain), 'a pending 60 card payment with no identity withholds, never 325', JSON.stringify(pendingPlain));
  const pendingMbna = funding([mbna(P)], notInBalance(60));
  ok(withheld60(pendingMbna), 'a pending 60 MBNA-identified card payment withholds, never 325', JSON.stringify(pendingMbna));
  const pendingTransfer = funding([['bills', 60, null, 'cash', { payee: 'Invented transfer out', category_name: 'Transfer', ...P }]], notInBalance(60));
  ok(withheld60(pendingTransfer), 'a pending 60 generic Transfer debit with nothing proving its other side withholds');
}

console.log('2. Posted card payments are unchanged');
{
  const postedPlain = funding([plain({})]);
  ok(postedPlain.status === 'ready' && postedPlain.available === 265, 'posted, no identity: 265 (held once, #1388)', JSON.stringify(postedPlain));
  const postedMbna = funding([mbna({})]);
  ok(postedMbna.status === 'ready' && postedMbna.available === 290, 'posted, MBNA identity: 290 (pays the minimum, #1394)', JSON.stringify(postedMbna));
}

console.log('3. A pending own-account transfer is not a card payment');
{
  const T = { category_name: 'Transfer' };
  const internal = funding([['bills', 60, null, 'cash', { payee: 'AB123 TFR-TO 0000', original_name: 'AB123 TFR-TO 0000', ...T, ...P }],
    ['weekly', -60, null, 'cash', { payee: 'AB123 TFR-FR 0000', original_name: 'AB123 TFR-FR 0000', ...T, ...P }]],
  x => { x.payload.accounts[0].balance += 60; x.payload.accounts[1].balance -= 60; });
  ok(internal.status === 'ready' && internal.available === 325,
    'a pending Bills -> Weekly transfer whose TD reference pairs: 325, unchanged', JSON.stringify(internal));
}

console.log('3b. The counterpart must be observable by the as-of (Atlas, #1413)');
{
  // The same pending Bills -> Weekly pair, with the Weekly leg dated the day after the as-of. It is in the packet but
  // not yet observable, so it cannot prove the debit is an own-account move: the 60 encumbers, as an unproven Transfer.
  const T = { category_name: 'Transfer' };
  const pair = weeklyDate => [['bills', 60, null, 'cash', { payee: 'AB123 TFR-TO 0000', original_name: 'AB123 TFR-TO 0000', ...T, ...P }],
    ['weekly', -60, weeklyDate, 'cash', { payee: 'AB123 TFR-FR 0000', original_name: 'AB123 TFR-FR 0000', ...T, ...P }]];
  const balances = x => { x.payload.accounts[0].balance += 60; };
  const s = run(world(pair('2026-09-21'), { card: 'mbna', policy, edit: balances }));
  ok(s.packet.transactions.some(t => t.date === '2026-09-21' && t.amount === -60),
    'the next-day counterpart is in the served packet (so the bound is what excludes it)');
  const f = s.period.fromTodayFunding;
  const next = { status: f.status, available: f.availableNow, reason: f.reason || '' };
  ok(withheld60(next), 'a next-day counterpart does not exempt the pending debit: withheld, never 325', JSON.stringify(next));
  const sameDay = funding(pair(null), x => { x.payload.accounts[0].balance += 60; x.payload.accounts[1].balance -= 60; });
  ok(sameDay.status === 'ready' && sameDay.available === 325, 'the same-day genuine pair still exempts it: 325', JSON.stringify(sameDay));
}

console.log('4. A pending payment that has since posted counts once');
{
  const pend = { ...P, plaid_metadata: JSON.stringify({ transaction_id: 'pend-1' }) };
  const post = { plaid_metadata: JSON.stringify({ transaction_id: 'post-1', pending_transaction_id: 'pend-1' }) };
  const replaced = funding([['bills', 60, '2026-09-19', 'cash', { payee: 'Invented card co', category_name: 'Credit Card Payment', ...pend }],
    plain(post)], notInBalance(60));
  ok(replaced.status === 'ready' && replaced.available === 265,
    'the pending copy is replaced by its posted payment: 265 (the posted figure), not withheld and not counted twice', JSON.stringify(replaced));
}

console.log(`\nAll pending card payment checks passed (${checks}).`);
