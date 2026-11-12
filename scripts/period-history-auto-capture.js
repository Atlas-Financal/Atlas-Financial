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
// Retry bound (owner, confirmed directly to Atlas 2026-11-12, #1118
// 6822401747: "up to six times a day, until that period is saved"; the claim
// record approved in #821 6822615033): a failed attempt that saved nothing is
// tried again until a closing exists or the next rollover passes. An attempt
// may start only on a tick inside one of six fixed household-time windows per
// day (00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 America/Vancouver, each
// SLOT_WINDOW_MS long), and only after it has claimed that window in the
// archive's capture_window_claims table, which accepts one claim per window
// across every server instance and restart. So the whole fleet makes at most
// one attempt per window and six per household day, however many instances
// run. The in-process rules (once per window per process, none in a window
// that opened before the process started) only save archive round trips.
// Results are logged as fixed codes only. Forecast remains the only
// calculator.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const Capture = require('./period-history-refresh-capture');
const SessionGate = require('./period-history-session-gate');

const FLAG = 'ATLAS_PERIOD_HISTORY_AUTO_CAPTURE';
const FIRST_TICK_MS = 60 * 1000;
const TICK_MS = 15 * 60 * 1000;
const SLOT_HOURS = Object.freeze([0, 4, 8, 12, 16, 20]);
const SLOT_WINDOW_MS = TICK_MS;
const MAX_PROVIDER_ATTEMPTS_PER_DAY = SLOT_HOURS.length;
const HOUSEHOLD_TIME_ZONE = 'America/Vancouver';
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

// The household wall-clock hour and minute at `ms`.
const clockParts = new Intl.DateTimeFormat('en-CA', { timeZone: HOUSEHOLD_TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function householdClock(ms) {
  const parts = Object.fromEntries(clockParts.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour),
    minute: Number(parts.minute), second: Number(parts.second) };
}
// The attempt window containing `ms`, as { key, opened } (opened = the
// window's start instant), or null outside every window.
function slotAt(ms) {
  const c = householdClock(ms);
  if (!SLOT_HOURS.includes(c.hour)) return null;
  const into = (c.minute * 60 + c.second) * 1000 + (ms % 1000);
  if (into >= SLOT_WINDOW_MS) return null;
  return { key: c.day + 'T' + String(c.hour).padStart(2, '0'), opened: ms - into };
}

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
async function observeLive(canonical, env, signal) {
  const Live = require('./live-plan');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OBSERVATION_TIMEOUT_MS);
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', () => controller.abort(), { once: true }); }
  let check = null;
  try {
    await Live.applyForServer(canonical, env, { signal: controller.signal, onObservation: value => { check = value; } });
  } finally { clearTimeout(timer); }
  return check;
}
async function openArchive(env) {
  return require('./private-period-history-postgres').openPeriodHistoryPostgres({ env });
}
// One attempt for one named period. `provider` says whether a provider
// request was made. The whole attempt runs inside ONE archive session, held
// from the closing check through the observation and the append. The
// archive's writer role allows a single connection (CONNECTION LIMIT 1), so
// that session is also the fleet-wide lock: a second server instance cannot
// connect while it is held, is refused before any provider request, and once
// the session ends finds the closing already saved. Exported for tests;
// production reaches it only through the worker below. Never throws.
async function runOnce({ canonical, env, period, windowStart, openStore = () => openArchive(env), observe = observeLive,
  buildInput = Capture.inputFor, now } = {}) {
  const History = require('./private-period-history');
  let store = null;
  try {
    if (!period || !isDay(period.start) || !isDay(period.end)
      || typeof windowStart !== 'string' || Number.isNaN(Date.parse(windowStart))) return { closing: 'not-due', provider: false };
    try {
      store = await openStore();
      if ((await store.read()).some(row => sameKey(row, period))) return { closing: 'already-captured', provider: false };
    } catch (error) { return { closing: code(error, 'history-store-unavailable'), provider: false }; }
    // The archive session is the cross-instance lock, so the observation lives
    // only while this instance holds it. The connection owner calls onLoss
    // synchronously when the session is lost or retired, before the
    // connection is released, and that aborts the read at once. A store
    // that cannot report loss is never used for an observation.
    if (typeof store.onLoss !== 'function') return { closing: 'history-session-unguarded', provider: false };
    // Claim this window fleet-wide before any provider request (#821
    // 6822615033): exactly one claim per window across every instance and
    // restart, so at most one attempt per window and six per household day.
    if (typeof store.claimWindow !== 'function') return { closing: 'history-claims-unavailable', provider: false };
    let claimed;
    try { claimed = await store.claimWindow({ periodStart: period.start, periodEnd: period.end, windowStart }); }
    catch (error) { return { closing: code(error, 'history-store-unavailable'), provider: false }; }
    if (claimed !== true) return { closing: 'history-window-claimed', provider: false };
    const ownership = new AbortController();
    const unsubscribe = store.onLoss(() => ownership.abort());
    if (ownership.signal.aborted) { unsubscribe(); return { closing: 'history-session-lost', provider: false }; }
    let check;
    try { check = await observe(canonical, env, ownership.signal); }
    catch (_) { check = null; }
    finally { unsubscribe(); }
    if (ownership.signal.aborted) return { closing: 'history-session-lost', provider: true };
    if (check === null) return { closing: 'history-observation-unavailable', provider: true };
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
    try {
      const appended = await store.append({ enabled: true, candidate });
      return { closing: appended && typeof appended.status === 'string' ? appended.status : 'history-capture-failed', provider: true };
    } catch (error) {
      const c = code(error, 'history-store-unavailable');
      return { closing: c === 'history-original-or-closing-conflict' ? 'already-captured' : c, provider: true };
    }
  } catch (_) { return { closing: 'history-capture-failed', provider: true }; }
  finally { if (store) { try { await store.retire(); } catch (_) { /* session owner retires */ } } }
}

if (!isMainThread && workerData && workerData.periodHistoryAutoCapture === true) {
  runOnce({ canonical: workerData.canonical, env: process.env, period: workerData.period, windowStart: workerData.windowStart })
    .then(message => parentPort.postMessage(message));
}

// Main-thread owner: one attempt at a time, the session gate shared with the
// archive read and the capture-on-refresh writer, and the per-day bound.
function create({ env = process.env, loadCanonical, clock = () => Date.now(), log = line => console.log(line),
  run, spawn, workerTimeoutMs = WORKER_TIMEOUT_MS, gate = SessionGate.shared } = {}) {
  const Forecast = require('../public/forecast');
  const bootedAt = clock();
  let running = false, savedKey = null, triedSlot = null;
  const makeWorker = spawn || (data => new Worker(__filename, { workerData: { periodHistoryAutoCapture: true, ...data }, env }));
  // Resolves only once the worker has exited, so the caller holds the session
  // gate for as long as the worker can touch the archive. A timed-out worker
  // is terminated and waited for, never left running.
  const launch = run || (data => new Promise(resolve => {
    let worker, timer, message = null, settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(message); };
    try {
      worker = makeWorker(data);
      timer = setTimeout(() => {
        message = { closing: 'history-capture-timeout', provider: true };
        Promise.resolve().then(() => worker.terminate()).catch(() => {}).then(finish);
      }, workerTimeoutMs);
      worker.once('message', value => { if (!message) message = value; });
      worker.once('error', () => {});
      worker.once('exit', finish);
    } catch (_) { finish(); }
  }));
  async function tick() {
    let release = null, mine = false;
    try {
      if (!enabled(env)) return 'disabled';
      if (running) return 'busy';
      const now = clock();
      const today = Forecast.financialDate(new Date(now).toISOString());
      let canonical;
      try { canonical = loadCanonical(); } catch (_) { return 'no-canonical'; }
      const period = closedPeriod(canonical, today);
      if (!period) return 'no-period';
      const key = period.start + '..' + period.end;
      if (key === savedKey) return 'saved';
      const slot = slotAt(now);
      if (!slot) return 'outside-window';
      if (bootedAt > slot.opened) return 'started-mid-window';
      if (slot.key === triedSlot) return 'window-used';
      release = gate.tryAcquire();
      if (!release) return 'busy';
      running = mine = true;
      triedSlot = slot.key;
      let outcome = null;
      try { outcome = await launch({ canonical, period, windowStart: new Date(slot.opened).toISOString() }); } catch (_) { outcome = null; }
      const provider = !outcome || outcome.provider !== false;
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

module.exports = { FLAG, FIRST_TICK_MS, TICK_MS, SLOT_HOURS, SLOT_WINDOW_MS, MAX_PROVIDER_ATTEMPTS_PER_DAY,
  enabled, closedPeriod, slotAt, runOnce, create, start };
