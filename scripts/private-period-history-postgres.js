'use strict';
// Hosted PostgreSQL backend for the private period-history archive.
//
// Owner decision (PR #831 comment 6694409045): the archive may live in hosted
// Postgres (Neon Free) so it survives a Render restart. It stores a SANITIZED
// PROJECTION only: period aggregates and provenance fingerprints. It never
// stores the `evidence` block, raw provider payloads, transaction-level rows,
// provider ids, merchant/payee strings, notes or tags. So it cannot replay a
// publication; it proves what was published, for which period, and when.
// Replay stays with the private file backend.
//
// Inert on import: no driver load, no environment read, no network, no DDL.
// The schema is created by the owner's explicit setup SQL in
// docs/PRIVATE_PERIOD_HISTORY.md; nothing here migrates at startup.
// Connection ownership is the shared owner in
// scripts/settlement-evidence-postgres-connection.js (profile 'period-history').
const History = require('./private-period-history');

const { canonical, digest, validateCandidate, planAppend, periodKey } = History.contract;
const ENV_NAME = 'ATLAS_PERIOD_HISTORY_DATABASE_URL';
const DEFAULT_SCHEMA = 'atlas_period_history';
const PROJECTION_SCHEMA = 'atlas-private-period-history-projection/v1';
// Transaction-scoped advisory lock: 'ATLS' / 'PH'. Released at COMMIT/ROLLBACK
// and by PostgreSQL when the session ends, so no stale lock survives a crash.
const LOCK = [1096043603, 20552];
const BASELINES = History.KINDS.slice(0, 3);
const HEX64 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OWNED = new WeakSet();

function fail(code) { const e = new Error(code); e.code = code; OWNED.add(e); throw e; }
function owns(error) { return !!error && OWNED.has(error); }
// Re-issue the record contract's own fixed history-* codes as this module's;
// any other failure stays foreign and is mapped by the caller.
function adopt(fn) {
  try { return fn(); }
  catch (error) {
    let code; try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch { code = null; }
    if (!owns(error) && error instanceof Error && typeof code === 'string' && /^history-[a-z-]+$/.test(code) && error.message === code) fail(code);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Closed projection allowlist. Every level is an exact key set: a key outside
// it fails closed. Types are pinned so no provider object can ride along.
// ---------------------------------------------------------------------------
const NUM = 'number', BOOL = 'boolean', STR = 'string', DAY = 'date', TIME = 'instant', HASH = 'hash';
const PUBLICATION = Object.freeze({
  id: STR, label: STR, rangeLabel: STR, start: DAY, end: DAY, role: STR, projected: BOOL, lookback: BOOL,
  openingKnown: BOOL, paydayBoundaryOpening: BOOL, opening: NUM, openingAsOf: DAY, openingSource: STR,
  liveCurrentBalance: NUM, currentBalance: NUM,
  incomeAdded: NUM, incomeTotal: NUM, incomeTrust: STR, available: NUM,
  totalBillsThisPeriod: NUM, paidBills: NUM, remainingBills: NUM, periodBillLoad: NUM, periodBillLoadTrust: STR,
  afterRemainingBills: NUM, afterBills: NUM, afterBillsTrust: STR,
  budgetHold: NUM, budgetHoldTrust: STR, balanceAfterDeductionsTrust: STR,
  cycleUnresolved: BOOL, operatingPlanUnavailable: BOOL,
  afterHouseholdBudget: NUM, balanceAfterDeductions: NUM,
  predictedEndingBalance: NUM, predictedEndingBalanceIdentity: STR,
  plannedPeriodClose: NUM, plannedPeriodCloseTrust: STR,
  afterDebtRepayment: NUM, afterBigPurchases: NUM, projectedEnding: NUM,
  timelineRole: STR, timelineOffset: NUM, evidenceState: STR, budgetProgressAsOf: DAY,
});
const TERMS = Object.freeze({
  predictedEndingBalanceTerms: { periodIncome: NUM, assignedBills: NUM, householdBudgetHold: NUM,
    savingsItemSpending: NUM, balanceAfterDeductions: NUM, identity: STR, closes: BOOL },
  plannedPeriodCloseTerms: { opening: NUM, incomeAdded: NUM, periodBillLoad: NUM, budgetHold: NUM,
    annualSavingsNeed: NUM, earlierCardPurchaseReserve: NUM, savingsItemSpending: NUM, identity: STR, deficit: BOOL },
});
// Plan-defined rows only. Transaction-level `recon` / `pendingRecon` lists,
// payer labels and unplanned other-income items are never projected.
const ROWS = Object.freeze({
  householdBudget: { id: STR, label: STR, monthly: NUM, plannedWeekly: NUM, plannedPayday: NUM, planned: NUM,
    spent: NUM, remaining: NUM, overspend: NUM, hold: NUM, projected: BOOL },
  income: { id: STR, label: STR, kind: STR, date: DAY, planned: NUM, amount: NUM, actual: NUM, remaining: NUM,
    settlement: STR, status: STR, confidence: STR },
  bills: { id: STR, label: STR, kind: STR, date: DAY, planned: NUM, amount: NUM, actual: NUM, remaining: NUM,
    settlement: STR, status: STR, cardPaid: BOOL, confidence: STR, settlementBasis: STR },
});
const OTHER_INCOME = Object.freeze({ amount: NUM });
const PERIOD = Object.freeze({ start: DAY, end: DAY, timezone: STR });
const ENGINE = Object.freeze({ commit: STR, filesFingerprint: HASH });
const WINDOW = Object.freeze({ startDate: DAY, endDate: DAY, complete: BOOL, hasMore: BOOL, truncated: BOOL });
const PENDING = Object.freeze({ complete: BOOL, status: STR, basis: STR, hasMore: BOOL });
const PROVENANCE = Object.freeze({ provider: STR, fetchedAt: TIME, sourceFingerprint: HASH, policyFingerprint: HASH,
  accountMapFingerprint: HASH, identityFingerprint: HASH });
const CONTENT = Object.freeze({ period: 'object', kind: STR, asOf: DAY, declaredAt: TIME, effectiveFrom: DAY,
  reason: STR, planBasis: STR, engine: 'object', provenance: 'object', sourceCompleteness: 'object',
  closingState: STR, cutoff: 'object', publication: 'object' });
const RECORD = Object.freeze(['schema', 'sourceSchema', 'captureId', 'capturedAt', 'contentKey', 'content',
  'sequence', 'previousRevision', 'baselineRevision', 'revisionId']);

function scalar(value, type) {
  if (value === null) return true; // native null is retained, never turned into zero
  if (type === NUM) return typeof value === 'number' && Number.isFinite(value);
  if (type === BOOL) return typeof value === 'boolean';
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (type === DAY) return DATE.test(value);
  if (type === TIME) return INSTANT.test(value);
  if (type === HASH) return HEX64.test(value);
  return type === STR;
}
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function pick(source, spec) {
  // Copies only allowlisted keys that are present; types are checked by shape().
  if (!plain(source)) fail('history-projection-invalid');
  return Object.fromEntries(Object.keys(spec).filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
function shape(value, spec, { required = [] } = {}) {
  if (!plain(value)) fail('history-projection-invalid');
  for (const key of Object.keys(value)) if (!Object.hasOwn(spec, key) || !scalar(value[key], spec[key])) fail('history-projection-invalid');
  for (const key of required) if (!Object.hasOwn(value, key)) fail('history-projection-invalid');
}
function rowsShape(list, spec) {
  if (!Array.isArray(list) || list.length > 500) fail('history-projection-invalid');
  for (const row of list) shape(row, spec);
}
function publicationShape(p) {
  if (!plain(p)) fail('history-projection-invalid');
  const allowed = new Set([...Object.keys(PUBLICATION), ...Object.keys(TERMS), ...Object.keys(ROWS), 'otherIncome']);
  for (const key of Object.keys(p)) if (!allowed.has(key)) fail('history-projection-invalid');
  shape(Object.fromEntries(Object.entries(p).filter(([key]) => Object.hasOwn(PUBLICATION, key))), PUBLICATION,
    { required: ['start', 'end'] });
  for (const [key, spec] of Object.entries(TERMS)) if (Object.hasOwn(p, key) && p[key] !== null) shape(p[key], spec);
  for (const [key, spec] of Object.entries(ROWS)) if (Object.hasOwn(p, key)) rowsShape(p[key], spec);
  if (Object.hasOwn(p, 'otherIncome') && p.otherIncome !== null) shape(p.otherIncome, OTHER_INCOME);
}
function contentShape(c, legacy) {
  if (!plain(c)) fail('history-projection-invalid');
  const h1 = ['sourceCompleteness', 'closingState', 'cutoff'];
  for (const key of Object.keys(c)) if (!Object.hasOwn(CONTENT, key)) fail('history-projection-invalid');
  const required = ['period', 'kind', 'asOf', 'declaredAt', 'effectiveFrom', 'reason', 'planBasis', 'engine', 'provenance', 'publication'];
  for (const key of [...required, ...(legacy ? [] : h1)]) if (!Object.hasOwn(c, key)) fail('history-projection-invalid');
  if (legacy && h1.some(key => Object.hasOwn(c, key))) fail('history-projection-invalid');
  for (const key of ['kind', 'asOf', 'declaredAt', 'effectiveFrom', 'planBasis']) if (!scalar(c[key], CONTENT[key])) fail('history-projection-invalid');
  if (!History.KINDS.includes(c.kind) || c.asOf === null) fail('history-projection-invalid');
  if (c.reason !== null && (typeof c.reason !== 'string' || c.reason.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(c.reason))) fail('history-projection-invalid');
  shape(c.period, PERIOD, { required: Object.keys(PERIOD) });
  shape(c.engine, ENGINE, { required: Object.keys(ENGINE) });
  if (!/^[a-f0-9]{40}$/.test(c.engine.commit)) fail('history-projection-invalid');
  const prov = c.provenance;
  if (!plain(prov)) fail('history-projection-invalid');
  for (const key of Object.keys(prov)) if (!Object.hasOwn(PROVENANCE, key) && key !== 'transactionWindow' && key !== 'pendingCoverage') fail('history-projection-invalid');
  shape(Object.fromEntries(Object.entries(prov).filter(([key]) => Object.hasOwn(PROVENANCE, key))), PROVENANCE,
    { required: Object.keys(PROVENANCE) });
  if (prov.transactionWindow !== null) shape(prov.transactionWindow, WINDOW);
  if (prov.pendingCoverage !== null) shape(prov.pendingCoverage, PENDING);
  if (!legacy) {
    const s = c.sourceCompleteness;
    if (!plain(s) || Object.keys(s).sort().join(',') !== 'reasons,status' || !Array.isArray(s.reasons)
        || !s.reasons.every(code => History.REASONS.includes(code)) || !['complete', 'incomplete'].includes(s.status)) fail('history-projection-invalid');
    if (!['provisional', 'complete-at-capture'].includes(c.closingState)) fail('history-projection-invalid');
    shape(c.cutoff, { rule: STR, end: DAY, tz: STR }, { required: ['rule', 'end', 'tz'] });
  }
  publicationShape(c.publication);
  if (c.publication.start !== c.period.start || c.publication.end !== c.period.end) fail('history-projection-invalid');
}
function recordShape(row) {
  if (!plain(row) || Object.keys(row).sort().join(',') !== RECORD.slice().sort().join(',')) fail('history-projection-invalid');
  if (row.schema !== PROJECTION_SCHEMA || ![History.SCHEMA, History.LEGACY_SCHEMA].includes(row.sourceSchema)
      || !HEX64.test(row.captureId) || !HEX64.test(row.contentKey) || !HEX64.test(row.revisionId)
      || !INSTANT.test(row.capturedAt) || !Number.isSafeInteger(row.sequence) || row.sequence < 1
      || (row.previousRevision !== null && !HEX64.test(row.previousRevision))
      || (row.baselineRevision !== null && !HEX64.test(row.baselineRevision))) fail('history-projection-invalid');
  contentShape(row.content, row.sourceSchema === History.LEGACY_SCHEMA);
}

// Backup guard behind the structural allowlist (which is the primary guard).
// Two kinds of provider text are collected from the capture's private evidence:
//  - FREE text: payees, merchants, notes, tags, account names and provider ids,
//    from transactions and their split `children`, accounts, tags and the
//    free-text/id fields of `plaid_metadata`. Any projected string value that
//    contains one fails closed.
//  - CATEGORY names: provider categories, `category_name` and Plaid category
//    arrays. These are household taxonomy words ("Bills", "Insurance") that
//    also occur inside Forecast's fixed identity strings and owner plan labels,
//    so they are checked only against label-like values, and a budget-row
//    label exactly equal to one is allowed: Forecast's fixed budget labels
//    ("Groceries", "Fuel") deliberately share that vocabulary.
// A projected value that is exactly an owner plan string is owner text, never
// a provider leak. Dates, instants and fingerprints are fixed-format.
const ACCOUNT_TEXT = ['id', 'name', 'display_name', 'institution_name', 'official_name', 'mask'];
const PROVIDER_TEXT = Object.freeze({
  transactions: ['id', 'payee', 'original_name', 'display_name', 'notes', 'display_notes', 'external_id',
    'account_id', 'plaid_account_id', 'manual_account_id', 'asset_id', 'recurring_payee', 'recurring_description', 'parent_id', 'group_id'],
  accounts: ACCOUNT_TEXT, plaid_accounts: ACCOUNT_TEXT, manual_accounts: ACCOUNT_TEXT, assets: ACCOUNT_TEXT,
  tags: ['id', 'name', 'description'],
});
const PLAID_FREE_TEXT = ['name', 'merchant_name', 'original_description', 'account_owner', 'transaction_id',
  'pending_transaction_id', 'account_id', 'check_number', 'authorized_date', 'website', 'logo_url'];
const PLAID_NESTED = { location: ['address', 'city', 'store_number'], payment_meta: ['payee', 'payer', 'reference_number', 'ppd_id'],
  counterparties: ['name', 'entity_id', 'website'] };
const LABEL_KEYS = new Set(['label', 'rangeLabel', 'reason', 'openingSource', 'provider', 'id']);
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, out));
  return out;
}
// Projected string values with their key, and whether they sit on a budget row.
function projectedValues(value, key = null, budgetRow = false, out = []) {
  if (typeof value === 'string') out.push({ key, budgetRow, text: value.toLowerCase() });
  else if (Array.isArray(value)) value.forEach(item => projectedValues(item, key, budgetRow, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value))
    projectedValues(v, k, budgetRow || key === 'householdBudget', out);
  return out;
}
function providerText(candidate) {
  const input = candidate.content.evidence?.input || {};
  const payload = input.payload || {};
  const free = new Set(), categories = new Set();
  const add = (set, value) => {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text === 'string' && text.trim().length >= 3) set.add(text.trim().toLowerCase());
  };
  const rows = name => (Array.isArray(payload[name]) ? payload[name] : []).filter(row => row && typeof row === 'object');
  const transaction = row => {
    for (const key of PROVIDER_TEXT.transactions) add(free, row[key]);
    for (const tag of Array.isArray(row.tags) ? row.tags : []) add(free, typeof tag === 'string' ? tag : tag?.name);
    add(categories, row.category_name); add(categories, row.category_group_name);
    const meta = row.plaid_metadata;
    if (meta && typeof meta === 'object') {
      for (const key of PLAID_FREE_TEXT) add(free, meta[key]);
      for (const [key, fields] of Object.entries(PLAID_NESTED))
        for (const item of [meta[key]].flat()) if (item && typeof item === 'object') for (const field of fields) add(free, item[field]);
      for (const name of [meta.category].flat()) add(categories, name);
    }
    for (const child of Array.isArray(row.children) ? row.children : []) if (child && typeof child === 'object') transaction(child);
  };
  rows('transactions').forEach(transaction);
  for (const name of ['accounts', 'plaid_accounts', 'manual_accounts', 'assets', 'tags'])
    for (const row of rows(name)) for (const key of PROVIDER_TEXT[name]) add(free, row[key]);
  const category = row => {
    add(categories, row.name); add(categories, row.group_name);
    for (const child of Array.isArray(row.children) ? row.children : []) if (child && typeof child === 'object') category(child);
  };
  rows('categories').forEach(category);
  return { free: [...free], categories: [...categories] };
}
function providerTextLeaks(candidate, content) {
  const plan = new Set(strings(candidate.content.evidence?.input?.data?.plan).map(text => text.trim().toLowerCase()));
  const values = projectedValues(content).filter(({ text }) => !HEX64.test(text) && !DATE.test(text)
    && !/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d{3})?z$/.test(text) && !plan.has(text.trim()));
  // Provider text identical to an owner plan string is owner vocabulary.
  const own = list => list.filter(value => !plan.has(value));
  const found = providerText(candidate), free = own(found.free), categories = own(found.categories);
  return values.some(({ key, budgetRow, text }) => free.some(value => text.includes(value))
    || (LABEL_KEYS.has(key) && categories.some(value => text.includes(value) && !(budgetRow && key === 'label' && text.trim() === value))));
}

function project(candidate) {
  adopt(() => validateCandidate(candidate));
  const c = candidate.content, legacy = candidate.schema === History.LEGACY_SCHEMA;
  const p = c.publication;
  const publication = pick(p, PUBLICATION);
  for (const key of Object.keys(TERMS)) if (Object.hasOwn(p, key)) publication[key] = p[key] === null ? null : pick(p[key], TERMS[key]);
  for (const [key, spec] of Object.entries(ROWS)) {
    if (!Object.hasOwn(p, key)) continue;
    if (!Array.isArray(p[key])) fail('history-projection-invalid');
    // Unplanned other-income items can carry provider text; only plan rows stay.
    publication[key] = p[key].filter(row => !(key === 'income' && row?.otherIncome === true)).map(row => pick(row, spec));
  }
  if (Object.hasOwn(p, 'otherIncome')) publication.otherIncome = p.otherIncome === null ? null : pick(p.otherIncome, OTHER_INCOME);
  const prov = c.provenance;
  const content = {
    period: pick(c.period, PERIOD), kind: c.kind, asOf: c.asOf, declaredAt: c.declaredAt, effectiveFrom: c.effectiveFrom,
    reason: c.reason, planBasis: c.planBasis,
    engine: { commit: c.engine.commit, filesFingerprint: digest(c.engine.files) },
    provenance: { ...pick(prov, PROVENANCE),
      transactionWindow: prov.transactionWindow == null ? null : pick(prov.transactionWindow, WINDOW),
      pendingCoverage: prov.pendingCoverage == null ? null : pick(prov.pendingCoverage, PENDING) },
    ...(legacy ? {} : { sourceCompleteness: { status: c.sourceCompleteness.status, reasons: c.sourceCompleteness.reasons.slice() },
      closingState: c.closingState, cutoff: { ...c.cutoff } }),
    publication,
  };
  contentShape(content, legacy);
  // Compare provider text with projected string VALUES only, never keys.
  if (providerTextLeaks(candidate, content)) fail('history-projection-provider-text');
  return { schema: PROJECTION_SCHEMA, sourceSchema: candidate.schema, captureId: candidate.captureId,
    capturedAt: candidate.capturedAt, content };
}

// ---------------------------------------------------------------------------
// Store over one injected, already-verified session (query(text, values)).
// ---------------------------------------------------------------------------
function ident(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) || schema.startsWith('pg_')) fail('history-store-config-invalid');
  return '"' + schema + '"';
}
function sqlState(error) {
  try { return error?.diagnostic?.code ?? Object.getOwnPropertyDescriptor(error, 'code')?.value ?? null; } catch { return null; }
}
function verify(result) {
  if (!result || result.command !== 'SELECT' || !Array.isArray(result.rows)) fail('history-io-failed');
  const rows = [];
  for (const stored of result.rows) {
    let row;
    if (!stored || typeof stored.record !== 'string') fail('history-integrity-failed');
    try { row = JSON.parse(stored.record); } catch { fail('history-integrity-failed'); }
    recordShape(row);
    const { revisionId, ...body } = row;
    const baseline = rows.find(prior => periodKey(prior.content.period) === periodKey(row.content.period) && BASELINES.includes(prior.content.kind));
    // Byte-exact canonical text, recomputed hash, and an unbroken chain.
    if (canonical(row) !== stored.record || digest(body) !== revisionId || stored.revision_id !== revisionId
        || Number(stored.sequence) !== row.sequence || row.sequence !== rows.length + 1
        || row.previousRevision !== (rows.at(-1)?.revisionId || null)
        || row.baselineRevision !== (baseline?.revisionId || null)) fail('history-integrity-failed');
    rows.push(row);
  }
  return rows;
}

function createPeriodHistoryPostgresStore({ client, schema = DEFAULT_SCHEMA } = {}) {
  if (!client || typeof client.query !== 'function') fail('history-store-config-invalid');
  const table = ident(schema) + '.revisions';
  const SELECT_ALL = 'SELECT sequence, revision_id, record FROM ' + table + ' ORDER BY sequence';
  const INSERT = 'INSERT INTO ' + table + ' (sequence, revision_id, record) VALUES ($1, $2, $3)';
  async function q(text, values = []) { return client.query(text, values); }
  // One session: every whole operation (BEGIN..COMMIT, or a read) runs alone,
  // in call order, so concurrent callers never interleave a transaction.
  let tail = Promise.resolve();
  const serial = fn => (...args) => { const run = tail.then(() => fn(...args)); tail = run.catch(() => {}); return run; };
  async function append({ enabled = false, candidate } = {}) {
    if (enabled !== true) fail('history-capture-disabled');
    const base = project(candidate); // validates the full candidate first
    let open = false, inserted = false;
    try {
      await q('BEGIN'); open = true;
      const lock = await q('SELECT pg_catalog.pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked', LOCK);
      if (lock?.rows?.[0]?.locked !== true) fail('history-capture-busy');
      const rows = verify(await q(SELECT_ALL));
      const decision = adopt(() => planAppend(rows, candidate));
      if (decision.status === 'duplicate') {
        await q('ROLLBACK'); open = false;
        return { status: 'duplicate', ...History.metadata(decision.row) };
      }
      const body = { ...base, ...decision.chain };
      const row = { ...body, revisionId: digest(body) };
      recordShape(row);
      inserted = true;
      await q(INSERT, [row.sequence, row.revisionId, canonical(row)]);
      await q('COMMIT'); open = false;
      return { status: 'appended', ...History.metadata(row) };
    } catch (error) {
      if (open) { try { await q('ROLLBACK'); } catch { /* session is retired by its owner */ } }
      if (owns(error)) throw error;
      if (sqlState(error) === '23505') fail('history-capture-busy');
      // Once the INSERT was sent, commit is unknown: inspect or retry; a
      // retry of the same candidate returns the committed revision.
      fail(inserted ? 'history-commit-uncertain' : 'history-io-failed');
    }
  }
  async function read({ revisionId, expectedHead } = {}) {
    let rows;
    try { rows = verify(await q(SELECT_ALL)); }
    catch (error) { if (owns(error)) throw error; fail('history-io-failed'); }
    if (expectedHead !== undefined && (!HEX64.test(expectedHead || '') || rows.at(-1)?.revisionId !== expectedHead)) fail('history-head-mismatch');
    if (revisionId === undefined) return rows.map(History.metadata);
    if (!HEX64.test(revisionId || '')) fail('history-revision-invalid');
    const row = rows.find(item => item.revisionId === revisionId);
    if (!row) fail('history-revision-unavailable');
    return row;
  }
  return Object.freeze({ append: serial(append), read: serial(read), owns });
}

// ---------------------------------------------------------------------------
// Render environment -> verified connection config. Errors are code-only and
// never echo the value, its host, user or password.
// ---------------------------------------------------------------------------
function parseDatabaseUrl(value) {
  if (value === undefined || value === null || value === '') fail('history-store-unconfigured');
  if (typeof value !== 'string' || value.length > 2048) fail('history-store-config-invalid');
  let url;
  try { url = new URL(value); } catch { fail('history-store-config-invalid'); }
  let user, password;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { fail('history-store-config-invalid'); }
  const params = [...url.searchParams.entries()];
  const database = url.pathname.replace(/^\//, '');
  const host = url.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || !host || !user || !password
      || host.includes('-pooler') || /^[\d.]+$/.test(host) || host.startsWith('[')
      || !/^[a-z_][a-z0-9_]{0,62}$/.test(database)) fail('history-store-config-invalid');
  // verify-full only: certificate chain AND hostname. Anything weaker, or any
  // other parameter, is refused rather than ignored.
  if (params.length !== 1 || params[0][0] !== 'sslmode' || params[0][1] !== 'verify-full') fail('history-store-tls-required');
  const port = url.port === '' ? 5432 : Number(url.port);
  return { host, port, database, user, password, ssl: { rejectUnauthorized: true, servername: host } };
}

async function openPeriodHistoryPostgres({ env = process.env, Client, schema = DEFAULT_SCHEMA } = {}) {
  const config = parseDatabaseUrl(env[ENV_NAME]);
  ident(schema);
  // Lazy: the shared connection owner imports this module for its adapter.
  const { createSettlementEvidencePostgresConnection } = require('./settlement-evidence-postgres-connection');
  let owner;
  try {
    owner = await createSettlementEvidencePostgresConnection({ profile: 'period-history',
      Client: Client || require('pg').Client, config, schema });
  } catch (error) {
    const e = new Error('history-store-unavailable'); e.code = 'history-store-unavailable';
    // Sanitized stage/category/SQLSTATE from the owner; never driver text.
    e.diagnostic = error?.diagnostic ? Object.freeze({ ...error.diagnostic }) : null;
    OWNED.add(e); throw e;
  }
  const wrap = fn => async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      if (owns(error)) throw error;
      const e = new Error('history-store-unavailable'); e.code = 'history-store-unavailable';
      e.diagnostic = error?.diagnostic ? Object.freeze({ ...error.diagnostic }) : null;
      OWNED.add(e); throw e;
    }
  };
  return Object.freeze({ append: wrap(owner.periodHistory.append), read: wrap(owner.periodHistory.read),
    retire: owner.retire, status: owner.status });
}

module.exports = { ENV_NAME, DEFAULT_SCHEMA, PROJECTION_SCHEMA, project, createPeriodHistoryPostgresStore,
  parseDatabaseUrl, openPeriodHistoryPostgres, owns };
