'use strict';
/* Format the published-figures review comment from two check snapshots.
 * `node scripts/figures-comment.js <base.json> <head.json> <baseRef> [--public-summary]`
 *
 * `scripts/figures-snapshot.js` emits one flat check snapshot per revision:
 * the household dated opening (data.json + public/periods.json, unprefixed
 * keys: Plan, Budget pay periods, Savings, Bills, Subscriptions, Credit,
 * Planning and their trust tags), each invented input under
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
  ['bills-row-confidence', 'Trust', 'bills.*.confidence', 'tag'],
  ['subscriptions-row-confidence', 'Trust', 'subscriptions.*.confidence', 'tag'],
  ['credit-row-confidence', 'Trust', 'credit.*.confidence', 'tag'],
  ['credit-minimum-confidence', 'Trust', 'credit.*.minimumConfidence', 'tag'],
  ['credit-minimum-date-confidence', 'Trust', 'credit.*.minimumDateConfidence', 'tag'],
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
  ['bills-row-amount', 'Bills', 'bills.*.amount', 'money'],
  ['subscriptions-row-amount', 'Subscriptions', 'subscriptions.*.amount', 'money'],
  ['credit-balance', 'Credit', 'credit.*.balance', 'money'],
  ['credit-minimum', 'Credit', 'credit.*.minimum', 'money'],
  ['planning-verdict', 'Planning', 'planning.*.verdict', 'tag'],
  ['planning-trajectory-cash', 'Planning', 'planning.trajectory.*.cash.amount', 'money'],
].map(([id, family, pattern, kind]) => Object.freeze({ id, family, pattern, kind })));

// Public families are fixed labels, never interpolated snapshot keys.
const PUBLIC_FAMILIES = Object.freeze(['Plan', 'Budget', 'Savings', 'Bills', 'Subscriptions', 'Credit',
  'Planning', 'Trust', 'Coverage', 'Other']);
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
  if (inner.startsWith('bills.')) return 'Bills';
  if (inner.startsWith('subscriptions.')) return 'Subscriptions';
  if (inner.startsWith('credit.')) return 'Credit';
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
// Required Savings publication evidence (Atlas 6549108431 §1B): every input,
// household and invented, carries the typed canonical capture's version,
// funding state, ordered roster count, and per invocation an identity and a
// digest. Missing, malformed, extra or out-of-roster entries are counted as
// INVALID, so deleting the evidence on both revisions cannot read unchanged.
// This list is mirrored by the posting step; a test pins the two together.
const PUBLICATION_ENCODING = 'atlas-savings-publication/v1';
const PUBLICATION_FUNDING = ['absent', 'null', 'object'];
function publicationEvidenceProblems(head, prefixes) {
  let problems = 0;
  const DIGEST_OK = v => typeof v === 'string' && DIGEST.test(v);
  for (const prefix of prefixes) {
    const at = key => (own(head, prefix + key) ? head[prefix + key] : undefined);
    if (at('savings.publication.version') !== PUBLICATION_ENCODING) problems++;
    if (!PUBLICATION_FUNDING.includes(at('savings.publication.funding'))) problems++;
    const count = at('savings.publication.count');
    const roster = Number.isSafeInteger(count) && count >= 0 && count <= 4096 ? count : -1;
    if (roster < 0) problems++;
    const required = [];
    if (at('savings.publication.funding') === 'object') required.push('d0');
    for (let i = 0; i < roster; i++) required.push('p' + i, 'r' + i, 'c' + i);
    for (const inv of required) {
      const invocation = at('savings.publication.' + inv + '.invocation');
      if (typeof invocation !== 'string' || !invocation) problems++;
      if (!DIGEST_OK(at('savings.publication.' + inv + '.digest'))) problems++;
    }
    for (const key of Object.keys(head)) {
      if (!key.startsWith(prefix + 'savings.publication.')) continue;
      const inner = key.slice(prefix.length + 'savings.publication.'.length);
      if (['version', 'funding', 'count'].includes(inner)) continue;
      const m = /^(d0|[prc](?:0|[1-9][0-9]{0,3}))\.(invocation|digest|keys|part\.[^.]+)$/.exec(inner);
      if (!m || !required.includes(m[1])) { problems++; continue; }
      if (m[2].startsWith('part.') ? !DIGEST_OK(head[key]) : m[2] === 'keys' && typeof head[key] !== 'string') problems++;
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
  invalid += publicationEvidenceProblems(head, ['', ...[...digests.keys()].map(id => 'fixture.' + id + '.')]);
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
  PUBLICATION_ENCODING,
  publicationEvidenceProblems,
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
