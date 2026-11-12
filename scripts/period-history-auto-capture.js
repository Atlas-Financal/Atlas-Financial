'use strict';
// Period-close capture at rollover (owner-approved 2026-11-12; the exact
// scope is ARCHITECTURE.md "Period-close capture"). Off unless BOTH
// ATLAS_PERIOD_HISTORY_AUTO_CAPTURE and the existing
// ATLAS_PERIOD_HISTORY_CAPTURE are exactly 'on'.
//
// The one scheduled read the owner approved: after a pay period's last
// household day, if the private archive has no `closing` record for that
// period, make ONE read-only observation (the same GET-only Lunch Money
// requests the on-demand refresh makes, through the same server-side token)
// and append that period's closing record. Nothing else:
//   - no provider request on a tick where nothing is due;
//   - the observation runs in its own worker and is never published into the
//     served observation memory, never replayed to a page load, never sent
//     through withProviderWrite, and never written to data.json;
//   - only the latest closed period is ever named, so older periods are
//     never caught up;
//   - the only write is the closing record (never the opening baseline the
//     capture-on-refresh writer also offers).
//
// Stateless across restarts: every tick re-derives the period from data.json
// and today's household date and asks the archive whether its closing exists
// before any provider request, so a restart can never cause a second closing
// (the archive also refuses one) and, once the closing exists, no restart
// reads the provider again for that period.
//
// Retry bound (owner, #821 comment 6812894251): a failed attempt that saved
// nothing is tried again until a closing exists or the next rollover passes,
// at most MAX_PROVIDER_ATTEMPTS_PER_DAY provider attempts per household day
// and no sooner than RETRY_MS after the previous one. The count lives in this
// process, so a restart while a closing is still due allows at most one more
// attempt. Results are logged as fixed codes only. Forecast remains the only
// calculator.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const Capture = require('./period-history-refresh-capture');
const SessionGate = require('./period-history-session-gate');

const FLAG = 'ATLAS_PERIOD_HISTORY_AUTO_CAPTURE';
const FIRST_TICK_MS = 60 * 1000;
const TICK_MS = 15 * 60 * 1000;
const RETRY_MS = Capture.RETRY_MS;
const MAX_PROVIDER_ATTEMPTS_PER_DAY = 6;
const OBSERVATION_TIMEOUT_MS = 150000;
const WORKER_TIMEOUT_MS = 240000;
const SAVED = new Set(['appended', 'duplicate', 'already-captured']);

function enabled(env) { return !!env && env[FLAG] === 'on' && env[Capture.FLAG] === 'on'; }
function code(error, fallback) {
  const value = error && (error.code || error.message);
  return typeof value === 'string' && /^history-[a-z-]+$/.test(value) ? value : fallback;
}
function dayBefore(day) { return new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10); }
const isDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

// The latest fully-ended pay period on `today` (a household date), from the
// canonical plan alone: no provider call. Null when it cannot be named.
function closedPeriod(canonical, today) {
  const Forecast = require('../public/forecast');
  try {
    const plan = canonical && canonical.plan;
    if (!plan || !isDay(today)) return null;
    const current = Forecast.spendingCycle(plan, today);
    if (!current || !isDay(current.start)) return null;
    const previous = Forecast.spendingCycle(plan, dayBefore(current.start));
    if (!previous || !isDay(previous.start) || !isDay(previous.end)
      || previous.start >= current.start || previous.end >= current.start || previous.end >= today) return null;
    return { start: previous.start, end: previous.end };
  } catch (_) { return null; }
}
const sameKey = (row, period) => row && row.kind === 'closing' && row.period
  && row.period.start === period.start && row.period.end === period.end;

// The default observation: the on-demand refresh's own read, run here in
// this worker. Only its qualified source evidence is kept; nothing it
// computes is served or stored apart from the closing record built below.
async function observeLive(canonical, env) {
  const Live = require('./live-plan');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OBSERVATION_TIMEOUT_MS);
  let check = null;
  try {
    await Live.applyForServer(canonical, env, { signal: controller.signal, onObservation: value => { check = value; } });
  } finally { clearTimeout(timer); }
  return check;
}
async function openArchive(env) {
  return require('./private-period-history-postgres').openPeriodHistoryPostgres({ env });
}
async function closingExists(openStore, period) {
  const store = await openStore();
  try { return (await store.read()).some(row => sameKey(row, period)); }
  finally { try { await store.retire(); } catch (_) { /* session owner retires */ } }
}

// One attempt for one named period. `provider` says whether a provider
// request was made. Exported for tests; production reaches it only through
// the worker below. Never throws.
async function runOnce({ canonical, env, period, openStore = () => openArchive(env), observe = observeLive,
  buildInput = Capture.inputFor, now } = {}) {
  const History = require('./private-period-history');
  try {
    if (!period || !isDay(period.start) || !isDay(period.end)) return { closing: 'not-due', provider: false };
    try { if (await closingExists(openStore, period)) return { closing: 'already-captured', provider: false }; }
    catch (error) { return { closing: code(error, 'history-store-unavailable'), provider: false }; }
    let check;
    try { check = await observe(canonical, env); }
    catch (_) { return { closing: 'history-observation-unavailable', provider: true }; }
    if (!check || check.qualified !== true || !check.evidence || !check.evidence.payload) {
      return { closing: 'history-observation-unavailable', provider: true };
    }
    let candidate;
    try {
      const input = buildInput(canonical, check.evidence.payload, env);
      candidate = History.captureClosing(input, now ? { now } : {});
    } catch (error) {
      const c = code(error, 'history-capture-failed');
      return { closing: ['history-closing-date-invalid', 'history-closing-period-unavailable'].includes(c) ? 'not-due' : c, provider: true };
    }
    const named = candidate.content && candidate.content.period;
    if (!named || named.start !== period.start || named.end !== period.end) return { closing: 'not-due', provider: true };
    let store;
    try { store = await openStore(); }
    catch (error) { return { closing: code(error, 'history-store-unavailable'), provider: true }; }
    try {
      if ((await store.read()).some(row => sameKey(row, period))) return { closing: 'already-captured', provider: true };
      const appended = await store.append({ enabled: true, candidate });
      return { closing: appended && typeof appended.status === 'string' ? appended.status : 'history-capture-failed', provider: true };
    } catch (error) {
      const c = code(error, 'history-store-unavailable');
      return { closing: c === 'history-original-or-closing-conflict' ? 'already-captured' : c, provider: true };
    } finally { try { await store.retire(); } catch (_) { /* session owner retires */ } }
  } catch (_) { return { closing: 'history-capture-failed', provider: true }; }
}

if (!isMainThread && workerData && workerData.periodHistoryAutoCapture === true) {
  runOnce({ canonical: workerData.canonical, env: process.env, period: workerData.period })
    .then(message => parentPort.postMessage(message));
}

// Main-thread owner: one attempt at a time, the session gate shared with the
// archive read and the capture-on-refresh writer, and the per-day bound.
function create({ env = process.env, loadCanonical, clock = () => Date.now(), log = line => console.log(line),
  run, gate = SessionGate.shared } = {}) {
  const Forecast = require('../public/forecast');
  let running = false, savedKey = null, attemptDay = null, attempts = 0, lastAttempt = -Infinity;
  const launch = run || (data => new Promise(resolve => {
    let worker, timer, settled = false;
    const done = message => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!message && worker) worker.terminate().catch(() => {});
      resolve(message);
    };
    try {
      worker = new Worker(__filename, { workerData: { periodHistoryAutoCapture: true, ...data }, env });
      timer = setTimeout(() => done({ closing: 'history-capture-timeout', provider: true }), WORKER_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      worker.once('message', done);
      worker.once('error', () => done(null));
      worker.once('exit', () => done(null));
    } catch (_) { done(null); }
  }));
  async function tick() {
    let release = null, mine = false;
    try {
      if (!enabled(env)) return 'disabled';
      if (running) return 'busy';
      const today = Forecast.financialDate(new Date(clock()).toISOString());
      let canonical;
      try { canonical = loadCanonical(); } catch (_) { return 'no-canonical'; }
      const period = closedPeriod(canonical, today);
      if (!period) return 'no-period';
      const key = period.start + '..' + period.end;
      if (key === savedKey) return 'saved';
      if (attemptDay !== today) { attemptDay = today; attempts = 0; }
      if (attempts >= MAX_PROVIDER_ATTEMPTS_PER_DAY) return 'capped';
      if (clock() - lastAttempt < RETRY_MS) return 'throttled';
      release = gate.tryAcquire();
      if (!release) return 'busy';
      running = mine = true;
      let outcome = null;
      try { outcome = await launch({ canonical, period }); } catch (_) { outcome = null; }
      const provider = !outcome || outcome.provider !== false;
      if (provider) { attempts++; lastAttempt = clock(); }
      const closing = outcome && typeof outcome.closing === 'string' ? outcome.closing : 'history-capture-failed';
      if (SAVED.has(closing)) savedKey = key;
      log(JSON.stringify({ type: 'period-history-auto-capture', closing, provider }));
      return closing;
    } catch (_) { return 'failed'; }
    finally { if (mine) running = false; if (release) release(); }
  }
  return Object.freeze({ tick });
}

// Started by server.js after it listens. Returns null when switched off.
function start({ env = process.env, loadCanonical, ...options } = {}) {
  if (!enabled(env) || typeof loadCanonical !== 'function') return null;
  const owner = create({ env, loadCanonical, ...options });
  const run = () => { owner.tick().catch(() => {}); };
  const first = setTimeout(run, FIRST_TICK_MS);
  const every = setInterval(run, TICK_MS);
  if (first.unref) first.unref();
  if (every.unref) every.unref();
  return Object.freeze({ tick: owner.tick, stop() { clearTimeout(first); clearInterval(every); } });
}

module.exports = { FLAG, FIRST_TICK_MS, TICK_MS, RETRY_MS, MAX_PROVIDER_ATTEMPTS_PER_DAY,
  enabled, closedPeriod, runOnce, create, start };
