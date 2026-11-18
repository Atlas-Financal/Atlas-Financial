'use strict';
/* Refresh-loop operating answer projector.
 *
 * After a trusted live overlay or an approved canonical refresh, this
 * module asks Forecast.recommend for the household operating answer and
 * copies those fields. It does not recalculate their financial meaning,
 * does not invent remaining-claim precision, and is not a second planner.
 *
 *   money available            ← Forecast.paydayAllocation.available
 *   protected obligations      ← Forecast.paydayAllocation.obligations
 *   current spending permission← Forecast.recommend.weekly /
 *                                Forecast.currentPeriodAction
 *   future-cost protection     ← Forecast.paydayAllocation.futureCosts /
 *                                protectedPath
 *   extra-debt allocation      ← Forecast.paydayAllocation.extraDebt
 *   freshness / trust limits   ← Forecast.currentPeriodAction.remainingClaim,
 *                                coverage, paydayAllocation.risks
 *
 * Live-overlay mode may pass sanitized overlay currentPeriodActuals into
 * Forecast only when the overlay applied. Canonical mode never does.
 * A fail-closed overlay keeps the dated opening and, when the observation
 * date is later, tells Forecast the current operating plan is unavailable.
 * Current/actionable fields (money available, spending permission, extra-debt)
 * are then withheld rather than copied from that stale opening. Zero/no-change
 * is valid when the dated opening is still the current plan.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const Forecast = require('../public/forecast.js');
const StageTiming = require('./refresh-stage-timing.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA = 'atlas-refresh-operating-answer/v1';
const PERIODS = path.join(ROOT, 'public', 'periods.json');

const COMPARE_FIELDS = Object.freeze([
  ['asOf', 'asOf'],
  ['moneyAvailable', 'moneyAvailable.value'],
  ['protectedObligations.wanted', 'protectedObligations.wanted'],
  ['protectedObligations.allocated', 'protectedObligations.allocated'],
  ['protectedObligations.shortfall', 'protectedObligations.shortfall'],
  ['currentSpendingPermission.weekly', 'currentSpendingPermission.weekly'],
  ['currentSpendingPermission.weeklyCap', 'currentSpendingPermission.weeklyCap'],
  ['currentSpendingPermission.spendPermission', 'currentSpendingPermission.spendPermission'],
  ['currentSpendingPermission.remainingClaim', 'currentSpendingPermission.remainingClaim'],
  ['currentSpendingPermission.mode', 'currentSpendingPermission.mode'],
  ['futureCostProtection.protectedPath.wanted', 'futureCostProtection.protectedPath.wanted'],
  ['futureCostProtection.protectedPath.allocated', 'futureCostProtection.protectedPath.allocated'],
  ['extraDebtAllocation.allocated', 'extraDebtAllocation.allocated'],
  ['extraDebtAllocation.status', 'extraDebtAllocation.status'],
  ['extraDebtAllocation.target', 'extraDebtAllocation.target.id'],
  ['limitations.remainingClaim', 'limitations.remainingClaim'],
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPeriods() {
  if (!fs.existsSync(PERIODS)) return null;
  return JSON.parse(fs.readFileSync(PERIODS, 'utf8'));
}

function overlayOf(data) {
  return data && data.liveOverlay ? data.liveOverlay : null;
}

function overlayApplied(data, opts) {
  if (opts && opts.mode === 'canonical') return false;
  const overlay = overlayOf(data);
  return !!(overlay && overlay.applied === true);
}

function asOfFrom(data, opts) {
  const plan = data && data.plan;
  const overlay = overlayOf(data);
  if (overlayApplied(data, opts) && overlay.effectiveAsOf) return overlay.effectiveAsOf;
  return (plan && plan.opening && plan.opening.asOf)
    || (data && data.meta && data.meta.asOf)
    || null;
}

function actualsFrom(data, opts) {
  if (!overlayApplied(data, opts)) return null;
  const overlay = overlayOf(data);
  return overlay.currentPeriodActuals || null;
}

function recommendOpts(data, opts) {
  const plan = data && data.plan;
  const targetBuffer = plan && plan.defaults && plan.defaults.targetBuffer != null
    ? plan.defaults.targetBuffer
    : 0;
  const overlay = opts && opts.mode === 'canonical' ? null : overlayOf(data);
  return {
    fundingSources: plan && plan.funding && plan.funding.options,
    debts: data && data.debts,
    revolvingExtra: data && data.revolvingExtra,
    periods: loadPeriods(),
    currentPeriodActuals: actualsFrom(data, opts),
    observedCash: overlay && overlay.observedCash || null,
    targetBuffer,
    operatingPlan: overlay && overlay.operatingPlan,
    operatingPlanNote: overlay && overlay.operatingPlanNote,
  };
}

function evaluateRecommendation(data, opts, evaluate) {
  const plan = data && data.plan;
  const asOf = asOfFrom(data, opts);
  if (!plan || !asOf) {
    const err = new Error('Refreshed data is missing a Forecast opening.');
    err.code = 'operating-answer-failed';
    throw err;
  }
  return {
    asOf,
    advice: evaluate(plan, asOf, recommendOpts(data, opts)),
  };
}

function recommendFrom(data, opts) {
  return evaluateRecommendation(data, opts, timedRecommend);
}

function timedRecommend(...args) {
  const recommend = Forecast.recommend;
  return StageTiming.sync('forecastMs', () => recommend(...args));
}

// One live read uses this for its primary and projected-source replay overlays.
// Keep at most one successful result, owned by that operation, with the complete
// Forecast input (including newly loaded periods). No cross-request cache or
// option normalization: differing inputs always ask Forecast again.
function createRefreshEvaluation() {
  let entry = null;
  function evaluate(plan, asOf, options) {
    const input = { plan, asOf, options };
    let snapshot;
    try {
      if (entry && entry.recommend === Forecast.recommend && isDeepStrictEqual(entry.input, input)) return structuredClone(entry.advice);
      snapshot = structuredClone(input);
    } catch (_) {
      entry = null;
      return StageTiming.sync('forecastMs', () => Forecast.recommend(plan, asOf, options));
    }
    entry = null; // Exceptions and unsupported results must not become hits.
    const recommend = Forecast.recommend;
    const advice = StageTiming.sync('forecastMs', () => recommend(plan, asOf, options));
    try {
      if (recommend === Forecast.recommend && isDeepStrictEqual(snapshot, input)) {
        entry = { input: snapshot, advice: structuredClone(advice), recommend };
      }
    } catch (_) { /* Unsupported clone: retain incumbent uncached behavior. */ }
    return advice;
  }
  return { fromRefreshedState: (data, opts) => projectRefreshedState(data, opts, evaluate) };
}

function trustedStateFrom(data, opts) {
  if (opts && opts.trustedState) return opts.trustedState;
  if (opts && opts.mode === 'canonical') {
    return opts.writesCanonicalState === true
      ? 'canonical-approved-write'
      : 'canonical-dated-opening';
  }
  if (overlayApplied(data, opts)) return 'live-overlay-applied';
  const overlay = overlayOf(data);
  if (overlay && overlay.applied === false) return 'live-overlay-failed-closed';
  return 'dated-opening';
}

function lookup(packet, dotted) {
  const parts = String(dotted).split('.');
  let cur = packet;
  for (const part of parts) {
    if (cur == null) return null;
    cur = cur[part];
  }
  return cur;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function changeFrom(before, after) {
  if (!before) {
    return {
      changed: null,
      fields: [],
      note: 'No baseline Forecast result was supplied; zero/no-change is not claimed.',
    };
  }
  const fields = COMPARE_FIELDS.map(([name, path]) => {
    const previous = lookup(before, path);
    const next = lookup(after, path);
    return {
      field: name,
      source: 'Forecast.recommend',
      before: previous == null ? null : previous,
      after: next == null ? null : next,
      changed: !valuesEqual(previous, next),
    };
  });
  const futureBefore = ((before.futureCostProtection && before.futureCostProtection.futureCosts) || [])
    .map(row => ({ id: row && row.id, allocated: row && row.allocated }));
  const futureAfter = ((after.futureCostProtection && after.futureCostProtection.futureCosts) || [])
    .map(row => ({ id: row && row.id, allocated: row && row.allocated }));
  fields.push({
    field: 'futureCostProtection.futureCosts',
    source: 'Forecast.paydayAllocation.futureCosts',
    before: futureBefore,
    after: futureAfter,
    changed: !valuesEqual(futureBefore, futureAfter),
  });
  return {
    changed: fields.some(row => row.changed === true),
    fields,
    note: 'Change is equality of Forecast outputs. The projector does not compute a financial delta.',
  };
}

function projectFromAdvice(advice, data, opts, asOf) {
  const overlay = overlayOf(data);
  const alloc = (advice && advice.paydayAllocation) || {};
  const action = (advice && advice.currentPeriodAction) || {};
  const remainingClaim = action.remainingClaim || 'unavailable';
  const mode = (opts && opts.mode) || 'live-overlay';
  const applied = overlayApplied(data, opts);
  const planUnavailable = overlay && overlay.operatingPlan === 'unavailable';
  const unavailableNote = (overlay && overlay.operatingPlanNote)
    || (advice && advice.operatingPlanNote)
    || 'Current plan unavailable. The dated opening is stale.';
  return {
    schema: SCHEMA,
    source: 'Forecast.recommend',
    provenance: {
      mode,
      trustedState: trustedStateFrom(data, opts),
      asOf,
      overlayApplied: applied,
      operatingPlan: overlay && overlay.operatingPlan || null,
      writesCanonicalState: opts && opts.writesCanonicalState === true,
      remainingClaim,
      categoryRemainingClaim: action.categoryRemainingClaim || null,
      overlayFailedReason: (!applied && overlay && overlay.reason) || null,
    },
    asOf,
    recommendMode: advice && advice.mode || null,
    moneyAvailable: planUnavailable
      ? {
        source: 'Forecast.paydayAllocation.available',
        value: null,
        status: 'unavailable',
        note: unavailableNote,
      }
      : {
        source: 'Forecast.paydayAllocation.available',
        value: Object.prototype.hasOwnProperty.call(alloc, 'available') ? alloc.available : null,
      },
    protectedObligations: {
      source: 'Forecast.paydayAllocation.obligations',
      wanted: alloc.obligations ? alloc.obligations.wanted : null,
      allocated: alloc.obligations ? alloc.obligations.allocated : null,
      shortfall: alloc.obligations ? alloc.obligations.shortfall : null,
      items: clone(alloc.obligations && alloc.obligations.items ? alloc.obligations.items : []),
    },
    currentSpendingPermission: {
      source: 'Forecast.recommend.weekly / Forecast.currentPeriodAction',
      weekly: planUnavailable ? null
        : (advice && Object.prototype.hasOwnProperty.call(advice, 'weekly') ? advice.weekly : null),
      weeklyCap: planUnavailable ? null
        : (action.weeklyCap != null ? action.weeklyCap : (alloc.weeklyCap != null ? alloc.weeklyCap : null)),
      spendPermission: planUnavailable ? null
        : (action.spendPermission != null
          ? action.spendPermission
          : (alloc.spendPermission != null ? alloc.spendPermission : null)),
      remainingClaim: planUnavailable ? 'unavailable' : remainingClaim,
      mode: planUnavailable ? null : (action.mode || (advice && advice.mode) || null),
      nextPayday: planUnavailable ? null : (action.nextPayday || null),
      noMovementToday: planUnavailable ? false : action.noMovementToday === true,
      // Lead ruling on #1358 (B2): a card payment's card is unconfirmed, so the
      // permission rests on an estimated card coverage (cautious, never above).
      ...(!planUnavailable && advice && advice.cardPurchaseCoverage && advice.cardPurchaseCoverage.status === 'ready'
        && advice.cardPurchaseCoverage.trust === 'estimated'
        ? { trust: 'estimated', estimateBasis: ['card-payment-destination-unconfirmed', 'card-credit-purpose-unconfirmed']
            .includes(advice.cardPurchaseCoverage.estimateBasis) ? advice.cardPurchaseCoverage.estimateBasis : 'card-coverage-rows-unconfirmed',
          toConfirmCount: Array.isArray(advice.cardPurchaseCoverage.toConfirm) ? advice.cardPurchaseCoverage.toConfirm.length : 0 }
        : {}),
    },
    futureCostProtection: {
      source: 'Forecast.paydayAllocation.futureCosts / protectedPath',
      protectedPath: clone(alloc.protectedPath || null),
      liquidity: clone(alloc.liquidity || null),
      futureCosts: clone(alloc.futureCosts || []),
    },
    extraDebtAllocation: {
      source: 'Forecast.paydayAllocation.extraDebt',
      allocated: planUnavailable ? null : (alloc.extraDebt ? alloc.extraDebt.allocated : null),
      absorbable: planUnavailable ? null : (alloc.extraDebt ? alloc.extraDebt.absorbable : null),
      status: planUnavailable ? 'unavailable' : (alloc.extraDebt ? alloc.extraDebt.status : null),
      reason: planUnavailable ? unavailableNote : (alloc.extraDebt ? alloc.extraDebt.reason : null),
      target: planUnavailable ? null
        : clone(alloc.extraDebt && alloc.extraDebt.target ? alloc.extraDebt.target : null),
      consequence: planUnavailable ? null
        : clone(alloc.extraDebt && alloc.extraDebt.consequence ? alloc.extraDebt.consequence : null),
    },
    limitations: {
      ...(advice?.cardPurchaseCoverage ? { cardPurchaseCoverage: {
        status: advice.cardPurchaseCoverage.status, reason: advice.cardPurchaseCoverage.reason,
      } } : {}),
      source: 'Forecast.currentPeriodAction / Forecast.paydayAllocation.risks',
      remainingClaim: planUnavailable ? 'unavailable' : remainingClaim,
      categoryRemainingClaim: planUnavailable ? null : (action.categoryRemainingClaim || null),
      coverage: clone(action.coverage || alloc.actualsCoverage || null),
      risks: clone(alloc.risks || []),
      unresolved: clone(alloc.unresolved || []),
    },
  };
}

function projectRefreshedState(data, opts, evaluate) {
  opts = opts || {};
  const { asOf, advice } = evaluateRecommendation(data, opts, evaluate);
  const packet = projectFromAdvice(advice, data, opts, asOf);
  if (opts.baseline) {
    const baselineOpts = {
      mode: opts.baselineMode || opts.mode,
      writesCanonicalState: false,
      baseline: null,
    };
    const before = projectRefreshedState(opts.baseline, baselineOpts, evaluate);
    packet.change = changeFrom(before, packet);
    packet.baselineProvenance = before.provenance;
  } else {
    packet.change = changeFrom(null, packet);
  }
  return packet;
}

function fromRefreshedState(data, opts) {
  return projectRefreshedState(data, opts, timedRecommend);
}

const api = {
  SCHEMA,
  COMPARE_FIELDS,
  overlayApplied,
  asOfFrom,
  actualsFrom,
  recommendOpts,
  recommendFrom,
  createRefreshEvaluation,
  fromRefreshedState,
  changeFrom,
};

if (require.main === module) {
  process.stderr.write(
    'scripts/operating-answer.js is a Forecast projector used by live-plan and canonical-refresh. It is not a CLI.\n'
  );
  process.exit(1);
} else {
  module.exports = api;
}
