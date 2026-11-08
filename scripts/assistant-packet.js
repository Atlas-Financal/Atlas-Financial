'use strict';
/* Sanitized read-only Atlas packet for an assistant consumer.
 *
 * This module DERIVES a machine-readable snapshot from incumbent authorities:
 *   - Forecast (sole planning / calculation authority)
 *   - scripts/live-plan.js (already-served overlay or fail-closed opening)
 *   - generated public/periods.json (historical actuals)
 *   - docs/01_OPEN_QUESTIONS.md (OPEN / ASKED / BLOCKED status)
 *   - data.json plan.decisionPosture (owner-stated policy labels only;
 *     Forecast does not apply that row in this slice)
 *
 * It is not a planner, not a second Forecast, not a transaction store, and
 * not a copy of household facts. If an incumbent has no answer, the packet
 * records unavailable/unknown. It never writes.
 *
 * HTTP consumers: GET /assistant/current (Bearer ATLAS_ASSISTANT_TOKEN);
 * GET /talk/context (household session); POST /talk/ask (household session,
 * same packet as Gemini explainer evidence). POST /assistant/mcp exposes that
 * same packet as one OAuth-protected, read-only MCP tool. Auth and transport
 * stay outside this projection; do not import either here.
 */

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const SalaryDiagnostic = require('./salary-match-diagnostic.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'atlas-assistant-packet/v1';
const DEFAULT_PERIODS = path.join(ROOT, 'public', 'periods.json');
const DEFAULT_QUESTIONS = path.join(ROOT, 'docs', '01_OPEN_QUESTIONS.md');
const CANONICAL_STATUSES = ['OPEN', 'ASKED', 'ANSWERED', 'BLOCKED'];
const UNRESOLVED = new Set(['OPEN', 'ASKED', 'BLOCKED']);
const TOKEN_MIN_LENGTH = 32;

function round2(value) {
  if (value == null || !isFinite(Number(value))) return value;
  return Math.round(Number(value) * 100) / 100;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unavailable(reason) {
  return { status: 'unavailable', reason: reason || 'unknown' };
}

// ATLAS-080 publication gating: the settlement evidence loader's
// tri-state outcome reaches this surface as a status carried ALONGSIDE
// the evidence on the served data (data.settlementEvidenceStatus /
// data.settlementEvidence) — never inside the evidence. The reason
// vocabulary is the loader's stable set (settlement-evidence-loader.js
// REASONS); anything outside it is malformed. A malformed status, a
// qualified status without valid effective evidence, or evidence
// presented under any non-qualified status fails closed as
// unavailable('invalid-configuration') — never as unconfigured, so a
// configured-but-broken store can never masquerade as "never
// configured" and publish settlement-dependent figures.
const SETTLEMENT_EVIDENCE_REASONS = new Set([
  'invalid-configuration', 'pin-unavailable', 'pin-invalid',
  'document-unavailable', 'document-missing', 'document-malformed',
  'household-mismatch', 'revision-mismatch', 'document-ahead-of-pin',
  'digest-mismatch', 'document-invalid', 'document-changed',
]);

// The effective projection's structural contract, mirrored from
// planned-obligation-settlement-contract.js (goalId, operation and
// txRef formats, positive safe-integer cents, real calendar dates,
// sha256 evidence digests, reversal records). Forecast's settlement
// index silently SKIPS entries and links that fail these shapes
// while still applying the rest — under a qualified label that
// would publish legacy figures as if the evidence were whole. The
// projection is keyed one entry per goal with unique operation
// identities, so duplicates are malformed too. A shared txRef
// across goals is NOT malformed: the contract budgets one payment
// across split assignments.
function settlementDateValid(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function settlementEvidenceValid(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  if (!Array.isArray(evidence.commitments)) return false;
  const goals = new Set();
  const operations = new Set();
  for (const entry of evidence.commitments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (typeof entry.goalId !== 'string'
      || !entry.goalId.startsWith('commitment:')
      || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry.goalId.slice('commitment:'.length))) return false;
    if (goals.has(entry.goalId)) return false;
    goals.add(entry.goalId);
    if (!Array.isArray(entry.links) || entry.links.length === 0) return false;
    for (const link of entry.links) {
      if (!link || typeof link !== 'object' || Array.isArray(link)) return false;
      if (typeof link.operationId !== 'string'
        || !/^operation-[a-f0-9]{32}$/.test(link.operationId)) return false;
      if (operations.has(link.operationId)) return false;
      operations.add(link.operationId);
      if (typeof link.txRef !== 'string' || !/^tx-[a-f0-9]{32}$/.test(link.txRef)) return false;
      if (!Number.isSafeInteger(link.assignedCents) || link.assignedCents <= 0) return false;
      if (!settlementDateValid(link.effectiveDate) || !settlementDateValid(link.asOf)) return false;
      if (typeof link.evidenceDigest !== 'string'
        || !/^[a-f0-9]{64}$/.test(link.evidenceDigest)) return false;
      if (!Array.isArray(link.reversals)) return false;
      for (const reversal of link.reversals) {
        if (!reversal || typeof reversal !== 'object' || Array.isArray(reversal)) return false;
        if (typeof reversal.operationId !== 'string'
          || !/^operation-[a-f0-9]{32}$/.test(reversal.operationId)) return false;
        if (operations.has(reversal.operationId)) return false;
        operations.add(reversal.operationId);
        if (typeof reversal.counterTxRef !== 'string'
          || !/^tx-[a-f0-9]{32}$/.test(reversal.counterTxRef)) return false;
        if (!Number.isSafeInteger(reversal.cents) || reversal.cents <= 0) return false;
        if (!settlementDateValid(reversal.date)) return false;
      }
    }
  }
  return true;
}

function settlementOutcomeOf(data) {
  const status = data ? data.settlementEvidenceStatus : undefined;
  const evidence = data ? data.settlementEvidence : undefined;
  const invalid = { kind: 'unavailable', reason: 'invalid-configuration' };
  // A published null status is a malformed outcome, not an omitted
  // one: omitted (undefined) is the unconfigured seam, while null is
  // a configured outcome that failed to serialize — fail closed
  // rather than equate it with inactivity.
  if (status === null) return invalid;
  const hasStatus = status !== undefined;
  const hasEvidence = evidence !== undefined && evidence !== null;
  if (!hasStatus && !hasEvidence) return { kind: 'unconfigured' };
  if (!hasStatus || typeof status !== 'object' || Array.isArray(status)) return invalid;
  if (status.status === 'unconfigured') {
    return hasEvidence ? invalid : { kind: 'unconfigured' };
  }
  if (status.status === 'qualified') {
    return hasEvidence && settlementEvidenceValid(evidence)
      ? { kind: 'qualified', evidence }
      : invalid;
  }
  if (status.status === 'unavailable') {
    if (hasEvidence) return invalid;
    return SETTLEMENT_EVIDENCE_REASONS.has(status.reason)
      ? { kind: 'unavailable', reason: status.reason }
      : invalid;
  }
  return invalid;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadPeriods(file) {
  const target = file || DEFAULT_PERIODS;
  if (!fs.existsSync(target)) return null;
  return loadJson(target);
}

function parseOpenQuestions(markdown) {
  const text = String(markdown || '');
  const questions = [];
  const seen = new Set();
  const headingRe = /^###\s+(Q\d+[a-zA-Z]?)\.\s+(.+?)\s*$/gm;
  let match;
  while ((match = headingRe.exec(text))) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const title = match[2].replace(/\s*[—–-]\s*ANSWERED\b.*$/i, '').trim();
    const rest = text.slice(match.index + match[0].length);
    const nextHeading = rest.search(/\n###\s+/);
    const body = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    const statusLine = /\*\*Status:\*\*\s*([^\n]+)/.exec(body);
    let status = null;
    if (statusLine) {
      const raw = statusLine[1].trim();
      if (!/^PARTIALLY\b/i.test(raw)) {
        const tok = new RegExp(`^(${CANONICAL_STATUSES.join('|')})\\b`, 'i').exec(raw);
        status = tok ? tok[1].toUpperCase() : null;
      }
    } else if (/\bANSWERED\b/i.test(match[2])) {
      status = 'ANSWERED';
    }
    const ownerLine = /\*\*Owner:\*\*\s*([^\n]+)/.exec(body);
    const owner = ownerLine ? ownerLine[1].replace(/\s*·.*$/, '').trim() : null;
    questions.push({ id, title, status, owner });
  }
  return questions;
}

function unresolvedQuestions(markdown) {
  return parseOpenQuestions(markdown)
    .filter(q => UNRESOLVED.has(q.status))
    .map(q => ({
      id: q.id,
      title: q.title,
      status: q.status,
      owner: q.owner || null,
    }));
}

function versionIdentifier(env) {
  const sourceEnv = env || {};
  const render = sourceEnv.RENDER_GIT_COMMIT;
  const override = sourceEnv.ATLAS_GIT_SHA;
  const sha = render || override || null;
  if (sha && /^[0-9a-f]{7,40}$/i.test(String(sha))) {
    return {
      gitSha: String(sha),
      source: render ? 'RENDER_GIT_COMMIT' : 'ATLAS_GIT_SHA',
    };
  }
  return { gitSha: null, source: 'unknown' };
}

function effectiveAsOf(data) {
  const overlay = data && data.liveOverlay;
  if (overlay && overlay.applied === true && overlay.effectiveAsOf) {
    return overlay.effectiveAsOf;
  }
  return (data && data.plan && data.plan.opening && data.plan.opening.asOf)
    || (data && data.meta && data.meta.asOf)
    || null;
}

function operatingPlanUnavailable(data, advice) {
  const overlay = data && data.liveOverlay;
  return (overlay && overlay.operatingPlan === 'unavailable')
    || (advice && (advice.operatingPlanUnavailable === true
      || advice.cardCoverageUnavailable === true));
}

function operatingPlanNote(data, advice) {
  const overlay = data && data.liveOverlay;
  return (advice && advice.operatingPlanNote)
    || (overlay && overlay.operatingPlanNote)
    || 'Current plan unavailable. The dated opening is stale.';
}

// ATLAS-077: Forecast's named scheduled-amount state. recommend
// attaches it to its result only when unavailable, and projectDebts
// carries its own for the debt-walk window; either way, an attached
// unavailable state names dated amounts the packet's claims may
// depend on. This is NOT the operatingPlan gate: publications the
// unknowns do not touch stay ready, and only the affected claims
// below are qualified.
function scheduledAmountsOf(result) {
  const state = result && result.scheduledAmounts;
  return state && state.status === 'unavailable' ? state : null;
}

function scheduledAmountsProjection(state) {
  return {
    status: 'unavailable',
    reason: state.reason || 'scheduled-amount-unknown',
    unknowns: (Array.isArray(state.unknowns) ? state.unknowns : []).map(u => ({
      carrier: u.carrier || null,
      id: u.id || null,
      date: u.date || null,
      reason: u.reason || 'scheduled-amount-unknown',
    })),
  };
}

// An unknown dated on or before a claim's date sits where the
// claim asserts order or completeness: an earlier dated amount the
// packet cannot quantify means the "next" obligation or the day
// total built past it is not certifiable, however well-known the
// later rows are. The state's unknowns are unresolved by
// construction — waived, settled, excused and known rows never
// reach it — and a once outflow dated before the as-of is still
// owed (Forecast carries it at the opening), so no as-of lower
// bound applies here: an overdue unknown is an earlier obligation
// a "next" claim cannot skip.
function scheduledUnknownOnOrBefore(state, date) {
  if (!state || !date) return false;
  return (Array.isArray(state.unknowns) ? state.unknowns : [])
    .some(u => u.date && u.date <= date);
}

// The nearBoundary total is a sum over its own dated window
// [as-of, until]: only an unknown dated inside that window enters
// the sum's completeness. An overdue unknown is not an item of
// that window and does not qualify it.
function scheduledUnknownWithin(state, asOf, date) {
  if (!state || !date) return false;
  return (Array.isArray(state.unknowns) ? state.unknowns : [])
    .some(u => u.date && u.date >= asOf && u.date <= date);
}

function canonicalAsOf(data) {
  const overlay = data && data.liveOverlay;
  if (overlay && overlay.historicalOpeningAsOf) return overlay.historicalOpeningAsOf;
  return (data && data.plan && data.plan.opening && data.plan.opening.asOf)
    || (data && data.meta && data.meta.asOf)
    || null;
}

function money(value) {
  if (value == null || !isFinite(Number(value))) return null;
  return round2(value);
}

function allocatedMoney(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return money(row.allocated);
}

function closedPeriodBillConfidence(tag) {
  return tag === 'confirmed' || tag === 'estimated' || tag === 'planned' ? tag : null;
}

function closedPeriodBillSettlement(tag) {
  return tag === 'upcoming' || tag === 'unverified' || tag === 'represented'
    ? tag
    : null;
}

function clipPacketText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

// Copy one Forecast current-period bill. Settlement is Forecast-owned
// (represented | upcoming | unverified). Talk does not date-filter this
// list, invent paid rows, or treat unverified as unpaid.
function projectCurrentPeriodBill(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = clipPacketText(item.id, 80);
  const label = clipPacketText(item.label, 120);
  if (!id && !label) return null;
  const row = {
    id,
    label,
    date: clipPacketText(item.date, 40),
    planned: money(item.planned),
    remaining: money(item.remaining),
    actual: item.actual == null ? null : money(item.actual),
    settlement: closedPeriodBillSettlement(item.settlement),
    confidence: closedPeriodBillConfidence(item.confidence),
  };
  // The owner's schedule-trust rule settled it on its due date; no bank
  // transaction was seen. Talk must not describe it as an observed payment.
  if (item.settlementBasis === 'schedule-trust-on-due') row.settlementBasis = 'schedule-trust-on-due';
  return row;
}

// The packet carries at most CURRENT_PERIOD_BILLS_MAX rows. billsTotal is
// Forecast's own row count and billsTruncated says the carried list is not
// all of them (capped, or a row could not be projected), so Talk never
// reads a short list as the whole pay period.
const CURRENT_PERIOD_BILLS_MAX = 32;

function projectCurrentPeriodBills(items) {
  if (!Array.isArray(items)) return null;
  const out = [];
  for (const item of items) {
    if (out.length >= CURRENT_PERIOD_BILLS_MAX) break;
    const row = projectCurrentPeriodBill(item);
    if (row) out.push(row);
  }
  return out;
}

function currentPeriodBillsCompleteness(items, listed) {
  if (!Array.isArray(items) || !Array.isArray(listed)) return {};
  return {
    billsTotal: items.length,
    billsTruncated: listed.length < items.length,
  };
}

function currentPeriodBillsSection(action) {
  if (action.unavailable === true) return { bills: null };
  const bills = projectCurrentPeriodBills(action.bills);
  return { bills, ...currentPeriodBillsCompleteness(action.bills, bills) };
}

// Current-pay-period Balance After Deductions. Copies the active calendar
// waterfall remainder (income − bills − Household Budget). Talk leftover
// reprints this Forecast identity; it does not reconstruct one from
// paydayAllocation.runningLeftover. Packet path stays
// forecast.predictedEndingBalance for Talk allowlist continuity.
function projectPredictedEndingBalance(advice) {
  const periods = advice && advice.defaultView && advice.defaultView.calendarPeriods;
  const active = Array.isArray(periods)
    ? periods.find(row => row && row.role === 'active')
    : null;
  const amount = active && (active.balanceAfterDeductions != null
    ? active.balanceAfterDeductions
    : active.afterHouseholdBudget);
  if (amount == null || !Number.isFinite(Number(amount))) {
    return unavailable('balance-after-deductions-unavailable');
  }
  return {
    status: 'ok',
    source: 'Forecast.calendarPeriodWaterfalls',
    identity: 'balance-after-deductions',
    amount: money(amount),
    periodStart: active.start || null,
    periodEnd: active.end || null,
  };
}


// Smallest operating-picture projection: copy Forecast leftover stages plus
// the leftover-consuming allocated amounts Talk reprints. Talk does not
// reconstruct a stage by subtracting. This is not a payday calculator.
function projectPaydayAllocation(advice) {
  const alloc = advice && advice.paydayAllocation;
  const leftover = alloc && alloc.runningLeftover;
  if (!leftover || typeof leftover !== 'object' || Array.isArray(leftover)) {
    return unavailable('payday-leftover-unavailable');
  }
  // N3: the remainder chain is Unknown (null) while this period's spending is incomplete; the
  // block says so with Forecast's reason instead of reading as a complete answer.
  const estimate = alloc.coverageEstimate && alloc.coverageEstimate.status === 'estimated'
    ? alloc.coverageEstimate : null;
  return {
    status: estimate ? 'estimated' : 'ok',
    ...(estimate ? { reason: estimate.reason } : {}),
    source: 'Forecast.paydayAllocation',
    runningLeftover: {
      currentBalance: money(leftover.currentBalance),
      afterBills: money(leftover.afterBills),
      afterHouseholdBudget: money(leftover.afterHouseholdBudget),
      afterDebtRepayment: money(leftover.afterDebtRepayment),
      afterBigPurchases: money(leftover.afterBigPurchases),
    },
    obligations: { allocated: allocatedMoney(alloc.obligations) },
    essentials: { allocated: allocatedMoney(alloc.essentials) },
    extraDebt: { allocated: allocatedMoney(alloc.extraDebt) },
  };
}

function trajectoryAsOfDate(data) {
  return (data && data.meta && data.meta.asOf)
    || (data && data.plan && data.plan.opening && data.plan.opening.asOf)
    || null;
}

function projectBaselineTrajectoryIncome(income) {
  if (!income || typeof income !== 'object' || Array.isArray(income)) {
    return { status: 'unavailable', reason: 'Forecast unavailable.' };
  }
  const row = { status: income.status || 'unavailable' };
  if (income.amount != null) row.amount = money(income.amount);
  const reason = clipPacketText(income.reason, 500);
  if (reason) row.reason = reason;
  return row;
}

function projectBaselineTrajectoryCash(cash) {
  if (!cash || typeof cash !== 'object' || Array.isArray(cash)) {
    return { status: 'unavailable', reason: 'Forecast unavailable.' };
  }
  const row = { status: cash.status || 'unavailable' };
  if (cash.amount != null) row.amount = money(cash.amount);
  if (cash.asOf) row.asOf = clipPacketText(cash.asOf, 40);
  if (cash.identity) row.identity = clipPacketText(cash.identity, 80);
  if (cash.roadAheadFunding === false) row.roadAheadFunding = false;
  const reason = clipPacketText(cash.reason, 500);
  if (reason) row.reason = reason;
  return row;
}

function projectBaselineTrajectoryDebt(debt) {
  if (!debt || typeof debt !== 'object' || Array.isArray(debt)) {
    return { status: 'unavailable', reason: 'Forecast unavailable.' };
  }
  const row = { status: debt.status || 'unavailable' };
  if (debt.consumer != null) row.consumer = money(debt.consumer);
  if (debt.secured != null) row.secured = money(debt.secured);
  if (debt.heloc != null) row.heloc = money(debt.heloc);
  if (debt.asOf) row.asOf = clipPacketText(debt.asOf, 40);
  const reason = clipPacketText(debt.reason, 500);
  if (reason) row.reason = reason;
  return row;
}

function projectBaselineTrajectoryMonth(month) {
  if (!month || typeof month !== 'object' || Array.isArray(month)) return null;
  const monthKey = clipPacketText(month.month, 16);
  if (!monthKey) return null;
  const row = {
    month: monthKey,
    periodStart: clipPacketText(month.start, 40),
    periodEnd: clipPacketText(month.end, 40),
    income: projectBaselineTrajectoryIncome(month.income),
    cash: projectBaselineTrajectoryCash(month.cash),
    debt: projectBaselineTrajectoryDebt(month.debt),
  };
  return row;
}

// Same Forecast.baselineTrajectory call and reprint surface as public/planning.js.
// Not gated on liveOverlay.operatingPlan — Planning still prints trajectory when
// current operating verdicts are withheld.
function projectBaselineTrajectory(data, periods, settlementEvidence) {
  const plan = data && data.plan;
  const asOf = trajectoryAsOfDate(data);
  if (!plan || !asOf) {
    return unavailable('baseline-trajectory-unavailable');
  }
  const overlay = data && data.liveOverlay;
  const actuals = overlay && overlay.applied === true ? overlay.currentPeriodActuals : null;
  const trajectory = Forecast.baselineTrajectory(plan, data.debts, asOf, {
    periods: periods || null,
    extraFacilities: data.revolvingExtra,
    currentPeriodActuals: actuals,
    ...(settlementEvidence ? { settlementEvidence } : {}),
  });
  if (!trajectory || trajectory.status !== 'ready') {
    const reason = clipPacketText(trajectory && trajectory.reason, 500)
      || 'Baseline trajectory unavailable.';
    return {
      status: (trajectory && trajectory.status) || 'unavailable',
      source: 'Forecast.baselineTrajectory',
      reason,
    };
  }
  const months = [];
  for (const month of trajectory.months || []) {
    const row = projectBaselineTrajectoryMonth(month);
    if (row) months.push(row);
  }
  const regimes = Array.isArray(trajectory.incomeRegimes)
    ? trajectory.incomeRegimes.map(regime => ({
      id: clipPacketText(regime && regime.id, 80),
      status: clipPacketText(regime && regime.status, 40),
      through: clipPacketText(regime && regime.through, 40),
      from: clipPacketText(regime && regime.from, 40),
      note: clipPacketText(regime && regime.note, 500),
      reason: clipPacketText(regime && regime.reason, 500),
    })).filter(row => row.id)
    : [];
  return {
    status: 'ready',
    source: 'Forecast.baselineTrajectory',
    asOf: trajectory.asOf || asOf,
    horizonEnd: trajectory.horizon && trajectory.horizon.end
      ? trajectory.horizon.end
      : null,
    weeklyVariable: trajectory.weeklyVariable && trajectory.weeklyVariable.amount != null
      ? money(trajectory.weeklyVariable.amount)
      : null,
    normalSpending: trajectory.normalSpending && trajectory.normalSpending.status
      ? {
        status: clipPacketText(trajectory.normalSpending.status, 40),
        phrase: clipPacketText(trajectory.normalSpending.phrase, 240),
        reason: clipPacketText(trajectory.normalSpending.reason, 500),
        trust: clipPacketText(trajectory.normalSpending.trust, 40),
        fallback: clipPacketText(trajectory.normalSpending.fallback, 80),
      }
      : null,
    roadAheadSurplusDeficit: trajectory.roadAheadSurplusDeficit
      ? {
        identity: clipPacketText(trajectory.roadAheadSurplusDeficit.identity, 80),
        priorPeriodSurplus: clipPacketText(trajectory.roadAheadSurplusDeficit.priorPeriodSurplus, 40),
        source: clipPacketText(trajectory.roadAheadSurplusDeficit.source, 40),
        cumulativeCash: clipPacketText(trajectory.roadAheadSurplusDeficit.cumulativeCash, 40),
      }
      : null,
    incomeRegimes: regimes.length ? regimes : null,
    months,
  };
}

function trustFor(value) {
  if (value == null) return 'unknown';
  return 'calculated';
}

const SOURCE_CONFIDENCE = new Set(['confirmed', 'estimated', 'planned']);
const CONFIDENCE_RANK = {
  unknown: 0,
  planned: 1,
  estimated: 2,
  confirmed: 3,
};

function sourceConfidence(event) {
  const tag = event && event.confidence;
  return SOURCE_CONFIDENCE.has(tag) ? tag : 'unknown';
}

function conservativeConfidence(tags) {
  const list = Array.isArray(tags) ? tags : [];
  if (!list.length) return 'unknown';
  let weakest = Infinity;
  for (const tag of list) {
    const normalized = SOURCE_CONFIDENCE.has(tag) ? tag : 'unknown';
    const rank = CONFIDENCE_RANK[normalized];
    if (rank < weakest) weakest = rank;
  }
  if (weakest === CONFIDENCE_RANK.unknown) return 'unknown';
  if (weakest === CONFIDENCE_RANK.planned) return 'planned';
  if (weakest === CONFIDENCE_RANK.estimated) return 'estimated';
  return 'confirmed';
}

function isNamedOutflow(event) {
  return !!(event && event.amount < 0 && event.kind !== 'noncash');
}

function isJointCashOutflow(event) {
  return isNamedOutflow(event) && event.jointCash !== false;
}

// The source event behind Forecast.nextDue, found by the same due-day rule
// (Forecast.dueOnOrAfter): an overdue outflow the walk still carries is due
// at as-of, so its own confidence tags the claim instead of 'unknown'.
function earliestNamedOutflow(events, asOf) {
  let best = null;
  let bestDate = null;
  for (const event of events || []) {
    if (!isNamedOutflow(event)) continue;
    const due = Forecast.dueOnOrAfter(event, asOf);
    if (due == null) continue;
    if (!best || due < bestDate) { best = event; bestDate = due; }
  }
  return best ? Object.assign({}, best, { date: bestDate }) : null;
}

function sameDayJointCashOutflows(events, asOf, date) {
  if (!date) return [];
  return (events || []).filter(event =>
    isJointCashOutflow(event) && Forecast.dueOnOrAfter(event, asOf) === date
  );
}

function eventByIdDate(events, id, date) {
  if (id == null || date == null) return null;
  for (const event of events || []) {
    if (event && event.id === id && event.date === date) return event;
  }
  return null;
}

function forecastAdvice(data, periods, settlementEvidence) {
  const plan = data && data.plan;
  const asOf = effectiveAsOf(data);
  if (!plan || !asOf) return null;
  const overlay = data.liveOverlay;
  const actuals = overlay && overlay.applied === true
    ? overlay.currentPeriodActuals
    : null;
  return Forecast.recommend(plan, asOf, {
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    periods: periods || null,
    currentPeriodActuals: actuals,
    operatingPlan: overlay && overlay.operatingPlan,
    operatingPlanNote: overlay && overlay.operatingPlanNote,
    ...(settlementEvidence ? { settlementEvidence } : {}),
  });
}

function projectDebtsFromAdvice(data, asOf, advice) {
  if (!advice || !data || !asOf) return null;
  return Forecast.projectDebts(data.plan, data.debts, asOf, Object.assign({},
    advice.simOptions || {}, {
      weeklyVariable: advice.weekly,
      extraFacilities: data.revolvingExtra,
    }));
}

// Bounded source-check receipt (metadata.sourceCheck). Projects only the
// serve lifecycle result the server captured for this read: whether the
// provider check behind the packet qualified, when its evidence was
// originally fetched, and when the serve completed. It never derives
// qualification from generatedAt, transport success, or the freshness block,
// and it never republishes raw overlay reason/error text — outcomes, sources
// and reasons come from the closed sets below, and any malformed or
// contradictory capture fails closed to the unavailable form.
const SOURCE_CHECK_SOURCES = new Set(['provider', 'memory']);
const SOURCE_CHECK_CACHE_NOTE =
  'Source evidence is process-local warm reuse; it can disappear on restart, sleep or deploy.';

function sourceCheckTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  let offsetMs = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offsetHour = Number(digits.slice(0, 2));
    const offsetMinute = Number(digits.slice(2, 4));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMs = sign * (offsetHour * 60 + offsetMinute) * 60000;
  }
  // Date.parse/Date.UTC normalize impossible calendar dates (2026-02-29
  // becomes March 1), so validity is proven by a component round-trip:
  // rebuild the instant and read every field back in the stated offset.
  const utcMs = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
    fraction ? Number((fraction + '000').slice(0, 3)) : 0) - offsetMs;
  if (!Number.isFinite(utcMs)) return null;
  const back = new Date(utcMs + offsetMs);
  const coherent =
    back.getUTCFullYear() === Number(year)
    && back.getUTCMonth() === Number(month) - 1
    && back.getUTCDate() === Number(day)
    && back.getUTCHours() === Number(hour)
    && back.getUTCMinutes() === Number(minute)
    && back.getUTCSeconds() === Number(second);
  return coherent ? value : null;
}

function projectSourceCheck(input) {
  const raw = input && typeof input === 'object' ? input : null;
  const attemptedAt = sourceCheckTimestamp(raw && raw.attemptedAt);
  const unavailable = reason => ({
    outcome: 'unavailable',
    source: null,
    qualified: false,
    evidenceCheckedAt: null,
    attemptedAt,
    reason,
    cacheNote: null,
  });
  // No captured check means no provider check was attempted by this serve
  // (off/fixture/canonical modes): attemptedAt stays null and the packet's
  // generatedAt remains the serve time. A captured check — coherent or not —
  // keeps the serve-completion stamp, so an attempt is never confused with
  // evidence and a non-attempt is never dressed up as one.
  if (!raw || raw.check == null) {
    return {
      outcome: 'unavailable',
      source: null,
      qualified: false,
      evidenceCheckedAt: null,
      attemptedAt: null,
      reason: 'no-provider-check',
      cacheNote: null,
    };
  }
  const check = raw.check;
  if (typeof check !== 'object') return unavailable('invalid-source-check');
  const source = SOURCE_CHECK_SOURCES.has(check.source) ? check.source : null;
  const evidenceCheckedAt = sourceCheckTimestamp(check.checkedAt);
  const cacheNote = source === 'memory' ? SOURCE_CHECK_CACHE_NOTE : null;
  if (check.qualified === true) {
    // Qualified requires a coherent capture: an allowed source AND the
    // check's valid original evidence timestamp AND the strict flag.
    if (source && evidenceCheckedAt) {
      return {
        outcome: 'qualified', source, qualified: true,
        evidenceCheckedAt, attemptedAt, reason: null, cacheNote,
      };
    }
    return unavailable('invalid-source-check');
  }
  if (check.qualified === false) {
    // The negative outcomes also require a coherent capture: an unlisted
    // source means no legitimate check ran, so fail closed like the
    // qualified branch instead of claiming unqualified/failed.
    if (!source) return unavailable('invalid-source-check');
    if (evidenceCheckedAt) {
      return {
        outcome: 'unqualified', source, qualified: false,
        evidenceCheckedAt, attemptedAt, reason: 'reconciliation-not-ready', cacheNote,
      };
    }
    if (check.checkedAt === null) {
      return {
        outcome: 'failed', source, qualified: false,
        evidenceCheckedAt: null, attemptedAt, reason: 'provider-check-failed', cacheNote,
      };
    }
    return unavailable('invalid-source-check');
  }
  return unavailable('invalid-source-check');
}

function metadataBlock(data, opts, advice, settlement) {
  const salaryMatcherDiagnostic = SalaryDiagnostic.project(
    data?.liveOverlay?.observationReceipt?.salaryMatcherDiagnostic);
  const overlay = data && data.liveOverlay;
  const applied = !!(overlay && overlay.applied === true);
  const liveAsOf = applied
    ? (overlay.observedAsOf || overlay.effectiveAsOf || null)
    : null;
  let confidence = 'canonical-opening';
  if (applied) confidence = 'live';
  else if (overlay && overlay.applied === false) confidence = 'canonical-opening';
  const coverage = Array.isArray(data && data.coverage)
    ? data.coverage.map(row => ({
      source: row.source || null,
      what: row.what || null,
      status: row.status || null,
    }))
    : unavailable('no-coverage-rows');
  return {
    generatedAt: opts.now,
    canonicalAsOf: canonicalAsOf(data),
    liveObservationAsOf: liveAsOf,
    effectiveAsOf: effectiveAsOf(data),
    version: versionIdentifier(opts.env),
    ...(salaryMatcherDiagnostic ? { observationReceipt: { salaryMatcherDiagnostic } } : {}),
    sourceCheck: projectSourceCheck(opts.sourceCheck),
    // ATLAS-080: the loader outcome, projected as status + reason
    // only — never the evidence, the document, or its history. The
    // key is absent entirely when unconfigured, so an unconfigured
    // packet stays byte-identical to one built before this field
    // existed.
    ...(settlement && settlement.kind !== 'unconfigured' ? {
      settlementEvidence: settlement.kind === 'qualified'
        ? { status: 'qualified', reason: null }
        : { status: 'unavailable', reason: settlement.reason },
    } : {}),
    freshness: {
      liveOverlayApplied: applied,
      liveOverlayReason: overlay && overlay.reason ? overlay.reason : null,
      confidence,
      writesCanonicalState: false,
    },
    coverage: {
      summary: (data && data.meta && data.meta.coverage) || null,
      sources: coverage,
      knowledgeHorizonDays: advice && advice.knowledge ? advice.knowledge.days : null,
    },
  };
}

function currentBlock(data, asOf, advice, used, settlement) {
  const plan = data && data.plan;
  if (!plan || !asOf) {
    return {
      spendableHouseholdCash: unavailable('missing-opening'),
      pending: unavailable('missing-opening'),
      debts: unavailable('missing-opening'),
      nextSignificantObligations: unavailable('missing-opening'),
    };
  }
  const planUnavailable = operatingPlanUnavailable(data, advice);
  const unavailableReason = operatingPlanNote(data, advice);
  const spendable = Forecast.startingCashAmount(plan);
  const events = advice && advice.sim && advice.sim.events
    ? advice.sim.events
    : null;
  const nextDue = events ? Forecast.nextDue(events, asOf) : null;
  const nextOut = events ? Forecast.nextPaymentOut(events, asOf) : null;
  const rows = used && Array.isArray(used.rows)
    ? used.rows.map(row => ({
      id: row.id,
      label: row.label,
      posted: money(row.posted),
      pending: row.pendingUnknown ? null : money(row.pending),
      pendingUnknown: row.pendingUnknown === true,
      used: money(row.used),
      limit: money(row.limit),
      available: money(row.available),
      overLimit: row.overLimit === true,
      utilizationPct: row.pct == null ? null : round2(row.pct),
      trust: row.pendingUnknown ? 'unknown' : 'calculated',
    }))
    : null;
  const snapshot = data.debts
    ? Forecast.compactSnapshot(data.debts, data.helocHistory)
    : null;
  const pendingUnknownCount = rows
    ? rows.filter(row => row.pendingUnknown).length
    : 0;
  const nextDueSource = earliestNamedOutflow(events, asOf);
  const nextDueConfidence = nextDue && nextDueSource
    && nextDueSource.date === nextDue.due
    && nextDueSource.label === nextDue.what
    ? sourceConfidence(nextDueSource)
    : (nextDue ? 'unknown' : null);
  const nextOutConfidence = nextOut
    ? conservativeConfidence(
      sameDayJointCashOutflows(events, asOf, nextOut.date).map(sourceConfidence)
    )
    : null;
  const nearBoundaryItems = advice && advice.nearBoundary
    && Array.isArray(advice.nearBoundary.items)
    ? advice.nearBoundary.items.map(item => {
      const source = eventByIdDate(events, item.id, item.date);
      return {
        date: item.date || null,
        id: item.id || null,
        label: item.label || null,
        amount: money(item.amount),
        confidence: sourceConfidence(source),
      };
    })
    : null;
  // ATLAS-077 (B1a): a scheduled amount unknown dated on or before a
  // next-obligation claim makes that claim an ordering/completeness
  // assertion the packet cannot certify — the unknown row emits no
  // event, so the earliest KNOWN event is not thereby the next
  // obligation. Withhold only the affected claims and carry the
  // named state on the block; claims the unknowns postdate, and the
  // independently known stocks above, stay published. A carried
  // overdue unknown (dated before the as-of, still owed) qualifies
  // the next-obligation claims the same way; the dated nearBoundary
  // sum is qualified only by unknowns inside its own window.
  const schedAmounts = scheduledAmountsOf(advice);
  const nextDueWithheld = !!schedAmounts && !!nextDue
    && scheduledUnknownOnOrBefore(schedAmounts, nextDue.due);
  const nextOutWithheld = !!schedAmounts && !!nextOut
    && scheduledUnknownOnOrBefore(schedAmounts, nextOut.date);
  const nearBoundaryWithheld = !!schedAmounts && !!nearBoundaryItems
    && !!(advice.nearBoundary && advice.nearBoundary.until)
    && scheduledUnknownWithin(schedAmounts, asOf, advice.nearBoundary.until);
  const nextClaimsQualified = nextDueWithheld || nextOutWithheld || nearBoundaryWithheld;
  return {
    spendableHouseholdCash: advice?.cardCoverageUnavailable === true
      && !(data.liveOverlay && data.liveOverlay.operatingPlan === 'unavailable')
      ? { status: 'unavailable', value: null, reason: unavailableReason,
        observedCash: Number.isFinite(spendable) ? money(spendable) : null,
        asOf, source: 'Forecast.recommend' }
      : Number.isFinite(spendable)
      ? (planUnavailable
        ? {
          status: 'dated-opening',
          current: false,
          value: money(spendable),
          asOf: canonicalAsOf(data),
          trust: trustFor(spendable),
          source: 'Forecast.startingCashAmount',
          note: unavailableReason,
        }
        : {
          status: 'ok',
          value: money(spendable),
          trust: trustFor(spendable),
          source: 'Forecast.startingCashAmount',
        })
      : unavailable('starting-cash-not-finite'),
    pending: used
      ? {
        status: 'ok',
        totalKnownPending: money(used.totalPending),
        unknownFacilityCount: pendingUnknownCount,
        freshness: pendingUnknownCount > 0 ? 'incomplete' : 'known',
        source: 'Forecast.utilisation',
      }
      : unavailable('utilisation-unavailable'),
    debts: rows
      ? {
        status: 'ok',
        source: 'Forecast.utilisation',
        totalAvailableCredit: money(used.totalAvailable),
        overLimitCount: used.overLimitCount,
        securedDebt: snapshot ? money(snapshot.secured) : null,
        monthlyInterest: snapshot ? money(snapshot.monthlyInterest) : null,
        helocDirection: snapshot && snapshot.heloc ? snapshot.heloc : null,
        facilities: rows,
      }
      : unavailable('utilisation-unavailable'),
    nextSignificantObligations: settlement && settlement.kind === 'unavailable'
      ? { status: 'unavailable', reason: settlement.reason }
      : (planUnavailable
      ? unavailable(unavailableReason)
      : events
      ? {
        status: 'ok',
        source: 'Forecast.nextDue / Forecast.nextPaymentOut / Forecast.recommend.nearBoundary',
        ...(nextClaimsQualified
          ? { scheduledAmounts: scheduledAmountsProjection(schedAmounts) }
          : {}),
        nextDue: nextDueWithheld ? null : nextDue ? {
          date: nextDue.due,
          label: nextDue.what,
          amount: money(nextDue.amount),
          daysUntil: nextDue.daysUntil,
          confidence: nextDueConfidence,
          ...(nextDue.overdue ? { overdue: true, scheduledDate: nextDue.scheduledDate } : {}),
        } : null,
        nextPaymentOut: nextOutWithheld ? null : nextOut ? {
          date: nextOut.date,
          label: nextOut.label,
          amount: money(nextOut.amount),
          count: nextOut.count,
          daysUntil: nextOut.daysUntil,
          confidence: nextOutConfidence,
          ...(nextOut.overdueCount ? { overdueCount: nextOut.overdueCount, overdueSince: nextOut.overdueSince } : {}),
        } : null,
        nearBoundary: nearBoundaryWithheld ? null : nearBoundaryItems
          ? {
            payday: advice.nearBoundary.payday || null,
            until: advice.nearBoundary.until || null,
            total: money(advice.nearBoundary.total),
            confidence: conservativeConfidence(nearBoundaryItems.map(item => item.confidence)),
            items: nearBoundaryItems,
          }
          : null,
      }
      : unavailable('forecast-events-unavailable')),
  };
}

function forecastBlock(data, asOf, advice, debtProj, periods, settlement) {
  // ATLAS-080: configured-but-unavailable settlement evidence
  // withholds the whole Forecast block wholesale — every key becomes
  // the same named unavailable shape, so no settlement-dependent
  // figure (recommendation, funding need, allocation, ending
  // balance) can survive anywhere inside it. The block is replaced,
  // never decomposed.
  if (settlement && settlement.kind === 'unavailable') {
    const reason = settlement.reason;
    return {
      status: 'unavailable',
      reason,
      source: 'settlement-evidence',
      recommendation: unavailable(reason),
      horizon: unavailable(reason),
      upcomingModeledCommitments: unavailable(reason),
      facilityCrossings: unavailable(reason),
      majorPlanFunding: unavailable(reason),
      currentPeriodAction: unavailable(reason),
      budgetCap: unavailable(reason),
      paydayAllocation: unavailable(reason),
      predictedEndingBalance: unavailable(reason),
    };
  }
  if (!advice) return unavailable('forecast-unavailable');
  if (operatingPlanUnavailable(data, advice)) {
    const reason = operatingPlanNote(data, advice);
    return {
      status: 'unavailable',
      reason,
      source: 'Forecast.recommend',
      recommendation: unavailable(reason),
      horizon: unavailable(reason),
      upcomingModeledCommitments: unavailable(reason),
      facilityCrossings: unavailable(reason),
      majorPlanFunding: unavailable(reason),
      currentPeriodAction: unavailable(reason),
      budgetCap: unavailable(reason),
      paydayAllocation: unavailable(reason),
      predictedEndingBalance: unavailable(reason),
    };
  }
  const horizon = advice.knowledge || Forecast.knowledgeHorizon(data.plan, asOf);
  const capMonthly = advice.weekly == null
    ? null
    : money(Forecast.monthlyFromWeekly(advice.weekly));
  const budget = periods
    ? Forecast.budgetBreakdown(data.plan, periods, {
      asOf,
      weeklyCap: advice.weekly,
    })
    : null;
  const infeasible = advice.infeasible
    ? {
      date: advice.infeasible.date || null,
      label: advice.infeasible.label || advice.infeasible.what || null,
      shortfall: money(advice.infeasible.shortfall || advice.infeasible.amount),
    }
    : null;
  const major = Array.isArray(advice.majorPlans)
    ? advice.majorPlans.map(item => ({
      id: item.id,
      label: item.label,
      date: item.date || null,
      verdict: item.verdict || null,
      ...(item.verdictTrust ? { verdictTrust: item.verdictTrust } : {}),
      flexibility: item.flexibility || null,
      confidence: item.confidence || null,
      need: money(item.need),
      amountMin: money(item.amountMin),
      amountMax: money(item.amountMax),
      margin: money(item.margin),
      remaining: money(item.remaining),
    }))
    : [];
  // N3: verdicts computed while this period's spending is incomplete are estimates, said so
  // with the Forecast-published reason; never 'ok'.
  const coverageEstimate = advice.coverageEstimate && advice.coverageEstimate.status === 'estimated'
    ? advice.coverageEstimate : null;
  const majorStatus = coverageEstimate ? 'estimated' : 'ok';
  const majorReason = coverageEstimate ? { reason: coverageEstimate.reason } : {};
  const crossings = debtProj && Array.isArray(debtProj.crossings)
    ? debtProj.crossings.map(row => ({
      id: row.id,
      label: row.label,
      date: row.date,
      day: row.day,
      limit: money(row.limit),
      alreadyOver: row.alreadyOver === true,
    }))
    : [];
  const debtSchedAmounts = scheduledAmountsOf(debtProj);
  const action = advice.currentPeriodAction || null;
  return {
    status: 'ok',
    source: 'Forecast.recommend',
    recommendation: {
      weekly: money(advice.weekly),
      monthlyEquivalent: capMonthly,
      mode: advice.mode || null,
      // A withheld feasibility verdict is null (unknown) upstream;
      // collapsing it to boolean false would publish a definite
      // "does not hold" the forecast never reached (ATLAS-077 B1a).
      holds: advice.holds == null ? null : advice.holds === true,
      infeasible,
      trust: advice.mode === 'infeasible' ? 'calculated' : trustFor(advice.weekly),
    },
    horizon: horizon
      ? {
        start: horizon.start || null,
        end: horizon.end || null,
        days: horizon.days || null,
        visibleWindowDays: (data.plan && data.plan.windowDays) || null,
        minBalance: advice.knowledge && advice.knowledge.min
          ? money(advice.knowledge.min.balance)
          : null,
        minDate: advice.knowledge && advice.knowledge.min
          ? advice.knowledge.min.date
          : null,
      }
      : unavailable('knowledge-horizon-unavailable'),
    upcomingModeledCommitments: major.length
      ? { status: majorStatus, source: 'Forecast.majorPlans', ...majorReason, items: major }
      : unavailable('no-major-plans'),
    // ATLAS-077 (B1a): when the debt walk withheld uncertain
    // crossings under the named state, an empty list is an
    // unavailable result, not a complete set of zero crossings —
    // it must not be promoted to {ok, []}. Crossings the walk did
    // publish (all established before the first unknown) stay
    // published, with the named state carried as the qualifier.
    facilityCrossings: debtSchedAmounts && !crossings.length
      ? { status: 'unavailable', reason: debtSchedAmounts.reason || 'scheduled-amount-unknown',
        source: 'Forecast.projectDebts',
        scheduledAmounts: scheduledAmountsProjection(debtSchedAmounts) }
      : crossings.length || (debtProj && Array.isArray(debtProj.crossings))
      ? { status: 'ok', source: 'Forecast.projectDebts', items: crossings,
        ...(debtSchedAmounts
          ? { scheduledAmounts: scheduledAmountsProjection(debtSchedAmounts) }
          : {}) }
      : unavailable('debt-projection-unavailable'),
    majorPlanFunding: major.length
      ? { status: majorStatus, source: 'Forecast.majorPlans', ...majorReason, items: major }
      : unavailable('no-major-plans'),
    currentPeriodAction: action
      ? {
        status: 'ok',
        source: 'Forecast.currentPeriodAction',
        mode: action.mode || null,
        periodStart: action.periodStart || null,
        periodEnd: action.periodEnd || null,
        nextPayday: action.nextPayday || null,
        remainingClaim: action.remainingClaim || null,
        categoryRemainingClaim: action.categoryRemainingClaim || null,
        essentialRemaining: money(action.essentialRemaining),
        weeklyCap: money(action.weeklyCap),
        noMovementToday: action.noMovementToday === true,
        currentShortfall: action.currentShortfall === true,
        ...currentPeriodBillsSection(action),
      }
      : unavailable('current-period-action-unavailable'),
    paydayAllocation: projectPaydayAllocation(advice),
    predictedEndingBalance: projectPredictedEndingBalance(advice),
    budgetCap: budget && budget.cap
      ? {
        status: 'ok',
        source: 'Forecast.budgetBreakdown.cap',
        weekly: money(budget.cap.weekly),
        monthlyEquivalent: money(budget.cap.monthly),
        hasDiscretionaryRoom: budget.cap.hasDiscretionaryRoom === true,
        discretionaryRoomWeekly: money(budget.cap.discretionaryRoomWeekly),
        essentialShortfallWeekly: money(budget.cap.essentialShortfallWeekly),
        inCapMonthly: money(budget.cap.inCapMonthly),
      }
      : unavailable('budget-cap-unavailable'),
  };
}

// The window's completeness and category claim never say more than the
// history source (scripts/periods.js metadata) does. A window holding a
// posted row periods.js could not read is incomplete; otherwise the window
// inherits the source: complete only when the source reports its coverage
// (window and HELOC) complete and reports malformed rows (the Lunch Money
// basis), false when the source is otherwise incomplete, and null (unknown)
// for a basis that reports neither.
function historyWindowClaim(source, window) {
  const malformed = Number(window.malformedTransactions) || 0;
  if (window.complete === false || malformed > 0) {
    return { complete: false, categoryClaim: 'incomplete', malformedTransactions: malformed };
  }
  const reportsMalformed = !!(source && source.malformedByMonth && typeof source.malformedByMonth === 'object');
  // A source that reports malformed rows also reports its coverage alone;
  // its own complete:false may come only from malformed rows elsewhere.
  // The fetch must also span this window (periods.js periodCoverage).
  const coverage = reportsMalformed && typeof source.coverageComplete === 'boolean'
    ? (source.coverageComplete && window.coverageComplete === true ? true
      : source.coverageComplete === false || window.coverageComplete === false ? false : null)
    : null;
  const complete = coverage === false ? false
    : source && source.complete === false && coverage !== true ? false
    : coverage === true ? true
    : null;
  let categoryClaim = source && typeof source.categoryClaim === 'string' ? source.categoryClaim : null;
  // The source's 'incomplete' may come only from malformed rows outside this
  // window; uncategorised rows are not attributed by window, so they keep it.
  if (categoryClaim === 'incomplete' && reportsMalformed
      && !(Number(source.uncategorisedTransactions) > 0)) {
    categoryClaim = 'precise';
  }
  return { complete, categoryClaim, malformedTransactions: reportsMalformed ? 0 : null };
}

function actualsBlock(data, periods, advice, settlement) {
  const settlementWithheld = settlement && settlement.kind === 'unavailable'
    ? { status: 'unavailable', reason: settlement.reason }
    : null;
  if (!periods || !periods.periods) {
    return unavailable('periods-unavailable');
  }
  const budget = data.plan && periods
    ? Forecast.budgetBreakdown(data.plan, periods, {
      asOf: effectiveAsOf(data),
      weeklyCap: advice && advice.weekly,
    })
    : null;
  const basis = (budget && budget.basis)
    || (data.plan && data.plan.budget && data.plan.budget.basis)
    || 'ytd';
  const window = periods.periods[basis] || periods.periods.all || null;
  if (!window) return unavailable('actuals-window-unavailable');
  const uncategorised = (window.spending || []).find(row =>
    row && /uncategor/i.test(row.label));
  const action = advice && advice.currentPeriodAction;
  return {
    status: 'ok',
    source: 'public/periods.json / Forecast.budgetBreakdown / Forecast.currentPeriodAction',
    window: {
      periodsAsOf: periods.asOf || null,
      thisMonth: periods.thisMonth || null,
      lastMonth: periods.lastMonth || null,
      basis,
      basisLabel: window.label || (budget && budget.basisLabel) || null,
      months: window.months || (budget && budget.months) || null,
      ...historyWindowClaim(periods.source, window),
    },
    totalsByCategory: (window.spending || []).map(row => ({
      label: row.label,
      total: money(row.total),
      type: row.type || null,
      types: row.types || null,
    })),
    spendingTotal: money(window.spendingTotal),
    feesTotal: money(window.feesTotal),
    interestTotal: money(window.interestTotal),
    budgetCategories: settlementWithheld
      ? settlementWithheld
      : budget && Array.isArray(budget.categories)
      ? budget.categories.map(row => ({
        id: row.id,
        label: row.label,
        class: row.class || null,
        historicalMonthly: money(row.historical),
        plannedMonthly: money(row.planned),
        source: row.source || null,
      }))
      : unavailable('budget-breakdown-unavailable'),
    currentPeriodCategories: settlementWithheld
      ? settlementWithheld
      : action && Array.isArray(action.categories)
      ? action.categories.map(row => ({
        id: row.id,
        label: row.label,
        class: row.class || null,
        planned: money(row.planned),
        posted: money(row.posted),
        pending: money(row.pending),
        remaining: money(row.remaining),
      }))
      : unavailable('current-period-categories-unavailable'),
    exclusionsCoverageConfidence: {
      uncategorisedTotal: uncategorised ? money(uncategorised.total) : 0,
      remainingClaim: action ? action.remainingClaim : null,
      categoryRemainingClaim: action ? action.categoryRemainingClaim : null,
      unclassifiedCount: action && action.unclassified ? action.unclassified.count : null,
    },
  };
}

function uncertaintyBlock(data, periods, questionsMarkdown, advice) {
  const overlay = data && data.liveOverlay;
  const refused = Array.isArray(overlay && overlay.refused)
    ? overlay.refused.map(row => ({
      locator: row.locator || null,
      fact: row.fact || null,
      reason: row.reason || null,
      evidenceDate: row.evidenceDate || null,
    }))
    : [];
  const used = data && data.debts
    ? Forecast.utilisation(data.debts, data.revolvingExtra, data.plan)
    : null;
  const staleOrManual = [];
  if (used && Array.isArray(used.rows)) {
    for (const row of used.rows) {
      if (row.pendingUnknown) {
        staleOrManual.push({
          id: row.id,
          label: row.label,
          kind: 'unknown-pending',
        });
      }
    }
  }
  const window = periods && periods.periods
    ? (periods.periods[(data.plan && data.plan.budget && data.plan.budget.basis) || 'ytd']
      || periods.periods.all)
    : null;
  const uncategorised = window && Array.isArray(window.spending)
    ? window.spending.find(row => row && /uncategor/i.test(row.label))
    : null;
  const action = advice && advice.currentPeriodAction;
  const providerGaps = refused.filter(row => row.reason);
  const ownerQuestions = unresolvedQuestions(questionsMarkdown);
  return {
    staleOrManualAccounts: staleOrManual,
    incompleteCategoryCoverage: {
      uncategorisedTotal: uncategorised ? money(uncategorised.total) : null,
      unclassifiedCurrentPeriod: action && action.unclassified
        ? {
          posted: money(action.unclassified.posted),
          pending: money(action.unclassified.pending),
          count: action.unclassified.count,
        }
        : null,
      categoryRemainingClaim: action ? action.categoryRemainingClaim : null,
    },
    providerGaps,
    liveOverlayFailed: overlay && overlay.applied === false
      ? { reason: overlay.reason || 'overlay-failed' }
      : null,
    // ATLAS-077: the named scheduled-amount unknowns behind any
    // qualified claim above, with Forecast's reason — an affected
    // claim's absence from the packet is never left unexplained.
    ...(scheduledAmountsOf(advice)
      ? { scheduledAmounts: scheduledAmountsProjection(scheduledAmountsOf(advice)) }
      : {}),
    ownerQuestions,
  };
}

const DECISION_POSTURE_FIELDS = [
  'posture',
  'velocity',
  'resilience',
  'breathingRoom',
  'knownCommitments',
  'cheapestWhenBrittle',
  'numericThreshold',
  'forecastApplication',
  'provenance',
  'provenanceDate',
  'provenanceNote',
  'note',
];

function projectDecisionPosture(data) {
  const row = data && data.plan && data.plan.decisionPosture;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return unavailable('decision-posture-unavailable');
  }
  const projected = {
    status: 'ok',
    source: 'data.json plan.decisionPosture',
  };
  for (const key of DECISION_POSTURE_FIELDS) {
    const value = row[key];
    if (typeof value === 'string' && value) projected[key] = value;
    else projected[key] = null;
  }
  return projected;
}

function looksSanitized(packet) {
  const blob = JSON.stringify(packet == null ? {} : packet);
  if (/"providerAccountId"\s*:/.test(blob)) return false;
  if (/"providerTransactionId"\s*:/.test(blob)) return false;
  if (/"accountId"\s*:/.test(blob)) return false;
  if (/"payee"\s*:/.test(blob)) return false;
  if (/"original_name"\s*:/.test(blob)) return false;
  if (/"account_id"\s*:/.test(blob)) return false;
  if (/"plaid_account_id"\s*:/.test(blob)) return false;
  if (/"transactions"\s*:\s*\[/.test(blob)) return false;
  if (/Bearer\s+\S+/.test(blob)) return false;
  if (/LUNCHMONEY_ACCESS_TOKEN/.test(blob)) return false;
  if (/SITE_PASSWORD/.test(blob)) return false;
  if (/SESSION_SECRET/.test(blob)) return false;
  if (/ATLAS_ASSISTANT_TOKEN/.test(blob)) return false;
  if (/ATLAS_TALK_GEMINI_API_KEY/.test(blob)) return false;
  if (/ATLAS_PROVIDER_ACCOUNT_MAP_JSON/.test(blob)) return false;
  if (/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/.test(blob)) return false;
  return true;
}

function buildPacket(opts) {
  opts = opts || {};
  const data = opts.data;
  if (!data || !data.plan) {
    throw new Error('Assistant packet requires served Atlas data.');
  }
  const periods = opts.periods !== undefined ? opts.periods : loadPeriods(opts.periodsPath);
  const questionsMarkdown = opts.questionsMarkdown !== undefined
    ? opts.questionsMarkdown
    : (fs.existsSync(opts.questionsPath || DEFAULT_QUESTIONS)
      ? fs.readFileSync(opts.questionsPath || DEFAULT_QUESTIONS, 'utf8')
      : '');
  const asOf = effectiveAsOf(data);
  // ATLAS-080: normalize the served settlement outcome once. Only a
  // qualified outcome's verified effective evidence is threaded into
  // Forecast; an unavailable outcome withholds below and passes no
  // evidence anywhere.
  const settlement = settlementOutcomeOf(data);
  const qualifiedEvidence = settlement.kind === 'qualified' ? settlement.evidence : null;
  const advice = forecastAdvice(data, periods, qualifiedEvidence);
  const used = Forecast.utilisation(data.debts, data.revolvingExtra, data.plan);
  const debtProj = projectDebtsFromAdvice(data, asOf, advice);
  const packet = {
    schema: SCHEMA,
    writesCanonicalState: false,
    productionWrite: false,
    unattended: false,
    authority: {
      planner: 'Forecast',
      observation: 'scripts/live-plan.js',
      actuals: 'public/periods.json',
      questions: 'docs/01_OPEN_QUESTIONS.md',
      note: 'This packet exposes Atlas/Forecast results. It is not a second planner.',
    },
    policy: {
      decisionPosture: projectDecisionPosture(data),
    },
    metadata: metadataBlock(data, {
      now: opts.now || new Date().toISOString(),
      env: opts.env || process.env,
      sourceCheck: opts.sourceCheck,
    }, advice, settlement),
    current: currentBlock(data, asOf, advice, used, settlement),
    forecast: forecastBlock(data, asOf, advice, debtProj, periods, settlement),
    planning: {
      trajectory: settlement.kind === 'unavailable'
        ? { status: 'unavailable', source: 'settlement-evidence', reason: settlement.reason }
        : projectBaselineTrajectory(data, periods, qualifiedEvidence),
    },
    actuals: actualsBlock(data, periods, advice, settlement),
    uncertainty: uncertaintyBlock(data, periods, questionsMarkdown, advice),
  };
  if (!looksSanitized(packet)) {
    throw new Error('Assistant packet is not sanitized.');
  }
  return packet;
}

function tokenConfigured(env) {
  const token = env && env.ATLAS_ASSISTANT_TOKEN;
  return typeof token === 'string' && token.length >= TOKEN_MIN_LENGTH;
}

module.exports = {
  SCHEMA,
  CURRENT_PERIOD_BILLS_MAX,
  TOKEN_MIN_LENGTH,
  DEFAULT_PERIODS,
  DEFAULT_QUESTIONS,
  DECISION_POSTURE_FIELDS,
  buildPacket,
  parseOpenQuestions,
  unresolvedQuestions,
  versionIdentifier,
  looksSanitized,
  projectDecisionPosture,
  projectBaselineTrajectory,
  loadPeriods,
  tokenConfigured,
  clone,
};
