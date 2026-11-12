'use strict';
// Capture-on-refresh writer for the hosted period-history archive (#818).
//
// After a qualified live refresh, the server offers that refresh's retained
// source evidence here. When ATLAS_PERIOD_HISTORY_CAPTURE is exactly 'on',
// one background worker thread re-runs the existing capture seam
// (scripts/private-period-history.js) and appends to the hosted PostgreSQL
// archive (scripts/private-period-history-postgres.js):
//   - the latest fully-ended period as one `closing` record; and
//   - the current period's baseline, `original` when the observation falls
//     on the opening household day, otherwise `first-observed`.
// A period that already has a closing (or a baseline) is a no-op, so every
// later refresh observes the same rollover harmlessly.
//
// Fire-and-forget by construction: offer() never throws, never awaits the
// store and returns before any capture work starts, and the work runs off
// the main thread. A store failure or a slow store changes and delays
// nothing that is served. Off by default; nothing here reads or serves the
// archive. Its trigger is a served refresh, not a schedule; the one scheduled
// writer is scripts/period-history-auto-capture.js (closing records only).
// Forecast remains the only calculator.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const SessionGate = require('./period-history-session-gate');

const FLAG = 'ATLAS_PERIOD_HISTORY_CAPTURE';
const RETRY_MS = 10 * 60 * 1000;
const WORKER_TIMEOUT_MS = 120000;
const TERMINAL = new Set(['appended', 'duplicate', 'already-captured', 'not-due']);

function code(error, fallback) {
  const value = error && (error.code || error.message);
  return typeof value === 'string' && /^history-[a-z-]+$/.test(value) ? value : fallback;
}
// The connection owner's sanitized stage / category / SQLSTATE (never driver
// text). Re-validated here against fixed shapes so a log line can only ever
// carry three short fixed fields: a lowercase stage, a lowercase category and
// an upper-case code or null. Anything else is dropped, never logged.
function cleanDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'category,code,stage') return null;
    const { stage, category, code: sql } = value;
    if (typeof stage !== 'string' || !/^[a-z][a-z-]{0,23}$/.test(stage)) return null;
    if (typeof category !== 'string' || !/^[a-z][a-z-]{0,23}$/.test(category)) return null;
    if (sql !== null && (typeof sql !== 'string' || !/^[A-Z0-9_]{3,40}$/.test(sql))) return null;
    return Object.freeze({ stage, category, code: sql });
  } catch (_) { return null; }
}
function diagnosticOf(error) { try { return cleanDiagnostic(error && error.diagnostic); } catch (_) { return null; } }
function samePeriod(row, period) { return row.period.start === period.start && row.period.end === period.end; }

// Decides and appends against an already-open store. Exported for tests;
// production reaches it only through the worker below. Never throws.
async function captureOnce({ input, store, now = () => new Date() }) {
  const History = require('./private-period-history');
  const result = { closing: 'history-capture-failed', opening: 'history-capture-failed' };
  let rows, diagnostic = null;
  try { rows = await store.read(); } catch (error) {
    const c = code(error, 'history-store-unavailable'); const d = diagnosticOf(error);
    return d ? { closing: c, opening: c, diagnostic: d } : { closing: c, opening: c };
  }
  async function append(candidate, exists) {
    if (exists(candidate.content.period)) return 'already-captured';
    try {
      const appended = await store.append({ enabled: true, candidate });
      return appended.status;
    } catch (error) {
      diagnostic = diagnostic || diagnosticOf(error);
      // A concurrent writer that won the singleton is the same no-op.
      return code(error, 'history-store-unavailable') === 'history-original-or-closing-conflict'
        ? 'already-captured' : code(error, 'history-store-unavailable');
    }
  }
  try {
    const candidate = History.captureClosing(input, { now });
    result.closing = await append(candidate, period => rows.some(row => row.kind === 'closing' && samePeriod(row, period)));
  } catch (error) {
    const c = code(error, 'history-capture-failed');
    result.closing = ['history-closing-date-invalid', 'history-closing-period-unavailable'].includes(c) ? 'not-due' : c;
  }
  try {
    let candidate;
    try { candidate = History.capture({ ...input, kind: 'original' }, { now }); }
    catch (error) {
      if (code(error) !== 'history-original-opening-unproven') throw error;
      candidate = History.capture({ ...input, kind: 'first-observed' }, { now });
    }
    const BASELINES = ['original', 'first-observed', 'reconstructed'];
    result.opening = await append(candidate, period => rows.some(row => BASELINES.includes(row.kind) && samePeriod(row, period)));
  } catch (error) { result.opening = code(error, 'history-capture-failed'); }
  if (diagnostic) result.diagnostic = diagnostic;
  return result;
}

// Builds the capture input from the same sources the served refresh used:
// canonical data, the retained source evidence, the live account map, the
// transaction-identity rules and the monthly periods file. `options.periodsFile`
// exists for tests; production uses public/periods.json.
function inputFor(canonical, payload, env, options = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const Observer = require('./provider-observe');
  const periodsFile = options.periodsFile || path.join(__dirname, '..', 'public', 'periods.json');
  // The parsed file itself: the object the served path gives Forecast
  // (operating-answer.js loadPeriods). The seam validates its shape and fails
  // closed on a missing or malformed file (null).
  const periods = fs.existsSync(periodsFile) ? JSON.parse(fs.readFileSync(periodsFile, 'utf8')) : null;
  const identity = fs.existsSync(Observer.DEFAULT_IDENTITY)
    ? JSON.parse(fs.readFileSync(Observer.DEFAULT_IDENTITY, 'utf8')) : { rules: [], billPaymentPayees: [] };
  return { data: canonical, payload, accountMap: Observer.loadLiveAccountMap(env, canonical), identity, periods };
}

// The worker's whole job, as a function so it can be exercised in-process.
// Resolves to the one message the worker posts: fixed codes, plus the
// connection owner's sanitized diagnostic when the store refused. Never throws.
async function runWorker({ canonical, payload, env, open, buildInput = inputFor, now } = {}) {
  let store = null;
  try {
    let input;
    try { input = buildInput(canonical, payload, env); }
    catch (_) { return { closing: 'history-capture-input-invalid', opening: 'history-capture-input-invalid' }; }
    const openStore = open || (() => require('./private-period-history-postgres').openPeriodHistoryPostgres({ env }));
    try { store = await openStore(); }
    catch (error) {
      const c = code(error, 'history-store-unavailable'); const d = diagnosticOf(error);
      return d ? { closing: c, opening: c, diagnostic: d } : { closing: c, opening: c };
    }
    return await captureOnce(now ? { input, store, now } : { input, store });
  } catch (_) {
    return { closing: 'history-capture-failed', opening: 'history-capture-failed' };
  } finally {
    if (store) { try { await store.retire(); } catch (_) { /* session owner retires */ } }
  }
}

if (!isMainThread && workerData && workerData.periodHistoryCapture === true) {
  runWorker({ canonical: workerData.canonical, payload: workerData.payload, env: process.env })
    .then(message => parentPort.postMessage(message));
}

// Main-thread owner. One capture worker at a time; a day whose closing and
// opening both reached a terminal state is not re-attempted; a failed day is
// retried no sooner than RETRY_MS. Results are logged as fixed codes only.
function create({ log = line => console.log(line), clock = () => Date.now(), spawn, gate = SessionGate.shared } = {}) {
  let running = false, doneDay = null, lastAttempt = -Infinity;
  const start = spawn || ((data, env) => new Worker(__filename, { workerData: data, env }));
  function offer({ canonical, evidence, env, day } = {}) {
    let release = null;
    try {
      if (!env || env[FLAG] !== 'on') return 'disabled';
      if (running) return 'busy';
      if (day && day === doneDay) return 'done';
      if (clock() - lastAttempt < RETRY_MS) return 'throttled';
      if (!evidence || !evidence.payload || !canonical) return 'no-evidence';
      // The archive role allows one session: a read in flight owns it. Skip
      // this offer without spending the retry window; the next refresh offers
      // again.
      release = gate.tryAcquire();
      if (!release) return 'busy';
      running = true; lastAttempt = clock();
      // Deferred: no capture work, clone or worker start runs inside the
      // caller's publication turn.
      setImmediate(() => {
        let worker, timer, settled = false;
        const finish = outcome => {
          if (settled) return;
          settled = true; running = false; clearTimeout(timer); release();
          const ok = outcome && TERMINAL.has(outcome.closing) && TERMINAL.has(outcome.opening);
          if (ok && day) doneDay = day;
          const diagnostic = outcome ? cleanDiagnostic(outcome.diagnostic) : null;
          log(JSON.stringify({ type: 'period-history-capture',
            closing: outcome && typeof outcome.closing === 'string' ? outcome.closing : 'history-capture-failed',
            opening: outcome && typeof outcome.opening === 'string' ? outcome.opening : 'history-capture-failed',
            ...(diagnostic ? { diagnostic } : {}) }));
          // A finished worker exits on its own after retiring its session;
          // only a timed-out one is stopped.
          if (outcome && outcome.closing === 'history-capture-timeout' && worker) worker.terminate().catch(() => {});
        };
        try {
          worker = start({ periodHistoryCapture: true, canonical, payload: evidence.payload }, env);
          timer = setTimeout(() => finish({ closing: 'history-capture-timeout', opening: 'history-capture-timeout' }), WORKER_TIMEOUT_MS);
          if (timer.unref) timer.unref();
          worker.once('message', finish);
          worker.once('error', () => finish(null));
          worker.once('exit', () => finish(null));
        } catch (_) { finish(null); }
      });
      return 'started';
    } catch (_) { running = false; if (release) release(); return 'failed'; }
  }
  return Object.freeze({ offer });
}

module.exports = { FLAG, RETRY_MS, captureOnce, runWorker, cleanDiagnostic, inputFor, create };
