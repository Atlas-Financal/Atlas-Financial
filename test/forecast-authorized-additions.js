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
//   null and unavailable when incomeTotal is withheld. A later key (A6
//   cards) adds its own proof here before it is stripped.
//     bills (A2): the bill total split into mortgage, card minimums and
//     other, proved to sum to the period's periodBillLoad, or every part
//     null and unavailable;
//     surplus (A2): income − other bills − household − mortgage − credit −
//     item spending, proved against its own terms and the bills split here,
//     and on unmodified output to equal Balance After Deductions plus its
//     held outflows and card payments beyond the minimum;
//     savings (A5): each goal's planned amount beside what moved, proved by
//     proveStackSavings below.
//   billHistory (Stack Wallet bill sheet): each bill's past and current
//   occurrences, proved against the published bill rows by proveBillHistory.
//   paidState (Stack Wallet A3, Forecast.billPaidState): each published bill
//   row's Paid / Not paid word. Presentation only; proved one of its three
//   words, then removed wherever a published row carries it.
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
    assert.deepEqual(Object.keys(node.stackSummary), ['income', 'bills', 'surplus', 'savings'], 'authorized addition: stackSummary carries only proved keys');
    proveStackIncome(node, node.stackSummary.income);
    proveStackBills(node, node.stackSummary.bills);
    proveStackSurplus(node, node.stackSummary.surplus, node.stackSummary.bills);
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

// billHistory (Stack Wallet, bill sheet): proved against the published bill
// rows it copies, then removed. Every entry is one published period row with
// the same id and date, never a carried copy, listed once, in date order newest
// first. Its amount follows the row's own displayAmountBasis (a linked actual
// or the scheduled amount, never mixed), with null exactly when trust is
// unavailable. Its occurrence is that row's identity. Every period's
// non-carried dated row (past, current and future) is listed. Run before withoutBillPaidState, which removes the rows' paidState.
const BILL_HISTORY_TRUST_WORDS = new Set(['calculated', 'estimated', 'unknown', 'unavailable']);
// Forecast's occurrence identity, as the history keys it: the row's
// occurrenceKey (id@scheduledDate) when it publishes one, else its id and
// date (or scheduledDate).
const billOccurrenceOf = row => (typeof row.occurrenceKey === 'string' && row.occurrenceKey.startsWith(row.id + '@')
  ? row.occurrenceKey : row.id + '@' + (typeof row.scheduledDate === 'string' && row.scheduledDate ? row.scheduledDate : row.date));
function proveBillHistory(advice) {
  const history = advice.billHistory;
  assert.ok(history && typeof history === 'object' && !Array.isArray(history), 'authorized addition: billHistory is a map of bill id to occurrences');
  const rows = new Map();
  const occurrences = new Set();
  for (const view of Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : []) {
    if (!view) continue;
    for (const row of Array.isArray(view.bills) ? view.bills : []) {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.date !== 'string' || row.paidState === 'carried') continue;
      const key = row.id + '@' + row.date;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(row);
      occurrences.add(billOccurrenceOf(row));
    }
  }
  const listed = new Set();
  for (const [id, list] of Object.entries(history)) {
    assert.ok(Array.isArray(list) && list.length, `authorized addition: billHistory.${id} lists occurrences`);
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      assert.deepEqual(Object.keys(entry), ['date', 'amount', 'amountBasis', 'trust', 'paidState', 'occurrence'], `authorized addition: billHistory.${id} entry shape`);
      if (i) assert.ok(list[i - 1].date >= entry.date, `authorized addition: billHistory.${id} is newest first`);
      const candidates = rows.get(id + '@' + entry.date) || [];
      const row = candidates.find(r => r.paidState === entry.paidState && !listed.has(billOccurrenceOf(r)));
      assert.ok(row, `authorized addition: billHistory.${id}@${entry.date} copies a published row of an occurrence not already listed`);
      const actual = row.displayAmountBasis === 'posted-actual' || row.displayAmountBasis === 'unconfirmed-actual';
      assert.equal(entry.amountBasis, actual ? row.displayAmountBasis : 'schedule', `authorized addition: billHistory.${id}@${entry.date} basis is the row's`);
      const raw = actual ? row.actual : row.amount;
      const expected = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(Math.abs(raw) * 100) / 100 : null;
      assert.equal(entry.amount, expected, `authorized addition: billHistory.${id}@${entry.date} amount is the basis amount`);
      assert.ok(BILL_HISTORY_TRUST_WORDS.has(entry.trust), `authorized addition: billHistory.${id}@${entry.date} trust is a trust word`);
      const carriedTrust = ['calculated', 'estimated'].includes(row.displayAmountTrust) ? row.displayAmountTrust : 'unknown';
      assert.equal(entry.trust, expected === null ? 'unavailable' : carriedTrust,
        `authorized addition: billHistory.${id}@${entry.date} trust is the row's display trust (an unrecognised word reads unknown)`);
      assert.equal(entry.amount === null, entry.trust === 'unavailable', `authorized addition: billHistory.${id}@${entry.date} null amount iff unavailable`);
      assert.equal(entry.occurrence, billOccurrenceOf(row), `authorized addition: billHistory.${id}@${entry.date} occurrence is the row's identity`);
      listed.add(billOccurrenceOf(row));
    }
  }
  // Each published occurrence (by identity, so a statement's moved date and
  // the saved close's original date are one) is listed exactly once.
  for (const key of occurrences) assert.ok(listed.has(key), `authorized addition: billHistory lists the published occurrence ${key}`);
  assert.equal(listed.size, Object.values(history).reduce((n, list) => n + list.length, 0), 'authorized addition: one entry per occurrence');
}

function withoutAuthorizedAdditions(advice) {
  if (!advice || typeof advice !== 'object') return advice;
  withoutStackSummary(advice);
  if (Object.hasOwn(advice, 'billHistory')) {
    proveBillHistory(advice);
    delete advice.billHistory;
  }
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
  if (/\.stackSummary\.income\.(dale|amanda|other|total)\.trust$/.test(key) || /\.stackSummary\.(surplus|bills)\.trust$/.test(key)
    || /\.stackSummary\.savings\.(items\.\d+\.(trust|savedTrust)|totals\.(trust|entitlementTrust))$/.test(key)) {
    assert.ok(['calculated', 'estimated', 'unavailable'].includes(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (/^\.billHistory\.[^.]+\.\d+\.trust$/.test(key)) {
    assert.ok(BILL_HISTORY_TRUST_WORDS.has(value), `authorized addition tag ${key} is a trust word`);
    return true;
  }
  if (!key.startsWith('.categorySpendingTrends.')) return false;
  assert.equal(value, 'unavailable', `authorized addition tag ${key} reads unavailable`);
  return true;
}

module.exports = { withoutAuthorizedAdditions, authorizedTagKey };
