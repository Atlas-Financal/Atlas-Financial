'use strict';
// Owner inputs are encoding checks only. Behavior uses invented early-payment
// ledgers and signed cash identities, never the household's cents as an oracle.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const F = require('../public/forecast'), Live = require('../scripts/live-plan');
const canonicalText = fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8');
const canonical = JSON.parse(canonicalText), clone = x => JSON.parse(JSON.stringify(x));
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (a, label) => { assert.ok(a, label); checks++; };
const target = canonical.plan.obligations.find(row => row.id === 'tdcc');
eq([target.amount, target.confidence, target.frequency, target.day, target.firstDue],
  [94.03, 'estimated', 'monthly', 17, '2026-09-17'], 'standing recurrence and future estimates unchanged');
eq(target.statementOccurrences, [{ scheduledDate: '2026-10-17', dueDate: '2026-10-17',
  minimum: 45.96, currency: 'cad', confidence: 'confirmed', dateConfidence: 'estimated' }]);
eq(target.sentPayments, [{ scheduledDate: '2026-10-17', confirmed: true, intent: 'minimum',
  debitId: 'tdcc-2026-10-bank-sent', postedOn: '2026-10-05', amount: 50, currency: 'cad',
  fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: '2026-10-06' }]);
eq(canonical.plan.opening.representedEvents.filter(row => row.id === 'tdcc'),
  [{ id: 'tdcc', date: '2026-09-17' }, { id: 'tdcc', date: '2026-10-17', effectiveAsOf: '2026-10-06' }],
  'separate September receipt is preserved without reconstructing its sender');
eq(F.obligationOccurrences(target, '2026-10-01', '2026-10-31').map(row =>
  [row.scheduledDate, row.date, row.amount, row.confidence, row.dateConfidence]),
  [['2026-10-17', '2026-10-17', 45.96, 'confirmed', 'estimated']]);
eq(F.obligationOccurrences(target, '2026-11-01', '2026-11-30')[0].amount, 94.03);

function fixture() {
  const data = require('./fixtures/card-backfill-data')('tdcc', 'invented-emerald-minimum').data;
  const asOf = '2038-06-06', p = data.plan;
  data.meta.asOf = asOf; p.opening = { asOf, priorAsOf: '2038-05-15', representedEvents: [
    { id: 'invented-emerald-minimum', date: '2038-05-17' },
    { id: 'invented-emerald-minimum', date: '2038-06-17', effectiveAsOf: asOf }] };
  p.windowDays = 90; p.defaults = { targetBuffer: 0, extraDebtMonthly: 0 };
  p.income.forEach(row => { row.anchor = '2038-06-04'; row.amount = 0; });
  p.budget.categories = []; p.bills = []; p.commitments = [];
  p.startingCash.breakdown.forEach(row => { row.value = row.id === 'chequing-a' ? 472.21 : 0; });
  data.debts[0].balance = 772.21; data.debts[0].rate = 0;
  p.obligations = [{ id: 'invented-emerald-minimum', label: 'Invented Emerald minimum',
    debtId: 'tdcc', effect: 'payment', payingAccount: 'chequing-a', frequency: 'monthly',
    day: 17, firstDue: '2038-05-17', amount: 38.41, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: '2038-06-17', dueDate: '2038-06-17',
      minimum: 23.17, currency: 'cad', confidence: 'confirmed', dateConfidence: 'estimated' }],
    sentPayments: [{ scheduledDate: '2038-06-17', confirmed: true, intent: 'minimum',
      debitId: 'invented-emerald-send', postedOn: '2038-06-05', amount: 27.79, currency: 'cad',
      fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: asOf }] }];
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
    coverageStart: '2038-06-04', coverageThrough: asOf, pendingCoverage: 'complete',
    transactionCoverage: 'complete', transactions: [], representedActuals: [] };
  return { data, asOf, opts: { debts: data.debts, currentPeriodActuals: packet,
    viewDays: 14, horizonDays: 14, weeklyVariable: 0, targetBuffer: 0 } };
}
const x = fixture(), before = JSON.stringify(x), p = x.data.plan;
const state = F.cardMinimumState(p, x.asOf, x.opts), sim = F.simulate(p, x.asOf, x.opts);
eq(state.status, 'ready'); eq(state.payments.length, 1);
eq([state.payments[0].occurrenceKey, state.payments[0].cashPaid,
  state.payments[0].cashInclusionStatus, state.payments[0].issuerMinimumStatus,
  state.payments[0].additionalCashRequired],
  ['invented-emerald-minimum@2038-06-17', 27.79, 'included', 'satisfied', 0], 'early payment satisfies only its original occurrence');
eq(Math.round(sim.ending * 100), 47221, '500.00 - 27.79 = 472.21; no second minimum/send deduction');
eq(Math.round(F.projectDebts(p, x.data.debts, x.asOf, { ...x.opts, debtHorizonDays: 14 }).byId.tdcc.balance * 100),
  77221, 'observed 800.00 - 27.79 principal is not replayed or relabeled as excess');
eq(state.payments.some(row => row.scheduledDate === '2038-05-17'), false,
  'new sender does not reconstruct a payment on the older cycle');
eq(F.representedOccurrence(p, 'invented-emerald-minimum', '2038-05-17', x.asOf, x.opts), true,
  'independently represented older cycle stays represented');
const next = F.obligationOccurrences(p.obligations[0], '2038-07-01', '2038-07-31')[0];
eq([next.amount, next.confidence], [38.41, 'estimated'], 'next minimum keeps independent standing estimate');
eq(Math.round(F.simulate(p, x.asOf, { ...x.opts, viewDays: 45, horizonDays: 45 }).ending * 100),
  43380, 'future 38.41 deducted once after already included current send');
eq(F.expandEvents(p, x.asOf, '2038-06-30', x.opts).some(row => row.id === 'invented-emerald-minimum'), false,
  'qualified early receipt omits the later scheduled cash event');
const event = F.expandEvents(p, x.asOf, '2038-06-30', { ...x.opts, keepRepresented: true })
  .find(row => row.id === 'invented-emerald-minimum');
eq([event.date, event.confidence, event.dateConfidence], ['2038-06-17', 'confirmed', 'estimated']);
eq(F.cardMinimumState(p, '2038-06-05', x.opts).status, 'unavailable', 'posting alone cannot certify next cash opening');
eq(F.cardMinimumState(p, '2038-06-04', x.opts).payments.length, 0, 'no payment before actual posting');
for (const [label, change] of [
  ['wrong old cycle', row => { row.sentPayments[0].scheduledDate = '2038-05-17'; }],
  ['later cycle', row => { row.sentPayments[0].scheduledDate = '2038-07-17'; }],
  ['unknown intent', row => { row.sentPayments[0].intent = 'unknown'; }],
  ['pending send', row => { row.sentPayments[0].pending = true; }],
  ['wrong funding', row => { row.sentPayments[0].fundingAccountId = 'chequing-b'; }],
  ['missing cash qualification', row => { delete row.sentPayments[0].cashIncludedAsOf; }],
]) {
  const plan = clone(p); change(plan.obligations[0]);
  const result = F.cardMinimumState(plan, x.asOf, x.opts);
  ok(!result.payments.some(row => row.occurrenceKey === 'invented-emerald-minimum@2038-06-17'
    && row.additionalCashRequired === 0), label + ': cannot satisfy the current named receipt');
}
const incomplete = clone(p); incomplete.opening.representedEvents = incomplete.opening.representedEvents.slice(0, 1);
eq(F.cardMinimumState(incomplete, x.asOf, x.opts).status, 'unavailable', 'cash send alone cannot prove issuer satisfaction');
for (const value of [null, 'unknown', false, 42]) {
  const plan = clone(p); plan.obligations[0].statementOccurrences[0].dateConfidence = value;
  assert.throws(() => F.expandEvents(plan, x.asOf, '2038-06-30')); checks++;
}
eq(F.simulate(p, x.asOf, x.opts), sim, 'repeat reads preserve the whole financial result');
// Real observation/overlay replay: a sender row and independently observed
// closing stocks do not invent a receiving transaction or another reduction.
const observed = require('./fixtures/card-backfill-data')('tdcc', 'invented-emerald-minimum');
observed.data = clone(x.data); observed.identity = { rules: [], billPaymentPayees: [] };
observed.payload.fetchedAt = x.asOf + 'T18:00:00Z';
observed.payload.accounts.forEach((row, i) => {
  row.balance = [472.21, 0, 0, 772.21][i]; row.updated_at = x.asOf + 'T17:00:00Z';
  // Same-day refresh: every balance is dated the live day. A lagging
  // fixture balance is the withheld stale-sibling case (hunt 5 finding 1),
  // not what this test is about.
  if (row.balance_as_of) row.balance_as_of = x.asOf + 'T17:00:00Z';
  if (row.balance_last_update) row.balance_last_update = x.asOf + 'T17:00:00Z';
});
observed.payload.transactions = [{ id: 82001, account_id: 3001, date: '2038-06-05', amount: 27.79,
  currency: 'cad', payee: 'TFR-TO C/C', category_name: 'Credit Card Payment', is_pending: false }];
observed.payload.transactionWindow = { startDate: '2038-06-04', endDate: x.asOf,
  complete: true, hasMore: false, truncated: false };
const observedBefore = JSON.stringify(observed), first = Live.fromObservation(observed), repeated = Live.fromObservation(observed);
eq(first.data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value, 472.21);
eq(first.data.debts.find(row => row.id === 'tdcc').balance, 772.21);
eq(first.data.plan.opening.representedEvents.filter(row => row.id === 'invented-emerald-minimum')
  .map(row => row.date).sort(), ['2038-05-17', '2038-06-17'], 'both old and early current receipts survive actual overlay');
eq(repeated.data, first.data, 'same observation cannot accumulate cash/principal deductions or receipts');
eq(JSON.stringify(observed), observedBefore);
eq(JSON.stringify(x), before);
eq(fs.readFileSync(path.join(__dirname, '../data.json'), 'utf8'), canonicalText);
console.log('PASS Emerald original October minimum: ' + checks + ' checks; owner encoding, estimated date, early qualified payment, legacy/future isolation and independent cash/principal conservation');
