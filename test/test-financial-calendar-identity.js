'use strict';
// Synthetic calendar/consumer proof. Date round-trips independently check
// Gregorian day identity; explicit timezone examples are owner-zone fixtures.
const assert = require('node:assert/strict');
const Forecast = require('../public/forecast');
const Provider = require('../scripts/provider-observe');
let checks = 0;
let failures = 0;
function equal(actual, expected, label) {
  checks++;
  try { assert.deepEqual(actual, expected, label); }
  catch (error) { failures++; console.error('FAIL ' + error.message); }
}

// setUTCFullYear avoids Date.UTC's 1900 offset for years 00 through 99.
function realDay(year, month, day) {
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  return instant.getUTCFullYear() === year
    && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
}
for (const year of [0, 1, 99, 1900, 2000, 2024, 2026, 2100, 9999]) {
  for (let month = 1; month <= 12; month++) {
    for (const day of [1, 28, 29, 30, 31]) {
      const date = String(year).padStart(4, '0') + '-'
        + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      equal(Forecast.financialDate(date), realDay(year, month, day) ? date : null, date);
    }
  }
}
for (const value of [null, undefined, '', '2026-00-01', '2026-13-01', '2026-01-00',
  '2026-01-32', '2026-2-01', '2026-02-01T12:00:00', '2026-02-30T12:00:00Z',
  '2025-02-29T01:00:00+01:00', '1900-02-29T23:00:00-08:00',
  '2026-04-31T12:00:00-0700', '2026-13-01T12:00:00Z']) {
  equal(Forecast.financialDate(value), null, 'reject ' + String(value));
}
const instants = [
  ['2024-02-29T12:00:00Z', '2024-02-29'],
  ['2000-02-29T12:00:00Z', '2000-02-29'],
  ['2026-01-01T07:59:59Z', '2025-12-31'],
  ['2026-01-01T08:00:00Z', '2026-01-01'],
  ['2026-03-01T07:59:59Z', '2026-02-28'],
  ['2026-03-01T08:00:00Z', '2026-03-01'],
  ['2026-03-08T07:30:00Z', '2026-03-07'],
  ['2026-03-08T09:59:59Z', '2026-03-08'],
  ['2026-03-08T10:00:00Z', '2026-03-08'],
  ['2026-11-01T08:30:00Z', '2026-11-01'],
  ['2026-11-01T09:30:00Z', '2026-11-01'],
  ['2026-01-15T01:00:00+01:00', '2026-01-14'],
  ['2026-06-01T00:30:00+1400', '2026-05-31'],
  ['2026-01-15T00:30:00-0800', '2026-01-15'],
  ['2026-03-08T03:00:00.123-07:00', '2026-03-08'],
  // Retain the existing accepted end-of-day instant representation.
  ['2026-01-15T24:00:00Z', '2026-01-15'],
];
for (const [value, day] of instants) equal(Forecast.financialDate(value), day, value);
equal(Forecast.financialDate(' 2026-03-08 '), '2026-03-08', 'literal day is not an instant');

function fixture(day) {
  return {
    plan: { windowDays: 7, startingCash: { amount: 2000 },
      opening: { asOf: day }, defaults: { targetBuffer: 500, extraDebtMonthly: 0, scenario: 'expected' },
      nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
      income: [], obligations: [], bills: [], commitments: [] },
    debts: [{ id: 'synthetic-card', label: 'Synthetic card', balance: 800, pending: 0,
      rate: 0, rateConvention: 'card', structure: 'Revolving - synthetic', secured: false, limit: 1200 }],
  };
}
const input = { amount: 100, debtId: 'synthetic-card', nature: 'hypothetical' };
for (const invalid of ['2026-02-30', '2025-02-29', '2026-04-31', '2026-02-30T12:00:00Z']) {
  const { plan, debts } = fixture(invalid);
  const before = JSON.stringify({ plan, debts });
  const answer = Forecast.hypotheticalExtraPayment(plan, debts, invalid, input);
  equal(answer.status, 'unavailable', 'hypothetical rejects impossible baseline ' + invalid);
  equal(answer.productionWrite, false, 'rejection is read-only');
  equal(JSON.stringify({ plan, debts }), before, 'no baseline mutation');
}
for (const day of ['2024-02-29', '2026-01-01', '2026-03-08', '2026-11-01']) {
  const { plan, debts } = fixture(day);
  const before = JSON.stringify({ plan, debts });
  const answer = Forecast.hypotheticalExtraPayment(plan, debts, day, input);
  equal(answer.status, 'ready', 'valid hypothetical ' + day);
  if (answer.status !== 'ready') continue;
  equal(answer.absorbed.amount, 100, 'whole requested payment absorbed');
  equal(answer.absorbed.unabsorbed, 0, 'no lost payment');
  equal(answer.delta.cash.ending, -100, 'cash falls by caller amount');
  equal(answer.delta.debt.paid, 100, 'principal paid rises by caller amount');
  equal(answer.delta.debt.ending, -100, 'zero-rate liability falls by caller amount');
  equal(answer.delta.debt.interest, 0, 'zero-rate independent interest oracle');
  for (const view of [answer.baseline, answer.scenario]) {
    equal(view.debt.ending + view.debt.paid, 800, 'opening principal conserved');
  }
  equal(answer.scenario.cash.ending - answer.scenario.debt.ending,
    answer.baseline.cash.ending - answer.baseline.debt.ending, 'payment preserves net cash less liability');
  equal(JSON.stringify({ plan, debts }), before, 'valid calculation does not mutate baseline');
}
const mapped = Provider.REQUIRED_LIVE_CASH_IDS.flatMap((id, index) =>
  Provider.observationsFromMappedAccount(Provider.normalizeLunchMoneyAccount({
    id: 900 + index, name: 'Synthetic ' + id, balance: '100.00',
    updated_at: '2026-02-30T12:00:00Z',
  }), { atlasRole: 'household-cash', canonical: { collection: 'cash', id } }, '2026-03-04T12:00:00Z'));
equal(Provider.householdDateFromProviderEvidence(mapped), null, 'invalid provider instant does not acquire a financial day');
equal(Provider.householdFinancialDate({ asOf: '2026-02-30' }, []), null, 'invalid explicit provider as-of rejected');
equal(Provider.postedBalanceEvidenceInstant({ balanceLastUpdate: '2026-02-30' }), null, 'incumbent posted-date rejection retained');
console.log('Financial calendar identity: ' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exitCode = 1;
