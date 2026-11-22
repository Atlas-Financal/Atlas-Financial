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
const { performance } = require('node:perf_hooks');
const Refresh = require('../scripts/server-live-refresh');
const Fixture = require('./fixtures/budget-surface-data');

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
  } finally {
    await mock.close();
    console.log = realLog;
  }
  console.log(`request timing served path: ${passed} checks passed`);
  process.exit(0);
})().catch(error => { console.log = realLog; console.error(error); process.exit(1); });
