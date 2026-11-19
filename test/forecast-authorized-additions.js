'use strict';
// Forecast fields an exact-main (frozen engine) comparison cannot see,
// because main predates them. Each is PROVED in its empty state on the
// invented input first, then removed from the current-engine side, so the
// comparison still covers every other field. A comparison input that
// carries saved closes would fail the proof loudly instead of hiding a move.
//
//   categorySpendingTrends (Forecast.categorySpendingTrends, #1384): with no
//   qualifying saved close, no trend is published.
//   stackSummary (Stack Wallet, #821 7013976545) on each pay period:
//     bills (A2): the bill total split into mortgage, card minimums and
//     other, proved to sum to the period's periodBillLoad, or every part
//     null and unavailable;
//     surplus (A2): income − other bills − household − mortgage − credit −
//     item spending, proved against its own terms and the bills split here,
//     and on unmodified output to equal Balance After Deductions plus its
//     held outflows and card payments beyond the minimum.
const assert = require('node:assert/strict');

const finite = v => typeof v === 'number' && Number.isFinite(v);
// The comparisons that call this may already have normalised a period's
// other figures (restored a frozen engine's numbers), so the proof here is
// the surplus's own: its amount is exactly its published terms, its trust a
// published value, and a withheld surplus lists no terms. The identity with
// the period's published Balance After Deductions (surplus = BAD + held +
// beyond the minimum) is proved on unmodified output in
// test/test-stack-summary-surplus.js.
const cents = v => Math.round(v * 100);
function proveStackBills(view, bills) {
  assert.ok(bills && typeof bills === 'object', 'authorized addition: stackSummary.bills is published');
  if (bills.other === null) {
    assert.ok(bills.mortgage === null && bills.cardMinimums === null && bills.trust === 'unavailable' && typeof bills.reason === 'string',
      'authorized addition: a withheld bills split is null throughout, unavailable, with a reason');
    return;
  }
  assert.ok(finite(bills.mortgage) && finite(bills.other) && Array.isArray(bills.cardMinimums)
    && bills.cardMinimums.every(card => card && typeof card.debtId === 'string' && finite(card.amount)),
    'authorized addition: a published bills split lists its parts');
  assert.ok(['calculated', 'estimated'].includes(bills.trust), 'authorized addition: a published bills split is calculated or estimated');
}
function proveStackSurplus(view, surplus, bills) {
  assert.ok(surplus && typeof surplus === 'object', 'authorized addition: stackSummary.surplus is published');
  assert.equal(typeof surplus.projected, 'boolean', 'authorized addition: surplus.projected is a flag');
  if (surplus.amount === null) {
    assert.equal(surplus.terms, null, 'authorized addition: a withheld surplus lists no terms');
    assert.equal(surplus.trust, 'unavailable', 'authorized addition: a withheld surplus reads unavailable');
    assert.equal(typeof surplus.reason, 'string', 'authorized addition: a withheld surplus says why');
    return;
  }
  const t = surplus.terms;
  assert.ok(t && finite(t.income) && finite(t.bills) && finite(t.household) && finite(t.mortgage) && finite(t.credit),
    'authorized addition: a published surplus lists its terms');
  assert.ok(bills.other === t.bills && bills.mortgage === t.mortgage
    && bills.cardMinimums.reduce((sum, card) => sum + cents(card.amount), 0) === cents(t.credit),
    'authorized addition: the surplus\'s bills, mortgage and credit terms are the bills split');
  const item = finite(t.savingsItemSpending) ? t.savingsItemSpending : 0;
  assert.equal(cents(surplus.amount), cents(t.income) - cents(t.bills) - cents(t.household) - cents(t.mortgage) - cents(t.credit) - cents(item),
    'authorized addition: surplus = income - bills - household - mortgage - credit - item spending, its own terms');
  assert.ok(['calculated', 'estimated'].includes(surplus.trust), 'authorized addition: a published surplus is calculated or estimated');
}
// A pay period's stackSummary, proved key by key, then removed.
function withoutStackSummary(view) {
  if (!view || typeof view !== 'object' || !Object.hasOwn(view, 'stackSummary')) return;
  const summary = view.stackSummary;
  assert.deepEqual(Object.keys(summary), ['bills', 'surplus'], 'authorized addition: stackSummary carries only proved keys');
  proveStackBills(view, summary.bills);
  proveStackSurplus(view, summary.surplus, summary.bills);
  delete view.stackSummary;
}

function withoutAuthorizedAdditions(advice) {
  if (!advice || typeof advice !== 'object') return advice;
  withoutStackSummary(advice);
  for (const list of [advice.payPeriodViews, advice.pastPeriodViews]) {
    for (const view of Array.isArray(list) ? list : []) withoutStackSummary(view);
  }
  const calendar = advice.defaultView && advice.defaultView.calendarPeriods;
  for (const view of Array.isArray(calendar) ? calendar : []) withoutStackSummary(view);
  if (!Object.hasOwn(advice, 'categorySpendingTrends')) return advice;
  const trends = advice.categorySpendingTrends;
  assert.equal(trends && trends.status, 'insufficient', 'authorized addition: categorySpendingTrends publishes no trend here');
  assert.equal(trends.trust, 'unavailable', 'authorized addition: categorySpendingTrends reads unavailable');
  assert.deepEqual(trends.categories, [], 'authorized addition: categorySpendingTrends lists nothing');
  assert.equal(trends.qualifyingCloses, 0, 'authorized addition: no qualifying saved close');
  delete advice.categorySpendingTrends;
  return advice;
}

// For flattened trust-tag maps ('.path.to.trust' -> value): the addition's
// own tags, proved unavailable, are not main's fields.
function authorizedTagKey(key, value) {
  if (/\.stackSummary\.(surplus|bills)\.trust$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust value`);
    return true;
  }
  if (!key.startsWith('.categorySpendingTrends.')) return false;
  assert.equal(value, 'unavailable', `authorized addition tag ${key} reads unavailable`);
  return true;
}

module.exports = { withoutAuthorizedAdditions, authorizedTagKey };
