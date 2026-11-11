'use strict';
/* Format the published-figures review comment from two check snapshots.
 * `node scripts/figures-comment.js <base.json> <head.json> <baseRef> [--public-summary]`
 *
 * `scripts/figures-snapshot.js` emits one flat check snapshot per revision:
 * the household dated opening (data.json + public/periods.json, unprefixed
 * keys: Plan, Budget pay periods, Savings, Planning and their trust tags), each invented input under
 * `fixture.<id>.`, and a coverage manifest under `coverage.`. This helper
 * must not describe that comparison as covering Deep Dive, Records,
 * Modellers, page rendering, page-side decisions, household figures at a live
 * opening, or "what the household is told".
 *
 * THIS MODULE DOES NOT COMPARE REVISIONS ITSELF. Callers pass already-loaded
 * `base` and `head` maps (or `base === null` when the base has no snapshot).
 * The CLI reads those maps from JSON files and writes only the comment body.
 *
 * The public summary carries counts and fixed vocabulary only. No snapshot
 * key, input id, class name, value or delta is interpolated into it. The
 * privileged posting step in `.github/workflows/figures-review.yml`
 * recomputes the same body from the inert snapshots without loading this
 * module and posts only on byte equality.
 */

const fs = require('fs');

const MARKER = '<!-- atlas-figures-review -->';
const CHECK_SCHEMA = 'atlas-figures-check/v2';
const INPUT_ID = /^[a-z][a-z0-9-]{0,47}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CHECK_KEYS = ['check.schema', 'check.collector.sha256', 'check.household.input.sha256'];

// The reviewed, fixed field-class vocabulary. A class is observed on an input
// when a captured key matching its dot-segment pattern (`*` is exactly one
// segment) holds: money, a finite number (a legitimate 0 counts; null does
// not); tag, a non-empty string; flag, a boolean; true, the value true. One
// observed value establishes that the field is published on that input, not
// that every branch of it is exercised. This list is mirrored, byte for byte,
// by the posting step in figures-review.yml; a test pins the two together.
const FIELD_CLASSES = Object.freeze([
  ['cash-spendable-today', 'Plan', 'cash.spendableToday', 'money'],
  ['plan-weekly-cap', 'Plan', 'plan.weeklyCap', 'money'],
  ['plan-lowest-cash', 'Plan', 'plan.lowestCash', 'money'],
  ['plan-opening-gap', 'Plan', 'plan.gapAmount', 'money'],
  ['plan-funding-borrowed', 'Plan', 'plan.fundingBorrowed', 'money'],
  ['payday-available', 'Plan', 'payday.available', 'money'],
  ['payday-risk-shortfall', 'Plan', 'payday.riskShortfall', 'money'],
  ['operating-this-remainder', 'Plan', 'operating.this.projectedEnding', 'money'],
  ['scoreboard-consumer-debt', 'Plan', 'scoreboard.*.consumerDebt', 'money'],
  ['budget-breakdown-required', 'Plan', 'budget.requiredPerMonth', 'money'],
  ['budget-period-opening', 'Budget', 'period.*.opening', 'money'],
  ['budget-period-opening-source', 'Budget', 'period.*.openingSource', 'tag'],
  ['budget-period-income', 'Budget', 'period.*.incomeTotal', 'money'],
  ['budget-period-bill-load', 'Budget', 'period.*.periodBillLoad', 'money'],
  ['budget-period-after-bills', 'Budget', 'period.*.afterBills', 'money'],
  ['budget-period-hold', 'Budget', 'period.*.budgetHold', 'money'],
  ['budget-period-bad', 'Budget', 'period.*.balanceAfterDeductions', 'money'],
  ['budget-period-sweep', 'Budget', 'period.*.paydaySweep', 'money'],
  ['budget-period-planned-close', 'Budget', 'period.*.plannedPeriodClose', 'money'],
  ['budget-period-operating-plan', 'Budget', 'period.*.operatingPlanUnavailable', 'flag'],
  ['budget-period-bill-amount', 'Budget', 'period.*.bill.*.amount', 'money'],
  ['budget-period-bill-status', 'Budget', 'period.*.bill.*.status', 'tag'],
  ['budget-period-card-paid-bill', 'Budget', 'period.*.bill.*.cardPaid', 'true'],
  ['budget-bills-at-end', 'Budget', 'period.billsAtEnd.amount', 'money'],
  ['budget-period-opening-trust', 'Trust', 'period.*.openingTrust', 'tag'],
  ['budget-period-income-trust', 'Trust', 'period.*.incomeTrust', 'tag'],
  ['budget-period-bill-load-trust', 'Trust', 'period.*.periodBillLoadTrust', 'tag'],
  ['budget-period-after-bills-trust', 'Trust', 'period.*.afterBillsTrust', 'tag'],
  ['budget-period-hold-trust', 'Trust', 'period.*.budgetHoldTrust', 'tag'],
  ['budget-period-bad-trust', 'Trust', 'period.*.balanceAfterDeductionsTrust', 'tag'],
  ['budget-period-sweep-trust', 'Trust', 'period.*.paydaySweepTrust', 'tag'],
  ['budget-period-planned-close-trust', 'Trust', 'period.*.plannedPeriodCloseTrust', 'tag'],
  ['budget-period-bill-confidence', 'Trust', 'period.*.bill.*.confidence', 'tag'],
  ['budget-period-bill-display-trust', 'Trust', 'period.*.bill.*.displayAmountTrust', 'tag'],
  ['budget-bills-at-end-trust', 'Trust', 'period.billsAtEnd.trust', 'tag'],
  ['savings-close-trust', 'Trust', 'savings.period.*.close.trust', 'tag'],
  ['savings-close-row-still-to-fund-trust', 'Trust', 'savings.period.*.close.row.*.stillToFundTrust', 'tag'],
  ['savings-planned-still-to-fund-trust', 'Trust', 'savings.period.*.planned.row.*.stillToFundTrust', 'tag'],
  ['savings-current-still-to-fund-trust', 'Trust', 'savings.current.row.*.stillToFundTrust', 'tag'],
  ['savings-inventory-setup', 'Savings', 'savings.setup', 'tag'],
  ['savings-funding-status', 'Savings', 'savings.funding.status', 'tag'],
  ['savings-close-status', 'Savings', 'savings.period.*.close.status', 'tag'],
  ['savings-close-nature', 'Savings', 'savings.period.*.close.nature', 'tag'],
  ['savings-close-stock', 'Savings', 'savings.period.*.close.stock', 'money'],
  ['savings-close-contribution', 'Savings', 'savings.period.*.close.contribution', 'money'],
  ['savings-close-deficit-coverage', 'Savings', 'savings.period.*.close.projectedDeficitCoverage', 'money'],
  ['savings-close-gap', 'Savings', 'savings.period.*.close.gapShortBy', 'money'],
  ['savings-close-row-saved', 'Savings', 'savings.period.*.close.row.*.forecastSaved', 'money'],
  ['savings-close-row-still-to-fund', 'Savings', 'savings.period.*.close.row.*.stillToFund', 'money'],
  ['savings-planned-needed', 'Savings', 'savings.period.*.planned.row.*.needed', 'money'],
  ['savings-current-still-to-fund', 'Savings', 'savings.current.row.*.stillToFund', 'money'],
  ['savings-current-surplus', 'Savings', 'savings.current.nativePeriodSurplus', 'money'],
  ['savings-close-member-allocation', 'Savings', 'savings.period.*.close.allocation.*.amount', 'money'],
  ['savings-current-member-allocation', 'Savings', 'savings.current.allocation.*.amount', 'money'],
  ['savings-current-proposal', 'Savings', 'savings.current.proposal', 'money'],
  ['savings-close-row-needed-trust', 'Trust', 'savings.period.*.close.row.*.neededTrust', 'tag'],
  ['savings-planned-row-needed-trust', 'Trust', 'savings.period.*.planned.row.*.neededTrust', 'tag'],
  ['planning-verdict', 'Planning', 'planning.*.verdict', 'tag'],
  ['planning-trajectory-cash', 'Planning', 'planning.trajectory.*.cash.amount', 'money'],
].map(([id, family, pattern, kind]) => Object.freeze({ id, family, pattern, kind })));

// Public families are fixed labels, never interpolated snapshot keys.
const PUBLIC_FAMILIES = Object.freeze(['Plan', 'Budget', 'Savings', 'Planning', 'Trust', 'Coverage', 'Other']);
const PLAN_KEY = /^(meta|cash|plan|payday|operating|totals|budget|scoreboard|debt|balance|heloc|action|policy)\./;

function money(v) {
  return typeof v === 'number'
    ? (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-CA',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(v);
}

// A key is money unless it is plainly a date, a count, a rate, or a verdict.
// Coverage manifest values are counts of inputs, never money.
function isCount(k) {
  return /facilitiesOverLimit|openCount|windowDays/.test(k) || /^coverage\./.test(k);
}

function isRate(k) {
  return /\.rate$/.test(k);
}

function fmt(k, v) {
  if (v === undefined) return '—';
  if (typeof v !== 'number') return '`' + v + '`';
  if (isCount(k)) return String(v);
  if (isRate(k)) return String(v) + '%';
  return money(v);
}

const own = (map, key) => map !== null && Object.prototype.hasOwnProperty.call(map, key);

function differs(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > 0.005;
  return a !== b;
}

// One comparison contract for both the private detail and the public report.
function compareFigures(base, head) {
  const keys = [...new Set([...Object.keys(base || {}), ...Object.keys(head)])].sort();
  const moved = base === null ? keys : keys.filter(k => differs(base[k], head[k]));
  return { keys, moved };
}

// A check snapshot is a flat map of inert scalars. Anything else is a
// collector or serialization failure, never a legitimate value.
function assertSnapshot(map, label) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new Error('invalid-' + label + '-snapshot');
  for (const key of Object.keys(map)) {
    const v = map[key];
    if (!(v === null || typeof v === 'string' || typeof v === 'boolean'
      || (typeof v === 'number' && Number.isFinite(v)))) throw new Error('invalid-' + label + '-snapshot');
  }
}

// Where a captured key belongs. `inner` is the key without any input prefix.
function keyRole(key) {
  if (key.startsWith('check.')) return { role: 'meta' };
  if (key.startsWith('coverage.')) return { role: 'coverage' };
  if (key.startsWith('fixture.')) {
    const rest = key.slice('fixture.'.length);
    const dot = rest.indexOf('.');
    const id = dot > 0 ? rest.slice(0, dot) : '';
    const inner = dot > 0 ? rest.slice(dot + 1) : '';
    return { role: inner === 'input.sha256' ? 'digest' : 'invented', id, inner };
  }
  return { role: 'household', inner: key };
}

function figureFamily(inner) {
  const last = inner.slice(inner.lastIndexOf('.') + 1);
  if (/(?:trust|confidence)$/i.test(last)) return 'Trust';
  if (inner.startsWith('period.')) return 'Budget';
  if (inner.startsWith('savings.')) return 'Savings';
  if (inner.startsWith('planning.')) return 'Planning';
  if (PLAN_KEY.test(inner)) return 'Plan';
  return 'Other';
}

function patternMatches(pattern, key) {
  const p = pattern.split('.');
  const k = key.split('.');
  if (p.length !== k.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*' ? k[i] === '' : p[i] !== k[i]) return false;
  }
  return true;
}

function observedValue(kind, v) {
  if (kind === 'money') return typeof v === 'number' && Number.isFinite(v);
  if (kind === 'tag') return typeof v === 'string' && v.length > 0;
  if (kind === 'flag') return typeof v === 'boolean';
  if (kind === 'true') return v === true;
  return false;
}

// Whether one per-input snapshot (unprefixed keys) observes a class.
function snapshotObserves(snapshot, cls) {
  for (const key of Object.keys(snapshot)) {
    if (patternMatches(cls.pattern, key) && observedValue(cls.kind, snapshot[key])) return true;
  }
  return false;
}

function inputDigests(map) {
  const out = new Map();
  if (map === null) return out;
  for (const key of Object.keys(map)) {
    const r = keyRole(key);
    if (r.role === 'digest' && INPUT_ID.test(r.id) && typeof map[key] === 'string' && DIGEST.test(map[key])) {
      out.set(r.id, map[key]);
    }
  }
  return out;
}

// The coverage predicate is recomputed from the captured keys and the fixed
// vocabulary, then reconciled with the manifest the snapshot claims. A missing,
// renamed, malformed, extra or unreconciled entry is invalid; it can never
// shrink the obligation and turn green.
// Required Savings capture evidence (G1 v3: Atlas 6550418629, Muse
// 6550491885; adopted obligation-table design 6554987596 + 6555018088 +
// 6555036724, Muse 6556013994). Every input, household and invented, carries
// the observed page capture. The guarantee is BOUNDED: schema, relationship,
// constant and internal-consistency checks per result. For every observation
// the validator derives the result's variant and view from its page, state,
// route, context and source plus that state's per-advice anchors, and
// requires the anchor's object-or-null verdict, the exact own top-level key
// set and producer order of the variant, the constant parts, positive
// identity subparts bound to the same page, state, advice and view, and one
// result per view and per page. For Budget the anchors must also equal the
// input's itemized pay periods and Savings publication (the collector's own
// engine run); Plan spend's anchors are not independent (a disclosed limit).
// It does NOT establish that a non-constant part digest encodes the original
// value (nested or optional content): that fidelity rests on the capture-side
// reconstruction and mutation tests against lossless originals. Evidence
// replaced as a whole is not authenticated (same runner, PR-writable).
// Missing, malformed, extra, out-of-range or unreferenced entries, an errored
// state or an unsupported form are INVALID, so the comparison reads
// INCOMPLETE. This logic is mirrored independently by the posting step; a
// test pins the two sets of tables together.
const CAPTURE_EVIDENCE = 'atlas-savings-page-capture/v4+atlas-savings-publication/v1';
// Expected coverage, derived independently of the emitted observations:
//  - STATES: the full declared state matrix, rebuilt from the input's own
//    itemized pay periods (prefix + period.<start>.timelineRole): Budget
//    default, each pay period under both funding lenses, month view,
//    drilldown; then Plan spend default. Exactly this list, in this order.
//  - ROUTES: every consumer route the reviewed inventory allows, with the
//    context shapes, sources and result types each may take.
//  - OBLIGATIONS: for a funded input, the (route, context) pairs every state
//    of each class must observe; CONDITIONAL pairs are required only when the
//    state's own anchors predict the call.
const CAPTURE_VIEW_ID = { past: start => 'past:' + start, current: () => 'this-pay-period', next: () => 'next-pay-period', future: start => 'future:' + start };
const CAPTURE_ROUTES = {
  // route: [allowed context shapes, allowed sources, allowed result types]
  'budget|public/plan.js#budgetDailySavingsFor<public/plan.js#budgetPayPeriodContentHtml': [['asOf=str,advice=A,periodId=null'], ['A.savingsFunding', 'undefined'], ['object', 'null']],
  'budget|public/plan.js#budgetDailySavingsFor<public/plan.js#budgetSavingsGoalsHtml': [['asOf=str,advice=A,periodId=str'], ['A.savingsFunding', 'undefined'], ['object', 'null']],
  'budget|public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingAnnualBill': [['asOf=str,advice=A,periodId=null'], ['A.savingsFunding', 'undefined'], ['object', 'null']],
  'budget|public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingFundingHtml': [['asOf=str,advice=A,periodId=null'], ['A.savingsFunding', 'undefined'], ['object', 'null']],
  'budget|public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetTodayCashCardHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetUpcomingFundingHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetMonthSurfaceHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingPlanHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingShortfallHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/plan.js#budgetSavingsTimelineFor<public/plan.js#budgetPayPeriodContentHtml': [['asOf=str,advice=A'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/savings-inventory.js#html<public/plan.js#budgetDailySavingsHtml': [['asOf=str,advice=A', 'asOf=str,period=view'], ['A.savingsFunding', 'other-object', 'result'], ['object', 'null']],
  'budget|public/savings-inventory.js#html<public/plan.js#q': [['asOf=str,period=view'], ['A.savingsFunding'], ['object', 'null']],
  'budget|public/savings-inventory.js#html<public/plan.js#renderPlan': [['asOf=str,advice=A,plan=entry-plan'], ['A.savingsFunding'], ['object', 'null']],
  'planSpend|public/plan-spend.js#planSpendFundingSchedule<public/plan-spend.js#planSpendPageHtml': [['advice=A,plan=entry-plan,asOf=str'], ['A.savingsFunding'], ['object', 'null']],
  'planSpend|public/savings-inventory.js#html<public/plan-spend.js#renderPlanSpend': [['advice=A,plan=entry-plan,asOf=str'], ['A.savingsFunding'], ['object', 'null']],
};
// Which anchor predicts an observation: its context shape and source, each
// mapped to exactly one anchor (never substituted for another; 6555036724).
// byId/byView/rawPacket are per view; pass-through is the result#k form.
const CAPTURE_ANCHOR_OF = {
  'budget|asOf=str,advice=A|A.savingsFunding': 'top',
  'budget|asOf=str,advice=A,periodId=null|A.savingsFunding': 'topNull',
  'budget|asOf=str,advice=A,periodId=null|undefined': 'topNull',
  'budget|asOf=str,advice=A,periodId=str|A.savingsFunding': 'byId',
  'budget|asOf=str,advice=A,periodId=str|undefined': 'byId',
  'budget|asOf=str,advice=A,plan=entry-plan|A.savingsFunding': 'topPlan',
  'budget|asOf=str,period=view|A.savingsFunding': 'byView',
  'budget|asOf=str,period=view|other-object': 'rawPacket',
  'budget|asOf=str,period=view|result': 'pass-through',
  'planSpend|advice=A,plan=entry-plan,asOf=str|A.savingsFunding': 'topPlan',
};
// The adopted per-state call roster (table r4 6558578436 as revised by r4.1
// 6558666715; Muse 6558680563). Within a state each step is called at most
// once, in this fixed page order, and is identified by route, context shape,
// source role and position, never by route and context alone. The gates and
// outcomes of each step are decided in captureExpectedSteps below.
const CAPTURE_STEPS = {
  budget: [
    ['B0', 'public/savings-inventory.js#html<public/plan.js#renderPlan', 'asOf=str,advice=A,plan=entry-plan'],
    ['A', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetTodayCashCardHtml', 'asOf=str,advice=A'],
    ['B', 'public/plan.js#budgetSavingsTimelineFor<public/plan.js#budgetPayPeriodContentHtml', 'asOf=str,advice=A'],
    ['C', 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetPayPeriodContentHtml', 'asOf=str,advice=A,periodId=null'],
    ['D', 'public/savings-inventory.js#html<public/plan.js#q', 'asOf=str,period=view'],
    ['E', 'public/savings-inventory.js#html<public/plan.js#budgetDailySavingsHtml', 'asOf=str,period=view'],
    ['F', 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingAnnualBill', 'asOf=str,advice=A,periodId=null'],
    ['G', 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetUpcomingFundingHtml', 'asOf=str,advice=A,periodId=null'],
    ['H', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetUpcomingFundingHtml', 'asOf=str,advice=A'],
    ['I', 'public/plan.js#budgetDailySavingsFor<public/plan.js#budgetSavingsGoalsHtml', 'asOf=str,advice=A,periodId=str'],
    ['J', 'public/savings-inventory.js#html<public/plan.js#budgetDailySavingsHtml', 'asOf=str,period=view'],
    ['K', 'public/savings-inventory.js#html<public/plan.js#budgetDailySavingsHtml', 'asOf=str,advice=A'],
  ],
  month: [
    ['B0', 'public/savings-inventory.js#html<public/plan.js#renderPlan', 'asOf=str,advice=A,plan=entry-plan'],
    ['M', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetMonthSurfaceHtml', 'asOf=str,advice=A'],
    ['M2', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingPlanHtml', 'asOf=str,advice=A'],
  ],
  drilldown: [
    ['B0', 'public/savings-inventory.js#html<public/plan.js#renderPlan', 'asOf=str,advice=A,plan=entry-plan'],
    ['N1', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingPlanHtml', 'asOf=str,advice=A'],
    ['N2', 'public/plan.js#budgetMonthPlanSpendSchedule<public/plan.js#budgetPayPeriodFundingShortfallHtml', 'asOf=str,advice=A'],
  ],
  planSpend: [
    ['P1', 'public/plan-spend.js#planSpendFundingSchedule<public/plan-spend.js#planSpendPageHtml', 'advice=A,plan=entry-plan,asOf=str'],
    ['P2', 'public/savings-inventory.js#html<public/plan-spend.js#renderPlanSpend', 'advice=A,plan=entry-plan,asOf=str'],
  ],
};
// The gate-line vocabulary (r4.1 §1-§2): per Budget state, page|state|
// calendar|dailyAsOf|inventory|month|monthPayday|monthId|drilldown.
const CAPTURE_GATE_WORDS = {
  calendar: /^(?:[yn]{6}(?:[yn]{2}|uu)|-)$/, dailyAsOf: /^(?:y|n|u|null|-)$/, inventory: /^(?:y|n|-)$/,
  month: /^(?:y|n|none|-)$/, monthPayday: /^(?:y|n|-)$/, monthId: /^(?:pub|fallback|other|-)$/, drilldown: /^(?:[yn]{4}|none|-)$/,
};
const CAPTURE_RESULT_SHAPES = { object: ['object'], 'null-object': ['object'], array: ['array'], scalar: ['string', 'number', 'boolean'] };
// The variants (table 6554939787 §A): V1, the top-level publication, and V2,
// a period packet, each with its exact own keys in producer order. A trailing
// ? marks a conditional key: goalAllocation iff allocationMode is combined,
// reason iff the period class is v1-unknown, plannedRequirements and
// forecastClosing iff the bound view is next or future.
const CAPTURE_V1_KEYS = ['source', 'asOf', 'currency', 'actionPermission', 'moneyMovementPermission', 'stock', 'backing',
  'goalAllocation?', 'allocationDescription', 'unresolved', 'rows', 'status', 'reason?', 'period',
  'allocationMode', 'manualInventory', 'schedule', 'lenses', 'periodViews', 'timeline'];
const CAPTURE_V2_KEYS = ['source', 'asOf', 'currency', 'status', 'actionPermission', 'moneyMovementPermission', 'rows',
  'stock', 'backing', 'unresolved', 'allocationDescription', 'period', 'plannedRequirements?', 'forecastClosing?'];
// The positive period classes (6555018088 §1): each class's exact own key
// list, held here as a constant; the validator compares its digest.
const CAPTURE_PERIOD_READY = ['status', 'basis', 'start', 'end', 'entitlement', 'transferred', 'nativePeriodSurplus', 'alreadySavedIncome',
  'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'projectedRemainingCapacity', 'currentCash', 'futureIncome',
  'cashCapacity', 'trust', 'cashThrough', 'incomeAuthorityThrough', 'completeness', 'allocations', 'cycleAllocations',
  'actualSaved', 'originalPaydayPlan'];
const CAPTURE_PERIOD_CLASSES = {
  'v1-ready': CAPTURE_PERIOD_READY,
  'v1-ready-withheld': [...CAPTURE_PERIOD_READY, 'reason'],
  'v1-unknown': ['status', 'reason', 'entitlement', 'transferred', 'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'actualSaved'],
  'v2-packet': ['status', 'kind', 'basis', 'start', 'end', 'trust', 'proposal', 'actualSaved', 'allocations', 'cycleAllocations', 'reason'],
};
const CAPTURE_STRING_PART = value => require('crypto').createHash('sha256').update('s' + JSON.stringify(value)).digest('hex');
const CAPTURE_NULL_PART = require('crypto').createHash('sha256').update('n').digest('hex');
const CAPTURE_CONSTANT_PARTS = { source: ['Forecast.savingsDailyFunding'], currency: ['CAD'], actionPermission: ['not-granted'],
  moneyMovementPermission: ['not-granted'], status: ['ready', 'unavailable'] };
const CAPTURE_DESCRIPTIONS = {
  'historical-pools': 'Historical allocation policy applies to the dated pool evidence.',
  past: 'Historical saving evidence is unavailable. Current observed savings are not substituted into this earlier period.',
  projected: 'Projected top-ups from this same opening. Actual saved and transfers in this future period are unknown.',
};
function captureExpectedStates(head, prefix) {
  const starts = new Map();
  const re = /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/;
  for (const key of Object.keys(head)) {
    if (!key.startsWith(prefix)) continue;
    const m = re.exec(key.slice(prefix.length));
    if (m) starts.set(m[1], head[key]);
  }
  const ids = [];
  for (const start of [...starts.keys()].sort()) {
    const view = CAPTURE_VIEW_ID[starts.get(start)];
    if (!view) return null;
    ids.push('period:' + view(start) + '/lens:today', 'period:' + view(start) + '/lens:payday');
  }
  return ['budget|default', ...ids.map(id => 'budget|' + id), 'budget|granularity:month', 'budget|drilldown', 'planSpend|default'];
}
// A context label in its declared shape: string values as str, the view
// identity as view, the call's advice as A (the context's advice and the
// first argument's advice must be the same object).
function captureContextShape(context, advice) {
  if (typeof context !== 'string') return null;
  if (context === 'context:{}' || context === 'context:undefined') return context;
  const out = [];
  for (const part of context.split(',')) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(part);
    if (!m) return null;
    let v = m[2];
    if (/^"[^"]*"$/.test(v)) v = 'str';
    else if (/^view:[^,]+$/.test(v)) v = 'view';
    else if (/^(?:budget|planSpend)-advice#\d+$/.test(v)) { if (advice.label && advice.label !== v) return null; advice.label = v; v = 'A'; }
    else if (!['null', 'undefined', 'entry-plan', 'string', 'number', 'boolean', 'object'].includes(v)) return null;
    out.push(m[1] + '=' + v);
  }
  return out.join(',');
}
function captureSourceShape(source, advice, n) {
  if (source === 'undefined' || source === 'null' || source === 'other-object') return source;
  let m = /^((?:budget|planSpend)-advice#\d+)\.savingsFunding$/.exec(source);
  if (m) { if (advice.label && advice.label !== m[1]) return null; advice.label = m[1]; return 'A.savingsFunding'; }
  m = /^result#(0|[1-9]\d*)$/.exec(source);
  if (m && Number(m[1]) < n) return 'result';
  return null;
}
// The expected own keys, in producer order, for a variant.
const captureKeys = (list, include) => list.filter(k => !k.endsWith('?') || include(k.slice(0, -1))).map(k => k.replace('?', ''));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function captureEvidenceProblems(head, prefixes) {
  const crypto = require('crypto');
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');
  let problems = 0;
  const DIGEST_OK = v => typeof v === 'string' && DIGEST.test(v);
  const COUNT_OK = v => Number.isSafeInteger(v) && v >= 0 && v <= 100000;
  const VERDICTS = ['object', 'null'];
  const CLASS_DIGESTS = Object.fromEntries(Object.entries(CAPTURE_PERIOD_CLASSES).map(([c, keys]) => [c, sha(JSON.stringify(keys))]));
  for (const prefix of prefixes) {
    const base = prefix + 'savings.capture.';
    const at = key => (own(head, base + key) ? head[base + key] : undefined);
    const item = key => (own(head, prefix + key) ? head[prefix + key] : undefined);
    if (at('version') !== CAPTURE_EVIDENCE) problems++;
    const states = COUNT_OK(at('states')) ? at('states') : -1;
    const count = COUNT_OK(at('count')) ? at('count') : -1;
    const results = COUNT_OK(at('results')) ? at('results') : -1;
    const adviceCount = COUNT_OK(at('advices')) ? at('advices') : -1;
    if (states <= 0) problems++;
    if (count < 0) problems++;
    if (results < 0) problems++;
    if (adviceCount < 0) problems++;
    const asOf = item('meta.asOf');
    if (typeof asOf !== 'string') problems++;
    const funded = typeof item('savings.funding.status') === 'string';
    // The input's itemized pay periods (the collector's own engine run).
    const itemized = new Map();
    for (const key of Object.keys(head)) {
      if (!key.startsWith(prefix)) continue;
      const m = /^period\.(\d{4}-\d{2}-\d{2})\.timelineRole$/.exec(key.slice(prefix.length));
      if (!m || !own(CAPTURE_VIEW_ID, head[key])) continue;
      const role = head[key];
      const id = CAPTURE_VIEW_ID[role](m[1]);
      const end = item('period.' + m[1] + '.end');
      const pub = role === 'current' ? 'savings.current' : 'savings.period.' + m[1];
      if (itemized.has(id)) problems++;
      itemized.set(id, { role, startDate: m[1], start: CAPTURE_STRING_PART(m[1]), end: typeof end === 'string' ? CAPTURE_STRING_PART(end) : null,
        publication: item(pub + '.publication'), status: item(pub + '.status'), closeStatus: own(head, prefix + pub + '.close.status') });
    }
    // R5 (itemized): a published next/future packet carries its close.status;
    // no other period does.
    for (const v of itemized.values()) {
      if (v.closeStatus !== ((v.role === 'next' || v.role === 'future') && v.publication === 'published')) problems++;
    }
    // The declared state list, exactly.
    const expected = captureExpectedStates(head, prefix);
    if (!expected) problems++;
    const declared = new Map();
    for (let i = 0; i < states; i++) {
      const line = at('state.' + i);
      const m = typeof line === 'string' && /^(budget|planSpend)\|([^|]+)\|calls=(0|[1-9]\d*)\|error=(yes)?\|unfinished=(\d+)\|load=(\d+)$/.exec(line);
      if (!m || m[4] === 'yes' || m[5] !== '0' || m[6] !== '0') { problems++; continue; }
      const id = m[1] + '|' + m[2];
      if (declared.has(id) || (expected && expected[i] !== id)) problems++;
      declared.set(id, { calls: Number(m[3]), seen: 0, pairs: new Set() });
    }
    if (expected && states !== expected.length) problems++;
    // The per-advice anchors: one advice per state, never reused.
    const anchors = new Map();
    const budgetForms = new Set();
    for (let i = 0; i < adviceCount; i++) {
      const line = at('advice.' + i);
      const p = typeof line === 'string' ? line.split('|') : [];
      if (p.length !== 9) { problems++; continue; }
      const [label, page, state, funding, current, nviews, top, topNull, topPlan] = p;
      const lm = /^(budget|planSpend)-advice#[1-9]\d*$/.exec(label);
      const st = declared.get(page + '|' + state);
      if (!lm || lm[1] !== page || !st || anchors.has(label) || st.anchor || !/^(0|[1-9]\d{0,3})$/.test(nviews)) { problems++; continue; }
      if (!['absent', 'ready', 'unavailable'].includes(funding)) problems++;
      const a = { label, page, state, funding, current, top, topNull, topPlan, views: new Map() };
      if (page === 'budget') {
        if (![top, topNull, topPlan].every(v => VERDICTS.includes(v))) problems++;
        // Versioned invariant of the pinned selector (6555036724): the
        // omitted, explicit-null and plan-bearing top anchors agree. It is
        // asserted, never used to fill a missing anchor.
        if (top !== topNull || top !== topPlan) problems++;
      } else if (top !== 'n/a' || topNull !== 'n/a' || !VERDICTS.includes(topPlan)) problems++;
      const topOf = page === 'budget' ? top : topPlan;
      if (funding === 'absent' && topOf !== 'null') problems++;
      let currents = 0;
      for (let j = 0; j < Number(nviews); j++) {
        const v = typeof at('advice.' + i + '.view.' + j) === 'string' ? at('advice.' + i + '.view.' + j).split('|') : [];
        if (v.length !== 7) { problems++; continue; }
        const [id, role, start, end, byId, byView, rawPacket] = v;
        if (!own(CAPTURE_VIEW_ID, role) || a.views.has(id) || !DIGEST_OK(start) || !DIGEST_OK(end)) { problems++; continue; }
        // The id is the page's view id for its role; a dated id names its own start.
        const dm = /^(past|future):(\d{4}-\d{2}-\d{2})$/.exec(id);
        if (role === 'past' || role === 'future' ? !dm || dm[1] !== role || CAPTURE_STRING_PART(dm[2]) !== start : id !== CAPTURE_VIEW_ID[role]()) problems++;
        if (role === 'current') { currents++; if (current !== id) problems++; }
        if (page === 'budget') {
          if (!VERDICTS.includes(byId) || !VERDICTS.includes(byView) || ![...VERDICTS, 'none'].includes(rawPacket)) problems++;
          if (role === 'current') {
            // Pinned selector: the current view selects the top-level result.
            if (byId !== top || byView !== top || rawPacket !== 'none') problems++;
          } else {
            // Route predicates (6554987596 §5): a non-current view selects the
            // top-level result through period=view only when it is not ready;
            // a packet is never published under a withheld parent; no raw
            // packet is read when the top-level result is withheld.
            if (byView !== (top === 'object' && funding !== 'ready' ? 'object' : 'null')) problems++;
            if (byId === 'object' && top !== 'object') problems++;
            if (top !== 'object' && rawPacket !== 'none') problems++;
            // R-raw (table r4 §2): byId and the raw read reach the same packet
            // (fc:4410-4417, cap:535-539), so a published packet is read raw.
            if (byId === 'object' && rawPacket !== 'object') problems++;
          }
        } else if (byId !== 'n/a' || byView !== 'n/a' || rawPacket !== 'n/a') problems++;
        a.views.set(id, { role, start, end, byId, byView, rawPacket });
      }
      if (currents > 1 || (currents === 0 && current !== 'none')) problems++;
      anchors.set(label, a);
      st.anchor = a;
      if (page === 'budget') {
        // Budget's anchors are cross-checked against the itemized pay periods
        // and publication (an independent engine run), and are equal in every
        // Budget state: no declared state variable is an input of recommend
        // (public/plan.js:8147, 212-224; 30-53), so a difference is INVALID.
        const form = [funding, current, nviews, top, topNull, topPlan,
          ...[...a.views].map(([id, v]) => [id, v.role, v.start, v.end, v.byId, v.byView, v.rawPacket].join(','))].join('|');
        budgetForms.add(form);
        if (funding !== (funded ? item('savings.funding.status') : 'absent')) problems++;
        if (a.views.size !== itemized.size) problems++;
        for (const [id, v] of a.views) {
          const iv = itemized.get(id);
          if (!iv || iv.role !== v.role || iv.start !== v.start || iv.end !== v.end) { problems++; continue; }
          if (funded) {
            // D(d), option (i): every funded input, whatever the anchor's own funding word.
            if ((iv.publication === 'published' ? 'object' : iv.publication === 'withheld' ? 'null' : null) !== v.byId) problems++;
          }
        }
      }
    }
    if (budgetForms.size > 1) problems++;
    // Observations.
    const parsed = [];
    for (let n = 0; n < count; n++) {
      const line = at('o' + n);
      const parts = typeof line === 'string' ? line.split('|') : [];
      parsed.push(null);
      if (parts.length !== 8 || !['budget', 'planSpend'].includes(parts[0]) || parts[7] !== '') { problems++; continue; }
      const [page, state, route, source, context, ref, type] = parts;
      const st = declared.get(page + '|' + state);
      if (!st) { problems++; continue; }
      st.seen++;
      st.list = st.list || [];
      st.list.push({ n, route, context, source, ref, type });
      // An observed route outside the reviewed set (a new, aliased or computed
      // call site that executed), or in an undeclared form, is unexplained.
      const allowed = CAPTURE_ROUTES[page + '|' + route];
      if (!allowed) { problems++; continue; }
      const same = {};
      const ctx = captureContextShape(context, same);
      const src = captureSourceShape(source, same, n);
      if (!allowed[0].includes(ctx) || !allowed[1].includes(src) || !allowed[2].includes(type)) { problems++; continue; }
      if (type === 'null' ? ref !== 'null' : !/^r(0|[1-9]\d*)$/.test(ref) || Number(ref.slice(1)) >= results) { problems++; continue; }
      st.pairs.add(route + '|' + ctx);
      // Identity: every observed asOf is the page's own; the advice is this
      // page's and this state's, never another state's; every period
      // identity in a pay-period state is that state's selected view, and
      // elsewhere the current one.
      for (const m of String(context).matchAll(/(?:^|,)asOf=("[^"]*")/g)) {
        let v = null;
        try { v = JSON.parse(m[1]); } catch { v = null; }
        if (v !== asOf) problems++;
      }
      // A raw packet or pass-through source names no advice: it is read
      // within the state's own (single) advice.
      const a = same.label ? anchors.get(same.label) : st.anchor;
      if (!a || a.page !== page || a.state !== state || st.anchor !== a) { problems++; continue; }
      const selected = /^period:(.+)\/lens:(?:today|payday)$/.exec(state);
      const want = selected ? selected[1] : 'this-pay-period';
      let viewId = null;
      for (const m of String(context).matchAll(/(?:^|,)(?:periodId="([^"]*)"|period=view:([^,]*))/g)) {
        viewId = m[1] ?? m[2];
        if (viewId !== want) problems++;
      }
      const anchor = CAPTURE_ANCHOR_OF[page + '|' + ctx + '|' + src];
      if (!anchor) { problems++; continue; }
      if (src === 'undefined' && a.funding !== 'absent') problems++;
      const view = viewId === null ? null : a.views.get(viewId);
      if (viewId !== null && !view) { problems++; continue; }
      let verdict, bind;
      if (anchor === 'pass-through') {
        // result#k names an earlier observation of the same page and state
        // that returned an object for the same view; the selector passes it
        // through unchanged.
        const k = Number(/^result#(\d+)$/.exec(source)[1]);
        const prior = parsed[k];
        if (!prior || prior.page !== page || prior.state !== state || prior.type !== 'object' || prior.viewId !== viewId
          || type !== 'object' || prior.ref !== ref) { problems++; continue; }
        verdict = 'object'; bind = prior.bind;
      } else {
        verdict = anchor === 'byId' || anchor === 'byView' || anchor === 'rawPacket' ? view[anchor] : a[anchor];
        if (!VERDICTS.includes(verdict)) { problems++; continue; }
        bind = anchor === 'rawPacket' || (anchor === 'byId' && view.role !== 'current') ? 'V2:' + viewId : 'V1';
      }
      if (type !== verdict) problems++;
      parsed[n] = { page, state, type, ref, viewId, bind, advice: a };
    }
    // Same-execution gate lines: one per Budget state, fixed vocabulary.
    const gateCount = COUNT_OK(at('gates')) ? at('gates') : -1;
    if (gateCount < 0) problems++;
    const gates = new Map();
    for (let i = 0; i < gateCount; i++) {
      const p = typeof at('gate.' + i) === 'string' ? at('gate.' + i).split('|') : [];
      if (p.length !== 9 || p[0] !== 'budget' || !declared.has('budget|' + p[1]) || gates.has(p[1])) { problems++; continue; }
      const g = { calendar: p[2], dailyAsOf: p[3], inventory: p[4], month: p[5], monthPayday: p[6], monthId: p[7], drilldown: p[8] };
      if (!Object.entries(CAPTURE_GATE_WORDS).every(([k, re]) => re.test(g[k]))) problems++;
      const isMonth = p[1] === 'granularity:month', isDrill = p[1] === 'drilldown';
      if (!isMonth && (g.month !== '-' || g.monthPayday !== '-' || g.monthId !== '-')) problems++;
      if (!isDrill && g.drilldown !== '-') problems++;
      gates.set(p[1], g);
    }
    for (const id of declared.keys()) if (id.startsWith('budget|') && !gates.has(id.slice(7))) problems++;
    // Gate state-equality (the adopted invariant applied to the gate facts):
    // the Calendar inventory, inventory presence and step-6 asOf facts derive
    // from the advice and its top-level result, which are equal in every Budget
    // state, so they are equal across the default and pay-period states. A
    // single-state flip with its governed steps dropped therefore reads INVALID.
    const payGates = [...gates].filter(([sid]) => sid === 'default' || /^period:/.test(sid)).map(([, g]) => [g.calendar, g.dailyAsOf, g.inventory].join('|'));
    if (new Set(payGates).size > 1) problems++;
    // Finite repair (Muse START #787 6560753655 on Atlas ruling #813
    // 6560691831; adoption record 6560081927, 6560657189, 6560714968,
    // 6560749340). R-unavail: the collector withheld the operating plan
    // (figures-snapshot.js:511-512), so the Budget surface returns its
    // unavailable card before any savings consumer but B0 (budget-surface.js:63)
    // and Plan spend skips P1 (plan-spend.js:287-293). R-noplans: Plan spend
    // returns its empty state before P1 when no major plan is published
    // (plan-spend.js:294-297); plans exist iff a `planning.<id>.verdict` key is
    // owned (figures-snapshot.js:522-524), by presence, whatever its value.
    const itemKeys = Object.keys(head).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    const unavail = own(head, prefix + 'planning.operatingPlan');
    const plansExist = itemKeys.some(k => /^planning\.(.+)\.verdict$/.test(k));
    // The page's own calendar-date predicate (public/plan.js:3709-3719).
    const isDate = v => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
      if (m < 1 || m > 12 || d < 1) return false;
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      return d <= (m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
    };
    // Period groups by actual identity: `period.<base>[#n]` (n per start date,
    // figures-snapshot.js:626-632).
    const groups = [...new Set(itemKeys.map(k => (/^period\.([^.]+)\./.exec(k) || [])[1]).filter(d => d && d !== 'billsAtEnd'))]
      .map(seg => ({ seg, base: seg.split('#')[0], ordinal: seg.includes('#') ? Number(seg.slice(seg.indexOf('#') + 1)) : 1,
        tl: item('period.' + seg + '.timelineRole'), role: item('period.' + seg + '.role') }));
    const byBaseOrdinal = (x, y) => (x.base < y.base ? -1 : x.base > y.base ? 1 : x.ordinal - y.ordinal);
    const curGroups = groups.filter(g => g.tl === 'current').sort(byBaseOrdinal);
    // Gate words bound to the record (rule 10). expAdv comes from the
    // gate-independent roster: G (advice=A) is mandatory in every default and
    // period state unless R-unavail, and B0 (advice=A) is the funded month,
    // drilldown and R-unavail step. D2/D2' apply only when expAdv holds.
    // Inventory presence and status: the collector's itemized `savings.setup`
    // from the same recommend inputs, a separate execution
    // (savingsInventoryWithCommitmentCost keeps the packet status, fc:1287-1288;
    // status from savingsEarmarksState, fc:1201-1202). Facts 1 and 3-6 are
    // constants of that packet (fc:1202-1205; currency validated CAD,
    // fc:1072-1073). Facts 7-8 follow the page's own asOf (pj:5154).
    const hasInv = own(head, prefix + 'savings.setup');
    const ready = item('savings.setup') === 'ready';
    const cRoute = CAPTURE_STEPS.budget.find(r => r[0] === 'C')[1];
    for (const [sid, g] of gates) {
      const list = declared.get('budget|' + sid).list || [];
      const expAdv = sid === 'default' || /^period:/.test(sid) ? (unavail ? funded : true) : funded;
      const c = list.find(o => o.route === cRoute);
      const daily = !c ? '-' : c.type === 'null' ? 'null' : String(g.calendar).endsWith('uu') ? 'u' : 'y';
      if ((g.calendar === '-') !== !expAdv || (g.inventory === '-') !== !expAdv
        || (expAdv && (g.inventory !== (hasInv ? 'y' : 'n')
          || String(g.calendar).slice(0, 6) !== (hasInv ? 'y' + (ready ? 'y' : 'n') + 'yyyy' : 'nnnnnn')
          || (hasInv && isDate(asOf) && String(g.calendar).slice(6) !== 'yy')))
        || g.dailyAsOf !== daily
        || (sid === 'granularity:month' && (unavail ? g.month !== 'none' || g.monthPayday !== '-' || g.monthId !== '-' : g.month !== 'y' && g.month !== 'n'))
        // Drilldown: the words the declared selection can produce
        // (capture 694-702); `none` only on the unavailable branch.
        || (sid === 'drilldown' && (unavail ? g.drilldown !== 'none' : !['nnnn', 'ynnn', 'yyyy', 'yyyn'].includes(g.drilldown)))) problems++;
    }
    // K1-K5 (R-unavail coherence, as qualified): one-way checks on the
    // collector's own output, so a single added key cannot fake the state.
    if (unavail) {
      if (item('planning.operatingPlan') !== 'unavailable') problems++;
      if (own(head, prefix + 'planning.horizonEnd')) problems++;
      if (itemKeys.some(k => k.startsWith('planning.') && k !== 'planning.operatingPlan' && !k.startsWith('planning.trajectory.'))) problems++;
      if (curGroups.some(g => item('period.' + g.seg + '.operatingPlanUnavailable') !== true)) problems++;
      // K5: unavailable implies an explicit null cap (figures-snapshot.js:252;
      // fc:14903); an absent key does not satisfy it (Atlas 6562644400 §1).
      if (!own(head, prefix + 'plan.weeklyCap') || item('plan.weeklyCap') !== null) problems++;
    }
    // Itemized coherence (rule 13): the collector's periods and Savings
    // publication agree with themselves, by each prefix's own emission counter
    // (figures-snapshot.js:626-632, 1028-1032).
    const PUB = /^(savings\.current(?:#\d+)?|savings\.period\.[^.]+)\./;
    const pubKeys = itemKeys.filter(k => PUB.test(k));
    if (!funded && pubKeys.length) problems++;
    const ROLE_PAIRS = ['lookback/past', 'active/current', 'future/next', 'future/future'];
    for (const g of groups) {
      if (!own(head, prefix + 'period.' + g.seg + '.role') || !own(head, prefix + 'period.' + g.seg + '.timelineRole') || !ROLE_PAIRS.includes(g.role + '/' + g.tl)) problems++;
    }
    if (funded) {
      const want = new Set();
      for (const base of new Set(groups.map(g => g.base))) {
        groups.filter(g => g.base === base && g.tl !== 'current').sort(byBaseOrdinal)
          .forEach((g, k) => want.add('savings.period.' + base + (k === 0 ? '' : '#' + (k + 1))));
      }
      curGroups.forEach((g, k) => want.add('savings.current' + (k === 0 ? '' : '#' + (k + 1))));
      const got = new Set(pubKeys.map(k => PUB.exec(k)[1]));
      for (const p of got) if (!want.has(p)) problems++;
      for (const p of want) {
        if (!own(head, prefix + p + '.publication')) { problems++; continue; }
        const w = item(p + '.publication');
        if (w !== 'published' && w !== 'withheld') problems++;
        else if (w === 'withheld' ? pubKeys.some(k => k.startsWith(p + '.') && k !== p + '.publication') : !own(head, prefix + p + '.status')) problems++;
      }
    }
    // R-seq, R-pass, R-unfunded: each declared state's observations equal its
    // expected steps, in order, by route, context shape, source role and
    // outcome; a pass-through names this state's own goals call (step I).
    const steps = (page, id) => {
      const st = declared.get(page + '|' + id);
      const a = st && st.anchor, g = gates.get(id) || {};
      const word = v => (v === 'object' || v === 'null' ? v : 'invalid');
      const srcA = funded ? ['A.savingsFunding'] : ['undefined'];
      const T = name => CAPTURE_STEPS[name];
      const step = (table, key, src, outcome, extra) => {
        const row = T(table).find(r => r[0] === key);
        return { key, route: row[1], ctx: row[2], src, outcome: word(outcome), ...(extra || {}) };
      };
      const out = [];
      if (page === 'planSpend') {
        // R-unavail and R-noplans: P1 only with an available plan and a
        // published major plan; P2 whenever funded.
        if (id === 'default' && funded && !unavail && plansExist) out.push(step('planSpend', 'P1', ['A.savingsFunding'], a && a.topPlan));
        if (id === 'default' && funded) out.push(step('planSpend', 'P2', ['A.savingsFunding'], a && a.topPlan));
        return out;
      }
      if (unavail) {
        // R-unavail: every Budget state renders the unavailable card; only B0.
        const table = id === 'granularity:month' ? 'month' : id === 'drilldown' ? 'drilldown' : 'budget';
        if (funded) out.push(step(table, 'B0', ['A.savingsFunding'], a && a.topPlan));
        return out;
      }
      if (id === 'granularity:month') {
        if (funded) out.push(step('month', 'B0', ['A.savingsFunding'], a && a.topPlan));
        if (funded && g.month === 'y') {
          out.push(step('month', 'M', ['A.savingsFunding'], a && a.top));
          if (g.monthId !== 'pub' && g.monthId !== 'fallback') problems++;
          if (g.monthId === 'pub' && !(a && a.top === 'object')) problems++;
          // A ready month surface calls the schedule helper, so its payday fact is recorded.
          if (g.monthPayday !== 'y' && g.monthPayday !== 'n') problems++;
          if (g.monthPayday === 'y') out.push(step('month', 'M2', ['A.savingsFunding'], a && a.top));
        } else if (funded ? g.monthPayday !== '-' || g.monthId !== '-' : g.monthId !== 'other' && g.monthId !== '-') {
          // Funded without a ready trajectory, the helper is never reached; a
          // legacy helper computes its own schedule without the selector.
          problems++;
        }
        return out;
      }
      if (id === 'drilldown') {
        if (funded) out.push(step('drilldown', 'B0', ['A.savingsFunding'], a && a.topPlan));
        if (funded && g.drilldown === 'yyyy') out.push(step('drilldown', 'N1', ['A.savingsFunding'], a && a.top), step('drilldown', 'N2', ['A.savingsFunding'], a && a.top));
        return out;
      }
      const selected = /^period:(.+)\/lens:(?:today|payday)$/.exec(id);
      const selId = selected ? selected[1] : 'this-pay-period';
      const iv = itemized.get(selId);
      const sv = a ? a.views.get(selId) : undefined;
      const views = itemized.size > 0;
      const cur = !!iv && iv.role === 'current';
      const top = a && a.top, topNull = a && a.topNull, topPlan = a && a.topPlan;
      const cal = /^y{8}$/.test(g.calendar || '');
      const opu = iv ? item('period.' + iv.startDate + '.operatingPlanUnavailable') === true : false;
      if (funded) out.push(step('budget', 'B0', ['A.savingsFunding'], topPlan), step('budget', 'A', ['A.savingsFunding'], top));
      if (funded && views) out.push(step('budget', 'B', ['A.savingsFunding'], top));
      if (views) out.push(step('budget', 'C', srcA, topNull));
      if (views && top === 'object' && cal) out.push(step('budget', 'D', ['A.savingsFunding'], sv && sv.byView));
      if (views && cal && g.dailyAsOf === 'y' && (cur ? top === 'object' : !!sv && sv.rawPacket !== 'none')) {
        out.push(cur ? step('budget', 'E', ['A.savingsFunding'], sv && sv.byView) : step('budget', 'E', ['other-object'], sv && sv.rawPacket));
      }
      if (iv && iv.role !== 'past' && !opu) out.push(step('budget', 'F', srcA, topNull));
      out.push(step('budget', 'G', srcA, topNull));
      if (funded) out.push(step('budget', 'H', ['A.savingsFunding'], top));
      const hasI = !!iv && (funded || cur);
      if (hasI) out.push(step('budget', 'I', srcA, sv && sv.byId));
      if (hasI && sv && sv.byId === 'object' && g.inventory === 'y') {
        out.push(cur ? step('budget', 'J', ['A.savingsFunding'], sv.byView) : step('budget', 'J', ['result'], 'object', { pass: 'I' }));
      }
      if (topNull === 'object' && g.inventory === 'y') out.push(step('budget', 'K', ['A.savingsFunding'], top));
      return out;
    };
    for (const [id, st] of declared) {
      if (st.calls !== st.seen) problems++;
      const [page, sid] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1)];
      const ex = steps(page, sid);
      const got = st.list || [];
      if (got.length !== ex.length) problems++;
      const matched = new Map();
      for (let i = 0; i < Math.min(got.length, ex.length); i++) {
        const o = got[i], e = ex[i];
        const ctx = captureContextShape(o.context, {});
        const src = captureSourceShape(o.source, {}, o.n);
        if (o.route !== e.route || ctx !== e.ctx || !e.src.includes(src) || e.outcome === 'invalid' || o.type !== e.outcome) { problems++; continue; }
        if (e.pass) {
          const prior = matched.get(e.pass);
          const k = Number((/^result#(\d+)$/.exec(o.source) || [])[1]);
          if (!prior || k !== prior.n || o.ref !== prior.ref) problems++;
        }
        matched.set(e.key, o);
      }
    }
    // The results table: shape, manifest, parts, digest and identity.
    const table = new Map();
    const digests = new Set();
    const referenced = new Set(parsed.filter(Boolean).filter(o => o.type === 'object').map(o => o.ref));
    for (let k = 0; k < results; k++) {
      const r = 'r' + k;
      const shape = at(r + '.shape');
      if (!referenced.has(r) || !own(CAPTURE_RESULT_SHAPES, shape)) { problems++; continue; }
      if (shape !== 'object') problems++; // the selector returns plain objects only
      let names = null, keys = at(r + '.keys');
      if (shape === 'scalar') { if (keys !== undefined) problems++; keys = ''; names = ['0']; }
      else {
        try { names = JSON.parse(keys); } catch { names = null; }
        if (!Array.isArray(names) || !names.every(x => typeof x === 'string') || new Set(names).size !== names.length
          || (shape === 'array' && !names.every((x, j) => x === String(j)))) { problems++; continue; }
      }
      const parts = names.map((_, j) => at(r + '.part.' + j));
      if (!parts.every(DIGEST_OK)) { problems++; continue; }
      const digest = at(r + '.digest');
      if (!DIGEST_OK(digest) || digest !== sha(shape + '\n' + keys + '\n' + parts.join('\n')) || digests.has(digest)) problems++;
      digests.add(digest);
      const id = typeof at(r + '.identity') === 'string' ? at(r + '.identity').split('|') : [];
      const subOk = v => v === 'absent' || DIGEST_OK(v);
      if (id.length !== 6 || !own(CLASS_DIGESTS, id[0]) || !id.slice(1).every(subOk) || id[1] !== CLASS_DIGESTS[id[0]]) {
        // An unsupported or mis-keyed period form is UNKNOWN: INCOMPLETE.
        problems++; continue;
      }
      for (const key of Object.keys(head)) {
        if (!key.startsWith(base + r + '.part.')) continue;
        const j = key.slice((base + r + '.part.').length);
        if (!/^(0|[1-9]\d*)$/.test(j) || Number(j) >= names.length) problems++;
      }
      table.set(r, { names, part: key => (names.includes(key) ? parts[names.indexOf(key)] : undefined),
        cls: id[0], kind: id[2], start: id[3], end: id[4], status: id[5] });
    }
    // Per result and per observation: the variant's rules (R1-R5), bound to
    // the observation's own page, state, advice and view.
    const bindings = new Map();
    const perPage = new Map();
    for (const o of parsed) {
      if (!o || o.type !== 'object') continue;
      const t = table.get(o.ref);
      if (!t) { problems++; continue; }
      const scope = o.page + '|' + o.bind;
      if (!perPage.has(scope)) perPage.set(scope, new Set());
      perPage.get(scope).add(o.ref);
      const owner = o.page + '|' + o.ref;
      if (bindings.has(owner) && bindings.get(owner) !== o.bind) problems++;
      bindings.set(owner, o.bind);
      // Constant parts, and asOf equal to the input's own.
      for (const [key, values] of Object.entries(CAPTURE_CONSTANT_PARTS)) if (!values.map(CAPTURE_STRING_PART).includes(t.part(key))) problems++;
      if (typeof asOf !== 'string' || t.part('asOf') !== CAPTURE_STRING_PART(asOf)) problems++;
      const a = o.advice;
      if (o.bind === 'V1') {
        // R1: the exact own key set and producer order; goalAllocation by the
        // allocationMode part, reason by the positive period class.
        if (!['v1-ready', 'v1-ready-withheld', 'v1-unknown'].includes(t.cls)) { problems++; continue; }
        const mode = t.part('allocationMode');
        const combined = mode === CAPTURE_STRING_PART('combined');
        if (!combined && mode !== CAPTURE_STRING_PART('historical-pools')) problems++;
        if ((t.part('manualInventory') === CAPTURE_NULL_PART) !== combined) problems++;
        if (!combined && t.part('allocationDescription') !== CAPTURE_STRING_PART(CAPTURE_DESCRIPTIONS['historical-pools'])) problems++;
        const want = captureKeys(CAPTURE_V1_KEYS, k => (k === 'goalAllocation' ? combined : t.cls === 'v1-unknown'));
        if (!sameList(t.names, want)) problems++;
        // R2: the status, the period's status and the advice's funding agree.
        const ready = t.cls === 'v1-ready';
        if (t.part('status') !== CAPTURE_STRING_PART(ready ? 'ready' : 'unavailable') || t.status !== t.part('status')) problems++;
        if (t.part('status') !== CAPTURE_STRING_PART(a.funding)) problems++;
        // Identity: no kind; a ready-built period spans the current view of
        // the same advice; an unknown-built one carries no dates.
        if (t.kind !== 'absent') problems++;
        const cur = a.views.get(a.current);
        if (t.cls === 'v1-unknown' ? t.start !== 'absent' || t.end !== 'absent' : !cur || t.start !== cur.start || t.end !== cur.end) problems++;
      } else {
        // R3/R4: the packet's exact keys by its bound view's role, its
        // constant description, kind, dates and status.
        const view = a.views.get(o.bind.slice(3));
        if (!view || t.cls !== 'v2-packet' || view.role === 'current') { problems++; continue; }
        const projected = view.role === 'next' || view.role === 'future';
        if (!sameList(t.names, captureKeys(CAPTURE_V2_KEYS, () => projected))) problems++;
        if (t.part('allocationDescription') !== CAPTURE_STRING_PART(CAPTURE_DESCRIPTIONS[projected ? 'projected' : 'past'])) problems++;
        if (t.kind !== CAPTURE_STRING_PART(projected ? 'projected' : 'historical')) problems++;
        if (t.start !== view.start || t.end !== view.end || t.status !== t.part('status')) problems++;
        if (!projected && t.part('status') !== CAPTURE_STRING_PART('unavailable')) problems++;
        if (o.page === 'budget') {
          const iv = itemized.get(o.bind.slice(3));
          if (!iv || typeof iv.status !== 'string' || t.part('status') !== CAPTURE_STRING_PART(iv.status)) problems++;
        }
      }
    }
    // One result per page for V1 and one per view for V2, across states (the
    // state-equality invariant), distinct across views.
    const viewOf = new Map();
    for (const [scope, refs] of perPage) {
      if (refs.size !== 1) problems++;
      for (const ref of refs) {
        const page = scope.split('|')[0];
        if (viewOf.has(page + '|' + ref) && viewOf.get(page + '|' + ref) !== scope) problems++;
        viewOf.set(page + '|' + ref, scope);
      }
    }
    for (const key of Object.keys(head)) {
      if (!key.startsWith(base)) continue;
      const inner = key.slice(base.length);
      if (/^(version|states|count|results|advices|gates)$/.test(inner)) continue;
      if (/^gate\.(0|[1-9]\d*)$/.test(inner)) { if (Number(inner.slice(5)) >= (COUNT_OK(at('gates')) ? at('gates') : 0)) problems++; continue; }
      let m = /^state\.(0|[1-9]\d*)$/.exec(inner);
      if (m) { if (Number(m[1]) >= states) problems++; continue; }
      m = /^o(0|[1-9]\d*)$/.exec(inner);
      if (m) { if (Number(m[1]) >= count) problems++; continue; }
      m = /^r(0|[1-9]\d*)\.(digest|keys|shape|identity|part\.(?:0|[1-9]\d*))$/.exec(inner);
      if (m) { if (Number(m[1]) >= results) problems++; continue; }
      m = /^advice\.(0|[1-9]\d*)(?:\.view\.(0|[1-9]\d*))?$/.exec(inner);
      if (m) {
        const nv = typeof at('advice.' + m[1]) === 'string' ? at('advice.' + m[1]).split('|')[5] : null;
        if (Number(m[1]) >= adviceCount || (m[2] !== undefined && !(Number(m[2]) < Number(nv)))) problems++;
        continue;
      }
      problems++;
    }
  }
  return problems;
}

function coverageReport(head) {
  const digests = inputDigests(head);
  const inputs = digests.size;
  let invalid = head['check.schema'] === CHECK_SCHEMA ? 0 : 1;
  const household = new Map(FIELD_CLASSES.map(c => [c.id, 0]));
  const invented = new Map(FIELD_CLASSES.map(c => [c.id, new Set()]));
  for (const key of Object.keys(head)) {
    const r = keyRole(key);
    if (r.role === 'meta') {
      if (!CHECK_KEYS.includes(key)) invalid++;
      continue;
    }
    if (r.role === 'coverage') continue;
    if (r.role === 'digest') {
      if (!digests.has(r.id)) invalid++;
      continue;
    }
    if (r.role === 'invented' && !digests.has(r.id)) { invalid++; continue; }
    for (const cls of FIELD_CLASSES) {
      if (!patternMatches(cls.pattern, r.inner) || !observedValue(cls.kind, head[key])) continue;
      if (r.role === 'household') household.set(cls.id, 1);
      else invented.get(cls.id).add(r.id);
    }
  }
  const expected = new Set();
  let observed = 0, byHousehold = 0, byInvented = 0, unobserved = 0;
  for (const cls of FIELD_CLASSES) {
    const h = household.get(cls.id), i = invented.get(cls.id).size;
    for (const [key, actual, max] of [['coverage.' + cls.id + '.household', h, 1],
      ['coverage.' + cls.id + '.invented', i, inputs]]) {
      expected.add(key);
      const claim = own(head, key) ? head[key] : undefined;
      if (!Number.isSafeInteger(claim) || claim < 0 || claim > max || claim !== actual) invalid++;
    }
    if (h + i > 0) observed++; else unobserved++;
    if (h) byHousehold++;
    if (i) byInvented++;
  }
  for (const key of Object.keys(head)) if (key.startsWith('coverage.') && !expected.has(key)) invalid++;
  invalid += captureEvidenceProblems(head, ['', ...[...digests.keys()].map(id => 'fixture.' + id + '.')]);
  return { declared: FIELD_CLASSES.length, observed, byHousehold, byInvented, unobserved, invalid,
    complete: invalid === 0 && unobserved === 0 };
}

function digestState(base, head, key) {
  const valid = map => map !== null && own(map, key) && typeof map[key] === 'string' && DIGEST.test(map[key]);
  if (!valid(head)) return 'unknown';
  if (!valid(base)) return 'introduced';
  return base[key] === head[key] ? 'unchanged' : 'changed';
}

// Everything the public summary says, as counts and fixed states.
function analyzeFigures(base, head) {
  assertSnapshot(head, 'head');
  if (base !== null) assertSnapshot(base, 'base');
  const families = PUBLIC_FAMILIES.map(name => ({ name, householdCompared: 0, householdChanged: 0,
    inventedCompared: 0, inventedChanged: 0 }));
  const row = name => families.find(f => f.name === name);
  const baseInputs = inputDigests(base), headInputs = inputDigests(head);
  const status = new Map();
  for (const [id, digest] of headInputs) {
    status.set(id, base === null || !baseInputs.has(id) ? 'added' : baseInputs.get(id) === digest ? 'common' : 'edited');
  }
  for (const id of baseInputs.keys()) if (!headInputs.has(id)) status.set(id, 'removed');
  const inputs = { common: 0, added: 0, edited: 0, removed: 0, movedFields: 0 };
  for (const s of status.values()) inputs[s]++;
  let compared = 0, changed = 0;
  for (const key of [...new Set([...Object.keys(base || {}), ...Object.keys(head)])].sort()) {
    const r = keyRole(key);
    if (r.role === 'meta' || r.role === 'digest') continue;
    if (r.role === 'invented' && status.get(r.id) !== 'common') continue;
    const moved = base === null || differs(base[key], head[key]);
    let family, column;
    if (r.role === 'coverage') {
      family = 'Coverage';
      column = key.endsWith('.invented') ? 'invented' : 'household';
    } else {
      family = figureFamily(r.inner);
      column = r.role === 'invented' ? 'invented' : 'household';
    }
    const f = row(family);
    f[column + 'Compared']++;
    if (moved) f[column + 'Changed']++;
    if (moved && r.role === 'invented') inputs.movedFields++;
    compared++;
    if (moved) changed++;
  }
  const state = base === null ? 'introduced' : changed ? 'changed' : 'unchanged';
  const coverage = coverageReport(head);
  const withheld = state !== 'unchanged' || inputs.added + inputs.edited + inputs.removed > 0;
  return { state, families, inputs, compared, changed, coverage,
    householdInput: digestState(base, head, 'check.household.input.sha256'),
    collector: digestState(base, head, 'check.collector.sha256'),
    withheld, incomplete: !coverage.complete };
}

const NOT_COVERED = 'Not covered: household figures at a live opening (private route only); page rendering and '
  + 'page-side decisions, including the PA-5 unavailable verdict and ATLAS-080 settlement qualification; '
  + 'persisted or adjusted page knobs; spending-period history on invented inputs that declare none; '
  + 'branches inside an observed field class.';

function acceptanceLine(a) {
  if (a.withheld && a.incomplete) {
    return 'Figures acceptance: WITHHELD and INCOMPLETE until the owner privately reconciles the exact-base/head '
      + 'figure-level diff with the merge card and every declared field class is observed by at least one input.';
  }
  if (a.withheld) {
    return 'Figures acceptance: WITHHELD until the owner privately reconciles the exact-base/head figure-level diff '
      + 'with the merge card.';
  }
  if (a.incomplete) {
    return 'Figures acceptance: INCOMPLETE until every declared field class is observed by at least one input and '
      + 'the coverage manifest reconciles; an unchanged comparison does not cover unobserved classes.';
  }
  return 'Figures acceptance: no compared field moved on the household dated opening or the invented inputs; '
    + 'items listed as not covered are outside this result.';
}

function formatPublicFiguresComment(base, head) {
  const a = analyzeFigures(base, head);
  const c = a.coverage;
  return MARKER + '\n### Published figures - public summary\n\n'
    + 'Comparison: ' + a.state + '.\n'
    + 'Coverage: ' + (a.incomplete ? 'INCOMPLETE' : 'complete') + '.\n\n'
    + '| Publication family | Household compared | Household changed | Invented compared | Invented changed |\n'
    + '|---|---|---|---|---|\n'
    + a.families.map(f => '| ' + f.name + ' | ' + f.householdCompared + ' | ' + f.householdChanged + ' | '
      + f.inventedCompared + ' | ' + f.inventedChanged + ' |').join('\n') + '\n\n'
    + 'Invented inputs: ' + a.inputs.common + ' compared like for like; ' + a.inputs.added + ' added; '
    + a.inputs.edited + ' edited; ' + a.inputs.removed + ' removed; ' + a.inputs.movedFields
    + ' fields moved on unedited inputs.\n'
    + 'Household dated opening input: ' + a.householdInput + '.\n'
    + 'Snapshot collector: ' + a.collector + '.\n'
    + 'Field classes: ' + c.declared + ' declared; ' + c.observed + ' observed by at least one input; '
    + c.byHousehold + ' observed by the household dated opening; ' + c.byInvented + ' observed by invented inputs; '
    + c.unobserved + ' observed by no input.\n'
    + 'Coverage manifest: ' + (c.invalid === 0 ? 'reconciled with the captured fields.'
      : 'INVALID; ' + c.invalid + ' entries are missing, extra, malformed or unreconciled.') + '\n'
    + 'Total: ' + a.compared + ' compared; ' + a.changed + ' changed.\n'
    + 'Financial values and raw diagnostics are withheld.\n'
    + NOT_COVERED + '\n'
    + acceptanceLine(a) + '\n';
}

// The private detail: identifiers, before/after values and deltas, grouped by
// what kind of field each row is. It goes only to the owner's approved private
// route (figures-private-diff.js), never to a public surface.
const DETAIL_SECTIONS = [
  ['household', 'Household dated opening — published-figure fields'],
  ['invented', 'Invented inputs — synthetic fields, not household figures'],
  ['metadata', 'Coverage manifest and input metadata — counts and digests, not figures'],
];

function detailSection(key) {
  const role = keyRole(key).role;
  if (role === 'household') return 'household';
  if (role === 'invented') return 'invented';
  return 'metadata';
}

function deltaText(k, a, b) {
  if (typeof a === 'number' && typeof b === 'number' && !isCount(k) && !isRate(k)) {
    const d = b - a;
    return (d >= 0 ? '+' : '−') + money(Math.abs(d)).replace(/^[−$]+/, '$');
  }
  if (typeof a === 'number' && typeof b === 'number') {
    const d = b - a;
    return (d >= 0 ? '+' : '−') + Math.abs(d);
  }
  if (a === undefined) return 'new';
  if (b === undefined) return 'removed';
  return 'changed';
}

function formatFiguresComment(base, head, baseRef) {
  const grouped = keys => DETAIL_SECTIONS.map(([id, title]) => ({ title, keys: keys.filter(k => detailSection(k) === id) }));
  if (base === null) {
    const sections = grouped(Object.keys(head)).filter(s => s.keys.length).map(s =>
      `#### ${s.title}\n\n| Field | Value |\n|---|---|\n` + s.keys.map(k => `| \`${k}\` | ${fmt(k, head[k])} |`).join('\n') + '\n');
    return `${MARKER}\n### 📊 Published figures — private detail, no baseline\n\n` +
      `The snapshot script is introduced by this PR, so there is no baseline to ` +
      `compare against. These are the captured fields as of this head, grouped by kind; ` +
      `invented-input rows are synthetic, not household figures.\n\n` + sections.join('\n');
  }

  const { keys, moved } = compareFigures(base, head);
  const counts = grouped(keys).map(s => s.keys.length);

  if (!moved.length) {
    return `${MARKER}\n### 📊 Published figures — private detail: no compared field moved\n\n` +
      `All ${keys.length} captured fields are identical on this head and on \`${baseRef}\`: ` +
      `${counts[0]} household dated-opening fields, ${counts[1]} invented-input fields and ` +
      `${counts[2]} coverage and input metadata fields. That covers only the captured fields on those inputs; ` +
      `page rendering, page-side decisions and household figures at a live opening are outside it.\n`;
  }

  const sections = grouped(moved).filter(s => s.keys.length).map(s =>
    `#### ${s.title} (${s.keys.length} moved)\n\n| Field | ${baseRef} | this PR | Δ |\n|---|---|---|---|\n` +
    s.keys.map(k => `| \`${k}\` | ${fmt(k, base[k])} | **${fmt(k, head[k])}** | ${deltaText(k, base[k], head[k])} |`).join('\n') + '\n');
  return `${MARKER}\n### 📊 ${moved.length} compared field${moved.length === 1 ? '' : 's'} moved\n\n` +
    `Computed by running each revision's own snapshot on \`${baseRef}\` and on this ` +
    `head, not by reading the diff — the figure that started all of this was a derived one, ` +
    `and a source diff would not have shown it.\n\n` +
    `**Household rows are published figures on the household dated opening; confirm each was intended and is ` +
    `stated on the merge card.** Invented rows are synthetic: they show logic movement on an invented input, not a ` +
    `household figure. Coverage and input metadata rows are counts and digests.\n\n` +
    sections.join('\n') +
    `\n<sub>${keys.length - moved.length} other captured fields unchanged.</sub>\n`;
}

function main(argv) {
  const [, , basePath, headPath, baseRef] = argv;
  const publicSummary = argv.length === 6 && argv[5] === '--public-summary';
  if (!basePath || !headPath || (argv.length !== 5 && !publicSummary)) {
    process.stderr.write(
      'usage: node scripts/figures-comment.js <base.json> <head.json> <baseRef> [--public-summary]\n'
    );
    return 1;
  }
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
  process.stdout.write(publicSummary ? formatPublicFiguresComment(base, head)
    : formatFiguresComment(base, head, baseRef));
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = {
  MARKER,
  CHECK_SCHEMA,
  FIELD_CLASSES,
  PUBLIC_FAMILIES,
  CAPTURE_EVIDENCE,
  CAPTURE_ROUTES,
  CAPTURE_ANCHOR_OF,
  CAPTURE_STEPS,
  CAPTURE_GATE_WORDS,
  CAPTURE_V1_KEYS,
  CAPTURE_V2_KEYS,
  CAPTURE_PERIOD_CLASSES,
  CAPTURE_CONSTANT_PARTS,
  CAPTURE_DESCRIPTIONS,
  captureExpectedStates,
  captureEvidenceProblems,
  formatFiguresComment,
  money,
  fmt,
  isCount,
  isRate,
  main,
  compareFigures,
  analyzeFigures,
  coverageReport,
  snapshotObserves,
  patternMatches,
  observedValue,
  figureFamily,
  keyRole,
  formatPublicFiguresComment,
};
