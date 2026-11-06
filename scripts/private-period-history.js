'use strict';
// Private evidence/publication retention. Forecast remains the only planner.
// No server import, provider transport, default destination, or automatic writer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Forecast = require('../public/forecast');
const Live = require('./live-plan');
const Observer = require('./provider-observe');
const Operating = require('./operating-answer');

// New captures write v2. Legacy v1 records stay readable byte-for-byte; they
// carry no completeness metadata, so their completeness reads as 'unknown'.
const SCHEMA = 'atlas-private-period-history/v2';
const LEGACY_SCHEMA = 'atlas-private-period-history/v1';
const SCHEMAS = [LEGACY_SCHEMA, SCHEMA];
const H1_KEYS = ['sourceCompleteness', 'closingState', 'cutoff'];
const CLOSING_STATES = ['provisional', 'complete-at-capture'];
const PENDING_BASIS = 'is_pending-unbounded';
// Deterministic reason order. Codes are prefixed by layer: transport
// (provider window/pending declarations), evidence (observer receipts and
// actuals packet) and publication (what Forecast itself marked unavailable).
// Transport completeness is not publication suitability; the combined status
// is 'complete' only when every layer is free of reasons.
const REASONS = Object.freeze([
  'transport:posted-window-absent',
  'transport:posted-window-contradictory',
  'transport:posted-window-misses-start',
  'transport:posted-window-misses-end',
  'transport:posted-window-not-complete',
  'transport:posted-window-has-more',
  'transport:posted-window-has-more-unknown',
  'transport:posted-window-truncated',
  'transport:pending-coverage-bounded-window',
  'transport:pending-coverage-unproven',
  'transport:source-fetched-before-cutoff',
  'evidence:observation-receipt-unavailable',
  'evidence:mapped-account-missing',
  'evidence:required-cash-unobserved',
  'evidence:balance-unproven',
  'evidence:unmapped-transaction-account',
  'evidence:reconciliation-receipt-unavailable',
  'evidence:reconciliation-unresolved',
  'evidence:current-period-actuals-unavailable',
  'evidence:card-coverage-unconfirmed',
  'evidence:currency-unconfirmed',
  'evidence:non-cad-transaction',
  'publication:operating-plan-unavailable',
  'publication:card-coverage-unavailable',
  'publication:budget-progress-unavailable',
  'publication:currency-unavailable',
  'publication:actuals-coverage-not-precise',
  'publication:income-actual-unavailable',
  'publication:income-actual-partial',
  'publication:bills-actual-unavailable',
  'publication:bills-actual-partial',
  'publication:household-actual-unavailable',
  'publication:household-actual-partial',
  'publication:household-category-actual-unavailable',
]);
const ROOT = path.resolve(__dirname, '..');
const KINDS = ['original', 'first-observed', 'reconstructed', 'plan-amendment', 'closing', 'actual-correction'];
const BASELINES = KINDS.slice(0, 3);
const SECRET_KEY = /password|secret|credential|authorization|cookie|session|token|api[_-]?key|^env$/i;
const PAYLOAD_KEYS = ['provider', 'fetchedAt', 'accounts', 'plaid_accounts', 'manual_accounts', 'assets',
  'transactions', 'categories', 'tags', 'transactionWindow', 'transaction_window', 'pendingCoverage', 'pending_coverage'];
const ENTRY = /^\d{8}-[a-f0-9]{64}\.json$/;
const STAGE = /^\.stage-[a-f0-9]{32}$/;

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function safeJson(value) {
  try {
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        if (SECRET_KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('history-private-input-invalid');
        visit(child);
      }
    };
    visit(value);
    return JSON.parse(JSON.stringify(value));
  } catch (_) { fail('history-private-input-invalid'); }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
      || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('history-date-invalid');
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)
      || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('history-time-invalid');
  date(value.slice(0, 10));
  return new Date(value).toISOString();
}
function engineFiles() {
  // Include loaded transitive financial dependencies, rather than just wrappers.
  const visited = new Set();
  function visit(module) {
    if (!module || visited.has(module.filename)) return;
    visited.add(module.filename); module.children.forEach(visit);
  }
  ['../public/forecast', './live-plan', './provider-observe', './operating-answer']
    .forEach(name => visit(require.cache[require.resolve(name)]));
  const files = [...visited].filter(file => file.endsWith('.js')
    && [path.join(ROOT, 'public'), path.join(ROOT, 'scripts')].some(dir => within(dir, file))
    && !path.basename(file).startsWith('private-period-history'))
    .map(file => path.relative(ROOT, file).split(path.sep).join('/')).sort();
  return fingerprintFiles(files);
}
function fingerprintFiles(files) {
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string'
      || !/^(?:public|scripts)\/[a-zA-Z0-9_./-]+\.js$/.test(file)
      || !within(ROOT, path.resolve(ROOT, file)) || file.split('/').includes('..'))) fail('history-engine-version-unavailable');
  return files.map(file => ({ path: file,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex') }));
}
function engineCommit() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', ...engineFiles().map(file => file.path)], { cwd: ROOT, stdio: 'ignore' });
    if (!/^[a-f0-9]{40}$/.test(commit)) fail('history-engine-version-unavailable');
    return commit;
  } catch (_) { fail('history-engine-version-unavailable'); }
}
function selectedPublication(advice, period) {
  const row = (advice.payPeriodViews || []).find(p => p.start === period.start && p.end === period.end);
  if (!row) fail('history-forecast-period-unavailable');
  return safeJson(row);
}

function cutoffFor(period) {
  // The period includes every household day through `end` in `tz`. The closing
  // gate opens at the next household midnight; fetch/capture clocks never
  // become the cutoff.
  return { rule: 'household-day', end: period.end, tz: Forecast.HOUSEHOLD_TIMEZONE };
}
function closingStateFor(period, fetchedAt, capturedAt, sourceCompleteness) {
  // complete-at-capture requires declared source scope complete with no
  // reasons, plus both next-household-day conditions. Every evidence,
  // coverage or publication gap stays provisional even after the date passes.
  // The existing closing-kind date gate is unchanged and separate.
  const scopeComplete = sourceCompleteness
    && sourceCompleteness.status === 'complete'
    && Array.isArray(sourceCompleteness.reasons)
    && sourceCompleteness.reasons.length === 0;
  const afterCutoff = Forecast.financialDate(fetchedAt) > period.end
    && Forecast.financialDate(capturedAt) > period.end;
  return scopeComplete && afterCutoff ? 'complete-at-capture' : 'provisional';
}
function isDate(value) {
  try { date(value); return true; } catch (_) { return false; }
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
// Declared evidence coverage at capture, never final household truth. Reads
// only already-published observer/Forecast fields; computes no figure.
function sourceCompletenessFor({ period, fetchedAt, transactionWindow, pendingCoverage, report, publication }) {
  const reasons = new Set();
  const add = code => { if (!REASONS.includes(code)) fail('history-reason-invalid'); reasons.add(code); };
  const w = transactionWindow || {};
  const bounded = w.startDate != null && w.endDate != null;
  if (!bounded) add('transport:posted-window-absent');
  const fetchedDay = Forecast.financialDate(fetchedAt);
  if (bounded && (!isDate(w.startDate) || !isDate(w.endDate) || w.startDate > w.endDate || w.endDate > fetchedDay)) {
    add('transport:posted-window-contradictory');
  }
  if (w.complete === true && (w.hasMore === true || w.truncated === true)) add('transport:posted-window-contradictory');
  if (bounded && isDate(w.startDate) && w.startDate > period.start) add('transport:posted-window-misses-start');
  if (bounded && isDate(w.endDate) && w.endDate < period.end) add('transport:posted-window-misses-end');
  if (w.complete !== true) add('transport:posted-window-not-complete');
  if (w.hasMore === true) add('transport:posted-window-has-more');
  else if (w.hasMore !== false) add('transport:posted-window-has-more-unknown');
  if (w.truncated === true) add('transport:posted-window-truncated');
  const p = pendingCoverage || {};
  if (!(p.complete === true && p.status === 'complete' && p.basis === PENDING_BASIS)) {
    add(p.status === 'bounded-window' ? 'transport:pending-coverage-bounded-window' : 'transport:pending-coverage-unproven');
  }
  if (fetchedDay <= period.end) add('transport:source-fetched-before-cutoff');

  const observation = report && report.observationReceipt;
  if (!observation || typeof observation !== 'object') add('evidence:observation-receipt-unavailable');
  else {
    const failed = Array.isArray(observation.failClosedReasons) ? observation.failClosedReasons : [];
    const missing = observation.accountCoverage?.missingExpectedIdentities;
    if (failed.includes('expected-mapped-identity-missing') || (Array.isArray(missing) && missing.length)) add('evidence:mapped-account-missing');
    if (failed.includes('required-cash-unobserved')) add('evidence:required-cash-unobserved');
    const undated = observation.balanceCoverage?.requiredCashMissingDatedBalance;
    if (failed.includes('required-cash-balance-unproven') || (Array.isArray(undated) && undated.length)) add('evidence:balance-unproven');
  }
  const packet = report && report.currentPeriodActuals;
  if (!packet || typeof packet !== 'object') add('evidence:current-period-actuals-unavailable');
  else if (Array.isArray(packet.transactions) && packet.transactions.some(tx => tx && tx.accountRole === 'unmapped')) {
    add('evidence:unmapped-transaction-account');
  }
  const recon = report && report.obligationReconciliationReceipt;
  if (!recon || typeof recon !== 'object') add('evidence:reconciliation-receipt-unavailable');
  else if (recon.trusted !== true || (Array.isArray(recon.failClosedReasons) && recon.failClosedReasons.length)
      || recon.oneOccurrenceOneTransaction !== true || recon.noTransactionConsumedTwice !== true
      || ['unverified', 'ambiguous'].some(key => !finite(recon.counts?.[key]) || recon.counts[key] > 0)) {
    add('evidence:reconciliation-unresolved');
  }
  if (packet && typeof packet === 'object') {
    if (!Array.isArray(packet.cardCoverageUnconfirmed) || packet.cardCoverageUnconfirmed.length) add('evidence:card-coverage-unconfirmed');
    if (!Array.isArray(packet.currencyUnconfirmed) || packet.currencyUnconfirmed.length) add('evidence:currency-unconfirmed');
    // Retained as declared: a non-CAD or currency-less actuals row is a gap
    // in CAD evidence even when the native publication still counts it.
    if (!Array.isArray(packet.transactions) || packet.transactions.some(tx => tx
        && (typeof tx.currency !== 'string' || tx.currency.trim().toLowerCase() !== 'cad'))) add('evidence:non-cad-transaction');
  }

  const pub = publication || {};
  if (pub.operatingPlanUnavailable === true) add('publication:operating-plan-unavailable');
  if (pub.cardCoverageUnavailable === true || pub.cardPurchaseCoverage?.status === 'unavailable') add('publication:card-coverage-unavailable');
  const progress = pub.budgetProgress;
  if (!progress || typeof progress !== 'object') add('publication:budget-progress-unavailable');
  else {
    if (progress.currency !== 'CAD') add('publication:currency-unavailable');
    if (progress.coverage?.remainingClaim !== 'precise') add('publication:actuals-coverage-not-precise');
    for (const section of ['income', 'bills', 'household']) {
      const actual = progress[section]?.actual;
      // A native 0 is a true zero; only a missing/non-finite amount is unavailable.
      if (!actual || !finite(actual.amount)) add('publication:' + section + '-actual-unavailable');
      else if (actual.completeness !== 'complete') add('publication:' + section + '-actual-partial');
    }
  }
  if (!Array.isArray(pub.householdBudget)
      || pub.householdBudget.some(row => row && !row.informational && !finite(row.spent))) {
    add('publication:household-category-actual-unavailable');
  }
  const ordered = REASONS.filter(code => reasons.has(code));
  return { status: ordered.length ? 'incomplete' : 'complete', reasons: ordered };
}
// Absent metadata (legacy v1, or any record without it) is 'unknown', never complete.
function completeness(row) {
  const c = row && row.content;
  if (!c || !H1_KEYS.every(key => Object.hasOwn(c, key))) {
    return { status: 'unknown', reasons: [], closingState: 'unknown', cutoff: null };
  }
  return { status: c.sourceCompleteness.status, reasons: c.sourceCompleteness.reasons.slice(),
    closingState: c.closingState, cutoff: { ...c.cutoff } };
}

function capture(input, { now = () => new Date() } = {}) {
  // Caller supplies already-read evidence; never accept a credential/environment.
  const clean = safeJson(input);
  if (clean && Object.hasOwn(clean, 'capturedAt')) fail('history-capture-clock-owned');
  if (!clean || !clean.data?.plan || !clean.payload || !clean.accountMap || !clean.identity || !Array.isArray(clean.periods)) fail('history-capture-input-invalid');
  const kind = clean.kind || 'first-observed';
  if (!KINDS.includes(kind)) fail('history-kind-invalid');
  // Runtime-owned clock; the CLI cannot backdate a reconstruction into original.
  // The function seam permits a synthetic clock in isolated tests only.
  const capturedAt = instant(now().toISOString());
  const payload = Object.fromEntries(PAYLOAD_KEYS.filter(key => Object.hasOwn(clean.payload, key))
    .map(key => [key, clean.payload[key]]));
  const fetchedAt = instant(payload.fetchedAt);
  if (fetchedAt > capturedAt) fail('history-source-time-invalid');
  const evidenceInput = { data: clean.data, payload, accountMap: clean.accountMap, identity: clean.identity, periods: clean.periods };
  let refreshed, normalized, asOf, forecastOptions, advice;
  try {
    Observer.assertLiveMap(clean.accountMap, { data: clean.data });
    normalized = Observer.normalizeLunchMoneyPayload(payload);
    refreshed = Live.fromObservation(evidenceInput);
    asOf = date(Operating.asOfFrom(refreshed.data, {}));
    forecastOptions = Operating.recommendOpts(refreshed.data, {});
    // Retain the caller's existing monthly source; never borrow today's file on replay.
    forecastOptions.periods = clean.periods;
    advice = Forecast.recommend(refreshed.data.plan, asOf, forecastOptions);
  } catch (_) { fail('history-forecast-capture-failed'); }
  if (asOf > Forecast.financialDate(capturedAt)) fail('history-financial-date-in-future');
  const cycle = Forecast.spendingCycle(refreshed.data.plan, clean.periodStart ? date(clean.periodStart) : asOf);
  if (!cycle || (clean.periodStart && cycle.start !== clean.periodStart)) fail('history-period-invalid');
  const period = { start: date(cycle.start), end: date(cycle.end), timezone: Forecast.HOUSEHOLD_TIMEZONE };
  const publication = selectedPublication(advice, period);
  if (kind === 'original' && (asOf !== period.start
      || Forecast.financialDate(capturedAt) !== period.start
      || Forecast.financialDate(fetchedAt) !== period.start
      || refreshed.data.liveOverlay?.applied !== true || publication.operatingPlanUnavailable === true)) {
    fail('history-original-opening-unproven');
  }
  if (kind === 'reconstructed' && period.end >= Forecast.financialDate(capturedAt)) fail('history-reconstruction-period-invalid');
  if (['closing', 'actual-correction'].includes(kind)
      && (period.end >= Forecast.financialDate(capturedAt) || asOf < period.end)) fail('history-closing-date-invalid');
  const declaredAt = clean.declaredAt == null ? null : instant(clean.declaredAt);
  const effectiveFrom = clean.effectiveFrom == null ? null : date(clean.effectiveFrom);
  if (declaredAt && declaredAt > capturedAt) fail('history-declaration-date-invalid');
  if (kind === 'plan-amendment' && (!declaredAt || !effectiveFrom)) fail('history-amendment-provenance-required');
  if (['plan-amendment', 'actual-correction'].includes(kind)
      && (typeof clean.reason !== 'string' || !clean.reason.trim())) fail('history-revision-reason-required');
  const stablePayload = { ...payload }; delete stablePayload.fetchedAt;
  const sourceCompleteness = sourceCompletenessFor({ period, fetchedAt,
    transactionWindow: normalized.transactionWindow, pendingCoverage: normalized.pendingCoverage,
    report: refreshed.report, publication });
  const content = safeJson({
    period, kind, asOf, declaredAt, effectiveFrom,
    reason: clean.reason || null,
    planBasis: kind === 'original' ? 'first-qualified-opening-day-observation'
      : kind === 'reconstructed' ? 'current-policy-reconstruction'
      : kind === 'first-observed' ? 'first-observed-original-unavailable' : 'see-baseline-revision',
    engine: { commit: engineCommit(), files: engineFiles() },
    provenance: {
      provider: normalized.provider, fetchedAt,
      sourceFingerprint: digest(stablePayload), policyFingerprint: digest(clean.data.plan),
      accountMapFingerprint: digest(clean.accountMap), identityFingerprint: digest(clean.identity),
      transactionWindow: normalized.transactionWindow, pendingCoverage: normalized.pendingCoverage,
      observationReceipt: refreshed.report.observationReceipt || null,
      // The observer publishes this receipt as obligationReconciliationReceipt.
      reconciliationReceipt: refreshed.report.obligationReconciliationReceipt || null,
    },
    sourceCompleteness,
    closingState: closingStateFor(period, fetchedAt, capturedAt, sourceCompleteness),
    cutoff: cutoffFor(period),
    publication,
    evidence: { input: evidenceInput, refreshedData: refreshed.data, forecastOptions },
  });
  const candidate = { schema: SCHEMA, capturedAt, content };
  return { ...candidate, captureId: digest(candidate) };
}

function dayBefore(day) {
  return new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}
function latestClosedPeriod(clean) {
  // Read-only pipeline head, mirroring capture(): derive the observation
  // as-of, take the Forecast cycle containing it, and walk back one cycle.
  // The named period is the most recent one that has fully ended; earlier
  // missed periods are not backfilled by this seam and stay not-captured.
  const payload = Object.fromEntries(PAYLOAD_KEYS.filter(key => Object.hasOwn(clean.payload, key))
    .map(key => [key, clean.payload[key]]));
  let refreshed, asOf;
  try {
    Observer.assertLiveMap(clean.accountMap, { data: clean.data });
    refreshed = Live.fromObservation({ data: clean.data, payload, accountMap: clean.accountMap,
      identity: clean.identity, periods: clean.periods });
    asOf = date(Operating.asOfFrom(refreshed.data, {}));
  } catch (_) { fail('history-forecast-capture-failed'); }
  const current = Forecast.spendingCycle(refreshed.data.plan, asOf);
  if (!current || !current.start) fail('history-closing-period-unavailable');
  const previous = Forecast.spendingCycle(refreshed.data.plan, dayBefore(current.start));
  if (!previous || !previous.start || !previous.end
      || previous.start >= current.start || previous.end >= current.start) {
    fail('history-closing-period-unavailable');
  }
  return { start: date(previous.start), end: date(previous.end) };
}
function captureClosing(input, { now = () => new Date() } = {}) {
  // Rollover seam (issue #818 slice 1): given an already-read private
  // observation, capture the latest closed period as a `closing` record.
  // The seam owns the closing selection — a caller-named kind or period
  // could point the record at a period that has not closed — and capture()
  // still enforces every closing gate. Inert: no server route, scheduler
  // or automatic caller uses this; the operator CLI exposes it explicitly.
  const clean = safeJson(input);
  if (clean && Object.hasOwn(clean, 'capturedAt')) fail('history-capture-clock-owned');
  if (!clean || !clean.data?.plan || !clean.payload || !clean.accountMap || !clean.identity
      || !Array.isArray(clean.periods)) fail('history-capture-input-invalid');
  if (Object.hasOwn(clean, 'kind') || Object.hasOwn(clean, 'periodStart')) fail('history-closing-selection-invalid');
  const period = latestClosedPeriod(clean);
  return capture({ ...clean, kind: 'closing', periodStart: period.start }, { now });
}
function appendClosing({ destination, enabled = false, input, now } = {}) {
  // Idempotent rollover append: a trigger may observe the same rollover
  // repeatedly, so an existing closing record for the period is a clean
  // no-op rather than append()'s singleton conflict. Disabled by default
  // and bound by the same private-destination rules as append().
  if (enabled !== true) fail('history-capture-disabled');
  const candidate = captureClosing(input, { now });
  const existing = read({ destination }).find(row => row.kind === 'closing'
    && row.period.start === candidate.content.period.start
    && row.period.end === candidate.content.period.end);
  if (existing) return { status: 'already-captured', ...existing };
  return append({ destination, enabled: true, candidate });
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function checkedRoot(destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('history-private-destination-required');
  const root = path.resolve(destination);
  let cursor = path.parse(root).root;
  for (const part of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (['public', 'static', 'www', 'wwwroot', 'htdocs'].includes(part.toLowerCase())
        || fs.lstatSync(cursor).isSymbolicLink()) fail('history-destination-forbidden');
  }
  for (let parent = root; ; parent = path.dirname(parent)) {
    const marker = path.join(parent, '.git');
    // Some managed filesystems expose empty protection placeholders named .git;
    // actual repositories have contents, or a worktree gitdir file. Bare repos
    // are forbidden too. Never follow a gitdir symlink.
    if ((fs.existsSync(marker) && (!fs.lstatSync(marker).isDirectory() || fs.readdirSync(marker).length > 0))
        || (fs.existsSync(path.join(parent, 'HEAD')) && fs.existsSync(path.join(parent, 'objects')))) fail('history-destination-forbidden');
    if (parent === path.dirname(parent)) break;
  }
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
  if ([ROOT, ...worktrees].some(repo => within(repo, root) || within(root, repo))) fail('history-destination-forbidden');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) fail('history-private-destination-required');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) fail('history-destination-not-private');
  return { root, dev: stat.dev, ino: stat.ino };
}
function privateRoot(destination) {
  try { return checkedRoot(destination); }
  catch (e) { if (e.code?.startsWith('history-')) throw e; fail('history-io-failed'); }
}
function unchangedRoot(checked) {
  const now = privateRoot(checked.root);
  if (now.dev !== checked.dev || now.ino !== checked.ino) fail('history-destination-changed');
}
function syncDirectory(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('history-entry-not-private');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
}
function contentKey(candidate) {
  // Fetch wall-clock alone is not a financial revision. Full evidence is hashed separately.
  const copy = safeJson(candidate.content);
  delete copy.provenance.fetchedAt;
  delete copy.provenance.observationReceipt;
  delete copy.provenance.reconciliationReceipt;
  // Derived capture-time labels: completeness follows from keyed content and
  // receipts; closingState depends on the capture clock. Excluding them keeps
  // retries idempotent and leaves every legacy v1 contentKey unchanged.
  for (const key of H1_KEYS) delete copy[key];
  delete copy.evidence;
  return digest(copy);
}
function validateCandidate(candidate) {
  if (!SCHEMAS.includes(candidate?.schema) || !KINDS.includes(candidate.content?.kind)) fail('history-schema-invalid');
  instant(candidate.capturedAt);
  const c = candidate.content;
  date(c.period?.start); date(c.period?.end); date(c.asOf);
  if (c.period.timezone !== Forecast.HOUSEHOLD_TIMEZONE || c.period.end < c.period.start
      || c.publication?.start !== c.period.start || c.publication?.end !== c.period.end
      || !c.evidence?.input || !c.evidence?.refreshedData || !c.evidence?.forecastOptions
      || !/^[a-f0-9]{40}$/.test(c.engine?.commit || '')) fail('history-schema-invalid');
  if (candidate.schema === LEGACY_SCHEMA ? H1_KEYS.some(key => Object.hasOwn(c, key)) : !validH1(c)) fail('history-schema-invalid');
  safeJson(candidate);
  if (digest({ schema: candidate.schema, capturedAt: candidate.capturedAt, content: c }) !== candidate.captureId) fail('history-capture-integrity-failed');
}
function validH1(c) {
  const s = c.sourceCompleteness, cut = c.cutoff;
  return !!(s && ['complete', 'incomplete'].includes(s.status) && Array.isArray(s.reasons)
    && s.reasons.every(code => REASONS.includes(code))
    && s.reasons.join('\n') === REASONS.filter(code => s.reasons.includes(code)).join('\n')
    && (s.status === 'complete') === (s.reasons.length === 0)
    && CLOSING_STATES.includes(c.closingState)
    && (c.closingState !== 'complete-at-capture' || s.status === 'complete')
    && cut && Object.keys(cut).sort().join(',') === 'end,rule,tz'
    && cut.rule === 'household-day' && cut.end === c.period.end && cut.tz === Forecast.HOUSEHOLD_TIMEZONE);
}
function load(root) {
  const names = fs.readdirSync(root).filter(name => name !== '.capture.lock' && !STAGE.test(name)).sort();
  if (names.some(name => !ENTRY.test(name))) fail('history-entry-invalid');
  const rows = [];
  for (const name of names) {
    const row = readFile(path.join(root, name));
    validateCandidate(row);
    const { revisionId, ...body } = row;
    const baseline = rows.find(prior => periodKey(prior.content.period) === periodKey(row.content.period) && BASELINES.includes(prior.content.kind));
    if (digest(body) !== revisionId || name !== String(rows.length + 1).padStart(8, '0') + '-' + revisionId + '.json'
        || row.sequence !== rows.length + 1 || row.previousRevision !== (rows.at(-1)?.revisionId || null)
        || row.contentKey !== contentKey(row) || row.baselineRevision !== (baseline?.revisionId || null)) fail('history-integrity-failed');
    rows.push(row);
  }
  return rows;
}
function periodKey(period) { return period.timezone + ':' + period.start + ':' + period.end; }
function metadata(row) {
  return { schema: row.schema, revisionId: row.revisionId || null, sequence: row.sequence || null,
    captureId: row.captureId,
    period: row.content.period, kind: row.content.kind, planBasis: row.content.planBasis,
    capturedAt: row.capturedAt, asOf: row.content.asOf, previousRevision: row.previousRevision || null,
    baselineRevision: row.baselineRevision || null, engineCommit: row.content.engine.commit,
    // Status labels only; reason codes are fixed strings, never source data.
    sourceCompleteness: (({ status, reasons }) => ({ status, reasons }))(completeness(row)),
    closingState: completeness(row).closingState };
}
function append({ destination, enabled = false, candidate }) {
  if (enabled !== true) fail('history-capture-disabled');
  let checked, lock, staged;
  try {
    validateCandidate(candidate);
    checked = privateRoot(destination);
    // Refuse unsupported filesystem durability before creating a revision.
    syncDirectory(checked.root);
    try { lock = fs.openSync(path.join(checked.root, '.capture.lock'), 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') fail('history-capture-busy'); throw e; }
    const rows = load(checked.root), key = contentKey(candidate);
    const samePeriod = rows.filter(row => periodKey(row.content.period) === periodKey(candidate.content.period));
    const identicalCapture = samePeriod.find(row => row.captureId === candidate.captureId);
    if (identicalCapture) return { status: 'duplicate', ...metadata(identicalCapture) };
    const kind = candidate.content.kind;
    // A regenerated capture has a new wall-clock ID. Match any retained
    // semantic revision before allowing old evidence to become the newest head.
    const semanticMatch = samePeriod.find(row => row.content.kind === kind && row.contentKey === key);
    if (semanticMatch) return { status: 'duplicate', ...metadata(semanticMatch) };
    const baseline = samePeriod.find(row => BASELINES.includes(row.content.kind));
    const singleton = BASELINES.includes(kind) ? baseline : kind === 'closing' ? samePeriod.find(row => row.content.kind === 'closing') : null;
    if (singleton) fail('history-original-or-closing-conflict');
    if (kind === 'plan-amendment' && !baseline) fail('history-baseline-required');
    if (kind === 'actual-correction' && !samePeriod.some(row => row.content.kind === 'closing')) fail('history-closing-required');
    if (samePeriod.at(-1)?.capturedAt > candidate.capturedAt) fail('history-capture-order-invalid');
    const body = safeJson({ ...candidate, sequence: rows.length + 1,
      previousRevision: rows.at(-1)?.revisionId || null, baselineRevision: baseline?.revisionId || null, contentKey: key });
    const row = { ...body, revisionId: digest(body) };
    const name = String(row.sequence).padStart(8, '0') + '-' + row.revisionId + '.json';
    staged = path.join(checked.root, '.stage-' + crypto.randomBytes(16).toString('hex'));
    const fd = fs.openSync(staged, 'wx', 0o600);
    try { fs.writeFileSync(fd, canonical(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    unchangedRoot(checked);
    // Atomic publication without replacement. A crash leaves either no revision,
    // or one complete committed revision plus an ignorable staging hard link.
    fs.linkSync(staged, path.join(checked.root, name));
    syncDirectory(checked.root);
    fs.unlinkSync(staged); staged = null;
    syncDirectory(checked.root);
    return { status: 'appended', ...metadata(row) };
  } catch (e) {
    if (e.code?.startsWith('history-')) throw e;
    fail('history-io-failed');
  } finally {
    if (lock !== undefined) {
      try {
        fs.closeSync(lock);
        // Revalidate before cleanup; never follow a replaced destination.
        unchangedRoot(checked);
        fs.unlinkSync(path.join(checked.root, '.capture.lock'));
      } catch (_) { fail('history-cleanup-failed'); }
    }
  }
}
function read({ destination, revisionId, expectedHead }) {
  try {
    const checked = privateRoot(destination), rows = load(checked.root);
    unchangedRoot(checked);
    if (expectedHead !== undefined && (!/^[a-f0-9]{64}$/.test(expectedHead)
        || rows.at(-1)?.revisionId !== expectedHead)) fail('history-head-mismatch');
    if (revisionId === undefined) return rows.map(metadata);
    if (!/^[a-f0-9]{64}$/.test(revisionId)) fail('history-revision-invalid');
    const row = rows.find(item => item.revisionId === revisionId);
    if (!row) fail('history-revision-unavailable');
    return row; // Private in-process consumer; never a public route or log payload.
  } catch (e) { if (e.code?.startsWith('history-')) throw e; fail('history-io-failed'); }
}
function replayPublication(row) {
  validateCandidate(row);
  if (row.revisionId) {
    const { revisionId, ...body } = row;
    if (digest(body) !== revisionId) fail('history-integrity-failed');
  }
  if (digest(row.content.engine.files) !== digest(fingerprintFiles(row.content.engine.files.map(file => file.path)))) fail('history-engine-version-unavailable');
  const c = row.content;
  const actual = selectedPublication(Forecast.recommend(c.evidence.refreshedData.plan, c.asOf, c.evidence.forecastOptions), c.period);
  if (digest(actual) !== digest(c.publication)) fail('history-replay-mismatch');
  return actual;
}
module.exports = { SCHEMA, LEGACY_SCHEMA, REASONS, capture, captureClosing, append, appendClosing,
  read, metadata, completeness, sourceCompletenessFor, closingStateFor, replayPublication };
