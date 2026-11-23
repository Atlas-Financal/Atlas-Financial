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

function enabled(env) { return !!env && env[FLAG] === 'on'; }
function failureCode(error) {
  const value = error && error.code;
  return typeof value === 'string' && /^live-refresh-[a-z-]+$/.test(value) ? value : 'failed';
}

// Starts the warm-up and resolves to its outcome code. `serve(options)` runs one
// ordinary refresh; `retain(served)` applies the incumbent retention of a served
// result. With the flag off it returns null and calls nothing.
function start({ env, serve, retain = () => {}, composition = 'inactive', log = console.log,
  now = () => performance.now() } = {}) {
  if (!enabled(env)) return null;
  const began = now();
  const line = outcome => {
    log(JSON.stringify({ type: 'live-refresh-warmup', outcome, ms: Math.max(0, Math.round(now() - began)) }));
    return outcome;
  };
  // An active settlement composition serves through its own base reader; the
  // grant covers the incumbent open path only.
  if (composition !== 'inactive' || typeof serve !== 'function') return Promise.resolve(line('skipped-composition'));
  if (require('./live-plan').overlayModeFromEnv(env) !== 'live') return Promise.resolve(line('skipped-not-live'));
  let qualified = false;
  return Promise.resolve()
    .then(() => serve({ ...OPEN_OPTIONS, onCheck(check) { qualified = check?.qualified === true; } }))
    .then(served => {
      retain(served);
      return line(qualified ? 'qualified' : 'unqualified');
    }, error => line(failureCode(error)))
    .catch(() => line('failed'));
}

module.exports = { FLAG, OPEN_OPTIONS, enabled, start };
