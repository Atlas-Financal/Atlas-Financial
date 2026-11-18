'use strict';
/* Lunch Money v2 group parents (lead dispatch 2026-11-18, v1/v2 field check
 * item 2). Spec 2.11.2: a group parent's plaid_account_id and
 * manual_account_id are null (POST /transactions/group example); only its
 * children, returned with include_children=true, carry accounts. Before this
 * change the parent was served as an unmapped-account row, transaction coverage
 * read incomplete, and every category's remaining amount went unavailable.
 * The parent now takes the one account all its children record; anything else
 * fails closed (unmapped).
 *
 * Invented data only (test/acceptance/harness.js).
 *
 *   node test/test-lunchmoney-group-parent-account.js
 */
const { isDeepStrictEqual } = require('node:util');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const O = require('../scripts/provider-observe.js');
const F = require('../public/forecast.js');
const ObservationMemory = require('../scripts/server-observation-memory.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const CHEQUING = 9001;
const PLANTED = 'PLANTED CHILD PAYEE QZV';
const kid = (id, plaid, manual = null) => ({ id, date: '2026-10-11', amount: '20.00', currency: 'cad', payee: PLANTED,
  notes: PLANTED, original_name: PLANTED, plaid_account_id: plaid, manual_account_id: manual });

const keep = transactions => ObservationMemory.sourceInputs({ provider: 'lunchmoney', fetchedAt: '2026-10-14T18:00:00.000Z',
  accounts: [], categories: [], tags: [], transactions,
  transactionWindow: { startDate: '2026-09-30', endDate: '2026-10-14', complete: true, hasMore: false, truncated: false },
  pendingCoverage: { complete: true, hasMore: false, truncated: false, basis: 'is_pending-unbounded' } });
function serve(row, { replay = false } = {}) {
  const w = H.baseWorld('2026-10-14');
  w.transactions = [H.lm({ id: 659999, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  let payload = H.rawPayload(w);
  payload.transactions = payload.transactions.concat(row ? [row] : []);
  // replay: the transactions as replay memory retains them.
  if (replay) payload = { ...payload, transactions: keep(payload.transactions).transactions };
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const a = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, F.budgetAsOf(r.data), F.budgetRecommendInputs(r.data, {}));
  return { data: r.data, actuals: a, cpa: adv.currentPeriodAction,
    tx: a && a.transactions.filter(t => t.date === '2026-10-11') };
}
// A grouped purchase and refund: $40 out, $25 back, a $15 group parent.
const base = H.lm({ id: 7001, date: '2026-10-11', amount: 15, category: 'Groceries', account: 'chequing-a', payee: 'Invented grocer' });
const v1 = { ...base, is_group: true };
const v2 = children => ({ ...base, is_group_parent: true, plaid_account_id: null, manual_account_id: null,
  ...(children ? { children } : {}) });

console.log('1. Both transaction reads ask for children');
{
  const hist = O.lunchMoneyTransactionsUrl('2026-10-14T18:00:00Z', 14);
  const pend = O.lunchMoneyPendingUniverseUrl();
  ok(hist.searchParams.get('include_children') === 'true', 'the history read sets include_children=true', hist.search);
  ok(pend.searchParams.get('include_children') === 'true', 'the pending read sets include_children=true', pend.search);
}

console.log('2. Reproduced on the old shape: a v2 group parent with no children is unmapped and blanks the remaining amounts');
{
  const s = serve(v2(null));
  ok(s.tx.length === 1 && s.tx[0].accountRole === 'unmapped', 'served as unmapped', JSON.stringify(s.tx.map(t => t.accountRole)));
  ok(s.actuals.transactionCoverage === 'incomplete' && s.cpa.categoryRemainingClaim === 'unavailable',
    'coverage incomplete, remaining unavailable (fail closed)');
}

console.log('3. A v2 group parent whose children share one account is served exactly as the v1 group parent');
{
  const old = serve(v1), now = serve(v2([kid(7002, CHEQUING), kid(7003, CHEQUING)]));
  ok(now.tx.length === 1 && now.tx[0].accountRole === 'household-cash' && now.tx[0].isGroup === true,
    'one row, household cash, still a group', JSON.stringify(now.tx.map(t => [t.accountRole, t.isGroup])));
  ok(now.actuals.transactionCoverage === 'complete' && now.cpa.categoryRemainingClaim === 'precise', 'coverage complete, remaining precise');
  ok(isDeepStrictEqual(old.data, now.data), 'the whole served data is deep-equal to the v1 shape');
  ok(!JSON.stringify(now.data).includes(PLANTED), 'no child payee, note or description reaches served data');
  const norm = row => O.normalizeLunchMoneyTransaction(row, new Map(), new Map()).providerAccountId;
  ok(norm(v2([kid(7002, null, 4401), kid(7003, null, 4401)])) === '4401', 'manual-account children give the parent their manual account');
  ok(norm({ ...v2([kid(7002, CHEQUING)]), plaid_account_id: 5555 }) === '5555', 'a parent that records its own account keeps it');
}

console.log('4. Any doubt keeps the parent without an account (unmapped, fail closed)');
for (const [why, children] of [
  ['no children', []],
  ['children on two accounts', [kid(7002, CHEQUING), kid(7003, 9002)]],
  ['a child with no account', [kid(7002, CHEQUING), kid(7003, null)]],
  ['a child with both accounts', [kid(7002, CHEQUING), kid(7003, CHEQUING, 4401)]],
  ['plaid and manual ids that are equal numbers', [kid(7002, 9001), kid(7003, null, 9001)]],
]) {
  const s = serve(v2(children));
  ok(s.tx.length === 1 && s.tx[0].accountRole === 'unmapped', why + ': unmapped', JSON.stringify(s.tx.map(t => t.accountRole)));
}
{
  const notGroup = serve({ ...base, plaid_account_id: null, manual_account_id: null, children: [kid(7002, CHEQUING)] });
  ok(notGroup.tx[0].accountRole === 'unmapped', 'children on a row that is not a group parent are ignored');
}

console.log('5. Replay memory keeps only the children\'s ids and account ids, and replays deep-equal');
{
  const row = v2([kid(7002, CHEQUING), kid(7003, CHEQUING)]);
  const kept = keep([row]);
  const children = kept.transactions[0].children;
  ok(isDeepStrictEqual(children, [{ id: 7002, plaid_account_id: CHEQUING, manual_account_id: null },
    { id: 7003, plaid_account_id: CHEQUING, manual_account_id: null }]), 'children projected to id and account ids', JSON.stringify(children));
  ok(!JSON.stringify(kept).includes(PLANTED), 'no child payee, note or description is retained');
  let threw = false;
  try { keep([{ ...row, children: { id: 1 } }]); } catch (_) { threw = true; }
  ok(threw, 'a children value that is not a list is refused');
  const live = serve(row), replayed = serve(row, { replay: true });
  ok(isDeepStrictEqual(live.data, replayed.data), 'the replayed served data is deep-equal (memory would be stored)');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money group parent account checks passed.');
