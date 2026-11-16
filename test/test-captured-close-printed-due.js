'use strict';
// #887 follow-up. A captured closed pay period keeps a bill row's occurrence
// `date` only. A once row that stands in for a skipped recurring occurrence
// prints its scheduled due on the live period; the saved close must print
// the same due, borrowed from today's row for the same occurrence (same id
// and date), never from another occurrence. Invented card data only
// (test/fixtures/card-backfill-data.js).
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const source = require('./fixtures/card-backfill-data');

const LATER = '2026-10-12';
const OCT = { start: '2026-09-25', end: '2026-10-08' };
const BILL_KEYS = ['id', 'label', 'kind', 'date', 'planned', 'amount', 'actual', 'remaining',
  'settlement', 'status', 'cardPaid', 'confidence'];

function run(periodHistory, onceDate = '2026-10-08') {
  const x = source('triangle', 'triangle');
  x.data.meta.asOf = x.asOf = LATER;
  const p = x.data.plan;
  p.opening = { asOf: LATER, priorAsOf: '2026-08-19', representedEvents: [] };
  p.income[0].anchor = '2026-09-25';
  p.budget.categories = [];
  // The recurring minimum skips October; a once row beside it stands in.
  p.obligations = [
    { id: 'triangle', label: 'Invented card minimum', debtId: 'triangle', effect: 'payment',
      frequency: 'monthly', day: 7, firstDue: '2026-11-07', amount: 43.21,
      confidence: 'estimated', payingAccount: 'chequing-a' },
    { id: 'triangle-oct', label: 'Invented October minimum', debtId: 'triangle', effect: 'payment',
      frequency: 'once', date: onceDate, amount: 50, confidence: 'confirmed', payingAccount: 'chequing-a' },
  ];
  return F.recommend(p, LATER, { debts: x.data.debts, ...(periodHistory ? { periodHistory } : {}) });
}
const period = (r, w) => r.payPeriodViews.find(v => v.start === w.start && v.end === w.end);
const bill = r => (period(r, OCT).bills || []).find(row => row.id === 'triangle-oct');
// A captured close as the archive serves it: the projected bill keys only.
const closeOf = r => ({ schema: 'atlas-private-period-history-projection/v1', capturedAt: '2026-10-09T19:00:00.000Z',
  content: { period: { ...OCT, timezone: 'America/Vancouver' }, kind: 'closing', asOf: OCT.end,
    closingState: 'provisional', planBasis: 'see-baseline-revision', provenance: { policyFingerprint: null },
    publication: { start: OCT.start, end: OCT.end,
      bills: (period(r, OCT).bills || []).map(row => Object.fromEntries(BILL_KEYS
        .filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]))) } } });

const live = run(null);
assert.ok(bill(live), 'precondition: the once row is in the October period');
assert.equal(bill(live).date, '2026-10-08');
assert.equal(bill(live).scheduledDue, '2026-10-07', 'precondition: it stands in for the skipped Oct 7');
const captured = closeOf(live);
assert.ok(!Object.hasOwn(captured.content.publication.bills.find(r => r.id === 'triangle-oct'), 'scheduledDue'),
  'precondition: the archive projection keeps no scheduledDue');

const closed = bill(run([captured]));
assert.ok(period(run([captured]), OCT).capturedClose, 'the period prints as its saved close');
assert.equal(closed.date, '2026-10-08', 'the saved occurrence date is unchanged');
assert.equal(closed.scheduledDue, '2026-10-07', 'the saved close prints the same due as the live period');

// Another occurrence never lends its due: today's row moved to Oct 6, so
// it is not the saved Oct 8 occurrence.
const moved = bill(run([captured], '2026-10-06'));
assert.equal(moved.date, '2026-10-08');
assert.ok(!Object.hasOwn(moved, 'scheduledDue'), 'a different occurrence lends nothing');
console.log('PASS a saved close prints a stood-in bill row\'s scheduled due (#887)');
