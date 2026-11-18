'use strict';
// The live fetch's provider GETs: me, plaid and manual accounts, categories, tags,
// the windowed and pending transactions, and the recurring-items read (S1).
// Seven reads, the recurring-items read, the two budget reads and the 200-day fixed-amount history read (#1355).
const PROVIDER_GETS = 11;
// Real workers and loopback provider calls. Every input is synthetic; no live
// credential, household file edit, provider write or completed response cache.
const threads = require('node:worker_threads');

// This same file is a worker-only preload for exception/early-exit controls.
// Normal publication and transport tests below use the real LivePlan unchanged.
if (!threads.isMainThread && process.env.ATLAS_COALESCING_TEST_WORKER_MODE) {
  const Live = require('../scripts/live-plan');
  Live.applyForServer = process.env.ATLAS_COALESCING_TEST_WORKER_MODE === 'exit'
    ? () => process.exit(7)
    : () => Promise.reject(new Error('SYNTHETIC-PRIVATE-WORKER-ERROR-must-not-be-logged'));
} else if (threads.isMainThread && require.main === module) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');
  const events = require('node:events');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const { performance } = require('node:perf_hooks');
  const workers = [], timings = [];
  const RealWorker = threads.Worker;
  threads.Worker = class extends RealWorker {
    constructor(file, options) {
      super(file, options);
      const record = { worker: this, ended: false };
      record.exit = new Promise(resolve => this.once('exit', () => { record.ended = true; resolve(); }));
      workers.push(record);
    }
  };
  const Refresh = require('../scripts/server-live-refresh');
  const Live = require('../scripts/live-plan');
  const Fixture = require('./fixtures/budget-surface-data');
  const canonical = Fixture.canonical(), payload = Fixture.payload();
  const map = { ...Fixture.map, scope: 'live' };
  const originalLog = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{')) {
      const entry = JSON.parse(args[0]);
      if (entry.type === 'live-refresh-lifecycle') { timings.push(entry); return; }
    }
    originalLog(...args);
  };
  let checks = 0;
  const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function bounded(promise, label) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic test deadline: ' + label)), 12000);
    })]); } finally { clearTimeout(timer); }
  }
  async function until(predicate, label) {
    const deadline = performance.now() + 12000;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error('Synthetic test deadline: ' + label);
      await pause(10);
    }
  }
  async function drain() { await bounded(Promise.all(workers.map(record => record.exit)), 'worker cleanup'); }
  function rejection(promise, code) {
    return assert.rejects(promise, error => error.code === code).then(() => { checks++; });
  }
  async function provider() {
    const calls = [], pending = new Set();
    let held = true, failure = false, active = 0, pendingHeld = false, categoryChanged = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      calls.push(url.pathname + (url.searchParams.get('is_pending') === 'true' ? '?pending' : ''));
      active++;
      res.once('close', () => { active--; pending.delete(res); });
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (failure) return send(503, { error: 'SYNTHETIC-PRIVATE-PROVIDER-ERROR', token: 'SYNTHETIC-SECRET-CANARY' });
      if (url.pathname === '/v2/me') {
        if (held) { pending.add(res); return; }
        return send(200, { user_id: 1 });
      }
      if (url.pathname === '/v2/plaid_accounts') return send(200, { plaid_accounts: payload.accounts });
      if (url.pathname === '/v2/manual_accounts') return send(200, { manual_accounts: [] });
      if (url.pathname === '/v2/categories') return send(200, { categories: payload.categories });
      if (url.pathname === '/v2/tags') return send(200, { tags: [] });
      if (url.pathname === '/v2/budgets/settings') return send(200, { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01' });
      if (url.pathname === '/v2/summary') return send(200, { aligned: false, categories: [] });
      if (url.pathname === '/v2/transactions') {
        const isPending = url.searchParams.get('is_pending') === 'true';
        const body = { has_more: false, transactions: payload.transactions.filter(tx => !isPending || tx.is_pending)
          .map(tx => categoryChanged && tx.id === payload.transactions[2].id ? { ...tx, category_id: 14 } : tx) };
        if (isPending && pendingHeld) { pending.add({ res, release: () => send(200, body) }); return; }
        return send(200, body);
      }
      send(404, {});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { calls, get active() { return active; },
      base: 'http://127.0.0.1:' + server.address().port + '/v2',
      hold() { held = true; }, fail(value) { failure = value; },
      holdPending() { pendingHeld = true; }, changeCategory(value) { categoryChanged = value; },
      release() {
        held = false;
        pendingHeld = false;
        for (const entry of pending) {
          if (entry.release) { if (!entry.res.destroyed) entry.release(); }
          else if (!entry.destroyed) { entry.writeHead(200, { 'content-type': 'application/json' }); entry.end('{"user_id":1}'); }
        }
        pending.clear();
      },
      async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
  }
  function environment(base) {
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    return { ...env, ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-SECRET-CANARY',
      ATLAS_LUNCHMONEY_API_BASE: base, ATLAS_LIVE_OVERLAY_NOW: payload.fetchedAt,
      ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify(map) };
  }
  const countMe = mock => mock.calls.filter(call => call === '/v2/me').length;
  function serverAdapter(service) {
    const filename = path.resolve(__dirname, '..', 'server.js');
    const source = fs.readFileSync(filename, 'utf8');
    const requireFromServer = createRequire(filename), exported = { exports: {} };
    const context = vm.createContext({ module: exported, process: { env: {} }, console,
      require(name) {
        if (name === './scripts/assistant-lunchmoney.js') return { createService: () => service };
        if (name === './scripts/assistant-standing-runtime.js') return { fromEnv: () => ({}) };
        if (name === './scripts/assistant-oauth.js') return { readConfig: () => ({ configured: false }) };
        return requireFromServer(name);
      } });
    // Execute the actual construction and writer wiring, not a copied wrapper.
    // The production factory now owns this prefix. End the probe at the same
    // pre-listen boundary, return its actual adapter, and invoke that factory.
    const boundary = source.indexOf('if (!PASSWORD');
    const construction = source.indexOf('function createApplication(options = {}) {');
    assert.ok(construction >= 0 && construction < boundary && boundary > 0);
    new vm.Script(source.slice(0, boundary)
      + '\nreturn lunchMoneyAssistant;\n}\nmodule.exports = createApplication();', { filename }).runInContext(context);
    return exported.exports;
  }
  async function pair(mock, env, secondCanonical, secondEnv, label) {
    await drain(); mock.hold();
    const before = workers.length, callsBefore = countMe(mock);
    const first = Refresh.serve(canonical, env);
    const second = Refresh.serve(secondCanonical, secondEnv);
    try {
      await until(() => countMe(mock) === callsBefore + 2, label);
      check(workers.length - before, 2, label + ': actual distinct workers');
      mock.release();
      const results = await bounded(Promise.all([first, second]), label + ' completion');
      check(results[0].meta, { ...canonical.meta, asOf: Fixture.AS_OF }, label + ': first canonical publication');
      check(results[1].meta, { ...secondCanonical.meta, asOf: Fixture.AS_OF }, label + ': second canonical publication');
    } finally { mock.release(); await Promise.allSettled([first, second]); await drain(); }
  }
  (async () => {
    const mock = await provider(), env = environment(mock.base);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-coalescing-synthetic-'));
    try {
      // Independent reference execution + actual GET counts, not coordinator counters.
      mock.release();
      const expected = await Live.applyForServer(canonical, env);
      check(expected.liveOverlay.applied, true, 'reference is a qualified live publication');
      check(mock.calls.length, PROVIDER_GETS, 'reference performs all eleven provider GETs (seven, the recurring-items read, the two budget reads and the fixed-amount history read)');
      mock.hold();
      const before = workers.length, callsBefore = mock.calls.length, original = structuredClone(canonical);
      const inputs = [canonical, structuredClone(canonical), structuredClone(canonical), canonical];
      const requests = inputs.slice(0, 3).map(input => Refresh.serve(input, Object.fromEntries(Object.entries(env).reverse())));
      await until(() => mock.calls.length === callsBefore + 1, 'shared provider start');
      // Equal strings can have different V8 wire encodings. A later caller
      // with two-byte-backed strings is still the identical request context.
      const equalEnv = Object.fromEntries(Object.entries(env).map(([name, value]) => [name, ('\u1234' + value).slice(1)]));
      requests.push(Refresh.serve(inputs[3], equalEnv));
      check(workers.length - before, 1, 'four equivalent callers start one actual worker');
      check(countMe(mock), 2, 'four equivalent callers start one provider observation');
      mock.release();
      const results = await bounded(Promise.all(requests), 'shared publication');
      for (const result of results) check(result, expected, 'whole qualified publication unchanged');
      results[0].plan.startingCash.breakdown[0].value = -999;
      check(results[1], expected, 'result mutation cannot affect another caller');
      check(canonical, original, 'canonical input unchanged');
      await drain();
      check(mock.calls.length - callsBefore, PROVIDER_GETS, 'one complete eleven-GET observation serves all callers');
      const sharedTiming = timings.at(-1);
      check(sharedTiming.waiterCount, 4, 'sanitized lifecycle counts shared callers');
      check(sharedTiming.outcome, 'completed', 'timing describes worker completion');

      const sequentialBefore = workers.length, sequentialCalls = mock.calls.length;
      check(await Refresh.serve(canonical, env), expected, 'sequential request retains publication');
      await drain();
      check(workers.length - sequentialBefore, 1, 'sequential request starts another real worker');
      check(mock.calls.length - sequentialCalls, PROVIDER_GETS, 'no completed observation cache');

      // The preserved real-worker race: posted transactions have been fetched,
      // pending coverage is held, then an authorized adapter invocation changes
      // synthetic provider state. No real provider write or credential is used.
      for (const outcome of ['applied', 'write-unverified', 'unavailable', 'throw']) {
        mock.release(); mock.changeCategory(false); mock.holdPending();
        const pendingBefore = mock.calls.filter(call => call === '/v2/transactions?pending').length;
        const beforeWrite = Refresh.serve(canonical, env);
        const obsolete = rejection(beforeWrite, 'live-refresh-invalidated');
        await until(() => mock.calls.filter(call => call === '/v2/transactions?pending').length === pendingBefore + 1, 'pre-edit posted window fetched');
        const joinedBeforeWrite = rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
        const editError = new Error('synthetic-ambiguous-edit'), editResult = { status: outcome };
        let finishEdit, invoked = 0, received;
        const editDone = new Promise(resolve => { finishEdit = resolve; });
        const service = { standingEnabled: true, standingCleanupEnabled: true, standingAdmissionEnabled: true,
          async invoke(...args) {
            invoked++; received = args; mock.changeCategory(true);
            await editDone;
            if (outcome === 'throw') throw editError;
            return editResult;
          } };
        const adapter = serverAdapter(service), args = { previewId: 'synthetic-preview', confirmed: true };
        const auth = { principal: 'synthetic-owner', scopes: ['synthetic-existing-scope'] };
        const operation = outcome === 'write-unverified' || outcome === 'throw' ? 'applyStanding' : 'apply';
        const editing = adapter.invoke(operation, args, auth);
        const editCheck = outcome === 'throw' ? assert.rejects(editing, error => error === editError)
          : editing.then(result => check(result, editResult, 'writer result returned unchanged'));
        await bounded(Promise.all([obsolete, joinedBeforeWrite]), 'obsolete shared waiter invalidation');
        check(received, [operation, args, auth], 'operation, arguments and auth forwarded unchanged');
        check(received[1] === args && received[2] === auth, true, 'writer retains argument/auth ownership');
        for (const flag of ['standingEnabled', 'standingCleanupEnabled', 'standingAdmissionEnabled']) check(adapter[flag], service[flag], 'capability flags preserved');
        const duringBefore = workers.length;
        await rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
        check(workers.length, duringBefore, 'during-edit read starts no mixed-evidence worker');
        await drain(); mock.release(); finishEdit(); await editCheck;
        const afterBefore = workers.length, callsBeforeEditRead = mock.calls.length;
        const afterWrite = await Refresh.serve(canonical, env); await drain();
        check(workers.length - afterBefore, 1, 'post-edit reader starts a new real worker');
        check(mock.calls.length - callsBeforeEditRead, PROVIDER_GETS, 'post-edit reader performs a complete fresh observation');
        assert.notDeepEqual(afterWrite.liveOverlay.currentPeriodActuals, expected.liveOverlay.currentPeriodActuals, 'post-edit actuals cannot equal the captured pre-edit window'); checks++;
        check(afterWrite, await Live.applyForServer(canonical, env), 'post-edit whole publication equals an independent fresh execution');
        check(invoked, 1, 'ambiguous/unavailable/error outcome never retries the edit');
      }
      mock.changeCategory(false);

      // Read/preview adapter calls do not invalidate unrelated active readers.
      mock.hold(); const readCalls = countMe(mock), readWorkers = workers.length;
      const unaffected = Refresh.serve(canonical, env);
      await until(() => countMe(mock) === readCalls + 1, 'read-only adapter control');
      const readResult = { status: 'synthetic-preview' }, readArguments = [], readAdapter = serverAdapter({
        standingEnabled: false, standingCleanupEnabled: false, standingAdmissionEnabled: false,
        invoke(...args) { readArguments.push(args); return Promise.resolve(readResult); },
      });
      for (const operation of ['catalog', 'prepare']) check(await readAdapter.invoke(operation, {}, {}), readResult, 'read/preview result unchanged');
      check(readArguments.map(args => args[0]), ['catalog', 'prepare'], 'only existing read/preview operations invoked');
      mock.release(); check(await unaffected, expected, 'read/preview does not invalidate a pending publication');
      await drain(); check(workers.length - readWorkers, 1, 'read/preview starts no replacement worker');

      // Two overlapping attempts keep external live reads unavailable until
      // the last attempt settles, even when the first reports success.
      let finishA, finishB;
      const doneA = new Promise(resolve => { finishA = resolve; }), doneB = new Promise(resolve => { finishB = resolve; });
      const overlappingAdapter = serverAdapter({ invoke: async operation => {
        await (operation === 'apply' ? doneA : doneB);
        return { status: operation === 'apply' ? 'applied' : 'write-unverified' };
      } });
      const writingA = overlappingAdapter.invoke('apply', {}, {}), writingB = overlappingAdapter.invoke('applyStanding', {}, {});
      const overlapWorkers = workers.length;
      await rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
      finishA(); await writingA;
      await rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
      check(workers.length, overlapWorkers, 'one settled writer cannot unblock another active writer');
      finishB(); await writingB;
      check(await Refresh.serve(canonical, env), expected, 'reads resume after all attempts settle'); await drain();

      // Invalidation does not pretend terminating workers have released slots.
      mock.hold(); const invalidationWorkers = workers.length;
      const abandonedA = rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
      const abandonedB = rejection(Refresh.serve({ ...canonical, meta: { ...canonical.meta, syntheticRevision: 'write-cap' } }, env), 'live-refresh-invalidated');
      await Refresh.withProviderWrite(async () => ({ status: 'write-unverified' }));
      await Promise.all([abandonedA, abandonedB]);
      await rejection(Refresh.serve(canonical, env), 'live-refresh-busy');
      check(workers.length - invalidationWorkers, 2, 'invalidated workers retain both slots until exit');
      await drain(); mock.release();
      check(await Refresh.serve(canonical, env), expected, 'retry succeeds after actual worker cleanup'); await drain();

      // Cancelling the initiator or any joining caller cannot cancel survivors.
      for (const initiator of [true, false]) {
        mock.hold();
        const controller = new AbortController(), listenerCount = events.getEventListeners(controller.signal, 'abort').length;
        const start = workers.length, observed = countMe(mock);
        const first = Refresh.serve(canonical, env, initiator ? { signal: controller.signal } : {});
        const second = Refresh.serve(canonical, env, initiator ? {} : { signal: controller.signal });
        const stopped = rejection(initiator ? first : second, 'live-refresh-cancelled');
        await until(() => countMe(mock) === observed + 1, 'cancellation provider start');
        controller.abort(); await stopped;
        check(events.getEventListeners(controller.signal, 'abort').length, listenerCount, 'cancelled waiter removes listener');
        check(mock.active, 1, 'surviving waiter still owns the provider connection');
        mock.release();
        check(await (initiator ? second : first), expected, 'survivor publication unchanged');
        await drain();
        check(workers.length - start, 1, 'one actual worker across cancellation');
      }

      mock.release();
      const successfulControl = new AbortController(), lateAbortBefore = workers.length;
      const successful = await Promise.all([Refresh.serve(canonical, env, { signal: successfulControl.signal }),
        Refresh.serve(canonical, env, { signal: successfulControl.signal })]);
      check(events.getEventListeners(successfulControl.signal, 'abort').length, 0, 'successful shared waiters remove both abort listeners');
      await drain(); mock.hold(); const lateAbortCalls = countMe(mock);
      const afterSuccess = Refresh.serve(canonical, env);
      await until(() => countMe(mock) === lateAbortCalls + 1, 'post-success replacement start');
      successfulControl.abort();
      check(mock.active, 1, 'late abort after publication cannot cancel replacement work');
      mock.release(); check(await afterSuccess, expected, 'post-success replacement publication unchanged');
      for (const result of successful) check(result, expected, 'successful shared signal publication unchanged');
      await drain(); check(workers.length - lateAbortBefore, 2, 'late abort starts no extra worker');

      // Each timer belongs to its waiter, including a shorter joining deadline.
      for (const initiatorExpires of [true, false]) {
        mock.hold(); const observed = countMe(mock), start = workers.length;
        const first = Refresh.serve(canonical, env, { timeoutMs: initiatorExpires ? 1500 : 10000 });
        const firstStopped = initiatorExpires ? rejection(first, 'live-refresh-timeout') : null;
        await until(() => countMe(mock) === observed + 1, 'deadline provider start');
        const second = Refresh.serve(canonical, env, { timeoutMs: initiatorExpires ? 10000 : 80 });
        await (firstStopped || rejection(second, 'live-refresh-timeout'));
        check(mock.active, 1, 'one expired waiter leaves the provider connected');
        mock.release(); check(await (initiatorExpires ? second : first), expected, 'longer waiter keeps its own deadline');
        await drain(); check(workers.length - start, 1, 'one actual worker across caller timeout');
      }

      // A new job may start before the abandoned worker exits. Its late events
      // must not evict or terminate that replacement, or a later joining caller.
      mock.hold();
      const controller = new AbortController(), start = workers.length, observed = countMe(mock);
      const abandoned = Refresh.serve(canonical, env, { signal: controller.signal });
      const stopped = rejection(abandoned, 'live-refresh-cancelled');
      await until(() => countMe(mock) === observed + 1, 'abandoned provider start');
      controller.abort(); await stopped;
      const replacement = Refresh.serve(canonical, env);
      await bounded(workers[start].exit, 'abandoned worker exit');
      const joining = Refresh.serve(canonical, env);
      await until(() => countMe(mock) === observed + 2, 'replacement provider start');
      check(workers.length - start, 2, 'replacement survives old worker exit without a third worker');
      mock.release();
      for (const result of await Promise.all([replacement, joining])) check(result, expected, 'replacement publication unchanged');
      await drain(); check(mock.active, 0, 'abandoned and replacement sockets cleaned');

      // All callers leaving terminates the shared job and clears every listener.
      mock.hold(); const observedAll = countMe(mock), controllers = [new AbortController(), new AbortController()];
      const all = controllers.map(control => rejection(Refresh.serve(canonical, env, { signal: control.signal }), 'live-refresh-cancelled'));
      await until(() => countMe(mock) === observedAll + 1, 'all-cancel provider start');
      controllers.forEach(control => control.abort()); await Promise.all(all); await drain();
      await until(() => mock.active === 0, 'all-cancel provider cleanup');
      for (const control of controllers) check(events.getEventListeners(control.signal, 'abort').length, 0, 'all-cancel listener cleaned');
      const cancelled = new AbortController(); cancelled.abort();
      const alreadyBefore = workers.length;
      await rejection(Refresh.serve(canonical, env, { signal: cancelled.signal }), 'live-refresh-cancelled');
      check(workers.length, alreadyBefore, 'already-cancelled caller starts no worker');

      // Distinct jobs consume the cap; equivalent callers can still join it.
      mock.hold(); const capBefore = workers.length, capCalls = countMe(mock);
      const changed = { ...canonical, meta: { ...canonical.meta, syntheticRevision: 2 } };
      const a = Refresh.serve(canonical, env), b = Refresh.serve(changed, env);
      const c = Refresh.serve(canonical, env);
      await rejection(Refresh.serve({ ...canonical, meta: { ...canonical.meta, syntheticRevision: 3 } }, env), 'live-refresh-busy');
      await until(() => countMe(mock) === capCalls + 2, 'worker cap');
      check(workers.length - capBefore, 2, 'real distinct-worker cap retained');
      mock.release(); const capResults = await Promise.all([a, b, c]);
      check(capResults[0], capResults[2], 'joining works at full distinct-worker capacity'); await drain();

      await pair(mock, env, changed, env, 'canonical revision isolation');
      for (const [name, value] of [
        ['LUNCHMONEY_ACCESS_TOKEN', 'SYNTHETIC-DIFFERENT-SECRET'],
        ['SITE_PASSWORD', 'synthetic-other-household-auth'],
        ['ATLAS_PROVIDER_ACCOUNT_MAP_JSON', JSON.stringify({ ...map, owns: 'Different synthetic mapping revision' })],
        ['RENDER_GIT_COMMIT', 'synthetic-runtime-revision'],
      ]) await pair(mock, env, canonical, { ...env, [name]: value }, name + ' context isolation');

      const alternate = await provider();
      try {
        mock.hold(); const providerBefore = workers.length, oldCalls = countMe(mock);
        const first = Refresh.serve(canonical, env), second = Refresh.serve(canonical, environment(alternate.base));
        await until(() => countMe(mock) === oldCalls + 1 && countMe(alternate) === 1, 'provider endpoint isolation');
        check(workers.length - providerBefore, 2, 'distinct provider endpoints start two workers');
        mock.release(); alternate.release(); await Promise.all([first, second]); await drain();
      } finally { alternate.release(); await alternate.close(); }

      const mapFile = path.join(directory, 'synthetic-map.json');
      fs.writeFileSync(mapFile, JSON.stringify(map));
      const fileEnv = { ...env, ATLAS_LIVE_OVERLAY_MAP: mapFile }; delete fileEnv.ATLAS_PROVIDER_ACCOUNT_MAP_JSON;
      mock.hold(); const fileBefore = workers.length, fileCalls = countMe(mock);
      const oldMap = rejection(Refresh.serve(canonical, fileEnv), 'live-refresh-invalidated');
      await until(() => countMe(mock) === fileCalls + 1, 'original file mapping');
      fs.writeFileSync(mapFile, JSON.stringify({ ...map, owns: 'New synthetic revision with unchanged identities' }));
      const newMap = Refresh.serve(canonical, fileEnv);
      await until(() => countMe(mock) === fileCalls + 2, 'changed file mapping');
      check(workers.length - fileBefore, 2, 'file-backed mapping revision cannot join old work');
      mock.release(); await oldMap; check(await newMap, expected, 'only current file context can publish'); await drain();

      // Same pinned evidence time, distinct current Pacific evaluation days.
      const originalNow = Date.now;
      try {
        mock.hold(); const midnightBefore = workers.length, midnightCalls = countMe(mock);
        Date.now = () => Date.parse('2026-10-14T06:59:59.999Z');
        const yesterday = rejection(Refresh.serve(canonical, env), 'live-refresh-invalidated');
        Date.now = () => Date.parse('2026-10-14T07:00:00.000Z');
        const today = Refresh.serve(canonical, env);
        await until(() => countMe(mock) === midnightCalls + 2, 'Pacific midnight isolation');
        check(workers.length - midnightBefore, 2, 'Pacific midnight starts a separate worker');
        mock.release();
        await yesterday;
        check(await today, expected, 'current clock context never rewrites original evidence dates');
        await drain();
      } finally { Date.now = originalNow; }

      // Returned fail-closed observations and rejected jobs are evicted alike.
      mock.fail(true); mock.release(); const failureBefore = workers.length, failureCalls = mock.calls.length;
      const failed = await Promise.all([Refresh.serve(canonical, env), Refresh.serve(canonical, env)]);
      check(workers.length - failureBefore, 1, 'failed transport is shared while active');
      check(mock.calls.length - failureCalls, 1, 'failed transport makes one actual provider attempt');
      check(failed[0], failed[1], 'fail-closed response preserved for both callers');
      check(failed[0].liveOverlay.applied, false, 'transport failure never becomes successful observation');
      check(failed[0].refreshTrust.exactFiguresAvailable, false, 'failed transport cannot approve figures');
      await drain(); mock.fail(false);
      check(await Refresh.serve(canonical, env), expected, 'successful retry preserves qualified body'); await drain();
      check(workers.length - failureBefore, 2, 'returned failure is not cached');

      const preload = '--require "' + __filename.replace(/\\/g, '/') + '"';
      for (const mode of ['reject', 'exit']) {
        const brokenEnv = { ...env, NODE_OPTIONS: preload, ATLAS_COALESCING_TEST_WORKER_MODE: mode };
        const brokenBefore = workers.length, brokenCalls = mock.calls.length;
        await Promise.all([rejection(Refresh.serve(canonical, brokenEnv), 'live-refresh-unavailable'),
          rejection(Refresh.serve(canonical, brokenEnv), 'live-refresh-unavailable')]);
        await drain(); check(workers.length - brokenBefore, 1, 'one actual ' + mode + ' worker shared');
        await rejection(Refresh.serve(canonical, brokenEnv), 'live-refresh-unavailable'); await drain();
        check(workers.length - brokenBefore, 2, mode + ' failure evicted for identical-context retry');
        check(mock.calls.length, brokenCalls, 'worker failure touches no real or synthetic provider');
      }

      // Later attachment cannot reset the shared 150s production ceiling.
      mock.hold(); const nativeTimeout = global.setTimeout, globalBefore = workers.length;
      let hardStop;
      global.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === Refresh.LIVE_REFRESH_TIMEOUT_MS ? 350 : ms, ...args);
      try { hardStop = Refresh.serve(canonical, env, { timeoutMs: 10000 }); }
      finally { global.setTimeout = nativeTimeout; }
      const hardStopped = rejection(hardStop, 'live-refresh-timeout');
      const joinStopped = rejection(Refresh.serve(canonical, env, { timeoutMs: 10000 }), 'live-refresh-timeout');
      const hardStart = performance.now(); await Promise.all([hardStopped, joinStopped]); await drain();
      check(workers.length - globalBefore, 1, 'shared absolute deadline keeps one worker');
      assert.ok(performance.now() - hardStart < 1600, 'shared deadline is not extended by a new waiter'); checks++;
      await until(() => mock.active === 0, 'hard deadline provider cleanup');

      const allowed = ['type', 'outcome', 'totalMs', 'workerStartupMs', 'workerRunMs', 'cleanupMs',
        'waiterCount', 'peakWaiters', 'cancelledWaiters', 'timedOutWaiters'].sort();
      for (const entry of timings) {
        check(Object.keys(entry).sort(), allowed, 'timing uses only closed sanitized fields');
        assert.ok(['completed', 'live-refresh-cancelled', 'live-refresh-timeout', 'live-refresh-unavailable', 'live-refresh-invalidated'].includes(entry.outcome)); checks++;
        for (const key of allowed.filter(key => key.endsWith('Ms'))) {
          assert.ok(entry[key] === null || Number.isSafeInteger(entry[key]) && entry[key] >= 0); checks++;
        }
        assert.ok(entry.workerStartupMs === null || entry.workerStartupMs <= entry.totalMs); checks++;
      }
      assert.ok(!/SYNTHETIC|token|secret|canonical|provider|key|generation|\/|\\/i.test(JSON.stringify(timings))); checks++;
      check(canonical, original, 'all paths preserve canonical input');
      originalLog('MEASURED ' + JSON.stringify({ equivalentCallers: 4, actualWorkers: 1, providerGETs: PROVIDER_GETS,
        lifecycle: sharedTiming, testedJobs: timings.length }));
      originalLog('PASS live refresh coalescing: ' + checks + ' checks; real workers/provider calls, publication conservation, caller isolation, deadlines, cancellation races, context/day separation, failure eviction and sanitized timings');
    } finally {
      mock.release(); await drain(); await mock.close();
      const syntheticMap = path.join(directory, 'synthetic-map.json');
      if (fs.existsSync(syntheticMap)) fs.unlinkSync(syntheticMap);
      fs.rmdirSync(directory);
      console.log = originalLog; threads.Worker = RealWorker;
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
