'use strict';
/* Earned trusted canonical refresh — B81 / AF-LIVE-02.
 *
 *   node scripts/canonical-refresh.js --fixture <file>
 *   node scripts/canonical-refresh.js --fixture <file> --apply --approve <previewId>
 *   node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD
 *   node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --apply --approve-cutover <cutoverApprovalId>
 *   node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --apply --approve-opening <openingApprovalId>
 *   node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --recover-opening-artifacts
 *   node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --recover-opening-artifacts --apply --approve-recovery <recoveryApprovalId>
 *   node scripts/canonical-refresh.js --fixture <file> --preserve-payday-observation
 *   node scripts/canonical-refresh.js --fixture <file> --preserve-payday-observation --apply --approve-payday-observation <paydayObservationApprovalId>
 *
 * Default is a non-writing preview. --apply --approve updates only the
 * posted cash/debt fields listed in that preview. previewId cannot
 * authorize pending or an opening. Observe and reconcile remain the
 * incumbents. Forecast remains the planner. An approved write result
 * projects the household operating answer from Forecast.recommend on
 * the written document. The preview does not publish that answer.
 *
 * The preview consumes the AF-REFRESH-03 obligation-reconciliation
 * receipt from the incumbent observer. It classifies mechanically
 * provable posted updates, no-op/replayed evidence, owner-fact
 * questions, ambiguous/unresolved evidence that must not write, and
 * unsupported targets. Untrusted reconciliation fail-closes those
 * obligation buckets and cannot invent writes. The earned posted
 * CHANGE allowlist remains the only mechanically provable write set.
 * Posted previewId is the approval identity of that proposed and
 * evidence state. It does not bind the volatile observation fetch
 * timestamp from the AF-REFRESH-02 digest.
 *
 * --cutover-as-of without --apply is preflight. It does not write
 * data.json, meta.asOf, plan.opening, or snapshots. Combining it with
 * --apply --approve <previewId> is refused: posted approval is not a
 * cutover or opening approval. MATCH is not freshness.
 *
 * --cutover-as-of --apply --approve-cutover writes only the exact
 * candidate-date pending transitions in that cutover fingerprint.
 * It does not advance the opening date.
 *
 * --cutover-as-of --apply --approve-opening writes one atomic opening
 * when the preflight is clean, openingApprovalId matches the complete
 * candidate opening and the current balance-map routing, and the
 * same-date Household positions plus dated snapshot are constructible
 * from that approved evidence. Canonical data.json is not permanently
 * mutated unless the full transition is proven constructible. previewId
 * and cutoverApprovalId cannot authorize that write. No approval = no
 * opening write.
 *
 * --cutover-as-of --recover-opening-artifacts is a same-date diagnostic of an
 * already-approved canonical opening whose Household positions and/or dated
 * snapshot are missing. It never infers those artifacts from data.json alone.
 * It requires a complete trustworthy same-date observation packet whose every
 * required posted and pending value MATCHES the surviving opening.
 * --apply --approve-recovery writes only the missing positions rows and
 * snapshot after the approval binds those exact proposed bytes (and the
 * expected artifact pre-state). It never writes data.json, never advances
 * the opening, never POSTs Lunch Money, and cannot be authorized by
 * previewId, cutoverApprovalId, or openingApprovalId.
 *
 * --preserve-payday-observation without --apply is a read-only proposal
 * for canonical chequing-a payday-boundary posted cash. It does not
 * advance the opening, rewrite startingCash, or write snapshots.
 * Forecast.paydayBoundaryAccountObservation remains the evidence
 * authority; this writer stores that fail-closed packet on
 * plan.opening.paydayAccountObservations so a later overlay day can
 * still read it. Temporal claim stays posted-balance-observed-on-
 * household-date. This is not a T4 opening cutover, not payday-morning
 * opening, not a previous-observation store, and not the BILLS walk.
 * --apply --approve-payday-observation writes only that packet when the
 * approval matches. previewId, cutoverApprovalId, openingApprovalId, and
 * recoveryApprovalId cannot authorize it. Combining it with
 * --cutover-as-of is refused. A recorded packet for a different payday
 * is protected and is not overwritten. Evidence whose household payday
 * predates plan.opening.asOf is refused: the incumbent reconciler marks
 * that row canonical-newer (stale-not-current), and the persist proposal
 * and apply paths fail closed on that relation and on the household-date
 * guard. Historical provider evidence cannot mint
 * paydayObservationApprovalId or write.
 *
 * Never writes without --apply and an exact matching approval.
 * Never POST/PUT/PATCH/DELETE Lunch Money. Never stores a token.
 * Unattended production writes are not this command.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./provider-observe.js');
const Forecast = require('../public/forecast.js');
const OA = require('./operating-answer.js');
const S = require('./snapshot-balances.js');
const POS = require('./positions-summary.js');
const Household = require('./opening-household-rows.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_POSITIONS = path.join(ROOT, 'docs', 'positions.csv');
const DEFAULT_SNAPSHOTS = path.join(ROOT, 'snapshots');
const DEFAULT_BALANCE_MAP = path.join(ROOT, 'docs', 'reconciliation', 'balance-map.json');
const DEFAULT_IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SCHEMA = 'atlas-canonical-refresh-preview/v1';
const CUTOVER_PENDING_SCHEMA = 'atlas-cutover-pending-approval/v1';
const OPENING_CUTOVER_SCHEMA = 'atlas-opening-cutover-approval/v1';
const ARTIFACT_RECOVERY_SCHEMA = 'atlas-opening-artifact-recovery-approval/v1';
const PAYDAY_OBSERVATION_SCHEMA = 'atlas-payday-account-observation-approval/v1';
const PAYDAY_BOUNDARY_TEMPORAL_CLAIM = 'posted-balance-observed-on-household-date';
const PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID = 'chequing-a';
const SNAPSHOT_COMMAND = 'node scripts/snapshot-balances.js';
const EPSILON = 0.005;
const PENDING_ZERO_PROOF = 'is_pending-unbounded';

const POSTED_CASH = new Set(['chequing-a', 'chequing-b', 'savings']);
// Owner-named monthly statement cadence, keyed by canonical Atlas id.
// Not a generic freshness default. Not Lunch Money provider IDs.
const OWNER_STATEMENT_CADENCE = Object.freeze({
  triangle: Object.freeze({ kind: 'monthly-statement', day: 17 }),
  mbna: Object.freeze({ kind: 'monthly-statement', day: 8 }),
});
const FRESHNESS_EXACT_DAY = 'exact-day';
const FRESHNESS_STATEMENT_CADENCE = 'owner-approved-monthly-statement-cadence';
const CREDIT_REFUSE_FACTS = new Set([
  'pending', 'limit', 'available-credit', 'confirmed-payment', 'scheduled-payment',
]);
const BACKFILL_FACTS = new Set(['posting']);
const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const UNRESOLVED_REFUSE_REASONS = new Set([
  'unresolved-pending',
  'unknown-value',
  'conflicting-observations',
]);

function fail(message) {
  const err = new Error(message);
  err.code = 'refresh-failed';
  throw err;
}

function parseArgs(argv) {
  const out = {
    provider: 'lunchmoney',
    fixture: null,
    live: false,
    map: null,
    data: DEFAULT_DATA,
    apply: false,
    approve: null,
    approveCutover: null,
    approveOpening: null,
    approveRecovery: null,
    preservePaydayObservation: false,
    approvePaydayObservation: null,
    recoverOpeningArtifacts: false,
    identity: DEFAULT_IDENTITY,
    cutoverAsOf: null,
    positions: null,
    snapshots: null,
    balanceMap: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i];
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--live') out.live = true;
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--approve') out.approve = argv[++i];
    else if (a === '--approve-cutover') out.approveCutover = argv[++i];
    else if (a === '--approve-opening') out.approveOpening = argv[++i];
    else if (a === '--approve-recovery') out.approveRecovery = argv[++i];
    else if (a === '--preserve-payday-observation') out.preservePaydayObservation = true;
    else if (a === '--approve-payday-observation') out.approvePaydayObservation = argv[++i];
    else if (a === '--recover-opening-artifacts') out.recoverOpeningArtifacts = true;
    else if (a === '--identity') out.identity = argv[++i];
    else if (a === '--cutover-as-of') out.cutoverAsOf = argv[++i];
    else if (a === '--positions') out.positions = argv[++i];
    else if (a === '--snapshots') out.snapshots = argv[++i];
    else if (a === '--balance-map') out.balanceMap = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--preview-out') {
      fail('--preview-out is not accepted. Preview writes to stdout only and cannot target canonical state.');
    } else {
      fail(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function near(a, b) {
  return Math.abs(Number(a) - Number(b)) <= EPSILON;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function parseLocator(locator) {
  if (!locator || typeof locator !== 'string') return null;
  const [collection, rest] = locator.split(':');
  if (!collection || !rest) return null;
  const hash = rest.indexOf('#');
  const id = hash === -1 ? rest : rest.slice(0, hash);
  const field = hash === -1 ? null : rest.slice(hash + 1);
  return { collection, id, field };
}

function cashRow(data, id) {
  const cash = (data.plan && data.plan.startingCash) || {};
  const rows = (cash.breakdown || []).concat(cash.heldElsewhere || []);
  return rows.find(row => row && row.id === id) || null;
}

function debtRow(data, id) {
  return ((data.debts || []).find(row => row && row.id === id)) || null;
}

function readCurrent(data, locator) {
  const parsed = parseLocator(locator);
  if (!parsed) return { found: false, value: null };
  if (parsed.collection === 'cash' && !parsed.field) {
    const row = cashRow(data, parsed.id);
    return row
      ? { found: true, value: Number(row.value), field: 'value' }
      : { found: false, value: null };
  }
  if (parsed.collection === 'debts' && !parsed.field) {
    const row = debtRow(data, parsed.id);
    return row
      ? { found: true, value: Number(row.balance), field: 'balance' }
      : { found: false, value: null };
  }
  return { found: false, value: null };
}

function eligiblePosted(row) {
  const parsed = parseLocator(row && row.canonicalTarget);
  if (!parsed || parsed.field) return false;
  if (row.fact && CREDIT_REFUSE_FACTS.has(row.fact)) return false;
  if (row.fact && BACKFILL_FACTS.has(row.fact)) return false;
  if (parsed.collection === 'cash') {
    return POSTED_CASH.has(parsed.id) && (!row.fact || row.fact === 'posted-balance');
  }
  if (parsed.collection === 'debts') {
    return !row.fact || row.fact === 'posted-balance';
  }
  return false;
}

function refuseReason(row) {
  const fact = row && row.fact;
  if (fact && CREDIT_REFUSE_FACTS.has(fact)) {
    if (fact === 'pending') {
      return row.unknown === true || row.evidenceValue == null
        ? 'unresolved-pending'
        : 'unresolved-pending';
    }
    return 'credit-capacity-not-cash';
  }
  if (fact && BACKFILL_FACTS.has(fact)) return 'historical-opening-backfill';
  if (row && row.status === 'CONFLICT') return 'conflicting-observations';
  if (row && row.status === 'MISSING') return 'unknown-value';
  if (row && (row.unknown === true || row.evidenceValue == null || !isFinite(row.evidenceValue))) {
    return 'unknown-value';
  }
  if (row && row.dateRelation === 'same-day') return 'same-day-no-winner';
  if (row && row.dateRelation === 'canonical-newer') return 'stale-not-current';
  if (row && row.dateRelation === 'incomparable') return 'incomparable-freshness';
  if (!eligiblePosted(row)) return 'not-posted-current-state';
  return 'not-proposed';
}

function sanitizedUnmapped(entry) {
  return {
    reason: 'unmapped-provider-account',
    accountLabel: entry && entry.accountLabel ? String(entry.accountLabel) : null,
  };
}

// A proposal's evidence must be dated on or before the observation's own
// request day. Explicit approval decides whether a write happens; it never
// makes a balance dated after the request current.
// Both sides are household financial dates (Forecast.financialDate), the
// same basis the observer and live-plan use, so a late-evening fetch is
// compared on the household day, not the UTC day.
function evidenceAfterRequest(row, report) {
  const requestDay = dateOnly(report && report.fetchedAt);
  const evidenceDate = dateOnly(row && (row.evidenceDate || row.observedAsOf));
  return !!(requestDay && evidenceDate && evidenceDate > requestDay);
}

function proposeFromReport(report) {
  const proposed = [];
  const refused = [];
  const seen = new Set();
  for (const row of (report && report.reconciliation && report.reconciliation.rows) || []) {
    const locator = row.canonicalTarget;
    if (!locator || seen.has(locator + '|' + (row.fact || ''))) continue;
    seen.add(locator + '|' + (row.fact || ''));
    if (row.status === 'MATCH') continue;
    const eligible = eligiblePosted(row)
      && row.status === 'CHANGE'
      && row.dateRelation === 'canonical-older'
      && row.unknown !== true
      && !evidenceAfterRequest(row, report)
      && row.evidenceValue != null
      && isFinite(row.evidenceValue)
      && row.canonicalValue != null
      && isFinite(row.canonicalValue);
    if (!eligible) {
      refused.push({
        locator,
        fact: row.fact || null,
        status: row.status || null,
        dateRelation: row.dateRelation || null,
        currentValue: row.canonicalValue,
        observedValue: row.unknown === true ? null : row.evidenceValue,
        evidenceDate: row.evidenceDate || row.observedAsOf || null,
        reason: row.unknown !== true && evidenceAfterRequest(row, report)
          ? 'future-not-current' : refuseReason(row),
      });
      continue;
    }
    const parsed = parseLocator(locator);
    proposed.push({
      locator,
      collection: parsed.collection,
      id: parsed.id,
      field: parsed.collection === 'cash' ? 'value' : 'balance',
      currentValue: round2(row.canonicalValue),
      proposedValue: round2(row.evidenceValue),
      evidenceDate: row.evidenceDate || row.observedAsOf || null,
      source: 'provider-observe:lunchmoney',
      dateRelation: row.dateRelation,
      reason: 'reconcile CHANGE; evidence newer than canonical as-of',
    });
  }
  for (const entry of (report && report.unmapped) || []) {
    refused.push(sanitizedUnmapped(entry));
  }
  for (const candidate of (report && report.representedEventCandidates) || []) {
    if (candidate && candidate.mustNotBackfillOpening !== false) {
      refused.push({
        locator: 'plan.opening.representedEvents',
        fact: 'posting',
        eventId: candidate.id || null,
        evidenceDate: candidate.date || null,
        reason: 'historical-opening-backfill',
      });
    }
  }
  proposed.sort((a, b) => String(a.locator).localeCompare(String(b.locator)));
  refused.sort((a, b) => String(a.locator || a.reason).localeCompare(String(b.locator || b.reason))
    || String(a.reason).localeCompare(String(b.reason)));
  return { proposed, refused };
}

function approvalObservationIdentity(observation) {
  const fingerprint = observation && observation.fingerprint;
  if (!fingerprint || typeof fingerprint !== 'object') return null;
  return {
    schema: fingerprint.schema || null,
    provider: fingerprint.provider || null,
    householdDate: fingerprint.householdDate || null,
    writesCanonicalState: fingerprint.writesCanonicalState === true,
    canonicalStateChanged: fingerprint.canonicalStateChanged === true,
    mappedHouseholdIdentities: Array.isArray(fingerprint.mappedHouseholdIdentities)
      ? fingerprint.mappedHouseholdIdentities.slice()
      : [],
    unmappedCount: Number(fingerprint.unmappedCount) || 0,
    missingExpectedIdentities: Array.isArray(fingerprint.missingExpectedIdentities)
      ? fingerprint.missingExpectedIdentities.slice()
      : [],
    requiredCashMissing: Array.isArray(fingerprint.requiredCashMissing)
      ? fingerprint.requiredCashMissing.slice()
      : [],
    requiredCashBalanceMissing: Array.isArray(fingerprint.requiredCashBalanceMissing)
      ? fingerprint.requiredCashBalanceMissing.slice()
      : [],
    postedComplete: fingerprint.postedComplete === true,
    pendingComplete: fingerprint.pendingComplete === true,
    pendingToPostedTransitions: Number(fingerprint.pendingToPostedTransitions) || 0,
    readyForReconciliation: fingerprint.readyForReconciliation === true,
  };
}

function previewFingerprint(proposed, refused, classification) {
  const classified = classification || {};
  return {
    proposed: (proposed || []).map(row => ({
      locator: row.locator,
      field: row.field,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      evidenceDate: row.evidenceDate,
      reason: row.reason,
    })),
    refused: (refused || []).map(row => ({
      locator: row.locator || null,
      reason: row.reason,
      evidenceDate: row.evidenceDate || null,
    })),
    reconciliationTrusted: classified.reconciliationTrusted === true,
    approvalObservationIdentity: classified.approvalObservationIdentity || null,
    noops: (classified.noops || []).map(row => ({
      locator: row.locator || null,
      id: row.id || null,
      reason: row.reason,
      evidenceDate: row.evidenceDate || row.date || null,
    })),
    unresolved: (classified.unresolved || []).map(row => ({
      locator: row.locator || null,
      id: row.id || null,
      evidenceFingerprint: row.evidenceFingerprint || null,
      reason: row.reason,
    })),
    ownerQuestions: (classified.ownerQuestions || []).map(row => ({
      id: row.id || null,
      date: row.date || null,
      reason: row.reason,
    })),
    unsupported: (classified.unsupported || []).map(row => ({
      locator: row.locator || null,
      id: row.id || null,
      reason: row.reason,
    })),
    downstreamArtifacts: (classified.downstreamArtifacts || []).map(row => ({
      kind: row.kind,
      wouldChange: row.wouldChange === true,
    })),
  };
}

function previewIdFrom(proposed, refused, classification) {
  const body = JSON.stringify(previewFingerprint(proposed, refused, classification));
  return crypto.createHash('sha256').update(body).digest('hex');
}

function sortClassified(a, b) {
  return String(a.locator || a.id || a.evidenceFingerprint || '')
    .localeCompare(String(b.locator || b.id || b.evidenceFingerprint || ''))
    || String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.reason || '').localeCompare(String(b.reason || ''));
}

function obligationReceiptFrom(report) {
  const receipt = report && report.obligationReconciliationReceipt;
  if (receipt && receipt.schema === O.RECONCILIATION_RECEIPT_SCHEMA) return receipt;
  return {
    schema: O.RECONCILIATION_RECEIPT_SCHEMA,
    trusted: false,
    observationReadyForReconciliation: false,
    failClosedKind: 'reconciliation-receipt-missing',
    failClosedReasons: ['reconciliation-receipt-missing'],
    observationFingerprintDigest: (report && report.observationReceipt
      && report.observationReceipt.fingerprintDigest) || null,
    counts: {
      coveredModeledOccurrences: 0,
      represented: 0,
      upcoming: 0,
      unverified: 0,
      ambiguous: 0,
      outsideCoverage: 0,
      unmatchedCashEvidence: 0,
    },
    occurrences: [],
    unmatchedCashEvidence: [],
  };
}

function postedMatchNoops(report) {
  const noops = [];
  const seen = new Set();
  for (const row of (report && report.reconciliation && report.reconciliation.rows) || []) {
    if (!row || row.status !== 'MATCH') continue;
    if (!eligiblePosted(row)) continue;
    const locator = row.canonicalTarget;
    if (!locator || seen.has(locator)) continue;
    seen.add(locator);
    noops.push({
      locator,
      fact: row.fact || null,
      currentValue: row.canonicalValue,
      observedValue: row.evidenceValue,
      evidenceDate: row.evidenceDate || row.observedAsOf || null,
      reason: 'replay-match',
    });
  }
  return noops;
}

function classifyFromObligationReceipt(receipt) {
  const noops = [];
  const unresolved = [];
  const ownerQuestions = [];
  const unsupported = [];
  if (!receipt || receipt.trusted !== true) {
    unsupported.push({
      locator: null,
      reason: 'obligation-reconciliation-not-trusted',
      failClosedKind: (receipt && receipt.failClosedKind) || 'reconciliation-receipt-missing',
    });
    return { noops, unresolved, ownerQuestions, unsupported };
  }
  for (const row of receipt.occurrences || []) {
    if (!row || !row.id) continue;
    const base = {
      id: row.id,
      date: row.date || null,
      kind: row.kind || null,
      settlement: row.settlement || null,
    };
    if (row.settlement === 'represented') {
      noops.push(Object.assign({}, base, {
        reason: 'obligation-represented-replay',
        evidenceFingerprint: row.evidenceFingerprint || null,
      }));
    } else if (row.settlement === 'upcoming') {
      noops.push(Object.assign({}, base, { reason: 'obligation-upcoming-not-a-write' }));
    } else if (row.settlement === 'unverified') {
      ownerQuestions.push(Object.assign({}, base, {
        reason: 'unverified-settlement-owner-fact',
      }));
    } else if (row.settlement === 'ambiguous') {
      unresolved.push(Object.assign({}, base, {
        reason: 'ambiguous-evidence-must-not-write',
        candidateCount: row.candidateCount || null,
      }));
    } else if (row.settlement === 'outside-coverage') {
      unsupported.push(Object.assign({}, base, {
        reason: 'outside-observation-window',
      }));
    } else {
      unsupported.push(Object.assign({}, base, {
        reason: 'unsupported-obligation-settlement',
      }));
    }
  }
  for (const row of receipt.unmatchedCashEvidence || []) {
    unresolved.push({
      date: row.date || null,
      amount: row.amount,
      accountRole: row.accountRole || null,
      kind: row.kind || null,
      evidenceFingerprint: row.evidenceFingerprint || null,
      reason: 'unmatched-household-cash-must-not-write',
    });
  }
  return { noops, unresolved, ownerQuestions, unsupported };
}

function classifyRefused(refused) {
  const unresolved = [];
  const unsupported = [];
  for (const row of refused || []) {
    const classified = {
      locator: row && row.locator || null,
      fact: row && row.fact || null,
      reason: row && row.reason,
      evidenceDate: row && row.evidenceDate || null,
      eventId: row && row.eventId || null,
    };
    if (row && UNRESOLVED_REFUSE_REASONS.has(row.reason)) unresolved.push(classified);
    else unsupported.push(classified);
  }
  return { unresolved, unsupported };
}

function downstreamArtifactsFrom(data, proposed) {
  const artifacts = [];
  const cashProposed = (proposed || []).filter(row => row && row.collection === 'cash');
  if (data && data.plan && cashProposed.length) {
    const next = clone(data);
    let applied = true;
    try {
      for (const change of cashProposed) applyChange(next, change);
    } catch (err) {
      applied = false;
    }
    if (applied) {
      const before = Forecast.startingCashAmount(data.plan);
      const after = Forecast.startingCashAmount(next.plan);
      artifacts.push({
        kind: 'forecast-starting-cash',
        wouldChange: !near(before, after),
        independentDelta: round2(after - before),
        note: 'Forecast consumes the written document after approval. This preview does not publish the operating answer.',
      });
    } else {
      artifacts.push({
        kind: 'forecast-starting-cash',
        wouldChange: false,
        independentDelta: 0,
        note: 'Posted cash proposal could not be applied in memory; no Forecast starting-cash consequence is claimed.',
      });
    }
  } else {
    artifacts.push({
      kind: 'forecast-starting-cash',
      wouldChange: false,
      independentDelta: 0,
      note: 'No posted cash write is proposed. Forecast starting cash would not change from this preview.',
    });
  }
  artifacts.push({
    kind: 'snapshot-balances',
    wouldChange: false,
    note: 'Posted previewId does not invent history. Snapshot remains scripts/snapshot-balances.js after a successful as-of cutover.',
  });
  artifacts.push({
    kind: 'opening-represented-events',
    wouldChange: false,
    note: 'Posted previewId cannot authorize representedEvents. Opening cutover remains a separate approval contract.',
  });
  return artifacts;
}

function classifyRefreshPreview(report, proposed, refused, data) {
  const receipt = obligationReceiptFrom(report);
  const observation = report && report.observationReceipt;
  const fromPostedMatch = postedMatchNoops(report);
  const fromObligation = classifyFromObligationReceipt(receipt);
  const fromRefused = classifyRefused(refused);
  return {
    reconciliationTrusted: receipt.trusted === true,
    observationReadyForReconciliation: !!(observation && observation.readyForReconciliation === true)
      || receipt.observationReadyForReconciliation === true,
    failClosedKind: receipt.trusted === true
      ? null
      : (receipt.failClosedKind || 'reconciliation-receipt-missing'),
    failClosedReasons: receipt.trusted === true ? [] : (receipt.failClosedReasons || []).slice(),
    observationFingerprintDigest: (observation && observation.fingerprintDigest)
      || receipt.observationFingerprintDigest
      || null,
    approvalObservationIdentity: approvalObservationIdentity(observation),
    counts: receipt.counts || null,
    mechanicallyProvable: clone(proposed),
    noops: fromPostedMatch.concat(fromObligation.noops).sort(sortClassified),
    unresolved: fromRefused.unresolved.concat(fromObligation.unresolved).sort(sortClassified),
    ownerQuestions: fromObligation.ownerQuestions.sort(sortClassified),
    unsupported: fromRefused.unsupported.concat(fromObligation.unsupported).sort(sortClassified),
    downstreamArtifacts: downstreamArtifactsFrom(data, proposed),
  };
}

function identityProofLooksSanitized(doc) {
  const blob = JSON.stringify(doc == null ? {} : doc);
  return !/"providerAccountId"\s*:/.test(blob)
    && !/"providerTransactionId"\s*:/.test(blob)
    && !/Bearer\s+\S+/.test(blob)
    && !/LUNCHMONEY_ACCESS_TOKEN/.test(blob);
}

function dateOnly(value) {
  return Forecast.financialDate(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value);
}

function ownerStatementCadence(canonicalId) {
  const row = canonicalId ? OWNER_STATEMENT_CADENCE[canonicalId] : null;
  return row ? { kind: row.kind, day: row.day } : null;
}

// Calendar-month day clamp. Same formula Forecast uses; not 30-day arithmetic.
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function statementDateInMonth(year, month, day) {
  const clamped = Math.min(Number(day), daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function currentStatementCycleStart(requestedAsOf, statementDay) {
  if (!isIsoDate(requestedAsOf) || !isFinite(Number(statementDay))) return null;
  const [year, month] = requestedAsOf.split('-').map(Number);
  const thisMonth = statementDateInMonth(year, month, statementDay);
  if (thisMonth <= requestedAsOf) return thisMonth;
  let priorYear = year;
  let priorMonth = month - 1;
  if (priorMonth < 1) {
    priorMonth = 12;
    priorYear -= 1;
  }
  return statementDateInMonth(priorYear, priorMonth, statementDay);
}

function nextStatementDate(cycleStart, statementDay) {
  if (!isIsoDate(cycleStart) || !isFinite(Number(statementDay))) return null;
  const [year, month] = cycleStart.split('-').map(Number);
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  return statementDateInMonth(nextYear, nextMonth, statementDay);
}

function statementCadenceAccepts(canonicalId, evidenceDate, requestedAsOf) {
  const cadence = ownerStatementCadence(canonicalId);
  if (!cadence || cadence.kind !== 'monthly-statement') return false;
  if (!isIsoDate(evidenceDate) || !isIsoDate(requestedAsOf)) return false;
  if (evidenceDate > requestedAsOf) return false;
  const cycleStart = currentStatementCycleStart(requestedAsOf, cadence.day);
  if (!cycleStart) return false;
  const nextStart = nextStatementDate(cycleStart, cadence.day);
  if (nextStart && requestedAsOf >= nextStart) return false;
  return evidenceDate >= cycleStart && evidenceDate <= requestedAsOf;
}

function issue(code, explanation, extra) {
  return Object.assign({ code, explanation }, extra || {});
}

function reconRows(report) {
  return (report && report.reconciliation && report.reconciliation.rows) || [];
}

function isPostedFact(row) {
  if (!row) return false;
  if (row.fact && CREDIT_REFUSE_FACTS.has(row.fact)) return false;
  if (row.fact && BACKFILL_FACTS.has(row.fact)) return false;
  return !row.fact || row.fact === 'posted-balance';
}

function requiredPostedLocators(data) {
  const out = [];
  for (const id of POSTED_CASH) {
    const row = cashRow(data, id);
    out.push({
      locator: `cash:${id}`,
      collection: 'cash',
      id,
      canonicalValue: row && row.value != null && isFinite(Number(row.value))
        ? Number(row.value)
        : null,
    });
  }
  for (const debt of (data && data.debts) || []) {
    if (!debt || !debt.id) continue;
    if (debt.balance == null || !isFinite(Number(debt.balance))) continue;
    out.push({
      locator: `debts:${debt.id}`,
      collection: 'debts',
      id: debt.id,
      canonicalValue: Number(debt.balance),
    });
  }
  return out;
}

function postedRowsForLocator(report, locator) {
  return reconRows(report).filter(row => row && row.canonicalTarget === locator && isPostedFact(row));
}

function trustworthyPostedRow(row) {
  return !!(row
    && row.unknown !== true
    && row.status !== 'CONFLICT'
    && row.status !== 'MISSING'
    && row.evidenceValue != null
    && isFinite(row.evidenceValue));
}

function paydayEvidenceHouseholdDate(row) {
  return dateOnly(row && (row.evidenceDate || row.observedAsOf));
}

function paydayEvidenceIsCanonicalNewer(row) {
  return !!(row && row.dateRelation === 'canonical-newer');
}

function paydayEvidencePredatesCanonicalOpening(row, currentOpeningAsOf) {
  const day = paydayEvidenceHouseholdDate(row);
  return !!(currentOpeningAsOf && day && String(day) < String(currentOpeningAsOf));
}

function currentPaydayPostedRow(row, currentOpeningAsOf) {
  return trustworthyPostedRow(row)
    && !paydayEvidenceIsCanonicalNewer(row)
    && !paydayEvidencePredatesCanonicalOpening(row, currentOpeningAsOf);
}

function paydayObservedCashFromReport(report, paydayDate, currentOpeningAsOf) {
  const accounts = [];
  if (!report || !paydayDate) {
    return { complete: false, asOf: paydayDate || null, accounts };
  }
  for (const id of POSTED_CASH) {
    const rows = postedRowsForLocator(report, `cash:${id}`);
    const fresh = rows.find(row =>
      currentPaydayPostedRow(row, currentOpeningAsOf)
      && paydayEvidenceHouseholdDate(row) === paydayDate);
    if (!fresh) continue;
    accounts.push({
      id,
      value: round2(fresh.evidenceValue),
      evidenceDate: paydayEvidenceHouseholdDate(fresh),
    });
  }
  return {
    complete: accounts.some(row => row.id === 'chequing-a')
      && accounts.some(row => row.id === 'chequing-b'),
    asOf: paydayDate,
    accounts,
  };
}

function recordedPaydayObservationPacket(plan) {
  return plan && plan.opening && plan.opening.paydayAccountObservations
    ? plan.opening.paydayAccountObservations
    : null;
}

function paydayObservationFingerprint(proposal) {
  const packet = proposal && proposal.packet;
  const row = packet && Array.isArray(packet.accounts) ? packet.accounts[0] : null;
  return {
    schema: PAYDAY_OBSERVATION_SCHEMA,
    paydayDate: packet && packet.periodStart || null,
    asOf: packet && packet.asOf || null,
    currentOpeningAsOf: proposal && proposal.currentOpeningAsOf || null,
    accountId: row && row.id || null,
    value: row && row.value != null ? round2(row.value) : null,
    evidenceDate: row && row.evidenceDate || null,
    temporalClaim: row && row.temporalClaim || null,
    source: row && row.source || null,
  };
}

function paydayObservationApprovalIdFrom(proposal) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(paydayObservationFingerprint(proposal)))
    .digest('hex');
}

function paydayObservationUnavailable(reason, extra) {
  return Object.assign({
    schema: PAYDAY_OBSERVATION_SCHEMA,
    writesCanonicalState: false,
    paydayObservationWriteSupported: false,
    paydayObservationApprovalId: null,
    reason: reason || 'unavailable',
    packet: null,
    currentOpeningAsOf: extra && extra.currentOpeningAsOf || null,
    paydayDate: extra && extra.paydayDate || null,
  }, extra || {});
}

function paydayObservationPredatesOpening(proposal, openingAsOf) {
  if (!openingAsOf) return true;
  const opening = String(openingAsOf);
  const days = [];
  if (proposal && proposal.paydayDate) days.push(dateOnly(proposal.paydayDate));
  const packet = proposal && proposal.packet;
  if (packet) {
    days.push(dateOnly(packet.periodStart), dateOnly(packet.asOf));
    const row = Array.isArray(packet.accounts) ? packet.accounts[0] : null;
    if (row) days.push(dateOnly(row.evidenceDate));
  }
  return days.some(day => day && String(day) < opening);
}

function buildPaydayAccountObservationProposal(data, report) {
  const currentOpeningAsOf = data && data.plan && data.plan.opening && data.plan.opening.asOf
    ? String(data.plan.opening.asOf)
    : null;
  const billsRows = postedRowsForLocator(report, `cash:${PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID}`)
    .filter(trustworthyPostedRow);
  if (!billsRows.length) {
    return paydayObservationUnavailable('chequing-a-evidence-missing', { currentOpeningAsOf });
  }
  const currentRows = billsRows.filter(row => currentPaydayPostedRow(row, currentOpeningAsOf));
  if (!currentRows.length) {
    return paydayObservationUnavailable('stale-not-current', {
      currentOpeningAsOf,
      paydayDate: paydayEvidenceHouseholdDate(billsRows[0]),
    });
  }
  const paydayDates = [];
  for (const row of currentRows) {
    const day = paydayEvidenceHouseholdDate(row);
    if (!day) continue;
    const cycle = Forecast.spendingCycle(data && data.plan, day);
    if (cycle && cycle.start && String(cycle.start) === String(day)
      && paydayDates.indexOf(day) === -1) {
      paydayDates.push(day);
    }
  }
  if (paydayDates.length !== 1) {
    return paydayObservationUnavailable(
      paydayDates.length ? 'conflicting-payday-evidence' : 'evidence-date-not-seaspan-payday',
      { currentOpeningAsOf, paydayDate: paydayDates[0] || paydayEvidenceHouseholdDate(currentRows[0]) }
    );
  }
  const paydayDate = paydayDates[0];
  if (currentOpeningAsOf && String(paydayDate) < String(currentOpeningAsOf)) {
    return paydayObservationUnavailable('stale-not-current', {
      currentOpeningAsOf,
      paydayDate,
    });
  }
  const observedCash = paydayObservedCashFromReport(report, paydayDate, currentOpeningAsOf);
  const obs = Forecast.paydayBoundaryAccountObservation(
    data && data.plan,
    PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID,
    paydayDate,
    { observedCash }
  );
  if (!obs) {
    return paydayObservationUnavailable('payday-boundary-observation-unavailable', {
      currentOpeningAsOf,
      paydayDate,
    });
  }
  if (String(obs.accountId) !== PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID
    || obs.temporalClaim !== PAYDAY_BOUNDARY_TEMPORAL_CLAIM
    || obs.isPaydayMorningOpening === true
    || obs.isPooledChequing === true
    || !Number.isFinite(Number(obs.value))) {
    return paydayObservationUnavailable('payday-boundary-observation-untrusted', {
      currentOpeningAsOf,
      paydayDate,
    });
  }
  const existing = recordedPaydayObservationPacket(data && data.plan);
  if (existing && existing.periodStart && String(existing.periodStart) !== String(paydayDate)) {
    return paydayObservationUnavailable('existing-payday-observation-protected', {
      currentOpeningAsOf,
      paydayDate,
      existingPeriodStart: String(existing.periodStart),
    });
  }
  const packet = {
    periodStart: String(paydayDate),
    asOf: String(paydayDate),
    accounts: [{
      id: PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID,
      value: round2(obs.value),
      evidenceDate: String(obs.evidenceDate),
      temporalClaim: PAYDAY_BOUNDARY_TEMPORAL_CLAIM,
      source: obs.source || 'provider-observation',
    }],
  };
  const proposal = {
    schema: PAYDAY_OBSERVATION_SCHEMA,
    writesCanonicalState: false,
    paydayObservationWriteSupported: true,
    reason: null,
    packet,
    currentOpeningAsOf,
    paydayDate: String(paydayDate),
    temporalClaim: PAYDAY_BOUNDARY_TEMPORAL_CLAIM,
    isPaydayMorningOpening: false,
    isPooledChequing: false,
    note: 'Proposal only. Owner approval writes plan.opening.paydayAccountObservations for canonical chequing-a. Opening as-of, startingCash, leftover, Current Balance, and Prepare Ahead are not this write.',
  };
  proposal.paydayObservationApprovalId = paydayObservationApprovalIdFrom(proposal);
  return proposal;
}

function pickDatedRow(rows, requestedAsOf, opts) {
  const allowNonExact = !!(opts && opts.allowNonExact);
  if (!rows.length) return null;
  const dated = rows.map(row => ({
    row,
    date: dateOnly(row.evidenceDate || row.observedAsOf),
  }));
  const exact = dated.filter(item => item.date === requestedAsOf);
  if (exact.length) {
    return (exact.find(item => item.row.status === 'CONFLICT') || exact[0]).row;
  }
  if (!allowNonExact) return null;
  const notAfter = dated.filter(item => item.date && item.date <= requestedAsOf)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (notAfter.length) return notAfter[0].row;
  const after = dated.filter(item => item.date && item.date > requestedAsOf)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (after.length) return after[0].row;
  return rows[0];
}

function hasPendingState(debt) {
  if (!debt) return false;
  if (debt.pendingUnknown === true || debt.unknownPending === true) return true;
  if (!Object.prototype.hasOwnProperty.call(debt, 'pending')) return false;
  return debt.secured === false;
}

function pendingRowsForDebt(report, id) {
  const locator = `debts:${id}#pending`;
  return reconRows(report).filter(row => row && row.fact === 'pending' && (
    row.cardId === id || row.canonicalTarget === locator
  ));
}

function pendingCoverageComplete(report) {
  const classified = O.classifyPendingCoverage(report || {});
  return classified.complete === true && classified.status === 'complete'
    && classified.basis === PENDING_ZERO_PROOF && classified.hasMore === false;
}

function pendingObservation(report, cardId) {
  return ((report && report.observations) || []).find(row => (
    row && row.fact === 'pending' && row.cardId === cardId
  )) || null;
}

function canonicalPendingState(debt) {
  const unknown = !!(debt && (debt.pendingUnknown === true || debt.unknownPending === true));
  const known = !unknown && debt && debt.pending != null && debt.pending !== '' && isFinite(Number(debt.pending));
  return {
    unknown,
    known,
    value: known ? Number(debt.pending) : null,
  };
}

function evaluateCandidatePending(debt, report, requestedAsOf) {
  const locator = `debts:${debt.id}#pending`;
  const canonical = canonicalPendingState(debt);
  const candidatePending = pendingRowsForDebt(report, debt.id).filter(item => (
    dateOnly(item.evidenceDate || item.observedAsOf) === requestedAsOf
  ));
  if (candidatePending.some(item => item.status === 'CONFLICT')) {
    return {
      locator,
      kind: 'conflict',
      currentUnknown: canonical.unknown,
      currentValue: canonical.value,
      proposedValue: null,
      evidenceDate: requestedAsOf,
    };
  }
  const row = pickDatedRow(pendingRowsForDebt(report, debt.id), requestedAsOf, { allowNonExact: false });
  const evidenceDate = row ? dateOnly(row.evidenceDate || row.observedAsOf) : null;
  const numeric = !!(row && row.unknown !== true && row.evidenceValue != null && isFinite(row.evidenceValue)
    && evidenceDate === requestedAsOf);
  if (canonical.unknown) {
    if (!numeric) {
      return {
        locator,
        kind: 'unknown-remain',
        currentUnknown: true,
        currentValue: null,
        proposedValue: null,
        evidenceDate: evidenceDate,
      };
    }
  } else if (!canonical.known) {
    return { locator, kind: 'skip', currentUnknown: false, currentValue: null, proposedValue: null, evidenceDate };
  } else if (!numeric) {
    return {
      locator,
      kind: 'unproven',
      currentUnknown: false,
      currentValue: canonical.value,
      proposedValue: null,
      evidenceDate: evidenceDate,
    };
  }
  const proposedValue = round2(row.evidenceValue);
  const obs = pendingObservation(report, debt.id);
  const proof = obs && obs.pendingProof ? String(obs.pendingProof) : null;
  const zero = near(proposedValue, 0);
  const coverageOk = pendingCoverageComplete(report);
  if (!coverageOk || (zero && proof !== PENDING_ZERO_PROOF)) {
    if (canonical.unknown) {
      return {
        locator,
        kind: 'unknown-remain',
        currentUnknown: true,
        currentValue: null,
        proposedValue: null,
        evidenceDate,
      };
    }
    if (zero || !numeric) {
      return {
        locator,
        kind: 'unproven',
        currentUnknown: false,
        currentValue: canonical.value,
        proposedValue: null,
        evidenceDate,
      };
    }
    return {
      locator,
      kind: 'unwritable',
      currentUnknown: false,
      currentValue: canonical.value,
      proposedValue,
      evidenceDate,
    };
  }
  if (!canonical.unknown && near(proposedValue, canonical.value)) {
    return {
      locator,
      kind: 'match',
      currentUnknown: false,
      currentValue: canonical.value,
      proposedValue,
      evidenceDate,
      proof: zero ? PENDING_ZERO_PROOF : (proof || 'candidate-date-pending'),
    };
  }
  return {
    locator,
    kind: 'writable',
    currentUnknown: canonical.unknown,
    currentValue: canonical.value,
    proposedValue,
    evidenceDate,
    proof: zero ? PENDING_ZERO_PROOF : (proof || 'candidate-date-pending'),
    cardId: debt.id,
  };
}

function pendingTransitionFromEval(evaluated) {
  return {
    locator: evaluated.locator,
    collection: 'debts',
    id: evaluated.cardId,
    field: 'pending',
    currentUnknown: evaluated.currentUnknown === true,
    currentValue: evaluated.currentUnknown ? null : round2(evaluated.currentValue),
    proposedValue: round2(evaluated.proposedValue),
    evidenceDate: evaluated.evidenceDate,
    proof: evaluated.proof,
    source: 'provider-observe:lunchmoney',
    reason: evaluated.currentUnknown
      ? 'UNKNOWN canonical pending; candidate-date evidence is numeric'
      : 'candidate-date pending differs from canonical pending',
  };
}

function cutoverPendingFingerprint(requestedAsOf, transitions) {
  return {
    schema: CUTOVER_PENDING_SCHEMA,
    requestedAsOf,
    transitions: (transitions || []).map(row => ({
      locator: row.locator,
      currentUnknown: row.currentUnknown === true,
      currentValue: row.currentUnknown === true ? null : row.currentValue,
      proposedValue: row.proposedValue,
      evidenceDate: row.evidenceDate,
      proof: row.proof || null,
    })),
  };
}

function cutoverApprovalIdFrom(requestedAsOf, transitions) {
  const body = JSON.stringify(cutoverPendingFingerprint(requestedAsOf, transitions));
  return crypto.createHash('sha256').update(body).digest('hex');
}

function sortByLocator(a, b) {
  return String(a && a.locator).localeCompare(String(b && b.locator));
}

function sortRepresented(a, b) {
  return String(a && a.date).localeCompare(String(b && b.date))
    || String(a && a.id).localeCompare(String(b && b.id));
}

function copyOpeningRepresentation(row) {
  return { id: row.id, date: row.date,
    ...(Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')
      ? { effectiveAsOf: row.effectiveAsOf } : {}) };
}

function pendingStateFromEval(evaluated, cardId) {
  return {
    locator: evaluated.locator,
    collection: 'debts',
    id: cardId || evaluated.cardId,
    field: 'pending',
    currentUnknown: evaluated.currentUnknown === true,
    currentValue: evaluated.currentUnknown ? null : (evaluated.currentValue == null ? null : round2(evaluated.currentValue)),
    proposedUnknown: false,
    proposedValue: round2(evaluated.proposedValue),
    evidenceDate: evaluated.evidenceDate,
    proof: evaluated.proof || null,
    kind: evaluated.kind,
  };
}

function postedStateFromFreshness(row) {
  const parsed = parseLocator(row && row.locator);
  return {
    locator: row.locator,
    collection: parsed ? parsed.collection : null,
    id: parsed ? parsed.id : null,
    field: parsed && parsed.collection === 'cash' ? 'value' : 'balance',
    currentValue: row.canonicalValue == null ? null : round2(row.canonicalValue),
    proposedValue: row.observedValue == null ? null : round2(row.observedValue),
    evidenceDate: row.evidenceDate || null,
    freshnessBasis: row.freshnessBasis || null,
    reconcileStatus: row.reconcileStatus || null,
  };
}

function openingRoutingFingerprint(balanceMap) {
  const mappings = ((balanceMap && balanceMap.mappings) || [])
    .map((row) => {
      if (!row || !row.canonical || !row.canonical.collection || !row.canonical.id) return null;
      return {
        locator: `${row.canonical.collection}:${row.canonical.id}`,
        accountLabel: row.accountLabel ? String(row.accountLabel) : null,
        observationId: row.observationId ? String(row.observationId) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.locator).localeCompare(String(b.locator))
      || String(a.accountLabel || '').localeCompare(String(b.accountLabel || ''))
      || String(a.observationId || '').localeCompare(String(b.observationId || '')));
  const excluded = ((balanceMap && balanceMap.excluded) || [])
    .map((row) => (row && row.accountLabel ? String(row.accountLabel) : null))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return { mappings, excluded };
}

function openingFingerprint(cutover, balanceMap) {
  const proposal = (cutover && cutover.proposedOpening) || {};
  return {
    schema: OPENING_CUTOVER_SCHEMA,
    requestedAsOf: cutover && cutover.requestedAsOf ? cutover.requestedAsOf : null,
    currentMetaAsOf: cutover && cutover.currentMetaAsOf ? cutover.currentMetaAsOf : null,
    currentOpeningAsOf: cutover && cutover.currentOpeningAsOf ? cutover.currentOpeningAsOf : null,
    posted: (proposal.posted || []).slice().sort(sortByLocator).map(row => ({
      locator: row.locator,
      currentValue: row.currentValue,
      observedValue: row.proposedValue,
      evidenceDate: row.evidenceDate || null,
      freshnessBasis: row.freshnessBasis || null,
      reconcileStatus: row.reconcileStatus || null,
    })),
    pending: (proposal.pending || []).slice().sort(sortByLocator).map(row => ({
      locator: row.locator,
      currentUnknown: row.currentUnknown === true,
      currentValue: row.currentUnknown === true ? null : row.currentValue,
      proposedUnknown: row.proposedUnknown === true,
      proposedValue: row.proposedUnknown === true ? null : row.proposedValue,
      evidenceDate: row.evidenceDate || null,
      proof: row.proof || null,
    })),
    representedEvents: (proposal.representedEvents || []).slice().sort(sortRepresented).map(copyOpeningRepresentation),
    openingFields: {
      metaAsOf: cutover && cutover.requestedAsOf ? cutover.requestedAsOf : null,
      planOpeningAsOf: cutover && cutover.requestedAsOf ? cutover.requestedAsOf : null,
    },
    routing: openingRoutingFingerprint(balanceMap),
  };
}

function openingApprovalIdFrom(cutover, balanceMap) {
  return crypto.createHash('sha256').update(JSON.stringify(openingFingerprint(cutover, balanceMap))).digest('hex');
}

function collectPendingDebts(data, report) {
  const pendingDebts = [];
  const seenPending = new Set();
  for (const debt of (data && data.debts) || []) {
    if (!hasPendingState(debt) || seenPending.has(debt.id)) continue;
    seenPending.add(debt.id);
    pendingDebts.push(debt);
  }
  for (const row of reconRows(report)) {
    if (!row || row.fact !== 'pending' || !row.cardId || seenPending.has(row.cardId)) continue;
    const debt = debtRow(data, row.cardId);
    if (!debt || !hasPendingState(debt)) continue;
    seenPending.add(row.cardId);
    pendingDebts.push(debt);
  }
  return pendingDebts;
}

function proposePendingTransitions(data, report, requestedAsOf) {
  const proposed = [];
  for (const debt of collectPendingDebts(data, report)) {
    const evaluated = evaluateCandidatePending(debt, report, requestedAsOf);
    if (evaluated.kind === 'writable') proposed.push(pendingTransitionFromEval(evaluated));
  }
  proposed.sort((a, b) => String(a.locator).localeCompare(String(b.locator)));
  return proposed;
}

function schedulePlan(plan) {
  return {
    income: (plan && plan.income) || [],
    obligations: (plan && plan.obligations) || [],
    bills: (plan && plan.bills) || [],
    commitments: (plan && plan.commitments) || [],
    startingCash: plan && plan.startingCash,
    opening: plan && plan.opening,
  };
}

function isJointCashOutflow(event) {
  return !!(event && event.amount < 0 && event.kind !== 'noncash' && event.jointCash !== false);
}

function carriedUnresolvedOutflows(data, requestedAsOf) {
  const plan = data && data.plan;
  if (!plan) return { count: 0, total: 0, items: [] };
  const events = Forecast.expandEvents(schedulePlan(plan), requestedAsOf, requestedAsOf, {});
  const items = [];
  for (const event of events) {
    if (!event || event.date >= requestedAsOf) continue;
    if (!isJointCashOutflow(event)) continue;
    items.push({
      id: event.id || null,
      scheduledDate: event.scheduledDate || event.date,
      amount: round2(event.amount),
      kind: event.kind || null,
    });
  }
  items.sort((a, b) => String(a.scheduledDate).localeCompare(String(b.scheduledDate))
    || String(a.id).localeCompare(String(b.id)));
  const total = round2(items.reduce((sum, item) => sum + Number(item.amount), 0));
  return { count: items.length, total, items };
}

function sameDayScheduledEvents(data, requestedAsOf) {
  const plan = data && data.plan;
  if (!plan) return [];
  return Forecast.expandEvents(schedulePlan(plan), requestedAsOf, requestedAsOf, {})
    .filter(event => event && event.date === requestedAsOf && event.kind !== 'noncash');
}

function sanitizedRepresentedCandidates(report, requestedAsOf) {
  return ((report && report.representedEventCandidates) || []).map((candidate) => {
    const classified = O.classifyRepresentedCandidate(candidate, requestedAsOf);
    return {
      id: classified.id || null,
      date: classified.date || null,
      openingRelevance: classified.openingRelevance,
      currentOpeningImpact: classified.currentOpeningImpact === true,
      mustNotBackfillOpening: classified.mustNotBackfillOpening !== false,
    };
  });
}

function pushUnique(list, item) {
  const key = [item.code, item.locator || '', item.eventId || '', item.evidenceDate || ''].join('|');
  if (list.some(existing => [existing.code, existing.locator || '', existing.eventId || '', existing.evidenceDate || ''].join('|') === key)) {
    return;
  }
  list.push(item);
}

function newerEvidenceSupersedes(report, locator, requestedAsOf) {
  return postedRowsForLocator(report, locator).some((row) => {
    const evidenceDate = dateOnly(row.evidenceDate || row.observedAsOf);
    return evidenceDate === requestedAsOf
      && row.status !== 'CONFLICT'
      && row.status !== 'MISSING'
      && row.unknown !== true
      && row.evidenceValue != null
      && isFinite(row.evidenceValue)
      && row.dateRelation === 'canonical-older';
  });
}

function buildOpeningCutover(data, report, requestedAsOf, balanceMap) {
  if (!isIsoDate(requestedAsOf)) {
    fail('--cutover-as-of must be an explicit YYYY-MM-DD date. Do not infer it from fetchedAt.');
  }
  const blockers = [];
  const warnings = [];
  const metaAsOf = data && data.meta && data.meta.asOf ? String(data.meta.asOf) : null;
  const openingAsOf = data && data.plan && data.plan.opening && data.plan.opening.asOf
    ? String(data.plan.opening.asOf)
    : null;

  if (!metaAsOf || !openingAsOf || metaAsOf !== openingAsOf) {
    pushUnique(blockers, issue(
      'canonical-as-of-incoherent',
      'meta.asOf and plan.opening.asOf must already agree before Atlas can reason about a successor opening.',
      { currentMetaAsOf: metaAsOf, currentOpeningAsOf: openingAsOf }
    ));
  }
  if (openingAsOf && requestedAsOf < openingAsOf) {
    pushUnique(blockers, issue(
      'requested-as-of-before-current-opening',
      'A requested cutover date earlier than the current canonical opening is rejected.',
      { requestedAsOf, currentOpeningAsOf: openingAsOf }
    ));
  }
  if (openingAsOf && requestedAsOf === openingAsOf) {
    pushUnique(warnings, issue(
      'same-date-not-an-opening-advance',
      'This is a same-date diagnostic of the current opening, not an opening-date advance.'
    ));
  }

  const accountFreshness = requiredPostedLocators(data).map((loc) => {
    const rows = postedRowsForLocator(report, loc.locator);
    const row = pickDatedRow(rows, requestedAsOf, { allowNonExact: true });
    const evidenceDate = row ? dateOnly(row.evidenceDate || row.observedAsOf) : null;
    const observedValue = row && row.unknown !== true && row.evidenceValue != null && isFinite(row.evidenceValue)
      ? row.evidenceValue
      : null;
    const exactDay = evidenceDate === requestedAsOf;
    const cadenceAccepted = statementCadenceAccepts(loc.id, evidenceDate, requestedAsOf);
    const trustworthy = !!(row
      && row.unknown !== true
      && observedValue != null
      && row.status !== 'CONFLICT'
      && row.status !== 'MISSING');
    const fresh = !!(trustworthy && (exactDay || cadenceAccepted));
    const freshnessBasis = !fresh
      ? null
      : (exactDay ? FRESHNESS_EXACT_DAY : FRESHNESS_STATEMENT_CADENCE);
    if (!row) {
      pushUnique(blockers, issue(
        'missing-posted-opening-evidence',
        `No trustworthy posted evidence exists for ${loc.locator} on ${requestedAsOf}.`,
        { locator: loc.locator }
      ));
    } else if (row.status === 'CONFLICT' && (exactDay || cadenceAccepted)) {
      pushUnique(blockers, issue(
        'same-day-no-winner',
        `Conflicting posted observations for ${loc.locator} on ${requestedAsOf} have no trustworthy winner.`,
        { locator: loc.locator, evidenceDate }
      ));
    } else if (!fresh && evidenceDate !== requestedAsOf) {
      pushUnique(blockers, issue(
        'stale-posted-opening-evidence',
        `Posted evidence for ${loc.locator} is dated ${evidenceDate || 'unknown'}, not ${requestedAsOf}. MATCH is not freshness.`,
        { locator: loc.locator, evidenceDate, reconcileStatus: row.status || null }
      ));
    }
    return {
      locator: loc.locator,
      canonicalValue: loc.canonicalValue,
      observedValue,
      evidenceDate,
      reconcileStatus: row ? (row.status || null) : 'MISSING',
      dateRelation: row ? (row.dateRelation || null) : null,
      freshForRequestedAsOf: fresh,
      freshnessBasis,
    };
  });

  const pendingTransitions = [];
  const pendingStates = [];
  for (const debt of collectPendingDebts(data, report)) {
    const evaluated = evaluateCandidatePending(debt, report, requestedAsOf);
    const locator = evaluated.locator;
    if (evaluated.kind === 'conflict') {
      pushUnique(blockers, issue(
        'pending-state-change-unresolved',
        `Candidate-date pending observations for ${debt.id} conflict. Atlas cannot choose one numeric pending amount. Pending cannot be written.`,
        {
          locator,
          canonicalValue: evaluated.currentValue,
          observedValue: null,
        }
      ));
      continue;
    }
    if (evaluated.kind === 'unknown-remain') {
      pushUnique(warnings, issue(
        'pending-remains-unknown',
        `Canonical pending for ${debt.id} remains UNKNOWN. UNKNOWN is not zero.`,
        { locator, observedValue: null }
      ));
      continue;
    }
    if (evaluated.kind === 'unproven') {
      pushUnique(blockers, issue(
        'pending-freshness-unproven',
        !evaluated.evidenceDate
          ? `Canonical pending for ${debt.id} is a known numeric value from an older opening and has no candidate-date evidence. It is not current.`
          : `Candidate-date pending evidence for ${debt.id} does not prove the numeric pending state.`,
        { locator, canonicalValue: evaluated.currentValue, observedValue: null }
      ));
      continue;
    }
    if (evaluated.kind === 'unwritable') {
      pushUnique(blockers, issue(
        'pending-state-change-unresolved',
        `Candidate-date pending for ${debt.id} differs from canonical pending. The new opening cannot retain ${evaluated.currentValue}. Pending cannot be written.`,
        { locator, canonicalValue: evaluated.currentValue, observedValue: evaluated.proposedValue }
      ));
      continue;
    }
    if (evaluated.kind === 'writable') {
      pendingTransitions.push(pendingTransitionFromEval(evaluated));
    }
    if (evaluated.kind === 'writable' || evaluated.kind === 'match') {
      pendingStates.push(pendingStateFromEval(evaluated, debt.id));
    }
  }
  pendingTransitions.sort((a, b) => String(a.locator).localeCompare(String(b.locator)));
  const cutoverApprovalId = pendingTransitions.length
    ? cutoverApprovalIdFrom(requestedAsOf, pendingTransitions)
    : null;

  for (const discrepancy of (report && report.sameDayDiscrepancies) || []) {
    if (!discrepancy || !discrepancy.canonicalTarget) continue;
    if (discrepancy.fact && CREDIT_REFUSE_FACTS.has(discrepancy.fact) && discrepancy.fact !== 'pending') continue;
    if (discrepancy.fact === 'pending') continue;
    if (newerEvidenceSupersedes(report, discrepancy.canonicalTarget, requestedAsOf)) continue;
    pushUnique(blockers, issue(
      'same-day-no-winner',
      `Same-day reconciliation conflict for ${discrepancy.canonicalTarget} has no trustworthy winner and must not silently participate in the requested opening.`,
      {
        locator: discrepancy.canonicalTarget,
        evidenceDate: discrepancy.evidenceDate || null,
        fact: discrepancy.fact || null,
      }
    ));
  }

  const candidates = sanitizedRepresentedCandidates(report, requestedAsOf);
  const sameDayEvents = sameDayScheduledEvents(data, requestedAsOf).map((event) => {
    const hit = candidates.find(candidate => candidate.id === event.id
      && candidate.date === event.date
      && candidate.currentOpeningImpact === true);
    if (hit) {
      return {
        id: event.id,
        date: event.date,
        kind: event.kind,
        amount: round2(event.amount),
        representation: 'REPRESENTED',
        representedEventsCandidate: { id: event.id, date: event.scheduledDate || event.date },
      };
    }
    return {
      id: event.id,
      date: event.date,
      kind: event.kind,
      amount: round2(event.amount),
      representation: 'UNKNOWN',
      representedEventsCandidate: null,
    };
  });
  for (const event of sameDayEvents) {
    if (event.representation !== 'UNKNOWN') continue;
    pushUnique(blockers, issue(
      'same-day-event-representation-unknown',
      `Scheduled cash event ${event.id} on ${event.date} is not proven to be already inside the observed opening balances.`,
      { eventId: event.id, date: event.date }
    ));
  }
  for (const candidate of candidates) {
    if (!candidate.date || candidate.date >= requestedAsOf) continue;
    pushUnique(warnings, issue(
      'historical-represented-candidate-not-promoted',
      `Provider identity hit for ${candidate.id} on ${candidate.date} is historical evidence and must not become representedEvents on ${requestedAsOf}.`,
      { eventId: candidate.id, evidenceDate: candidate.date }
    ));
  }

  const unmappedCount = report && report.unmapped ? report.unmapped.length : 0;
  if (unmappedCount > 0) {
    pushUnique(warnings, issue(
      'unmapped-account-materiality-unknown',
      'Unmapped provider accounts are not inferred into household state. Materiality remains unknown; they are not spendable household cash.',
      { unmappedCount }
    ));
  }

  blockers.sort((a, b) => String(a.code).localeCompare(String(b.code))
    || String(a.locator || '').localeCompare(String(b.locator || ''))
    || String(a.eventId || '').localeCompare(String(b.eventId || '')));
  warnings.sort((a, b) => String(a.code).localeCompare(String(b.code))
    || String(a.locator || '').localeCompare(String(b.locator || ''))
    || String(a.eventId || '').localeCompare(String(b.eventId || '')));

  pendingStates.sort(sortByLocator);
  const postedStates = accountFreshness.map(postedStateFromFreshness).sort(sortByLocator);
  const proposedRepresentedEvents = sameDayEvents
    .filter(event => event && event.representation === 'REPRESENTED' && event.id && event.date)
    .map(event => event.representedEventsCandidate || ({ id: event.id, date: event.date }))
    .sort(sortRepresented);
  // Issuer knowledge is not candidate-date cash replay. Preserve only valid
  // original minimum-contract identities and their earliest qualification.
  for (const row of (data.plan.opening.representedEvents || [])) {
    const original = Forecast.cardMinimumReceiptIdentity(data.plan, row);
    if (!original) continue;
    const retained = { ...copyOpeningRepresentation(row), date: original,
      ...(!Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')
        ? { effectiveAsOf: openingAsOf } : {}) };
    const index = proposedRepresentedEvents.findIndex(item => item.id === retained.id && item.date === original);
    if (index < 0) proposedRepresentedEvents.push(retained);
    else {
      const current = proposedRepresentedEvents[index];
      const retainedActive = Forecast.representedEventEffectiveBy(retained, requestedAsOf);
      const currentActive = Forecast.representedEventEffectiveBy(current, requestedAsOf);
      if ((retainedActive && !currentActive) || (retainedActive && currentActive
          && retained.effectiveAsOf < (current.effectiveAsOf || requestedAsOf))) proposedRepresentedEvents[index] = retained;
    }
  }
  proposedRepresentedEvents.sort(sortRepresented);
  const proposedOpening = {
    requestedAsOf,
    currentMetaAsOf: metaAsOf,
    currentOpeningAsOf: openingAsOf,
    posted: postedStates,
    pending: pendingStates,
    representedEvents: proposedRepresentedEvents,
  };
  const unknownPendingRemains = warnings.some(item => item.code === 'pending-remains-unknown');
  const openingAdvance = !!(openingAsOf && requestedAsOf > openingAsOf);
  const postedFresh = accountFreshness.length > 0
    && accountFreshness.every(row => row.freshForRequestedAsOf === true);
  const sameDayKnown = sameDayEvents.every(event => event.representation === 'REPRESENTED');
  const cutoverWriteSupported = blockers.length === 0
    && openingAdvance
    && !unknownPendingRemains
    && postedFresh
    && sameDayKnown;
  const openingDraft = {
    requestedAsOf,
    currentMetaAsOf: metaAsOf,
    currentOpeningAsOf: openingAsOf,
    proposedOpening,
  };
  const openingApprovalId = cutoverWriteSupported ? openingApprovalIdFrom(openingDraft, balanceMap) : null;

  return {
    requestedAsOf,
    currentMetaAsOf: metaAsOf,
    currentOpeningAsOf: openingAsOf,
    writesOpening: false,
    cutoverWriteSupported,
    pendingWriteSupported: pendingTransitions.length > 0,
    cutoverApprovalId,
    openingApprovalId,
    pendingTransitions,
    proposedOpening,
    status: blockers.length ? 'BLOCKED' : 'READY_FOR_OWNER_REVIEW',
    accountFreshness,
    blockers,
    warnings,
    sameDayEvents,
    carriedUnresolvedOutflows: carriedUnresolvedOutflows(data, requestedAsOf),
    unmappedCount,
  };
}

function buildPreview(report, opts) {
  const { proposed, refused } = proposeFromReport(report);
  const classified = classifyRefreshPreview(report, proposed, refused, opts && opts.data);
  const previewId = previewIdFrom(proposed, refused, classified);
  return {
    schema: SCHEMA,
    writesCanonicalState: false,
    canonicalWriteAuthorized: false,
    unattended: false,
    productionWrite: false,
    previewId,
    source: 'provider-observe:lunchmoney',
    fetchedAt: report && report.fetchedAt ? report.fetchedAt : null,
    proposed,
    refused,
    mechanicallyProvable: classified.mechanicallyProvable,
    noops: classified.noops,
    unresolved: classified.unresolved,
    ownerQuestions: classified.ownerQuestions,
    unsupported: classified.unsupported,
    downstreamArtifacts: classified.downstreamArtifacts,
    reconciliationTrusted: classified.reconciliationTrusted,
    observationReadyForReconciliation: classified.observationReadyForReconciliation,
    failClosedKind: classified.failClosedKind,
    failClosedReasons: classified.failClosedReasons,
    observationFingerprintDigest: classified.observationFingerprintDigest,
    reconciliationCounts: classified.counts,
    unmappedCount: (report && report.unmapped ? report.unmapped.length : 0),
    cardCapacityIsCash: report && report.cardCapacityIsCash === 0
      ? 0
      : (report && report.cardCapacityIsCash) || 0,
    snapshotFollows: SNAPSHOT_COMMAND,
    identityProofSanitized: true,
    note: (opts && opts.note)
      || 'Preview only. No approval means no canonical write. Unresolved, owner-fact, and unsupported rows cannot write. Opening as-of is not a new cutover.',
  };
}

function observeInput(args, data, payload, accountMap) {
  const identity = fs.existsSync(args.identity) ? loadJson(args.identity) : { rules: [], billPaymentPayees: [] };
  return {
    provider: 'lunchmoney',
    payload,
    accountMap,
    data,
    identity,
    fetchedAt: payload && payload.fetchedAt,
  };
}

async function loadPayload(args) {
  if (args.live && args.fixture) fail('Use either --fixture or --live, not both.');
  if (!args.live && !args.fixture) fail('Pass --fixture <file> or --live.');
  if (args.live) {
    return O.fetchLunchMoneyLive(
      await O.resolveLiveToken(),
      new Date().toISOString(),
      O.historyDaysFromArgs({ mode: 'current-state' })
    );
  }
  return loadJson(args.fixture);
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function canonicalFileSha256(dataPath, data) {
  if (dataPath && fs.existsSync(dataPath)) return sha256Bytes(fs.readFileSync(dataPath));
  return sha256Bytes(Buffer.from(encodeData(data), 'utf8'));
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function postedStatesAllMatch(accountFreshness) {
  if (!Array.isArray(accountFreshness) || !accountFreshness.length) return false;
  return accountFreshness.every(row => (
    row
    && row.freshForRequestedAsOf === true
    && row.reconcileStatus === 'MATCH'
    && row.canonicalValue != null && isFinite(Number(row.canonicalValue))
    && row.observedValue != null && isFinite(Number(row.observedValue))
    && near(row.canonicalValue, row.observedValue)
  ));
}

function pendingStatesAllMatch(cutover) {
  const pending = (cutover && cutover.proposedOpening && cutover.proposedOpening.pending) || [];
  return pending.every(row => (
    row
    && row.kind === 'match'
    && row.proposedUnknown !== true
    && row.currentUnknown !== true
    && row.proposedValue != null && isFinite(Number(row.proposedValue))
    && row.currentValue != null && isFinite(Number(row.currentValue))
    && near(row.currentValue, row.proposedValue)
  ));
}

function pendingCensusCompleteForRecovery(cutover, report) {
  return pendingCoverageComplete(report)
    && !unknownPendingBlocksOpening(cutover)
    && !(cutover.pendingTransitions && cutover.pendingTransitions.length)
    && !((cutover.warnings || []).some(item => item.code === 'pending-remains-unknown'));
}

function requiredPostedMappingGaps(proposedOpening, balanceMap) {
  const excluded = Household.excludedLabels(balanceMap);
  const missing = [];
  for (const posted of (proposedOpening && proposedOpening.posted) || []) {
    if (!posted || !posted.locator) {
      missing.push({ locator: null, reason: 'missing-locator' });
      continue;
    }
    const mapping = Household.mappingForLocator(balanceMap, posted.locator);
    if (!mapping || !mapping.accountLabel) {
      missing.push({ locator: posted.locator, reason: 'unmapped-required-account' });
      continue;
    }
    if (excluded.has(mapping.accountLabel)) {
      missing.push({ locator: posted.locator, reason: 'excluded-required-account' });
    }
  }
  return missing;
}

function inspectSameDateHousehold(csvText, requestedAsOf, proposedOpening, balanceMap) {
  const rows = S.parsePositions(csvText);
  const household = rows.filter(row => row.entity === 'Household');
  const missingIncumbent = [];
  const missingSameDate = [];
  const conflicting = [];
  let matching = 0;
  for (const posted of (proposedOpening && proposedOpening.posted) || []) {
    const mapping = Household.mappingForLocator(balanceMap, posted.locator);
    if (!mapping || !mapping.accountLabel) continue;
    const pos = household.find(row => row.account_label === mapping.accountLabel);
    if (!pos) {
      missingIncumbent.push(mapping.accountLabel);
      continue;
    }
    if (pos.as_of !== requestedAsOf) {
      missingSameDate.push(mapping.accountLabel);
      continue;
    }
    if (!near(Number(pos.balance), posted.proposedValue)) {
      conflicting.push(mapping.accountLabel);
      continue;
    }
    matching += 1;
  }
  return { matching, missingIncumbent, missingSameDate, conflicting };
}

function recoveryArtifactProposal(constructed, incumbentCsv, snapshotDir) {
  if (!constructed || constructed.positionsText == null || !constructed.snapshot || !constructed.snapshot.asOf) {
    return null;
  }
  const snapshotDest = snapshotDir ? path.join(snapshotDir, `${constructed.snapshot.asOf}.json`) : null;
  return {
    proposedPositionsSha256: sha256Bytes(Buffer.from(constructed.positionsText, 'utf8')),
    proposedSnapshotSha256: sha256Bytes(Buffer.from(S.encodeSnapshot(constructed.snapshot), 'utf8')),
    snapshotPreState: snapshotDest && fs.existsSync(snapshotDest) ? 'present' : 'absent',
    positionsNeeded: normalizeNewlines(constructed.positionsText) !== normalizeNewlines(incumbentCsv),
  };
}

function recoveryFingerprint(cutover, balanceMap, canonicalSha256, artifactProposal) {
  const proposal = (cutover && cutover.proposedOpening) || {};
  const artifacts = artifactProposal || {};
  return {
    schema: ARTIFACT_RECOVERY_SCHEMA,
    requestedAsOf: cutover && cutover.requestedAsOf ? cutover.requestedAsOf : null,
    currentMetaAsOf: cutover && cutover.currentMetaAsOf ? cutover.currentMetaAsOf : null,
    currentOpeningAsOf: cutover && cutover.currentOpeningAsOf ? cutover.currentOpeningAsOf : null,
    canonicalSha256: canonicalSha256 || null,
    writesCanonicalState: false,
    posted: (proposal.posted || []).slice().sort(sortByLocator).map(row => ({
      locator: row.locator,
      currentValue: row.currentValue,
      observedValue: row.proposedValue,
      evidenceDate: row.evidenceDate || null,
      freshnessBasis: row.freshnessBasis || null,
      reconcileStatus: row.reconcileStatus || null,
    })),
    pending: (proposal.pending || []).slice().sort(sortByLocator).map(row => ({
      locator: row.locator,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      evidenceDate: row.evidenceDate || null,
      proof: row.proof || null,
      kind: row.kind || null,
    })),
    representedEvents: (proposal.representedEvents || []).slice().sort(sortRepresented).map(copyOpeningRepresentation),
    routing: openingRoutingFingerprint(balanceMap),
    artifacts: {
      surfaces: ['positions.csv', 'snapshots/<date>.json'],
      proposedPositionsSha256: artifacts.proposedPositionsSha256 || null,
      proposedSnapshotSha256: artifacts.proposedSnapshotSha256 || null,
      snapshotPreState: artifacts.snapshotPreState || null,
      positionsNeeded: artifacts.positionsNeeded === true,
    },
  };
}

function recoveryApprovalIdFrom(cutover, balanceMap, canonicalSha256, artifactProposal) {
  return crypto.createHash('sha256').update(JSON.stringify(recoveryFingerprint(cutover, balanceMap, canonicalSha256, artifactProposal))).digest('hex');
}

function blockedRecovery(cutover, extra) {
  const recovery = Object.assign({
    schema: ARTIFACT_RECOVERY_SCHEMA,
    inspected: false,
    sameDateOpening: false,
    postedAllMatch: false,
    pendingAllMatch: false,
    pendingCensusComplete: false,
    missingSameDateHousehold: false,
    missingSnapshot: false,
    positionsNeeded: false,
    snapshotNeeded: false,
    alreadyComplete: false,
    supported: false,
    recoveryApprovalId: null,
    canonicalSha256: null,
    status: 'BLOCKED',
    blockers: [],
    writesCanonicalState: false,
  }, extra || {});
  cutover.artifactRecovery = recovery;
  return recovery;
}

function attachOpeningArtifactRecovery(cutover, data, report, opts) {
  const blockers = [];
  const sameDate = !!(cutover
    && cutover.requestedAsOf
    && cutover.currentOpeningAsOf
    && cutover.currentMetaAsOf
    && cutover.requestedAsOf === cutover.currentOpeningAsOf
    && cutover.currentMetaAsOf === cutover.currentOpeningAsOf);
  if (!sameDate) {
    return blockedRecovery(cutover, {
      inspected: true,
      sameDateOpening: false,
      status: 'NOT_APPLICABLE',
      blockers: [issue(
        'recovery-not-same-date-opening',
        'Artifact recovery is only for an already-approved same-date canonical opening. It cannot advance or replace the opening.'
      )],
    });
  }

  const postedAllMatch = postedStatesAllMatch(cutover.accountFreshness);
  const pendingAllMatch = pendingStatesAllMatch(cutover);
  const censusComplete = pendingCensusCompleteForRecovery(cutover, report);
  if ((cutover.blockers || []).length || cutover.status === 'BLOCKED') {
    pushUnique(blockers, issue(
      'recovery-opening-blocked',
      'The same-date observation packet is not a clean MATCH diagnostic. Recovery cannot reconstruct artifacts from blocked evidence.'
    ));
  }
  if (!postedAllMatch) {
    pushUnique(blockers, issue(
      'recovery-posted-not-match',
      'Every required posted value must MATCH the surviving canonical opening before artifact recovery is allowed.'
    ));
  }
  if (!pendingAllMatch || (cutover.pendingTransitions && cutover.pendingTransitions.length)) {
    pushUnique(blockers, issue(
      'recovery-pending-not-match',
      'Every mapped revolving pending state must MATCH the surviving canonical opening. Recovery cannot write pending or invent UNKNOWN as zero.'
    ));
  }
  if (!censusComplete) {
    pushUnique(blockers, issue(
      'recovery-pending-census-incomplete',
      'Pending census is incomplete. Recovery requires proven candidate-date pending evidence, including is_pending-unbounded coverage for zero.'
    ));
  }
  if (unknownPendingBlocksOpening(cutover)) {
    pushUnique(blockers, issue(
      'recovery-pending-unknown',
      'UNKNOWN pending remains. Recovery cannot reconstruct Household pending evidence from an unknown census.'
    ));
  }

  const balanceMap = opts && opts.balanceMap;
  const mappingGaps = requiredPostedMappingGaps(cutover.proposedOpening, balanceMap);
  for (const gap of mappingGaps) {
    pushUnique(blockers, issue(
      gap.reason === 'excluded-required-account' ? 'recovery-excluded-required-account' : 'unmapped-required-account',
      `Required opening locator ${gap.locator || '(missing)'} has no usable Household mapping.`,
      { locator: gap.locator }
    ));
  }

  if (!opts || !opts.positionsPath || !opts.snapshotDir) {
    pushUnique(blockers, issue(
      'missing-recovery-artifact-paths',
      'Recovery cannot inspect or write positions.csv and snapshots without explicit artifact paths. It does not infer those artifacts from data.json.'
    ));
    return blockedRecovery(cutover, {
      inspected: false,
      sameDateOpening: true,
      postedAllMatch,
      pendingAllMatch,
      pendingCensusComplete: censusComplete,
      blockers,
    });
  }

  const canonicalSha256 = opts.canonicalSha256 || canonicalFileSha256(opts.dataPath, data);
  let incumbentCsv;
  try {
    incumbentCsv = fs.readFileSync(opts.positionsPath, 'utf8');
  } catch (err) {
    pushUnique(blockers, issue(
      'missing-recovery-positions',
      `positions.csv is not readable: ${err.message}`
    ));
    return blockedRecovery(cutover, {
      inspected: false,
      sameDateOpening: true,
      postedAllMatch,
      pendingAllMatch,
      pendingCensusComplete: censusComplete,
      canonicalSha256,
      blockers,
    });
  }

  const householdState = inspectSameDateHousehold(
    incumbentCsv,
    cutover.requestedAsOf,
    cutover.proposedOpening,
    balanceMap
  );
  if (householdState.missingIncumbent.length) {
    pushUnique(blockers, issue(
      'missing-incumbent-household-row',
      `No incumbent Household row for ${householdState.missingIncumbent.join(', ')}. Recovery updates captured rows; it does not invent accounts.`
    ));
  }
  if (householdState.conflicting.length) {
    pushUnique(blockers, issue(
      'recovery-positions-conflict',
      `Same-date Household rows already exist and disagree with the MATCH packet for ${householdState.conflicting.join(', ')}.`
    ));
  }

  let constructed = null;
  if (!blockers.length) {
    try {
      constructed = buildOpeningArtifacts(data, { openingCutover: cutover }, {
        positionsPath: opts.positionsPath,
        snapshotDir: opts.snapshotDir,
        balanceMapPath: opts.balanceMapPath,
        periodsPath: opts.periodsPath,
      });
    } catch (err) {
      const message = String(err && err.message || err);
      if (/already exists and disagrees/.test(message)) {
        pushUnique(blockers, issue(
          'recovery-snapshot-conflict',
          `snapshot ${cutover.requestedAsOf} already exists and disagrees with the MATCH packet; refusing to rewrite history.`
        ));
      } else {
        pushUnique(blockers, issue(
          'recovery-construction-failed',
          message
        ));
      }
    }
  }

  const snapshotDest = path.join(opts.snapshotDir, `${cutover.requestedAsOf}.json`);
  const snapshotExists = fs.existsSync(snapshotDest);
  let snapshotAgrees = false;
  if (snapshotExists && constructed) {
    try {
      snapshotAgrees = assertSnapshotInstallable(opts.snapshotDir, constructed.snapshot) === 'unchanged';
    } catch (err) {
      pushUnique(blockers, issue(
        'recovery-snapshot-conflict',
        String(err && err.message || err)
      ));
    }
  }
  const positionsNeeded = !!(constructed
    && normalizeNewlines(constructed.positionsText) !== normalizeNewlines(incumbentCsv));
  const snapshotNeeded = !snapshotExists;
  const alreadyComplete = !!(constructed
    && !positionsNeeded
    && snapshotExists
    && snapshotAgrees
    && householdState.missingSameDate.length === 0
    && householdState.conflicting.length === 0
    && householdState.missingIncumbent.length === 0);

  if (alreadyComplete) {
    cutover.artifactRecovery = {
      schema: ARTIFACT_RECOVERY_SCHEMA,
      inspected: true,
      sameDateOpening: true,
      postedAllMatch,
      pendingAllMatch,
      pendingCensusComplete: censusComplete,
      missingSameDateHousehold: false,
      missingSnapshot: false,
      positionsNeeded: false,
      snapshotNeeded: false,
      alreadyComplete: true,
      supported: false,
      recoveryApprovalId: null,
      canonicalSha256,
      status: 'ALREADY_COMPLETE',
      blockers: [],
      writesCanonicalState: false,
    };
    return cutover.artifactRecovery;
  }

  if (!positionsNeeded && !snapshotNeeded && constructed) {
    pushUnique(blockers, issue(
      'recovery-not-needed',
      'Same-date positions and snapshot already agree with the MATCH packet. Recovery is not a rewrite.'
    ));
  }

  const artifactProposal = constructed
    ? recoveryArtifactProposal(constructed, incumbentCsv, opts.snapshotDir)
    : null;
  const supported = blockers.length === 0
    && postedAllMatch
    && pendingAllMatch
    && censusComplete
    && !!constructed
    && !!artifactProposal
    && !!artifactProposal.proposedPositionsSha256
    && !!artifactProposal.proposedSnapshotSha256
    && (positionsNeeded || snapshotNeeded);

  cutover.artifactRecovery = {
    schema: ARTIFACT_RECOVERY_SCHEMA,
    inspected: true,
    sameDateOpening: true,
    postedAllMatch,
    pendingAllMatch,
    pendingCensusComplete: censusComplete,
    missingSameDateHousehold: householdState.missingSameDate.length > 0,
    missingSnapshot: snapshotNeeded,
    positionsNeeded,
    snapshotNeeded,
    alreadyComplete: false,
    supported,
    recoveryApprovalId: supported
      ? recoveryApprovalIdFrom(cutover, balanceMap, canonicalSha256, artifactProposal)
      : null,
    canonicalSha256,
    status: supported ? 'READY_FOR_OWNER_REVIEW' : 'BLOCKED',
    blockers,
    writesCanonicalState: false,
  };
  return cutover.artifactRecovery;
}

function assertRecoveryMatchesCanonical(data, cutover) {
  if (!cutover || !cutover.proposedOpening) fail('Recovery proposal is missing.');
  if (String(data.meta && data.meta.asOf) !== String(cutover.requestedAsOf)
    || String(data.plan && data.plan.opening && data.plan.opening.asOf) !== String(cutover.requestedAsOf)) {
    fail('Recovery requires the surviving canonical opening to already equal the requested date. Canonical state was not written.');
  }
  for (const change of cutover.proposedOpening.posted || []) {
    if (change.reconcileStatus !== 'MATCH' || !change.freshnessBasis) {
      fail(`Recovery refused posted ${change.locator}: ${change.reconcileStatus || 'missing'} is not a fresh MATCH.`);
    }
    const current = readCurrent(data, change.locator);
    if (!current.found || current.value == null || !near(current.value, change.proposedValue)) {
      fail(`Recovery refused: canonical ${change.locator} does not MATCH observed ${change.proposedValue}.`);
    }
  }
  for (const change of cutover.proposedOpening.pending || []) {
    if (change.kind !== 'match' || change.proposedUnknown === true) {
      fail(`Recovery refused pending ${change.locator}: not a MATCH against the surviving opening.`);
    }
    const current = readCanonicalPending(data, change.id);
    if (!current.found || current.unknown || current.value == null || !near(current.value, change.proposedValue)) {
      fail(`Recovery refused: canonical pending ${change.locator} does not MATCH observed ${change.proposedValue}.`);
    }
  }
}

function installRecoveryArtifacts(artifacts, opts) {
  const originalPositions = fs.readFileSync(opts.positionsPath);
  const snapshotDest = path.join(opts.snapshotDir, `${artifacts.snapshot.asOf}.json`);
  const hadSnapshot = fs.existsSync(snapshotDest);
  const originalSnapshot = hadSnapshot ? fs.readFileSync(snapshotDest) : null;
  try {
    if (opts.writePositions) {
      replaceBytesAtomically(opts.positionsPath, artifacts.positionsText, 'text');
    }
    if (opts.writeSnapshot) {
      S.writeSnapshot(artifacts.snapshot, opts.snapshotDir);
    }
  } catch (err) {
    try { fs.writeFileSync(opts.positionsPath, originalPositions); } catch (_) { /* ignore */ }
    if (hadSnapshot && originalSnapshot) {
      try { fs.writeFileSync(snapshotDest, originalSnapshot); } catch (_) { /* ignore */ }
    } else if (!hadSnapshot && fs.existsSync(snapshotDest)) {
      try { fs.unlinkSync(snapshotDest); } catch (_) { /* ignore */ }
    }
    throw err;
  }
}

function applyRecoveryPreview(data, preview, destPath, originalBytes, opts) {
  const cutover = preview && preview.openingCutover;
  const recovery = cutover && cutover.artifactRecovery;
  if (!preview || preview.schema !== SCHEMA) fail('Preview schema is not the earned refresh preview.');
  if (!cutover) fail('Opening cutover proposal is missing.');
  if (!recovery) fail('Artifact recovery proposal is missing. Pass --recover-opening-artifacts. Canonical state was not written.');
  if (recovery.alreadyComplete === true) {
    fail('Opening artifacts already present and agree with the MATCH packet; recovery will not rewrite them.');
  }
  if (recovery.supported !== true || recovery.status !== 'READY_FOR_OWNER_REVIEW') {
    fail('Artifact recovery is not supported. Canonical state was not written.');
  }
  if ((cutover.blockers || []).length || cutover.status === 'BLOCKED') {
    fail('Same-date observation is blocked. Canonical state was not written.');
  }
  if ((recovery.blockers || []).length) {
    fail('Artifact recovery is blocked. Canonical state was not written.');
  }
  if (!recovery.recoveryApprovalId) fail('Recovery approval is missing.');
  if (!isIsoDate(cutover.requestedAsOf)) fail('Recovery request is missing an explicit YYYY-MM-DD date.');
  if (cutover.requestedAsOf !== cutover.currentOpeningAsOf || cutover.requestedAsOf !== cutover.currentMetaAsOf) {
    fail('Artifact recovery cannot advance or replace the canonical opening. Canonical state was not written.');
  }
  if (!opts || !opts.positionsPath || !opts.snapshotDir || !opts.balanceMapPath) {
    fail('Recovery write requires positions.csv, snapshots directory, and balance-map paths. Canonical state was not written.');
  }
  const currentBalanceMap = loadJson(opts.balanceMapPath);
  const canonicalSha256 = sha256Bytes(originalBytes);
  if (recovery.canonicalSha256 && recovery.canonicalSha256 !== canonicalSha256) {
    fail('Canonical data.json changed since the recovery preview. Canonical state was not written.');
  }
  assertRecoveryMatchesCanonical(data, cutover);
  if (Buffer.compare(fs.readFileSync(destPath), originalBytes) !== 0) {
    fail('Canonical data.json changed before recovery install. Canonical state was not written.');
  }
  const artifacts = buildOpeningArtifacts(data, preview, opts);
  if (artifactsLeakSecrets(Buffer.from(originalBytes).toString('utf8'), artifacts.positionsText, artifacts.snapshot)) {
    fail('Recovery artifacts are not sanitized. Canonical state was not written.');
  }
  const incumbentCsv = fs.readFileSync(opts.positionsPath, 'utf8');
  const artifactProposal = recoveryArtifactProposal(artifacts, incumbentCsv, opts.snapshotDir);
  const recomputed = recoveryApprovalIdFrom(cutover, currentBalanceMap, canonicalSha256, artifactProposal);
  if (!artifactProposal
    || String(recomputed) !== String(recovery.recoveryApprovalId)) {
    fail('Recovery approval fingerprint does not match the surviving opening, MATCH packet, balance-map routing, or the exact proposed recovered artifacts. Canonical state was not written.');
  }
  const positionsNeeded = normalizeNewlines(artifacts.positionsText)
    !== normalizeNewlines(incumbentCsv);
  const snapshotState = assertSnapshotInstallable(opts.snapshotDir, artifacts.snapshot);
  const snapshotNeeded = snapshotState === 'missing';
  if (!positionsNeeded && !snapshotNeeded) {
    fail('Opening artifacts already present and agree with the MATCH packet; recovery will not rewrite them.');
  }
  const installProposal = recoveryArtifactProposal(
    artifacts,
    fs.readFileSync(opts.positionsPath, 'utf8'),
    opts.snapshotDir
  );
  if (!installProposal
    || installProposal.proposedPositionsSha256 !== artifactProposal.proposedPositionsSha256
    || installProposal.proposedSnapshotSha256 !== artifactProposal.proposedSnapshotSha256
    || installProposal.snapshotPreState !== artifactProposal.snapshotPreState) {
    fail('Recovered artifact bytes drifted before install. Canonical state was not written.');
  }
  installRecoveryArtifacts(artifacts, {
    positionsPath: opts.positionsPath,
    snapshotDir: opts.snapshotDir,
    writePositions: positionsNeeded,
    writeSnapshot: snapshotNeeded,
  });
  if (Buffer.compare(fs.readFileSync(destPath), originalBytes) !== 0) {
    fail('Recovery modified data.json. Canonical state was not written.');
  }
  const cash = Forecast.startingCashAmount(data.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the surviving starting cash.');
  return {
    positionsWritten: positionsNeeded,
    snapshotWritten: snapshotNeeded,
    updated: artifacts.updated,
  };
}

function previewFrom(input, opts) {
  const report = O.observe(input);
  const preview = buildPreview(report, { data: input && input.data });
  if (opts && opts.cutoverAsOf) {
    preview.openingCutover = buildOpeningCutover(input.data, report, opts.cutoverAsOf, opts.balanceMap);
    if (opts.recoverOpeningArtifacts) {
      attachOpeningArtifactRecovery(preview.openingCutover, input.data, report, opts);
    }
  }
  if (opts && opts.preservePaydayObservation) {
    preview.paydayAccountObservation = buildPaydayAccountObservationProposal(input.data, report);
  }
  preview.identityProofSanitized = identityProofLooksSanitized(preview);
  if (!preview.identityProofSanitized) fail('Preview is not sanitized.');
  if (Object.prototype.hasOwnProperty.call(preview, 'operatingAnswer')
    || Object.prototype.hasOwnProperty.call(preview, 'paydayAllocation')
    || Object.prototype.hasOwnProperty.call(preview, 'recommend')) {
    fail('Canonical preview must not publish the operating answer.');
  }
  return { report, preview };
}

function attachOperatingAnswer(result, afterData, beforeData, extra) {
  result.operatingAnswer = OA.fromRefreshedState(afterData, Object.assign({
    mode: 'canonical',
    baseline: beforeData,
    writesCanonicalState: result.writesCanonicalState === true,
  }, extra || {}));
  return result;
}

function applyChange(data, change) {
  const parsed = parseLocator(change.locator);
  if (!parsed) fail(`Unsupported locator: ${change.locator}`);
  if (parsed.collection === 'cash' && change.field === 'value' && POSTED_CASH.has(parsed.id)) {
    const row = cashRow(data, parsed.id);
    if (!row) fail(`Missing cash row ${parsed.id}`);
    if (!near(row.value, change.currentValue)) {
      fail(`Stale preview for ${change.locator}: canonical is ${row.value}, preview expected ${change.currentValue}`);
    }
    row.value = round2(change.proposedValue);
    return;
  }
  if (parsed.collection === 'debts' && change.field === 'balance' && !parsed.field) {
    const row = debtRow(data, parsed.id);
    if (!row) fail(`Missing debt row ${parsed.id}`);
    if (!near(row.balance, change.currentValue)) {
      fail(`Stale preview for ${change.locator}: canonical is ${row.balance}, preview expected ${change.currentValue}`);
    }
    row.balance = round2(change.proposedValue);
    return;
  }
  fail(`Refusing write of ${change.locator} field ${change.field}`);
}

function collectNumericState(data) {
  const out = {};
  for (const id of POSTED_CASH) {
    const row = cashRow(data, id);
    if (row) out[`cash:${id}`] = Number(row.value);
  }
  for (const row of data.debts || []) {
    if (row && row.id) out[`debts:${row.id}`] = Number(row.balance);
  }
  return out;
}

function validateApplied(before, after, preview) {
  if (!after || !after.plan || !after.plan.startingCash) fail('Applied document is missing plan.startingCash.');
  if (!Array.isArray(after.debts)) fail('Applied document is missing debts.');
  if (!after.meta || !after.meta.asOf) fail('Applied document is missing meta.asOf.');
  const allowed = new Set((preview.proposed || []).map(row => row.locator));
  const beforeNums = collectNumericState(before);
  const afterNums = collectNumericState(after);
  for (const locator of Object.keys(beforeNums)) {
    if (allowed.has(locator)) continue;
    if (!near(beforeNums[locator], afterNums[locator])) {
      fail(`Unapproved locator changed: ${locator}`);
    }
  }
  for (const change of preview.proposed || []) {
    const got = afterNums[change.locator];
    if (got == null || !near(got, change.proposedValue)) {
      fail(`Approved locator ${change.locator} did not receive ${change.proposedValue}`);
    }
  }
  const cash = Forecast.startingCashAmount(after.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the applied starting cash.');
  if (after.plan.nextDollar && before.plan.nextDollar) {
    if (JSON.stringify(after.plan.nextDollar) !== JSON.stringify(before.plan.nextDollar)) {
      fail('Refresh must not rewrite plan.nextDollar.');
    }
  }
}

function encodeData(data) {
  return `${JSON.stringify(data, null, 4)}\n`;
}

function replaceBytesAtomically(dest, nextBytes, kind) {
  const destPath = path.resolve(dest);
  const tmp = `${destPath}.atlas-refresh-tmp`;
  fs.writeFileSync(tmp, nextBytes, { encoding: 'utf8' });
  try {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (kind === 'json') JSON.parse(fs.readFileSync(tmp, 'utf8'));
    // POSIX rename and Node's Windows MoveFileEx replace dest in one step.
    // If that replace cannot complete, fail closed with dest still intact.
    // Never rename dest aside: a crash between dest→bak and tmp→dest would
    // leave canonical state missing.
    fs.renameSync(tmp, destPath);
    if (kind === 'json') JSON.parse(fs.readFileSync(destPath, 'utf8'));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

function replaceFileAtomically(dest, nextBytes) {
  return replaceBytesAtomically(dest, nextBytes, 'json');
}

// Compare-and-swap guard for every canonical data.json write. The caller
// loaded `data` (and, from run(), the exact `baselineBytes`) before an
// awaited provider fetch. An owner edit that lands during that await must
// never be reverted by replacing the whole file with a clone of the stale
// load. With baseline bytes the current file must be byte-identical; a
// library caller without bytes must still hold a file that parses to the
// loaded document. Either mismatch refuses: nothing is merged or written.
// Kept synchronous and called immediately before the replace so no await
// can separate the check from the swap.
function assertCanonicalUnchanged(destPath, data, baselineBytes) {
  let current;
  try { current = fs.readFileSync(destPath); } catch (_) {
    fail('Canonical data.json could not be re-read before the write. Canonical state was not written.');
  }
  if (baselineBytes != null) {
    if (Buffer.compare(current, Buffer.from(baselineBytes)) !== 0) {
      fail('Canonical data.json changed since it was loaded for this approval. Canonical state was not written; re-run the preview.');
    }
    return;
  }
  let parsed;
  try { parsed = JSON.parse(current.toString('utf8')); } catch (_) {
    fail('Canonical data.json changed since it was loaded for this approval. Canonical state was not written; re-run the preview.');
  }
  if (JSON.stringify(parsed) !== JSON.stringify(data)) {
    fail('Canonical data.json changed since it was loaded for this approval. Canonical state was not written; re-run the preview.');
  }
}

function replaceCanonicalIfUnchanged(destPath, data, baselineBytes, encoded) {
  assertCanonicalUnchanged(destPath, data, baselineBytes);
  replaceFileAtomically(destPath, encoded);
}

function sameResolvedPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (a === b) return true;
  try {
    if (fs.existsSync(a) && fs.existsSync(b)) {
      return fs.realpathSync(a) === fs.realpathSync(b);
    }
  } catch (_) { /* compare resolved paths only */ }
  return false;
}

function resolveOpeningArtifactPaths(args) {
  const dest = path.resolve(args.data);
  const live = sameResolvedPath(dest, DEFAULT_DATA);
  if (live) {
    if (args.positions || args.snapshots || args.balanceMap) {
      fail('Live canonical opening cannot override --positions, --snapshots, or --balance-map. data.json, docs/positions.csv, snapshots/, and docs/reconciliation/balance-map.json are one artifact set. Canonical state was not written.');
    }
    return {
      positionsPath: DEFAULT_POSITIONS,
      snapshotDir: DEFAULT_SNAPSHOTS,
      balanceMapPath: DEFAULT_BALANCE_MAP,
    };
  }
  if (!args.positions || !args.snapshots || !args.balanceMap) {
    fail('Opening apply requires --positions, --snapshots, and --balance-map when --data is not the live canonical file. Canonical state was not written.');
  }
  const positions = path.resolve(args.positions);
  const snapshots = path.resolve(args.snapshots);
  const balanceMap = path.resolve(args.balanceMap);
  if (sameResolvedPath(positions, DEFAULT_POSITIONS)
    || sameResolvedPath(snapshots, DEFAULT_SNAPSHOTS)
    || sameResolvedPath(balanceMap, DEFAULT_BALANCE_MAP)) {
    fail('Non-live opening data cannot target live positions.csv, snapshots/, or balance-map.json. Canonical state was not written.');
  }
  return {
    positionsPath: positions,
    snapshotDir: snapshots,
    balanceMapPath: balanceMap,
  };
}

function openingBalanceMapPath(args) {
  const dest = path.resolve(args.data || DEFAULT_DATA);
  if (sameResolvedPath(dest, DEFAULT_DATA)) return DEFAULT_BALANCE_MAP;
  if (args.balanceMap) return path.resolve(args.balanceMap);
  return null;
}

function loadOpeningBalanceMap(args) {
  const mapPath = openingBalanceMapPath(args);
  if (!mapPath || !fs.existsSync(mapPath)) return { mappings: [], excluded: [] };
  return loadJson(mapPath);
}

function artifactsLeakSecrets(dataText, positionsText, snapshot) {
  const blob = `${dataText}\n${positionsText}\n${JSON.stringify(snapshot || {})}`;
  return /LUNCHMONEY_ACCESS_TOKEN/i.test(blob)
    || /SITE_PASSWORD/i.test(blob)
    || /SESSION_SECRET/i.test(blob)
    || /Bearer\s+\S+/.test(blob)
    || /"providerAccountId"\s*:/.test(blob)
    || /"providerTransactionId"\s*:/.test(blob);
}

function assertSnapshotInstallable(snapshotDir, doc) {
  const dest = path.join(snapshotDir, `${doc.asOf}.json`);
  if (!fs.existsSync(dest)) return 'missing';
  let existing;
  try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
  catch (err) {
    fail(`existing ${path.basename(dest)} is not readable JSON: ${err.message}`);
  }
  if (JSON.stringify(S.publicSnapshot(existing)) === JSON.stringify(S.publicSnapshot(doc))) {
    return 'unchanged';
  }
  fail(`snapshot ${doc.asOf} already exists and disagrees with the current reading; refusing to rewrite history`);
}

function assertOpeningAgreement(nextData, csvText, snapshot, cutover, balanceMap) {
  const rows = S.parsePositions(csvText);
  const excluded = new Set(((balanceMap && balanceMap.excluded) || []).map(row => row && row.accountLabel).filter(Boolean));
  const householdLabels = rows.filter(row => row.entity === 'Household').map(row => row.account_label);
  const duplicate = householdLabels.find((label, idx) => label && householdLabels.indexOf(label) !== idx);
  if (duplicate) fail(`Duplicate Household authority for ${duplicate}. Canonical state was not written.`);
  for (const posted of cutover.proposedOpening.posted || []) {
    const mapping = Household.mappingForLocator(balanceMap, posted.locator);
    if (!mapping) fail(`Approved posted ${posted.locator} lost its balance-map mapping during agreement.`);
    if (excluded.has(mapping.accountLabel)) {
      fail(`Excluded account ${mapping.accountLabel} participated in the opening. Canonical state was not written.`);
    }
    const pos = rows.find(row => row.entity === 'Household' && row.account_label === mapping.accountLabel);
    if (!pos) fail(`Missing Household row for ${mapping.accountLabel} after construction.`);
    if (pos.as_of !== cutover.requestedAsOf) {
      fail(`Household ${mapping.accountLabel} as_of is ${pos.as_of}, not ${cutover.requestedAsOf}.`);
    }
    if (!near(Number(pos.balance), posted.proposedValue)) {
      fail(`Household ${mapping.accountLabel} ${pos.balance} disagrees with approved posted ${posted.proposedValue}.`);
    }
    const snap = (snapshot.accounts || []).find(row => row.id === mapping.canonical.id);
    if (!snap) fail(`Snapshot omitted approved opening account ${mapping.canonical.id}.`);
    if (!near(snap.balance, posted.proposedValue)) {
      fail(`Snapshot ${mapping.canonical.id} disagrees with approved posted ${posted.proposedValue}.`);
    }
  }
}

function buildOpeningArtifacts(nextData, preview, opts) {
  if (!opts || !opts.positionsPath || !opts.snapshotDir || !opts.balanceMapPath) {
    fail('Opening write requires positions.csv, snapshots directory, and balance-map paths. Canonical state was not written.');
  }
  const cutover = preview.openingCutover;
  const incumbentCsv = fs.readFileSync(opts.positionsPath, 'utf8');
  const balanceMap = loadJson(opts.balanceMapPath);
  const household = Household.applyApprovedHouseholdRows({
    csvText: incumbentCsv,
    balanceMap,
    proposedOpening: cutover.proposedOpening,
    requestedAsOf: cutover.requestedAsOf,
    nextData,
  });
  const computed = POS.regenerateComputedRows(nextData, household.text, {
    periodsPath: opts.periodsPath,
    periods: (nextData.plan && nextData.plan.budget) ? undefined : null,
  });
  const snapshot = S.buildSnapshot(nextData, S.parsePositions(computed.text), balanceMap);
  if (!snapshot.accounts || !snapshot.accounts.length) {
    fail(`no same-date accounts for ${cutover.requestedAsOf}; refusing an empty snapshot`);
  }
  assertSnapshotInstallable(opts.snapshotDir, snapshot);
  assertOpeningAgreement(nextData, computed.text, snapshot, cutover, balanceMap);
  const encoded = encodeData(nextData);
  if (artifactsLeakSecrets(encoded, computed.text, snapshot)) {
    fail('Opening artifacts are not sanitized. Canonical state was not written.');
  }
  return {
    encodedData: encoded,
    positionsText: computed.text,
    snapshot,
    updated: household.updated,
    incumbentCsv,
  };
}

function restoreOpeningInstall(destPath, originalData, positionsPath, originalPositions) {
  try { if (originalData) fs.writeFileSync(destPath, originalData); } catch (_) { /* ignore */ }
  try { if (originalPositions) fs.writeFileSync(positionsPath, originalPositions); } catch (_) { /* ignore */ }
}

function installOpeningArtifacts(destPath, artifacts, opts) {
  const originalData = fs.readFileSync(destPath);
  const originalPositions = fs.readFileSync(opts.positionsPath);
  try {
    replaceFileAtomically(destPath, artifacts.encodedData);
    replaceBytesAtomically(opts.positionsPath, artifacts.positionsText, 'text');
    S.writeSnapshot(artifacts.snapshot, opts.snapshotDir);
  } catch (err) {
    restoreOpeningInstall(destPath, originalData, opts.positionsPath, originalPositions);
    throw err;
  }
}

function readCanonicalPending(data, id) {
  const row = debtRow(data, id);
  if (!row) return { found: false, unknown: false, value: null, limit: null, balance: null };
  const unknown = row.pendingUnknown === true || row.unknownPending === true;
  const known = !unknown && row.pending != null && row.pending !== '' && isFinite(Number(row.pending));
  return {
    found: true,
    unknown,
    value: known ? Number(row.pending) : null,
    limit: row.limit == null || row.limit === '' ? null : Number(row.limit),
    balance: row.balance == null || row.balance === '' ? null : Number(row.balance),
  };
}

function applyPendingChange(data, change) {
  const parsed = parseLocator(change && change.locator);
  if (!parsed || parsed.collection !== 'debts' || parsed.field !== 'pending' || change.field !== 'pending') {
    fail(`Refusing pending write of ${change && change.locator} field ${change && change.field}`);
  }
  const row = debtRow(data, parsed.id);
  if (!row) fail(`Missing debt row ${parsed.id}`);
  if (row.secured !== false) fail(`Pending write refused for secured debt ${parsed.id}`);
  if (!hasPendingState(row)) fail(`Pending write refused for debt without pending state ${parsed.id}`);
  const current = readCanonicalPending(data, parsed.id);
  if (change.currentUnknown === true) {
    if (!current.unknown) {
      fail(`Stale cutover pending preview for ${change.locator}: canonical is no longer UNKNOWN`);
    }
  } else {
    if (current.unknown) {
      fail(`Stale cutover pending preview for ${change.locator}: canonical became UNKNOWN`);
    }
    if (current.value == null || !near(current.value, change.currentValue)) {
      fail(`Stale cutover pending preview for ${change.locator}: canonical is ${current.value}, preview expected ${change.currentValue}`);
    }
  }
  if (change.proposedValue == null || !isFinite(Number(change.proposedValue))) {
    fail(`Pending write refused unknown proposed value for ${change.locator}`);
  }
  row.pending = round2(change.proposedValue);
  row.pendingUnknown = false;
  if (Object.prototype.hasOwnProperty.call(row, 'unknownPending')) row.unknownPending = false;
}

function collectPendingNumericState(data) {
  const out = {};
  for (const row of data.debts || []) {
    if (!row || !row.id || !hasPendingState(row)) continue;
    const current = readCanonicalPending(data, row.id);
    out[`debts:${row.id}#pending`] = {
      unknown: current.unknown,
      value: current.unknown ? null : current.value,
      limit: current.limit,
      balance: current.balance,
    };
  }
  return out;
}

function validatePendingApplied(before, after, preview) {
  if (!after || !after.plan || !after.plan.startingCash) fail('Applied document is missing plan.startingCash.');
  if (!Array.isArray(after.debts)) fail('Applied document is missing debts.');
  if (!after.meta || !after.meta.asOf) fail('Applied document is missing meta.asOf.');
  if (String(after.meta.asOf) !== String(before.meta.asOf)) fail('Pending write must not move meta.asOf.');
  const beforeOpening = before.plan.opening && before.plan.opening.asOf;
  const afterOpening = after.plan.opening && after.plan.opening.asOf;
  if (String(afterOpening) !== String(beforeOpening)) fail('Pending write must not move plan.opening.asOf.');
  if (JSON.stringify(after.plan.opening && after.plan.opening.representedEvents)
    !== JSON.stringify(before.plan.opening && before.plan.opening.representedEvents)) {
    fail('Pending write must not rewrite representedEvents.');
  }
  if (after.plan.nextDollar && before.plan.nextDollar
    && JSON.stringify(after.plan.nextDollar) !== JSON.stringify(before.plan.nextDollar)) {
    fail('Pending write must not rewrite plan.nextDollar.');
  }
  const allowed = new Set((preview.openingCutover.pendingTransitions || []).map(row => row.locator));
  const beforePosted = collectNumericState(before);
  const afterPosted = collectNumericState(after);
  for (const locator of Object.keys(beforePosted)) {
    if (!near(beforePosted[locator], afterPosted[locator])) {
      fail(`Unapproved locator changed: ${locator}`);
    }
  }
  const beforePending = collectPendingNumericState(before);
  const afterPending = collectPendingNumericState(after);
  for (const locator of Object.keys(beforePending)) {
    const prev = beforePending[locator];
    const next = afterPending[locator];
    if (!next) fail(`Pending locator disappeared: ${locator}`);
    if (prev.limit != null && next.limit != null && !near(prev.limit, next.limit)) {
      fail(`Pending write must not change limit on ${locator}`);
    }
    if (allowed.has(locator)) continue;
    if (prev.unknown !== next.unknown || (prev.value == null ? next.value != null : !near(prev.value, next.value))) {
      fail(`Unapproved pending locator changed: ${locator}`);
    }
  }
  for (const change of preview.openingCutover.pendingTransitions || []) {
    const got = afterPending[change.locator];
    if (!got || got.unknown || got.value == null || !near(got.value, change.proposedValue)) {
      fail(`Approved pending locator ${change.locator} did not receive ${change.proposedValue}`);
    }
  }
  const cash = Forecast.startingCashAmount(after.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the applied starting cash.');
  const used = Forecast.utilisation(after.debts, null, after.plan);
  if (!used || !Array.isArray(used.rows)) fail('Forecast cannot consume the applied debt pending state.');
}

function applyPendingPreview(data, preview, destPath, baselineBytes) {
  const cutover = preview && preview.openingCutover;
  if (!preview || preview.schema !== SCHEMA) fail('Preview schema is not the earned refresh preview.');
  if (!cutover || cutover.writesOpening === true) fail('Opening cutover write is not this approval.');
  if (!cutover.cutoverApprovalId) fail('Cutover pending approval is missing.');
  if (!Array.isArray(cutover.pendingTransitions) || !cutover.pendingTransitions.length) {
    fail('Empty cutover pending proposal cannot authorize a write.');
  }
  const recomputed = cutoverApprovalIdFrom(cutover.requestedAsOf, cutover.pendingTransitions);
  if (String(recomputed) !== String(cutover.cutoverApprovalId)) {
    fail('Cutover approval fingerprint does not match the pending proposal. Canonical state was not written.');
  }
  const next = clone(data);
  for (const change of cutover.pendingTransitions) applyPendingChange(next, change);
  validatePendingApplied(data, next, preview);
  const encoded = encodeData(next);
  JSON.parse(encoded);
  replaceCanonicalIfUnchanged(destPath, data, baselineBytes, encoded);
  const written = loadJson(destPath);
  validatePendingApplied(data, written, preview);
  return written;
}

function unknownPendingBlocksOpening(cutover) {
  return ((cutover && cutover.warnings) || []).some(item => item.code === 'pending-remains-unknown');
}

function validateOpeningApplied(before, after, preview) {
  const cutover = preview && preview.openingCutover;
  const proposal = cutover && cutover.proposedOpening;
  if (!cutover || !proposal) fail('Opening proposal is missing.');
  if (!after || !after.plan || !after.plan.startingCash) fail('Applied document is missing plan.startingCash.');
  if (!Array.isArray(after.debts)) fail('Applied document is missing debts.');
  if (!after.meta || !after.meta.asOf) fail('Applied document is missing meta.asOf.');
  if (!after.plan.opening || !after.plan.opening.asOf) fail('Applied document is missing plan.opening.asOf.');
  if (String(after.meta.asOf) !== String(cutover.requestedAsOf)) {
    fail(`Opening write did not set meta.asOf to ${cutover.requestedAsOf}.`);
  }
  if (String(after.plan.opening.asOf) !== String(cutover.requestedAsOf)) {
    fail(`Opening write did not set plan.opening.asOf to ${cutover.requestedAsOf}.`);
  }
  if (String(after.meta.asOf) !== String(after.plan.opening.asOf)) {
    fail('meta.asOf and plan.opening.asOf must move together.');
  }
  if (after.plan.nextDollar && before.plan.nextDollar
    && JSON.stringify(after.plan.nextDollar) !== JSON.stringify(before.plan.nextDollar)) {
    fail('Opening write must not rewrite plan.nextDollar.');
  }
  const allowedPosted = new Set((proposal.posted || []).map(row => row.locator));
  const beforePosted = collectNumericState(before);
  const afterPosted = collectNumericState(after);
  for (const locator of Object.keys(beforePosted)) {
    if (allowedPosted.has(locator)) continue;
    if (!near(beforePosted[locator], afterPosted[locator])) {
      fail(`Unapproved locator changed: ${locator}`);
    }
  }
  for (const change of proposal.posted || []) {
    const got = afterPosted[change.locator];
    if (got == null || !near(got, change.proposedValue)) {
      fail(`Approved locator ${change.locator} did not receive ${change.proposedValue}`);
    }
  }
  const allowedPending = new Set((proposal.pending || []).map(row => row.locator));
  const beforePending = collectPendingNumericState(before);
  const afterPending = collectPendingNumericState(after);
  for (const locator of Object.keys(beforePending)) {
    const prev = beforePending[locator];
    const next = afterPending[locator];
    if (!next) fail(`Pending locator disappeared: ${locator}`);
    if (prev.limit != null && next.limit != null && !near(prev.limit, next.limit)) {
      fail(`Opening write must not change limit on ${locator}`);
    }
    if (allowedPending.has(locator)) continue;
    if (prev.unknown !== next.unknown || (prev.value == null ? next.value != null : !near(prev.value, next.value))) {
      fail(`Unapproved pending locator changed: ${locator}`);
    }
  }
  for (const change of proposal.pending || []) {
    const got = afterPending[change.locator];
    if (!got || got.unknown || got.value == null || !near(got.value, change.proposedValue)) {
      fail(`Approved pending locator ${change.locator} did not receive ${change.proposedValue}`);
    }
  }
  const expectedEvents = (proposal.representedEvents || []).slice().sort(sortRepresented);
  const gotEvents = ((after.plan.opening && after.plan.opening.representedEvents) || [])
    .map(copyOpeningRepresentation)
    .sort(sortRepresented);
  if (JSON.stringify(gotEvents) !== JSON.stringify(expectedEvents)) {
    fail('representedEvents do not match the approved candidate-date representation.');
  }
  const cash = Forecast.startingCashAmount(after.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the applied starting cash.');
  const used = Forecast.utilisation(after.debts, null, after.plan);
  if (!used || !Array.isArray(used.rows)) fail('Forecast cannot consume the applied debt pending state.');
}

function validatePaydayObservationApplied(before, after, proposal) {
  if (!after || !after.plan || !after.plan.opening) {
    fail('Applied document is missing plan.opening.');
  }
  const beforeOpening = before && before.plan && before.plan.opening && before.plan.opening.asOf;
  const afterOpening = after.plan.opening.asOf;
  if (String(beforeOpening || '') !== String(afterOpening || '')) {
    fail('Payday observation persist must not advance plan.opening.asOf.');
  }
  if (paydayObservationPredatesOpening(proposal, afterOpening)
    || paydayObservationPredatesOpening({
      paydayDate: after.plan.opening.paydayAccountObservations
        && after.plan.opening.paydayAccountObservations.periodStart,
      packet: after.plan.opening.paydayAccountObservations,
    }, afterOpening)) {
    fail('Payday observation evidence predates the current canonical opening. Canonical state was not written.');
  }
  const beforeMeta = before && before.meta && before.meta.asOf;
  const afterMeta = after.meta && after.meta.asOf;
  if (String(beforeMeta || '') !== String(afterMeta || '')) {
    fail('Payday observation persist must not advance meta.asOf.');
  }
  const beforeNums = collectNumericState(before);
  const afterNums = collectNumericState(after);
  for (const locator of Object.keys(beforeNums)) {
    if (!near(beforeNums[locator], afterNums[locator])) {
      fail(`Payday observation persist changed ${locator}.`);
    }
  }
  if (before.plan.nextDollar && after.plan.nextDollar
    && JSON.stringify(after.plan.nextDollar) !== JSON.stringify(before.plan.nextDollar)) {
    fail('Payday observation persist must not rewrite plan.nextDollar.');
  }
  const packet = after.plan.opening.paydayAccountObservations;
  const expected = proposal && proposal.packet;
  if (!packet || !expected) fail('Payday observation packet was not written.');
  if (String(packet.periodStart) !== String(expected.periodStart)
    || String(packet.asOf) !== String(expected.asOf)) {
    fail('Payday observation packet dates do not match the approved proposal.');
  }
  const row = Array.isArray(packet.accounts) ? packet.accounts[0] : null;
  const want = Array.isArray(expected.accounts) ? expected.accounts[0] : null;
  if (!row || !want || String(row.id) !== PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID) {
    fail('Payday observation persist must write canonical chequing-a only.');
  }
  if (!near(row.value, want.value)
    || String(row.evidenceDate) !== String(want.evidenceDate)
    || String(row.temporalClaim) !== PAYDAY_BOUNDARY_TEMPORAL_CLAIM) {
    fail('Payday observation persist did not write the approved chequing-a packet.');
  }
  const cash = Forecast.startingCashAmount(after.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the surviving starting cash.');
}

function applyPaydayObservationPreview(data, preview, destPath, baselineBytes) {
  const proposal = preview && preview.paydayAccountObservation;
  if (!proposal || proposal.schema !== PAYDAY_OBSERVATION_SCHEMA) {
    fail('Payday observation schema is not the earned persist preview.');
  }
  if (!proposal.paydayObservationWriteSupported || !proposal.paydayObservationApprovalId) {
    fail('No payday observation proposal exists to approve. Canonical state was not written.');
  }
  if (!proposal.packet) fail('Payday observation proposal is missing its packet.');
  const openingAsOf = data && data.plan && data.plan.opening && data.plan.opening.asOf;
  if (paydayObservationPredatesOpening(proposal, openingAsOf)) {
    fail('Payday observation evidence predates the current canonical opening. Canonical state was not written.');
  }
  const next = clone(data);
  if (!next.plan) fail('Canonical data is missing plan.');
  next.plan.opening = Object.assign({}, next.plan.opening || {}, {
    paydayAccountObservations: {
      periodStart: String(proposal.packet.periodStart),
      asOf: String(proposal.packet.asOf),
      accounts: [{
        id: PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID,
        value: round2(proposal.packet.accounts[0].value),
        evidenceDate: String(proposal.packet.accounts[0].evidenceDate),
        temporalClaim: PAYDAY_BOUNDARY_TEMPORAL_CLAIM,
        source: proposal.packet.accounts[0].source || 'provider-observation',
      }],
    },
  });
  validatePaydayObservationApplied(data, next, proposal);
  const encoded = encodeData(next);
  JSON.parse(encoded);
  replaceCanonicalIfUnchanged(destPath, data, baselineBytes, encoded);
  const written = loadJson(destPath);
  validatePaydayObservationApplied(data, written, proposal);
  return written;
}

function applyOpeningPreview(data, preview, destPath, opts, baselineBytes) {
  const cutover = preview && preview.openingCutover;
  if (!preview || preview.schema !== SCHEMA) fail('Preview schema is not the earned refresh preview.');
  if (!cutover) fail('Opening cutover proposal is missing.');
  if (cutover.cutoverWriteSupported !== true) fail('Opening cutover write is not supported.');
  if (cutover.status === 'BLOCKED' || (cutover.blockers || []).length) {
    fail('Opening cutover is blocked. Canonical state was not written.');
  }
  if (unknownPendingBlocksOpening(cutover)) {
    fail('UNKNOWN pending blocks the opening write. Canonical state was not written.');
  }
  if (!cutover.openingApprovalId) fail('Opening approval is missing.');
  if (!cutover.proposedOpening) fail('Exact proposed opening is missing.');
  if (!isIsoDate(cutover.requestedAsOf)) fail('Opening request is missing an explicit YYYY-MM-DD date.');
  if (!cutover.currentOpeningAsOf || cutover.requestedAsOf <= cutover.currentOpeningAsOf) {
    fail('Opening cutover must advance the current canonical opening. Canonical state was not written.');
  }
  if (!opts || !opts.balanceMapPath) {
    fail('Opening write requires a balance-map path. Canonical state was not written.');
  }
  const currentBalanceMap = loadJson(opts.balanceMapPath);
  const recomputed = openingApprovalIdFrom(cutover, currentBalanceMap);
  if (String(recomputed) !== String(cutover.openingApprovalId)) {
    fail('Opening approval fingerprint does not match the proposed opening or its balance-map routing. Canonical state was not written.');
  }
  if (String(data.meta && data.meta.asOf) !== String(cutover.currentMetaAsOf)
    || String(data.plan && data.plan.opening && data.plan.opening.asOf) !== String(cutover.currentOpeningAsOf)) {
    fail('Current canonical opening changed since preview. Canonical state was not written.');
  }
  assertCanonicalUnchanged(destPath, data, baselineBytes);
  const next = clone(data);
  for (const change of cutover.proposedOpening.posted || []) {
    if (change.proposedValue == null || !isFinite(Number(change.proposedValue))) {
      fail(`Opening write refused unknown proposed posted value for ${change.locator}`);
    }
    if (!change.freshnessBasis) {
      fail(`Opening write refused posted ${change.locator} without an accepted freshness basis.`);
    }
    applyChange(next, {
      locator: change.locator,
      field: change.field,
      currentValue: change.currentValue,
      proposedValue: change.proposedValue,
    });
  }
  for (const change of cutover.proposedOpening.pending || []) {
    applyPendingChange(next, change);
  }
  if (!next.plan.opening || typeof next.plan.opening !== 'object') {
    fail('Canonical plan.opening is missing.');
  }
  next.plan.opening.representedEvents = (cutover.proposedOpening.representedEvents || []).map(copyOpeningRepresentation);
  next.meta.asOf = cutover.requestedAsOf;
  next.plan.opening.asOf = cutover.requestedAsOf;
  validateOpeningApplied(data, next, preview);
  const artifacts = buildOpeningArtifacts(next, preview, opts || {});
  assertCanonicalUnchanged(destPath, data, baselineBytes);
  installOpeningArtifacts(destPath, artifacts, opts || {});
  const written = loadJson(destPath);
  validateOpeningApplied(data, written, preview);
  return written;
}

function assertProposedWritable(preview) {
  const proposed = preview && preview.proposed || [];
  const mechanical = preview && preview.mechanicallyProvable
    ? preview.mechanicallyProvable
    : proposed;
  if (JSON.stringify(proposed) !== JSON.stringify(mechanical)) {
    fail('Proposed writes must equal the mechanically provable set. Canonical state was not written.');
  }
  const blocked = new Set();
  for (const row of [].concat(
    (preview && preview.unresolved) || [],
    (preview && preview.ownerQuestions) || [],
    (preview && preview.unsupported) || []
  )) {
    if (row && row.locator) blocked.add(row.locator);
  }
  for (const change of proposed) {
    if (change && change.locator && blocked.has(change.locator)) {
      fail(`Unresolved or unsupported locator cannot write: ${change.locator}. Canonical state was not written.`);
    }
    if (change && (
      change.field === 'representedEvents'
      || /representedEvents/.test(String(change.locator || ''))
    )) {
      fail('Posted preview cannot authorize representedEvents. Canonical state was not written.');
    }
  }
}

function applyPreview(data, preview, destPath, baselineBytes) {
  if (!preview || preview.schema !== SCHEMA) fail('Preview schema is not the earned refresh preview.');
  if (!preview.previewId) fail('Preview is missing previewId.');
  if ((preview.proposed || []).some(row => row && (row.field === 'pending' || /#pending$/.test(String(row.locator || ''))))) {
    fail('Posted preview cannot authorize pending. Canonical state was not written.');
  }
  if (!Array.isArray(preview.proposed) || !preview.proposed.length) {
    fail('Empty preview cannot authorize a canonical write.');
  }
  assertProposedWritable(preview);
  const requestDay = dateOnly(preview.fetchedAt);
  if (preview.proposed.some(row => {
    const evidenceDate = dateOnly(row && row.evidenceDate);
    return !!(requestDay && evidenceDate && evidenceDate > requestDay);
  })) {
    fail('Preview proposes evidence dated after its request day. Canonical state was not written.');
  }
  const next = clone(data);
  for (const change of preview.proposed) applyChange(next, change);
  validateApplied(data, next, preview);
  const encoded = encodeData(next);
  JSON.parse(encoded);
  replaceCanonicalIfUnchanged(destPath, data, baselineBytes, encoded);
  const written = loadJson(destPath);
  validateApplied(data, written, preview);
  return written;
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/canonical-refresh.js --fixture <file> [--map <file>] [--data <file>]\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --apply --approve <previewId> --data <file>\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --apply --approve-cutover <cutoverApprovalId> --data <file>\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --apply --approve-opening <openingApprovalId> --data <file>\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --recover-opening-artifacts\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --cutover-as-of YYYY-MM-DD --recover-opening-artifacts --apply --approve-recovery <recoveryApprovalId> --data <file>\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --preserve-payday-observation\n'
      + '       node scripts/canonical-refresh.js --fixture <file> --preserve-payday-observation --apply --approve-payday-observation <paydayObservationApprovalId> --data <file>\n'
      + 'Default is a non-writing preview. --apply --approve writes posted fields only.\n'
      + 'The preview consumes the trusted obligation-reconciliation receipt when present.\n'
      + 'Unresolved, owner-fact, and unsupported rows cannot write.\n'
      + '--cutover-as-of without an opening, pending, or recovery approval is read-only.\n'
      + '--preserve-payday-observation without --apply is read-only. It writes only plan.opening.paydayAccountObservations after --approve-payday-observation.\n'
      + 'previewId cannot authorize pending, an opening, recovery, or a payday observation persist.\n'
      + 'An approved opening also writes same-date Household positions and snapshots/<date>.json.\n'
      + 'Recovery reconstructs missing same-date positions and snapshot only. It never writes data.json.\n'
    );
    return 0;
  }
  if (args.provider !== 'lunchmoney') fail('Only --provider lunchmoney is implemented.');
  const approvalCount = [
    args.approve,
    args.approveCutover,
    args.approveOpening,
    args.approveRecovery,
    args.approvePaydayObservation,
  ].filter(Boolean).length;
  if (approvalCount > 1) {
    fail('Posted, pending, opening, recovery, and payday-observation approvals cannot be combined. Canonical state was not written.');
  }
  if (args.approvePaydayObservation && !args.preservePaydayObservation) {
    fail('--approve-payday-observation requires --preserve-payday-observation. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.cutoverAsOf) {
    fail('--preserve-payday-observation cannot combine with --cutover-as-of. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.approve) {
    fail('Posted previewId cannot authorize a payday observation persist. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.approveCutover) {
    fail('Pending cutoverApprovalId cannot authorize a payday observation persist. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.approveOpening) {
    fail('Opening approval cannot authorize a payday observation persist. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.approveRecovery) {
    fail('Recovery approval cannot authorize a payday observation persist. Canonical state was not written.');
  }
  if (args.preservePaydayObservation && args.apply && !args.approvePaydayObservation) {
    fail('--preserve-payday-observation is read-only without --approve-payday-observation. Canonical state was not written.');
  }
  if (args.approveRecovery && !args.recoverOpeningArtifacts) {
    fail('--approve-recovery requires --recover-opening-artifacts. Canonical state was not written.');
  }
  if (args.recoverOpeningArtifacts && !args.cutoverAsOf) {
    fail('--recover-opening-artifacts requires --cutover-as-of. Canonical state was not written.');
  }
  if (args.approveCutover && !args.cutoverAsOf) {
    fail('--approve-cutover requires --cutover-as-of. Canonical state was not written.');
  }
  if (args.approveOpening && !args.cutoverAsOf) {
    fail('--approve-opening requires --cutover-as-of. Canonical state was not written.');
  }
  if (args.recoverOpeningArtifacts && args.approve) {
    fail('Posted previewId cannot authorize artifact recovery. Canonical state was not written.');
  }
  if (args.recoverOpeningArtifacts && args.approveOpening) {
    fail('Opening approval cannot authorize artifact recovery. Canonical state was not written.');
  }
  if (args.recoverOpeningArtifacts && args.approveCutover) {
    fail('Pending cutoverApprovalId cannot authorize artifact recovery. Canonical state was not written.');
  }
  if (args.cutoverAsOf && args.approve) {
    fail('--cutover-as-of is read-only for posted previewId. Combining it with --approve is refused. Canonical state was not written.');
  }
  if (args.cutoverAsOf && args.apply && !args.approveCutover && !args.approveOpening && !args.approveRecovery) {
    fail('--cutover-as-of is read-only without --approve-cutover, --approve-opening, or --approve-recovery. Canonical state was not written.');
  }
  if (args.cutoverAsOf && !isIsoDate(args.cutoverAsOf)) {
    fail('--cutover-as-of must be an explicit YYYY-MM-DD date. Do not infer it from fetchedAt.');
  }
  if (args.apply && !args.approve && !args.approveCutover && !args.approveOpening && !args.approveRecovery && !args.approvePaydayObservation) {
    fail('No approval = no canonical write. Pass --approve <previewId>, --approve-cutover <cutoverApprovalId>, --approve-opening <openingApprovalId>, --approve-recovery <recoveryApprovalId>, or --approve-payday-observation <paydayObservationApprovalId>.');
  }
  const needsArtifactPaths = args.recoverOpeningArtifacts
    || (args.apply && args.approveOpening);
  const openingArtifactPaths = (needsArtifactPaths && (
    sameResolvedPath(args.data, DEFAULT_DATA)
    || args.positions
    || args.snapshots
    || args.balanceMap
  ))
    ? resolveOpeningArtifactPaths(args)
    : (args.recoverOpeningArtifacts ? resolveOpeningArtifactPaths(args) : null);
  const originalBytes = fs.readFileSync(args.data);
  const data = JSON.parse(originalBytes.toString('utf8'));
  const payload = await loadPayload(args);
  const mapPath = args.map || O.resolveMapPath({ live: args.live, fixture: args.fixture, map: args.map });
  const accountMap = loadJson(mapPath);
  if (args.live) O.assertLiveMap(accountMap, { data });
  const { preview } = previewFrom(
    observeInput(args, data, payload, accountMap),
    (args.cutoverAsOf || args.preservePaydayObservation) ? {
      cutoverAsOf: args.cutoverAsOf,
      preservePaydayObservation: args.preservePaydayObservation === true,
      balanceMap: openingArtifactPaths
        ? loadJson(openingArtifactPaths.balanceMapPath)
        : (args.cutoverAsOf ? loadOpeningBalanceMap(args) : null),
      recoverOpeningArtifacts: args.recoverOpeningArtifacts === true,
      positionsPath: openingArtifactPaths ? openingArtifactPaths.positionsPath : null,
      snapshotDir: openingArtifactPaths ? openingArtifactPaths.snapshotDir : null,
      balanceMapPath: openingArtifactPaths ? openingArtifactPaths.balanceMapPath : null,
      dataPath: args.data,
      canonicalSha256: sha256Bytes(originalBytes),
    } : undefined
  );
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return 0;
  }
  if (args.approveRecovery) {
    const cutover = preview.openingCutover;
    const recovery = cutover && cutover.artifactRecovery;
    if (recovery && recovery.alreadyComplete === true) {
      fail('Opening artifacts already present and agree with the MATCH packet; recovery will not rewrite them.');
    }
    if (!recovery || !recovery.recoveryApprovalId) {
      fail('No artifact-recovery proposal exists to approve. Canonical state was not written.');
    }
    if (String(args.approveRecovery) === String(preview.previewId)) {
      fail('Posted previewId cannot authorize artifact recovery. Canonical state was not written.');
    }
    if (cutover.cutoverApprovalId && String(args.approveRecovery) === String(cutover.cutoverApprovalId)) {
      fail('Pending cutoverApprovalId cannot authorize artifact recovery. Canonical state was not written.');
    }
    if (cutover.openingApprovalId && String(args.approveRecovery) === String(cutover.openingApprovalId)) {
      fail('Opening approval cannot authorize artifact recovery. Canonical state was not written.');
    }
    if (String(args.approveRecovery) !== String(recovery.recoveryApprovalId)) {
      fail('Recovery approval does not match the recomputed recovery proposal. Canonical state was not written.');
    }
    const applied = applyRecoveryPreview(
      data,
      preview,
      args.data,
      originalBytes,
      openingArtifactPaths || resolveOpeningArtifactPaths(args)
    );
    const afterBytes = fs.readFileSync(args.data);
    if (afterBytes.compare(originalBytes) !== 0) {
      fail('Recovery modified data.json. Canonical state was not written.');
    }
    const result = {
      schema: ARTIFACT_RECOVERY_SCHEMA,
      writesCanonicalState: false,
      canonicalWriteAuthorized: false,
      writesOpening: false,
      writesPositions: applied.positionsWritten === true,
      writesSnapshot: applied.snapshotWritten === true,
      artifactRecoverySupported: true,
      unattended: false,
      productionWrite: false,
      previewId: preview.previewId,
      cutoverApprovalId: cutover.cutoverApprovalId || null,
      openingApprovalId: cutover.openingApprovalId || null,
      recoveryApprovalId: recovery.recoveryApprovalId,
      requestedAsOf: cutover.requestedAsOf,
      canonicalSha256: recovery.canonicalSha256,
      snapshotFollows: SNAPSHOT_COMMAND,
      snapshotRequired: false,
      snapshotWritten: applied.snapshotWritten === true,
      snapshotAsOf: cutover.requestedAsOf,
      byteChange: false,
      note: 'Bounded owner-approved opening-artifact recovery. data.json was not modified. Same-date Household positions and snapshots/<date>.json were reconstructed from the MATCH observation packet. Forecast remains authority. Posted previewId, pending cutoverApprovalId, and openingApprovalId did not authorize this write.',
    };
    attachOperatingAnswer(result, data, data, {
      trustedState: 'canonical-dated-opening',
    });
    if (!identityProofLooksSanitized(result)) fail('Apply result is not sanitized.');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (args.approveOpening) {
    const cutover = preview.openingCutover;
    if (!cutover || !cutover.openingApprovalId) {
      fail('No opening proposal exists to approve. Canonical state was not written.');
    }
    if (String(args.approveOpening) === String(preview.previewId)) {
      fail('Posted previewId cannot authorize an opening write. Canonical state was not written.');
    }
    if (cutover.cutoverApprovalId && String(args.approveOpening) === String(cutover.cutoverApprovalId)) {
      fail('Pending cutoverApprovalId cannot authorize an opening write. Canonical state was not written.');
    }
    if (String(args.approveOpening) !== String(cutover.openingApprovalId)) {
      fail('Opening approval does not match the recomputed opening proposal. Canonical state was not written.');
    }
    applyOpeningPreview(
      data,
      preview,
      args.data,
      openingArtifactPaths || resolveOpeningArtifactPaths(args),
      originalBytes
    );
    const afterBytes = fs.readFileSync(args.data);
    const written = loadJson(args.data);
    const result = {
      schema: OPENING_CUTOVER_SCHEMA,
      writesCanonicalState: true,
      canonicalWriteAuthorized: true,
      writesOpening: true,
      writesPositions: true,
      writesSnapshot: true,
      cutoverWriteSupported: true,
      unattended: false,
      productionWrite: false,
      previewId: preview.previewId,
      cutoverApprovalId: cutover.cutoverApprovalId || null,
      openingApprovalId: cutover.openingApprovalId,
      requestedAsOf: cutover.requestedAsOf,
      previousOpeningAsOf: cutover.currentOpeningAsOf,
      applied: {
        posted: cutover.proposedOpening.posted,
        pending: cutover.proposedOpening.pending,
        representedEvents: cutover.proposedOpening.representedEvents,
        metaAsOf: cutover.requestedAsOf,
        planOpeningAsOf: cutover.requestedAsOf,
      },
      snapshotFollows: SNAPSHOT_COMMAND,
      snapshotRequired: false,
      snapshotWritten: true,
      snapshotAsOf: cutover.requestedAsOf,
      byteChange: afterBytes.compare(originalBytes) !== 0,
      note: 'Bounded owner-approved opening cutover. meta.asOf, plan.opening.asOf, same-date Household positions, derived position rows, and snapshots/<date>.json advanced together. Posted previewId and pending cutoverApprovalId did not authorize this write. The snapshot uses incumbent snapshot-balances semantics; previous dated files were not rewritten. Forecast.recommend on the written opening is the operating answer.',
    };
    attachOperatingAnswer(result, written, data);
    if (!identityProofLooksSanitized(result)) fail('Apply result is not sanitized.');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (args.approveCutover) {
    const cutover = preview.openingCutover;
    if (!cutover || !cutover.cutoverApprovalId) {
      fail('No cutover pending proposal exists to approve. Canonical state was not written.');
    }
    if (String(args.approveCutover) === String(preview.previewId)) {
      fail('Posted previewId cannot authorize a pending write. Canonical state was not written.');
    }
    if (String(args.approveCutover) !== String(cutover.cutoverApprovalId)) {
      fail('Cutover approval does not match the recomputed pending proposal. Canonical state was not written.');
    }
    applyPendingPreview(data, preview, args.data, originalBytes);
    const afterBytes = fs.readFileSync(args.data);
    const written = loadJson(args.data);
    const result = {
      schema: CUTOVER_PENDING_SCHEMA,
      writesCanonicalState: true,
      canonicalWriteAuthorized: true,
      unattended: false,
      productionWrite: false,
      previewId: preview.previewId,
      cutoverApprovalId: cutover.cutoverApprovalId,
      requestedAsOf: cutover.requestedAsOf,
      applied: cutover.pendingTransitions,
      snapshotFollows: SNAPSHOT_COMMAND,
      byteChange: afterBytes.compare(originalBytes) !== 0,
      note: 'Bounded owner-approved pending write. Opening as-of was not advanced. Posted previewId did not authorize this write. Forecast.recommend on the written document is the operating answer.',
    };
    attachOperatingAnswer(result, written, data);
    if (!identityProofLooksSanitized(result)) fail('Apply result is not sanitized.');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (args.approvePaydayObservation) {
    const proposal = preview.paydayAccountObservation;
    if (!proposal || !proposal.paydayObservationApprovalId) {
      fail('No payday observation proposal exists to approve. Canonical state was not written.');
    }
    if (String(args.approvePaydayObservation) === String(preview.previewId)) {
      fail('Posted previewId cannot authorize a payday observation persist. Canonical state was not written.');
    }
    const cutover = preview.openingCutover;
    if (cutover && cutover.cutoverApprovalId
      && String(args.approvePaydayObservation) === String(cutover.cutoverApprovalId)) {
      fail('Pending cutoverApprovalId cannot authorize a payday observation persist. Canonical state was not written.');
    }
    if (cutover && cutover.openingApprovalId
      && String(args.approvePaydayObservation) === String(cutover.openingApprovalId)) {
      fail('Opening approval cannot authorize a payday observation persist. Canonical state was not written.');
    }
    const recovery = cutover && cutover.artifactRecovery;
    if (recovery && recovery.recoveryApprovalId
      && String(args.approvePaydayObservation) === String(recovery.recoveryApprovalId)) {
      fail('Recovery approval cannot authorize a payday observation persist. Canonical state was not written.');
    }
    if (String(args.approvePaydayObservation) !== String(proposal.paydayObservationApprovalId)) {
      fail('Payday observation approval does not match the recomputed proposal. Canonical state was not written.');
    }
    if (String(paydayObservationApprovalIdFrom(proposal)) !== String(proposal.paydayObservationApprovalId)) {
      fail('Payday observation approval does not match the recomputed fingerprint. Canonical state was not written.');
    }
    applyPaydayObservationPreview(data, preview, args.data, originalBytes);
    const afterBytes = fs.readFileSync(args.data);
    const written = loadJson(args.data);
    const result = {
      schema: PAYDAY_OBSERVATION_SCHEMA,
      writesCanonicalState: true,
      canonicalWriteAuthorized: true,
      writesOpening: false,
      writesPositions: false,
      writesSnapshot: false,
      paydayObservationWriteSupported: true,
      unattended: false,
      productionWrite: false,
      previewId: preview.previewId,
      paydayObservationApprovalId: proposal.paydayObservationApprovalId,
      paydayDate: proposal.paydayDate,
      currentOpeningAsOf: proposal.currentOpeningAsOf,
      applied: {
        paydayAccountObservations: proposal.packet,
      },
      snapshotFollows: SNAPSHOT_COMMAND,
      snapshotRequired: false,
      snapshotWritten: false,
      byteChange: afterBytes.compare(originalBytes) !== 0,
      note: 'Bounded owner-approved payday-boundary observation persist. plan.opening.paydayAccountObservations recorded canonical chequing-a posted-balance-observed-on-household-date. Opening as-of, startingCash, positions, and snapshots were not rewritten. Posted previewId, pending cutoverApprovalId, openingApprovalId, and recoveryApprovalId did not authorize this write. Forecast.recommend on the written document is the operating answer.',
    };
    attachOperatingAnswer(result, written, data, {
      trustedState: 'canonical-dated-opening',
    });
    if (!identityProofLooksSanitized(result)) fail('Apply result is not sanitized.');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (String(args.approve) !== String(preview.previewId)) {
    fail('Approval does not match the recomputed preview. Canonical state was not written.');
  }
  applyPreview(data, preview, args.data, originalBytes);
  const afterBytes = fs.readFileSync(args.data);
  const written = loadJson(args.data);
  const result = {
    schema: SCHEMA,
    writesCanonicalState: true,
    canonicalWriteAuthorized: true,
    unattended: false,
    productionWrite: false,
    previewId: preview.previewId,
    applied: preview.proposed,
    snapshotFollows: SNAPSHOT_COMMAND,
    byteChange: afterBytes.compare(originalBytes) !== 0,
    note: 'Bounded owner-approved write. Run node scripts/snapshot-balances.js only after a successful as-of cutover; this slice does not invent history. Forecast.recommend on the written document is the operating answer.',
  };
  attachOperatingAnswer(result, written, data);
  if (!identityProofLooksSanitized(result)) fail('Apply result is not sanitized.');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

const api = {
  SCHEMA,
  CUTOVER_PENDING_SCHEMA,
  OPENING_CUTOVER_SCHEMA,
  ARTIFACT_RECOVERY_SCHEMA,
  PAYDAY_OBSERVATION_SCHEMA,
  PAYDAY_BOUNDARY_TEMPORAL_CLAIM,
  PAYDAY_BOUNDARY_BILLS_ACCOUNT_ID,
  DEFAULT_DATA,
  SNAPSHOT_COMMAND,
  DEFAULT_POSITIONS,
  DEFAULT_SNAPSHOTS,
  DEFAULT_BALANCE_MAP,
  parseArgs,
  parseLocator,
  eligiblePosted,
  proposeFromReport,
  proposePendingTransitions,
  previewIdFrom,
  cutoverApprovalIdFrom,
  openingApprovalIdFrom,
  openingFingerprint,
  openingRoutingFingerprint,
  identityProofLooksSanitized,
  isIsoDate,
  ownerStatementCadence,
  currentStatementCycleStart,
  nextStatementDate,
  statementCadenceAccepts,
  OWNER_STATEMENT_CADENCE,
  FRESHNESS_EXACT_DAY,
  FRESHNESS_STATEMENT_CADENCE,
  requiredPostedLocators,
  buildOpeningCutover,
  buildPreview,
  previewFrom,
  attachOperatingAnswer,
  applyChange,
  applyPendingChange,
  validateApplied,
  validatePendingApplied,
  validateOpeningApplied,
  replaceFileAtomically,
  applyPreview,
  assertCanonicalUnchanged,
  applyPendingPreview,
  applyOpeningPreview,
  applyRecoveryPreview,
  applyPaydayObservationPreview,
  buildPaydayAccountObservationProposal,
  paydayObservationApprovalIdFrom,
  paydayObservationFingerprint,
  attachOpeningArtifactRecovery,
  recoveryApprovalIdFrom,
  recoveryFingerprint,
  recoveryArtifactProposal,
  buildOpeningArtifacts,
  resolveOpeningArtifactPaths,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = api;
}
