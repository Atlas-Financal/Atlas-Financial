'use strict';
// The Forecast output behind test/browser-pending-lookalike.js, without a
// browser: a pending row that only looks like a posted one (same date,
// account, amount and merchant) leaves its category's spent at the posted
// side counted once but tags it estimated (trust 'estimated', plannedTrust
// 'calculated', estimateReason 'possible-duplicate'), with both rows in the
// category's listing; a lone pending row, two posted purchases and an
// unrelated category are unchanged. Invented household from
// test/acceptance/harness.js; no household figure.
//
//   node test/test-pending-lookalike.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

function observation(extra) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })]
    .concat(extra.map(H.lm));
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  const budgetRows = actuals => {
    const view = F.recommend(data.plan, data.meta.asOf, { currentPeriodActuals: actuals, debts: data.debts }).defaultView;
    const period = (view.calendarPeriods || []).find(p => p.id === 'this-pay-period');
    assert.ok(period, 'positive control: the current pay period is published');
    return id => period.householdBudget.find(r => r.id === id);
  };
  return { packet, budgetRows };
}

function rows(extra) {
  const { packet, budgetRows } = observation(extra);
  return budgetRows(packet);
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
}

const cafe = { date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe' };
const independentAuth = 'invented-cafe-visible-auth';
const otherAuth = 'invented-cafe-replaced-auth';
const pendingCafe = { ...cafe, pending: true, raw: { plaid_metadata: { transaction_id: independentAuth } } };
function postedCafe(predecessor, extra = {}) {
  const identity = { transaction_id: 'invented-cafe-posting', pending_transaction_id: predecessor, ...extra };
  return { ...cafe, raw: { plaid_metadata: identity } };
}

check('a different affirmative predecessor preserves both equal purchases on live and replayed packets', () => {
  const { packet, budgetRows } = observation([{ ...postedCafe(otherAuth), originalName: 'INVENTED-CAFE' }, pendingCafe]);
  const pending = packet.transactions.find(row => row.pending && row.amount === 6.5);
  const posted = packet.transactions.find(row => row.pending === false && row.amount === 6.5);
  assert.match(pending.id, /^tx-\d+$/);
  assert.equal(posted.distinctPendingId, pending.id, 'only the exact packet-local peer is named');
  const replay = JSON.stringify(packet);
  for (const nativeId of [independentAuth, otherAuth, 'invented-cafe-posting']) {
    assert.ok(!replay.includes(nativeId), 'native Plaid identities stay private');
  }
  for (const actuals of [packet, JSON.parse(replay)]) {
    const eating = budgetRows(actuals)('restaurants');
    // Two independent purchases: 6.50 + 6.50 = 13.00. From 100 leaves 87.
    assert.equal(eating.spent, 13);
    assert.equal(eating.remaining, 87);
    assert.equal(eating.estimateReason, undefined);
    assert.equal(eating.recon.length, 2);
    assert.ok(eating.recon.every(row => row.pendingPostedDuplicate !== true));
  }
  posted.distinctPendingId = 'tx-999';
  assert.equal(budgetRows(packet)('restaurants').estimateReason, 'possible-duplicate',
    'a statement about another row cannot establish distinctness for this pair');
});

check('a directed replacement drops its authorization and takes the posted amount once', () => {
  const eating = rows([pendingCafe, { ...postedCafe(independentAuth), amount: 7.25 }])('restaurants');
  // One purchase: the 6.50 authorization clears as 7.25. 100 - 7.25 = 92.75.
  assert.equal(eating.spent, 7.25);
  assert.equal(eating.remaining, 92.75);
  assert.deepEqual(eating.recon.map(row => [row.amount, row.pending === true]), [[7.25, false]]);
});

check('posting one authorization leaves another equal pending purchase after collapse', () => {
  const earlierAuth = { ...pendingCafe, raw: { plaid_metadata: { transaction_id: otherAuth } } };
  const eating = rows([earlierAuth, pendingCafe, postedCafe(otherAuth)])('restaurants');
  // Three feed rows but only two purchases: 6.50 posted + 6.50 independent.
  assert.equal(eating.spent, 13);
  assert.equal(eating.recon.length, 2);
  assert.ok(eating.recon.every(row => row.pendingPostedDuplicate !== true));
});

check('missing, malformed or conflicting predecessors leave the look-alike unresolved', () => {
  const different = postedCafe(otherAuth);
  for (const posted of [
    postedCafe(undefined),
    postedCafe(true),
    postedCafe(otherAuth, { transaction_id: independentAuth }),
    postedCafe(otherAuth, { transaction: { pending_transaction_id: independentAuth } }),
    { ...different, raw: { ...different.raw, pending_transaction_id: independentAuth } },
    { ...different, raw: { ...different.raw, plaidMetadata: { pending_transaction_id: independentAuth } } },
  ]) {
    const eating = rows([pendingCafe, posted])('restaurants');
    // Pending remains listed but unconfirmed. Posted 6.50 leaves 93.50.
    assert.equal(eating.spent, 6.5);
    assert.equal(eating.remaining, 93.5);
    assert.equal(eating.estimateReason, 'possible-duplicate');
    assert.equal(eating.recon.length, 2);
    assert.ok(eating.recon.every(row => row.pendingPostedDuplicate === true));
  }
});

check('a directed ID cannot collapse an authorization when the other row has unknown posting state', () => {
  const directed = postedCafe(independentAuth);
  const { packet, budgetRows } = observation([pendingCafe, { ...directed, raw: { ...directed.raw, is_pending: null } }]);
  assert.deepEqual(packet.transactions.filter(row => row.amount === 6.5).map(row => [row.savingsPostingEvidence, row.pendingPostedDuplicate]),
    [['pending', true], ['unknown', true]]);
  assert.equal(budgetRows(packet)('restaurants').spent, null, 'neither row proves a posted total');
});

check('a pending look-alike tags its category spent estimated and keeps both rows listed', () => {
  const row = rows([cafe, { ...cafe, pending: true }]);
  const eating = row('restaurants');
  assert.equal(eating.spent, 6.5, 'the posted side counts once');
  assert.equal(eating.remaining, 93.5);
  assert.equal(eating.trust, 'estimated');
  assert.equal(eating.plannedTrust, 'calculated', 'the plan keeps its own trust');
  assert.equal(eating.estimateReason, 'possible-duplicate');
  assert.equal(eating.hold, 100, 'the hold keeps the plan');
  assert.deepEqual(eating.recon.map(r => [r.amount, r.pending === true, r.pendingPostedDuplicate === true]),
    [[6.5, false, true], [6.5, true, true]]);
  const groceries = row('groceries');
  assert.equal(groceries.spent, 0, 'an unrelated category keeps its precise spent');
  assert.equal(groceries.trust, undefined);
});
check('control: a lone pending purchase is counted as before', () => {
  const eating = rows([{ ...cafe, pending: true }])('restaurants');
  assert.equal(eating.spent, 6.5);
  assert.equal(eating.remaining, 93.5);
  assert.equal(eating.trust, undefined);
});
check('control: two posted purchases at the same merchant are counted, not estimated', () => {
  const eating = rows([cafe, { ...cafe }])('restaurants');
  assert.equal(eating.spent, 13);
  assert.equal(eating.trust, undefined);
});

// Builder self-check (lead, 2026-11-11): equal timestamp, repeat, fixed
// context, through the real observer -> live overlay -> Forecast path.
// Forecast pairs a look-alike only one-to-one (pendingPostedDuplicateIdSet);
// with any extra same-key row the pairing is ambiguous and nothing is paired,
// so every row is counted (it can only overstate) and nothing is marked. That
// incumbent rule is unchanged here and identical on main; these pin it.
check('equal timestamp: two pending look-alikes of one posted row are ambiguous, all counted, unmarked', () => {
  const eating = rows([cafe, { ...cafe, pending: true }, { ...cafe, pending: true }])('restaurants');
  assert.equal(eating.spent, 19.5, '6.50 x 3: nothing paired, nothing hidden');
  assert.equal(eating.trust, undefined, 'no possible-duplicate mark without a one-to-one pair');
  assert.equal(eating.recon.length, 3, 'every row listed');
  assert.ok(eating.recon.every(r => r.pendingPostedDuplicate !== true));
});
check('repeat: two posted purchases with two pending look-alikes are ambiguous, all counted, unmarked', () => {
  const eating = rows([cafe, { ...cafe }, { ...cafe, pending: true }, { ...cafe, pending: true }])('restaurants');
  assert.equal(eating.spent, 26, '6.50 x 4');
  assert.equal(eating.trust, undefined);
  assert.equal(eating.recon.length, 4);
});
check('consecutive days: a look-alike on Oct 11 does not mark a different-day purchase in another category', () => {
  const row = rows([cafe, { ...cafe, pending: true },
    { date: '2026-10-12', amount: 20, category: 'Groceries', payee: 'Invented grocer' }]);
  assert.equal(row('groceries').spent, 20);
  assert.equal(row('groceries').trust, undefined, 'unrelated category stays precise');
  assert.equal(row('restaurants').trust, 'estimated');
});
check('fixed context: the same input observed twice publishes identical rows', () => {
  const input = [cafe, { ...cafe, pending: true }];
  const a = rows(input)('restaurants'), b = rows(input)('restaurants');
  assert.deepEqual(a, b);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
