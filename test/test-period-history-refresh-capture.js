'use strict';
// Capture-on-refresh writer (#818, PR-A). Invented finances and identities
// only; no data.json, live credential or provider write.
//   C1 off by default: no flag, no worker, nothing captured
//   C2 one closing per period and one baseline; every repeat is a no-op
//   C3 original only on the opening household day, otherwise first-observed
//   C4 store failures stay code-only and never throw
//   C5 engine identity: Git checkout, deploy-commit fallback, refusal
//   C6 offer() is fire-and-forget: never throws, single-flight, throttled
//   C7 a real qualified refresh is served while the store hangs (timing)
//   C8 the same decisions against a real local PostgreSQL (UNRUN unless
//      ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN is set)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const threads = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const Capture = require('../scripts/period-history-refresh-capture');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { pgWorld, URL_VALUE } = require('./fixtures/period-history-pg-double');
const { START, END, NEXT, input } = require('./fixtures/private-period-history-input');

// Fixture cycles: 02-01..02-14, then 02-15..02-28.
const NEXT_END = '2030-02-28';
const LATER = '2030-02-20';
function evidence(day, cash) {
  const raw = input({ day, cash, periodStart: START });
  delete raw.kind; delete raw.periodStart;
  const at = raw.capturedAt; delete raw.capturedAt;
  return { raw, now: () => new Date(at) };
}
const TRUST = /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i;
const trustClean = !Object.keys(process.env).some(k => TRUST.test(k));
const UNRUN = 'UNRUN: process environment carries TLS-trust variables the connection owner refuses; run with them unset';
async function openDouble() {
  const world = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: world.Client });
  return { world, store };
}
const kinds = rows => rows.map(r => [r.kind, r.period.start, r.period.end]);

async function decisions(store) {
  // Opening day of cycle 2: closes cycle 1 and records cycle 2's original.
  const a = evidence(NEXT);
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store, now: a.now }), { closing: 'appended', opening: 'appended' });
  assert.deepEqual(kinds(await store.read()), [['closing', START, END], ['original', NEXT, NEXT_END]]);
  // Exact repeat, and a same-period refresh with changed evidence: no-ops,
  // never a second closing or a singleton conflict.
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store, now: a.now }), { closing: 'already-captured', opening: 'already-captured' });
  const b = evidence(LATER, [900, 450, 100]);
  assert.deepEqual(await Capture.captureOnce({ input: b.raw, store, now: b.now }), { closing: 'already-captured', opening: 'already-captured' });
  assert.equal((await store.read()).length, 2, 'exactly one closing and one baseline');
}

test('C1 off by default: no flag means no worker and nothing captured', () => {
  let spawned = 0;
  const owner = Capture.create({ spawn: () => { spawned++; throw new Error('must not spawn'); }, log: () => {} });
  const ev = { schema: 'x', payload: {} };
  for (const env of [{}, { [Capture.FLAG]: 'ON' }, { [Capture.FLAG]: '1' }, { [Capture.FLAG]: 'true' }, undefined]) {
    assert.equal(owner.offer({ canonical: {}, evidence: ev, env }), 'disabled');
  }
  assert.equal(spawned, 0);
});

test('C2 one closing per period and one baseline; repeats are no-ops', async t => {
  if (!trustClean) return t.skip(UNRUN);
  const { store } = await openDouble();
  await decisions(store);
  await store.retire();
});

test('C3 original only on the opening day; otherwise first-observed', async t => {
  if (!trustClean) return t.skip(UNRUN);
  const { store } = await openDouble();
  const later = evidence(LATER);
  assert.deepEqual(await Capture.captureOnce({ input: later.raw, store, now: later.now }), { closing: 'appended', opening: 'appended' });
  const rows = await store.read();
  assert.deepEqual(kinds(rows), [['closing', START, END], ['first-observed', NEXT, NEXT_END]]);
  assert.equal(rows[1].planBasis, 'first-observed-original-unavailable');
  // A later opening-day observation cannot replace the first-observed baseline.
  const opening = evidence(NEXT);
  assert.deepEqual(await Capture.captureOnce({ input: opening.raw, store, now: opening.now }), { closing: 'already-captured', opening: 'already-captured' });
  await store.retire();
});

test('C4 store failures are fixed codes and never throw', async () => {
  const a = evidence(NEXT);
  const unreadable = { read: async () => { throw new Error('PRIVATE-DRIVER-TEXT'); }, append: async () => assert.fail('no append') };
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store: unreadable, now: a.now }),
    { closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
  const failing = { read: async () => [], append: async () => { const e = new Error('history-commit-uncertain'); e.code = e.message; throw e; } };
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store: failing, now: a.now }),
    { closing: 'history-commit-uncertain', opening: 'history-commit-uncertain' });
  const broken = { read: async () => [], append: async () => { throw new Error('PRIVATE-DRIVER-TEXT'); } };
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store: broken, now: a.now }),
    { closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
  const conflicted = { read: async () => [], append: async () => { const e = new Error('history-original-or-closing-conflict'); e.code = e.message; throw e; } };
  assert.deepEqual(await Capture.captureOnce({ input: a.raw, store: conflicted, now: a.now }),
    { closing: 'already-captured', opening: 'already-captured' }, 'a concurrent winner is the same no-op');
  const invalid = { ...a.raw, accountMap: { ...a.raw.accountMap, scope: 'fixture' } };
  const result = await Capture.captureOnce({ input: invalid, store: { read: async () => [], append: async () => assert.fail('no append') }, now: a.now });
  assert.match(result.closing, /^history-[a-z-]+$/); assert.match(result.opening, /^history-[a-z-]+$/);
});

test('C5 engine identity: checkout, deploy fallback, refusal', () => {
  const sha = 'a'.repeat(40), deploy = 'b'.repeat(40);
  const root = require('node:path').resolve(__dirname, '..');
  const checkout = (head, dirty = false) => args => {
    if (args[0] === 'rev-parse') return root + '\n' + head + '\n';
    if (dirty) throw new Error('dirty'); return '';
  };
  const noGit = () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
  const refused = fn => assert.throws(fn, e => e.code === 'history-engine-version-unavailable');
  assert.equal(History.engineCommit({ git: checkout(sha), env: {} }), sha, 'clean checkout');
  assert.equal(History.engineCommit({ git: checkout(sha), env: { RENDER_GIT_COMMIT: deploy } }), sha, 'checkout wins over the deploy variable');
  refused(() => History.engineCommit({ git: checkout(sha, true), env: { RENDER_GIT_COMMIT: deploy } }));
  refused(() => History.engineCommit({ git: checkout('not-a-commit'), env: { RENDER_GIT_COMMIT: deploy } }));
  assert.equal(History.engineCommit({ git: noGit, env: { RENDER_GIT_COMMIT: deploy } }), deploy, 'no checkout: deploy commit');
  const foreign = args => args[0] === 'rev-parse' ? '/\n' + sha + '\n' : '';
  assert.equal(History.engineCommit({ git: foreign, env: { RENDER_GIT_COMMIT: deploy } }), deploy, 'an enclosing foreign repository is not this engine');
  refused(() => History.engineCommit({ git: foreign, env: {} }));
  for (const env of [{}, { RENDER_GIT_COMMIT: '' }, { RENDER_GIT_COMMIT: 'B'.repeat(40) }, { RENDER_GIT_COMMIT: 'b'.repeat(39) }, { RENDER_GIT_COMMIT: deploy + '\n' }]) {
    refused(() => History.engineCommit({ git: noGit, env }));
  }
});

test('C6 offer() is fire-and-forget: never throws, single-flight, throttled, done per day', async () => {
  const lines = [];
  let now = 0, spawned = 0, worker = null;
  const { EventEmitter } = require('node:events');
  const spawn = () => { spawned++; worker = new EventEmitter(); worker.terminate = async () => {}; return worker; };
  const owner = Capture.create({ spawn, clock: () => now, log: line => lines.push(JSON.parse(line)) });
  const env = { [Capture.FLAG]: 'on' }, ev = { payload: {} };
  assert.equal(owner.offer({ canonical: {}, evidence: null, env }), 'no-evidence');
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'started');
  assert.equal(spawned, 0, 'no worker starts inside the caller turn');
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'busy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spawned, 1);
  worker.emit('message', { closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
  assert.deepEqual(lines.at(-1), { type: 'period-history-capture', closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'throttled', 'a failure is retried later, not on every load');
  now += Capture.RETRY_MS;
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'started');
  await new Promise(resolve => setImmediate(resolve));
  worker.emit('message', { closing: 'appended', opening: 'already-captured' });
  now += Capture.RETRY_MS;
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'done', 'a captured day is not re-attempted');
  assert.equal(owner.offer({ canonical: {}, evidence: ev, env, day: 'd2' }), 'started');
  await new Promise(resolve => setImmediate(resolve));
  worker.emit('exit', 1);
  assert.deepEqual(lines.at(-1), { type: 'period-history-capture', closing: 'history-capture-failed', opening: 'history-capture-failed' });
  const throwing = Capture.create({ spawn: () => { throw new Error('PRIVATE'); }, log: line => lines.push(JSON.parse(line)) });
  assert.equal(throwing.offer({ canonical: {}, evidence: ev, env, day: 'd1' }), 'started');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.at(-1).closing, 'history-capture-failed');
  assert.ok(lines.every(line => Object.keys(line).join() === 'type,closing,opening'), 'fixed fields only');
});

test('C7 a qualified refresh is served while capture is still running', async () => {
  const Fixture = require('./fixtures/budget-surface-data');
  const payload = { ...Fixture.payload(), tags: [] };
  const clock = Date.parse(payload.fetchedAt), realNow = Date.now;
  // The refresh owner checks its financial day against the fixture clock.
  Date.now = () => clock;
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/v2/me') return send({ user_id: 1 });
    if (url.pathname === '/v2/plaid_accounts') return send({ plaid_accounts: payload.accounts });
    if (url.pathname === '/v2/manual_accounts') return send({ manual_accounts: [] });
    if (url.pathname === '/v2/categories') return send({ categories: payload.categories });
    if (url.pathname === '/v2/tags') return send({ tags: [] });
    if (url.pathname === '/v2/transactions') {
      const pending = url.searchParams.get('is_pending') === 'true';
      return send({ has_more: false, transactions: payload.transactions.filter(tx => !pending || tx.is_pending) });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const lines = [], log = console.log;
  console.log = (...args) => { if (typeof args[0] === 'string' && args[0].includes('"period-history-capture"')) lines.push(JSON.parse(args[0])); };
  // Every worker is real. In 'hang' mode the capture worker is replaced by
  // one that never answers until released: a store that never responds.
  const workers = [], captures = [], RealWorker = threads.Worker;
  let mode = 'real';
  threads.Worker = class extends RealWorker {
    constructor(file, options) {
      const capture = options && options.workerData && options.workerData.periodHistoryCapture === true;
      if (capture && mode === 'hang') {
        super("require('node:worker_threads').parentPort.once('message', m => require('node:worker_threads').parentPort.postMessage(m))", { eval: true });
      } else super(file, options);
      if (capture) captures.push(this);
      workers.push(new Promise(r => this.once('exit', r)));
    }
  };
  const fresh = () => {
    for (const name of ['../scripts/server-live-refresh', '../scripts/period-history-refresh-capture']) delete require.cache[require.resolve(name)];
    return require('../scripts/server-live-refresh');
  };
  const until = async (predicate, label) => {
    const deadline = performance.now() + 30000;
    while (!predicate()) { if (performance.now() > deadline) assert.fail('deadline: ' + label); await new Promise(r => setTimeout(r, 20)); }
  };
  try {
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    const base = { ...env, ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-CREDENTIAL-CANARY',
      ATLAS_LUNCHMONEY_API_BASE: 'http://127.0.0.1:' + provider.address().port + '/v2', ATLAS_LIVE_OVERLAY_NOW: payload.fetchedAt,
      ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...Fixture.map, scope: 'live' }) };
    // Reference: the same refresh with capture off starts no capture worker.
    let Refresh = fresh();
    const t0 = performance.now();
    const off = await Refresh.serve(Fixture.canonical(), base);
    const offMs = performance.now() - t0;
    assert.equal(off.liveOverlay.applied, true, 'reference refresh qualifies');
    await Promise.all(workers.splice(0));
    assert.equal(captures.length, 0, 'capture off: no capture worker');
    assert.equal(lines.length, 0);

    // Real capture worker, end to end: it builds the input from the served
    // refresh's own evidence and reaches the archive, which is unconfigured.
    Refresh = fresh();
    assert.deepEqual(await Refresh.serve(Fixture.canonical(), { ...base, [Capture.FLAG]: 'on' }), off, 'capture changes nothing served');
    await until(() => lines.length === 1, 'real capture outcome');
    assert.deepEqual(lines.pop(), { type: 'period-history-capture', closing: 'history-store-unconfigured', opening: 'history-store-unconfigured' });
    await Promise.all(workers.splice(0));

    // Hung capture: the refresh resolves with the identical publication, in
    // about the same time, while the capture worker has not answered.
    mode = 'hang'; captures.length = 0;
    Refresh = fresh();
    const t1 = performance.now();
    const on = await Refresh.serve(Fixture.canonical(), { ...base, [Capture.FLAG]: 'on' });
    const onMs = performance.now() - t1;
    assert.deepEqual(on, off, 'capture changes nothing served');
    await until(() => captures.length === 1, 'capture worker started after the refresh was served');
    assert.equal(lines.length, 0, 'the refresh was served before the capture finished');
    assert.ok(onMs < offMs + 2000, `served in ${Math.round(onMs)}ms vs ${Math.round(offMs)}ms with capture off`);
    // A second refresh while capture is still hung is also served at once.
    const t2 = performance.now();
    assert.deepEqual(await Refresh.serve(Fixture.canonical(), { ...base, [Capture.FLAG]: 'on' }), off);
    assert.ok(performance.now() - t2 < offMs + 2000, 'a refresh during a hung capture is not delayed');
    assert.equal(captures.length, 1, 'single-flight: no second capture worker while one runs');
    captures[0].postMessage({ closing: 'history-store-unavailable', opening: 'history-store-unavailable' });
    await until(() => lines.length === 1, 'released capture outcome');
    assert.deepEqual(lines, [{ type: 'period-history-capture', closing: 'history-store-unavailable', opening: 'history-store-unavailable' }]);
    for (const worker of captures) worker.terminate();
    await Promise.all(workers);
  } finally {
    console.log = log; threads.Worker = RealWorker; Date.now = realNow;
    provider.closeAllConnections(); provider.close();
  }
});

test('C8 the same decisions against a real local PostgreSQL', async t => {
  const { startLocalPg } = require('./fixtures/period-history-local-pg');
  if (!trustClean) return t.skip(UNRUN);
  const local = await startLocalPg();
  if (local.skip) return t.skip(local.skip);
  try {
    await local.admin('TRUNCATE atlas_period_history.revisions');
    const store = await Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url }, Client: local.LocalClient });
    try { await decisions(store); } finally { await store.retire(); }
  } finally { local.stop(); }
});
