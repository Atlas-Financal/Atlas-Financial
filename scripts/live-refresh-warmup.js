'use strict';
// Boot warm-up (owner grant, Dale, 2026-11-23, #821 7090586736: "Yes, I like
// the warm up."; the exact scope is ARCHITECTURE.md "Boot warm-up").
//
// When the server starts listening, ONE ordinary live refresh is started
// through the existing on-demand path (ServerLiveRefresh.serve, the same
// worker, job key, coalescing, deadline and lifecycle as a page open), so the
// first open after a deploy or restart joins a refresh already under way
// instead of waiting for a cold one. Nothing else:
//   - exactly one attempt per process start: no retry, no loop, no timer, no
//     new-day or time-of-day refresh;
//   - GET-only against the provider, like every on-demand read; no provider,
//     canonical or production write;
//   - no change to what is published, how a figure is tagged, or the loading
//     screen: the result is retained exactly as an open's result would be;
//   - a failure is a failed open: its attempt is recorded by the incumbent
//     refresh path, with the incumbent retry gap, and nothing else.
// Off unless ATLAS_LIVE_REFRESH_WARMUP is exactly 'on'. It logs one fixed-code
// line, {"type":"live-refresh-warmup","outcome":...,"ms":...}, never a figure.
const { performance } = require('node:perf_hooks');

const FLAG = 'ATLAS_LIVE_REFRESH_WARMUP';
// The options an ordinary browser open passes (server.js GET /data.json),
// without its per-response header hook, so the warm-up and an open share one
// job key and an open during the warm-up joins it.
const OPEN_OPTIONS = Object.freeze({ preferObservation: true });

// The incumbent refresh path's own failure codes (scripts/server-live-refresh.js). Any other code, in this shape or
// not, logs as 'failed': the line never carries a value it did not choose.
const FAILURE_CODES = Object.freeze(new Set(['live-refresh-busy', 'live-refresh-cancelled', 'live-refresh-invalidated',
  'live-refresh-timeout', 'live-refresh-unavailable']));

function enabled(env) { return !!env && env[FLAG] === 'on'; }
function failureCode(error) {
  const value = error && error.code;
  return typeof value === 'string' && FAILURE_CODES.has(value) ? value : 'failed';
}
// Starts the warm-up and resolves to its outcome code. `serve(options)` runs one ordinary refresh; `retain(served)`
// applies the incumbent retention of a served result; `claim()` is the caller's once-per-process claim, taken only
// immediately before an eligible serve (after every skip check), and returns false when already spent. With the flag
// off it returns null and calls nothing.
function start({ env, serve, retain = () => {}, claim = () => true, composition = 'inactive', log = console.log,
  now = () => performance.now() } = {}) {
  if (!enabled(env)) return null;
  const began = now();
  let qualified = false;
  // Every step, skips included, runs inside the chain, so nothing here can throw out of the caller (startServer), and
  // exactly one line is logged whatever fails.
  return Promise.resolve()
    .then(() => {
      // An active settlement composition serves through its own base reader; the grant covers the incumbent open path.
      if (composition !== 'inactive' || typeof serve !== 'function') return 'skipped-composition';
      if (require('./live-plan').overlayModeFromEnv(env) !== 'live') return 'skipped-not-live';
      if (claim() !== true) return 'skipped-already-started';
      return Promise.resolve(serve({ ...OPEN_OPTIONS, onCheck(check) { qualified = check?.qualified === true; } }))
        .then(served => { retain(served); return qualified ? 'qualified' : 'unqualified'; }, error => failureCode(error));
    })
    .catch(() => 'failed')
    .then(outcome => {
      try { log(JSON.stringify({ type: 'live-refresh-warmup', outcome, ms: Math.max(0, Math.round(now() - began)) })); }
      catch (_) { /* a failing logger changes nothing */ }
      return outcome;
    });
}

module.exports = { FLAG, OPEN_OPTIONS, FAILURE_CODES, enabled, start };
