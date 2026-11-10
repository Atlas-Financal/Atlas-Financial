'use strict';
// Invented inputs only. Diagnostics name the failed evidence without changing
// the packet or qualification, and never serialize source fields or identifiers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const threads = require('node:worker_threads');
const D = require('../scripts/coverage-diagnostics');
const O = require('../scripts/provider-observe');
const Fixture = require('./fixtures/budget-surface-data');
const H = require('./test-server-observation-memory');
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

// The final log boundary reconstructs its own closed shape even if a caller
// accidentally passes source-shaped data. Unknown keys and invalid counts die.
const canary = 'SYNTHETIC-PRIVATE-CANARY';
eq(D.record({ 'posted-duplicate': 2, 'sync-evidence-stale': '3', amount: 123,
  payee: canary, id: canary, token: canary, 'dropped-row': -1 }), {
  type: 'live-refresh-coverage', reasons: { 'posted-duplicate': 2 },
}, 'only allowlisted integer counts reach the log');
eq(D.record({ 'posted-duplicate': Number.MAX_SAFE_INTEGER }).reasons['posted-duplicate'],
  1000000000, 'counts are bounded');
eq(D.record({}).reasons, {}, 'clean evidence has no invented failure');

for (const [code, mutate] of [
  ['posted-duplicate', p => p.transactions.push({ ...p.transactions[2] })],
  ['posted-duplicate-conflict', p => p.transactions.push({ ...p.transactions[2], amount: p.transactions[2].amount + 1 })],
  ['dropped-row', p => p.transactions.push({ ...p.transactions[2], id: 99100, date: 'not-a-date' })],
  ['split-unreconciled', p => p.transactions.push(
    { ...p.transactions[2], id: 99200, amount: 100, is_group: true },
    { ...p.transactions[2], id: 99201, amount: 30, parent_id: 99200 },
    { ...p.transactions[2], id: 99202, amount: 50, parent_id: 99200 })],
  ['cash-currency-unconfirmed', p => { p.transactions[2].currency = 'usd'; }],
]) {
  const payload = Fixture.payload(); mutate(payload);
  const input = { provider: 'lunchmoney', data: Fixture.canonical(), payload,
    accountMap: Fixture.map, identity: Fixture.identity };
  const baseline = O.observe(input), counts = {};
  const reported = O.observe({ ...input, onCoverageDiagnostic(value) { D.merge(counts, value); } });
  eq(reported, baseline, code + ': report and all figures unchanged by diagnostics');
  eq(counts[code], 1, code + ': actual observer branch counted');
  eq(JSON.stringify(D.record(counts)).includes(canary), false, code + ': no source content serialized');
  eq(O.observe({ ...input, onCoverageDiagnostic() { throw new Error(canary); } }), baseline,
    code + ': a broken diagnostic sink cannot affect the observation');
}

// Execute the real paging function with an in-memory transport, not a provider.
const source = fs.readFileSync(path.join(__dirname, '../scripts/provider-observe.js'), 'utf8');
const withPage = source.slice(source.indexOf('function withPage('), source.indexOf('\nfunction coverageDate('));
const paged = source.slice(source.indexOf('async function fetchLunchMoneyTransactionsPaged('), source.indexOf('\nasync function resolveLiveToken('));
async function pagingProof() {
  for (const [payload, expected] of [
    [{ transactions: [] }, 'has-more-missing'],
    [{ transactions: [], has_more: 'false' }, 'has-more-invalid'],
    [{ transactions: null, has_more: false }, 'transactions-array-malformed'],
    [{ transactions: [], has_more: true }, 'empty-page-with-more'],
    [{ transactions: [{ id: 1 }], has_more: true }, 'page-limit-reached'],
  ]) {
    const box = { URL, PENDING_QUERY_PAGE_LIMIT: 1000, PENDING_QUERY_MAX_PAGES: 20,
      httpsGetJson: async () => payload };
    vm.createContext(box); vm.runInContext(withPage + '\n' + paged, box);
    const counts = {};
    const url = new URL('https://synthetic.invalid/v2/transactions');
    const baseline = await box.fetchLunchMoneyTransactionsPaged(url, canary, { maxPages: 1 });
    const actual = await box.fetchLunchMoneyTransactionsPaged(url, canary, { maxPages: 1,
      onCoverageDiagnostic(value) { D.merge(counts, value); } });
    eq(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(baseline)), expected + ': paging result unchanged');
    eq(counts[expected], 1, expected + ': correct branch counted');
  }
}

async function lifecycleProof() {
  const RealWorker = threads.Worker, exits = [], logs = [];
  const oldLog = console.log, oldNow = Date.now;
  threads.Worker = class extends RealWorker {
    constructor(...args) { super(...args); exits.push(new Promise(resolve => this.once('exit', resolve))); }
  };
  const Refresh = require('../scripts/server-live-refresh');
  Date.now = () => Date.parse(H.CLOCK);
  console.log = value => {
    if (typeof value === 'string' && value.startsWith('{"type":"live-refresh-coverage"')) logs.push(JSON.parse(value));
  };
  const mock = await H.provider({ accountId: 501 });
  const env = H.environment(mock.base), canonical = Fixture.canonical();
  const read = async options => {
    const before = logs.length; let check;
    const data = await Refresh.serve(canonical, env, { ...options, onCheck(value) { check = value; } });
    await Promise.all(exits);
    eq(logs.length - before, 1, 'exactly one diagnostic line per settled refresh job');
    eq(Object.keys(logs.at(-1)), ['type', 'reasons'], 'log has no identities or financial fields');
    eq(Object.values(logs.at(-1).reasons).every(Number.isSafeInteger), true, 'log values are counts only');
    return { data, check, reasons: logs.at(-1).reasons };
  };
  try {
    const control = await read(); eq(control.reasons, {}, 'successful control has no diagnostic failure');
    const stale = { ...Fixture.payload(), tags: [] };
    stale.accounts[0].last_fetch = '2026-08-18T18:00:00Z';
    stale.transactions[2].payee = canary; mock.payload(stale);
    const provider = await read();
    eq(provider.reasons['sync-evidence-stale'], 1, 'provider result names stale sync evidence');
    eq(provider.check.qualified, true, 'diagnostic does not tighten source qualification or cohort admission');
    eq(provider.data.liveOverlay.currentPeriodActuals.transactionCoverage, 'incomplete', 'downstream incomplete stamp unchanged');
    const calls = mock.calls.length, replay = await read({ preferObservation: true });
    eq(mock.calls.length, calls, 'memory diagnostics require no provider refresh');
    eq(replay.reasons, provider.reasons, 'memory replay diagnoses the same evidence once');
    eq(JSON.stringify(logs).includes(canary), false, 'no payee or credential canary reaches logs');
    mock.mode('postedIncomplete'); const missing = await read();
    eq(missing.reasons['has-more-missing'], 1, 'missing posted flag is distinguished from malformed arrays');
    eq(missing.reasons['window-truncated'], 1, 'observer window truncation recorded separately');
    eq('coverageDiagnostics' in missing.data.liveOverlay, false, 'diagnostic transport is not added to served data');
    mock.mode('laterFailure'); const failed = await read();
    eq(failed.reasons['provider-unavailable'], 1, 'a provider failure records only its incumbent sanitized reason');
  } finally {
    await mock.close(); await Promise.all(exits);
    threads.Worker = RealWorker; Date.now = oldNow; console.log = oldLog;
  }
}
(async () => { await pagingProof(); await lifecycleProof(); console.log('Coverage diagnostics: ' + checks + ' checks passed.'); })()
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
