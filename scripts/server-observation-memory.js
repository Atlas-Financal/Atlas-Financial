'use strict';
// One private process-local complete-cohort slot. Current source evidence and
// dated display are separate read capabilities, never a canonical store, planner,
// credential store or restart/deploy survival promise.
const { isDeepStrictEqual } = require('node:util');
const SCHEMA = 'atlas-provider-observation-memory/v1';
const ACCOUNT = 'id name display_name institution_name institution type subtype type_name currency balance available_balance available credit_limit limit updated_at balance_as_of balance_last_update date_last_fetched last_fetch plaid_last_successful_update status'.split(' ');
const CATEGORY = 'id name display_name is_income exclude_from_totals exclude_from_budget is_group is_group_parent archived is_archived'.split(' ');
// Keep the recurring source identity already consumed by the observer. Dropping
// it changes replay evidence and defeats exact-input Forecast reuse.
const TRANSACTION = 'id account_id plaid_account_id manual_account_id date amount currency payee original_name originalName notes note external_id externalId pending_transaction_id pendingTransactionId plaid_id plaidId plaidTransactionId plaidPendingTransactionId is_group is_group_parent has_children parent_id recurring_id is_pending status kind mcc plaid_mcc category_id category_name categoryName is_income exclude_from_totals exclude_from_budget contradictoryEvidence confirmedSettlement'.split(' ');
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
function transaction(row) {
  const out = pick(row, TRANSACTION);
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
function sourceInputs(payload) {
  if (payload?.provider !== 'lunchmoney' || typeof payload.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.fetchedAt))) throw new Error('observation-input-invalid');
  const out = { provider: 'lunchmoney', fetchedAt: payload.fetchedAt,
    accounts: payload.accounts.map(row => pick(row, ACCOUNT)),
    categories: payload.categories.map(category), tags: payload.tags.map(tag),
    transactions: payload.transactions.map(transaction),
    transactionWindow: pick(payload.transactionWindow, WINDOW),
    pendingCoverage: pick(payload.pendingCoverage, PENDING) };
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
function create() {
  let slot = null;
  return Object.freeze({
    clear() { slot = null; },
    clearCurrent() { if (slot) { slot.context = null; slot.evidence = null; } },
    read(context) {
      if (!slot || slot.context !== context) {
        if (slot) { slot.context = null; slot.evidence = null; }
        return null;
      }
      return structuredClone(slot.evidence);
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
    observeBudget(accountId) {
      if (slot?.display) slot.display.lastBudgetAccountId = accountId;
    },
    noteAttempt(context, attempt) {
      if (slot?.display && isDeepStrictEqual(slot.display.context, context)) slot.display.attempt = structuredClone(attempt);
    },
    publish(context, evidence, display) {
      if (evidence?.schema !== SCHEMA) throw new Error('observation-input-invalid');
      const incompleteCandidate = display && !completeTransactionCohort(display.data);
      const retained = display && display.context != null
        && completeTransactionCohort(display.data)
        && display.checkedAt === evidence.payload?.fetchedAt
        ? structuredClone(display) : null;
      slot = { context, evidence: { schema: SCHEMA, payload: sourceInputs(evidence.payload) },
        display: retained || (display === undefined || incompleteCandidate ? slot?.display || null : null) };
    },
  });
}
module.exports = { SCHEMA, sourceInputs, completeTransactionCohort, create };
