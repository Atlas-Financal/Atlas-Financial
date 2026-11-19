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
//   null and unavailable when incomeTotal is withheld. savings (A5) is proved
//   by proveStackSavings below. A later key (A2 surplus, A6 cards) adds its
//   own proof here before it is stripped.
//   paidState (Stack Wallet A3, Forecast.billPaidState): each published bill
//   row's Paid / Not paid word. Presentation only; proved one of its three
//   words, then removed wherever a published row carries it.
const assert = require('node:assert/strict');

const INCOME_LINES = ['dale', 'amanda', 'other'];
function proveStackIncome(view, income) {
  if (view.capturedClose && typeof view.incomeTotal === 'number') {
    // A saved close: its total stands as saved; the lines are withheld (the archive keeps no income class).
    assert.equal(income.total.amount, view.incomeTotal, 'authorized addition: a saved close keeps its income total');
    for (const k of INCOME_LINES) {
      assert.equal(income[k].amount, null, 'authorized addition: a saved close withholds the income lines');
      assert.equal(income[k].trust, 'unavailable', 'authorized addition: a withheld line reads unavailable');
    }
  } else if (typeof view.incomeTotal === 'number') {
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
// A5: stackSummary.savings. A goal's saved is the current period's transfers
// attributed by the owner's nearest-due rule, summing to them, or null; needed is a number with a trust word or null
// and unavailable; totals.needed is the cent sum of every goal's needed or
// null when any is missing; totals.saved and entitlement are pool-level
// together, or null; reasons come from the closed set.
const SAVINGS_REASONS = new Set(['no-per-goal-attribution', 'owner-rule:nearest-due-first', 'net-of-period-transfers', 'future-period', 'past-period',
  'planned-unavailable', 'planned-incomplete', 'pool-level', 'pool-transfer-unavailable']);
const isFigure = v => typeof v === 'number' && Number.isFinite(v);
function proveStackSavings(view, savings) {
  assert.ok(savings && Array.isArray(savings.items) && savings.totals, 'authorized addition: stackSummary.savings lists items and totals');
  for (const item of savings.items) {
    assert.ok(item.saved === null ? item.savedTrust === 'unavailable' && item.periodTarget === null
      : isFigure(item.saved) && ['calculated', 'estimated'].includes(item.savedTrust) && view.timelineRole === 'current',
    'authorized addition: a goal\'s saved is the current period\'s attributed transfers, or null');
    assert.ok(item.needed === null ? item.trust === 'unavailable' : isFigure(item.needed) && ['calculated', 'estimated'].includes(item.trust),
      'authorized addition: a savings goal\'s needed is a number with its trust, or null and unavailable');
    assert.ok(Array.isArray(item.reasons) && item.reasons.every(r => SAVINGS_REASONS.has(r)), 'authorized addition: savings reasons are closed');
  }
  const t = savings.totals;
  if (savings.items.length && savings.items.every(item => item.saved !== null)) {
    assert.equal(savings.items.reduce((c, item) => c + Math.round(item.saved * 100), 0), Math.round(t.saved * 100),
      'authorized addition: the goals\' saved sum to the period\'s transfers');
  }
  const missing = savings.items.filter(item => item.needed === null).map(item => item.id);
  assert.deepEqual(t.excluded, missing, 'authorized addition: totals.excluded names the goals without a needed');
  assert.equal(t.needed, savings.items.length && !missing.length
    ? savings.items.reduce((c, item) => c + Math.round(item.needed * 100), 0) / 100 : null,
  'authorized addition: totals.needed is the cent sum of every goal\'s needed, or null');
  assert.ok(t.completeness === 'pool-level' ? isFigure(t.saved) && isFigure(t.entitlement) : t.completeness === 'none' && t.saved === null && t.entitlement === null,
    'authorized addition: totals.saved and entitlement are pool-level together, or null');
  assert.ok(Array.isArray(t.reasons) && t.reasons.every(r => SAVINGS_REASONS.has(r)), 'authorized addition: savings totals reasons are closed');
}
function withoutStackSummary(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'stackSummary') && Object.hasOwn(node, 'incomeTotal')) {
    assert.deepEqual(Object.keys(node.stackSummary), ['income', 'savings'], 'authorized addition: stackSummary carries only proved keys');
    proveStackIncome(node, node.stackSummary.income);
    proveStackSavings(node, node.stackSummary.savings);
    delete node.stackSummary;
  }
  for (const value of Object.values(node)) withoutStackSummary(value, seen);
}


const PAID_STATES = new Set(['paid', 'not-paid', 'carried']);
function withoutBillPaidState(node, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Object.hasOwn(node, 'paidState') && Object.hasOwn(node, 'settlement')) {
    assert.ok(PAID_STATES.has(node.paidState), `authorized addition: bill paidState is one of three words (${node.paidState})`);
    delete node.paidState;
  }
  for (const value of Object.values(node)) withoutBillPaidState(value, seen);
}

function withoutAuthorizedAdditions(advice) {
  if (!advice || typeof advice !== 'object') return advice;
  withoutStackSummary(advice);
  withoutBillPaidState(advice);
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
  if (/\.stackSummary\.income\.(dale|amanda|other|total)\.trust$/.test(key)
    || /\.stackSummary\.savings\.(items\.\d+\.(trust|savedTrust)|totals\.(trust|entitlementTrust))$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (!key.startsWith('.categorySpendingTrends.')) return false;
  assert.equal(value, 'unavailable', `authorized addition tag ${key} reads unavailable`);
  return true;
}

module.exports = { withoutAuthorizedAdditions, authorizedTagKey };
