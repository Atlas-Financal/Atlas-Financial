'use strict';
/* C1 — a dropped household row must not leave transaction coverage 'complete'.
 *
 * Invented rows only. The observer drops a row whose amount or date cannot be
 * qualified. For any account that feeds household figures, that drop must
 * stamp the period's transaction coverage 'incomplete'; for accounts that do
 * not feed household figures (unmapped, external) it must not. Pagination
 * (truncated) keeps its own stamp, and a clean packet stays 'complete'.
 *
 * `node test/test-coverage-observer-stamp.js`
 */
const fs = require('fs');
const path = require('path');
const O = require('../scripts/provider-observe.js');

const ROOT = path.join(__dirname, '..');
const accountMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/connectivity/fixtures/provider-account-map.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const row = (id, extra) => O.normalizeLunchMoneyTransaction(Object.assign({
  id, account_id: 1001, date: '2026-08-14', amount: '12.50', currency: 'cad',
  is_pending: false, status: 'cleared', payee: 'Invented grocer', category_name: 'Groceries',
}, extra));
const packetFor = (txs, window) => O.sanitizedCurrentPeriodActuals({
  fetchedAt: '2026-08-16T18:00:00.000Z',
  transactionWindow: Object.assign({ startDate: '2026-08-01', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false }, window || {}),
  pendingCoverage: { complete: true },
  transactions: txs, collapsedTransactions: txs, representedEventCandidates: [],
}, { asOf: '2026-08-16', accountMap, plan: data.plan });

console.log('=== 1. control: clean packet stays complete ===');
{
  const p = packetFor([row(1)]);
  ok(p.transactionCoverage === 'complete' && p.transactions.length === 1, 'one valid household-cash row: complete, row kept');
}

console.log('\n=== 2. a dropped household row marks coverage incomplete ===');
{
  for (const [label, extra] of [
    ['unusable amount', { amount: 'unavailable' }],
    ['null amount', { amount: null }],
    ['missing date', { date: null }],
  ]) {
    const p = packetFor([row(1), row(2, extra)]);
    ok(p.transactionCoverage === 'incomplete' && p.transactions.length === 1,
      `household-cash row with ${label} is dropped and coverage reads incomplete`, p.transactionCoverage);
  }
  const card = packetFor([row(3, { account_id: 2001, amount: 'unavailable' })]);
  ok(card.transactionCoverage === 'incomplete', 'a dropped revolving-credit row also marks incomplete');
  const heloc = packetFor([row(4, { account_id: 2002, date: null })]);
  ok(heloc.transactionCoverage === 'incomplete', 'a dropped HELOC row also marks incomplete');
}

console.log('\n=== 2b. a dropped row that provably lies outside the window does not degrade coverage ===');
{
  const early = packetFor([row(1), row(6, { date: '2026-07-01', amount: 'unavailable' })]);
  ok(early.transactionCoverage === 'complete', 'a row dated before the window start is out of scope', early.transactionCoverage);
  const late = packetFor([row(1), row(7, { date: '2026-09-30', amount: 'unavailable' })]);
  ok(late.transactionCoverage === 'complete', 'a row dated after the window end is out of scope', late.transactionCoverage);
  const inside = packetFor([row(1), row(8, { date: '2026-08-01', amount: 'unavailable' })]);
  ok(inside.transactionCoverage === 'incomplete', 'a row dated on the window start day is in scope', inside.transactionCoverage);
}

console.log('\n=== 3. accounts that feed no household figure do not degrade coverage ===');
{
  const unmappedRow = row(5, { account_id: 9999, amount: 'unavailable' });
  const p = packetFor([row(1), unmappedRow]);
  ok(p.transactionCoverage === 'complete', 'a dropped row on an unmapped account leaves coverage complete (no household figure uses it)', p.transactionCoverage);
}

console.log('\n=== 4. pagination keeps its own stamp ===');
{
  const t = packetFor([row(1), row(2, { amount: 'unavailable' })], { truncated: true, hasMore: true, complete: false });
  ok(t.transactionCoverage === 'truncated', 'a truncated window stays truncated even with a dropped row', t.transactionCoverage);
}

console.log('\n=== 5. N2: per-account sync evidence feeds the stamp ===');
{
  const acct = (id, extra) => O.normalizeLunchMoneyAccount(Object.assign({ id, name: 'Invented ' + id, type: 'cash', balance: '10.00', currency: 'cad' }, extra));
  const withAccounts = (accounts, txs) => O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-01', endDate: '2026-08-16', complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true }, accounts,
    transactions: txs || [row(1)], collapsedTransactions: txs || [row(1)], representedEventCandidates: [],
  }, { asOf: '2026-08-16', accountMap, plan: data.plan });
  const byId = (p, id) => (p.syncEvidence || []).find(r => r.id === id);

  const proven = withAccounts([acct(1001, { last_fetch: '2026-08-16T15:00:00Z' })]);
  ok(proven.transactionCoverage === 'complete' && byId(proven, 'chequing-a').syncEvidence === 'proven',
    'a sync timestamp on the window end day is proven; coverage stays complete');

  const stale = withAccounts([acct(1001, { last_fetch: '2026-08-13T15:00:00Z' })]);
  ok(stale.transactionCoverage === 'incomplete' && byId(stale, 'chequing-a').syncEvidence === 'failed',
    'a sync older than the window end day is failed and the stamp reads incomplete');

  const sinceSuccess = withAccounts([acct(1001, { last_fetch: '2026-08-16T15:00:00Z', plaid_last_successful_update: '2026-08-10T15:00:00Z' })]);
  ok(byId(sinceSuccess, 'chequing-a').syncEvidence === 'failed',
    'the last SUCCESSFUL update is preferred over the last fetch attempt');

  for (const status of ['error', 'relink', 'inactive']) {
    const bad = withAccounts([acct(2001, { type: 'credit', status, last_fetch: '2026-08-16T15:00:00Z' })]);
    ok(bad.transactionCoverage === 'incomplete' && byId(bad, 'tdcc').syncEvidence === 'failed',
      `a card reporting status "${status}" is failed even with a current fetch`);
  }

  const oldStatementOnly = withAccounts([acct(2001, { type: 'credit', balance_last_update: '2026-07-20', balance_as_of: '2026-07-20', updated_at: '2026-07-20T00:00:00Z', last_fetch: '2026-08-16T15:00:00Z' })]);
  ok(oldStatementOnly.transactionCoverage === 'complete' && byId(oldStatementOnly, 'tdcc').syncEvidence === 'proven',
    'an old statement balance date alone is not a sync failure when the sync itself is current');

  const absent = withAccounts([acct(1001, { updated_at: '2026-08-01T00:00:00Z', balance_last_update: '2026-08-01' })]);
  ok(absent.transactionCoverage === 'complete' && byId(absent, 'chequing-a').syncEvidence === 'absent',
    'no sync field at all is absent: coverage stays complete as on main, and the qualifier says so');
  ok(JSON.stringify(byId(absent, 'chequing-a').fields) === JSON.stringify({ last_fetch: false, plaid_last_successful_update: false, status: false }),
    'the recorded shape lists which sync fields were present, as booleans');

  const present = withAccounts([acct(1001, { status: 'active', last_fetch: '2026-08-16T15:00:00Z' })]);
  const shape = byId(present, 'chequing-a');
  ok(JSON.stringify(shape.fields) === JSON.stringify({ last_fetch: true, plaid_last_successful_update: false, status: true }),
    'present fields are recorded by name and boolean');
  ok(!/2026-08|active|T15:00/.test(JSON.stringify(present.syncEvidence)), 'no timestamp or status value appears in the sync evidence');

  const external = withAccounts([acct(9999, { last_fetch: '2026-07-01T00:00:00Z' })]);
  ok(external.transactionCoverage === 'complete' && (external.syncEvidence || []).length === 0,
    'an unmapped account contributes no sync evidence and cannot degrade coverage');

  const truncated = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-08-16T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-01', endDate: '2026-08-16', complete: false, hasMore: true, truncated: true },
    pendingCoverage: { complete: true }, accounts: [acct(1001, { last_fetch: '2026-08-10T00:00:00Z' })],
    transactions: [row(1)], collapsedTransactions: [row(1)], representedEventCandidates: [],
  }, { asOf: '2026-08-16', accountMap, plan: data.plan });
  ok(truncated.transactionCoverage === 'truncated', 'pagination truncation still takes precedence over a failed sync');
}

console.log('\n=== 6. end to end through observe(): the account sync fields reach the stamp ===');
{
  const clone = x => JSON.parse(JSON.stringify(x));
  const base = require('./fixtures/salary-diagnostic-data').input();
  const run = patch => {
    const x = clone(base);
    for (const a of x.payload.accounts) Object.assign(a, patch(a));
    return O.observe(x).currentPeriodActuals;
  };
  const day = (base.payload.fetchedAt || '').slice(0, 10);
  const current = run(() => ({ last_fetch: day + 'T12:00:00Z' }));
  ok(current.transactionCoverage === 'complete' && (current.syncEvidence || []).some(r => r.syncEvidence === 'proven'),
    'accounts with a current sync: the observer packet is complete and records proven evidence', current.transactionCoverage);
  const stale = run(() => ({ last_fetch: '2026-01-02T12:00:00Z' }));
  ok(stale.transactionCoverage === 'incomplete' && stale.syncEvidence.some(r => r.syncEvidence === 'failed'),
    'accounts whose last sync is long before the window end: the observer packet reads incomplete', stale.transactionCoverage);
  const none = run(() => ({}));
  ok(none.transactionCoverage === 'complete' && none.syncEvidence.every(r => r.syncEvidence === 'absent'),
    'accounts with no sync field: complete, every qualifier absent');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
