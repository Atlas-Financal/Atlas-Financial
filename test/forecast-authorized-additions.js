'use strict';
// Forecast fields an exact-main (frozen engine) comparison cannot see,
// because main predates them. Each is PROVED in its empty state on the
// invented input first, then removed from the current-engine side, so the
// comparison still covers every other field. A comparison input that
// carries saved closes would fail the proof loudly instead of hiding a move.
//
//   categorySpendingTrends (Forecast.categorySpendingTrends, #1384): with no
//   qualifying saved close, no trend is published.
//   stackSummary (Stack Wallet, every pay period, set last by publishStackSummary):
//   income (A1) proves its three lines sum to the period's incomeTotal to the
//   cent and its total copies incomeTotal / incomeTrust, or that every line is
//   null and unavailable when incomeTotal is withheld. A later key (A2 surplus,
//   A6 cards) adds its own proof here before it is stripped.
const assert = require('node:assert/strict');

const INCOME_LINES = ['dale', 'amanda', 'other'];
function proveStackIncome(view, income) {
  if (typeof view.incomeTotal === 'number') {
    const cents = INCOME_LINES.reduce((c, k) => c + Math.round(income[k].amount * 100), 0);
    assert.equal(cents, Math.round(view.incomeTotal * 100), 'authorized addition: stackSummary.income sums to incomeTotal');
    assert.equal(income.total.amount, view.incomeTotal, 'authorized addition: stackSummary.income.total is incomeTotal');
  } else {
    for (const k of [...INCOME_LINES, 'total']) {
      assert.equal(income[k].amount, null, 'authorized addition: a withheld incomeTotal withholds stackSummary.income');
      assert.equal(income[k].trust, 'unavailable', 'authorized addition: a withheld line reads unavailable');
    }
  }
}
function withoutStackSummary(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'stackSummary') && Object.hasOwn(node, 'incomeTotal')) {
    assert.deepEqual(Object.keys(node.stackSummary), ['income'], 'authorized addition: stackSummary carries only proved keys');
    proveStackIncome(node, node.stackSummary.income);
    delete node.stackSummary;
  }
  for (const value of Object.values(node)) withoutStackSummary(value, seen);
}

function withoutAuthorizedAdditions(advice) {
  withoutStackSummary(advice);
  if (!advice || typeof advice !== 'object' || !Object.hasOwn(advice, 'categorySpendingTrends')) return advice;
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
  if (/\.stackSummary\.income\.(dale|amanda|other|total)\.trust$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (!key.startsWith('.categorySpendingTrends.')) return false;
  assert.equal(value, 'unavailable', `authorized addition tag ${key} reads unavailable`);
  return true;
}

module.exports = { withoutAuthorizedAdditions, authorizedTagKey };
