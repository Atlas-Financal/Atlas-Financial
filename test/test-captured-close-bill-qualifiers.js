'use strict';
// #818 / Atlas 6701670033 on #867. A captured close keeps its own bill state:
// a payment recorded after the capture must not turn a captured unconfirmed
// minimum into Paid, and the reverse must not drop a captured Paid. Today's
// row lends only plan wording and classes. Invented card data only
// (test/fixtures/card-backfill-data.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const Detail = require('../public/bill-detail');
const source = require('./fixtures/card-backfill-data');

const LATER = '2026-10-12';
const OCT = { start: '2026-09-25', end: '2026-10-08' };
const AUG = { start: '2026-07-31', end: '2026-08-13' };
const BILL_KEYS = ['id', 'label', 'kind', 'date', 'planned', 'amount', 'actual', 'remaining', 'settlement', 'status', 'cardPaid', 'confidence'];
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

function fixture(records) {
  const x = source('triangle', 'triangle');
  x.data.meta.asOf = x.asOf = LATER;
  const p = x.data.plan;
  p.opening = { asOf: LATER, priorAsOf: '2026-08-19', representedEvents: [] };
  p.income[0].anchor = '2026-09-25';
  p.startingCash.breakdown[0].value = 785.17;
  p.budget.categories = [];
  p.obligations = [{ id: 'triangle', label: 'Invented card minimum', debtId: 'triangle',
    effect: 'payment', frequency: 'monthly', day: 7, firstDue: '2026-10-07',
    amount: 43.21, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
      minimum: 47.39, currency: 'cad', confidence: 'confirmed' }],
    ...(records ? { sentPayments: records } : {}) }];
  return x;
}
const SENT = [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
  debitId: 'invented-recorded-send', postedOn: '2026-10-07', amount: 52.67,
  currency: 'cad', fundingAccountId: 'chequing-a', pending: false }];
const run = (records, periodHistory) => {
  const x = fixture(records);
  return F.recommend(x.data.plan, LATER, { debts: x.data.debts, ...(periodHistory ? { periodHistory } : {}) });
};
const period = (r, w) => r.payPeriodViews.find(v => v.start === w.start && v.end === w.end);
const bill = (r, w) => (period(r, w).bills || []).find(row => row.id === 'triangle');
// A captured close as the archive serves it: the projected bill keys only.
const closeOf = (r, w, capturedAt) => ({ schema: 'atlas-private-period-history-projection/v1', capturedAt,
  content: { period: { ...w, timezone: 'America/Vancouver' }, kind: 'closing', asOf: w.end,
    closingState: 'provisional', planBasis: 'see-baseline-revision', provenance: { policyFingerprint: null },
    publication: { start: w.start, end: w.end,
      bills: (period(r, w).bills || []).map(row => Object.fromEntries(BILL_KEYS.filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]]))) } } });

const context = vm.createContext({ Forecast: F, BillDetail: Detail, console,
  addEventListener() {}, document: { addEventListener() {}, querySelectorAll() { return []; },
    getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
vm.runInContext('App.boot = () => {};', context);
vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
const shown = row => { context.row = row; return JSON.parse(vm.runInContext('JSON.stringify(budgetBillPresentation(row))', context)); };

// Preconditions: today's rebuild does carry the later send on the Oct row.
const before = run(null), after = run(SENT);
ok(bill(before, OCT).settlement === 'unverified' && !bill(before, OCT).cashPaymentStatus, 'captured state: minimum unconfirmed');
ok(bill(after, OCT).cashPaymentStatus === 'sent' && bill(after, OCT).householdPaymentStatus === 'paid'
  && shown(bill(after, OCT)).label === 'Paid', "today's rebuild alone would read Paid");

// Forward: captured unconfirmed, later fully sent payment.
const forward = bill(run(SENT, [closeOf(before, OCT, '2026-10-09T19:00:00.000Z')]), OCT);
ok(forward.settlement === 'unverified' && forward.status === bill(before, OCT).status, 'the captured status and settlement are reprinted');
for (const key of ['cashPaymentStatus', 'householdPaymentStatus', 'cashInclusionStatus', 'issuerMinimumStatus',
  'cashSentDates', 'additionalCashRequired', 'glanceKind', 'minimumCoverage', 'payerLabel', 'payingAccount']) {
  ok(!Object.hasOwn(forward, key), key + ' is not borrowed from today');
}
ok(shown(forward).label === 'To confirm' && !shown(forward).qualifier, 'the captured minimum stays unconfirmed on the Bills page');

// Reverse: captured after the send, today's rebuild no longer carries it.
const reverse = bill(run(null, [closeOf(after, OCT, '2026-10-09T19:00:00.000Z')]), OCT);
ok(!Object.hasOwn(reverse, 'cashPaymentStatus') && shown(reverse).label === shown({ ...bill(after, OCT),
  cashPaymentStatus: undefined, householdPaymentStatus: undefined }).label,
  'the reverse reprints the captured row, not today\'s');

// Same id, different occurrence: a capture of the Aug period leaves the
// uncaptured Oct occurrence as today's rebuild, and the Aug row as captured.
const control = run(SENT, [closeOf(before, AUG, '2026-08-14T19:00:00.000Z')]);
ok(bill(control, OCT).cashPaymentStatus === 'sent' && period(control, OCT).capturedClose === undefined,
  'the uncaptured Oct occurrence is today\'s');
ok(JSON.stringify(Object.fromEntries(BILL_KEYS.map(k => [k, bill(control, AUG)[k]])))
  === JSON.stringify(Object.fromEntries(BILL_KEYS.map(k => [k, bill(before, AUG)[k]]))), 'the captured Aug occurrence is the capture');

console.log('PASS captured close bill qualifiers: ' + checks + ' checks');
