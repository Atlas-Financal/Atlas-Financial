'use strict';
// ONE storage contract, run unchanged against BOTH period-history backends:
// the private file backend (full revisions) and the hosted PostgreSQL backend
// (sanitized projection) over an offline injected pg.Client double through the
// shared connection owner. Parametrised by record shape only: each backend
// stores a different record, but both must give the same guarantees.
//   C1 append-only revisions        C2 idempotent retry returns the same revision
//   C3 history-original-or-closing-conflict
//   C4 every revision hash intact on read-back; damage fails closed
//   C5 fail-closed when disabled, unconfigured or unreachable
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, NEXT, input, capture } = require('./fixtures/private-period-history-input');
const { pgWorld, URL_VALUE, CANARY } = require('./fixtures/period-history-pg-double');
const { startLocalPg } = require('./fixtures/period-history-local-pg');

const { digest } = History.contract;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-history-contract-'));
let dirs = 0;
// The connection owner refuses a process whose environment can redirect TLS
// trust. Run this suite in a clean environment (CI does); locally use env -u.
const trustClean = !Object.keys(process.env).some(k => /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i.test(k));

const fileBackend = {
  name: 'file',
  async open() {
    const destination = path.join(temporary, 'store-' + (++dirs));
    fs.mkdirSync(destination, { mode: 0o700 });
    this.destination = destination;
    return {
      append: async (candidate, enabled = true) => History.append({ destination, enabled, candidate }),
      read: async (opts = {}) => History.read({ destination, ...opts }),
      surface: ['append', 'read'],
    };
  },
  async corrupt() {
    const name = fs.readdirSync(this.destination).filter(n => n.endsWith('.json')).sort()[0];
    const file = path.join(this.destination, name);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('"opening":1500'));
    fs.writeFileSync(file, text.replace('"opening":1500', '"opening":1501'), { mode: 0o600 });
  },
  async count() { return fs.readdirSync(this.destination).filter(n => n.endsWith('.json')).length; },
  unavailable() {
    const missing = path.join(temporary, 'missing-' + (++dirs));
    return [() => History.append({ destination: missing, enabled: true, candidate: capture(input()) }),
      () => History.read({ destination: missing }), () => History.read({ destination: 'relative/path' })];
  },
};

const postgresBackend = {
  name: 'postgres',
  async open() {
    this.world = pgWorld();
    const store = await Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: this.world.Client });
    return {
      append: async (candidate, enabled = true) => store.append({ enabled, candidate }),
      read: async (opts = {}) => store.read(opts),
      surface: Object.keys(store).filter(k => !['retire', 'status'].includes(k)),
    };
  },
  async corrupt() {
    const row = this.world.committed[0];
    assert.ok(row.record.includes('"opening":1500'));
    row.record = row.record.replace('"opening":1500', '"opening":1501');
  },
  async count() { return this.world.committed.length; },
  unavailable() {
    const refused = pgWorld({ connect: async () => { throw Object.assign(new Error(CANARY), { code: 'ECONNREFUSED' }); } });
    const authFail = pgWorld({ fail: ({ index }) => index === 0 ? Object.assign(new Error(CANARY), { code: '28P01' }) : null });
    const updatable = pgWorld(); updatable.catalog.privileges.tables = false; // e.g. UPDATE or DELETE was granted
    return [
      () => Pg.openPeriodHistoryPostgres({ env: {}, Client: refused.Client }),
      () => Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE.replace('verify-full', 'require') }, Client: refused.Client }),
      () => Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: refused.Client }),
      () => Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: authFail.Client }),
      () => Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: updatable.Client }),
    ];
  },
};

// Third backend: a real local PostgreSQL built from the owner setup SQL, over
// real verify-full TLS. Runs only when ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN is set.
let local = null;
const localBackend = {
  name: 'postgres-local',
  async open() {
    // The writer role allows ONE connection: retire the previous session first.
    if (this.store) await this.store.retire();
    await local.admin('TRUNCATE atlas_period_history.revisions');
    this.store = await Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url }, Client: local.LocalClient });
    const store = this.store;
    return {
      append: async (candidate, enabled = true) => store.append({ enabled, candidate }),
      read: async (opts = {}) => store.read(opts),
      surface: Object.keys(store).filter(k => !['retire', 'status'].includes(k)),
    };
  },
  async corrupt() {
    await local.admin(`UPDATE atlas_period_history.revisions SET record = replace(record, '"opening":1500', '"opening":1501') WHERE sequence = 1`);
  },
  async count() { return Number((await local.admin('SELECT count(*)::int AS n FROM atlas_period_history.revisions')).rows[0].n); },
  unavailable() {
    const free = async () => { if (localBackend.store) await localBackend.store.retire(); };
    return [
      async () => { await free(); return Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url.replace(local.password, 'wrong' + local.password) }, Client: local.LocalClient }); },
      async () => { await free(); return Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url }, Client: local.UntrustedClient }); },
      async () => { await free(); return Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: local.url }, Client: local.LocalClient, schema: 'absent_schema' }); },
    ];
  },
};

function rejectsWith(promiseOrFn, code) {
  return assert.rejects(async () => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn),
    error => (code instanceof RegExp ? code.test(error.code) : error.code === code)
      && !String(error.message).includes(CANARY) && !JSON.stringify(error.diagnostic || null).includes(CANARY), String(code));
}

// Fixed scenario across two pay periods; every candidate is captured once.
const original = capture(input());
const originalRetry = capture(input({ capturedAt: START + 'T18:05:00Z' })); // new wall clock, same content
const originalConflict = capture(input({ cash: [1001, 500, 100], capturedAt: START + 'T18:06:00Z' }));
const closing = capture(input({ day: NEXT, kind: 'closing' }));
const closingConflict = capture(input({ day: NEXT, kind: 'closing', cash: [999, 500, 100], capturedAt: NEXT + 'T18:07:00Z' }));
const correction = capture(input({ day: NEXT, kind: 'actual-correction', cash: [998, 500, 100], capturedAt: NEXT + 'T18:08:00Z' }));
const laterClosing = capture(input({ day: '2030-03-01', kind: 'closing', periodStart: NEXT }));
const nextOpening = capture(input({ day: NEXT, kind: 'first-observed', periodStart: NEXT, capturedAt: NEXT + 'T18:09:00Z' }));

let localSkip = 'not started';
test.before(async () => {
  if (!trustClean) { localSkip = 'UNRUN: TLS-trust variables present'; return; }
  const started = await startLocalPg();
  if (started.skip) localSkip = started.skip; else { local = started; localSkip = false; }
});
for (const backend of [fileBackend, postgresBackend, localBackend]) {
  const skipFor = () => backend.name === 'postgres-local' ? localSkip : backend.name === 'postgres' && !trustClean
    ? 'process environment carries TLS-trust variables the connection owner refuses; run with them unset' : false;
  test(`[${backend.name}] C1-C4 contract: append-only, idempotent, conflict-detecting, hash-intact`, async t => {
    if (skipFor()) return t.skip(skipFor());
    const store = await backend.open();
    assert.deepEqual(store.surface.sort(), ['append', 'read'], 'no update or delete surface');

    const a = await store.append(original);
    assert.equal(a.status, 'appended'); assert.equal(a.sequence, 1); assert.equal(a.kind, 'original');
    const snapshot = await store.read({ revisionId: a.revisionId });

    // C2: exact retry and regenerated retry both return the same revision.
    for (const retry of [original, originalRetry]) {
      const again = await store.append(retry);
      assert.equal(again.status, 'duplicate'); assert.equal(again.revisionId, a.revisionId);
    }
    assert.equal(await backend.count(), 1, 'retry writes nothing');

    // C3: a second baseline, or a second differing closing, is a conflict.
    await rejectsWith(store.append(originalConflict), 'history-original-or-closing-conflict');
    const c = await store.append(closing);
    assert.equal(c.status, 'appended'); assert.equal(c.sequence, 2); assert.equal(c.previousRevision, a.revisionId);
    assert.equal(c.baselineRevision, a.revisionId);
    await rejectsWith(store.append(closingConflict), 'history-original-or-closing-conflict');
    assert.equal(await backend.count(), 2, 'refused appends write nothing');

    const fix = await store.append(correction);
    assert.equal(fix.status, 'appended'); assert.equal(fix.kind, 'actual-correction');
    const next = await store.append(nextOpening);
    assert.equal(next.sequence, 4); assert.equal(next.baselineRevision, null, 'next period has its own baseline chain');

    // C1: earlier revisions are byte-for-byte unchanged by later appends.
    assert.deepEqual(await store.read({ revisionId: a.revisionId }), snapshot);

    // C4: every revision re-hashes to its id; the chain is unbroken.
    const list = await store.read();
    assert.deepEqual(list.map(r => r.sequence), [1, 2, 3, 4]);
    let previous = null;
    for (const meta of list) {
      const row = await store.read({ revisionId: meta.revisionId });
      const { revisionId, ...body } = row;
      assert.equal(digest(body), revisionId, 'hash intact on read-back');
      assert.equal(row.previousRevision, previous); previous = revisionId;
    }
    assert.equal((await store.read({ expectedHead: next.revisionId })).length, 4);
    await rejectsWith(store.read({ expectedHead: a.revisionId }), 'history-head-mismatch');
    await rejectsWith(store.read({ revisionId: 'f'.repeat(64) }), 'history-revision-unavailable');

    // Damage to one stored byte fails every later read and append closed.
    await backend.corrupt();
    // The file backend may catch it at the capture-id or the revision hash; both are integrity failures.
    await rejectsWith(store.read(), /^history-(capture-)?integrity-failed$/);
    await rejectsWith(store.append(laterClosing), /^history-(capture-)?integrity-failed$/);
    assert.equal(await backend.count(), 4, 'nothing appended over a damaged chain');
  });

  test(`[${backend.name}] C5 contract: fail closed when disabled, tampered, unconfigured or unreachable`, async t => {
    if (skipFor()) return t.skip(skipFor());
    const store = await backend.open();
    await rejectsWith(store.append(original, false), 'history-capture-disabled');
    const tampered = { ...original, capturedAt: '2030-02-01T18:02:00.000Z' };
    await rejectsWith(store.append(tampered), 'history-capture-integrity-failed');
    assert.equal(await backend.count(), 0);
    for (const attempt of backend.unavailable()) await rejectsWith(attempt, /^history-/);
  });
}

test.after(async () => {
  fs.rmSync(temporary, { recursive: true, force: true });
  if (localBackend.store) await localBackend.store.retire();
  if (local) local.stop();
});
