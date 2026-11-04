'use strict';
// Household inputs below are encoding checks only. Financial behavior uses an
// invented ledger: 1,000.00 Bills - 49.37 sent = 950.63; observed card stock
// 800.00 - 49.37 = 750.63. The statement minimum is independently 43.19.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');
let checks = 0;
const eq = (a, b, why) => { assert.deepEqual(a, b, why); checks++; };
const ok = (a, why) => { assert.ok(a, why); checks++; };
const clone = x => structuredClone(x);
const text = fs.readFileSync(require.resolve('../data.json'), 'utf8');
const canonical = JSON.parse(text), row = canonical.plan.obligations.find(x => x.id === 'triangle');
eq(row.sentPayments, [{ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
  debitId: 'triangle-2026-10-bank-sent', postedOn: '2026-10-05', amount: 270,
  currency: 'cad', fundingAccountId: 'chequing-a', pending: false, cashIncludedAsOf: '2026-10-06' }],
  'qualify the existing sender without recording another payment');
eq(row.statementOccurrences, [{ scheduledDate: '2026-10-07', dueDate: '2026-10-08',
  minimum: 262.82, currency: 'cad', confidence: 'confirmed' }], 'existing statement unchanged');
eq([row.amount, row.confidence, row.day, row.firstDue],
  [253.57, 'estimated', 7, '2026-09-07'], 'standing future estimate unchanged');
eq(canonical.plan.opening.representedEvents.filter(x => x.id === 'triangle'), [
  { id: 'triangle', date: '2026-09-07', effectiveAsOf: '2026-10-05' },
  { id: 'triangle', date: '2026-10-07', effectiveAsOf: '2026-10-06' }],
  'preserve prior history and date the new owner confirmation');
eq(F.financialDate('2026-10-07T01:14:54Z'), '2026-10-06', 'capture instant uses the household date, not its UTC date');
ok(row.note.includes('owner confirmation') && row.note.includes('01:14:54 UTC'), 'durable attributed provenance');

const id = 'invented-triangle-minimum', scheduledDate = '2038-06-07';
const cashDate = '2038-06-06', confirmedDate = '2038-06-06', postedOn = '2038-06-05';
function fixture() {
  const x = source('triangle', id), p = x.data.plan;
  x.asOf = confirmedDate; x.data.meta.asOf = cashDate;
  p.opening = { asOf: '2038-06-04', representedEvents: [] };
  p.income[0].anchor = '2038-06-04'; p.income[0].amount = 0;
  p.budget.categories = [];
  p.startingCash.breakdown[0].value = 950.63;
  x.data.debts[0].balance = 750.63;
  p.obligations = [{ id, label: 'Invented Triangle minimum', debtId: 'triangle',
    effect: 'payment', frequency: 'monthly', day: 7, firstDue: scheduledDate,
    amount: 31.27, confidence: 'estimated', payingAccount: 'chequing-a',
    statementOccurrences: [{ scheduledDate, dueDate: '2038-06-08', minimum: 43.19,
      currency: 'cad', confidence: 'confirmed' }],
    sentPayments: [{ scheduledDate, confirmed: true, intent: 'minimum',
      debitId: 'invented-one-sender', postedOn, amount: 49.37, currency: 'cad',
      fundingAccountId: 'chequing-a', pending: false }] }];
  return x;
}
function opts(x, date) {
  return { debts: x.data.debts, horizonDays: 14, viewDays: 14, weeklyVariable: 0,
    currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: date,
      coverageStart: '2038-06-04', coverageThrough: date, pendingCoverage: 'complete',
      transactionCoverage: 'complete', transactions: [], representedActuals: [] } };
}
function current(x, date) {
  return F.recommend(x.data.plan, date, opts(x, date)).payPeriodViews.find(x => x.timelineRole === 'current');
}
const x = fixture(), p = x.data.plan;
eq(F.cardMinimumState(p, confirmedDate).status, 'unavailable', 'reproduce original missing proof');
eq(current(x, confirmedDate).balanceAfterDeductions, null, 'original minimum holds BAD publication');
p.obligations[0].sentPayments[0].cashIncludedAsOf = cashDate;
eq(F.cardMinimumState(p, confirmedDate).payments[0].issuerMinimumStatus, 'unconfirmed',
  'cash inclusion alone never asserts issuer settlement');
eq(current(x, confirmedDate).balanceAfterDeductions, null, 'included sender alone leaves BAD unavailable');
p.opening.representedEvents.push({ id, date: scheduledDate, effectiveAsOf: confirmedDate });
const immutable = JSON.stringify(x), state = F.cardMinimumState(p, confirmedDate);
eq(state.status, 'ready');
eq([state.payments[0].cashPaid, state.payments[0].cashInclusionStatus,
  state.payments[0].issuerMinimumStatus, state.payments[0].additionalCashRequired],
  [49.37, 'included', 'satisfied', 0], 'owner-confirmed original minimum has zero additional cash');
const prior = F.cardMinimumState(p, postedOn).payments[0];
eq([prior.cashInclusionStatus, prior.issuerMinimumStatus, prior.additionalCashRequired],
  ['unconfirmed', 'unconfirmed', null], 'do not backdate owner confirmation or cash inclusion to the posting date');
eq(current(x, postedOn).balanceAfterDeductions, null, 'history retains its original settlement hold');
const period = current(x, confirmedDate), bill = period.bills.find(x => x.id === id);
eq([bill.status, bill.settlement, bill.remaining, bill.date, bill.occurrenceKey],
  ['PAID', 'represented', 0, '2038-06-08', id + '@' + scheduledDate], 'native consumer sees the same paid occurrence');
eq(Math.round(period.balanceAfterDeductions * 100), -4319,
  'native whole-period BAD: zero income - 43.19 assigned minimum - zero budget; confirmation releases its unknown hold');
eq(Math.round(F.simulate(p, confirmedDate, opts(x, confirmedDate)).ending * 100), 95063);
const debt = F.projectDebts(p, x.data.debts, confirmedDate, { debtHorizonDays: 14 }).byId.triangle;
eq([Math.round(debt.balance * 100), debt.paid], [75063, 0], 'observed principal is not replayed or assigned as excess');
const next = F.obligationOccurrences(p.obligations[0], '2038-07-01', '2038-07-31')[0];
eq([next.scheduledDate, next.amount, next.confidence], ['2038-07-07', 31.27, 'estimated']);
eq(F.representedOccurrence(p, id, '2038-07-07', confirmedDate, opts(x, confirmedDate)), false,
  'future cycle cannot borrow this confirmation');
const wrongCycle = clone(p); wrongCycle.opening.representedEvents[0].date = '2038-05-07';
eq(F.cardMinimumState(wrongCycle, confirmedDate).status, 'unavailable', 'wrong occurrence cannot clear the current minimum');
for (const [label, change] of [
  ['purchase backfill', row => { row.intent = 'purchase-backfill'; }],
  ['ambiguous intent', row => { delete row.intent; }],
  ['pending', row => { row.pending = true; }],
  ['refund', row => { row.amount = -49.37; }],
]) {
  const fresh = fixture(); change(fresh.data.plan.obligations[0].sentPayments[0]);
  ok(!F.cardMinimumState(fresh.data.plan, confirmedDate).payments.some(row => row.issuerMinimumStatus === 'satisfied'),
    label + ': matching date/amount without owner proof cannot settle the minimum');
}
eq(JSON.stringify(x), immutable, 'native queries do not mutate any cash, stock or source');

// Advance real observation/overlay composition with independently observed
// closing stocks and only the existing sender. No receiving transaction is invented.
x.identity = { rules: [], billPaymentPayees: [] };
x.payload.transactions = [{ id: 88001, account_id: 3001, date: postedOn,
  amount: 49.37, currency: 'cad', payee: 'CAN TIRE MC', category_name: 'Credit Card Payment', is_pending: false }];
for (const day of [confirmedDate, '2038-06-08', '2038-06-09']) {
  x.asOf = day; x.payload.fetchedAt = day + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2038-06-04', endDate: day, complete: true, hasMore: false, truncated: false };
  x.payload.accounts.forEach((row, i) => { row.balance = [950.63, 0, 0, 750.63][i]; row.updated_at = day + 'T17:00:00Z'; row.balance_last_update = day + 'T17:00:00Z'; });
  const before = JSON.stringify(x), live = Live.fromObservation(x);
  eq(JSON.stringify(x), before, 'observation composition remains read only');
  ok(live.data.liveOverlay.applied);
  x.data = live.data;
  eq(x.data.plan.opening.representedEvents.filter(row => row.id === id),
    [{ id, date: scheduledDate, effectiveAsOf: confirmedDate }], 'one durable confirmation survives advancing refreshes');
  eq(F.cardMinimumState(x.data.plan, day).status, 'ready');
  eq(F.postedHouseholdChequingCash(x.data.plan), 950.63, 'bank cash is unchanged after refresh');
  eq(x.data.debts[0].balance, 750.63, 'card observed balance is unchanged after refresh');
  eq(F.projectDebts(x.data.plan, x.data.debts, day, { debtHorizonDays: 14 }).byId.triangle.paid, 0);
  eq(Math.round(current(x, day).balanceAfterDeductions * 100), -4319, 'whole-period native BAD remains free of the paid-item unknown hold');
  eq(Math.round(F.simulate(x.data.plan, day, opts(x, day)).ending * 100), 95063,
    'independent cash identity survives refresh without a second payment');
}
eq(fs.readFileSync(require.resolve('../data.json'), 'utf8'), text, 'canonical data remains untouched by tests');
console.log('PASS Triangle owner-confirmed paid: ' + checks + ' checks; dated proof, native BAD, unchanged cash/principal, next-cycle isolation and refresh durability');
