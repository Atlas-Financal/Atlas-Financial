'use strict';
// Per-request server timing for authenticated page and API requests (lead
// dispatch, 2026-11-22: measure where a page load spends its time before any
// hosting decision). One closed JSON line per request on stdout, and one
// start-up line per process. Server log only: no header, nothing sent to the
// browser.
//
// Closed fields only: route (a fixed allowlist, anything else 'other'),
// method (GET/HEAD/POST/other), outcome (completed, or client-closed when
// the connection closed before the response finished: then the status is
// 'none', never a 2xx), status class, cold (first logged request of this
// process), whole-millisecond durations, the served-path enum and cacheHit. No path beyond the allowlist, query string, header, cookie,
// token, body, payload, amount, id, payee, account or error text is read into
// the record. The per-job Lunch Money / overlay / Forecast split already
// logged by live-refresh-stages is not duplicated here: one provider job is
// shared by every request that coalesces onto it, so a per-request split
// would double-count it. served names the path that actually served this
// response, as ServerLiveRefresh.serve reports it from its own state (never
// the browser-facing check metadata): provider-job (this request started the
// provider job), joined-job (it waited on a job another request started),
// retained (a retained display: the early return, an unavailable fallback or
// a carried failure), replay (a memory replay, run or reused), canonical (no
// live overlay) or none (no data read). A provider-job request matches the
// live-refresh-stages line its job writes.
const { performance } = require('node:perf_hooks');

const ROUTES = Object.freeze({ '/': '/', '/index.html': '/', '/data.json': '/data.json',
  '/balance-history.json': '/balance-history.json', '/assistant/current': '/assistant/current',
  '/assistant/mcp': '/assistant/mcp' });
const STATIC_ASSET = /^\/[A-Za-z0-9_./-]+\.(?:js|css|png|svg|ico|webmanifest|woff2?|map)$/;
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const SERVED = new Set(['provider-job', 'joined-job', 'retained', 'replay', 'canonical', 'none']);
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
function record(state, statusCode, method, outcome) {
  const completed = outcome === 'completed';
  const total = state.end - state.start;
  // A read still open when the connection closed counts up to that moment.
  let data = state.data + (typeof state.dataOpen === 'bigint' ? state.end - state.dataOpen : 0n);
  if (data < 0n) data = 0n;
  const serialize = state.serialize < 0n ? 0n : state.serialize;
  let other = total - data - serialize;
  if (other < 0n) other = 0n;
  const served = SERVED.has(state.served) ? state.served : 'none';
  // Phase split (lead dispatch 2026-11-22, response-phase timing): where the
  // time outside the existing data/serialize fields goes. Whole ms, labels
  // only. preData: request start to the first data read. dataServe / dataAttach:
  // the data read before and after its settlement attach mark. afterData: the
  // last data read's end to the first serialize. write: the last serialize's
  // end to the response finishing (compression and flush). unattributed is the
  // remainder, so the phases always sum to total (before rounding).
  const at = v => typeof v === 'bigint' ? v : null;
  const span = (a, b) => (at(a) !== null && at(b) !== null && b >= a ? b - a : 0n);
  const firstData = at(state.firstDataStart), lastDataEnd = at(state.lastDataEnd);
  const attach = at(state.attachStart);
  const firstSer = at(state.firstSerializeStart), lastSer = at(state.lastSerializeEnd);
  const p = {
    preData: firstData !== null ? span(state.start, firstData) : 0n,
    dataServe: firstData !== null ? (attach !== null ? span(firstData, attach) : data) : 0n,
    dataAttach: attach !== null && lastDataEnd !== null ? span(attach, lastDataEnd) : 0n,
    afterData: lastDataEnd !== null && firstSer !== null ? span(lastDataEnd, firstSer) : 0n,
    serialize,
    write: lastSer !== null ? span(lastSer, state.end) : 0n,
  };
  let rest = total;
  for (const v of Object.values(p)) rest -= v;
  if (rest < 0n) rest = 0n;
  const phases = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, toMs(v)]));
  phases.unattributed = toMs(rest);
  return {
    type: 'atlas-timing',
    route: routeOf(state.path),
    method: METHODS.has(method) ? method : 'other',
    outcome: completed ? 'completed' : 'client-closed',
    status: completed ? statusClass(statusCode) : 'none',
    cold: state.cold === true,
    ms: { total: toMs(total), data: toMs(data), serialize: toMs(serialize), other: toMs(other) },
    served,
    cacheHit: served === 'retained' || served === 'replay',
    phases,
  };
}

// First middleware: starts the clock for every request and wraps res.json so
// its time is counted as serialize. Nothing is logged unless a handler or the
// session gate marks the request authenticated.
function start(req, res, next) {
  const state = { start: now(), end: 0n, path: req.path, data: 0n, dataOpen: null, serialize: 0n,
    served: 'none', authed: false, excluded: false, done: false, cold: false,
    firstDataStart: null, lastDataEnd: null, attachStart: null, firstSerializeStart: null, lastSerializeEnd: null };
  req[KEY] = state;
  const json = res.json.bind(res);
  res.json = body => {
    const t = now();
    if (state.firstSerializeStart === null) state.firstSerializeStart = t;
    try { return json(body); } finally { const e = now(); state.serialize += e - t; state.lastSerializeEnd = e; }
  };
  // One record per request: 'finish' means the response was fully handed
  // off; a 'close' before it means the client went away first.
  const finish = outcome => {
    if (state.done) return;
    state.done = true;
    if (!state.authed || state.excluded) return;
    state.end = now();
    state.cold = cold;
    cold = false;
    // Diagnostics only: a logging failure never affects the response.
    try { console.log(JSON.stringify(record(state, res.statusCode, req.method, outcome))); } catch (_) { /* closed */ }
  };
  res.once('finish', () => finish('completed'));
  res.once('close', () => finish(res.writableFinished ? 'completed' : 'client-closed'));
  next();
}
const stateOf = req => (req && req[KEY]) || null;
function markAuthed(req) { const s = stateOf(req); if (s) s.authed = true; }
// A route that writes its own single diagnostic line (the browser timing
// beacon, scripts/client-timing.js) opts out of this one, so each of its
// requests writes at most that one line. It also leaves cold untouched.
function exclude(req) { const s = stateOf(req); if (s) s.excluded = true; }
// The data read: dataStart before it, dataEnd in its finally. After the
// record is written (a client that closed first), nothing changes it.
function dataStart(req) {
  const s = stateOf(req);
  if (!s || s.done) return null;
  const t = now();
  s.dataOpen = t;
  if (s.firstDataStart === null) s.firstDataStart = t;
  return t;
}
function dataEnd(req, started) {
  const s = stateOf(req);
  if (!s || s.done || typeof started !== 'bigint') return;
  const e = now();
  s.data += e - started;
  s.dataOpen = null;
  s.lastDataEnd = e;
}
// The settlement attach inside the data read starts (first mark only).
function attachStart(req) {
  const s = stateOf(req);
  if (s && !s.done && s.attachStart === null && typeof s.dataOpen === 'bigint') s.attachStart = now();
}
function noteServed(req, served) {
  const s = stateOf(req);
  if (s && !s.done && SERVED.has(served)) s.served = served;
}

function startupRecord() {
  return { type: 'atlas-startup', ms: { bootToListen: Math.max(0, Math.round(performance.now())) } };
}

module.exports = { start, markAuthed, exclude, dataStart, dataEnd, attachStart, noteServed, record, routeOf, startupRecord,
  _resetColdForTests: () => { cold = true; } };
