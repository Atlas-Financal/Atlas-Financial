'use strict';
// Invented inputs, localhost GETs and real production workers. Implicit identity
// and period reads are substituted in memory, never household data or secrets.
const fs = require('node:fs'), path = require('node:path');
const threads = require('node:worker_threads');
const root = path.resolve(__dirname, '..');
const Fixture = require('./fixtures/budget-surface-data');
const Timing = require('../scripts/refresh-stage-timing');
const replacements = {
  [path.join(root, 'data.json')]: Fixture.canonical(),
  [path.join(root, 'public/periods.json')]: null,
  [path.join(root, 'docs/connectivity/transaction-identity.json')]: Fixture.identity,
};
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (typeof file === 'string') {
    const resolved = path.resolve(file);
    if (Object.hasOwn(replacements, resolved)) {
      const bytes = JSON.stringify(replacements[resolved]);
      return typeof args[0] === 'string' || args[0]?.encoding ? bytes : Buffer.from(bytes);
    }
  }
  return Reflect.apply(read, this, [file, ...args]);
};

if (!threads.isMainThread) {
  Date.now = () => Date.parse(Fixture.payload().fetchedAt);
  const fault = process.env.ATLAS_STAGE_TEST_FAULT;
  if (fault === 'error') throw new Error('SYNTHETIC-PRIVATE-WORKER-CANARY');
  if (fault === 'exit') process.exit(7);
  if (fault === 'invalid-progress') {
    threads.parentPort.postMessage({ type: Timing.MESSAGE,
      stages: { workerComplete: false, ...Object.fromEntries(Timing.FIELDS.map(key => [key, 987654321])),
        rawPayload: 'SYNTHETIC-PRIVATE-CANARY' } });
  }
} else {
  const test = require('node:test'), assert = require('node:assert/strict');
  const helper = require('./test-server-observation-memory');
  const O = require('../scripts/provider-observe'), F = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const fields = ['providerAcquireMs', 'normalizeMs', 'overlayMs', 'forecastMs', 'sourceReplayMs'];
  const snapshotKeys = ['workerComplete', ...fields].sort();
  const recordKeys = ['type', 'source', 'outcome', 'qualified', ...snapshotKeys, 'publicationMs'].sort();
  const empty = Object.fromEntries([['workerComplete', false], ...fields.map(key => [key, null])]);
  function validSnapshot(value) {
    assert.deepEqual(Object.keys(value).sort(), snapshotKeys);
    assert.equal(typeof value.workerComplete, 'boolean');
    for (const key of fields) assert(value[key] === null || Number.isFinite(value[key]) && value[key] >= 0, key);
  }
  function validRecord(value) {
    assert.deepEqual(Object.keys(value).sort(), recordKeys);
    assert.equal(value.type, 'live-refresh-stages');
    assert(['provider', 'memory'].includes(value.source));
    assert(['completed', 'live-refresh-cancelled', 'live-refresh-timeout', 'live-refresh-unavailable', 'live-refresh-invalidated'].includes(value.outcome));
    assert(value.qualified === null || typeof value.qualified === 'boolean');
    assert(value.publicationMs === null || Number.isFinite(value.publicationMs) && value.publicationMs >= 0);
    validSnapshot(Object.fromEntries(snapshotKeys.map(key => [key, value[key]])));
  }
  function acquisition(t, failure = false) {
    const payload = { ...Fixture.payload(), tags: [] };
    const fetch = t.mock.method(O, 'fetchLunchMoneyLive', async () => {
      if (failure) throw new Error('SYNTHETIC-PRIVATE-PROVIDER-CANARY');
      return structuredClone(payload);
    });
    t.mock.method(O, 'loadLiveAccountMap', () => structuredClone(Fixture.map));
    t.mock.method(O, 'resolveLiveCredential', async () => ({ token: 'SYNTHETIC-OFFLINE-TOKEN', source: 'env' }));
    for (const name of ['node:http', 'node:https']) t.mock.method(require(name), 'request', () => { throw new Error('External network refused'); });
    return fetch;
  }
  async function apply(options = {}) {
    let check;
    const data = await Live.applyForServer(Fixture.canonical(), { ATLAS_LIVE_OVERLAY: 'live' },
      { ...options, onObservation: value => { check = value; } });
    return { data, check };
  }

  test('closed timing schema rejects extra fields and non-finite/negative durations', () => {
    assert.deepEqual(Timing.accept(empty), empty);
    for (const value of [null, {}, { ...empty, privateValue: 'canary' }, { ...empty, workerComplete: 1 }]) assert.equal(Timing.accept(value), null);
    for (const key of fields) for (const value of [NaN, Infinity, -1, '1', undefined]) assert.equal(Timing.accept({ ...empty, [key]: value }), null);
    const record = Timing.record({ ...empty, raw: 'SYNTHETIC-PRIVATE-CANARY' }, 'unknown', 'private-error', 'true', NaN);
    validRecord(record);
    assert.equal(record.source, 'provider'); assert.equal(record.outcome, 'live-refresh-unavailable');
    assert.equal(record.qualified, null); assert.equal(record.publicationMs, null);
    assert(!JSON.stringify(record).includes('CANARY'));
  });

  test('timing executes each operation once and preserves values/errors despite a failing sink', async () => {
    const value = {}, error = new Error('SYNTHETIC-PRIVATE-CANARY'); let calls = 0;
    const updates = [];
    assert.equal(await Timing.run(() => Timing.sync('normalizeMs', () => { calls++; return value; }), entry => updates.push(entry)), value);
    assert.equal(calls, 1); updates.forEach(validSnapshot); assert.equal(updates.at(-1).workerComplete, true);
    await assert.rejects(Timing.run(() => Timing.async('providerAcquireMs', async () => { calls++; throw error; }), () => { throw new Error('sink failed'); }), actual => actual === error);
    assert.equal(calls, 2);
    assert.equal(await Timing.run(() => Timing.sync('forecastMs', () => value), () => { throw error; }), value);
    let a, b;
    await Promise.all([
      Timing.run(() => Timing.async('providerAcquireMs', async () => value), entry => { a = entry; }),
      Timing.run(() => Timing.sync('forecastMs', () => value), entry => { b = entry; }),
    ]);
    assert.equal(a.forecastMs, null); assert.equal(b.providerAcquireMs, null);
  });

  test('timed fresh/replay results and receipts exactly match controls without repeated Forecast', async t => {
    const fetch = acquisition(t), recommend = t.mock.method(F, 'recommend'), observe = t.mock.method(O, 'observe');
    const control = await apply();
    assert.equal(control.check.qualified, true); assert(control.check.evidence);
    let last; const updates = [];
    const timed = await Timing.run(() => apply(), entry => { last = entry; updates.push(entry); });
    assert.deepEqual(timed, control, 'entire financial result and source evidence');
    assert.equal(fetch.mock.calls.length, 2); assert.equal(observe.mock.calls.length, 4);
    assert.equal(recommend.mock.calls.length, 2, 'one Forecast per fresh read, including replay proof');
    updates.forEach(validSnapshot); assert.equal(last.workerComplete, true);
    for (const key of fields) assert(Number.isFinite(last[key]) && last[key] >= 0, key);
    const replayControl = await apply({ evidence: control.check.evidence });
    const replay = await Timing.run(() => apply({ evidence: control.check.evidence }), entry => { last = entry; });
    assert.deepEqual(replay, replayControl); assert.deepEqual(replay.data, control.data);
    assert.equal(fetch.mock.calls.length, 2, 'replay does not reacquire');
    assert.equal(observe.mock.calls.length, 6); assert.equal(recommend.mock.calls.length, 4);
    assert.equal(last.providerAcquireMs, null); assert.equal(last.workerComplete, true);
  });

  test('acquisition failure retains identical fail-closed output and times its actual fallback Forecast', async t => {
    acquisition(t, true);
    const recommend = t.mock.method(F, 'recommend');
    const control = await apply(); let last;
    const timed = await Timing.run(() => apply(), entry => { last = entry; });
    assert.deepEqual(timed, control); assert.equal(timed.data.liveOverlay.applied, false);
    assert.equal(recommend.mock.calls.length, 2);
    assert.equal(last.normalizeMs, null); assert(Number.isFinite(last.providerAcquireMs));
    assert(Number.isFinite(last.forecastMs)); assert.equal(last.workerComplete, true);
  });

  test('actual workers preserve publication, replay, failure, cancellation and timeout with private closed logs', async () => {
    const workers = [], records = [], lifecycles = [];
    const RealWorker = threads.Worker, originalLog = console.log, originalNow = Date.now;
    threads.Worker = class extends RealWorker {
      constructor(file, options) {
        super(file, { ...options, execArgv: ['--require', __filename] });
        workers.push({ worker: this, exit: new Promise(resolve => this.once('exit', resolve)) });
      }
    };
    console.log = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('{')) {
        const value = JSON.parse(args[0]);
        if (value.type === 'live-refresh-stages') { records.push(value); return; }
        if (value.type === 'live-refresh-lifecycle') { lifecycles.push(value); return; }
      }
      originalLog(...args);
    };
    Date.now = () => Date.parse(Fixture.payload().fetchedAt);
    // Load after the Worker observer; production itself never exports workers.
    delete require.cache[require.resolve('../scripts/server-live-refresh')];
    const Refresh = require('../scripts/server-live-refresh');
    let mock;
    const drain = () => Promise.all(workers.map(worker => worker.exit));
    const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
    try {
      mock = await helper.provider();
      const env = helper.environment(mock.base), canonical = Fixture.canonical(), before = structuredClone(canonical);
      const expected = await Live.applyForServer(canonical, env, { onObservation() {} });
      let sourceCheck;
      const actual = await Refresh.serve(canonical, env, { onCheck: value => { sourceCheck = value; } }); await drain();
      assert.deepEqual(actual, expected); assert.equal(sourceCheck.qualified, true);
      assert.equal(records.at(-1).qualified, true); assert.equal(records.at(-1).workerComplete, true);
      assert(Number.isFinite(records.at(-1).publicationMs));
      const calls = mock.calls.length;
      const replay = await Refresh.serve(canonical, env, { preferObservation: true }); await drain();
      assert.deepEqual(replay, actual); assert.equal(mock.calls.length, calls);
      assert.equal(records.at(-1).source, 'memory'); assert.equal(records.at(-1).providerAcquireMs, null);
      mock.mode('failure');
      await reject(Refresh.serve(canonical, env, { forceRefresh: true }), 'live-refresh-unavailable'); await drain();
      assert.equal(records.at(-1).outcome, 'completed', 'worker completion is separate from qualification');
      assert.equal(records.at(-1).qualified, false); assert.equal(records.at(-1).workerComplete, true);
      mock.mode('ok'); mock.hold();
      const controller = new AbortController(), callBefore = mock.calls.length;
      const cancelled = Refresh.serve(canonical, env, { signal: controller.signal });
      const cancelledCheck = reject(cancelled, 'live-refresh-cancelled');
      await helper.until(() => mock.calls.length > callBefore, 'held acquisition started'); controller.abort();
      await cancelledCheck; await drain();
      assert.equal(records.at(-1).outcome, 'live-refresh-cancelled'); assert.equal(records.at(-1).workerComplete, false);
      assert.equal(records.at(-1).providerAcquireMs, null); assert.equal(records.at(-1).qualified, null);
      await reject(Refresh.serve(canonical, env, { timeoutMs: 200 }), 'live-refresh-timeout'); await drain();
      assert.equal(records.at(-1).outcome, 'live-refresh-timeout'); assert.equal(records.at(-1).workerComplete, false);
      for (const fault of ['error', 'exit']) {
        await reject(Refresh.serve(canonical, { ...env, ATLAS_STAGE_TEST_FAULT: fault }), 'live-refresh-unavailable'); await drain();
        assert.equal(records.at(-1).outcome, 'live-refresh-unavailable'); assert.equal(records.at(-1).workerComplete, false);
      }
      await reject(Refresh.serve(canonical, { ...env, ATLAS_STAGE_TEST_FAULT: 'invalid-progress' }, { timeoutMs: 200 }), 'live-refresh-timeout'); await drain();
      assert.equal(records.at(-1).normalizeMs, null, 'untrusted extra-field progress cannot publish');
      assert.equal(records.length, lifecycles.length); records.forEach(validRecord);
      assert(!/CANARY|merchant|account|token|credential|rawPayload|payee/i.test(JSON.stringify(records)));
      assert.deepEqual(canonical, before);
    } finally {
      mock?.release(); for (const worker of workers) await worker.worker.terminate().catch(() => {});
      await mock?.close(); threads.Worker = RealWorker; console.log = originalLog; Date.now = originalNow;
    }
  });
}
