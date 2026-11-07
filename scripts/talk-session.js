'use strict';
/* Talk ephemeral multi-turn session context.
 *
 * Conversation memory is conversational context only. It is not a
 * canonical household fact store, financial evidence, Forecast state,
 * owner policy, a write, permission, a substitute for this request's
 * assistant packet, or a substitute for explicit verification of
 * amounts and targets.
 *
 * The buffer is in-process RAM, keyed to the authenticated session
 * cookie (HMAC of the cookie, never the raw token). Bounded depth,
 * size, session count, and inactivity TTL. No durable database.
 * Logout and a new login start empty. Session A cannot read session B.
 *
 * Follow-up amounts and named debts are resolved only by the explicit
 * contract below. History may fill a missing amount or named debt only
 * when the question is authorized follow-up grammar — a positive
 * deixis/extra skeleton with no leftover wording. An explainer
 * blacklist is not the gate. Ambiguity returns unavailable. Gemini
 * never fills a missing amount or target from chat text. Current Atlas
 * state and Forecast remain the only financial authorities. A
 * hypothetical or comparison turn may keep the already-published
 * Forecast as-of / freshness so a later Why? can label that same
 * calculation. Those fields are provenance of a published result, not
 * household-financial evidence and not a later packet substitute.
 *
 * Campaign-style verified follow-ups ("what about next payday?",
 * "what about that card?", "how much interest was that again?",
 * "what does that leave us with?") resolve only against ephemeral
 * structured refs from a prior verified presentation — allowlisted
 * packet paths and published result keys, never conversation prose.
 * Payday leftover is Forecast Balance After Deductions
 * (`forecast.predictedEndingBalance.amount`, the active calendar
 * waterfall income − bills − Household Budget). "What does this payday
 * leave us with?" reads that identity. paydayAllocation.runningLeftover
 * remains the current-cash allocation picture, not this leftover. "What
 * does this payday look like?" reprints those allocation stages plus
 * leftover-consuming allocated amounts. "What does that leave us
 * with?" binds only when leftover was already earned, including from
 * that look-like presentation. Remaining payday bills reprint Forecast-owned
 * currentPeriodAction.bills. Settlement is Forecast-owned

 * (represented | upcoming | unverified). Talk does not date-filter
 * that list, invent a paid list, or treat unverified as unpaid.
 * Ambiguous deixis is unavailable. After exactly one earned two-option
 * A-vs-B comparison in the session, a bare "Which one?" refers to those
 * exact two options and invokes only the incumbent owner preference
 * rule. Session uniqueness is a compact ephemeral comparison-identity
 * signal on the same RAM record as the turn buffer. It survives 8-turn
 * eviction, is keyed to the auth session, and is not household-financial
 * evidence, not prose, and not amounts as financial truth. Once more
 * than one distinct A-vs-B identity has appeared in this session, later
 * Which one? fails closed even if the earlier comparison has rolled out
 * of the buffer. Multiple comparisons, 3+ options, leftover/bills/
 * hypothetical last turns, stale debts, or an unearned prior fail
 * closed. The server re-reads this request's packet or recomputes
 * Forecast on the stored hyp inputs. No durable household fact store.
 */

const crypto = require('crypto');
const TalkHypothetical = require('./talk-hypothetical');
const { remainingBillsCompleteness } = require('./talk-presentation');

const MAX_TURNS = 8;
const MAX_SESSIONS = 32;
const TTL_MS = 60 * 60 * 1000;
const QUESTION_MAX = 2000;
const PRESENTED_MAX = 400;
const LABEL_MAX = 80;
const SCENARIO_MAX = 6;
const ASOF_MAX = 40;
const FRESHNESS_TAGS = Object.freeze({
  unavailable: true,
  unknown: true,
  'dated-opening': true,
  planned: true,
  estimated: true,
  'posted-only': true,
  calculated: true,
  'owner-stated': true,
  'canonical-opening': true,
  precise: true,
  confirmed: true,
  live: true,
});
const FOLLOWUP_DEIXIS_RE = /\b(?:what about|how about|and(?:\s+what)?|instead|also|same(?:\s+amount)?|that)\b/i;
const EXTRA_LANGUAGE_RE = /\b(?:extra|put(?:ting)?|toward|towards|instead)\b/i;
const COMPARISON_FOLLOWUP_RE = /\b(?:compare(?:d)?|versus|vs\.?|against)\b/i;
/* Authorized inheritance grammar is a positive skeleton: deixis / extra-
 * application words plus structural glue. After masking recovered amounts
 * and named debts, any leftover word fails closed. Payment, minimum,
 * utilization, and other debt-explainer nouns are not in this set.
 */
const FOLLOWUP_INTENT_RE = /\b(?:what about|how about|and(?:\s+what)?|instead|also|same(?:\s+amount)?|that|extra|put(?:ting)?|toward|towards)\b/i;
const AUTHORIZED_FOLLOWUP_WORDS = new Set([
  'what', 'about', 'how', 'and', 'instead', 'also', 'same', 'amount',
  'that', 'extra', 'put', 'putting', 'toward', 'towards',
  'the', 'a', 'an', 'on', 'to', 'of', 'for', 'with', 'my', 'our',
]);
const FOLLOWUP_REFERENT_KEYS = Object.freeze({
  'next-payday': true,
  'pay-period': true,
  'interest': true,
  'card': true,
  'last-presented': true,
  'payday-leftover': true,
  'payday-picture': true,
  'payday-remaining-bills': true,
});
const FOLLOWUP_KEY_PATHS = Object.freeze({
  'next-payday': Object.freeze([
    'forecast.currentPeriodAction.nextPayday',
  ]),
  'pay-period': Object.freeze([
    'forecast.currentPeriodAction.essentialRemaining',
    'forecast.currentPeriodAction.weeklyCap',
    'forecast.currentPeriodAction.periodStart',
    'forecast.currentPeriodAction.periodEnd',
    'forecast.currentPeriodAction.nextPayday',
    'forecast.currentPeriodAction.remainingClaim',
  ]),
  'interest': Object.freeze([
    'current.debts.monthlyInterest',
  ]),
  'payday-leftover': Object.freeze([
    'forecast.predictedEndingBalance.amount',
  ]),
  'payday-picture': Object.freeze([
    'forecast.paydayAllocation.runningLeftover.currentBalance',
    'forecast.paydayAllocation.obligations.allocated',
    'forecast.paydayAllocation.runningLeftover.afterBills',
    'forecast.paydayAllocation.essentials.allocated',
    'forecast.paydayAllocation.runningLeftover.afterHouseholdBudget',
    'forecast.paydayAllocation.extraDebt.allocated',
    'forecast.paydayAllocation.runningLeftover.afterDebtRepayment',
    'forecast.paydayAllocation.runningLeftover.afterBigPurchases',
  ]),
});
const LEFTOVER_INTENT = 'payday-leftover';
const LEFTOVER_PATH = 'forecast.predictedEndingBalance.amount';
const PAYDAY_PICTURE_INTENT = 'payday-picture';
const PAYDAY_PICTURE_PATHS = FOLLOWUP_KEY_PATHS['payday-picture'];
const LEFTOVER_EXTRACT_KEYS = Object.freeze({
  intent: true,
  referentKey: true,
});
const LEFTOVER_REFERENT_KEYS = Object.freeze({
  'payday-leftover': true,
  'last-presented': true,
  'pay-period': true,
});
const LEFTOVER_FORBIDDEN_KEYS = Object.freeze({
  leftover: true,
  amount: true,
  equals: true,
  value: true,
  runningLeftover: true,
  afterBigPurchases: true,
  leftoverAmount: true,
});
const PAYDAY_PICTURE_EXTRACT_KEYS = Object.freeze({
  intent: true,
});
const PAYDAY_PICTURE_FORBIDDEN_KEYS = Object.freeze({
  leftover: true,
  amount: true,
  equals: true,
  value: true,
  runningLeftover: true,
  allocated: true,
  currentBalance: true,
  afterBills: true,
  afterHouseholdBudget: true,
  afterDebtRepayment: true,
  afterBigPurchases: true,
  leftoverAmount: true,
  claims: true,
});
const REMAINING_BILLS_INTENT = 'payday-remaining-bills';
const REMAINING_BILLS_EXTRACT_KEYS = Object.freeze({
  intent: true,
  referentKey: true,
  billLabel: true,
});
const REMAINING_BILLS_REFERENT_KEYS = Object.freeze({
  covered: true,
  'last-presented': true,
});
const REMAINING_BILLS_FORBIDDEN_KEYS = Object.freeze({
  leftover: true,
  amount: true,
  equals: true,
  value: true,
  remaining: true,
  remainingCount: true,
  wanted: true,
  allocated: true,
  items: true,
  settlement: true,
  paid: true,
  unpaid: true,
  late: true,
  overdue: true,
  covered: true,
  claims: true,
  status: true,
});
const FACILITY_REF_RE = /^current\.debts\.facilities\[(\d{1,3})\]\.(?:available|label)$/;
const NEXT_PAYDAY_FOLLOWUP_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:what about|how about)(?:\s+the)?\s+next\s+payday\??$/i;
const THAT_CARD_FOLLOWUP_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:what about|how about)\s+(?:that|this|the)\s+card\??$/i;
const INTEREST_AGAIN_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:how much interest (?:was|is) that(?: again)?|(?:what(?:'s| is)|whats) (?:the )?interest (?:again|on that)|interest again)\??$/i;
const BARE_THAT_FOLLOWUP_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:what about|how about)\s+that\??$/i;
const THIS_PAYDAY_LOOK_LIKE_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?what does this payday look like\??$/i;
const THIS_PAYDAY_LEFTOVER_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?what does this payday leave us with\??$/i;
const THAT_LEAVE_US_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?what does that leave us with\??$/i;
const REMAINING_BILLS_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:what bills are coming before (?:the )?next payday|what bills do we still have before (?:the )?next payday|what still needs to come out this pay period|what bills are left)\??$/i;
const COVERED_BILLS_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?which bills have already been covered\??$/i;
const NAMED_BILL_DUE_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?is\s+(.+?)\s+still\s+due\??$/i;
const THAT_ONE_FOLLOWUP_RE = /^(?:ok[,.]?\s+|and\s+|so\s+|then\s+)?(?:what about|how about)\s+that\s+one\??$/i;

function hmacKey(secret, token) {
  if (typeof secret !== 'string' || secret.length < 16) return '';
  if (typeof token !== 'string' || !token) return '';
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

function finiteAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clipText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

const REFERENT_PATH_RE = /^(?:[A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d{1,3}\]){0,7}$/;
const FORBIDDEN_REFERENT_PATH_RE = /(?:^|[.\[]|])(?:__proto__|constructor|prototype)(?:$|[.\]])/;

function sanitizeReferentPaths(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = Object.create(null);
  for (const path of raw) {
    if (typeof path !== 'string' || path.length === 0 || path.length > 120) continue;
    if (!REFERENT_PATH_RE.test(path) || FORBIDDEN_REFERENT_PATH_RE.test(path)) continue;
    if (seen[path]) continue;
    seen[path] = true;
    out.push(path);
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeReferentKeys(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = Object.create(null);
  for (const key of raw) {
    if (typeof key !== 'string' || !FOLLOWUP_REFERENT_KEYS[key] || seen[key]) continue;
    seen[key] = true;
    out.push(key);
    if (out.length >= 8) break;
  }
  return out;
}

function bindReferentKeysFromPaths(paths) {
  const keys = [];
  const seen = Object.create(null);
  const facilityIndexes = [];
  if (!Array.isArray(paths)) return { keys, facilityIndexes };
  for (const path of paths) {
    if (typeof path !== 'string') continue;
    for (const key of Object.keys(FOLLOWUP_KEY_PATHS)) {
      if (!seen[key] && FOLLOWUP_KEY_PATHS[key].includes(path)) {
        seen[key] = true;
        keys.push(key);
      }
    }
    const facility = FACILITY_REF_RE.exec(path);
    if (facility) {
      const index = Number(facility[1]);
      if (!facilityIndexes.includes(index)) facilityIndexes.push(index);
    }
  }
  if (facilityIndexes.length === 1 && !seen.card) {
    seen.card = true;
    keys.push('card');
  }
  // A payday look-like presentation still earns leftover deixis. The
  // leftover follow-up then reads Balance After Deductions, not the

  // paydayAllocation closing stage.
  if (seen['payday-picture'] && !seen['payday-leftover']) {
    seen['payday-leftover'] = true;
    keys.push('payday-leftover');
  }
  return { keys, facilityIndexes };
}

function referentKeysOn(prior) {
  const stored = sanitizeReferentKeys(prior && prior.referentKeys);
  const derived = bindReferentKeysFromPaths(prior && prior.referentPaths);
  const out = stored.slice();
  const seen = Object.create(null);
  for (const key of stored) seen[key] = true;
  for (const key of derived.keys) {
    if (seen[key]) continue;
    seen[key] = true;
    out.push(key);
  }
  return out;
}

function priorHasReferentKey(prior, key) {
  return referentKeysOn(prior).includes(key);
}

function facilityIndexForDebt(packet, debtId, debtLabel) {
  const facilities = packet
    && packet.current
    && packet.current.debts
    && packet.current.debts.facilities;
  if (!Array.isArray(facilities)) return null;
  const matches = [];
  for (let i = 0; i < facilities.length; i += 1) {
    const row = facilities[i];
    if (!row || typeof row !== 'object') continue;
    if ((debtId && row.id === debtId) || (debtLabel && row.label === debtLabel)) {
      matches.push(i);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function uniqueFacilityFollowup(prior, packet) {
  const bound = bindReferentKeysFromPaths(prior && prior.referentPaths);
  if (bound.facilityIndexes.length === 1) {
    const index = bound.facilityIndexes[0];
    return {
      ok: true,
      paths: [
        `current.debts.facilities[${index}].label`,
        `current.debts.facilities[${index}].available`,
      ],
    };
  }
  if (bound.facilityIndexes.length > 1) {
    return { ok: false, ambiguous: true };
  }
  const debtId = prior && typeof prior.debtId === 'string' ? prior.debtId : '';
  const debtLabel = prior && typeof prior.debtLabel === 'string' ? prior.debtLabel : '';
  const hypLike = prior && (
    prior.kind === 'hypothetical'
    || prior.priorKind === 'hypothetical'
  );
  if (hypLike && (debtId || debtLabel)) {
    const index = facilityIndexForDebt(packet, debtId, debtLabel);
    if (index != null) {
      return {
        ok: true,
        paths: [
          `current.debts.facilities[${index}].label`,
          `current.debts.facilities[${index}].available`,
        ],
      };
    }
  }
  return { ok: false, ambiguous: false };
}

function classifyVerifiedFollowup(question) {
  if (typeof question !== 'string' || !question.trim()) return null;
  const parsed = question.trim().replace(/\s+/g, ' ');
  if (THIS_PAYDAY_LOOK_LIKE_RE.test(parsed)) return 'payday-picture';
  if (THIS_PAYDAY_LEFTOVER_RE.test(parsed)) return 'payday-leftover';
  if (THAT_LEAVE_US_RE.test(parsed)) return 'payday-leftover-deixis';
  if (REMAINING_BILLS_RE.test(parsed)) return 'payday-remaining-bills';
  if (COVERED_BILLS_RE.test(parsed)) return 'payday-remaining-bills-covered';
  if (NAMED_BILL_DUE_RE.test(parsed)) return 'payday-named-bill';
  if (NEXT_PAYDAY_FOLLOWUP_RE.test(parsed)) return 'next-payday';
  if (THAT_CARD_FOLLOWUP_RE.test(parsed)) return 'card';
  if (INTEREST_AGAIN_RE.test(parsed)) return 'interest';
  if (THAT_ONE_FOLLOWUP_RE.test(parsed)) return 'last-presented-one';
  if (BARE_THAT_FOLLOWUP_RE.test(parsed)) return 'last-presented';
  return null;
}

function namedBillLabelFromQuestion(question) {
  if (typeof question !== 'string' || !question.trim()) return '';
  const parsed = question.trim().replace(/\s+/g, ' ');
  const match = NAMED_BILL_DUE_RE.exec(parsed);
  return match && match[1] ? clipText(match[1], LABEL_MAX) : '';
}

function normalizeBillToken(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// "The one still-due bill" is a completeness claim: only a complete list
// (TalkPresentation.remainingBillsCompleteness) may name it.
function packetRemainingBillsComplete(packet) {
  const action = packet && packet.forecast && packet.forecast.currentPeriodAction;
  return remainingBillsCompleteness(action).complete === true;
}

function packetRemainingBillItems(packet) {
  const action = packet && packet.forecast && packet.forecast.currentPeriodAction;
  if (!action || action.status === 'unavailable') {
    return null;
  }
  const items = action.bills;
  return Array.isArray(items) ? items : null;
}

function forecastStillDueBills(items) {
  if (!Array.isArray(items)) return null;
  return items.filter(item => item && (
    item.settlement === 'upcoming' || item.settlement === 'unverified'
  ));
}

function matchRemainingBill(items, query, preferredId) {
  if (!Array.isArray(items)) return { status: 'unavailable' };
  const preferred = typeof preferredId === 'string' ? preferredId : '';
  if (preferred) {
    const byId = items.filter(item => item && item.id === preferred);
    if (byId.length === 1) return { status: 'unique', item: byId[0] };
    if (byId.length > 1) return { status: 'ambiguous' };
    return { status: 'none' };
  }
  const q = normalizeBillToken(query);
  if (!q) return { status: 'none' };
  const matches = [];
  const seen = Object.create(null);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = normalizeBillToken(item.id || '');
    const label = normalizeBillToken(item.label || '');
    const key = item.id || item.label || '';
    if (!key || seen[key]) continue;
    const exact = (id && id === q) || (label && label === q);
    const contains = q.length >= 3 && (
      (id && (id === q || id.indexOf(q) !== -1 || q.indexOf(id) !== -1))
      || (label && (label.indexOf(q) !== -1 || q.indexOf(label) !== -1))
    );
    if (exact || contains) {
      seen[key] = true;
      matches.push(item);
    }
  }
  if (matches.length === 1) return { status: 'unique', item: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous' };
  return { status: 'none' };
}

function remainingBillsReference(ask, billLabel, packet, preferredId) {
  const resolved = {
    status: 'resolved-reference',
    referentKey: REMAINING_BILLS_INTENT,
    ask,
  };
  if (ask !== 'named') {
    const listed = packetRemainingBillItems(packet);
    const stillDue = forecastStillDueBills(listed);
    if (ask === 'remaining' && stillDue && stillDue.length === 1 && stillDue[0] && stillDue[0].id
        && packetRemainingBillsComplete(packet)) {
      resolved.billId = stillDue[0].id;
      resolved.billLabel = clipText(stillDue[0].label, LABEL_MAX) || stillDue[0].id;
    }
    return resolved;
  }
  const label = clipText(billLabel, LABEL_MAX);
  if (!label) return { status: 'ambiguous', nature: 'reference' };
  resolved.billLabel = label;
  const listed = packetRemainingBillItems(packet);
  if (!listed) return resolved;
  const match = matchRemainingBill(listed, label, preferredId);
  if (match.status === 'ambiguous') return { status: 'ambiguous', nature: 'reference' };
  if (match.status === 'unique' && match.item && match.item.id) {
    resolved.billId = match.item.id;
    resolved.billLabel = clipText(match.item.label, LABEL_MAX) || label;
  }
  return resolved;
}

function remainingBillsDeixis(prior, packet) {
  if (!priorHasReferentKey(prior, REMAINING_BILLS_INTENT)) {
    return { status: 'none' };
  }
  const billId = prior && typeof prior.billId === 'string' ? prior.billId : '';
  const billLabel = prior && typeof prior.billLabel === 'string' ? prior.billLabel : '';
  if (!billId) return { status: 'ambiguous', nature: 'reference' };
  return remainingBillsReference('named', billLabel || billId, packet, billId);
}

function leftoverReference(priorRequired, prior) {
  if (priorRequired && !priorHasReferentKey(prior, 'payday-leftover')) {
    return { status: 'ambiguous', nature: 'reference' };
  }
  return {
    status: 'resolved-reference',
    paths: FOLLOWUP_KEY_PATHS['payday-leftover'].slice(),
    referentKey: 'payday-leftover',
  };
}

function paydayPictureReference() {
  return {
    status: 'resolved-reference',
    paths: PAYDAY_PICTURE_PATHS.slice(),
    referentKey: 'payday-picture',
  };
}

function parseLeftoverExtract(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-leftover' };
  }
  if (parsed.intent !== LEFTOVER_INTENT) return { ok: false, reason: 'not-leftover' };
  const keys = Object.keys(parsed);
  if (keys.some(key => LEFTOVER_FORBIDDEN_KEYS[key])) {
    return { ok: false, reason: 'invented leftover' };
  }
  if (keys.some(key => !LEFTOVER_EXTRACT_KEYS[key])) {
    return { ok: false, reason: 'unexpected fields' };
  }
  if (keys.includes('referentKey')) {
    if (typeof parsed.referentKey !== 'string' || !LEFTOVER_REFERENT_KEYS[parsed.referentKey]) {
      return { ok: false, reason: 'invalid referentKey' };
    }
    return {
      ok: true,
      intent: LEFTOVER_INTENT,
      referentKey: parsed.referentKey,
    };
  }
  return { ok: true, intent: LEFTOVER_INTENT };
}

function parsePaydayPictureExtract(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-payday-picture' };
  }
  if (parsed.intent !== PAYDAY_PICTURE_INTENT) {
    return { ok: false, reason: 'not-payday-picture' };
  }
  const keys = Object.keys(parsed);
  if (keys.some(key => PAYDAY_PICTURE_FORBIDDEN_KEYS[key])) {
    return { ok: false, reason: 'invented payday picture' };
  }
  if (keys.some(key => !PAYDAY_PICTURE_EXTRACT_KEYS[key])) {
    return { ok: false, reason: 'unexpected fields' };
  }
  return { ok: true, intent: PAYDAY_PICTURE_INTENT };
}

function parseRemainingBillsExtract(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-remaining-bills' };
  }
  if (parsed.intent !== REMAINING_BILLS_INTENT) {
    return { ok: false, reason: 'not-remaining-bills' };
  }
  const keys = Object.keys(parsed);
  if (keys.some(key => REMAINING_BILLS_FORBIDDEN_KEYS[key])) {
    return { ok: false, reason: 'invented remaining bills' };
  }
  if (keys.some(key => !REMAINING_BILLS_EXTRACT_KEYS[key])) {
    return { ok: false, reason: 'unexpected fields' };
  }
  const hasKey = keys.includes('referentKey');
  const hasLabel = keys.includes('billLabel');
  if (hasKey && hasLabel) return { ok: false, reason: 'unexpected fields' };
  if (hasKey) {
    if (typeof parsed.referentKey !== 'string'
        || !REMAINING_BILLS_REFERENT_KEYS[parsed.referentKey]) {
      return { ok: false, reason: 'invalid referentKey' };
    }
    return {
      ok: true,
      intent: REMAINING_BILLS_INTENT,
      referentKey: parsed.referentKey,
    };
  }
  if (hasLabel) {
    if (typeof parsed.billLabel !== 'string' || !parsed.billLabel.trim()) {
      return { ok: false, reason: 'invalid billLabel' };
    }
    const billLabel = clipText(parsed.billLabel, LABEL_MAX);
    if (!billLabel) return { ok: false, reason: 'invalid billLabel' };
    return {
      ok: true,
      intent: REMAINING_BILLS_INTENT,
      billLabel,
    };
  }
  return { ok: true, intent: REMAINING_BILLS_INTENT };
}

function resolvePaydayLeftover({ question, priorTurn, extract }) {
  const prior = priorTurn && typeof priorTurn === 'object' ? priorTurn : null;
  if (extract && extract.ok && extract.intent === LEFTOVER_INTENT) {
    if (extract.referentKey === 'last-presented' || extract.referentKey === 'pay-period') {
      return leftoverReference(true, prior);
    }
    return leftoverReference(false, prior);
  }
  const kind = classifyVerifiedFollowup(question);
  if (kind === 'payday-leftover') return leftoverReference(false, prior);
  if (kind === 'payday-leftover-deixis') return leftoverReference(true, prior);
  return { status: 'none' };
}

function resolvePaydayPicture({ question, extract }) {
  if (extract && extract.ok && extract.intent === PAYDAY_PICTURE_INTENT) {
    return paydayPictureReference();
  }
  const kind = classifyVerifiedFollowup(question);
  if (kind === 'payday-picture') return paydayPictureReference();
  return { status: 'none' };
}

function resolvePaydayRemainingBills({ question, priorTurn, packet, extract }) {
  const prior = priorTurn && typeof priorTurn === 'object' ? priorTurn : null;
  if (extract && extract.ok && extract.intent === REMAINING_BILLS_INTENT) {
    if (extract.referentKey === 'last-presented') {
      const deixis = remainingBillsDeixis(prior, packet);
      return deixis.status === 'none'
        ? { status: 'ambiguous', nature: 'reference' }
        : deixis;
    }
    if (extract.referentKey === 'covered') {
      return remainingBillsReference('covered', null, packet);
    }
    if (extract.billLabel) {
      return remainingBillsReference('named', extract.billLabel, packet);
    }
    return remainingBillsReference('remaining', null, packet);
  }
  const kind = classifyVerifiedFollowup(question);
  if (kind === 'payday-remaining-bills') {
    return remainingBillsReference('remaining', null, packet);
  }
  if (kind === 'payday-remaining-bills-covered') {
    return remainingBillsReference('covered', null, packet);
  }
  if (kind === 'payday-named-bill') {
    return remainingBillsReference('named', namedBillLabelFromQuestion(question), packet);
  }
  if (kind === 'last-presented-one') {
    return remainingBillsDeixis(prior, packet);
  }
  return { status: 'none' };
}

function resolveVerifiedReference({ question, priorTurn, packet }) {
  const kind = classifyVerifiedFollowup(question);
  if (!kind) return { status: 'none' };
  const prior = priorTurn && typeof priorTurn === 'object' ? priorTurn : null;

  if (kind === 'payday-picture') {
    return paydayPictureReference();
  }

  if (kind === 'payday-leftover') {
    return leftoverReference(false, prior);
  }

  if (kind === 'payday-leftover-deixis') {
    return leftoverReference(true, prior);
  }

  if (kind === 'payday-remaining-bills') {
    return remainingBillsReference('remaining', null, packet);
  }

  if (kind === 'payday-remaining-bills-covered') {
    return remainingBillsReference('covered', null, packet);
  }

  if (kind === 'payday-named-bill') {
    return remainingBillsReference('named', namedBillLabelFromQuestion(question), packet);
  }

  if (kind === 'last-presented-one') {
    const thatOne = remainingBillsDeixis(prior, packet);
    if (thatOne.status !== 'none') return thatOne;
  }

  if (kind === 'next-payday') {
    if (priorHasReferentKey(prior, 'next-payday') || priorHasReferentKey(prior, 'pay-period')) {
      return {
        status: 'resolved-reference',
        paths: FOLLOWUP_KEY_PATHS['next-payday'].slice(),
        referentKey: 'next-payday',
      };
    }
    return { status: 'ambiguous', nature: 'reference' };
  }

  if (kind === 'card') {
    const facility = uniqueFacilityFollowup(prior, packet);
    if (facility.ok) {
      return {
        status: 'resolved-reference',
        paths: facility.paths,
        referentKey: 'card',
      };
    }
    return { status: 'ambiguous', nature: 'reference' };
  }

  if (kind === 'interest') {
    if (prior && (prior.kind === 'comparison' || prior.priorKind === 'comparison')) {
      return { status: 'ambiguous', nature: 'reference' };
    }
    if (prior && finiteAmount(prior.amount)
        && typeof prior.debtId === 'string' && prior.debtId
        && typeof prior.debtLabel === 'string' && prior.debtLabel
        && (prior.kind === 'hypothetical' || prior.priorKind === 'hypothetical')) {
      return {
        status: 'resolved-hypothetical',
        amount: prior.amount,
        debtId: prior.debtId,
        debtLabel: prior.debtLabel,
      };
    }
    if (priorHasReferentKey(prior, 'interest')) {
      return {
        status: 'resolved-reference',
        paths: FOLLOWUP_KEY_PATHS.interest.slice(),
        referentKey: 'interest',
      };
    }
    return { status: 'ambiguous', nature: 'reference' };
  }

  const paths = sanitizeReferentPaths(prior && prior.referentPaths);
  if (paths.length) {
    return {
      status: 'resolved-reference',
      paths,
      referentKey: 'last-presented',
    };
  }
  return { status: 'ambiguous', nature: 'reference' };
}

function sanitizeAsOf(value) {
  if (typeof value !== 'string' || !value || value.length > ASOF_MAX) return '';
  if (/[\\/]/.test(value) || /\.env\b|raw|derived|secret/i.test(value)) return '';
  return value;
}

function sanitizeFreshness(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value === 'verified' || value === 'current') return '';
  return FRESHNESS_TAGS[value] ? value : '';
}

function attachTurnProvenance(turn, raw) {
  const asOf = sanitizeAsOf(raw && raw.asOf);
  if (asOf) turn.asOf = asOf;
  const freshness = sanitizeFreshness(raw && raw.freshness);
  if (freshness) turn.freshness = freshness;
  return turn;
}

function sanitizeScenario(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (!finiteAmount(row.amount)) return null;
  const debtId = clipText(row.debtId, LABEL_MAX);
  const debtLabel = clipText(row.debtLabel, LABEL_MAX);
  if (!debtId || !debtLabel) return null;
  return { amount: row.amount, debtId, debtLabel };
}

function sanitizeTurn(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = raw.kind;
  if (kind !== 'explained' && kind !== 'hypothetical' && kind !== 'comparison'
      && kind !== 'unavailable' && kind !== 'why') {
    return null;
  }
  const question = clipText(raw.question, QUESTION_MAX);
  if (!question) return null;
  const turn = {
    kind,
    question,
    presented: clipText(raw.presented, PRESENTED_MAX),
  };
  const referentPaths = sanitizeReferentPaths(raw.referentPaths);
  if (referentPaths.length) turn.referentPaths = referentPaths;
  const referentKeys = sanitizeReferentKeys(
    (Array.isArray(raw.referentKeys) ? raw.referentKeys : [])
      .concat(bindReferentKeysFromPaths(referentPaths).keys)
  );
  if (referentKeys.length) turn.referentKeys = referentKeys;
  if (referentKeys.includes(REMAINING_BILLS_INTENT)) {
    const billId = clipText(raw.billId, LABEL_MAX);
    const billLabel = clipText(raw.billLabel, LABEL_MAX);
    if (billId) turn.billId = billId;
    if (billLabel) turn.billLabel = billLabel;
  }
  if (kind === 'why' && (raw.priorKind === 'hypothetical' || raw.priorKind === 'comparison')) {
    turn.priorKind = raw.priorKind;
  }
  if (kind === 'hypothetical' || (kind === 'why' && raw.priorKind === 'hypothetical')) {
    if (!finiteAmount(raw.amount)) return null;
    const debtId = clipText(raw.debtId, LABEL_MAX);
    const debtLabel = clipText(raw.debtLabel, LABEL_MAX);
    if (!debtId || !debtLabel) return null;
    turn.amount = raw.amount;
    turn.debtId = debtId;
    turn.debtLabel = debtLabel;
  }
  if (kind === 'comparison' || (kind === 'why' && raw.priorKind === 'comparison')) {
    if (!Array.isArray(raw.scenarios) || raw.scenarios.length < 2
        || raw.scenarios.length > SCENARIO_MAX) {
      return null;
    }
    const scenarios = [];
    for (const row of raw.scenarios) {
      const clean = sanitizeScenario(row);
      if (!clean) return null;
      scenarios.push(clean);
    }
    turn.scenarios = scenarios;
  }
  return attachTurnProvenance(turn, raw);
}

function publicConversation(turns) {
  if (!Array.isArray(turns)) return [];
  const out = [];
  for (const turn of turns) {
    const question = clipText(turn && turn.question, QUESTION_MAX);
    if (!question) continue;
    out.push({
      question,
      presented: clipText(turn && turn.presented, PRESENTED_MAX),
    });
  }
  return out;
}

function lastTurn(turns) {
  if (!Array.isArray(turns) || !turns.length) return null;
  return turns[turns.length - 1] || null;
}

function currentDebtStillLive(debts, packet, debtId, debtLabel) {
  const resolved = TalkHypothetical.resolveDebtLabel(debtLabel, debts, packet);
  if (resolved.ok && resolved.debtId === debtId) return true;
  const targets = TalkHypothetical.recoverCallerDebtTargets(debtLabel, debts, packet);
  return targets.length === 1 && targets[0] === debtId;
}

function incompleteExtraShape(amountCount, targetCount) {
  return (amountCount === 1 && targetCount === 0)
    || (amountCount === 0 && targetCount === 1);
}

function maskSpans(text, spans) {
  if (!Array.isArray(spans) || !spans.length) return text;
  const chars = String(text).split('');
  for (const span of spans) {
    const start = span && Number.isFinite(span.start) ? span.start : -1;
    const end = span && Number.isFinite(span.end) ? span.end : -1;
    if (start < 0 || end <= start) continue;
    for (let i = start; i < end && i < chars.length; i += 1) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

function authorizedFollowupGrammar(question, debts, packet) {
  if (typeof question !== 'string' || !question.trim()) return false;
  if (!FOLLOWUP_INTENT_RE.test(question)) return false;
  const spans = TalkHypothetical.recoverCallerAmountOccurrences(question)
    .concat(TalkHypothetical.recoverCallerDebtTargetOccurrences(question, debts, packet));
  const words = maskSpans(question, spans).toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.every(word => AUTHORIZED_FOLLOWUP_WORDS.has(word));
}

function looksLikeIncompleteExtra(question, amountCount, targetCount, debts, packet) {
  if (!incompleteExtraShape(amountCount, targetCount)) return false;
  if (!authorizedFollowupGrammar(question, debts, packet)) return false;
  if (amountCount === 1 && targetCount === 0) {
    return FOLLOWUP_DEIXIS_RE.test(question) || EXTRA_LANGUAGE_RE.test(question);
  }
  return EXTRA_LANGUAGE_RE.test(question);
}

function comparisonIdentity(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length < 2) return '';
  const rows = [];
  for (const row of scenarios) {
    if (!row || !finiteAmount(row.amount) || typeof row.debtId !== 'string' || !row.debtId) {
      return '';
    }
    rows.push(`${row.debtId}:${row.amount}`);
  }
  return rows.slice().sort().join('|');
}

function comparisonTurnsFrom(priorTurns, priorTurn) {
  const list = Array.isArray(priorTurns) && priorTurns.length
    ? priorTurns
    : (priorTurn ? [priorTurn] : []);
  const out = [];
  for (const turn of list) {
    if (!turn || typeof turn !== 'object') continue;
    const scenarios = Array.isArray(turn.scenarios) ? turn.scenarios : null;
    if ((turn.kind === 'comparison' || turn.priorKind === 'comparison')
        && scenarios && scenarios.length >= 2) {
      out.push(turn);
    }
  }
  return out;
}

function emptyComparisonState() {
  return { becameAmbiguous: false, soleIdentity: '' };
}

function noteComparisonState(state, turn) {
  const next = state && typeof state === 'object'
    ? {
      becameAmbiguous: state.becameAmbiguous === true,
      soleIdentity: typeof state.soleIdentity === 'string' ? state.soleIdentity : '',
    }
    : emptyComparisonState();
  if (next.becameAmbiguous) {
    next.soleIdentity = '';
    return next;
  }
  if (!turn || typeof turn !== 'object') return next;
  const isComparison = turn.kind === 'comparison' || turn.priorKind === 'comparison';
  if (!isComparison || !Array.isArray(turn.scenarios) || turn.scenarios.length < 2) {
    return next;
  }
  if (turn.scenarios.length !== 2) {
    return { becameAmbiguous: true, soleIdentity: '' };
  }
  const id = comparisonIdentity(turn.scenarios);
  if (!id) return { becameAmbiguous: true, soleIdentity: '' };
  if (!next.soleIdentity) {
    next.soleIdentity = id;
    return next;
  }
  if (next.soleIdentity !== id) {
    return { becameAmbiguous: true, soleIdentity: '' };
  }
  return next;
}

function publicSessionComparison(state) {
  return { becameAmbiguous: !!(state && state.becameAmbiguous) };
}

function sessionComparisonBecameAmbiguous(sessionComparison) {
  return !!(sessionComparison && sessionComparison.becameAmbiguous);
}

function resolveWhichOnePreference({
  question, priorTurn, priorTurns, debts, packet, sessionComparison,
}) {
  if (!TalkHypothetical.questionAsksWhichOneReferent(question)) {
    return { status: 'none' };
  }
  const amounts = TalkHypothetical.recoverCallerAmounts(question);
  const targets = TalkHypothetical.recoverCallerDebtTargets(question, debts, packet);
  if (amounts.length || targets.length) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  if (sessionComparisonBecameAmbiguous(sessionComparison)) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  const turns = comparisonTurnsFrom(priorTurns, priorTurn);
  if (!turns.length) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  const seen = Object.create(null);
  const identities = [];
  for (const turn of turns) {
    if (!Array.isArray(turn.scenarios) || turn.scenarios.length !== 2) {
      return { status: 'ambiguous', nature: 'comparison' };
    }
    const id = comparisonIdentity(turn.scenarios);
    if (!id) return { status: 'ambiguous', nature: 'comparison' };
    if (!seen[id]) {
      seen[id] = turn;
      identities.push(id);
    }
  }
  if (identities.length !== 1) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  const last = priorTurn && typeof priorTurn === 'object' ? priorTurn : null;
  if (!last || (last.kind !== 'comparison' && last.priorKind !== 'comparison')) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  if (comparisonIdentity(last.scenarios) !== identities[0]
      || !Array.isArray(last.scenarios) || last.scenarios.length !== 2) {
    return { status: 'ambiguous', nature: 'comparison' };
  }
  const earned = seen[identities[0]];
  const live = [];
  for (const row of earned.scenarios) {
    if (!currentDebtStillLive(debts, packet, row.debtId, row.debtLabel)) {
      return { status: 'ambiguous', nature: 'comparison' };
    }
    live.push({
      amount: row.amount,
      debtId: row.debtId,
      debtLabel: row.debtLabel,
    });
  }
  if (live.length !== 2) return { status: 'ambiguous', nature: 'comparison' };
  return { status: 'resolved-preference', scenarios: live };
}

function resolveFollowup({ question, priorTurn, debts, packet, priorTurns, sessionComparison }) {
  const parsed = typeof question === 'string' ? question.trim() : '';
  if (!parsed) return { status: 'none' };

  const amounts = TalkHypothetical.recoverCallerAmounts(parsed);
  const targets = TalkHypothetical.recoverCallerDebtTargets(parsed, debts, packet);
  const completeSingle = amounts.length === 1 && targets.length === 1;
  const recoveredPairs = TalkHypothetical.recoverCallerScenarioPairs(parsed, debts, packet);
  const plannerAct = TalkHypothetical.questionIsPlannerActComparison(parsed);
  const wantsPreference = TalkHypothetical.questionAsksAuthorizedPreference(parsed);
  const compareAsk = COMPARISON_FOLLOWUP_RE.test(parsed);
  const authorizedFollowup = authorizedFollowupGrammar(parsed, debts, packet);

  if (recoveredPairs.ok) {
    return { status: 'none' };
  }
  if (completeSingle && !compareAsk) {
    return { status: 'none' };
  }

  if (plannerAct && !wantsPreference && incompleteExtraShape(amounts.length, targets.length)) {
    return { status: 'ambiguous', nature: 'hypothetical' };
  }

  const prior = priorTurn && typeof priorTurn === 'object' ? priorTurn : null;

  if (TalkHypothetical.questionAsksWhichOneReferent(parsed)) {
    return resolveWhichOnePreference({
      question: parsed,
      priorTurn: prior,
      priorTurns,
      debts,
      packet,
      sessionComparison,
    });
  }

  if (wantsPreference
      && prior && prior.kind === 'comparison'
      && Array.isArray(prior.scenarios) && prior.scenarios.length >= 2
      && amounts.length === 0
      && (targets.length === 0
        || prior.scenarios.every(row => targets.includes(row.debtId)
          || TalkHypothetical.recoverCallerDebtTargets(row.debtLabel, debts, packet)
            .some(id => targets.includes(id))))) {
    const live = [];
    for (const row of prior.scenarios) {
      if (!currentDebtStillLive(debts, packet, row.debtId, row.debtLabel)) {
        return { status: 'ambiguous', nature: 'comparison' };
      }
      live.push({
        amount: row.amount,
        debtId: row.debtId,
        debtLabel: row.debtLabel,
      });
    }
    return { status: 'resolved-preference', scenarios: live };
  }

  if (compareAsk && prior && prior.kind === 'hypothetical'
      && amounts.length === 1 && targets.length === 1
      && currentDebtStillLive(debts, packet, prior.debtId, prior.debtLabel)) {
    const newId = targets[0];
    const newLabel = findLabelForDebt(newId, debts, packet);
    if (!currentDebtStillLive(debts, packet, newId, newLabel)) {
      return { status: 'ambiguous', nature: 'comparison' };
    }
    if (prior.debtId === newId && prior.amount === amounts[0]) {
      return { status: 'ambiguous', nature: 'comparison' };
    }
    return {
      status: 'resolved-comparison',
      scenarios: [
        {
          amount: prior.amount,
          debtId: prior.debtId,
          debtLabel: prior.debtLabel,
        },
        {
          amount: amounts[0],
          debtId: newId,
          debtLabel: newLabel,
        },
      ],
    };
  }

  if (compareAsk) {
    return { status: 'ambiguous', nature: 'comparison' };
  }

  if (amounts.length === 1 && targets.length === 0
      && authorizedFollowup
      && prior && prior.kind === 'hypothetical'
      && currentDebtStillLive(debts, packet, prior.debtId, prior.debtLabel)) {
    return {
      status: 'resolved-hypothetical',
      amount: amounts[0],
      debtId: prior.debtId,
      debtLabel: prior.debtLabel,
    };
  }

  if (amounts.length === 0 && targets.length === 1
      && authorizedFollowup && !compareAsk
      && prior && prior.kind === 'hypothetical'
      && finiteAmount(prior.amount)) {
    const newId = targets[0];
    const newLabel = findLabelForDebt(newId, debts, packet);
    if (!currentDebtStillLive(debts, packet, newId, newLabel)) {
      return { status: 'ambiguous', nature: 'hypothetical' };
    }
    return {
      status: 'resolved-hypothetical',
      amount: prior.amount,
      debtId: newId,
      debtLabel: newLabel,
    };
  }

  if (looksLikeIncompleteExtra(parsed, amounts.length, targets.length, debts, packet)) {
    return { status: 'ambiguous', nature: 'hypothetical' };
  }

  if (wantsPreference && (!prior || prior.kind !== 'comparison')) {
    return { status: 'ambiguous', nature: 'comparison' };
  }

  const verified = resolveVerifiedReference({
    question: parsed,
    priorTurn: prior,
    packet,
  });
  if (verified.status !== 'none') return verified;

  return { status: 'none' };
}

function findLabelForDebt(debtId, debts, packet) {
  const list = Array.isArray(debts) ? debts : [];
  for (const debt of list) {
    if (debt && debt.id === debtId && typeof debt.label === 'string' && debt.label) {
      return debt.label;
    }
  }
  const facilities = packet
    && packet.current
    && packet.current.debts
    && packet.current.debts.facilities;
  if (Array.isArray(facilities)) {
    for (const row of facilities) {
      if (row && row.id === debtId && typeof row.label === 'string' && row.label) {
        return row.label;
      }
    }
  }
  return debtId;
}

function sessionTurnFromHypothetical(result, provenance) {
  if (!result || result.status !== 'ready' || !result.input) {
    return { kind: 'unavailable' };
  }
  const amount = result.input.amount;
  const debtId = clipText(result.input.debtId, LABEL_MAX);
  const debtLabel = clipText(result.input.debtLabel, LABEL_MAX);
  if (!finiteAmount(amount) || !debtId || !debtLabel) return { kind: 'unavailable' };
  const fromResult = result.input && result.input.asOf;
  return attachTurnProvenance({
    kind: 'hypothetical',
    amount,
    debtId,
    debtLabel,
    referentKeys: ['interest'],
  }, {
    asOf: (provenance && provenance.asOf) || fromResult,
    freshness: provenance && provenance.freshness,
  });
}

function sessionTurnFromRemainingBills(resolved) {
  if (!resolved || resolved.status !== 'resolved-reference'
      || resolved.referentKey !== REMAINING_BILLS_INTENT) {
    return { kind: 'unavailable' };
  }
  const turn = {
    kind: 'explained',
    referentKeys: [REMAINING_BILLS_INTENT],
  };
  const billId = clipText(resolved.billId, LABEL_MAX);
  const billLabel = clipText(resolved.billLabel, LABEL_MAX);
  if (billId) turn.billId = billId;
  if (billLabel) turn.billLabel = billLabel;
  return turn;
}

function sessionTurnFromComparison(result, provenance) {
  if (!result || result.status !== 'ready' || !Array.isArray(result.scenarios)) {
    return { kind: 'unavailable' };
  }
  const scenarios = [];
  for (const row of result.scenarios) {
    const clean = sanitizeScenario(row && row.input);
    if (!clean) return { kind: 'unavailable' };
    scenarios.push(clean);
  }
  if (scenarios.length < 2) return { kind: 'unavailable' };
  const fromResult = result.baseline && result.baseline.asOf;
  return attachTurnProvenance({ kind: 'comparison', scenarios }, {
    asOf: (provenance && provenance.asOf) || fromResult,
    freshness: provenance && provenance.freshness,
  });
}

function createSessionContext(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const secret = opts.secret;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : TTL_MS;
  const maxTurns = Number.isFinite(opts.maxTurns) ? opts.maxTurns : MAX_TURNS;
  const maxSessions = Number.isFinite(opts.maxSessions) ? opts.maxSessions : MAX_SESSIONS;
  const map = new Map();

  function prune(now) {
    for (const [key, rec] of map.entries()) {
      if (!rec || now - rec.updatedAt > ttlMs) map.delete(key);
    }
    while (map.size > maxSessions) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, rec] of map.entries()) {
        if (rec.updatedAt < oldestAt) {
          oldestAt = rec.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey == null) break;
      map.delete(oldestKey);
    }
  }

  function keyFromToken(token) {
    return hmacKey(secret, token);
  }

  function turns(key) {
    if (typeof key !== 'string' || !key) return [];
    const now = nowFn();
    prune(now);
    const rec = map.get(key);
    if (!rec) return [];
    if (now - rec.updatedAt > ttlMs) {
      map.delete(key);
      return [];
    }
    return rec.turns.slice();
  }

  function append(key, raw) {
    if (typeof key !== 'string' || !key) return false;
    const turn = sanitizeTurn(raw);
    if (!turn) return false;
    const now = nowFn();
    prune(now);
    const rec = map.get(key) || {
      turns: [],
      updatedAt: now,
      comparisonState: emptyComparisonState(),
    };
    rec.comparisonState = noteComparisonState(rec.comparisonState, turn);
    rec.turns = rec.turns.concat([turn]).slice(-maxTurns);
    rec.updatedAt = now;
    map.set(key, rec);
    prune(now);
    return true;
  }

  function sessionComparison(key) {
    if (typeof key !== 'string' || !key) return publicSessionComparison(null);
    const now = nowFn();
    prune(now);
    const rec = map.get(key);
    if (!rec) return publicSessionComparison(null);
    if (now - rec.updatedAt > ttlMs) {
      map.delete(key);
      return publicSessionComparison(null);
    }
    return publicSessionComparison(rec.comparisonState);
  }

  function clear(key) {
    if (typeof key !== 'string' || !key) return;
    map.delete(key);
  }

  return {
    keyFromToken,
    turns,
    append,
    sessionComparison,
    clear,
    publicConversation,
    sessionCount() {
      prune(nowFn());
      return map.size;
    },
  };
}

module.exports = {
  MAX_TURNS,
  MAX_SESSIONS,
  TTL_MS,
  QUESTION_MAX,
  PRESENTED_MAX,
  LEFTOVER_INTENT,
  LEFTOVER_PATH,
  PAYDAY_PICTURE_INTENT,
  PAYDAY_PICTURE_PATHS,
  REMAINING_BILLS_INTENT,
  createSessionContext,
  resolveFollowup,
  resolveVerifiedReference,
  resolvePaydayLeftover,
  resolvePaydayPicture,
  resolvePaydayRemainingBills,
  parseLeftoverExtract,
  parsePaydayPictureExtract,
  parseRemainingBillsExtract,
  bindReferentKeysFromPaths,
  classifyVerifiedFollowup,
  FOLLOWUP_REFERENT_KEYS,
  FOLLOWUP_KEY_PATHS,
  publicConversation,
  lastTurn,
  sessionTurnFromHypothetical,
  sessionTurnFromComparison,
  sessionTurnFromRemainingBills,
  hmacKey,
};
