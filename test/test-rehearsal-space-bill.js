'use strict';
// Canonical routing is checked separately from the invented behavior ledger.
// No receipt, recipient, provider reference or live household cash is a fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const { sourceText } = require('./test-source-text');
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const cents = value => Math.round(Number(value) * 100);
const ID = 'rehearsal-space';
const canonical = load('data.json');
const rows = canonical.plan.bills.filter(row => row.id === ID);
assert.equal(rows.length, 1, 'one canonical rehearsal-space bill');
const row = rows[0];
assert.deepEqual([row.frequency, row.day, row.firstDue, row.amount, row.payingAccount],
  ['monthly', 1, '2026-11-01', 80, 'chequing-a'], 'authorized input routing only');
assert.equal(row.confidence, 'estimated');
assert.equal(row.dateConfidence, 'estimated');
assert.match(row.label, /estimated timing/i, 'the date qualifier travels on every label consumer');
assert.match(row.note, /contractual due day is unknown/i);
assert.match(row.note, /October is already paid/i);
assert.equal(row.budgetCategory, null, 'no historical category or guilt-free policy is inferred');
assert.equal(row.householdObligation, true);
assert.equal(F.billIsSubscription(row), false);
for (const key of ['settledOn', 'statementOccurrences', 'utilityAccountCredit']) {
  assert.equal(Object.hasOwn(row, key), false, 'no invented ' + key);
}
assert.equal(F.expandEvents(canonical.plan, '2026-10-01', '2026-10-31')
  .some(event => event.id === ID), false, 'canonical October has no rehearsal-space hold');

// Independent ledger: three hand-listed dates, 3 * 67.31 = 201.93.
// Routing fields come from the input; amount, dates and opening are invented.
const AMOUNT = 6731, OPENING = 130000, AS_OF = '2038-10-09';
const bill = { ...clone(row), amount: AMOUNT / 100, firstDue: '2038-11-01',
  label: 'Invented rehearsal bill (estimated timing)', note: 'Invented timing evidence only.' };
const data = { meta: { asOf: AS_OF }, accounts: [], debts: [], revolvingExtra: [], plan: {
  windowDays: 91, defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
  startingCash: { breakdown: [{ id: 'chequing-a', value: OPENING / 100 },
    { id: 'chequing-b', value: 0 }] },
  opening: { asOf: AS_OF, priorAsOf: '2038-10-01', representedEvents: [] },
  income: [], obligations: [], commitments: [], bills: [bill], budget: { categories: [] },
} };
const unchanged = JSON.stringify(data);
const dates = ['2038-11-01', '2038-12-01', '2039-01-01'];
const events = F.expandEvents(data.plan, '2038-10-01', '2039-01-31');
assert.deepEqual(events.map(event => [event.date, cents(-event.amount), event.confidence]),
  dates.map(date => [date, AMOUNT, 'estimated']));
assert(events.every(event => event.jointCash === true && event.cardPaid === false
  && event.payingAccount === 'chequing-a'));
const simulate = horizonDays => F.simulate(data.plan, AS_OF, {
  horizonDays, viewDays: horizonDays, weeklyVariable: 0, extraDebtMonthly: 0, targetBuffer: 0,
});
const october = simulate(23);
assert.equal(cents(october.totals.bills), 0);
assert.equal(cents(october.ending), OPENING, 'already-paid October is not deducted again');
const throughJanuary = simulate(115);
assert.equal(cents(throughJanuary.totals.bills), 20193);
assert.equal(cents(throughJanuary.ending), 109807, '1300.00 - 201.93, without borrowing');
assert.equal(cents(throughJanuary.totals.income), 0);
assert.equal(cents(throughJanuary.totals.reserved || 0), 0, 'no second card-paid reserve');
assert.equal(JSON.stringify(data), unchanged, 'Forecast leaves historical/input state untouched');

const roster = F.householdBills(data.plan, AS_OF);
assert.equal(roster.bills.length, 1);
assert.deepEqual([roster.bills[0].nextDate, roster.bills[0].confidence,
  cents(roster.bills[0].monthlyEquivalent)], ['2038-11-01', 'estimated', AMOUNT]);
assert.equal(cents(roster.monthlyEquivalentTotal), AMOUNT);
assert.equal(F.householdSubscriptions(data.plan, AS_OF).subscriptions.length, 0);

// Exercise the real observer with the incumbent identity configuration.
// Even equal native-CAD amount/account/date and a plausible label do not
// establish rehearsal payment purpose. A Fortis positive control proves the
// matcher ran rather than passing because observation was disabled.
const identity = load('docs/connectivity/transaction-identity.json');
assert(!identity.rules.some(rule => rule.eventId === ID), 'no automatic settlement rule');
function observe(date, payee) {
  const input = clone(data);
  input.plan.bills.push({ id: 'fortis', label: 'Invented gas control', frequency: 'monthly',
    day: 1, firstDue: '2038-11-01', amount: AMOUNT / 100, payingAccount: 'chequing-a' });
  return O.observe({ provider: 'lunchmoney', data: input, identity,
    accountMap: load('docs/connectivity/fixtures/provider-account-map.json'), payload: {
      provider: 'lunchmoney', fetchedAt: date + 'T18:00:00.000Z',
      transactionWindow: { startDate: '2038-10-01', endDate: date,
        complete: true, hasMore: false, truncated: false },
      pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS,
        hasMore: false, truncated: false },
      accounts: [{ id: 1001, name: 'Invented Bills', type: 'cash', balance: 1232.69,
        updated_at: date + 'T17:55:00.000Z' },
      { id: 1002, name: 'Invented Weekly', type: 'cash', balance: 0,
        updated_at: date + 'T17:55:00.000Z' }],
      categories: [{ id: 11, name: 'Uncategorised', is_income: false, exclude_from_totals: false }],
      transactions: [{ id: 9701, account_id: 1001, date, amount: AMOUNT / 100,
        currency: 'cad', is_pending: false, payee, category_id: 11 }],
    } });
}
for (const [date, payee] of [['2038-10-01', 'E-TRANSFER SEND'],
  ['2038-11-01', 'E-TRANSFER SEND'], ['2038-11-01', 'Interac e-Transfer'],
  ['2038-11-01', 'Band rehearsal space'], ['2038-11-01', 'Fortisbc Energy Bpy']]) {
  const report = observe(date, payee);
  assert.equal(report.writesCanonicalState, false);
  assert.equal(report.transactionWindow.complete, true);
  assert.equal(report.transactions.length, 1, 'observer consumed the invented ledger');
  assert(!(report.representedEventCandidates || []).some(hit => hit.id === ID));
  assert(!(report.currentPeriodActuals.representedActuals || []).some(hit => hit.id === ID));
  if (payee === 'Fortisbc Energy Bpy') {
    assert(report.representedEventCandidates.some(hit => hit.id === 'fortis'
      && hit.date === '2038-11-01'), 'positive control: existing named identity still settles');
  }
}
console.log('PASS rehearsal input; independent monthly cash ledger; zero October replay; visible estimated timing; no e-transfer auto-settlement');
