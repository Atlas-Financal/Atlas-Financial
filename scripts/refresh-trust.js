'use strict';
/* Household-facing refresh-trust projector.
 *
 * Copies incumbent observation, reconciliation, canonical-preview,
 * live-overlay, and Forecast remaining-claim fields into one sanitized
 * packet the operating surface can render. It does not invent freshness,
 * settlement, financial meaning, or owner policy, and it is not a
 * planner, matcher, or writer.
 *
 *   last observed / reconciled as-of
 *   current / partially-current / attention-needed
 *   unresolved material items
 *   coverage limits that prevent exact claims
 *   whether a canonical proposal is waiting for explicit approval
 *   the smallest genuinely necessary owner question, if one exists
 */

const OA = require('./operating-answer.js');
const O = require('./provider-observe.js');
const C = require('./canonical-refresh.js');

const SCHEMA = 'atlas-refresh-trust/v1';
const DISPLAY_CURRENT = 'current';
const DISPLAY_PARTIAL = 'partially-current';
const DISPLAY_ATTENTION = 'attention-needed';

const OWNER_QUESTION_COPY = Object.freeze({
  'unverified-settlement-owner-fact':
    'Atlas still needs a household fact before treating this modeled item as settled.',
});

const UNRESOLVED_COPY = Object.freeze({
  'ambiguous-evidence-must-not-write':
    'A modeled item has more than one matching observation and was not treated as settled.',
  'unmatched-household-cash':
    'Unmatched household cash movement was not classified into a modeled item.',
  'unverified-settlement-owner-fact':
    'A modeled item remains unverified. That is not a claim it is unpaid.',
});

const FAIL_CLOSED_COPY = Object.freeze({
  'posted-window-truncated':
    'Posted transaction coverage is truncated, so remaining spend cannot be confirmed as complete.',
  'posted-window-unproven':
    'Posted transaction coverage is unproven, so remaining spend cannot be confirmed.',
  'pending-coverage-bounded-window':
    'Pending coverage is not the completed unbounded pending query, so additional unknown pending may exist.',
  'pending-coverage-unproven':
    'Pending coverage is not complete, so additional unknown pending may exist.',
  'required-cash-unobserved':
    'Required spendable-cash accounts were not all observed.',
  'required-cash-balance-unproven':
    'Required spendable-cash balances were not all dated.',
  'required-cash-balance-stale':
    'A required spendable-cash balance is dated before today, so the live balance is not current.',
  'expected-mapped-identity-missing':
    'An expected mapped household account was missing from the observation.',
  'observation-not-ready':
    'The observation was not complete enough to reconcile.',
  'observation-receipt-missing':
    'No trusted observation receipt is available.',
  'reconciliation-receipt-missing':
    'No trusted reconciliation receipt is available.',
  'obligation-reconciliation-not-trusted':
    'Obligation reconciliation is not trusted on this observation.',
  'stale-live-cash-evidence':
    'Live balances were not fresh enough to replace the dated opening.',
  'missing-live-cash-evidence':
    'Required live cash evidence was missing, so the dated opening was kept.',
  'pending-freshness-unproven':
    'Pending freshness was unproven, so the dated opening was kept.',
  'same-day-event-representation-unknown':
    'A same-day paycheck or deposit was not proven posted. Current plan is unavailable; the dated opening is stale.',
  'live-observation-unavailable':
    'Live observation was unavailable, so the dated opening was kept.',
  'provider-unavailable':
    'The provider was unavailable, so the dated opening was kept.',
  'provider-request-timeout':
    'The provider request timed out, so the dated opening was kept.',
  'missing-required-cash-mapping':
    'Live account mapping is incomplete, so the dated opening was kept.',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function overlayOf(data) {
  return data && data.liveOverlay ? data.liveOverlay : null;
}

function observationOf(report) {
  return report && report.observationReceipt ? report.observationReceipt : null;
}

function reconciliationOf(report) {
  return report && report.obligationReconciliationReceipt
    ? report.obligationReconciliationReceipt
    : null;
}

function planLabel(data, id) {
  if (!data || !data.plan || !id) return null;
  const lists = []
    .concat(data.plan.bills || [])
    .concat(data.plan.obligations || [])
    .concat(data.plan.commitments || [])
    .concat(data.plan.income || []);
  const hit = lists.find(row => row && row.id === id);
  return hit && hit.label ? String(hit.label) : null;
}

// Required operating cash observed with a usable value but dated before the
// observation's household day. The dated opening is kept (live-plan refuses
// it), so the page may stay exact, but it is never "current". Unknown rows are
// already reported as unproven; purpose reserves emit no operating rows.
function staleRequiredCash(report, observation) {
  const householdDate = observation && observation.householdDate;
  if (!report || !householdDate) return [];
  const stale = [];
  for (const id of O.REQUIRED_LIVE_CASH_IDS) {
    const row = (report.observations || []).find(o => o && o.canonical
      && o.canonical.collection === 'cash' && String(o.canonical.id) === id
      && o.unknown !== true && o.evidenceValue != null && isFinite(Number(o.evidenceValue)));
    const date = row && String(row.evidenceDate || row.observedAsOf || '').slice(0, 10);
    if (date && date < householdDate) stale.push(id);
  }
  return stale;
}

function observedAsOfFrom(observation, overlay) {
  if (observation && observation.householdDate) return observation.householdDate;
  if (overlay && overlay.observedAsOf) return overlay.observedAsOf;
  return null;
}

function previewFromReport(report, canonical) {
  if (!report || !canonical) return null;
  try {
    return C.buildPreview(report, { data: canonical });
  } catch (err) {
    return null;
  }
}

function operatingLimits(data, opts) {
  try {
    const packet = (opts?.operatingEvaluation || OA).fromRefreshedState(data, {
      mode: (opts && opts.mode) || 'live-overlay',
      writesCanonicalState: false,
    });
    const permission = packet.currentSpendingPermission || {};
    const limits = packet.limitations || {};
    return {
      remainingClaim: limits.remainingClaim || permission.remainingClaim || 'unavailable',
      categoryRemainingClaim: limits.categoryRemainingClaim
        || permission.categoryRemainingClaim
        || null,
      coverage: limits.coverage || null,
      cardPurchaseCoverage: limits.cardPurchaseCoverage || null,
    };
  } catch (err) {
    return {
      remainingClaim: 'unavailable',
      categoryRemainingClaim: null,
      coverage: null,
    };
  }
}

function coverageLimitsFrom(parts) {
  const seen = new Set();
  const out = [];
  function add(id, text) {
    if (!id || !text || seen.has(id) || seen.has(text)) return;
    seen.add(id);
    seen.add(text);
    out.push({ id, text });
  }
  const coverage = parts.coverage;
  if (parts.cardPurchaseCoverage?.status === 'unavailable') {
    add('card-purchase-coverage-unconfirmed', parts.cardPurchaseCoverage.reason);
  }
  if (coverage && coverage.reason) add('forecast-coverage', coverage.reason);
  if (coverage && coverage.status === 'stale') {
    add('forecast-stale', coverage.reason || 'Transaction actuals are not current through the financial as-of.');
  }
  if (coverage && coverage.status === 'incomplete') {
    add('forecast-incomplete', coverage.reason || 'Transaction coverage is incomplete.');
  }
  if (coverage && coverage.status === 'absent') {
    add('forecast-absent', coverage.reason || 'Transaction actuals were not supplied. Current remaining spend cannot be confirmed.');
  }
  if (parts.remainingClaim === 'posted-only') {
    add('posted-only', 'Remaining is based on posted and observed pending only. Additional unknown pending may exist.');
  }
  if (parts.categoryRemainingClaim === 'classified-incomplete') {
    add('classified-incomplete', 'Category allocation is incomplete, so named remaining is not an exact claim.');
  }
  if (parts.staleRequiredCash && parts.staleRequiredCash.length) {
    add('required-cash-balance-stale', FAIL_CLOSED_COPY['required-cash-balance-stale']);
  }
  const observation = parts.observation;
  if (observation && Array.isArray(observation.failClosedReasons)) {
    for (const reason of observation.failClosedReasons) {
      add(reason, FAIL_CLOSED_COPY[reason] || 'Observation coverage is not complete enough to confirm remaining spend.');
    }
  }
  if (observation && observation.pendingTransactionCoverage
    && observation.pendingTransactionCoverage.complete === false
    && parts.remainingClaim !== 'unavailable') {
    add('pending-incomplete', FAIL_CLOSED_COPY['pending-coverage-unproven']);
  }
  const overlay = parts.overlay;
  if (overlay && overlay.applied === false && overlay.reason) {
    add(overlay.reason, FAIL_CLOSED_COPY[overlay.reason]
      || 'Live overlay was not applied. The dated opening remains in force.');
  }
  const reconciliation = parts.reconciliation;
  if (reconciliation && reconciliation.trusted !== true && reconciliation.failClosedKind) {
    add(reconciliation.failClosedKind,
      FAIL_CLOSED_COPY[reconciliation.failClosedKind]
      || FAIL_CLOSED_COPY['obligation-reconciliation-not-trusted']);
  }
  return out;
}

function unresolvedFrom(parts, data) {
  const out = [];
  const preview = parts.preview;
  const rows = preview && Array.isArray(preview.unresolved) ? preview.unresolved : [];
  for (const row of rows) {
    if (!row) continue;
    const kind = row.reason || 'unresolved';
    const label = planLabel(data, row.id);
    const copy = UNRESOLVED_COPY[kind]
      || 'A material observation could not be safely classified.';
    out.push({
      kind,
      id: row.id || null,
      date: row.date || null,
      text: label ? `${label}. ${copy}` : copy,
    });
  }
  const receipt = parts.reconciliation;
  if (receipt && receipt.trusted === true) {
    for (const row of receipt.occurrences || []) {
      if (!row || row.settlement !== 'ambiguous') continue;
      const already = out.some(item => item.id === row.id && item.date === row.date);
      if (already) continue;
      const label = planLabel(data, row.id);
      const copy = UNRESOLVED_COPY['ambiguous-evidence-must-not-write'];
      out.push({
        kind: 'ambiguous-evidence-must-not-write',
        id: row.id || null,
        date: row.date || null,
        text: label ? `${label}. ${copy}` : copy,
      });
    }
    const unmatched = Number(receipt.counts && receipt.counts.unmatchedCashEvidence) || 0;
    if (unmatched > 0 && !out.some(item => item.kind === 'unmatched-household-cash')) {
      out.push({
        kind: 'unmatched-household-cash',
        id: null,
        date: null,
        text: unmatched === 1
          ? UNRESOLVED_COPY['unmatched-household-cash']
          : `${unmatched} unmatched household cash movements were not classified into modeled items.`,
      });
    }
  }
  return out;
}

function ownerQuestionFrom(parts, data) {
  const questions = (parts.preview && parts.preview.ownerQuestions) || [];
  if (!questions.length) return null;
  const row = questions[0];
  if (!row) return null;
  const label = planLabel(data, row.id);
  const copy = OWNER_QUESTION_COPY[row.reason]
    || 'Atlas still needs a household fact to finish reconciliation.';
  return {
    id: row.id || null,
    date: row.date || null,
    reason: row.reason || null,
    text: label ? `${copy} ${label}.` : copy,
  };
}

function displayStateFrom(parts) {
  const remaining = parts.remainingClaim || 'unavailable';
  const coverage = parts.coverage || {};
  const overlay = parts.overlay;
  const observation = parts.observation;
  const reconciliation = parts.reconciliation;
  const unresolved = parts.unresolvedMaterial || [];
  const attention = remaining === 'unavailable'
    || parts.cardPurchaseCoverage?.status === 'unavailable'
    || coverage.status === 'stale'
    || coverage.status === 'incomplete'
    || coverage.status === 'absent'
    || (overlay && overlay.applied === false)
    || (observation && observation.readyForReconciliation === false)
    || (observation && reconciliation && observation.readyForReconciliation === true
      && reconciliation.trusted !== true)
    || unresolved.some(item => item.kind === 'ambiguous-evidence-must-not-write')
    || (reconciliation && Number(reconciliation.counts && reconciliation.counts.ambiguous) > 0);
  if (attention) return DISPLAY_ATTENTION;
  const partial = remaining === 'posted-only'
    || (parts.staleRequiredCash && parts.staleRequiredCash.length > 0)
    || parts.categoryRemainingClaim === 'classified-incomplete'
    || unresolved.length > 0
    || (observation && observation.pendingTransactionCoverage
      && observation.pendingTransactionCoverage.complete === false)
    || (reconciliation && Number(reconciliation.counts && reconciliation.counts.unverified) > 0);
  if (partial) return DISPLAY_PARTIAL;
  return DISPLAY_CURRENT;
}

function looksSanitized(packet) {
  const blob = JSON.stringify(packet == null ? {} : packet);
  return O.identityProofLooksSanitized(packet)
    && !/"payee"\s*:/.test(blob)
    && !/"original_name"\s*:/.test(blob)
    && !/"observationId"\s*:/.test(blob)
    && !/"status"\s*:\s*"(MATCH|CHANGE|CONFLICT|MISSING|STALE)"/.test(blob)
    && !/"evidenceValue"\s*:/.test(blob)
    && !/"reconciliation"\s*:/.test(blob)
    && !/"recommend"\s*:/.test(blob)
    && !/"safeToSpend"\s*:/.test(blob)
    && !/"weeklyCap"\s*:/.test(blob)
    && !/"spendPermission"\s*:/.test(blob)
    && !/"providerAccountId"\s*:/.test(blob)
    && !/"providerTransactionId"\s*:/.test(blob)
    && !/"mechanicallyProvable"\s*:/.test(blob)
    && !/"proposedValue"\s*:/.test(blob)
    && !/"currentValue"\s*:/.test(blob);
}

function fromIncumbent(opts) {
  opts = opts || {};
  const data = opts.data;
  const canonical = opts.canonical || data;
  const report = opts.report || null;
  const overlay = overlayOf(data);
  const observation = observationOf(report);
  const reconciliation = reconciliationOf(report);
  const preview = opts.preview || previewFromReport(report, canonical);
  const limits = operatingLimits(data, opts);
  const remainingClaim = limits.remainingClaim || 'unavailable';
  const parts = {
    overlay,
    observation,
    reconciliation,
    preview,
    remainingClaim,
    categoryRemainingClaim: limits.categoryRemainingClaim,
    cardPurchaseCoverage: limits.cardPurchaseCoverage,
    coverage: limits.coverage,
  };
  parts.unresolvedMaterial = unresolvedFrom(parts, data);
  parts.staleRequiredCash = staleRequiredCash(report, observation);
  const observedAsOf = observedAsOfFrom(observation, overlay);
  const reconciledAsOf = (reconciliation && reconciliation.trusted === true
    && (reconciliation.asOf || reconciliation.householdDate))
    || null;
  const proposedCount = preview && Array.isArray(preview.mechanicallyProvable)
    ? preview.mechanicallyProvable.length
    : 0;
  const overlayAttempted = !!(overlay || report);
  const packet = {
    schema: SCHEMA,
    source: 'incumbent-observation-reconciliation-forecast',
    writesCanonicalState: false,
    displayState: null,
    observedAsOf: observedAsOf || null,
    reconciledAsOf,
    remainingClaim,
    categoryRemainingClaim: limits.categoryRemainingClaim,
    exactFiguresAvailable: remainingClaim !== 'unavailable'
      && parts.cardPurchaseCoverage?.status !== 'unavailable',
    coverageLimits: coverageLimitsFrom(parts),
    unresolvedMaterial: parts.unresolvedMaterial,
    canonicalProposalWaiting: proposedCount > 0,
    canonicalProposalCount: proposedCount,
    ownerQuestion: ownerQuestionFrom(parts, data),
    observationReady: observation ? observation.readyForReconciliation === true : null,
    overlayApplied: overlay ? overlay.applied === true : null,
    refreshPath: overlayAttempted ? 'on-demand-reload' : 'dated-opening',
  };
  packet.displayState = displayStateFrom(Object.assign({}, parts, {
    unresolvedMaterial: packet.unresolvedMaterial,
  }));
  if (!looksSanitized(packet)) {
    const err = new Error('Refresh-trust packet is not sanitized.');
    err.code = 'refresh-trust-unsanitized';
    throw err;
  }
  return packet;
}

function attachTo(data, opts) {
  const next = data || {};
  next.refreshTrust = fromIncumbent(Object.assign({}, opts || {}, { data: next }));
  return next;
}

const api = {
  SCHEMA,
  DISPLAY_CURRENT,
  DISPLAY_PARTIAL,
  DISPLAY_ATTENTION,
  fromIncumbent,
  attachTo,
  looksSanitized,
};

if (require.main === module) {
  process.stderr.write(
    'scripts/refresh-trust.js is a household-facing projector used by live-plan. It is not a CLI.\n'
  );
  process.exit(1);
} else {
  module.exports = api;
}
