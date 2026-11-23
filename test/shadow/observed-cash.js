'use strict';

const assert = require('node:assert/strict');
const Forecast = require('../../public/forecast.js');

// The walk accumulates some allowances at a sub-cent daily rate. Compare the
// displayed cent value and keep every unavailable monetary value distinct.
function cents(amount) {
  if (amount === null) return null;
  assert.ok(Number.isFinite(amount), 'cash publication must be a finite number or null');
  return Math.round(amount * 100) || 0;
}

function observedCash({ plan, asOf, horizonDays, opts, weeklyVariable }) {
  const walk = Forecast.simulate(plan, asOf, { ...opts, horizonDays, weeklyVariable });
  const cards = Forecast.utilisation(opts.debts, [], plan).rows.map(row => ({
    id: row.id, postedCents: cents(row.posted), pendingCents: cents(row.pending),
    usedCents: cents(row.used), availableCents: cents(row.available),
    overLimit: row.overLimit, overLimitByCents: cents(row.overLimitBy),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const minimumRows = [];
  for (const row of plan.obligations) {
    let type, occurrences;
    if (row.debtId === 'heloc' && row.nonCash) {
      type = 'heloc';
      occurrences = Forecast.capitalisingCashMinimumOccurrences(row, asOf, walk.end);
    } else if (row.effect === 'payment' && opts.debts.some(d => d.id === row.debtId && !d.secured)) {
      type = 'card';
      occurrences = Forecast.obligationOccurrences(row, asOf, walk.end);
    } else continue;
    for (const occurrence of occurrences) {
      minimumRows.push({ id: row.id, debtId: row.debtId, date: occurrence.date,
        scheduledDate: occurrence.scheduledDate || occurrence.date, cents: cents(occurrence.amount), type });
    }
  }
  minimumRows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return {
    daily: walk.daily.every(r => r.balance === null) ? null
      : walk.daily.map(r => ({ date: r.date, cents: cents(r.balance) })),
    minimumCents: cents(walk.min.balance), endingCents: cents(walk.ending), minimumRows, cards,
  };
}

module.exports = { observedCash };
