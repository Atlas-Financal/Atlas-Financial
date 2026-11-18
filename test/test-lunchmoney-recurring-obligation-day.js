'use strict';
/* E1 (lead dispatch 2026-11-18, census 4 and 9; option B approved): a card
 * minimum or the HELOC cash minimum takes its planned day from its reviewed
 * Lunch Money recurring item, served plan only. Monthly items on monthly rows
 * only; amount and every tag stay the plan's. Recorded history is never
 * re-dated: the new day applies from the day after the row's latest recorded
 * statement, sent payment or opening representation (timingBefore keeps the
 * earlier day before it). The plan stands, unchanged, when the day would
 * move past the latest known statement's due day, or when the cutover would
 * put two occurrences in one statement cycle or skip one.
 *
 * Invented world: test/fixtures/card-backfill-data (an invented card,
 * 'triangle', paid from Bills, LM account 3001), as of 2026-10-05. The card
 * row is monthly on the 7th from Oct 7, with one recorded statement
 * (Oct 7 -> due Oct 8). Each walk is hand-derived in its comment.
 *
 * `node test/test-lunchmoney-recurring-obligation-day.js`
 */
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const source = require('./fixtures/card-backfill-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123470';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fixture(row = {}) {
  const x = source('triangle', 'triangle');
  x.asOf = '2026-10-05';
  x.data.meta.asOf = '2026-10-02';
  x.data.plan.opening.asOf = '2026-10-02';
  x.data.plan.windowDays = 28;
  x.data.plan.income[0].anchor = '2026-10-02';
  x.data.plan.obligations[0] = { id: 'triangle', debtId: 'triangle', effect: 'payment',
    label: 'Invented card minimum', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
    amount: 88.88, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
      minimum: 91.23, currency: 'cad', confidence: 'confirmed' }], ...row };
  for (const key of Object.keys(row)) if (row[key] === undefined) delete x.data.plan.obligations[0][key];
  x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2026-10-02', endDate: x.asOf, complete: true, hasMore: false, truncated: false };
  x.payload.transactions = [];
  x.payload.accounts.forEach(a => { a.updated_at = x.asOf + 'T17:00:00Z'; a.balance_last_update = x.asOf + 'T17:00:00Z'; });
  x.identity = { ...x.identity, rules: x.identity.rules.map(rule => rule.eventId === 'triangle'
    ? { ...rule, lunchMoneyRecurringIds: [ID] } : rule) };
  return x;
}
const readItem = (anchorDate, expected, extra = {}) => ({ status: 'read', read: { unexpectedPaginationEvidence: false,
  requestedWindow: { startDate: '2026-10-02', endDate: '2026-11-05' },
  items: [{ providerId: ID, status: 'reviewed', unavailableFields: [],
    criteria: { startDate: '2026-01-01', endDate: null, granularity: 'month', quantity: 1, anchorDate, amount: '88.8800',
      currency: 'CAD', plaidAccountId: '3001', manualAccountId: null, ...extra },
    matches: { expectedOccurrenceDates: expected, foundTransactions: [], missingTransactionDates: expected } }] } });
function serve(x, recurringItems) {
  if (recurringItems) x.payload.recurringItems = recurringItems;
  const r = Live.fromObservation(x);
  const row = r.data.plan.obligations.find(o => o.id === 'triangle');
  const walk = (from, to) => F.expandEvents(r.data.plan, from, to).filter(e => e.id === 'triangle').map(e => e.date);
  return { applied: r.data.liveOverlay.applied, row, walk };
}
const planStands = (s, why, day = 7) => {
  ok(s.applied === true, why + ': the overlay applies');
  ok(s.row.day === day && !Object.hasOwn(s.row, 'timingBefore'), why + ': the plan\'s day ' + day + ' stands', JSON.stringify([s.row.day, s.row.timingBefore]));
};

console.log('1. The card moves to LM\'s 5th from the day after its recorded statement');
{
  // Statement Oct 7 -> due Oct 8 is the latest record: cutover Oct 9. The 5th
  // is on or before the statement's due day (the 8th). Old Oct 7 to new
  // Nov 5 is 29 days, one cycle. Walk Oct 1-Dec 31: Oct 8 (the statement's
  // due date, unchanged), Nov 5, Dec 5.
  const s = serve(fixture(), readItem('2026-01-05', ['2026-10-05', '2026-11-05']));
  ok(s.applied === true, 'the overlay applies');
  ok(s.row.day === 5 && same(s.row.timingBefore, { from: '2026-10-09', frequency: 'monthly', day: 7 }),
    'served day 5, earlier day 7 kept before Oct 9', JSON.stringify([s.row.day, s.row.timingBefore]));
  ok(s.row.confidence === 'estimated' && s.row.amount === 88.88 && !Object.hasOwn(s.row, 'dateConfidence'),
    'amount, its tag and every other field are the plan\'s; no tag added');
  ok(same(s.walk('2026-10-01', '2026-12-31'), ['2026-10-08', '2026-11-05', '2026-12-05']), 'Oct 8, Nov 5, Dec 5',
    JSON.stringify(s.walk('2026-10-01', '2026-12-31')));
  const control = serve(fixture());
  ok(same(control.walk('2026-10-01', '2026-12-31'), ['2026-10-08', '2026-11-07', '2026-12-07']), 'control, no read: Oct 8, Nov 7, Dec 7',
    JSON.stringify(control.walk('2026-10-01', '2026-12-31')));
}

console.log('2. Never past the known statement due day');
{
  // A sent payment for Oct 7 posted Oct 24 moves the cutover to Oct 25, so
  // LM's 20th would first fall on Nov 20: next month, 44 days after Oct 7,
  // one cycle. Only the due-day rule refuses it: the 20th is after the
  // statement's due day (the 8th), so the plan's 7th stands.
  const late = { sentPayments: [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum', debitId: 'invented-debit',
    postedOn: '2026-10-24', amount: 92, currency: 'cad', fundingAccountId: 'chequing-a', pending: false }] };
  planStands(serve(fixture(late), readItem('2026-01-20', ['2026-11-20'])), 'LM on the 20th, due day the 8th');
  // Control: LM's 8th, on the due day, leads from Oct 25 (Nov 8, 32 days).
  const onDue = serve(fixture(late), readItem('2026-01-08', ['2026-11-08']));
  ok(onDue.row.day === 8 && onDue.row.timingBefore && onDue.row.timingBefore.from === '2026-10-25', 'control: LM on the 8th leads from Oct 25',
    JSON.stringify([onDue.row.day, onDue.row.timingBefore]));
  // Same month: old Oct 7 and a new day the cutover lets fall in October
  // (cutover Oct 9, LM's 12th -> Oct 12) would be two in one month.
  planStands(serve(fixture(), readItem('2026-01-12', ['2026-10-12', '2026-11-12'])), 'LM on the 12th, Oct 7 then Oct 12');
}

console.log('3. The cutover never puts two occurrences in one cycle, and never skips one');
{
  // Old day 28, statement Oct 28 -> due Oct 28: cutover Oct 29. LM's 2nd
  // would give Oct 28 and then Nov 2, 5 days apart, two in one cycle: the plan
  // stands. Walk: Oct 28, Nov 28 (no Nov 2).
  const two = serve(fixture({ day: 28, firstDue: '2026-10-28', statementOccurrences: [{ scheduledDate: '2026-10-28',
    dueDate: '2026-10-28', minimum: 91.23, currency: 'cad', confidence: 'confirmed' }] }), readItem('2026-01-02', ['2026-11-02']));
  planStands(two, 'old 28th, LM 2nd', 28);
  ok(same(two.walk('2026-10-01', '2026-11-30'), ['2026-10-28', '2026-11-28']), 'Oct 28, Nov 28, never a Nov 2 as well',
    JSON.stringify(two.walk('2026-10-01', '2026-11-30')));
  // Old day 2, no statement; a sent payment for Oct 2 posted Oct 30: cutover
  // Oct 31. LM's 28th would go from Oct 2 to Nov 28, 57 days, skipping a
  // cycle: the plan stands.
  const skip = serve(fixture({ day: 2, firstDue: '2026-10-02', statementOccurrences: undefined,
    sentPayments: [{ scheduledDate: '2026-10-02', confirmed: true, intent: 'minimum', debitId: 'invented-debit', postedOn: '2026-10-30',
      amount: 90, currency: 'cad', fundingAccountId: 'chequing-a', pending: false }] }), readItem('2026-01-28', ['2026-11-28']));
  planStands(skip, 'old 2nd, LM 28th', 2);
  // Same month with a long gap: old day 2, no statement, a sent payment for
  // Oct 2 posted Oct 3 (cutover Oct 4). LM's 25th would give Oct 2 and then
  // Oct 25: 23 days, but both in October, two in one cycle. The plan stands.
  const sameMonth = serve(fixture({ day: 2, firstDue: '2026-10-02', statementOccurrences: undefined,
    sentPayments: [{ scheduledDate: '2026-10-02', confirmed: true, intent: 'minimum', debitId: 'invented-debit', postedOn: '2026-10-03',
      amount: 90, currency: 'cad', fundingAccountId: 'chequing-a', pending: false }] }), readItem('2026-01-25', ['2026-10-25']));
  planStands(sameMonth, 'old 2nd, LM 25th in the same month', 2);
  // The unit check, read directly: the same day pair across the 28th -> 2nd
  // cutover is refused, and 28th -> 25th (28 days) is accepted.
  const plan = d => ({ obligations: [{ id: 'triangle', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: d,
    firstDue: '2026-09-28', payingAccount: 'chequing-a', statementOccurrences: [{ scheduledDate: '2026-10-28', dueDate: '2026-10-28',
      minimum: 50, currency: 'cad', confidence: 'confirmed' }] }], bills: [] });
  const sched = anchor => O.recurringBillSchedules({ status: 'read', items: [{ recurringId: ID, granularity: 'month', quantity: 1,
    anchorDate: anchor, startDate: '2026-01-01', endDate: null, currency: 'cad', accountRole: 'household-cash', expectedDates: [],
    foundTransactionLocalIds: [] }] }, [{ eventId: 'triangle', lunchMoneyRecurringIds: [ID] }], plan(28), '2026-11-01');
  ok(sched('2026-01-02').length === 0, 'unit: 28th -> 2nd refused');
  ok(sched('2026-01-25').length === 1 && sched('2026-01-25')[0].fields.day === 25, 'unit: 28th -> 25th accepted', JSON.stringify(sched('2026-01-25')));
}

console.log('4. Any doubt keeps the plan');
planStands(serve(fixture(), readItem('2026-01-05', ['2026-10-05'], { granularity: 'week', quantity: 2 })), 'every two weeks');
planStands(serve(fixture(), readItem('2026-01-05', ['2026-10-05'], { endDate: '2026-12-31' })), 'an ended item');
planStands(serve(fixture(), readItem('2026-02-30', [])), 'anchor not a real day');
planStands(serve(fixture(), readItem('2026-01-05', ['2026-11-06'])), 'LM expects a date the 5th does not produce');
planStands(serve(fixture(), readItem('2026-01-05', ['2026-11-05'], { plaidAccountId: '9999' })), 'paid from an unmapped account');
planStands(serve(fixture()), 'no read');

console.log('5. HELOC cash leg: LM\'s day moves cashDay; earlier cash days kept when represented');
{
  const heloc = extra => ({ obligations: [{ id: 'heloc', debtId: 'heloc', effect: 'capitalise', frequency: 'monthly', day: 31,
    nonCash: true, payingAccount: 'chequing-a', cashPayment: 50, cashDay: 21, cashFirstDue: '2026-09-21', cashConfidence: 'estimated' }],
    bills: [], opening: { representedEvents: extra || [] } });
  const sched = (plan, anchor) => O.recurringBillSchedules({ status: 'read', items: [{ recurringId: ID, granularity: 'month', quantity: 1,
    anchorDate: anchor, startDate: '2026-01-01', endDate: null, currency: 'cad', accountRole: 'household-cash', expectedDates: [],
    foundTransactionLocalIds: [] }] }, [{ eventId: 'heloc', lunchMoneyRecurringIds: [ID] }], plan, '2026-10-05');
  // No represented cash day: cashDay 15, no cutover.
  const plain = sched(heloc(), '2026-01-15');
  ok(plain.length === 1 && same(plain[0].fields, { cashDay: 15 }), 'cashDay 15, no cutover', JSON.stringify(plain));
  // Represented Oct 21: cutover Oct 22; Oct 21 -> Nov 15 is 25 days. The cash
  // walk Oct 1-Dec 31 on the applied row: Oct 21, Nov 15, Dec 15.
  const plan = heloc([{ id: 'heloc', date: '2026-10-21' }]);
  const cut = sched(plan, '2026-01-15');
  ok(cut.length === 1 && same(cut[0].fields, { cashDay: 15, cashTimingBefore: { from: '2026-10-22', frequency: 'monthly', day: 21 } }),
    'cashDay 15 from Oct 22, the 21st kept before', JSON.stringify(cut));
  const row = O.applyRecurringObligationSchedule(plan.obligations[0], cut[0]);
  const cash = F.expandEvents({ obligations: [row], bills: [], income: [], commitments: [] }, '2026-10-01', '2026-12-31')
    .filter(e => e.id === 'heloc' && e.kind === 'obligation').map(e => e.date);
  ok(same(cash, ['2026-10-21', '2026-11-15', '2026-12-15']), 'cash Oct 21, Nov 15, Dec 15', JSON.stringify(cash));
}

console.log('6. The owner-policy guard: only day / timingBefore / cashDay / cashTimingBefore, only on a scheduled obligation');
{
  const card = { id: 'triangle', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 7, amount: 88.88, confidence: 'estimated' };
  const before = { plan: { obligations: [card, { ...card, id: 'other' }] } };
  const after = patch => ({ plan: { obligations: [{ ...card, ...patch }, { ...card, id: 'other' }] } });
  const throws = (a, set) => { try { Live.assertOwnerPolicyUntouched(before, a, new Set(), set); return false; } catch (_) { return true; } };
  const tri = new Set(['triangle']);
  ok(!throws(after({ day: 5, timingBefore: { from: '2026-10-09', frequency: 'monthly', day: 7 } }), tri), 'scheduled: day and timingBefore may differ');
  ok(throws(after({ day: 5 }), new Set()), 'not scheduled: the day may not differ');
  ok(throws(after({ amount: 90 }), tri), 'scheduled: the amount may not differ');
  ok(throws(after({ confidence: 'confirmed' }), tri), 'scheduled: the tag may not differ');
  ok(throws(after({ frequency: 'biweekly' }), tri), 'scheduled: the cadence may not differ');
  ok(throws({ plan: { obligations: [card, { ...card, id: 'other', day: 9 }] } }, tri), 'another obligation may not differ');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money recurring obligation-day checks passed.');
