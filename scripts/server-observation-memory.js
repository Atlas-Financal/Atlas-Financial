'use strict';
// One private process-local complete-cohort slot. Current source evidence and
// dated display are separate read capabilities, never a canonical store, planner,
// credential store or restart/deploy survival promise.
const { isDeepStrictEqual } = require('node:util');
const Forecast = require('../public/forecast');
const SCHEMA = 'atlas-provider-observation-memory/v1';
const ACCOUNT = 'id name display_name institution_name institution type subtype type_name currency balance available_balance available credit_limit limit updated_at balance_as_of balance_last_update date_last_fetched last_fetch plaid_last_successful_update status'.split(' ');
const CATEGORY = 'id name display_name is_income exclude_from_totals exclude_from_budget is_group is_group_parent archived is_archived group_id'.split(' ');
// Keep the recurring source identity already consumed by the observer. Dropping
// it changes replay evidence and defeats exact-input Forecast reuse.
const TRANSACTION = 'id account_id plaid_account_id manual_account_id date amount currency payee original_name originalName notes note external_id externalId pending_transaction_id pendingTransactionId plaid_id plaidId plaidTransactionId plaidPendingTransactionId is_group is_group_parent has_children parent_id group_parent_id recurring_id is_pending status kind mcc plaid_mcc category_id category_name categoryName is_income exclude_from_totals exclude_from_budget contradictoryEvidence confirmedSettlement'.split(' ');
const WINDOW = 'startDate endDate complete hasMore truncated'.split(' ');
const PENDING = [...WINDOW, 'basis'];
function pick(row, fields) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('observation-input-invalid');
  const out = {};
  for (const field of fields) if (Object.hasOwn(row, field)) {
    const value = row[field];
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value)) throw new Error('observation-input-invalid');
    out[field] = value;
  }
  return out;
}
function tag(value) {
  if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) || value === null) return value;
  return pick(value, ['id', 'name', 'label']);
}
function category(row) {
  const out = pick(row, CATEGORY);
  if (Object.hasOwn(row, 'children')) out.children = row.children.map(category);
  return out;
}
// Lunch Money recurring items (S1): only the schedule fields the observer's
// sanitizer reads (scripts/provider-observe.js sanitizedRecurringEvidence),
// plus the match dates stampLunchMoneyMatched reads (S3).
// No description, payee, overrides, amount or provenance is retained.
// amount: the item's expected amount per occurrence, which the cadence
// consistency check reads (#1289); never a served amount.
const RECURRING_CRITERIA = 'startDate endDate granularity quantity anchorDate currency amount plaidAccountId manualAccountId'.split(' ');
function recurring(value) {
  if (value?.status !== 'read') return { status: 'unavailable', reason: 'recurring-read-failed' };
  const read = value.read;
  if (!read || typeof read !== 'object' || !Array.isArray(read.items)) throw new Error('observation-input-invalid');
  const strings = list => list === null ? null : list.map(entry => {
    if (typeof entry !== 'string') throw new Error('observation-input-invalid');
    return entry;
  });
  return { status: 'read', read: {
    unexpectedPaginationEvidence: read.unexpectedPaginationEvidence,
    requestedWindow: pick(read.requestedWindow, ['startDate', 'endDate', 'providerDefault']),
    items: read.items.map(item => ({ ...pick(item, ['providerId', 'status']),
      unavailableFields: strings(item.unavailableFields),
      criteria: item.criteria === null ? null : pick(item.criteria, RECURRING_CRITERIA),
      matches: item.matches === null ? null : {
        expectedOccurrenceDates: Array.isArray(item.matches.expectedOccurrenceDates)
          ? strings(item.matches.expectedOccurrenceDates) : null,
        // S3 (LM-matched settlement): the found date and the missing dates
        // decide which occurrences Lunch Money matched; dates and ids only.
        foundTransactions: Array.isArray(item.matches.foundTransactions)
          ? item.matches.foundTransactions.map(found => pick(found, ['date', 'transactionId'])) : null,
        missingTransactionDates: Array.isArray(item.matches.missingTransactionDates)
          ? strings(item.matches.missingTransactionDates) : null,
      } })) } };
}
// Lunch Money budgets (PR A, #821 2026-11-18): only the fields the observer's
// budget reader consumes -- the period settings, and per category its id and
// each period's dates and `budgeted`. Activity, notes and currency text are
// never retained. Any read that is not a clean 'read' replays as unavailable.
const BUDGET_SETTINGS = ['budget_period_granularity', 'budget_period_quantity', 'budget_period_anchor_date'];
// A read budget block keeps its read status even when malformed, so the
// observer's sanitizer gives a replay the same reason as the live read
// (budget-settings-invalid / budget-summary-invalid), not a generic failure.
function budgets(value) {
  if (value?.status !== 'read') return { status: 'unavailable', reason: 'budget-read-failed' };
  const settings = value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)
    ? pick(value.settings, BUDGET_SETTINGS) : null;
  const rows = value.summary && value.summary.categories;
  return { status: 'read', settings, summary: { categories: Array.isArray(rows)
    ? rows.filter(row => row && typeof row === 'object').map(row => ({
      category_id: row.category_id,
      occurrences: Array.isArray(row.occurrences)
        ? row.occurrences.filter(o => o && typeof o === 'object').map(o => pick(o, ['start_date', 'end_date', 'budgeted']))
        : null,
    })) : null } };
}
// The fixed-amount derivation record (#1355): only its outcome -- source,
// status, the history window's dates and the derived bill and obligation ids. The 200-day
// history rows themselves are never retained. Anything not in exactly this
// clean shape replays as unavailable, so it fixes no bill.
function amountFixedDerivation(value) {
  const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const window = value && value.window;
  const clean = value && typeof value === 'object' && value.source === 'lunchmoney-payment-history'
    && value.status === 'complete' && window && day(window.startDate) && day(window.endDate)
    && Array.isArray(value.billIds) && value.billIds.every(id => typeof id === 'string' && id.length > 0)
    && (value.obligationIds === undefined || (Array.isArray(value.obligationIds)
      && value.obligationIds.every(id => typeof id === 'string' && id.length > 0)));
  if (!clean) return { source: 'lunchmoney-payment-history', status: 'unavailable', window: null, billIds: [], obligationIds: [] };
  return { source: value.source, status: 'complete', window: { startDate: window.startDate, endDate: window.endDate },
    billIds: Array.from(new Set(value.billIds)).sort(),
    obligationIds: Array.from(new Set(value.obligationIds || [])).sort() };
}
// The bill sheet's payment history (Dale, 2026-11-18): per plan row only its id
// and its payments' dates and amounts, the six month keys and the read date.
// Anything not in exactly this clean shape replays as unavailable.
const BILL_HISTORY_REASONS = new Set(['history-unavailable', 'history-incomplete', 'history-too-short']);
function billPaymentHistory(value) {
  const day = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
  const month = v => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
  const cents = v => typeof v === 'number' && Number.isFinite(v) && v > 0 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
  const unavailable = reason => ({ source: 'lunchmoney-payment-history', status: 'unavailable',
    reason: BILL_HISTORY_REASONS.has(reason) ? reason : 'history-unavailable', asOf: null, months: [], bills: [] });
  if (!value || typeof value !== 'object' || value.source !== 'lunchmoney-payment-history') return unavailable();
  if (value.status !== 'complete') return unavailable(value.reason);
  const months = value.months;
  const ids = new Set();
  const cleanBill = row => {
    if (!row || typeof row !== 'object' || typeof row.billId !== 'string' || !row.billId || ids.has(row.billId)
      || !Array.isArray(row.payments)) return null;
    ids.add(row.billId);
    if (row.status === 'unavailable') return ['paid-in-parts', 'duplicate-record'].includes(row.reason) && row.payments.length === 0
      ? { billId: row.billId, status: 'unavailable', reason: row.reason, payments: [] } : null;
    if (row.status !== 'complete' || !row.payments.every(p => p && day(p.date) && cents(p.amount)
      && months.includes(p.date.slice(0, 7)) && p.date <= value.asOf)) return null;
    if ((row.excludedAmbiguous === undefined) !== (row.excludedAmbiguousMonths === undefined)) return null;
    if (row.excludedAmbiguous !== undefined && !(Number.isInteger(row.excludedAmbiguous) && row.excludedAmbiguous > 0
      && Array.isArray(row.excludedAmbiguousMonths) && row.excludedAmbiguousMonths.length > 0
      && row.excludedAmbiguousMonths.length <= row.excludedAmbiguous
      && row.excludedAmbiguousMonths.every((m, i, all) => months.includes(m) && (i === 0 || m > all[i - 1])))) return null;
    return { billId: row.billId, status: 'complete',
      payments: row.payments.map(p => ({ date: p.date, amount: p.amount })),
      ...(row.excludedAmbiguous !== undefined
        ? { excludedAmbiguous: row.excludedAmbiguous, excludedAmbiguousMonths: row.excludedAmbiguousMonths.slice() } : {}) };
  };
  if (!day(value.asOf) || !Array.isArray(months) || months.length !== 6 || !months.every(month)
    || months[5] !== value.asOf.slice(0, 7) || !months.every((m, i) => i === 0 || m > months[i - 1])
    || !Array.isArray(value.bills)) return unavailable();
  const bills = value.bills.map(cleanBill);
  if (bills.some(row => !row)) return unavailable();
  return { source: value.source, status: 'complete', asOf: value.asOf, months: months.slice(), bills };
}
// A group parent's children: only their ids, account ids and parent id
// (provider-observe groupParentAccountId). No payee, note, amount or metadata.
const CHILD_ACCOUNT = ['id', 'plaid_account_id', 'manual_account_id', 'group_parent_id'];
function transaction(row) {
  const out = pick(row, TRANSACTION);
  if (Object.hasOwn(row, 'children')) {
    if (!Array.isArray(row.children)) throw new Error('observation-input-invalid');
    out.children = row.children.map(child => pick(child, CHILD_ACCOUNT));
  }
  for (const field of ['tags', 'tag_ids', 'tagIds']) if (Object.hasOwn(row, field)) {
    out[field] = row[field] === null ? null : row[field].map(tag);
  }
  // Preserve only the settlement source IDs the incumbent observer consumes.
  // Never retain arbitrary provider metadata (including unexpected secrets).
  for (const field of ['plaid_metadata', 'plaidMetadata']) if (Object.hasOwn(row, field)) {
    let value = row[field];
    const encoded = typeof value === 'string';
    if (encoded) value = JSON.parse(value);
    if (value === null) out[field] = null;
    else {
      const ids = ['transaction_id', 'transactionId', 'pending_transaction_id', 'pendingTransactionId'];
      const meta = pick(value, ids);
      if (Object.hasOwn(value, 'transaction')) meta.transaction = pick(value.transaction, ids);
      out[field] = encoded ? JSON.stringify(meta) : meta;
    }
  }
  return out;
}
function provedPayerReceipts(value) {
  if (!Array.isArray(value)) throw new Error('observation-input-invalid');
  const cards = new Set(['cashback', 'travelvisa', 'tdcc', 'triangle', 'mbna', 'heloc']);
  return value.map(proof => {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('observation-input-invalid');
    const allowed = ['coverageRef', 'id', 'account', 'amountCents', 'cardId', 'trust', 'reason'];
    if (Object.keys(proof).some(key => !allowed.includes(key))) throw new Error('observation-input-invalid');
    const coverageRef = proof.coverageRef;
    const id = proof.id;
    const hasRef = typeof coverageRef === 'string' && /^pc-[a-f0-9]{24}$/.test(coverageRef);
    const hasId = typeof id === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(id);
    if ((coverageRef != null && !hasRef) || (id != null && !hasId) || (!hasRef && !hasId)) {
      throw new Error('observation-input-invalid');
    }
    if (typeof proof.account !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(proof.account)) {
      throw new Error('observation-input-invalid');
    }
    if (!Number.isSafeInteger(proof.amountCents) || proof.amountCents === 0) throw new Error('observation-input-invalid');
    if (!cards.has(proof.cardId)) throw new Error('observation-input-invalid');
    if (proof.trust !== 'calculated' && proof.trust !== 'estimated') throw new Error('observation-input-invalid');
    if (proof.reason != null && (typeof proof.reason !== 'string' || !/^[a-z0-9-]{1,80}$/.test(proof.reason))) {
      throw new Error('observation-input-invalid');
    }
    const out = { account: proof.account, amountCents: proof.amountCents, cardId: proof.cardId, trust: proof.trust };
    if (hasRef) out.coverageRef = coverageRef;
    if (hasId) out.id = id;
    if (proof.reason) out.reason = proof.reason;
    return out;
  });
}
function sourceInputs(payload) {
  if (payload?.provider !== 'lunchmoney' || typeof payload.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.fetchedAt))) throw new Error('observation-input-invalid');
  const out = { provider: 'lunchmoney', fetchedAt: payload.fetchedAt,
    accounts: payload.accounts.map(row => pick(row, ACCOUNT)),
    categories: payload.categories.map(category), tags: payload.tags.map(tag),
    transactions: payload.transactions.map(transaction),
    transactionWindow: pick(payload.transactionWindow, WINDOW),
    pendingCoverage: pick(payload.pendingCoverage, PENDING),
    ...(Object.hasOwn(payload, 'recurringItems') ? { recurringItems: recurring(payload.recurringItems) } : {}),
    ...(Object.hasOwn(payload, 'lunchMoneyBudgets') ? { lunchMoneyBudgets: budgets(payload.lunchMoneyBudgets) } : {}),
    ...(Object.hasOwn(payload, 'amountFixedDerivation')
      ? { amountFixedDerivation: amountFixedDerivation(payload.amountFixedDerivation) } : {}),
    ...(Object.hasOwn(payload, 'billPaymentHistory')
      ? { billPaymentHistory: billPaymentHistory(payload.billPaymentHistory) } : {}),
    ...(Object.hasOwn(payload, 'provedPayerReceipts')
      ? { provedPayerReceipts: provedPayerReceipts(payload.provedPayerReceipts) } : {}) };
  const numeric = value => typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value));
  const id = value => typeof value === 'string' && value.length > 0 || typeof value === 'number' && Number.isFinite(value);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!out.accounts.every(row => id(row.id) && numeric(row.balance) && typeof row.currency === 'string')
    || !out.transactions.every(row => id(row.id) && date(row.date) && numeric(row.amount)
      && typeof row.currency === 'string' && typeof row.is_pending === 'boolean')
    || !out.categories.every(row => id(row.id))
    || out.transactionWindow.complete !== true || out.transactionWindow.hasMore !== false
    || out.transactionWindow.truncated !== false || !date(out.transactionWindow.startDate) || !date(out.transactionWindow.endDate)
    || out.pendingCoverage.complete !== true || out.pendingCoverage.hasMore !== false
    || out.pendingCoverage.truncated !== false || out.pendingCoverage.basis !== 'is_pending-unbounded') {
    throw new Error('observation-input-invalid');
  }
  // Bounded memory only. Oversized evidence remains on the incumbent live path.
  if (Buffer.byteLength(JSON.stringify(out)) > 8 * 1024 * 1024) {
    const error = new Error('observation-input-too-large'); error.code = 'observation-input-too-large'; throw error;
  }
  return out;
}
// Consume the observer's earned stamp, not whether every planned figure is
// numeric. Scheduled/card-policy Unknowns outside transaction coverage survive.
function completeTransactionCohort(data) {
  return data?.liveOverlay?.applied === true
    && data.liveOverlay.currentPeriodActuals?.transactionCoverage === 'complete';
}
// A publication under a whole-plan hold (liveOverlay.operatingPlan
// 'unavailable', e.g. income reconciliation on a complete refresh) is still a
// complete cohort, but it is not a full picture of the plan.
function planWithheld(data) {
  return data?.liveOverlay?.operatingPlan === 'unavailable';
}

function lastKnownCardActivity(previous, display, current) {
  if (!display.householdAccountId || !current) return null;
  const { context, householdAccountId, data, checkedAt } = display;
  const samePeriod = previous?.householdAccountId === householdAccountId && isDeepStrictEqual(previous.context, context)
    && previous.start === current.start && previous.end === current.end;
  const cards = new Map((samePeriod ? previous.cards : []).map(card => [card.id, card]));
  const asOf = Forecast.budgetAsOf(data);
  for (const card of current.cards) {
    const held = cards.get(card.id);
    // A newer reading replaces the held line, except one whose Paid back is withheld only for incomplete payer coverage
    // with the same charges and target: the held line stays to be shown in its place (OD-045; Forecast owns the rule).
    if (!held || (Date.parse(checkedAt) > Date.parse(held.observedAt) && asOf >= held.asOf
      && !Forecast.heldCardLineCoversPayerGap(card, held))) {
      cards.set(card.id, { ...card, asOf, observedAt: checkedAt });
    }
  }
  return { context, householdAccountId, start: current.start, end: current.end, cards: [...cards.values()] };
}

function create() {
  let slot = null;
  return Object.freeze({
    clear() { slot = null; },
    clearCurrent() {
      if (slot) { slot.context = null; slot.evidence = null; slot.postedBills = null; }
    },
    read(context) {
      if (!slot || slot.context !== context) {
        if (slot) { slot.context = null; slot.evidence = null; }
        return null;
      }
      return structuredClone(slot.evidence);
    },
    replayHousehold(context, checkedAt) {
      return slot?.context === context && slot.evidence?.payload.fetchedAt === checkedAt
        ? slot.sourceHouseholdAccountId : null;
    },
    // A miss returns null and leaves the slot. read() clears a mismatched slot;
    // a live fetch must be able to look up an earlier proof list without that.
    peek(context) {
      if (!slot || slot.context !== context) return null;
      return structuredClone(slot.evidence);
    },
    readPostedBills(context) {
      return slot?.postedBills?.context === context ? structuredClone(slot.postedBills) : null;
    },
    readDisplay(context) {
      if (!slot?.display || !isDeepStrictEqual(slot.display.context, context)) {
        // Incompatible reads cannot see the cohort; failed attempts never
        // erase its financial packet. Only a later complete publish replaces
        // it, or clear() when a newer evidence-day view supersedes it (OD-2).
        return null;
      }
      return structuredClone(slot.display);
    },
    // Dale, 2026-11-18: the last NON-WITHHELD complete publication, so a hold
    // raised on a complete refresh still shows the last full picture. Same
    // process memory and the same compatibility rule as readDisplay; it is
    // replaced only by a later non-withheld complete publication and is
    // served only as the retained picture (live-plan
    // withLatestCompleteRefresh). Retirement: ARCHITECTURE.md.
    readClearDisplay(context) {
      if (!slot?.clearDisplay || !isDeepStrictEqual(slot.clearDisplay.context, context)) return null;
      // Household attestation and the latest attempt are the current display's.
      const current = slot.display && isDeepStrictEqual(slot.display.context, context) ? slot.display : null;
      return structuredClone({ ...slot.clearDisplay,
        ...(current ? { lastBudgetAccountId: current.lastBudgetAccountId, attempt: current.attempt } : {}) });
    },
    observeBudget(accountId) {
      if (slot?.display) slot.display.lastBudgetAccountId = accountId;
      if (slot?.cardActivity && slot.cardActivity.householdAccountId !== accountId) slot.cardActivity = null;
    },
    withLastKnownCardActivity(context, householdAccountId, checkedAt, data) {
      const held = slot?.cardActivity;
      if (!held || held.householdAccountId !== householdAccountId || !isDeepStrictEqual(held.context, context)
        || data?.liveOverlay?.applied !== true || planWithheld(data)) return data;
      const asOf = Forecast.budgetAsOf(data);
      const period = Forecast.spendingCycle(data.plan, asOf);
      if (!period || period.start !== held.start || period.end !== held.end) return data;
      const cards = held.cards.filter(card => card.asOf <= asOf && Date.parse(card.observedAt) < Date.parse(checkedAt));
      if (!cards.length) return data;
      return { ...data, liveOverlay: { ...data.liveOverlay,
        lastKnownCardActivity: structuredClone({ start: held.start, end: held.end, cards }) } };
    },
    noteAttempt(context, attempt) {
      if (slot?.display && isDeepStrictEqual(slot.display.context, context)) slot.display.attempt = structuredClone(attempt);
    },
    publish(context, evidence, display, billContext, activity) {
      if (evidence?.schema !== SCHEMA) throw new Error('observation-input-invalid');
      const incompleteCandidate = display && !completeTransactionCohort(display.data);
      const retained = display && display.context != null
        && completeTransactionCohort(display.data)
        && display.checkedAt === evidence.payload?.fetchedAt
        ? structuredClone(display) : null;
      const nextDisplay = retained || (display === undefined || incompleteCandidate ? slot?.display || null : null);
      // The clear slot follows the display slot, except that a withheld
      // publication keeps the earlier clear picture. When the display slot
      // empties (a newer publication that cannot be retained) the clear slot
      // empties too: no picture older than a superseding one is kept. A
      // withheld publication under a different display context also drops it,
      // so a return to the old context cannot revive a superseded picture.
      const kept = slot?.clearDisplay && isDeepStrictEqual(slot.clearDisplay.context, nextDisplay?.context)
        ? slot.clearDisplay : null;
      const clearDisplay = !nextDisplay ? null : planWithheld(nextDisplay.data) ? kept : nextDisplay;
      let cardActivity = kept && (!retained || retained.householdAccountId === slot.cardActivity?.householdAccountId)
        ? slot.cardActivity : null;
      if (retained && !planWithheld(retained.data)) cardActivity = lastKnownCardActivity(cardActivity, retained, activity);
      const receipts = evidence.postedBillReceipts?.length ? structuredClone(evidence.postedBillReceipts) : null;
      const postedBills = receipts && billContext ? { ...billContext, receipts } : null;
      slot = { context, evidence: { schema: SCHEMA, payload: sourceInputs(evidence.payload),
        ...(receipts ? { postedBillReceipts: receipts } : {}) }, postedBills,
        sourceHouseholdAccountId: retained?.credentialSource === 'env' ? retained.householdAccountId : null,
        display: nextDisplay, clearDisplay, cardActivity };
    },
  });
}
module.exports = { SCHEMA, sourceInputs, amountFixedDerivation, billPaymentHistory, completeTransactionCohort, planWithheld, create };
