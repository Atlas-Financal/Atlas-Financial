'use strict';

const assert = require('node:assert/strict');
const Forecast = require('../../public/forecast.js');

// Observation only. Keep null distinct from zero, and reject missing, invalid,
// or fractional-cent published figures instead of rounding a discrepancy away.
function publishedCents(dollars) {
  if (dollars === null) return null;
  assert.ok(Number.isFinite(dollars), 'expected a finite published amount or null');
  const scaled = dollars * 100;
  const cents = Math.round(scaled);
  assert.ok(Number.isSafeInteger(cents) && Math.abs(scaled - cents) < 1e-6,
    'published amount must be whole cents');
  return cents === 0 ? 0 : cents;
}

function observedPeriod({ plan, asOf, opts }) {
  const calendar = Forecast.spendingCycle(plan, asOf);
  const advice = Forecast.recommend(plan, asOf, opts);
  const current = advice.payPeriodViews.find(period => period.timelineRole === 'current');
  if (!current) {
    assert.equal(calendar, null, 'missing current view for a published cycle');
    return null;
  }
  assert.ok(calendar, 'current view has no published cycle');
  assert.equal(current.start, calendar.start);
  assert.equal(current.end, calendar.end);
  const { bills, surplus } = current.stackSummary;
  const byDateAndId = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  // Rows still list each occurrence when a single unknown price withholds the
  // bill load and its breakdown. Observe them even in that case.
  const listed = current.bills.map(row => ({
    id: row.id, date: row.date, amount: publishedCents(row.amount),
  })).sort(byDateAndId);
  const assigned = bills.other === null ? null : current.bills
    .filter(row => Object.hasOwn(row, 'stackBillPart'))
    .map(row => ({ id: row.id, date: row.date, amount: publishedCents(row.stackBillAmount) }))
    .sort(byDateAndId);
  const terms = surplus.terms === null ? null : Object.fromEntries(
    Object.entries(surplus.terms).map(([key, amount]) => [key, publishedCents(amount)])
  );
  return {
    start: current.start,
    end: current.end,
    nextPayday: calendar.nextPayday,
    income: publishedCents(current.incomeTotal),
    billLoad: publishedCents(current.periodBillLoad),
    household: publishedCents(current.budgetHold),
    balanceAfterDeductions: publishedCents(current.balanceAfterDeductions),
    listed,
    assigned,
    stack: { amount: publishedCents(surplus.amount), terms },
  };
}

module.exports = { observedPeriod };
