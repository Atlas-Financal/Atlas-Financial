'use strict';
/* Lunch Money recurring-items read (GET /recurring_items).
 *
 * Restored 2026-11-17 for its first consumer (owner decision, #821
 * 6956651970: reviewed Lunch Money recurring items become the bill-schedule
 * authority). provider-observe's live fetch calls fetchRecurringItems once
 * per observation for the transaction window, and its sanitizer keeps only
 * reviewed items a transaction-identity rule names (lunchMoneyRecurringIds),
 * reduced to schedule fields. provider-observe's schedule review (S2) reads
 * that block to lead each linked bill's schedule, and its amount review uses
 * each item's amount for the served bill amount (owner, 2026-11-21). It is not
 * wired to any server route, assistant/MCP surface or scheduler.
 *
 * Official contract — pinned from the Lunch Money v2.11.1 OpenAPI (the spec
 * the capability audit in PR #562 cites; operationId getAllRecurring):
 *
 *   GET /recurring_items accepts only start_date / end_date and
 *   include_suggested. The dates do NOT filter which items are returned —
 *   they set the range used to populate each item's `matches` object; when
 *   omitted, the provider uses the current month. The endpoint is
 *   UNPAGINATED: no limit / offset / has_more / cursor exists in the spec
 *   or in the response envelope, so this module sends exactly one GET and
 *   consumes the single response whole. Whether the provider enforces any
 *   undocumented internal size cap is UNKNOWN; a response carrying
 *   pagination-shaped fields is therefore never declared complete.
 *
 *   recurringObject (required top-level keys: id, description, status,
 *   transaction_criteria, overrides, matches, created_by, created_at,
 *   updated_at, source): status is suggested | reviewed (only reviewed
 *   items are applied to matching transactions); transaction_criteria
 *   carries granularity day | week | month | year, quantity, anchor_date,
 *   nullable start/end dates and payee, an amount that is an exact decimal
 *   STRING matching ^-?\d+(\.\d{1,4})?$, a three-letter currency, and
 *   nullable plaid/manual account IDs; matches is null for suggested items
 *   and otherwise carries expected_occurrence_dates, found_transactions and
 *   missing_transaction_dates for the requested range; source is
 *   manual | transaction | system and may be null on older items.
 *
 * Agreed decisions (Atlas Systems Review, 2026-10-10):
 *   Q1 Transport is module-local (below): provider-observe's single-GET
 *      helpers are not exported, and neither its transactions pager nor
 *      fetchLunchMoneyLive fits an unpaginated non-transaction endpoint.
 *      The token arrives from the caller, resolved through
 *      provider-observe's existing credential seam (resolveLiveCredential);
 *      this module never reads credentials itself. Redirects are never
 *      followed, so Authorization is never forwarded across one, and the
 *      only non-default base is an explicit loopback override (the test
 *      seam), mirroring provider-observe's ATLAS_LUNCHMONEY_API_BASE rule.
 *   Q2 The provider's `to_base` conversion is OMITTED entirely — it is the
 *      provider's own currency conversion and must never be republished as
 *      an Atlas figure.
 *   Q3 scripts/recurring-audit.js is entirely separate: it derives review
 *      candidates statistically from card transactions. This reader
 *      returns provider evidence only; there is no reconciliation,
 *      cross-check, or shared output between the two.
 *   Q4 Provider ID stability across criteria edits or delete/recreate is
 *      UNKNOWN — the spec calls id unique but documents no stability
 *      guarantee. IDs are treated as opaque within one read; no cross-read
 *      identity matching is attempted or implied.
 *   Q5 Fail-closed split: a missing, duplicate, or invalid item id fails
 *      the WHOLE read. A malformed semantic field (monetary string, date,
 *      enum) marks that field explicitly unavailable in the item's
 *      `unavailableFields` and marks the envelope incomplete — values are
 *      never coerced, zero-filled, or defaulted (a bad status is never
 *      defaulted to 'reviewed'). Documented nulls are preserved as null
 *      and are NOT misrepresented as provider failures.
 *   Q6 List only. The by-id read (GET /recurring_items/{id}) is not part
 *      of this increment.
 *
 * Repair (Systems Review 5479465980 on head 68fdc4fa, 2026-10-10):
 *   R1 Presence is validated wherever the pinned spec lists a key as
 *      required: an ABSENT required key (top-level description /
 *      overrides / matches / source, and every transaction_criteria key,
 *      nullable ones included) marks that field unavailable — absence is
 *      never silently equated with a documented null. Present override
 *      fields are non-nullable per the spec, so a null payee / notes /
 *      category_id inside overrides is unavailable, not dropped. The
 *      spec lists no required keys inside matches, so no absence
 *      requirement is invented for its nested properties.
 *   R2 Identity domains are enforced exactly, with no Number() rounding
 *      or coercion: the item id and overrides.category_id / created_by
 *      are int32; plaid / manual account IDs and found transaction IDs
 *      are int64. Digit strings are evaluated with BigInt and normalized
 *      to their exact canonical decimal form, so distinct in-domain
 *      values can never be rounded into a collision and out-of-domain
 *      values are invalid (whole-read failure for the item id,
 *      unavailable-field for secondary identities).
 *   R3 The duplicate-id error is sanitized: it never carries the raw
 *      provider identity.
 *   R4 created_at / updated_at must be actual ISO 8601 date-times — a
 *      date-only string is not a timestamp. Ordering is validated where
 *      the contract defines an ordered pair: transaction_criteria
 *      start_date <= end_date and the matches request window
 *      request_start_date <= request_end_date (when both bounds are
 *      present). Occurrence-window membership is NOT enforced: the spec
 *      describes occurrence/missing dates as "within the range" in
 *      prose but attaches no schema constraint or clipping guarantee,
 *      so an out-of-window date is reported verbatim, never used to
 *      discard provider evidence.
 *
 * Repair (Systems Review 5479885271 on head ca38c4df, 2026-10-10):
 *   R5 A JSON numeric identity is accepted only when Number.isSafeInteger
 *      holds: JSON.parse already rounded any larger unquoted literal, so
 *      BigInt conversion of such a number would publish the rounded
 *      (wrong) identity exactly, with complete:true. Unsafe numeric ids
 *      are invalid (whole-read failure for the item id; unavailable-field
 *      for secondary account / category / creator / found-transaction
 *      ids). Digit strings remain exact via BigInt. Covered by isolated
 *      raw-JSON regressions, because object fixtures constructed in JS
 *      cannot express the unrounded literal the provider can send.
 *   R6 matches request dates: ABSENCE stays allowed (no required keys
 *      are invented inside matches), but a PRESENT null is malformed —
 *      the pinned schema types request_start_date / request_end_date as
 *      date strings, not nullable — so the matches object is
 *      unavailable rather than passing with a null window bound.
 *   R7 Timezone-less timestamps are rejected: the pinned contract's
 *      date-time format is RFC 3339, which requires a time offset; the
 *      earlier acceptance rested only on Date.parse permissiveness.
 *
 * Provider recurring items are provider-detected / provider-declared
 * evidence — never Forecast bills, obligations, or proof of payment, and
 * an expected occurrence with no found transaction is not evidence of an
 * unpaid bill. Raw provider IDs stay inside this trust boundary: they are
 * preserved because a reader must key on them, but they must never appear
 * in public logs or cross an assistant/MCP response (none exists here).
 */

const http = require('node:http');
const https = require('node:https');
const ProviderObserve = require('./provider-observe.js');

const SCHEMA = 'atlas-lunchmoney-recurring-items/v1';
const CAVEAT = 'Provider recurring items are provider-detected/'
  + 'provider-declared evidence — not Forecast bills or obligations, and '
  + 'never proof of payment. Completeness of this list proves nothing '
  + 'about the household ledger or about all bill obligations being '
  + 'complete, and an expected occurrence with no found transaction is '
  + 'not evidence of an unpaid bill.';
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,4})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const STATUSES = new Set(['suggested', 'reviewed']);
const GRANULARITIES = new Set(['day', 'week', 'month', 'year']);
const SOURCES = new Set(['manual', 'transaction', 'system']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Fields that would claim a list response continues beyond what was
// returned. The documented contract has none of them; if any appears, the
// read is not complete, however the items themselves parse.
const PAGING_KEYS = [
  'has_more', 'hasMore', 'pagination', 'cursor', 'next', 'next_offset',
  'offset', 'limit', 'page', 'pages', 'total_pages',
];

function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parts = value.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year
    && dt.getUTCMonth() === month - 1
    && dt.getUTCDate() === day;
}

// Both dates or neither (the provider requires each if the other is
// present), each a real calendar date, end not before start — all checked
// before any request is made.
function validateRecurringWindow({ startDate, endDate } = {}) {
  const hasStart = startDate != null;
  const hasEnd = endDate != null;
  if (hasStart !== hasEnd) {
    throw new Error('Recurring items startDate and endDate must be supplied together (both or neither).');
  }
  if (!hasStart) return { startDate: null, endDate: null, providerDefault: true };
  if (!isRealCalendarDate(startDate)) {
    throw new Error('Recurring items startDate must be a real YYYY-MM-DD calendar date.');
  }
  if (!isRealCalendarDate(endDate)) {
    throw new Error('Recurring items endDate must be a real YYYY-MM-DD calendar date.');
  }
  if (endDate < startDate) {
    throw new Error('Recurring items endDate must not be before startDate.');
  }
  return { startDate, endDate, providerDefault: false };
}

// The default destination is the provider's live base. Any other base is
// the explicit test-only loopback override and is held to the same rule
// provider-observe applies to ATLAS_LUNCHMONEY_API_BASE: loopback host,
// http or https, nothing else — arbitrary destinations are never permitted.
function resolveBase(base) {
  if (base == null || base === '') return ProviderObserve.LIVE_BASE;
  const raw = String(base).trim();
  if (raw === ProviderObserve.LIVE_BASE) return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    throw new Error('Recurring items API base is not a URL.');
  }
  if (!LOOPBACK_HOSTS.has(String(parsed.hostname || ''))) {
    throw new Error('Recurring items API base may only point at a loopback host.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Recurring items API base must be http or https.');
  }
  return raw.replace(/\/$/, '');
}

function buildRecurringItemsUrl({ startDate, endDate, includeSuggested, base } = {}) {
  const win = validateRecurringWindow({ startDate, endDate });
  const url = new URL(`${resolveBase(base)}/recurring_items`);
  if (!win.providerDefault) {
    url.searchParams.set('start_date', win.startDate);
    url.searchParams.set('end_date', win.endDate);
  }
  // Always sent explicitly: the spec does not state the provider's
  // omitted-value default for include_suggested, so the reader never
  // relies on it. Module default is false.
  url.searchParams.set('include_suggested', includeSuggested === true ? 'true' : 'false');
  return url;
}

// Module-local single GET (Q1), mirroring the incumbent httpsGetJson
// behavior: Bearer token, JSON accept, the incumbent timeout, sanitized
// errors that never carry the token, the body, or the query string.
// Node's http/https never follow redirects, so a 3xx lands in the
// non-2xx error path and Authorization is never forwarded across one.
function getJson(url, token, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    // The observer's refresh cancellation (AbortSignal), as its own GETs honour it.
    const cancelled = () => {
      if (req && typeof req.destroy === 'function') req.destroy();
      done(new Error('Live refresh cancelled.'));
    };
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', cancelled);
      if (err) reject(err);
      else resolve(value);
    };
    if (signal && signal.aborted) { cancelled(); return; }
    if (signal) signal.addEventListener('abort', cancelled, { once: true });
    const lib = url.protocol === 'http:' ? http : https;
    req = lib.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          if (typeof req.destroy === 'function') req.destroy();
          done(new Error('Lunch Money response exceeded the maximum size.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('aborted', () => done(new Error('Lunch Money request failed.')));
      res.on('error', () => done(new Error('Lunch Money request failed.')));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401 || res.statusCode === 403) {
          done(new Error('Lunch Money rejected the access token. Token value is not logged.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          done(new Error(`Lunch Money GET ${url.pathname} failed with HTTP ${res.statusCode}.`));
          return;
        }
        try { done(null, JSON.parse(body || '{}')); }
        catch (e) { done(new Error('Lunch Money response was not JSON.')); }
      });
    });
    if (typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs || ProviderObserve.REQUEST_TIMEOUT_MS, () => {
        if (typeof req.destroy === 'function') req.destroy();
        done(new Error('Lunch Money request timeout.'));
      });
    }
    req.on('error', () => done(new Error('Lunch Money request failed.')));
    req.end();
  });
}

// Documented identity domains in the pinned spec: the recurring item id
// is int32, as are category ids and the user id behind created_by; plaid
// and manual account ids and transaction ids are int64.
const INT32_MAX = 2147483647n;
const INT64_MAX = 9223372036854775807n;

// A provider identity value: a positive integer inside its documented
// domain, as a JSON number or a digit string. Digit strings are evaluated
// with BigInt — never via Number() — so a digit string is preserved
// exactly: distinct in-domain values cannot be rounded into the same
// key, and a sufficiently large string is out-of-domain rather than
// "Infinity". A JSON NUMBER is accepted only when it is a safe integer
// (Number.isSafeInteger): JSON.parse has already rounded any larger
// unquoted literal (18014398509481985 arrives as 18014398509481984), so
// converting such a number with BigInt would publish a WRONG identity
// exactly — unsafe numeric ids are invalid, never approximated. (A
// provider that genuinely holds such an id must send it as a digit
// string, which this helper preserves exactly.)
// The returned string is the exact canonical decimal form of the value.
function validProviderId(value, domainMax) {
  let parsed = null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
  if (parsed == null || parsed <= 0n || parsed > domainMax) return null;
  return parsed.toString();
}

// Nullable identity (account ids): null stays null and is not a failure;
// a present malformed or out-of-domain value is unavailable.
function mapNullableId(value, field, unavailableFields, domainMax) {
  if (value == null) return null;
  const id = validProviderId(value, domainMax);
  if (id == null) {
    unavailableFields.push(field);
    return null;
  }
  return id;
}

function mapNullableDate(value, field, unavailableFields) {
  if (value == null) return null;
  if (isRealCalendarDate(value)) return value;
  unavailableFields.push(field);
  return null;
}

// created_at / updated_at are date-TIMES in the pinned spec (OpenAPI
// format: date-time, i.e. RFC 3339). Date.parse alone would also accept
// a date-only string (it parses as midnight) and timezone-less strings,
// so a timestamp must carry a real calendar date, a 'T', a time-of-day,
// AND a zone designator. Determination (Systems Review 5479885271):
// timezone-less timestamp acceptance is NOT supported by the pinned
// contract — RFC 3339 date-time requires a time offset (Z or ±hh:mm),
// and the provider sends Z. The earlier acceptance of timezone-less
// values was Date.parse permissiveness, not a contract guarantee, so
// such values are unavailable, never interpreted in some assumed zone.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/;

function isTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  if (!isRealCalendarDate(value.slice(0, 10))) return false;
  return Number.isFinite(Date.parse(value));
}

function mapDateTime(value, field, unavailableFields) {
  if (isTimestamp(value)) return value;
  unavailableFields.push(field);
  return null;
}

function mapMatches(rawMatches, unavailableFields) {
  if (rawMatches == null) return null;
  if (typeof rawMatches !== 'object' || Array.isArray(rawMatches)) {
    unavailableFields.push('matches');
    return null;
  }
  let bad = false;
  const dateOrBad = (value) => {
    // Absence is allowed: the spec lists no required keys inside
    // matches, so a missing request date maps to null without failing.
    // A PRESENT null is different (Systems Review 5479885271): the
    // pinned schema types these fields as date strings, not nullable,
    // so present null is malformed evidence and the matches object is
    // unavailable — absence and documented null are never equated here
    // because null is not documented for these fields at all.
    if (value === undefined) return null;
    if (isRealCalendarDate(value)) return value;
    bad = true;
    return null;
  };
  const dateListOrBad = (value) => {
    if (!Array.isArray(value)) { bad = true; return null; }
    const out = [];
    for (const entry of value) {
      if (!isRealCalendarDate(entry)) { bad = true; return null; }
      out.push(entry);
    }
    return out;
  };
  const requestStartDate = dateOrBad(rawMatches.request_start_date);
  const requestEndDate = dateOrBad(rawMatches.request_end_date);
  // The returned match window is an ordered pair (R4): an end before its
  // start is malformed evidence and the whole matches object becomes
  // unavailable. Occurrence-window MEMBERSHIP is deliberately not checked
  // (header R4): the spec's "within the range" wording is descriptive
  // prose with no schema constraint or clipping guarantee, so expected /
  // found / missing dates are reported verbatim even if one falls
  // outside this window — provider evidence is never discarded on the
  // strength of prose.
  if (requestStartDate != null && requestEndDate != null && requestEndDate < requestStartDate) {
    bad = true;
  }
  const expectedOccurrenceDates = dateListOrBad(rawMatches.expected_occurrence_dates);
  const missingTransactionDates = dateListOrBad(rawMatches.missing_transaction_dates);
  let foundTransactions = null;
  if (!Array.isArray(rawMatches.found_transactions)) {
    bad = true;
  } else {
    foundTransactions = [];
    for (const entry of rawMatches.found_transactions) {
      const txnId = entry && typeof entry === 'object' ? validProviderId(entry.transaction_id, INT64_MAX) : null;
      if (!entry || typeof entry !== 'object' || !isRealCalendarDate(entry.date) || txnId == null) {
        bad = true;
        foundTransactions = null;
        break;
      }
      // Found transaction ids are provider identity: internal only.
      foundTransactions.push({ date: entry.date, transactionId: txnId });
    }
  }
  if (bad) {
    unavailableFields.push('matches');
    return null;
  }
  return {
    requestStartDate,
    requestEndDate,
    expectedOccurrenceDates,
    foundTransactions,
    missingTransactionDates,
  };
}

const hasKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function mapRecurringItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Lunch Money recurring item is not an object; failing closed.');
  }
  // Identity failures fail the whole read (Q5): an item whose identity is
  // missing or invalid cannot be keyed, deduplicated, or trusted.
  const providerId = validProviderId(raw.id, INT32_MAX);
  if (providerId == null) {
    throw new Error('Lunch Money recurring item is missing a valid provider id; failing closed.');
  }
  const unavailableFields = [];

  // description is a required key whose documented value may be null
  // (R1): presence with null is preserved as null, but ABSENCE of the key
  // is a contract violation and is unavailable — never silently equated
  // with the documented null.
  let description = null;
  if (!hasKey(raw, 'description')) {
    unavailableFields.push('description');
  } else if (raw.description != null) {
    if (typeof raw.description === 'string') description = raw.description;
    else unavailableFields.push('description');
  }

  let status = null;
  if (STATUSES.has(raw.status)) status = raw.status;
  else unavailableFields.push('status');

  let criteria = null;
  const rawCriteria = raw.transaction_criteria;
  if (!rawCriteria || typeof rawCriteria !== 'object' || Array.isArray(rawCriteria)) {
    unavailableFields.push('criteria');
  } else {
    const c = {};
    // Every transaction_criteria key is required by the pinned spec
    // (R1). The nullable ones (start/end dates, payee, account ids) may
    // be PRESENT as null — that documented null is preserved — but an
    // absent key is unavailable, never silently equated with null. The
    // non-nullable keys already fail their value checks when absent.
    if (!hasKey(rawCriteria, 'start_date')) { c.startDate = null; unavailableFields.push('criteria.startDate'); }
    else c.startDate = mapNullableDate(rawCriteria.start_date, 'criteria.startDate', unavailableFields);
    if (!hasKey(rawCriteria, 'end_date')) { c.endDate = null; unavailableFields.push('criteria.endDate'); }
    else c.endDate = mapNullableDate(rawCriteria.end_date, 'criteria.endDate', unavailableFields);
    // The criteria window is an ordered pair (R4): with both bounds
    // present, an end before the start makes BOTH bounds untrustworthy —
    // the reader cannot know which one is wrong, so both are unavailable
    // rather than silently kept or reordered.
    if (c.startDate != null && c.endDate != null && c.endDate < c.startDate) {
      c.startDate = null;
      c.endDate = null;
      unavailableFields.push('criteria.startDate', 'criteria.endDate');
    }
    if (GRANULARITIES.has(rawCriteria.granularity)) c.granularity = rawCriteria.granularity;
    else { c.granularity = null; unavailableFields.push('criteria.granularity'); }
    if (Number.isInteger(rawCriteria.quantity) && rawCriteria.quantity >= 1) c.quantity = rawCriteria.quantity;
    else { c.quantity = null; unavailableFields.push('criteria.quantity'); }
    if (isRealCalendarDate(rawCriteria.anchor_date)) c.anchorDate = rawCriteria.anchor_date;
    else { c.anchorDate = null; unavailableFields.push('criteria.anchorDate'); }
    if (!hasKey(rawCriteria, 'payee')) { c.payee = null; unavailableFields.push('criteria.payee'); }
    else if (rawCriteria.payee == null) c.payee = null;
    else if (typeof rawCriteria.payee === 'string') c.payee = rawCriteria.payee;
    else { c.payee = null; unavailableFields.push('criteria.payee'); }
    // The exact decimal string is preserved verbatim — never coerced to a
    // number, rounded, or zero-filled. `to_base` is deliberately not read
    // (Q2): the provider's own conversion is never republished here.
    if (typeof rawCriteria.amount === 'string' && AMOUNT_PATTERN.test(rawCriteria.amount)) c.amount = rawCriteria.amount;
    else { c.amount = null; unavailableFields.push('criteria.amount'); }
    if (typeof rawCriteria.currency === 'string' && CURRENCY_PATTERN.test(rawCriteria.currency)) c.currency = rawCriteria.currency;
    else { c.currency = null; unavailableFields.push('criteria.currency'); }
    if (!hasKey(rawCriteria, 'plaid_account_id')) { c.plaidAccountId = null; unavailableFields.push('criteria.plaidAccountId'); }
    else c.plaidAccountId = mapNullableId(rawCriteria.plaid_account_id, 'criteria.plaidAccountId', unavailableFields, INT64_MAX);
    if (!hasKey(rawCriteria, 'manual_account_id')) { c.manualAccountId = null; unavailableFields.push('criteria.manualAccountId'); }
    else c.manualAccountId = mapNullableId(rawCriteria.manual_account_id, 'criteria.manualAccountId', unavailableFields, INT64_MAX);
    criteria = c;
  }

  // overrides is a required key and is NOT nullable in the pinned spec
  // (R1): absent or null is unavailable. Inside a present overrides
  // object, only keys the provider actually sent are carried (absent keys
  // stay absent, never filled with invented values), and every present
  // field is non-nullable per the spec — a present null or wrong-typed
  // payee / notes / category_id is unavailable, never silently dropped.
  let overrides = null;
  if (!hasKey(raw, 'overrides') || raw.overrides == null
    || typeof raw.overrides !== 'object' || Array.isArray(raw.overrides)) {
    unavailableFields.push('overrides');
  } else {
    overrides = {};
    for (const key of ['payee', 'notes']) {
      if (hasKey(raw.overrides, key)) {
        if (typeof raw.overrides[key] === 'string') overrides[key] = raw.overrides[key];
        else unavailableFields.push(`overrides.${key}`);
      }
    }
    if (hasKey(raw.overrides, 'category_id')) {
      const categoryId = validProviderId(raw.overrides.category_id, INT32_MAX);
      if (categoryId == null) unavailableFields.push('overrides.categoryId');
      else overrides.categoryId = categoryId;
    }
  }

  // matches is a required key whose documented value may be null (null
  // for suggested items): present-null is preserved, ABSENCE is
  // unavailable (R1). The spec lists no required keys inside matches, so
  // no absence requirement is invented for its nested properties.
  let matches = null;
  if (!hasKey(raw, 'matches')) {
    unavailableFields.push('matches');
  } else {
    matches = mapMatches(raw.matches, unavailableFields);
  }

  // Provenance: created_by is required by the contract; a missing or
  // malformed value is unavailable provenance, never an invented identity.
  // A null `source` is the documented state of older items: preserved as
  // null and NOT counted as a failure — but the source KEY is required,
  // so its absence is unavailable provenance (R1).
  const createdBy = mapNullableId(raw.created_by, 'createdBy', unavailableFields, INT32_MAX);
  if (raw.created_by == null) unavailableFields.push('createdBy');
  const createdAt = mapDateTime(raw.created_at, 'createdAt', unavailableFields);
  const updatedAt = mapDateTime(raw.updated_at, 'updatedAt', unavailableFields);
  let source = null;
  if (!hasKey(raw, 'source')) {
    unavailableFields.push('source');
  } else if (raw.source != null) {
    if (SOURCES.has(raw.source)) source = raw.source;
    else unavailableFields.push('source');
  }

  return {
    providerId,
    description,
    status,
    criteria,
    overrides,
    matches,
    createdBy,
    createdAt,
    updatedAt,
    source,
    unavailableFields,
  };
}

async function fetchRecurringItems({ startDate, endDate, includeSuggested, token, base, fetchOptions } = {}) {
  if (!token) throw new Error('Recurring items read has no Lunch Money credential.');
  const win = validateRecurringWindow({ startDate, endDate });
  const url = buildRecurringItemsUrl({ startDate, endDate, includeSuggested, base });
  const body = await getJson(url, token, fetchOptions && fetchOptions.timeoutMs, fetchOptions && fetchOptions.signal);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.recurring_items)) {
    throw new Error('Lunch Money recurring items response was malformed; failing closed with no partial items.');
  }
  const unexpectedPaginationEvidence = PAGING_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(body, key),
  );
  const seen = new Set();
  const items = [];
  for (const raw of body.recurring_items) {
    const mapped = mapRecurringItem(raw);
    if (seen.has(mapped.providerId)) {
      // Sanitized diagnostic (R3): the raw provider identity never
      // appears in an outward error, per the header's privacy contract.
      throw new Error('Lunch Money recurring items returned a duplicate provider id; failing closed.');
    }
    seen.add(mapped.providerId);
    items.push(mapped);
  }
  const complete = !unexpectedPaginationEvidence
    && items.every((item) => item.unavailableFields.length === 0);
  return {
    schema: SCHEMA,
    // The requested match window is recorded exactly as requested. When
    // the caller supplied no dates the provider applies its own current
    // month default: providerDefault is true and the effective dates are
    // NEVER invented here.
    requestedWindow: {
      startDate: win.startDate,
      endDate: win.endDate,
      providerDefault: win.providerDefault,
    },
    includeSuggested: includeSuggested === true,
    // Complete means only "the single documented response was retrieved
    // whole and every item validated" — see the caveat for what it never
    // means.
    complete,
    unexpectedPaginationEvidence,
    caveat: CAVEAT,
    itemCount: items.length,
    items,
  };
}

module.exports = {
  SCHEMA,
  CAVEAT,
  isRealCalendarDate,
  validateRecurringWindow,
  buildRecurringItemsUrl,
  mapRecurringItem,
  fetchRecurringItems,
};
