'use strict';
// Per-request server timing for authenticated page and API requests (lead
// dispatch, 2026-11-22: measure where a page load spends its time before any
// hosting decision). One closed JSON line per request on stdout, and one
// start-up line per process. Server log only: no header, nothing sent to the
// browser.
//
// Closed fields only: route (a fixed allowlist, anything else 'other'),
// method (GET/HEAD/POST/other), status class, cold (first logged request of
// this process), whole-millisecond durations, the data source enum and two
// booleans. No path beyond the allowlist, query string, header, cookie,
// token, body, payload, amount, id, payee, account or error text is read into
// the record. The per-job Lunch Money / overlay / Forecast split already
// logged by live-refresh-stages is not duplicated here: one provider job is
// shared by every request that coalesces onto it, so a per-request split
// would double-count it. jobStarted says whether this request started the
// job whose stages line it can be matched with.
const { performance } = require('node:perf_hooks');

const ROUTES = Object.freeze({ '/': '/', '/index.html': '/', '/data.json': '/data.json',
  '/balance-history.json': '/balance-history.json', '/assistant/current': '/assistant/current',
  '/assistant/mcp': '/assistant/mcp' });
const STATIC_ASSET = /^\/[A-Za-z0-9_./-]+\.(?:js|css|png|svg|ico|webmanifest|woff2?|map)$/;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const SOURCES = new Set(['provider', 'memory', 'canonical', 'none']);
const KEY = Symbol('atlasRequestTiming');

let cold = true;
const now = () => process.hrtime.bigint();
const toMs = ns => Number(ns / 1000000n);

function routeOf(path) {
  if (typeof path !== 'string') return 'other';
  if (Object.hasOwn(ROUTES, path)) return ROUTES[path];
  return STATIC_ASSET.test(path) && !path.includes('..') ? 'static' : 'other';
}
function statusClass(code) {
  return Number.isInteger(code) && code >= 100 && code < 600 ? Math.floor(code / 100) + 'xx' : 'other';
}

// Build the one record from closed inputs. Exported for the tests.
function record(state, statusCode, method) {
  const total = state.end - state.start;
  const data = state.data < 0n ? 0n : state.data;
  const serialize = state.serialize < 0n ? 0n : state.serialize;
  let other = total - data - serialize;
  if (other < 0n) other = 0n;
  const source = SOURCES.has(state.source) ? state.source : 'none';
  return {
    type: 'atlas-timing',
    route: routeOf(state.path),
    method: METHODS.has(method) ? method : 'other',
    status: statusClass(statusCode),
    cold: state.cold === true,
    ms: { total: toMs(total), data: toMs(data), serialize: toMs(serialize), other: toMs(other) },
    source,
    cacheHit: source === 'memory',
    jobStarted: state.jobStarted === true,
  };
}

// First middleware: starts the clock for every request and wraps res.json so
// its time is counted as serialize. Nothing is logged unless a handler or the
// session gate marks the request authenticated.
function start(req, res, next) {
  const state = { start: now(), end: 0n, path: req.path, data: 0n, serialize: 0n,
    source: 'none', jobStarted: false, authed: false, done: false, cold: false };
  req[KEY] = state;
  const json = res.json.bind(res);
  res.json = body => {
    const t = now();
    try { return json(body); } finally { state.serialize += now() - t; }
  };
  const finish = () => {
    if (state.done) return;
    state.done = true;
    if (!state.authed) return;
    state.end = now();
    state.cold = cold;
    cold = false;
    // Diagnostics only: a logging failure never affects the response.
    try { console.log(JSON.stringify(record(state, res.statusCode, req.method))); } catch (_) { /* closed */ }
  };
  res.once('finish', finish);
  res.once('close', finish);
  next();
}
const stateOf = req => (req && req[KEY]) || null;
function markAuthed(req) { const s = stateOf(req); if (s) s.authed = true; }
// The data read: dataStart before it, dataEnd in its finally. A request that
// reaches the read is counted as 'canonical' until a provider or memory
// check names its source.
function dataStart(req) {
  const s = stateOf(req);
  if (!s) return null;
  if (s.source === 'none') s.source = 'canonical';
  return now();
}
function dataEnd(req, started) {
  const s = stateOf(req);
  if (s && typeof started === 'bigint') s.data += now() - started;
}
function noteSource(req, source) {
  const s = stateOf(req);
  if (s && SOURCES.has(source) && (s.source === 'none' || s.source === 'canonical')) s.source = source;
}
function noteJobStarted(req, started) { const s = stateOf(req); if (s && started === true) s.jobStarted = true; }

function startupRecord() {
  return { type: 'atlas-startup', ms: { bootToListen: Math.max(0, Math.round(performance.now())) } };
}

module.exports = { start, markAuthed, dataStart, dataEnd, noteSource, noteJobStarted, record, routeOf, startupRecord,
  _resetColdForTests: () => { cold = true; } };
