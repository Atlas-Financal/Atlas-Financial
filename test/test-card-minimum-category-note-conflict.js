'use strict';
/* A household debit filed in "Minimum payment - <card X>" whose "card payment:" note names a different definite card
 * Y (lead ruling, ATLAS LEAD 11, 2026-11-19, found by LEDGER A on #1407). Neither the category nor the note wins
 * silently: the debit counts toward neither card's minimum, X's minimum stays to confirm, and the debit is held To
 * confirm once (one listing, no double count with #1388 / #1401 / #1407). The shared reading is #1407's
 * cardPaymentDestinationConflict, with destination = the payee identity's card ?? the posted minimum category's card.
 * Pending rows stay label-only (#1402): a conflicted pending debit gets no Payment pending label.
 *
 * Path: invented raw Lunch Money rows (category and note) -> scripts/live-plan.js fromObservation (the card-minimum
 * category observer, the served packet) -> Forecast.recommend (bill rows, the held list, the card drawer, From-today
 * funding, Balance After Deductions).
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): payday anchor 2026-09-18, as of 2026-09-20, Bills
 * 500, groceries 150, the travel card's 25 minimum due on the as-of, income 1000. A 25 Bills debit "TFR-TO C/C" filed
 * in "Minimum payment - TD Travel Visa". By hand:
 *   - Control (no note) and same card (note Travel Visa): the minimum is paid (PAID, 0 left); nothing held;
 *     available = 500 - 25 - 150 = 325; Balance After Deductions = 1000 - 25 - 150 = 825.
 *   - Conflict (note TD Cash Back Visa): no payment record; the travel minimum stays still due (25); the debit is held
 *     once, reason 'card-payment-destination-conflict', and the drawer does not ask again;
 *     available = 500 - 25 debit - 25 minimum - 150 = 300; Balance After Deductions = 1000 - 25 - 150 - 25 held = 800.
 *   - Card Y's own minimum (a second card, 40 due on the as-of, note naming it): stays still due (40), never paid by
 *     this debit.
 *   - From Savings: the observer never reads a Savings-funded debit as a minimum payment (Bills untouched), so the
 *     travel minimum stays due and available is 325 either way; the conflicted one is not held (Savings) and the
 *     drawer asks once, naming the conflict.
 *   - An owner record of the debit for the travel occurrence: the owner decides, as before (owned, not held).
 *   - Pending: control pending lists Payment pending; conflicted pending lists nothing.
 *
 * `node test/test-card-minimum-category-note-conflict.js`
 */
const assert = require('node:assert/strict');
const crypto = require('crypto');
const F = require('../public/forecast');
const Category = require('../scripts/card-minimum-category');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CATEGORY = 'Minimum payment - TD Travel Visa';
function serve({ notes = null, account = 'bills', pending = false, opts = {}, edit } = {}) {
  const rows = [[account, 25, null, 'cash', { id: 91001, payee: 'TFR-TO C/C', original_name: 'AB123 TFR-TO C/C',
    category_id: 9001, category_name: CATEGORY, is_pending: pending, ...(notes ? { notes } : {}) }]];
  const x = world(rows, { savingsOpening: 500, ...opts, edit: x => {
    x.payload.categories = [{ id: 9001, name: CATEGORY, is_income: false, is_group: false,
      exclude_from_totals: true, exclude_from_budget: true }];
    if (edit) edit(x);
  } });
  const s = run(x);
  const evidence = s.observed.data.plan.cardMinimumCategoryEvidence || {};
  const period = s.advice.defaultView.calendarPeriods[0];
  const held = period.heldOutflowsToConfirm;
  const bill = id => (s.advice.defaultView.bills || []).filter(b => b.id === id).map(b => [b.status, b.remaining]);
  return { s, evidence, payments: (evidence.payments || []).length, pendingPayments: evidence.pendingPayments || null,
    travel: bill('travel'), second: bill('second-minimum'),
    held: held && Array.isArray(held.recon) ? held.recon.map(r => [r.amount, r.reason || r.includeReason || null]) : [],
    asked: ((period.cardPurchaseCoverage || {}).toConfirm || []).map(r => [r.amount, r.diagnostic || null]),
    available: s.period.fromTodayFunding.availableNow, afterDeductions: s.advice.defaultView.predictedEndingBalance,
    debit: s.packet.transactions.find(t => t.amount === 25) };
}

console.log('posted, from Bills');
const control = serve();
ok(control.payments === 1 && same(control.travel, [['PAID', 0]]) && control.held.length === 0,
  'control (category X, no note): pays the travel minimum; nothing held', JSON.stringify([control.travel, control.held]));
ok(control.available === 325 && control.afterDeductions === 825, 'control: available 325, Balance After Deductions 825',
  JSON.stringify([control.available, control.afterDeductions]));
const sameCard = serve({ notes: 'card payment: Travel Visa' });
ok(sameCard.payments === 1 && same(sameCard.travel, [['PAID', 0]]) && sameCard.held.length === 0
  && sameCard.available === 325 && sameCard.afterDeductions === 825, 'same card (X, note X): as control; 325 / 825');
const conflict = serve({ notes: 'card payment: TD Cash Back Visa' });
ok(conflict.debit.minimumCategoryDebt === 'travelvisa' && conflict.debit.cardPaymentNoteDestination === 'cashback'
  && !Object.hasOwn(conflict.debit, 'notes'), 'the packet carries both cards (category travel, note cash back), never the note text');
ok(conflict.payments === 0 && same(conflict.evidence.disagreements, []) && same(conflict.travel, [['still due', 25]]),
  'conflict (X, note Y): no payment record; the travel minimum stays still due (25)', JSON.stringify(conflict.travel));
ok(F.cardMinimumState(conflict.s.observed.data.plan, '2026-09-20').status === 'incumbent',
  'conflict: no card-minimum issue is raised (nothing withheld globally)');
ok(same(conflict.held, [[25, 'card-payment-destination-conflict']]) && conflict.asked.length === 0,
  'conflict: held To confirm once, with the conflict named; the drawer does not ask again', JSON.stringify([conflict.held, conflict.asked]));
ok(conflict.available === 300 && conflict.afterDeductions === 800,
  'conflict: counted once as money out: available 300, Balance After Deductions 800 (the cautious side of 325 / 825)',
  JSON.stringify([conflict.available, conflict.afterDeductions]));

console.log('card Y\'s own minimum is not paid either');
{
  const second = x => x.data.plan.obligations.push({ id: 'second-minimum', label: 'Invented second minimum', debtId: 'mbna',
    effect: 'payment', frequency: 'once', date: x.asOf, amount: 40, payingAccount: 'chequing-a', confidence: 'confirmed' });
  const opts = { twoCards: true };
  const base = serve({ opts, edit: second });
  const toY = serve({ notes: 'card payment: MBNA', opts, edit: second });
  ok(same(base.second, [['still due', 40]]) && same(toY.second, [['still due', 40]]),
    'the second card\'s 40 minimum stays still due with or without a note naming it', JSON.stringify([base.second, toY.second]));
  ok(toY.payments === 0 && same(toY.travel, [['still due', 25]]) && same(toY.held, [[25, 'card-payment-destination-conflict']]),
    'noted for the second card: pays neither minimum; held once', JSON.stringify([toY.travel, toY.held]));
  ok(toY.afterDeductions === base.afterDeductions - 25 && toY.available === base.available - 25,
    'noted for the second card: exactly one 25 more out than the control (the held debit), no double count',
    JSON.stringify([base.available, toY.available, base.afterDeductions, toY.afterDeductions]));
}

console.log('from Savings');
{
  const savingsControl = serve({ account: 'savings' });
  const savingsConflict = serve({ account: 'savings', notes: 'card payment: TD Cash Back Visa' });
  ok(savingsControl.payments === 0 && savingsConflict.payments === 0
    && same(savingsControl.travel, [['still due', 25]]) && same(savingsConflict.travel, [['still due', 25]]),
  'a Savings-funded debit is never a minimum payment: the travel minimum stays due either way');
  ok(savingsConflict.held.length === 0 && same(savingsConflict.asked, [[25, 'card-payment-destination-conflict']]),
    'Savings conflict: not held (Savings); the drawer asks once, naming the conflict', JSON.stringify([savingsConflict.held, savingsConflict.asked]));
  ok(savingsConflict.available === 325 && savingsControl.available === 325
    && savingsConflict.afterDeductions === savingsControl.afterDeductions,
  'Savings: Bills untouched, available 325 in both; Balance After Deductions equal (no double count)',
  JSON.stringify([savingsControl.available, savingsConflict.available, savingsControl.afterDeductions, savingsConflict.afterDeductions]));
}

console.log('an owner record of the debit still decides it');
{
  const debitId = crypto.createHash('sha256').update(Category.SOURCE + ':91001').digest('hex');
  const owner = x => { x.data.plan.obligations[0].sentPayments = [{ scheduledDate: x.asOf, confirmed: true, intent: 'minimum',
    debitId, postedOn: x.asOf, amount: 25, currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: x.asOf }];
    x.data.plan.opening.representedEvents = [{ id: 'travel', date: x.asOf, effectiveAsOf: x.asOf }]; };
  const ownerOnly = serve({ edit: owner });
  const ownerConflict = serve({ notes: 'card payment: TD Cash Back Visa', edit: owner });
  ok(ownerConflict.debit.cardMinimumOwned === true && ownerConflict.held.length === 0
    && same(ownerConflict.travel, ownerOnly.travel) && ownerConflict.available === ownerOnly.available
    && ownerConflict.afterDeductions === ownerOnly.afterDeductions,
  'owner-recorded for the travel occurrence: owned, not held; every figure equals the owner record without a note',
  JSON.stringify([ownerConflict.travel, ownerOnly.travel, ownerConflict.available, ownerOnly.available]));
}

console.log('pending stays label-only');
{
  const pendingControl = serve({ pending: true });
  const pendingConflict = serve({ pending: true, notes: 'card payment: TD Cash Back Visa' });
  ok(same(pendingControl.pendingPayments, [{ id: 'travel', scheduledDate: '2026-09-20', pendingOn: '2026-09-20' }]),
    'pending control: listed Payment pending', JSON.stringify(pendingControl.pendingPayments));
  ok(pendingConflict.pendingPayments === null && pendingConflict.payments === 0
    && same(pendingConflict.travel, pendingControl.travel.map(([s, r]) => [s === 'pending' ? 'still due' : s, r]))
    && pendingConflict.travel[0][1] === 25,
  'pending conflict: no Payment pending label, no payment; still 25 owed', JSON.stringify([pendingConflict.travel, pendingControl.travel]));
}

console.log(`\nAll card minimum category / note conflict checks passed (${checks}).`);
