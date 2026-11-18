'use strict';
/* E2 (lead ruling 2026-11-18, #821 6967807281, under Dale's standing
 * direction; Dale may veto). A card minimum is withheld from automatic
 * settlement (cardMinimumNeedsConfirmation: a card payment may be a purchase
 * backfill, not the minimum) except in one narrow case: the card's rule opts
 * in with settlementFrom 'lunchmoney-matched-occurrences', Lunch Money's own
 * matches for its reviewed item are consistent (#1287 gates), and Lunch Money
 * paired exactly one payment with the cycle, where the cycle has a CONFIRMED
 * statement on the paired occurrence, the payment is at least that
 * statement's minimum, and no other linked payment posted in the cycle.
 * Anything else keeps today's withholding.
 *
 * Invented world: test/fixtures/card-backfill-data (an invented card,
 * 'triangle', paid from Bills, LM account 3001), as of 2026-10-05. Monthly on
 * the 7th from Oct 7, with one confirmed statement: Oct 7 -> due Oct 8,
 * minimum $91.23. firstDue is Oct 7, so there is no earlier occurrence and the
 * cycle starts 31 days before Oct 7: it runs from after Sep 6 to Oct 8.
 *
 * `node test/test-lunchmoney-matched-card-minimum.js`
 */
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123480';
const OPT_IN = 'lunchmoney-matched-occurrences';

let nextId = 94100;
const pay = (date, amount, extra = {}) => ({ id: ++nextId, account_id: 3001, date, amount, currency: 'cad',
  payee: 'Invented card payment', category_name: 'Credit card payment', is_pending: false, recurring_id: Number(ID), ...extra });

function fixture({ payments = [], optIn = true, statement = {} } = {}) {
  const x = source('triangle', 'triangle');
  x.asOf = '2026-10-05';
  x.data.meta.asOf = '2026-10-02';
  x.data.plan.opening.asOf = '2026-10-02';
  x.data.plan.windowDays = 28;
  x.data.plan.income[0].anchor = '2026-10-02';
  x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
    label: 'Invented card minimum', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
    amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a',
    ...(statement === null ? {} : { statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
      minimum: 91.23, currency: 'cad', confidence: 'confirmed', ...statement }] }) };
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2026-09-08', endDate: x.asOf, complete: true, hasMore: false, truncated: false };
  x.payload.transactions = payments;
  x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  // The card's rule: identified by its Lunch Money recurring link alone.
  x.identity = { ...x.identity, rules: x.identity.rules.filter(rule => rule.eventId !== 'triangle').concat([{ eventId: 'triangle',
    lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a', direction: 'debit', requiredCurrency: 'cad',
    requiredPostingEvidence: 'posted', postingDateRule: 'covers-statement-cycle-or-latest-due', settlesWhen: 'amount-at-least',
    ...(optIn ? { settlementFrom: OPT_IN } : {}) }]) };
  return x;
}
const lmRead = (expected, found, missing = []) => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-09-08', endDate: '2026-11-05' },
  items: [{ providerId: ID, status: 'reviewed', unavailableFields: [],
    criteria: { startDate: '2026-01-01', endDate: null, granularity: 'month', quantity: 1, anchorDate: '2026-01-07', amount: '91.2300',
      currency: 'CAD', plaidAccountId: '3001', manualAccountId: null },
    matches: { expectedOccurrenceDates: expected, missingTransactionDates: missing,
      foundTransactions: found.map(t => ({ date: t.date, transactionId: t.id })) } }] } });
function serve(x, lm) {
  if (lm) x.payload.recurringItems = lm;
  const r = Live.fromObservation(x);
  const represented = (r.report.representedEventCandidates || []).filter(c => c.id === 'triangle');
  const advice = F.recommend(r.data.plan, x.asOf, { debts: r.data.debts, currentPeriodActuals: r.data.liveOverlay.currentPeriodActuals });
  const bill = advice.defaultView.bills.find(row => row.id === 'triangle');
  return { applied: r.data.liveOverlay.applied, represented, bill };
}
const settled = s => s.represented.length === 1;
const withheld = (s, label) => {
  ok(s.applied === true, label + ': the overlay applies');
  ok(s.represented.length === 0, label + ': nothing settles the card (withheld as today)', JSON.stringify(s.represented.map(c => [c.date, c.postingDate])));
  ok(s.bill && s.bill.status === 'still due' && s.bill.remaining > 0, label + ': the card minimum still reads still due',
    JSON.stringify(s.bill && [s.bill.status, s.bill.remaining]));
};

console.log('1. One LM-matched payment covering the confirmed minimum settles that cycle');
{
  // $100 on Oct 5 >= $91.23; LM expected Oct 7, matched it. One payment in
  // the cycle (after Sep 6, up to Oct 8].
  const p = [pay('2026-10-05', 100)];
  const s = serve(fixture({ payments: p }), lmRead(['2026-10-07'], p));
  ok(s.applied === true, 'the overlay applies');
  ok(settled(s) && s.represented[0].date === '2026-10-07' && s.represented[0].postingDate === '2026-10-05',
    'the Oct 7 minimum is represented by the Oct 5 payment', JSON.stringify(s.represented.map(c => [c.date, c.postingDate])));
  ok(s.bill && s.bill.status === 'PAID' && s.bill.remaining === 0 && s.bill.settlement === 'represented',
    'the card minimum reads PAID, $0 remaining', JSON.stringify(s.bill && [s.bill.status, s.bill.remaining, s.bill.settlement]));
  // Controls: the same payment and read with no opt-in, and with no read at
  // all, stay withheld as today.
  withheld(serve(fixture({ payments: [pay('2026-10-05', 100)], optIn: false }), lmRead(['2026-10-07'], [pay('2026-10-05', 100)])), 'control, not opted in');
  withheld(serve(fixture({ payments: [pay('2026-10-05', 100)] })), 'control, no read');
}

console.log('2. A payment below the confirmed minimum settles nothing');
{
  const p = [pay('2026-10-05', 50)];
  withheld(serve(fixture({ payments: p }), lmRead(['2026-10-07'], p)), '$50 against a $91.23 minimum');
  // Exactly the minimum settles.
  const q = [pay('2026-10-05', 91.23)];
  ok(settled(serve(fixture({ payments: q }), lmRead(['2026-10-07'], q))), 'exactly $91.23 settles');
}

console.log('3. Two payments in the cycle settle nothing');
{
  // LM matched the Oct 5 payment, but a second linked payment posted Sep 20,
  // inside the cycle (after Sep 6, up to Oct 8): the cycle has two payments.
  // LM's own count is consistent (one matched date, one found payment), so
  // only the one-payment-per-cycle check refuses it.
  const p = [pay('2026-09-20', 40), pay('2026-10-05', 100)];
  withheld(serve(fixture({ payments: p }), lmRead(['2026-10-07'], [p[1]])), 'two linked payments in one cycle (LM counted one)');
}

console.log('4. No confirmed statement: the plan\'s estimated minimum never counts');
{
  // Statement records are confirmed by contract (an unconfirmed one is
  // rejected outright), so the case is a cycle with no statement: only the
  // plan's estimated $88.88, which a $100 payment covers, yet it settles
  // nothing.
  const p = [pay('2026-10-05', 100)];
  withheld(serve(fixture({ payments: p, statement: null }), lmRead(['2026-10-07'], p)), 'no statement for the cycle');
}

console.log('5. LM inconsistent: today\'s behaviour (withheld)');
{
  const p = [pay('2026-10-05', 100)];
  withheld(serve(fixture({ payments: p }), lmRead(['2026-10-07'], [])), 'LM found nothing for a matched date (count mismatch)');
  withheld(serve(fixture({ payments: p }), lmRead(['2026-10-07'], [], ['2026-10-07'])), 'LM says Oct 7 missing');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money matched card-minimum checks passed.');
