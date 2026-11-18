'use strict';
// A "card payment: <card>" note is the sent side of a TD card's minimum, and
// the card's own posted PAYMENT - THANK YOU credit, paired with that debit by
// card coverage, is the issuer's receipt (lead dispatch U4, option A; census 7).
// Without that credit the minimum stays To confirm, as today: never "sent,
// issuer unknown", which would withhold the plan. Triangle and MBNA have no
// card feed, so a note never confirms them. An exact minimum category keeps
// Dale's 2026-10-07 rule unchanged. Invented numbers only; every expected
// figure is written from the rule by hand.
//
// World (fixtures/card-backfill-data, Travel Visa): Bills 1000, card debt 800,
// a confirmed 43.19 minimum (scheduled 2035-10-07, due 10-08), as of 10-06.
// One 49.37 TD "TFR-TO C/C" debit on 10-05. No purchases, no other needs, so
// available now = Bills after the payment = 1000 - 49.37 = 950.63 whenever the
// payment covers the minimum, and the figures never depend on the note: the
// note changes only whether the minimum reads paid.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Category = require('../scripts/card-minimum-category');
const source = require('./fixtures/card-backfill-data');

const NOW = '2035-10-06', ORIGINAL = '2035-10-07', DUE = '2035-10-08';
const TRAVEL = 'card payment: Travel Visa ...9999';
let checks = 0;
const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

function world({ card = 'travelvisa', id = 'travel', note = null, credit = false, category = false, amount = 49.37,
  payee = 'AB123 TFR-TO C/C', edit } = {}) {
  const x = source(card, id);
  x.data.meta.asOf = x.data.plan.opening.asOf = '2035-10-01';
  x.data.plan.opening.representedEvents = [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id, debtId: card, effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: ORIGINAL, payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 43.19, currency: 'cad', confidence: 'confirmed' }] }];
  x.data.plan.cardPurchaseCoverage = { rule: 'aggregate-per-card-per-pay-period',
    opening: { asOf: '2035-10-01', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] },
    ...(['triangle', 'mbna'].includes(card) ? { payDownOnly: [card] } : {}) };
  x.data.plan.startingCash.breakdown[0].value = 1000; x.data.debts[0].balance = 800;
  x.payload.accounts[0].balance = 1000 - amount; x.payload.accounts[3].balance = credit ? 800 - amount : 800;
  x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
  x.payload.fetchedAt = NOW + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2035-10-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
  const name = category ? Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === card) : 'Transfer';
  x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false,
    exclude_from_totals: category, exclude_from_budget: category }];
  x.payload.transactions = [{ id: 98001, account_id: 3001, date: '2035-10-05', amount, currency: 'cad', payee,
    original_name: payee, category_id: 9001, notes: note, is_pending: false, status: 'reviewed' }];
  if (credit) x.payload.transactions.push({ id: 98002, account_id: 3004, date: '2035-10-05', amount: -amount,
    currency: 'cad', payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', category_id: 9001,
    is_pending: false, status: 'reviewed' });
  x.asOf = NOW;
  if (edit) edit(x);
  return x;
}
function run(x) {
  const evidence = O.observe({ ...x, provider: 'lunchmoney' }).cardMinimumCategoryEvidence;
  const live = Live.fromObservation(x);
  const packet = live.report.currentPeriodActuals;
  const advice = F.recommend(live.data.plan, NOW, { debts: live.data.debts, currentPeriodActuals: packet });
  const state = F.cardMinimumState(live.data.plan, NOW);
  const period = advice.payPeriodViews.find(v => v.role === 'active');
  const row = advice.defaultView.bills.find(b => b.id === x.eventId && b.date === DUE) || null;
  return { evidence, live, state, period, row, available: period?.fromTodayFunding?.availableNow };
}
const toConfirm = (s, why) => {
  check(s.state.status === 'incumbent' && s.state.payments.length === 0, why + ': minimum To confirm, as today (state '
    + s.state.status + ')');
  check(s.state.status !== 'unavailable', why + ': never sent with the issuer unknown');
};

// 0. The lead's two note names, matched as the existing table matches (case-insensitive, card digits ignored).
for (const [note, id] of [['card payment: Triangle Mastercard', 'triangle'], ['Card Payment: TRIANGLE MASTERCARD ...4321', 'triangle'],
  ['card payment: MBNA', 'mbna'], ['card payment: mbna ...1234', 'mbna'], [TRAVEL, 'travelvisa']]) {
  check(F.cardPaymentNoteDestination({ notes: note }) === id, JSON.stringify(note) + ' names ' + id);
}
// 1. Noted TD debit plus the card's posted credit: sent, and the issuer applied it.
{
  const s = run(world({ note: TRAVEL, credit: true }));
  check(s.evidence.payments.length === 1 && s.evidence.payments[0].evidence === 'card-payment-note',
    'note + credit: one note-evidenced minimum payment');
  check(!('coverageRef' in s.evidence.payments[0]) && !('debtId' in s.evidence.payments[0]),
    'note + credit: the internal join fields never leave the observer');
  check(s.state.status === 'ready' && s.state.payments.length === 1, 'note + credit: the minimum is ready');
  const p = s.state.payments[0];
  check(p.cashPaid === 49.37 && p.issuerMinimumStatus === 'satisfied' && p.additionalCashRequired === 0,
    'note + credit: 49.37 sent, the 43.19 minimum satisfied, no additional cash');
  check(p.minimumConfirmationSource === 'card-payment-note-and-credit', 'note + credit: the source is the note and the credit');
  check(s.row && s.row.householdPaymentStatus === 'paid' && s.row.cashPaid === 49.37, 'note + credit: the bill row reads paid 49.37');
  check(s.available === 950.63, 'note + credit: available now 1000 - 49.37 = 950.63 (got ' + s.available + ')');
  // Control: the same credit and debit without the note publish the same money; only the minimum stays To confirm.
  const control = run(world({ credit: true }));
  toConfirm(control, 'no note + credit (control)');
  check(control.available === 950.63, 'no note + credit: the same available now, 950.63 (got ' + control.available + ')');
}
// 2. The note alone, before the credit arrives: To confirm, and the plan still publishes.
{
  const s = run(world({ note: TRAVEL }));
  check(s.evidence.payments.length === 0, 'note alone: no minimum evidence until coverage pairs the credit');
  toConfirm(s, 'note alone');
  check(s.available === 950.63, 'note alone: the plan is not blanked, available now 950.63 (got ' + s.available + ')');
}
// 3. Below the confirmed minimum (40 < 43.19): no receipt, so it is dropped and stays To confirm.
toConfirm(run(world({ note: TRAVEL, credit: true, amount: 40 })), 'note + credit below the minimum');
// 4. The credit is pending: coverage does not pair it, no receipt.
toConfirm(run(world({ note: TRAVEL, credit: true, edit: x => { x.payload.transactions[1].is_pending = true; } })),
  'note + pending credit');
// 5. The note names another TD card than the card the credit posted to: no receipt.
toConfirm(run(world({ note: 'card payment: TD Cash Back Visa ...8888', credit: true })), 'note naming another card');
// 5b. The card credit is a recorded card payment but not TD's PAYMENT - THANK YOU
// (an invented payee under "Credit Card Payment"): coverage may pair it, but it
// is not the TD issuer's receipt, so the minimum stays To confirm.
toConfirm(run(world({ note: TRAVEL, credit: true, edit: x => {
  x.payload.categories.push({ id: 9002, name: 'Credit Card Payment', is_income: false, is_group: false });
  Object.assign(x.payload.transactions[1], { payee: 'Invented card payment', original_name: 'Invented card payment', category_id: 9002 });
} })), 'note + a non-TD payment credit');
// 5c. The payment is later returned (Codex P1, #1316): a posted card debit and a
// Bills credit of the same 49.37 under "Credit Card Payment". Coverage reverses
// it, so nothing satisfied the minimum: it stays To confirm, never paid.
toConfirm(run(world({ note: TRAVEL, credit: true, edit: x => {
  x.payload.categories.push({ id: 9002, name: 'Credit Card Payment', is_income: false, is_group: false });
  x.payload.transactions.push(
    { id: 98003, account_id: 3004, date: '2035-10-06', amount: 49.37, currency: 'cad', payee: 'Invented returned payment',
      original_name: 'Invented returned payment', category_id: 9002, is_pending: false, status: 'reviewed' },
    { id: 98004, account_id: 3001, date: '2035-10-06', amount: -49.37, currency: 'cad', payee: 'Invented returned payment',
      original_name: 'Invented returned payment', category_id: 9002, is_pending: false, status: 'reviewed' });
  x.payload.accounts[0].balance += 49.37; x.payload.accounts[3].balance += 49.37;
} })), 'note + credit, then the payment is returned');
// 5d. The genuine TD PAYMENT - THANK YOU credit filed under "Credit Card
// Payment" (Codex P2, #1316) is still the issuer's receipt: paid, as in case 1.
{
  const s = run(world({ note: TRAVEL, credit: true, edit: x => {
    x.payload.categories.push({ id: 9002, name: 'Credit Card Payment', is_income: false, is_group: false });
    x.payload.transactions[1].category_id = 9002;
  } }));
  check(s.state.status === 'ready' && s.state.payments[0]?.issuerMinimumStatus === 'satisfied'
    && s.row?.householdPaymentStatus === 'paid', 'TD credit under "Credit Card Payment": still the receipt, paid (state '
    + s.state.status + ')');
  check(s.available === 950.63, 'TD credit under "Credit Card Payment": available 950.63 (got ' + s.available + ')');
}
// 6. Triangle and MBNA (manual, no card feed): a note never confirms them; their minimum reads as it does with no note.
for (const [card, payee] of [['triangle', 'CAN TIRE MC'], ['mbna', 'MBNA M/C']]) {
  const name = card === 'triangle' ? 'Triangle Mastercard' : 'MBNA';
  const noted = run(world({ card, id: card, payee, note: 'card payment: ' + name }));
  const plain = run(world({ card, id: card, payee }));
  check(noted.evidence.payments.length === 0, card + ': the note adds no minimum evidence');
  check(noted.state.status === plain.state.status && JSON.stringify(noted.state.payments) === JSON.stringify(plain.state.payments)
    && noted.available === plain.available, card + ': reads exactly as the same payment without a note');
  check(noted.state.status !== 'unavailable', card + ': never sent with the issuer unknown');
}
// 6b. A Triangle or MBNA name on a TD "TFR-TO C/C" transfer is contradictory
// (that transfer pays a TD card): card coverage withholds it exactly as an
// unknown name, as on main, and the minimum stays To confirm (#1316 pre-review).
for (const name of ['Triangle Mastercard', 'MBNA']) {
  const s = run(world({ note: 'card payment: ' + name, edit: x => {
    x.data.debts.push({ id: 'triangle', label: 'Invented triangle', structure: 'Revolving', secured: false, balance: 0,
      pending: 0, rate: 0, limit: 1000, statementCloseDay: 17 });
  } }));
  const unknown = run(world({ note: 'card payment: Invented Card', edit: x => {
    x.data.debts.push({ id: 'triangle', label: 'Invented triangle', structure: 'Revolving', secured: false, balance: 0,
      pending: 0, rate: 0, limit: 1000, statementCloseDay: 17 });
  } }));
  const codes = r => JSON.stringify(((r.live.data && F.recommend(r.live.data.plan, NOW, { debts: r.live.data.debts,
    currentPeriodActuals: r.live.report.currentPeriodActuals }).cardPurchaseCoverage) || {}).issues || []);
  check(s.available === unknown.available && codes(s) === codes(unknown),
    name + ' on a TFR-TO C/C: card coverage reads as an unknown name (available ' + s.available + ', ' + codes(s) + ')');
  // Lead dispatch 2026-11-18 (Dale): the unconfirmed destination degrades.
  const trust = r => ((r.live.data && F.recommend(r.live.data.plan, NOW, { debts: r.live.data.debts,
    currentPeriodActuals: r.live.report.currentPeriodActuals }).cardPurchaseCoverage) || {}).trust;
  check(trust(s) === 'estimated' && trust(unknown) === 'estimated', name + ' on a TFR-TO C/C: destination unconfirmed, an estimate');
  toConfirm(s, name + ' on a TFR-TO C/C');
}
// 7. The exact minimum category is unchanged (Dale 2026-10-07): ready, household-category.
{
  const s = run(world({ category: true }));
  check(s.state.status === 'ready' && s.state.payments[0].minimumConfirmationSource === 'household-category',
    'category: unchanged household confirmation');
}
{
  const s = run(world({ category: true, note: 'card payment: TD Cash Back Visa ...8888' }));
  check(s.state.status === 'ready' && s.state.payments[0].minimumConfirmationSource === 'household-category',
    'category with a note naming another card: the category wins, as on main');
}
// 8. The packet's card-minimum ownership mark follows the QUALIFIED evidence (Codex P1 on #1388):
// a noted debit the card's credit pairs stays owned; one it does not pair is never left marked owned.
{
  const owned = packet => (packet.transactions || []).filter(tx => tx.cardMinimumOwned === true).length;
  const paired = run(world({ note: TRAVEL, credit: true }));
  check(paired.live.report.currentPeriodActuals.cardMinimumOwnership === 'available'
    && owned(paired.live.report.currentPeriodActuals) === 1, 'paired note: the debit is marked owned once');
  const unpaired = run(world({ note: TRAVEL }));
  check(unpaired.live.report.currentPeriodActuals.cardMinimumOwnership === 'available'
    && owned(unpaired.live.report.currentPeriodActuals) === 0, 'unpaired note: no row stays marked owned');
}

console.log(`  PASS  a noted TD minimum is confirmed by the card's paired credit, else To confirm (${checks} checks)`);
