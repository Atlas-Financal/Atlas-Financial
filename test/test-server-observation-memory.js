'use strict';
// Synthetic source inputs, actual worker/observer/LivePlan and authenticated
// server routes. No household file edit, configured secret or provider write.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const Fixture = require('./fixtures/budget-surface-data');
const ROOT = path.resolve(__dirname, '..');
const CLOCK = Fixture.payload().fetchedAt;
const PASS = 'synthetic-observation-site-password';
const SECRET = 'synthetic-observation-session-secret';
const OTHER_PASS = 'synthetic-new-household-context';
const TOKEN = 'synthetic-observation-assistant-token-32chars';

// A child-only preload substitutes the dated baseline in memory. It never
// changes data.json, credentials, identity files, environment or access grants.
if (process.env.ATLAS_SYNTHETIC_OBSERVATION_PRELOAD === '1') {
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(ROOT, 'data.json')) {
      const bytes = process.env.ATLAS_SYNTHETIC_OBSERVATION_CANONICAL || JSON.stringify(Fixture.canonical());
      return args[0] ? bytes : Buffer.from(bytes);
    }
    return read.call(this, file, ...args);
  };
  Date.now = () => Date.parse(process.env.ATLAS_LIVE_OVERLAY_NOW);
}
if (!require('node:worker_threads').isMainThread
  && (process.env.ATLAS_SYNTHETIC_REPLAY_DELAY_MS || process.env.ATLAS_SYNTHETIC_LIVE_RESULT_DELAY_MS)) {
  const Live = require('../scripts/live-plan'), apply = Live.applyForServer;
  Live.applyForServer = async (...args) => {
    if (args[2]?.evidence) await new Promise(resolve => setTimeout(resolve, Number(process.env.ATLAS_SYNTHETIC_REPLAY_DELAY_MS)));
    const data = await apply(...args);
    if (!args[2]?.evidence && process.env.ATLAS_SYNTHETIC_LIVE_RESULT_DELAY_MS) {
      require('node:worker_threads').parentPort.postMessage({ syntheticAcquired: true });
      await new Promise(resolve => setTimeout(resolve, Number(process.env.ATLAS_SYNTHETIC_LIVE_RESULT_DELAY_MS)));
    }
    return data;
  };
}
function environment(base) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-CREDENTIAL-CANARY',
    ATLAS_LUNCHMONEY_API_BASE: base, ATLAS_LIVE_OVERLAY_NOW: CLOCK,
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...Fixture.map, scope: 'live' }) };
}
async function provider({ accountId = null } = {}) {
  let payload = { ...Fixture.payload(), tags: [] }, mode = 'ok', held = false, heldPath = '/v2/me';
  const calls = [], pending = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); calls.push(url.pathname);
    if (req.method !== 'GET') throw new Error('Synthetic provider received a write');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const answer = () => {
      if (mode === 'failure') return send(503, { error: 'SYNTHETIC-PRIVATE-ERROR', token: 'SYNTHETIC-CREDENTIAL-CANARY' });
      if (mode === 'optionalFailure' && url.pathname === '/v2/tags') return send(503, { error: 'SYNTHETIC-OPTIONAL-ERROR' });
      if (url.pathname === '/v2/me') return send(200, { id: 1, ...(accountId == null ? {} : { account_id: accountId }) });
      if (mode === 'laterFailure') return send(503, { error: 'SYNTHETIC-LATER-LEG-ERROR' });
      if (url.pathname === '/v2/plaid_accounts') return send(200, { plaid_accounts: payload.accounts });
      if (url.pathname === '/v2/manual_accounts') return send(200, { manual_accounts: [] });
      if (url.pathname === '/v2/categories') return send(200, { categories: mode === 'malformed' ? {} : payload.categories });
      if (url.pathname === '/v2/tags') return send(200, { tags: payload.tags });
      if (url.pathname === '/v2/transactions') {
        const isPending = url.searchParams.get('is_pending') === 'true';
        const rows = payload.transactions.filter(tx => !isPending || tx.is_pending);
        return send(200, { transactions: rows, ...((mode === 'incomplete' && isPending) || (mode === 'postedIncomplete' && !isPending) ? {} : { has_more: false }) });
      }
      send(404, {});
    };
    if (held && url.pathname === heldPath) {
      pending.add(answer); res.once('close', () => pending.delete(answer));
    } else answer();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: 'http://127.0.0.1:' + server.address().port + '/v2', calls,
    account(value) { accountId = value; },
    mode(value) { mode = value; }, payload(value) { payload = structuredClone(value); },
    hold(at = '/v2/me') { held = true; heldPath = at; }, release() { held = false; for (const answer of pending) answer(); pending.clear(); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = performance.now() + 15000;
  while (!(await predicate())) { if (performance.now() >= deadline) throw new Error('Synthetic deadline: ' + label); await pause(10); }
}
async function freePort() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function oauthIssuer() {
  const jose = await import('jose');
  const pair = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await jose.exportJWK(pair.publicKey), kid: 'synthetic-observation-key', alg: 'RS256', use: 'sig' };
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const issuer = 'http://127.0.0.1:' + server.address().port + '/';
  return { issuer, jwks: issuer + 'jwks',
    token: resource => new jose.SignJWT({ scope: 'atlas.current.read' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer).setAudience(resource).setSubject('synthetic-owner').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey),
    close: () => new Promise(resolve => server.close(resolve)) };
}
async function atlas(mock, { mcp = false, canonical = null } = {}) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port, auth = mcp ? await oauthIssuer() : null;
  const child = spawn(process.execPath, ['--require', __filename, path.join(ROOT, 'server.js')], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment(mock.base),
      PORT: String(port), SITE_PASSWORD: PASS, SESSION_SECRET: SECRET,
      ATLAS_ASSISTANT_TOKEN: TOKEN, ATLAS_SYNTHETIC_OBSERVATION_PRELOAD: '1',
      ...(canonical ? { ATLAS_SYNTHETIC_OBSERVATION_CANONICAL: JSON.stringify(canonical) } : {}),
      ...(auth ? { ATLAS_MCP_RESOURCE_URL: base + '/assistant/mcp', ATLAS_OAUTH_ISSUER: auth.issuer, ATLAS_OAUTH_JWKS_URI: auth.jwks } : {}) } });
  // Capture privately; publish only the test's own closed counts/timings.
  let exited = false; child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.once('exit', () => { exited = true; });
  const close = async () => {
    if (!exited && child.exitCode === null) {
      const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit;
    }
    await auth?.close();
  };
  try {
    await until(async () => {
      if (exited) throw new Error('Synthetic server startup failed');
      try { return (await fetch(base + '/login')).status === 200; } catch (_) { return false; }
    }, 'server startup');
  const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(PASS) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Synthetic login failed');
    return { base, cookie, close, mcpToken: auth ? await auth.token(base + '/assistant/mcp') : null };
  } catch (error) { await close(); throw error; }
}
module.exports = { provider, atlas, environment, CLOCK, PASS, TOKEN, until, pause };

if (require.main === module) (async () => {
  const assert = require('node:assert/strict');
  const threads = require('node:worker_threads');
  const workerExits = [], workers = [];
  const RealWorker = threads.Worker;
  threads.Worker = class extends RealWorker {
    constructor(...args) { super(...args); workers.push(this); workerExits.push(new Promise(resolve => this.once('exit', resolve))); }
    emit(event, value, ...args) {
      if (event === 'message' && value?.syntheticAcquired) { this.syntheticAcquired = true; return true; }
      return super.emit(event, value, ...args);
    }
  };
  const Refresh = require('../scripts/server-live-refresh');
  const Live = require('../scripts/live-plan');
  const Memory = require('../scripts/server-observation-memory');
  const Observer = require('../scripts/provider-observe');
  const canonical = Fixture.canonical();
  const originalNow = Date.now, originalLog = console.log;
  let now = CLOCK, checks = 0;
  Date.now = () => Date.parse(now);
  const check = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
  const reject = async (promise, code) => { await assert.rejects(promise, error => error.code === code); checks++; };
  const drain = () => Promise.all(workerExits);
  const timings = [];
  console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('{"type":"live-refresh-lifecycle"')) timings.push(JSON.parse(args[0])); else originalLog(...args); };
  const mock = await provider(), env = environment(mock.base);
  try {
    // The source projection excludes credentials, arbitrary nested metadata,
    // publications and owner allocations, and refuses incomplete/malformed rows.
    const raw = { ...Fixture.payload(), tags: [], token: 'SYNTHETIC-CREDENTIAL-CANARY',
      startingCash: { amount: 99999 }, savedAllocations: [99999] };
    raw.accounts[0].password = 'SYNTHETIC-CREDENTIAL-CANARY';
    raw.transactions[0].plaid_metadata = { transaction_id: 'synthetic-id', secret: 'SYNTHETIC-CREDENTIAL-CANARY' };
    const projected = Memory.sourceInputs(raw);
    check(JSON.stringify(projected).includes('SYNTHETIC-CREDENTIAL-CANARY'), false, 'no credential fields retained');
    check(Object.keys(projected), ['provider','fetchedAt','accounts','categories','tags','transactions','transactionWindow','pendingCoverage'], 'source-only shape');
    const memory = Memory.create(), envelope = { schema: Memory.SCHEMA, payload: projected };
    memory.publish('synthetic-private-context', envelope); projected.accounts[0].balance = 99999;
    check(memory.read('synthetic-private-context').payload.accounts[0].balance, 1215, 'publish clones source');
    const read = memory.read('synthetic-private-context'); read.payload.accounts[0].balance = 99999;
    check(memory.read('synthetic-private-context').payload.accounts[0].balance, 1215, 'read clones source');
    check(memory.read('different-context'), null, 'incompatible slot erased');
    check(Memory.create().read('synthetic-private-context'), null, 'new process/store has no restored evidence');
    for (const mutate of [p => { p.pendingCoverage.complete = false; }, p => { p.transactionWindow.truncated = true; },
      p => { p.transactions[0].amount = null; }, p => { p.transactions[0].amount = '   '; },
      p => { p.accounts[0].balance = '0x10'; }, p => { p.transactions[0].date = '2026-02-30'; }]) {
      const bad = structuredClone(raw); mutate(bad); assert.throws(() => Memory.sourceInputs(bad)); checks++;
    }

    let observation;
    const direct = await Live.applyForServer(canonical, env, { onObservation(value) { observation = value; } });
    check(observation.qualified, true, 'independent live acquisition qualifies');
    assert.ok(observation.evidence); checks++;
    const report = Observer.observe({ provider: 'lunchmoney', data: canonical, payload: observation.evidence.payload,
      accountMap: { ...Fixture.map, scope: 'live' }, identity: JSON.parse(fs.readFileSync(Observer.DEFAULT_IDENTITY, 'utf8')) });
    const independentlyEvaluated = Live.overlayLiveState({ data: canonical, report }).data;
    check(independentlyEvaluated, direct, 'independent observer/cutover evaluation conserves whole publication');
    check(independentlyEvaluated.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value
      + independentlyEvaluated.plan.startingCash.breakdown.find(row => row.id === 'chequing-b').value, 1375, 'independent 1215 + 160 chequing proof');
    const firstCount = mock.calls.length; let firstCheck;
    check(await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { firstCheck = value; } }), direct, 'first browser miss equals independent evaluation');
    await drain(); check(mock.calls.length - firstCount, 7, 'first browser read performs seven GETs');
    check(firstCheck, { source: 'provider', qualified: true, checkedAt: CLOCK }, 'live check timestamp');
    const cachedCount = mock.calls.length, workerCount = workers.length, started = performance.now(); let reusedCheck;
    const reused = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { reusedCheck = value; } });
    const providerFreeResponseMs = performance.now() - started;
    check(reused, independentlyEvaluated, 'sequential browser replay equals independent same-evidence evaluation');
    check(mock.calls.length, cachedCount, 'sequential browser replay makes zero provider requests');
    check(workers.length - workerCount, 1, 'replay uses actual bounded worker');
    check(reusedCheck, { source: 'memory', qualified: true, checkedAt: CLOCK }, 'render does not relabel original check');
    reused.plan.startingCash.breakdown[0].value = 99999;
    check(await Refresh.serve(canonical, env, { preferObservation: true }), direct, 'callers do not share result or evidence objects'); await drain();
    const replayCancel = new AbortController(), replayBefore = workers.length;
    const cancelledReplay = reject(Refresh.serve(canonical, env, { preferObservation: true, signal: replayCancel.signal }), 'live-refresh-cancelled');
    const survivor = Refresh.serve(canonical, env, { preferObservation: true });
    replayCancel.abort(); await cancelledReplay;
    check(await survivor, direct, 'one cancelled replay waiter cannot cancel its survivor'); await drain();
    check(workers.length - replayBefore, 1, 'equivalent replay callers share an actual worker');
    check(mock.calls.length, cachedCount, 'cancelled replay never starts provider work');

    for (const options of [{}, { preferObservation: true, forceRefresh: true }]) {
      const count = mock.calls.length;
      check(await Refresh.serve(canonical, env, options), direct, 'live and force consumers retain publication'); await drain();
      check(mock.calls.length - count, 7, 'live/force consumers bypass completed evidence');
    }
    // A forced live acquisition supersedes any pending older cached replay.
    const delayedEnv = { ...env, ATLAS_SYNTHETIC_REPLAY_DELAY_MS: '800',
      NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
    await Refresh.serve(canonical, delayedEnv); await drain();
    const obsoleteReplay = reject(Refresh.serve(canonical, delayedEnv, { preferObservation: true }), 'live-refresh-invalidated');
    const changed = { ...Fixture.payload(), tags: [] }; changed.transactions[2].category_id = 14; mock.payload(changed);
    const latest = await Refresh.serve(canonical, delayedEnv, { forceRefresh: true });
    await obsoleteReplay; await drain(); const latestCount = mock.calls.length;
    check(await Refresh.serve(canonical, delayedEnv, { preferObservation: true }), latest, 'latest live check owns subsequent replay'); await drain();
    check(mock.calls.length, latestCount, 'obsolete replay cannot restore an older slot');
    mock.payload({ ...Fixture.payload(), tags: [] }); await Refresh.serve(canonical, env); await drain();
    // A successfully evaluated result arriving after cancellation is abandoned,
    // not a completed check that may silently fill the private evidence slot.
    const lateEnv = { ...env, ATLAS_SYNTHETIC_LIVE_RESULT_DELAY_MS: '35',
      NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
    const lateCancel = new AbortController();
    const abandoned = reject(Refresh.serve(canonical, lateEnv, { forceRefresh: true, signal: lateCancel.signal }), 'live-refresh-cancelled');
    await until(() => workers.at(-1).syntheticAcquired, 'qualified but not delivered worker result');
    lateCancel.abort(); await abandoned; await drain();
    const abandonedCount = mock.calls.length;
    await Refresh.serve(canonical, lateEnv, { preferObservation: true }); await drain();
    check(mock.calls.length - abandonedCount, 7, 'abandoned late worker cannot populate completed evidence');
    for (const mode of ['failure', 'malformed', 'incomplete', 'optionalFailure']) {
      mock.mode(mode);
      await reject(Refresh.serve(canonical, env, { preferObservation: true, forceRefresh: true }), 'live-refresh-unavailable'); await drain();
      const count = mock.calls.length;
      const failed = await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
      check(mock.calls.length > count, true, mode + ': no successful cached fallback');
      if (mode !== 'optionalFailure') check(failed.liveOverlay.applied, false, mode + ': incomplete/invalid data does not advance cash');
      mock.mode('ok'); await Refresh.serve(canonical, env); await drain();
    }
    // Source qualification and financial completeness are distinct. Missing a
    // mapped card can leave cash applied but fail receipt qualification; a
    // qualified source check can still withhold card-covered spending figures.
    const missingCard = { ...Fixture.payload(), tags: [] };
    missingCard.accounts = missingCard.accounts.filter(row => row.id !== 2001);
    mock.payload(missingCard); let incompleteCheck;
    const incomplete = await Refresh.serve(canonical, env, {
      onCheck(value) { incompleteCheck = value; } }); await drain();
    check(incompleteCheck, { source: 'provider', qualified: false, checkedAt: CLOCK }, 'dated provider response is not a qualified source check');
    check(incomplete.liveOverlay.applied, true, 'unqualified receipt does not invent a failed cash overlay');
    check(incomplete.refreshTrust.displayState, 'attention-needed', 'incumbent financial attention state retained');
    await reject(Refresh.serve(canonical, env, { forceRefresh: true }), 'live-refresh-unavailable'); await drain();
    const incompleteCount = mock.calls.length;
    await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
    check(mock.calls.length - incompleteCount, 7, 'unqualified source response never enters completed memory');
    mock.payload({ ...Fixture.payload(), tags: [] });
    const uncovered = structuredClone(canonical); delete uncovered.plan.cardPurchaseCoverage; let coveredCheck;
    const limited = await Refresh.serve(uncovered, env, { onCheck(value) { coveredCheck = value; } }); await drain();
    check(coveredCheck, { source: 'provider', qualified: true, checkedAt: CLOCK }, 'source check can qualify while financial coverage is limited');
    check(limited.refreshTrust.exactFiguresAvailable, false, 'card coverage still withholds exact financial figures');
    check(limited.refreshTrust.coverageLimits.some(row => row.id === 'card-purchase-coverage-unconfirmed'), true, 'incumbent card coverage reason retained');
    await Refresh.serve(canonical, env); await drain();
    for (const change of [
      { LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-DIFFERENT-TOKEN' }, { SITE_PASSWORD: OTHER_PASS },
      { RENDER_GIT_COMMIT: 'synthetic-new-runtime' }, { ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...Fixture.map, scope: 'live', revision: 'new' }) },
    ]) {
      const count = mock.calls.length;
      await Refresh.serve(canonical, { ...env, ...change }, { preferObservation: true }); await drain();
      check(mock.calls.length - count, 7, 'changed credential/household/runtime/map context misses');
    }
    const changedCanonical = structuredClone(canonical); changedCanonical.meta.syntheticRevision = 'new';
    const count = mock.calls.length; await Refresh.serve(changedCanonical, env, { preferObservation: true }); await drain();
    check(mock.calls.length - count, 7, 'canonical revision misses');
    const stat = fs.statSync;
    try {
      fs.statSync = (file, ...args) => {
        if (file === Observer.LOCAL_MAP) { const error = new Error('synthetic metadata refusal'); error.code = 'EACCES'; throw error; }
        return stat(file, ...args);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const opaqueCount = mock.calls.length;
        check(await Refresh.serve(canonical, env, { preferObservation: true }), direct, 'unreadable compatibility metadata retains incumbent live result'); await drain();
        check(mock.calls.length - opaqueCount, 7, 'unreadable metadata never authorizes completed reuse');
      }
    } finally { fs.statSync = stat; }

    await Refresh.serve(canonical, env); await drain();
    const cancel = new AbortController(); cancel.abort(); const cancelledCount = mock.calls.length;
    await reject(Refresh.serve(canonical, env, { preferObservation: true, signal: cancel.signal }), 'live-refresh-cancelled');
    check(mock.calls.length, cancelledCount, 'pre-cancelled replay does not fetch');
    await Refresh.withProviderWrite(async () => ({ status: 'write-unverified' }));
    const afterWriteCount = mock.calls.length;
    await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
    check(mock.calls.length - afterWriteCount, 7, 'uncertain write invalidates completed evidence');
    mock.hold(); const old = reject(Refresh.serve(canonical, env, { forceRefresh: true }), 'live-refresh-invalidated');
    await until(() => mock.calls.length > afterWriteCount + 7, 'old provider job');
    let finishWrite; const write = Refresh.withProviderWrite(() => new Promise(resolve => { finishWrite = resolve; }));
    await old;
    await reject(Refresh.serve(canonical, env, { preferObservation: true }), 'live-refresh-invalidated');
    finishWrite({ status: 'applied' }); await write; mock.release(); await drain();

    // Midnight/payday rollover ignores old evidence even without a new import.
    now = '2026-08-28T06:59:59.000Z'; const dayEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: now };
    const dayPayload = { ...Fixture.payload(), tags: [] }; dayPayload.accounts.forEach(row => { row.updated_at = now; row.balance_last_update = now; }); mock.payload(dayPayload);
    await Refresh.serve(canonical, dayEnv); await drain();
    now = '2026-08-28T07:00:00.000Z'; const midnightCount = mock.calls.length;
    let rolledCheck = null;
    const rolled = await Refresh.serve(canonical, { ...dayEnv, ATLAS_LIVE_OVERLAY_NOW: now }, { preferObservation: true, onCheck(value) { rolledCheck = value; } }); await drain();
    check(mock.calls.length - midnightCount, 7, 'Pacific midnight/payday starts live acquisition');
    // OD-2 (#821): prior-day cash is shown as the dated view of its own day,
    // never as a new-day financial verdict or a current check.
    check(rolled.meta.asOf, '2026-08-27', 'prior-day cash stays dated on its own evidence day');
    check(rolledCheck && rolledCheck.qualified, false, 'prior-day cash cannot become a new-day financial verdict');
    check(rolled.liveOverlay.retainedRefresh?.attempt?.reason, 'stale-live-cash-evidence', 'new-day view is labelled as a dated plan');
    check(rolled.liveOverlay.operatingPlan !== Live.OPERATING_PLAN_UNAVAILABLE, true, 'dated view of valid evidence is not blanked');
    for (const [before, after] of [['2026-11-01T08:59:59.000Z','2026-11-01T09:00:00.000Z'],
      ['2027-03-14T09:59:59.000Z','2027-03-14T10:00:00.000Z']]) {
      now = before; const dstPayload = { ...Fixture.payload(), tags: [] }; dstPayload.accounts.forEach(row => { row.updated_at = before; row.balance_last_update = before; }); mock.payload(dstPayload);
      const dstEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: before }; await Refresh.serve(canonical, dstEnv); await drain();
      const dstCount = mock.calls.length; now = after;
      const dst = await Refresh.serve(canonical, dstEnv, { preferObservation: true }); await drain();
      check(mock.calls.length, dstCount, 'same household date across DST reuses evidence');
      check(dst.liveOverlay.fetchedAt, before, 'DST replay retains exact original check timestamp');
    }
    now = CLOCK; mock.payload({ ...Fixture.payload(), tags: [] });

    // Packet-level source-check receipt: the real serve capture projected
    // through the real packet builder (Assistant.buildPacket projects the
    // captured check into metadata.sourceCheck; nothing else in the packet
    // is derived from it).
    const Assistant = require('../scripts/assistant-packet');
    const receiptPacket = (data, check, attemptedAt) => Assistant.buildPacket({
      data, env, now: attemptedAt, sourceCheck: { check, attemptedAt },
    });
    {
      let packetCheck;
      const packetData = await Refresh.serve(canonical, env, { onCheck(value) { packetCheck = value; } });
      await drain();
      check(receiptPacket(packetData, packetCheck, '2026-08-20T18:05:00.000Z').metadata.sourceCheck, {
        outcome: 'qualified', source: 'provider', qualified: true,
        evidenceCheckedAt: CLOCK, attemptedAt: '2026-08-20T18:05:00.000Z', reason: null, cacheNote: null,
      }, 'packet receipt: qualified provider check, original evidence time, separate attempt time');
      let replayCheck;
      const replayData = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { replayCheck = value; } });
      await drain();
      check(receiptPacket(replayData, replayCheck, '2026-08-20T19:30:00.000Z').metadata.sourceCheck, {
        outcome: 'qualified', source: 'memory', qualified: true,
        evidenceCheckedAt: CLOCK, attemptedAt: '2026-08-20T19:30:00.000Z', reason: null,
        cacheNote: 'Source evidence is process-local warm reuse; it can disappear on restart, sleep or deploy.',
      }, 'packet receipt: memory replay keeps the original evidence time and discloses warm reuse');
      // Unqualified: the overlay applied (freshness still says live) but the
      // check did not qualify — the receipt, not freshness, tells the truth.
      const missing = { ...Fixture.payload(), tags: [] };
      missing.accounts = missing.accounts.filter(row => row.id !== 2001);
      mock.payload(missing);
      let unqCheck;
      const unqData = await Refresh.serve(canonical, env, { onCheck(value) { unqCheck = value; } });
      await drain();
      const unqPacket = receiptPacket(unqData, unqCheck, '2026-08-20T18:10:00.000Z');
      check(unqPacket.metadata.sourceCheck.outcome, 'unqualified', 'packet receipt: dated but unqualified check is unqualified');
      check(unqPacket.metadata.sourceCheck.evidenceCheckedAt, CLOCK, 'packet receipt: unqualified check keeps its evidence time');
      check(unqPacket.metadata.freshness.confidence, 'live', 'packet freshness still says live on the unqualified overlay (the receipt is the qualification signal)');
      mock.payload({ ...Fixture.payload(), tags: [] });
      // Failure after a qualified success: the failed read must not present
      // the prior success's evidence time as its own.
      mock.mode('failure');
      let failCheck;
      const failData = await Refresh.serve(canonical, env, { onCheck(value) { failCheck = value; } });
      await drain();
      check(receiptPacket(failData, failCheck, '2026-08-20T18:15:00.000Z').metadata.sourceCheck, {
        outcome: 'failed', source: 'provider', qualified: false,
        evidenceCheckedAt: null, attemptedAt: '2026-08-20T18:15:00.000Z', reason: 'provider-check-failed', cacheNote: null,
      }, 'packet receipt: failure after success is failed, with no evidence time');
      mock.mode('ok');
      await Refresh.serve(canonical, env); await drain();
    }
    {
      // Concurrent consumers coalesce onto one provider job and receive the
      // identical check, so their receipts agree.
      const beforeCalls = mock.calls.length;
      mock.hold();
      let checkA, checkB;
      const serveA = Refresh.serve(canonical, env, { onCheck(value) { checkA = value; } });
      const serveB = Refresh.serve(canonical, env, { onCheck(value) { checkB = value; } });
      await until(() => mock.calls.length > beforeCalls, 'coalesced provider job started');
      mock.release();
      const [dataA, dataB] = await Promise.all([serveA, serveB]);
      await drain();
      check(mock.calls.length - beforeCalls, 7, 'two concurrent serves share one seven-GET provider fetch');
      check(checkA, checkB, 'coalesced waiters receive the identical check');
      check(receiptPacket(dataA, checkA, '2026-08-20T18:20:00.000Z').metadata.sourceCheck,
        receiptPacket(dataB, checkB, '2026-08-20T18:20:00.000Z').metadata.sourceCheck,
        'coalesced consumers project identical receipts');
    }
    {
      // A read during an in-flight write is refused (server.js maps this
      // rejection to HTTP 503); the first read after the write settles runs
      // a fresh provider check, and an uncertain write earns no replay.
      let finishWrite;
      const write = Refresh.withProviderWrite(() => new Promise(resolve => { finishWrite = resolve; }));
      await reject(Refresh.serve(canonical, env, { preferObservation: true }), 'live-refresh-invalidated');
      finishWrite({ status: 'applied' });
      await write;
      const afterWrite = mock.calls.length;
      let postWriteCheck;
      const postWriteData = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { postWriteCheck = value; } });
      await drain();
      check(mock.calls.length - afterWrite, 7, 'first read after a write performs a fresh provider fetch');
      check(receiptPacket(postWriteData, postWriteCheck, '2026-08-20T18:25:00.000Z').metadata.sourceCheck.source,
        'provider', 'first receipt after a write is a fresh provider check, never a pre-write replay');
      await Refresh.withProviderWrite(async () => ({ status: 'write-unverified' }));
      const afterUncertain = mock.calls.length;
      let uncertainCheck;
      const uncertainData = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { uncertainCheck = value; } });
      await drain();
      check(mock.calls.length - afterUncertain, 7, 'uncertain write attempt still forces a fresh provider fetch');
      check(receiptPacket(uncertainData, uncertainCheck, '2026-08-20T18:26:00.000Z').metadata.sourceCheck.qualified,
        true, 'receipt after an uncertain write reflects the post-write check, not a stale qualified replay');
    }

    // A Lunch Money edit changes only the recurring link on the same row.
    // Keep this server, canonical context and clock alive across every edit:
    // the Refresh button must replace the previous retained source evidence.
    {
      const recurringPlan = Fixture.canonical();
      recurringPlan.plan.budget.categories.push({ id: 'pets', label: 'Invented pet food',
        class: 'essential', plannedPayday: 100, confidence: 'confirmed',
        dogFoodLunchMoneyRecurringIds: ['8801'], dogFoodLunchMoneyCategoryIds: ['88'] });
      const payload = { ...Fixture.payload(), tags: [] };
      payload.categories.push({ id: 88, name: 'Pet supplies', is_income: false });
      const transaction = { id: 92888, account_id: 1002, date: '2026-08-19', amount: 23,
        currency: 'cad', payee: 'Invented linked supplier', category_id: 88,
        is_pending: false, status: 'cleared' };
      payload.transactions.push(transaction);
      const app = await atlas(mock, { canonical: recurringPlan });
      try {
        let transactionRef;
        for (const [label, recurringId, linked] of [
          ['initially unlinked', undefined, false],
          ['added link', 8801, true],
          ['changed link', 8802, false],
          ['restored before deletion', 8801, true],
          ['removed link (absent)', undefined, false],
          ['restored before clearing', 8801, true],
          ['removed link (null)', null, false],
        ]) {
          if (recurringId === undefined) delete transaction.recurring_id;
          else transaction.recurring_id = recurringId;
          mock.payload(payload);
          const beforeRefresh = mock.calls.length;
          const refreshed = await fetch(app.base + '/data.json?refresh=force', { headers: { cookie: app.cookie } });
          check(refreshed.status, 200, label + ': authenticated Refresh succeeds');
          check(refreshed.headers.get('X-Atlas-Observation-Source'), 'provider', label + ': Refresh re-reads provider');
          check(refreshed.headers.get('X-Atlas-Observation-Qualified'), 'true', label + ': fresh evidence qualifies');
          check(mock.calls.length - beforeRefresh, 7, label + ': next Refresh performs a full provider read');
          const fresh = await refreshed.json();
          const rows = fresh.liveOverlay.currentPeriodActuals.transactions.filter(row => row.displayedPayee === transaction.payee);
          check(rows.length, 1, label + ': same transaction is present');
          const row = rows[0];
          transactionRef ??= row.id;
          check(row.id, transactionRef, label + ': local transaction identity is unchanged');
          check([row.dogFood === true, row.dogFoodLunchMoneyLink === true], [linked, linked],
            label + ': publication follows the current link, not the previously retained one');
          check(Object.hasOwn(row, 'recurring_id') || Object.hasOwn(row, 'recurringId'), false,
            label + ': raw provider link stays private');
          const beforeReplay = mock.calls.length;
          const replayed = await fetch(app.base + '/data.json', { headers: { cookie: app.cookie } });
          check(replayed.status, 200, label + ': subsequent page read succeeds');
          check(replayed.headers.get('X-Atlas-Observation-Source'), 'memory', label + ': updated evidence was retained');
          check(replayed.headers.get('X-Atlas-Observation-Qualified'), 'true', label + ': updated retained evidence qualifies');
          check(mock.calls.length, beforeReplay, label + ': page read replays without provider requests');
          check(await replayed.json(), fresh, label + ': complete replay reflects the latest link edit');
        }
      } finally {
        await app.close();
        mock.payload({ ...Fixture.payload(), tags: [] });
      }
    }

    // Full session-authenticated route and static-Bearer live consumer.
    for (let restart = 0; restart < 2; restart++) {
      const app = await atlas(mock, { mcp: true });
      try {
        check((await fetch(app.base + '/data.json?refresh=force')).status, 401, 'force is session-authenticated');
        for (const query of ['refresh=wat','refresh=force&refresh=force','refresh[x]=force']) {
          check((await fetch(app.base + '/data.json?' + query, { headers: { cookie: app.cookie } })).status, 400, 'malformed force option rejected');
        }
        const routeCount = mock.calls.length;
        const live = await fetch(app.base + '/data.json', { headers: { cookie: app.cookie } });
        check(live.status, 200, 'authenticated first read succeeds'); check(await live.json(), direct, 'actual route publication conservation');
        check(mock.calls.length - routeCount, 7, 'new server process has no restored evidence');
        const routeCachedCount = mock.calls.length;
        const cached = await fetch(app.base + '/data.json', { headers: { cookie: app.cookie } });
        check(await cached.json(), direct, 'actual browser route re-evaluates evidence');
        check(cached.headers.get('X-Atlas-Observation-Source'), 'memory', 'actual route reports reuse truthfully');
        check(cached.headers.get('X-Atlas-Observation-Checked-At'), CLOCK, 'actual route keeps original provider check');
        check(mock.calls.length, routeCachedCount, 'actual sequential browser route performs zero provider GETs');
        const assistantCount = mock.calls.length;
        check((await fetch(app.base + '/assistant/current', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 200, 'assistant/current succeeds under dedicated Bearer');
        check(mock.calls.length - assistantCount, 7, 'assistant/current remains live');
        check((await fetch(app.base + '/assistant/current', { headers: { cookie: app.cookie } })).status, 401, 'session cannot unlock assistant/current');
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const client = new Client({ name: 'synthetic-observation-proof', version: '1' });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(app.base + '/assistant/mcp'), {
            requestInit: { headers: { authorization: 'Bearer ' + app.mcpToken } }, }));
          const mcpCount = mock.calls.length;
          const result = await client.callTool({ name: 'get_atlas_current', arguments: {} });
          check(result.isError === true, false, 'OAuth MCP current read succeeds');
          check(mock.calls.length - mcpCount, 7, 'MCP current read remains live');
        } finally { await client.close(); }
        mock.mode('failure');
        check((await fetch(app.base + '/data.json?refresh=force', { headers: { cookie: app.cookie } })).status, 503, 'actual force failure is explicit');
        const retryCount = mock.calls.length;
        await fetch(app.base + '/data.json', { headers: { cookie: app.cookie } });
        check(mock.calls.length > retryCount, true, 'opening after failed force cannot hide failure behind old success');
        mock.mode('ok');
      } finally { await app.close(); }
    }
    // Packet consumers over HTTP: /assistant/current and MCP get_atlas_current
    // carry the same receipt the in-process projector produces. The child's
    // synthetic evidence clock is CLOCK (the preload stubs Date.now, which
    // the observer's fetch stamps use), while attemptedAt is the server's
    // real serve-completion stamp — the two are asserted separately, never
    // conflated.
    {
      const app = await atlas(mock, { mcp: true });
      try {
        const res = await fetch(app.base + '/assistant/current', { headers: { authorization: 'Bearer ' + TOKEN } });
        check(res.status, 200, 'assistant/current succeeds for the receipt read');
        const packet = await res.json();
        const httpReceipt = packet.metadata.sourceCheck || {};
        check({
          outcome: httpReceipt.outcome, source: httpReceipt.source, qualified: httpReceipt.qualified,
          evidenceCheckedAt: httpReceipt.evidenceCheckedAt, reason: httpReceipt.reason, cacheNote: httpReceipt.cacheNote,
        }, {
          outcome: 'qualified', source: 'provider', qualified: true,
          evidenceCheckedAt: CLOCK, reason: null, cacheNote: null,
        }, 'assistant/current receipt: qualified with the original evidence time');
        check(typeof httpReceipt.attemptedAt === 'string'
          && Number.isFinite(Date.parse(httpReceipt.attemptedAt))
          && httpReceipt.attemptedAt !== httpReceipt.evidenceCheckedAt, true,
          'assistant/current receipt: attempt time is a distinct serve-completion stamp');
        const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const client = new Client({ name: 'synthetic-receipt-proof', version: '1' });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(app.base + '/assistant/mcp'), {
            requestInit: { headers: { authorization: 'Bearer ' + app.mcpToken } }, }));
          const result = await client.callTool({ name: 'get_atlas_current', arguments: {} });
          check(result.structuredContent?.metadata?.sourceCheck?.outcome, 'qualified', 'MCP get_atlas_current receipt is qualified');
          check(result.structuredContent?.metadata?.sourceCheck?.evidenceCheckedAt, CLOCK, 'MCP receipt keeps the original evidence time');
        } finally { await client.close(); }
        mock.mode('failure');
        const failRes = await fetch(app.base + '/assistant/current', { headers: { authorization: 'Bearer ' + TOKEN } });
        const failPacket = await failRes.json();
        check(failPacket.metadata.sourceCheck.outcome, 'failed', 'assistant/current receipt after provider failure is failed');
        check(failPacket.metadata.sourceCheck.evidenceCheckedAt, null, 'failed HTTP receipt does not reuse the prior evidence time');
        mock.mode('ok');
        const missing = { ...Fixture.payload(), tags: [] };
        missing.accounts = missing.accounts.filter(row => row.id !== 2001);
        mock.payload(missing);
        const unqRes = await fetch(app.base + '/assistant/current', { headers: { authorization: 'Bearer ' + TOKEN } });
        const unqPacket = await unqRes.json();
        check(unqPacket.metadata.sourceCheck.outcome, 'unqualified', 'assistant/current receipt for a dated unqualified check is unqualified');
        check(unqPacket.metadata.freshness.confidence, 'live', 'HTTP packet freshness remains live on the unqualified overlay');
        mock.payload({ ...Fixture.payload(), tags: [] });
      } finally { await app.close(); }
    }
    // ATLAS-069: a failed refresh retains the last qualified observation.
    // The failed forced refresh holds replay, so the failure is never hidden
    // behind the earlier success; the retained evidence itself is not
    // destroyed. OD-4 (#821; Atlas review 6787237992): a failed live
    // revalidation keeps the hold too, so the next load asks the recovered
    // provider, and replay resumes only after that qualified publish.
    mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
    await Refresh.serve(canonical, env); await drain();
    mock.mode('failure');
    await reject(Refresh.serve(canonical, env, { preferObservation: true, forceRefresh: true }), 'live-refresh-unavailable'); await drain();
    let heldCheck;
    const heldCount = mock.calls.length;
    const held = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { heldCheck = value; } }); await drain();
    check(mock.calls.length > heldCount, true, 'read after a failed forced refresh revalidates live once');
    check(heldCheck.source, 'provider', 'revalidation after a failed force is a provider check, not a replay');
    check(held.liveOverlay.applied, false, 'failed revalidation does not advance cash');
    check(receiptPacket(held, heldCheck, '2026-08-20T18:35:00.000Z').metadata.sourceCheck, {
      outcome: 'failed', source: 'provider', qualified: false,
      evidenceCheckedAt: null, attemptedAt: '2026-08-20T18:35:00.000Z', reason: 'provider-check-failed', cacheNote: null,
    }, 'failed refresh keeps an explicit failed receipt with no evidence time');
    mock.mode('ok');
    let recoveredCheck;
    const recoveredCount = mock.calls.length;
    const recovered = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { recoveredCheck = value; } }); await drain();
    check(mock.calls.length - recoveredCount, 7, 'after a failed revalidation the next load asks the recovered provider, never replays old evidence');
    check(recoveredCheck, { source: 'provider', qualified: true, checkedAt: CLOCK }, 'recovered load is a new qualified provider check');
    check(recovered, direct, 'recovered provider check conserves the qualified publication');
    let retainedCheck;
    const retainedCount = mock.calls.length;
    const retained = await Refresh.serve(canonical, env, { preferObservation: true, onCheck(value) { retainedCheck = value; } }); await drain();
    check(mock.calls.length - retainedCount, 0, 'replay resumes after the qualified publish (0 provider calls)');
    check(retainedCheck, { source: 'memory', qualified: true, checkedAt: CLOCK }, 'retained replay keeps the original check time');
    check(retained, direct, 'retained replay conserves the qualified publication');
    await Refresh.withProviderWrite(async () => ({ status: 'write-unverified' }));
    const retainedWriteCount = mock.calls.length;
    await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
    check(mock.calls.length - retainedWriteCount, 7, 'a write still invalidates retained evidence');
    const retainedContextCount = mock.calls.length;
    await Refresh.serve(canonical, { ...env, LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-DIFFERENT-TOKEN' }, { preferObservation: true }); await drain();
    check(mock.calls.length - retainedContextCount, 7, 'a changed credential context still misses retained evidence');
    const superseded = { ...Fixture.payload(), tags: [] };
    superseded.accounts = superseded.accounts.filter(row => row.id !== 2001);
    mock.payload(superseded);
    await Refresh.serve(canonical, env); await drain();
    const supersededCount = mock.calls.length;
    await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
    check(mock.calls.length - supersededCount, 7, 'a dated unqualified answer still supersedes retained evidence');
    mock.payload({ ...Fixture.payload(), tags: [] });
    await Refresh.serve(canonical, env); await drain();

    // ATLAS-069 review repair: a failed FORCED refresh restores the whole
    // publication barrier on every termination path — in-flight replays are
    // invalidated and replay is held — while the slot itself is retained.
    // A merely-attempted (non-forced) failed refresh keeps the retention
    // behaviour pinned above.
    {
      // Delayed-replay race: a failing forced refresh invalidates an
      // in-flight replay of the retained observation.
      const raceEnv = { ...env, ATLAS_SYNTHETIC_REPLAY_DELAY_MS: '800',
        NODE_OPTIONS: '--require "' + __filename.replace(/\\/g, '/') + '"' };
      await Refresh.serve(canonical, raceEnv); await drain();
      mock.mode('failure');
      const raceReplay = reject(Refresh.serve(canonical, raceEnv, { preferObservation: true }), 'live-refresh-invalidated');
      await reject(Refresh.serve(canonical, raceEnv, { forceRefresh: true }), 'live-refresh-unavailable');
      await raceReplay; await drain();
      mock.mode('ok');
    }
    {
      // A forced waiter timeout holds replay even while a second waiter
      // keeps the job alive and the job later completes unqualified.
      await Refresh.serve(canonical, env); await drain();
      mock.hold();
      const timedOut = reject(Refresh.serve(canonical, env, { forceRefresh: true, timeoutMs: 20 }), 'live-refresh-timeout');
      const survivor = Refresh.serve(canonical, env);
      await timedOut;
      mock.mode('failure'); mock.release();
      const survived = await survivor; await drain();
      check(survived.liveOverlay.applied, false, 'surviving waiter still receives the failed completion');
      mock.mode('ok');
      const holdCount = mock.calls.length;
      await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
      check(mock.calls.length - holdCount, 7, 'forced waiter timeout holds replay until a live completion');
    }
    {
      // A forced waiter timeout that terminates the job still holds replay.
      await Refresh.serve(canonical, env); await drain();
      mock.hold();
      await reject(Refresh.serve(canonical, env, { forceRefresh: true, timeoutMs: 20 }), 'live-refresh-timeout');
      mock.release(); await drain();
      const holdCount = mock.calls.length;
      await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
      check(mock.calls.length - holdCount, 7, 'job terminated by forced timeout holds replay');
    }
    {
      // A worker-constructor failure on a forced refresh holds replay. The
      // driver runs in a child process: server-live-refresh binds
      // worker_threads.Worker at require time, so the throwing subclass
      // must be installed before the module loads, which this process
      // cannot do for its own already-loaded copy.
      const driver = path.join(ROOT, 'test', 'atlas069-constructor-failure-driver.js');
      const child = spawn(process.execPath, [driver], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', () => {});
      const code = await new Promise(resolve => child.once('exit', resolve));
      check(code, 0, 'constructor failure on forced refresh holds replay (child driver exit)');
      check(out.includes('ATLAS069-CONSTRUCTOR-OK'), true, 'constructor failure child driver completed its sequence');
    }
    {
      // Preservation: a transport-unreachable worker completion still
      // rejects a forced read outright (worker failure path).
      const dead = await provider(); const deadBase = dead.base; await dead.close();
      const deadEnv = { ...env, ATLAS_LUNCHMONEY_API_BASE: deadBase };
      await reject(Refresh.serve(canonical, deadEnv, { forceRefresh: true }), 'live-refresh-unavailable'); await drain();
      await Refresh.serve(canonical, env); await drain();
    }
    {
      // Preservation: day rollover still invalidates retained evidence.
      const dayPayload = { ...Fixture.payload(), tags: [] };
      now = '2026-08-28T06:59:59.000Z'; dayPayload.accounts.forEach(row => { row.updated_at = now; row.balance_last_update = now; }); mock.payload(dayPayload);
      const dayEnv = { ...env, ATLAS_LIVE_OVERLAY_NOW: now };
      await Refresh.serve(canonical, dayEnv); await drain();
      now = '2026-08-28T07:00:00.000Z';
      const dayCount = mock.calls.length;
      let rolledCheck = null;
      const rolled = await Refresh.serve(canonical, { ...dayEnv, ATLAS_LIVE_OVERLAY_NOW: now }, { preferObservation: true, onCheck(value) { rolledCheck = value; } }); await drain();
      check(mock.calls.length - dayCount, 7, 'day rollover still invalidates retained evidence');
      check(rolledCheck && rolledCheck.qualified, false, 'prior-day retained cash cannot become a new-day verdict');
      check(rolled.meta.asOf, '2026-08-27', 'prior-day retained cash keeps its own evidence day');
      now = CLOCK; mock.payload({ ...Fixture.payload(), tags: [] });
      await Refresh.serve(canonical, env); await drain();
    }

    originalLog('MEASURED ' + JSON.stringify({ providerFreeResponseMs: Math.round(providerFreeResponseMs * 100) / 100,
      sequentialProviderRequests: 0, proof: 'synthetic worker/HTTP; render measured separately' }));
    originalLog('PASS observation memory: ' + checks + ' checks; actual workers/routes, source-only cloning, qualification, force/failure, context, write races, calendar/DST and restart');
  } finally {
    Date.now = originalNow; console.log = originalLog; mock.release(); await drain(); await mock.close(); threads.Worker = RealWorker;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
