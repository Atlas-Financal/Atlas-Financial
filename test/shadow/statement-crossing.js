'use strict';

const assert = require('node:assert/strict');
const fc = require('fast-check');
const Forecast = require('../../public/forecast');
const { minimumRows } = require('./cash-card');

// ARCHITECTURE.md, "One statement minimum occurrence". A changed due date
// must still be between the immediately preceding and next original dates.
// For each calendar, exercise the last legal day, the collision, and the
// first day across the neighboring occurrence in both directions.
const statementCase = fc.record({
  year: fc.constantFrom(2027, 2028, 2029),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.oneof(fc.integer({ min: 1, max: 31 }), fc.constantFrom(28, 29, 30, 31)),
  cents: fc.integer({ min: 1, max: 9000 }),
});

function compareStatement({ year, month, day, cents }) {
  const iso = tick => new Date(tick).toISOString().slice(0, 10);
  const original = monthIndex => {
    const monthLength = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    return Date.UTC(year, monthIndex, Math.min(day, monthLength));
  };
  // Include all original and candidate effective dates even at year boundaries.
  const start = iso(Date.UTC(year, month - 3, 1)), end = iso(Date.UTC(year, month + 2, 0));
  const scheduledDate = iso(original(month - 1));
  const amount = cents / 100, minimum = (cents + 1) / 100;
  for (const direction of [-1, 1]) {
    const neighbor = original(month - 1 + direction);
    for (const beyond of [-1, 0, 1]) {
      const dueDate = iso(neighbor + direction * beyond * 86400000);
      const obligation = { id: 'minimum', label: 'Invented minimum', debtId: 'mbna', effect: 'payment',
        frequency: 'monthly', day, amount, payingAccount: 'chequing-a', confidence: 'confirmed',
        statementOccurrences: [{ scheduledDate, dueDate, minimum, currency: 'cad', confidence: 'confirmed' }] };
      const plan = { obligations: [obligation], income: [], bills: [], commitments: [] };
      if (beyond >= 0) {
        assert.throws(() => minimumRows(plan, start, end), /crosses another original occurrence/);
        assert.throws(() => Forecast.expandEvents(plan, start, end), /statement.*(?:cross|conflict|invalid)/i,
          `reject statement ${scheduledDate} -> ${dueDate}`);
        continue;
      }
      const expected = minimumRows(plan, start, end).map(row => [row.date, row.scheduledDate, -row.cents]);
      const events = Forecast.expandEvents(plan, start, end);
      const actual = events.filter(row => row.kind === 'obligation' && row.id === obligation.id)
        .map(row => [row.date, row.scheduledDate || row.date, Math.round(row.amount * 100)]);
      assert.deepEqual(actual, expected, `statement ${scheduledDate} -> ${dueDate} (${direction}, ${beyond})`);
    }
  }
}

module.exports = { statementCase, compareStatement };
