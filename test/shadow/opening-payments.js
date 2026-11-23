'use strict';

const assert = require('node:assert/strict');
const fc = require('fast-check');
const Forecast = require('../../public/forecast');
const { makeHousehold } = require('./households');
const { expectedCash } = require('./cash-card');
const { expectedPeriod } = require('./period');
const { observedCash } = require('./observed-cash');
const { observedPeriod } = require('./observed-period');

const paymentCase = fc.record({
  asOf: fc.constantFrom('2028-02-29', '2027-01-15', '2028-12-31'),
  pay: fc.integer({ min: 1, max: 9000 }), minimum: fc.integer({ min: 1, max: 9000 }),
});

function compareOpeningPayments({ asOf, pay, minimum }) {
  // ARCHITECTURE.md, "Effective date of represented cash movement". The
  // ledger has already identified each occurrence. No transaction matching.
  const input = { payday: asOf, elapsed: 0, horizonDays: 1, cash: minimum + 1,
    weeklyCash: 0, weeklyAllowanceCents: 0, groceries: 0, pay, semiMonthlyOnly: true, secondPay: null,
    bills: [], purchases: [], mortgage: null, heloc: null,
    card: { cents: minimum, day: Number(asOf.slice(8)), pending: 0, balancePad: 0, limitDelta: 1 } };
  const facts = makeHousehold(input);
  assert.equal(expectedPeriod(facts), null);
  assert.equal(observedPeriod(facts), null, 'a second salary cannot define the operating cycle');
  const obligation = facts.plan.obligations[0];
  const pending = { id: obligation.id, scheduledDate: asOf, pendingOn: asOf };
  const evidence = { source: 'lunchmoney-minimum-category', asOf, payments: [] };
  const withPayroll = makeHousehold({ ...input, semiMonthlyOnly: false });
  withPayroll.plan.cardMinimumCategoryEvidence = { ...evidence, pendingPayments: [pending] };
  const advice = Forecast.recommend(withPayroll.plan, asOf, withPayroll.opts);
  const current = advice.payPeriodViews.find(period => period.timelineRole === 'current');
  const bill = current.bills.find(row => row.id === obligation.id && row.date === asOf);
  assert.ok(bill, 'the opening-day minimum is on the current bill list');
  assert.deepEqual([bill.status, bill.paymentPending, bill.remaining], ['pending', true, minimum / 100]);
  const receipt = { id: obligation.id, date: asOf, effectiveAsOf: asOf };
  const nextDay = new Date(Date.parse(asOf) + 86400000).toISOString().slice(0, 10);
  for (const [state, openingReceipt, ending] of [
    ['pending', null, pay + 1],
    ['future opening', { ...receipt, effectiveAsOf: nextDay }, pay + 1],
    ['posted in this opening', receipt, pay + minimum + 1],
  ]) {
    facts.plan.cardMinimumCategoryEvidence = { ...evidence, pendingPayments: state === 'pending' ? [pending] : [] };
    facts.plan.opening.representedEvents = openingReceipt ? [openingReceipt] : [];
    const expected = expectedCash(facts);
    assert.equal(expected.endingCents, ending, state);
    assert.deepEqual(observedCash(facts), expected, state);
  }
  facts.plan.startingCash.breakdown[1] = { id: 'chequing-b', value: null, unknown: true };
  const unknown = expectedCash(facts);
  assert.equal(unknown.endingCents, null, 'unknown chequing opening');
  assert.deepEqual(observedCash(facts), unknown, 'unknown cash withholds daily and minimum balances');
}

module.exports = { paymentCase, compareOpeningPayments };
