'use strict';
// Request lifecycle only. The existing LivePlan/Forecast modules own all values.
// Live consumers share active work. Browser reads may replay compatible private
// source evidence; Observer/LivePlan re-evaluate it and Forecast owns all values.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const StageTiming = require('./refresh-stage-timing');
const CoverageDiagnostics = require('./coverage-diagnostics');
const LIVE_REFRESH_TIMEOUT_MS = 150000;
const MAX_ACTIVE_LIVE_REFRESHES = 2;
// OD-4 (#821, owner 2026-11-11): after a failed provider check, a normal page
// load shows the retained cohort without asking the provider again only for
// this long; the next normal load after it asks again, so a new sync appears
// without pressing Refresh. Bounds provider GETs to one coalesced check per
// gap from ordinary page loads.
const FAILED_CHECK_RETRY_GAP_MS = 5 * 60 * 1000;

// Replay reuse (#822 c) disk witness. A replay's result can depend on files
// it reads from disk (for example public/periods.json), not only on its
// inputs. A replay worker records every path it touches, with the file's
// revision taken BEFORE the touch; the main thread remembers the result only
// while every one of those revisions is still current, and re-checks them all
// on reuse. A change after the stat, an unreadable revision or a call it
// cannot attribute to a path leaves the result unremembered. Paths only:
// never file contents, and never logged or served.
// Captured before any wrapping below, so a revision read is never itself
// recorded (and cannot recurse).
const statUnrecorded = require('node:fs').statSync;
function diskRevision(file) {
  try {
    const stat = statUnrecorded(file, { bigint: true });
    return [file, stat.isDirectory() ? 'dir' : 'file', String(stat.dev), String(stat.ino),
      String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
  } catch (error) {
    return error && error.code === 'ENOENT' ? [file, 'missing'] : null;
  }
}
function recordDiskReads(root) {
  const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url');
  const seen = new Map(), descriptors = new Set();
  let complete = true;
  const note = target => {
    try {
      // A descriptor counts only when a recorded open returned it; any other
      // descriptor names no path, so the witness is incomplete.
      if (typeof target === 'number') { if (!descriptors.has(target)) complete = false; return; }
      if (target instanceof URL) target = fileURLToPath(target);
      else if (Buffer.isBuffer(target)) target = target.toString();
      if (typeof target !== 'string') { complete = false; return; }
      const file = path.resolve(target);
      if (!seen.has(file)) {
        const revision = diskRevision(file);
        if (!revision) complete = false;
        seen.set(file, revision);
      }
    } catch (_) { complete = false; }
  };
  const recorded = original => function (target, ...rest) { note(target); return original.call(this, target, ...rest); };
  const wrap = (owner, names) => {
    for (const name of names) {
      const original = owner[name];
      if (typeof original !== 'function') continue;
      owner[name] = recorded(original);
      // realpathSync.native and realpath.native are reads too.
      if (typeof original.native === 'function') owner[name].native = recorded(original.native);
    }
  };
  wrap(fs, ['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'lstatSync', 'accessSync',
    'readFile', 'readdir', 'stat', 'lstat', 'access', 'createReadStream', 'opendirSync', 'opendir',
    'realpathSync', 'realpath', 'readlinkSync', 'readlink', 'statfsSync', 'statfs', 'watch', 'watchFile',
    'readSync', 'read', 'fstatSync', 'fstat']);
  wrap(fs.promises, ['readFile', 'readdir', 'stat', 'lstat', 'open', 'access', 'opendir',
    'realpath', 'readlink', 'statfs']);
  // Opens are recorded by path, and the descriptor they return is known.
  const openSync = fs.openSync, open = fs.open;
  fs.openSync = function (target, ...rest) {
    note(target);
    const fd = openSync.call(this, target, ...rest);
    descriptors.add(fd);
    return fd;
  };
  fs.open = function (target, ...rest) {
    note(target);
    const done = rest.length && typeof rest[rest.length - 1] === 'function' ? rest.pop() : null;
    if (!done) return open.call(this, target, ...rest);
    return open.call(this, target, ...rest, (error, fd) => {
      if (!error) descriptors.add(fd);
      done(error, fd);
    });
  };
  return () => {
    // Repository modules this worker loaded are inputs too.
    for (const file of Object.keys(require.cache)) if (file.startsWith(root)) note(file);
    return complete ? [...seen.values()] : null;
  };
}

if (!isMainThread) {
  // Record from before the planner modules load, so a file read at module
  // load is witnessed too. Only memory-replay serve jobs can be reused.
  const replayReads = workerData.evidence && !workerData.acquire
    ? recordDiskReads(require('node:path').resolve(__dirname, '..') + require('node:path').sep) : null;
  const Live = require('./live-plan');
  const controller = new AbortController();
  let check = { qualified: false, checkedAt: null, evidence: null };
  parentPort.on('message', () => controller.abort());
  if (workerData.acquire) {
    // Private acquisition job: the result is an acquisition for the
    // private waiter only. It is never a served response.
    StageTiming.run(() => Live.acquireSettlementForServer(workerData.canonical, process.env, { signal: controller.signal,
      evidence: workerData.evidence, onObservation: value => { check = value; } }),
    stages => parentPort.postMessage({ type: StageTiming.MESSAGE, stages }))
      .then(acquisition => parentPort.postMessage({ acquisition, check }))
      .catch(() => parentPort.postMessage({ error: 'live-refresh-unavailable' }));
  } else {
    StageTiming.run(() => Live.applyForServer(workerData.canonical, process.env, { signal: controller.signal,
      evidence: workerData.evidence, onObservation: value => { check = value; },
      onCoverageDiagnostic: counts => CoverageDiagnostics.merge(check.coverageDiagnostics ||= {}, counts),
      onHouseholdIdentity: value => parentPort.postMessage({ type: 'household-identity', accountId: value }) }),
    stages => parentPort.postMessage({ type: StageTiming.MESSAGE, stages }))
      .then(data => {
        let reads = null;
        try { reads = replayReads ? replayReads() : null; } catch (_) { reads = null; }
        parentPort.postMessage({ data, check, ...(replayReads ? { reads } : {}) });
      })
      .catch(() => parentPort.postMessage({ error: 'live-refresh-unavailable' }));
  }
} else {
  const crypto = require('node:crypto');
  const { isDeepStrictEqual } = require('node:util');
  const fs = require('node:fs');
  const path = require('node:path');
  const Forecast = require('../public/forecast');
  const Observer = require('./provider-observe');
  const Credentials = require('./local-credentials');
  const ObservationMemory = require('./server-observation-memory');
  const observations = ObservationMemory.create();
  // Off unless ATLAS_PERIOD_HISTORY_CAPTURE=on; offer() never throws or waits.
  const periodCapture = require('./period-history-refresh-capture').create();
  const root = path.resolve(__dirname, '..') + path.sep;
  // Private process-local identity only. Never log a key, environment or input.
  const keySalt = crypto.randomBytes(32);
  const active = new Set();
  const jobs = new Map();
  let generation = 0n, observationEpoch = 0n, activeWrites = 0;
  // Set when any live provider attempt fails (forced or automatic): the
  // retained observation stays in its slot, but replay is held until a later
  // qualified publish, so the failure is not hidden behind the earlier
  // success and the next eligible load asks the provider.
  let replayHeld = false;
  // Item c (#822): one process-memory copy of the last qualified replay
  // result, so a later page load replaying the same retained observation
  // does not run Forecast again. Memory only: never written to disk, logged
  // or sent anywhere beyond the response the worker result already makes.
  // The key binds the job context (canonical, environment, household day,
  // loaded engine files, write generation), the observation epoch and the
  // exact retained observation; the disk witness (diskRevision, above) binds
  // every file the replay read. Any doubt is a miss, and a miss recomputes.
  const replayReuse = (() => {
    let slot = null;
    return Object.freeze({
      clear() { slot = null; },
      remember(key, result) {
        try {
          slot = readsCurrent(result.reads) ? { key, day: financialDay(), result: structuredClone(result) } : null;
        } catch (_) { slot = null; }
      },
      take(key) {
        if (!slot || typeof key !== 'string' || slot.key !== key || slot.day !== financialDay()
          || !readsCurrent(slot.result.reads)) {
          slot = null;
          return null;
        }
        try { return structuredClone(slot.result); } catch (_) { slot = null; return null; }
      },
    });
  })();
  // Every file the replay touched must still be at the revision it was
  // read at. An empty, malformed or incomplete witness is never current.
  function readsCurrent(reads) {
    if (!Array.isArray(reads) || reads.length === 0) return false;
    for (const entry of reads) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') return false;
      const now = diskRevision(entry[0]);
      if (!now || !isDeepStrictEqual(now, entry)) return false;
    }
    return true;
  }
  function replayReuseKey(context, evidence) {
    return crypto.createHmac('sha256', keySalt).update(JSON.stringify(contextValue(['replay-reuse/v1',
      context, String(generation), String(observationEpoch), financialDay(), evidence]))).digest('hex');
  }
  function unavailable(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  function fileRevision(file, metadata) {
    if (!file) return null;
    try {
      const stat = fs.statSync(file, { bigint: true });
      return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
    } catch (error) {
      if (error.code !== 'ENOENT' && metadata) metadata.readable = false;
      // A missing file is stable. Unreadable metadata must never authorize reuse.
      return [file, error.code === 'ENOENT' ? null : crypto.randomBytes(32).toString('hex')];
    }
  }
  function contextValue(value, seen = new Map()) {
    // Private identity encoding, never a financial packet or stored schema.
    // V8's wire bytes can differ for equal one-/two-byte-backed JS strings.
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (value === undefined) return ['undefined'];
    if (typeof value !== 'object') throw unavailable('live-refresh-unavailable');
    if (seen.has(value)) return ['reference', seen.get(value)];
    const id = seen.size;
    seen.set(value, id);
    const entries = Object.entries(value).map(([name, child]) => [name, contextValue(child, seen)]);
    if (Array.isArray(value)) return ['array', id, value.length, entries];
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw unavailable('live-refresh-unavailable');
    }
    return ['object', id, entries];
  }
  function financialDay() { return Forecast.financialDate(new Date(Date.now()).toISOString()); }
  function jobKey(canonical, env, metadata = { readable: true }) {
    const runtime = Object.keys(require.cache).filter(file => file.startsWith(root))
      .sort().map(file => fileRevision(file, metadata));
    const files = [Observer.DEFAULT_IDENTITY, Observer.DEFAULT_MAP, Observer.LOCAL_MAP,
      env[Observer.MAP_PATH_ENV] && path.resolve(env[Observer.MAP_PATH_ENV]),
      !Credentials.envToken(env) && process.platform === 'win32'
        ? Credentials.defaultCredentialPath(env) : null].filter(Boolean).map(file => fileRevision(file, metadata));
    const day = financialDay();
    return crypto.createHmac('sha256', keySalt)
      .update(JSON.stringify(contextValue([canonical, Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
        day, process.execArgv, runtime, files, generation]))).digest('hex');
  }
  // DISPLAY identity only. No day, runtime version, browser auth or write
  // generation is included. Household identity is separately attested by /me.
  function displayKey(canonical, env) {
    const map = Observer.loadLiveAccountMap(env, canonical);
    const categories = (canonical.plan?.budget?.categories || []).map(row => ({
      id: row.id, from: row.from, class: row.class,
    }));
    return { accountMap: map, categoryMapping: categories };
  }
  function retainedDisplay(canonical, env, accountId, attempt, persist = true, preferClear = true) {
    try {
      // Lead ruling: the normal production provider environment is assumed
      // fixed for the process. A failed /me may reuse historical same-process
      // budget identity; no credential, credential hash or session is stored.
      if (accountId && persist) observations.observeBudget(accountId);
      // This is the trusted resolver's ENV-first source classification, not
      // a token value comparison/fingerprint. Never read a local credential.
      if (!Credentials.envToken(env || process.env)) return null;
      const context = displayKey(canonical, env);
      // Dale, 2026-11-18: the last FULL picture. When the newest retained
      // publication carries a whole-plan hold, the last non-withheld one is
      // shown instead (under the banner), if this process still holds it.
      // Precedence checks (preferClear false) read the newest held cohort.
      const newest = observations.readDisplay(context);
      const retained = preferClear && newest && ObservationMemory.planWithheld(newest.data)
        ? observations.readClearDisplay(context) || newest : newest;
      if (!retained || retained.credentialSource !== 'env'
        || (accountId && accountId !== retained.householdAccountId)
        || retained.lastBudgetAccountId !== retained.householdAccountId) return null;
      if (attempt && persist) observations.noteAttempt(context, attempt);
      const receipt = attempt || retained.attempt || { source: null, qualified: false,
        checkedAt: null, attemptedAt: null, reason: 'current-observation-unavailable' };
      const data = require('./live-plan').withLatestCompleteRefresh(retained, receipt);
      return { data, check: data.liveOverlay.retainedRefresh.attempt,
        checkedAt: retained.checkedAt, cashEvidenceAt: retained.cashEvidenceAt || null };
    } catch (_) { return null; }
  }
  // OD-2 (#821): the worker's evidence-day view of the provider's own last
  // sync needs no process memory, so a restart cannot blank it. The view is
  // never qualified, never published and never retained.
  //
  // Precedence against a cohort this process retained (lead design ruling on
  // #1040, 6788227366): a later as-of day wins outright. On the same household
  // day, balance evidence is compared with balance evidence, then fetch order:
  // the view (a newer fetch) wins unless its newest required balance instant
  // is strictly older than the retained cohort's newest required balance
  // instant. Equal balance instants with a later fetch go to the later fetch,
  // which covers a transaction-only change (a new or recategorised row) that
  // leaves balance times unchanged. A view that is not a later fetch, or any
  // unreadable instant, keeps the retained cohort.
  function evidenceDayNewer(view, held) {
    const viewDay = view.meta.asOf, heldDay = held.data?.meta?.asOf;
    if (typeof heldDay !== 'string') return false;
    if (viewDay !== heldDay) return viewDay > heldDay;
    const at = value => typeof value === 'string' ? Date.parse(value) : NaN;
    const viewFetch = at(view.liveOverlay.retainedRefresh.attempt?.checkedAt), heldFetch = at(held.checkedAt);
    const viewBalance = at(view.liveOverlay.retainedRefresh.observedAt), heldBalance = at(held.cashEvidenceAt);
    if (![viewFetch, heldFetch, viewBalance, heldBalance].every(Number.isFinite)) return false;
    if (viewFetch <= heldFetch) return false;
    return viewBalance >= heldBalance;
  }
  function evidenceDayDisplay(canonical, env, result, accountId) {
    const data = result?.data;
    if (result?.check?.evidenceDayView !== true || result.check.qualified === true
      || !data?.liveOverlay?.retainedRefresh || !ObservationMemory.completeTransactionCohort(data)
      || typeof data.meta?.asOf !== 'string') return null;
    // Precedence against the NEWEST held cohort, withheld or not: a view older
    // than it never wins and never drops it (rulings 6788227366 / 6788734379).
    const held = retainedDisplay(canonical, env, accountId, null, false, false);
    if (held && !evidenceDayNewer(data, held)) return null;
    // Any supersession, same day or later, drops the superseded cohort from
    // memory (lead ruling 6788734379): a process never shows figures older
    // than ones it has already superseded. An outage after a supersession is
    // then unavailable, as in a cold process.
    return { data, check: data.liveOverlay.retainedRefresh.attempt, supersedes: !!held };
  }
  // True only for a failed provider check attempted within the retry gap. A
  // missing, unreadable or future attempt time is not recent: ask again.
  function recentFailedProviderCheck(attempt) {
    if (attempt?.source !== 'provider') return false;
    const age = Date.now() - Date.parse(attempt.attemptedAt);
    return Number.isFinite(age) && age >= 0 && age < FAILED_CHECK_RETRY_GAP_MS;
  }
  function failedAttempt(check, reason) {
    return { source: 'provider', qualified: false, checkedAt: check?.checkedAt || null,
      attemptedAt: new Date(Date.now()).toISOString(), reason: reason || 'current-observation-unavailable' };
  }
  function emitTiming(job) {
    if (job.logged) return;
    job.logged = true;
    const elapsed = (start, end) => start == null || end == null ? null : Math.max(0, Math.round(end - start));
    // Closed fields only: no payload, error text, provider identity or key.
    // completed means the worker returned, not that provider evidence qualified.
    console.log(JSON.stringify({ type: 'live-refresh-lifecycle', outcome: job.outcome,
      totalMs: elapsed(job.started, job.finished),
      workerStartupMs: elapsed(job.started, job.online),
      workerRunMs: elapsed(job.online, job.finished),
      cleanupMs: elapsed(job.finished, performance.now()),
      waiterCount: job.waiterCount, peakWaiters: job.peakWaiters,
      cancelledWaiters: job.cancelledWaiters, timedOutWaiters: job.timedOutWaiters }));
    console.log(JSON.stringify(StageTiming.record(job.stages, job.evidence ? 'memory' : 'provider',
      job.outcome, job.check?.qualified, job.publicationMs)));
    console.log(JSON.stringify(CoverageDiagnostics.record(job.check?.coverageDiagnostics)));
    // Closed fields only: whether a remembered replay result served this job.
    if (job.reused) console.log(JSON.stringify({ type: 'live-refresh-reuse', outcome: job.outcome,
      totalMs: elapsed(job.started, job.finished) }));
  }
  // --- Write-admission freshness witness (private) -----------------------
  // A witness is minted per waiter inside the acquisition publication
  // continuation (settleWaiter, below) and paired with exactly that
  // waiter's acquisition clone. It captures the lifecycle state the
  // publication barriers just validated — generation, observationEpoch,
  // financial day and context — and re-checks it synchronously at
  // invocation: any invalidation since publication (a provider write, a
  // superseding publish or live job, a replay hold, a day rollover, a
  // context replacement) refuses. The trusted caller's synchronous
  // current-context reader is REQUIRED (B1): a fenced acquisition mints
  // no admitting witness without it — recomputing freshness from the
  // job's captured inputs is not a fallback, since replacement or ABA
  // outside those captured objects would be invisible. The reader's
  // context and monotonic revision are first captured at acquisition
  // ENTRY, before the asynchronous worker runs (B2), and rechecked in
  // the publication continuation: replacement or ABA while the worker
  // was running refuses that acquisition's witness rather than adopting
  // the newer state as its baseline. Coalesced reuse is bound to the
  // job's issuing stamp (the creating waiter's reader domain and entry
  // capture): a waiter that joined across a revision, or from another
  // reader domain, refuses even when its own capture is fresh, because
  // the shared work was issued under the earlier state. At invocation the witness
  // requires a fresh reading whose recomputed context key matches AND
  // whose revision is unchanged since entry, so replacement and ABA are
  // detected even where content — and therefore the context key —
  // returns to identical bytes. Reader failure, malformed or
  // asynchronous results, or any uncertainty refuse. There is no global
  // latest-witness slot: each closure captures only its own job's state.
  // Each waiter owns its witness — including a refusing one: minting
  // returns a fresh closure per waiter, never a shared constant.
  const REFUSING_WITNESS = () => () => false;
  function readContextReader(reader) {
    try {
      const value = reader();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      if (typeof value.then === 'function') return null;
      const revision = value.contextRevision;
      if (!Number.isSafeInteger(revision) || revision < 0) return null;
      const metadata = { readable: true };
      const key = jobKey(value.canonical, value.env, metadata);
      if (!metadata.readable) return null;
      return { key, revision };
    } catch { return null; }
  }
  // Capture the trusted reader's current context at acquisition ENTRY,
  // synchronously, before any asynchronous work runs (B2). The capture
  // is valid only when the reader is a function whose synchronous
  // reading is well-formed and names exactly the context being acquired;
  // anything else (no reader, a non-function, a throwing / asynchronous
  // / malformed reader, a context mismatch) captures null, and a null
  // capture can never mint an admitting witness (B1).
  function captureEntryContext(suppliedReader, context) {
    if (typeof suppliedReader !== 'function') return null;
    const reading = readContextReader(suppliedReader);
    if (!reading || reading.key !== context) return null;
    return reading;
  }
  function mintWitness(job, suppliedReader, entryCapture) {
    const context = job.context, day = job.day;
    const gen = generation, epoch = observationEpoch;
    // B1: the reader is required — no reader or no valid entry capture
    // yields a permanently refusing witness, never a captured-input
    // recomputation.
    if (typeof suppliedReader !== 'function' || !entryCapture) return REFUSING_WITNESS();
    // B2 (joined case): coalesced reuse is bound to the job's ISSUING
    // stamp — the reader domain and entry capture of the waiter that
    // created the job. A waiter that joined a job issued under a
    // different reader, or at an earlier context/revision, does not
    // inherit an admitting witness from its own later, fresher capture:
    // the work it would admit was started under the issuing state.
    if (suppliedReader !== job.issuingReader || !job.issuingCapture
      || entryCapture.key !== job.issuingCapture.key
      || entryCapture.revision !== job.issuingCapture.revision) return REFUSING_WITNESS();
    // B2: recheck the entry capture in the publication continuation. A
    // context replaced — or taken away and returned — while the worker
    // ran has an advanced revision, so this acquisition's witness
    // refuses rather than adopting the newer state as its baseline.
    const current = readContextReader(suppliedReader);
    if (!current || current.key !== entryCapture.key
      || current.revision !== entryCapture.revision) return REFUSING_WITNESS();
    const baseline = entryCapture;
    const reader = suppliedReader;
    return function freshnessWitness() {
      try {
        if (generation !== gen || observationEpoch !== epoch) return false;
        if (activeWrites !== 0 || replayHeld) return false;
        if (jobs.has(context + ':live')) return false;
        if (financialDay() !== day) return false;
        const reading = readContextReader(reader);
        if (!reading || reading.key !== context || reading.revision !== baseline.revision) return false;
        return true;
      } catch { return false; }
    };
  }
  function settleWaiter(job, waiter, error, data) {
    if (!job.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.cancelled);
    let displayCheck = job.displayCheck;
    // Timing only: true where a retained display (not this job's own
    // result, such as a dated evidence-day view) was selected to serve.
    let servedRetained = job.servedRetained === true;
    if (error && !job.acquire && error.code !== 'live-refresh-cancelled' && job.contextInput) {
      // Error/timeout/exit publication needs the same obsolete-work fence as
      // normal results. An old waiter may read a compatible dated cohort but
      // cannot rewrite a newer cohort's budget identity or failed-attempt time.
      let current = false;
      try {
        const metadata = { readable: true };
        current = job.generation === generation && job.observationEpoch === observationEpoch
          && job.day === financialDay() && job.context === jobKey(job.contextInput, job.contextEnv, metadata)
          && metadata.readable && !activeWrites;
      } catch (_) { /* Dated read only, never publication. */ }
      const receipt = job.evidence ? { source: null, qualified: false, checkedAt: null,
        attemptedAt: new Date(Date.now()).toISOString(), reason: error.code } : failedAttempt(null, error.code);
      const retained = retainedDisplay(job.contextInput, job.contextEnv, job.householdAccountId, receipt, current);
      if (retained) { data = retained.data; displayCheck = retained.check; servedRetained = true; error = null; }
    }
    if (!error && waiter.forceRefresh && job.check?.qualified !== true && !displayCheck) error = unavailable('live-refresh-unavailable');
    if (error) waiter.reject(error);
    // Each request keeps the same independent ownership as a dedicated worker.
    else {
      const checkedAt = job.check?.checkedAt;
      try { waiter.onCheck?.(displayCheck ? { ...displayCheck, retained: true } : {
        source: job.evidence ? 'memory' : 'provider', qualified: job.check?.qualified === true,
        checkedAt: typeof checkedAt === 'string' && Number.isFinite(Date.parse(checkedAt)) ? checkedAt : null }); }
      catch (_) { /* Response closed; never change a financial result. */ }
      // Timing only (scripts/request-timing.js): the path that served this
      // waiter, set where the served data was selected, never from the
      // browser-facing check (a dated view of this job's own read carries
      // a displayCheck too, and is not a retained display).
      try {
        waiter.onServedPath?.(servedRetained ? 'retained' : job.reused ? 'replay'
          : !waiter.started ? 'joined-job' : job.evidence ? 'replay' : 'provider-job');
      } catch (_) { /* Diagnostics only. */ }
      // Admission waiters receive their own acquisition clone plus their
      // own witness, minted now — inside the publication continuation,
      // after every barrier above has validated this exact job. The
      // witness pairs the job's validated state with the reader that
      // waiter itself supplied. The acquisition itself is unchanged and
      // carries no witness.
      if (job.admission) waiter.resolve({ acquisition: structuredClone(data), witness: mintWitness(job, waiter.contextReader, waiter.entryCapture) });
      else waiter.resolve(structuredClone(data));
    }
  }
  function finishJob(job, error, data) {
    if (job.settled) return;
    job.settled = true;
    job.finished = performance.now();
    job.outcome = error ? error.code : 'completed';
    clearTimeout(job.timer);
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    for (const waiter of [...job.waiters]) settleWaiter(job, waiter, error, data);
    if (!job.worker) return emitTiming(job);
    const terminate = () => job.worker.terminate().catch(() => {});
    try { job.worker.postMessage({ abort: true }); } catch (_) { /* Already exited. */ }
    // Give cooperative transports their existing grace, then stop synchronous work.
    if (error) setTimeout(terminate, 50).unref();
    else terminate();
  }
  function invalidate() {
    generation++;
    observationEpoch++;
    observations.clearCurrent();
    replayReuse.clear();
    // Once a write may occur, no waiting reader can publish the obsolete job.
    // Slots still belong to those workers until their actual exit.
    for (const job of [...jobs.values()]) finishJob(job, unavailable('live-refresh-invalidated'));
  }
  async function withProviderWrite(invoke) {
    activeWrites++;
    invalidate();
    try { return await invoke(); }
    finally {
      activeWrites--;
      // Includes rejected, uncertain, audit-failed and thrown write attempts.
      invalidate();
    }
  }
  function startJob(job, canonical, env) {
    if (job.settled) return;
    job.timer = setTimeout(() => {
      // A job-level timeout is a failed live attempt: the hold must be
      // recorded before the job settles, like every other path.
      if (!job.evidence) replayHeld = true;
      finishJob(job, unavailable('live-refresh-timeout'));
    }, LIVE_REFRESH_TIMEOUT_MS);
    if (job.reused) {
      // No worker: the remembered result meets the same barriers a fresh
      // worker result would, after every joining waiter has registered.
      const result = job.reused;
      queueMicrotask(() => {
        if (job.settled) return;
        // Re-check the disk witness at publication, after every joining
        // waiter registered (#1162 second Atlas finding): a waiter that joined
        // after a dependency changed must never receive the remembered
        // result. Any doubt drops the slot and this job computes in a worker.
        let current = false;
        try { current = readsCurrent(result.reads); } catch (_) { current = false; }
        if (current) return publishResult(job, canonical, env, result);
        replayReuse.clear();
        job.reused = null;
        clearTimeout(job.timer);
        // A reuse took no worker slot; a fallback compute respects the cap.
        if (active.size >= MAX_ACTIVE_LIVE_REFRESHES) return finishJob(job, unavailable('live-refresh-busy'));
        startJob(job, canonical, env);
      });
      return;
    }
    try {
      const worker = job.worker = new Worker(__filename, { workerData: { canonical, evidence: job.evidence, acquire: job.acquire === true }, env });
      active.add(worker);
      worker.once('online', () => { if (!job.settled) job.online = performance.now(); });
      worker.on('message', result => {
        if (job.settled) return;
        if (result?.type === 'household-identity') {
          if (typeof result.accountId === 'string' && /^\d+$/.test(result.accountId)) job.householdAccountId = result.accountId;
          return;
        }
        if (result?.type === StageTiming.MESSAGE) {
          const stages = StageTiming.accept(result.stages);
          if (stages) job.stages = stages;
          return;
        }
        publishResult(job, canonical, env, result);
      });
      worker.on('error', () => {
        if (!job.settled && !job.evidence) replayHeld = true;
        finishJob(job, unavailable('live-refresh-unavailable'));
      });
      worker.on('exit', () => {
        active.delete(worker);
        if (!job.settled) {
          if (!job.evidence) replayHeld = true;
          finishJob(job, unavailable('live-refresh-unavailable'));
        }
        emitTiming(job);
      });
    } catch (_) {
      // A constructor failure is a failed live attempt too: record the hold
      // before settling the job.
      if (!job.evidence) replayHeld = true;
      finishJob(job, unavailable('live-refresh-unavailable'));
    }
  }
  // Every worker result, and every reused replay result, passes through the
  // same publication barriers. Reuse skips only the worker's compute.
  function publishResult(job, canonical, env, result) {
        const publicationStarted = performance.now();
        try {
        if (job.generation !== generation || activeWrites) return finishJob(job, unavailable('live-refresh-invalidated'));
        const superseded = !job.acquire && !job.evidence && job.observationEpoch !== observationEpoch;
        if (job.evidence && job.observationEpoch !== observationEpoch) return finishJob(job, unavailable('live-refresh-invalidated'));
        // A rollover/config change during work cannot publish an old-context verdict.
        const metadata = { readable: true }, matches = job.context === jobKey(canonical, env, metadata);
        if (job.day !== financialDay() || job.cacheable && (!metadata.readable || !matches)) {
          return finishJob(job, unavailable('live-refresh-invalidated'));
        }
        job.check = result?.check;
        const completeDisplay = result?.check?.qualified === true
          && ObservationMemory.completeTransactionCohort(result?.data);
        // Distinct valid callers retain their incumbent independent response.
        // An older completion cannot mutate the newer singleton's source,
        // household attestation, complete display cohort or last attempt.
        if (superseded) {
          if (!result?.data) return finishJob(job, unavailable('live-refresh-unavailable'));
          if (!completeDisplay) {
            const dated = evidenceDayDisplay(canonical, env, result, result.check?.householdAccountId || job.householdAccountId);
            if (dated) { job.displayCheck = dated.check; return finishJob(job, null, dated.data); }
            const retained = retainedDisplay(canonical, env, result.check?.householdAccountId || job.householdAccountId,
              failedAttempt(result.check, result.data.liveOverlay?.reason), false);
            if (retained) { job.displayCheck = retained.check; job.servedRetained = true; return finishJob(job, null, retained.data); }
            return finishJob(job, null, require('./live-plan').withoutCompleteRefresh(result.data));
          }
          return finishJob(job, null, result.data);
        }
        if (result.check?.householdAccountId) observations.observeBudget(result.check.householdAccountId);
        // Only a qualified publish releases a replay hold; a failed
        // completion, forced or not, can never cleanse it.
        if (!job.evidence && result?.data) {
          let published = false;
          if (job.cacheable && metadata.readable && matches && result.check?.qualified === true && result.check.evidence
            && Forecast.financialDate(result.check.checkedAt) === financialDay()) {
            try {
              const accountId = result.check.householdAccountId;
              observations.publish(job.context, result.check.evidence, completeDisplay && accountId && result.check.credentialSource === 'env' ? {
                context: displayKey(canonical, env), householdAccountId: accountId, lastBudgetAccountId: accountId, credentialSource: 'env',
                checkedAt: result.check.checkedAt, data: result.data,
                ...(typeof result.check.cashEvidenceAt === 'string' ? { cashEvidenceAt: result.check.cashEvidenceAt } : {}),
              } : undefined);
              published = true;
            } catch (_) { /* Live path only. */ }
          }
          if (published) {
            // Qualified source evidence supersedes source replay independently
            // of the stricter complete-transaction display-cohort admission.
            observationEpoch++;
            replayHeld = false;
            // Fire-and-forget period-history capture of this same qualified
            // evidence; nothing served waits on it or depends on its result.
            periodCapture.offer({ canonical, evidence: result.check.evidence, env, day: job.day });
          } else if (typeof result.check?.checkedAt === 'string') {
            // A dated provider answer that does not qualify is the current
            // truth: it supersedes any retained qualified observation.
            observationEpoch++;
            observations.clearCurrent();
            replayHeld = true;
          } else {
            // A failed check (no dated answer) never destroys retained
            // qualified evidence, but any failed live attempt, forced or
            // automatic (OD-4), holds replay until a later qualified publish,
            // so the next eligible load asks the provider and the failure is
            // never hidden behind the earlier success.
            replayHeld = true;
          }
        } else if (!job.evidence) {
          // A live job that produced no result at all follows the same
          // retention/hold rule as a failed check.
          replayHeld = true;
        }
        if (job.evidence && result?.check?.qualified !== true) {
          observationEpoch++;
          observations.clearCurrent();
          return finishJob(job, unavailable('live-refresh-unavailable'));
        }
        if (job.acquire) {
          // The private waiter receives the acquisition and nothing
          // else; serve waiters on other jobs never see this result.
          return result?.acquisition
            ? finishJob(job, null, result.acquisition)
            : finishJob(job, unavailable('live-refresh-unavailable'));
        }
        if (result?.data && !completeDisplay && !job.evidence) {
          const dated = evidenceDayDisplay(canonical, env, result, result.check?.householdAccountId || job.householdAccountId);
          if (dated) {
            // A superseding view drops the older retained cohort, so a later
            // read cannot fall back to figures the page already superseded.
            if (dated.supersedes) observations.clear();
            job.displayCheck = dated.check;
            return finishJob(job, null, dated.data);
          }
        }
        if (result?.data && !completeDisplay) {
          const attempt = failedAttempt(result.check, result.data.liveOverlay?.reason
            || (result.data.liveOverlay?.currentPeriodActuals?.transactionCoverage === 'truncated' ? 'posted-window-truncated' : 'current-observation-unavailable'));
          if (job.evidence) attempt.source = null; // A replay is not a new provider check.
          const retained = retainedDisplay(canonical, env, result.check?.householdAccountId || job.householdAccountId, attempt);
          if (retained) { job.displayCheck = retained.check; job.servedRetained = true; return finishJob(job, null, retained.data); }
          return finishJob(job, null, require('./live-plan').withoutCompleteRefresh(result.data));
        }
        // Remember a qualified replay result only after every barrier above
        // held, under the exact key its inputs were read with (item c).
        if (job.reuseKey && !job.reused && result?.data && result.check?.qualified === true) {
          replayReuse.remember(job.reuseKey, result);
        }
        // Dale, 2026-11-18: a complete refresh whose plan is withheld as a
        // whole (e.g. income reconciliation) shows the last non-withheld
        // picture under the banner; with none held, the withheld page (and
        // its shell) as before. A replay of that withheld observation (an
        // ordinary page load) takes the same fallback, but is not a new
        // provider check.
        if (result?.data && completeDisplay && ObservationMemory.planWithheld(result.data)) {
          const attempt = failedAttempt(result.check, 'current-plan-withheld');
          if (job.evidence) attempt.source = null;
          const clear = retainedDisplay(canonical, env, result.check?.householdAccountId || job.householdAccountId, attempt, false);
          if (clear && !ObservationMemory.planWithheld(clear.data)) {
            job.displayCheck = clear.check;
            job.servedRetained = true;
            return finishJob(job, null, clear.data);
          }
        }
        return result?.data ? finishJob(job, null, result.data) : finishJob(job, unavailable('live-refresh-unavailable'));
        } finally { job.publicationMs = Math.max(0, performance.now() - publicationStarted); }
  }
  function serve(canonical, env, options = {}) {
    const Live = require('./live-plan');
    // Timing only (scripts/request-timing.js): how this response is served.
    const servedPath = path => { try { options.onServedPath?.(path); } catch (_) { /* Diagnostics only. */ } };
    if (Live.overlayModeFromEnv(env) !== 'live') {
      if (options.forceRefresh) return Promise.reject(unavailable('live-refresh-unavailable'));
      servedPath('canonical');
      return Live.applyForServer(canonical, env);
    }
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(unavailable('live-refresh-cancelled'));
    const unavailableDisplay = code => {
      const retained = retainedDisplay(canonical, env, null, { source: null, qualified: false,
        checkedAt: null, attemptedAt: new Date(Date.now()).toISOString(), reason: code });
      if (!retained) return Promise.reject(unavailable(code));
      try { options.onCheck?.({ ...retained.check, retained: true }); } catch (_) { /* Closed response. */ }
      servedPath('retained');
      return Promise.resolve(retained.data);
    };
    if (options.preferObservation === true && !options.forceRefresh) {
      const retained = retainedDisplay(canonical, env);
      if (retained && (activeWrites || recentFailedProviderCheck(retained.data.liveOverlay.retainedRefresh.attempt))) {
        if (retained.check.source === 'provider') options.onCheck?.({ ...retained.check, retained: true });
        servedPath('retained');
        return Promise.resolve(retained.data);
      }
    }
    if (activeWrites) return unavailableDisplay('live-refresh-invalidated');
    // Shorter budgets support bounded callers/tests; no caller can raise the cap.
    const requested = options.timeoutMs;
    const budget = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, LIVE_REFRESH_TIMEOUT_MS) : LIVE_REFRESH_TIMEOUT_MS;
    let key, context, evidence = null, input, workerEnv;
    const metadata = { readable: true };
    try {
      input = structuredClone(canonical);
      workerEnv = Object.fromEntries(Object.entries(env || process.env).map(([name, value]) => [name, String(value)]));
      context = jobKey(input, workerEnv, metadata);
      key = context + ':live';
      if (metadata.readable && !replayHeld && !jobs.has(key) && options.preferObservation === true && !options.forceRefresh) {
        evidence = observations.read(context);
        if (evidence) key = context + ':replay';
      }
    } catch (_) { return unavailableDisplay('live-refresh-unavailable'); }
    let job = jobs.get(key);
    const fresh = !job;
    let reuseKey = null, reused = null;
    if (fresh && evidence) {
      try { reuseKey = replayReuseKey(context, evidence); reused = replayReuse.take(reuseKey); }
      catch (_) { reuseKey = null; reused = null; }
    }
    // Equivalent callers can join even when the distinct-worker cap is full.
    if (fresh && !reused && active.size >= MAX_ACTIVE_LIVE_REFRESHES) return unavailableDisplay('live-refresh-busy');
    if (fresh) {
      // Starting a live job invalidates in-flight replays of the retained
      // observation (their verdicts predate this attempt), but it never
      // destroys the observation itself: the slot is replaced only by a
      // new qualified publish, a dated unqualified answer, or a hard
      // invalidator.
      if (!evidence) observationEpoch++;
      job = { key, context, evidence, contextInput: input, contextEnv: workerEnv, reuseKey, reused,
        cacheable: metadata.readable, day: financialDay(), generation, observationEpoch,
        started: performance.now(), waiters: new Set(), waiterCount: 0,
        peakWaiters: 0, cancelledWaiters: 0, timedOutWaiters: 0, settled: false, hadForcedWaiter: false };
      jobs.set(key, job);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onCheck: options.onCheck, forceRefresh: options.forceRefresh === true,
        onServedPath: options.onServedPath, started: fresh };
      const leave = code => {
        if (!job.waiters.has(waiter)) return;
        if (code === 'live-refresh-cancelled') job.cancelledWaiters++;
        else job.timedOutWaiters++;
        const error = unavailable(code);
        settleWaiter(job, waiter, error);
        // A forced waiter who leaves unserved (timeout/cancel) means the
        // forced refresh has failed for the publication barrier, whatever
        // the job does next: hold replay now, and mark the job so its
        // completion bookkeeping cannot cleanse the hold. A later
        // qualified publish still releases it.
        if (!job.evidence && waiter.forceRefresh) { job.hadForcedWaiter = true; replayHeld = true; }
        if (!job.waiters.size) finishJob(job, error);
      };
      waiter.cancelled = () => leave('live-refresh-cancelled');
      waiter.timer = setTimeout(() => leave('live-refresh-timeout'), budget);
      job.waiters.add(waiter);
      job.waiterCount++;
      job.peakWaiters = Math.max(job.peakWaiters, job.waiters.size);
      signal?.addEventListener('abort', waiter.cancelled, { once: true });
      if (signal?.aborted) waiter.cancelled();
      if (fresh) startJob(job, input, workerEnv);
    });
  }
  // Unserved private settlement acquisition. Memory-replay only: the
  // retained source observation for this exact context is re-evaluated
  // by a distinct private job through the same worker lifecycle, caps,
  // ownership, deadlines and publication barriers as serve(). Held,
  // unreadable, superseded or missing memory is unavailable — an
  // acquisition never starts a provider (live) job, never joins one,
  // and is never returned to a serve caller. Each call reacquires; no
  // acquisition is retained after its waiters settle.
  function acquireSettlement(canonical, env, options = {}) {
    const Live = require('./live-plan');
    if (Live.overlayModeFromEnv(env) !== 'live') return Promise.reject(unavailable('live-refresh-unavailable'));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(unavailable('live-refresh-cancelled'));
    if (activeWrites) return Promise.reject(unavailable('live-refresh-invalidated'));
    // Shorter budgets support bounded callers/tests; no caller can raise the cap.
    const requested = options.timeoutMs;
    const budget = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, LIVE_REFRESH_TIMEOUT_MS) : LIVE_REFRESH_TIMEOUT_MS;
    let context, evidence = null, input, workerEnv;
    const metadata = { readable: true };
    try {
      input = structuredClone(canonical);
      workerEnv = Object.fromEntries(Object.entries(env || process.env).map(([name, value]) => [name, String(value)]));
      context = jobKey(input, workerEnv, metadata);
      if (!metadata.readable || replayHeld || jobs.has(context + ':live')) {
        return Promise.reject(unavailable('live-refresh-unavailable'));
      }
      evidence = observations.read(context);
      if (!evidence) return Promise.reject(unavailable('live-refresh-unavailable'));
    } catch (_) { return Promise.reject(unavailable('live-refresh-unavailable')); }
    const key = context + ':acquire';
    let job = jobs.get(key);
    const fresh = !job;
    // Equivalent callers can join even when the distinct-worker cap is full.
    if (fresh && active.size >= MAX_ACTIVE_LIVE_REFRESHES) return Promise.reject(unavailable('live-refresh-busy'));
    if (fresh) {
      job = { key, context, evidence, acquire: true, cacheable: metadata.readable, day: financialDay(), generation, observationEpoch,
        started: performance.now(), waiters: new Set(), waiterCount: 0,
        peakWaiters: 0, cancelledWaiters: 0, timedOutWaiters: 0, settled: false, hadForcedWaiter: false };
      jobs.set(key, job);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      const leave = code => {
        if (!job.waiters.has(waiter)) return;
        if (code === 'live-refresh-cancelled') job.cancelledWaiters++;
        else job.timedOutWaiters++;
        const error = unavailable(code);
        settleWaiter(job, waiter, error);
        if (!job.waiters.size) finishJob(job, error);
      };
      waiter.cancelled = () => leave('live-refresh-cancelled');
      waiter.timer = setTimeout(() => leave('live-refresh-timeout'), budget);
      job.waiters.add(waiter);
      job.waiterCount++;
      job.peakWaiters = Math.max(job.peakWaiters, job.waiters.size);
      signal?.addEventListener('abort', waiter.cancelled, { once: true });
      if (signal?.aborted) waiter.cancelled();
      if (fresh) startJob(job, input, workerEnv);
    });
  }
  // Unserved private write-admission acquisition: the identical
  // memory-replay lifecycle as acquireSettlement (same singleton state,
  // jobs discipline, caps, deadlines and publication barriers — never a
  // second lifecycle or cache), except each waiter additionally receives
  // its own synchronous freshness witness minted inside the publication
  // continuation and paired with exactly its acquisition clone:
  // acquireSettlementWithWitness(...) -> { acquisition, witness }.
  // options.contextReader is a REQUIRED trusted synchronous reader
  // returning the current canonical/environment inputs and a monotonic
  // contextRevision; it is supplied only by a trusted composition (in
  // tests, a labelled synthetic fixture) — no production authority reader
  // is wired anywhere. Without a valid reader the acquisition still
  // resolves, but its witness can never admit (B1). The witness is a
  // private capability for the settlement store's admission fence: it is
  // never served, logged, serialized or attached to the acquisition
  // itself.
  function acquireSettlementWithWitness(canonical, env, options = {}) {
    const Live = require('./live-plan');
    if (Live.overlayModeFromEnv(env) !== 'live') return Promise.reject(unavailable('live-refresh-unavailable'));
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(unavailable('live-refresh-cancelled'));
    if (activeWrites) return Promise.reject(unavailable('live-refresh-invalidated'));
    // Shorter budgets support bounded callers/tests; no caller can raise the cap.
    const requested = options.timeoutMs;
    const budget = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, LIVE_REFRESH_TIMEOUT_MS) : LIVE_REFRESH_TIMEOUT_MS;
    let context, evidence = null, input, workerEnv;
    const metadata = { readable: true };
    try {
      input = structuredClone(canonical);
      workerEnv = Object.fromEntries(Object.entries(env || process.env).map(([name, value]) => [name, String(value)]));
      context = jobKey(input, workerEnv, metadata);
      if (!metadata.readable || replayHeld || jobs.has(context + ':live')) {
        return Promise.reject(unavailable('live-refresh-unavailable'));
      }
      evidence = observations.read(context);
      if (!evidence) return Promise.reject(unavailable('live-refresh-unavailable'));
    } catch (_) { return Promise.reject(unavailable('live-refresh-unavailable')); }
    // B2: capture this caller's current context/revision NOW, in the
    // synchronous entry, before the asynchronous worker runs; the
    // publication continuation rechecks it per waiter (see mintWitness).
    const entryCapture = captureEntryContext(options.contextReader, context);
    const key = context + ':acquire-witness';
    let job = jobs.get(key);
    const fresh = !job;
    // Equivalent callers can join even when the distinct-worker cap is full.
    if (fresh && active.size >= MAX_ACTIVE_LIVE_REFRESHES) return Promise.reject(unavailable('live-refresh-busy'));
    if (fresh) {
      job = { key, context, evidence, acquire: true, admission: true, cacheable: metadata.readable,
        day: financialDay(), generation, observationEpoch,
        contextInput: input, contextEnv: workerEnv,
        // The issuing stamp (B2 joined case): the creating waiter's
        // reader domain and entry capture. Joining waiters are bound to
        // it at minting; see mintWitness.
        issuingReader: options.contextReader, issuingCapture: entryCapture,
        started: performance.now(), waiters: new Set(), waiterCount: 0,
        peakWaiters: 0, cancelledWaiters: 0, timedOutWaiters: 0, settled: false, hadForcedWaiter: false };
      jobs.set(key, job);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, contextReader: options.contextReader, entryCapture };
      const leave = code => {
        if (!job.waiters.has(waiter)) return;
        if (code === 'live-refresh-cancelled') job.cancelledWaiters++;
        else job.timedOutWaiters++;
        const error = unavailable(code);
        settleWaiter(job, waiter, error);
        if (!job.waiters.size) finishJob(job, error);
      };
      waiter.cancelled = () => leave('live-refresh-cancelled');
      waiter.timer = setTimeout(() => leave('live-refresh-timeout'), budget);
      job.waiters.add(waiter);
      job.waiterCount++;
      job.peakWaiters = Math.max(job.peakWaiters, job.waiters.size);
      signal?.addEventListener('abort', waiter.cancelled, { once: true });
      if (signal?.aborted) waiter.cancelled();
      if (fresh) startJob(job, input, workerEnv);
    });
  }
  module.exports = { serve, acquireSettlement, acquireSettlementWithWitness, withProviderWrite, LIVE_REFRESH_TIMEOUT_MS, MAX_ACTIVE_LIVE_REFRESHES,
    FAILED_CHECK_RETRY_GAP_MS };
}
