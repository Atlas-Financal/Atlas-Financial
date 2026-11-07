'use strict';
/* Talk deterministic Why? explanation.
 *
 * Talk may explain an already-published Atlas/Forecast result by tracing
 * its existing verified inputs and provenance. This is explanation, not
 * recalculation. Gemini may extract only { intent:"why" } with an optional
 * allowlisted referentPath or referentKey. It must not invent causes,
 * numbers, or policy. Unexpected model fields — including free-form
 * causal prose — fail closed. A why-ask without a publishable referent
 * is unavailable. Conversation history is not household-financial
 * evidence. A Why? of a prior hypothetical or comparison keeps that
 * published Forecast as-of / freshness; missing baseline fails closed
 * instead of stamping the current packet onto an unrecomputed result.
 * This module does not call Forecast, does not rank, and does not
 * introduce a second dependency graph.
 */

const TalkPresentation = require('./talk-presentation');
const TalkSession = require('./talk-session');

const WHY_INTENT = 'why';
const PATH_MAX_LENGTH = 120;
const PATH_RE = /^(?:[A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d{1,3}\]){0,7}$/;
const FORBIDDEN_PATH_RE = /(?:^|[.\[]|])(?:__proto__|constructor|prototype)(?:$|[.\]])/;

const WHY_EXTRACT_KEYS = Object.freeze({
  intent: true,
  referentPath: true,
  referentKey: true,
});

const REFERENT_KEYS = Object.freeze({
  'last-presented': true,
  'next-due': true,
  'debt-risk': true,
  'pay-period': true,
  'spendable-cash': true,
  'decision-posture': true,
});

const REFERENT_KEY_PATHS = Object.freeze({
  'next-due': Object.freeze([
    'current.nextSignificantObligations.nextDue.label',
    'current.nextSignificantObligations.nextDue.amount',
    'current.nextSignificantObligations.nextDue.date',
    'current.nextSignificantObligations.nextDue.daysUntil',
  ]),
  'debt-risk': Object.freeze([
    'current.debts.overLimitCount',
    'current.debts.monthlyInterest',
    'current.debts.totalAvailableCredit',
  ]),
  'pay-period': Object.freeze([
    'forecast.currentPeriodAction.essentialRemaining',
    'forecast.currentPeriodAction.weeklyCap',
    'forecast.currentPeriodAction.periodStart',
    'forecast.currentPeriodAction.periodEnd',
    'forecast.currentPeriodAction.nextPayday',
    'forecast.currentPeriodAction.remainingClaim',
  ]),
  'spendable-cash': Object.freeze([
    'current.spendableHouseholdCash.value',
  ]),
  'decision-posture': Object.freeze([
    'policy.decisionPosture.posture',
    'policy.decisionPosture.provenance',
    'policy.decisionPosture.provenanceDate',
  ]),
});

const WHY_QUESTION_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:why|how come)\b|\bwhy\s+(?:is|are|did|does|do|was|were|would|should|am i|are we)\b|\bexplain\s+(?:why|that|this)\b|\bwhat makes atlas\b/i;
const DEICTIC_RE = /\b(?:that|this|telling me|showing me|said that|just (?:said|told|showed))\b/i;
const BILL_RE = /\b(?:bill|bills|obligation|next due|due item|payment out)\b/i;
const DEBT_RISK_RE = /\b(?:debt|risk|over[\s-]?limit|credit (?:risk|picture)|interest)\b/i;
const PAY_PERIOD_RE = /\b(?:pay period|remaining|weekly cap|payday|essential remaining)\b/i;
const SPENDABLE_RE = /\b(?:spendable|household cash|opening cash)\b/i;
const POSTURE_RE = /\b(?:decision posture|owner policy|posture)\b/i;
const PLANNER_ACT_RE = /\b(?:should i|recommend|best\b|afford|borrow|transfer|pay off|safe to spend|available cash|ranking|where to put|spare cash)\b/i;

const CAUSAL_PROSE_KEYS = Object.freeze({
  reason: true,
  cause: true,
  because: true,
  explanation: true,
  prose: true,
  why: true,
  narrative: true,
  analysis: true,
  recommendation: true,
  ranking: true,
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value) {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function questionAsksWhy(question) {
  return typeof question === 'string' && WHY_QUESTION_RE.test(question.trim());
}

function questionIsPlannerActWhy(question) {
  return typeof question === 'string' && PLANNER_ACT_RE.test(question);
}

function parsePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX_LENGTH) {
    return null;
  }
  if (!PATH_RE.test(path) || FORBIDDEN_PATH_RE.test(path)) return null;
  const steps = [];
  for (const piece of path.split('.')) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)((?:\[\d{1,3}\])*)$/.exec(piece);
    if (!match) return null;
    steps.push({ type: 'key', key: match[1] });
    const indexes = match[2].match(/\d{1,3}/g) || [];
    for (const index of indexes) steps.push({ type: 'index', index: Number(index) });
  }
  return steps;
}

function readPacketValue(packet, path) {
  const steps = parsePath(path);
  if (!steps) return { ok: false, reason: 'invalid path' };
  let current = packet;
  for (const step of steps) {
    if (current == null || typeof current !== 'object') {
      return { ok: false, reason: 'missing path' };
    }
    if (step.type === 'key') {
      if (!Object.prototype.hasOwnProperty.call(current, step.key)) {
        return { ok: false, reason: 'missing path' };
      }
      current = current[step.key];
    } else {
      if (!Array.isArray(current) || step.index >= current.length) {
        return { ok: false, reason: 'missing path' };
      }
      current = current[step.index];
    }
  }
  return { ok: true, value: current };
}

function allowlistedPath(path) {
  return typeof path === 'string' && !!TalkPresentation.ruleFor(path);
}

function publishablePaths(paths, packet) {
  if (!Array.isArray(paths) || !packet || typeof packet !== 'object') return [];
  const out = [];
  const seen = Object.create(null);
  for (const path of paths) {
    if (!allowlistedPath(path) || seen[path]) continue;
    const found = readPacketValue(packet, path);
    if (!found.ok || !isPrimitive(found.value)) continue;
    seen[path] = true;
    out.push({ path, value: found.value });
    if (out.length >= 8) break;
  }
  return out;
}

function parseExtract(parsed) {
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'not-why' };
  }
  const keys = Object.keys(parsed);
  if (!keys.includes('intent')) return { ok: false, reason: 'not-why' };
  if (parsed.intent !== WHY_INTENT) return { ok: false, reason: 'not-why' };
  if (keys.some(key => CAUSAL_PROSE_KEYS[key])) {
    return { ok: false, reason: 'invented-prose' };
  }
  if (keys.some(key => !WHY_EXTRACT_KEYS[key])) {
    return { ok: false, reason: 'unexpected fields' };
  }
  const hasPath = keys.includes('referentPath');
  const hasKey = keys.includes('referentKey');
  if (hasPath && hasKey) {
    return { ok: false, reason: 'unexpected fields' };
  }
  if (hasPath) {
    if (typeof parsed.referentPath !== 'string' || !allowlistedPath(parsed.referentPath)) {
      return { ok: false, reason: 'invalid referentPath' };
    }
    return {
      ok: true,
      intent: WHY_INTENT,
      referentPath: parsed.referentPath,
    };
  }
  if (hasKey) {
    if (typeof parsed.referentKey !== 'string' || !REFERENT_KEYS[parsed.referentKey]) {
      return { ok: false, reason: 'invalid referentKey' };
    }
    return {
      ok: true,
      intent: WHY_INTENT,
      referentKey: parsed.referentKey,
    };
  }
  return { ok: true, intent: WHY_INTENT };
}

function referentKeyFromQuestion(question) {
  if (typeof question !== 'string') return null;
  if (BILL_RE.test(question)) return 'next-due';
  if (DEBT_RISK_RE.test(question) && /\brisk\b/i.test(question)) return 'debt-risk';
  if (PAY_PERIOD_RE.test(question)) return 'pay-period';
  if (SPENDABLE_RE.test(question)) return 'spendable-cash';
  if (POSTURE_RE.test(question)) return 'decision-posture';
  if (DEICTIC_RE.test(question)) return 'last-presented';
  const trimmed = question.trim();
  if (/^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:why|how come)\??$/i.test(trimmed)
      || /^(?:explain that|explain this)\??$/i.test(trimmed)) {
    return 'last-presented';
  }
  return null;
}

function lastPresentedFromTurn(priorTurn) {
  if (!priorTurn || typeof priorTurn !== 'object') return null;
  if (priorTurn.kind === 'hypothetical') {
    return {
      priorKind: 'hypothetical',
      priorAmount: priorTurn.amount,
      priorDebtId: priorTurn.debtId,
      priorDebtLabel: priorTurn.debtLabel,
      asOf: priorTurn.asOf,
      freshness: priorTurn.freshness,
    };
  }
  if (priorTurn.kind === 'comparison') {
    return {
      priorKind: 'comparison',
      priorScenarios: Array.isArray(priorTurn.scenarios) ? priorTurn.scenarios.slice() : [],
      asOf: priorTurn.asOf,
      freshness: priorTurn.freshness,
    };
  }
  if (priorTurn.kind === 'explained' || priorTurn.kind === 'why') {
    if (priorTurn.priorKind === 'hypothetical'
        && typeof priorTurn.amount === 'number'
        && typeof priorTurn.debtLabel === 'string') {
      return {
        priorKind: 'hypothetical',
        priorAmount: priorTurn.amount,
        priorDebtId: priorTurn.debtId,
        priorDebtLabel: priorTurn.debtLabel,
        asOf: priorTurn.asOf,
        freshness: priorTurn.freshness,
      };
    }
    if (priorTurn.priorKind === 'comparison' && Array.isArray(priorTurn.scenarios)) {
      return {
        priorKind: 'comparison',
        priorScenarios: priorTurn.scenarios.slice(),
        asOf: priorTurn.asOf,
        freshness: priorTurn.freshness,
      };
    }
    if (Array.isArray(priorTurn.referentPaths) && priorTurn.referentPaths.length) {
      return {
        priorKind: priorTurn.kind,
        paths: priorTurn.referentPaths.slice(),
        facilityRefs: priorTurn.facilityRefs,
      };
    }
  }
  return null;
}

function debtRiskPublishable(claims) {
  const over = claims.find(row => row.path === 'current.debts.overLimitCount');
  if (!over || !Number.isFinite(Number(over.value)) || Number(over.value) <= 0) {
    return false;
  }
  return true;
}

function unavailable(reason) {
  return { status: 'unavailable', reason: reason || 'no-referent' };
}

function readyFromClaims(claims, extras) {
  extras = extras || {};
  if (!claims.length && extras.priorKind !== 'hypothetical' && extras.priorKind !== 'comparison') {
    return unavailable(extras.reason || 'no-referent');
  }
  const ready = {
    status: 'ready',
    claims,
    paths: claims.map(row => row.path),
    referentKey: extras.referentKey || null,
    priorKind: extras.priorKind || null,
    priorAmount: extras.priorAmount || null,
    priorDebtId: extras.priorDebtId || null,
    priorDebtLabel: extras.priorDebtLabel || null,
    priorScenarios: extras.priorScenarios || null,
  };
  if (typeof extras.asOf === 'string' && extras.asOf) ready.asOf = extras.asOf;
  if (typeof extras.freshness === 'string' && extras.freshness) ready.freshness = extras.freshness;
  if (extras.lead) ready.lead = extras.lead;
  return ready;
}

function resolveKey(referentKey, packet, priorTurn) {
  if (referentKey === 'last-presented') {
    const last = lastPresentedFromTurn(priorTurn);
    if (!last) return unavailable('no-referent');
    if (last.priorKind === 'hypothetical' || last.priorKind === 'comparison') {
      if (typeof last.asOf !== 'string' || !last.asOf) {
        return unavailable('stale-baseline');
      }
      return readyFromClaims([], last);
    }
    // A20: a stored card path is re-read by the card's stable id; a card
    // that is gone or no longer identifiable is withheld, never swapped.
    const rebound = TalkSession.rebindFacilityPaths(last.paths, last.facilityRefs, packet);
    if (!rebound.ok) return unavailable('no-referent');
    const claims = publishablePaths(rebound.paths, packet);
    return readyFromClaims(claims, { referentKey, priorKind: last.priorKind });
  }
  const listed = REFERENT_KEY_PATHS[referentKey];
  if (!listed) return unavailable('invalid referentKey');
  const claims = publishablePaths(listed, packet);
  if (referentKey === 'debt-risk' && !debtRiskPublishable(claims)) {
    return unavailable('no-risk');
  }
  const leads = {
    'next-due': 'Atlas is showing that bill from already-published obligation fields, not a new plan calculation.',
    'debt-risk': 'Atlas is showing this credit picture from already-published credit fields, not a new risk score.',
    'pay-period': 'Atlas is showing that pay-period figure from already-published Forecast fields, not a new calculation.',
    'spendable-cash': 'Atlas is showing that cash figure from already-published household-cash fields, not a new calculation.',
    'decision-posture': 'Atlas is showing that decision-posture label from already-published owner-stated policy fields, not a new rule.',
  };
  return readyFromClaims(claims, { referentKey, lead: leads[referentKey] });
}

function resolve({ question, packet, priorTurn, extract }) {
  if (!packet || typeof packet !== 'object') return unavailable('missing packet');
  if (questionIsPlannerActWhy(question)) return unavailable('planner-act');

  if (extract && extract.ok && extract.intent === WHY_INTENT) {
    if (extract.referentPath) {
      const claims = publishablePaths([extract.referentPath], packet);
      return readyFromClaims(claims, { referentKey: null });
    }
    if (extract.referentKey) {
      return resolveKey(extract.referentKey, packet, priorTurn);
    }
  }

  const fromQuestion = referentKeyFromQuestion(question);
  if (fromQuestion) {
    return resolveKey(fromQuestion, packet, priorTurn);
  }

  if (questionAsksWhy(question)) {
    return unavailable('unresolved-referent');
  }
  return unavailable('not-why');
}

function sessionTurnFromWhy(result) {
  if (!result || result.status !== 'ready') return { kind: 'unavailable' };
  const turn = { kind: 'why' };
  if (Array.isArray(result.paths) && result.paths.length) {
    turn.referentPaths = result.paths.slice(0, 8);
  }
  if (result.priorKind === 'hypothetical'
      && typeof result.priorAmount === 'number'
      && typeof result.priorDebtLabel === 'string'
      && result.priorDebtLabel) {
    turn.priorKind = 'hypothetical';
    turn.amount = result.priorAmount;
    turn.debtId = typeof result.priorDebtId === 'string' ? result.priorDebtId : '';
    turn.debtLabel = result.priorDebtLabel;
    if (typeof result.asOf === 'string' && result.asOf) turn.asOf = result.asOf;
    if (typeof result.freshness === 'string' && result.freshness) {
      turn.freshness = result.freshness;
    }
  }
  if (result.priorKind === 'comparison' && Array.isArray(result.priorScenarios)
      && result.priorScenarios.length >= 2) {
    turn.priorKind = 'comparison';
    turn.scenarios = result.priorScenarios;
    if (typeof result.asOf === 'string' && result.asOf) turn.asOf = result.asOf;
    if (typeof result.freshness === 'string' && result.freshness) {
      turn.freshness = result.freshness;
    }
  }
  return turn;
}

function sessionTurnFromExplained(claims) {
  const paths = [];
  const seen = Object.create(null);
  if (Array.isArray(claims)) {
    for (const claim of claims) {
      if (!claim || typeof claim.path !== 'string' || seen[claim.path]) continue;
      if (!allowlistedPath(claim.path)) continue;
      seen[claim.path] = true;
      paths.push(claim.path);
      if (paths.length >= 8) break;
    }
  }
  const turn = { kind: 'explained' };
  if (paths.length) turn.referentPaths = paths;
  return turn;
}

function presentExtract(extract, context) {
  context = context || {};
  const resolved = resolve({
    question: context.question,
    packet: context.packet,
    priorTurn: context.priorTurn,
    extract,
  });
  return TalkPresentation.presentWhyExplanation(resolved, context.packet);
}

module.exports = {
  WHY_INTENT,
  REFERENT_KEYS,
  REFERENT_KEY_PATHS,
  WHY_EXTRACT_KEYS,
  questionAsksWhy,
  questionIsPlannerActWhy,
  parseExtract,
  resolve,
  publishablePaths,
  allowlistedPath,
  sessionTurnFromWhy,
  sessionTurnFromExplained,
  presentExtract,
};
