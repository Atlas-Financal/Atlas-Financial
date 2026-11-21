'use strict';
/* Read-only provider observation → B91 reconciliation.
 *
 *   node scripts/provider-observe.js --provider lunchmoney --fixture <file>
 *   node scripts/provider-observe.js --provider lunchmoney --live
 *   node scripts/provider-observe.js --provider lunchmoney --live --identity-proof
 *   node scripts/provider-observe.js --provider lunchmoney --fixture <file> --receipt
 *   node scripts/provider-observe.js --provider lunchmoney --fixture <file> --reconciliation-receipt
 *
 * Live mode resolves a Lunch Money token from LUNCHMONEY_ACCESS_TOKEN, or
 * on Windows from the local CurrentUser DPAPI store. It never
 * writes data.json. Unknown provider account IDs stay unmapped and cannot
 * authorize a precise current-period remaining figure. Deliberate
 * non-household accounts use atlasRole household-external. Synthetic
 * fixture mappings cannot authorize a live canonical mapping. Historical
 * represented-event candidates are not current-opening corrections.
 * A live current-state posted window stays 14 days unless that same GET
 * must reach either an unresolved once joint-cash posting date or the
 * previous Seaspan cycle start. The extension is capped at 120 days.
 * It is settlement lookup plus the two-cycle Road Ahead window, not a
 * historical store. Pending coverage is unchanged.
 * Account timestamps stay distinct: balance_as_of, balance_last_update,
 * updated_at, date_last_fetched. Posted evidence prefers semantic balance dates.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const R = require('./reconcile.js');
const Credentials = require('./local-credentials.js');
const SalaryDiagnostic = require('./salary-match-diagnostic.js');
const MinimumCategory = require('./card-minimum-category.js');
const CoverageDiagnostics = require('./coverage-diagnostics.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_MAP = path.join(ROOT, 'docs', 'connectivity', 'provider-account-map.json');
const LOCAL_MAP = path.join(ROOT, 'docs', 'connectivity', 'provider-account-map.local.json');
const FIXTURE_MAP = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'provider-account-map.json');
const DEFAULT_IDENTITY = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const DEFAULT_DATA = path.join(ROOT, 'data.json');
const LIVE_BASE = 'https://api.lunchmoney.dev/v2';
const TOKEN_ENV = 'LUNCHMONEY_ACCESS_TOKEN';
const MAP_JSON_ENV = 'ATLAS_PROVIDER_ACCOUNT_MAP_JSON';
const MAP_PATH_ENV = 'ATLAS_LIVE_OVERLAY_MAP';
const API_BASE_ENV = 'ATLAS_LUNCHMONEY_API_BASE';
const LIVE_MAP_SCHEMA = 'atlas-provider-account-map/v1';
const RECEIPT_SCHEMA = 'atlas-observation-receipt/v1';
const RECONCILIATION_RECEIPT_SCHEMA = 'atlas-obligation-reconciliation-receipt/v1';
const REQUEST_TIMEOUT_MS = 8000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CASH_ROLES = new Set(['household-cash']);
const CREDIT_ROLES = new Set(['revolving-credit']);
const EXTERNAL_LIVE_ROLE = 'household-external';
// Roles whose transactions feed household figures: a dropped row on one of them breaks coverage.
const COVERAGE_ACCOUNT_ROLES = new Set(['household-cash', 'household-reserve', 'revolving-credit', 'heloc', 'mortgage']);
const SUPPORTED_LIVE_ROLES = {
  'household-cash': 'cash',
  'household-reserve': 'cash',
  'revolving-credit': 'debts',
  heloc: 'debts',
  mortgage: 'debts',
};
const REQUIRED_LIVE_CASH_IDS = Object.freeze(['chequing-a', 'chequing-b', 'savings']);
const CURRENT_STATE_HISTORY_DAYS = 14;
const RECONCILE_HISTORY_DAYS = 120;
// Fixed-amount derivation (owner decision #821, 2026-11-18): one separate,
// bounded GET of posted history that feeds only the derived amountFixed flag.
const AMOUNT_HISTORY_DAYS = 200;
const BILL_PAYMENT_PENDING_DAYS = 90;
const PENDING_COVERAGE_BASIS = 'is_pending-unbounded';
const PENDING_QUERY_PAGE_LIMIT = 1000;
const PENDING_QUERY_MAX_PAGES = 20;
const PENDING_COVERAGE_REQUIRED_EVIDENCE =
  'GET /v2/transactions?is_pending=true with no start_date/end_date, paginated until has_more=false.';
const Forecast = require('../public/forecast.js');
const ObservationMemory = require('./server-observation-memory.js');

function fail(message) {
  const err = new Error(message);
  err.code = 'observe-failed';
  throw err;
}

function parseArgs(argv) {
  const out = {
    provider: null, fixture: null, live: false, map: null,
    data: DEFAULT_DATA, mode: 'current-state', historyDays: null,
    identityProof: false,
    receipt: false,
    reconciliationReceipt: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') out.provider = argv[++i];
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--live') out.live = true;
    else if (a === '--map') out.map = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--history-days') out.historyDays = Number(argv[++i]);
    else if (a === '--identity-proof') out.identityProof = true;
    else if (a === '--receipt') out.receipt = true;
    else if (a === '--reconciliation-receipt') out.reconciliationReceipt = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function historyDaysFromArgs(args) {
  if (args && args.historyDays != null && isFinite(args.historyDays)) {
    return Math.max(1, Math.floor(args.historyDays));
  }
  if (args && args.mode === 'reconcile') return RECONCILE_HISTORY_DAYS;
  return CURRENT_STATE_HISTORY_DAYS;
}

function resolveMapPath(args) {
  if (args.map) return args.map;
  if (args.live) {
    if (fs.existsSync(LOCAL_MAP)) return LOCAL_MAP;
    return DEFAULT_MAP;
  }
  return FIXTURE_MAP;
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || ''));
}

function lunchMoneyApiBase(env) {
  const source = env || process.env;
  const raw = source && source[API_BASE_ENV];
  if (raw == null || String(raw).trim() === '') return LIVE_BASE;
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch (e) {
    fail('ATLAS_LUNCHMONEY_API_BASE is not a URL.');
  }
  if (!isLoopbackHost(parsed.hostname)) {
    fail('ATLAS_LUNCHMONEY_API_BASE may only point at a loopback host.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('ATLAS_LUNCHMONEY_API_BASE must be http or https.');
  }
  return String(raw).trim().replace(/\/$/, '');
}

function requestLibFor(url) {
  return url.protocol === 'http:' ? http : https;
}

function knownCanonicalIdsByCollection(data) {
  const byCollection = {
    cash: new Set(),
    debts: new Set(),
  };
  const cash = (data && data.plan && data.plan.startingCash) || {};
  for (const row of [].concat(cash.breakdown || [], cash.heldElsewhere || [])) {
    if (row && row.id) byCollection.cash.add(String(row.id));
  }
  const configured = Forecast.savingsEarmarksState(data && data.plan, '9999-12-31');
  if (configured.status === 'ready') {
    for (const pool of configured.pools) byCollection.cash.add(pool.accountId);
  }
  for (const row of (data && data.debts) || []) {
    if (row && row.id) byCollection.debts.add(String(row.id));
  }
  return byCollection;
}

function assertLiveMap(mapDoc, opts) {
  if (!mapDoc || typeof mapDoc !== 'object' || Array.isArray(mapDoc)) {
    fail('live-account-map-invalid');
  }
  if (mapDoc.provider !== 'lunchmoney') fail('Account map is missing or is not a lunchmoney map.');
  if (mapDoc.scope === 'fixture') {
    fail('Fixture account map cannot authorize a live canonical mapping.');
  }
  if (mapDoc.schema !== LIVE_MAP_SCHEMA) fail('live-account-map-invalid');
  assertSavingsLinks(mapDoc);
  const mappings = mapDoc.mappings;
  if (!Array.isArray(mappings)) fail('live-account-map-invalid');
  const providerIds = new Set();
  const atlasKeys = new Set();
  const cashIds = new Set();
  const known = opts && opts.data ? knownCanonicalIdsByCollection(opts.data) : null;
  for (const mapping of mappings) {
    if (!mapping || mapping.providerAccountId == null || mapping.providerAccountId === '') {
      fail('live-account-map-invalid');
    }
    const providerId = String(mapping.providerAccountId);
    if (providerIds.has(providerId)) fail('duplicate-provider-account-id');
    providerIds.add(providerId);
    const role = mapping.atlasRole;
    const collection = mapping.canonical && mapping.canonical.collection;
    const atlasId = mapping.canonical && mapping.canonical.id;
    if (role === EXTERNAL_LIVE_ROLE) {
      if (collection || atlasId) fail('live-account-map-invalid');
      continue;
    }
    if (!role || !SUPPORTED_LIVE_ROLES[role]) fail('unsupported-atlas-role');
    if (!collection || !atlasId) fail('live-account-map-invalid');
    if (SUPPORTED_LIVE_ROLES[role] !== collection) fail('live-account-map-invalid');
    const pools = Forecast.savingsEarmarksState(opts && opts.data && opts.data.plan, '9999-12-31');
    const configuredReserve = collection === 'cash' && pools.status === 'ready' && pools.pools.some(p => p.accountId === atlasId);
    if (role === 'household-reserve' && !configuredReserve) fail('invalid-atlas-account-id');
    const purposeReserve = configuredReserve && pools.pools.some(p => p.accountId === atlasId && p.role === 'purpose-reserve');
    if (configuredReserve && (atlasId !== 'savings' || purposeReserve) && role !== 'household-reserve') fail('unsupported-atlas-role');
    const atlasKey = collection + ':' + String(atlasId);
    if (atlasKeys.has(atlasKey)) fail('live-account-map-invalid');
    atlasKeys.add(atlasKey);
    if (known) {
      const ids = known[collection];
      if (!ids || !ids.has(String(atlasId))) fail('invalid-atlas-account-id');
      if (role === 'household-reserve' && known.debts.has(String(atlasId))) fail('invalid-atlas-account-id');
    }
    if (role === 'household-cash' && collection === 'cash') cashIds.add(String(atlasId));
  }
  const required = Forecast.savingsEarmarksState(opts && opts.data && opts.data.plan, '9999-12-31').status !== 'setup-unknown'
    ? ['chequing-a', 'chequing-b'] : REQUIRED_LIVE_CASH_IDS;
  for (const id of required) {
    if (!cashIds.has(id)) fail('missing-required-cash-mapping');
  }
}

// Optional private-map extension only. No amounts, names, allocation policy or
// provider writes. Missing links preserve the incumbent packet byte shape.
function savingsLinkDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function assertSavingsLinks(mapDoc) {
  const block = mapDoc?.savingsLinks;
  if (block == null) return;
  const keys = (row, allowed) => row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => allowed.includes(key));
  const identity = value => typeof value === 'string' && value.length > 0 && value === value.trim()
    || typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (!keys(block, ['version', 'anchorRevision', 'links'])
      || !Number.isSafeInteger(block.version) || block.version < 1
      || !Number.isSafeInteger(block.anchorRevision) || block.anchorRevision < 1
      || !Array.isArray(block.links)) fail('savings-links-invalid');
  for (const link of block.links) {
    if (!keys(link, ['categoryId', 'tagId', 'goalRef', 'occurrenceDate', 'effectiveFrom', 'effectiveThrough'])
        || Object.hasOwn(link, 'categoryId') === Object.hasOwn(link, 'tagId')
        || !identity(link.categoryId ?? link.tagId)
        || !keys(link.goalRef, ['kind', 'id'])
        || !['commitment', 'group', 'yearly-bill', 'budget-reserve'].includes(link.goalRef.kind)
        || typeof link.goalRef.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(link.goalRef.id)
        || !savingsLinkDate(link.occurrenceDate) || !savingsLinkDate(link.effectiveFrom) || !savingsLinkDate(link.effectiveThrough)
        || link.effectiveThrough < link.effectiveFrom) fail('savings-links-invalid');
  }
}

function parseAccountMapJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (e) {
    fail('live-account-map-invalid');
  }
  return parsed;
}

function loadLiveAccountMap(env, data) {
  const source = env || process.env;
  const json = source && source[MAP_JSON_ENV];
  if (json != null && String(json).trim() !== '') {
    const mapDoc = parseAccountMapJson(json);
    assertLiveMap(mapDoc, { data });
    return mapDoc;
  }
  const mapPath = (source && source[MAP_PATH_ENV])
    || (fs.existsSync(LOCAL_MAP) ? LOCAL_MAP : null);
  if (!mapPath) fail('live-account-map-missing');
  let mapDoc;
  try {
    mapDoc = loadJson(mapPath);
  } catch (e) {
    fail('live-account-map-invalid');
  }
  assertLiveMap(mapDoc, { data });
  return mapDoc;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mappingFor(mapDoc, providerAccountId) {
  const id = String(providerAccountId);
  return (mapDoc.mappings || []).find(m => String(m.providerAccountId) === id) || null;
}

function dateOnly(value) {
  return Forecast.financialDate(value);
}

// A provider amount is a finite number or a numeric string. The first present
// candidate decides; a present value that is blank, boolean or non-numeric is
// unknown (null), never coerced to 0 or NaN.
function firstNumber(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const LEDGER_NAME_MAX = 60;
function ledgerNameOf(raw) {
  for (const value of [raw.display_name, raw.name]) {
    if (typeof value !== 'string') continue;
    const name = value.replace(/\s+/g, ' ').trim();
    if (name) return name.slice(0, LEDGER_NAME_MAX);
  }
  return null;
}

function normalizeLunchMoneyAccount(raw) {
  if (!raw || raw.id == null) fail('Lunch Money account is missing a stable id.');
  return {
    provider: 'lunchmoney',
    providerAccountId: String(raw.id),
    displayName: raw.name || raw.display_name || null,
    // The name the household reads in Lunch Money (owner decision, Dale,
    // 2026-11-20; Grok Bot, rule 17): display_name first, which bank sync
    // never overwrites, else the provider's name. A label only, carried to the
    // page by provider account id; never used to match anything.
    ledgerName: ledgerNameOf(raw),
    institutionName: raw.institution_name || raw.institution || null,
    type: raw.type || null,
    subtype: raw.subtype || raw.type_name || null,
    currency: raw.currency || null,
    balance: firstNumber(raw.balance),
    available: firstNumber(raw.available_balance, raw.available),
    limit: firstNumber(raw.credit_limit, raw.limit),
    updatedAt: raw.updated_at || null,
    balanceAsOf: raw.balance_as_of || null,
    ...(Object.prototype.hasOwnProperty.call(raw, 'balance_last_update')
      ? { balanceLastUpdate: raw.balance_last_update } : {}),
    dateLastFetched: raw.date_last_fetched || null,
    ...(Object.prototype.hasOwnProperty.call(raw, 'last_fetch') ? { lastFetch: raw.last_fetch } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, 'plaid_last_successful_update')
      ? { lastSuccessfulUpdate: raw.plaid_last_successful_update } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, 'status') ? { syncStatus: raw.status } : {}),
  };
}

// Posted evidence keeps legacy balance_as_of precedence, then the v2
// semantic balance_last_update. An explicitly unknown/malformed v2 date withholds
// evidence instead of borrowing an object update or sync/fetch timestamp.
// Preserve absence separately for incumbent legacy timestamp compatibility.
// Household conversion remains Forecast.financialDate; UTC below only
// validates calendar identity so impossible dates cannot roll forward.
function postedBalanceEvidenceInstant(account) {
  if (!account || typeof account !== 'object') return null;
  if (account.balanceAsOf) return account.balanceAsOf;
  if (Object.prototype.hasOwnProperty.call(account, 'balanceLastUpdate')) {
    const value = account.balanceLastUpdate;
    if (typeof value !== 'string' || !dateOnly(value)) return null;
    const day = value.trim().slice(0, 10), instant = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== day) return null;
    return value;
  }
  return account.updatedAt || account.dateLastFetched || null;
}

// Live cash / mortgage / HELOC keep the prior object-update dating so
// daily-refreshed accounts are not silently retimed by a leftover
// balance_as_of. This is not statement-cadence freshness.
function genericAccountEvidenceInstant(account) {
  if (!account || typeof account !== 'object') return null;
  // Incumbent order. A v2 account dated only by balance_last_update keeps a
  // validated semantic date instead of becoming undated (loans no longer
  // borrow the request time).
  return account.updatedAt || account.balanceAsOf || account.dateLastFetched
    || (Object.prototype.hasOwnProperty.call(account, 'balanceLastUpdate')
      ? postedBalanceEvidenceInstant({ balanceLastUpdate: account.balanceLastUpdate }) : null)
    || null;
}

function normalizeLunchMoneyCategory(raw) {
  if (!raw || raw.id == null) return null;
  return {
    id: String(raw.id),
    name: raw.name || raw.display_name || null,
    isIncome: raw.is_income === true,
    excludeFromTotals: raw.exclude_from_totals === true,
    excludeFromBudget: raw.exclude_from_budget === true,
    isGroup: raw.is_group === true || raw.is_group_parent === true,
    archived: raw.archived === true || raw.is_archived === true,
  };
}

function categoryIndexFromPayload(payload) {
  const byId = new Map();
  const add = raw => {
    const cat = normalizeLunchMoneyCategory(raw);
    if (!cat) return;
    byId.set(cat.id, cat);
    for (const child of raw.children || []) add(child);
  };
  for (const raw of payload && payload.categories || []) add(raw);
  return byId;
}

function tagIndexFromPayload(payload) {
  const byId = new Map();
  const add = raw => {
    if (!raw || raw.id == null) return;
    byId.set(String(raw.id), {
      id: String(raw.id),
      name: raw.name || raw.label || null,
    });
  };
  for (const raw of (payload && payload.tags) || []) add(raw);
  return byId;
}

function resolveRawTags(raw, tagsById) {
  const index = tagsById || new Map();
  const fromObjects = [];
  if (Array.isArray(raw && raw.tags)) {
    for (const item of raw.tags) {
      if (item == null) continue;
      if (typeof item === 'object') {
        const id = item.id != null ? String(item.id) : null;
        const named = id && index.get(id);
        fromObjects.push({
          id,
          name: item.name || item.label || (named && named.name) || null,
        });
        continue;
      }
      if (typeof item === 'number' || (typeof item === 'string' && /^\d+$/.test(item))) {
        const id = String(item);
        const named = index.get(id);
        fromObjects.push({ id, name: (named && named.name) || null });
        continue;
      }
      if (typeof item === 'string') fromObjects.push({ id: null, name: item });
    }
  }
  if (fromObjects.length) return fromObjects;
  const ids = (raw && (raw.tag_ids || raw.tagIds)) || [];
  if (!Array.isArray(ids) || !ids.length) return raw && raw.tags ? raw.tags : null;
  return ids.map(id => {
    const key = String(id);
    const named = index.get(key);
    return { id: key, name: (named && named.name) || null };
  });
}

// A provider transaction ID is trustworthy only as a safe-integer number,
// or as a nonempty string exactly equal to its own trim() — trustworthy
// strings are opaque identities preserved verbatim (case and leading zeros
// are identity; identity remains the String() form, so number 123 and
// string '123' stay the same identity). Everything else — booleans,
// non-finite / non-integer / unsafe numbers, empty or whitespace-padded
// strings, arrays, objects, null/undefined — is untrustworthy:
// unmergeable at fetch (mergeTransactionsById) and rejected at
// normalization through the existing missing-id failure path.
function isTrustworthyTransactionId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return value.length > 0 && value === value.trim();
  return false;
}

// Lunch Money v2 (spec 2.11.2, POST /transactions/group example): a group
// parent carries plaid_account_id and manual_account_id null; only its
// children (returned with include_children) carry accounts. The parent takes
// the one account every child records, and nothing else: no child, a child
// with no account or with both, or children on different accounts leaves the
// parent without an account (unmapped, fail closed). Children are read for
// their account ids only; they never become rows of their own.
function groupParentAccountId(raw) {
  if (!(raw.is_group_parent === true || raw.is_group === true)) return null;
  const children = Array.isArray(raw.children) ? raw.children : [];
  if (!children.length) return null;
  const accounts = new Set();
  for (const child of children) {
    const plaid = child && child.plaid_account_id != null, manual = child && child.manual_account_id != null;
    if (plaid === manual) return null;
    accounts.add((plaid ? 'plaid:' : 'manual:') + String(plaid ? child.plaid_account_id : child.manual_account_id));
  }
  if (accounts.size !== 1) return null;
  const child = children[0];
  return child.plaid_account_id != null ? child.plaid_account_id : child.manual_account_id;
}

function normalizeLunchMoneyTransaction(raw, categoriesById, tagsById, opts) {
  if (!raw || !isTrustworthyTransactionId(raw.id)) fail('Lunch Money transaction is missing a stable id.');
  const accountId = raw.account_id != null ? raw.account_id
    : raw.plaid_account_id != null ? raw.plaid_account_id
    : raw.manual_account_id != null ? raw.manual_account_id
    : groupParentAccountId(raw);
  const categoryId = raw.category_id != null ? String(raw.category_id) : null;
  const fromIndex = categoryId && categoriesById ? categoriesById.get(categoryId) : null;
  const categoryName = raw.category_name || raw.categoryName
    || (fromIndex && fromIndex.name) || null;
  const isIncome = raw.is_income === true
    || (fromIndex && fromIndex.isIncome === true);
  const excludeFromTotals = raw.exclude_from_totals === true
    || (fromIndex && fromIndex.excludeFromTotals === true);
  const excludeFromBudget = raw.exclude_from_budget === true
    || (fromIndex && fromIndex.excludeFromBudget === true);
  const minimumCategoryDebt = fromIndex && categoryName === fromIndex.name && raw.is_pending === false
    ? MinimumCategory.categoryDebt(fromIndex) : null;
  return {
    provider: 'lunchmoney',
    providerTransactionId: String(raw.id),
    providerAccountId: accountId != null ? String(accountId) : null,
    date: raw.date || null,
    amount: lunchMoneyDebitAmount(raw.amount),
    currency: typeof raw.currency === 'string' ? raw.currency.trim().toLowerCase() : null,
    payee: raw.payee || null,
    originalName: raw.original_name || raw.originalName || null,
    notes: raw.notes || raw.note || null,
    tags: resolveRawTags(raw, tagsById),
    // Resolve exact tag identity while it still exists. Names never substitute.
    // A4a: bare tag IDs (tags: [501]) resolve through resolveRawTags too.
    ...(opts?.savingsLinks ? { tagIds: [...new Set([...(Array.isArray(raw.tag_ids) ? raw.tag_ids : []),
      ...(Array.isArray(raw.tags) ? (resolveRawTags({ tags: raw.tags }, null) || []).map(tag => tag && tag.id) : [])]
      .filter(id => isTrustworthyTransactionId(id)).map(String))] } : {}),
    externalId: raw.external_id || raw.externalId || null,
    pendingTransactionId: raw.pending_transaction_id || raw.pendingTransactionId || null,
    plaidId: raw.plaid_id || raw.plaidId || null,
    plaidMetadata: raw.plaid_metadata || raw.plaidMetadata || null,
    plaidTransactionId: plaidTransactionIdFromRaw(raw),
    plaidPendingTransactionId: plaidPendingTransactionIdFromRaw(raw),
    isGroup: raw.is_group === true || raw.is_group_parent === true
      || raw.has_children === true,
    // v1 parent_id, or v2 group_parent_id (spec 2.11.2) for a row grouped
    // into a group parent.
    parentId: raw.parent_id != null ? String(raw.parent_id)
      : raw.group_parent_id != null ? String(raw.group_parent_id) : null,
    // v2 split identity (spec 2.11.2): a split piece carries split_parent_id
    // and a split parent is_split_parent. Read only by the dropped-row rule
    // (droppedRowCategory), as a v1 parent_id piece is there. Never parentId:
    // the group-parent rules keep group_parent_id / parent_id alone. Like the
    // U5 group child ids, it is present only on a v2 split row, so every other
    // row's shape is unchanged; the served packet rows never carry it.
    ...(raw.split_parent_id != null || raw.is_split_parent === true ? { splitIdentity: true } : {}),
    // U5: the provider ids of the children Lunch Money lists on a group parent,
    // so the coverage stamp can tell a complete cross-account group from a
    // partial one. Internal (never emitted); absent on every other row, so
    // their shape is unchanged.
    ...((raw.is_group_parent === true || raw.is_group === true) && Array.isArray(raw.children)
      ? { groupChildIds: raw.children.map(child => child && isTrustworthyTransactionId(child.id) ? String(child.id) : null) } : {}),
    // Lunch Money v2 transaction recurring_id: the recurring item this row
    // matched. Forecast reads it only to stamp the dogFood flags; it is not
    // published in the served packet.
    recurringId: raw.recurring_id != null ? String(raw.recurring_id) : null,
    pending: raw.is_pending === true,
    savingsPostingEvidence: Object.hasOwn(raw, 'is_pending') && raw.is_pending === false ? 'posted'
      : Object.hasOwn(raw, 'is_pending') && raw.is_pending === true ? 'pending' : 'unknown',
    status: raw.status || null,
    kind: minimumCategoryDebt ? 'card-payment' : raw.kind || null,
    mcc: raw.mcc || raw.plaid_mcc || null,
    categoryId,
    categoryLabel: categoryName,
    minimumCategoryDebt,
    // A pending debit in an exact card-minimum category: a Payment pending
    // label candidate only (card-minimum-category.js). Present only on such a
    // row, so every other row keeps its shape; kind and minimumCategoryDebt
    // stay posted-only.
    ...(fromIndex && categoryName === fromIndex.name && raw.is_pending === true && MinimumCategory.categoryDebt(fromIndex)
      ? { pendingMinimumCategoryDebt: MinimumCategory.categoryDebt(fromIndex) } : {}),
    isIncome,
    excludeFromTotals,
    excludeFromBudget,
    contradictoryEvidence: raw.contradictoryEvidence === true,
    confirmedSettlement: raw.confirmedSettlement === true,
  };
}

function collectLunchMoneyAccounts(payload) {
  if (Array.isArray(payload.accounts) && payload.accounts.length) return payload.accounts;
  return [].concat(
    payload.plaid_accounts || [],
    payload.manual_accounts || [],
    payload.assets || []
  );
}

function normalizeLunchMoneyPayload(payload, fetchedAt, opts) {
  if (!payload || typeof payload !== 'object') fail('Lunch Money payload is not an object.');
  const categoriesById = categoryIndexFromPayload(payload);
  const tagsById = tagIndexFromPayload(payload);
  const txWindow = payload.transactionWindow || payload.transaction_window || null;
  // Capture original declarations before any normalization or row inference.
  // Only literal query dates and an affirmative, noncontradictory completion
  // cross the Savings boundary; absence never earns source provenance.
  const declared = txWindow && typeof txWindow === 'object' && !Array.isArray(txWindow) ? txWindow : {};
  const declaredDate = keys => {
    const values = keys.filter(key => Object.hasOwn(declared, key)).map(key => declared[key]);
    return values.length && values.every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && value === values[0]) ? values[0] : null;
  };
  const savingsFetchCoverage = {
    complete: Object.hasOwn(declared, 'complete') && declared.complete === true
      && ['hasMore', 'has_more', 'truncated'].every(key => !Object.hasOwn(declared, key)
        || declared[key] == null || declared[key] === false),
    startDate: declaredDate(['startDate', 'start_date']),
    endDate: declaredDate(['endDate', 'end_date']),
  };
  return {
    provider: 'lunchmoney',
    fetchedAt: payload.fetchedAt || fetchedAt,
    accounts: collectLunchMoneyAccounts(payload).map(normalizeLunchMoneyAccount),
    transactions: (payload.transactions || []).map(tx =>
      normalizeLunchMoneyTransaction(tx, categoriesById, tagsById, opts)),
    // A missing collection is not an empty one: only a delivered array is
    // evidence that there were no transactions (A1).
    transactionsPresent: Array.isArray(payload.transactions),
    pendingCoverage: classifyPendingCoverage(payload),
    transactionWindow: {
      savingsFetchCoverage,
      startDate: (txWindow && (txWindow.startDate || txWindow.start_date)) || null,
      endDate: (txWindow && (txWindow.endDate || txWindow.end_date)) || null,
      complete: txWindow && txWindow.complete === true
        ? true
        : txWindow && (txWindow.complete === false
          || txWindow.truncated === true
          || txWindow.hasMore === true
          || txWindow.has_more === true)
          ? false
          : null,
      hasMore: txWindow && (txWindow.hasMore === true || txWindow.has_more === true)
        ? true
        : txWindow && (txWindow.hasMore === false || txWindow.has_more === false)
          ? false
          : null,
      truncated: !!(txWindow && txWindow.truncated === true),
    },
  };
}

function httpsGetJson(url, token, options) {
  return new Promise((resolve, reject) => {
    const signal = options && options.signal;
    let req;
    const cancelled = () => {
      if (req && typeof req.destroy === 'function') req.destroy();
      done(new Error('Live refresh cancelled.'));
    };
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', cancelled);
      if (err) reject(err);
      else resolve(value);
    };
    const lib = requestLibFor(url);
    if (signal && signal.aborted) { cancelled(); return; }
    if (signal) signal.addEventListener('abort', cancelled, { once: true });
    req = lib.request(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
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
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (typeof req.destroy === 'function') req.destroy();
        done(new Error('Lunch Money request timeout.'));
      });
    }
    req.on('error', () => {
      done(new Error('Lunch Money request failed.'));
    });
    req.end();
  });
}

async function tryGetJson(url, token, options) {
  try {
    return await httpsGetJson(url, token, options);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) return null;
    throw err;
  }
}

function accountsFromLivePayloads(plaid, manuals) {
  return [].concat(
    (plaid && (plaid.plaid_accounts || plaid.accounts)) || [],
    (manuals && (manuals.manual_accounts || manuals.assets || manuals.accounts)) || []
  );
}

function lunchMoneyTransactionsUrl(now, historyDays, base) {
  const days = historyDays == null ? CURRENT_STATE_HISTORY_DAYS : Number(historyDays);
  const span = isFinite(days) && days > 0 ? Math.floor(days) : CURRENT_STATE_HISTORY_DAYS;
  const txUrl = new URL(`${base || LIVE_BASE}/transactions`);
  const end = dateOnly(now);
  if (!end) fail('Transaction history range needs a parseable fetch instant.');
  const startMs = Date.parse(now);
  const start = Number.isFinite(startMs)
    ? dateOnly(new Date(startMs - span * 86400000).toISOString())
    : Forecast.addDays(end, -span);
  if (!start) fail('Transaction history start date could not be derived.');
  txUrl.searchParams.set('start_date', start);
  txUrl.searchParams.set('end_date', end);
  txUrl.searchParams.set('include_pending', 'true');
  txUrl.searchParams.set('include_metadata', 'true');
  // v2 returns a group parent with no account of its own; its children
  // (only with include_children) carry the account (groupParentAccountId).
  txUrl.searchParams.set('include_children', 'true');
  txUrl.startDate = start;
  txUrl.endDate = end;
  return txUrl;
}

function lunchMoneyPendingUniverseUrl(base) {
  const txUrl = new URL(`${base || LIVE_BASE}/transactions`);
  txUrl.searchParams.set('is_pending', 'true');
  txUrl.searchParams.set('include_metadata', 'true');
  txUrl.searchParams.set('include_children', 'true');
  return txUrl;
}

function withPage(url, offset, limit) {
  const pageUrl = new URL(url.href);
  pageUrl.searchParams.set('limit', String(limit));
  pageUrl.searchParams.set('offset', String(offset));
  return pageUrl;
}

function coverageDate(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function classifyPendingCoverage(raw) {
  const declared = raw && raw.pendingCoverage;
  if (!declared || typeof declared !== 'object') {
    return {
      complete: false,
      status: 'insufficient',
      basis: null,
      hasMore: null,
      startDate: null,
      endDate: null,
      reason: 'No pending-coverage metadata. A bounded include_pending window is not proof of zero pending.',
      requiredEvidence: PENDING_COVERAGE_REQUIRED_EVIDENCE,
    };
  }
  const startDate = coverageDate(declared.startDate || declared.start_date);
  const endDate = coverageDate(declared.endDate || declared.end_date);
  const basis = declared.basis == null ? null : String(declared.basis);
  const hasMore = declared.hasMore === true || declared.has_more === true
    ? true
    : declared.hasMore === false || declared.has_more === false
      ? false
      : null;
  const truncated = declared.truncated === true;
  const dated = !!(startDate || endDate);
  if (basis !== PENDING_COVERAGE_BASIS || dated) {
    return {
      complete: false,
      status: dated ? 'bounded-window' : 'insufficient',
      basis,
      hasMore,
      startDate,
      endDate,
      reason: dated
        ? 'Pending query is date-bounded. Absence inside that window is not proof of zero pending.'
        : 'Pending coverage basis is not the unbounded is_pending query.',
      requiredEvidence: PENDING_COVERAGE_REQUIRED_EVIDENCE,
    };
  }
  if (truncated || hasMore !== false || declared.complete !== true) {
    return {
      complete: false,
      status: 'insufficient',
      basis,
      hasMore,
      startDate,
      endDate,
      reason: truncated
        ? 'Pending query was truncated before has_more=false.'
        : 'Pending query did not complete with has_more=false.',
      requiredEvidence: PENDING_COVERAGE_REQUIRED_EVIDENCE,
    };
  }
  return {
    complete: true,
    status: 'complete',
    basis,
    hasMore: false,
    startDate: null,
    endDate: null,
    reason: 'Completed is_pending=true query with no date bound.',
    requiredEvidence: null,
  };
}

// Merge the paginated window with the pending universe. The same provider
// id legitimately appears in both (a pending row, or a pending/posted union
// across the two queries). A later copy is dropped when it is byte-identical
// to a kept copy, or when it is pending (a second pending copy is never
// counted twice). A later posted copy is always kept, whatever arrived
// first, so collapseByProviderTransactionId decides: a pending/posted pair
// becomes one posted row, and two different posted records for one id are a
// posted duplicate with incomplete coverage, exactly as for direct fixture
// input. Merging never decides which posted copy is true.
function rawPosted(tx) {
  return tx.is_pending !== true;
}

function mergeTransactionsById(primary, extra) {
  const out = [];
  const kept = new Map();
  for (const tx of [].concat(primary || [], extra || [])) {
    if (!tx || !isTrustworthyTransactionId(tx.id)) {
      out.push(tx);
      continue;
    }
    const id = String(tx.id);
    const copies = kept.get(id);
    if (!copies) {
      kept.set(id, [{ tx, text: JSON.stringify(tx) }]);
      out.push(tx);
      continue;
    }
    const text = JSON.stringify(tx);
    if (copies.some(copy => copy.text === text)) continue;
    if (!rawPosted(tx)) continue;
    copies.push({ tx, text });
    out.push(tx);
  }
  return out;
}

async function fetchLunchMoneyTransactionsPaged(url, token, opts) {
  const limit = (opts && opts.limit) || PENDING_QUERY_PAGE_LIMIT;
  const maxPages = (opts && opts.maxPages) || PENDING_QUERY_MAX_PAGES;
  const all = [];
  let offset = 0;
  let hasMore = null;
  let pages = 0;
  let truncated = false;
  const note = code => {
    try { opts?.onCoverageDiagnostic?.({ [code]: 1 }); } catch (_) { /* Diagnostics never affect the fetch. */ }
  };
  while (pages < maxPages) {
    const payload = await httpsGetJson(withPage(url, offset, limit), token, opts);
    if (!payload || !Array.isArray(payload.transactions)) {
      note('transactions-array-malformed');
      // A 200 page without a transactions array is malformed, not a genuine
      // empty window: fail closed exactly like the missing-has_more path.
      hasMore = null;
      truncated = true;
      break;
    }
    const txs = payload.transactions;
    all.push(...txs);
    pages += 1;
    if (payload && payload.has_more === true) {
      hasMore = true;
      if (txs.length === 0) {
        note('empty-page-with-more');
        truncated = true;
        break;
      }
      offset += limit;
      continue;
    }
    if (payload && payload.has_more === false) {
      hasMore = false;
      break;
    }
    hasMore = null;
    truncated = true;
    note(Object.hasOwn(payload, 'has_more') ? 'has-more-invalid' : 'has-more-missing');
    break;
  }
  if (hasMore === true && pages >= maxPages) {
    truncated = true;
    note('page-limit-reached');
  }
  return {
    transactions: all,
    hasMore,
    complete: hasMore === false && truncated !== true,
    truncated,
    pages,
  };
}

async function resolveLiveToken(options) {
  const resolved = await Credentials.resolveLunchMoneyAccessToken(options);
  return resolved.token;
}

async function resolveLiveCredential(options) {
  return Credentials.resolveLunchMoneyAccessToken(options);
}

async function fetchLunchMoneyLive(token, now, historyDays, options) {
  if (!token) fail('Live observation has no Lunch Money credential.');
  const env = options && options.env ? options.env : process.env;
  const base = lunchMoneyApiBase(env);
  const txUrl = lunchMoneyTransactionsUrl(now, historyDays, base);
  const me = await httpsGetJson(new URL(`${base}/me`), token, options);
  // Official v2 /me userObject.account_id identifies the budget account;
  // user id, names and email are NOT household identity. Keep this private
  // lifecycle attestation outside the financial source payload/receipts.
  if (Number.isSafeInteger(me?.account_id) && me.account_id >= 0) {
    options?.onHouseholdIdentity?.(String(me.account_id));
  }
  const plaid = await tryGetJson(new URL(`${base}/plaid_accounts`), token, options);
  let manuals = await tryGetJson(new URL(`${base}/manual_accounts`), token, options);
  if (!manuals) manuals = await tryGetJson(new URL(`${base}/assets`), token, options);
  // Categories are fetched without tryGetJson's 404-to-null swallow: a
  // transaction whose raw row carries only a category_id takes its label
  // and income flag solely from this index, so a swallowed 404 would
  // silently degrade classification while the observation still qualified
  // as complete. A categories failure must reject the whole fetch, exactly
  // like a 503 already does through tryGetJson's rethrow (ATLAS-067 FR2).
  const categoriesPayload = await httpsGetJson(new URL(`${base}/categories`), token, options);
  // Tags are fetched without tryGetJson's 404-to-null swallow either: tag
  // names are classification inputs — a tag named fuel/gas is explicit fuel
  // evidence and a tag named for a household member assigns the personal
  // owner — so a swallowed 404 would silently strip that evidence from
  // every bare-ID tag while the observation still qualified as complete.
  // A tags failure must reject the whole fetch, exactly like a 503
  // already does through tryGetJson's rethrow (ATLAS-067 tags).
  const tagsPayload = await httpsGetJson(new URL(`${base}/tags`), token, options);
  const txPage = await fetchLunchMoneyTransactionsPaged(txUrl, token, options);
  const pendingPage = await fetchLunchMoneyTransactionsPaged(
    lunchMoneyPendingUniverseUrl(base),
    token,
    options
  );
  const recurringItems = await fetchRecurringEvidence(token, txUrl, base, options);
  const lunchMoneyBudgets = await fetchBudgetEvidence(token, base, now, options);
  const amountHistory = options && options.amountHistory === true
    ? await fetchAmountHistory(token, now, base, options) : undefined;
  return {
    provider: 'lunchmoney',
    fetchedAt: now,
    accounts: accountsFromLivePayloads(plaid, manuals),
    categories: (categoriesPayload && (categoriesPayload.categories || categoriesPayload)) || [],
    tags: (tagsPayload && (tagsPayload.tags || tagsPayload)) || [],
    transactions: mergeTransactionsById(
      txPage.transactions,
      pendingPage.transactions
    ),
    transactionWindow: {
      startDate: txUrl.startDate,
      endDate: txUrl.endDate,
      complete: txPage.complete === true,
      hasMore: txPage.hasMore,
      truncated: txPage.truncated === true,
    },
    pendingCoverage: {
      complete: pendingPage.complete === true,
      basis: PENDING_COVERAGE_BASIS,
      hasMore: pendingPage.hasMore,
      startDate: null,
      endDate: null,
      truncated: pendingPage.truncated === true,
    },
    recurringItems,
    lunchMoneyBudgets,
    ...(amountHistory ? { amountHistory } : {}),
  };
}

// Lunch Money budgets (owner decision, #821, 2026-11-18: budget amounts come
// from Lunch Money; lead rulings Q1-Q5). Two GET reads per observation:
// /budgets/settings (period granularity, quantity, anchor) and /summary with
// occurrences, over a window from BUDGET_READ_LOOKBACK_DAYS before today to
// BUDGET_READ_LOOKAHEAD_DAYS after. A non-aligned range still returns every
// budget period it fully contains, each with its own dates and `budgeted`.
// FOUNDATION: Forecast does not read the block yet (PR B), so a failed read
// is recorded as unavailable and never fails the observation. Cancellation
// still cancels.
const BUDGET_READ_LOOKBACK_DAYS = 120;
const BUDGET_READ_LOOKAHEAD_DAYS = 200;
async function fetchBudgetEvidence(token, base, now, options) {
  try {
    const day = dateOnly(now);
    if (!day) return { status: 'unavailable', reason: 'budget-read-failed' };
    const settings = await httpsGetJson(new URL(`${base}/budgets/settings`), token, options);
    const url = new URL(`${base}/summary`);
    url.searchParams.set('start_date', Forecast.addDays(day, -BUDGET_READ_LOOKBACK_DAYS));
    url.searchParams.set('end_date', Forecast.addDays(day, BUDGET_READ_LOOKAHEAD_DAYS));
    url.searchParams.set('include_occurrences', 'true');
    const summary = await httpsGetJson(url, token, options);
    return { status: 'read', settings, summary };
  } catch (err) {
    if (options && options.signal && options.signal.aborted) throw err;
    return { status: 'unavailable', reason: 'budget-read-failed' };
  }
}

// The fixed-amount history read: GET /v2/transactions over AMOUNT_HISTORY_DAYS,
// paged. It feeds only derivedAmountFixedBills and billPaymentHistory (the bill sheet). Any failure is recorded as an
// incomplete window, so no bill is marked fixed and the bill sheet says Unavailable; it never fails the refresh.
async function fetchAmountHistory(token, now, base, options) {
  const url = lunchMoneyTransactionsUrl(now, AMOUNT_HISTORY_DAYS, base);
  const window = { startDate: url.startDate, endDate: url.endDate };
  try {
    // Coverage diagnostics describe the observation window only; the history
    // overlaps it, so its rows are never counted a second time.
    const { onCoverageDiagnostic, ...quiet } = options || {};
    const page = await fetchLunchMoneyTransactionsPaged(url, token, quiet);
    return { transactions: page.transactions || [], transactionWindow: { ...window,
      complete: page.complete === true, hasMore: page.hasMore, truncated: page.truncated === true } };
  } catch (err) {
    if (options && options.signal && options.signal.aborted) throw err;
    return { transactions: [], transactionWindow: { ...window, complete: false, truncated: false } };
  }
}

// Lunch Money reviewed recurring items (owner, #821 6956651970): one GET of
// /recurring_items for the transaction window, through the restored
// fail-closed reader (scripts/provider-recurring-items.js), suggestions not
// requested. FOUNDATION: nothing reads the result yet, so a failed read is
// recorded as unavailable and never fails the observation. Cancellation
// still cancels. Required lazily: that module requires this one.
async function fetchRecurringEvidence(token, txUrl, base, options) {
  try {
    const read = await require('./provider-recurring-items.js').fetchRecurringItems({
      startDate: txUrl.startDate, endDate: Forecast.addDays(txUrl.endDate, RECURRING_READ_LOOKAHEAD_DAYS),
      includeSuggested: false, token, base,
      fetchOptions: { signal: options && options.signal },
    });
    return { status: 'read', read };
  } catch (err) {
    if (options && options.signal && options.signal.aborted) throw err;
    return { status: 'unavailable', reason: 'recurring-read-failed' };
  }
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function parseIsoDate(value) {
  const d = dateOnly(value);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return d;
}

function calendarDaysBetween(from, to) {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) return null;
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  if (!isFinite(ms)) return null;
  return Math.round(ms / 86400000);
}

// Lunch Money v2: positive amount = debit, negative amount = credit.
// That sign is fixed and does not follow the user's display preference.
function lunchMoneyDebitAmount(amount) {
  // Qualify the provider's scalar decimal before conversion. JavaScript's
  // Number coercion would invent zero/one from blanks, booleans or arrays.
  if (typeof amount === 'string') {
    const decimal = amount.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal)) return null;
    amount = Number(decimal);
  }
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
}

function billPaymentPayees(plan, extra) {
  const labels = [];
  const push = value => {
    if (value == null || value === '') return;
    const s = String(value);
    if (!labels.some(x => x.toLowerCase() === s.toLowerCase())) labels.push(s);
  };
  for (const row of [].concat(
    extra || [],
    (plan && plan.bills) || [],
    (plan && plan.obligations) || [],
    (plan && plan.commitments) || []
  )) {
    if (typeof row === 'string') push(row);
    else if (row && row.label) push(row.label);
  }
  return labels;
}

function isBillOrPaymentTransaction(tx, plan, extraPayees) {
  if (!tx) return false;
  if (tx.kind === 'bill-payment' || tx.kind === 'payment') return true;
  const payee = tx.payee ? String(tx.payee).toLowerCase() : '';
  // The stamped bank descriptor (see stampIdentityDescriptors) survives a
  // Lunch Money payee rename. It is read forward only (descriptor contains
  // the label): a short raw descriptor never qualifies by being contained
  // in a longer bill label.
  const originals = (identityDescriptorFields(tx) || []).map(value => String(value).toLowerCase());
  if (!payee && !originals.length) return false;
  const billPay = /\b(bill payment|bill pay)\b/;
  if ((payee && billPay.test(payee)) || originals.some(value => billPay.test(value))) return true;
  return billPaymentPayees(plan, extraPayees).some((label) => {
    const l = String(label).toLowerCase();
    return (payee && (payee.includes(l) || l.includes(payee)))
      || originals.some(value => value.includes(l));
  });
}

function pendingForecastTreatment(tx, asOf, opts) {
  const historicalStatus = tx && tx.pending ? 'pending' : 'posted';
  if (!tx || !tx.pending) {
    return {
      treatment: 'confirmed-settled',
      historicalStatus,
      confidence: 'confirmed',
      conflict: false,
    };
  }
  if (tx.contradictoryEvidence === true || (opts && opts.contradictoryEvidence === true)) {
    return {
      treatment: 'unresolved',
      historicalStatus: 'pending',
      confidence: 'unresolved',
      conflict: true,
    };
  }
  if (tx.confirmedSettlement === true || (opts && opts.confirmedSettlement === true)) {
    return {
      treatment: 'confirmed-settled',
      historicalStatus: 'pending',
      confidence: 'confirmed',
      conflict: false,
    };
  }
  const age = calendarDaysBetween(tx.date, asOf);
  const billOrPayment = isBillOrPaymentTransaction(
    tx,
    opts && opts.plan,
    opts && opts.billPaymentPayees
  );
  if (billOrPayment && age != null && age > BILL_PAYMENT_PENDING_DAYS) {
    return {
      treatment: 'presumed-settled-for-current-forecast',
      historicalStatus: 'pending',
      confidence: 'inferred',
      conflict: false,
      ageDays: age,
    };
  }
  return {
    treatment: 'unresolved',
    historicalStatus: 'pending',
    confidence: 'unresolved',
    conflict: false,
    ageDays: age,
  };
}

function collapseByProviderTransactionId(transactions) {
  const byId = new Map();
  for (const tx of transactions || []) {
    const id = tx && tx.providerTransactionId;
    if (!id) continue;
    const list = byId.get(id) || [];
    list.push(tx);
    byId.set(id, list);
  }
  const collapsed = [];
  const identityEvidence = [];
  for (const [id, list] of byId) {
    const posted = list.filter(t => t.pending !== true);
    const pending = list.filter(t => t.pending === true);
    if (posted.length && pending.length && posted.length === 1) {
      const winner = posted[0];
      collapsed.push(Object.assign({}, winner, {
        pending: false,
        priorPending: true,
        identity: id,
      }));
      identityEvidence.push({
        providerTransactionId: id,
        transition: 'pending-to-posted',
        pendingCount: pending.length,
        postedCount: posted.length,
        ghostPending: false,
        doubleCounted: false,
      });
    } else if (posted.length > 1) {
      // Astra A3 (lead ruling (c)): one provider id delivered more than once
      // as posted is never resolved by picking a copy and never trusted as
      // complete. Matching the existing invariant that an exact duplicate
      // identity within one observation fails closed, every copy stays in
      // the shared list exactly as on main (other consumers' guards, and the
      // settlement crosswalk's ambiguity refusal, read the duplicate); the
      // actuals pass adds a dropped-row count, so transaction coverage is
      // incomplete and Forecast's coverage gate withholds dependent figures.
      const disagrees = POSTED_DUPLICATE_FIELDS.filter(field => {
        const first = postedDuplicateValue(posted[0], field);
        return posted.some(t => postedDuplicateValue(t, field) !== first);
      });
      // A pending copy beside two posted copies is the same transaction's
      // earlier state; only the posted copies are carried, as in the
      // pending-to-posted branch, so nothing counts as pending twice.
      collapsed.push(...posted);
      identityEvidence.push(Object.assign({
        providerTransactionId: id,
        transition: disagrees.length ? 'posted-duplicate-conflict' : 'posted-duplicate',
        pendingCount: pending.length,
        postedCount: posted.length,
        dropped: true,
        reason: disagrees.length ? 'posted-duplicate-disagrees' : 'posted-duplicate-identity',
      }, disagrees.length ? { disagreeingFields: disagrees } : {}));
    } else {
      collapsed.push(...list);
    }
  }
  return { transactions: collapsed, identityEvidence };
}

const POSTED_DUPLICATE_FIELDS = ['amount', 'date', 'account', 'currency'];

function postedDuplicateValue(tx, field) {
  if (field === 'amount') {
    const n = Number(tx.amount);
    return tx.amount == null || tx.amount === '' || !Number.isFinite(n) ? 'raw:' + String(tx.amount) : String(n);
  }
  if (field === 'date') return dateOnly(tx.date) || 'raw:' + String(tx.date);
  if (field === 'account') return String(tx.providerAccountId);
  return String(tx.currency);
}

function pendingComponentsForCard(transactions, mapping, asOf, opts) {
  const accountId = mapping && mapping.providerAccountId != null
    ? String(mapping.providerAccountId) : null;
  if (!accountId || !CREDIT_ROLES.has(mapping.atlasRole)) return [];
  const components = [];
  for (const tx of transactions || []) {
    if (String(tx.providerAccountId) !== accountId) continue;
    if (tx.pending !== true) continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    if (amount == null) continue;
    const treatment = pendingForecastTreatment(tx, asOf, opts);
    components.push({
      providerTransactionId: tx.providerTransactionId,
      date: tx.date,
      payee: tx.payee,
      amount,
      sign: amount >= 0 ? 'debit' : 'credit',
      pending: true,
      settlementTreatment: treatment.treatment,
      historicalStatus: treatment.historicalStatus,
      confidence: treatment.confidence,
      conflict: treatment.conflict === true,
      contributesToCurrentPending: treatment.treatment === 'unresolved' && treatment.conflict !== true,
    });
  }
  return components;
}

// A pending row on the card whose amount or date is unusable is not absent.
// It is counted here so the card's pending exposure stays unknown instead of
// becoming a proven zero (or a partial sum) under complete coverage. The
// caller passes the normalized rows from before every collapse (the
// provider-id collapse drops a pending copy beside a posted twin, and the
// settlement-identity collapse sets undated rows aside).
function invalidPendingRowsForCard(transactions, mapping) {
  const accountId = mapping && mapping.providerAccountId != null
    ? String(mapping.providerAccountId) : null;
  if (!accountId || !CREDIT_ROLES.has(mapping.atlasRole)) return 0;
  return (transactions || []).filter(tx => tx
    && String(tx.providerAccountId) === accountId
    && tx.pending === true
    && (lunchMoneyDebitAmount(tx.amount) == null || !dateOnly(tx.date))).length;
}

function netCurrentPending(components) {
  let sum = 0;
  let unresolved = 0;
  for (const c of components || []) {
    if (!c.contributesToCurrentPending) continue;
    unresolved += 1;
    sum += Number(c.amount);
  }
  return { amount: round2(sum), unresolved };
}

function inferredCardState(posted, pending, limit) {
  const postedN = posted == null || !isFinite(Number(posted)) ? null : Number(posted);
  const pendingN = pending == null || !isFinite(Number(pending)) ? null : Number(pending);
  const limitN = limit == null || !isFinite(Number(limit)) ? null : Number(limit);
  if (postedN == null || pendingN == null) {
    return {
      posted: postedN,
      pending: pendingN,
      exposure: null,
      limit: limitN,
      overLimit: null,
      kind: 'inference-from-posted-plus-pending',
      householdCash: 0,
      unknown: true,
    };
  }
  const exposure = round2(postedN + pendingN);
  const overLimit = limitN == null ? null : round2(Math.max(0, exposure - limitN));
  return {
    posted: postedN,
    pending: pendingN,
    exposure,
    limit: limitN,
    overLimit,
    kind: 'inference-from-posted-plus-pending',
    householdCash: 0,
    unknown: false,
  };
}

function pendingObservationsFromTransactions(input) {
  const mapDoc = input.accountMap;
  const asOf = dateOnly(input.asOf || input.fetchedAt);
  const opts = {
    plan: input.plan,
    billPaymentPayees: input.billPaymentPayees,
  };
  const coverage = input.pendingCoverage
    || classifyPendingCoverage(input.payload || input);
  const out = [];
  for (const mapping of (mapDoc && mapDoc.mappings) || []) {
    if (!CREDIT_ROLES.has(mapping.atlasRole) || !mapping.canonical || !mapping.canonical.id) {
      continue;
    }
    const components = pendingComponentsForCard(
      input.transactions, mapping, asOf, opts
    );
    const invalidPending = invalidPendingRowsForCard(
      input.unusablePendingSource || input.transactions, mapping);
    if (invalidPending > 0) {
      out.push({
        observationId: `lm-${mapping.providerAccountId}-pending`,
        fact: 'pending',
        cardId: mapping.canonical.id,
        provider: 'lunchmoney',
        providerAccountId: String(mapping.providerAccountId),
        accountLabel: mapping.canonical.id,
        evidenceValue: null,
        observedAsOf: asOf,
        evidenceDate: asOf,
        unknown: true,
        unknownReason: 'invalid-pending-row',
        invalidPendingCount: invalidPending,
        balanceIncludesPending: false,
        pendingCoverage: coverage.status,
        pendingProof: null,
        canonical: { collection: 'debts', id: mapping.canonical.id, field: 'pending' },
        source: 'provider-observe:lunchmoney-transactions',
        note: 'A pending transaction on this card has an unusable amount or date. Pending exposure is unknown, not zero. Posted balance is a separate fact. Not household cash.',
        components,
      });
      continue;
    }
    if (!components.length) {
      if (!coverage.complete) continue;
      out.push({
        observationId: `lm-${mapping.providerAccountId}-pending`,
        fact: 'pending',
        cardId: mapping.canonical.id,
        provider: 'lunchmoney',
        providerAccountId: String(mapping.providerAccountId),
        accountLabel: mapping.canonical.id,
        evidenceValue: 0,
        observedAsOf: asOf,
        evidenceDate: asOf,
        unknown: false,
        balanceIncludesPending: false,
        pendingCoverage: coverage.status,
        pendingProof: coverage.basis,
        canonical: { collection: 'debts', id: mapping.canonical.id, field: 'pending' },
        source: 'provider-observe:lunchmoney-transactions',
        note: 'Proven zero pending from a completed is_pending=true query with no date bound. Absence inside a bounded include_pending window is not this proof. Posted balance is a separate fact. Not household cash.',
        components: [],
      });
      continue;
    }
    const net = netCurrentPending(components);
    const allSettledForForecast = net.unresolved === 0 && components.every(c =>
      c.settlementTreatment === 'presumed-settled-for-current-forecast'
      || c.settlementTreatment === 'confirmed-settled');
    const unknown = !allSettledForForecast && components.length > 0
      && components.every(c => c.conflict);
    out.push({
      observationId: `lm-${mapping.providerAccountId}-pending`,
      fact: 'pending',
      cardId: mapping.canonical.id,
      provider: 'lunchmoney',
      providerAccountId: String(mapping.providerAccountId),
      accountLabel: mapping.canonical.id,
      evidenceValue: unknown ? null : net.amount,
      observedAsOf: asOf,
      evidenceDate: asOf,
      unknown: !!unknown,
      balanceIncludesPending: false,
      pendingCoverage: coverage.status,
      pendingProof: coverage.complete ? coverage.basis : null,
      canonical: { collection: 'debts', id: mapping.canonical.id, field: 'pending' },
      source: 'provider-observe:lunchmoney-transactions',
      note: allSettledForForecast
        ? 'Aged pending bill/payment excluded from current pending; historical status remains pending.'
        : 'Pending exposure from mapped provider transactions. Posted balance is a separate fact. Not household cash.',
      components,
    });
  }
  return out;
}

function payeeMatches(payee, pattern, mode) {
  if (!payee || !pattern) return false;
  const left = String(payee).trim().toLowerCase();
  const right = String(pattern).trim().toLowerCase();
  if (mode === 'exact') return left === right;
  return left.includes(right);
}

function rulePayeeMatchMode(rule) {
  const mode = rule && String(rule.payeeMatchMode || '').trim().toLowerCase();
  return mode === 'exact' ? 'exact' : 'includes';
}

const WEEKEND_NEXT_BUSINESS_DAY = 'same-day-or-weekend-next-business-day';
const COVER_DUE_ON_OR_BEFORE_POSTING = 'covers-due-on-or-before-posting';
const COVER_EARLY_OR_DUE_ON_OR_BEFORE_POSTING = 'covers-early-or-due-on-or-before-posting';
const COVER_STATEMENT_CYCLE_OR_LATEST_DUE = 'covers-statement-cycle-or-latest-due';
// S3 (lead ruling 2026-11-17, after #1284; Grok Bot asked): a rule that
// names exactly one reviewed Lunch Money recurring item may opt in with
// settlementFrom 'lunchmoney-matched-occurrences'. When that item's own
// matches are consistent, Lunch Money's pairing decides which occurrence each
// linked payment settles. Atlas adds no matching of its own: it only orders
// LM's matched dates and found payments when their counts agree. Otherwise the rule's
// incumbent postingDateRule applies unchanged.
const SETTLEMENT_FROM_LM_MATCHED = 'lunchmoney-matched-occurrences';
const LM_MATCHED_RELATION = 'lunchmoney-matched-occurrence';
// The recurring read reaches this far past the transaction window's end, so
// Lunch Money can report the next expected occurrence a payment made early
// was matched to. Same GET, wider end date.
const RECURRING_READ_LOOKAHEAD_DAYS = 31;
// The pairing is held beside each transaction object, never on it, so it
// cannot reach the report, the packet or replay memory. A copied row carries
// no pairing and falls back to the incumbent rule (fail closed).
const LM_MATCHED = new WeakMap();
// Opt-in bounded late window (adopted bills blueprint #787 6595179923:
// explicit identity windows, two days): a rule that names this
// postingDateRule matches a payment posted on the due date or up to two days
// after it, never earlier and never three days late. A rule without a
// postingDateRule stays same-day; no default widens.
const DUE_OR_UP_TO_TWO_DAYS_AFTER = 'due-or-up-to-two-days-after';
const DUE_OR_UP_TO_TWO_DAYS_AFTER_DAYS = 2;
const SETTLES_WHEN_AMOUNT_AT_LEAST = 'amount-at-least';
const SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT = 'exact-scheduled-amount';
// Q2, owner decision (Dale, 2026-11-18, #821 6967081727): Amanda's two salary
// streams. A posted CAD credit into the rule's account settles an occurrence
// once, at its actual amount, when it is within amountToleranceDollars of THAT
// occurrence's scheduled amount and posts within postingBusinessDays business
// days (Forecast's Monday-to-Friday count) before or after the projected payday.
// Amount and timing are the identity here; nothing else is. Fail closed: two
// qualifying credits for one occurrence, or one credit qualifying for two
// occurrences, settle nothing (To confirm). Never a pending row, an excluded
// payee (refund, reversal, reimbursement), an internal household transfer, or a
// credit another rule identifies.
const SETTLES_WHEN_NEAR_AMOUNT_AND_PAYDAY = 'near-scheduled-amount-and-payday';
const NEAR_PAYDAY_RELATION = 'near-projected-payday';
// Words that mark a credit as not salary (owner decision 6967081727: reimbursements, coaching and refunds never
// qualify), read in the payee, the original bank name, the Lunch Money category, the notes and the tags (#1294 review).
const NEAR_PAYDAY_EXCLUDED_WORDS = Object.freeze([/REFUND/i, /REVERSAL/i, /REIMBURS/i, /COACH/i, /BUSINESS/i]);
// An income category counts only when its name says salary, or it is Lunch Money's generic "Income"; any other
// income category (coaching, business, reimbursement, "Other income") is not her pay.
const NEAR_PAYDAY_SALARY_CATEGORY = /SALARY|PAYROLL|PAYCHE|\bPAY\b|WAGE|^\s*INCOME\s*$/i;
const SETTLES_WHEN_TWO_LEG_SUM = 'two-leg-sum';
const SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE = 'schedule-trust-on-due';
const INHERITED_PENDING_AUTHORIZATION = 'inherited-pending-authorization';
const COVER_DUE_LOOKBACK_DAYS = 62;
// covers-due-on-or-before-posting is a recurring "latest due" relation.
// A once occurrence is not a series: reuse after this grace would attach a
// later same-alias debit to an already-scheduled once bill.
const ONCE_COVER_GRACE_DAYS = 7;
const EARLY_PAY_LOOKAHEAD_DAYS = 7;
const IDENTITY_AMOUNT_EPSILON = 0.005;

function ruleEarlyPayLookaheadDays(rule) {
  const fallback = EARLY_PAY_LOOKAHEAD_DAYS;
  if (!rule || rule.postingDateRule !== COVER_EARLY_OR_DUE_ON_OR_BEFORE_POSTING) {
    return fallback;
  }
  const raw = rule.earlyPayLookaheadDays;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, COVER_DUE_LOOKBACK_DAYS);
}

function rulePayeePatterns(rule) {
  const values = [].concat((rule && rule.payeePatterns) || [],
    rule && rule.payeePattern ? [rule.payeePattern] : []);
  return Array.from(new Set(values.map(value => String(value).trim()).filter(Boolean)));
}

function rulePayeeExcludePatterns(rule) {
  const values = [].concat((rule && rule.payeeExcludePatterns) || [],
    rule && rule.payeeExcludePattern ? [rule.payeeExcludePattern] : []);
  return Array.from(new Set(values.map(value => String(value).trim()).filter(Boolean)));
}

function ruleOriginalNamePatterns(rule) {
  const values = [].concat((rule && rule.originalNamePatterns) || [],
    rule && rule.originalNamePattern ? [rule.originalNamePattern] : []);
  return Array.from(new Set(values.map(value => String(value).trim()).filter(Boolean)));
}

function identityPayeeFields(tx) {
  return [tx && tx.payee, tx && tx.displayedPayee];
}

function identityOriginalNameFields(tx) {
  return [tx && tx.originalName, tx && tx.original_name, tx && tx.originalMerchant];
}

function anyIdentityFieldMatches(fields, pattern, mode) {
  return (fields || []).some(value => payeeMatches(value, pattern, mode));
}

// Displayed-payee rename survival. Lunch Money never rewrites original_name,
// so a household-debit rule (bill or subscription) whose payee patterns are
// substring fragments reads them against the bank's original descriptor: a
// displayed-payee rename can neither break nor forge that match. Exact-mode
// patterns, and rules that gate a separate originalNamePatterns list, are
// written against the displayed payee by construction and keep that reading.
function ruleReadsOriginalDescriptorFirst(rule) {
  return !!rule && rule.direction === 'debit'
    && rulePayeeMatchMode(rule) !== 'exact'
    && ruleOriginalNamePatterns(rule).length === 0;
}

const IDENTITY_DESCRIPTOR = Symbol('atlas.identityDescriptor');

// Stamped once per observation against the complete identity rule set.
// A descriptor that any guarded rule's originalNamePatterns claims stays on
// the incumbent displayed reading, so an unguarded sibling cannot take it
// past that guarded rule's posted / currency / exact-payee gates. No stamp
// (or no original descriptor) means the incumbent displayed reading.
function stampIdentityDescriptors(transactions, rules) {
  const guards = [].concat(...(rules || []).map(ruleOriginalNamePatterns));
  for (const tx of transactions || []) {
    if (!tx || typeof tx !== 'object' || Object.hasOwn(tx, IDENTITY_DESCRIPTOR)) continue;
    const originals = identityOriginalNameFields(tx)
      .filter(value => value != null && String(value).trim() !== '');
    const guarded = originals.some(value => guards.some(pattern => payeeMatches(value, pattern)));
    Object.defineProperty(tx, IDENTITY_DESCRIPTOR, {
      value: originals.length && !guarded ? originals : null, enumerable: false });
  }
  return transactions;
}

function identityDescriptorFields(tx) {
  const fields = tx && tx[IDENTITY_DESCRIPTOR];
  return Array.isArray(fields) && fields.length ? fields : null;
}

function payeeMatchesRule(tx, rule) {
  if (!tx || !rule) return false;
  const originalFields = identityOriginalNameFields(tx);
  const descriptorFields = ruleReadsOriginalDescriptorFirst(rule) ? identityDescriptorFields(tx) : null;
  const payeeFields = descriptorFields || identityPayeeFields(tx);
  const matchMode = rulePayeeMatchMode(rule);
  if (!rulePayeePatterns(rule).some(pattern => anyIdentityFieldMatches(payeeFields, pattern, matchMode))) {
    return false;
  }
  const originalPatterns = ruleOriginalNamePatterns(rule);
  if (originalPatterns.length
      && !originalPatterns.some(pattern => anyIdentityFieldMatches(originalFields, pattern))) {
    return false;
  }
  if (rulePayeeExcludePatterns(rule).some(pattern =>
    anyIdentityFieldMatches(identityPayeeFields(tx), pattern)
    || anyIdentityFieldMatches(originalFields, pattern))) {
    return false;
  }
  return true;
}

function transactionIsTransfer(tx) {
  if (!tx || tx.isIncome === true) return false;
  const kind = String(tx.kind || '').toLowerCase();
  if (kind === 'transfer' || kind === 'internal-transfer') return true;
  if (tx.excludeFromTotals === true) return true;
  return /transfer/i.test(String(tx.categoryLabel || ''));
}

function ruleCounterpartExternalId(rule) {
  const value = rule && rule.counterpartExternalId;
  return value != null && String(value).trim() !== '' ? String(value).trim() : '';
}

function mappingExternalId(mapping) {
  const value = mapping && mapping.externalId;
  return value != null && String(value).trim() !== '' ? String(value).trim() : '';
}

function amountsMatchExactly(left, right) {
  return isFinite(left) && isFinite(right)
    && Math.abs(Math.abs(Number(left)) - Math.abs(Number(right))) <= IDENTITY_AMOUNT_EPSILON;
}

function transferCounterpartMatches(tx, rule, input, amount, diagnostic) {
  const counterpartId = ruleCounterpartExternalId(rule);
  if (!tx || !counterpartId) return [];
  const mapDoc = input && input.accountMap;
  const matches = [];
  for (const other of (input && input.transactions) || []) {
    if (!other || other === tx) continue;
    if (!hasPostedReceipt(other)) continue;
    if (String(other.date || '') !== String(tx.date || '')) continue;
    if (!transactionIsTransfer(other)) continue;
    const mapping = mappingFor(mapDoc, other.providerAccountId);
    const roleMatches = !!mapping && mapping.atlasRole === EXTERNAL_LIVE_ROLE;
    diagnostic?.record(rule.eventId, 'externalRole', roleMatches,
      roleMatches ? undefined : 'SOURCE_ROLE_MISMATCH');
    if (!roleMatches) continue;
    const identityMatches = mappingExternalId(mapping) === counterpartId;
    diagnostic?.record(rule.eventId, 'externalIdentity', identityMatches,
      identityMatches ? undefined : 'EXTERNAL_ID_MISMATCH');
    if (!identityMatches) continue;
    const otherAmount = lunchMoneyDebitAmount(other.amount);
    const amountMatches = otherAmount > 0 && amountsMatchExactly(otherAmount, amount);
    diagnostic?.record(rule.eventId, 'amountGuard', amountMatches,
      amountMatches ? undefined : 'AMOUNT_GUARD_MISMATCH');
    if (!amountMatches) continue;
    matches.push(other);
  }
  return matches;
}

function uniqueTransferCounterpart(tx, rule, input, amount, diagnostic) {
  const matches = transferCounterpartMatches(tx, rule, input, amount, diagnostic);
  diagnostic?.record(rule.eventId, 'counterpart', matches.length === 1,
    matches.length === 1 ? undefined : matches.length ? 'COUNTERPART_AMBIGUOUS' : 'COUNTERPART_MISSING');
  return matches.length === 1 ? matches[0] : null;
}

function countTransferCounterparts(tx, rule, input, amount, diagnostic) {
  const count = transferCounterpartMatches(tx, rule, input, amount, diagnostic).length;
  diagnostic?.record(rule.eventId, 'counterpart', count === 1,
    count === 1 ? undefined : count ? 'COUNTERPART_AMBIGUOUS' : 'COUNTERPART_MISSING');
  return count;
}

// Lunch Money recurring-item identity (owner, 2026-11-11). A rule that names
// lunchMoneyRecurringIds identifies its event by the row's Lunch Money
// recurring link: no payee, original-name, note or amount fragment
// substitutes for it or widens it. Account, direction, posting-date relation,
// currency, posting evidence and the shared amount-consistency bound still
// apply through the incumbent matcher. Generic for any rule; configured only
// where transaction-identity.json names the ids.
// Recurring link alongside payee rules (Grok rule 4, link order 1 of 3): a
// rule may name both. A row carrying one of the rule's recurring ids links;
// otherwise the rule's existing payee patterns still apply exactly as before,
// so adding a recurring id never removes a link (retiring payee rules is a
// later, separately proven step). A rule with recurring ids and no payee
// patterns (rehearsal-space) reads the recurring link alone, as before. A row
// two rules claim stays on the incumbent transaction-consumed-twice path.
function ruleLunchMoneyRecurringIds(rule) {
  const values = Array.isArray(rule && rule.lunchMoneyRecurringIds) ? rule.lunchMoneyRecurringIds : [];
  return Array.from(new Set(values.filter(value => value != null)
    .map(value => String(value).trim()).filter(Boolean)));
}

// Lunch Money item-note identity (Grok rule 4, link order 2 of 3). A rule that
// names lunchMoneyItemNames links a row whose note carries exactly one
// deliberate "item: <name>" part (";"-separated; prefix in any case, spaces
// ignored) whose name equals one of the rule's names, ignoring case. A note
// with two item parts links nothing by note. Lunch Money's auto-copied
// recurring description has no prefix and never counts. Alongside, not
// instead: the rule's other link sources still apply as before.
const ITEM_NOTE_PREFIX = 'item:';
function normalizeItemName(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
function ruleLunchMoneyItemNames(rule) {
  const values = Array.isArray(rule && rule.lunchMoneyItemNames) ? rule.lunchMoneyItemNames : [];
  return Array.from(new Set(values.map(normalizeItemName).filter(Boolean)));
}
// Grok Bot's bill verification marker (owner, Dale, 2026-11-20, #821 7046237901; Grok Bot, Plan #6 thread,
// ts 1795188508.458429): the exact text "bill verified" at the start of ANY line of the payment's note, then the
// end of the line or an optional comment starting " - " or " (". Case-sensitive, no leading space; every line is
// read. The note carries no amount and no bill name: the verified amount is the row's own, and the bill link is
// the incumbent one (rule 17: Atlas only reads the marker). Only the boolean leaves this file, never the note.
// Grok Bot's note can only be appended to, so a later "bill not verified" line withdraws an earlier "bill verified":
// the LAST marker line decides (Grok Bot, Plan #6 thread, after ts 1795212883.667279).
const BILL_VERIFIED_LINE = /^bill (not )?verified(?:$| - | \()/;
function billVerifiedMarker(notes) {
  if (typeof notes !== 'string') return false;
  let verified = false;
  for (const line of notes.split(/\r\n|\r|\n/)) {
    const m = BILL_VERIFIED_LINE.exec(line);
    if (m) verified = m[1] === undefined;
  }
  return verified;
}

function noteItemNames(notes) {
  if (typeof notes !== 'string') return [];
  return notes.split(';').map(part => part.trim())
    .filter(part => part.slice(0, ITEM_NOTE_PREFIX.length).toLowerCase() === ITEM_NOTE_PREFIX)
    .map(part => normalizeItemName(part.slice(ITEM_NOTE_PREFIX.length)));
}

// Single-bill category identity (Grok rule 4, link order 3 of 3). A rule that
// names lunchMoneyCategoryIds links a row whose Lunch Money category_id is one
// of them, exactly. Opt-in and empty until Dale confirms each category; a
// category id named by two rules is refused for both before any row is
// matched (the config test also fails). Each entry is { id, name }: the id is
// the identity and the name is the category as Dale confirmed it. Grok Bot
// (recorded on #1207, 6927147873): a category renamed or removed in Lunch
// Money makes its link read To confirm, never move to another bill. So a row
// in the claimed id whose ledger category name is not the confirmed name links
// nothing, and the claim still keeps every other rule off it. An entry with no
// name cannot be checked, so it never links (fail closed).
function categoryEntryId(value) {
  const id = value && typeof value === 'object' ? value.id : value;
  return id == null ? '' : String(id).trim();
}
function ruleLunchMoneyCategoryIds(rule) {
  const values = Array.isArray(rule && rule.lunchMoneyCategoryIds) ? rule.lunchMoneyCategoryIds : [];
  return Array.from(new Set(values.map(categoryEntryId).filter(Boolean)));
}
function normalizeCategoryName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}
// True only when the row's ledger category name is the confirmed name for that id.
function categoryNameConfirmed(rule, categoryId, ledgerName) {
  const values = Array.isArray(rule && rule.lunchMoneyCategoryIds) ? rule.lunchMoneyCategoryIds : [];
  const names = values.filter(value => value && typeof value === 'object' && categoryEntryId(value) === categoryId)
    .map(value => normalizeCategoryName(value.name)).filter(Boolean);
  const ledger = normalizeCategoryName(ledgerName);
  return names.length > 0 && !!ledger && names.every(name => name === ledger);
}

// The one confirmed name recorded for that category id, as written; null when none or several.
function confirmedCategoryName(rule, categoryId) {
  const values = Array.isArray(rule && rule.lunchMoneyCategoryIds) ? rule.lunchMoneyCategoryIds : [];
  const names = values.filter(value => value && typeof value === 'object' && categoryEntryId(value) === categoryId)
    .map(value => typeof value.name === 'string' ? value.name.replace(/\s+/g, ' ').trim() : '').filter(Boolean);
  const distinct = Array.from(new Set(names.map(normalizeCategoryName)));
  return distinct.length === 1 ? names[0] : null;
}

// Category ids that more than one rule names. Refused for every rule.
function duplicatedRuleCategoryIds(rules) {
  const seen = new Map();
  for (const rule of rules || []) {
    for (const id of ruleLunchMoneyCategoryIds(rule)) {
      const owners = seen.get(id) || new Set();
      owners.add(rule.eventId);
      seen.set(id, owners);
    }
  }
  return new Set([...seen].filter(([, owners]) => owners.size > 1).map(([id]) => id));
}

// Link sources claimed anywhere in the rule set a rule was read with (Grok,
// Plan #6, 2026-11-16): the order is recurring link, then "item:" note, then
// single-bill category, then payee rule last, and each payment counts once
// against the winning bill. A row whose recurring_id, single item name or
// category another rule names is not taken by a lower-ranked source here. Exception: a recurring link and an item note
// naming DIFFERENT bills both still match, so neither wins and the row is
// held ambiguous (the incumbent consumed-twice path: To confirm).
// Stamped on every rule each time a rule set is read; a rule read on a path
// that never stamped it keeps its incumbent reading and links by no category
// (fail closed). A rule's own usable category ids can only narrow.
const RULE_SET_RECURRING_CLAIMS = Symbol('atlas.ruleSetRecurringClaims');
const RULE_SET_ITEM_CLAIMS = Symbol('atlas.ruleSetItemClaims');
const RULE_SET_CATEGORY_CLAIMS = Symbol('atlas.ruleSetCategoryClaims');
const CATEGORY_CLAIMS = Symbol('atlas.categoryClaims');
function stampRuleSetClaims(rules) {
  // A missing rule set reads as empty, as before; any other non-array is
  // returned untouched so malformed input keeps its incumbent failure.
  if (rules == null) return [];
  if (!Array.isArray(rules)) return rules;
  const claimed = new Set();
  const claimedItems = new Set();
  const claimedCategories = new Set();
  const duplicated = duplicatedRuleCategoryIds(rules.filter(rule => rule && typeof rule === 'object'));
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    ruleLunchMoneyRecurringIds(rule).forEach(id => claimed.add(id));
    ruleLunchMoneyItemNames(rule).forEach(name => claimedItems.add(name));
    ruleLunchMoneyCategoryIds(rule).forEach(id => { if (!duplicated.has(id)) claimedCategories.add(id); });
  }
  const set = (rule, key, value) => Object.defineProperty(rule, key,
    { configurable: true, enumerable: true, writable: true, value });
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    set(rule, RULE_SET_RECURRING_CLAIMS, claimed);
    set(rule, RULE_SET_ITEM_CLAIMS, claimedItems);
    set(rule, RULE_SET_CATEGORY_CLAIMS, claimedCategories);
    // Only ever narrows: a later read of a subset cannot un-refuse a duplicate.
    const prior = Array.isArray(rule[CATEGORY_CLAIMS]) ? new Set(rule[CATEGORY_CLAIMS]) : null;
    set(rule, CATEGORY_CLAIMS, ruleLunchMoneyCategoryIds(rule)
      .filter(id => !duplicated.has(id) && (!prior || prior.has(id))));
  }
  return rules;
}
function ruleCategoryClaims(rule) {
  return rule && Array.isArray(rule[CATEGORY_CLAIMS]) ? rule[CATEGORY_CLAIMS] : [];
}
// The row's category is another rule's usable single-bill category: that
// rule's category link outranks this rule's payee rule (Grok's order).
function categoryClaimedElsewhere(rule, categoryId) {
  const claimed = rule && rule[RULE_SET_CATEGORY_CLAIMS];
  return !!(categoryId && claimed instanceof Set && claimed.has(categoryId)
    && !ruleLunchMoneyCategoryIds(rule).includes(categoryId));
}
// The note's single deliberate item names another rule's bill: that rule's
// item link outranks this rule's payee rule (Grok's order).
function itemNoteClaimedElsewhere(rule, items) {
  const claimed = rule && rule[RULE_SET_ITEM_CLAIMS];
  return !!(items.length === 1 && claimed instanceof Set && claimed.has(items[0])
    && !ruleLunchMoneyItemNames(rule).includes(items[0]));
}
function recurringLinkClaimedElsewhere(rule, linkedTo) {
  const claimed = rule && rule[RULE_SET_RECURRING_CLAIMS];
  return !!(linkedTo && claimed instanceof Set && claimed.has(linkedTo)
    && !ruleLunchMoneyRecurringIds(rule).includes(linkedTo));
}

function ruleHasIdentity(rule, diagnostic) {
  // Also used directly as Array.filter's predicate, which passes its index.
  if (typeof diagnostic?.record !== 'function') diagnostic = null;
  if (!rule || !rule.eventId) return false;
  if (rule.settlesWhen === SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE) return true;
  if (nearPaydayRule(rule)) return true;
  if (rule.transactionKind === 'transfer') {
    const present = !!ruleCounterpartExternalId(rule);
    diagnostic?.record(rule.eventId, 'externalIdentity', present,
      present ? undefined : 'EXTERNAL_ID_MISSING');
    return present;
  }
  if (ruleLunchMoneyRecurringIds(rule).length) return true;
  if (ruleLunchMoneyItemNames(rule).length) return true;
  if (ruleLunchMoneyCategoryIds(rule).length) return true;
  return rulePayeePatterns(rule).length > 0;
}

function hasPostedReceipt(tx) {
  // Normalization retains affirmative provider evidence separately from the
  // display-oriented pending boolean. A missing flag can project false there.
  return !!tx && tx.pending === false && tx.savingsPostingEvidence === 'posted'
    && tx.contradictoryEvidence !== true;
}

function ruleMatchesTransactionIdentity(tx, rule) {
  return hasPostedReceipt(tx) && matchesIdentityFields(tx, rule);
}

// Pending-bill disclosure and replacement inheritance can find an identity
// here. Only a posted receipt can settle it.
function matchesIdentityFields(tx, rule) {
  if (!tx || !rule) return false;
  // A near-amount-and-payday rule is matched only by nearPaydaySalaryHits.
  if (rule.settlesWhen === SETTLES_WHEN_NEAR_AMOUNT_AND_PAYDAY) return false;
  // An explicit posting qualifier also constrains candidate-only paths.
  if (Object.hasOwn(rule, 'requiredPostingEvidence')
      && (rule.requiredPostingEvidence !== 'posted' || !hasPostedReceipt(tx))) {
    return false;
  }
  if (rulePayeeExcludePatterns(rule).some(pattern =>
    anyIdentityFieldMatches(identityPayeeFields(tx), pattern)
    || anyIdentityFieldMatches(identityOriginalNameFields(tx), pattern))) {
    return false;
  }
  const recurringIds = ruleLunchMoneyRecurringIds(rule);
  const itemNames = ruleLunchMoneyItemNames(rule);
  const linkedTo = tx.recurringId == null ? '' : String(tx.recurringId).trim();
  if (recurringIds.length && linkedTo && recurringIds.includes(linkedTo)) return true;
  const items = noteItemNames(tx.notes);
  // Matched even when the row's recurring link names another bill: the two
  // deliberate links then disagree and neither wins (To confirm).
  if (itemNames.length && items.length === 1 && itemNames.includes(items[0])) return true;
  // Either deliberate link elsewhere outranks this rule's payee rule.
  if (recurringLinkClaimedElsewhere(rule, linkedTo)) return false;
  if (itemNoteClaimedElsewhere(rule, items)) return false;
  // Single-bill category, below the recurring link and the item note.
  const categoryId = tx.categoryId == null ? '' : String(tx.categoryId).trim();
  if (categoryId && ruleCategoryClaims(rule).includes(categoryId)) {
    // Renamed (or unnamed) since Dale confirmed it: To confirm, no link and no payee fallback.
    return categoryNameConfirmed(rule, categoryId, tx.categoryLabel);
  }
  if (categoryClaimedElsewhere(rule, categoryId)) return false;
  if ((recurringIds.length || itemNames.length || ruleLunchMoneyCategoryIds(rule).length)
      && !rulePayeePatterns(rule).length) return false;
  if (rule.transactionKind === 'transfer') {
    if (!transactionIsTransfer(tx)) return false;
    if (!ruleCounterpartExternalId(rule)) return false;
    if (!rulePayeePatterns(rule).length) return true;
  }
  return payeeMatchesRule(tx, rule);
}

// A mapped CAD account does not qualify an individual transaction's units.
// These opt-in rules accept native plan-currency evidence only. Provider FX
// amounts (to_base) are not an authorized conversion/settlement contract.
function ruleCurrencyQualified(tx, rule) {
  if (!rule.requiredCurrency) return true;
  return tx.currencySettlementUnconfirmed !== true
    && typeof tx.currency === 'string'
    && tx.currency.trim().toLowerCase() === rule.requiredCurrency;
}

function currencyRulesForTransaction(tx, accountMap, rules, plan) {
  // The standalone sanitizer permits an absent map. That caller cannot
  // establish a mapped settlement identity; preserve its incomplete packet.
  if (!accountMap) return [];
  const mapping = mappingFor(accountMap, tx && tx.providerAccountId);
  const accountId = mapping && mapping.canonical && mapping.canonical.id;
  return stampRuleSetClaims(rules).filter(rule => rule.requiredCurrency
    && (!rule.atlasAccountId || rule.atlasAccountId === accountId)
    // Reuse the incumbent matcher for direction and occurrence eligibility.
    // Removing this one guard tests candidacy; it never qualifies settlement.
    && collectIdentityHits(tx, { accountMap, plan },
      [{ ...rule, requiredCurrency: null }]).length > 0);
}

function ruleIdentityLabel(rule) {
  if (rule && rule.transactionKind === 'transfer') {
    return ruleCounterpartExternalId(rule)
      ? 'transfer+counterpart+account+date'
      : 'transfer+account+date';
  }
  if (ruleLunchMoneyRecurringIds(rule).length) return 'lunchmoney-recurring+account+date';
  return 'payee+account+date';
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateWithClampedDay(year, month, day) {
  const clamped = Math.min(Number(day), daysInUtcMonth(year, month));
  if (!isFinite(clamped) || clamped < 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function statementCloseDayForEvent(plan, event) {
  const debtId = event && event.debtId;
  if (!debtId) return null;
  const debt = ((plan && plan.debts) || []).find(row => row && row.id === debtId);
  const day = debt && debt.statementCloseDay;
  if (!isFinite(Number(day)) || Number(day) < 1 || Number(day) > 31) return null;
  return Number(day);
}

function statementCloseDateForDue(dueDate, closeDay) {
  const due = parseIsoDate(dueDate);
  if (!due || !isFinite(Number(closeDay))) return null;
  const [year, month] = due.split('-').map(Number);
  const thisMonth = dateWithClampedDay(year, month, closeDay);
  if (thisMonth && thisMonth < due) return thisMonth;
  let priorYear = year;
  let priorMonth = month - 1;
  if (priorMonth < 1) {
    priorMonth = 12;
    priorYear -= 1;
  }
  return dateWithClampedDay(priorYear, priorMonth, closeDay);
}

function coveringStatementCycleDates(plan, rule, postingDate) {
  const posted = parseIsoDate(postingDate);
  if (!plan || !rule || !rule.eventId || !posted) return [];
  const from = Forecast.addDays(posted, -COVER_DUE_LOOKBACK_DAYS);
  const to = Forecast.addDays(posted, COVER_DUE_LOOKBACK_DAYS);
  if (!from || !to) return [];
  const events = scheduledEventsOnRange(plan, from, to)
    .filter(event => event && event.id === rule.eventId);
  const matching = [];
  for (const event of events) {
    const closeDay = statementCloseDayForEvent(plan, event);
    if (closeDay == null) continue;
    const closeDate = statementCloseDateForDue(event.date, closeDay);
    if (!closeDate || posted < closeDate) continue;
    matching.push(event);
  }
  if (!matching.length) return [];
  const outstanding = matching.filter(event => event.date <= posted)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (outstanding.length) {
    const latest = outstanding[0].date;
    if (outstanding.filter(event => event.date === latest).length !== 1) return [];
    return [latest];
  }
  const upcoming = matching.filter(event => event.date > posted)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (upcoming.length !== 1) return [];
  return [upcoming[0].date];
}

// Lead dispatch 2026-11-18 (the #1313 answer key's known gap): a payroll
// credit dated within one business day after its payday (Friday's pay landing
// Saturday or Monday) settles that payday once, at its actual amount, through
// the matcher's own ambiguity rules: a second candidate for the payday, or a
// credit the matcher can place on two occurrences, stays To confirm. Only the
// plain payroll rule qualifies (a credit identity with no posting-date rule, no
// settlement mode and no transfer kind); Amanda's near-amount rule keeps its own
// window. The late payday must be the payroll occurrence just before the credit,
// with none on the credit's own date, and strictly nearer than the next one.
// Any amount qualifies: the credit settles at what arrived, exactly as an
// on-time credit does (lead, 2026-11-18); there is no exact-amount gate.
// Business days are Forecast's (Monday to Friday, no holiday calendar).
const PAYROLL_LATE_RELATION = 'payroll-late-one-business-day';
const PAYROLL_LATE_BUSINESS_DAYS = 1;
function payrollLateRule(rule) {
  return !!rule && rule.eventId === 'payroll' && rule.direction === 'credit' && !rule.postingDateRule
    && !rule.settlesWhen && rule.transactionKind !== 'transfer';
}
// The late credit must be the only credit of this identity, on its account,
// from the day after the previous payday up to the next one, so an early
// credit for the late payday also competes. A credit that is itself the
// previous payday's own late posting is that payday's, not a rival, so a pay
// that is late every time settles every time. Without the transaction list,
// no late cover (fail closed).
function payrollLatePayday(plan, rule, posted, tx, transactions) {
  if (!payrollLateRule(rule) || !plan || !posted || !tx || !Array.isArray(transactions)) return null;
  const scanFrom = Forecast.addDays(posted, -45);
  const events = scheduledEventsOnRange(plan, scanFrom, Forecast.addDays(posted, 28))
    .filter(e => e && e.id === rule.eventId).map(e => e.date).sort();
  // The payday a credit on `date` would be a late posting of, by date alone.
  const lateBy = date => {
    if (events.includes(date)) return null;
    const payday = events.filter(d => d < date).pop();
    if (!payday || Forecast.businessDaysAfter(payday, date) > PAYROLL_LATE_BUSINESS_DAYS) return null;
    const after = events.find(d => d > date);
    return after && !(Forecast.diffDays(payday, date) < Forecast.diffDays(date, after)) ? null : payday;
  };
  const late = lateBy(posted);
  if (!late) return null;
  // Settles at the actual amount, as an on-time credit does (lead, 2026-11-18);
  // the matcher itself needs exactly one occurrence on the payday.
  const prev = events.filter(d => d < late).pop();
  const next = events.find(d => d > posted);
  const windowFrom = prev ? Forecast.addDays(prev, 1) : scanFrom;
  const rival = transactions.some(other => other && other !== tx
    && String(other.providerTransactionId) !== String(tx.providerTransactionId)
    && String(other.providerAccountId) === String(tx.providerAccountId)
    && lunchMoneyDebitAmount(other.amount) < 0 && matchesIdentityFields(other, rule)
    && other.date >= windowFrom && (!next || other.date < next)
    && !(prev && lateBy(other.date) === prev));
  return rival ? null : late;
}

function postingDateRelation(scheduledDate, postingDate, rule, tx) {
  const scheduled = parseIsoDate(scheduledDate);
  const posted = parseIsoDate(postingDate);
  if (!scheduled || !posted) return null;
  const lm = tx && LM_MATCHED.get(tx);
  if (lm && rule && lm.eventId === rule.eventId && lm.date === scheduled) return LM_MATCHED_RELATION;
  if (scheduled === posted) return 'same-day';
  if (payrollLateRule(rule)) {
    return scheduled < posted && Forecast.businessDaysAfter(scheduled, posted) <= PAYROLL_LATE_BUSINESS_DAYS
      ? PAYROLL_LATE_RELATION : null;
  }
  if (rule && rule.postingDateRule === DUE_OR_UP_TO_TWO_DAYS_AFTER) {
    const latest = Forecast.addDays(scheduled, DUE_OR_UP_TO_TWO_DAYS_AFTER_DAYS);
    return scheduled < posted && latest && posted <= latest ? 'late-within-two-days' : null;
  }
  if (rule && rule.postingDateRule === COVER_STATEMENT_CYCLE_OR_LATEST_DUE) {
    return COVER_STATEMENT_CYCLE_OR_LATEST_DUE;
  }
  if (rule && rule.postingDateRule === COVER_EARLY_OR_DUE_ON_OR_BEFORE_POSTING) {
    if (scheduled < posted) return COVER_DUE_ON_OR_BEFORE_POSTING;
    const earliest = Forecast.addDays(scheduled, -ruleEarlyPayLookaheadDays(rule));
    return earliest && posted >= earliest ? 'early-pay-before-due' : null;
  }
  if (rule && rule.postingDateRule === COVER_DUE_ON_OR_BEFORE_POSTING
    && scheduled < posted) {
    return COVER_DUE_ON_OR_BEFORE_POSTING;
  }
  if (!rule || rule.postingDateRule !== WEEKEND_NEXT_BUSINESS_DAY) return null;
  const weekday = new Date(`${scheduled}T00:00:00Z`).getUTCDay();
  const nextBusinessDay = weekday === 6
    ? Forecast.addDays(scheduled, 2)
    : weekday === 0 ? Forecast.addDays(scheduled, 1) : null;
  return nextBusinessDay === posted ? 'weekend-next-business-day' : null;
}

function sourceFrequency(plan, eventId) {
  if (!plan || !eventId) return null;
  const row = [].concat(
    (plan.bills) || [],
    (plan.obligations) || [],
    (plan.income) || [],
    (plan.commitments) || []
  ).find(item => item && item.id === eventId);
  return row && row.frequency != null ? String(row.frequency) : null;
}

function coveringEarlyOrDueDates(plan, rule, postingDate) {
  const posted = parseIsoDate(postingDate);
  if (!plan || !rule || !rule.eventId || !posted) return [];
  const lookahead = ruleEarlyPayLookaheadDays(rule);
  const from = Forecast.addDays(posted, -COVER_DUE_LOOKBACK_DAYS);
  const to = Forecast.addDays(posted, lookahead);
  if (!from || !to) return [];
  const events = scheduledEventsOnRange(plan, from, to)
    .filter(event => event && event.id === rule.eventId);
  const scored = [];
  for (const event of events) {
    if (!event || !event.date) continue;
    const dist = calendarDaysBetween(posted, event.date);
    if (dist == null) continue;
    const abs = Math.abs(dist);
    if (event.date > posted && abs > lookahead) continue;
    if (sourceFrequency(plan, rule.eventId) === 'once' && event.date < posted) {
      const lastAllowed = Forecast.addDays(event.date, ONCE_COVER_GRACE_DAYS);
      if (!lastAllowed || posted > lastAllowed) continue;
    }
    scored.push({
      date: event.date,
      dist: abs,
      outstanding: event.date <= posted,
    });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => a.dist - b.dist || (Number(b.outstanding) - Number(a.outstanding)));
  const nearestDist = scored[0].dist;
  const nearest = scored.filter(row => row.dist === nearestDist);
  const nearestDates = new Set(nearest.map(row => row.date));
  if (nearestDates.size === 1) return [scored[0].date];
  const outstandingNearest = nearest.filter(row => row.outstanding);
  const outstandingDates = new Set(outstandingNearest.map(row => row.date));
  if (outstandingDates.size === 1) return [[...outstandingDates][0]];
  return [];
}

function coveringScheduledDates(plan, rule, postingDate, tx, transactions) {
  const posted = parseIsoDate(postingDate);
  if (!plan || !rule || !rule.eventId || !posted) return [];
  // S3: when Lunch Money's own matches for the rule's reviewed item are
  // consistent (stampLunchMoneyMatched), they alone name the occurrence a
  // linked payment settles; one LM did not match settles none.
  const lm = tx && LM_MATCHED.get(tx);
  if (lm && lm.eventId === rule.eventId) return lm.date ? [lm.date] : [];
  if (rule.postingDateRule === COVER_STATEMENT_CYCLE_OR_LATEST_DUE) {
    return coveringStatementCycleDates(plan, rule, posted);
  }
  if (rule.postingDateRule === COVER_EARLY_OR_DUE_ON_OR_BEFORE_POSTING) {
    return coveringEarlyOrDueDates(plan, rule, posted);
  }
  if (payrollLateRule(rule)) {
    const late = payrollLatePayday(plan, rule, posted, tx, transactions);
    return late ? [posted, late] : [posted];
  }
  if (rule.postingDateRule !== COVER_DUE_ON_OR_BEFORE_POSTING) {
    return scheduledDatesForPosting(posted, rule);
  }
  const from = Forecast.addDays(posted, -COVER_DUE_LOOKBACK_DAYS);
  if (!from) return [];
  const events = scheduledEventsOnRange(plan, from, posted)
    .filter(e => e && e.id === rule.eventId && e.date <= posted);
  if (!events.length) return [];
  events.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const latest = events[0].date;
  if (events.filter(e => e.date === latest).length !== 1) return [];
  if (sourceFrequency(plan, rule.eventId) === 'once') {
    const lastAllowed = Forecast.addDays(latest, ONCE_COVER_GRACE_DAYS);
    if (!lastAllowed || posted > lastAllowed) return [];
  }
  return [latest];
}

function scheduledDatesForPosting(postingDate, rule) {
  const posted = parseIsoDate(postingDate);
  if (!posted) return [];
  const dates = [posted];
  if (rule && (rule.postingDateRule === WEEKEND_NEXT_BUSINESS_DAY
    || rule.postingDateRule === DUE_OR_UP_TO_TWO_DAYS_AFTER)) {
    dates.push(Forecast.addDays(posted, -1), Forecast.addDays(posted, -2));
  }
  return dates.filter((date, index) => date && dates.indexOf(date) === index
    && postingDateRelation(date, posted, rule));
}

function schedulePlan(plan) {
  return {
    income: (plan && plan.income) || [],
    obligations: (plan && plan.obligations) || [],
    bills: (plan && plan.bills) || [],
    commitments: (plan && plan.commitments) || [],
    startingCash: plan && plan.startingCash,
    debts: (plan && plan.debts) || [],
  };
}

function scheduledEventsOn(plan, date) {
  if (!plan || !date) return [];
  return Forecast.expandEvents(schedulePlan(plan), date, date, {})
    .filter(e => e && e.kind !== 'noncash');
}

function scheduledEventsOnRange(plan, from, to) {
  if (!plan || !from || !to || to < from) return [];
  return Forecast.expandEvents(schedulePlan(plan), from, to, {})
    .filter(e => e && e.kind !== 'noncash' && e.date >= from && e.date <= to);
}

// expandEvents hides a commitment once settledOn is on or before the
// one-day window start, so a due-date lookup cannot see an already-settled
// occurrence. Identity still has to name that occurrence. Cash settlement
// stays on settledOn; this is not a second cash event.
function settledCommitmentSchedule(plan, eventId, date) {
  const row = ((plan && plan.commitments) || []).find(c => c && c.id === eventId);
  if (!row || !Forecast.commitmentSettledBy(row, date)) return [];
  if (row.flexibility === 'optional' || row.optional === true) return [];
  const cashDate = Forecast.commitmentCashDate(row);
  const amount = Number(row.amount);
  if (cashDate !== date || !isFinite(amount)) return [];
  return [{
    date: cashDate,
    amount: -amount,
    kind: 'commitment',
    label: row.label,
    id: row.id,
    confidence: row.confidence,
  }];
}

function scheduledOccurrence(plan, eventId, date) {
  const due = Forecast.statementOccurrenceDate(plan, eventId,
    Forecast.statementOccurrenceIdentity(plan, eventId, date));
  const expanded = scheduledEventsOn(plan, due)
    .filter(e => e && e.id === eventId && e.date === due);
  if (expanded.length === 1) return expanded;
  const settled = settledCommitmentSchedule(plan, eventId, date);
  return settled.length === 1 ? settled : expanded;
}

function openingAsOfFromData(data) {
  const opening = data && data.plan && data.plan.opening;
  return opening && opening.asOf ? String(opening.asOf) : null;
}

function classifyRepresentedCandidate(candidate, asOf) {
  const date = candidate && candidate.date ? String(candidate.date) : null;
  const current = !!(asOf && date && date === asOf);
  let openingRelevance = 'incomparable';
  if (asOf && date) {
    if (date === asOf) openingRelevance = 'current-opening';
    else if (date < asOf) openingRelevance = 'historical-before-opening';
    else openingRelevance = 'after-opening';
  }
  return Object.assign({}, candidate, {
    currentOpeningImpact: current,
    mustNotBackfillOpening: !current,
    openingRelevance,
  });
}

function postingObservationFromCandidate(candidate, fetchedAt) {
  return {
    observationId: `lm-${candidate.providerTransactionId}-posting`,
    fact: 'posting',
    eventId: candidate.id,
    accountLabel: candidate.payee,
    scheduledDate: candidate.scheduledDate || candidate.date,
    posted: true,
    unknown: false,
    observedAsOf: dateOnly(fetchedAt),
    evidenceDate: dateOnly(fetchedAt),
    canonical: { collection: 'representedEvents', id: candidate.id, date: candidate.scheduledDate || candidate.date },
    source: 'provider-observe:lunchmoney-transactions',
    note: candidate && candidate.identity === 'transfer+counterpart+account+date'
      ? 'Identity is a uniquely proven transfer credit into the mapped BILLS account paired to the TENNIS INCOME salary-flow counterpart + direction + allowed scheduled/posting-date relation. Amount is a necessary guard, not identity. Historical candidates are not current-opening posting comparisons.'
      : candidate && candidate.identity === 'transfer+account+date'
      ? 'Identity is a uniquely proven transfer credit into the mapped BILLS account + direction + allowed scheduled/posting-date relation. Amount is a necessary guard, not identity. Historical candidates are not current-opening posting comparisons.'
      : 'Identity is explicit payee alias + mapped account + direction + allowed scheduled/posting-date relation. Amount similarity was not used. Historical candidates are not current-opening posting comparisons.',
    currentOpeningImpact: candidate.currentOpeningImpact === true,
    mustNotBackfillOpening: candidate.mustNotBackfillOpening !== false,
    openingRelevance: candidate.openingRelevance || 'incomparable',
  };
}

function sameDayDiscrepancies(recon) {
  return ((recon && recon.rows) || [])
    .filter(r => r && r.status === 'CHANGE' && r.dateRelation === 'same-day')
    .map(r => ({
      canonicalTarget: r.canonicalTarget || null,
      fact: r.fact || null,
      evidenceValue: r.evidenceValue,
      canonicalValue: r.canonicalValue,
      evidenceDate: r.evidenceDate || r.observedAsOf || null,
      dateRelation: 'same-day',
      winnerChosen: false,
      reason: 'same-day without adequate time evidence — no canonical winner',
    }))
    .sort((a, b) => String(a.canonicalTarget).localeCompare(String(b.canonicalTarget)));
}

function observationIdentityKey(obs) {
  if (obs && obs.canonical && obs.canonical.collection) {
    const c = obs.canonical;
    return [c.collection, c.id, obs.fact || c.field || '', c.date || '']
      .filter(part => part !== '')
      .join(':');
  }
  return obs && obs.fact ? String(obs.fact) : 'unknown';
}

function identityFingerprint(report) {
  const mapped = (report.mapped || [])
    .map(m => ({
      atlasId: m.atlasId,
      collection: m.collection,
      atlasRole: m.atlasRole,
    }))
    .sort((a, b) => String(a.atlasId).localeCompare(String(b.atlasId)));
  const observations = (report.observations || [])
    .map(o => ({
      key: observationIdentityKey(o),
      fact: o.fact || null,
      evidenceValue: o.evidenceValue,
      unknown: o.unknown === true,
      evidenceDate: o.evidenceDate || o.observedAsOf || null,
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key))
      || String(a.fact).localeCompare(String(b.fact)));
  const reconciliation = ((report.reconciliation && report.reconciliation.rows) || [])
    .map(r => ({
      target: r.canonicalTarget || null,
      fact: r.fact || null,
      status: r.status,
      dateRelation: r.dateRelation || null,
      evidenceValue: r.evidenceValue,
      canonicalValue: r.canonicalValue,
    }))
    .sort((a, b) => String(a.target).localeCompare(String(b.target))
      || String(a.fact).localeCompare(String(b.fact)));
  const classified = report.representedEventCandidates || [];
  const historical = classified
    .filter(c => !c.currentOpeningImpact)
    .map(c => ({
      eventId: c.id,
      date: c.date,
      openingRelevance: c.openingRelevance,
      mustNotBackfillOpening: c.mustNotBackfillOpening !== false,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.eventId).localeCompare(String(b.eventId)));
  const currentOpening = classified
    .filter(c => c.currentOpeningImpact)
    .map(c => ({
      eventId: c.id,
      date: c.date,
      openingRelevance: c.openingRelevance,
      mustNotBackfillOpening: false,
    }))
    .sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)));
  return {
    writesCanonicalState: report.writesCanonicalState === true,
    canonicalWriteAuthorized: false,
    mappingBy: 'provider-account-id',
    displayNameIsLabelOnly: true,
    endpointOriginPreserved: false,
    cardCapacityIsCash: report.cardCapacityIsCash,
    spendableCash: report.spendableCash,
    fetchedAt: report.fetchedAt || null,
    mapped,
    unmappedCount: (report.unmapped || []).length,
    observations,
    reconciliation,
    historicalRepresentedEventCandidates: historical,
    currentOpeningRepresentedEventCandidates: currentOpening,
    pendingToPostedTransitions: (report.identityEvidence || [])
      .filter(e => e && e.transition === 'pending-to-posted').length,
    sameDayDiscrepancies: report.sameDayDiscrepancies
      || sameDayDiscrepancies(report.reconciliation),
  };
}

function identityProofLooksSanitized(proof) {
  const blob = JSON.stringify(proof == null ? {} : proof);
  return !/"providerAccountId"\s*:/.test(blob)
    && !/"providerTransactionId"\s*:/.test(blob)
    && !/"plaidTransactionId"\s*:/.test(blob)
    && !/"plaidPendingTransactionId"\s*:/.test(blob)
    && !/"plaid_metadata"\s*:/.test(blob)
    && !/"plaidMetadata"\s*:/.test(blob)
    && !/"pending_transaction_id"\s*:/.test(blob)
    && !/"pendingTransactionId"\s*:/.test(blob)
    && !/Bearer\s+\S+/.test(blob)
    && !/LUNCHMONEY_ACCESS_TOKEN/.test(blob);
}

function compareIdentityFingerprints(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  const keyShape = proof => ({
    mapped: proof && proof.mapped,
    unmappedCount: proof && proof.unmappedCount,
    observationKeys: ((proof && proof.observations) || []).map(o => o.key),
    historical: proof && proof.historicalRepresentedEventCandidates,
    currentOpening: proof && proof.currentOpeningRepresentedEventCandidates,
  });
  return {
    equal: left === right,
    keysEqual: JSON.stringify(keyShape(a)) === JSON.stringify(keyShape(b)),
  };
}

function postedWindowIsComplete(window) {
  if (!window || typeof window !== 'object') return false;
  return window.complete === true
    && window.truncated !== true
    && window.hasMore !== true;
}

function pendingCoverageIsComplete(coverage) {
  return !!(coverage
    && coverage.complete === true
    && coverage.status === 'complete'
    && coverage.basis === PENDING_COVERAGE_BASIS);
}

function expectedHouseholdIdentities(mapDoc) {
  const ids = [];
  const seen = new Set();
  for (const mapping of (mapDoc && mapDoc.mappings) || []) {
    if (!mapping || mapping.atlasRole === EXTERNAL_LIVE_ROLE) continue;
    const id = mapping.canonical && mapping.canonical.id;
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  ids.sort();
  return ids;
}

function mappedHouseholdIdentities(mapped) {
  const ids = [];
  const seen = new Set();
  for (const row of mapped || []) {
    if (!row || !row.atlasId || row.atlasRole === EXTERNAL_LIVE_ROLE) continue;
    const key = String(row.atlasId);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  ids.sort();
  return ids;
}

function requiredCashObserved(identities) {
  const have = new Set(identities || []);
  return REQUIRED_LIVE_CASH_IDS.filter(id => have.has(id));
}

function requiredCashMissingFrom(identities) {
  const have = new Set(identities || []);
  return REQUIRED_LIVE_CASH_IDS.filter(id => !have.has(id));
}

function datedRequiredCash(observations, savingsPools) {
  const dated = [];
  for (const id of REQUIRED_LIVE_CASH_IDS) {
    const obs = (observations || []).find(o =>
      o
      && o.canonical
      && o.canonical.collection === 'cash'
      && String(o.canonical.id) === id
      // A balance the observer qualified as unknown (future-dated or
      // undated) is not dated evidence, even when it carries a date.
      && o.unknown !== true
      && (o.evidenceDate || o.observedAsOf)
      && o.evidenceValue != null
      && isFinite(Number(o.evidenceValue)));
    // Purpose reserves deliberately do not emit operating-cash observations.
    // Consume their incumbent semantic balance evidence for this dated-source
    // receipt only; it grants neither current backing nor spendable cash.
    const reserves = (savingsPools && Array.isArray(savingsPools.accounts) ? savingsPools.accounts : [])
      .filter(row => row && row.accountId === id);
    const reserve = id === 'savings' && reserves.length === 1 ? reserves[0] : null;
    const cents = reserve && typeof reserve.value === 'number' ? Math.round(reserve.value * 100) : null;
    const date = reserve && reserve.evidenceDate;
    const reserveDated = reserve && Number.isSafeInteger(cents) && reserve.value === cents / 100
      && reserve.currency === 'CAD' && reserve.source === 'provider-observe:lunchmoney'
      && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(date + 'T00:00:00Z'))
      && new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date
      && dateOnly(savingsPools.asOf) && date <= dateOnly(savingsPools.asOf);
    if (obs || reserveDated) dated.push(id);
  }
  return dated;
}

function observationReceiptLooksSanitized(receipt) {
  if (receipt && Object.hasOwn(receipt, 'salaryMatcherDiagnostic')
      && !SalaryDiagnostic.project(receipt.salaryMatcherDiagnostic)) return false;
  const blob = JSON.stringify(receipt == null ? {} : receipt);
  return identityProofLooksSanitized(receipt)
    && !/"payee"\s*:/.test(blob)
    && !/"original_name"\s*:/.test(blob)
    && !/"observationId"\s*:/.test(blob)
    && !/"status"\s*:\s*"(MATCH|CHANGE|CONFLICT|MISSING|STALE)"/.test(blob)
    && !/"evidenceValue"\s*:/.test(blob)
    && !/"reconciliation"\s*:/.test(blob)
    && !/"recommend"\s*:/.test(blob)
    && !/"safeToSpend"\s*:/.test(blob);
}

function observationFingerprintFromParts(parts) {
  return {
    schema: RECEIPT_SCHEMA,
    provider: 'lunchmoney',
    observedAt: parts.observedAt || null,
    householdDate: parts.householdDate || null,
    writesCanonicalState: parts.writesCanonicalState === true,
    canonicalStateChanged: false,
    mappedHouseholdIdentities: parts.mappedHouseholdIdentities || [],
    unmappedCount: Number(parts.unmappedCount) || 0,
    missingExpectedIdentities: parts.missingExpectedIdentities || [],
    requiredCashMissing: parts.requiredCashMissing || [],
    requiredCashBalanceMissing: parts.requiredCashBalanceMissing || [],
    postedComplete: parts.postedComplete === true,
    pendingComplete: parts.pendingComplete === true,
    pendingToPostedTransitions: Number(parts.pendingToPostedTransitions) || 0,
    readyForReconciliation: parts.readyForReconciliation === true,
  };
}

function observationFingerprintDigest(fingerprint) {
  return crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}

// Schedule-trust uses one provider/household financial date.
// fetchedAt and the process clock are fetch timestamps, not as-of.
function householdDateFromProviderEvidence(observations) {
  const dates = [];
  for (const id of REQUIRED_LIVE_CASH_IDS) {
    const obs = (observations || []).find(o =>
      o
      && o.canonical
      && o.canonical.collection === 'cash'
      && String(o.canonical.id) === id
      && o.evidenceValue != null
      && isFinite(Number(o.evidenceValue)));
    const day = dateOnly(obs && (obs.evidenceDate || obs.observedAsOf));
    if (day) dates.push(day);
  }
  if (!dates.length) return null;
  dates.sort();
  return dates[0];
}

function householdFinancialDate(input, observations) {
  const explicit = dateOnly(input && (input.asOf || input.householdDate));
  if (explicit) return explicit;
  return householdDateFromProviderEvidence(observations);
}

function observationReceipt(report, opts) {
  opts = opts || {};
  const salaryMatcherDiagnostic = SalaryDiagnostic.project(opts.salaryMatcherDiagnostic
    || report?.observationReceipt?.salaryMatcherDiagnostic);
  const fetchedAt = (report && report.fetchedAt) || null;
  const householdDate = dateOnly(fetchedAt);
  const pending = (report && report.pendingCoverage) || classifyPendingCoverage({});
  const window = (report && report.transactionWindow) || {};
  const mappedIds = mappedHouseholdIdentities(report && report.mapped);
  const expected = expectedHouseholdIdentities(opts.accountMap);
  const missingExpected = expected.filter(id => mappedIds.indexOf(id) === -1);
  const unmappedCount = ((report && report.unmapped) || []).length;
  const cashMissing = requiredCashMissingFrom(mappedIds);
  const cashDated = datedRequiredCash(report && report.observations, report && report.savingsPools);
  const cashDatedMissing = REQUIRED_LIVE_CASH_IDS.filter(id => cashDated.indexOf(id) === -1);
  const cashBalanceMissing = cashDatedMissing.filter(id => cashMissing.indexOf(id) === -1);
  const postedComplete = postedWindowIsComplete(window);
  const pendingComplete = pendingCoverageIsComplete(pending);
  const pendingToPosted = ((report && report.identityEvidence) || [])
    .filter(e => e && e.transition === 'pending-to-posted').length;
  const writeClaimed = !!(report && report.writesCanonicalState === true);
  const failClosedReasons = [];
  if (!postedComplete) {
    failClosedReasons.push(window.truncated === true
      ? 'posted-window-truncated'
      : 'posted-window-unproven');
  }
  if (!pendingComplete) {
    failClosedReasons.push(pending.status === 'bounded-window'
      ? 'pending-coverage-bounded-window'
      : 'pending-coverage-unproven');
  }
  if (cashMissing.length) failClosedReasons.push('required-cash-unobserved');
  if (cashBalanceMissing.length) failClosedReasons.push('required-cash-balance-unproven');
  if (missingExpected.length) failClosedReasons.push('expected-mapped-identity-missing');
  if (writeClaimed) failClosedReasons.push('canonical-write-claimed');
  const ready = failClosedReasons.length === 0;
  const fingerprint = observationFingerprintFromParts({
    observedAt: fetchedAt,
    householdDate,
    writesCanonicalState: writeClaimed,
    mappedHouseholdIdentities: mappedIds,
    unmappedCount,
    missingExpectedIdentities: missingExpected,
    requiredCashMissing: cashMissing,
    requiredCashBalanceMissing: cashBalanceMissing,
    postedComplete,
    pendingComplete,
    pendingToPostedTransitions: pendingToPosted,
    readyForReconciliation: ready,
  });
  return {
    schema: RECEIPT_SCHEMA,
    provider: 'lunchmoney',
    observedAt: fetchedAt,
    householdDate,
    writesCanonicalState: writeClaimed,
    canonicalStateChanged: false,
    ...(salaryMatcherDiagnostic ? { salaryMatcherDiagnostic } : {}),
    accountCoverage: {
      status: (cashMissing.length || missingExpected.length) ? 'incomplete' : 'required-cash-observed',
      mappedHouseholdIdentities: mappedIds,
      unmappedCount,
      expectedMappedCount: expected.length,
      missingExpectedIdentities: missingExpected,
      requiredCashObserved: requiredCashObserved(mappedIds),
      requiredCashMissing: cashMissing,
    },
    balanceCoverage: {
      status: cashDatedMissing.length ? 'incomplete' : 'required-cash-dated',
      requiredCashWithDatedBalance: cashDated,
      requiredCashMissingDatedBalance: cashDatedMissing,
      freshnessVerdict: 'not-claimed',
      freshnessNote: 'Dated balance evidence is not a current/freshness verdict. MATCH is not freshness.',
    },
    postedTransactionCoverage: {
      complete: postedComplete,
      truncated: window.truncated === true,
      hasMore: window.hasMore === true,
      status: postedComplete ? 'complete' : (window.truncated === true ? 'truncated' : 'unproven'),
    },
    pendingTransactionCoverage: {
      complete: pendingComplete,
      status: pending.status || 'insufficient',
      reason: pendingComplete
        ? null
        : (pending.reason || 'Pending coverage is not the completed unbounded is_pending query.'),
    },
    identity: {
      mappingBy: 'provider-account-id',
      displayNameIsLabelOnly: true,
      pendingToPostedTransitions: pendingToPosted,
      vsPriorObservation: 'not-claimed',
      vsPriorObservationNote: 'No authorized previous-observation store. Intra-payload pending-to-posted and account-map coverage are the incumbent identity evidence.',
    },
    readyForReconciliation: ready,
    failClosedReasons,
    fingerprint,
    fingerprintDigest: observationFingerprintDigest(fingerprint),
  };
}

function transactionWithMappedAccount(tx, accountMap) {
  if (!tx) return tx;
  if (tx.atlasAccountId || tx.account) return tx;
  const mapping = mappingFor(accountMap, tx.providerAccountId);
  const id = mapping && mapping.canonical && mapping.canonical.id;
  if (!id) return tx;
  return Object.assign({}, tx, { atlasAccountId: id, account: id });
}

function soleOwnerConfirmedSpotifyTransaction(transactions, accountMap) {
  const matches = (transactions || []).filter(tx =>
    hasPostedReceipt(tx)
    && Forecast.classifyCurrentPeriodTransaction.ownerConfirmedSpotify(
      transactionWithMappedAccount(tx, accountMap)
    ));
  return matches.length === 1 ? matches[0] : null;
}

function scheduleTrustCandidates(input) {
  const asOf = parseIsoDate(input && input.asOf);
  if (!asOf || !input || !input.plan) return [];
  const cycle = Forecast.spendingCycle(input.plan, asOf);
  const cycleStart = cycle && cycle.start ? parseIsoDate(cycle.start) : null;
  const openingAsOf = input.plan.opening && input.plan.opening.asOf
    ? parseIsoDate(input.plan.opening.asOf) : null;
  // A schedule-trust occurrence stays settled after its pay period rolls.
  // Forecast carries an unrepresented joint-cash outflow from the canonical
  // opening (priorAsOf) onward, so the window reaches back to that opening,
  // not just the current cycle start; otherwise a trusted bill prints
  // unverified in the prior period and is reserved again.
  const afterOpening = openingAsOf ? Forecast.addDays(openingAsOf, 1) : null;
  const from = (cycleStart && afterOpening
    ? (afterOpening < cycleStart ? afterOpening : cycleStart)
    : (cycleStart || afterOpening))
    || Forecast.addDays(asOf, -COVER_DUE_LOOKBACK_DAYS);
  if (!from || from > asOf) return [];
  const hits = [];
  const seen = new Set();
  for (const rule of stampRuleSetClaims(input.identityRules)) {
    if (!rule || !rule.eventId || rule.settlesWhen !== SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE) {
      continue;
    }
    const events = scheduledEventsOnRange(input.plan, from, asOf)
      .filter(event => event && event.id === rule.eventId
        && event.date >= from && event.date <= asOf);
    for (const event of events) {
      const key = rule.eventId + '@' + event.date;
      if (seen.has(key)) continue;
      const amount = Math.abs(Number(event.amount));
      if (!isFinite(amount)) continue;
      seen.add(key);
      hits.push({
        id: rule.eventId,
        date: event.date,
        postingDate: event.date,
        postingDateRelation: SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE,
        direction: null,
        providerTransactionId: null,
        providerAccountId: null,
        payee: null,
        identity: 'schedule-trust-on-due',
        amountNotUsed: true,
        observedAmount: Math.round(amount * 100) / 100,
        atlasAccountId: null,
        settlesWhen: SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE,
      });
    }
  }
  return hits;
}

function candidateTransactionIds(candidate) {
  const ids = [];
  const seen = new Set();
  const push = value => {
    if (value == null || value === '') return;
    const key = String(value);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(value);
  };
  if (candidate && Array.isArray(candidate.providerTransactionIds)) {
    for (const value of candidate.providerTransactionIds) push(value);
  }
  if (candidate) push(candidate.providerTransactionId);
  return ids;
}

function combineTwoLegHits(hits) {
  const ordered = hits.slice().sort((a, b) =>
    String(a.postingDate).localeCompare(String(b.postingDate))
    || String(a.providerTransactionId).localeCompare(String(b.providerTransactionId)));
  const sum = ordered.reduce((total, hit) => total + Number(hit.observedAmount), 0);
  const last = ordered[ordered.length - 1];
  const accounts = new Set(ordered.map(hit => hit.atlasAccountId).filter(Boolean));
  const sameAccountSplit = ordered.every(hit => hit && hit.sameAccountSplitLegs === true)
    && accounts.size === 1;
  return {
    id: ordered[0].id,
    date: ordered[0].date,
    postingDate: last && last.postingDate,
    postingDateRelation: last && last.postingDateRelation,
    direction: ordered[0].direction,
    providerTransactionId: ordered[0].providerTransactionId,
    providerTransactionIds: ordered.map(hit => hit.providerTransactionId),
    providerAccountId: ordered[0].providerAccountId,
    payee: ordered[0].payee,
    identity: 'two-leg-payee+account+date',
    amountNotUsed: true,
    observedAmount: Math.round(sum * 100) / 100,
    atlasAccountId: ordered[0].atlasAccountId,
    atlasAccountIds: ordered.map(hit => hit.atlasAccountId),
    settlesWhen: SETTLES_WHEN_TWO_LEG_SUM,
    sameAccountSplitLegs: sameAccountSplit,
  };
}

// Incumbent two-leg-sum is two distinct transactions on two distinct
// accounts (TD monthly account fees). A same-account pair settles only
// when every leg opted in on the rule (sameAccountSplitLegs === true),
// the pair shares one canonical account, and both posted on the same
// household date. Amount is not consulted. Anything else fails closed.
function twoLegSumAccepted(hits) {
  if (!hits || hits.length !== 2) return false;
  if (!hits.every(hit => hit && hit.settlesWhen === SETTLES_WHEN_TWO_LEG_SUM)) return false;
  const accounts = new Set(hits.map(hit => hit.atlasAccountId).filter(Boolean));
  const txIds = new Set(hits.map(hit => hit.providerTransactionId)
    .filter(id => id != null && id !== '').map(String));
  if (txIds.size !== 2 || accounts.size < 1) return false;
  if (accounts.size === 2) return true;
  if (accounts.size !== 1) return false;
  if (!hits.every(hit => hit.sameAccountSplitLegs === true)) return false;
  const postingDates = new Set(hits.map(hit => hit.postingDate).filter(Boolean));
  return postingDates.size === 1;
}

// One occurrence's hits, already limited to a single settlement shape.
// Two-leg-sum accepts only an incumbent pair. One same-account split
// leg is never a settlement. Anything else with several hits is ambiguous
// unless every hit is an amount-at-least coverage of that same occurrence.
function classifyOccurrenceHits(key, hits) {
  const empty = { unique: null, ambiguous: null };
  if (!hits || !hits.length) return empty;
  if (hits.every(hit => hit && hit.settlesWhen === SETTLES_WHEN_TWO_LEG_SUM)) {
    if (twoLegSumAccepted(hits)) return { unique: combineTwoLegHits(hits), ambiguous: null };
    if (hits.length > 2) {
      return {
        unique: null,
        ambiguous: {
          key,
          id: hits[0] && hits[0].id,
          date: hits[0] && hits[0].date,
          hits,
          reason: 'multiple-compatible-candidates',
          candidateCount: hits.length,
        },
      };
    }
    return empty;
  }
  if (hits.length === 1) {
    // An explicit same-account split opt-in is never a one-leg settlement,
    // including when settlesWhen was omitted on that rule.
    if (hits[0] && hits[0].sameAccountSplitLegs === true) return empty;
    return { unique: hits[0], ambiguous: null };
  }
  const sameOccurrence = hits.every(hit => hit && hit.id === hits[0].id
    && hit.date === hits[0].date);
  const amountAtLeast = hits.every(hit => hit
    && hit.settlesWhen === SETTLES_WHEN_AMOUNT_AT_LEAST);
  if (sameOccurrence && amountAtLeast) {
    const ordered = hits.slice().sort((a, b) =>
      String(a.postingDate).localeCompare(String(b.postingDate))
      || String(a.providerTransactionId).localeCompare(String(b.providerTransactionId)));
    return { unique: ordered[0], ambiguous: null };
  }
  return {
    unique: null,
    ambiguous: {
      key,
      id: hits[0] && hits[0].id,
      date: hits[0] && hits[0].date,
      hits,
      reason: 'multiple-compatible-candidates',
      candidateCount: hits.length,
    },
  };
}

function isBillOrObligationEvent(plan, eventId) {
  if (!plan || !eventId) return false;
  return [].concat(plan.bills || [], plan.obligations || [])
    .some(row => row && row.id === eventId);
}

// A posted card payment proves a balance movement, not the household's
// purpose for it. Purchase backfills can have the same payee, date and amount
// as a minimum payment. Generic identity leaves these occurrences unconfirmed;
// the separate owner-approved exact-category path now supplies typed household
// confirmation without opening this payee/amount gate. Owner/statement confirmations
// already on plan.opening.representedEvents remain Forecast inputs unchanged.
// Visa purchase reconciliation publishes the backfill split for Budget. It
// does not reopen this gate.
function cardMinimumNeedsConfirmation(plan, eventId, accountMap) {
  const row = ((plan && plan.obligations) || []).find(item => item && item.id === eventId);
  if (!row || row.effect !== 'payment' || !row.debtId) return false;
  const mappedCard = ((accountMap && accountMap.mappings) || []).some(mapping =>
    mapping && CREDIT_ROLES.has(mapping.atlasRole) && mapping.canonical
    && mapping.canonical.collection === 'debts' && mapping.canonical.id === row.debtId);
  const debt = ((plan && plan.debts) || []).find(item => item && item.id === row.debtId);
  return mappedCard || !!(debt && !debt.secured && /^Revolving\b/i.test(debt.structure || ''));
}

// Finish-line audit finding 2 (#821 6788704527): a payee fragment is not
// enough to say a debit paid a bill. A default-rule debit (no settlesWhen of
// its own, not a transfer) more than BILL_IDENTITY_AMOUNT_SHARE times the
// occurrence's scheduled amount is inconsistent with that bill: a 400.00
// Groceries purchase at a shop whose name contains a 15.00 bill's payee is
// that shop's spending, not the bill. The bound is upper only: a payment
// below the bill is the partial-payment shape, which has its own lane.
// Rules that state their own amount semantics (amount-at-least,
// exact-scheduled-amount, two-leg-sum, schedule trust) keep them, and an
// occurrence with no positive scheduled amount has nothing to compare.
const BILL_IDENTITY_AMOUNT_SHARE = 1.5;
function billDebitAmountConsistent(rule, amount, scheduledAmount) {
  if (!rule || rule.direction !== 'debit' || rule.settlesWhen || rule.transactionKind === 'transfer') return true;
  const need = Math.abs(Number(scheduledAmount));
  if (!(Number.isFinite(need) && need > 0)) return true;
  return Number.isFinite(amount) && Math.abs(amount) <= need * BILL_IDENTITY_AMOUNT_SHARE + IDENTITY_AMOUNT_EPSILON;
}

function collectIdentityHits(tx, input, rules) {
  if (!tx || tx.contradictoryEvidence === true) return [];
  const mapDoc = input && input.accountMap;
  const mapping = mappingFor(mapDoc, tx.providerAccountId);
  if (!mapping || !mapping.canonical || !mapping.canonical.id) return [];
  const amount = lunchMoneyDebitAmount(tx.amount);
  const hits = [];
  for (const rule of rules || []) {
    if (cardMinimumNeedsConfirmation(input.plan, rule.eventId, mapDoc) && !lmMatchedCardMinimum(tx, rule)) continue;
    if (rule.atlasAccountId && mapping.canonical.id !== rule.atlasAccountId) continue;
    if (!matchesIdentityFields(tx, rule)) continue;
    if (!ruleCurrencyQualified(tx, rule)) continue;
    if (rule.direction === 'credit' && !(amount < 0)) continue;
    if (rule.direction === 'debit' && !(amount > 0)) continue;
    if (rule.postingDateRule === DUE_OR_UP_TO_TWO_DAYS_AFTER && !(Number.isFinite(amount) && amount > 0)) continue;
    for (const scheduledDate of coveringScheduledDates(input.plan, rule, tx.date, tx, input.transactions)) {
      const scheduled = scheduledOccurrence(input.plan, rule.eventId, scheduledDate);
      if (scheduled.length !== 1) continue;
      const relation = postingDateRelation(scheduledDate, tx.date, rule, tx);
      if (!relation) continue;
      if (rule.settlesWhen === SETTLES_WHEN_AMOUNT_AT_LEAST) {
        const need = Math.abs(Number(scheduled[0].amount));
        if (!(Math.abs(amount) + IDENTITY_AMOUNT_EPSILON >= need)) continue;
      }
      // Same as representedEventHitGroups: for a credit rule only, Lunch Money's own pairing replaces the
      // exact-amount guard. A debit rule keeps it (Codex P2 on #1292).
      if (rule.settlesWhen === SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT
        && !(relation === LM_MATCHED_RELATION && rule.direction === 'credit')) {
        const need = Math.abs(Number(scheduled[0].amount));
        if (!(isFinite(need) && isFinite(amount)
          && Math.abs(Math.abs(amount) - need) <= IDENTITY_AMOUNT_EPSILON)) {
          continue;
        }
      }
      if (!billDebitAmountConsistent(rule, amount, scheduled[0].amount)) continue;
      if (rule.transactionKind === 'transfer') {
        const counterpartCount = countTransferCounterparts(tx, rule, input, amount);
        if (counterpartCount !== 1) continue;
      }
      hits.push({
        id: rule.eventId,
        date: scheduledDate,
        postingDate: tx.date,
        postingDateRelation: relation,
        direction: rule.direction || null,
        providerTransactionId: tx.providerTransactionId,
        providerAccountId: tx.providerAccountId,
        payee: tx.payee,
        identity: ruleIdentityLabel(rule),
        amountNotUsed: true,
        observedAmount: amount,
        atlasAccountId: mapping.canonical.id,
        settlesWhen: rule.settlesWhen || null,
        sameAccountSplitLegs: rule.sameAccountSplitLegs === true,
        ...(rule.postingDateRule === DUE_OR_UP_TO_TWO_DAYS_AFTER ? { lateWindow: true } : {}),
      });
    }
  }
  return hits;
}

// Provider-native 1:1 pending→posted replacement. Same Lunch Money id, or
// the incumbent directed Plaid link plus the same canonical account.
// Merchant, date, and amount are not this link. Ambiguous mates are not
// a link. This does not collapse rows; collapse stays the incumbent path.
function uniqueProviderReplacementLinks(transactions, opts) {
  const list = (transactions || []).filter(tx => tx && tx.date);
  const links = [];
  const usedPending = new Set();
  const usedPosted = new Set();
  const byId = new Map();
  for (const tx of list) {
    const id = tx && tx.providerTransactionId;
    if (id == null || id === '') continue;
    const bucket = byId.get(String(id)) || [];
    bucket.push(tx);
    byId.set(String(id), bucket);
  }
  for (const bucket of byId.values()) {
    const pending = bucket.filter(tx => tx.pending === true);
    const posted = bucket.filter(tx => tx.pending !== true);
    if (pending.length !== 1 || posted.length !== 1) continue;
    if (!sameSettlementAccount(pending[0], posted[0], opts)) continue;
    links.push({ pending: pending[0], posted: posted[0] });
    usedPending.add(pending[0]);
    usedPosted.add(posted[0]);
  }
  const pendingLeft = list.filter(tx => tx.pending === true && !usedPending.has(tx));
  const postedLeft = list.filter(tx => tx.pending !== true && !usedPosted.has(tx));
  const pairs = [];
  for (const pend of pendingLeft) {
    for (const post of postedLeft) {
      if (!directedPlaidSettlementMate(post, pend)) continue;
      if (!sameSettlementAccount(pend, post, opts)) continue;
      pairs.push({ pending: pend, posted: post });
    }
  }
  for (const pend of pendingLeft) {
    const mates = [];
    for (const pair of pairs) {
      if (pair.pending === pend && !mates.includes(pair.posted)) mates.push(pair.posted);
    }
    if (mates.length !== 1) continue;
    const post = mates[0];
    if (pairs.some(pair => pair.posted === post && pair.pending !== pend)) continue;
    links.push({ pending: pend, posted: post });
  }
  return links;
}

// Carry a unique incumbent identity hit from a dropped pending row onto
// the posted survivor. Not a second matcher. Two-leg and same-account
// split legs stay posted-only. Disagreeing occurrences fail closed later
// as one transaction consumed twice. Identity and scheduled date stay
// the pending hit. Posting provenance is the posted survivor's date;
// the inherited relation is not a claim that the posted row itself
// was same-day.
function stampPendingReplacementHits(preTransactions, collapsedTransactions, input) {
  const links = uniqueProviderReplacementLinks(preTransactions, input);
  const kept = new Set(collapsedTransactions || []);
  const byPostedId = new Map();
  for (const tx of collapsedTransactions || []) {
    if (!hasPostedReceipt(tx) || tx.providerTransactionId == null || tx.providerTransactionId === '') {
      continue;
    }
    const id = String(tx.providerTransactionId);
    const list = byPostedId.get(id) || [];
    list.push(tx);
    byPostedId.set(id, list);
  }
  const rules = stampRuleSetClaims(input.identityRules).filter(ruleHasIdentity);
  for (const link of links) {
    if (!link || kept.has(link.pending)) continue;
    const postedId = link.posted && link.posted.providerTransactionId;
    if (postedId == null || postedId === '') continue;
    const survivors = byPostedId.get(String(postedId)) || [];
    if (survivors.length !== 1) continue;
    if (!link.pending.currency || !link.posted.currency || link.pending.currency !== link.posted.currency) {
      survivors[0].coverageCurrencyConflict = true;
    }
    const currencyRules = currencyRulesForTransaction(link.pending, input.accountMap, rules, input.plan)
      .concat(currencyRulesForTransaction(link.posted, input.accountMap, rules, input.plan));
    if (currencyRules.some(rule => !ruleCurrencyQualified(link.pending, rule)
      || !ruleCurrencyQualified(link.posted, rule))) {
      survivors[0].currencySettlementUnconfirmed = true;
      continue;
    }
    if (Forecast.classifyCurrentPeriodTransaction.ownerConfirmedFuel(
      transactionWithMappedAccount(link.pending, input.accountMap)
    )) {
      survivors[0].ownerConfirmedFuel = true;
    }
    const hits = collectIdentityHits(link.pending, input, rules).filter(hit =>
      hit && hit.settlesWhen !== SETTLES_WHEN_TWO_LEG_SUM
      && hit.sameAccountSplitLegs !== true
      && isBillOrObligationEvent(input.plan, hit.id));
    if (hits.length !== 1) continue;
    const postedDate = parseIsoDate(link.posted.date);
    if (!postedDate) continue;
    // The opt-in late window never inherits through pending replacement
    // (#918, lead rescope): only a directly posted, finite, positive debit
    // inside due..due+2 settles it, through the normal posted path.
    if (hits[0].lateWindow === true) continue;
    const postedAmount = lunchMoneyDebitAmount(link.posted.amount);
    const samePostedDate = hits[0].date === postedDate;
    survivors[0].pendingReplacementHit = Object.assign({}, hits[0], {
      providerTransactionId: postedId,
      providerAccountId: link.posted.providerAccountId,
      observedAmount: postedAmount != null ? postedAmount : hits[0].observedAmount,
      inheritedPendingReplacement: true,
      postingDate: postedDate,
      postingDateRelation: samePostedDate
        ? (hits[0].postingDateRelation || 'same-day')
        : INHERITED_PENDING_AUTHORIZATION,
    });
  }
}

// The one shape a near-amount-and-payday rule may take: a credit rule with a
// positive dollar tolerance and a whole number of business days.
function nearPaydayRule(rule) {
  return !!rule && rule.settlesWhen === SETTLES_WHEN_NEAR_AMOUNT_AND_PAYDAY && rule.direction === 'credit'
    && !!rule.atlasAccountId && Number.isFinite(rule.amountToleranceDollars) && rule.amountToleranceDollars > 0
    && Number.isInteger(rule.postingBusinessDays) && rule.postingBusinessDays >= 0;
}

// Business days between a posting and the projected payday, either side
// (Forecast.businessDaysAfter: Monday to Friday, no holiday calendar).
function businessDaysApart(left, right) {
  return left <= right ? Forecast.businessDaysAfter(left, right) : Forecast.businessDaysAfter(right, left);
}

// Q2 (owner decision 6967081727): the hits of the near-amount-and-payday rules.
// Each qualifying credit is pushed under every occurrence it qualifies for; the
// incumbent classifier then leaves two credits for one occurrence unresolved,
// and representedEventHitGroups leaves every occurrence a shared credit
// qualifies for To confirm, before any occurrence is classified.
function nearPaydaySalaryHits(input, rules) {
  const hits = [];
  for (const { tx, amount, rule, mapping } of nearPaydaySalaryCandidates(input, rules)) {
    // Each calendar day within reach of postingBusinessDays business days (a weekend adds at most
    // two days per five), read from the income's own schedule.
    const reach = rule.postingBusinessDays + 2 * Math.ceil((rule.postingBusinessDays + 1) / 5) + 2;
    const events = scheduledEventsOnRange(input.plan, Forecast.addDays(tx.date, -reach), Forecast.addDays(tx.date, reach))
      .filter(event => event && event.id === rule.eventId && event.kind === 'income' && event.amount > 0);
    for (const event of events) {
      if (businessDaysApart(tx.date, event.date) > rule.postingBusinessDays) continue;
      if (!(Math.abs(Math.abs(amount) - Math.abs(Number(event.amount))) <= rule.amountToleranceDollars + IDENTITY_AMOUNT_EPSILON)) continue;
      if (scheduledOccurrence(input.plan, rule.eventId, event.date).length !== 1) continue;
      hits.push({
        id: rule.eventId,
        date: event.date,
        postingDate: tx.date,
        postingDateRelation: NEAR_PAYDAY_RELATION,
        direction: 'credit',
        providerTransactionId: tx.providerTransactionId,
        providerAccountId: tx.providerAccountId,
        payee: tx.payee,
        identity: 'near-scheduled-amount-and-payday',
        amountNotUsed: false,
        observedAmount: amount,
        atlasAccountId: mapping.canonical.id,
        settlesWhen: SETTLES_WHEN_NEAR_AMOUNT_AND_PAYDAY,
      });
    }
  }
  return hits;
}

// Every posted credit that could be her pay under a near-amount-and-payday rule, before timing and amount: each
// exclusion nearPaydaySalaryHits applies (posted native CAD money in on the rule's account; no refund, reversal,
// reimbursement, coaching or business mark; no non-salary income category; no other credit rule's identity; no
// internal household move; a transfer only from the rule's salary source). One home for those exclusions: the
// matcher adds the owner's window, and the early plain-credit hold (futureIncomeUncertainty) reads the same pairs.
function nearPaydaySalaryCandidates(input, rules) {
  const window = input && input.transactionWindow;
  if (!window || window.complete !== true || !parseIsoDate(window.startDate) || !parseIsoDate(window.endDate)) return [];
  const near = (rules || []).filter(nearPaydayRule);
  if (!near.length || !input.plan) return [];
  const others = (rules || []).filter(rule => rule && !nearPaydayRule(rule) && rule.direction === 'credit');
  const mapDoc = input.accountMap;
  const posted = tx => tx && tx.pending === false && tx.savingsPostingEvidence === 'posted'
    && tx.contradictoryEvidence !== true && tx.currencySettlementUnconfirmed !== true && tx.currency === 'cad'
    && !!parseIsoDate(tx.date) && tx.providerTransactionId != null;
  const householdRole = mapping => !!mapping && ['household-cash', 'household-reserve'].includes(mapping.atlasRole);
  // A posted debit of the same amount on another account, within the rule's business-day window of the credit.
  const equalDebitsNear = (tx, amount, days) => (input.transactions || []).filter(other => other && other !== tx
    && posted(other) && String(other.providerAccountId) !== String(tx.providerAccountId)
    && lunchMoneyDebitAmount(other.amount) > 0 && amountsMatchExactly(lunchMoneyDebitAmount(other.amount), Math.abs(amount))
    && businessDaysApart(other.date, tx.date) <= days);
  // An internal household move: an equal debit on another household account within the window, the same day or
  // posted days apart (#1294 review).
  const internalMove = (tx, amount, days) => equalDebitsNear(tx, amount, days)
    .some(other => householdRole(mappingFor(mapDoc, other.providerAccountId)));
  // A credit Lunch Money marks as a transfer (excluded from totals, or a transfer category) is her pay only when its
  // counterpart is the rule's own salary source account (TENNIS INCOME, the owner-confirmed path): an equal debit there
  // within the window. Any other transfer is not her pay (#1294 review).
  const transferFromSalarySource = (tx, amount, days, rule) => {
    const source = ruleCounterpartExternalId(rule);
    return !!source && equalDebitsNear(tx, amount, days).some(other => {
      const mapping = mappingFor(mapDoc, other.providerAccountId);
      return !!mapping && mapping.atlasRole === EXTERNAL_LIVE_ROLE && mappingExternalId(mapping) === source;
    });
  };
  const textFields = tx => identityPayeeFields(tx).concat(identityOriginalNameFields(tx),
    [tx.categoryLabel, tx.notes], (Array.isArray(tx.tags) ? tx.tags : []).map(tag => tag && typeof tag === 'object' ? tag.name : tag))
    .filter(value => typeof value === 'string' && value.trim());
  const notSalaryIncomeCategory = tx => tx.isIncome === true
    && !NEAR_PAYDAY_SALARY_CATEGORY.test(String(tx.categoryLabel || ''));
  const candidates = [];
  for (const tx of input.transactions || []) {
    if (!posted(tx)) continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    if (!(amount < 0)) continue;
    const mapping = mappingFor(mapDoc, tx.providerAccountId);
    if (!mapping || !mapping.canonical || mapping.atlasRole !== 'household-cash') continue;
    if (textFields(tx).some(text => NEAR_PAYDAY_EXCLUDED_WORDS.some(word => word.test(text)))) continue;
    if (notSalaryIncomeCategory(tx)) continue;
    if (others.some(rule => ruleMatchesTransactionIdentity(tx, rule))) continue;
    for (const rule of near) {
      if (mapping.canonical.id !== rule.atlasAccountId) continue;
      if (internalMove(tx, amount, rule.postingBusinessDays)) continue;
      if (transactionIsTransfer(tx) && !transferFromSalarySource(tx, amount, rule.postingBusinessDays, rule)) continue;
      if (rulePayeeExcludePatterns(rule).some(pattern => anyIdentityFieldMatches(identityPayeeFields(tx), pattern)
        || anyIdentityFieldMatches(identityOriginalNameFields(tx), pattern))) continue;
      // Positive sign of salary, beyond passing the exclusions (#1334 review, lead rulings): a TENNIS INCOME transfer
      // leg, or a payee matching the rule's salary aliases. A category is never enough: the household files non-pay
      // credits under a generic income category.
      const salaryEvidence = transferFromSalarySource(tx, amount, rule.postingBusinessDays, rule)
        || (Array.isArray(rule.salaryReceiptPayeePatterns) && rule.salaryReceiptPayeePatterns.length > 0
          && payeeMatchesRule(tx, { payeePatterns: rule.salaryReceiptPayeePatterns, payeeMatchMode: 'exact',
            payeeExcludePatterns: ['REFUND', 'REVERSAL', 'REIMBURSEMENT'] }));
      candidates.push({ tx, amount, rule, mapping, salaryEvidence });
    }
  }
  return candidates;
}

// A salary receipt and its uniquely paired transfer prove more than a generic
// transfer of the expected amount. Keep source-account business cash excluded:
// only configured employer payroll aliases, native CAD and a single scheduled
// salary occurrence bracketed by deposit and transfer can earn this identity.
function salaryReceiptTransferHits(input, rules) {
  const diagnostic = input.salaryDiagnostic;
  const window = input && input.transactionWindow;
  const covered = !!window && window.complete === true && !!parseIsoDate(window.startDate)
    && !!parseIsoDate(window.endDate) && !(window.startDate > window.endDate);
  diagnostic?.window(covered, covered ? undefined : window ? 'WINDOW_INCOMPLETE' : 'WINDOW_MISSING');
  if (!covered) return [];
  const salaryRules = (rules || []).filter(rule => {
    const eligible = rule
    && ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId)
    && !nearPaydayRule(rule)
    && rule.transactionKind === 'transfer' && rule.direction === 'credit'
    && rule.atlasAccountId === 'chequing-a' && ruleCounterpartExternalId(rule)
    && Array.isArray(rule.salaryReceiptPayeePatterns) && rule.salaryReceiptPayeePatterns.length;
    diagnostic?.record(rule?.eventId, 'rule', !!eligible, eligible ? undefined : 'RULE_INELIGIBLE');
    return eligible;
  });
  if (!salaryRules.length) return [];
  const eligibleIds = new Set(salaryRules.map(rule => rule.eventId));
  const nativePosted = tx => hasPostedReceipt(tx)
    && tx.currencySettlementUnconfirmed !== true && tx.currency === 'cad'
    && parseIsoDate(tx.date) && tx.date >= window.startDate && tx.date <= window.endDate
    && tx.providerTransactionId != null;
  const hits = [];
  // Diagnostic attribution is separate from the native matcher below. A
  // candidate needs an explicitly mapped external income source and exactly
  // one native salary occurrence bracketed by that source and this household
  // transfer. No selected rule date, amount match or final outcome assigns it.
  // Pending/foreign evidence can be diagnosed only after this association;
  // absent, malformed or ambiguous association leaves candidate gates unknown.
  const diagnosticSources = diagnostic ? (input.transactions || []).filter(source => {
    if (!source || source.isIncome !== true || !(lunchMoneyDebitAmount(source.amount) < 0)
        || !parseIsoDate(source.date) || source.date < window.startDate || source.date > window.endDate) return false;
    const mapping = mappingFor(input.accountMap, source.providerAccountId);
    return !!mapping && (mapping.atlasRole === EXTERNAL_LIVE_ROLE || !!mappingExternalId(mapping));
  }) : [];
  const diagnosticBrackets = new Map();
  function diagnosticCandidate(credit) {
    if (!diagnostic || !credit || !parseIsoDate(credit.date)
        || credit.date < window.startDate || credit.date > window.endDate
        || !(lunchMoneyDebitAmount(credit.amount) < 0) || !transactionIsTransfer(credit)) return undefined;
    const mapping = mappingFor(input.accountMap, credit.providerAccountId);
    if (!mapping || mapping.atlasRole !== 'household-cash'
        || !mapping.canonical || mapping.canonical.id !== 'chequing-a') return undefined;
    const sources = new Map(), associations = new Map();
    for (const source of diagnosticSources) {
      if (source.date > credit.date) continue;
      const key = source.date + '@' + credit.date;
      if (!diagnosticBrackets.has(key)) diagnosticBrackets.set(key,
        scheduledEventsOnRange(input.plan, source.date, credit.date)
          .filter(event => event.kind === 'income' && eligibleIds.has(event.id)));
      const occurrences = diagnosticBrackets.get(key);
      if (occurrences.length !== 1) continue;
      const occurrence = occurrences[0];
      const recorder = diagnostic.forDate(source.date)?.forOccurrence(occurrence.id, occurrence.date);
      if (!recorder) continue;
      sources.set(source, recorder);
      associations.set(occurrence.id + '@' + occurrence.date, occurrence);
    }
    if (associations.size !== 1) return undefined;
    const occurrence = associations.values().next().value;
    return { attempt: diagnostic.forDate(credit.date)?.forOccurrence(occurrence.id, occurrence.date), sources };
  }
  for (const credit of input.transactions || []) {
    const candidate = diagnosticCandidate(credit);
    const attempt = candidate && candidate.attempt;
    const posted = !!nativePosted(credit);
    for (const rule of salaryRules) attempt?.record(rule.eventId, 'nativePostedCad', posted,
      posted ? undefined : 'CREDIT_UNQUALIFIED');
    if (!posted || !(lunchMoneyDebitAmount(credit.amount) < 0)) continue;
    const mapping = mappingFor(input.accountMap, credit.providerAccountId);
    const householdCredit = !!mapping && mapping.atlasRole === 'household-cash'
      && !!mapping.canonical && mapping.canonical.id === 'chequing-a';
    for (const rule of salaryRules) attempt?.record(rule.eventId, 'householdCredit', householdCredit);
    if (!householdCredit) continue;
    for (const rule of salaryRules) {
      const identityMatches = ruleMatchesTransactionIdentity(credit, rule);
      attempt?.record(rule.eventId, 'transferIdentity', !!identityMatches);
      if (!identityMatches) continue;
      const counterpart = uniqueTransferCounterpart(credit, rule, input, credit.amount, attempt);
      const counterpartPosted = !!nativePosted(counterpart);
      attempt?.record(rule.eventId, 'nativePostedCad', counterpartPosted,
        counterpart && !counterpartPosted ? 'CREDIT_UNQUALIFIED' : undefined);
      if (!counterpartPosted) continue;
      const sources = [];
      for (const source of input.transactions || []) {
        const sourceAttempt = candidate && candidate.sources.get(source);
        const sourcePosted = !!nativePosted(source);
        sourceAttempt?.record(rule.eventId, 'nativePostedCad', sourcePosted,
          sourcePosted ? undefined : 'CREDIT_UNQUALIFIED');
        if (!sourcePosted) continue;
        const sourceIncome = source.isIncome === true && lunchMoneyDebitAmount(source.amount) < 0;
        sourceAttempt?.record(rule.eventId, 'sourceIncome', sourceIncome);
        if (!sourceIncome) continue;
        const sourceTiming = !(source.date > credit.date);
        sourceAttempt?.record(rule.eventId, 'sourceTiming', sourceTiming);
        if (!sourceTiming) continue;
        const amountMatches = amountsMatchExactly(source.amount, credit.amount);
        sourceAttempt?.record(rule.eventId, 'amountGuard', amountMatches,
          amountMatches ? undefined : 'AMOUNT_GUARD_MISMATCH');
        if (!amountMatches) continue;
        const sourceMap = mappingFor(input.accountMap, source.providerAccountId);
        const roleMatches = !!sourceMap && sourceMap.atlasRole === EXTERNAL_LIVE_ROLE;
        sourceAttempt?.record(rule.eventId, 'externalRole', roleMatches,
          roleMatches ? undefined : 'SOURCE_ROLE_MISMATCH');
        if (!roleMatches) continue;
        const externalMatches = mappingExternalId(sourceMap) === ruleCounterpartExternalId(rule);
        sourceAttempt?.record(rule.eventId, 'externalIdentity', externalMatches,
          externalMatches ? undefined : 'EXTERNAL_ID_MISMATCH');
        if (!externalMatches) continue;
        const accountMatches = String(source.providerAccountId) === String(counterpart.providerAccountId);
        sourceAttempt?.record(rule.eventId, 'sourceAccount', accountMatches,
          accountMatches ? undefined : 'SOURCE_ACCOUNT_MISMATCH');
        if (!accountMatches) continue;
        const aliasMatches = payeeMatchesRule(source, { payeePatterns: rule.salaryReceiptPayeePatterns,
          payeeMatchMode: 'exact', payeeExcludePatterns: ['REFUND', 'REVERSAL', 'REIMBURSEMENT'] });
        sourceAttempt?.record(rule.eventId, 'payrollAlias', !!aliasMatches,
          aliasMatches ? undefined : 'PAYROLL_ALIAS_MISMATCH');
        if (!aliasMatches) continue;
        // The nominal date is bracketed by actual receipt and actual transfer.
        // Multiple eligible occurrences cannot borrow the same salary packet.
        const occurrences = scheduledEventsOnRange(input.plan, source.date, credit.date)
          .filter(event => event.kind === 'income' && eligibleIds.has(event.id));
        const occurrenceMatches = occurrences.length === 1 && occurrences[0].id === rule.eventId;
        sourceAttempt?.record(rule.eventId, 'occurrence', occurrenceMatches,
          occurrenceMatches ? undefined : occurrences.length > 1 ? 'OCCURRENCE_AMBIGUOUS' : 'OCCURRENCE_MISSING');
        if (!occurrenceMatches) continue;
        sources.push({ source, occurrence: occurrences[0] });
      }
      attempt?.record(rule.eventId, 'payrollReceipt', sources.length === 1,
        sources.length === 1 ? undefined : sources.length ? 'RECEIPT_AMBIGUOUS' : 'RECEIPT_MISSING');
      if (sources.length !== 1) continue;
      const { source, occurrence } = sources[0];
      hits.push({ id: rule.eventId, date: occurrence.date, postingDate: credit.date,
        postingDateRelation: 'salary-receipt-to-paired-transfer', direction: 'credit',
        providerTransactionId: credit.providerTransactionId,
        providerTransactionIds: [credit.providerTransactionId, counterpart.providerTransactionId, source.providerTransactionId],
        providerAccountId: credit.providerAccountId, payee: credit.payee,
        identity: 'employer-payroll+external-account+paired-transfer+occurrence',
        amountNotUsed: false, observedAmount: lunchMoneyDebitAmount(source.amount),
        atlasAccountId: 'chequing-a', settlesWhen: 'salary-receipt-and-paired-transfer' });
    }
  }
  return hits;
}

// E2 (lead ruling 2026-11-18, #821 6967807281, under Dale's standing
// direction; Dale may veto). A card minimum stays withheld from automatic
// settlement (cardMinimumNeedsConfirmation: a card payment may be a purchase
// backfill, not the minimum) except in one narrow case. The rule opts in
// (settlementFrom), Lunch Money's own matches for its reviewed item are
// consistent (stampLunchMoneyMatched), and Lunch Money paired exactly this
// one payment with the cycle, where:
//   - the cycle has a CONFIRMED statement (statementOccurrences, confidence
//     confirmed) whose scheduled date is the paired occurrence;
//   - the payment posted inside the cycle (after the previous occurrence, up
//     to the statement's due date) and is at least that statement's minimum;
//     and
//   - no other linked payment of the rule posted in that cycle (after the
//     previous occurrence, up to the statement's due date), and the fetched
//     transaction window is complete and starts no later than the cycle's
//     first day, so an earlier payment in the cycle cannot be missing.
// Otherwise today's withholding stands: a payment below the minimum, two
// payments in a cycle, or no confirmed statement (the plan's estimated
// minimum never counts). coveringStatementCycleDates is untouched.
function lmMatchedCardMinimumQualifies(plan, rule, tx, date, linked, txWindow) {
  const row = ((plan && plan.obligations) || []).find(item => item && item.id === rule.eventId);
  if (!row || row.effect !== 'payment' || !Array.isArray(row.statementOccurrences)) return false;
  const original = Forecast.statementOccurrenceIdentity(plan, rule.eventId, date);
  const statements = row.statementOccurrences.filter(r => r && r.scheduledDate === original);
  if (statements.length !== 1) return false;
  const statement = statements[0];
  const minimum = Number(statement.minimum);
  if (statement.confidence !== 'confirmed' || !realIsoDay(statement.dueDate) || !(Number.isFinite(minimum) && minimum > 0)) return false;
  if (!(lunchMoneyDebitAmount(tx.amount) + IDENTITY_AMOUNT_EPSILON >= minimum)) return false;
  const previous = Forecast.occurrences(row, Forecast.addDays(original, -62), Forecast.addDays(original, -1)).pop() || Forecast.addDays(original, -31);
  if (!txWindow || txWindow.complete !== true || !realIsoDay(txWindow.startDate)
    || txWindow.startDate > Forecast.addDays(previous, 1)) return false;
  // The paired payment itself must post inside the cycle: a payment before
  // the cycle starts, or after the statement is due, pays no part of it.
  if (!realIsoDay(tx.date) || !(tx.date > previous && tx.date <= statement.dueDate)) return false;
  const others = (linked || []).filter(other => other !== tx && other && other.pending === false && other.date
    && lunchMoneyDebitAmount(other.amount) > 0 && other.date > previous && other.date <= statement.dueDate);
  return others.length === 0;
}
// True only for the narrow E2 case above, on the rule that opted in.
function lmMatchedCardMinimum(tx, rule) {
  const lm = tx && typeof tx === 'object' ? LM_MATCHED.get(tx) : null;
  return !!(rule && rule.settlementFrom === SETTLEMENT_FROM_LM_MATCHED && lm && lm.eventId === rule.eventId
    && lm.date && lm.cardMinimum === true);
}

// S3: read which occurrences Lunch Money itself matched for an opt-in rule's
// reviewed recurring item, and stamp each linked transaction of that rule
// with the occurrence LM paired it to (LM_MATCHED date) or none (null). The
// Lunch Money spec gives matches.expected_occurrence_dates,
// found_transactions ({date, transaction_id}) and missing_transaction_dates
// ("expected but none was found"); it does not pair a found transaction to a
// date. So an expected date not in missing is LM-matched, and the matched
// dates and found transactions are paired in date order only when everything
// agrees. Every one of these must hold, or the rule is left to its incumbent
// postingDateRule (fail closed to today's behaviour):
//   - the read is complete, the rule's one item is reviewed, and no other rule
//     names it;
//   - missing dates are a subset of expected dates, with no duplicates;
//   - every found transaction is in this observation, posted, on the rule's
//     account, in its currency, in the rule's direction (money out for a
//     debit rule, money in for a credit rule; a transfer-kind rule also
//     needs a transfer row), and carries the rule's link;
//   - the found count equals the matched-date count;
//   - every matched date is exactly one scheduled occurrence of the bill;
//   - each paired payment's amount is consistent with that occurrence (a
//     debit rule only). A credit rule's paired receipt settles at its actual
//     amount: Lunch Money paired it, and Forecast publishes the represented
//     actual, so no scheduled-amount guard is asked (Q1, lead 2026-11-18).
function stampLunchMoneyMatched(transactions, identityRules, plan, accountMap, rawRecurring, txWindow) {
  for (const tx of transactions || []) if (tx && typeof tx === 'object') LM_MATCHED.delete(tx);
  const rules = (identityRules || []).filter(rule => rule && rule.settlementFrom === SETTLEMENT_FROM_LM_MATCHED
    && rule.eventId && (rule.direction === 'debit' || rule.direction === 'credit')
    // A rule with its own salary-receipt matcher never takes LM's pairing: two matchers could then settle one
    // arrival on different paydays (Codex P2 on #1292). Payroll is the credit rule Q1 opts in.
    && !(Array.isArray(rule.salaryReceiptPayeePatterns) && rule.salaryReceiptPayeePatterns.length)
    && ruleLunchMoneyRecurringIds(rule).length === 1);
  const applied = [];
  const read = rawRecurring && rawRecurring.status === 'read' ? rawRecurring.read : null;
  if (!rules.length || !plan || !read || !Array.isArray(read.items) || read.unexpectedPaginationEvidence !== false) return applied;
  const isDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  for (const rule of rules) {
    const id = ruleLunchMoneyRecurringIds(rule)[0];
    if ((identityRules || []).filter(other => other && ruleLunchMoneyRecurringIds(other).includes(id)).length !== 1) continue;
    const items = read.items.filter(item => item && String(item.providerId) === id);
    if (items.length !== 1 || items[0].status !== 'reviewed') continue;
    const m = items[0].matches;
    if (!m || !Array.isArray(m.expectedOccurrenceDates) || !Array.isArray(m.missingTransactionDates)
      || !Array.isArray(m.foundTransactions)) continue;
    const expected = m.expectedOccurrenceDates, missing = m.missingTransactionDates;
    if (!expected.every(isDate) || !missing.every(isDate) || new Set(expected).size !== expected.length
      || new Set(missing).size !== missing.length || !missing.every(d => expected.includes(d))) continue;
    const matched = expected.filter(d => !missing.includes(d)).sort();
    const found = m.foundTransactions;
    if (!found.every(f => f && f.transactionId != null && isDate(f.date))) continue;
    const linked = (transactions || []).filter(tx => tx && ruleMatchesTransactionIdentity(tx, rule));
    // Grok Bot's guard (LM-matched route): when Lunch Money lists one
    // transaction more than once, it has matched it to several due dates.
    // None of the matched dates reads Paid and no linked payment of the rule
    // settles anything in this observation.
    const ids = found.map(f => String(f.transactionId));
    // The incumbent To confirm follows: each linked payment is the bill of no
    // occurrence and its line names the bill (linkedBillMisfit), while every
    // occurrence stays due and reserved.
    if (new Set(ids).size !== ids.length) {
      for (const tx of linked) LM_MATCHED.set(tx, { eventId: rule.eventId, date: null });
      applied.push({ eventId: rule.eventId, reusedTransaction: true });
      continue;
    }
    const foundTx = found.map(f => {
      const rows = linked.filter(tx => String(tx.providerTransactionId) === String(f.transactionId));
      return rows.length === 1 ? rows[0] : null;
    });
    const accepted = tx => {
      if (!hasPostedReceipt(tx)) return false;
      const mapping = accountMap && mappingFor(accountMap, tx.providerAccountId);
      if (!mapping || !mapping.canonical || (rule.atlasAccountId && mapping.canonical.id !== rule.atlasAccountId)) return false;
      if (rule.transactionKind === 'transfer' && !transactionIsTransfer(tx)) return false;
      const amount = lunchMoneyDebitAmount(tx.amount);
      return ruleCurrencyQualified(tx, rule) && (rule.direction === 'credit' ? amount < 0 : amount > 0);
    };
    if (!foundTx.every(accepted) || foundTx.length !== matched.length) continue;
    const pairs = foundTx.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.providerTransactionId).localeCompare(String(b.providerTransactionId)))
      .map((tx, i) => ({ tx, date: matched[i] }));
    const consistent = pairs.every(({ tx, date }) => {
      const occ = scheduledOccurrence(plan, rule.eventId, date);
      return occ.length === 1 && (rule.direction === 'credit'
        || billDebitAmountConsistent(rule, lunchMoneyDebitAmount(tx.amount), occ[0].amount));
    });
    if (!consistent) continue;
    for (const tx of linked) LM_MATCHED.set(tx, { eventId: rule.eventId, date: null });
    // E2: a card minimum is otherwise withheld by cardMinimumNeedsConfirmation;
    // the pairing marks only the narrow case that may settle it.
    const card = cardMinimumNeedsConfirmation(plan, rule.eventId, accountMap);
    for (const { tx, date } of pairs) {
      LM_MATCHED.set(tx, { eventId: rule.eventId, date,
        ...(card ? { cardMinimum: lmMatchedCardMinimumQualifies(plan, rule, tx, date, linked, txWindow) } : {}) });
    }
    applied.push({ eventId: rule.eventId, matchedDates: matched.length });
  }
  return applied;
}

function representedEventHitGroups(input) {
  const diagnostic = input.salaryDiagnostic;
  const empty = { unique: [], ambiguous: [] };
  if (input.transactionWindow && input.transactionWindow.complete === false) {
    diagnostic?.window(false, 'WINDOW_INCOMPLETE');
    return empty;
  }
  const rules = stampRuleSetClaims(input.identityRules).filter(rule => {
    diagnostic?.rule(rule?.eventId);
    const eligible = ruleHasIdentity(rule, diagnostic)
      && (!cardMinimumNeedsConfirmation(input.plan, rule.eventId, input.accountMap)
        || rule.settlementFrom === SETTLEMENT_FROM_LM_MATCHED);
    diagnostic?.record(rule?.eventId, 'rule', !!eligible, eligible ? undefined : 'RULE_INELIGIBLE');
    return eligible;
  });
  diagnostic?.rulesScanned();
  if (!rules.length) return empty;
  const mapDoc = input.accountMap;
  const eventHits = new Map();
  const counterpartAmbiguous = new Map();
  for (const hit of nearPaydaySalaryHits(input, rules).concat(salaryReceiptTransferHits(input, rules))) {
    const key = hit.id + '@' + hit.date;
    const list = eventHits.get(key) || [];
    list.push(hit);
    eventHits.set(key, list);
  }
  for (const tx of input.transactions || []) {
    if (!hasPostedReceipt(tx)) continue;
    const mapping = mappingFor(mapDoc, tx.providerAccountId);
    if (!mapping || !mapping.canonical || !mapping.canonical.id) continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    for (const rule of rules) {
      // E2: an opted-in card rule is let through only for its narrow LM case.
      if (cardMinimumNeedsConfirmation(input.plan, rule.eventId, mapDoc) && !lmMatchedCardMinimum(tx, rule)) continue;
      if (rule.atlasAccountId && mapping.canonical.id !== rule.atlasAccountId) continue;
      if (!ruleMatchesTransactionIdentity(tx, rule)) continue;
      if (!ruleCurrencyQualified(tx, rule)) continue;
      if (rule.direction === 'credit' && !(amount < 0)) continue;
      if (rule.direction === 'debit' && !(amount > 0)) continue;
      if (rule.postingDateRule === DUE_OR_UP_TO_TWO_DAYS_AFTER && !(Number.isFinite(amount) && amount > 0)) continue;
      for (const scheduledDate of coveringScheduledDates(input.plan, rule, tx.date, tx, input.transactions)) {
        const scheduled = scheduledOccurrence(input.plan, rule.eventId, scheduledDate);
        if (scheduled.length !== 1) continue;
        const relation = postingDateRelation(scheduledDate, tx.date, rule, tx);
        if (!relation) continue;
        if (rule.settlesWhen === SETTLES_WHEN_AMOUNT_AT_LEAST) {
          const need = Math.abs(Number(scheduled[0].amount));
          if (!(Math.abs(amount) + IDENTITY_AMOUNT_EPSILON >= need)) continue;
        }
        // Q1 (lead 2026-11-18): when Lunch Money itself paired a CREDIT rule's receipt to the occurrence, the
        // exact-scheduled-amount guard is not asked; the receipt settles at its actual amount. A debit rule keeps
        // the guard (Codex P2 on #1292). Without that pairing the incumbent guard applies unchanged.
        if (rule.settlesWhen === SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT
          && !(relation === LM_MATCHED_RELATION && rule.direction === 'credit')) {
          const need = Math.abs(Number(scheduled[0].amount));
          if (!(isFinite(need) && isFinite(amount)
            && Math.abs(Math.abs(amount) - need) <= IDENTITY_AMOUNT_EPSILON)) {
            continue;
          }
        }
        if (!billDebitAmountConsistent(rule, amount, scheduled[0].amount)) continue;
        if (rule.transactionKind === 'transfer') {
          const counterpartCount = countTransferCounterparts(tx, rule, input, amount,
            diagnostic?.forDate(tx.date)?.forOccurrence(rule.eventId, scheduledDate));
          if (counterpartCount !== 1) {
            if (counterpartCount > 1) {
              const ambKey = rule.eventId + '@' + scheduledDate;
              const prior = counterpartAmbiguous.get(ambKey);
              counterpartAmbiguous.set(ambKey, {
                id: rule.eventId,
                date: scheduledDate,
                candidateCount: Math.max(counterpartCount, prior && prior.candidateCount || 0),
              });
            }
            continue;
          }
        }
        const key = rule.eventId + '@' + scheduledDate;
        const list = eventHits.get(key) || [];
        // The stronger salary packet and its legacy same-day transfer are
        // one credit, not two compatible receipts for the same occurrence.
        if (list.some(hit => String(hit.providerTransactionId) === String(tx.providerTransactionId))) continue;
        list.push({
          id: rule.eventId,
          date: scheduledDate,
          postingDate: tx.date,
          postingDateRelation: relation,
          direction: rule.direction || null,
          providerTransactionId: tx.providerTransactionId,
          providerAccountId: tx.providerAccountId,
          payee: tx.payee,
          identity: ruleIdentityLabel(rule),
          amountNotUsed: true,
          observedAmount: amount,
          atlasAccountId: mapping.canonical.id,
          settlesWhen: rule.settlesWhen || null,
          sameAccountSplitLegs: rule.sameAccountSplitLegs === true,
        });
        eventHits.set(key, list);
      }
    }
  }
  for (const tx of input.transactions || []) {
    const inherited = tx && tx.pendingReplacementHit;
    if (!inherited || !inherited.id || !inherited.date || !hasPostedReceipt(tx)) continue;
    if (cardMinimumNeedsConfirmation(input.plan, inherited.id, input.accountMap)) continue;
    const key = inherited.id + '@' + inherited.date;
    const list = eventHits.get(key) || [];
    if (list.some(hit => String(hit.providerTransactionId) === String(inherited.providerTransactionId))) {
      continue;
    }
    list.push(inherited);
    eventHits.set(key, list);
  }
  const spotifyEvidence = soleOwnerConfirmedSpotifyTransaction(
    input.transactions, input.accountMap
  );
  for (const hit of scheduleTrustCandidates(input)) {
    if (cardMinimumNeedsConfirmation(input.plan, hit.id, input.accountMap)) continue;
    const key = hit.id + '@' + hit.date;
    if (eventHits.has(key)) continue;
    if (spotifyEvidence && hit.id === 'spotify' && hit.date === '2026-09-23') {
      hit.providerTransactionId = spotifyEvidence.providerTransactionId;
      hit.postingDate = spotifyEvidence.date || hit.postingDate;
    }
    eventHits.set(key, [hit]);
  }
  const unique = [];
  const ambiguous = [];
  // Q2 (owner decision 6967081727): one near-amount-and-payday credit that qualifies for two or more
  // occurrences leaves every one of them To confirm. Found across ALL qualifying hits, before any occurrence
  // is classified, so an occurrence that is also ambiguous for another reason cannot hide the reuse.
  const nearKeysByTx = new Map();
  for (const [key, hits] of eventHits) {
    for (const hit of hits) {
      if (!hit || hit.settlesWhen !== SETTLES_WHEN_NEAR_AMOUNT_AND_PAYDAY) continue;
      const keys = nearKeysByTx.get(String(hit.providerTransactionId)) || new Set();
      keys.add(key);
      nearKeysByTx.set(String(hit.providerTransactionId), keys);
    }
  }
  const nearShared = new Set([...nearKeysByTx.values()].filter(keys => keys.size > 1).flatMap(keys => [...keys]));
  for (const [key, hits] of eventHits) {
    if (nearShared.has(key)) {
      ambiguous.push({ key, id: hits[0] && hits[0].id, date: hits[0] && hits[0].date, hits,
        reason: 'transaction-consumed-twice' });
      continue;
    }
    const twoLegHits = hits.filter(hit => hit && hit.settlesWhen === SETTLES_WHEN_TWO_LEG_SUM);
    const otherHits = hits.filter(hit => !hit || hit.settlesWhen !== SETTLES_WHEN_TWO_LEG_SUM);
    // A pure shape keeps the incumbent decision. Standing bell is the
    // occurrence that can carry both a Travel Visa debit and a chequing-a
    // two-leg pair. Those shapes are judged separately. A subset that is
    // not an accepted pair does not veto the other shape. Two accepted
    // shapes for one occurrence stay unresolved.
    if (!twoLegHits.length || !otherHits.length) {
      const classified = classifyOccurrenceHits(key, hits);
      if (classified.unique) unique.push(classified.unique);
      else if (classified.ambiguous) ambiguous.push(classified.ambiguous);
      continue;
    }
    const twoClass = classifyOccurrenceHits(key, twoLegHits);
    const otherClass = classifyOccurrenceHits(key, otherHits);
    if (twoClass.unique && otherClass.unique) {
      ambiguous.push({
        key,
        id: hits[0] && hits[0].id,
        date: hits[0] && hits[0].date,
        hits,
        reason: 'multiple-compatible-candidates',
        candidateCount: hits.length,
      });
      continue;
    }
    if (twoClass.unique) {
      unique.push(twoClass.unique);
      continue;
    }
    if (otherClass.unique) {
      unique.push(otherClass.unique);
      continue;
    }
    if (twoClass.ambiguous) ambiguous.push(twoClass.ambiguous);
    else if (otherClass.ambiguous) ambiguous.push(otherClass.ambiguous);
  }
  const byTx = new Map();
  for (const hit of unique) {
    for (const rawId of candidateTransactionIds(hit)) {
      const list = byTx.get(String(rawId)) || [];
      list.push(hit);
      byTx.set(String(rawId), list);
    }
  }
  const preferred = [];
  const droppedUpcoming = new Set();
  // Grok Bot (#1206, 6928328181): a recurring link and an item note naming DIFFERENT bills leave
  // neither the winner. That holds whatever their due dates: the outstanding-before-upcoming
  // preference below must not pick one of them (Astra's audit, #821 6934483625, observation 2),
  // so such a row goes on to the consumed-twice path (To confirm).
  const txById = new Map((input.transactions || []).map(tx => [String(tx && tx.providerTransactionId), tx]));
  const deliberateLinksDisagree = txId => {
    const tx = txById.get(String(txId));
    if (!tx) return false;
    const linkedTo = tx.recurringId == null ? '' : String(tx.recurringId).trim();
    const items = noteItemNames(tx.notes);
    const byRecurring = new Set(rules.filter(rule => linkedTo
      && ruleLunchMoneyRecurringIds(rule).includes(linkedTo)).map(rule => rule.eventId));
    const byItem = new Set(rules.filter(rule => items.length === 1
      && ruleLunchMoneyItemNames(rule).includes(items[0])).map(rule => rule.eventId));
    return byRecurring.size > 0 && byItem.size > 0 && [...byRecurring].some(id => !byItem.has(id));
  };
  for (const [txId, siblings] of byTx) {
    const outstanding = siblings.filter(hit => hit && hit.date <= hit.postingDate);
    const upcoming = siblings.filter(hit => hit && hit.date > hit.postingDate);
    if (outstanding.length && upcoming.length && !deliberateLinksDisagree(txId)) {
      for (const hit of upcoming) {
        droppedUpcoming.add(hit.id + '@' + hit.date + '@' + txId);
      }
    }
  }
  for (const hit of unique) {
    const txIds = candidateTransactionIds(hit).map(String);
    if (txIds.some(txId => droppedUpcoming.has(hit.id + '@' + hit.date + '@' + txId))) {
      continue;
    }
    preferred.push(hit);
  }
  const preferredByTx = new Map();
  for (const hit of preferred) {
    for (const rawId of candidateTransactionIds(hit)) {
      const list = preferredByTx.get(String(rawId)) || [];
      list.push(hit);
      preferredByTx.set(String(rawId), list);
    }
  }
  const uniqueOnce = [];
  const consumedTwice = new Set();
  for (const hit of preferred) {
    const txIds = candidateTransactionIds(hit).map(String);
    const conflictId = txIds.find(txId => (preferredByTx.get(txId) || []).length > 1);
    if (conflictId) {
      if (!consumedTwice.has(conflictId)) {
        consumedTwice.add(conflictId);
        const siblings = preferredByTx.get(conflictId) || [];
        ambiguous.push({
          key: siblings.map(s => s.id + '@' + s.date).sort().join(','),
          id: null,
          date: null,
          hits: siblings,
          reason: 'transaction-consumed-twice',
        });
      }
      continue;
    }
    uniqueOnce.push(hit);
  }
  for (const [key, row] of counterpartAmbiguous) {
    if (uniqueOnce.some(hit => hit && hit.id + '@' + hit.date === key)) continue;
    if (ambiguous.some(group => group && (group.key === key
      || (group.id === row.id && group.date === row.date)))) continue;
    ambiguous.push({
      key,
      id: row.id,
      date: row.date,
      hits: [],
      reason: 'multiple-compatible-candidates',
      candidateCount: row.candidateCount,
    });
  }
  diagnostic?.resolve();
  return { unique: uniqueOnce.map(hit => {
    const original = Forecast.statementOccurrenceIdentity(input.plan, hit.id, hit.date);
    return original === hit.date ? hit : { ...hit, scheduledDate: original };
  }), ambiguous };
}

function sanitizedSameDayInboundAmbiguity(groups) {
  return (groups || [])
    .filter(group => group && group.id && group.date)
    .map(group => ({
      id: group.id,
      date: group.date,
      reason: group.reason || 'multiple-compatible-candidates',
      candidateCount: Number(group.candidateCount) > 0
        ? Number(group.candidateCount)
        : ((group.hits || []).length || 0),
      // Earliest posting among the competing hits (a date, never provider
      // text). An early-income hold needs a posting already in the opening.
      earliestPostingDate: (group.hits || []).map(hit => hit && hit.postingDate)
        .filter(date => parseIsoDate(date)).sort()[0] || null,
    }));
}

function representedEventCandidates(input) {
  return representedEventHitGroups(input).unique;
}

// A qualified posted receipt can be in today's stock before its nominal
// occurrence. This is uncertainty evidence only: never select a settlement,
// change the calendar, or attach the receipt to a future represented event.
// How far before the observation window the income's own schedule is read for the occurrence just
// before a credit (covers monthly and quarterly incomes).
const LATE_POSTING_LOOKBACK_DAYS = 100;
function futureIncomeUncertainty(input, represented, ambiguous) {
  const window = input.transactionWindow, asOf = input.asOf;
  const empty = { asOf, status: 'ready', issues: [] };
  if (!window || window.complete !== true || window.hasMore === true || window.truncated === true
      || !parseIsoDate(window.startDate) || !parseIsoDate(asOf)
      || window.endDate !== asOf || window.startDate > asOf || !input.plan) return empty;
  const used = new Set((represented || []).flatMap(candidateTransactionIds));
  // Occurrences the observer already claims: a unique represented receipt, or competing
  // compatible credits. A future occurrence with competing credits already posted on or before
  // this opening is held precisely by live-plan earlyIncomeAmbiguityGuards (the same three
  // conditions: it is after the opening, a credit is already in it, and it is an exact scheduled
  // occurrence), which withholds just that occurrence and keeps the cap; the wider guard for
  // other scheduled incomes leaves exactly those to it rather than withholding more. Any other
  // ambiguous group is not skipped here.
  const ambiguousKeys = new Set((ambiguous || []).filter(group => group && group.id && group.date
    && group.date > asOf && (group.hits || []).some(hit => hit && parseIsoDate(hit.postingDate) && hit.postingDate <= asOf)
    && Forecast.prepaidIncomeOccurrence(input.plan, group.id, group.date, asOf))
    .map(group => String(group.id) + '@' + String(group.date)));
  const claimedKeys = new Set([...(represented || []).filter(candidate => candidate && candidate.id && candidate.date)
    .map(candidate => String(candidate.id) + '@' + String(candidate.date)), ...ambiguousKeys]);
  const native = tx => tx && tx.pending !== true && tx.contradictoryEvidence !== true
    && tx.currencySettlementUnconfirmed !== true && tx.currency === 'cad'
    && parseIsoDate(tx.date) && tx.date >= window.startDate && tx.date <= asOf
    && tx.providerTransactionId != null && !used.has(String(tx.providerTransactionId));
  const identityRules = stampRuleSetClaims(input.identityRules).filter(rule => ruleHasIdentity(rule));
  const rules = identityRules.filter(rule => rule.direction === 'credit' && rule.atlasAccountId === 'chequing-a');
  // U6 (lead, boundary (ii)): a plain credit that could be her pay but posted before the owner's window. A credit
  // the near-amount matcher placed under any occurrence (settled, or competing To confirm) is explained by it and
  // never held here; every other candidate passed the matcher's exclusions and differs only in timing or amount.
  const nearPaydayExplained = new Set(nearPaydaySalaryHits(input, identityRules)
    .map(hit => String(hit.providerTransactionId)));
  const nearPaydayEarly = nearPaydaySalaryCandidates(input, identityRules)
    .filter(candidate => !nearPaydayExplained.has(String(candidate.tx.providerTransactionId)));
  const payroll = rules.filter(rule => rule.eventId === 'payroll' && rule.transactionKind !== 'transfer');
  const salary = rules.filter(rule => ['amandaSalary15', 'amandaSalaryMonthEnd'].includes(rule.eventId)
    && rule.transactionKind === 'transfer' && ruleCounterpartExternalId(rule)
    && Array.isArray(rule.salaryReceiptPayeePatterns) && rule.salaryReceiptPayeePatterns.length);
  // Every other scheduled income with its own credit identity rule into Bills is held to
  // the same rule as payroll: a posting after its previous occurrence that no occurrence
  // claimed may be the NEXT occurrence arriving early, which the cash walk would count a
  // second time. A transfer-kind rule without salary receipt evidence cannot be proven
  // either way here and is left to its own matcher.
  const named = new Set(['payroll', 'amandaSalary15', 'amandaSalaryMonthEnd']);
  const otherRules = rules.filter(rule => !named.has(rule.eventId) && rule.transactionKind !== 'transfer');
  const otherIds = new Set(otherRules.map(rule => rule.eventId));
  const others = [...otherIds].map(id => otherRules.filter(rule => rule.eventId === id));
  const groups = [payroll, salary, ...others].filter(group => group.length);
  const end = Forecast.knowledgeHorizon(input.plan, asOf).end;
  const schedule = scheduledEventsOnRange(input.plan, window.startDate, end)
    .filter(event => event.kind === 'income' && event.amount > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  const issues = [];
  for (const group of groups) {
    const ids = new Set(group.map(rule => rule.eventId));
    const events = schedule.filter(event => ids.has(event.id));
    const futureDate = events.find(event => event.date > asOf)?.date;
    if (!futureDate) continue;
    // Bound overlap by the native preceding income occurrence (both Amanda
    // slots share one employer packet), clipped to complete provider coverage.
    const previous = events.filter(event => event.date <= asOf).map(event => event.date).sort().pop();
    const afterPrevious = tx => !previous || tx.date > previous;
    // A credit right after an occurrence that nothing claimed is that occurrence's LATE
    // posting (income has no after-the-day tolerance, so a deposit one day late, or Friday's
    // landing Monday, is unclaimed), not an early one for the next occurrence. Only the
    // occurrence just before the credit decides: when it IS claimed, an extra credit can be the
    // next one arriving early, whatever older occurrences did. Limited to the other scheduled
    // incomes; payroll has its own narrower one-business-day rule below, and the salary pair keeps its rule.
    const previousEvent = events.filter(event => event.date <= asOf)
      .sort((left, right) => left.date.localeCompare(right.date)).pop();
    const earlierUnclaimed = !!previousEvent && !claimedKeys.has(previousEvent.id + '@' + previousEvent.date);
    // The occurrence just before the credit is read from the income's own schedule, even when it
    // is dated BEFORE the window starts (an Aug 12 occurrence for a window that opens Aug 13).
    // Nothing in the window can claim it, so its claim cannot be seen and it counts as
    // UNCLAIMED: a credit that is its late posting stays live, exactly as before the guard was
    // widened. Only the credit's nearness tells a late posting from an early one for the next
    // occurrence (an Aug 13 credit is one day after Aug 12 and a month before Sep 12; an Aug 20
    // credit is a month after Jul 21 and one day before Aug 21): the credit is late for the
    // earlier occurrence only when strictly nearer to it than to the next, and a tie cannot be
    // proven late, so it is held. Without any occurrence in reach, nothing proves lateness.
    const lookback = Forecast.addDays(window.startDate, -LATE_POSTING_LOOKBACK_DAYS);
    const priorEvent = previousEvent || (otherIds.has(group[0].eventId) && lookback
      ? scheduledEventsOnRange(input.plan, lookback, Forecast.addDays(window.startDate, -1))
        .filter(event => ids.has(event.id) && event.kind === 'income' && event.amount > 0)
        .sort((left, right) => left.date.localeCompare(right.date)).pop() : null);
    const lateOfEarlier = credit => previousEvent ? earlierUnclaimed
      : !!priorEvent && Forecast.diffDays(priorEvent.date, credit.date) < Forecast.diffDays(credit.date, futureDate);
    // Payroll late-posting hold-off (#1290). Since #1325 the matcher itself SETTLES a plain payroll credit one
    // business day late (payrollLatePayday), and a settled credit is in `used`, so it never reaches this check: the
    // matcher is the one path for every late pay it settles. What remains here is narrower and settles nothing: it
    // only keeps the plan live, with the payday still To confirm and the figures estimated, for an exact-amount late
    // credit the matcher declined. Three cases remain (test/test-payroll-late-hold-off-remaining.js): (a) another
    // credit of the same identity competes for the payday (an early one, say), so the matcher's late cover stands
    // down; (b) the credit also fits another income's occurrence, so the matcher leaves it unresolved; (c) a payroll
    // rule that is not the plain shape (it names a posting-date rule or a settlement mode), which the late cover does
    // not read. A posted payroll credit dated within one business day after the payday just before it (Friday's pay
    // landing Monday), when nothing claimed that payday, is that payday's late posting and is never the next pay
    // arriving early. Business days are Forecast's (Monday to Friday, no holiday calendar), so a payday followed
    // by a weekday holiday is two business days to the Tuesday and still holds. At most ONE credit is absorbed per
    // payday: a second qualifying credit is unexplained and holds exactly as before, as does any credit that is not
    // explicitly posted, not of exactly the scheduled amount, not strictly nearer that payday than the next, or later
    // than one business day.
    // A payday whose own receipts already compete (an ambiguous group for that exact occurrence, on any date) is
    // not unclaimed in the sense this needs: its receipt is unresolved, so a later credit stays held as before.
    // Only a credit of EXACTLY the payday's scheduled amount is absorbed (#1290 review): this hold-off settles nothing,
    // so Forecast publishes the payday's scheduled amount, which equals the credit only when the amounts are equal.
    // A short, tiny or oversized late credit the matcher declined holds exactly as before.
    const previousAmbiguous = !!previousEvent && (ambiguous || []).some(group => group
      && String(group.id) === String(previousEvent.id) && String(group.date) === String(previousEvent.date));
    let payrollLateAbsorbed = 0;
    // Q1: when Lunch Money's own pairing took authority over payroll in THIS observation (stampLunchMoneyMatched
    // stamped a payroll deposit, with a payday or with none), LM decides which payday each linked deposit settles,
    // so this hold-off stands aside. When the read is absent, unavailable or inconsistent, nothing is stamped and
    // the hold-off applies as before. Its removal is the closure step once the item is named (BACKLOG), when LM's
    // pairing decides cases (a) to (c) above.
    const payrollLmMatched = (input.transactions || []).some(tx => {
      const lm = tx && typeof tx === 'object' ? LM_MATCHED.get(tx) : null;
      return !!lm && lm.eventId === 'payroll';
    });
    const payrollLateOfEarlier = credit => !payrollLmMatched && !!previousEvent && earlierUnclaimed && !previousAmbiguous
      && credit.savingsPostingEvidence === 'posted' && credit.date > previousEvent.date
      && Math.abs(Math.abs(lunchMoneyDebitAmount(credit.amount)) - Math.abs(Number(previousEvent.amount))) <= IDENTITY_AMOUNT_EPSILON
      && Forecast.businessDaysAfter(previousEvent.date, credit.date) <= 1
      && Forecast.diffDays(previousEvent.date, credit.date) < Forecast.diffDays(credit.date, futureDate);
    let unresolved = false;
    // The early plain-credit hold (U6, boundary (ii) as narrowed by the #1334 review), for the near-amount-and-payday
    // salary rules only. A posted candidate after the previous occurrence, that the matcher did not place, holds the
    // next occurrence when it carries positive salary evidence (salaryEvidence) and is no less than half that
    // occurrence's scheduled amount, on any date in the run-up (an early, possibly off-amount, pay). Otherwise the
    // cash walk counts her early pay as Other Income while the payday is still projected, so the pay is counted twice.
    // A credit within the rule's tolerance and business days of the payday is the matcher's (settled, or competing To
    // confirm), so it is never held here. A credit with no sign of salary never withholds the plan. When the occurrence just
    // before the credit was claimed by nothing, a credit strictly nearer to it than to the next payday is that
    // occurrence's late pay (left To confirm, not relied on), not the next one arriving early, so it holds nothing,
    // as lateOfEarlier reads the other scheduled incomes.
    const futureEvent = events.find(event => event.date > asOf);
    if (futureEvent && group.some(nearPaydayRule)) {
      const scheduled = Math.abs(Number(futureEvent.amount));
      const lateForPrevious = tx => !!previousEvent && earlierUnclaimed
        && Forecast.diffDays(previousEvent.date, tx.date) < Forecast.diffDays(tx.date, futureEvent.date);
      unresolved = nearPaydayEarly.some(({ tx, amount, rule, salaryEvidence }) => ids.has(rule.eventId)
        && native(tx) && afterPrevious(tx) && tx.date < futureEvent.date
        && salaryEvidence === true && !lateForPrevious(tx) && Math.abs(amount) >= scheduled / 2 - IDENTITY_AMOUNT_EPSILON);
    }
    for (const credit of unresolved ? [] : input.transactions || []) {
      if (!native(credit) || !afterPrevious(credit) || !(lunchMoneyDebitAmount(credit.amount) < 0)) continue;
      const mapping = mappingFor(input.accountMap, credit.providerAccountId);
      if (mapping?.atlasRole !== 'household-cash' || mapping.canonical?.id !== 'chequing-a') continue;
      for (const rule of group) {
        // A possible payroll receipt may still justify a hold. A near-amount-and-payday salary rule is never
        // matched by identity (only nearPaydaySalaryHits settles it), so this hold reads the rule's TENNIS INCOME
        // transfer shape directly: a transfer credit with its counterpart and salary source, below. One it did not
        // settle stays held (an early or off-amount pay).
        const holdIdentity = nearPaydayRule(rule)
          ? transactionIsTransfer(credit) && !!ruleCounterpartExternalId(rule)
          : matchesIdentityFields(credit, rule);
        if (!holdIdentity) continue;
        if (rule.eventId === 'payroll') {
          if (payrollLateOfEarlier(credit) && payrollLateAbsorbed === 0) { payrollLateAbsorbed += 1; break; }
          unresolved = true; break;
        }
        // A scheduled income other than payroll and the salary pair holds the plan only on a receipt the
        // provider explicitly states as posted (is_pending === false). An absent, null or non-boolean flag
        // is unknown posting evidence (the sanitizer reads it as not pending but marks it 'unknown'): it
        // never holds anything, so the held note's "already posted" is only said with that proof.
        if (otherIds.has(rule.eventId)) {
          if (credit.savingsPostingEvidence === 'posted' && !lateOfEarlier(credit)) unresolved = true;
          break;
        }
        // Reuse native transfer/amount/account predicates. Competing qualified
        // legs justify withholding; they never earn receipt or settlement.
        const debits = transferCounterpartMatches(credit, rule, input, credit.amount).filter(native);
        if (!debits.length) continue;
        const source = (input.transactions || []).find(tx => native(tx) && afterPrevious(tx)
          && tx.isIncome === true && lunchMoneyDebitAmount(tx.amount) < 0 && tx.date <= credit.date
          && amountsMatchExactly(tx.amount, credit.amount)
          && debits.some(debit => String(debit.providerAccountId) === String(tx.providerAccountId))
          && payeeMatchesRule(tx, { payeePatterns: rule.salaryReceiptPayeePatterns,
            payeeMatchMode: 'exact', payeeExcludePatterns: ['REFUND', 'REVERSAL', 'REIMBURSEMENT'] }));
        if (source) { unresolved = true; break; }
      }
      if (unresolved) break;
    }
    if (unresolved) for (const event of events.filter(event => event.date === futureDate
        && !(otherIds.has(event.id) && ambiguousKeys.has(String(event.id) + '@' + String(event.date))))) {
      issues.push({ id: event.id, date: event.date, reason: 'posted-income-occurrence-unresolved' });
    }
  }
  return { asOf, status: issues.length ? 'unavailable' : 'ready', issues };
}

function sanitizedEvidenceFingerprint(providerTransactionId) {
  if (providerTransactionId == null || providerTransactionId === '') return null;
  return crypto.createHash('sha256')
    .update('atlas-evidence:lunchmoney:tx:' + String(providerTransactionId))
    .digest('hex');
}

function emptyReconciliationCounts() {
  return {
    coveredModeledOccurrences: 0,
    represented: 0,
    upcoming: 0,
    unverified: 0,
    ambiguous: 0,
    outsideCoverage: 0,
    unmatchedCashEvidence: 0,
  };
}

function allowedPostingDatesFor(scheduledDate, rule) {
  const scheduled = parseIsoDate(scheduledDate);
  if (!scheduled) return [];
  const dates = [scheduled];
  if (rule && rule.postingDateRule === WEEKEND_NEXT_BUSINESS_DAY) {
    const weekday = new Date(`${scheduled}T00:00:00Z`).getUTCDay();
    if (weekday === 6) dates.push(Forecast.addDays(scheduled, 2));
    if (weekday === 0) dates.push(Forecast.addDays(scheduled, 1));
  }
  if (rule && rule.postingDateRule === COVER_EARLY_OR_DUE_ON_OR_BEFORE_POSTING) {
    const lookahead = ruleEarlyPayLookaheadDays(rule);
    for (let i = 1; i <= lookahead; i += 1) {
      dates.push(Forecast.addDays(scheduled, -i));
    }
  }
  return dates.filter((date, index) => date && dates.indexOf(date) === index);
}

function identityRulesForEvent(identity, eventId) {
  return ((identity && identity.rules) || []).filter(rule =>
    rule && rule.eventId === eventId);
}

function occurrenceDebtId(plan, id) {
  const row = [].concat((plan && plan.obligations) || [], (plan && plan.bills) || [])
    .find(item => item && item.id === id);
  return row && row.debtId ? row.debtId : null;
}

function earliestEligiblePostingDate(occurrence, identity, plan) {
  if (!occurrence || !occurrence.date) return null;
  const dates = [occurrence.date];
  for (const rule of identityRulesForEvent(identity, occurrence.id)) {
    for (const postingDate of allowedPostingDatesFor(occurrence.date, rule)) {
      if (postingDate) dates.push(postingDate);
    }
    if (rule && rule.postingDateRule === COVER_STATEMENT_CYCLE_OR_LATEST_DUE) {
      const closeDay = statementCloseDayForEvent(plan, {
        id: occurrence.id,
        date: occurrence.date,
        debtId: occurrence.debtId || occurrenceDebtId(plan, occurrence.id),
      });
      const closeDate = closeDay != null
        ? statementCloseDateForDue(occurrence.date, closeDay) : null;
      if (closeDate) dates.push(closeDate);
    }
  }
  dates.sort();
  return dates[0] || null;
}

function carriedOnceJointCashOccurrences(plan, asOf) {
  const out = [];
  if (!plan || !asOf) return out;
  const seen = new Set();
  for (const item of [].concat(plan.obligations || [], plan.bills || [])) {
    if (!item || !item.id || !item.date) continue;
    if (!Forecast.carriedOnceJointCashOutflow(plan, item.id, item.date, asOf)) continue;
    const key = String(item.id) + '@' + String(item.date);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: item.id, date: item.date });
  }
  return out;
}

// Ordinary current-state posted history stays 14 days. Extend the same
// GET /transactions start, capped at the incumbent 120-day reconcile
// horizon, only far enough to cover either of:
// - an unresolved once joint-cash occurrence whose permitted posting date
//   is older than that window (settlement lookup, not a second observer);
// - the previous Seaspan payday-to-payday start, so Road Ahead can see
//   one completed cycle plus the current cycle. Not a historical store.
function cycleSettlementOccurrences(plan, asOf, identity) {
  const out = carriedOnceJointCashOccurrences(plan, asOf);
  const seen = new Set(out.map(row => String(row.id) + '@' + String(row.date)));
  const cycleIds = new Set(((identity && identity.rules) || [])
    .filter(rule => rule && rule.postingDateRule === COVER_STATEMENT_CYCLE_OR_LATEST_DUE
      && rule.eventId)
    .map(rule => rule.eventId));
  if (!cycleIds.size || !asOf) return out;
  const until = Forecast.addDays(asOf, COVER_DUE_LOOKBACK_DAYS);
  if (!until) return out;
  for (const event of scheduledEventsOnRange(plan, asOf, until)) {
    if (!event || !cycleIds.has(event.id) || event.date < asOf) continue;
    const key = String(event.id) + '@' + String(event.date);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: event.id,
      date: event.date,
      debtId: event.debtId || occurrenceDebtId(plan, event.id),
    });
  }
  return out;
}

function previousSeaspanCycleStart(plan, asOf) {
  if (!plan || !asOf || typeof Forecast.spendingCycle !== 'function') return null;
  const current = Forecast.spendingCycle(plan, asOf);
  if (!current || !current.start) return null;
  const priorDay = Forecast.addDays(current.start, -1);
  if (!priorDay) return null;
  const prior = Forecast.spendingCycle(plan, priorDay);
  if (!prior || !prior.start || prior.start >= current.start) return null;
  return prior.start;
}

function postedHistoryDaysForCarriedSettlement(opts) {
  const now = opts && opts.now;
  const ordinary = CURRENT_STATE_HISTORY_DAYS;
  const asOf = dateOnly(now);
  if (!asOf) return ordinary;
  const plan = Object.assign({}, (opts && opts.plan) || {}, {
    debts: (opts && opts.debts) || (opts && opts.plan && opts.plan.debts) || [],
  });
  const ordinaryStart = lunchMoneyTransactionsUrl(now, ordinary).startDate;
  if (!ordinaryStart) return ordinary;
  let earliest = null;
  for (const occurrence of cycleSettlementOccurrences(plan, asOf, opts && opts.identity)) {
    const postingDate = earliestEligiblePostingDate(occurrence, opts && opts.identity, plan);
    if (!postingDate || postingDate >= ordinaryStart) continue;
    if (!earliest || postingDate < earliest) earliest = postingDate;
  }
  const priorCycleStart = previousSeaspanCycleStart(plan, asOf);
  if (priorCycleStart && priorCycleStart < ordinaryStart) {
    if (!earliest || priorCycleStart < earliest) earliest = priorCycleStart;
  }
  const coverageOpening = plan.cardPurchaseCoverage && plan.cardPurchaseCoverage.opening;
  if (coverageOpening && coverageOpening.confirmed === true && parseIsoDate(coverageOpening.asOf)
    && coverageOpening.asOf < ordinaryStart && (!earliest || coverageOpening.asOf < earliest)) {
    earliest = coverageOpening.asOf;
  }
  if (!earliest) return ordinary;
  let span = calendarDaysBetween(earliest, asOf);
  if (span == null || span < ordinary) span = ordinary;
  let start = lunchMoneyTransactionsUrl(now, span).startDate;
  while (start && start > earliest && span < RECONCILE_HISTORY_DAYS) {
    span += 1;
    start = lunchMoneyTransactionsUrl(now, span).startDate;
  }
  if (span < ordinary) return ordinary;
  if (span > RECONCILE_HISTORY_DAYS) return RECONCILE_HISTORY_DAYS;
  return span;
}

function occurrenceInsideObservationWindow(scheduledDate, window, rules) {
  const start = window && window.startDate;
  const end = window && window.endDate;
  if (!start || !end || !scheduledDate) return false;
  const applicable = (rules && rules.length) ? rules : [{}];
  for (const rule of applicable) {
    for (const postingDate of allowedPostingDatesFor(scheduledDate, rule)) {
      if (postingDate >= start && postingDate <= end) return true;
    }
  }
  return false;
}

function ambiguousGroupFor(id, date, groups) {
  for (const group of groups || []) {
    if (group.reason === 'multiple-compatible-candidates'
      && group.id === id && group.date === date) return group;
    if (group.reason === 'transaction-consumed-twice'
      && (group.hits || []).some(hit => hit && hit.id === id && hit.date === date)) {
      return group;
    }
  }
  return null;
}

function unmatchedHouseholdCash(report, opts, consumedTxIds) {
  const collapsed = (report && report.collapsedTransactions)
    || (report && report.transactions)
    || [];
  const mapDoc = opts.accountMap;
  const plan = opts.data && opts.data.plan;
  const window = (report && report.transactionWindow) || {};
  const start = window.startDate || null;
  const end = window.endDate || null;
  const unmatched = [];
  for (const tx of collapsed) {
    if (!tx || !tx.date || tx.pending === true || tx.contradictoryEvidence === true) continue;
    if (consumedTxIds.has(String(tx.providerTransactionId))) continue;
    if (start && tx.date < start) continue;
    if (end && tx.date > end) continue;
    const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
    if (atlasAccountRole(mapping) !== 'household-cash') continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    if (amount == null || amount === 0) continue;
    const kindHint = kindHintFromTransaction(tx);
    // Forecast is the classification authority. Stamp the CAN TIRE MC
    // card-payment identity here the same way the sanitized overlay does,
    // because this path does not pass merchant text into the classifier.
    const flags = Forecast.classifyCurrentPeriodTransaction.derivedFlags({
      payee: tx.payee,
      original_name: tx.originalName,
      originalName: tx.originalName,
      displayedPayee: tx.payee,
      originalMerchant: tx.originalName || tx.payee,
      notes: tx.notes,
      note: tx.notes || tx.note,
      tags: tx.tags,
      tag: tx.tag || tx.tags,
      kindHint,
      kind: tx.kind,
      mcc: tx.mcc,
      categoryLabel: tx.categoryLabel,
      categoryId: tx.categoryId,
      recurringId: tx.recurringId,
    }, plan);
    const cls = Forecast.classifyCurrentPeriodTransaction({
      date: tx.date,
      amount,
      pending: false,
      categoryLabel: tx.categoryLabel || null,
      isIncome: tx.isIncome === true,
      excludeFromTotals: tx.excludeFromTotals === true,
      excludeFromBudget: tx.excludeFromBudget === true,
      accountRole: 'household-cash',
      kindHint,
      cardPaymentIdentity: flags.cardPaymentIdentity,
      cardFinanceChargeIdentity: flags.cardFinanceChargeIdentity,
    }, plan);
    if (cls.kind === 'transfer' || cls.kind === 'internal-movement' || cls.kind === 'card-payment'
      || cls.kind === 'business' || cls.kind === 'external'
      || cls.kind === 'interest') continue;
    if (cls.kind === 'income') continue;
    unmatched.push({
      date: tx.date,
      amount: Math.round(amount * 100) / 100,
      accountRole: 'household-cash',
      kind: cls.kind || 'unclassified',
      evidenceFingerprint: sanitizedEvidenceFingerprint(tx.providerTransactionId),
    });
  }
  unmatched.sort((a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.evidenceFingerprint).localeCompare(String(b.evidenceFingerprint)));
  return unmatched;
}

function reconciliationReceiptLooksSanitized(receipt) {
  const blob = JSON.stringify(receipt == null ? {} : receipt);
  return identityProofLooksSanitized(receipt)
    && !/"payee"\s*:/.test(blob)
    && !/"original_name"\s*:/.test(blob)
    && !/"observationId"\s*:/.test(blob)
    && !/"status"\s*:\s*"(MATCH|CHANGE|CONFLICT|MISSING|STALE)"/.test(blob)
    && !/"recommend"\s*:/.test(blob)
    && !/"safeToSpend"\s*:/.test(blob)
    && !/"paydayAllocation"\s*:/.test(blob)
    && !/"weeklyCap"\s*:/.test(blob)
    && !/"spendPermission"\s*:/.test(blob);
}

function emptyObligationReconciliationReceipt(parts) {
  return {
    schema: RECONCILIATION_RECEIPT_SCHEMA,
    observationSchema: RECEIPT_SCHEMA,
    observationFingerprintDigest: parts.observationFingerprintDigest || null,
    observedAt: parts.observedAt || null,
    householdDate: parts.householdDate || null,
    asOf: parts.asOf || parts.householdDate || null,
    writesCanonicalState: false,
    canonicalStateChanged: false,
    forecastPlannerInvoked: false,
    trusted: false,
    observationReadyForReconciliation: parts.observationReadyForReconciliation === true,
    failClosedKind: parts.failClosedKind || null,
    failClosedReasons: parts.failClosedReasons || [],
    counts: emptyReconciliationCounts(),
    oneOccurrenceOneTransaction: true,
    noTransactionConsumedTwice: true,
    occurrences: [],
    unmatchedCashEvidence: [],
  };
}

function reconciliationReceipt(report, opts) {
  opts = opts || {};
  const observation = report && report.observationReceipt;
  const householdDate = (observation && observation.householdDate)
    || dateOnly(report && report.fetchedAt);
  const baseParts = {
    observationFingerprintDigest: observation && observation.fingerprintDigest || null,
    observedAt: (observation && observation.observedAt) || (report && report.fetchedAt) || null,
    householdDate,
    asOf: householdDate,
    observationReadyForReconciliation: !!(observation && observation.readyForReconciliation === true),
  };
  if (!observation || observation.readyForReconciliation !== true) {
    return emptyObligationReconciliationReceipt(Object.assign({}, baseParts, {
      failClosedKind: 'observation-not-ready',
      failClosedReasons: (observation && observation.failClosedReasons && observation.failClosedReasons.length)
        ? observation.failClosedReasons.slice()
        : ['observation-receipt-missing'],
    }));
  }

  const data = opts.data;
  const plan = Object.assign({}, (data && data.plan) || {}, {
    debts: (data && data.debts) || [],
  });
  const identityRules = stampRuleSetClaims(opts.identityRules
    || ((opts.identity && opts.identity.rules) || []));
  const mapDoc = opts.accountMap;
  const collapsed = (report && report.collapsedTransactions)
    || (report && report.transactions)
    || [];
  const scheduleTrustAsOf = householdFinancialDate(opts, report && report.observations);
  const groups = representedEventHitGroups({
    transactions: collapsed,
    accountMap: mapDoc,
    plan,
    identityRules,
    transactionWindow: report && report.transactionWindow,
    asOf: scheduleTrustAsOf,
  });
  const uniqueByKey = new Map();
  for (const candidate of groups.unique) {
    if (!candidate || !candidate.id || !candidate.date) continue;
    uniqueByKey.set(candidate.id + '@' + candidate.date, candidate);
  }
  const representedActuals = [];
  for (const candidate of groups.unique) {
    const amt = Number(candidate.observedAmount);
    if (!candidate.id || !candidate.date || !isFinite(amt)) continue;
    representedActuals.push({
      id: candidate.id,
      date: candidate.date,
      actual: Math.round(amt * 100) / 100,
      postedOn: candidate.postingDate || candidate.date,
    });
  }
  const paydayOrigin = Forecast.paydayPeriodOrigin(plan, householdDate);
  const states = Forecast.currentPeriodObligationStates(plan, householdDate, {
    periodOrigin: paydayOrigin,
    preservePaydayPeriodOrigin: true,
    representedEvents: groups.unique.map(c => ({ id: c.id, date: c.date })),
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      representedActuals,
      transactions: [],
    },
  });
  const rulesByEvent = new Map();
  for (const rule of identityRules) {
    if (!rule || !rule.eventId) continue;
    const list = rulesByEvent.get(rule.eventId) || [];
    list.push(rule);
    rulesByEvent.set(rule.eventId, list);
  }
  const window = (report && report.transactionWindow) || {};
  const occurrences = [];
  const usedEvidence = new Set();
  let oneOccurrenceOneTransaction = true;
  let noTransactionConsumedTwice = groups.ambiguous
    .every(group => group.reason !== 'transaction-consumed-twice');
  for (const bill of states.bills || []) {
    if (!bill || !bill.id || !bill.date) continue;
    const key = bill.id + '@' + bill.date;
    const ambiguous = ambiguousGroupFor(bill.id, bill.date, groups.ambiguous);
    const candidate = uniqueByKey.get(key);
    let settlement = bill.settlement;
    let evidenceFingerprint = null;
    let evidenceFingerprints = null;
    let postingDateRelationValue = null;
    let atlasAccountId = null;
    let observedAmount = bill.actual;
    let candidateCount = 0;
    if (ambiguous) {
      settlement = 'ambiguous';
      candidateCount = (ambiguous.hits || []).length;
      evidenceFingerprints = (ambiguous.hits || [])
        .map(hit => sanitizedEvidenceFingerprint(hit && hit.providerTransactionId))
        .filter(Boolean)
        .sort();
      observedAmount = null;
    } else if (candidate) {
      settlement = 'represented';
      const fingerprints = candidateTransactionIds(candidate)
        .map(id => sanitizedEvidenceFingerprint(id))
        .filter(Boolean)
        .sort();
      evidenceFingerprint = fingerprints[0] || null;
      if (fingerprints.length > 1) evidenceFingerprints = fingerprints;
      postingDateRelationValue = candidate.postingDateRelation || null;
      atlasAccountId = candidate.atlasAccountId || null;
      const amt = Number(candidate.observedAmount);
      observedAmount = isFinite(amt) ? Math.round(amt * 100) / 100 : null;
      for (const fingerprint of fingerprints) {
        if (usedEvidence.has(fingerprint)) {
          oneOccurrenceOneTransaction = false;
          noTransactionConsumedTwice = false;
        }
        usedEvidence.add(fingerprint);
      }
    } else if (bill.settlement === 'upcoming') {
      settlement = 'upcoming';
      observedAmount = 0;
    } else if (!occurrenceInsideObservationWindow(bill.date, window, rulesByEvent.get(bill.id))) {
      settlement = 'outside-coverage';
      observedAmount = null;
    } else {
      settlement = 'unverified';
      observedAmount = null;
    }
    const row = {
      id: bill.id,
      date: bill.date,
      kind: bill.kind || null,
      settlement,
      plannedAmount: bill.planned,
      observedAmount,
    };
    if (evidenceFingerprint) row.evidenceFingerprint = evidenceFingerprint;
    if (evidenceFingerprints && evidenceFingerprints.length) {
      row.evidenceFingerprints = evidenceFingerprints;
    }
    if (candidateCount) row.candidateCount = candidateCount;
    if (postingDateRelationValue) row.postingDateRelation = postingDateRelationValue;
    if (atlasAccountId) row.atlasAccountId = atlasAccountId;
    occurrences.push(row);
  }
  const listedKeys = new Set(occurrences.map(row => row.id + '@' + row.date));
  const periodStart = states.periodStart;
  const periodEnd = states.periodEnd;
  const inPaydayPeriod = (date) => date && periodStart && periodEnd
    && date >= periodStart && date <= periodEnd;
  for (const candidate of groups.unique) {
    if (!candidate || !candidate.id || !candidate.date) continue;
    if (!inPaydayPeriod(candidate.date)) continue;
    const key = candidate.id + '@' + candidate.date;
    if (listedKeys.has(key)) continue;
    const scheduled = scheduledOccurrence(plan, candidate.id, candidate.date);
    if (scheduled.length !== 1) continue;
    const kind = scheduled[0].kind;
    if (kind !== 'obligation' && kind !== 'bill' && kind !== 'commitment') continue;
    const planned = isFinite(-scheduled[0].amount)
      ? Math.round((-scheduled[0].amount) * 100) / 100 : null;
    const fingerprints = candidateTransactionIds(candidate)
      .map(id => sanitizedEvidenceFingerprint(id))
      .filter(Boolean)
      .sort();
    const amt = Number(candidate.observedAmount);
    const row = {
      id: candidate.id,
      date: candidate.date,
      kind: (scheduled[0] && scheduled[0].kind) || null,
      settlement: 'represented',
      plannedAmount: planned,
      observedAmount: isFinite(amt) ? Math.round(amt * 100) / 100 : null,
    };
    if (fingerprints[0]) row.evidenceFingerprint = fingerprints[0];
    if (fingerprints.length > 1) row.evidenceFingerprints = fingerprints;
    for (const fingerprint of fingerprints) {
      if (usedEvidence.has(fingerprint)) {
        oneOccurrenceOneTransaction = false;
        noTransactionConsumedTwice = false;
      }
      usedEvidence.add(fingerprint);
    }
    if (candidate.postingDateRelation) row.postingDateRelation = candidate.postingDateRelation;
    if (candidate.atlasAccountId) row.atlasAccountId = candidate.atlasAccountId;
    occurrences.push(row);
    listedKeys.add(key);
  }
  for (const group of groups.ambiguous || []) {
    const hits = group && group.hits || [];
    const targets = group && group.reason === 'transaction-consumed-twice'
      ? hits
      : (group && group.id && group.date ? [{ id: group.id, date: group.date, hits }] : []);
    for (const target of targets) {
      if (!target || !target.id || !target.date || !inPaydayPeriod(target.date)) continue;
      const key = target.id + '@' + target.date;
      if (listedKeys.has(key)) continue;
      const scheduled = scheduledOccurrence(plan, target.id, target.date);
      if (scheduled.length !== 1) continue;
      const kind = scheduled[0].kind;
      if (kind !== 'obligation' && kind !== 'bill' && kind !== 'commitment') continue;
      const planned = isFinite(-scheduled[0].amount)
        ? Math.round((-scheduled[0].amount) * 100) / 100 : null;
      const groupHits = target.hits || hits;
      occurrences.push({
        id: target.id,
        date: target.date,
        kind: (scheduled[0] && scheduled[0].kind) || null,
        settlement: 'ambiguous',
        plannedAmount: planned,
        observedAmount: null,
        candidateCount: groupHits.length,
        evidenceFingerprints: groupHits
          .map(hit => sanitizedEvidenceFingerprint(hit && hit.providerTransactionId))
          .filter(Boolean)
          .sort(),
      });
      listedKeys.add(key);
    }
  }
  occurrences.sort((a, b) => String(a.date).localeCompare(String(b.date))
    || String(a.id).localeCompare(String(b.id)));
  const consumedTxIds = new Set();
  for (const candidate of groups.unique) {
    if (!candidate || candidate.providerTransactionId == null) continue;
    const key = candidate.id + '@' + candidate.date;
    const listed = listedKeys.has(key);
    if (inPaydayPeriod(candidate.date) && !listed) {
      const scheduled = scheduledOccurrence(plan, candidate.id, candidate.date);
      const kind = scheduled[0] && scheduled[0].kind;
      if (kind === 'obligation' || kind === 'bill' || kind === 'commitment') continue;
    }
    consumedTxIds.add(String(candidate.providerTransactionId));
  }
  const unmatched = unmatchedHouseholdCash(report, opts, consumedTxIds);
  const counts = emptyReconciliationCounts();
  counts.coveredModeledOccurrences = occurrences.length;
  for (const row of occurrences) {
    if (row.settlement === 'represented') counts.represented += 1;
    else if (row.settlement === 'upcoming') counts.upcoming += 1;
    else if (row.settlement === 'unverified') counts.unverified += 1;
    else if (row.settlement === 'ambiguous') counts.ambiguous += 1;
    else if (row.settlement === 'outside-coverage') counts.outsideCoverage += 1;
  }
  counts.unmatchedCashEvidence = unmatched.length;
  return {
    schema: RECONCILIATION_RECEIPT_SCHEMA,
    observationSchema: RECEIPT_SCHEMA,
    observationFingerprintDigest: baseParts.observationFingerprintDigest,
    observedAt: baseParts.observedAt,
    householdDate,
    asOf: householdDate,
    writesCanonicalState: false,
    canonicalStateChanged: false,
    forecastPlannerInvoked: false,
    trusted: true,
    observationReadyForReconciliation: true,
    failClosedKind: null,
    failClosedReasons: [],
    counts,
    oneOccurrenceOneTransaction,
    noTransactionConsumedTwice,
    occurrences,
    unmatchedCashEvidence: unmatched,
  };
}

// N1: a household-cash balance is dated only by a semantic balance date: the legacy
// balance_as_of, else the v2 balance_last_update. The object update time and the
// request time are never a balance date. No (or an invalid) semantic date means the
// date is unknown and the evidence fails closed; it is not repaired from fetch time.
function cashBalanceEvidenceInstant(account) {
  if (!account || typeof account !== 'object') return null;
  if (account.balanceAsOf) return account.balanceAsOf;
  if (Object.prototype.hasOwnProperty.call(account, 'balanceLastUpdate')) {
    return postedBalanceEvidenceInstant({ balanceLastUpdate: account.balanceLastUpdate });
  }
  return null;
}

function observationsFromMappedAccount(account, mapping, fetchedAt) {
  const isCredit = CREDIT_ROLES.has(mapping.atlasRole);
  const isCash = CASH_ROLES.has(mapping.atlasRole);
  const isLoan = mapping.atlasRole === 'heloc' || mapping.atlasRole === 'mortgage';
  const usesPostedDate = isCredit || isCash;
  const dated = isCredit
    ? postedBalanceEvidenceInstant(account)
    : isCash ? cashBalanceEvidenceInstant(account) : genericAccountEvidenceInstant(account);
  // Every posted-credit and posted-cash fact shares the semantic-date boundary. A
  // request timestamp cannot repair missing/invalid balance evidence. Savings uses
  // the same helper directly. Mortgage/HELOC keep their incumbent generic dating,
  // but never borrow the request time: an undated or future-dated loan balance
  // is unknown, not current.
  const observedAt = usesPostedDate || isLoan ? dated : dated || fetchedAt;
  const evidenceDate = dateOnly(observedAt);
  const requestDay = dateOnly(fetchedAt);
  const unqualifiedPostedDate = (usesPostedDate || isLoan)
    && (!evidenceDate || !requestDay || evidenceDate > requestDay);
  const base = {
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    accountLabel: account.displayName,
    observedAsOf: evidenceDate,
    evidenceDate,
    ...(unqualifiedPostedDate ? { unknown: true } : {}),
    ...(unqualifiedPostedDate && (isCash || isLoan)
      ? { unknownReason: evidenceDate ? 'balance-date-after-request' : 'no-semantic-balance-date' } : {}),
    canonical: mapping.canonical,
    source: 'provider-observe:lunchmoney',
  };
  const out = [];
  if (CASH_ROLES.has(mapping.atlasRole) && account.balance != null) {
    out.push({
      ...base,
      observationId: `lm-${account.providerAccountId}-cash`,
      evidenceValue: account.balance,
    });
  }
  if ((mapping.atlasRole === 'heloc' || mapping.atlasRole === 'mortgage')
    && account.balance != null) {
    out.push({
      ...base,
      observationId: `lm-${account.providerAccountId}-debt`,
      evidenceValue: account.balance,
      note: mapping.atlasRole === 'heloc'
        ? 'HELOC balance is not spendable household cash.'
        : 'Mortgage balance is not spendable household cash.',
    });
  }
  if (CREDIT_ROLES.has(mapping.atlasRole) && account.balance != null) {
    out.push({
      ...base,
      observationId: `lm-${account.providerAccountId}-debt`,
      fact: 'posted-balance',
      cardId: mapping.canonical && mapping.canonical.id,
      evidenceValue: account.balance,
    });
  }
  if (CREDIT_ROLES.has(mapping.atlasRole) && account.available != null) {
    out.push({
      ...base,
      observationId: `lm-${account.providerAccountId}-available`,
      fact: 'available-credit',
      cardId: mapping.canonical && mapping.canonical.id,
      evidenceValue: account.available,
      note: 'Available credit is never household cash.',
    });
  }
  if (CREDIT_ROLES.has(mapping.atlasRole) && account.limit != null) {
    out.push({
      ...base,
      observationId: `lm-${account.providerAccountId}-limit`,
      fact: 'limit',
      cardId: mapping.canonical && mapping.canonical.id,
      evidenceValue: account.limit,
      note: 'Credit limit is never household cash.',
    });
  }
  return out;
}

function spendableCashFromObservations(observations, data) {
  let cash = 0;
  for (const obs of observations) {
    if (obs.fact === 'available-credit' || obs.fact === 'limit') continue;
    if (Forecast.savingsEarmarksState(data && data.plan, '9999-12-31').status !== 'setup-unknown'
        && !['chequing-a', 'chequing-b'].includes(obs.canonical && obs.canonical.id)) continue;
    if (obs.canonical && obs.canonical.collection === 'cash' && obs.evidenceValue != null) {
      cash += Number(obs.evidenceValue);
    }
  }
  return Math.round(cash * 100) / 100;
}

// Sanitized account observations only. No transaction history, allocation,
// target, inferred purpose or financial calculation enters this packet.
function savingsPoolObservations(data, normalized, accountMap) {
  if (!data || !data.plan || Forecast.savingsEarmarksState(data.plan, '9999-12-31').status === 'setup-unknown') return null;
  const asOf = dateOnly(normalized.fetchedAt);
  const config = Forecast.savingsEarmarksState(data.plan, asOf);
  if (config.status !== 'ready') return { asOf, accounts: [] };
  const ids = new Set(['savings', ...config.pools.map(pool => pool.accountId)]);
  const accounts = [];
  for (const accountId of ids) {
    const maps = (accountMap.mappings || []).filter(m => m && m.canonical
      && m.canonical.collection === 'cash' && m.canonical.id === accountId);
    if (maps.length !== 1) continue;
    const mapping = maps[0];
    if (mapping.atlasRole !== 'household-reserve' && !(accountId === 'savings' && mapping.atlasRole === 'household-cash')) continue;
    if ((accountMap.mappings || []).filter(m => m && String(m.providerAccountId) === String(mapping.providerAccountId)).length !== 1) continue;
    const matches = normalized.accounts.filter(a => a.providerAccountId === String(mapping.providerAccountId));
    if (matches.length !== 1) continue;
    const account = matches[0];
    if (!['cash', 'depository'].includes(String(account.type || '').toLowerCase())) continue;
    if ((data.debts || []).some(debt => debt && debt.id === accountId)) continue;
    const pending = normalized.transactions.some(tx => tx && tx.providerAccountId === account.providerAccountId && tx.pending === true);
    const postingUnknown = normalized.transactions.some(tx => tx && tx.providerAccountId === account.providerAccountId
      && !['posted', 'pending'].includes(tx.savingsPostingEvidence));
    accounts.push({ accountId, value: account.balance, currency: String(account.currency || '').toUpperCase(),
      evidenceDate: dateOnly(postedBalanceEvidenceInstant(account)),
      pendingState: pending ? 'pending' : postingUnknown ? 'unknown' : pendingCoverageIsComplete(normalized.pendingCoverage) ? 'clear' : 'unknown',
      source: 'provider-observe:lunchmoney' });
  }
  return { asOf, accounts };
}

function observe(input) {
  return observeCore(input, null);
}

// The incumbent observation execution. When `capture` is an object, the
// sanitizer pass inside this execution additionally records its same-pass
// crosswalk provenance into it (see acquireSettlementCrosswalk); with a
// null capture the execution — and every output — is exactly the shipped
// behaviour.
function observeCore(input, capture) {
  const provider = input.provider;
  if (provider !== 'lunchmoney') fail(`Unsupported provider: ${provider || '(missing)'}.`);
  const fetchedAt = input.fetchedAt || new Date().toISOString();
  const normalized = normalizeLunchMoneyPayload(input.payload, fetchedAt,
    { savingsLinks: input.accountMap?.savingsLinks?.links?.length > 0 });
  const mapDoc = input.accountMap;
  if (!mapDoc || mapDoc.provider !== 'lunchmoney') fail('Account map is missing or is not a lunchmoney map.');
  // S2: reviewed recurring-item timing applies BEFORE any occurrence matching,
  // so payment evidence and Forecast read the same occurrence dates (Codex P1,
  // #1281). Only day and dateConfidence of a mapper-supplied bill change, on
  // this observation's working copy of the plan; data.json is never written.
  // Cadence too (#1289), and only with the item's own expected amount.
  const recurringReview = recurringBillScheduleReview(
    sanitizedRecurringEvidence(input.payload && input.payload.recurringItems,
      { identityRules: input.identityRules || (input.identity && input.identity.rules) || [],
        accountMap: mapDoc, existingLocalId: () => null }),
    input.identityRules || (input.identity && input.identity.rules) || [],
    input.data && input.data.plan, dateOnly(normalized.fetchedAt),
    { amounts: recurringItemAmounts(input.payload && input.payload.recurringItems) });
  const recurringSchedules = recurringReview.schedules;
  const obligationSchedules = recurringSchedules.filter(schedule => schedule.obligationId);
  if (obligationSchedules.length && input.data && input.data.plan && Array.isArray(input.data.plan.obligations)) {
    const byId = new Map(obligationSchedules.map(schedule => [schedule.obligationId, schedule]));
    input = { ...input, data: { ...input.data, plan: { ...input.data.plan, obligations: input.data.plan.obligations.map(row =>
      row && byId.has(row.id) ? applyRecurringObligationSchedule(row, byId.get(row.id)) : row) } } };
  }
  if (recurringSchedules.some(schedule => schedule.billId) && input.data && input.data.plan && Array.isArray(input.data.plan.bills)) {
    const byBill = new Map(recurringSchedules.filter(schedule => schedule.billId).map(schedule => [schedule.billId, schedule]));
    input = { ...input, data: { ...input.data, plan: { ...input.data.plan, bills: input.data.plan.bills.map(bill =>
      bill && byBill.has(bill.id) ? applyRecurringSchedule(bill, byBill.get(bill.id)) : bill) } } };
  }
  const mapped = [];
  const unmapped = [];
  const observations = [];
  const postedByCard = new Map();
  const limitByCard = new Map();
  for (const account of normalized.accounts) {
    const mapping = mappingFor(mapDoc, account.providerAccountId);
    if (mapping && mapping.atlasRole === EXTERNAL_LIVE_ROLE) {
      mapped.push({
        providerAccountId: account.providerAccountId,
        displayName: account.displayName,
        atlasId: null,
        collection: null,
        atlasRole: EXTERNAL_LIVE_ROLE,
      });
      continue;
    }
    if (!mapping || !mapping.canonical || !mapping.canonical.id) {
      unmapped.push({
        providerAccountId: account.providerAccountId,
        displayName: account.displayName,
        reason: 'unmapped-provider-account',
      });
      continue;
    }
    mapped.push({
      providerAccountId: account.providerAccountId,
      displayName: account.displayName,
      ledgerName: account.ledgerName || null,
      atlasId: mapping.canonical.id,
      collection: mapping.canonical.collection,
      atlasRole: mapping.atlasRole,
    });
    const accountObs = observationsFromMappedAccount(account, mapping, normalized.fetchedAt);
    observations.push(...accountObs);
    if (CREDIT_ROLES.has(mapping.atlasRole)) {
      // A posted balance the observer marked unknown (dated after the request
      // day, or with no usable balance date) is not posted evidence for the
      // diagnostic inference either: the card keeps its entry, unknown.
      const posted = accountObs.find(o => o.fact === 'posted-balance');
      if (account.balance != null) postedByCard.set(mapping.canonical.id, posted && posted.unknown ? null : account.balance);
      if (account.limit != null) limitByCard.set(mapping.canonical.id, account.limit);
    }
  }
  // Unusable pending rows are counted from the normalized rows, before any
  // collapse: a pending copy that a posted twin or a settlement mate would
  // otherwise replace still keeps the card's pending exposure unknown.
  const preCollapseTransactions = normalized.transactions;
  const collapsed = collapseByProviderTransactionId(normalized.transactions);
  const identityRules = stampRuleSetClaims(input.identityRules
    || ((input.identity && input.identity.rules) || []));
  stampIdentityDescriptors(preCollapseTransactions, identityRules);
  stampIdentityDescriptors(collapsed.transactions, identityRules);
  const billPaymentPayees = input.billPaymentPayees
    || ((input.identity && input.identity.billPaymentPayees) || []);
  const settlementOpts = {
    plan: input.data && input.data.plan,
    billPaymentPayees,
    accountMap: mapDoc,
  };
  const settlementCollapsed = collapsePendingPostedBySettlementIdentity(
    collapsed.transactions,
    dateOnly(normalized.fetchedAt),
    settlementOpts
  );
  if (settlementCollapsed !== collapsed.transactions) {
    const kept = new Set(settlementCollapsed);
    for (const tx of collapsed.transactions) {
      if (!tx || tx.pending !== true || kept.has(tx)) continue;
      collapsed.identityEvidence.push({
        transition: 'pending-to-posted',
        pendingCount: 1,
        postedCount: 1,
        ghostPending: false,
        doubleCounted: false,
        linkage: 'plaid-directed',
      });
    }
  }
  collapsed.transactions = settlementCollapsed;
  const pendingObs = pendingObservationsFromTransactions({
    transactions: collapsed.transactions,
    unusablePendingSource: preCollapseTransactions,
    accountMap: mapDoc,
    asOf: dateOnly(normalized.fetchedAt),
    fetchedAt: normalized.fetchedAt,
    plan: input.data && input.data.plan,
    billPaymentPayees,
    pendingCoverage: normalized.pendingCoverage,
  });
  observations.push(...pendingObs);
  const cardInferences = [];
  for (const obs of pendingObs) {
    const inference = inferredCardState(
      postedByCard.has(obs.cardId) ? postedByCard.get(obs.cardId) : null,
      obs.unknown ? null : obs.evidenceValue,
      limitByCard.has(obs.cardId) ? limitByCard.get(obs.cardId) : null
    );
    cardInferences.push(Object.assign({ cardId: obs.cardId }, inference));
  }
  for (const [cardId, posted] of postedByCard) {
    if (cardInferences.some(c => c.cardId === cardId)) continue;
    if (!limitByCard.has(cardId)) continue;
    cardInferences.push(Object.assign({ cardId }, inferredCardState(posted, null, limitByCard.get(cardId))));
  }
  const openingAsOf = openingAsOfFromData(input.data);
  const planForIdentity = Object.assign({}, (input.data && input.data.plan) || {}, {
    debts: (input.data && input.data.debts) || [],
  });
  stampLunchMoneyMatched(collapsed.transactions, identityRules, planForIdentity, mapDoc,
    input.payload && input.payload.recurringItems, normalized.transactionWindow);
  stampPendingReplacementHits(normalized.transactions, collapsed.transactions, {
    accountMap: mapDoc,
    plan: planForIdentity,
    identityRules,
    transactions: normalized.transactions,
  });
  const scheduleTrustAsOf = householdFinancialDate(input, observations);
  // Observation has no selected current salary identity. Derive a diagnostic
  // target only if the incumbent native schedule provides one occurrence for
  // the slot in complete, current household-dated coverage. A broad history
  // containing several cycles cannot choose a latest one on the user's behalf.
  const salaryWindow = normalized.transactionWindow;
  const salaryCoverage = salaryWindow.complete === true && parseIsoDate(salaryWindow.startDate)
    && parseIsoDate(salaryWindow.endDate) && salaryWindow.startDate <= salaryWindow.endDate
    && parseIsoDate(scheduleTrustAsOf) && salaryWindow.endDate === scheduleTrustAsOf;
  const salaryDiagnostic = input.salaryDiagnostic === false ? null : SalaryDiagnostic.create(salaryCoverage
    ? { startDate: salaryWindow.startDate, endDate: salaryWindow.endDate,
      occurrences: scheduledEventsOnRange(planForIdentity, salaryWindow.startDate, salaryWindow.endDate) }
    : undefined);
  const hitGroups = representedEventHitGroups({
    transactions: collapsed.transactions,
    accountMap: mapDoc,
    plan: planForIdentity,
    identityRules,
    transactionWindow: normalized.transactionWindow,
    asOf: scheduleTrustAsOf,
    salaryDiagnostic,
  });
  const represented = hitGroups.unique.map(c => classifyRepresentedCandidate(c, openingAsOf));
  const explicitlyPostedCounts = new Map();
  for (const raw of input.payload?.transactions || []) if (raw.is_pending === false && raw.id != null) {
    const id = String(raw.id);
    explicitlyPostedCounts.set(id, (explicitlyPostedCounts.get(id) || 0) + 1);
  }
  const cardMinimumCategoryEvidence = MinimumCategory.observe({
    plan: planForIdentity, accountMap: mapDoc, asOf: scheduleTrustAsOf,
    transactions: collapsed.transactions, transactionWindow: normalized.transactionWindow,
    pendingCoverage: normalized.pendingCoverage,
    cycleOpensOn: (due, day) => statementCloseDateForDue(due, day) || due,
    isExplicitlyPosted: tx => explicitlyPostedCounts.get(tx.providerTransactionId) === 1,
    coverageReference: cardCoverageReference,
    // The served row's payee card, by the same derivation and identity flags.
    payeeCardDestination: tx => payeeCardDestination(tx, mappingFor(mapDoc, tx.providerAccountId),
      Forecast.classifyCurrentPeriodTransaction.derivedFlags({ payee: tx.payee, displayedPayee: tx.payee,
        originalName: tx.originalName, original_name: tx.originalName, originalMerchant: tx.originalName || tx.payee,
        notes: tx.notes, note: tx.notes || tx.note, kind: tx.kind, date: tx.date, amount: tx.amount },
      planForIdentity)),
    alreadyAllocated: tx => (planForIdentity.cardPurchaseCoverage?.payments || []).some(p =>
      p.confirmed === true && (p.debitRef === cardCoverageReference(tx) || p.creditRef === cardCoverageReference(tx))),
    matchesIdentity: (tx, row) => identityRules.some(rule => rule.eventId === row.id
      && ruleMatchesTransactionIdentity(tx, rule)),
    // Payment pending only: the same identity fields without the posted-receipt
    // requirement (as pending-bill disclosure reads them). Never settles.
    matchesPendingIdentity: (tx, row) => identityRules.some(rule => rule.eventId === row.id
      && matchesIdentityFields(tx, rule)),
    // Reversal evidence uses the same payment aliases. Exclusions prevent a
    // reversal from confirming a payment, but must not hide its withdrawal.
    matchesReversalIdentity: (tx, row) => identityRules.some(rule => rule.eventId === row.id
      && ruleMatchesTransactionIdentity(tx, { ...rule, payeeExcludePatterns: [] })),
  });
  // Historical transaction-identity hits are evidence, not current-opening
  // posting comparisons. The live overlay may consume one only for an exact
  // once joint-cash outflow that Forecast is still carrying.
  const postingObservations = represented
    .filter(c => c.currentOpeningImpact)
    .map(c => postingObservationFromCandidate(c, normalized.fetchedAt));
  const compareObs = observations.filter(o => !R.CARD_FACTS.has(o.fact));
  const cardObs = observations.filter(o => R.CARD_FACTS.has(o.fact));
  const result = R.reconcile({
    data: input.data,
    map: input.balanceMap || { mappings: [] },
    observations: compareObs,
    cardObservations: cardObs,
    postingObservations,
  });
  const sameDay = sameDayDiscrepancies(result);
  const incomeUncertainty = futureIncomeUncertainty({ transactions: collapsed.transactions,
    accountMap: mapDoc, plan: planForIdentity, identityRules,
    transactionWindow: normalized.transactionWindow, asOf: scheduleTrustAsOf }, hitGroups.unique, hitGroups.ambiguous);
  const assembled = {
    writesCanonicalState: false,
    provider: 'lunchmoney',
    fetchedAt: normalized.fetchedAt,
    pendingCoverage: normalized.pendingCoverage,
    transactionWindow: normalized.transactionWindow,
    mapped,
    unmapped,
    transactions: normalized.transactions,
    collapsedTransactions: collapsed.transactions,
    identityEvidence: collapsed.identityEvidence,
    observations,
    spendableCash: spendableCashFromObservations(observations, input.data),
    savingsPools: savingsPoolObservations(input.data, { ...normalized, transactions: collapsed.transactions }, mapDoc),
    cardCapacityIsCash: R.householdCashFromCardCapacity(),
    cardInferences,
    representedEventCandidates: represented,
    cardMinimumCategoryEvidence,
    ...(incomeUncertainty.status === 'unavailable' ? { incomeReconciliation: incomeUncertainty } : {}),
    sameDayInboundAmbiguity: sanitizedSameDayInboundAmbiguity(hitGroups.ambiguous),
    sameDayDiscrepancies: sameDay,
    reconciliation: result,
  };
  assembled.identityProof = identityFingerprint(assembled);
  assembled.observationReceipt = observationReceipt(assembled, { accountMap: mapDoc,
    salaryMatcherDiagnostic: salaryDiagnostic?.finish(hitGroups) });
  assembled.obligationReconciliationReceipt = reconciliationReceipt(assembled, {
    data: input.data,
    accountMap: mapDoc,
    identityRules,
  });
  const actualsPass = sanitizedCurrentPeriodActualsPass(assembled, {
    accountMap: mapDoc,
    transactionsPresent: normalized.transactionsPresent,
    plan: input.data && input.data.plan,
    planForIdentity,
    identityRules,
    billPaymentPayees,
    ambiguousBillGroups: hitGroups.ambiguous,
    asOf: dateOnly(normalized.fetchedAt),
    // N2: account sync fields reach the coverage stamp without joining the public report.
    accounts: normalized.accounts,
    recurringItems: input.payload && input.payload.recurringItems,
    lunchMoneyBudgets: input.payload && input.payload.lunchMoneyBudgets,
    lunchMoneyCategories: input.payload && input.payload.categories,
    // Part (b): the refusals of this observation's one review, never re-derived.
    recurringRefused: recurringReview.refused,
    onCoverageDiagnostic: input.onCoverageDiagnostic,
  });
  assembled.currentPeriodActuals = actualsPass.packet;
  // U4: a noted TD minimum payment stays evidence only if card coverage, on
  // this observation's own packet, paired it with the card's posted credit.
  if (assembled.cardMinimumCategoryEvidence) {
    const packet = actualsPass.packet;
    const receipts = (assembled.cardMinimumCategoryEvidence.payments || []).some(p => p?.evidence === 'card-payment-note')
      && packet && Array.isArray(packet.transactions)
      ? Forecast.cardNotePaymentReceipts(packet.transactions, { plan: input.data && input.data.plan,
        asOf: packet.observationAsOf, packet, debts: input.data && input.data.debts }) : [];
    assembled.cardMinimumCategoryEvidence = MinimumCategory.qualifyNotePayments(assembled.cardMinimumCategoryEvidence, receipts);
    // The packet's ownership marks follow the qualified evidence, never the provisional.
    restampCardMinimumOwnership(packet, actualsPass.join, input.data && input.data.plan,
      assembled.cardMinimumCategoryEvidence);
  }
  // S2: the timing applied above, for live-plan to apply to the served plan.
  // Internal to the report; never served.
  // Present only when a schedule applies, so every other report keeps its shape.
  if (recurringSchedules.length) assembled.recurringBillSchedules = recurringSchedules;
  // The fixed-amount derivation, for live-plan to apply to the served plan.
  // Internal to the report; present only when the history read was asked for.
  if (input.payload && input.payload.amountHistory !== undefined) {
    assembled.derivedAmountFixed = derivedAmountFixedBills(input.payload.amountHistory, {
      plan: input.data && input.data.plan, debts: input.data && input.data.debts, accountMap: mapDoc, identityRules,
      categories: input.payload.categories, tags: input.payload.tags, fetchedAt: normalized.fetchedAt });
  } else if (input.payload && input.payload.amountFixedDerivation !== undefined) {
    // A replay from observation memory carries the live derivation's outcome
    // (ObservationMemory.sourceInputs keeps only that record, never the rows).
    // Memory is bound to the same canonical context, so it derives the same.
    assembled.derivedAmountFixed = ObservationMemory.amountFixedDerivation(input.payload.amountFixedDerivation);
  }
  // The bill sheet's payment history (Dale, 2026-11-18), from the same read and
  // identification; a replay carries the live series through its clean record.
  if (input.payload && input.payload.amountHistory !== undefined) {
    // Anchored on this observation's own as-of, never the request clock: the same
    // evidence publishes the same series whenever it is read.
    assembled.billPaymentHistory = billPaymentHistory(input.payload.amountHistory, {
      asOf: assembled.currentPeriodActuals && assembled.currentPeriodActuals.observationAsOf,
      plan: input.data && input.data.plan, debts: input.data && input.data.debts, accountMap: mapDoc, identityRules,
      categories: input.payload.categories, tags: input.payload.tags, fetchedAt: normalized.fetchedAt });
  } else if (input.payload && input.payload.billPaymentHistory !== undefined) {
    assembled.billPaymentHistory = ObservationMemory.billPaymentHistory(input.payload.billPaymentHistory);
  }
  if (capture) {
    capture.packet = actualsPass.packet;
    capture.join = actualsPass.join;
    capture.qualified = actualsPass.qualified;
  }
  for (const tx of collapsed.transactions || []) {
    if (tx && Object.prototype.hasOwnProperty.call(tx, 'pendingReplacementHit')) {
      delete tx.pendingReplacementHit;
    }
  }
  return assembled;
}

const RAW_TX_METADATA_KEYS = [
  'payee',
  'original_name',
  'originalName',
  'original_merchant',
  'displayed_payee',
  'notes',
  'note',
  'tags',
  'tag',
  'tag_ids',
  'tagIds',
  'providerTransactionId',
  'providerAccountId',
  'provider_transaction_id',
  'provider_account_id',
  'merchant',
  'merchantName',
  'merchant_name',
  'external_id',
  'externalId',
  'pending_transaction_id',
  'pendingTransactionId',
  'plaid_id',
  'plaidId',
  'plaid_metadata',
  'plaidMetadata',
  'plaidTransactionId',
  'plaidPendingTransactionId',
  'transaction_id',
  'identity',
];
const RAW_TX_METADATA_KEY_RE = new RegExp(
  '"(' + RAW_TX_METADATA_KEYS.join('|') + ')"\\s*:'
);

// Display-only Lunch Money note (owner-confirmed by Dale, 2026-10-31): a note
// is published only when it is deliberately marked with this prefix. Payee
// renames on recurring-linked rows revert, so the real purchase goes in the
// note instead (for example "item: Disney+"). Any other note stays hidden.
const DISPLAYED_NOTE_PREFIX = 'item:';
const DISPLAYED_NOTE_MAX_CHARS = 60;

// Only the first line of a note can publish (owner direction, Dale,
// 2026-11-02): later lines are never displayed. Any Unicode line break ends
// the first line: CRLF, LF, CR, VT, FF, NEL, LINE and PARAGRAPH SEPARATOR.
const DISPLAYED_NOTE_LINE_BREAK_RE = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;

// Bounded value for the new `displayedNote` field, computed from the raw note
// before stripRawTransactionMetadata removes it. Only the note's first line is
// considered; nothing after the first line break is ever read. Returns null
// when the note is not a string, its first line does not start with the
// prefix (case-insensitive, leading spaces and tabs allowed), or the first
// line is empty after the prefix. The raw note itself is never published, and
// nothing in Forecast classification or math reads this.
function displayedItemNote(rawNote) {
  if (typeof rawNote !== 'string') return null;
  const firstLine = rawNote.split(DISPLAYED_NOTE_LINE_BREAK_RE, 1)[0];
  const lead = firstLine.trimStart();
  if (lead.slice(0, DISPLAYED_NOTE_PREFIX.length).toLowerCase() !== DISPLAYED_NOTE_PREFIX) {
    return null;
  }
  const text = lead.slice(DISPLAYED_NOTE_PREFIX.length)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= DISPLAYED_NOTE_MAX_CHARS) return text;
  return chars.slice(0, DISPLAYED_NOTE_MAX_CHARS - 1).join('').trimEnd() + '\u2026';
}

// #962 C1 (Grok Bot, rule 17; lead conditions 2026-11-16): the bank's own
// description of a refund, as written (Lunch Money original_name), shown only
// when the row has no display name. Control characters stripped, capped like
// the item note. No payee or category fallback. Kept only on rows Forecast
// links to a named household category (#1234); every other row strips it.
// Invisible text-direction marks (ALM, LRM, RLM, the embeddings and overrides
// U+202A-202E, the isolates U+2066-2069) and zero-width characters (U+200B-200D,
// the word joiner U+2060, the BOM U+FEFF). They are removed outright, never
// replaced, so the visible text stays exactly as the bank wrote it: case and
// punctuation untouched (Grok Bot, rule 17, 2026-11-17).
const BANK_DESCRIPTION_INVISIBLE_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const BANK_DESCRIPTION_INVISIBLE_TEST_RE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

function bankDescriptionText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(BANK_DESCRIPTION_INVISIBLE_RE, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  if (chars.length <= DISPLAYED_NOTE_MAX_CHARS) return text;
  return chars.slice(0, DISPLAYED_NOTE_MAX_CHARS - 1).join('').trimEnd() + '\u2026';
}

function sanitizedMerchantIdentity(value) {
  if (value == null) return null;
  if (typeof value === 'number' && isFinite(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function stripRawTransactionMetadata(tx) {
  if (!tx || typeof tx !== 'object') return tx;
  for (const key of RAW_TX_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(tx, key)) delete tx[key];
  }
  return tx;
}

function transactionLooksSanitized(tx) {
  if (!tx || typeof tx !== 'object') return false;
  for (const key of RAW_TX_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(tx, key)) return false;
  }
  // #962 C1: a bank description survives only on a refund (a credit), bounded
  // and free of control, invisible text-direction and zero-width characters. Any other row carrying one is unsanitized.
  if (Object.prototype.hasOwnProperty.call(tx, 'bankDescription')) {
    const text = tx.bankDescription;
    if (typeof text !== 'string' || !text || /[\u0000-\u001f\u007f]/.test(text)
      || BANK_DESCRIPTION_INVISIBLE_TEST_RE.test(text)
      || Array.from(text).length > DISPLAYED_NOTE_MAX_CHARS || !(Number(tx.amount) < 0)) return false;
  }
  return !RAW_TX_METADATA_KEY_RE.test(JSON.stringify(tx));
}

function currentPeriodActualsLooksSanitized(packet) {
  if (packet == null) return true;
  const blob = JSON.stringify(packet);
  if (RAW_TX_METADATA_KEY_RE.test(blob)) return false;
  if (/Bearer\s+\S+/.test(blob)) return false;
  const txs = packet.transactions;
  if (Array.isArray(txs) && txs.some(tx => tx && !transactionLooksSanitized(tx))) {
    return false;
  }
  return recurringEvidenceLooksSanitized(packet.lunchMoneyRecurring)
    && budgetEvidenceLooksSanitized(packet.lunchMoneyBudgets);
}

function householdCashIdsFromPlan(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  // Match Forecast.openingCashState / gapMovementAffectsSpendableOpening:
  // when canonical chequing identities exist, only those rows open spendable
  // cash. A correctly mapped Savings reserve is not a missing cash mapping.
  // A plan without those ids has no ready opening in Forecast (the gate is
  // unavailable), so no figure rests on this; the stricter generic-row
  // mapping requirement is kept for it.
  const chequingIds = ['chequing-a', 'chequing-b'];
  const hasChequing = rows.some(row => row && chequingIds.includes(row.id));
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    if (hasChequing && !chequingIds.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function mappedHouseholdCashIds(accountMap) {
  const ids = new Set();
  for (const mapping of (accountMap && accountMap.mappings) || []) {
    if (!mapping || mapping.atlasRole !== 'household-cash') continue;
    const id = mapping.canonical && mapping.canonical.id;
    if (id) ids.add(String(id));
  }
  return ids;
}

function paydayFromPlan(plan, asOf) {
  const cycle = Forecast.spendingCycle(plan, asOf);
  return cycle && cycle.start ? String(cycle.start) : null;
}

// Earn paydayGapComplete from incumbent observation evidence. A
// paginated-complete current-period window is not enough: the posted
// window must cover every household-cash day from the dated opening
// through payday morning, required household-cash identities in the
// opening breakdown must be mapped, amounts must be trusted, pending
// coverage must be complete, and no pending-unproven household-cash
// movement may sit in that gap. Caller-supplied truth flags are ignored.
function paydayGapCompleteFromEvidence(opts) {
  const plan = opts && opts.plan;
  const asOf = opts && opts.asOf;
  const window = (opts && opts.window) || {};
  const txs = (opts && opts.transactions) || [];
  const pendingCoverage = opts && opts.pendingCoverage;
  const accountMap = opts && opts.accountMap;
  if (!plan || !asOf) return false;
  const openingAsOf = plan.opening && plan.opening.asOf;
  if (!openingAsOf) return false;
  const paydayDate = paydayFromPlan(plan, asOf);
  if (!paydayDate) return false;
  if (String(openingAsOf) === String(paydayDate)) return true;
  const firstGapDay = Forecast.addDays(openingAsOf, 1);
  const lastGapDay = Forecast.addDays(paydayDate, -1);
  if (!firstGapDay || !lastGapDay) return false;
  if (String(lastGapDay) < String(firstGapDay)) return true;
  if (!postedWindowIsComplete(window)) return false;
  const coverageStart = window.startDate || null;
  const coverageThrough = window.endDate || null;
  if (!coverageStart || !coverageThrough) return false;
  if (String(coverageStart) > String(firstGapDay)) return false;
  if (String(coverageThrough) < String(lastGapDay)) return false;
  if (pendingCoverage !== 'complete') return false;
  const needed = householdCashIdsFromPlan(plan);
  if (needed.length) {
    const mapped = mappedHouseholdCashIds(accountMap);
    if (needed.some(id => !mapped.has(id))) return false;
  }
  for (const tx of txs) {
    if (!tx) continue;
    if (tx.accountRole === 'unmapped') return false;
    const inGap = tx.date
      && String(tx.date) > String(openingAsOf)
      && String(tx.date) < String(paydayDate);
    if (tx.accountRole === 'household-cash'
      && tx.pending === true
      && (tx.pendingPostedDuplicate !== true || tx.pendingBillCopy === true)
      && inGap) {
      return false;
    }
    if (tx.accountRole === 'household-cash' && tx.pending !== true
      && !Number.isFinite(Number(tx.amount))) {
      return false;
    }
  }
  return true;
}

// The payee identity's card (MBNA, CAN TIRE MC as Triangle) for a household
// cash or Savings (reserve) debit, or null: money onto the card counts from
// either (owner rule). The generic TD "TFR-TO C/C" names no card. The one
// derivation, read by the served row and by the card-minimum observer.
function payeeCardDestination(tx, mapping, flags) {
  if (!tx || !['household-cash', 'household-reserve'].includes(atlasAccountRole(mapping))) return null;
  if (isMbnaCardPayment(tx)) return 'mbna';
  return flags && flags.cardPaymentIdentity === true && flags.tdCardPaymentIdentity !== true ? 'triangle' : null;
}

function atlasAccountRole(mapping) {
  if (!mapping || !mapping.atlasRole) return 'unmapped';
  if (mapping.atlasRole === 'household-cash') return 'household-cash';
  if (mapping.atlasRole === 'household-reserve') return 'household-reserve';
  if (CREDIT_ROLES.has(mapping.atlasRole)) return 'revolving-credit';
  if (mapping.atlasRole === 'heloc' || mapping.atlasRole === 'mortgage') return mapping.atlasRole;
  if (mapping.atlasRole === EXTERNAL_LIVE_ROLE) return EXTERNAL_LIVE_ROLE;
  return 'unmapped';
}

function kindHintFromTransaction(tx) {
  const raw = tx && tx.kind ? String(tx.kind).toLowerCase() : '';
  if (raw === 'payment' || raw === 'bill-payment' || raw === 'card-payment') return 'payment';
  if (raw === 'transfer' || raw === 'internal-transfer') return 'transfer';
  if (raw === 'gas' || raw === 'fuel' || raw === 'petrol') return 'gas';
  return null;
}

function explicitPersonalOwnerFromTagsNotes(tx) {
  if (!tx) return null;
  const parts = [];
  const push = value => {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        if (typeof item === 'object') parts.push(item.name || item.label || '');
        else parts.push(item);
      }
      return;
    }
    if (typeof value === 'object') {
      parts.push(value.name || value.label || '');
      return;
    }
    parts.push(value);
  };
  push(tx.notes);
  push(tx.note);
  push(tx.tags);
  push(tx.tag);
  const blob = parts.filter(Boolean).join(' ');
  const dale = /\bdale\b/i.test(blob);
  const amanda = /\bamanda\b/i.test(blob);
  if (dale && amanda) return null;
  if (dale) return 'dale';
  if (amanda) return 'amanda';
  return null;
}

function isMbnaCardPayment(tx) {
  if (!tx) return false;
  const payee = [tx.payee, tx.originalName, tx.displayedPayee]
    .filter(Boolean).map(v => String(v)).join(' ');
  if (!/\bmbna\b/i.test(payee)) return false;
  if (/\bamazon\b|\bamzn\b/i.test(payee) && !/payment|pay\b|autopay|\bpmt\b/i.test(payee)) {
    return false;
  }
  const label = String(tx.categoryLabel || tx.category_name || '').toLowerCase();
  if (tx.excludeFromTotals === true) return true;
  if (/payment|transfer/.test(label)) return true;
  if (/payment|pay\b|autopay|\bpmt\b/i.test(payee)) return true;
  return /^\s*mbna\s*$/i.test(payee);
}

function parsePlaidMetadataObject(meta) {
  if (meta == null || meta === '') return null;
  let obj = meta;
  if (typeof meta === 'string') {
    try { obj = JSON.parse(meta); }
    catch (e) { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return obj;
}

function plaidFieldsFromMetadata(meta, keys) {
  const obj = parsePlaidMetadataObject(meta);
  if (!obj) return [];
  const sources = [obj];
  if (obj.transaction && typeof obj.transaction === 'object' && !Array.isArray(obj.transaction)) {
    sources.push(obj.transaction);
  }
  return sources.flatMap(source => keys.map(key => source[key]));
}

function consistentPlaidIdentity(raw, directKeys, metadataKeys) {
  if (!raw || typeof raw !== 'object') return null;
  const values = directKeys.map(key => raw[key])
    .concat([raw.plaid_metadata, raw.plaidMetadata].flatMap(meta => plaidFieldsFromMetadata(meta, metadataKeys)))
    .filter(value => value != null && value !== '');
  const [first] = values;
  return typeof first === 'string' && /^\S+$/.test(first) && values.every(value => value === first) ? first : null;
}

function plaidTransactionIdFromRaw(raw) {
  return consistentPlaidIdentity(raw, ['plaidTransactionId'], ['transaction_id', 'transactionId']);
}

function plaidPendingTransactionIdFromRaw(raw) {
  return consistentPlaidIdentity(raw, ['plaidPendingTransactionId', 'pending_transaction_id', 'pendingTransactionId'],
    ['pending_transaction_id', 'pendingTransactionId']);
}

function plaidTransactionIdOf(tx) {
  if (tx?.provider === 'lunchmoney' && Object.hasOwn(tx, 'plaidTransactionId')) return tx.plaidTransactionId;
  return plaidTransactionIdFromRaw(tx);
}

function plaidPendingTransactionIdOf(tx) {
  if (tx?.provider === 'lunchmoney' && Object.hasOwn(tx, 'plaidPendingTransactionId')) return tx.plaidPendingTransactionId;
  return plaidPendingTransactionIdFromRaw(tx);
}

function directedPlaidSettlementMate(posted, pending) {
  const want = plaidPendingTransactionIdOf(posted);
  const have = plaidTransactionIdOf(pending);
  if (!want || !have) return false;
  return want === have;
}

function postedForPendingSettlement(tx) {
  // Normalized provider rows always carry explicit posting evidence.
  // Older normalized fixtures carry the affirmative boolean directly.
  return tx.pending === false && tx.contradictoryEvidence !== true
    && (!Object.hasOwn(tx, 'savingsPostingEvidence') || tx.savingsPostingEvidence === 'posted');
}

function hasDifferentPlaidPredecessor(posted, pending) {
  if (!postedForPendingSettlement(posted) || pending.contradictoryEvidence === true) return false;
  const predecessor = plaidPendingTransactionIdOf(posted);
  const authorization = plaidTransactionIdOf(pending);
  const postedIdentity = plaidTransactionIdOf(posted);
  return !!predecessor && !!authorization && predecessor !== authorization
    && postedIdentity !== authorization && postedIdentity !== predecessor;
}

function sameSettlementAccount(pending, posted, opts) {
  const pendingAccount = settlementAccountId(pending, opts);
  const postedAccount = settlementAccountId(posted, opts);
  if (pendingAccount == null || postedAccount == null
      || pendingAccount === '' || postedAccount === '') {
    return true;
  }
  return String(pendingAccount) === String(postedAccount);
}

function settlementAccountId(tx, opts) {
  const mapping = opts && opts.accountMap
    ? mappingFor(opts.accountMap, tx && tx.providerAccountId) : null;
  return mapping && mapping.canonical && mapping.canonical.id
    ? mapping.canonical.id
    : (tx && (tx.atlasAccountId || tx.account || tx.providerAccountId));
}

// Owner-confirmed 2026-09-02: this exact pending+posted pair is one Travel
// Visa Shopify purchase (live overlay tx-103 → tx-113). Not a merchant-digit
// heuristic and not a general date+account+amount+merchant rule.
const OWNER_CONFIRMED_SHOPIFY_SETTLEMENT = Object.freeze({
  date: '2026-08-31',
  amount: '54.88',
  originalMerchant: 'SHOPIFY INC/578523914',
});

function isTravelVisaAccount(accountId) {
  if (accountId == null || accountId === '') return false;
  return String(accountId).trim().toLowerCase().replace(/[\s_-]+/g, '') === 'travelvisa';
}

function ownerConfirmedShopifyMerchant(tx) {
  if (!tx) return false;
  const want = OWNER_CONFIRMED_SHOPIFY_SETTLEMENT.originalMerchant;
  return [tx.originalMerchant, tx.originalName, tx.original_name]
    .some(v => v === want);
}

function matchesOwnerConfirmedShopifySettlement(tx, accountId) {
  if (!tx || tx.date !== OWNER_CONFIRMED_SHOPIFY_SETTLEMENT.date) return false;
  if (!isTravelVisaAccount(accountId)) return false;
  if (!ownerConfirmedShopifyMerchant(tx)) return false;
  const amt = lunchMoneyDebitAmount(tx.amount);
  return amt != null && Number(amt).toFixed(2) === OWNER_CONFIRMED_SHOPIFY_SETTLEMENT.amount;
}

function collapseOwnerConfirmedShopifySettlement(pending, posted, drop, opts) {
  const confirmedPending = pending.filter(tx =>
    !drop.has(tx) && matchesOwnerConfirmedShopifySettlement(tx, settlementAccountId(tx, opts)));
  const confirmedPosted = posted.filter(tx =>
    !drop.has(tx) && matchesOwnerConfirmedShopifySettlement(tx, settlementAccountId(tx, opts)));
  // Exactly one unresolved pending and one confirmed-settled posted of this
  // identity. Two such 4-tuples stay uncollapsed — that would be a general rule.
  if (confirmedPending.length === 1 && confirmedPosted.length === 1
    && !hasDifferentPlaidPredecessor(confirmedPosted[0], confirmedPending[0])) {
    drop.add(confirmedPending[0]);
  }
}

function collapsePendingPostedBySettlementIdentity(transactions, asOf, opts) {
  const list = (transactions || []).filter(tx => tx && tx.date);
  if (list.length < 2) return list;
  const treat = tx => pendingForecastTreatment(tx, asOf, opts);
  const pending = [];
  const posted = [];
  for (const tx of list) {
    const treatment = treat(tx);
    if (tx.pending === true && treatment.treatment === 'unresolved') pending.push(tx);
    else if (postedForPendingSettlement(tx)) posted.push(tx);
  }
  if (!pending.length || !posted.length) return list;
  const drop = new Set();
  const links = [];
  for (const pend of pending) {
    for (const post of posted) {
      if (!directedPlaidSettlementMate(post, pend)) continue;
      if (!sameSettlementAccount(pend, post, opts)) continue;
      links.push({ pend, post });
    }
  }
  for (const pend of pending) {
    const mates = [];
    for (const link of links) {
      if (link.pend === pend && !mates.includes(link.post)) mates.push(link.post);
    }
    if (mates.length === 1) {
      const claimedByOtherPending = links.some(link => (
        link.post === mates[0] && link.pend !== pend
      ));
      if (!claimedByOtherPending) drop.add(pend);
      else {
        pend.pendingPostedAmbiguous = true;
        mates[0].pendingPostedAmbiguous = true;
      }
    } else if (mates.length > 1) {
      pend.pendingPostedAmbiguous = true;
      for (const post of mates) post.pendingPostedAmbiguous = true;
    }
  }
  collapseOwnerConfirmedShopifySettlement(pending, posted, drop, opts);
  const remaining = drop.size ? list.filter(tx => !drop.has(tx)) : list;
  flagUnresolvedPendingPostedDuplicates(remaining, asOf, opts);
  return remaining;
}

const distinctPendingByPosted = new WeakMap();

function pendingPostedSurfaceKey(tx, opts) {
  const accountId = settlementAccountId(tx, opts);
  const amount = lunchMoneyDebitAmount(tx && tx.amount);
  const merchant = [
    tx && tx.originalMerchant,
    tx && tx.originalName,
    tx && tx.original_name,
    tx && tx.payee,
  ].find(v => v != null && String(v).trim() !== '');
  if (!tx || amount == null) return null;
  return Forecast.classifyCurrentPeriodTransaction.spendDuplicateKey({
    date: tx.date, account: accountId, amount, originalMerchant: merchant,
  });
}

function flagUnresolvedPendingPostedDuplicates(transactions, asOf, opts) {
  const treat = tx => pendingForecastTreatment(tx, asOf, opts);
  const pendingByKey = new Map();
  const postedByKey = new Map();
  for (const tx of transactions || []) {
    if (!tx) continue;
    distinctPendingByPosted.delete(tx);
    const key = pendingPostedSurfaceKey(tx, opts);
    if (!key) continue;
    const treatment = treat(tx);
    if (tx.pending === true && treatment.treatment === 'unresolved') {
      const list = pendingByKey.get(key) || [];
      list.push(tx);
      pendingByKey.set(key, list);
    } else if (tx.pending !== true && treatment.treatment === 'confirmed-settled') {
      const list = postedByKey.get(key) || [];
      list.push(tx);
      postedByKey.set(key, list);
    }
  }
  for (const [key, pendings] of pendingByKey) {
    const posted = postedByKey.get(key) || [];
    if (pendings.length !== 1 || posted.length !== 1) continue;
    if (pendings[0].pendingPostedAmbiguous !== true && posted[0].pendingPostedAmbiguous !== true
      && hasDifferentPlaidPredecessor(posted[0], pendings[0])) {
      distinctPendingByPosted.set(posted[0], pendings[0]);
      continue;
    }
    pendings[0].pendingPostedDuplicate = true;
    posted[0].pendingPostedDuplicate = true;
  }
}

function isCardPaidPlanBill(plan, eventId) {
  const bill = ((plan && plan.bills) || []).find(row => row && row.id === eventId);
  if (!bill || bill.householdObligation === false) return false;
  const cash = (plan && plan.startingCash) || {};
  if ((cash.heldElsewhere || []).some(row => row && row.id === bill.payingAccount)) return false;
  if (bill.jointCash === false) return true;
  return ((plan && plan.obligations) || []).some(row => row && row.debtId === bill.payingAccount);
}

// A pending charge occupies a card-paid bill only at the bill's exact
// scheduled amount, including when the identity rule sets no settlesWhen.
// A payee match
// at another amount (a price change, an add-on) is not that bill: the charge
// stays counted as card spending and the bill stays due, so nothing is lost.
// An unknown scheduled amount fails closed (not occupied).
function pendingHitIsExactScheduledAmount(plan, hit) {
  const scheduled = scheduledOccurrence(plan, hit.id, hit.date);
  if (scheduled.length !== 1) return false;
  const need = Math.abs(Number(scheduled[0].amount));
  const got = Math.abs(Number(hit.observedAmount));
  return isFinite(need) && isFinite(got) && need > 0
    && Math.abs(got - need) <= IDENTITY_AMOUNT_EPSILON;
}

// Pending revolving purchases that uniquely match a still-due card-paid bill
// occupy that occurrence for classification only. They are not represented
// settlement and do not use the pending provider id as cash-omit evidence.
// Returns { ids, possible }: `ids` occupy their bill; `possible` maps a
// pending local id to the one card-paid bill its payee identifies at a
// different amount (display only, never occupancy or math).
function pendingCardPaidBillLocalIds(collapsed, opts, existingLocalId, representedActuals) {
  const possible = new Map();
  const window = opts && opts.transactionWindow;
  if (window && window.complete === false) return { ids: [], possible };
  const rules = stampRuleSetClaims(opts && opts.identityRules).filter(ruleHasIdentity);
  if (!rules.length) return { ids: [], possible };
  const identityOnlyRules = rules.map(rule => (rule.settlesWhen === SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT
    ? Object.assign({}, rule, { settlesWhen: undefined }) : rule));
  const plan = (opts && (opts.planForIdentity || opts.plan)) || null;
  const mapDoc = opts && opts.accountMap;
  const taken = new Set((representedActuals || [])
    .filter(row => row && row.id && row.date)
    .map(row => row.id + '@' + row.date));
  for (const row of (plan && plan.opening && plan.opening.representedEvents) || []) {
    if (row && row.id && row.date) taken.add(row.id + '@' + row.date);
  }
  const groups = new Map();
  for (const tx of collapsed || []) {
    if (!tx || tx.pending !== true || tx.contradictoryEvidence === true) continue;
    if (tx.pendingPostedDuplicate === true || tx.pendingPostedAmbiguous === true) continue;
    const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
    if (atlasAccountRole(mapping) !== 'revolving-credit') continue;
    // Identity-only hits: an exact-scheduled-amount rule is relaxed to its
    // payee identity here so a different-amount charge can be disclosed;
    // occupancy below still requires the exact scheduled amount.
    const identityHits = collectIdentityHits(tx, {
      accountMap: mapDoc,
      plan,
      identityRules: identityOnlyRules,
      transactions: collapsed,
    }, identityOnlyRules).filter(hit => hit
      && hit.sameAccountSplitLegs !== true
      && hit.lateWindow !== true
      && isCardPaidPlanBill(plan, hit.id)
      && (hit.settlesWhen === SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT || !hit.settlesWhen));
    const hits = identityHits.filter(hit => pendingHitIsExactScheduledAmount(plan, hit));
    if (hits.length !== 1) {
      // Disclosure only: the one still-due bill this payee identifies, at a
      // different amount. The charge stays counted; the page says why.
      if (!hits.length && identityHits.length === 1
        && !taken.has(identityHits[0].id + '@' + identityHits[0].date)) {
        const nearId = existingLocalId(identityHits[0].providerTransactionId);
        if (nearId) possible.set(nearId, identityHits[0].id);
      }
      continue;
    }
    const key = hits[0].id + '@' + hits[0].date;
    if (taken.has(key)) continue;
    const localId = existingLocalId(hits[0].providerTransactionId);
    if (!localId) continue;
    const list = groups.get(key) || [];
    list.push(localId);
    groups.set(key, list);
  }
  const ids = [];
  for (const list of groups.values()) {
    if (list.length !== 1) continue;
    ids.push(list[0]);
  }
  return { ids, possible };
}

// #962 D3: a debit that carries a bill's full identity except its date is a
// probable payment of that bill, not household spending. It is never a
// settlement (date and amount never identify): the bill stays To confirm
// and reserved, and the debit is held out of Household / Other and named
// on the bill as a to-confirm candidate. Bounded: an explicit payee
// identity, the rule's own mapped account, debit direction, a posted debit
// on a household cash account, and a date within NEAR_DUE_BILL_DAYS of exactly one
// scheduled occurrence, capped below half of that bill's own interval so
// a short-cycle bill can never claim its neighbour's charge.
// Owner decision (#821, 2026-11-18): whether a plan bill's amount is fixed
// comes from its Lunch Money payment history, never a hand mark. A bill is
// fixed when (a) its identified posted CAD debits on the rule's own account in
// the history window, for completed occurrences only (not the current one,
// whose payment D2 is reading), (b) the latest min(6, count) of them with
// count >= 3, are (c) all equal to the cent and (d) equal to the plan amount,
// and (e) the newest is no older than two of the bill's intervals at the
// window's end.
// Anything uncertain (an incomplete or truncated window, a row two bills'
// rules identify, two payments on one day, a two-leg or minimum-style rule,
// an amount schedule, a once bill) leaves the bill not fixed. Recomputed on
// every observation, so a price change turns it off with no code change.
const AMOUNT_FIXED_INTERVAL_DAYS = Object.freeze({ weekly: 7, biweekly: 14, monthly: 31, quarterly: 92, yearly: 366 });
const AMOUNT_FIXED_SAMPLE = 6;
const AMOUNT_FIXED_MIN_COUNT = 3;
const AMOUNT_FIXED_EXCLUDED_SETTLES = new Set(['two-leg-sum', 'amount-at-least', SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE]);

// The identified payments both history readers share: each candidate plan
// row's posted CAD debits on its rules' own account, in the history window.
// Null when the window is unusable (incomplete, truncated, has more, or
// missing). `ambiguous` holds, per id, the dates of the rows another plan row's rules also
// identify (left out of every row's payments); `unsupported` holds the ids
// whose rule shape (two-leg sum, at least, trust on due, transfer) means one
// debit is not one payment of the bill; `duplicated` the ids one of whose
// rows the read delivered more than once.
function identifiedHistoryPayments(history, opts) {
  const plan = opts && opts.plan;
  const mapDoc = opts && opts.accountMap;
  const window = history && history.transactionWindow;
  const end = parseIsoDate(window && window.endDate);
  if (!plan || !mapDoc || !window || window.complete !== true || window.truncated === true || window.hasMore === true
    || !parseIsoDate(window.startDate) || !end || !Array.isArray(history.transactions)) return null;
  // The candidates: plan bills, and plain payment obligations (lead ruling on
  // #1355: the mortgage). An obligation with statement occurrences (a card
  // minimum), a revolving card's debt, a non-cash or capitalising leg (the
  // HELOC), or a once schedule is never a candidate.
  // An id named by more than one plan row (two bills, two obligations, or a
  // bill and an obligation) is ambiguous, so it is never a candidate.
  const idCount = new Map();
  for (const row of [].concat(plan.bills || [], plan.obligations || [])) {
    if (row && typeof row.id === 'string') idCount.set(row.id, (idCount.get(row.id) || 0) + 1);
  }
  // A revolving card's payment (its debt has a limit or a statement close day)
  // is a minimum against a moving balance, never a plain obligation, even
  // when it carries no statement occurrences (lead record on #1369: travel).
  const debts = new Map(((opts && opts.debts) || []).filter(d => d && typeof d.id === 'string').map(d => [d.id, d]));
  const revolving = o => {
    const debt = o.debtId != null ? debts.get(o.debtId) : null;
    return !!debt && (debt.limit != null || debt.statementCloseDay != null);
  };
  const plainObligation = o => o && typeof o.id === 'string' && o.effect === 'payment' && o.frequency !== 'once'
    && o.statementOccurrences === undefined && o.nonCash === undefined && o.cashPayment === undefined
    && !revolving(o);
  const bills = new Map();
  for (const b of plan.bills || []) {
    if (b && typeof b.id === 'string' && idCount.get(b.id) === 1) bills.set(b.id, { row: b, kind: 'bill' });
  }
  for (const o of plan.obligations || []) {
    if (o && typeof o.id === 'string' && idCount.get(o.id) === 1 && plainObligation(o)) bills.set(o.id, { row: o, kind: 'obligation' });
  }
  // The identity check reads every plan row's rules, candidate or not (Codex P2
  // on #1374): a row another bill or obligation also identifies is ambiguous
  // evidence, so leaving a non-candidate out could hand its payment to a
  // candidate. Only candidates collect payments.
  const rules = stampRuleSetClaims(opts.identityRules).filter(rule => rule && rule.direction === 'debit'
    && rule.atlasAccountId && idCount.has(rule.eventId));
  const identified = new Set(rules.map(rule => rule.eventId).filter(id => bills.has(id)));
  const normalized = normalizeLunchMoneyPayload({ transactions: history.transactions,
    categories: opts.categories || [], tags: opts.tags || [] }, opts.fetchedAt).transactions;
  const payments = new Map();
  const ambiguous = new Map();
  const unsupported = new Set();
  // A posted row whose provider transaction id the read delivers more than
  // once (or without one) has no single identity (Codex P1 on #1379): it is
  // never one payment, so the row it would pay is `duplicated` instead.
  const idSeen = new Map();
  for (const tx of normalized) {
    if (tx && tx.pending !== true && tx.providerTransactionId != null) {
      idSeen.set(tx.providerTransactionId, (idSeen.get(tx.providerTransactionId) || 0) + 1);
    }
  }
  const duplicated = new Set();
  for (const tx of normalized) {
    if (!tx || tx.pending === true || tx.contradictoryEvidence === true) continue;
    const date = parseIsoDate(tx.date);
    const amount = lunchMoneyDebitAmount(tx.amount);
    if (!date || date > end || !(Number.isFinite(amount) && amount > 0)) continue;
    if (typeof tx.currency !== 'string' || tx.currency.trim().toLowerCase() !== 'cad') continue;
    const mapping = mappingFor(mapDoc, tx.providerAccountId);
    const accountId = mapping && mapping.canonical && mapping.canonical.id;
    const hits = rules.filter(rule => rule.atlasAccountId === accountId
      && ruleMatchesTransactionIdentity(tx, rule) && ruleCurrencyQualified(tx, rule));
    const ids = Array.from(new Set(hits.map(rule => rule.eventId)));
    if (!ids.length) continue;
    // A row two plan rows' rules identify belongs to neither.
    if (ids.length > 1) { ids.forEach(id => ambiguous.set(id, (ambiguous.get(id) || []).concat([date]))); continue; }
    if (!bills.has(ids[0])) continue;
    if (hits.some(rule => AMOUNT_FIXED_EXCLUDED_SETTLES.has(rule.settlesWhen) || rule.transactionKind === 'transfer')) {
      unsupported.add(ids[0]); continue;
    }
    if (tx.providerTransactionId == null || idSeen.get(tx.providerTransactionId) !== 1) { duplicated.add(ids[0]); continue; }
    if (!payments.has(ids[0])) payments.set(ids[0], []);
    payments.get(ids[0]).push({ date, cents: Math.round(amount * 100) });
  }
  for (const rows of payments.values()) rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { plan, window, end, bills, identified, payments, ambiguous, unsupported, duplicated };
}

function derivedAmountFixedBills(history, opts) {
  const window = history && history.transactionWindow;
  const out = { source: 'lunchmoney-payment-history', status: 'unavailable',
    window: window ? { startDate: window.startDate || null, endDate: window.endDate || null } : null, billIds: [], obligationIds: [] };
  const found = identifiedHistoryPayments(history, opts);
  if (!found) return out;
  out.status = 'complete';
  const { plan, end, bills, payments } = found;
  for (const [id, rows] of payments) {
    const { row: bill, kind } = bills.get(id);
    const interval = AMOUNT_FIXED_INTERVAL_DAYS[bill.frequency];
    if (found.ambiguous.has(id) || found.unsupported.has(id) || found.duplicated.has(id) || !interval || bill.amountSchedule !== undefined
      || rows.length < AMOUNT_FIXED_MIN_COUNT) continue;
    // Two payments on one day are legs or a duplicate, not one fixed price.
    if (rows.some((row, i) => i > 0 && rows[i - 1].date === row.date)) continue;
    const planned = Number(bill.amount);
    if (!Number.isFinite(planned) || planned <= 0) continue;
    const plannedCents = Math.round(planned * 100);
    // Completed occurrences only (Codex P1 on #1355): a payment for the current
    // occurrence (the latest due on or before the window's end) or a later one
    // is the settlement D2 is reading, possibly a partial one, so it never
    // decides whether the price is fixed. Each payment belongs to its nearest
    // scheduled occurrence; with no resolvable schedule the bill is not fixed.
    const occ = scheduledEventsOnRange(plan, Forecast.addDays(window.startDate, -interval), Forecast.addDays(end, interval))
      .filter(e => e && e.id === id).map(e => e.date).filter((d, i, all) => all.indexOf(d) === i).sort();
    const current = occ.filter(d => d <= end).pop();
    if (!current) continue;
    const nearest = date => occ.reduce((best, d) => (Math.abs(Forecast.diffDays(d, date)) < Math.abs(Forecast.diffDays(best, date)) ? d : best), occ[0]);
    const completed = rows.filter(row => nearest(row.date) < current);
    if (completed.length < AMOUNT_FIXED_MIN_COUNT) continue;
    const sample = completed.slice(-AMOUNT_FIXED_SAMPLE);
    if (!sample.every(row => row.cents === plannedCents)) continue;
    if (Forecast.diffDays(sample[sample.length - 1].date, end) > 2 * interval) continue;
    (kind === 'obligation' ? out.obligationIds : out.billIds).push(id);
  }
  out.billIds.sort();
  out.obligationIds.sort();
  return out;
}

// Dale (2026-11-18, via the lead): the bill sheet's "Last 6 months" box shows
// each bill's and plain obligation's identified posted payments, read from the
// same 200-day history and the same identification as derivedAmountFixedBills;
// no new GET and no new matching. The six calendar months end with the window
// end's month; the window must reach back to the first of the earliest one.
// Published per row: its id and its payments' dates and amounts only, never
// payee text, notes or raw rows. A row whose rule shape makes one debit not one
// payment is unavailable; rows another plan row also identifies are left out
// and counted. A row with no debit identity rule has no entry.
const BILL_PAYMENT_HISTORY_MONTHS = 6;
function billPaymentHistoryMonths(endDate) {
  const [y, m] = endDate.split('-').map(Number);
  const out = [];
  for (let i = BILL_PAYMENT_HISTORY_MONTHS - 1; i >= 0; i--) {
    const k = y * 12 + (m - 1) - i;
    out.push(String(Math.floor(k / 12)) + '-' + String(k % 12 + 1).padStart(2, '0'));
  }
  return out;
}
function billPaymentHistory(history, opts) {
  const window = history && history.transactionWindow;
  const out = { source: 'lunchmoney-payment-history', status: 'unavailable', reason: 'history-unavailable',
    asOf: null, months: [], bills: [] };
  const found = identifiedHistoryPayments(history, opts);
  if (!found) {
    if (window && (window.truncated === true || window.hasMore === true || window.complete === false)) out.reason = 'history-incomplete';
    return out;
  }
  // The six months end with the observation's own as-of (opts.asOf), not the
  // history read's end, which follows the request clock. A read that ends before
  // that day is incomplete for it; payments after it are not shown.
  const asOf = parseIsoDate(opts && opts.asOf);
  if (!asOf || asOf > found.end) { out.reason = 'history-incomplete'; return out; }
  const months = billPaymentHistoryMonths(asOf);
  const from = months[0] + '-01';
  if (parseIsoDate(window.startDate) > from) { out.reason = 'history-too-short'; return out; }
  out.status = 'complete';
  delete out.reason;
  out.asOf = asOf;
  out.months = months;
  for (const id of Array.from(found.identified).sort()) {
    if (found.unsupported.has(id)) { out.bills.push({ billId: id, status: 'unavailable', reason: 'paid-in-parts', payments: [] }); continue; }
    if (found.duplicated.has(id)) { out.bills.push({ billId: id, status: 'unavailable', reason: 'duplicate-record', payments: [] }); continue; }
    const entry = { billId: id, status: 'complete',
      payments: (found.payments.get(id) || []).filter(row => row.date >= from && row.date <= asOf)
        .map(row => ({ date: row.date, amount: row.cents / 100 })) };
    const left = (found.ambiguous.get(id) || []).filter(date => date >= from && date <= asOf);
    if (left.length) {
      entry.excludedAmbiguous = left.length;
      // The months those rows fall in, so the page marks them left out, not unpaid (lead on #1379).
      entry.excludedAmbiguousMonths = Array.from(new Set(left.map(date => date.slice(0, 7)))).sort();
    }
    out.bills.push(entry);
  }
  return out;
}

const NEAR_DUE_BILL_DAYS = 3;
// The one occurrence of a bill nearest a debit date, with its reach: at most
// NEAR_DUE_BILL_DAYS, capped below half of that bill's own interval. Null
// when the bill has no occurrence within 45 days. Shared by the near-due
// candidates and the pending-copy pairing, so both use one window.
function nearestBillOccurrence(plan, eventId, date) {
  const occ = scheduledEventsOnRange(plan, Forecast.addDays(date, -45), Forecast.addDays(date, 45))
    .filter(e => e.id === eventId).map(e => e.date)
    .filter((d, i, all) => all.indexOf(d) === i).sort();
  if (!occ.length) return null;
  const dist = d => Math.abs(Forecast.diffDays(d, date));
  const nearest = occ.reduce((best, d) => (dist(d) < dist(best) ? d : best), occ[0]);
  const i = occ.indexOf(nearest);
  const gaps = [i > 0 ? Forecast.diffDays(occ[i - 1], nearest) : Infinity,
    i < occ.length - 1 ? Forecast.diffDays(nearest, occ[i + 1]) : Infinity];
  const interval = Math.min(...gaps);
  return { date: nearest, off: dist(nearest), reach: Math.min(NEAR_DUE_BILL_DAYS, Math.ceil(interval / 2) - 1),
    offsetDays: Forecast.diffDays(nearest, date) };
}
// The identity rules the near-due candidates and the pending-copy pairing
// read: an explicit payee identity, debit direction, a mapped account, not a
// transfer or a trust-on-due rule, naming a plan bill or obligation.
function nearDueIdentityRules(opts, plan) {
  return stampRuleSetClaims(opts && opts.identityRules).filter(rule => rule && rule.eventId
    && rule.direction === 'debit' && rule.atlasAccountId
    && rule.transactionKind !== 'transfer'
    && rule.settlesWhen !== SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE
    && rulePayeePatterns(rule).length > 0
    && isBillOrObligationEvent(plan, rule.eventId));
}
function nearDueBillCandidateIds(collapsed, opts, linkedLocalIds, existingLocalId, representedActuals) {
  const out = new Map();
  // An occurrence already settled by its own matched payment has nothing to
  // confirm: a second identity debit near it stays ordinary spending. A
  // pending-only row (pendingOnlyBillActuals, pending: true) is linked
  // evidence, never a payment: the bill stays reserved, so a posted identity
  // debit near it (typically that pending charge posting days later without a
  // provider link) is still held To confirm on the bill. Counting it as
  // spending while the bill is reserved would deduct the payment twice.
  const settled = new Set((representedActuals || []).filter(row => row && row.id && row.date && row.pending !== true)
    .map(row => row.id + '@' + row.date));
  // The occurrences only a pending-only row stands on. A debit held To confirm
  // on one of them carries pendingOnlyOccurrence: the pending copy and the
  // posted debit are not resolved as one payment, so Forecast keeps the
  // category remaining claim classified-incomplete, as before the hold.
  // The posted debit reads as that pending charge posting only when it is the
  // pending amount to the cent (one pending row). Any other amount may be a
  // separate charge beside a bill still pending, so it stays ordinary spending
  // and the pending bill stays reserved (#1315 re-review note; lead 2026-11-18):
  // the cautious reading never lets a gap or a second charge vanish.
  const pendingOnlyCents = new Map();
  for (const row of representedActuals || []) {
    if (!row || !row.id || !row.date || row.pending !== true) continue;
    const key = row.id + '@' + row.date;
    const list = pendingOnlyCents.get(key) || [];
    list.push(Math.round(Number(row.actual) * 100));
    pendingOnlyCents.set(key, list);
  }
  const pendingOnly = new Set(pendingOnlyCents.keys());
  const pendingCopyOf = (key, amount) => {
    const list = pendingOnlyCents.get(key);
    return !!(list && list.length === 1 && Number.isFinite(list[0]) && list[0] === Math.round(amount * 100));
  };
  // So is an occurrence the plan opening already names as represented
  // (effective by the observation date), and a recurring occurrence dated
  // before the settlement opening boundary, which Forecast prints Paid
  // because it already sits inside the opening cash.
  const planForOpening = (opts && opts.plan) || null;
  const opening = planForOpening && planForOpening.opening;
  const observedOn = parseIsoDate(opts && opts.asOf);
  for (const row of (opening && opening.representedEvents) || []) {
    if (!row || !row.id || !row.date) continue;
    if (observedOn && !Forecast.representedEventEffectiveBy(row, observedOn)) continue;
    settled.add(row.id + '@' + row.date);
  }
  const openingBoundary = opening && parseIsoDate(opening.priorAsOf || opening.asOf);
  const onceIds = new Set([].concat((planForOpening && planForOpening.bills) || [],
    (planForOpening && planForOpening.obligations) || [])
    .filter(row => row && row.frequency === 'once').map(row => row.id));
  const insideOpening = (id, date) => !!(openingBoundary && date < openingBoundary && !onceIds.has(id));
  const window = opts && opts.transactionWindow;
  if (window && window.complete === false) return out;
  const plan = (opts && (opts.planForIdentity || opts.plan)) || null;
  const mapDoc = opts && opts.accountMap;
  const rules = nearDueIdentityRules(opts, plan);
  if (!plan || !rules.length) return out;
  // Posted household-cash debits that pass every gate below except date.
  const eligibleDebit = new Map();
  // Lead ruling 2026-11-19 (BACKLOG, from #1319): a lone pending identity
  // debit near a still-due bill is that bill's probable payment, held To
  // confirm on it while pending, counted once; the bill is not settled and
  // stays reserved. Collected here, decided after the posted pass below.
  const pendingCandidates = [];
  // Occurrences any posted identity debit within reach names, whatever the
  // gates below decide: a pending row beside one is never held (#1319's
  // pairing or the incumbent path owns that pair). Like that pairing (Codex
  // P2 on #1319) and Forecast's actuals, a row dated after the observation
  // date is not yet evidence, so it never vetoes the hold (Atlas, #1400):
  // this census, and the pending count below, read rows through observedOn.
  const postedNear = new Set();
  const futurePosted = new Set();
  const competingRow = date => !observedOn || date <= observedOn;
  for (const tx of collapsed || []) {
    if (tx && tx.pending === true) {
      if (tx.contradictoryEvidence === true || tx.pendingPostedAmbiguous === true) continue;
      const localId = existingLocalId(tx.providerTransactionId);
      if (!localId || (linkedLocalIds && linkedLocalIds.has(localId))) continue;
      const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
      if (atlasAccountRole(mapping) !== 'household-cash' || !mapping.canonical) continue;
      const amount = lunchMoneyDebitAmount(tx.amount);
      const date = parseIsoDate(tx.date);
      if (!(Number.isFinite(amount) && amount > 0) || !date) continue;
      const found = [];
      for (const rule of rules) {
        if (mapping.canonical.id !== rule.atlasAccountId) continue;
        // A pending row has no posted receipt: it reads the rule's identity
        // fields only, as the pending-copy pairing does, and a rule that
        // requires posted evidence never names it.
        if (!matchesIdentityFields(tx, rule) || !ruleCurrencyQualified(tx, rule)) continue;
        const near = nearestBillOccurrence(plan, rule.eventId, date);
        if (!near || near.off > near.reach) continue;
        found.push({ id: rule.eventId, date: near.date, offsetDays: near.offsetDays, off: near.off });
      }
      pendingCandidates.push({ localId, amount, found, counts: competingRow(date) });
      continue;
    }
    // A posted row paired with its own pending copy (pendingPostedDuplicate)
    // is still the payment: the pending side is the possible replacement,
    // never counted. Without the hold it would be spent beside the reserve.
    if (tx.pendingPostedAmbiguous === true) continue;
    const localId = existingLocalId(tx.providerTransactionId);
    if (!localId || (linkedLocalIds && linkedLocalIds.has(localId))) continue;
    const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
    if (atlasAccountRole(mapping) !== 'household-cash') continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    const date = parseIsoDate(tx.date);
    if (!(Number.isFinite(amount) && amount > 0) || !date) continue;
    if (!competingRow(date)) futurePosted.add(localId);
    const found = [];
    for (const rule of rules) {
      if (!mapping.canonical || mapping.canonical.id !== rule.atlasAccountId) continue;
      if (!ruleMatchesTransactionIdentity(tx, rule) || !ruleCurrencyQualified(tx, rule)) continue;
      const near = nearestBillOccurrence(plan, rule.eventId, date);
      if (near && near.off <= near.reach && competingRow(date)) postedNear.add(rule.eventId + '@' + near.date);
      // Same-day identity is the matcher's to settle or leave ambiguous.
      if (!near || near.off < 1 || near.off > near.reach) continue;
      found.push({ id: rule.eventId, date: near.date, offsetDays: near.offsetDays });
    }
    const unique = found.filter((f, i, all) => all.findIndex(g => g.id === f.id && g.date === f.date) === i)
      .filter(f => !settled.has(f.id + '@' + f.date) && !insideOpening(f.id, f.date)
        && (!pendingOnly.has(f.id + '@' + f.date) || pendingCopyOf(f.id + '@' + f.date, amount))
        && billDebitAmountConsistent(rules.find(rule => rule.eventId === f.id), amount,
          (scheduledOccurrence(plan, f.id, f.date)[0] || {}).amount));
    if (unique.length === 1) {
      out.set(localId, pendingOnly.has(unique[0].id + '@' + unique[0].date)
        ? { ...unique[0], pendingOnlyOccurrence: true } : unique[0]);
    }
    eligibleDebit.set(localId, amount);
  }
  // Finish-line audit finding 2: several same-day identity debits for one
  // occurrence are left ambiguous by the matcher, which settles none of them.
  // They are that bill's probable payments, so each is named as a
  // to-confirm candidate the same way (offsetDays 0, ambiguous), instead of
  // every one of them landing in Other while the bill also stays reserved.
  for (const group of (opts && opts.ambiguousGroups) || []) {
    if (!group || !group.id || !group.date || group.reason !== 'multiple-compatible-candidates') continue;
    if (!rules.some(rule => rule.eventId === group.id)) continue;
    if (settled.has(group.id + '@' + group.date) || insideOpening(group.id, group.date)) continue;
    for (const hit of group.hits || []) {
      if (!hit || hit.direction !== 'debit') continue;
      for (const rawId of candidateTransactionIds(hit)) {
        const localId = existingLocalId(rawId);
        if (!localId || out.has(localId) || !eligibleDebit.has(localId)) continue;
        out.set(localId, { id: group.id, date: group.date,
          offsetDays: Forecast.diffDays(group.date, hit.postingDate || group.date), ambiguous: true });
      }
    }
  }
  // When two or more debits are named for one occurrence, each held debit
  // stands in for the same reserve. Largest first (then date, then id): the
  // largest is held as the payment (final rule-6 design call on #1070), and
  // each other debit is held only while the running total stays within the
  // scheduled amount; any other candidate stays ordinary spending, counted
  // once. A lone candidate is not capped (rule-6 design
  // call on #1070): within the amount gate above it is held as before, so
  // an above-plan variable bill paid off its date is one held payment, not
  // spending beside a reserve. Amount-at-least rules (card minimums) keep
  // their own semantics.
  const byOccurrence = new Map();
  for (const [localId, f] of out) {
    const key = f.id + '@' + f.date;
    const list = byOccurrence.get(key) || [];
    list.push({ localId, f, amount: eligibleDebit.get(localId) });
    byOccurrence.set(key, list);
  }
  for (const list of byOccurrence.values()) {
    if (list.length < 2) continue;
    const { id, date } = list[0].f;
    if (rules.some(rule => rule.eventId === id && rule.settlesWhen === SETTLES_WHEN_AMOUNT_AT_LEAST)) continue;
    const reserve = Math.abs(Number((scheduledOccurrence(plan, id, date)[0] || {}).amount));
    if (!(Number.isFinite(reserve) && reserve > 0)) continue;
    list.sort((a, b) => b.amount - a.amount || String(a.f.date).localeCompare(String(b.f.date))
      || String(a.localId).localeCompare(String(b.localId)));
    // The largest candidate is always held: it already passed the amount
    // gate, so it is the occurrence's payment, as a lone candidate would be.
    // The rest are held only within the reserve it leaves, so a smaller
    // charge is never held in place of the payment.
    let held = list[0].amount;
    for (const row of list.slice(1)) {
      if (held + row.amount <= reserve + IDENTITY_AMOUNT_EPSILON) held += row.amount;
      else out.delete(row.localId);
    }
  }
  // The lone pending debit (lead ruling above). Held only when it names
  // exactly one occurrence, no other pending identity debit names that
  // occurrence, no posted identity debit is within its reach, nothing
  // settled or already stands on it (a matched payment, the opening, a
  // pending-only row on the due date), it is off the due date, and it passes
  // the bill's amount gate. Anything else (two pendings for one bill, one
  // pending that fits two bills) keeps its incumbent path: ordinary spending
  // beside the reserve, the cautious reading. It carries pendingDebit, so
  // Forecast keeps the category remaining claim classified-incomplete while
  // it is pending. The pending-copy pairing's addPosted skips pending rows, so
  // it is never read there as a posted payment.
  const pendingPerOccurrence = new Map();
  for (const c of pendingCandidates) {
    if (!c.counts) continue;
    for (const f of c.found.filter((f, i, all) => all.findIndex(g => g.id === f.id && g.date === f.date) === i)) {
      const key = f.id + '@' + f.date;
      pendingPerOccurrence.set(key, (pendingPerOccurrence.get(key) || 0) + 1);
    }
  }
  const heldOccurrences = new Set([...out].filter(([localId]) => !futurePosted.has(localId))
    .map(([, f]) => f.id + '@' + f.date));
  // Every veto this branch reads is bounded to evidence effective at the
  // observation date, for this branch only (Atlas, #1400; the posted path's
  // own sets above are unchanged): postedNear, the pending count and
  // heldOccurrences already read rows through observedOn; settledNow and
  // pendingOnlyNow read a represented row only when its transaction is
  // dated (postedOn) on or before observedOn, so a future due-day payment,
  // posted or pending, never vetoes a current lone pending; opening rows are
  // already read effective by observedOn; insideOpeningNow reads the opening
  // boundary only when it is not after observedOn.
  const effectiveRow = row => !observedOn || (parseIsoDate(row.postedOn || row.date) || '') <= observedOn;
  const settledNow = new Set();
  const pendingOnlyNow = new Set();
  for (const row of representedActuals || []) {
    if (!row || !row.id || !row.date || !effectiveRow(row)) continue;
    (row.pending === true ? pendingOnlyNow : settledNow).add(row.id + '@' + row.date);
  }
  for (const row of (opening && opening.representedEvents) || []) {
    if (!row || !row.id || !row.date) continue;
    if (observedOn && !Forecast.representedEventEffectiveBy(row, observedOn)) continue;
    settledNow.add(row.id + '@' + row.date);
  }
  const insideOpeningNow = (id, date) => insideOpening(id, date) && (!observedOn || openingBoundary <= observedOn);
  for (const c of pendingCandidates) {
    // A pending dated after the observation date is not yet evidence either.
    if (!c.counts) continue;
    const unique = c.found.filter((f, i, all) => all.findIndex(g => g.id === f.id && g.date === f.date) === i);
    if (unique.length !== 1) continue;
    const f = unique[0];
    const key = f.id + '@' + f.date;
    if (f.off < 1 || pendingPerOccurrence.get(key) !== 1 || postedNear.has(key) || heldOccurrences.has(key)) continue;
    if (settledNow.has(key) || insideOpeningNow(f.id, f.date) || pendingOnlyNow.has(key)) continue;
    if (!billDebitAmountConsistent(rules.find(rule => rule.eventId === f.id), c.amount,
      (scheduledOccurrence(plan, f.id, f.date)[0] || {}).amount)) continue;
    out.set(c.localId, { id: f.id, date: f.date, offsetDays: f.offsetDays, pendingDebit: true });
  }
  return out;
}

// Lead dispatch 2026-11-18 (after #1315): a bill payment first seen pending
// on one day and posted on a later day, with no provider link between the two
// rows, is one payment. The same-day pairing (flagUnresolvedPendingPostedDuplicates)
// needs equal dates, and a pending identity debit off the due date is never a
// near-due candidate, so the pending copy was spent beside the bill's reserve
// or its payment. Here, per occurrence of one bill: exactly one unlinked
// pending identity debit, within the occurrence's near-due reach (due date
// included), and exactly one posted payment for that occurrence (the
// matcher's posted settlement or a held near-due candidate), on the same
// account, at the same amount to the cent, the pending dated on or before the
// posted. The pending side takes the existing pendingPostedDuplicate
// treatment (the posted payment counts once; the pending row stays listed as
// an unresolved possible replacement, never spent and never dropped) and is
// also marked pendingBillCopy, so the two places where an unresolved pending
// row keeps a figure cautious still read it that way: an unclassified copy
// still makes the category remaining claim classified-incomplete, and a copy
// in the opening-to-payday gap still leaves that gap unproven. A pending row
// the same-day pairing already flagged is marked too when it pairs here. The
// posted payment is not flagged, so every consumer reads it as before.
// Anything else (two pendings, two posted payments, a pending after the
// posted row, a different amount or account) is left as it was.
function pendingBillCopyIds(collapsed, opts, linkedLocalIds, existingLocalId, representedActuals, nearDueBills) {
  const out = new Set();
  const window = opts && opts.transactionWindow;
  if (window && window.complete === false) return out;
  const plan = (opts && (opts.planForIdentity || opts.plan)) || null;
  const mapDoc = opts && opts.accountMap;
  const rules = nearDueIdentityRules(opts, plan);
  // Codex P2 on #1319: a posted row dated after the observation date is not
  // yet in the period's actuals, so it is never evidence that a current
  // pending row is its copy.
  const observedOn = parseIsoDate(opts && opts.asOf);
  if (!plan || !rules.length || !mapDoc || !observedOn) return out;
  const byLocal = new Map();
  for (const tx of collapsed || []) {
    const localId = tx && existingLocalId(tx.providerTransactionId);
    if (localId) byLocal.set(localId, tx);
  }
  const posted = new Map();
  const addPosted = (key, localId) => {
    const tx = byLocal.get(localId);
    if (!tx || tx.pending === true) return;
    const amount = lunchMoneyDebitAmount(tx.amount);
    const date = parseIsoDate(tx.date);
    if (!(Number.isFinite(amount) && amount > 0) || !date || date > observedOn) return;
    const list = posted.get(key) || [];
    if (!list.some(row => row.localId === localId)) list.push({ localId, amount, date, account: String(tx.providerAccountId) });
    posted.set(key, list);
  };
  for (const row of representedActuals || []) {
    if (!row || row.pending === true || !row.id || !row.date || !rules.some(rule => rule.eventId === row.id)) continue;
    for (const localId of [].concat(row.transactionIds || (row.transactionId ? [row.transactionId] : []))) {
      addPosted(row.id + '@' + row.date, localId);
    }
  }
  for (const [localId, f] of nearDueBills || []) addPosted(f.id + '@' + f.date, localId);
  const pending = new Map();
  for (const tx of collapsed || []) {
    if (!tx || tx.pending !== true || tx.contradictoryEvidence === true || tx.pendingPostedAmbiguous === true) continue;
    const localId = existingLocalId(tx.providerTransactionId);
    if (!localId || (linkedLocalIds && linkedLocalIds.has(localId))) continue;
    const mapping = mappingFor(mapDoc, tx.providerAccountId);
    if (atlasAccountRole(mapping) !== 'household-cash' || !mapping.canonical) continue;
    const amount = lunchMoneyDebitAmount(tx.amount);
    const date = parseIsoDate(tx.date);
    if (!(Number.isFinite(amount) && amount > 0) || !date) continue;
    const keys = new Set();
    for (const rule of rules) {
      if (mapping.canonical.id !== rule.atlasAccountId) continue;
      // A pending row has no posted receipt: like the pending-bill disclosure
      // (collectIdentityHits), it reads the rule's identity fields only, and a
      // rule that requires posted evidence still never pairs it.
      if (!matchesIdentityFields(tx, rule) || !ruleCurrencyQualified(tx, rule)) continue;
      const near = nearestBillOccurrence(plan, rule.eventId, date);
      if (!near || near.off > near.reach) continue;
      keys.add(rule.eventId + '@' + near.date);
    }
    if (keys.size !== 1) continue;
    const key = [...keys][0];
    const list = pending.get(key) || [];
    list.push({ localId, amount, date, account: String(tx.providerAccountId) });
    pending.set(key, list);
  }
  for (const [key, pendings] of pending) {
    const posts = posted.get(key) || [];
    if (pendings.length !== 1 || posts.length !== 1) continue;
    const [p] = pendings, [q] = posts;
    if (p.account !== q.account || Math.abs(p.amount - q.amount) > IDENTITY_AMOUNT_EPSILON || p.date > q.date) continue;
    out.add(p.localId);
  }
  return out;
}

// A payment linked to a bill that doesn't fit it (Grok, Plan #6, 2026-11-17).
// A posted row whose recurring link or single "item:" note names exactly one
// bill, but which that bill's rule rejected, stays counted once as ordinary
// money out (no payee fallback; neither bill settles). This names, for the
// row's display only, the linked bill and the first gate that failed:
// account, currency, direction, date or amount. Nothing reads it for math.
// A row whose two links name different bills is the consumed-twice path and
// is not named here; nor is a row whose gates all pass (its occurrence was
// left unsettled for another reason, so no single check can be named), nor
// a near-due candidate, which is already named on its bill.
function linkedBillMisfitIds(collapsed, opts, linkedLocalIds, existingLocalId) {
  const out = new Map();
  const plan = (opts && (opts.planForIdentity || opts.plan)) || null;
  const mapDoc = opts && opts.accountMap;
  const rules = stampRuleSetClaims(opts && opts.identityRules).filter(rule => rule && rule.eventId
    && (ruleLunchMoneyRecurringIds(rule).length || ruleLunchMoneyItemNames(rule).length
      || ruleCategoryClaims(rule).length)
    && isBillOrObligationEvent(plan, rule.eventId));
  if (!plan || !mapDoc || !rules.length) return out;
  const billLabel = id => {
    const row = [].concat(plan.bills || [], plan.obligations || []).find(r => r && r.id === id);
    return row && typeof row.label === 'string' && row.label.trim() ? row.label.trim() : null;
  };
  for (const tx of collapsed || []) {
    if (!tx || tx.pending === true || tx.contradictoryEvidence === true) continue;
    if (tx.pendingPostedDuplicate === true || tx.pendingPostedAmbiguous === true) continue;
    const localId = existingLocalId(tx.providerTransactionId);
    if (!localId || (linkedLocalIds && linkedLocalIds.has(localId))) continue;
    const linkedTo = tx.recurringId == null ? '' : String(tx.recurringId).trim();
    const items = noteItemNames(tx.notes);
    const byRecurring = rules.filter(rule => linkedTo && ruleLunchMoneyRecurringIds(rule).includes(linkedTo));
    const byItem = rules.filter(rule => items.length === 1 && ruleLunchMoneyItemNames(rule).includes(items[0]));
    const owners = byRecurring.concat(byItem.filter(rule => !byRecurring.includes(rule)));
    const ids = Array.from(new Set(owners.map(rule => rule.eventId)));
    // Grok Bot (after #1265): a recurring link and an item note naming different bills settle
    // neither; the payment is money out to confirm, and its line names both bills.
    // Lead (on #1267): the two naming notes below are for money out only; a refund gets neither.
    const moneyOut = lunchMoneyDebitAmount(tx.amount) > 0;
    const recurringIds = Array.from(new Set(byRecurring.map(rule => rule.eventId)));
    const itemIds = Array.from(new Set(byItem.map(rule => rule.eventId)));
    if (recurringIds.length === 1 && itemIds.length === 1 && recurringIds[0] !== itemIds[0]) {
      if (moneyOut) out.set(localId, { id: recurringIds[0], label: billLabel(recurringIds[0]),
        otherId: itemIds[0], otherLabel: billLabel(itemIds[0]), check: 'links disagree' });
      continue;
    }
    if (!ids.length) {
      // Grok Bot (after #1264): a claimed single-bill category renamed (or removed) since Dale
      // confirmed it links nothing and reads To confirm; its line names the category.
      const categoryId = tx.categoryId == null ? '' : String(tx.categoryId).trim();
      const claimants = categoryId ? rules.filter(rule => ruleCategoryClaims(rule).includes(categoryId)) : [];
      if (moneyOut && claimants.length === 1 && !categoryNameConfirmed(claimants[0], categoryId, tx.categoryLabel)) {
        const name = typeof tx.categoryLabel === 'string' && tx.categoryLabel.trim() ? tx.categoryLabel.trim() : null;
        // Removed (no ledger name): the last name Dale confirmed for that id, when exactly one is recorded.
        const confirmed = name ? null : confirmedCategoryName(claimants[0], categoryId);
        out.set(localId, { id: claimants[0].eventId, label: billLabel(claimants[0].eventId), check: 'category',
          categoryName: name, ...(confirmed ? { confirmedCategoryName: confirmed } : {}) });
      }
      continue;
    }
    if (ids.length !== 1) continue;
    const check = linkedBillFirstFailedCheck(tx, owners, plan, mapDoc);
    if (check) out.set(localId, { id: ids[0], label: billLabel(ids[0]), check });
  }
  return out;
}

function linkedBillFirstFailedCheck(tx, rules, plan, mapDoc) {
  const mapping = mappingFor(mapDoc, tx.providerAccountId);
  const accountId = mapping && mapping.canonical && mapping.canonical.id;
  const amount = lunchMoneyDebitAmount(tx.amount);
  const order = ['account', 'currency', 'direction', 'date', 'amount'];
  let best = null;
  for (const rule of rules) {
    let failed = null;
    if (!accountId || (rule.atlasAccountId && accountId !== rule.atlasAccountId)) failed = 'account';
    else if (!ruleCurrencyQualified(tx, rule)) failed = 'currency';
    else if ((rule.direction === 'credit' && !(amount < 0)) || (rule.direction === 'debit' && !(amount > 0))) {
      failed = 'direction';
    } else {
      const dates = coveringScheduledDates(plan, rule, tx.date, tx)
        .filter(date => postingDateRelation(date, tx.date, rule, tx)
          && scheduledOccurrence(plan, rule.eventId, date).length === 1);
      if (!dates.length) failed = 'date';
      else if (!dates.some(date => linkedBillAmountFits(rule, amount, scheduledOccurrence(plan, rule.eventId, date)))) {
        failed = 'amount';
      } else return null;
    }
    if (best == null || order.indexOf(failed) > order.indexOf(best)) best = failed;
  }
  return best;
}

function linkedBillAmountFits(rule, amount, scheduled) {
  const need = Math.abs(Number(scheduled[0].amount));
  if (rule.settlesWhen === SETTLES_WHEN_AMOUNT_AT_LEAST && !(Math.abs(amount) + IDENTITY_AMOUNT_EPSILON >= need)) return false;
  if (rule.settlesWhen === SETTLES_WHEN_EXACT_SCHEDULED_AMOUNT
    && !(isFinite(need) && isFinite(amount) && Math.abs(Math.abs(amount) - need) <= IDENTITY_AMOUNT_EPSILON)) return false;
  return billDebitAmountConsistent(rule, amount, scheduled[0].amount);
}

function pendingOnlyBillActuals(collapsed, opts, representedActuals, existingLocalId) {
  const window = opts && opts.transactionWindow;
  if (window && window.complete === false) return [];
  const rules = stampRuleSetClaims(opts && opts.identityRules).filter(ruleHasIdentity);
  if (!rules.length) return [];
  const plan = (opts && (opts.planForIdentity || opts.plan)) || null;
  const mapDoc = opts && opts.accountMap;
  const taken = new Set((representedActuals || [])
    .filter(row => row && row.id && row.date)
    .map(row => row.id + '@' + row.date));
  const groups = new Map();
  for (const tx of collapsed || []) {
    if (!tx || tx.pending !== true || tx.contradictoryEvidence === true) continue;
    if (tx.pendingPostedDuplicate === true || tx.pendingPostedAmbiguous === true) continue;
    const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
    if (atlasAccountRole(mapping) !== 'household-cash') continue;
    const hits = collectIdentityHits(tx, {
      accountMap: mapDoc,
      plan,
      identityRules: rules,
      transactions: collapsed,
    }, rules).filter(hit => hit
      && !hit.settlesWhen
      && hit.sameAccountSplitLegs !== true
      // A pending debit under the opt-in late window is identity, never
      // settlement: only a posted debit settles it (#918 review).
      && hit.lateWindow !== true
      && isBillOrObligationEvent(plan, hit.id));
    if (hits.length !== 1) continue;
    const key = hits[0].id + '@' + hits[0].date;
    if (taken.has(key)) continue;
    const localId = existingLocalId(hits[0].providerTransactionId);
    if (!localId) continue;
    const list = groups.get(key) || [];
    list.push({ hit: hits[0], localId });
    groups.set(key, list);
  }
  const rows = [];
  for (const list of groups.values()) {
    if (list.length !== 1) continue;
    const hit = list[0].hit;
    const amt = Number(hit.observedAmount);
    if (!isFinite(amt)) continue;
    rows.push({
      id: hit.id,
      date: hit.date,
      actual: Math.round(amt * 100) / 100,
      postedOn: hit.postingDate || hit.date,
      transactionId: list[0].localId,
      // A pending debit is linked evidence, never a payment: Forecast reads this mark and shows 'Payment pending', never Paid.
      pending: true,
    });
  }
  return rows;
}

function cardCoverageReference(tx) {
  if (!tx || !tx.providerAccountId || !tx.providerTransactionId) return null;
  const native = plaidPendingTransactionIdOf(tx) || plaidTransactionIdOf(tx);
  const source = native ? 'plaid:' + native : 'lunchmoney:' + tx.providerTransactionId;
  return 'pc-' + require('crypto').createHash('sha256')
    .update('atlas-card-coverage/v1|' + tx.providerAccountId + '|' + source).digest('hex').slice(0, 24);
}

// Reviewed Lunch Money recurring items (owner, #821 6956651970), reduced to
// schedule fields. FOUNDATION — NOT COMPLETION: no Forecast or page code reads
// this block yet (consumer S2, which waits on Grok Bot under rule 17). Kept:
// only status 'reviewed' items whose id a transaction-identity rule names in
// lunchMoneyRecurringIds. Every other item is dropped and counted by reason
// only. No payee, description, notes, category, amount or provider account id
// leaves; found transactions are this packet's local ids, never provider ids.
// An item whose schedule fields did not validate is dropped (fail closed).
const RECURRING_ITEM_KEYS = Object.freeze(['recurringId', 'granularity', 'quantity', 'anchorDate',
  'startDate', 'endDate', 'currency', 'accountRole', 'expectedDates', 'foundTransactionLocalIds']);
const RECURRING_DROP_REASONS = Object.freeze(['not-reviewed', 'not-named', 'schedule-invalid']);
const RECURRING_SCHEDULE_FIELDS = new Set(['status', 'criteria', 'criteria.startDate', 'criteria.endDate',
  'criteria.granularity', 'criteria.quantity', 'criteria.anchorDate', 'criteria.currency',
  'criteria.plaidAccountId', 'criteria.manualAccountId', 'matches', 'matches.expectedOccurrenceDates',
  'matches.foundTransactions']);
// Each reviewed, named item the review does not apply is recorded where it
// is refused, with its Atlas plan row (only when exactly one plan row has the
// one event id that names it, else null) and one closed reason code (lead
// dispatch 2026-11-17 part (b), Option S). No provider id, amount or date.
const RECURRING_REFUSAL_CODES = Object.freeze(['not-started', 'rule-names-no-event', 'several-rules', 'several-items',
  'no-plan-row', 'plan-row-ambiguous', 'plan-row-unsupported', 'once-bill', 'account-mismatch', 'date-invalid',
  'item-ended', 'cadence-unmapped', 'cadence-amount-unconfirmed', 'day-after-statement-due', 'cutover-unsafe',
  'expected-dates-mismatch', 'link-anchor-missing']);
const RECURRING_REFUSAL_KEYS = Object.freeze(['billId', 'obligationId', 'reasonCode']);
// The plan-id shape a served refusal may carry: lowercase, starting with a
// letter, letters, digits and hyphens. An all-digit Lunch Money id never fits.
function recurringRefusalPlanId(v) {
  return typeof v === 'string' && v.length <= 64 && /^[a-z][a-z0-9-]*$/.test(v);
}
// Reviewed Lunch Money items no identity rule names (lead dispatch, 2026-11-20): so the owner's team can write the
// lunchMoneyRecurringIds links, each is listed with its numeric id and its schedule only: granularity, quantity, anchor,
// start and end dates, the Atlas role of its account, and the dates of the transactions Lunch Money found for it in the
// window. No payee, description, amount, notes, category, currency, provider account id or transaction id leaves. An item
// whose schedule did not read is listed as unavailable (its id only), never guessed. Suggestions (not reviewed) are not here.
const RECURRING_UNNAMED_READ_KEYS = Object.freeze(['recurringId', 'status', 'granularity', 'quantity', 'anchorDate', 'startDate',
  'endDate', 'accountRole', 'foundDates']);
const RECURRING_UNNAMED_UNAVAILABLE_KEYS = Object.freeze(['recurringId', 'status', 'reason']);
const RECURRING_UNNAMED_ROLES = Object.freeze(['household-cash', 'household-reserve', 'revolving-credit', 'heloc', 'mortgage',
  EXTERNAL_LIVE_ROLE, 'unmapped']);
function recurringUnnamedEntryLooksSanitized(entry) {
  const keysAre = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && realIsoDay(v);
  if (!entry || typeof entry !== 'object' || typeof entry.recurringId !== 'string' || !/^\d+$/.test(entry.recurringId)) return false;
  if (entry.status === 'unavailable') return keysAre(entry, RECURRING_UNNAMED_UNAVAILABLE_KEYS) && entry.reason === 'schedule-unreadable';
  return entry.status === 'read' && keysAre(entry, RECURRING_UNNAMED_READ_KEYS)
    && ['day', 'week', 'month', 'year'].includes(entry.granularity)
    && Number.isSafeInteger(entry.quantity) && entry.quantity >= 1
    && date(entry.anchorDate)
    && (entry.startDate === null || date(entry.startDate)) && (entry.endDate === null || date(entry.endDate))
    && (entry.accountRole === null || RECURRING_UNNAMED_ROLES.includes(entry.accountRole))
    && Array.isArray(entry.foundDates) && entry.foundDates.every(date)
    && entry.foundDates.every((d, i) => i === 0 || entry.foundDates[i - 1] < d);
}
// One reviewed, unnamed item as its closed entry; null when its id is not a Lunch Money recurring id (it is then only counted).
function unnamedRecurringEntry(item, opts) {
  const id = item && item.providerId != null ? String(item.providerId) : '';
  if (!/^\d+$/.test(id)) return null;
  const unreadable = { recurringId: id, status: 'unavailable', reason: 'schedule-unreadable' };
  const c = item.criteria, m = item.matches;
  const broken = (item.unavailableFields || []).some(field => RECURRING_SCHEDULE_FIELDS.has(field)
    || [...RECURRING_SCHEDULE_FIELDS].some(prefix => field.startsWith(prefix + '.')));
  const found = m && Array.isArray(m.foundTransactions) ? m.foundTransactions : null;
  if (broken || !c || !found) return unreadable;
  const providerAccountId = c.plaidAccountId != null ? c.plaidAccountId : c.manualAccountId;
  const entry = { recurringId: id, status: 'read', granularity: c.granularity, quantity: c.quantity, anchorDate: c.anchorDate,
    startDate: c.startDate == null ? null : c.startDate, endDate: c.endDate == null ? null : c.endDate,
    accountRole: providerAccountId == null ? null : atlasAccountRole(mappingFor((opts && opts.accountMap) || {}, providerAccountId)),
    foundDates: Array.from(new Set(found.map(f => f && f.date))).sort() };
  return recurringUnnamedEntryLooksSanitized(entry) ? entry : unreadable;
}

function sanitizedRecurringEvidence(raw, opts) {
  if (raw == null) return null;
  // A response that claims to continue beyond what it returned (paging keys
  // the contract does not have) may be missing items: the read is unavailable.
  if (raw.status !== 'read' || !raw.read || !Array.isArray(raw.read.items)
    || raw.read.unexpectedPaginationEvidence !== false) {
    return { source: 'provider-observe:lunchmoney', status: 'unavailable', reason: 'recurring-read-failed' };
  }
  const named = new Set();
  for (const rule of opts.identityRules || []) for (const id of ruleLunchMoneyRecurringIds(rule)) named.add(id);
  const dropped = Object.fromEntries(RECURRING_DROP_REASONS.map(reason => [reason, 0]));
  const items = [];
  const unnamed = [];
  for (const item of raw.read.items) {
    if (!item || item.status !== 'reviewed') { dropped['not-reviewed'] += 1; continue; }
    if (!named.has(String(item.providerId))) {
      dropped['not-named'] += 1;
      const entry = unnamedRecurringEntry(item, opts);
      if (entry) unnamed.push(entry);
      continue;
    }
    const c = item.criteria, m = item.matches;
    const broken = (item.unavailableFields || []).some(field => RECURRING_SCHEDULE_FIELDS.has(field)
      || [...RECURRING_SCHEDULE_FIELDS].some(prefix => field.startsWith(prefix + '.')));
    const expected = m && Array.isArray(m.expectedOccurrenceDates) ? m.expectedOccurrenceDates : null;
    const found = m && Array.isArray(m.foundTransactions) ? m.foundTransactions : null;
    if (broken || !c || !c.granularity || !c.quantity || !c.anchorDate || !c.currency || !expected || !found
      || !expected.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
      dropped['schedule-invalid'] += 1; continue;
    }
    const providerAccountId = c.plaidAccountId != null ? c.plaidAccountId : c.manualAccountId;
    items.push({
      recurringId: String(item.providerId),
      granularity: c.granularity,
      quantity: c.quantity,
      anchorDate: c.anchorDate,
      startDate: c.startDate == null ? null : c.startDate,
      endDate: c.endDate == null ? null : c.endDate,
      currency: c.currency.toLowerCase(),
      accountRole: providerAccountId == null ? null : atlasAccountRole(mappingFor(opts.accountMap || {}, providerAccountId)),
      expectedDates: expected.slice(),
      // Only rows this packet carries: a found transaction outside it has no local id.
      foundTransactionLocalIds: Array.from(new Set(found.map(f => f && f.transactionId != null
        ? opts.existingLocalId(f.transactionId) : null).filter(Boolean))),
    });
  }
  // The review's refusals, copied field by field into the closed shape. An
  // id outside the plan-id shape reads null for that entry only, and an
  // entry without a closed code is left out, so one bad entry never fails
  // the whole block (recurringEvidenceLooksSanitized stays strict).
  const refused = (Array.isArray(opts.refused) ? opts.refused : [])
    .filter(r => r && RECURRING_REFUSAL_CODES.includes(r.reasonCode))
    .map(r => {
      const billId = recurringRefusalPlanId(r.billId) ? r.billId : null;
      const obligationId = recurringRefusalPlanId(r.obligationId) ? r.obligationId : null;
      return { billId, obligationId: billId ? null : obligationId, reasonCode: r.reasonCode };
    });
  return { source: 'provider-observe:lunchmoney', status: 'read',
    window: { startDate: raw.read.requestedWindow?.startDate ?? null, endDate: raw.read.requestedWindow?.endDate ?? null },
    items, dropped, refused, unnamed };
}

// S2 (owner decision #821 6956651970 (a)/(b): a REVIEWED Lunch Money
// recurring item is the authority for its bill's schedule, and "reviewed"
// confirms the schedule only). The amount, firstDue and the amount tag stay
// the plan's. Settlement is decided elsewhere (identity rules, and for an
// opt-in rule Lunch Money's own matches).
// Day leads (owner decision, Dale 2026-11-17: "no friction if the date
// drifts"): the item's anchor day leads every future occurrence, tagged
// confirmed, even when it differs from the plan's day.
// Cadence leads (owner decision, Dale 2026-11-18): the item's cadence leads
// too, wherever Forecast expands it exactly (recurringItemTiming): monthly,
// quarterly, biweekly and yearly; and an ended item stops the bill after its
// end date (lastDue). This retires Grok Bot's monthly-only cadence guard.
// Any doubt keeps the plan's own cadence, day and tags: an unavailable read,
// a cadence Forecast cannot map, an item not yet started, an item named by
// zero or several rules, a bill named by several items, a once bill, a
// paying account whose role does not match, or expected dates the mapped
// cadence does not produce.
function recurringBillSchedules(block, identityRules, plan, asOf, opts) {
  return recurringBillScheduleReview(block, identityRules, plan, asOf, opts).schedules;
}
// Each reviewed item's expected amount per occurrence (criteria.amount, an
// exact decimal string, or null), keyed by provider id, from the read itself.
// Used only to test consistency; it never becomes a served amount.
function recurringItemAmounts(raw) {
  const out = new Map();
  const items = raw && raw.status === 'read' && raw.read && Array.isArray(raw.read.items) ? raw.read.items : [];
  for (const item of items) {
    if (!item || item.providerId == null) continue;
    const amount = item.criteria && typeof item.criteria.amount === 'string' ? Number(item.criteria.amount) : NaN;
    out.set(String(item.providerId), Number.isFinite(amount) ? amount : null);
  }
  return out;
}
// A real calendar day: the ISO shape and a UTC round trip (no Feb 30).
function realIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
// #1289 blocker 1: a cadence change keeps the plan's per-occurrence amount,
// so it is safe only when the reviewed item expects about that amount each
// time. Consistent means within the bill matchers' share (1.5x) either way.
function recurringAmountConsistent(itemAmount, planAmount) {
  const a = Math.abs(Number(itemAmount)), b = Math.abs(Number(planAmount));
  if (!(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0)) return false;
  return Math.max(a, b) <= Math.min(a, b) * BILL_IDENTITY_AMOUNT_SHARE + IDENTITY_AMOUNT_EPSILON;
}
// The bill-schedule fields a reviewed Lunch Money item may set on the served
// plan (owner decision, Dale 2026-11-18: cadence also comes from Lunch Money).
const RECURRING_TIMING_FIELDS = ['frequency', 'day', 'month', 'anchor', 'lastDue', 'timingBefore'];
// The bill's own cadence fields a cutover keeps for occurrences before it.
const RECURRING_CUTOVER_FIELDS = ['frequency', 'day', 'month', 'anchor'];

// Lunch Money cadence -> a Forecast cadence it can expand exactly; anything
// else is null (the plan's cadence and day stand, estimated).
//   month x1 -> monthly on the anchor day
//   month x3 -> quarterly on the anchor day, phased by the anchor date
//   week  x2 -> biweekly from the anchor date
//   year  x1 -> yearly on the anchor's month and day
function recurringItemTiming(item) {
  const anchor = item.anchorDate;
  const day = Number(anchor.slice(8, 10));
  const month = Number(anchor.slice(5, 7));
  if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) return null;
  if (item.granularity === 'month' && item.quantity === 1) return { frequency: 'monthly', day };
  if (item.granularity === 'month' && item.quantity === 3) return { frequency: 'quarterly', day, anchor };
  if (item.granularity === 'week' && item.quantity === 2) return { frequency: 'biweekly', anchor };
  if (item.granularity === 'year' && item.quantity === 1) return { frequency: 'yearly', month, day };
  return null;
}

// Apply a schedule to one bill row (served plan only): its timing fields are
// replaced by the schedule's, and its date tag becomes confirmed. Amount,
// firstDue and the amount tag stay the plan's.
function applyRecurringSchedule(bill, schedule) {
  const out = { ...bill };
  for (const field of RECURRING_TIMING_FIELDS) delete out[field];
  for (const field of RECURRING_TIMING_FIELDS) if (Object.hasOwn(schedule.timing, field)) out[field] = schedule.timing[field];
  out.dateConfidence = schedule.dateConfidence;
  return out;
}

function recurringBillScheduleReview(block, identityRules, plan, asOf, opts) {
  const refused = [];
  const done = schedules => ({ schedules, refused });
  if (!block || block.status !== 'read' || !Array.isArray(block.items) || !plan || !asOf) return done([]);
  const bills = Array.isArray(plan.bills) ? plan.bills : [];
  const obligations = Array.isArray(plan.obligations) ? plan.obligations : [];
  const rowOf = eventId => {
    const b = eventId == null ? 0 : bills.filter(bill => bill && bill.id === eventId).length;
    const o = eventId == null ? 0 : obligations.filter(row => row && row.id === eventId).length;
    return { billId: b === 1 && o === 0 ? eventId : null, obligationId: o === 1 && b === 0 ? eventId : null };
  };
  const refuse = (eventId, reasonCode) => { refused.push({ ...rowOf(eventId), reasonCode }); };
  const byBill = new Map();
  const linkedFromByBill = new Map();
  for (const item of block.items) {
    const eventIds = new Set();
    for (const rule of identityRules || []) {
      if (ruleLunchMoneyRecurringIds(rule).includes(item.recurringId) && rule.eventId) {
        eventIds.add(String(rule.eventId));
        if (typeof rule.linkedFrom === 'string') linkedFromByBill.set(String(rule.eventId), rule.linkedFrom);
      }
    }
    const only = eventIds.size === 1 ? [...eventIds][0] : null;
    if (item.startDate && item.startDate > asOf) { refuse(only, 'not-started'); continue; }
    if (eventIds.size !== 1) { refuse(null, eventIds.size ? 'several-rules' : 'rule-names-no-event'); continue; }
    byBill.set(only, (byBill.get(only) || []).concat([item]));
  }
  const out = [];
  for (const [billId, items] of byBill) {
    if (items.length !== 1) { for (const _ of items) refuse(billId, 'several-items'); continue; }
    const item = items[0];
    const matches = bills.filter(bill => bill && bill.id === billId);
    const obligationMatches = obligations.filter(row => row && row.id === billId);
    if (!matches.length && obligationMatches.length === 1) {
      const schedule = recurringObligationSchedule(item, obligationMatches[0], plan, asOf);
      if (schedule.refused) refuse(billId, schedule.refused); else out.push(schedule);
      continue;
    }
    if (matches.length !== 1 || obligationMatches.length) {
      refuse(billId, matches.length || obligationMatches.length ? 'plan-row-ambiguous' : 'no-plan-row'); continue;
    }
    if (matches[0].frequency === 'once') { refuse(billId, 'once-bill'); continue; }
    // A bill link without a recorded linkedFrom (an ISO first of a month)
    // changes no timing: fail closed.
    const linkedFrom = linkedFromByBill.get(billId);
    if (!(typeof linkedFrom === 'string' && /^\d{4}-\d{2}-01$/.test(linkedFrom) && realIsoDay(linkedFrom))) {
      refuse(billId, 'link-anchor-missing'); continue;
    }
    const bill = matches[0];
    const cash = ['chequing-a', 'chequing-b'].includes(bill.payingAccount);
    if (!cash || item.accountRole !== 'household-cash') { refuse(billId, 'account-mismatch'); continue; }
    if (!realIsoDay(item.anchorDate) || (item.endDate && !realIsoDay(item.endDate))) { refuse(billId, 'date-invalid'); continue; }
    const timing = recurringItemTiming(item);
    if (!timing) { refuse(billId, 'cadence-unmapped'); continue; }
    // A cadence change leads only when the item's expected amount per
    // occurrence matches the plan's (the amount stays the plan's). A day move
    // on the same cadence cannot change the load and needs no amount.
    if (timing.frequency !== bill.frequency) {
      const amounts = opts && opts.amounts instanceof Map ? opts.amounts : new Map();
      if (!recurringAmountConsistent(amounts.get(item.recurringId), bill.amount)) { refuse(billId, 'cadence-amount-unconfirmed'); continue; }
    }
    // An ended item stops the bill after its end date (lastDue).
    if (item.endDate) timing.lastDue = item.endDate;
    // Every date Lunch Money expects must be one Forecast expands from the
    // mapped timing; otherwise the plan's own cadence stands.
    const probe = { ...timing };
    const expected = item.expectedDates.slice().sort();
    if (expected.length) {
      const dates = Forecast.occurrences(probe, expected[0], expected[expected.length - 1]);
      if (!expected.every(date => dates.includes(date))) { refuse(billId, 'expected-dates-mismatch'); continue; }
    }
    // Recorded history is never re-dated (#1508 live check; lead design
    // ruling on the #1511 review): the cutover is the link's own recorded
    // `linkedFrom` date (the first of a month, set when the link is written),
    // never derived from the observation date, the pay period or the item's
    // start, so it cannot move between observations. Occurrences before it
    // keep the bill's own cadence and day (timingBefore); from it on, the
    // item's timing applies.
    if (RECURRING_CUTOVER_FIELDS.some(field => bill[field] !== timing[field])) {
      const before = {};
      for (const field of RECURRING_CUTOVER_FIELDS) if (bill[field] !== undefined) before[field] = bill[field];
      // The plan's own date tag goes with the plan's own timing: occurrences
      // before the cutover never take the item's confirmed tag (owner stop 2).
      timing.timingBefore = { from: linkedFrom, ...before,
        dateConfidence: bill.dateConfidence === 'confirmed' ? 'confirmed' : 'estimated' };
    }
    out.push({ billId, recurringId: item.recurringId, timing, dateConfidence: 'confirmed', source: 'lunchmoney-recurring' });
  }
  return done(out);
}

// E1 (lead dispatch 2026-11-18, census 4 and 9; option B, cutover): a card
// minimum or the HELOC cash minimum takes its planned day from its reviewed
// Lunch Money item, served plan only. Monthly items on monthly rows only; the
// amount and every tag stay the plan's. Recorded history is never re-dated:
// the new day applies only from the day after the latest recorded statement,
// sent payment or opening representation, and never before the observation
// date (timingBefore / cashTimingBefore keeps the earlier day before it). Any
// doubt keeps the plan:
//   - the row is not a monthly card payment or a monthly HELOC cash leg, or
//     is not paid from household cash, or the item is not monthly, has ended,
//     or has a date that is not a real day;
//   - the day would move past the latest known statement's due day, or, for
//     a card with no known statement, later than its plan day;
//   - an occurrence still due from the cutover would be lost (the first new
//     one must fall in that occurrence's month);
//   - the cutover would put two occurrences in one statement cycle or skip
//     one (the first new occurrence must fall in the calendar month right
//     after the last earlier-day one, between half a month and a month and a
//     half after it);
//   - Lunch Money's expected dates on or after the cutover are not the new
//     day's.
const MONTH_DAYS = 365.25 / 12;
function recurringObligationSchedule(item, row, plan, asOf) {
  const refuse = code => ({ refused: code });
  const card = row.effect === 'payment' && row.debtId && !row.nonCash && row.frequency === 'monthly';
  const heloc = row.nonCash && row.cashDay != null && row.frequency === 'monthly';
  if (!card && !heloc) return refuse('plan-row-unsupported');
  if (!['chequing-a', 'chequing-b'].includes(row.payingAccount) || item.accountRole !== 'household-cash') return refuse('account-mismatch');
  if (!realIsoDay(item.anchorDate)) return refuse('date-invalid');
  if (item.endDate) return refuse('item-ended');
  const timing = recurringItemTiming(item);
  if (!timing || timing.frequency !== 'monthly') return refuse('cadence-unmapped');
  const oldDay = Number(card ? row.day : row.cashDay);
  if (!(oldDay >= 1 && oldDay <= 31)) return refuse('plan-row-unsupported');
  const statements = card && Array.isArray(row.statementOccurrences) ? row.statementOccurrences : [];
  const latestStatement = statements.filter(r => r && realIsoDay(r.dueDate)).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).pop();
  if (latestStatement && timing.day > Number(latestStatement.dueDate.slice(8, 10))) return refuse('day-after-statement-due');
  // With no known statement due day, a card's day may only move earlier.
  if (card && !latestStatement && timing.day > oldDay) return refuse('day-after-statement-due');
  const recorded = [];
  for (const r of statements) for (const d of [r && r.scheduledDate, r && r.dueDate]) if (realIsoDay(d)) recorded.push(d);
  for (const r of (card && Array.isArray(row.sentPayments) ? row.sentPayments : [])) {
    for (const d of [r && r.scheduledDate, r && r.postedOn]) if (realIsoDay(d)) recorded.push(d);
  }
  for (const r of (plan.opening && Array.isArray(plan.opening.representedEvents) ? plan.opening.representedEvents : [])) {
    if (r && r.id === row.id && realIsoDay(r.date)) recorded.push(r.date);
  }
  // The cutover is never before the observation date (#1293 blocker 1): an
  // occurrence still due from today keeps its own day unless the new day
  // replaces it in the same month.
  const latest = recorded.sort().pop() || null;
  const afterRecords = latest ? Forecast.addDays(latest, 1) : null;
  const from = afterRecords && afterRecords > asOf ? afterRecords : asOf;
  const firstDue = card ? row.firstDue : (row.cashFirstDue || row.firstDue);
  const newRow = { frequency: 'monthly', day: timing.day, ...(firstDue ? { firstDue } : {}) };
  if (timing.day !== oldDay) {
    const oldRow = { frequency: 'monthly', day: oldDay, ...(firstDue ? { firstDue } : {}) };
    const last = Forecast.occurrences(oldRow, Forecast.addDays(from, -62), Forecast.addDays(from, -1)).pop();
    const next = Forecast.occurrences(newRow, from, Forecast.addDays(from, 62))[0];
    const oldNext = Forecast.occurrences(oldRow, from, Forecast.addDays(from, 62))[0];
    const monthOf = d => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
    // No occurrence still due may be lost: the first new one replaces the
    // first earlier-day one due from the cutover, in that same month.
    if (oldNext && (!next || monthOf(next) !== monthOf(oldNext))) return refuse('cutover-unsafe');
    if (last && next) {
      // One occurrence per statement cycle: the first new occurrence falls in
      // the calendar month right after the last earlier-day one, and between
      // half a month and a month and a half after it.
      const gap = calendarDaysBetween(last, next);
      if (monthOf(next) !== monthOf(last) + 1 || !(gap >= MONTH_DAYS / 2 && gap <= MONTH_DAYS * 1.5)) return refuse('cutover-unsafe');
    }
  }
  const expected = item.expectedDates.filter(d => !from || d >= from).sort();
  if (expected.length) {
    const dates = Forecast.occurrences({ frequency: 'monthly', day: timing.day }, expected[0], expected[expected.length - 1]);
    if (!expected.every(d => dates.includes(d))) return refuse('expected-dates-mismatch');
  }
  const before = timing.day !== oldDay ? { from, frequency: 'monthly', day: oldDay } : null;
  return { obligationId: row.id, recurringId: item.recurringId, kind: card ? 'card' : 'heloc',
    fields: card ? { day: timing.day, ...(before ? { timingBefore: before } : {}) }
      : { cashDay: timing.day, ...(before ? { cashTimingBefore: before } : {}) },
    source: 'lunchmoney-recurring' };
}
// The obligation fields a schedule may set; the owner-policy guard allows
// exactly these to differ, on a scheduled obligation only.
// Per kind (#1293 note): a card may change only its day and timingBefore, the
// HELOC only its cash day and cashTimingBefore.
const RECURRING_OBLIGATION_FIELDS = { card: ['day', 'timingBefore'], heloc: ['cashDay', 'cashTimingBefore'] };
function applyRecurringObligationSchedule(row, schedule) {
  const out = { ...row };
  for (const field of RECURRING_OBLIGATION_FIELDS[schedule.kind] || []) {
    if (Object.hasOwn(schedule.fields, field)) out[field] = schedule.fields[field];
  }
  return out;
}

// The structural check for that block: exact keys, value types and no
// free text. Anything else marks the packet unsanitized.
// Lunch Money budgets, reduced for the packet (owner decision #821
// 2026-11-18; lead rulings Q1-Q5, and the 2026-11-18 group-id ruling).
// Each plan budget row names its Lunch Money category group by numeric id
// (plan.budget.categories[].lunchMoneyCategoryGroupId, an integer: the one
// authority; an id survives a rename in Lunch Money). The id is checked
// against this observation's own /categories read. An id the read does not
// carry, or carries archived, fails closed for that row
// (group-id-missing); an id that is a category rather than a group fails
// closed too (group-id-not-group). The packet is keyed by Atlas row id, so
// no Lunch Money id leaves.
// Per Lunch Money budget period, each resolved row gets one `budgeted`:
//   - the budget Lunch Money holds on the group itself, when it holds one
//     (level 'group'); otherwise
//   - the sum of the budgets on the group's own categories, skipping
//     categories with none (level 'children'); otherwise
//   - null (no budget set for that period; level null).
// Only `budgeted` (the user's primary currency) is kept: activity,
// available, notes and currency text are dropped. The planned-amount rules
// (cadence, carry-forward) are Forecast's, not this reader's.
const BUDGET_GRANULARITIES = new Set(['day', 'week', 'month', 'year', 'twice a month']);
const BUDGET_UNAVAILABLE_REASONS = new Set(['budget-read-failed', 'budget-settings-invalid', 'budget-summary-invalid']);
const BUDGET_ROW_UNAVAILABLE_REASONS = new Set(['group-id-missing', 'group-id-not-group', 'group-id-invalid',
  'group-id-duplicate', 'row-id-duplicate', 'categories-read-failed']);
// An Atlas row id: lower-case words and hyphens, never all digits (the shape
// of a Lunch Money id).
const BUDGET_ROW_ID = /^(?=[a-z0-9-]*[a-z])[a-z0-9][a-z0-9-]{0,63}$/;
// Atlas row id -> the Lunch Money group id it reads, or the reason it reads
// none, from the plan (lead rulings 2026-11-18). A row that names a group
// (an id or a label) but whose id is not a positive integer is
// group-id-invalid; an Atlas row id used twice is row-id-duplicate; a group
// id two rows share is group-id-duplicate on every sharing row. Each fails
// closed for its own row(s) only. A row naming no group is left out.
function budgetRowGroupIds(plan) {
  const named = [];
  const seenRow = new Map();
  for (const row of (plan && plan.budget && Array.isArray(plan.budget.categories)) ? plan.budget.categories : []) {
    if (!row || typeof row.id !== 'string' || !BUDGET_ROW_ID.test(row.id)) continue;
    seenRow.set(row.id, (seenRow.get(row.id) || 0) + 1);
    const id = row.lunchMoneyCategoryGroupId;
    const names = id !== undefined || row.lunchMoneyCategoryGroupLabel !== undefined;
    if (!names) continue;
    named.push({ rowId: row.id, groupId: Number.isSafeInteger(id) && id > 0 ? String(id) : null });
  }
  const groupUses = new Map();
  for (const n of named) if (n.groupId) groupUses.set(n.groupId, (groupUses.get(n.groupId) || 0) + 1);
  const out = new Map();
  for (const n of named) {
    if (seenRow.get(n.rowId) > 1) out.set(n.rowId, { reason: 'row-id-duplicate' });
    else if (!n.groupId) out.set(n.rowId, { reason: 'group-id-invalid' });
    else if (groupUses.get(n.groupId) > 1) out.set(n.rowId, { reason: 'group-id-duplicate' });
    else out.set(n.rowId, { groupId: n.groupId });
  }
  // A labelled row without an id is only waiting for its id; it names nothing
  // yet and is not published (the shipped plan carries labels before ids).
  for (const row of (plan && plan.budget && Array.isArray(plan.budget.categories)) ? plan.budget.categories : []) {
    if (row && typeof row.id === 'string' && out.has(row.id) && row.lunchMoneyCategoryGroupId === undefined
      && seenRow.get(row.id) === 1) out.delete(row.id);
  }
  return out;
}
function sanitizedBudgetEvidence(raw, rawCategories, plan) {
  if (raw == null) return null;
  const unavailable = reason => ({ source: 'provider-observe:lunchmoney', status: 'unavailable', reason });
  if (raw.status !== 'read') return unavailable('budget-read-failed');
  const settings = raw.settings || {};
  const granularity = settings.budget_period_granularity;
  const quantity = settings.budget_period_quantity;
  const anchorDate = parseIsoDate(settings.budget_period_anchor_date);
  if (!BUDGET_GRANULARITIES.has(granularity) || !Number.isSafeInteger(quantity) || quantity < 1 || !anchorDate) {
    return unavailable('budget-settings-invalid');
  }
  const rows = raw.summary && raw.summary.categories;
  if (!Array.isArray(rows)) return unavailable('budget-summary-invalid');
  // category id -> (period key -> budgeted number | null); every period seen.
  const byCategory = new Map();
  const periods = new Map();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.category_id) || !Array.isArray(row.occurrences)) continue;
    const occ = new Map();
    for (const o of row.occurrences) {
      const start = o && parseIsoDate(o.start_date);
      const end = o && parseIsoDate(o.end_date);
      if (!start || !end || end < start) continue;
      const key = start + '|' + end;
      periods.set(key, { start, end });
      const value = typeof o.budgeted === 'number' && Number.isFinite(o.budgeted) ? o.budgeted : null;
      occ.set(key, value);
    }
    byCategory.set(String(row.category_id), occ);
  }
  // group id -> its own category ids, from the categories catalog (nested
  // children, or a child's group_id); every id the read carries -> whether it
  // is a live group, an archived one, or a category.
  const children = new Map();
  const kinds = new Map();
  const addChild = (groupId, childId) => {
    if (groupId == null || childId == null) return;
    const key = String(groupId);
    if (!children.has(key)) children.set(key, new Set());
    children.get(key).add(String(childId));
  };
  const archived = cat => cat.archived === true || cat.is_archived === true;
  const note = (cat, kind) => { if (!kinds.has(String(cat.id)) || kind === 'group') kinds.set(String(cat.id), kind); };
  for (const cat of Array.isArray(rawCategories) ? rawCategories : []) {
    if (!cat || cat.id == null) continue;
    // An archived category is not part of its group's budget (lead ruling).
    if (cat.is_group === true && Array.isArray(cat.children)) {
      for (const child of cat.children) {
        if (child && child.id != null) {
          if (!archived(child)) addChild(cat.id, child.id);
          note(child, archived(child) ? 'archived' : 'category');
        }
      }
    }
    if (cat.group_id != null && !archived(cat)) addChild(cat.group_id, cat.id);
    note(cat, archived(cat) ? 'archived' : cat.is_group === true ? 'group' : 'category');
  }
  const ordered = [...periods.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const byRow = {};
  const categoriesRead = Array.isArray(rawCategories);
  for (const [rowId, named] of [...budgetRowGroupIds(plan)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (named.reason) { byRow[rowId] = { status: 'unavailable', reason: named.reason }; continue; }
    if (!categoriesRead) { byRow[rowId] = { status: 'unavailable', reason: 'categories-read-failed' }; continue; }
    const groupId = named.groupId;
    const kind = kinds.get(groupId);
    if (kind === 'category') { byRow[rowId] = { status: 'unavailable', reason: 'group-id-not-group' }; continue; }
    if (kind !== 'group') { byRow[rowId] = { status: 'unavailable', reason: 'group-id-missing' }; continue; }
    const own = byCategory.get(groupId);
    const kids = [...(children.get(groupId) || [])];
    byRow[rowId] = { status: 'read', periods: ordered.map(({ start, end }) => {
      const key = start + '|' + end;
      const groupValue = own ? own.get(key) : null;
      if (typeof groupValue === 'number') return { start, end, budgeted: round2(groupValue), level: 'group' };
      const values = kids.map(id => byCategory.get(id)).filter(Boolean)
        .map(occ => occ.get(key)).filter(v => typeof v === 'number');
      if (values.length) return { start, end, budgeted: round2(values.reduce((a, b) => a + b, 0)), level: 'children' };
      return { start, end, budgeted: null, level: null };
    }) };
  }
  return { source: 'provider-observe:lunchmoney', status: 'read', granularity, quantity, anchorDate, byRow };
}

// Structural check for the packet's budget block: exactly the keys above,
// dates as dates, numbers as numbers, Atlas row ids, closed reasons.
// Anything else fails the packet's sanitization and the block is withheld.
function budgetEvidenceLooksSanitized(block) {
  if (block == null) return true;
  if (typeof block !== 'object' || Array.isArray(block)) return false;
  const keys = Object.keys(block).sort().join(',');
  if (block.status === 'unavailable') {
    return keys === 'reason,source,status' && block.source === 'provider-observe:lunchmoney'
      && BUDGET_UNAVAILABLE_REASONS.has(block.reason);
  }
  if (block.status !== 'read' || keys !== 'anchorDate,byRow,granularity,quantity,source,status') return false;
  if (block.source !== 'provider-observe:lunchmoney' || !BUDGET_GRANULARITIES.has(block.granularity)
    || !Number.isSafeInteger(block.quantity) || block.quantity < 1 || !parseIsoDate(block.anchorDate)) return false;
  if (!block.byRow || typeof block.byRow !== 'object' || Array.isArray(block.byRow)) return false;
  for (const [rowId, entry] of Object.entries(block.byRow)) {
    if (!BUDGET_ROW_ID.test(rowId) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const entryKeys = Object.keys(entry).sort().join(',');
    if (entry.status === 'unavailable') {
      if (entryKeys !== 'reason,status' || !BUDGET_ROW_UNAVAILABLE_REASONS.has(entry.reason)) return false;
      continue;
    }
    if (entry.status !== 'read' || entryKeys !== 'periods,status' || !Array.isArray(entry.periods)) return false;
    for (const p of entry.periods) {
      if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== 'budgeted,end,level,start') return false;
      if (!parseIsoDate(p.start) || !parseIsoDate(p.end) || p.end < p.start) return false;
      if (p.budgeted === null ? p.level !== null
        : !(typeof p.budgeted === 'number' && Number.isFinite(p.budgeted) && (p.level === 'group' || p.level === 'children'))) return false;
    }
  }
  return true;
}

function recurringEvidenceLooksSanitized(block) {
  if (block === undefined) return true;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const keysAre = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
    && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (block.source !== 'provider-observe:lunchmoney') return false;
  if (block.status === 'unavailable') {
    return keysAre(block, ['source', 'status', 'reason']) && block.reason === 'recurring-read-failed';
  }
  if (block.status !== 'read' || !keysAre(block, ['source', 'status', 'window', 'items', 'dropped', 'refused', 'unnamed'])) return false;
  if (!Array.isArray(block.unnamed) || !block.unnamed.every(recurringUnnamedEntryLooksSanitized)) return false;
  // A refusal is an Atlas plan row id (never a Lunch Money id, which is all
  // digits) or null, and one closed reason code; nothing else.
  const planId = v => v === null || recurringRefusalPlanId(v);
  if (!Array.isArray(block.refused) || !block.refused.every(r => keysAre(r, RECURRING_REFUSAL_KEYS)
    && planId(r.billId) && planId(r.obligationId) && !(r.billId && r.obligationId)
    && RECURRING_REFUSAL_CODES.includes(r.reasonCode))) return false;
  if (!keysAre(block.window, ['startDate', 'endDate'])
    || !(block.window.startDate === null || date(block.window.startDate))
    || !(block.window.endDate === null || date(block.window.endDate))) return false;
  if (!keysAre(block.dropped, RECURRING_DROP_REASONS)
    || !RECURRING_DROP_REASONS.every(r => Number.isSafeInteger(block.dropped[r]) && block.dropped[r] >= 0)) return false;
  return Array.isArray(block.items) && block.items.every(item => keysAre(item, RECURRING_ITEM_KEYS)
    && typeof item.recurringId === 'string' && /^\d+$/.test(item.recurringId)
    && ['day', 'week', 'month', 'year'].includes(item.granularity)
    && Number.isSafeInteger(item.quantity) && item.quantity >= 1
    && date(item.anchorDate)
    && (item.startDate === null || date(item.startDate)) && (item.endDate === null || date(item.endDate))
    && typeof item.currency === 'string' && /^[a-z]{3}$/.test(item.currency)
    && (item.accountRole === null || ['household-cash', 'household-reserve', 'revolving-credit', 'heloc',
      'mortgage', EXTERNAL_LIVE_ROLE, 'unmapped'].includes(item.accountRole))
    && Array.isArray(item.expectedDates) && item.expectedDates.every(date)
    && Array.isArray(item.foundTransactionLocalIds)
    && item.foundTransactionLocalIds.every(id => typeof id === 'string' && /^tx-\d+$/.test(id)));
}

// The card-minimum owner's export (Forecast.cardMinimumOwnedDebits, the one
// authority), read here so the debit identities stay server-side (lead ruling
// on #1149, 2026-11-17): a row the owner counts carries only a boolean, and the
// packet carries the export's status and what it could not read (an obligation
// label and a word). Refresh-time: a durable record added later is read on the
// next refresh.
function cardMinimumOwnership(plan, evidence, asOf) {
  const owned = Forecast.cardMinimumOwnedDebits(Object.assign({}, plan || {},
    evidence !== undefined ? { cardMinimumCategoryEvidence: evidence } : {}), asOf);
  const sets = owned.status === 'available' ? {
    owned: new Set(owned.debitIds), unknown: new Set(owned.unknownDebitIds || []),
    disagreed: new Set(owned.disagreementDebitIds || []) } : null;
  return {
    status: owned.status === 'available' ? 'available' : 'unavailable',
    unreadable: (owned.unreadable || []).map(item => ({ label: item.label || null, what: item.what })),
    // 'owned' | 'unknown' | 'disagreement' | null for one provider transaction id.
    mark(providerTransactionId) {
      if (!sets || providerTransactionId == null || providerTransactionId === '') return null;
      const id = require('crypto').createHash('sha256')
        .update(MinimumCategory.SOURCE + ':' + providerTransactionId).digest('hex');
      return sets.owned.has(id) ? 'owned' : sets.unknown.has(id) ? 'unknown'
        : sets.disagreed.has(id) ? 'disagreement' : null;
    },
  };
}
function cardMinimumFlags(mark) {
  return mark === 'owned' ? { cardMinimumOwned: true } : mark === 'unknown' ? { cardMinimumUnknown: true }
    : mark === 'disagreement' ? { cardMinimumDisagreement: true } : {};
}
const CARD_MINIMUM_FLAGS = ['cardMinimumOwned', 'cardMinimumUnknown', 'cardMinimumDisagreement'];
// Re-mark the packet's rows from the QUALIFIED minimum evidence (Codex P1 on
// #1388): the pass marks rows before qualifyNotePayments drops a noted minimum
// card coverage did not pair, so a dropped candidate must not stay owned. Rows
// are found through the pass's own join (local id -> provider transaction id).
function restampCardMinimumOwnership(packet, join, plan, evidence) {
  if (!packet || !Array.isArray(packet.transactions)) return packet;
  const ownership = cardMinimumOwnership(plan, evidence, packet.observationAsOf);
  const providerIds = new Map((Array.isArray(join) ? join : []).map(row => [row.localId, row.transactionId]));
  for (const tx of packet.transactions) {
    if (!tx) continue;
    for (const flag of CARD_MINIMUM_FLAGS) delete tx[flag];
    if (!(Number(tx.amount) > 0) || tx.pending === true) continue;
    Object.assign(tx, cardMinimumFlags(ownership.mark(providerIds.get(tx.id))));
  }
  packet.cardMinimumOwnership = ownership.status;
  if (ownership.unreadable.length) packet.cardMinimumUnreadable = ownership.unreadable;
  else delete packet.cardMinimumUnreadable;
  return packet;
}

function sanitizedCurrentPeriodActuals(report, opts) {
  return sanitizedCurrentPeriodActualsPass(report, opts).packet;
}

// The sanitizer pass itself. Alongside the packet it returns the pass's
// own crosswalk provenance (`join`): one entry per packet row actually
// emitted, captured from the exact surviving transaction at emission, in
// emission order — { localId, providerAccountId, transactionId }. Rows the
// pass drops (undated, amount-less, currency-unqualified, collapsed
// predecessors) earn no entry even when the pass assigned them a local id
// for a diagnostic, and linkage-only ids (parent references) earn none
// either. `qualified` reports whether the final packet passed the pass's
// own sanitation check; when it did not, the packet's transactions are
// emptied by the incumbent failure path and the join is not usable.
// N2: per-account sync evidence. Only sync fields count: a statement, balance or
// object-update date is never evidence that the account's transactions arrived.
// Owner 2026-11-10: sync age is informational, never a coverage failure or
// caution. Explicit provider failure and wholly unreadable sync fields still
// fail. Valid sync fields retain the incumbent qualifier without claiming that
// all institutions supplied today's activity. ABSENT when there is no
// usable sync field: that stays as on main (it does not degrade coverage) until the
// production shape is proven. Only field NAMES and booleans are recorded, never values.
const SYNC_FAILURE_STATUSES = new Set(['error', 'relink', 'inactive', 'not found', 'not supported']);
function accountSyncEvidence(accounts, mapDoc, endDay) {
  const out = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || typeof account !== 'object') continue;
    const mapping = mapDoc ? mappingFor(mapDoc, account.providerAccountId) : null;
    const role = atlasAccountRole(mapping);
    if (!COVERAGE_ACCOUNT_ROLES.has(role) || !(mapping.canonical && mapping.canonical.id)) continue;
    const has = key => Object.prototype.hasOwnProperty.call(account, key)
      && account[key] != null && account[key] !== '';
    // The last successful update outranks the last fetch. A present field that does not
    // parse falls back to the next one; if sync fields are present and none parses, the
    // account is failed with a named reason rather than silently absent.
    let syncDay = null;
    for (const key of ['lastSuccessfulUpdate', 'lastFetch']) {
      if (!has(key)) continue;
      syncDay = dateOnly(account[key]);
      if (syncDay) break;
    }
    const syncFieldPresent = has('lastSuccessfulUpdate') || has('lastFetch');
    const status = has('syncStatus') ? String(account.syncStatus).trim().toLowerCase() : null;
    let syncEvidence = 'absent';
    let reason = null;
    if (status && SYNC_FAILURE_STATUSES.has(status)) {
      syncEvidence = 'failed'; reason = 'sync-status-failure';
    } else if (syncFieldPresent && !syncDay) {
      syncEvidence = 'failed'; reason = 'sync-field-unparseable';
    } else if (syncDay && endDay) {
      syncEvidence = 'proven';
    }
    out.push({
      id: String(mapping.canonical.id),
      role,
      syncEvidence,
      ...(reason ? { reason } : {}),
      fields: { last_fetch: has('lastFetch'), plaid_last_successful_update: has('lastSuccessfulUpdate'), status: has('syncStatus') },
    });
  }
  return out;
}

// Display metadata only: the OLDEST successful institution contact among the
// household accounts the page relies on (cash, reserve, cards, HELOC, mortgage).
// "Last updated" can never be fresher than the stalest balance it covers: a card
// that synced today does not make a chequing feed from days ago read as today.
// A fetch request is not success. Never borrow request time or invent a clock
// for a date-only field; invalid/future values earn no display instant. Accounts
// outside the relied-on roles never move it; a relied-on account with no valid
// success time is simply not dated (sync age never blanks a figure).
function lastSuccessfulSyncAt(accounts, mapDoc, fetchedAt) {
  const fetched = Date.parse(fetchedAt);
  let oldest = null;
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account) continue;
    const mapping = mappingFor(mapDoc || {}, account.providerAccountId);
    if (!mapping?.canonical?.id || !COVERAGE_ACCOUNT_ROLES.has(atlasAccountRole(mapping))) continue;
    const value = account.lastSuccessfulUpdate;
    if (typeof value !== 'string' || !value.includes('T') || !dateOnly(value)) continue;
    const instant = Date.parse(value);
    if (!Number.isFinite(instant) || !Number.isFinite(fetched) || instant > fetched) continue;
    if (oldest == null || instant < oldest) oldest = instant;
  }
  return oldest == null ? null : new Date(oldest).toISOString();
}

// A dropped row degrades the window's coverage unless its date proves it lies outside the
// window. An undated row cannot be scoped, so it always counts.
function droppedRowInCoverage(date, window) {
  // The existing date parser decides: a malformed, impossible or non-ISO date cannot be
  // scoped to the window, so it counts exactly like an undated row.
  const day = dateOnly(date);
  if (!day) return true;
  if (window && window.startDate && day < window.startDate) return false;
  if (window && window.endDate && day > window.endDate) return false;
  return true;
}

function sanitizedCurrentPeriodActualsPass(report, opts) {
  opts = opts || {};
  const asOf = dateOnly(opts.asOf || (report && report.fetchedAt));
  const window = (report && report.transactionWindow) || {};
  const collapsed = collapsePendingPostedBySettlementIdentity(
    (report && report.collapsedTransactions)
      || (report && report.transactions)
      || [],
    asOf,
    {
      plan: opts.plan,
      billPaymentPayees: opts.billPaymentPayees,
      accountMap: opts.accountMap,
    }
  );
  const tagsById = tagIndexFromPayload(report);
  const mapDoc = opts.accountMap;
  assertSavingsLinks(mapDoc);
  // The card-minimum owner's export (cardMinimumOwnership below). The pass marks
  // rows with the evidence it is given; the observer assembly re-marks them once
  // the minimum evidence is qualified (restampCardMinimumOwnership).
  const minimumOwnership = cardMinimumOwnership(opts.plan, report && report.cardMinimumCategoryEvidence, asOf);
  const cardMinimumMark = tx => minimumOwnership.mark(tx && tx.providerTransactionId);
  const linkBlock = mapDoc?.savingsLinks;
  const privateLinks = (linkBlock?.links || []).map((link, i) => ({ ...link, ref: 'link-' + (i + 1),
    target: Forecast.savingsLinkTarget(opts.plan, link.goalRef, link.occurrenceDate, linkBlock.anchorRevision, asOf) }));
  const savingsLinks = privateLinks.length ? { source: 'provider-observe:lunchmoney', mode: 'foundation',
    asOf, version: linkBlock.version, anchorRevision: linkBlock.anchorRevision,
    links: privateLinks.map(link => ({ ref: link.ref, type: Object.hasOwn(link, 'categoryId') ? 'category' : 'tag',
      ...link.target, occurrenceDate: link.occurrenceDate, effectiveFrom: link.effectiveFrom,
      effectiveThrough: link.effectiveThrough })), evidence: [] } : null;
  const linkHits = new Map();
  const localByProvider = new Map();
  let localSeq = 0;
  const localIdFor = providerId => {
    if (providerId == null || providerId === '') return null;
    const key = String(providerId);
    if (localByProvider.has(key)) return localByProvider.get(key);
    localSeq += 1;
    const local = 'tx-' + localSeq;
    localByProvider.set(key, local);
    return local;
  };
  const existingLocalId = providerId => {
    if (providerId == null || providerId === '') return null;
    return localByProvider.get(String(providerId)) || null;
  };
  const txs = [];
  const distinctPendingRows = [];
  // U5: emitted group-parent id -> the child provider ids Lunch Money lists for
  // it; emitted row id -> its provider id. Internal to this pass; never emitted.
  const groupChildIds = new Map(), providerIdOfRow = new Map();
  const bankDescriptions = new Map();
  const join = [];
  const currencyUnconfirmed = [];
  let droppedCoverageRows = 0;
  // Count affected source identities once for diagnostics only. The incumbent
  // coverage counter and every financial/qualification predicate stay intact.
  const diagnosticDroppedRows = new Set();
  const noteDroppedRow = tx => diagnosticDroppedRows.add(tx?.providerTransactionId ?? tx);
  // C1 (acceptance 7.6): a dropped row whose household budget category is
  // certain withholds that category only (droppedCategoryRows, published
  // below); every other dropped row withholds coverage globally, as before.
  const droppedCategoryRows = [];
  const localizedDropIds = new Set();
  const rawAmountDrops = [];
  const cardCoverageUnconfirmed = [];
  const outgoingETransferUnconfirmed = [];
  // Outgoing e-transfer descriptor identity (Atlas decision, 2026-10-12),
  // shared by the surviving-row boolean below and the unprocessable-
  // candidate diagnostic in the amount guard: computed from
  // tx.originalName alone — never tx.payee, never the originalMerchant
  // fallback (which falls back to payee), never a Payment/Transfer
  // category inference. Normalized as trim + collapse whitespace +
  // uppercase, anchored at the start: 'SEND E-TFR' followed by
  // end-of-string or a non-alphanumeric boundary, so SEND E-TFRXYZ and
  // SEND E-TFR2 do not qualify. SEND E-TFR FEE is a fee, not a transfer
  // (the scripts/interac.js precedent), and is excluded. Boolean only —
  // the raw descriptor is never retained.
  const outgoingETransferDescriptorIdentity = originalName => {
    const name = typeof originalName === 'string'
      ? originalName.trim().replace(/\s+/g, ' ').toUpperCase() : '';
    return /^SEND E-TFR(?=$|[^A-Z0-9])/.test(name)
      && !/^SEND E-TFR FEE(?=$|[^A-Z0-9])/.test(name);
  };
  const postingByProviderId = new Map();
  const sourceTransactions = report && report.transactions || [];
  const provenPostingTransitions = new Set((report && report.identityEvidence || []).filter(row => {
    const members = sourceTransactions.filter(tx => String(tx?.providerTransactionId) === String(row?.providerTransactionId));
    return row?.transition === 'pending-to-posted' && row.postedCount === 1 && row.pendingCount > 0
      && row.ghostPending === false && row.doubleCounted === false && members.length > 0
      && members.every(tx => tx.providerAccountId === members[0].providerAccountId && tx.currency === 'cad');
  }).map(row => String(row.providerTransactionId)));
  for (const tx of sourceTransactions) if (tx?.providerTransactionId != null) {
    const id = String(tx.providerTransactionId), evidence = ['posted', 'pending'].includes(tx.savingsPostingEvidence)
      ? tx.savingsPostingEvidence : 'unknown', prior = postingByProviderId.get(id);
    postingByProviderId.set(id, evidence === 'unknown' || prior === 'unknown' ? 'unknown'
      : prior == null || prior === evidence ? evidence : provenPostingTransitions.has(id) ? 'transition' : 'unknown');
  }
  // Only canonical Savings account identity and fixed reasons may cross this
  // boundary. A discarded provider row is not evidence of no movement.
  const savingsMovementUnconfirmed = [];
  const markSavingsUnconfirmed = (mapping, reason) => {
    const accountId = mapping && mapping.canonical && mapping.canonical.id;
    if (mapping?.canonical?.collection !== 'cash'
      || !['savings', 'savings-dont-touch'].includes(accountId)) return;
    if (!savingsMovementUnconfirmed.some(row => row.accountId === accountId && row.reason === reason)) {
      savingsMovementUnconfirmed.push({ accountId, reason });
    }
  };
  const movementEvidenceRole = mapping => ['revolving-credit', 'heloc'].includes(atlasAccountRole(mapping));
  // Collapse omits undated rows; keep card and HELOC evidence unknown.
  for (const tx of report && report.transactions || []) {
    if (tx && tx.savingsPostingEvidence === 'unknown') {
      markSavingsUnconfirmed(mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null,
        'transaction-posting-status-unconfirmed');
    }
    if (tx && (!dateOnly(tx.date) || lunchMoneyDebitAmount(tx.amount) == null)) {
      markSavingsUnconfirmed(mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null,
        'transaction-amount-or-date-unconfirmed');
      // C1: collapse omits undated rows, so they are counted here as well.
      // A dated row with an unreadable amount is counted after the collapsed
      // pass below, unless that pass localised it to one category.
      if (COVERAGE_ACCOUNT_ROLES.has(atlasAccountRole(mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null))
          && droppedRowInCoverage(tx.date, window)) {
        noteDroppedRow(tx);
        if (dateOnly(tx.date)) rawAmountDrops.push(tx);
        else droppedCoverageRows += 1;
      }
    }
    if (tx && tx.currency !== 'cad') {
      markSavingsUnconfirmed(mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null,
        'native-plan-currency-unconfirmed');
    }
    if (tx && !dateOnly(tx.date) && movementEvidenceRole(mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null)) {
      cardCoverageUnconfirmed.push({ ref: cardCoverageReference(tx), date: null,
        reason: 'transaction-amount-or-date-unconfirmed' });
    }
  }
  // Astra A3: a posted-duplicate group (identical or disagreeing copies) is
  // counted as a dropped row; its rows stay in the packet as on main: coverage is incomplete for any household
  // account any copy names, inside the window, and Savings movement unknown.
  for (const row of report && report.identityEvidence || []) {
    if (!row || !['posted-duplicate', 'posted-duplicate-conflict'].includes(row.transition)) continue;
    const members = sourceTransactions.filter(tx => tx && tx.pending !== true
      && String(tx.providerTransactionId) === String(row.providerTransactionId));
    let counted = false;
    for (const tx of members) {
      const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
      markSavingsUnconfirmed(mapping, 'transaction-amount-or-date-unconfirmed');
      if (!counted && COVERAGE_ACCOUNT_ROLES.has(atlasAccountRole(mapping))
          && droppedRowInCoverage(tx.date, window)) {
        noteDroppedRow(tx);
        droppedCoverageRows += 1;
        counted = true;
      }
    }
  }
  // C1 guard: the one named household budget category a dropped row would
  // have counted in, by Forecast's own classifier on the row as a charge
  // (the G3a rule), or null. Only a dated, posted, CAD row on a household
  // cash or card account, with a provider category, no payment / transfer /
  // income / split identity, and a stable provider id qualifies.
  const droppedRowCategory = (tx, mapping, amount) => {
    const role = atlasAccountRole(mapping);
    if (amount != null || !dateOnly(tx.date) || !['household-cash', 'revolving-credit'].includes(role)) return null;
    if (tx.providerTransactionId == null || tx.providerTransactionId === '' || tx.pending === true) return null;
    if (tx.currency !== 'cad' || tx.coverageCurrencyConflict === true) return null;
    if (tx.isIncome === true || tx.excludeFromTotals === true || tx.excludeFromBudget === true) return null;
    if (tx.isGroup === true || tx.parentId != null || tx.splitIdentity === true) return null;
    if (kindHintFromTransaction(tx) || isMbnaCardPayment(tx) || outgoingETransferDescriptorIdentity(tx.originalName)) return null;
    if (typeof tx.categoryLabel !== 'string' || !tx.categoryLabel.trim()) return null;
    const atlasAccountId = mapping && mapping.canonical && mapping.canonical.id ? mapping.canonical.id : null;
    const resolvedTags = resolveRawTags(tx, tagsById);
    const asCharge = { payee: tx.payee, original_name: tx.originalName, originalName: tx.originalName,
      displayedPayee: tx.payee, originalMerchant: tx.originalName || tx.payee, notes: tx.notes,
      note: tx.notes || tx.note, tags: resolvedTags, tag: resolvedTags, kindHint: null, kind: tx.kind,
      mcc: tx.mcc, categoryLabel: tx.categoryLabel, atlasAccountId, account: atlasAccountId,
      accountId: atlasAccountId, date: dateOnly(tx.date), amount: 1, ownerConfirmedFuel: tx.ownerConfirmedFuel === true };
    const flags = Forecast.classifyCurrentPeriodTransaction.derivedFlags({ ...asCharge,
      categoryId: tx.categoryId, recurringId: tx.recurringId }, opts.plan);
    if (flags.cardPaymentIdentity === true || flags.tdCardPaymentIdentity === true
      || flags.internalTransferIdentity === true || flags.tfrReference
      || flags.cardFinanceChargeIdentity === true || flags.helocFinanceChargeIdentity === true
      || flags.cashWithdrawalIdentity === true || flags.externalCashDeposit === true) return null;
    const cls = Forecast.classifyCurrentPeriodTransaction({ ...asCharge, ...flags,
      currency: 'cad', pending: false, isIncome: false, excludeFromTotals: false, excludeFromBudget: false,
      accountRole: role }, opts.plan, {});
    const categoryId = cls && cls.kind === 'spend' && cls.householdSpending === true
      && !cls.needsConfirmation ? cls.categoryId : null;
    const named = ((opts.plan && opts.plan.budget && opts.plan.budget.categories) || [])
      .some(cat => cat && cat.id === categoryId);
    return categoryId && categoryId !== 'uncategorised' && categoryId !== 'other-spend' && named
      ? categoryId : null;
  };
  for (const tx of collapsed) {
    if (!tx) continue;
    const mapping = mapDoc ? mappingFor(mapDoc, tx.providerAccountId) : null;
    const amount = lunchMoneyDebitAmount(tx.amount);
    // The existing date parser decides, not truthiness: a malformed, impossible or non-ISO date
    // is as unusable as a missing one, whatever the amount.
    if (!dateOnly(tx.date) || amount == null) {
      markSavingsUnconfirmed(mapping, 'transaction-amount-or-date-unconfirmed');
      if (movementEvidenceRole(mapping)
        || (atlasAccountRole(mapping) === 'household-cash'
          && (kindHintFromTransaction(tx) === 'card-payment' || isMbnaCardPayment(tx)))) {
        cardCoverageUnconfirmed.push({ ref: cardCoverageReference(tx),
          date: dateOnly(tx.date) || null, reason: 'transaction-amount-or-date-unconfirmed' });
      }
      // P1 4253396900 diagnostic: a dated household-cash SEND E-TFR row
      // whose amount cannot be qualified is dropped here, before identity
      // detection — retain dates-only evidence so Forecast can withhold
      // the outgoing e-transfer all-clear for the row's period. The row
      // stays omitted; no descriptor, provider id or amount is retained,
      // and global coverage and classification are untouched.
      if (tx.date && amount == null
        && atlasAccountRole(mapping) === 'household-cash'
        && outgoingETransferDescriptorIdentity(tx.originalName)) {
        outgoingETransferUnconfirmed.push({ date: tx.date,
          reason: 'transaction-amount-unconfirmed' });
      }
      // C1: a row dropped for an unusable amount or date is spending the packet
      // can no longer see. For any account that feeds household figures, the
      // period's transaction coverage is no longer complete. When the row's
      // one household budget category is certain, only that category is
      // withheld (droppedCategoryRows); any doubt withholds globally.
      if (COVERAGE_ACCOUNT_ROLES.has(atlasAccountRole(mapping)) && droppedRowInCoverage(tx.date, window)) {
        noteDroppedRow(tx);
        const categoryId = droppedRowCategory(tx, mapping, amount);
        if (categoryId) {
          droppedCategoryRows.push({ date: dateOnly(tx.date), categoryId, reason: 'amount-unreadable' });
          localizedDropIds.add(String(tx.providerTransactionId));
        } else {
          droppedCoverageRows += 1;
        }
      }
      continue;
    }
    const currencyRules = currencyRulesForTransaction(tx, mapDoc, opts.identityRules,
      opts.planForIdentity || opts.plan);
    if (tx.coverageCurrencyConflict === true) markSavingsUnconfirmed(mapping, 'native-plan-currency-unconfirmed');
    if (tx.currencySettlementUnconfirmed === true
      || currencyRules.some(rule => !ruleCurrencyQualified(tx, rule))) {
      markSavingsUnconfirmed(mapping, 'native-plan-currency-unconfirmed');
      currencyUnconfirmed.push({ id: localIdFor(tx.providerTransactionId), currency: tx.currency || null });
      continue;
    }
    const treatment = pendingForecastTreatment(tx, asOf, {
      plan: opts.plan,
      billPaymentPayees: opts.billPaymentPayees,
    });
    const atlasAccountId = mapping && mapping.canonical && mapping.canonical.id
      ? mapping.canonical.id : null;
    const resolvedTags = resolveRawTags(tx, tagsById);
    let kindHint = kindHintFromTransaction(tx);
    if (!kindHint && isMbnaCardPayment(tx)) kindHint = 'card-payment';
    const derivedInput = {
      payee: tx.payee,
      original_name: tx.originalName,
      originalName: tx.originalName,
      displayedPayee: tx.payee,
      originalMerchant: tx.originalName || tx.payee,
      notes: tx.notes,
      note: tx.notes || tx.note,
      tags: resolvedTags,
      tag: resolvedTags,
      kindHint,
      kind: tx.kind,
      mcc: tx.mcc,
      categoryLabel: tx.categoryLabel,
      // Preserve native HELOC evidence before non-spend merchant text is stripped.
      ...(atlasAccountRole(mapping) === 'heloc' ? { accountRole: 'heloc' } : {}),
      atlasAccountId,
      account: atlasAccountId,
      accountId: atlasAccountId,
      date: tx.date,
      amount,
      ownerConfirmedFuel: tx.ownerConfirmedFuel === true,
    };
    const explicitOwner = explicitPersonalOwnerFromTagsNotes(derivedInput);
    // Raw Lunch Money ids reach Forecast's flag stamp only; the emitted row
    // carries the resulting booleans, never the ids.
    const flags = Forecast.classifyCurrentPeriodTransaction.derivedFlags({ ...derivedInput,
      categoryId: tx.categoryId, recurringId: tx.recurringId }, opts.plan);
    // Outgoing e-transfer identity: the shared descriptor test above,
    // stamped as one boolean — only this boolean enters the packet.
    const outgoingETransferIdentity = outgoingETransferDescriptorIdentity(tx.originalName);
    const coverageRelevant = movementEvidenceRole(mapping)
      || (atlasAccountRole(mapping) === 'household-cash'
        && (kindHint === 'card-payment' || flags.cardPaymentIdentity === true));
    if (coverageRelevant && (tx.currency !== 'cad' || tx.coverageCurrencyConflict === true)) {
      cardCoverageUnconfirmed.push({ ref: cardCoverageReference(tx), date: tx.date,
        reason: 'native-plan-currency-unconfirmed' });
      continue;
    }
    const ownerFuel = Forecast.classifyCurrentPeriodTransaction.ownerConfirmedFuel(derivedInput) === true;
    const ownerSpotify = Forecast.classifyCurrentPeriodTransaction.ownerConfirmedSpotify(derivedInput) === true;
    const ownerNoble = Forecast.classifyCurrentPeriodTransaction.ownerConfirmedNoble(derivedInput) === true;
    // Dale 2026-09-02: Cursor merchant is Dale. Stamp before overlay strip
    // so an Amanda tag cannot reassign it after payee/tags are removed.
    // Dale 2026-09-03: Amazon + travelvisa is Amanda. Stamp before strip so
    // a Dale-style incidental tag cannot reassign it, and so Forecast can
    // still apply the standing rule after raw merchant text is gone.
    const personalOwner = flags.daleGuiltFreeMerchant
      ? 'dale'
      : (flags.amazonMerchant && flags.personalOwner === 'amanda'
        ? 'amanda'
        : (explicitOwner || flags.personalOwner));
    const localId = localIdFor(tx.providerTransactionId);
    if (savingsLinks) linkHits.set(localId, privateLinks.filter(link => savingsLinkDate(tx.date) && tx.date >= link.effectiveFrom
      && tx.date <= link.effectiveThrough && tx.date <= asOf
      && (Object.hasOwn(link, 'categoryId') ? tx.categoryId === String(link.categoryId)
        : (tx.tagIds || []).includes(String(link.tagId)))));
    // Bounded display-only note, computed before the raw note is stripped.
    const displayedNote = displayedItemNote(tx.notes || tx.note);
    const bankDescription = bankDescriptionText(tx.originalName);
    if (bankDescription) bankDescriptions.set(localId, bankDescription);
    const emittedRow = {
      id: localId,
      coverageRef: cardCoverageReference(tx),
      date: tx.date,
      amount,
      currency: tx.currency || null,
      coverageCurrencyConflict: tx.coverageCurrencyConflict === true,
      pending: tx.pending === true,
      savingsPostingEvidence: postingByProviderId.get(String(tx.providerTransactionId)) === 'transition'
        ? tx.pending === false && tx.savingsPostingEvidence === 'posted' ? 'posted' : 'unknown'
        : postingByProviderId.get(String(tx.providerTransactionId)) || 'unknown',
      currency: tx.currency || null,
      pendingTreatment: treatment.treatment,
      categoryLabel: tx.categoryLabel || null,
      displayedPayee: sanitizedMerchantIdentity(tx.payee),
      ...(displayedNote ? { displayedNote } : {}),
      originalMerchant: sanitizedMerchantIdentity(tx.originalName || tx.payee),
      isIncome: tx.isIncome === true,
      excludeFromTotals: tx.excludeFromTotals === true,
      excludeFromBudget: tx.excludeFromBudget === true,
      accountRole: atlasAccountRole(mapping),
      atlasAccountId,
      account: atlasAccountId,
      kindHint,
      dogFood: flags.dogFood,
      ...(flags.dogFoodLunchMoneyLink === true ? { dogFoodLunchMoneyLink: true } : {}),
      convenienceStore: flags.convenienceStore,
      canadianTire: flags.canadianTire,
      groceryUncertain: flags.groceryUncertain,
      groceryMixed: flags.groceryMixed,
      merchantKnown: flags.merchantKnown,
      fuelEvidence: flags.fuelEvidence,
      confirmedGrocery: flags.confirmedGrocery,
      confirmedFuel: flags.confirmedFuel || ownerFuel,
      ownerConfirmedFuel: ownerFuel,
      ownerConfirmedSpotify: ownerSpotify,
      ownerConfirmedNobleOccurrence: ownerNoble,
      daleGuiltFreeMerchant: flags.daleGuiltFreeMerchant,
      amazonMerchant: flags.amazonMerchant,
      cardPaymentIdentity: flags.cardPaymentIdentity,
      ...(amount > 0 && tx.pending !== true ? cardMinimumFlags(cardMinimumMark(tx)) : {}),
      outgoingETransferIdentity,
      ...(flags.tdCardPaymentIdentity === true ? { tdCardPaymentIdentity: true } : {}),
      // TD "PAYMENT - THANK YOU" card credit (Grok Bot ruling): only the
      // boolean enters the packet, never the bank description.
      ...(flags.tdCardPaymentCredit === true ? { tdCardPaymentCredit: true } : {}),
      // TD rewards redemption card credit (Grok Bot ruling): only the boolean.
      ...(flags.tdRewardsRedemptionCredit === true ? { tdRewardsRedemptionCredit: true } : {}),
      // The note's named card (Grok Bot ruling), never the note text itself.
      ...(flags.cardPaymentNoteDestination ? { cardPaymentNoteDestination: flags.cardPaymentNoteDestination } : {}),
      // Card-specific payment identity from the existing payee identities
      // (MBNA, CAN TIRE MC) on a household cash or Savings (reserve) debit:
      // money onto the card counts from either (owner rule). The generic TD
      // "TFR-TO C/C" names no card and never sets this.
      ...(amount > 0 && payeeCardDestination(tx, mapping, flags)
        ? { cardPaymentDestination: payeeCardDestination(tx, mapping, flags) } : {}),
      cardFinanceChargeIdentity: flags.cardFinanceChargeIdentity,
      ...(flags.helocFinanceChargeIdentity === true ? { helocFinanceChargeIdentity: true } : {}),
      internalTransferIdentity: flags.internalTransferIdentity,
      externalCashDeposit: flags.externalCashDeposit,
      cashWithdrawalIdentity: flags.cashWithdrawalIdentity,
      tfrReference: flags.tfrReference || null,
      tfrDirection: flags.tfrDirection || null,
      personalOwner,
      isGroup: tx.isGroup === true,
      parentId: localIdFor(tx.parentId),
      pendingPostedDuplicate: tx.pendingPostedDuplicate === true,
      pendingPostedAmbiguous: tx.pendingPostedAmbiguous === true,
      // Grok Bot's "bill verified" marker, on a posted row only (a pending row never verifies); the boolean, never
      // the note text.
      ...(tx.pending !== true && billVerifiedMarker(tx.notes || tx.note) ? { billVerifiedNote: true } : {}),
      // The posted minimum category's card, present only on such a row, so the
      // held reader can see a category/note conflict (cardPaymentDestinationConflict).
      ...(typeof tx.minimumCategoryDebt === 'string' ? { minimumCategoryDebt: tx.minimumCategoryDebt } : {}),
    };
    txs.push(emittedRow);
    const distinctPending = distinctPendingByPosted.get(tx);
    if (distinctPending) distinctPendingRows.push([emittedRow, distinctPending.providerTransactionId]);
    if (emittedRow.id != null) {
      providerIdOfRow.set(String(emittedRow.id), tx.providerTransactionId == null ? null : String(tx.providerTransactionId));
      if (Array.isArray(tx.groupChildIds)) groupChildIds.set(String(emittedRow.id), tx.groupChildIds);
    }
    // Same-pass crosswalk capture: the exact surviving transaction that
    // produced this emitted row. Strings are copied at emission, so later
    // row mutation (linkage stamps, metadata stripping, merchant
    // removal) cannot reach back into the provenance.
    if (localId != null && tx.providerTransactionId != null && tx.providerTransactionId !== '') {
      join.push({
        localId,
        providerAccountId: tx.providerAccountId != null ? String(tx.providerAccountId) : null,
        transactionId: String(tx.providerTransactionId),
      });
    }
  }
  // Project only a link within this packet. Plaid IDs and raw provider
  // transaction IDs stay in the observer.
  const emittedIds = new Set(txs.map(tx => tx.id));
  for (const [posted, providerId] of distinctPendingRows) {
    const pendingId = existingLocalId(providerId);
    if (pendingId && pendingId !== posted.id && emittedIds.has(pendingId)) posted.distinctPendingId = pendingId;
  }
  const representedActuals = [];
  const linkedLocalIds = new Set();
  for (const candidate of (report && report.representedEventCandidates) || []) {
    if (!candidate || !candidate.id || !candidate.date) continue;
    const amt = Number(candidate.observedAmount);
    if (!isFinite(amt)) continue;
    const row = {
      id: candidate.id,
      date: candidate.date,
      actual: Math.round(amt * 100) / 100,
      postedOn: candidate.postingDate || candidate.date,
    };
    const localIds = [];
    const seenLocal = new Set();
    for (const rawId of candidateTransactionIds(candidate)) {
      const localId = existingLocalId(rawId);
      if (!localId || seenLocal.has(localId)) continue;
      seenLocal.add(localId);
      localIds.push(localId);
    }
    if (localIds.length) {
      row.transactionId = localIds[0];
      if (localIds.length > 1) row.transactionIds = localIds;
      for (const localId of localIds) linkedLocalIds.add(localId);
    } else if (candidate.settlesWhen === SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE) {
      // The owner's rule settles this occurrence on its due date at the
      // scheduled amount; no bank transaction was seen. Say so on the
      // entry so every reader can tell "trusted on due date" from "seen".
      row.settlementBasis = SETTLES_WHEN_SCHEDULE_TRUST_ON_DUE;
    }
    representedActuals.push(row);
  }
  for (const row of pendingOnlyBillActuals(collapsed, {
    transactionWindow: window,
    identityRules: opts.identityRules,
    planForIdentity: opts.planForIdentity,
    plan: opts.plan,
    accountMap: mapDoc,
  }, representedActuals, existingLocalId)) {
    representedActuals.push(row);
    if (row.transactionId) linkedLocalIds.add(row.transactionId);
  }
  const pendingCardPaid = pendingCardPaidBillLocalIds(collapsed, {
    transactionWindow: window,
    identityRules: opts.identityRules,
    planForIdentity: opts.planForIdentity,
    plan: opts.plan,
    accountMap: mapDoc,
  }, existingLocalId, representedActuals);
  const pendingCardPaidIds = new Set(pendingCardPaid.ids);
  const nearDueBills = nearDueBillCandidateIds(collapsed, {
    transactionWindow: window,
    identityRules: opts.identityRules,
    planForIdentity: opts.planForIdentity,
    plan: opts.plan,
    accountMap: mapDoc,
    asOf,
    ambiguousGroups: opts.ambiguousBillGroups,
  }, linkedLocalIds, existingLocalId, representedActuals);
  const pendingBillCopies = pendingBillCopyIds(collapsed, {
    transactionWindow: window,
    identityRules: opts.identityRules,
    planForIdentity: opts.planForIdentity,
    plan: opts.plan,
    accountMap: mapDoc,
    asOf,
  }, linkedLocalIds, existingLocalId, representedActuals, nearDueBills);
  const linkedMisfits = linkedBillMisfitIds(collapsed, {
    identityRules: opts.identityRules,
    planForIdentity: opts.planForIdentity,
    plan: opts.plan,
    accountMap: mapDoc,
  }, linkedLocalIds, existingLocalId);
  for (const tx of txs) {
    if (tx && linkedLocalIds.has(tx.id)) tx.representedBill = true;
    else if (tx) tx.representedBill = false;
    if (tx && tx.representedBill !== true && nearDueBills.has(tx.id)) {
      tx.nearDueBillCandidate = { ...nearDueBills.get(tx.id) };
    }
    if (tx && tx.pending === true && pendingBillCopies.has(tx.id)) {
      tx.pendingPostedDuplicate = true;
      tx.pendingBillCopy = true;
    }
    // A near-due candidate is already named on its bill; one naming only.
    if (tx && tx.representedBill !== true && !tx.nearDueBillCandidate && linkedMisfits.has(tx.id)) {
      tx.linkedBillMisfit = { ...linkedMisfits.get(tx.id) };
    }
    if (tx) {
      tx.pendingMatchingCardPaidBill = tx.pending === true
        && pendingCardPaidIds.has(tx.id)
        && tx.representedBill !== true;
      const possibleBillId = tx.pending === true && tx.representedBill !== true
        && !tx.pendingMatchingCardPaidBill ? pendingCardPaid.possible.get(tx.id) : null;
      if (possibleBillId) {
        const bill = (((opts.planForIdentity || opts.plan) || {}).bills || [])
          .find(row => row && row.id === possibleBillId);
        tx.pendingPossibleCardPaidBill = { id: possibleBillId,
          label: bill && typeof bill.label === 'string' && bill.label.trim() ? bill.label.trim() : null };
      }
    }
    stripRawTransactionMetadata(tx);
  }
  const classifyPacket = { transactions: txs, representedActuals };
  // An inbound row with no item link of its own that shares its account and
  // merchant with a linked charge may be that charge's refund (a refund
  // posted without the purchase's tag or category). Atlas cannot tell which
  // item it reverses, so the item's evidence becomes unresolved and Forecast
  // does not net the row into a household category. Built before the loop
  // below strips merchant text from rows that are not household spend.
  const linkedChargeKey = row => {
    const merchant = row && (row.originalMerchant || row.displayedPayee);
    if (!row || !row.atlasAccountId || typeof merchant !== 'string' || !merchant.trim()) return null;
    return row.atlasAccountId + '|' + merchant.trim().replace(/\s+/g, ' ').toUpperCase();
  };
  // The evidence loop below skips a split parent whose children are present
  // and a pending row replaced by its posted successor; so do both sides here.
  const isSplitParent = row => row.isGroup === true && txs.some(child => child && child !== row && child.parentId === row.id);
  const isReplacedPending = row => row.pending === true && row.pendingPostedDuplicate === true && row.pendingPostedAmbiguous !== true;
  const linkedChargeRefs = new Map();
  for (const row of txs) {
    const hits = row && savingsLinks ? linkHits.get(row.id) || [] : [];
    const key = hits.length && row.amount > 0 && !isSplitParent(row) && !isReplacedPending(row) ? linkedChargeKey(row) : null;
    if (!key) continue;
    // Only the item the charge itself resolves to; every candidate when the
    // charge cannot be resolved (conservative).
    const resolution = Forecast.savingsLinkTarget.resolve(hits.map(link => ({
      type: Object.hasOwn(link, 'categoryId') ? 'category' : 'tag', ...link.target })));
    const own = resolution.status === 'linked'
      ? hits.filter(link => link.target && link.target.occurrenceKey === resolution.occurrenceKey) : hits;
    const refs = linkedChargeRefs.get(key) || new Set();
    for (const link of own) refs.add(link.ref);
    linkedChargeRefs.set(key, refs);
  }
  for (const row of txs) {
    if (!row) continue;
    const cls = Forecast.classifyCurrentPeriodTransaction(row, opts.plan, {
      packet: classifyPacket,
      currentPeriodActuals: classifyPacket,
    });
    const hits = linkHits.get(row.id) || [];
    // Same date bound as the link hits above: Forecast refuses the whole
    // link publication for evidence dated after the observation.
    const unlinkedRefundRefs = !hits.length && savingsLinkDate(row.date) && row.date <= asOf
      && !isSplitParent(row) && !isReplacedPending(row) && row.amount < 0 && !row.kindHint && row.isIncome !== true
      && row.excludeFromTotals !== true && !['transfer', 'internal-movement', 'card-payment', 'income'].includes(cls.kind)
      ? linkedChargeRefs.get(linkedChargeKey(row)) : null;
    if (unlinkedRefundRefs) {
      row.linkedItemRefundUnresolved = true;
      savingsLinks.evidence.push({ transactionRef: row.id, date: row.date,
        linkRefs: [...unlinkedRefundRefs].sort(), direction: 'refund',
        state: 'unresolved', reason: 'refund-unlinked', occurrenceKey: null });
    }
    // A4b: a split parent whose children are in this packet is excluded, as
    // every consumer excludes it (skipSplitParent); the qualified children
    // decide. A pending row replaced by its unique posted successor (the
    // household's own pendingPostedDuplicate pairing) is not evidence; the
    // successor counts once. Ambiguous pairs and childless groups stay
    // unresolved, so their item stays Unknown.
    const splitParent = row.isGroup === true && txs.some(child => child && child !== row && child.parentId === row.id);
    const replacedPending = row.pending === true && row.pendingPostedDuplicate === true && row.pendingPostedAmbiguous !== true;
    if (hits.length && !splitParent && !replacedPending) {
      // One resolution authority; category and tag agreeing is one link.
      const resolution = Forecast.savingsLinkTarget.resolve(hits.map(link => ({
        type: Object.hasOwn(link, 'categoryId') ? 'category' : 'tag', ...link.target })));
      let reason = resolution.status === 'linked' ? null : 'conflicting-links';
      // Signed: a classified refund nets against its item. Income, transfers
      // and other credits stay nonconsumption; zero is never evidence. A
      // debit in an income category is unconfirmed spending, never item
      // evidence: it stays nonconsumption here too.
      const refund = row.amount < 0 && cls.kind === 'refund' && cls.reason === 'refund' && !row.kindHint;
      if (!reason && (!(row.amount > 0 || refund) || row.isIncome === true || row.currency !== 'cad' || row.excludeFromTotals
          || row.excludeFromBudget || row.isGroup || txs.some(child => child.parentId === row.id)
          || row.representedBill || !(cls.householdSpending || cls.kind === 'savings-paid' || refund) || ['unmapped', 'external'].includes(cls.kind)))
        reason = 'nonconsumption';
      if (!reason && (row.pendingPostedAmbiguous || row.pendingPostedDuplicate && row.pending === true)) reason = 'replacement-unresolved';
      if (!reason && !['posted', 'pending'].includes(row.savingsPostingEvidence)) reason = 'posting-unconfirmed';
      // No creation-date or anchor cutoff: a pre-item purchase in the
      // covered history is evidence (blueprint section 3).
      savingsLinks.evidence.push({ transactionRef: row.id, date: row.date,
        linkRefs: hits.map(link => link.ref), direction: row.amount < 0 ? 'refund' : 'charge',
        state: reason ? 'unresolved' : row.savingsPostingEvidence,
        reason, occurrenceKey: reason ? null : resolution.occurrenceKey });
    }
    // A Savings-paid purchase is still listed on the Budget (Savings audit PR 1),
    // and so is a held outflow under To confirm (rank 18; it was listed as
    // Other spending before, so it keeps the same identity fields).
    if (!Forecast.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible(cls)
        && cls.kind !== 'savings-paid' && cls.kind !== 'held-outflow') {
      delete row.displayedPayee;
      delete row.originalMerchant;
      delete row.displayedNote;
    }
    delete row.bankDescription;
    // Only a refund Forecast links to one named household category (#1234), the only refund the page lists
    // by name. A standalone refund prints only in the "Refunds not linked" total, so it keeps no bank text;
    // nor does any other credit, such as payroll, an e-transfer or an unclassified deposit.
    if (cls.kind === 'refund' && bankDescriptions.has(row.id)
      && Forecast.classifyCurrentPeriodTransaction.linkedCategoryRefund(row, cls, opts.plan,
        { packet: classifyPacket, currentPeriodActuals: classifyPacket })) row.bankDescription = bankDescriptions.get(row.id);
  }
  // C1: a raw dated row with an unreadable amount that the collapsed pass
  // did not localise (or never saw) withholds coverage globally.
  for (const tx of rawAmountDrops) {
    if (tx.providerTransactionId == null || !localizedDropIds.has(String(tx.providerTransactionId))) droppedCoverageRows += 1;
  }
  const pending = report && report.pendingCoverage;
  let pendingCoverage = 'unknown';
  if (pending && pending.complete === true) pendingCoverage = 'complete';
  else if (pending && pending.status === 'bounded-window') pendingCoverage = 'partial';
  const syncEvidence = accountSyncEvidence((opts && opts.accounts) || (report && report.accounts), mapDoc, dateOnly(window.endDate) || asOf);
  // A1: the stamp is earned by positive evidence, never by the absence of a
  // named failure. Each gap below withholds 'complete'.
  const sourceRole = tx => atlasAccountRole(mapDoc ? mappingFor(mapDoc, tx && tx.providerAccountId) : null);
  const evidenceRows = Array.isArray(report && report.transactions) ? report.transactions
    : (report && report.collapsedTransactions) || [];
  const inWindowCoverageRows = evidenceRows.filter(tx => tx
    && COVERAGE_ACCOUNT_ROLES.has(sourceRole(tx)) && droppedRowInCoverage(tx.date, window));
  const collectionPresent = Object.hasOwn(opts, 'transactionsPresent')
    ? opts.transactionsPresent === true
    : Array.isArray(report && report.transactions) || Array.isArray(report && report.collapsedTransactions);
  // A2: Forecast suppresses a split parent once any child is present, so the
  // present children must reconcile to the parent to the cent.
  // U5 (lead dispatch): a cross-account group parent has no account of its own
  // (#1306) and every consumer skips it once its children are present
  // (skipSplitParent). It is not an unmapped-account gap when exactly the
  // children Lunch Money lists for it (by id, each once) are present as rows
  // and every one of them is individually mapped. A parent with any child
  // missing, duplicated, unlisted or unmapped, or with no listed children,
  // stays a gap.
  const completeGroupParent = parent => {
    if (!parent || parent.isGroup !== true || parent.id == null) return false;
    const expected = groupChildIds.get(String(parent.id));
    if (!Array.isArray(expected) || !expected.length || expected.some(id => id == null)
      || new Set(expected).size !== expected.length) return false;
    const children = txs.filter(child => child && child !== parent && child.parentId != null
      && String(child.parentId) === String(parent.id));
    const present = children.map(child => providerIdOfRow.get(String(child.id)));
    return children.length === expected.length && new Set(present).size === present.length
      && present.every(id => id != null && expected.includes(id))
      && children.every(child => child.accountRole && child.accountRole !== 'unmapped');
  };
  const splitUnreconciled = txs.some(parent => {
    if (!parent || parent.isGroup !== true || !COVERAGE_ACCOUNT_ROLES.has(parent.accountRole)) return false;
    const children = txs.filter(child => child && child !== parent && child.parentId != null
      && (parent.id == null || String(child.parentId) === String(parent.id)));
    if (!children.length) return false;
    if (parent.id == null) return true;
    const cents = v => Math.round(Number(v) * 100);
    return children.reduce((sum, child) => sum + cents(child.amount), 0) !== cents(parent.amount);
  });
  const positiveEvidenceGap = window.complete !== true
    || !collectionPresent
    // The Bills account identity, as the incumbent salary attribution reads it.
    || !((mapDoc && mapDoc.mappings) || []).some(m => atlasAccountRole(m) === 'household-cash'
      && m.canonical && m.canonical.id === 'chequing-a')
    || !dateOnly(window.startDate) || !dateOnly(window.endDate)
    || inWindowCoverageRows.some(tx => !['posted', 'pending'].includes(tx.savingsPostingEvidence))
    // Rule 6 reads the rows that survive pending/posted replacement: a
    // superseded pending leg does not feed any figure.
    || collapsed.some(tx => tx && ['household-cash', 'household-reserve'].includes(sourceRole(tx))
      && droppedRowInCoverage(tx.date, window) && tx.currency !== 'cad')
    || splitUnreconciled;
  let transactionCoverage = 'complete';
  // C1: every gap except a localised category drop. The stamp itself still
  // reads 'incomplete' for a localised drop, so every consumer that reads it
  // alone keeps withholding as before; only the category actuals path reads
  // droppedCategoryRows (Forecast actualsCoverageState, localizedDrops opt-in).
  const otherCoverageGap = cardCoverageUnconfirmed.length || currencyUnconfirmed.length || droppedCoverageRows > 0
      || syncEvidence.some(row => row.syncEvidence === 'failed')
      || txs.some(tx => tx && tx.accountRole === 'unmapped' && !completeGroupParent(tx))
      || positiveEvidenceGap;
  if (window.truncated === true || window.complete === false || window.hasMore === true) {
    transactionCoverage = 'truncated';
  } else if (otherCoverageGap || droppedCategoryRows.length) {
    transactionCoverage = 'incomplete';
  }
  const coverageExceptCategories = transactionCoverage === 'incomplete' && !otherCoverageGap
    && droppedCategoryRows.length > 0;
  let coverageStart = window.startDate || null;
  let coverageThrough = window.endDate || null;
  if (!coverageStart || !coverageThrough) {
    for (const tx of txs) {
      if (!tx || !tx.date) continue;
      if (!coverageStart || tx.date < coverageStart) coverageStart = tx.date;
      if (!coverageThrough || tx.date > coverageThrough) coverageThrough = tx.date;
    }
  }
  const lastSyncedAt = lastSuccessfulSyncAt((opts && opts.accounts) || (report && report.accounts), mapDoc, report && report.fetchedAt);
  let lunchMoneyRecurring = sanitizedRecurringEvidence(opts.recurringItems,
    { identityRules: opts.identityRules, accountMap: mapDoc, existingLocalId, refused: opts.recurringRefused });
  // A block that fails its own structural check is replaced, so it can never
  // empty the packet's transactions below.
  if (lunchMoneyRecurring && !recurringEvidenceLooksSanitized(lunchMoneyRecurring)) {
    lunchMoneyRecurring = { source: 'provider-observe:lunchmoney', status: 'unavailable', reason: 'recurring-read-failed' };
  }
  let lunchMoneyBudgets = sanitizedBudgetEvidence(opts.lunchMoneyBudgets, opts.lunchMoneyCategories, opts.plan);
  if (lunchMoneyBudgets && !budgetEvidenceLooksSanitized(lunchMoneyBudgets)) {
    lunchMoneyBudgets = { source: 'provider-observe:lunchmoney', status: 'unavailable', reason: 'budget-read-failed' };
  }
  const packet = {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: asOf,
    coverageStart,
    coverageThrough,
    // The window bounds themselves, not only the coverage dates derived
    // from them: when the window is absent those dates fall back to the
    // transactions' own min/max, which manufactures bounds. Downstream
    // provenance checks (the outgoing e-transfer publication) read the
    // window from here; dates and booleans only, never raw descriptors.
    transactionWindow: {
      startDate: window.startDate || null,
      endDate: window.endDate || null,
      complete: window.complete === true ? true : window.complete === false ? false : null,
      hasMore: window.hasMore === true ? true : window.hasMore === false ? false : null,
      truncated: window.truncated === true,
    },
    pendingCoverage,
    transactionCoverage,
    syncEvidence,
    ...(lastSyncedAt ? { lastSuccessfulSyncAt: lastSyncedAt } : {}),
    cardCoverageUnconfirmed,
    outgoingETransferUnconfirmed,
    cardCoverageRequired: ((mapDoc && mapDoc.mappings) || []).some(m => atlasAccountRole(m) === 'revolving-credit'),
    currencyUnconfirmed,
    savingsMovementUnconfirmed,
    savingsFetchCoverage: window.savingsFetchCoverage || { complete: false, startDate: null, endDate: null },
    paydayGapComplete: paydayGapCompleteFromEvidence({
      plan: opts.plan,
      asOf,
      window,
      transactions: txs,
      pendingCoverage,
      accountMap: mapDoc,
    }),
    representedActuals,
    transactions: txs,
    cardMinimumOwnership: minimumOwnership.status,
    // What the card-minimum owner could not read: obligation label and a word, never an identity.
    ...(minimumOwnership.unreadable.length ? { cardMinimumUnreadable: minimumOwnership.unreadable } : {}),
    ...(savingsLinks ? { savingsLinks } : {}),
    ...(lunchMoneyRecurring ? { lunchMoneyRecurring } : {}),
    ...(lunchMoneyBudgets ? { lunchMoneyBudgets } : {}),
    // C1: present only when the sole coverage gap is dropped rows whose one
    // budget category is certain. Dates and category ids only: no amount,
    // payee, merchant or provider id.
    ...(coverageExceptCategories ? {
      coverageExceptCategories: true,
      droppedCategoryRows: droppedCategoryRows.map(row => ({ date: row.date, categoryId: row.categoryId, reason: row.reason })),
    } : {}),
  };
  let qualified = true;
  if (!currentPeriodActualsLooksSanitized(packet)) {
    qualified = false;
    for (const tx of txs) {
      markSavingsUnconfirmed({ canonical: { collection: 'cash', id: tx.atlasAccountId } },
        'transaction-evidence-sanitization-failed');
    }
    packet.transactions = [];
    packet.representedActuals = representedActuals.map(row => ({
      id: row.id,
      date: row.date,
      actual: row.actual,
      postedOn: row.postedOn,
      transactionId: row.transactionId || undefined,
      settlementBasis: row.settlementBasis || undefined,
      pending: row.pending === true ? true : undefined,
    }));
    packet.transactionCoverage = 'incomplete';
    delete packet.lunchMoneyRecurring;
    delete packet.lunchMoneyBudgets;
    delete packet.coverageExceptCategories;
    delete packet.droppedCategoryRows;
    packet.paydayGapComplete = false;
  }
  // Use this pass's actual counters and predicates. Do not infer dropped rows
  // from differences in collection size: legitimate replacement also shrinks it.
  const diagnostics = {};
  const count = (code, value) => CoverageDiagnostics.merge(diagnostics, { [code]: value });
  for (const code of ['posted-duplicate', 'posted-duplicate-conflict']) {
    count(code, (report?.identityEvidence || []).filter(row => row?.transition === code).length);
  }
  count('sync-evidence-failed', syncEvidence.filter(row => row.reason === 'sync-status-failure').length);
  count('sync-evidence-invalid', syncEvidence.filter(row => row.reason === 'sync-field-unparseable').length);
  count('currency-unconfirmed', currencyUnconfirmed.length);
  count('cash-currency-unconfirmed', collapsed.filter(tx => tx
    && ['household-cash', 'household-reserve'].includes(sourceRole(tx))
    && droppedRowInCoverage(tx.date, window) && tx.currency !== 'cad').length);
  count('card-coverage-unconfirmed', cardCoverageUnconfirmed.length);
  count('dropped-row', diagnosticDroppedRows.size);
  count('unmapped-account', txs.filter(tx => tx?.accountRole === 'unmapped' && !completeGroupParent(tx)).length);
  count('posting-status-unconfirmed', inWindowCoverageRows.filter(tx => !['posted', 'pending'].includes(tx.savingsPostingEvidence)).length);
  count('split-unreconciled', splitUnreconciled ? 1 : 0);
  count('transactions-missing', collectionPresent ? 0 : 1);
  count('window-bounds-missing', !dateOnly(window.startDate) || !dateOnly(window.endDate) ? 1 : 0);
  count('window-completion-unproven', window.complete === true ? 0 : 1);
  count('window-truncated', window.truncated === true || window.complete === false || window.hasMore === true ? 1 : 0);
  count('pending-coverage-incomplete', pendingCoverage === 'complete' ? 0 : 1);
  count('sanitization-failed', qualified ? 0 : 1);
  try { opts.onCoverageDiagnostic?.(diagnostics); } catch (_) { /* Diagnostics cannot change the packet. */ }
  return { packet, join, qualified };
}

// Deep copy of plain data for acquisition ownership: arrays and plain
// objects are rebuilt, primitives (including undefined) pass through, and
// anything else — functions, class instances, Maps, cycles — is rejected
// so an acquisition never aliases a caller-owned graph it cannot own.
function cloneOwnedPlainData(value, seen) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new Error('settlement crosswalk acquisition requires plain data');
    }
    return value;
  }
  if (seen.has(value)) throw new Error('settlement crosswalk acquisition requires acyclic data');
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map(item => cloneOwnedPlainData(item, seen));
    seen.delete(value);
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('settlement crosswalk acquisition requires plain data');
  }
  seen.add(value);
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = cloneOwnedPlainData(value[key], seen);
  seen.delete(value);
  return copy;
}

// ATLAS-080 — the production same-pass crosswalk exporter (addendum
// section A.8). Takes already-supplied observe() input ({ provider,
// payload, data, accountMap, ... }) and runs ONE incumbent observation /
// sanitization execution, returning the owned coherent acquisition
// { packet, join, plan, map } of that single pass for the settlement
// resolver. It has no production caller, performs no fetch, persistence
// or activation, and observe()'s own outputs are untouched. Returns null
// — no usable acquisition — when the pass's final sanitation check fails
// or the captured provenance fails integrity validation (a missing or
// malformed tuple component, an orphan entry, or an emitted row without
// provenance). Input conditions observe() itself rejects (unsupported
// provider, missing map, untrustworthy transaction id) keep observe()'s
// incumbent failure behaviour.
function acquireSettlementCrosswalk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const capture = {};
  observeCore(input, capture);
  return settlementAcquisitionFromCapture(input, capture);
}

// The paired private entry for the refresh acquisition composition:
// ONE observeCore execution returns both the incumbent report and the
// same-pass acquisition validated from that execution's own capture, so
// a consumer can qualify the report and use the acquisition without a
// second observation/sanitization. observe()'s outputs are untouched
// (this entry returns the very object observeCore produced), and the
// acquisition is exactly what acquireSettlementCrosswalk returns for
// the same input. Input observe() itself rejects keeps observe()'s
// incumbent failure behaviour; a non-object input yields nulls.
function observeWithSettlementCrosswalk(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { report: null, acquisition: null };
  }
  const capture = {};
  const report = observeCore(input, capture);
  return { report, acquisition: settlementAcquisitionFromCapture(input, capture) };
}

// Validates one executed pass's capture and builds the owned
// acquisition from it, or returns null when the pass did not qualify
// or the captured provenance fails integrity validation.
function settlementAcquisitionFromCapture(input, capture) {
  if (capture.qualified !== true || !Array.isArray(capture.join)) return null;
  const packet = capture.packet;
  if (!packet || !Array.isArray(packet.transactions)) return null;
  const rowIds = new Set();
  for (const row of packet.transactions) {
    if (!row || typeof row.id !== 'string' || row.id === '') return null;
    rowIds.add(row.id);
  }
  // Integrity validation with structural tuple identity (nested Maps,
  // never a delimited string): malformed components and orphan entries
  // fail closed; exact duplicate tuples from the incumbent string/number
  // identity merge are recorded once.
  const join = [];
  const byLocalId = new Map();
  for (const entry of capture.join) {
    if (!entry || typeof entry.localId !== 'string' || entry.localId === ''
      || typeof entry.providerAccountId !== 'string' || entry.providerAccountId === ''
      || typeof entry.transactionId !== 'string' || entry.transactionId === '') return null;
    if (!rowIds.has(entry.localId)) return null;
    let byAccount = byLocalId.get(entry.localId);
    if (!byAccount) {
      byAccount = new Map();
      byLocalId.set(entry.localId, byAccount);
    }
    let seenTransactions = byAccount.get(entry.providerAccountId);
    if (!seenTransactions) {
      seenTransactions = new Set();
      byAccount.set(entry.providerAccountId, seenTransactions);
    }
    if (seenTransactions.has(entry.transactionId)) continue;
    seenTransactions.add(entry.transactionId);
    join.push({
      localId: entry.localId,
      providerAccountId: entry.providerAccountId,
      transactionId: entry.transactionId,
    });
  }
  const joinedIds = new Set(join.map(entry => entry.localId));
  for (const id of rowIds) {
    if (!joinedIds.has(id)) return null;
  }
  let packetCopy;
  let planCopy;
  let mapCopy;
  try {
    packetCopy = cloneOwnedPlainData(packet, new Set());
    planCopy = input.data && input.data.plan != null
      ? cloneOwnedPlainData(input.data.plan, new Set()) : null;
    mapCopy = cloneOwnedPlainData(input.accountMap, new Set());
  } catch {
    return null;
  }
  return { packet: packetCopy, join, plan: planCopy, map: mapCopy };
}

function loadIdentity(file) {
  if (!file || !fs.existsSync(file)) return { rules: [], billPaymentPayees: [] };
  return loadJson(file);
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/provider-observe.js --provider lunchmoney --fixture <file>\n'
      + '       node scripts/provider-observe.js --provider lunchmoney --live [--mode current-state|reconcile] [--history-days N]\n'
      + '       [--identity-proof | --receipt | --reconciliation-receipt]\n'
    );
    return 0;
  }
  if (args.provider !== 'lunchmoney') fail('Only --provider lunchmoney is implemented in this spike.');
  if (args.live && args.fixture) fail('Use either --fixture or --live, not both.');
  if (!args.live && !args.fixture) fail('Pass --fixture <file> or --live.');
  if ([args.identityProof, args.receipt, args.reconciliationReceipt].filter(Boolean).length > 1) {
    fail('Use only one of --identity-proof, --receipt, or --reconciliation-receipt.');
  }
  if (args.mode && args.mode !== 'current-state' && args.mode !== 'reconcile') {
    fail('Mode must be current-state or reconcile.');
  }
  const data = loadJson(args.data);
  const accountMap = loadJson(resolveMapPath(args));
  if (args.live) {
    await resolveLiveToken();
    assertLiveMap(accountMap, { data });
  }
  const identity = loadIdentity(DEFAULT_IDENTITY);
  const now = new Date().toISOString();
  let historyDays = historyDaysFromArgs(args);
  if (args.live && args.historyDays == null && args.mode !== 'reconcile') {
    historyDays = postedHistoryDaysForCarriedSettlement({
      now,
      plan: data.plan,
      debts: data.debts,
      identity,
    });
  }
  let payload;
  if (args.live) {
    payload = await fetchLunchMoneyLive(
      await resolveLiveToken(),
      now,
      historyDays
    );
  } else {
    payload = loadJson(args.fixture);
  }
  const report = observe({
    provider: 'lunchmoney',
    payload,
    accountMap,
    data,
    identity,
    fetchedAt: payload.fetchedAt,
  });
  const printed = args.reconciliationReceipt
    ? report.obligationReconciliationReceipt
    : (args.receipt
      ? report.observationReceipt
      : (args.identityProof ? report.identityProof : report));
  process.stdout.write(JSON.stringify(printed, null, 2) + '\n');
  return 0;
}

const api = {
  cardCoverageReference,
  TOKEN_ENV,
  MAP_JSON_ENV,
  MAP_PATH_ENV,
  API_BASE_ENV,
  LIVE_MAP_SCHEMA,
  RECEIPT_SCHEMA,
  RECONCILIATION_RECEIPT_SCHEMA,
  REQUEST_TIMEOUT_MS,
  LIVE_BASE,
  DEFAULT_MAP,
  LOCAL_MAP,
  FIXTURE_MAP,
  DEFAULT_IDENTITY,
  CURRENT_STATE_HISTORY_DAYS,
  RECONCILE_HISTORY_DAYS,
  BILL_PAYMENT_PENDING_DAYS,
  PENDING_COVERAGE_BASIS,
  PENDING_COVERAGE_REQUIRED_EVIDENCE,
  REQUIRED_LIVE_CASH_IDS,
  EXTERNAL_LIVE_ROLE,
  parseArgs,
  historyDaysFromArgs,
  postedHistoryDaysForCarriedSettlement,
  resolveMapPath,
  lunchMoneyApiBase,
  loadLiveAccountMap,
  assertLiveMap,
  mappingFor,
  lunchMoneyTransactionsUrl,
  lunchMoneyPendingUniverseUrl,
  fetchLunchMoneyTransactionsPaged,
  classifyPendingCoverage,
  lunchMoneyDebitAmount,
  calendarDaysBetween,
  isBillOrPaymentTransaction,
  pendingForecastTreatment,
  collapseByProviderTransactionId,
  pendingObservationsFromTransactions,
  inferredCardState,
  representedEventHitGroups,
  representedEventCandidates,
  transactionIsTransfer,
  uniqueTransferCounterpart,
  countTransferCounterparts,
  ruleHasIdentity,
  ruleMatchesTransactionIdentity,
  duplicatedRuleCategoryIds,
  stampIdentityDescriptors,
  ruleEarlyPayLookaheadDays,
  openingAsOfFromData,
  classifyRepresentedCandidate,
  postingObservationFromCandidate,
  sameDayDiscrepancies,
  observationIdentityKey,
  identityFingerprint,
  identityProofLooksSanitized,
  compareIdentityFingerprints,
  postedWindowIsComplete,
  pendingCoverageIsComplete,
  observationReceiptLooksSanitized,
  observationFingerprintFromParts,
  observationFingerprintDigest,
  householdDateFromProviderEvidence,
  householdFinancialDate,
  observationReceipt,
  sanitizedEvidenceFingerprint,
  reconciliationReceiptLooksSanitized,
  reconciliationReceipt,
  normalizeLunchMoneyAccount,
  billVerifiedMarker,
  postedBalanceEvidenceInstant,
  cashBalanceEvidenceInstant,
  genericAccountEvidenceInstant,
  normalizeLunchMoneyTransaction,
  normalizeLunchMoneyPayload,
  observationsFromMappedAccount,
  spendableCashFromObservations,
  sanitizedCurrentPeriodActuals,
  acquireSettlementCrosswalk,
  observeWithSettlementCrosswalk,
  paydayGapCompleteFromEvidence,
  currentPeriodActualsLooksSanitized,
  recurringBillSchedules,
  recurringBillScheduleReview,
  derivedAmountFixedBills,
  billPaymentHistory,
  AMOUNT_HISTORY_DAYS,
  recurringItemAmounts,
  applyRecurringSchedule,
  applyRecurringObligationSchedule,
  RECURRING_OBLIGATION_FIELDS,
  RECURRING_REFUSAL_CODES,
  sanitizedRecurringEvidence,
  RECURRING_UNNAMED_ROLES,
  RECURRING_TIMING_FIELDS,
  RECURRING_CUTOVER_FIELDS,
  transactionLooksSanitized,
  DISPLAYED_NOTE_PREFIX,
  DISPLAYED_NOTE_MAX_CHARS,
  displayedItemNote,
  observe,
  fetchLunchMoneyLive,
  sanitizedBudgetEvidence,
  budgetEvidenceLooksSanitized,
  resolveLiveToken,
  resolveLiveCredential,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = api;
}
