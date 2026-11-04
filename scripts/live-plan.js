'use strict';
/* Read-only live plan overlay.
 *
 * Lunch Money observation → reconcile → in-memory current account state
 * → Forecast. Historical openings and snapshots stay on disk. When a
 * trusted overlay advances past a Seaspan payday, the in-memory opening
 * retains paydaySnapshot from Forecast.establishPaydaySnapshot on the
 * pre-overlay dated plan only when that figure is a recorded snapshot
 * or a completeness-proven household-cash walk. When the observation
 * household date is that payday, or the canonical opening as-of is that
 * payday, live-plan also retains Forecast.paydayBoundaryAccountObservation
 * for canonical chequing-a. That packet is posted-balance-observed-on-
 * household-date, not payday-morning opening, not pooled A+B, and not a
 * canonical write. The walk evidence is
 * the incumbent sanitized currentPeriodActuals packet, passed as
 * paydayGapCash. provider-observe earns paydayGapComplete from
 * opening-to-payday household-cash coverage; a paginated-complete
 * current-period window is not gap completeness. Scheduled-only
 * reconstruction is not retained. Missing, truncated, unattested,
 * or incomplete gap coverage withholds the opening. That is not
 * today's live cash walked backward. On a Dale/Seaspan payday, before
 * posted chequing-a is replaced, live-plan also retains
 * plan.opening.prePaydayBillsBase from Forecast.prePaydayBillsAccountCash
 * on that same pre-overlay plan. Incomplete gap-day coverage stores
 * nothing. That retain is the immediately pre-payday BILLS stock, in
 * memory only: not today's refreshed balance, not a new cash store,
 * and not a canonical write.
 * This command never writes data.json, positions.csv, or snapshots/.
 *
 *   node scripts/live-plan.js --fixture <file>
 *   node scripts/live-plan.js --live
 *
 * Overlay is today's live plan only: posted household-cash and debt
 * balances, plus revolving pending, plus an in-memory Forecast start
 * equal to a freshness-qualified observation date. fetchedAt alone
 * does not advance that start. MATCH is not freshness: required
 * spendable cash identities need acceptable evidence for the live
 * date, and required revolving pending must be known/current, or the
 * overlay fails closed and keeps the dated opening. Freshness-qualified
 * posted cash is still attached as sanitized liveOverlay.observedCash
 * so current chequing availability can report without rewriting the
 * Forecast opening. Owner policy,
 * bills, income rules, and commitments stay on canonical Atlas data.
 * Same-day CHANGE may overlay a current observation; that is not a
 * canonical write. Scheduled joint-cash occurrences in
 * (historicalOpeningAsOf, liveAsOf] are accounted for before as-of
 * advances: posting/representation evidence names them on in-memory
 * representedEvents. Existing opening names that still qualify as
 * in-window, carried-once, or prepaid for the new liveAsOf are merged
 * into that list; identity rediscovery stays additive. A duplicate
 * id/date prefers currently applicable proof over an inactive deferred
 * or invalid entry and retains the earlier truthful qualification.
 * Unrepresented
 * joint-cash outflows stay reserved
 * via plan.opening.priorAsOf so Forecast does not drop them.
 * Unrepresented recurring card-paid reserved bills use that same
 * priorAsOf carry boundary as reserved gravity; they do not become
 * joint-cash withdrawals. Any once
 * joint-cash occurrence still carried as unresolved remains eligible
 * for identity-based settlement lookup even when its permitted posting
 * date has aged out of the ordinary 14-day current-state transaction
 * window; the live fetch then extends that same posted window back to
 * the oldest still-carried occurrence plus its permitted posting-date
 * relation, capped at the incumbent 120-day reconcile horizon. Wider
 * historical evidence is settlement-only for currently carried
 * occurrences and does not authorize generic historical opening
 * backfill. A complete
 * freshness-qualified household-cash observation remains the Forecast
 * opening when a same-day inbound is unproven or ambiguous: Forecast
 * omits that inbound from actionable cash via in-memory
 * opening.notReliedUponEvents without claiming it posted. A later
 * same-date refresh rebuilds those same-day inbound guards independently
 * of a prior hold and retains the suppression until applicable posting
 * proof resolves it; it does not require as-of to advance.
 * Incomplete or
 * untrusted current cash still fails closed. Same-day unposted
 * joint-cash bills stay still due and do not fail the overlay. Triangle/MBNA
 * statement cadence may keep canonical posted values. Unknown, stale,
 * conflicting, unmapped, credit-capacity, and transfer-as-income
 * evidence fail closed. Historical data.json and snapshots stay
 * byte-identical. After a trusted overlay, the CLI projects the household
 * operating answer from Forecast.recommend; it does not recalculate those
 * values. A fail-closed overlay keeps the dated opening and cannot raise
 * remaining-claim precision. When the observation's household date is later
 * than that opening, the dated sheet is not the current operating plan:
 * liveOverlay.operatingPlan is unavailable so Forecast withholds current
 * spend permission, current-period action, extra-debt instruction, and the
 * current spending-cycle label rather than publishing the opening's cycle
 * as today. Do not pair a later payday cycle with the unadvanced opening.
 * Zero/no-change is a valid Forecast result.
 * Served data also carries a sanitized household refresh-trust packet
 * copied from incumbent observation, reconciliation, canonical-preview,
 * overlay, and Forecast remaining-claim results. The page renders that
 * packet; this module does not invent freshness or settlement.
 *
 * Production /data.json stays the dated opening unless ATLAS_LIVE_OVERLAY
 * is explicitly `fixture` or `live`. Owner-authorized production read-only
 * Lunch Money access uses ATLAS_LIVE_OVERLAY=live plus owner-supplied
 * Render secrets. Unattended canonical writes remain unauthorized.
 */

const fs = require('fs');
const path = require('path');
const O = require('./provider-observe.js');
const SalaryDiagnostic = require('./salary-match-diagnostic.js');
const C = require('./canonical-refresh.js');
const OA = require('./operating-answer.js');
const RT = require('./refresh-trust.js');
const ObservationMemory = require('./server-observation-memory.js');
const StageTiming = require('./refresh-stage-timing.js');
const { isDeepStrictEqual } = require('node:util');
const Forecast = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'atlas-live-plan-overlay/v1';
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const DEFAULT_IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const SNAPSHOT_DIR = path.join(ROOT, 'snapshots');
const EPSILON = 0.005;
const POSTED_CASH = new Set(['chequing-a', 'chequing-b', 'savings']);
const CREDIT_CAPACITY_FACTS = new Set([
  'limit', 'available-credit', 'confirmed-payment', 'scheduled-payment',
]);
const TRANSFER_INCOME_FACTS = new Set([
  'employment-deposit', 'household-transfer', 'coaching-receipt',
  'business-obligation', 'internal-transfer', 'household-available',
]);
const BACKFILL_FACTS = new Set(['posting', 'settlement']);
const OPERATING_PLAN_LIVE = 'live';
const OPERATING_PLAN_DATED = 'dated-opening';
const OPERATING_PLAN_UNAVAILABLE = 'unavailable';
const OPERATING_PLAN_UNAVAILABLE_NOTE =
  'Current plan unavailable. The dated opening is stale.';

function fail(message) {
  const err = new Error(message);
  err.code = 'live-plan-failed';
  throw err;
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

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sanitizeLiveFailureReason(message) {
  const raw = String(message || 'overlay-failed');
  if (/timeout/i.test(raw)) return 'provider-request-timeout';
  if (/duplicate-provider-account-id/.test(raw)) return 'duplicate-provider-account-id';
  if (/missing-required-cash-mapping|live-account-map-missing/.test(raw)) {
    return 'missing-required-cash-mapping';
  }
  if (/unsupported-atlas-role/.test(raw)) return 'unsupported-atlas-role';
  if (/invalid-atlas-account-id/.test(raw)) return 'invalid-atlas-account-id';
  if (/live-account-map-invalid/.test(raw)) return 'live-account-map-invalid';
  if (/Fixture account map/.test(raw)) return 'fixture-map-not-live';
  if (/rejected the access token|HTTP 401|HTTP 403|is not set/i.test(raw)) {
    return 'live-observation-unavailable';
  }
  if (/HTTP \d+|request failed|ENOTFOUND|ECONNREFUSED|provider unavailable/i.test(raw)) {
    return 'provider-unavailable';
  }
  const known = raw.match(/^(missing-live-cash-evidence|stale-live-cash-evidence|pending-freshness-unproven|same-day-event-representation-unknown)(?::|\s|$)/);
  if (known) return known[1];
  if (/token|Bearer|LUNCHMONEY|Authorization|ATLAS_PROVIDER_ACCOUNT_MAP_JSON/i.test(raw)) {
    return 'live-observation-unavailable';
  }
  return raw.replace(/\b\d{4,}\b/g, '[id]').slice(0, 200);
}

function logLiveFailure(reason) {
  console.error('live overlay failed:', reason);
}

function observationNow(env) {
  const source = env || process.env;
  const pinned = source && source.ATLAS_LIVE_OVERLAY_NOW;
  if (pinned == null || String(pinned).trim() === '') return new Date().toISOString();
  try {
    O.lunchMoneyApiBase(source);
  } catch (e) {
    fail('ATLAS_LIVE_OVERLAY_NOW is only valid with a loopback Lunch Money API base.');
  }
  const base = source[O.API_BASE_ENV];
  if (base == null || String(base).trim() === '') {
    fail('ATLAS_LIVE_OVERLAY_NOW is only valid with a loopback Lunch Money API base.');
  }
  return String(pinned).trim();
}

function overlayModeFromEnv(env) {
  const raw = env && env.ATLAS_LIVE_OVERLAY != null
    ? env.ATLAS_LIVE_OVERLAY : process.env.ATLAS_LIVE_OVERLAY;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'fixture' || v === 'live') return v;
  return 'off';
}

function actualsPacketLooksSanitized(packet) {
  return O.currentPeriodActualsLooksSanitized(packet);
}

function reconRows(report) {
  return (report && report.reconciliation && report.reconciliation.rows) || [];
}

function cashRow(data, id) {
  const cash = (data.plan && data.plan.startingCash) || {};
  const rows = (cash.breakdown || []).concat(cash.heldElsewhere || []);
  return rows.find(row => row && row.id === id) || null;
}

function debtRow(data, id) {
  return ((data.debts || []).find(row => row && row.id === id)) || null;
}

function hasPendingState(debt) {
  if (!debt) return false;
  if (debt.pendingUnknown === true || debt.unknownPending === true) return true;
  if (!Object.prototype.hasOwnProperty.call(debt, 'pending')) return false;
  return debt.secured === false;
}

function pendingCoverageComplete(report) {
  const cov = report && report.pendingCoverage;
  if (cov && cov.complete === true && cov.basis === O.PENDING_COVERAGE_BASIS) return true;
  const classified = O.classifyPendingCoverage(
    cov ? { pendingCoverage: cov } : (report || {})
  );
  return classified.complete === true
    && classified.basis === O.PENDING_COVERAGE_BASIS;
}

function dateAllowsOverlay(row) {
  return row && (row.dateRelation === 'canonical-older' || row.dateRelation === 'same-day');
}

function liveEvidenceDate(row) {
  return Forecast.financialDate(row && (row.evidenceDate || row.observedAsOf));
}

function postedBalanceRow(row) {
  if (!row) return false;
  if (row.fact && CREDIT_CAPACITY_FACTS.has(row.fact)) return false;
  if (row.fact && TRANSFER_INCOME_FACTS.has(row.fact)) return false;
  if (row.fact && BACKFILL_FACTS.has(row.fact)) return false;
  if (row.fact === 'pending') return false;
  return !row.fact || row.fact === 'posted-balance';
}

function trustworthyNumeric(row) {
  return !!(row
    && row.unknown !== true
    && row.status !== 'CONFLICT'
    && row.status !== 'MISSING'
    && row.evidenceValue != null
    && isFinite(row.evidenceValue));
}

function postedFreshForLiveAsOf(row, liveAsOf) {
  if (!trustworthyNumeric(row) || !liveAsOf) return false;
  const evidenceDate = liveEvidenceDate(row);
  if (evidenceDate === liveAsOf) return true;
  const parsed = C.parseLocator(row.canonicalTarget);
  return !!(parsed && C.statementCadenceAccepts(parsed.id, evidenceDate, liveAsOf));
}

function pendingFreshForLiveAsOf(row, report, liveAsOf) {
  if (!trustworthyNumeric(row) || !liveAsOf) return false;
  if (liveEvidenceDate(row) !== liveAsOf) return false;
  if (row.status !== 'MATCH' && row.status !== 'CHANGE') return false;
  if (near(row.evidenceValue, 0) && !pendingCoverageComplete(report)) return false;
  return true;
}

function rowFreshForLiveAsOf(row, report, liveAsOf) {
  if (!row || !liveAsOf) return false;
  if (row.fact === 'pending') return pendingFreshForLiveAsOf(row, report, liveAsOf);
  if (!postedBalanceRow(row)) return false;
  return postedFreshForLiveAsOf(row, liveAsOf);
}

function postedRowsForLocator(report, locator) {
  return reconRows(report).filter(row => (
    row && row.canonicalTarget === locator && postedBalanceRow(row)
  ));
}

function pendingRowsForDebt(report, id) {
  const locator = `debts:${id}#pending`;
  return reconRows(report).filter(row => row && row.fact === 'pending' && (
    row.cardId === id || row.canonicalTarget === locator
  ));
}

function assertFreshLivePacket(data, report, liveAsOf) {
  if (!liveAsOf) fail('Live overlay is missing a household financial date.');
  for (const id of POSTED_CASH) {
    if (id === 'savings' && Forecast.savingsEarmarksState(data && data.plan, liveAsOf).status !== 'setup-unknown') continue;
    const locator = `cash:${id}`;
    const rows = postedRowsForLocator(report, locator);
    const fresh = rows.find(row => (
      trustworthyNumeric(row) && liveEvidenceDate(row) === liveAsOf
    ));
    if (!fresh) {
      const sample = rows.find(row => trustworthyNumeric(row)) || rows[0];
      if (!sample) fail(`missing-live-cash-evidence: ${locator}`);
      const dated = liveEvidenceDate(sample) || 'unknown (no usable balance date)';
      fail(`stale-live-cash-evidence: ${locator} dated ${dated}; MATCH is not freshness`);
    }
  }
  const mappedDebts = new Set(((report && report.mapped) || [])
    .filter(row => row && row.collection === 'debts' && row.atlasId)
    .map(row => row.atlasId));
  for (const debt of (data && data.debts) || []) {
    if (!hasPendingState(debt)) continue;
    const pendingRows = pendingRowsForDebt(report, debt.id);
    if (!mappedDebts.has(debt.id) && !pendingRows.length) continue;
    const locator = `debts:${debt.id}#pending`;
    const fresh = pendingRows.find(row => pendingFreshForLiveAsOf(row, report, liveAsOf));
    if (!fresh) fail(`pending-freshness-unproven: ${locator}`);
  }
}

function sanitizedUnmapped(entry) {
  return {
    locator: null,
    fact: null,
    reason: 'unmapped-provider-account',
    accountLabel: entry && entry.accountLabel ? String(entry.accountLabel)
      : (entry && entry.displayName ? String(entry.displayName) : null),
  };
}

function refuseRow(row, reason) {
  return {
    locator: (row && row.canonicalTarget) || null,
    fact: (row && row.fact) || null,
    status: (row && row.status) || null,
    dateRelation: (row && row.dateRelation) || null,
    currentValue: row && row.canonicalValue != null && isFinite(row.canonicalValue)
      ? round2(row.canonicalValue) : null,
    observedValue: row && row.unknown === true ? null
      : (row && row.evidenceValue != null && isFinite(row.evidenceValue)
        ? round2(row.evidenceValue) : null),
    evidenceDate: (row && (row.evidenceDate || row.observedAsOf)) || null,
    reason,
  };
}

function postedOverlayEligible(row) {
  if (!C.eligiblePosted(row)) return false;
  if (!row || row.status !== 'CHANGE') return false;
  if (row.unknown === true) return false;
  if (row.evidenceValue == null || !isFinite(row.evidenceValue)) return false;
  if (row.canonicalValue == null || !isFinite(row.canonicalValue)) return false;
  return dateAllowsOverlay(row);
}

function pendingOverlayEligible(row, report) {
  if (!row || row.fact !== 'pending') return false;
  if (row.status !== 'CHANGE') return false;
  if (row.unknown === true) return false;
  if (row.evidenceValue == null || !isFinite(row.evidenceValue)) return false;
  if (!dateAllowsOverlay(row)) return false;
  if (near(row.evidenceValue, 0) && !pendingCoverageComplete(report)) return false;
  const parsed = C.parseLocator(row.canonicalTarget);
  if (!parsed || parsed.collection !== 'debts' || parsed.field !== 'pending') return false;
  return true;
}

function postedRefuseReason(row) {
  const fact = row && row.fact;
  if (fact && CREDIT_CAPACITY_FACTS.has(fact)) return 'credit-capacity-not-cash';
  if (fact && TRANSFER_INCOME_FACTS.has(fact)) return 'transfer-not-income';
  if (fact && BACKFILL_FACTS.has(fact)) return 'historical-opening-backfill';
  if (row && row.status === 'CONFLICT') return 'conflicting-observations';
  if (row && row.status === 'MISSING') return 'unknown-value';
  if (fact === 'pending' && (row.unknown === true || row.evidenceValue == null)) {
    return 'unresolved-pending';
  }
  if (row && (row.unknown === true || row.evidenceValue == null || !isFinite(row.evidenceValue))) {
    return 'unknown-value';
  }
  if (row && row.dateRelation === 'canonical-newer') {
    const parsed = C.parseLocator(row.canonicalTarget);
    const id = parsed && parsed.id;
    const evidenceDate = row.evidenceDate || row.observedAsOf || null;
    const asOf = row.canonicalAsOf
      || (row && row._canonicalAsOf)
      || null;
    if (id && evidenceDate && asOf && C.statementCadenceAccepts(id, evidenceDate, asOf)) {
      return 'statement-cadence-keep-canonical';
    }
    return 'stale-not-current';
  }
  if (row && row.dateRelation === 'incomparable') return 'incomparable-freshness';
  if (row && row.dateRelation === 'same-day' && row.status !== 'CHANGE') {
    return 'same-day-no-winner';
  }
  if (!C.eligiblePosted(row) && fact !== 'pending') return 'not-posted-current-state';
  return 'not-proposed';
}

function proposeOverlay(report, canonicalAsOf, liveAsOf) {
  const proposed = [];
  const refused = [];
  const seen = new Set();
  for (const row of reconRows(report)) {
    const locator = row && row.canonicalTarget;
    const key = String(locator || '') + '|' + String(row && row.fact || '');
    if (!locator || seen.has(key)) continue;
    seen.add(key);
    const annotated = Object.assign({}, row, { _canonicalAsOf: canonicalAsOf });
    if (row.status === 'MATCH') {
      if (liveAsOf && (row.fact === 'pending' || postedBalanceRow(annotated))
        && !rowFreshForLiveAsOf(annotated, report, liveAsOf)) {
        const zeroUnproven = row.fact === 'pending'
          && row.unknown !== true
          && row.evidenceValue != null
          && isFinite(row.evidenceValue)
          && near(row.evidenceValue, 0)
          && !pendingCoverageComplete(report);
        refused.push(refuseRow(annotated, zeroUnproven
          ? 'unproven-zero-pending'
          : 'stale-not-current'));
      }
      continue;
    }
    if (row.fact === 'pending') {
      if (pendingOverlayEligible(annotated, report)) {
        const parsed = C.parseLocator(locator);
        proposed.push({
          locator,
          collection: 'debts',
          id: parsed.id,
          field: 'pending',
          currentValue: row.canonicalValue == null ? null : round2(row.canonicalValue),
          proposedValue: round2(row.evidenceValue),
          evidenceDate: row.evidenceDate || row.observedAsOf || null,
          dateRelation: row.dateRelation,
          source: 'provider-observe:lunchmoney',
          reason: 'reconcile pending CHANGE; overlay current pending onto today\'s live plan',
        });
        continue;
      }
      const zeroUnproven = row.status === 'CHANGE'
        && row.unknown !== true
        && row.evidenceValue != null
        && isFinite(row.evidenceValue)
        && near(row.evidenceValue, 0)
        && !pendingCoverageComplete(report);
      refused.push(refuseRow(row, zeroUnproven
        ? 'unproven-zero-pending'
        : (row.dateRelation === 'canonical-newer'
          ? 'stale-not-current'
          : postedRefuseReason(annotated))));
      continue;
    }
    if (postedOverlayEligible(annotated)) {
      const parsed = C.parseLocator(locator);
      proposed.push({
        locator,
        collection: parsed.collection,
        id: parsed.id,
        field: parsed.collection === 'cash' ? 'value' : 'balance',
        currentValue: round2(row.canonicalValue),
        proposedValue: round2(row.evidenceValue),
        evidenceDate: row.evidenceDate || row.observedAsOf || null,
        dateRelation: row.dateRelation,
        source: 'provider-observe:lunchmoney',
        reason: row.dateRelation === 'same-day'
          ? 'reconcile CHANGE; same-day observation overlays today\'s live plan only'
          : 'reconcile CHANGE; evidence newer than canonical opening',
      });
      continue;
    }
    refused.push(refuseRow(annotated, postedRefuseReason(annotated)));
  }
  for (const entry of (report && report.unmapped) || []) {
    refused.push(sanitizedUnmapped(entry));
  }
  proposed.sort((a, b) => String(a.locator).localeCompare(String(b.locator))
    || String(a.field).localeCompare(String(b.field)));
  refused.sort((a, b) => String(a.locator || a.reason).localeCompare(String(b.locator || b.reason))
    || String(a.reason).localeCompare(String(b.reason)));
  return { proposed, refused };
}

function applyPostedOverlay(data, change) {
  const parsed = C.parseLocator(change.locator);
  if (!parsed) fail(`Unsupported overlay locator: ${change.locator}`);
  if (parsed.collection === 'cash' && change.field === 'value' && POSTED_CASH.has(parsed.id)) {
    const row = cashRow(data, parsed.id);
    if (!row) fail(`Missing cash row ${parsed.id}`);
    row.value = round2(change.proposedValue);
    return;
  }
  if (parsed.collection === 'debts' && change.field === 'balance' && !parsed.field) {
    const row = debtRow(data, parsed.id);
    if (!row) fail(`Missing debt row ${parsed.id}`);
    row.balance = round2(change.proposedValue);
    return;
  }
  fail(`Refusing overlay of ${change.locator} field ${change.field}`);
}

function applyPendingOverlay(data, change) {
  const parsed = C.parseLocator(change.locator);
  if (!parsed || parsed.collection !== 'debts' || parsed.field !== 'pending'
    || change.field !== 'pending') {
    fail(`Refusing pending overlay of ${change && change.locator}`);
  }
  const row = debtRow(data, parsed.id);
  if (!row) fail(`Missing debt row ${parsed.id}`);
  if (row.secured !== false) fail(`Pending overlay refused for secured debt ${parsed.id}`);
  if (!hasPendingState(row)) fail(`Pending overlay refused for debt without pending state ${parsed.id}`);
  if (change.proposedValue == null || !isFinite(Number(change.proposedValue))) {
    fail(`Pending overlay refused unknown proposed value for ${change.locator}`);
  }
  row.pending = round2(change.proposedValue);
  row.pendingUnknown = false;
  if (Object.prototype.hasOwnProperty.call(row, 'unknownPending')) row.unknownPending = false;
}

function assertOwnerPolicyUntouched(before, after) {
  const keys = ['income', 'bills', 'obligations', 'commitments', 'budget', 'actions', 'nextDollar', 'savingsEarmarks', 'cardPurchaseCoverage'];
  for (const key of keys) {
    if (JSON.stringify((before.plan || {})[key]) !== JSON.stringify((after.plan || {})[key])) {
      fail(`Live overlay must not rewrite plan.${key}.`);
    }
  }
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

// Same-day inbound guards must see currently held receipts. Forecast
// omitRepresented treats notReliedUponEvents as absence; that prior
// suppression cannot be the input to rebuilding the hold.
function schedulePlanForSameDayGuards(plan) {
  const scheduled = schedulePlan(plan);
  if (scheduled.opening) {
    scheduled.opening = Object.assign({}, scheduled.opening, {
      notReliedUponEvents: [],
    });
  }
  return scheduled;
}

function scheduledCashEventsOn(plan, date) {
  if (!plan || !date) return [];
  return Forecast.expandEvents(schedulePlanForSameDayGuards(plan), date, date, {})
    .filter(event => event && event.date === date && event.kind !== 'noncash');
}

function scheduledCashEventsIn(plan, afterExclusive, throughInclusive) {
  if (!plan || !afterExclusive || !throughInclusive) return [];
  if (throughInclusive <= afterExclusive) return [];
  const from = Forecast.addDays(afterExclusive, 1);
  if (!from || from > throughInclusive) return [];
  return Forecast.expandEvents(schedulePlan(plan), from, throughInclusive, {})
    .filter(event => event && event.date > afterExclusive
      && event.date <= throughInclusive
      && event.kind !== 'noncash');
}

// Unrepresented same-day inbound cash would double-count if Forecast
// still added it on top of live posted balances. Unposted same-day
// bills do not: live cash does not include them, and Forecast keeps
// them still due because they are not named on representedEvents.
function sameDayUnrepresentedWouldDoubleCount(event) {
  if (!event || event.kind === 'noncash') return false;
  if (event.kind === 'income') return true;
  return Number(event.amount) > 0;
}

function liveAsOfFrom(report, historicalOpeningAsOf) {
  const observed = Forecast.financialDate(report && report.fetchedAt)
    || Forecast.financialDate(report && report.observedAsOf);
  return observed || historicalOpeningAsOf || null;
}

function representedCandidateAllowed(candidate, historicalOpeningAsOf, liveAsOf, plan) {
  if (!candidate || !candidate.id || !candidate.date || !liveAsOf) return false;
  if (!Forecast.representedEventEffectiveBy(candidate, liveAsOf)) return false;
  const inLiveWindow = !!(historicalOpeningAsOf
    && candidate.date > historicalOpeningAsOf
    && candidate.date <= liveAsOf);
  // Same-date refresh has an empty (prior, live] window, but current-opening
  // posting proof must still resolve an unproven-income hold.
  const currentOpeningProof = candidate.date === liveAsOf;
  return inLiveWindow
    || currentOpeningProof
    || Forecast.carriedOnceJointCashOutflow(plan, candidate.id, candidate.date, liveAsOf)
    || Forecast.prepaidJointCashOutflow(plan, candidate.id, candidate.date, liveAsOf);
}

function representedCandidatesFor(report, historicalOpeningAsOf, liveAsOf, plan) {
  return ((report && report.representedEventCandidates) || [])
    .map(candidate => O.classifyRepresentedCandidate(candidate, liveAsOf))
    .filter(candidate => representedCandidateAllowed(
      candidate, historicalOpeningAsOf, liveAsOf, plan));
}

function sortRepresented(a, b) {
  return String(a.date).localeCompare(String(b.date))
    || String(a.id).localeCompare(String(b.id));
}

function copyRepresented(row) {
  return { id: row.id, date: row.date,
    ...(Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')
      ? { effectiveAsOf: row.effectiveAsOf } : {}) };
}

function representedQualificationDate(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')) return null;
  return typeof row.effectiveAsOf === 'string' ? row.effectiveAsOf : null;
}

function copyNotRelied(row) {
  return {
    id: row.id,
    date: row.date,
    reason: row.reason,
    candidateCount: Number(row.candidateCount) > 0 ? Number(row.candidateCount) : 0,
  };
}

function mergeSameDayIncomeGuards(existing, rebuilt, representedKeys, liveAsOf) {
  const byKey = new Map();
  const take = (row, prefer) => {
    if (!row || !row.id || !row.date || row.date !== liveAsOf) return;
    const key = String(row.id) + '@' + String(row.date);
    if (representedKeys.has(key)) return;
    if (!prefer && byKey.has(key)) return;
    byKey.set(key, copyNotRelied(row));
  };
  for (const row of existing || []) take(row, false);
  for (const row of rebuilt || []) take(row, true);
  const out = Array.from(byKey.values());
  out.sort(sortRepresented);
  return out;
}

function preferRepresented(kept, incoming, liveAsOf) {
  const keptActive = Forecast.representedEventEffectiveBy(kept, liveAsOf);
  const incomingActive = Forecast.representedEventEffectiveBy(incoming, liveAsOf);
  if (incomingActive !== keptActive) return incomingActive ? incoming : kept;
  if (keptActive && incomingActive) {
    const keptFrom = representedQualificationDate(kept);
    const incomingFrom = representedQualificationDate(incoming);
    if (keptFrom == null) return kept;
    if (incomingFrom == null) return incoming;
    if (incomingFrom < keptFrom) return incoming;
  }
  return kept;
}

function mergeRepresented(existing, added, liveAsOf) {
  const byKey = new Map();
  for (const row of (existing || []).concat(added || [])) {
    if (!row || !row.id || !row.date) continue;
    const next = copyRepresented(row);
    const key = String(next.id) + '@' + String(next.date);
    const prev = byKey.get(key);
    byKey.set(key, prev ? preferRepresented(prev, next, liveAsOf) : next);
  }
  const out = Array.from(byKey.values());
  out.sort(sortRepresented);
  return out;
}

function refuseNonLiveRepresented(report, historicalOpeningAsOf, liveAsOf, plan) {
  const refused = [];
  for (const candidate of (report && report.representedEventCandidates) || []) {
    const classified = O.classifyRepresentedCandidate(candidate, liveAsOf);
    if (representedCandidateAllowed(classified, historicalOpeningAsOf, liveAsOf, plan)) continue;
    refused.push({
      locator: 'plan.opening.representedEvents',
      fact: 'posting',
      eventId: classified.id || null,
      evidenceDate: classified.date || null,
      reason: classified.date && historicalOpeningAsOf
        && classified.date <= historicalOpeningAsOf
        ? 'historical-opening-backfill'
        : 'not-live-as-of',
    });
  }
  return refused;
}

function sameDayInboundAmbiguityFor(report, event) {
  const rows = (report && report.sameDayInboundAmbiguity) || [];
  return rows.find(row => row && row.id === event.id && row.date === event.date) || null;
}

function applyLiveCutover(next, report, historicalOpeningAsOf) {
  const liveAsOf = liveAsOfFrom(report, historicalOpeningAsOf);
  if (!liveAsOf) fail('Live overlay is missing a household financial date.');
  const windowEvents = scheduledCashEventsIn(next.plan, historicalOpeningAsOf, liveAsOf)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.id).localeCompare(String(b.id)));
  // Same-date refresh: (historicalOpeningAsOf, liveAsOf] is empty, but
  // liveAsOf scheduled inbounds still sit on top of observed cash.
  const seenWindow = new Set(windowEvents.map(event =>
    String(event.id) + '@' + String(event.date)));
  for (const event of scheduledCashEventsOn(next.plan, liveAsOf)) {
    const key = String(event.id) + '@' + String(event.date);
    if (seenWindow.has(key)) continue;
    windowEvents.push(event);
    seenWindow.add(key);
  }
  const candidates = representedCandidatesFor(
    report, historicalOpeningAsOf, liveAsOf, next.plan);
  const represented = [];
  const notReliedUpon = [];
  for (const candidate of candidates) {
    if (Forecast.carriedOnceJointCashOutflow(
      next.plan, candidate.id, candidate.date, liveAsOf)
      || Forecast.prepaidJointCashOutflow(
        next.plan, candidate.id, candidate.date, liveAsOf)) {
      represented.push({ id: candidate.id, date: Forecast.statementOccurrenceIdentity(next.plan, candidate.id, candidate.date), effectiveAsOf: liveAsOf });
    }
  }
  for (const event of windowEvents) {
    const hit = candidates.find(candidate => candidate.id === event.id
      && candidate.date === event.date);
    if (hit) {
      represented.push({ id: event.id, date: event.scheduledDate || event.date, effectiveAsOf: liveAsOf });
      continue;
    }
    if (event.date !== liveAsOf || !sameDayUnrepresentedWouldDoubleCount(event)) continue;
    const ambiguous = sameDayInboundAmbiguityFor(report, event);
    notReliedUpon.push({
      id: event.id,
      date: event.date,
      reason: ambiguous ? 'same-day-inbound-ambiguous' : 'same-day-inbound-unproven',
      candidateCount: ambiguous && Number(ambiguous.candidateCount) > 0
        ? Number(ambiguous.candidateCount)
        : 0,
    });
  }
  const uniqueRepresented = mergeRepresented([], represented, liveAsOf);
  const advances = !!(historicalOpeningAsOf && liveAsOf > historicalOpeningAsOf);
  if (historicalOpeningAsOf && liveAsOf < historicalOpeningAsOf) {
    return {
      liveAsOf: historicalOpeningAsOf,
      representedEvents: mergeRepresented(
        (next.plan.opening && next.plan.opening.representedEvents) || [],
        [],
        historicalOpeningAsOf
      ),
      notReliedUponEvents: [],
      advanced: false,
    };
  }
  const existing = (next.plan.opening && next.plan.opening.representedEvents) || [];
  // Advancing as-of used to replace the opening list with identity
  // hits only. That dropped Dale-gated prepaid names the live packet
  // had not rediscovered (tdcc chequing TFR-TO C/C is not identity).
  // Keep existing names that still qualify for this liveAsOf; identity
  // candidates remain additive. Historical cash replay names still drop;
  // independently qualified minimum receipt knowledge is retained below.
  // Explicit deferred evidence stays attached but inactive; stripping
  // its effective date would turn it into an opening-date legacy assertion.
  // Duplicate id/date cannot let that inactive row shadow fresh applicable
  // proof, and a later live date cannot overwrite an earlier truthful one.
  // Minimum receipt knowledge survives its due date; replay eligibility still
  // belongs to Forecast. Preserve the original identity and earliest attached
  // opening of a legacy proof before replacing that opening with fresh stock.
  const durableExisting = existing.map(row => {
    const original = Forecast.cardMinimumReceiptIdentity(next.plan, row);
    return original && historicalOpeningAsOf ? { ...row, date: original,
      ...(!Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')
        ? { effectiveAsOf: historicalOpeningAsOf } : {}) } : row;
  });
  const keptExisting = advances
    ? durableExisting.filter(row => Forecast.cardMinimumReceiptIdentity(next.plan, row)
      || representedCandidateAllowed(
      row, historicalOpeningAsOf, liveAsOf, next.plan)
      || (row && Object.prototype.hasOwnProperty.call(row, 'effectiveAsOf')
        && !Forecast.representedEventEffectiveBy(row, liveAsOf)))
    : durableExisting;
  const nextRepresented = mergeRepresented(keptExisting, uniqueRepresented, liveAsOf);
  const representedKeys = new Set(nextRepresented.filter(row =>
    Forecast.representedEventEffectiveBy(row, liveAsOf)).map(row =>
    String(row.id) + '@' + String(row.date)));
  // Rebuild from occurrences still visible without prior holds, then
  // keep any same-day hold that applicable proof has not resolved.
  const nextNotRelied = mergeSameDayIncomeGuards(
    (next.plan.opening && next.plan.opening.notReliedUponEvents) || [],
    notReliedUpon,
    representedKeys,
    liveAsOf
  );
  const nextOpening = Object.assign({}, next.plan.opening || {}, {
    asOf: liveAsOf,
    representedEvents: nextRepresented,
    notReliedUponEvents: nextNotRelied,
  });
  if (advances) nextOpening.priorAsOf = historicalOpeningAsOf;
  next.plan.opening = nextOpening;
  if (!next.meta) next.meta = {};
  next.meta.asOf = liveAsOf;
  return {
    liveAsOf,
    representedEvents: nextOpening.representedEvents,
    notReliedUponEvents: nextOpening.notReliedUponEvents,
    advanced: advances,
  };
}

function recordedPaydaySnapshot(snap, periodStart) {
  if (!snap || !periodStart) return null;
  if (String(snap.periodStart) !== String(periodStart)) return null;
  if (String(snap.asOf) !== String(periodStart)) return null;
  if (typeof snap.opening === 'number') {
    return Number.isFinite(snap.opening) ? snap : null;
  }
  if (typeof snap.opening === 'string' && snap.opening.trim() !== '') {
    return Number.isFinite(Number(snap.opening)) ? snap : null;
  }
  return null;
}

// Incumbent live evidence for the opening-to-payday household-cash gap.
// currentPeriodActuals amounts stay Lunch Money signed (positive debit /
// outflow, negative credit / inflow). Forecast paydayGapCash movements
// are household-cash signed (in +, out −), so each posted household-cash
// debit is negated here. Account identity is preserved so Forecast can
// restrict the reconstructed spendable opening to the chequing-only pool;
// designated savings remains household-cash evidence, not ordinary spendable.
// A current-period window being paginated-complete
// is not gap completeness: that packet's claim is the current payday
// period, not "unscheduled pre-payday spend was zero." complete:true
// requires the observer-earned paydayGapComplete attestation plus a
// fetch-complete window that actually covers the gap.
function paydayGapCashFromReport(report, canonicalPlan, paydayDate) {
  const explicit = report && report.paydayGapCash;
  if (explicit && typeof explicit === 'object' && Array.isArray(explicit.movements)) {
    return explicit;
  }
  const packet = report && report.currentPeriodActuals;
  const window = (report && report.transactionWindow) || {};
  const openingAsOf = canonicalPlan && canonicalPlan.opening && canonicalPlan.opening.asOf;
  const coverageStart = (packet && packet.coverageStart) || window.startDate || null;
  const coverageThrough = (packet && packet.coverageThrough) || window.endDate || null;
  const empty = {
    complete: false,
    coverageStart,
    coverageThrough,
    movements: [],
  };
  if (!packet || !Array.isArray(packet.transactions) || !openingAsOf || !paydayDate) {
    return empty;
  }
  const windowComplete = window.complete === true
    && window.truncated !== true
    && window.hasMore !== true;
  const txCoverage = packet.transactionCoverage;
  const packetComplete = txCoverage !== 'truncated'
    && txCoverage !== 'incomplete'
    && !(txCoverage && typeof txCoverage === 'object'
      && (txCoverage.truncated === true || txCoverage.complete === false));
  let coversGap = String(openingAsOf) === String(paydayDate);
  if (!coversGap) {
    const firstGapDay = Forecast.addDays(openingAsOf, 1);
    const lastGapDay = Forecast.addDays(paydayDate, -1);
    if (firstGapDay && lastGapDay && String(lastGapDay) < String(firstGapDay)) {
      coversGap = true;
    } else if (firstGapDay && lastGapDay && coverageStart && coverageThrough) {
      coversGap = String(coverageStart) <= String(firstGapDay)
        && String(coverageThrough) >= String(lastGapDay);
    }
  }
  const hasUnmapped = packet.transactions.some(tx => tx && tx.accountRole === 'unmapped');
  const movements = [];
  let amountsTrusted = true;
  let pendingGapUnproven = false;
  for (const tx of packet.transactions) {
    if (!tx || !tx.date) continue;
    const inGap = String(tx.date) > String(openingAsOf)
      && String(tx.date) < String(paydayDate);
    if (tx.accountRole === 'household-cash'
      && tx.pending === true
      && tx.pendingPostedDuplicate !== true
      && inGap) {
      pendingGapUnproven = true;
    }
    if (tx.pending === true) continue;
    if (tx.accountRole !== 'household-cash') continue;
    const debit = Number(tx.amount);
    if (!Number.isFinite(debit)) {
      amountsTrusted = false;
      break;
    }
    const atlasAccountId = tx.atlasAccountId || tx.account || tx.accountId || null;
    const movement = {
      date: String(tx.date),
      amount: Math.round((-debit) * 100) / 100,
      accountRole: 'household-cash',
    };
    if (atlasAccountId) movement.atlasAccountId = String(atlasAccountId);
    movements.push(movement);
  }
  const gapAttested = packet.paydayGapComplete === true;
  return {
    complete: !!(gapAttested && windowComplete && packetComplete && coversGap
      && !hasUnmapped && amountsTrusted && !pendingGapUnproven),
    coverageStart,
    coverageThrough,
    movements,
  };
}

// Presence guard for the original opening's spendable rows. Scope follows
// Forecast.startingCashAmount; this does not calculate a cash amount.
function paydayOpeningCashKnown(plan) {
  const finite = value => typeof value === 'number' ? Number.isFinite(value)
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  const cash = plan && plan.startingCash;
  const rows = cash && cash.breakdown;
  if (!Array.isArray(rows) || !rows.length) return finite(cash && cash.amount);
  const chequingIds = ['chequing-a', 'chequing-b'];
  const hasChequing = rows.some(row => row && chequingIds.includes(row.id));
  // Reconstruction needs each required operating observation exactly once.
  // Duplicate rows would let Forecast sum the same original cash twice.
  if (hasChequing && chequingIds.some(id => rows.filter(row => row && row.id === id).length !== 1)) return false;
  const pools = Array.isArray(plan.savingsEarmarks && plan.savingsEarmarks.pools)
    ? plan.savingsEarmarks.pools : [];
  const spendable = rows.filter(row => row && (hasChequing ? chequingIds.includes(row.id)
    : row.id !== 'savings' && !pools.some(pool => pool && pool.accountId === row.id)));
  return spendable.length > 0 && spendable.every(row => row.unknown !== true && finite(row.value));
}

// Retain Forecast's payday-morning figure on the live clone. Use the
// pre-overlay dated plan, never the post-overlay live cash. An already
// matching snapshot stays frozen. A walk is retained only when
// Forecast can prove the opening-to-payday gap is cash-complete from
// incumbent live actuals / transaction-window evidence.
function retainPaydaySnapshot(next, canonicalPlan, liveAsOf, report) {
  if (!next || !next.plan || !canonicalPlan || !liveAsOf) return;
  const cycle = Forecast.spendingCycle(canonicalPlan, liveAsOf);
  if (!cycle || !cycle.start) return;
  const existing = recordedPaydaySnapshot(
    next.plan.opening && next.plan.opening.paydaySnapshot, cycle.start)
    || recordedPaydaySnapshot(
      canonicalPlan.opening && canonicalPlan.opening.paydaySnapshot, cycle.start);
  if (existing) {
    next.plan.opening = Object.assign({}, next.plan.opening || {}, {
      paydaySnapshot: {
        periodStart: String(existing.periodStart),
        asOf: String(existing.asOf),
        opening: Math.round(Number(existing.opening) * 100) / 100,
      },
    });
    return;
  }
  // Earn from recorded original cash, never Number(null/blank) -> zero.
  // A valid frozen snapshot above remains independently usable.
  if (!paydayOpeningCashKnown(canonicalPlan)) return;
  const snap = Forecast.establishPaydaySnapshot(canonicalPlan, cycle.start, {
    representedEvents: (next.plan.opening && next.plan.opening.representedEvents) || [],
    paydayGapCash: paydayGapCashFromReport(report, canonicalPlan, cycle.start),
  });
  if (!snap) return;
  next.plan.opening = Object.assign({}, next.plan.opening || {}, {
    paydaySnapshot: {
      periodStart: snap.periodStart,
      asOf: snap.asOf,
      opening: snap.opening,
    },
  });
}

function stampPaydayAccountObservation(next, obs, payday) {
  if (!next || !next.plan || !obs || !payday) return;
  if (String(obs.accountId) !== 'chequing-a') return;
  if (obs.temporalClaim !== 'posted-balance-observed-on-household-date') return;
  if (obs.isPaydayMorningOpening === true || obs.isPooledChequing === true) return;
  next.plan.opening = Object.assign({}, next.plan.opening || {}, {
    paydayAccountObservations: {
      periodStart: String(payday),
      asOf: String(payday),
      accounts: [{
        id: 'chequing-a',
        value: obs.value,
        evidenceDate: obs.evidenceDate,
        temporalClaim: obs.temporalClaim,
        source: obs.source,
      }],
    },
  });
}

// Retain account-specific posted-balance evidence for canonical chequing-a
// when the observation household date, or the pre-overlay canonical opening
// as-of, is the current Seaspan payday. Not a payday-morning opening, not
// pooled A+B, not a previous-observation store, and not a canonical write.
// A canonical plan.opening.paydayAccountObservations row, when already
// recorded by the earned persist write, is kept on the overlay clone.
function retainPaydayAccountObservations(next, canonicalPlan, liveAsOf, report) {
  if (!next || !next.plan || !canonicalPlan || !liveAsOf) return;
  const cycle = Forecast.spendingCycle(canonicalPlan, liveAsOf);
  if (!cycle || !cycle.start) return;
  const payday = cycle.start;
  const recorded = next.plan.opening && next.plan.opening.paydayAccountObservations;
  if (recorded) {
    const existing = Forecast.paydayBoundaryAccountObservation(
      next.plan, 'chequing-a', payday);
    if (existing) {
      stampPaydayAccountObservation(next, existing, payday);
      return;
    }
  }
  const obs = Forecast.paydayBoundaryAccountObservation(
    canonicalPlan, 'chequing-a', payday, {
      observedCash: collectObservedCash(report, liveAsOf),
    });
  if (!obs) return;
  stampPaydayAccountObservation(next, obs, payday);
}

// Immediately pre-payday chequing-a, walked on the pre-overlay plan
// before the same-day BILLS row is replaced. The cutoff is the day before
// payday: this stock does not include payday postings. Forecast counts a
// same-day chequing-a inflow only when it is positively labelled
// non-income. A refund category within 1% of planned payroll fails
// closed. A proven household transfer inside that window is still
// counted. One unlabelled inflow within 1% of planned payroll is the
// unrecognised deposit and is excluded. Any other inflow, and a retain
// with no transaction packet, fails closed.
// Forecast.prePaydayBillsAccountCash is the only walk. A null walk,
// including incomplete coverage of any gap day, stores nothing. The
// refreshed balance is not an input.
function retainPrePaydayBillsBase(next, canonicalPlan, liveAsOf, report) {
  if (!next || !next.plan || !canonicalPlan || !liveAsOf) return;
  const cycle = Forecast.spendingCycle(canonicalPlan, liveAsOf);
  if (!cycle || cycle.start !== liveAsOf) return;
  const payday = String(cycle.start);
  const openingAsOf = Forecast.financialDate(
    canonicalPlan.opening && canonicalPlan.opening.asOf);
  if (!openingAsOf || !(openingAsOf < payday)) return;
  const through = Forecast.addDays(payday, -1);
  if (!through || through < openingAsOf) return;
  const amount = Forecast.prePaydayBillsAccountCash(canonicalPlan, payday, {
    currentPeriodActuals: (report && report.currentPeriodActuals) || null,
  });
  if (amount == null || !Number.isFinite(Number(amount))) return;
  next.plan.opening = Object.assign({}, next.plan.opening || {}, {
    prePaydayBillsBase: {
      payday,
      accountId: 'chequing-a',
      amount: round2(amount),
      fromAsOf: openingAsOf,
      through,
      coverageComplete: true,
      source: 'dated-opening-walk',
    },
  });
}

function collectObservedCash(report, liveAsOf) {
  const accounts = [];
  if (!report || !liveAsOf) {
    return { complete: false, asOf: liveAsOf || null, accounts };
  }
  for (const id of POSTED_CASH) {
    const locator = `cash:${id}`;
    const rows = postedRowsForLocator(report, locator);
    const fresh = rows.find(row =>
      trustworthyNumeric(row) && liveEvidenceDate(row) === liveAsOf);
    if (!fresh) continue;
    accounts.push({
      id,
      value: round2(fresh.evidenceValue),
      evidenceDate: liveEvidenceDate(fresh),
    });
  }
  return {
    complete: accounts.some(row => row.id === 'chequing-a')
      && accounts.some(row => row.id === 'chequing-b'),
    asOf: liveAsOf,
    accounts,
  };
}

function operatingPlanFromOverlay(applied, historicalOpeningAsOf, liveAsOf) {
  if (applied === true) return OPERATING_PLAN_LIVE;
  // Observation household date, never wall-clock. A later observed date
  // means the unadvanced opening is not the current operating plan.
  if (historicalOpeningAsOf && liveAsOf && liveAsOf > historicalOpeningAsOf) {
    return OPERATING_PLAN_UNAVAILABLE;
  }
  return OPERATING_PLAN_DATED;
}

function operatingPlanNoteFor(status) {
  return status === OPERATING_PLAN_UNAVAILABLE
    ? OPERATING_PLAN_UNAVAILABLE_NOTE
    : null;
}

function overlayMeta(opts) {
  const salaryMatcherDiagnostic = SalaryDiagnostic.project(opts.observationReceipt?.salaryMatcherDiagnostic);
  const operatingPlan = opts.operatingPlan
    || operatingPlanFromOverlay(
      opts.applied === true,
      opts.historicalOpeningAsOf,
      opts.observedAsOf || opts.effectiveAsOf
    );
  return {
    schema: SCHEMA,
    writesCanonicalState: false,
    productionWrite: false,
    unattended: false,
    applied: opts.applied === true,
    historicalOpeningAsOf: opts.historicalOpeningAsOf || null,
    effectiveAsOf: opts.effectiveAsOf || null,
    observedAsOf: opts.observedAsOf || null,
    representedEvents: opts.representedEvents || [],
    notReliedUponEvents: opts.notReliedUponEvents || [],
    overlays: opts.overlays || [],
    refused: opts.refused || [],
    source: 'provider-observe:lunchmoney',
    note: opts.note || 'In-memory overlay for today\'s live plan. Dated openings and snapshots are unchanged.',
    reason: opts.reason || null,
    operatingPlan,
    operatingPlanNote: opts.operatingPlanNote !== undefined
      ? opts.operatingPlanNote
      : operatingPlanNoteFor(operatingPlan),
    currentPeriodActuals: opts.currentPeriodActuals || null,
    observedCash: opts.observedCash || null,
    fetchedAt: opts.fetchedAt || null,
    observedAt: opts.observedAt || opts.fetchedAt || null,
    ...(salaryMatcherDiagnostic ? { observationReceipt: { salaryMatcherDiagnostic } } : {}),
  };
}

function overlayLiveState(input) {
  const data = input && input.data;
  if (!data || !data.plan || !Array.isArray(data.debts)) fail('Canonical data is missing plan or debts.');
  const report = input.report;
  if (!report) fail('Observation report is required.');
  if (report.writesCanonicalState !== false) fail('Observer must declare writesCanonicalState false.');
  const historicalOpeningAsOf = (data.plan.opening && data.plan.opening.asOf)
    || (data.meta && data.meta.asOf) || null;
  const liveAsOf = liveAsOfFrom(report, historicalOpeningAsOf);
  const { proposed, refused } = proposeOverlay(report, historicalOpeningAsOf, liveAsOf);
  const postingRefused = refuseNonLiveRepresented(
    report, historicalOpeningAsOf, liveAsOf, data.plan);
  if (historicalOpeningAsOf && liveAsOf && liveAsOf > historicalOpeningAsOf) {
    assertFreshLivePacket(data, report, liveAsOf);
  }
  const next = clone(data);
  // Replace, never accumulate, provider-category confirmation on each refresh.
  // It is independent of durable owner-confirmed opening receipts/policy.
  next.plan.cardMinimumCategoryEvidence = clone(report.cardMinimumCategoryEvidence
    || { source: 'lunchmoney-minimum-category', asOf: liveAsOf, payments: [] });
  if (Forecast.savingsEarmarksState(data.plan, liveAsOf).status !== 'setup-unknown') next.plan.savingsPoolObservation = report.savingsPools || { asOf: liveAsOf, accounts: [] };
  const cutover = applyLiveCutover(next, report, historicalOpeningAsOf);
  // Rebuild from fresh evidence. Absence on a later fetch is not proof that
  // a previously observed receipt funds an additional future occurrence.
  // Retain unresolved future names until their native date is reached; the
  // incumbent same-day recognition guards then own that day's cash treatment.
  const priorIncome = Forecast.incomeReconciliationState(data.plan, historicalOpeningAsOf);
  delete next.plan.opening.incomeReconciliation;
  if (report.incomeReconciliation?.asOf === cutover.liveAsOf
      && (report.incomeReconciliation.status !== 'ready' || report.incomeReconciliation.issues?.length)) {
    next.plan.opening.incomeReconciliation = clone(report.incomeReconciliation);
  }
  const retainedIncome = priorIncome.issues.filter(row => row.date > cutover.liveAsOf);
  if (retainedIncome.length) {
    const issues = (next.plan.opening.incomeReconciliation?.issues || []).concat(retainedIncome);
    next.plan.opening.incomeReconciliation = { asOf: cutover.liveAsOf, status: 'unavailable',
      issues: issues.filter((row, i) => issues.findIndex(other => other.id === row.id && other.date === row.date) === i) };
  }
  retainPaydaySnapshot(next, data.plan, cutover.liveAsOf || liveAsOf, report);
  retainPaydayAccountObservations(next, data.plan, cutover.liveAsOf || liveAsOf, report);
  retainPrePaydayBillsBase(next, data.plan, cutover.liveAsOf || liveAsOf, report);
  for (const change of proposed) {
    if (change.field === 'pending') applyPendingOverlay(next, change);
    else applyPostedOverlay(next, change);
  }
  assertOwnerPolicyUntouched(data, next);
  const cash = Forecast.startingCashAmount(next.plan);
  if (!isFinite(cash)) fail('Forecast cannot consume the overlaid starting cash.');
  const allRefused = refused.concat(postingRefused).sort((a, b) =>
    String(a.locator || a.reason).localeCompare(String(b.locator || b.reason))
    || String(a.reason).localeCompare(String(b.reason)));
  next.liveOverlay = overlayMeta({
    applied: true,
    operatingPlan: Forecast.incomeReconciliationState(next.plan, cutover.liveAsOf).status === 'unavailable'
      ? OPERATING_PLAN_UNAVAILABLE : undefined,
    operatingPlanNote: Forecast.incomeReconciliationState(next.plan, cutover.liveAsOf).reason || undefined,
    historicalOpeningAsOf,
    effectiveAsOf: cutover.liveAsOf,
    observedAsOf: liveAsOf || historicalOpeningAsOf,
    representedEvents: cutover.representedEvents,
    notReliedUponEvents: cutover.notReliedUponEvents || [],
    overlays: proposed.map(row => ({
      locator: row.locator,
      field: row.field,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      evidenceDate: row.evidenceDate,
      reason: row.reason,
    })),
    refused: allRefused.map(row => ({
      locator: row.locator || null,
      fact: row.fact || null,
      reason: row.reason,
      evidenceDate: row.evidenceDate || null,
    })),
    currentPeriodActuals: report.currentPeriodActuals || null,
    observationReceipt: report.observationReceipt,
    observedCash: collectObservedCash(report, liveAsOf || cutover.liveAsOf),
    fetchedAt: report.fetchedAt || null,
    observedAt: report.fetchedAt || null,
  });
  if (!C.identityProofLooksSanitized(next.liveOverlay)
    || !O.identityProofLooksSanitized(next.liveOverlay)) {
    fail('Live overlay metadata is not sanitized.');
  }
  if (next.liveOverlay.currentPeriodActuals
    && !actualsPacketLooksSanitized(next.liveOverlay.currentPeriodActuals)) {
    fail('Current-period actuals packet is not sanitized.');
  }
  RT.attachTo(next, { report, canonical: data, operatingEvaluation: input.operatingEvaluation });
  if (!RT.looksSanitized(next.refreshTrust)) fail('Refresh-trust packet is not sanitized.');
  return {
    data: next,
    overlays: proposed,
    refused: allRefused,
    writesCanonicalState: false,
    historicalOpeningAsOf,
    effectiveAsOf: cutover.liveAsOf,
  };
}

function observeInput(opts) {
  const identity = opts.identity || (
    fs.existsSync(opts.identityPath || DEFAULT_IDENTITY)
      ? loadJson(opts.identityPath || DEFAULT_IDENTITY)
      : { rules: [], billPaymentPayees: [] }
  );
  return {
    provider: 'lunchmoney',
    payload: opts.payload,
    accountMap: opts.accountMap,
    data: opts.data,
    identity,
    fetchedAt: opts.payload && opts.payload.fetchedAt,
  };
}

function fromObservation(opts) {
  const report = O.observe(observeInput(opts));
  const overlaid = overlayLiveState({ data: opts.data, report });
  return Object.assign({ report }, overlaid);
}

function forecastFrom(data, opts) {
  const plan = data && data.plan;
  const operatingAnswer = OA.fromRefreshedState(data, Object.assign({
    mode: 'live-overlay',
    writesCanonicalState: false,
  }, opts || {}));
  const asOf = operatingAnswer.asOf;
  if (!plan || !asOf) fail('Overlaid data is missing a Forecast opening.');
  const used = Forecast.utilisation(data.debts, data.revolvingExtra, plan);
  const permission = operatingAnswer.currentSpendingPermission || {};
  const limits = operatingAnswer.limitations || {};
  return {
    asOf,
    startingCash: Forecast.startingCashAmount(plan),
    weekly: permission.weekly,
    mode: operatingAnswer.recommendMode || permission.mode,
    utilisation: {
      totalAvailable: used.totalAvailable,
      totalPending: used.totalPending,
      overLimitCount: used.overLimitCount,
    },
    writesCanonicalState: false,
    currentPeriod: {
      mode: permission.mode,
      remainingClaim: limits.remainingClaim,
      nextPayday: permission.nextPayday,
      noMovementToday: permission.noMovementToday,
      coverage: limits.coverage,
    },
    operatingAnswer,
  };
}

function failedOverlay(canonical, reason, extra) {
  const sanitized = sanitizeLiveFailureReason(reason);
  logLiveFailure(sanitized);
  const next = clone(canonical);
  if (next.plan) delete next.plan.cardMinimumCategoryEvidence;
  const historicalOpeningAsOf = (canonical.plan && canonical.plan.opening && canonical.plan.opening.asOf)
    || (canonical.meta && canonical.meta.asOf) || null;
  const report = extra && extra.report;
  const liveAsOf = report ? liveAsOfFrom(report, historicalOpeningAsOf) : null;
  if (Forecast.savingsEarmarksState(canonical.plan, liveAsOf).status !== 'setup-unknown') {
    next.plan.savingsPoolObservation = report && report.savingsPools || { asOf: liveAsOf, accounts: [] };
  }
  const operatingPlan = operatingPlanFromOverlay(false, historicalOpeningAsOf, liveAsOf);
  next.liveOverlay = overlayMeta({
    applied: false,
    historicalOpeningAsOf,
    effectiveAsOf: null,
    observedAsOf: liveAsOf,
    representedEvents: [],
    notReliedUponEvents: [],
    overlays: [],
    refused: [],
    reason: sanitized,
    operatingPlan,
    operatingPlanNote: operatingPlanNoteFor(operatingPlan),
    note: operatingPlan === OPERATING_PLAN_UNAVAILABLE
      ? 'Live overlay failed closed. Current plan unavailable; dated opening is stale.'
      : 'Live overlay failed closed. Dated opening is unchanged.',
    observedCash: report ? collectObservedCash(report, liveAsOf) : null,
    observationReceipt: report?.observationReceipt,
    fetchedAt: report && report.fetchedAt || null,
    observedAt: report && report.fetchedAt || null,
  });
  RT.attachTo(next, {
    canonical,
    report: extra && extra.report,
  });
  if (report) {
    retainPaydayAccountObservations(next, canonical.plan, liveAsOf, report);
  }
  return next;
}

function livePostedHistoryDays(canonical, now, identity) {
  return O.postedHistoryDaysForCarriedSettlement({
    now,
    plan: canonical && canonical.plan,
    debts: canonical && canonical.debts,
    identity: identity || loadIdentity(),
  });
}

function loadIdentity() {
  if (!fs.existsSync(DEFAULT_IDENTITY)) return { rules: [], billPaymentPayees: [] };
  return loadJson(DEFAULT_IDENTITY);
}

function fixturePathsFromEnv(env) {
  const fixture = (env && env.ATLAS_LIVE_OVERLAY_FIXTURE)
    || process.env.ATLAS_LIVE_OVERLAY_FIXTURE;
  const mapPath = (env && env.ATLAS_LIVE_OVERLAY_MAP)
    || process.env.ATLAS_LIVE_OVERLAY_MAP
    || O.FIXTURE_MAP;
  return { fixture, mapPath };
}

function observeForOverlay(canonical, payload, accountMap) {
  return O.observe(observeInput({
    data: canonical,
    payload,
    accountMap,
    identity: loadIdentity(),
  }));
}

function observeForSettlementAcquisition(canonical, payload, accountMap) {
  return O.observeWithSettlementCrosswalk(observeInput({
    data: canonical,
    payload,
    accountMap,
    identity: loadIdentity(),
  }));
}

function applyObservedOverlay(canonical, report, operatingEvaluation) {
  try {
    return overlayLiveState({ data: canonical, report, operatingEvaluation }).data;
  } catch (err) {
    const message = err && err.message ? err.message : 'overlay-failed';
    return failedOverlay(canonical, message, { report });
  }
}

function applyFixtureOverlay(canonical, env) {
  const { fixture, mapPath } = fixturePathsFromEnv(env);
  if (!fixture) fail('ATLAS_LIVE_OVERLAY=fixture requires ATLAS_LIVE_OVERLAY_FIXTURE.');
  const report = observeForOverlay(canonical, loadJson(fixture), loadJson(mapPath));
  return applyObservedOverlay(canonical, report);
}

function serveCanonicalOrFixture(canonical, env) {
  const mode = overlayModeFromEnv(env);
  if (mode === 'off') {
    const next = clone(canonical);
    return RT.attachTo(next, { canonical: next });
  }
  if (mode !== 'fixture') fail('serveCanonicalOrFixture handles fixture overlay only.');
  try {
    return applyFixtureOverlay(canonical, env);
  } catch (err) {
    const message = err && err.message ? err.message : 'overlay-failed';
    return failedOverlay(canonical, message);
  }
}

async function applyForServer(canonical, env, options) {
  const mode = overlayModeFromEnv(env);
  if (mode === 'off' || mode === 'fixture') {
    return serveCanonicalOrFixture(canonical, env);
  }
  try {
    const accountMap = O.loadLiveAccountMap(env || process.env, canonical);
    const payload = options?.evidence?.schema === ObservationMemory.SCHEMA
      ? StageTiming.sync('sourceReplayMs', () => ObservationMemory.sourceInputs(options.evidence.payload))
      : await StageTiming.async('providerAcquireMs', () => acquireServerObservation(canonical, env, options));
    const report = StageTiming.sync('normalizeMs', () => observeForOverlay(canonical, payload, accountMap));
    const operatingEvaluation = OA.createRefreshEvaluation();
    const data = StageTiming.sync('overlayMs', () => applyObservedOverlay(canonical, report, operatingEvaluation));
    let qualified = data.liveOverlay?.applied === true
      && report.observationReceipt?.readyForReconciliation === true;
    let evidence = null;
    if (qualified && !options?.evidence && options?.onObservation) {
      try {
        StageTiming.sync('sourceReplayMs', () => {
          const inputs = ObservationMemory.sourceInputs(payload);
          // A field projection cannot change qualification or a single figure.
          // Future observer inputs therefore cause a cache miss until supported.
          const replayReport = StageTiming.sync('normalizeMs', () => observeForOverlay(canonical, inputs, accountMap));
          const replayed = StageTiming.sync('overlayMs', () => applyObservedOverlay(canonical, replayReport, operatingEvaluation));
          if (isDeepStrictEqual(data, replayed)) evidence = { schema: ObservationMemory.SCHEMA, payload: inputs };
        });
      } catch (error) {
        // Capacity refusal is a cache miss, not a failed provider observation.
        if (error.code !== 'observation-input-too-large') qualified = false;
      }
    }
    options?.onObservation?.({ qualified, checkedAt: report.fetchedAt || null, evidence });
    return data;
  } catch (err) {
    const message = err && err.message ? err.message : 'overlay-failed';
    return StageTiming.sync('overlayMs', () => failedOverlay(canonical, message));
  }
}

// Private settlement acquisition composition. Memory-replay only: the
// retained source observation is re-evaluated through the observer's
// paired entry, and the incumbent overlay qualification on that same
// report decides whether the pass's own acquisition may be returned.
// The paired result is consumed exactly once — no second observation,
// no provider fetch and no fallback. Missing, malformed or unqualified
// memory returns null; the dated check is still reported so the refresh
// lifecycle can apply its incumbent clearing rule. Nothing here is
// served, and ordinary applyForServer behaviour is untouched.
async function acquireSettlementForServer(canonical, env, options) {
  const notify = value => {
    if (options && options.onObservation) options.onObservation(value);
  };
  if (overlayModeFromEnv(env) !== 'live'
    || !options || !options.evidence
    || options.evidence.schema !== ObservationMemory.SCHEMA) {
    notify({ qualified: false, checkedAt: null, evidence: null });
    return null;
  }
  try {
    const accountMap = O.loadLiveAccountMap(env || process.env, canonical);
    const payload = StageTiming.sync('sourceReplayMs',
      () => ObservationMemory.sourceInputs(options.evidence.payload));
    const paired = StageTiming.sync('normalizeMs',
      () => observeForSettlementAcquisition(canonical, payload, accountMap));
    if (!paired || !paired.report) {
      notify({ qualified: false, checkedAt: null, evidence: null });
      return null;
    }
    const operatingEvaluation = OA.createRefreshEvaluation();
    const data = StageTiming.sync('overlayMs',
      () => applyObservedOverlay(canonical, paired.report, operatingEvaluation));
    const qualified = data.liveOverlay?.applied === true
      && paired.report.observationReceipt?.readyForReconciliation === true;
    notify({ qualified, checkedAt: paired.report.fetchedAt || null, evidence: null });
    return qualified ? paired.acquisition : null;
  } catch (err) {
    // Mirrors applyForServer's failure path: no observation is
    // reported, so the lifecycle check stays undated and unqualified.
    return null;
  }
}

async function acquireServerObservation(canonical, env, options) {
  const now = observationNow(env || process.env);
  return O.fetchLunchMoneyLive(
    await O.resolveLiveToken({ env: env || process.env, signal: options && options.signal }),
    now,
    livePostedHistoryDays(canonical, now),
    { env: env || process.env, signal: options && options.signal }
  );
}

function snapshotPaths() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => path.join(SNAPSHOT_DIR, name));
}

function parseArgs(argv) {
  const args = {
    live: false,
    fixture: null,
    map: null,
    data: DEFAULT_DATA,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--map') args.map = argv[++i];
    else if (a === '--data') args.data = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else fail(`Unknown argument: ${a}`);
  }
  return args;
}

function summary(result, baseline) {
  const figures = forecastFrom(result.data, baseline ? { baseline } : {});
  return {
    schema: SCHEMA,
    writesCanonicalState: false,
    historicalOpeningAsOf: result.historicalOpeningAsOf,
    effectiveAsOf: result.effectiveAsOf
      || (result.data.liveOverlay && result.data.liveOverlay.effectiveAsOf)
      || null,
    overlayCount: result.overlays.length,
    refusedCount: result.refused.length,
    overlays: result.data.liveOverlay && result.data.liveOverlay.overlays,
    refused: result.data.liveOverlay && result.data.liveOverlay.refused,
    forecast: figures,
    operatingAnswer: figures.operatingAnswer,
  };
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/live-plan.js --fixture <file>\n'
      + '       node scripts/live-plan.js --live\n'
      + 'Read-only. Never writes data.json or snapshots.\n'
    );
    return 0;
  }
  if (args.live && args.fixture) fail('Use either --fixture or --live, not both.');
  if (!args.live && !args.fixture) fail('Pass --fixture <file> or --live.');
  const data = loadJson(args.data);
  const baseline = clone(data);
  const identity = loadIdentity();
  let result;
  if (args.live) {
    const mapPath = args.map
      || (fs.existsSync(O.LOCAL_MAP) ? O.LOCAL_MAP : O.DEFAULT_MAP);
    const accountMap = loadJson(mapPath);
    O.assertLiveMap(accountMap, { data });
    const now = new Date().toISOString();
    const payload = await O.fetchLunchMoneyLive(
      await O.resolveLiveToken(),
      now,
      livePostedHistoryDays(data, now, identity)
    );
    result = fromObservation({ data, payload, accountMap, identity });
  } else {
    const mapPath = args.map || O.FIXTURE_MAP;
    result = fromObservation({
      data,
      payload: loadJson(args.fixture),
      accountMap: loadJson(mapPath),
      identity,
    });
  }
  const printed = summary(result, baseline);
  if (!C.identityProofLooksSanitized(printed) || !O.identityProofLooksSanitized(printed)) {
    fail('Live plan output is not sanitized.');
  }
  process.stdout.write(`${JSON.stringify(printed, null, 2)}\n`);
  return 0;
}

const api = {
  SCHEMA,
  POSTED_CASH,
  OPERATING_PLAN_LIVE,
  OPERATING_PLAN_DATED,
  OPERATING_PLAN_UNAVAILABLE,
  OPERATING_PLAN_UNAVAILABLE_NOTE,
  overlayModeFromEnv,
  sanitizeLiveFailureReason,
  proposeOverlay,
  overlayLiveState,
  paydayGapCashFromReport,
  collectObservedCash,
  fromObservation,
  forecastFrom,
  liveAsOfFrom,
  scheduledCashEventsOn,
  serveCanonicalOrFixture,
  applyForServer,
  acquireSettlementForServer,
  livePostedHistoryDays,
  failedOverlay,
  snapshotPaths,
  parseArgs,
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
