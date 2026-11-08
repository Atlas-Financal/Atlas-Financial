'use strict';
/* Every published headline figure, as one flat JSON map. `node scripts/figures-snapshot.js`
 *
 * This exists so a pull request cannot move a number the household acts on
 * without anyone noticing. CI runs it on the base revision and on the head,
 * diffs the two, and posts the result on the PR. A change here is not a
 * failure — it is usually the whole point of the change — but it has to be
 * SEEN, and it has to match what the merge card says was intended.
 *
 * The rule for what belongs in here: if the household could read it off the
 * Plan, Budget, Savings, Bills, Subscriptions, Credit, or Planning surface and
 * do something differently because of it, it belongs, with its trust tag.
 * Anything that is only evidence does not.
 * Deep Dive, Records, and Modellers remain outside this snapshot, as do page
 * rendering and page-side decisions.
 *
 * WHAT ONE RUN EMITS (the check snapshot, `node scripts/figures-snapshot.js`):
 *
 *   - the household dated opening: data.json + public/periods.json, unprefixed
 *     keys. It is the only household evidence CI has. Household figures at a
 *     live opening cannot be observed here at all (no provider access in CI).
 *   - every invented input in test/fixtures/figures-inputs/*.json, under
 *     `fixture.<id>.`, with `fixture.<id>.input.sha256` = the digest of that
 *     complete effective input (its served data and its own periods payload).
 *     Invented inputs never read data.json or public/periods.json.
 *   - `check.*` collector and household-input digests, and a coverage manifest
 *     `coverage.<class>.household` (0 or 1) / `.invented` (how many invented
 *     inputs observe the class) for the fixed vocabulary in figures-comment.js.
 *
 * `--household-only` emits just the household map (the pre-v2 shape), for
 * local use and for suites that compare against an older revision's script.
 * `--coverage` prints the manifest with class names, locally; the names never
 * reach the public summary.
 *
 * Every input runs Forecast.recommend with the Budget page's own default
 * options (pageOptions below): an engine-input parity subset, NOT full page
 * parity. Page-side decisions the page makes before calling Forecast are not
 * executed here, and an input on which they could matter is refused.
 *
 * Output is a flat `{ "label": value }` map so the diff is trivial and stable
 * across revisions. Values are numbers where they are money, strings where
 * they are dates or verdicts. Keys must be STABLE: renaming one shows up as a
 * removal plus an addition, which is noise. Add new keys freely.
 *
 * THIS SCRIPT DOES NOT COMPARE ANYTHING. Running it emits ONE snapshot: the
 * figures as of the revision it is run from. It selects no baseline and holds
 * no opinion about what came before. `node scripts/figures-snapshot.js` answers
 * "what are the figures here", never "what changed".
 *
 * The baseline belongs entirely to whoever does the comparing. CI checks out
 * the PR base into a worktree and runs THAT revision's own copy of this script,
 * then diffs the two. Where the base revision has no copy — as on the pull
 * request that introduces the script — there is nothing to diff against, and CI
 * says so rather than inventing one.
 *
 * SO ANY "UNCHANGED" CLAIM MUST NAME BOTH REVISIONS. Not because it is tidier,
 * but because the alternative was got wrong here: comparing this script's
 * output against a file generated earlier from a mid-branch commit is a real
 * and useful check, and it is NOT a comparison against the base branch. The two
 * were conflated. Several commits reported "no published figure moves", each
 * true against the commit before it, and that was then summarised as though the
 * whole branch had moved nothing — and once described as confirmed "against
 * base", which CI had explicitly declined to do.
 *
 * The branch in fact moved a dozen published figures: the weekly allocation
 * split, effective consumer debt, revolving headroom, the positions and
 * net-worth figures, liquidity and coverage. All intended, all listed on the
 * merge card. What did not move was the $1,250/week household cap — a cash
 * constraint, and the one number that correctness work was least able to shift.
 *
 * If you are writing the claim, write the command that supports it. Each
 * revision runs its OWN copy of this script, because the engine's shape changes
 * between revisions and one revision's script against another's data is not a
 * comparison of anything:
 *
 *   git worktree add /tmp/base <revision> && \
 *     node /tmp/base/scripts/figures-snapshot.js > /tmp/base.json
 *   node scripts/figures-snapshot.js > /tmp/head.json
 *   diff /tmp/base.json /tmp/head.json     # unchanged AGAINST <revision>
 *
 * Substitute a different revision and the claim changes with it. Name it.
 *
 * That recipe needs <revision> to HAVE a copy of this script, which is exactly
 * what the base branch lacks until this first merges — verified, not assumed:
 * against `origin/main` today the second line has no file to run. When the base
 * cannot produce a snapshot the honest answer is that there is no base
 * comparison, which is what CI reports. It is not a licence to substitute a
 * mid-branch commit and keep the word "base".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const F = require(path.join(ROOT, 'public', 'forecast.js'));
const PageCapture = require('./figures-page-capture');
// The page capture is deterministic in the input and the page and engine
// source. The page runs its own Forecast in its own realm, so engine
// perturbations reach it only through PageCapture.withPerturbations; a run
// with none registered reuses a capture for an identical input digest.
const captureMemo = new Map();
function captureFor(data, periods) {
  const key = PageCapture.perturbed() ? null : sha256(canonicalJson({ data, periods }));
  if (key && captureMemo.has(key)) return captureMemo.get(key);
  const capture = PageCapture.capturePages(data, periods);
  if (key) captureMemo.set(key, capture);
  return capture;
}
const INPUT_DIR = path.join(ROOT, 'test', 'fixtures', 'figures-inputs');
const INPUT_SCHEMA = 'atlas-figures-input/v1';
const INPUT_ID = /^[a-z][a-z0-9-]{0,47}$/;
const INPUT_KEYS = ['schema', 'id', 'invented', 'description', 'origin', 'limitations', 'periods', 'data'];
const ORIGIN_KEYS = ['kind', 'source', 'transform'];
const ORIGIN_KINDS = ['test-builder', 'invented-ledger'];
const LIMITATIONS = ['absent-periods'];

const round = n => Math.round(n * 100) / 100;

// The Budget page's default Forecast.recommend call, mirrored as an
// ENGINE-INPUT PARITY SUBSET: public/plan.js simOpts (:211-224) with the knobs
// loadKnobs takes from plan.defaults, the canonical debts and their policy
// target and the extra facilities wireControls sets (:9020-9023), then
// renderPlan's own additions (:8144-8157): the funding sources, the periods
// payload, and the served overlay. Only currentPeriodActuals is gated on
// liveOverlay.applied === true; operatingPlan, observedCash and
// operatingPlanNote are read from any overlay, exactly as the page reads them.
// Persisted or user-adjusted knobs are not covered. Two page-side decisions are
// not executed: the PA-5 effective verdict (liveOperatingPlanUnavailable) and
// ATLAS-080 settlement qualification (planSettlementOutcome). parityExclusions
// names an input on which either could make the page differ from this call.
function pageOptions(data, periods) {
  const plan = data.plan;
  const overlay = data.liveOverlay;
  const priority = F.debtPriority(plan, data.debts);
  return {
    scenario: plan.defaults.scenario,
    targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: plan.defaults.extraDebtMonthly,
    incomeOverrides: {},
    disabled: [],
    debts: data.debts,
    extraDebtTarget: priority.target && priority.target.id,
    extraFacilities: data.revolvingExtra,
    fundingSources: plan.funding && plan.funding.options,
    periods,
    currentPeriodActuals: overlay && overlay.applied === true ? overlay.currentPeriodActuals : null,
    operatingPlan: overlay && overlay.operatingPlan,
    observedCash: overlay && overlay.observedCash,
    operatingPlanNote: overlay && overlay.operatingPlanNote,
  };
}

// Fail-closed bound of the parity subset: any served settlement outcome
// (ATLAS-080 qualification may change the options or short-circuit the page),
// and any overlay that was not applied (the PA-5 verdict may replace the
// served operatingPlan). Wider than either page predicate on purpose.
function parityExclusions(data) {
  const reasons = [];
  if (data.settlementEvidenceStatus !== undefined || data.settlementEvidence !== undefined) {
    reasons.push('settlement-outcome');
  }
  const overlay = data.liveOverlay;
  if (overlay !== undefined && overlay !== null && overlay.applied !== true) reasons.push('overlay-not-applied');
  return reasons;
}

// Ids and dates become key segments; a dot inside one would change the shape.
const segment = value => String(value).replace(/\./g, '_');

function buildFiguresSnapshot(data, periods) {
const plan = data.plan;
const asOf = data.meta.asOf;

const out = {};
// Values are inert scalars. A nonfinite number or a structured value is a
// collector or engine failure, never a legitimate null: it throws.
const put = (key, value) => {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('nonfinite snapshot value: ' + key);
  if (value !== null && value !== undefined && typeof value === 'object') throw new Error('structured snapshot value: ' + key);
  if (typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
    throw new Error('unserializable snapshot value: ' + key);
  }
  if (typeof value === 'number') {
    // Validated before AND after rounding: a finite value whose cents are not
    // a safe integer (1e308 * 100 overflows to Infinity, which JSON writes as
    // null) is corrupt numerical output, never a legitimate null or zero.
    if (!Number.isSafeInteger(Math.round(value * 100))) throw new Error('unrepresentable snapshot value: ' + key);
    const rounded = round(value);
    if (!Number.isFinite(rounded)) throw new Error('unrepresentable snapshot value: ' + key);
    out[key] = rounded;
    return;
  }
  out[key] = value;
};
// A summed term: an absent term is zero, but a nonfinite one is a failure
// and must not be coerced to a legitimate zero by `|| 0`.
const term = (value, key) => {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('nonfinite snapshot value: ' + key);
  return value;
};
// A required summed term: it must be a finite number. Absent is not zero here.
const finite = (value, key) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('nonfinite snapshot value: ' + key);
  return value;
};
// A field the publication carries, copied as it is; a missing field stays
// missing (absent key), an explicit null stays null.
const putField = (key, row, field) => {
  if (row && Object.prototype.hasOwnProperty.call(row, field) && row[field] !== undefined) put(key, row[field]);
};

put('meta.asOf', asOf);
put('meta.windowDays', plan.windowDays);
put('meta.targetBuffer', plan.defaults.targetBuffer);
put('meta.scenario', plan.defaults.scenario);

/* ---- the cash position ------------------------------------------------- */
put('cash.spendableToday', F.spendableHouseholdCash(plan));
for (const h of plan.startingCash.heldElsewhere || []) {
  const key = `cash.elsewhere.${(h.class || 'unclassified')}`;
  // A missing value makes its class total unknown (null), never a zero.
  const prior = Object.prototype.hasOwnProperty.call(out, key) ? out[key] : 0;
  put(key, prior === null || h.value === null || h.value === undefined ? null : prior + finite(h.value, key));
}

/* ---- the recommendation, which is the point of the whole page ---------- */
// ONE call with the Budget page's own default options (pageOptions above). The
// funding source decides whether covering an opening gap costs anything, and
// the periods payload feeds the payday risk rows the page renders, so the
// snapshot reads the page's computation rather than a reduced copy of it.
const advice = F.recommend(plan, asOf, pageOptions(data, periods));
const savings = advice.savingsInventory;
if (savings) {
  put('savings.setup', savings.status);
  put('savings.incrementalInstructions', savings.incrementalInstructions);
  for (const pool of savings.pools || []) {
    for (const key of ['status', 'observedCash', 'observedAsOf', 'intent', 'unallocated', 'deficit']) {
      put('savings.pool.' + pool.id + '.' + key, pool[key]);
    }
  }
  for (const goal of savings.goals || []) {
    for (const key of ['intent', 'backed', 'target', 'targetMax', 'settled']) put('savings.goal.' + goal.key + '.' + key, goal[key]);
  }
}
put('plan.mode', advice.mode);
if (advice.funding) {
  put('plan.fundingSource', advice.funding.parts.map(p => p.id).join('+'));
  put('plan.fundingBorrowed', advice.funding.borrowed);
  put('plan.fundingShortfall', advice.funding.shortfall);
}
put('plan.weeklyCap', advice.weekly);
put('plan.weeklyCapMonthly', F.monthlyFromWeekly(advice.weekly));
put('plan.effectiveFrom', advice.effectiveFrom);
// A withheld plan publishes no binding day; that is null, not a crash.
put('plan.bindingDate', advice.binding ? advice.binding.date : null);
put('plan.bindingBalance', advice.binding ? advice.binding.balance : null);
put('plan.endingCash', advice.sim.ending);
put('plan.lowestCash', advice.sim.min.balance);
put('plan.lowestCashDate', advice.sim.min.date);
if (advice.gap) {
  put('plan.gapAmount', advice.gap.amount);
  put('plan.gapDate', advice.gap.date);
  put('plan.gapDueThatDay', advice.gap.dueOnGapDay);
}
if (advice.paydayAllocation) {
  const pa = advice.paydayAllocation;
  put('payday.available', pa.available);
  put('payday.obligations', pa.obligations && pa.obligations.allocated);
  put('payday.essentials', pa.essentials && pa.essentials.allocated);
  put('payday.liquidity', pa.liquidity && pa.liquidity.allocated);
  put('payday.futureCosts', (pa.futureCosts || []).reduce((s, r) => s + term(r.allocated, 'payday.futureCosts'), 0));
  put('payday.extraDebt', pa.extraDebt && pa.extraDebt.allocated);
  put('payday.unallocated', pa.unallocated);
  put('payday.riskShortfall', (pa.risks || []).reduce((s, r) => s + term(r.shortfall, 'payday.riskShortfall'), 0));
}

const operating = (advice.defaultView && advice.defaultView.calendarPeriods) || [];
const thisPeriod = operating.find(p => p && p.id === 'this-pay-period')
  || operating.find(p => p && p.role === 'active');
const nextPeriod = operating.find(p => p && p.id === 'next-pay-period')
  || operating.find(p => p && p.role === 'future');
if (thisPeriod) {
  put('operating.this.start', thisPeriod.start);
  put('operating.this.end', thisPeriod.end);
  put('operating.this.opening', thisPeriod.opening);
  put('operating.this.available', thisPeriod.available);
  put('operating.this.incomeAdded', thisPeriod.incomeAdded);
  put('operating.this.otherIncome', thisPeriod.otherIncome && thisPeriod.otherIncome.amount);
  put('operating.this.incomeTotal', thisPeriod.incomeTotal);
  // Plan Q07 remainder is Balance After Deductions (income − bills −
  // Household Budget). Forecast.projectedEnding is afterBigPurchases —
  // target-buffer leftover after extra-debt / Road Ahead allocation —
  // and is not the household-facing remainder.
  const thisRemainder = thisPeriod.predictedEndingBalance != null
    ? thisPeriod.predictedEndingBalance
    : (thisPeriod.balanceAfterDeductions != null
      ? thisPeriod.balanceAfterDeductions
      : thisPeriod.afterHouseholdBudget);
  put('operating.this.projectedEnding', thisRemainder);
  // Household Budget Total on the Plan is Forecast budgetHold.
  put('operating.this.householdBudgetTotal', thisPeriod.budgetHold);
}
if (advice.defaultView && advice.defaultView.liveCurrentBalance != null) {
  put('operating.liveCurrentBalance', advice.defaultView.liveCurrentBalance);
}
if (nextPeriod) {
  put('operating.next.start', nextPeriod.start);
  put('operating.next.end', nextPeriod.end);
  put('operating.next.available', nextPeriod.available);
  put('operating.next.incomeAdded', nextPeriod.incomeAdded);
  put('operating.next.otherIncome', nextPeriod.otherIncome && nextPeriod.otherIncome.amount);
  put('operating.next.incomeTotal', nextPeriod.incomeTotal);
  put('operating.next.projectedEnding', nextPeriod.projectedEnding);
  put('operating.next.householdBudgetTotal', nextPeriod.budgetHold);
}

const carryTrend = (advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points) || [];
for (let i = 0; i < carryTrend.length; i++) {
  const point = carryTrend[i];
  if (!point || !point.payday || point.known !== true) continue;
  put('operating.carryover.' + point.payday, point.amount);
}

const T = advice.sim.totals;
put('totals.confirmedIncome', T.confirmedIncome);
put('totals.estimatedIncome', T.estimatedIncome);
put('totals.obligations', T.obligations);
put('totals.bills', T.bills);
put('totals.commitments', T.commitments);
put('totals.nonCashInterest', T.noncash);

/* ---- what the cap has to cover ----------------------------------------- */
// The weekly figures below are the engine's, not this script's. It kept its
// own copy of the weeks-per-month constant until the conversion moved into
// Forecast — a third copy, beside the page's and the suite's, in the one file
// whose whole job is to prove published figures did not move.
const budget = periods ? F.budgetBreakdown(plan, periods, {
  paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
  weeklyCap: advice.weekly,
  asOf,
}) : null;
if (budget) {
  put('budget.basis', budget.basis);
  put('budget.essentialPerMonth', budget.essentialMonthly);
  put('budget.requiredPerMonth', budget.requiredMonthly);
  put('budget.requiredPerWeek', budget.cap.essentialWeekly);
  put('budget.discretionaryPerMonth', budget.discretionaryMonthly);
  put('budget.reservePerMonth', budget.reserveMonthly);
  put('budget.datedPerMonth', budget.datedMonthly);
  const food = budget.categories.find(c => c.id === 'groceries');
  const fuel = budget.categories.find(c => c.id === 'fuel');
  if (food && fuel) {
    put('budget.foodAndFuelPerMonth', budget.cap.foodFuelPlannedMonthly);
    put('budget.foodAndFuelPerWeek', budget.cap.foodFuelPlannedWeekly);
  }
}

/* ---- the debt side ------------------------------------------------------ */
const proj = F.projectDebts(plan, data.debts, asOf,
  Object.assign({}, advice.simOptions, { weeklyVariable: advice.weekly,
    extraFacilities: data.revolvingExtra }));
for (const m of proj.marks) {
  if (![0, 30, 60, 90].includes(m.day)) continue;
  const tag = m.day === 0 ? 'today' : 'day' + m.day;
  const cash = m.day === 0 ? F.spendableHouseholdCash(plan)
    : (advice.sim.daily.find(p => p.date === m.date) || {}).balance;
  put(`scoreboard.${tag}.cash`, cash);
  put(`scoreboard.${tag}.consumerDebt`, m.consumer);
  put(`scoreboard.${tag}.heloc`, m.heloc);
  put(`scoreboard.${tag}.creditHeadroom`, m.headroom);
  put(`scoreboard.${tag}.facilitiesOverLimit`, m.overLimitCount);
}
put('debt.interestOverWindow', proj.marks.length ? proj.marks[proj.marks.length - 1].interestToDate : null);
for (const c of proj.crossings || []) {
  put(`debt.overLimit.${c.id}`, c.alreadyOver ? 'already over today' : c.date);
}

/* ---- the balance sheet -------------------------------------------------- */
put('balance.assets', F.publicationTotals(data).assets);
// A total over balances: a missing balance makes the total unknown (null),
// never a zero; a non-numeric or nonfinite one is a failure. A missing
// pending amount is no pending charge.
const balanceTotal = (rows, key, withPending = false) => {
  let sum = 0;
  for (const x of rows) {
    if (x.balance === null || x.balance === undefined) return null;
    sum += finite(x.balance, key);
    if (withPending) sum += term(x.pending, key);
  }
  return sum;
};
const unsecuredDebts = data.debts.filter(x => !x.secured);
put('balance.debts', balanceTotal(data.debts, 'balance.debts'));
// POSTED only, and named so. The scoreboard's consumer-debt figure is posted
// PLUS known pending, because a pending charge is money already spent; these
// two sat in one report as `balance.consumerDebt` $29,842.83 against
// `scoreboard.today.consumerDebt` $30,090.01 with nothing saying why.
put('balance.consumerDebtPosted', balanceTotal(unsecuredDebts, 'balance.consumerDebtPosted'));
put('balance.consumerDebtPending',
  unsecuredDebts.reduce((s, x) => s + term(x.pending, 'balance.consumerDebtPending'), 0));
put('balance.consumerDebtEffective', balanceTotal(unsecuredDebts, 'balance.consumerDebtEffective', true));
put('balance.securedDebt', balanceTotal(data.debts.filter(x => x.secured), 'balance.securedDebt'));

const helocSnap = F.compactSnapshot(data.debts, data.helocHistory);
if (helocSnap.heloc) {
  put('heloc.vsLastMonth', helocSnap.heloc.delta);
  put('heloc.vsLastMonthVerdict', helocSnap.heloc.id);
}
const dive = F.deepDive(data);
if (dive.heloc && dive.heloc.current != null) {
  put('heloc.currentOpening', dive.heloc.current);
}

/* ---- what the household is told to do ----------------------------------- */
const first = (plan.actions || [])[0];
if (first) {
  put('action.next', first.what);
  put('action.nextAmount', first.amount);
  put('action.nextDue', first.due);
}
put('action.openCount', (plan.actions || []).filter(a => a.status !== 'done').length);
const debtPriority = F.debtPriority(plan, data.debts);
if (debtPriority.target) put('policy.nextDollarTarget', debtPriority.target.id);

/* ---- Credit: Forecast.creditAccounts, the same composition the page renders */
// The page formats these rows. This snapshot copies the incumbent fields a
// household member can act on: posted balance, pending, limit, utilisation
// headroom, rate, the next required payment, and HELOC capitalise / cash
// minimum. It does not subtract a limit from a balance and does not pick a
// due date of its own.
const accounts = F.creditAccounts(plan, data.debts, asOf, {
  extraFacilities: data.revolvingExtra,
});
put('credit.asOf', accounts.asOf);
for (const row of [...(accounts.secured || []), ...(accounts.cards || [])]) {
  const p = `credit.${row.id}`;
  put(`${p}.balance`, row.balance);
  // The account chip and the next payment's date chip the page renders.
  putField(`${p}.confidence`, row, 'confidence');
  put(`${p}.pendingUnknown`, row.pendingUnknown === true);
  put(`${p}.pending`, row.pending);
  put(`${p}.rate`, row.rate);
  if (row.shape !== 'secured-term') {
    put(`${p}.limit`, row.limit);
    put(`${p}.available`, row.available);
    put(`${p}.overLimit`, row.overLimit === true);
    if (row.overLimit) put(`${p}.overLimitBy`, row.overLimitBy);
  }
  if (row.shape === 'secured-term' && row.regularPayment != null) {
    put(`${p}.regularPayment`, row.regularPayment);
  }
  const next = row.nextPayment;
  put(`${p}.minimum`, next ? next.amount : null);
  put(`${p}.due`, next ? next.date : null);
  if (next && next.confidence) put(`${p}.minimumConfidence`, next.confidence);
  if (next && next.dateConfidence) put(`${p}.minimumDateConfidence`, next.dateConfidence);
  if (next && next.overdue) put(`${p}.minimumOverdueSince`, next.overdueSince);
  if (row.nextCapitalise) {
    put(`${p}.capitalise`, row.nextCapitalise.amount);
    put(`${p}.capitaliseDate`, row.nextCapitalise.date);
  }
  if (row.nextCashMinimum) {
    put(`${p}.cashMinimum`, row.nextCashMinimum.amount);
    put(`${p}.cashMinimumDue`, row.nextCashMinimum.date);
    if (row.nextCashMinimum.confidence) {
      put(`${p}.cashMinimumConfidence`, row.nextCashMinimum.confidence);
    }
    if (row.nextCashMinimum.overdue) put(`${p}.cashMinimumOverdueSince`, row.nextCashMinimum.overdueSince);
  } else if (row.interestTreatment === 'capitalised') {
    put(`${p}.cashMinimum`, null);
    put(`${p}.cashMinimumDue`, null);
  }
}

/* ---- Bills: Forecast.householdBills, the same roster the page renders */
// Amount, cadence, next date, monthly-equivalent and the page total are
// copied. The snapshot does not annualise a bill, does not smear a once
// due across a window, and does not invent a next date.
const billsView = F.householdBills(plan, asOf);
put('bills.asOf', billsView.asOf);
put('bills.monthlyEquivalentTotal', billsView.monthlyEquivalentTotal);
for (const row of billsView.bills || []) {
  const p = `bills.${row.id}`;
  put(`${p}.amount`, row.amount);
  put(`${p}.frequency`, row.frequency);
  put(`${p}.nextDate`, row.nextDate);
  put(`${p}.monthlyEquivalent`, row.monthlyEquivalent);
  putField(`${p}.confidence`, row, 'confidence');
}

/* ---- Subscriptions: Forecast.householdSubscriptions, the same roster the page renders */
// Amount, cadence, next date, monthly-equivalent and the page total are
// copied. The snapshot does not annualise a subscription, does not invent a
// merchant, and does not compute a second monthly-equivalent formula.
const subscriptionsView = F.householdSubscriptions(plan, asOf);
put('subscriptions.asOf', subscriptionsView.asOf);
put('subscriptions.monthlyEquivalentTotal', subscriptionsView.monthlyEquivalentTotal);
for (const row of subscriptionsView.subscriptions || []) {
  const p = `subscriptions.${row.id}`;
  put(`${p}.amount`, row.amount);
  put(`${p}.frequency`, row.frequency);
  put(`${p}.nextDate`, row.nextDate);
  put(`${p}.monthlyEquivalent`, row.monthlyEquivalent);
  putField(`${p}.confidence`, row, 'confidence');
}

/* ---- Planning: Forecast.majorPlans on the same recommend the pages use */
// Verdict, remaining, point/range, timing, flexibility, deferred, and any
// paydayAllocation set-aside / projection are copied. No midpoint, no second
// planner, no invented saved balance. When Forecast withholds the operating
// plan the page withholds verdicts; so does this snapshot.
if (advice.operatingPlanUnavailable === true) {
  put('planning.operatingPlan', 'unavailable');
} else {
  const knowledge = advice.knowledge || {};
  if (knowledge.end) put('planning.horizonEnd', knowledge.end);
  // Absent stays absent; a present value must be a finite number. A
  // nonfinite or non-numeric one is a collector failure, never filtered out.
  if (knowledge.encumbered != null) put('planning.encumbered', finite(knowledge.encumbered, 'planning.encumbered'));
  const alloc = advice.paydayAllocation || {};
  const paydayRows = [...(alloc.futureCosts || []), ...(alloc.optional || [])];
  const unresolvedIds = new Set((alloc.unresolved || []).map(r => r && r.id).filter(Boolean));
  for (const row of advice.majorPlans || []) {
    const p = `planning.${row.id}`;
    put(`${p}.verdict`, row.verdict);
    put(`${p}.remaining`, row.remaining);
    if (row.need != null) put(`${p}.need`, row.need);
    if (row.amountMin != null) put(`${p}.amountMin`, row.amountMin);
    if (row.amountMax != null) put(`${p}.amountMax`, row.amountMax);
    if (row.when) put(`${p}.when`, row.when);
    if (row.date) put(`${p}.date`, row.date);
    if (row.flexibility) put(`${p}.flexibility`, row.flexibility);
    put(`${p}.deferred`, row.deferred === true);
    const payday = paydayRows.find(item => item && item.id === row.id);
    if (payday && payday.projectedByDeadline != null) {
      put(`${p}.projectedByDeadline`, payday.projectedByDeadline);
    }
    if (payday) {
      put(`${p}.allocated`, term(payday.allocated, `${p}.allocated`));
    } else if (unresolvedIds.has(row.id)) {
      put(`${p}.allocated`, 'not-assigned');
    }
  }
}

/* ---- Planning trajectory: Forecast.baselineTrajectory — same opts as planning.js */
const trajectory = F.baselineTrajectory(plan, data.debts, asOf, {
  periods,
  extraFacilities: data.revolvingExtra,
});
put('planning.trajectory.status', trajectory.status);
if (trajectory.status === 'ready') {
  if (trajectory.asOf) put('planning.trajectory.asOf', trajectory.asOf);
  if (trajectory.horizon && trajectory.horizon.end) {
    put('planning.trajectory.horizonEnd', trajectory.horizon.end);
  }
  if (trajectory.weeklyVariable && trajectory.weeklyVariable.amount != null) {
    put('planning.trajectory.weeklyVariable', trajectory.weeklyVariable.amount);
  }
  if (trajectory.weeklyVariable && trajectory.weeklyVariable.source) {
    put('planning.trajectory.weeklyVariable.source', trajectory.weeklyVariable.source);
  }
  if (trajectory.normalSpending && trajectory.normalSpending.status) {
    put('planning.trajectory.normalSpending.status', trajectory.normalSpending.status);
  }
  const roadIdentity = trajectory.roadAheadSurplusDeficit || {};
  if (roadIdentity.identity) {
    put('planning.trajectory.roadAheadSurplusDeficit.identity', roadIdentity.identity);
  }
  if (roadIdentity.priorPeriodSurplus) {
    put('planning.trajectory.roadAheadSurplusDeficit.priorPeriodSurplus', roadIdentity.priorPeriodSurplus);
  }
  for (const month of trajectory.months || []) {
    if (!month || !month.month) continue;
    const p = `planning.trajectory.${month.month}`;
    const income = month.income || {};
    const cash = month.cash || {};
    const debt = month.debt || {};
    put(`${p}.income.status`, income.status);
    if (income.amount != null) put(`${p}.income.amount`, income.amount);
    if (income.reason) put(`${p}.income.reason`, income.reason);
    if (month.start) put(`${p}.periodStart`, month.start);
    if (month.end) put(`${p}.periodEnd`, month.end);
    put(`${p}.cash.status`, cash.status);
    if (cash.amount != null) put(`${p}.cash.amount`, cash.amount);
    if (cash.asOf) put(`${p}.cash.asOf`, cash.asOf);
    if (cash.reason) put(`${p}.cash.reason`, cash.reason);
    put(`${p}.debt.status`, debt.status);
    if (debt.consumer != null) put(`${p}.debt.consumer`, debt.consumer);
    if (debt.secured != null) put(`${p}.debt.secured`, debt.secured);
    if (debt.heloc != null) put(`${p}.debt.heloc`, debt.heloc);
    if (debt.asOf) put(`${p}.debt.asOf`, debt.asOf);
    if (debt.reason) put(`${p}.debt.reason`, debt.reason);
  }
} else if (trajectory.reason) {
  put('planning.trajectory.reason', trajectory.reason);
}

putPayPeriods(put, putField, advice);
putSavingsPublication(put, putField, advice, selectPublications(advice, asOf));

return out;
}

/* ---- Budget pay periods: Forecast.recommend payPeriodViews, every period the page can select */
// Copied as published, with each figure's trust tag beside it. Nothing is
// summed, netted or re-dated here. A period is keyed by its start date and a
// bill row by its id and date, so a period or row that appears, disappears or
// moves shows up as a changed key.
const PERIOD_FIELDS = ['role', 'timelineRole', 'end', 'opening', 'openingTrust', 'openingSource', 'openingBasis',
  'incomeTotal', 'incomeTrust', 'periodBillLoad', 'periodBillLoadTrust', 'paidBills', 'remainingBills', 'afterBills',
  'afterBillsTrust', 'budgetHold', 'budgetHoldTrust', 'balanceAfterDeductions', 'balanceAfterDeductionsTrust',
  'predictedEndingBalance', 'predictedEndingBalanceIdentity', 'paydaySweep', 'paydaySweepTrust', 'plannedPeriodClose',
  'plannedPeriodCloseTrust', 'plannedPeriodCloseReason', 'operatingPlanUnavailable'];
const PERIOD_BILL_FIELDS = ['amount', 'status', 'settlement', 'confidence', 'dateConfidence', 'displayAmountBasis',
  'displayAmountTrust', 'cardPaid'];

// One key per identity; a repeated identity gets an ordinal instead of
// silently overwriting the first.
function uniqueKey(used, key) {
  let candidate = key;
  for (let n = 2; used.has(candidate); n++) candidate = key + '#' + n;
  used.add(candidate);
  return candidate;
}

function putPayPeriods(put, putField, advice) {
  const views = Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : [];
  const periodKeys = new Set();
  for (const view of views) {
    if (!view || typeof view.start !== 'string' || !view.start) throw new Error('pay period without a start date');
    const p = uniqueKey(periodKeys, 'period.' + segment(view.start));
    for (const field of PERIOD_FIELDS) putField(p + '.' + field, view, field);
    const billKeys = new Set();
    for (const bill of Array.isArray(view.bills) ? view.bills : []) {
      const b = uniqueKey(billKeys, p + '.bill.' + segment(bill && bill.id) + '@' + segment(bill && bill.date));
      for (const field of PERIOD_BILL_FIELDS) putField(b + '.' + field, bill, field);
    }
  }
  // "Expected Bills balance at period end": the active period's publication.
  const atEnd = advice.defaultView && advice.defaultView.billsAccountPeriodBalance;
  if (atEnd) {
    for (const field of ['amount', 'status', 'trust', 'end']) putField('period.billsAtEnd.' + field, atEnd, field);
  }
}

/* ---- Savings: Forecast.savingsFundingPublication, the selector the Budget and Savings pages call */
// For each period the page can select: whether the selector published or
// withheld the packet, the projected Savings close with its nature and trust,
// and the Budget savings card and evidence-sheet figures read from that
// packet: the period's funding lines (Unsent top-up today, surplus,
// entitlement, proved transfers, remaining entitlement, unassigned capacity),
// each goal row's Saved / Needed (point or range endpoints, with the trust the
// page falls back to) / This period / Still to fund / Paid facts and their
// as-of gate, each grouped member's Saved / Needed / This period, and the
// published member allocations. The itemized map does NOT cover every packet
// path the page reads (for example the sheet's reported and observed stock,
// pool lines, Costs ahead lenses and the funding schedule, all read from this
// packet); the typed publication evidence below covers the whole packet, and
// the consumer inventory (test/fixtures/savings-consumer-manifest/manifest.json) names
// each path and its capture. The row and member
// rosters follow the page's own selection (budgetDailySavingsRows and
// budgetSavingsRowMembers in public/plan.js). Copied, never recomputed.
const CLOSE_FIELDS = ['status', 'nature', 'trust', 'stock', 'operatingCash', 'contribution', 'projectedContributions',
  'projectedDraws', 'projectedDeficitCoverage', 'unallocated', 'balanceAsOf', 'verifiedReason', 'reason'];
const CLOSE_ROW_FIELDS = ['forecastSaved', 'forecastContribution', 'needed', 'neededTrust', 'trust', 'stillToFund',
  'stillToFundTrust'];
const CLOSE_ITEM_FIELDS = ['forecastSaved', 'forecastTrust', 'needed', 'neededTrust', 'trust', 'stillToFund',
  'stillToFundTrust'];
const PLANNED_ROW_FIELDS = ['needed', 'neededTrust', 'trust', 'stillToFund', 'stillToFundTrust'];
const PLANNED_ITEM_FIELDS = ['needed', 'neededTrust', 'trust', 'stillToFund', 'stillToFundTrust'];
const CURRENT_ROW_FIELDS = ['saved', 'savedTrust', 'needed', 'neededTrust', 'trust', 'thisPeriod', 'thisPeriodTrust',
  'remainingThisPeriod', 'stillToFund', 'stillToFundTrust'];
const CURRENT_ITEM_FIELDS = ['saved', 'trust', 'needed', 'neededTrust', 'stillToFund', 'stillToFundTrust'];
const COST_FACTS = ['originalCost', 'confirmedLinkedPaid', 'unpaidCost'];
// What the evidence sheet prints for a packet that is not projected
// (budgetDailySavingsHtml): Unsent top-up today, Period balance before
// proposals, Funding entitlement, Proved transfers, Remaining entitlement and
// Unassigned capacity, all under the period's trust.
const PERIOD_FUNDING_FIELDS = ['proposal', 'nativePeriodSurplus', 'entitlement', 'transferred', 'remainingEntitlement',
  'unassigned', 'trust'];

// A structured sub-figure the page renders. Absent stays absent (no key); an
// explicit null is captured as null, because the page can tell them apart
// (SavingsInventory.commitmentCostHtml prints a point cost only when
// `range === null`); a plain object returns for its members to be copied;
// anything else is corrupt, never silently skipped.
function subFigure(put, key, holder, field) {
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, field) || holder[field] === undefined) return null;
  const value = holder[field];
  if (value === null) { put(key, null); return null; }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed snapshot value: ' + key);
  return value;
}

// What a row or member renders beyond its scalar fields: the Needed range
// endpoints (budgetDailyNeededHtml) and the Paid / original / unpaid cost
// facts (budgetGoalPaidProgressHtml, SavingsInventory.commitmentCostHtml).
function putFigureParts(put, putField, prefix, row) {
  const range = subFigure(put, prefix + '.neededRange', row, 'neededRange');
  if (range) {
    putField(prefix + '.neededRange.min', range, 'min');
    putField(prefix + '.neededRange.max', range, 'max');
  }
  const cost = subFigure(put, prefix + '.cost', row, 'commitmentCost');
  if (!cost) return;
  // The cost facts print only under a valid as-of date, so the date is a gate.
  putField(prefix + '.cost.asOf', cost, 'asOf');
  for (const name of COST_FACTS) {
    const fact = subFigure(put, prefix + '.cost.' + name, cost, name);
    if (!fact) continue;
    putField(prefix + '.cost.' + name + '.status', fact, 'status');
    putField(prefix + '.cost.' + name + '.amount', fact, 'amount');
    const factRange = subFigure(put, prefix + '.cost.' + name + '.range', fact, 'range');
    if (factRange) {
      putField(prefix + '.cost.' + name + '.range.min', factRange, 'min');
      putField(prefix + '.cost.' + name + '.range.max', factRange, 'max');
    }
  }
}

function putRows(put, putField, prefix, rows, fields, identity = 'key') {
  const used = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = uniqueKey(used, prefix + segment(row && row[identity]));
    for (const field of fields) putField(r + '.' + field, row, field);
    if (!row) continue;
    putFigureParts(put, putField, r, row);
    if (Array.isArray(row.members)) put(r + '.members', row.members.map(String).join(','));
  }
}

// The member distribution: one amount per published allocation identity,
// exactly the entries budgetSavingsRowMembers joins to a member.
function putAllocations(put, prefix, allocations) {
  const used = new Set();
  for (const part of Array.isArray(allocations) ? allocations : []) {
    const a = uniqueKey(used, prefix + segment(part && part.id));
    put(a + '.amount', part ? part.amount : undefined);
  }
}

/* ---- Savings publication evidence: typed canonical capture (Atlas 6549108431 §1B) */
// The safety net beside the itemized map above. For every invocation of
// Forecast.savingsFundingPublication the Budget page makes (one per selectable
// pay period, in roster order), the selected result is encoded BEFORE any
// rounding, truthiness filtering, projection or JSON serialization, and its
// SHA-256 is stored as compared Savings evidence. The encoding keeps scalar
// type and value, absent versus own-undefined versus null, empty versus
// populated objects and arrays, key presence and order, and array length and
// order. It rejects what it cannot represent faithfully instead of
// normalizing it. A digest is a change detector under SHA-256's collision
// resistance, not an explanation: the per-part digests below locate a change
// within the packet, and the itemized map explains the figures it covers.
const PUBLICATION_ENCODING = 'atlas-savings-publication/v1';
// Whether proto is some realm's intrinsic Object.prototype or Array.prototype.
const isIntrinsicProto = (proto, name) => {
  if (proto === Object.prototype) return name === 'Object';
  if (proto === Array.prototype) return name === 'Array';
  if (!proto || typeof proto !== 'object') return false;
  const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  const fn = ctor && ctor.value;
  if (typeof fn !== 'function' || fn.name !== name || fn.prototype !== proto) return false;
  if (!/\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn))) return false;
  const parent = Object.getPrototypeOf(proto);
  return name === 'Object' ? parent === null : isIntrinsicProto(parent, 'Object');
};
const PUBLICATION_LIMITS = Object.freeze({ depth: 48, nodes: 1000000, string: 65536, bytes: 16 * 1024 * 1024 });

function encodePublication(value, label) {
  const fail = why => { throw new Error('unencodable savings publication (' + why + '): ' + label); };
  const ancestors = new Set();
  let nodes = 0, bytes = 0;
  const emit = text => {
    bytes += text.length;
    if (bytes > PUBLICATION_LIMITS.bytes) fail('size limit');
    return text;
  };
  // Every assembled array or object, keys and punctuation included, is held
  // to the byte limit; a nested string is contained in its parent's, so the
  // complete encoding is bounded, not only its scalar tokens.
  const bounded = text => {
    if (text.length > PUBLICATION_LIMITS.bytes) fail('size limit');
    return text;
  };
  const walk = (v, depth) => {
    if (++nodes > PUBLICATION_LIMITS.nodes) fail('node limit');
    if (depth > PUBLICATION_LIMITS.depth) fail('depth limit');
    if (v === null) return emit('n');
    if (v === undefined) return emit('u');
    switch (typeof v) {
      case 'boolean': return emit(v ? 'b1' : 'b0');
      case 'number':
        if (!Number.isFinite(v)) fail('nonfinite number');
        return emit(Object.is(v, -0) ? 'd-0' : 'd' + String(v));
      case 'string':
        if (v.length > PUBLICATION_LIMITS.string) fail('string limit');
        return emit('s' + JSON.stringify(v));
      case 'object': break;
      default: fail('unsupported ' + typeof v);
    }
    if (ancestors.has(v)) fail('cycle');
    // A Proxy runs traps on every read; it is not inert published data.
    if (require('util').types.isProxy(v)) fail('proxy');
    const isArray = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    // A plain object or array may come from another realm: the page capture
    // runs the pages in a vm, and the page parses its own copy of the input,
    // so Forecast can pass through objects whose intrinsic prototype is the
    // vm's. Anything else (Date, Map, class instances, subclasses) is refused.
    if (isArray ? !isIntrinsicProto(proto, 'Array') : proto !== null && !isIntrinsicProto(proto, 'Object')) fail('unsupported prototype');
    const keys = Reflect.ownKeys(v);
    if (isArray && keys.some(k => typeof k === 'symbol')) fail('symbol key on array');
    ancestors.add(v);
    let out;
    if (isArray) {
      if (keys.length !== v.length + 1) fail('sparse or extra-property array');
      const parts = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d)) fail(d ? 'accessor' : 'sparse array');
        parts.push(walk(d.value, depth + 1));
      }
      out = bounded('[' + parts.join(',') + ']');
    } else {
      const parts = [], symbols = new Set();
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!('value' in d)) fail('accessor');
        if (typeof k === 'symbol') {
          // Forecast keeps module-private, non-enumerable symbol-keyed scalars
          // (forecast.js savingsReportedCents). No page consumer can read
          // them, but they are kept, by description, rather than dropped.
          const name = k.description;
          if (typeof name !== 'string' || !name || symbols.has(name)) fail('ambiguous symbol key');
          if (name.length > PUBLICATION_LIMITS.string) fail('string limit');
          symbols.add(name);
          parts.push('@' + JSON.stringify(name) + ':' + walk(d.value, depth + 1));
          continue;
        }
        if (!d.enumerable) fail('non-enumerable property');
        if (k.length > PUBLICATION_LIMITS.string) fail('string limit');
        parts.push(JSON.stringify(k) + ':' + walk(d.value, depth + 1));
      }
      // A null-prototype object is kept distinct from a plain one.
      out = bounded((proto === null ? 'O{' : '{') + parts.join(',') + '}');
    }
    ancestors.delete(v);
    return out;
  };
  return walk(value, 0);
}

// The itemized map's publications: one selector call per selectable period
// with the Budget page's default options. These feed the itemized Savings
// fields only. The compared Savings evidence is the observed page capture
// (putCaptureEvidence below), never this roster.
function selectPublications(advice, asOf) {
  const has = Object.prototype.hasOwnProperty.call(advice, 'savingsFunding') && advice.savingsFunding !== undefined;
  const funding = has ? advice.savingsFunding : undefined;
  const views = funding && Array.isArray(advice.payPeriodViews) ? advice.payPeriodViews : [];
  return views.map(view => ({ view, packet: F.savingsFundingPublication(funding, { asOf, advice, periodId: view.id }) }));
}

/* ---- Savings capture evidence (G1 v3: Atlas 6550418629, Muse 6550491885) */
// The compared Savings evidence is what the real pages actually did:
// scripts/figures-page-capture.js runs the registered entries on this input
// over the page state matrix and observes every selector call. Keys:
//   savings.capture.version          capture and encoding versions
//   savings.capture.states / .state.<i>  page|state|calls|error|unfinished|load errors
//   savings.capture.count  / .o<n>   page|state|route|source|context|result|error, in call order
//   savings.capture.results / .r<k>.{digest,keys,part.<j>}  each distinct encoded result
// Results are shared by exact encoding equality only; part identities are
// positional (keys lists the names), so no two parts can collide.
const CAPTURE_EVIDENCE = 'atlas-savings-page-capture/v4+' + PUBLICATION_ENCODING;
// v2 evidence (Atlas 6552087494 items 2-3). Each observation line is
// page|state|route|source|context|ref|type|error, where type is the result's
// kind and ref is r<k>, 'null' or 'none' accordingly. Each distinct result
// r<k> carries a shape (object, null-object, array or scalar), its manifest
// (keys: the own keys of an object, the indexes of an array, absent for a
// scalar), one digest per part (each key's or element's full encoding, or
// the scalar's encoding), and a digest computed FROM the shape, manifest and
// parts, so a validator recomputes it: a deleted, replaced or reordered part
// or manifest is detected, and a legitimate empty object or array is valid
// with no parts.
const resultKind = v => (v === null ? 'null' : v === undefined ? 'undefined' : Array.isArray(v) ? 'array' : typeof v);
// v3 identity subparts (design 6554987596 §3, 6555018088 §1, §3). The
// result's own period is classified POSITIVELY by its exact own key list (in
// producer order) and its constant values; anything else is unsupported,
// which the validators read as UNKNOWN (INCOMPLETE). The class, a digest of
// the period's own key list and digests of period.kind/start/end/status are
// recorded; the validators hold the expected key-list digests as constants.
// periodOrigin (the class) is capture-written evidence, not an authenticated
// origin: the reconstruction test proves its fidelity.
const PERIOD_CLASS_KEYS = Object.freeze({
  'v1-ready': ['status', 'basis', 'start', 'end', 'entitlement', 'transferred', 'nativePeriodSurplus', 'alreadySavedIncome',
    'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'projectedRemainingCapacity', 'currentCash', 'futureIncome',
    'cashCapacity', 'trust', 'cashThrough', 'incomeAuthorityThrough', 'completeness', 'allocations', 'cycleAllocations',
    'actualSaved', 'originalPaydayPlan'],
  'v1-ready-withheld': null, // v1-ready's keys plus reason (public/forecast.js:14940)
  'v1-unknown': ['status', 'reason', 'entitlement', 'transferred', 'remainingEntitlement', 'availableNow', 'proposal', 'unassigned', 'actualSaved'],
  'v2-packet': ['status', 'kind', 'basis', 'start', 'end', 'trust', 'proposal', 'actualSaved', 'allocations', 'cycleAllocations', 'reason'],
});
const PERIOD_BASIS = 'operating-surplus-before-proposals';
function periodClass(period) {
  const keys = Object.keys(period);
  const is = list => list.length === keys.length && list.every((k, i) => k === keys[i]);
  const ready = PERIOD_CLASS_KEYS['v1-ready'];
  if (is(ready) && period.status === 'ready' && period.basis === PERIOD_BASIS && period.completeness === 'bounded') return 'v1-ready';
  if (is([...ready, 'reason']) && period.status === 'unavailable' && period.basis === PERIOD_BASIS && period.completeness === 'bounded'
    && period.proposal === null && period.availableNow === null && period.actualSaved === null) return 'v1-ready-withheld';
  if (is(PERIOD_CLASS_KEYS['v1-unknown']) && period.status === 'unavailable'
    && keys.every(k => k === 'status' || k === 'reason' || period[k] === null)) return 'v1-unknown';
  if (is(PERIOD_CLASS_KEYS['v2-packet']) && period.basis === PERIOD_BASIS && ['historical', 'projected'].includes(period.kind)) return 'v2-packet';
  return 'unsupported';
}
function captureIdentity(result, where) {
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');
  const d = Object.getOwnPropertyDescriptor(result, 'period');
  const period = d && 'value' in d && d.enumerable ? d.value : undefined;
  if (!period || typeof period !== 'object' || Array.isArray(period) || Object.getPrototypeOf(period) === null
    || !isIntrinsicProto(Object.getPrototypeOf(period), 'Object')) return ['unsupported', 'absent', 'absent', 'absent', 'absent', 'absent'].join('|');
  const sub = key => {
    const pd = Object.getOwnPropertyDescriptor(period, key);
    return pd && 'value' in pd ? sha(encodePublication(pd.value, where + '.period.' + key)) : 'absent';
  };
  return [periodClass(period), sha(JSON.stringify(Object.keys(period))), sub('kind'), sub('start'), sub('end'), sub('status')].join('|');
}
function captureResultParts(result, where) {
  const sha = text => crypto.createHash('sha256').update(text).digest('hex');
  let shape, names = null, parts;
  // A top-level symbol key is refused before enumeration, so Object.keys can
  // never erase it (design 6554987596 §7). Nested symbols stay encoded by
  // description inside their part.
  if (result && typeof result === 'object' && Object.getOwnPropertySymbols(result).length > 0) {
    throw new Error('unencodable savings publication (top-level symbol key): ' + where);
  }
  if (Array.isArray(result)) {
    shape = 'array'; names = result.map((_, j) => String(j));
    parts = result.map((v, j) => sha(encodePublication(v, where + '[' + j + ']')));
  } else if (result && typeof result === 'object') {
    shape = Object.getPrototypeOf(result) === null ? 'null-object' : 'object';
    names = Object.keys(result);
    parts = names.map(key => sha(encodePublication(result[key], where + '.' + key)));
  } else {
    shape = 'scalar'; parts = [sha(encodePublication(result, where))];
  }
  const keys = names ? JSON.stringify(names) : '';
  const identity = shape === 'object' || shape === 'null-object' ? captureIdentity(result, where) : undefined;
  return { shape, keys: names ? keys : undefined, parts, identity, digest: sha(shape + '\n' + keys + '\n' + parts.join('\n')) };
}
// One anchor value as recorded: a verdict word, or a digest of a view date.
const ANCHOR_VERDICTS = ['object', 'null', 'error', 'none', 'n/a'];
function anchorWord(value, where) {
  if (!ANCHOR_VERDICTS.includes(value)) throw new Error('capture anchor: unexpected verdict at ' + where);
  return value;
}
const anchorText = (value, where) => {
  if (typeof value !== 'string' || !value || /[|\n]/.test(value)) throw new Error('capture anchor: unsupported identifier at ' + where);
  return value;
};
function putCaptureEvidence(out, prefix, capture) {
  const set = (key, value) => { out[prefix + 'savings.capture.' + key] = value; };
  set('version', CAPTURE_EVIDENCE);
  const states = capture.runs.flatMap(run => run.states.map(state => [run.page, state.id,
    'calls=' + state.calls, 'error=' + (state.error ? 'yes' : ''), 'unfinished=' + state.unfinished,
    'load=' + run.loadErrors.length].join('|')));
  set('states', states.length);
  states.forEach((line, i) => set('state.' + i, line));
  const results = new Map();
  set('count', capture.observations.length);
  capture.observations.forEach((o, n) => {
    const type = resultKind(o.result);
    let ref = type === 'null' ? 'null' : type === 'undefined' ? 'none' : null;
    if (ref === null) {
      // The whole-result encoding first: it refuses what it cannot represent
      // (a Proxy, a foreign prototype, a non-enumerable, symbol-keyed or
      // accessor property), as v1 did (pre-review 6553590628 S-2).
      encodePublication(o.result, 'capture o' + n);
      const r = captureResultParts(o.result, 'capture o' + n);
      if (!results.has(r.digest)) {
        const k = 'r' + results.size;
        results.set(r.digest, k);
        set(k + '.shape', r.shape);
        if (r.keys !== undefined) set(k + '.keys', r.keys);
        r.parts.forEach((part, j) => set(k + '.part.' + j, part));
        set(k + '.digest', r.digest);
        if (r.identity !== undefined) set(k + '.identity', r.identity);
      }
      ref = results.get(r.digest);
    }
    set('o' + n, [o.page, o.state, o.route, o.source, o.context, ref, type, o.error ? 'error' : ''].join('|'));
  });
  set('results', results.size);
  // The per-advice anchors (design 6554987596 §1, 6555018088 §2,
  // 6555036724): one line per advice and one per pay-period view, with view
  // dates as publication-encoding digests, never plaintext.
  const digestOf = (value, where) => crypto.createHash('sha256').update(encodePublication(value, where)).digest('hex');
  // Same-execution gate facts per Budget state (adopted table r4.1 §1-§2):
  // fixed vocabulary only (y/n/u, - or none, pub/fallback/other).
  const gates = Array.isArray(capture.gates) ? capture.gates : [];
  set('gates', gates.length);
  gates.forEach((g, i) => {
    const where = 'capture gate ' + i;
    const word = v => { if (typeof v !== 'string' || !/^[a-z-]{1,8}$/.test(v)) throw new Error('capture gate: unexpected value at ' + where); return v; };
    set('gate.' + i, [anchorText(g.page, where), anchorText(g.state, where), word(g.calendar), word(g.dailyAsOf), word(g.inventory),
      word(g.month), word(g.monthPayday), word(g.monthId), word(g.drilldown)].join('|'));
  });
  const advices = Array.isArray(capture.advices) ? capture.advices : [];
  set('advices', advices.length);
  advices.forEach((a, i) => {
    const where = 'capture advice ' + i;
    set('advice.' + i, [anchorText(a.label, where), anchorText(a.page, where), anchorText(a.state, where),
      anchorText(a.funding, where), a.current == null ? 'none' : anchorText(a.current, where), String(a.views.length),
      anchorWord(a.top, where), anchorWord(a.topNull, where), anchorWord(a.topPlan, where)].join('|'));
    a.views.forEach((v, j) => {
      const at = where + ' view ' + j;
      set('advice.' + i + '.view.' + j, [anchorText(v.id, at), anchorText(v.role, at), digestOf(v.start, at + ' start'),
        digestOf(v.end, at + ' end'), anchorWord(v.byId, at), anchorWord(v.byView, at), anchorWord(v.rawPacket, at)].join('|'));
    });
  });
}

function putSavingsPublication(put, putField, advice, publications) {
  if (!Object.prototype.hasOwnProperty.call(advice, 'savingsFunding') || advice.savingsFunding === undefined) return;
  const funding = advice.savingsFunding;
  put('savings.funding.status', funding && typeof funding.status === 'string' ? funding.status : null);
  if (!funding) return;
  const periodKeys = new Set();
  for (const { view, packet } of publications) {
    const current = view.timelineRole === 'current';
    const p = uniqueKey(periodKeys, current ? 'savings.current' : 'savings.period.' + segment(view.start));
    put(p + '.publication', packet ? 'published' : 'withheld');
    if (!packet) continue;
    putField(p + '.status', packet, 'status');
    const kind = packet.period && packet.period.kind;
    const close = kind === 'projected' ? packet.forecastClosing : null;
    if (kind !== 'projected') {
      for (const field of PERIOD_FUNDING_FIELDS) putField(p + '.' + field, packet.period, field);
    }
    if (close) {
      for (const field of CLOSE_FIELDS) putField(p + '.close.' + field, close, field);
      if (close.gap) {
        putField(p + '.close.gapShortBy', close.gap, 'shortBy');
        putField(p + '.close.gapDate', close.gap, 'date');
        putField(p + '.close.gapTrust', close.gap, 'trust');
      }
      putRows(put, putField, p + '.close.row.', close.rows, CLOSE_ROW_FIELDS);
      putRows(put, putField, p + '.close.item.', close.items, CLOSE_ITEM_FIELDS);
      putAllocations(put, p + '.close.allocation.', close.allocations);
    }
    if (kind === 'projected' && packet.plannedRequirements) {
      putRows(put, putField, p + '.planned.row.', packet.plannedRequirements.rows, PLANNED_ROW_FIELDS);
      putRows(put, putField, p + '.planned.item.', packet.plannedRequirements.items, PLANNED_ITEM_FIELDS);
    }
    // Every other packet renders its own rows (budgetDailySavingsRows): the
    // current period, a historical period, and a projected period that
    // publishes no close. Members join backing and unresolved items and the
    // period's cycle allocations; a historical packet withholds member
    // figures on the page, so none are captured for it.
    if (!close) {
      putRows(put, putField, p + '.row.', packet.rows, CURRENT_ROW_FIELDS);
      if (kind !== 'historical' && !(kind === 'projected' && packet.plannedRequirements)) {
        const members = [...((packet.backing && packet.backing.items) || []), ...(packet.unresolved || [])];
        putRows(put, putField, p + '.item.', members, CURRENT_ITEM_FIELDS);
        putAllocations(put, p + '.allocation.', packet.period && packet.period.cycleAllocations);
      }
    }
  }
}

/* ---- inputs ----------------------------------------------------------------- */
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (object, keys) => JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Key-sorted JSON, so a digest names content rather than file formatting.
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol'
    || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('uncanonical input value');
  return JSON.stringify(value);
}

function loadCanonicalInputs(root = ROOT) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));
  const periodsFile = path.join(root, 'public', 'periods.json');
  // An absent periods payload is a real served state; a malformed one is not.
  const periods = fs.existsSync(periodsFile) ? JSON.parse(fs.readFileSync(periodsFile, 'utf8')) : null;
  return { data, periods };
}

// An invented input is frozen served data plus its own periods payload. The
// schema is closed: unknown keys, a file name that is not the id, a missing
// `invented: true`, description or origin, or an input outside the parity
// subset is refused, never skipped.
function validateInventedInput(doc, file) {
  const fail = why => { throw new Error('invalid figures input ' + file + ': ' + why); };
  if (!isPlainObject(doc) || !sameKeys(doc, INPUT_KEYS)) fail('keys');
  if (doc.schema !== INPUT_SCHEMA) fail('schema');
  if (typeof doc.id !== 'string' || !INPUT_ID.test(doc.id) || doc.id + '.json' !== file) fail('id');
  if (doc.invented !== true) fail('invented');
  if (typeof doc.description !== 'string' || !doc.description.trim()) fail('description');
  const origin = doc.origin;
  if (!isPlainObject(origin) || !sameKeys(origin, ORIGIN_KEYS) || !ORIGIN_KINDS.includes(origin.kind)
    || typeof origin.source !== 'string' || !origin.source.trim()
    || typeof origin.transform !== 'string' || !origin.transform.trim()) fail('origin');
  if (!Array.isArray(doc.limitations) || new Set(doc.limitations).size !== doc.limitations.length
    || doc.limitations.some(item => !LIMITATIONS.includes(item))) fail('limitations');
  if (!(doc.periods === null || isPlainObject(doc.periods))) fail('periods');
  if ((doc.periods === null) !== doc.limitations.includes('absent-periods')) fail('absent-periods limitation');
  const data = doc.data;
  if (!isPlainObject(data) || !isPlainObject(data.meta) || typeof data.meta.asOf !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.meta.asOf) || !isPlainObject(data.plan) || !isPlainObject(data.plan.defaults)
    || !Array.isArray(data.debts) || !Array.isArray(data.revolvingExtra)) fail('data');
  const excluded = parityExclusions(data);
  if (excluded.length) fail('outside the engine-input parity subset (' + excluded.join(', ') + ')');
  return doc;
}

function loadInventedInputs(dir = INPUT_DIR) {
  return fs.readdirSync(dir).sort().map(file => {
    const full = path.join(dir, file);
    if (!file.endsWith('.json') || !fs.statSync(full).isFile()) throw new Error('unexpected entry in figures inputs: ' + file);
    const doc = validateInventedInput(JSON.parse(fs.readFileSync(full, 'utf8')), file);
    return { id: doc.id, doc, digest: sha256(canonicalJson(doc)) };
  });
}

// The instrument's own identity: a moved field on an unedited input can come
// from the engine or from this collector, and the summary keeps them apart.
function collectorDigest() {
  return sha256(['figures-snapshot.js', 'figures-comment.js', 'figures-page-capture.js']
    .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n')).join('\0'));
}

function buildCheckSnapshot(canonicalInputs, inputs) {
  const { CHECK_SCHEMA, FIELD_CLASSES, snapshotObserves } = require('./figures-comment');
  const excluded = parityExclusions(canonicalInputs.data);
  if (excluded.length) {
    throw new Error('the household dated opening is outside the engine-input parity subset (' + excluded.join(', ') + ')');
  }
  const out = {
    'check.schema': CHECK_SCHEMA,
    'check.collector.sha256': collectorDigest(),
    'check.household.input.sha256': sha256(canonicalJson({ data: canonicalInputs.data, periods: canonicalInputs.periods })),
  };
  const household = buildFiguresSnapshot(canonicalInputs.data, canonicalInputs.periods);
  for (const [key, value] of Object.entries(household)) {
    if (/^(check|coverage|fixture)\./.test(key)) throw new Error('reserved household snapshot key: ' + key);
    if (value !== undefined) out[key] = value;
  }
  putCaptureEvidence(out, '', captureFor(canonicalInputs.data, canonicalInputs.periods));
  const invented = [];
  for (const input of inputs) {
    const snapshot = buildFiguresSnapshot(input.doc.data, input.doc.periods);
    const prefix = 'fixture.' + input.id + '.';
    out[prefix + 'input.sha256'] = input.digest;
    for (const [key, value] of Object.entries(snapshot)) {
      if (key.startsWith('input.')) throw new Error('reserved input snapshot key: ' + key);
      if (value !== undefined) out[prefix + key] = value;
    }
    putCaptureEvidence(out, prefix, captureFor(input.doc.data, input.doc.periods));
    invented.push(snapshot);
  }
  for (const cls of FIELD_CLASSES) {
    out['coverage.' + cls.id + '.household'] = snapshotObserves(household, cls) ? 1 : 0;
    out['coverage.' + cls.id + '.invented'] = invented.filter(snapshot => snapshotObserves(snapshot, cls)).length;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const householdOnly = argv.length === 1 && argv[0] === '--household-only';
  const coverage = argv.length === 1 && argv[0] === '--coverage';
  if (argv.length && !householdOnly && !coverage) {
    process.stderr.write('usage: node scripts/figures-snapshot.js [--household-only | --coverage]\n');
    process.exitCode = 1;
    return;
  }
  const canonicalInputs = loadCanonicalInputs();
  if (householdOnly) {
    process.stdout.write(JSON.stringify(buildFiguresSnapshot(canonicalInputs.data, canonicalInputs.periods), null, 2) + '\n');
    return;
  }
  const snapshot = buildCheckSnapshot(canonicalInputs, loadInventedInputs());
  if (coverage) {
    // Local only: class names with household 0/1 and invented-input counts.
    const { FIELD_CLASSES } = require('./figures-comment');
    for (const cls of FIELD_CLASSES) {
      process.stdout.write([cls.id, cls.family, snapshot['coverage.' + cls.id + '.household'],
        snapshot['coverage.' + cls.id + '.invented']].join('\t') + '\n');
    }
    return;
  }
  process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  buildFiguresSnapshot,
  buildCheckSnapshot,
  loadCanonicalInputs,
  loadInventedInputs,
  validateInventedInput,
  pageOptions,
  parityExclusions,
  canonicalJson,
  encodePublication,
  PUBLICATION_ENCODING,
  // One input's capture evidence (unprefixed keys), for tests.
  __putCaptureEvidence: putCaptureEvidence,
  PERIOD_CLASS_KEYS,
  captureEvidence: (data, periods) => { const out = {}; putCaptureEvidence(out, '', captureFor(data, periods)); return out; },
  CAPTURE_EVIDENCE,
  INPUT_DIR,
  INPUT_SCHEMA,
  main,
};
