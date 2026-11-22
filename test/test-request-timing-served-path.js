'use strict';
// The served path a timing line names is the path that actually served the
// response, as ServerLiveRefresh.serve reports it from its own state.
// `node test/test-request-timing-served-path.js`
//
// Systems Review on #1553 (blocker 1): the first head took the label from the
// browser-facing check metadata (check.source, the last provider attempt), so
// a retained display served on the early return or an unavailable fallback
// could be logged as a provider read. serve() now reports a closed path:
// provider-job (this caller started the provider job), joined-job (it waited
// on one another caller started), retained (a retained display), replay (a
// memory replay) or canonical (no live overlay).
//
// Failure it detects: any of those paths reported as another, or not at all.
// Release decision: any failure blocks.
//
// Invented fixture (test/fixtures/budget-surface-data) and a local synthetic
// provider; no household data and no real provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Refresh = require('../scripts/server-live-refresh');
const Fixture = require('./fixtures/budget-surface-data');
const RequestTiming = require('../scripts/request-timing');

const canonical = Fixture.canonical();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('  ok ' + name); }
// Keep the module's own diagnostics lines out of this test's output.
const realLog = console.log;
console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('{"type":"live-refresh')) return; realLog(...args); };

// The synthetic provider, environment and clock of the observation-memory
// suite, so the first provider read qualifies and is retained for replay.
const Memory = require('./test-server-observation-memory.js');
Date.now = () => Date.parse(Memory.CLOCK);
// One serve call; returns every path it reported, in order.
async function served(env, options = {}) {
  const paths = [];
  let error = null;
  try { await Refresh.serve(structuredClone(canonical), env, { ...options, onServedPath: p => paths.push(p) }); }
  catch (e) { error = e; }
  return { paths, error };
}
async function until(predicate, label) {
  const deadline = performance.now() + 15000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('deadline: ' + label); await pause(10); }
}

(async () => {
  console.log('=== timing served path: what actually served the response ===');
  const mock = await Memory.provider({ accountId: 501 });
  const env = Memory.environment(mock.base);
  try {
    await check('no live overlay: canonical', async () => {
      const { paths, error } = await served({ PATH: process.env.PATH });
      assert.equal(error, null);
      assert.deepEqual(paths, ['canonical']);
    });

    await check('a caller that starts the provider job: provider-job; one that joins it: joined-job', async () => {
      mock.hold();
      const first = served(env);
      // The second caller joins the job the first one started.
      await pause(50);
      const second = served(env);
      await pause(50);
      mock.release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.error, null); assert.equal(b.error, null);
      assert.deepEqual(a.paths, ['provider-job']);
      assert.deepEqual(b.paths, ['joined-job']);
    });

    await check('a preferred-observation read of the retained cohort: replay', async () => {
      const { paths, error } = await served(env, { preferObservation: true });
      assert.equal(error, null);
      assert.deepEqual(paths, ['replay']);
    });

    await check('a failed provider check served from the retained cohort: retained, never provider-job', async () => {
      // Review blocker 1's case: the browser-facing check names a provider
      // attempt, but a retained display serves the response.
      mock.mode('failure');
      const paths = [];
      let check;
      const data = await Refresh.serve(structuredClone(canonical), env, { onServedPath: p => paths.push(p), onCheck: c => { check = c; } });
      assert.ok(data.liveOverlay.retainedRefresh, 'a retained display served it');
      assert.equal(check.retained, true);
      assert.deepEqual(paths, ['retained']);
    });

    await check('the early retained return after a recent failed check: retained', async () => {
      const { paths, error } = await served(env, { preferObservation: true });
      assert.equal(error, null);
      assert.deepEqual(paths, ['retained']);
    });

    await check('an unavailable fallback during a provider write: retained', async () => {
      mock.mode('ok');
      let inner;
      await Refresh.withProviderWrite(async () => { inner = await served(env); });
      assert.equal(inner.error, null);
      assert.deepEqual(inner.paths, ['retained']);
    });

    await check('a request that is refused reports no served path', async () => {
      const { paths, error } = await served(env, { forceRefresh: true, signal: AbortSignal.abort() });
      assert.ok(error, 'refused');
      assert.deepEqual(paths, []);
    });

    // Re-review on #1553 (7082888754): a dated evidence-day view is this
    // job's own provider read, though it carries a displayCheck like a
    // retained display. A new process holds no retained cohort, so nothing
    // retained can serve it.
    const DAY = '2026-08-19', BALANCE_AT = DAY + 'T17:55:00.000Z';
    const lastSync = () => { // the provider's last sync was the day before
      const p = { ...Fixture.payload(), tags: [] };
      p.accounts = p.accounts.map(a => ({ ...a, balance_last_update: BALANCE_AT, updated_at: BALANCE_AT }));
      return p;
    };
    const freshProcess = () => {
      for (const key of Object.keys(require.cache)) {
        if (/scripts[\\/](server-live-refresh|server-observation-memory)\.js$/.test(key)) delete require.cache[key];
      }
      return require('../scripts/server-live-refresh');
    };
    const servedBy = async (R, e, options = {}) => {
      const paths = []; let check = null;
      const data = await R.serve(structuredClone(canonical), e, { ...options, onServedPath: p => paths.push(p), onCheck: c => { check = c; } });
      return { data, check, paths };
    };
    const cacheHitOf = served => RequestTiming.record({ start: 0n, end: 0n, path: '/data.json', data: 0n, serialize: 0n,
      served, cold: false }, 200, 'GET', 'completed').cacheHit;
    const laneB = { ...env, ATLAS_TIMING_TEST_LANE: 'b' }; // a second job context, the same display context

    await check('a new process serving a dated evidence-day view from its own provider read: provider-job, cacheHit false', async () => {
      mock.mode('ok'); mock.payload(lastSync());
      const r = await servedBy(freshProcess(), env, { preferObservation: true });
      assert.equal(r.data.meta.asOf, DAY, 'the dated evidence-day view served it');
      assert.equal(r.check.qualified, false);
      assert.deepEqual(r.paths, ['provider-job']);
      assert.equal(cacheHitOf(r.paths[0]), false);
    });

    await check('an obsolete job serving a dated view of its own read: provider-job, and a joiner joined-job', async () => {
      mock.mode('ok'); mock.payload(lastSync());
      const R = freshProcess();
      mock.hold();
      const first = servedBy(R, env);
      await pause(50);
      const joiner = servedBy(R, env);
      await pause(50);
      // A newer live job in another context makes the first one obsolete.
      const newer = servedBy(R, laneB);
      await pause(50);
      mock.release();
      const [a, j, b] = await Promise.all([first, joiner, newer]);
      assert.equal(a.data.meta.asOf, DAY); assert.equal(b.data.meta.asOf, DAY);
      assert.deepEqual(a.paths, ['provider-job']);
      assert.deepEqual(j.paths, ['joined-job']);
      assert.deepEqual(b.paths, ['provider-job']);
      assert.equal(cacheHitOf(a.paths[0]), false);
    });

    await check('an obsolete job whose failed read is served from the retained cohort: retained', async () => {
      mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
      const R = freshProcess();
      const seed = await servedBy(R, env, { forceRefresh: true });
      assert.equal(seed.check.qualified, true, 'a qualified read is retained');
      mock.mode('failure'); mock.hold();
      const first = servedBy(R, env);
      await pause(50);
      const newer = servedBy(R, laneB);
      await pause(50);
      mock.release();
      const [a, b] = await Promise.all([first, newer]);
      assert.ok(a.data.liveOverlay.retainedRefresh, 'a retained display served it');
      assert.deepEqual(a.paths, ['retained']);
      assert.deepEqual(b.paths, ['retained']);
      assert.equal(cacheHitOf(a.paths[0]), true);
      mock.mode('ok');
    });

    await check('a request that times out on its read and is served from the retained cohort: retained', async () => {
      mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
      const R = freshProcess();
      assert.equal((await servedBy(R, env, { forceRefresh: true })).check.qualified, true);
      mock.hold();
      const r = await servedBy(R, env, { timeoutMs: 200 });
      mock.release();
      assert.ok(r.data.liveOverlay.retainedRefresh, 'a retained display served it');
      assert.deepEqual(r.paths, ['retained']);
    });

    await check('a complete refresh whose plan is withheld, served the last full picture: retained', async () => {
      // The worker-only preload of test-last-non-withheld-picture.js sets
      // the whole-plan hold on a complete result while the flag file exists.
      const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-timing-withhold-')), 'withhold');
      const preload = path.join(__dirname, 'test-last-non-withheld-picture.js').replace(/\\/g, '/');
      const withhold = { ...env, ATLAS_SYNTHETIC_WITHHOLD_FLAG: flag, NODE_OPTIONS: '--require "' + preload + '"' };
      mock.mode('ok'); mock.payload({ ...Fixture.payload(), tags: [] });
      const R = freshProcess();
      const clean = await servedBy(R, withhold, { forceRefresh: true });
      assert.deepEqual(clean.paths, ['provider-job']);
      fs.writeFileSync(flag, '1');
      const held = await servedBy(R, withhold, { forceRefresh: true });
      fs.rmSync(path.dirname(flag), { recursive: true, force: true });
      assert.equal(held.data.liveOverlay.retainedRefresh?.attempt?.reason, 'current-plan-withheld', 'the last full picture served it');
      assert.deepEqual(held.paths, ['retained']);
    });
  } finally {
    await mock.close();
    console.log = realLog;
  }
  console.log(`request timing served path: ${passed} checks passed`);
  process.exit(0);
})().catch(error => { console.log = realLog; console.error(error); process.exit(1); });
