'use strict';
/* The private observation-memory projection must preserve every account field the observer
 * consumes, or the server's replay differs from the live evaluation and never retains evidence
 * (then settlement acquisition has nothing to use). #847 made the observer consume the account
 * sync fields `last_fetch`, `plaid_last_successful_update` and `status`.
 *
 * Invented data only. `node test/test-observation-memory-sync-fields.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Fixture = require('./fixtures/budget-surface-data');
const Memory = require('../scripts/server-observation-memory');
const Observer = require('../scripts/provider-observe');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log('  PASS  ' + label); };

const canonical = Fixture.canonical();
const identity = JSON.parse(fs.readFileSync(Observer.DEFAULT_IDENTITY, 'utf8'));
const observe = payload => Observer.observe({ provider: 'lunchmoney', data: canonical, payload,
  accountMap: { ...Fixture.map, scope: 'live' }, identity });
const withSync = patch => {
  const payload = structuredClone(Fixture.payload());
  payload.tags = payload.tags || [];
  for (const account of payload.accounts) Object.assign(account, patch);
  return payload;
};

const SYNC = ['last_fetch', 'plaid_last_successful_update', 'status'];
console.log('=== projection keeps the sync fields ===');
{
  const payload = withSync({ last_fetch: '2026-01-02T12:00:00Z', plaid_last_successful_update: '2026-01-02T12:00:00Z', status: 'active' });
  const projected = Memory.sourceInputs(payload);
  for (const field of SYNC) {
    ok(projected.accounts.every(row => row[field] === payload.accounts.find(a => a.id === row.id)[field]),
      `${field} survives the source projection`);
  }
}

console.log('\n=== replay equals the live evaluation, for each sync state ===');
for (const [name, patch] of [
  ['stale last_fetch', { last_fetch: '2026-01-02T12:00:00Z' }],
  ['current last_fetch', { last_fetch: Fixture.payload().fetchedAt }],
  ['failed status', { status: 'error' }],
  ['stale last successful update', { plaid_last_successful_update: '2026-01-02T12:00:00Z' }],
  ['yesterday success and newer fetch', { plaid_last_successful_update: '2026-08-19T16:45:00Z', last_fetch: Fixture.payload().fetchedAt }],
  ['old success and newer fetch', { plaid_last_successful_update: '2025-08-18T18:30:00Z', last_fetch: Fixture.payload().fetchedAt }],
  ['unreadable sync fields', { plaid_last_successful_update: 'not-a-date', last_fetch: 'not-a-date' }],
  ['no sync field', {}],
]) {
  const payload = withSync(patch);
  const live = observe(payload).currentPeriodActuals;
  const replay = observe(Memory.sourceInputs(payload)).currentPeriodActuals;
  assert.deepEqual(replay, live, `${name}: replay must equal the live packet`); checks++;
  ok(replay.transactionCoverage === live.transactionCoverage
      && JSON.stringify(replay.syncEvidence) === JSON.stringify(live.syncEvidence),
    `${name}: the replayed packet carries the same coverage stamp and sync evidence`);
}

console.log(`\nALL CHECKS PASSED (${checks})`);
