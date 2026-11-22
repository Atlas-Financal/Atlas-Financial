'use strict';
// Ordering pin (lead dispatch 2026-11-22, response-phase timing): a live refresh resolves its waiter before
// any worker cleanup, so a slow worker teardown never delays the response. The live-refresh-lifecycle line's
// cleanupMs split (resolveMs / exitWaitMs / mainBusyMs / teardownMs) relies on this. A stub Worker stands in
// for the real one: it reports online and returns an invented result, and its terminate() takes 1.5 s. No
// provider call, credential, household data or figure is involved.
const assert = require('node:assert/strict');
const threads = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

const TEARDOWN_MS = 1500;
let terminateCalledAt = null, terminatedAt = null;
class SlowTeardownWorker extends EventEmitter {
  constructor() {
    super();
    setTimeout(() => {
      this.emit('online');
      // An invented, non-qualified result: no dated check, so it is served as an incomplete refresh.
      this.emit('message', { data: { meta: { asOf: '2026-10-14' }, liveOverlay: { applied: false } }, check: { qualified: false } });
    }, 20);
  }
  postMessage() {}
  terminate() {
    terminateCalledAt = performance.now();
    return new Promise(resolve => setTimeout(() => {
      terminatedAt = performance.now();
      this.emit('exit', 0);
      resolve(0);
    }, TEARDOWN_MS));
  }
  unref() {}
}
threads.Worker = SlowTeardownWorker;
const Refresh = require('../scripts/server-live-refresh');

const lifecycle = [];
const log = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('{"type":"live-refresh-lifecycle"')) { lifecycle.push(JSON.parse(args[0])); return; }
  if (typeof args[0] === 'string' && args[0].startsWith('{"type":"live-refresh-')) return;
  log(...args);
};
let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; };

(async () => {
  const canonical = { meta: { asOf: '2026-10-14' }, plan: { opening: { asOf: '2026-10-14' }, bills: [], income: [], budget: { categories: [] } } };
  const env = { ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-TOKEN', ATLAS_LIVE_OVERLAY_NOW: '2026-10-14T18:00:00Z',
    ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ scope: 'live', mappings: [] }) };
  const started = performance.now();
  let resolvedAt = null, outcome = null;
  try { await Refresh.serve(canonical, env, {}); outcome = 'resolved'; } catch (error) { outcome = 'rejected:' + error.code; }
  resolvedAt = performance.now();
  ok(outcome !== null, 'the waiter settled: ' + outcome);
  // The waiter is settled synchronously inside finishJob, before terminate() is called; this test only observes
  // it after its own await resumes, so it asserts against the slow teardown's end, never the terminate() call.
  ok(terminateCalledAt !== null, 'the worker was told to stop');
  ok(terminatedAt === null || resolvedAt < terminatedAt, 'the waiter settled before the slow teardown finished');
  ok(resolvedAt - started < TEARDOWN_MS, 'the 1.5 s teardown did not delay the waiter (' + Math.round(resolvedAt - started) + ' ms)');
  await new Promise(resolve => setTimeout(resolve, TEARDOWN_MS + 200));
  ok(terminatedAt !== null, 'cleanup still ran to completion after the response');
  const line = lifecycle.at(-1);
  ok(line && Number.isSafeInteger(line.resolveMs) && Number.isSafeInteger(line.exitWaitMs)
    && Number.isSafeInteger(line.mainBusyMs) && Number.isSafeInteger(line.teardownMs), 'the lifecycle line carries the cleanup split');
  ok(line.exitWaitMs >= TEARDOWN_MS - 50 && line.teardownMs >= TEARDOWN_MS - 200 && line.mainBusyMs < 1000,
    'an idle main thread attributes the wait to teardown, not to main-thread busy time: ' + JSON.stringify(line));
  ok(line.cleanupMs >= line.resolveMs + line.exitWaitMs - 1 && line.cleanupMs <= line.resolveMs + line.exitWaitMs + 1, 'cleanupMs = resolveMs + exitWaitMs');
  console.log = log;
  console.log(`live refresh resolve-before-teardown: ${checks} checks passed`);
})().catch(error => { console.log = log; console.error(error); process.exit(1); });
