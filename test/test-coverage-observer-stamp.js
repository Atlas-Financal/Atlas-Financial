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

console.log('\n=== 2c. a malformed date cannot be scoped, so it counts as undated ===');
{
  for (const date of ['not-a-date', '2026/07/01', '2026-02-30', 'yesterday', '']) {
    const p = packetFor([row(1), row(9, { date, amount: 'unavailable' })]);
    ok(p.transactionCoverage === 'incomplete', `a dropped row dated ${JSON.stringify(date)} marks coverage incomplete`, p.transactionCoverage);
  }
  const iso = packetFor([row(1), row(10, { date: '2026-07-01T09:00:00Z', amount: 'unavailable' })]);
  ok(iso.transactionCoverage === 'complete', 'a valid timestamp dated before the window is still out of scope');
}

console.log('\n=== 2d. an unusable date earns no complete coverage even when the amount parses (Atlas) ===');
{
  for (const date of ['not-a-date', '2026/08/18', '2026-02-30', 'yesterday']) {
    const p = packetFor([row(1), row(11, { date })]);
    ok(p.transactionCoverage === 'incomplete' && p.transactions.length === 1,
      `a valid-amount household row dated ${JSON.stringify(date)} is dropped and coverage reads incomplete`, p.transactionCoverage);
    ok(!JSON.stringify(p).includes(date), `${JSON.stringify(date)} is not carried into the packet`);
  }
  const card = packetFor([row(12, { account_id: 2001, date: 'not-a-date' })]);
  ok(card.transactionCoverage === 'incomplete', 'a valid-amount revolving-credit row with a malformed date also marks incomplete');
  const outside = packetFor([row(1), row(13, { date: '2026-07-01T09:00:00Z' })]);
  ok(outside.transactionCoverage === 'complete', 'a valid timestamp dated before the window with a valid amount stays out of scope');
  const control = packetFor([row(1), row(14, { date: '2026-08-15' })]);
  ok(control.transactionCoverage === 'complete' && control.transactions.length === 2, 'control: valid date and amount stay complete and kept');
  const unmapped = packetFor([row(1), row(15, { account_id: 9999, date: 'not-a-date' })]);
  ok(unmapped.transactionCoverage === 'complete', 'a malformed date on an unmapped account still does not degrade coverage');
  // Producer to Forecast, the path the household reads.
  const F = require('../public/forecast.js');
  const fx = require('./fixtures/budget-surface-data');
  const payload = fx.payload();
  payload.transactions.push({ ...payload.transactions[0], id: 'invented-bad-date', date: '2026-02-30', amount: 12.5, is_pending: false });
  const pk = O.observe({ provider: 'lunchmoney', data: fx.canonical(), payload, accountMap: { ...fx.map, scope: 'live' },
    identity: JSON.parse(fs.readFileSync(O.DEFAULT_IDENTITY, 'utf8')) }).currentPeriodActuals;
  ok(pk.transactionCoverage === 'incomplete', 'real observer on the fixture: stamp incomplete', pk.transactionCoverage);
  const served = fx.served();
  const advice = F.recommend(served.plan, served.meta.asOf, { debts: served.debts, weeklyVariable: 0, ...served.liveOverlay, currentPeriodActuals: pk });
  const cur = advice.payPeriodViews.find(v => v.timelineRole === 'current');
  ok(advice.currentPeriodAction.remainingClaim === 'unavailable' && cur.balanceAfterDeductions === null,
    'merged Forecast: the claim is unavailable and the current remainder Unknown', JSON.stringify([advice.currentPeriodAction.remainingClaim, cur.balanceAfterDeductions]));
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

  // The live incident named stale sync evidence, not a transport failure.
  // Provider fetch acceptance is asynchronous and is not institution success:
  // https://github.com/lunch-money/lunch-money-js-v2/blob/main/src/types.generated.ts#L605-L609
  // Hand-worked Vancouver boundaries (PDT = UTC-7), independent of dateOnly.
  // This preserves the current same-household-day policy, not a provider SLA.
  for (const [label, success, fetch, want] of [
    ['one second before Vancouver midnight', '2026-08-16T06:59:59Z', '2026-08-16T18:00:00Z', 'failed'],
    ['exact Vancouver midnight', '2026-08-16T07:00:00Z', '2026-08-16T18:00:00Z', 'proven'],
    ['offset-equivalent prior household day', '2026-08-16T08:59:59+02:00', '2026-08-16T18:00:00Z', 'failed'],
    ['fresh success outranks an older fetch', '2026-08-16T15:00:00Z', '2026-08-15T18:00:00Z', 'proven'],
    ['yesterday success is not replaced by fresh request acceptance', '2026-08-15T18:00:00Z', '2026-08-16T18:00:00Z', 'failed'],
  ]) {
    const p = withAccounts([acct(1001, { plaid_last_successful_update: success, last_fetch: fetch })]);
    ok(byId(p, 'chequing-a').syncEvidence === want,
      label + ': source success, not fetch acceptance or UTC date prefix, decides');
    ok(p.transactionCoverage === (want === 'proven' ? 'complete' : 'incomplete'),
      label + ': coverage preserves the incumbent freshness boundary');
  }

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

  // An invalid sync field is not 'absent': it falls back to the next field, and if none parses it fails closed.
  const garbageThenStale = withAccounts([acct(1001, { plaid_last_successful_update: 'garbage', last_fetch: '2026-08-01T00:00:00Z' })]);
  ok(garbageThenStale.transactionCoverage === 'incomplete' && byId(garbageThenStale, 'chequing-a').syncEvidence === 'failed'
      && byId(garbageThenStale, 'chequing-a').reason === 'sync-older-than-window',
    'an unparseable success field falls back to the fetch field, which is stale: failed, not absent');
  const garbageThenFresh = withAccounts([acct(1001, { plaid_last_successful_update: 'garbage', last_fetch: '2026-08-16T15:00:00Z' })]);
  ok(byId(garbageThenFresh, 'chequing-a').syncEvidence === 'proven' && garbageThenFresh.transactionCoverage === 'complete',
    'an unparseable success field falls back to a fresh fetch: proven');
  for (const [label, extra] of [
    ['an unparseable last fetch alone', { last_fetch: 'yesterday' }],
    ['two unparseable sync fields', { last_fetch: 'x', plaid_last_successful_update: '2026/08/16' }],
  ]) {
    const bad = withAccounts([acct(1001, extra)]);
    ok(bad.transactionCoverage === 'incomplete' && byId(bad, 'chequing-a').syncEvidence === 'failed'
        && byId(bad, 'chequing-a').reason === 'sync-field-unparseable',
      `${label}: failed with the named reason, never absent`);
  }
  const statusFail = withAccounts([acct(2001, { type: 'credit', status: 'Error ', last_fetch: '2026-08-16T15:00:00Z' })]);
  ok(byId(statusFail, 'tdcc').reason === 'sync-status-failure', 'a failure status carries its named reason');
  ok(!('reason' in byId(proven, 'chequing-a')) && !('reason' in byId(absent, 'chequing-a')), 'proven and absent carry no reason');

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

console.log('\n=== 7. complete pagination does not make downstream evidence failures truncation ===');
{
  const F = require('../public/forecast.js');
  const fx = require('./fixtures/budget-surface-data');
  const served = fx.served();
  const observe = mutate => {
    const payload = fx.payload();
    payload.transactionWindow.startDate = '2026-07-31';
    if (mutate) mutate(payload);
    return O.observe({ provider: 'lunchmoney', data: fx.canonical(), payload,
      accountMap: fx.map, identity: fx.identity });
  };
  const read = packet => {
    const opts = { debts: served.debts, ...served.liveOverlay, currentPeriodActuals: packet };
    const advice = F.recommend(served.plan, served.meta.asOf, opts);
    const previous = F.budgetPeriodProgress(served.plan, served.meta.asOf,
      { start: '2026-07-31', end: '2026-08-13', timelineRole: 'past' }, opts);
    return { advice, previous };
  };
  const incompleteCurrent = 'Posted transaction evidence is incomplete. Current remaining amounts unavailable.';
  const incompleteHistorical = 'Posted transaction evidence is incomplete. Historical spent withheld.';
  for (const [label, mutate] of [
    ['failed account sync', p => { p.accounts[0].last_fetch = '2026-08-18T18:00:00Z'; }],
    ['unusable household row', p => { p.transactions.push({ ...p.transactions[0], id: 99100, date: 'not-a-date' }); }],
    ['conflicting posted copies', p => { p.transactions.push({ ...p.transactions[2], amount: p.transactions[2].amount + 1 }); }],
    ['unreconciled split', p => { p.transactions.push(
      { ...p.transactions[2], id: 99200, amount: 100, is_group: true },
      { ...p.transactions[2], id: 99201, amount: 30, parent_id: 99200 },
      { ...p.transactions[2], id: 99202, amount: 50, parent_id: 99200 }); }],
  ]) {
    const report = observe(mutate), packet = report.currentPeriodActuals;
    ok(report.observationReceipt.readyForReconciliation === true
      && packet.transactionWindow.complete === true && packet.transactionWindow.hasMore === false
      && packet.transactionWindow.truncated === false && packet.transactionCoverage === 'incomplete',
    `${label}: source receipt can qualify while downstream evidence is incomplete`);
    const { advice, previous } = read(packet);
    ok(advice.currentPeriodAction.coverage.reason === incompleteCurrent,
      `${label}: current reason says incomplete evidence, not truncated pagination`, advice.currentPeriodAction.coverage.reason);
    ok(advice.currentPeriodAction.remainingClaim === 'unavailable'
      && advice.payPeriodViews.find(row => row.timelineRole === 'current').balanceAfterDeductions === null,
    `${label}: current figures remain withheld`);
    ok(previous.coverage.reason === incompleteHistorical && previous.coverage.remainingClaim === 'unavailable',
      `${label}: completed-period reason is accurate and historical figures stay withheld`, previous.coverage.reason);
  }
  const truncated = observe(p => { Object.assign(p.transactionWindow, { complete: false, hasMore: true, truncated: true }); });
  const truncatedRead = read(truncated.currentPeriodActuals);
  ok(truncatedRead.advice.currentPeriodAction.coverage.reason === 'Posted transaction coverage is truncated. Current remaining amounts unavailable.'
    && truncatedRead.previous.coverage.reason === 'Posted transaction coverage is truncated. Historical spent withheld.',
  'actual pagination truncation keeps its existing current and historical wording');
  const unconfirmed = observe().currentPeriodActuals;
  delete unconfirmed.transactionCoverage;
  const unconfirmedRead = read(unconfirmed);
  ok(unconfirmedRead.advice.currentPeriodAction.coverage.reason === incompleteCurrent
    && unconfirmedRead.advice.currentPeriodAction.remainingClaim === 'unavailable',
  'an absent coverage stamp is incomplete evidence, not proof of pagination truncation');
  for (const stamp of [null, 'unknown', { complete: false }, { complete: true, status: 'incomplete' }]) {
    const packet = observe().currentPeriodActuals;
    packet.transactionCoverage = stamp;
    const result = read(packet);
    ok(result.advice.currentPeriodAction.coverage.reason === incompleteCurrent
      && result.advice.currentPeriodAction.remainingClaim === 'unavailable'
      && result.previous.coverage.reason === incompleteHistorical,
    'an unqualified coverage stamp does not invent a pagination failure: ' + JSON.stringify(stamp));
  }
  for (const [stamp, window] of [
    [{ complete: true, hasMore: true }, {}],
    [{ complete: true, has_more: true }, {}],
    [{ complete: true, truncated: true }, {}],
    ['incomplete', { truncated: true }],
    ['incomplete', { hasMore: true }],
  ]) {
    const packet = observe().currentPeriodActuals;
    packet.transactionCoverage = stamp;
    Object.assign(packet.transactionWindow, window);
    const result = read(packet);
    ok(result.advice.currentPeriodAction.coverage.reason.includes('coverage is truncated.')
      && result.advice.currentPeriodAction.remainingClaim === 'unavailable'
      && result.previous.coverage.reason.includes('coverage is truncated.'),
    'explicit continuation or truncation keeps the truncation reason and withhold');
  }
  const control = read(observe().currentPeriodActuals).advice;
  ok(control.currentPeriodAction.coverage.reason === null && control.currentPeriodAction.remainingClaim === 'precise'
    && Number.isFinite(control.payPeriodViews.find(row => row.timelineRole === 'current').balanceAfterDeductions),
  'a complete control keeps precise figures and no failure reason');
  // Reuse the active Budget VM renderer; the page consumes Forecast's reason.
  const Module = require('node:module');
  const rendererFile = path.join(__dirname, 'test-atlas-077-malformed-amounts.js');
  const source = fs.readFileSync(rendererFile, 'utf8').split('const budgetPage = createBudgetPage();')[0];
  const renderer = new Module(rendererFile, module);
  renderer.filename = rendererFile;
  renderer.paths = Module._nodeModulePaths(__dirname);
  renderer._compile(source + '\nmodule.exports = { createBudgetPage };', rendererFile);
  const displayed = structuredClone(served);
  displayed.liveOverlay.currentPeriodActuals = observe(p => {
    p.accounts[0].last_fetch = '2026-08-18T18:00:00Z';
  }).currentPeriodActuals;
  const html = renderer.exports.createBudgetPage().render(displayed);
  ok(html.includes(incompleteCurrent) && !html.includes('Posted transaction coverage is truncated.'),
    'the active Budget renderer displays the incomplete-evidence reason without inventing truncation');
}

console.log('\n' + (failures ? `${failures} failure(s)` : 'ALL CHECKS PASSED'));
process.exit(failures === 0 ? 0 : 1);
