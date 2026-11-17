'use strict';
// Owner-authorized direct Lunch Money evidence and bounded edits (2026-10-02).
// No Atlas calculations/canonical writes. References and previews are RAM-only.
const crypto = require('crypto');
const z = require('zod/v4');
const Provider = require('./provider-observe.js');
const Credentials = require('./local-credentials.js');
const Standing = require('./assistant-standing-corrections.js');
const Cleanup = require('./assistant-cleanup-instructions.js');
const CleanupPolicy = require('./assistant-cleanup-policy.js');
const READ_SCOPE = 'atlas.transactions.read';
const WRITE_SCOPE = 'atlas.transactions.write';
const TTL = 10 * 60 * 1000;
const MAX_REFS = 10000;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v =>
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const ref = z.string().regex(/^(tx|cat|acct|tag)-[a-f0-9]{24}$/);
const money = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/);
// Provider evidence is a decimal string with up to four places. Read it
// verbatim; the separate `money`/cents contract governs caller/write input.
const providerMoney = z.string().max(64).regex(/^-?\d+(\.\d{1,4})?$/);
const child = z.object({ amount: money, categoryRef: ref.nullable(), notes: z.string().max(1000).optional() }).strict();
const changes = z.object({ categoryRef: ref.nullable().optional(), notes: z.string().max(1000).optional(),
  payee: Cleanup.text.optional(), notesAppend: Cleanup.note.optional(),
  tagRefsAdd: z.array(ref).min(1).max(20).optional(),
  transferLabel: z.object({ fromAccountRef: ref, toAccountRef: ref }).strict().optional(),
}).strict().refine(v => Object.keys(v).length > 0 && !(v.notes !== undefined && v.notesAppend !== undefined)
  && !(v.payee !== undefined && v.transferLabel !== undefined)
  && (!v.tagRefsAdd || new Set(v.tagRefsAdd).size === v.tagRefsAdd.length));
const standingChanges = z.object({ categoryRef: ref.optional(), notesAppend: z.string().min(1).max(500).optional() })
  .strict().refine(v => Object.keys(v).length > 0);
const delegatedReview = z.object({
  schema: z.literal(Standing.DELEGATED_POLICY), status: z.enum(['resolved', 'uncertain']),
  sources: z.array(z.object({ system: z.enum(['gmail', 'library', 'user-provided', 'other-authorized']),
    reference: z.string().min(1).max(300), excerptDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(5),
  facts: z.object({ date, payee: z.string().min(1).max(200), amount: money, currency: z.string().regex(/^[a-z]{3}$/),
    completeReceipt: z.boolean(), items: z.array(z.object({ description: z.string().min(1).max(200),
      amount: money, categoryRef: ref }).strict()).min(1).max(40) }).strict(),
  rationale: z.string().min(1).max(1000), issues: z.array(z.string().max(200)).max(10),
}).strict();
const grantRef = z.string().regex(/^grant-[a-f0-9]{24}$/);
const evidenceRef = z.string().regex(/^evidence-[a-f0-9]{24}$/);
const cleanupReview = z.object({ schema: z.literal(CleanupPolicy.POLICY), status: z.enum(['resolved', 'uncertain']),
  sources: delegatedReview.shape.sources, rationale: delegatedReview.shape.rationale, issues: delegatedReview.shape.issues,
  facts: z.object({ date, payee: Cleanup.text, originalBankDescription: z.string().min(1).max(2000),
    amount: providerMoney, currency: z.string().regex(/^[a-z]{3}$/) }).strict(),
  supportedChanges: Cleanup.createSchema.shape.changes, categoryReceipt: delegatedReview.optional(),
}).strict();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
function monthSpan(startMonth, endMonth) {
  const [sy, sm] = startMonth.split('-').map(Number);
  const [ey, em] = endMonth.split('-').map(Number);
  return (ey - sy) * 12 + (em - sm);
}
const schemas = {
  // Recurring-item schedule evidence (S0, LEDGER A; Dale 2026-11-17). Both dates
  // set the provider's matches window; the span is capped like the transactions read.
  recurring: z.object({ startDate: date, endDate: date }).strict()
    .refine(v => v.startDate <= v.endDate && (Date.parse(v.endDate) - Date.parse(v.startDate)) <= 366 * 86400000),
  balanceHistory: z.object({ startMonth: month, endMonth: month }).strict()
    .refine(v => monthSpan(v.startMonth, v.endMonth) >= 0 && monthSpan(v.startMonth, v.endMonth) <= 119),
  cleanupInstruction: Cleanup.createSchema,
  submitStandingEvidence: z.object({ transactionRef: ref, grantRef, categoryRef: ref, review: delegatedReview }).strict(),
  standingAudit: z.object({ grantRef }).strict(),
  submitCleanupEvidence: z.object({ transactionRef: ref, grantRef, cleanupInstruction: Cleanup.schema, review: cleanupReview }).strict(),
  prepareStanding: z.object({ transactionRef: ref, grantRef, evidenceRef, changes: standingChanges.optional(),
    cleanupInstruction: Cleanup.schema.optional() }).strict().refine(v => !!v.changes !== !!v.cleanupInstruction),
  applyStanding: z.object({ previewId: z.string().regex(/^edit-[a-f0-9]{48}$/) }).strict(),
  catalog: z.object({ includeTags: z.boolean().optional() }).strict(),
  query: z.object({ startDate: date, endDate: date, categoryRef: ref.optional(),
    accountRef: ref.optional(), excludeAccountRef: ref.optional(), merchant: z.string().trim().min(1).max(120).optional(),
    offset: z.number().int().min(0).max(10000).optional(), limit: z.number().int().min(1).max(200).optional() }).strict()
    .refine(v => v.startDate <= v.endDate && (Date.parse(v.endDate) - Date.parse(v.startDate)) <= 366 * 86400000
      && !(v.accountRef && v.excludeAccountRef)),
  prepare: z.object({ transactionRef: ref, changes: changes.optional(), splits: z.array(child).min(2).max(20).optional(),
    cleanupInstruction: Cleanup.schema.optional() })
    .strict().refine(v => [v.changes, v.splits, v.cleanupInstruction].filter(Boolean).length === 1),
  apply: z.object({ previewId: z.string().regex(/^edit-[a-f0-9]{48}$/), confirmed: z.literal(true) }).strict(),
};
function cents(value) {
  if (typeof value !== 'string' || !money.safeParse(value).success) throw new Error('invalid-amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (negative ? -1 : 1) * (Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
}
function providerCents(value) {
  if (!providerMoney.safeParse(value).success) throw new Error('invalid-provider-amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  // Extra provider places may represent whole cents, never rounded fractions.
  if (/[1-9]/.test(fraction.slice(2))) throw new Error('invalid-provider-amount');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid-provider-amount');
  return Number(negative ? -magnitude : magnitude);
}
function fingerprint(tx) { return crypto.createHash('sha256').update(JSON.stringify(tx)).digest('hex'); }
function stableAuthorization({ financialEffects, ...binding }) { return binding; }
function fail(reason) { return { status: 'unavailable', reason, writesAtlasState: false }; }
class ProviderRequestError extends Error {
  constructor(code, stage, upstreamStatus) {
    super(code);
    this.stage = stage;
    if (Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599) {
      this.upstreamStatus = upstreamStatus;
    }
  }
}
const READ_ERROR_CODES = new Set([
  'invalid-provider-amount', 'malformed-transaction', 'malformed-date',
  'invalid-provider-identity', 'invalid-category-identity', 'reference-capacity',
  'reference-expired-or-unavailable', 'category-evidence-unavailable',
  'account-evidence-unavailable', 'catalog-unavailable', 'coverage-unavailable',
  'duplicate-provider-identity',
  'tag-evidence-unavailable', 'balance-history-unavailable', 'recurring-items-unavailable',
]);
function readFailure(operation, error) {
  // Never expose error text, request URLs/headers, provider bodies or IDs.
  const requestError = error instanceof ProviderRequestError;
  const code = requestError || READ_ERROR_CODES.has(error && error.message)
    ? error.message : 'unexpected-failure';
  const stage = requestError ? error.stage
    : code === 'invalid-provider-amount' || code === 'malformed-transaction'
      ? 'transaction-validation' : operation;
  return { ...fail('lunchmoney-operation-unavailable'), diagnostic: { stage, code,
    ...(requestError && error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}) } };
}
function requiredScope(operation) {
  if (['prepareStanding', 'applyStanding', 'submitStandingEvidence', 'submitCleanupEvidence', 'standingAudit'].includes(operation)) return Standing.SCOPE;
  if (operation === 'prepare' || operation === 'apply') return WRITE_SCOPE;
  if (operation === 'catalog' || operation === 'query' || operation === 'balanceHistory' || operation === 'recurring'
    || operation === 'cleanupInstruction') return READ_SCOPE;
  return null;
}
function scopeDenial(operation, auth = {}) {
  const required = requiredScope(operation);
  if (!required) return fail('invalid-arguments');
  if (required === Standing.SCOPE) {
    return [READ_SCOPE, WRITE_SCOPE, Standing.SCOPE].every(scope => (auth.scopes || []).includes(scope))
      ? null : fail('standing-correction-scopes-required');
  }
  if (!(auth.scopes || []).includes(required)) {
    return fail(required === WRITE_SCOPE
      ? 'transaction-write-scope-required'
      : 'transaction-read-scope-required');
  }
  return null;
}
function safeText(value) { return typeof value === 'string' ? value.slice(0, 2000) : null; }

// Keep provider decimal precision/sign and semantic balance dates. A catalog
// GET, object edit, or successful sync is not proof of today's bank balance.
function providerDate(value) {
  if (typeof value !== 'string') return null;
  return date.safeParse(value).success || z.iso.datetime({ offset: true }).safeParse(value).success
    ? value : null;
}
function accountEvidence(row, kind, observedAt) {
  const amount = typeof row.balance === 'string' && row.balance.length <= 64
    && /^-?\d+(\.\d{1,4})?$/.test(row.balance) ? row.balance : null;
  const currency = typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency)
    ? row.currency : null;
  const dateField = kind === 'plaid' ? 'balance_last_update' : 'balance_as_of';
  const asOf = providerDate(row[dateField]);
  const status = amount !== null && currency !== null ? 'reported' : 'unavailable';
  return {
    accountType: safeText(row.type), subtype: safeText(row.subtype),
    institution: safeText(row.institution_name), accountStatus: safeText(row.status),
    closedOn: date.safeParse(row.closed_on).success ? row.closed_on : null,
    balance: {
      status, amount: status === 'reported' ? amount : null, currency,
      asOf, asOfField: asOf ? dateField : null,
      freshness: !asOf ? 'unknown' : Date.parse(asOf) > observedAt ? 'future-date' : 'provider-dated',
      trust: 'unknown', source: 'Lunch Money v2',
      ...(status === 'unavailable' ? { reason: amount === null
        ? 'balance-missing-or-invalid' : 'currency-missing-or-invalid' } : {}),
    },
    // These are useful diagnostics, never substitutes for balance.asOf.
    timestamps: {
      updatedAt: providerDate(row.updated_at), lastFetchedAt: providerDate(row.last_fetch),
      lastImportedAt: providerDate(row.last_import),
      lastSuccessfulSyncAt: providerDate(row.plaid_last_successful_update),
    },
  };
}

function createService(options = {}) {
  const env = options.env || process.env;
  // Runtime construction is default-off. Reusable preview recipes confer no
  // standing authority and never widen the category-only grant contract.
  const standing = options.standingCorrections || {};
  const blockedStandingGrants = new Set();
  const now = options.now || Date.now;
  const refs = new Map();
  const previews = new Map();
  const locks = new Set();
  const salt = crypto.randomBytes(32);
  const fetcher = options.fetch || fetch;
  const resolveToken = options.resolveToken || (async () => (await Credentials.resolveLunchMoneyAccessToken({ env })).token);
  function sweep() {
    for (const map of [refs, previews]) for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  }
  function alias(kind, id, principal, extra = {}) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid-provider-identity');
    sweep();
    const key = kind + '-' + crypto.createHmac('sha256', salt).update(`${principal}:${kind}:${id}`).digest('hex').slice(0, 24);
    if (!refs.has(key) && refs.size >= MAX_REFS) throw new Error('reference-capacity');
    refs.set(key, { ...refs.get(key), kind, id, principal, ...extra, expires: now() + TTL });
    return key;
  }
  function resolve(key, kind, principal) {
    sweep(); const value = refs.get(key);
    if (!value || value.kind !== kind || value.principal !== principal) throw new Error('reference-expired-or-unavailable');
    return value;
  }
  async function request(method, path, body, beforeSend) {
    const stage = path.startsWith('/transactions') ? 'transactions-request'
      : path.startsWith('/balance_history') ? 'balance-history-request'
      : path.startsWith('/recurring_items') ? 'recurring-items-request'
        : path.startsWith('/categories') ? 'categories-request'
          : path.startsWith('/tags') ? 'tags-request'
            : path.startsWith('/plaid_accounts') ? 'synced-accounts-request' : 'manual-accounts-request';
    let token;
    try { token = await resolveToken(); }
    catch (_) { throw new ProviderRequestError('credential-unavailable', stage); }
    if (!token) throw new ProviderRequestError('credential-unavailable', stage);
    let base;
    try { base = Provider.lunchMoneyApiBase(env); }
    catch (_) { throw new ProviderRequestError('provider-configuration-invalid', stage); }
    // Run the standing final authorization/reservation after credentials resolve,
    // immediately before the single provider request. It may reject the write.
    if (beforeSend) await beforeSend({ credentialDigest: fingerprint(token) });
    let response;
    try {
      response = await fetcher(base + path, { method, redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new ProviderRequestError(error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'provider-request-timeout' : 'provider-network-error', stage);
    }
    if (!response.ok) throw new ProviderRequestError('provider-request-failed', stage, response.status);
    try { return await response.json(); }
    catch (_) { throw new ProviderRequestError('provider-response-invalid-json', stage, response.status); }
  }
  function accountKey(tx) {
    if (tx.plaid_account_id != null) return ['plaid', tx.plaid_account_id];
    if (tx.manual_account_id != null) return ['manual', tx.manual_account_id];
    return null;
  }
  // Account ID namespaces may overlap; keep their reference namespace distinct.
  function accountAlias(kind, id, principal, label) {
    const accountPrincipal = principal + ':' + kind;
    const key = alias('acct', id, accountPrincipal, { accountType: kind, label });
    refs.get(key).principal = principal;
    return key;
  }
  function project(tx, principal, categories, accounts, tags) {
    if (!tx || !date.safeParse(tx.date).success || typeof tx.currency !== 'string' || !/^[a-z]{3}$/.test(tx.currency) || typeof tx.amount !== 'string') throw new Error('malformed-transaction');
    if (!providerMoney.safeParse(tx.amount).success) throw new Error('invalid-provider-amount');
    const account = accountKey(tx);
    const accountRow = account && accounts.find(a => a.type === account[0] && a.providerId === account[1]);
    return { transactionRef: alias('tx', tx.id, principal), date: tx.date, amount: tx.amount,
      currency: tx.currency, payee: safeText(tx.payee), notes: safeText(tx.notes),
      originalBankDescription: safeText(tx.original_name),
      originalBankDescriptionStatus: typeof tx.original_name === 'string' ? 'provider-reported' : 'unavailable',
      tags: Array.isArray(tx.tag_ids) ? tx.tag_ids.map(id => {
        const tag = tags?.find(row => row.providerId === id);
        if (tags && !tag) throw new Error('tag-evidence-unavailable');
        const tagRef = alias('tag', id, principal, tag ? { label: tag.name } : {});
        return { tagRef, name: tag ? tag.name : refs.get(tagRef).label || null };
      }) : null,
      categoryRef: tx.category_id == null ? null : alias('cat', tx.category_id, principal),
      category: categories.find(c => c.id === tx.category_id)?.name || null,
      accountRef: accountRow?.ref || null, account: accountRow?.label || null,
      accountType: account?.[0] || 'unknown', pending: tx.is_pending === true,
      splitParent: tx.is_split_parent === true, splitChild: tx.split_parent_id != null,
      groupParent: tx.is_group_parent === true, groupChild: tx.group_parent_id != null,
      updatedAt: tx.updated_at || null };
  }
  async function catalogData(principal, includeBalances = false, credentialGate) {
    const [c, p, m] = await Promise.all([request('GET', '/categories', undefined, credentialGate), request('GET', '/plaid_accounts', undefined, credentialGate), request('GET', '/manual_accounts', undefined, credentialGate)]);
    if (!Array.isArray(c.categories) || !Array.isArray(p.plaid_accounts) || !Array.isArray(m.manual_accounts)) throw new Error('catalog-unavailable');
    const categories = c.categories.flatMap(row => [row, ...(row.children || [])]);
    const observedAt = now();
    const accounts = [
      ...p.plaid_accounts.map(a => ({ type: 'plaid', providerId: a.id, label: safeText(a.display_name || a.name),
        ...(includeBalances ? { evidence: accountEvidence(a, 'plaid', observedAt) } : {}) })),
      ...m.manual_accounts.map(a => ({ type: 'manual', providerId: a.id, label: safeText(a.name),
        ...(includeBalances ? { evidence: accountEvidence(a, 'manual', observedAt) } : {}) })),
    ].map(a => ({ ...a, ref: accountAlias(a.type, a.providerId, principal, a.label) }));
    return { categories, accounts, observedAt };
  }
  async function categoryId(value, principal, credentialGate) {
    if (value === null) return null;
    const id = resolve(value, 'cat', principal).id;
    const category = await request('GET', '/categories/' + id, undefined, credentialGate);
    if (category.id !== id || category.is_group || category.archived) throw new Error('category-not-editable');
    return id;
  }
  async function tagsData(principal, credentialGate) {
    const data = await request('GET', '/tags', undefined, credentialGate);
    if (!Array.isArray(data.tags)) throw new Error('tag-evidence-unavailable');
    const seen = new Set();
    return data.tags.map(row => {
      if (!Number.isSafeInteger(row.id) || row.id < 1 || seen.has(row.id)
          || typeof row.name !== 'string' || !row.name.trim()) throw new Error('tag-evidence-unavailable');
      seen.add(row.id);
      return { tagRef: alias('tag', row.id, principal, { label: row.name }), name: safeText(row.name),
        archived: row.archived === true, providerId: row.id };
    });
  }
  function tagIds(tx) {
    if (!Array.isArray(tx.tag_ids) || tx.tag_ids.some(id => !Number.isSafeInteger(id) || id < 1)
        || new Set(tx.tag_ids).size !== tx.tag_ids.length) throw new Error('tag-evidence-unavailable');
    return [...tx.tag_ids].sort((a, b) => a - b);
  }
  async function metadataContext(body, principal, transfer, credentialGate) {
    const context = {};
    if (body.additional_tag_ids) {
      const tags = await tagsData(principal, credentialGate);
      context.tags = body.additional_tag_ids.map(id => {
        const row = tags.find(t => t.providerId === id && !t.archived);
        if (!row) throw new Error('tag-not-editable');
        return { id, name: row.name };
      });
    }
    if (transfer) {
      const cat = await catalogData(principal, false, credentialGate);
      context.transfer = [transfer.fromAccountRef, transfer.toAccountRef].map(key => {
        const row = cat.accounts.find(a => a.ref === key);
        if (!row || !row.label) throw new Error('transfer-account-unavailable');
        return { type: row.type, id: row.providerId, name: row.label };
      });
    }
    return context;
  }
  function editable(tx) {
    if (tx.is_pending || tx.is_split_parent || tx.split_parent_id != null
      || tx.is_group_parent || tx.group_parent_id != null || tx.status === 'delete_pending') throw new Error('transaction-not-editable');
  }
  async function catalog(input, auth, credentialGate) {
    const { categories, accounts, observedAt } = await catalogData(auth.principal, true, credentialGate);
    const tags = input.includeTags ? await tagsData(auth.principal, credentialGate) : null;
    return { status: 'ok', source: 'Lunch Money v2', observedAt: new Date(observedAt).toISOString(),
      coverage: 'complete-provider-account-response', writesAtlasState: false, providerWrite: false,
      note: 'All synced and manual accounts returned by Lunch Money, including savings and closed/inactive accounts. This is not proof that every household account is linked or every bank has synced. Balances are provider-reported, not independently verified; trust remains unknown. Show each balance date and flag old, missing, or future dates. observedAt and sync/object timestamps are not balance dates. Positive asset balances are held funds; positive liability balances are amounts owed. Preserve signs and currencies; never combine assets with debt or different currencies. Savings, restricted or business funds, and available credit are not automatically spendable household cash. Forecast remains the planner.',
      referenceExpiresInSeconds: TTL / 1000,
      categories: categories.map(c => ({ categoryRef: alias('cat', c.id, auth.principal), name: safeText(c.name),
        archived: c.archived === true, group: c.is_group === true, income: c.is_income === true,
        excludedFromBudget: c.exclude_from_budget === true, excludedFromTotals: c.exclude_from_totals === true })),
      accounts: accounts.map(a => ({ accountRef: a.ref, name: a.label, type: a.type, ...a.evidence })),
      ...(tags ? { tags: tags.map(({ providerId, ...row }) => row) } : {}) };
  }
  // Read-only monthly balance history (GET /balance_history, v2.11.1).
  // Monthly provider evidence only: it is not an Atlas stored opening, not a
  // pay-period snapshot and not a plan. Missing values stay unavailable.
  const BALANCE_HISTORY_SOURCE_IDS = { plaid: 'plaid_account_id', manual: 'manual_account_id',
    crypto_manual: 'crypto_manual_id', crypto_synced: 'crypto_synced_id', deleted: 'deleted_account_id' };
  function balanceHistoryEntry(row) {
    if (!row || typeof row !== 'object' || !month.safeParse(row.month).success
        || !['historical', 'current'].includes(row.type)) throw new Error('balance-history-unavailable');
    // The provider entry id is validated for historical rows but NEVER
    // returned: raw provider IDs may not cross the OAuth boundary
    // (ARCHITECTURE.md). Only the entry kind (historical/current) is kept.
    if (row.type === 'historical') {
      if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('invalid-provider-identity');
    }
    const amount = typeof row.balance === 'string' && row.balance.length <= 64
      && /^-?\d+(\.\d{1,4})?$/.test(row.balance) ? row.balance : null;
    const currency = typeof row.currency === 'string' && /^[a-z]{3}$/.test(row.currency) ? row.currency : null;
    const status = amount !== null && currency !== null ? 'reported' : 'unavailable';
    return { month: row.month, entryType: row.type,
      balance: { status, amount: status === 'reported' ? amount : null, currency,
        trust: 'unknown', source: 'Lunch Money v2',
        ...(status === 'unavailable' ? { reason: amount === null
          ? 'balance-missing-or-invalid' : 'currency-missing-or-invalid' } : {}) } };
  }
  async function balanceHistory(input, auth) {
    const { accounts } = await catalogData(auth.principal);
    const params = new URLSearchParams({ start_month: input.startMonth, end_month: input.endMonth });
    const data = await request('GET', '/balance_history?' + params);
    if (!data || !Array.isArray(data.balance_history)) throw new Error('balance-history-unavailable');
    const seenSources = new Set();
    const rows = [];
    for (const block of data.balance_history) {
      const source = block && typeof block === 'object' ? block.source : null;
      const idField = source && BALANCE_HISTORY_SOURCE_IDS[source.type];
      if (!idField || !Number.isSafeInteger(source[idField]) || source[idField] < 1
          || !Array.isArray(block.balances)) throw new Error('balance-history-unavailable');
      let sourceKey = source.type + ':' + source[idField];
      if (source.type === 'crypto_synced') {
        // Official v2.11.1 stream identity for a synced-crypto source is
        // crypto_synced_id PLUS symbol: distinct symbols under one
        // connection are distinct streams, not duplicates. The documented
        // symbol contract is a required string of 1-25 characters with no
        // pattern or normalization, so the exact provider symbol is
        // preserved in the identity. A missing, non-string, empty or
        // over-length symbol fails closed rather than collapsing streams.
        if (typeof source.symbol !== 'string' || source.symbol.length < 1 || source.symbol.length > 25)
          throw new Error('balance-history-unavailable');
        sourceKey += ':' + source.symbol;
      }
      if (seenSources.has(sourceKey)) throw new Error('duplicate-provider-identity');
      seenSources.add(sourceKey);
      // Only plaid/manual sources exist in the Atlas catalog. Crypto and
      // deleted-account sources are reported with an explicitly unavailable
      // mapping — never given an invented reference and never dropped.
      const account = (source.type === 'plaid' || source.type === 'manual')
        ? accounts.find(a => a.type === source.type && a.providerId === source[idField]) : null;
      const seenMonths = new Set();
      const entries = [];
      for (const raw of block.balances) {
        const entry = balanceHistoryEntry(raw);
        if (entry.month < input.startMonth || entry.month > input.endMonth) continue;
        if (seenMonths.has(entry.month)) throw new Error('duplicate-provider-identity');
        seenMonths.add(entry.month);
        entries.push(entry);
      }
      entries.sort((a, b) => a.month < b.month ? -1 : a.month > b.month ? 1 : 0);
      rows.push({ sortKey: sourceKey, accountRef: account?.ref || null, account: account?.label || null,
        sourceType: source.type,
        accountMapping: account ? 'catalog' : 'unavailable',
        ...(account ? {} : { accountMappingReason: source.type === 'plaid' || source.type === 'manual'
          ? 'account-not-in-current-catalog' : 'account-source-not-in-atlas-catalog' }),
        entries });
    }
    rows.sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
    return { status: 'ok', source: 'Lunch Money v2', observedAt: new Date(now()).toISOString(),
      window: { startMonth: input.startMonth, endMonth: input.endMonth },
      coverage: 'complete-provider-response', writesAtlasState: false, providerWrite: false,
      granularity: 'monthly', isPayPeriodSnapshot: false,
      note: 'Monthly provider balance history: each historical entry is the stored balance at or around that month end, and a current entry is an ephemeral snapshot that may change between requests. This is not an Atlas stored opening, not a pay-period snapshot and not the original plan for a period; Atlas preserves original plans and closing snapshots separately, with dated revisions for late postings. Balances are provider-reported, not independently verified; trust remains unknown. Exact provider decimal strings and currencies are preserved per account and never combined across accounts or currencies. Missing or invalid balances stay unavailable and are never shown as zero. Provider base-currency conversions are omitted so no second converted figure competes. Forecast remains the planner.',
      referenceExpiresInSeconds: TTL / 1000,
      accounts: rows.map(({ sortKey, ...row }) => row),
      accountCount: rows.length,
      entryCount: rows.reduce((total, row) => total + row.entries.length, 0) };
  }
  // GET /recurring_items (Lunch Money v2.11.1 getAllRecurring: one unpaginated
  // response; start_date/end_date set each item's `matches` window and do not
  // filter items; suggested items are excluded unless asked for, and are never
  // asked for here). Reviewed items only. Schedule evidence only: no payee,
  // description, notes, amount, currency conversion, category or creator
  // leaves this read. Raw provider ids never cross: the item, its account and
  // each found transaction are opaque references (a found transaction's
  // reference is the same one get_lunchmoney_transactions returns for that row).
  // A missing, invalid or duplicate item id fails the whole read; any other
  // malformed field is reported unavailable for that item, never coerced.
  async function recurring(input, auth) {
    const { accounts } = await catalogData(auth.principal);
    const params = new URLSearchParams({ start_date: input.startDate, end_date: input.endDate });
    const data = await request('GET', '/recurring_items?' + params);
    const items = Array.isArray(data) ? data : data && Array.isArray(data.recurring_items) ? data.recurring_items : null;
    if (!items) throw new Error('recurring-items-unavailable');
    // The endpoint documents no pagination; a paginated-looking envelope is never called complete.
    const paged = !Array.isArray(data) && ['has_more', 'next', 'cursor', 'offset', 'limit'].some(key => Object.hasOwn(data, key));
    const day = value => typeof value === 'string' && date.safeParse(value).success ? value : null;
    const days = value => Array.isArray(value) && value.every(v => day(v) !== null) ? [...value].sort() : null;
    const seen = new Set();
    let suggestedExcluded = 0;
    let malformedStatus = 0;
    const rows = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || item.id < 1)
        throw new Error('invalid-provider-identity');
      if (seen.has(item.id)) throw new Error('duplicate-provider-identity');
      seen.add(item.id);
      if (item.status === 'suggested') { suggestedExcluded++; continue; }
      // A missing or unknown status is never treated as reviewed.
      if (item.status !== 'reviewed') { malformedStatus++; continue; }
      const unavailable = [];
      const criteria = item.transaction_criteria && typeof item.transaction_criteria === 'object'
        ? item.transaction_criteria : null;
      if (!criteria) unavailable.push('transactionCriteria');
      const c = criteria || {};
      const granularity = ['day', 'week', 'month', 'year'].includes(c.granularity) ? c.granularity : null;
      if (criteria && granularity === null) unavailable.push('granularity');
      const quantity = Number.isSafeInteger(c.quantity) && c.quantity > 0 ? c.quantity : null;
      if (criteria && quantity === null) unavailable.push('quantity');
      const anchorDate = day(c.anchor_date);
      if (criteria && anchorDate === null) unavailable.push('anchorDate');
      // start/end are documented nullable: null stays null; anything else malformed is unavailable.
      const startDate = c.start_date == null ? null : day(c.start_date);
      if (criteria && c.start_date != null && startDate === null) unavailable.push('startDate');
      const endDate = c.end_date == null ? null : day(c.end_date);
      if (criteria && c.end_date != null && endDate === null) unavailable.push('endDate');
      if (startDate && endDate && startDate > endDate) unavailable.push('startDate', 'endDate');
      const accountKind = c.plaid_account_id != null ? 'plaid' : c.manual_account_id != null ? 'manual' : null;
      const accountId = accountKind === 'plaid' ? c.plaid_account_id : accountKind === 'manual' ? c.manual_account_id : null;
      const account = accountKind && Number.isSafeInteger(accountId)
        ? accounts.find(a => a.type === accountKind && a.providerId === accountId) : null;
      const accountMapping = account ? 'catalog' : accountKind ? 'unavailable' : 'none';
      let matches = null;
      const m = item.matches;
      if (m && typeof m === 'object') {
        const expected = days(m.expected_occurrence_dates);
        const missing = days(m.missing_transaction_dates);
        let found = null;
        if (Array.isArray(m.found_transactions)) {
          found = [];
          for (const f of m.found_transactions) {
            if (!f || day(f.date) === null || !Number.isSafeInteger(f.transaction_id) || f.transaction_id < 1) { found = null; break; }
            found.push({ date: f.date, transactionRef: alias('tx', f.transaction_id, auth.principal) });
          }
          if (found) found.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
        }
        if (expected === null) unavailable.push('expectedDates');
        if (missing === null) unavailable.push('missingDates');
        if (found === null) unavailable.push('foundTransactions');
        matches = { windowStart: day(m.request_start_date), windowEnd: day(m.request_end_date),
          expectedDates: expected, foundTransactions: found, missingDates: missing };
      } else {
        unavailable.push('matches');
      }
      rows.push({ sortKey: item.id, recurringRef: alias('rec', item.id, auth.principal), status: 'reviewed',
        granularity, quantity, anchorDate, startDate, endDate,
        accountRef: account ? account.ref : null, accountMapping, matches,
        ...(unavailable.length ? { unavailableFields: [...new Set(unavailable)] } : {}) });
    }
    rows.sort((a, b) => a.sortKey - b.sortKey);
    const complete = !paged && malformedStatus === 0 && rows.every(row => !row.unavailableFields);
    return { status: 'ok', source: 'Lunch Money v2', observedAt: new Date(now()).toISOString(),
      window: { startDate: input.startDate, endDate: input.endDate },
      coverage: complete ? 'complete-provider-response' : 'incomplete-provider-response',
      writesAtlasState: false, providerWrite: false,
      note: 'Lunch Money reviewed recurring items: schedule evidence only (granularity, quantity, anchor, start and end dates, the account reference, and the expected, found and missing dates Lunch Money reports for the requested window). Suggested items are excluded and counted. No payee, description, notes, amount or category is returned. A found transaction reference is the same reference get_lunchmoney_transactions returns for that row. An expected date with no found transaction is not evidence of an unpaid bill, and none of this is an Atlas bill, settlement or figure. Forecast remains the planner.',
      referenceExpiresInSeconds: TTL / 1000,
      items: rows.map(({ sortKey, ...row }) => row),
      itemCount: rows.length, suggestedExcluded,
      ...(malformedStatus ? { statusUnavailable: malformedStatus } : {}) };
  }
  async function query(input, auth) {
    const { categories, accounts } = await catalogData(auth.principal);
    const category = input.categoryRef ? resolve(input.categoryRef, 'cat', auth.principal).id : null;
    const categoryRow = category && categories.find(c => c.id === category);
    if (category && !categoryRow) throw new Error('category-evidence-unavailable');
    // Lunch Money category-group filters include their children. Keep the
    // local evidence check consistent with that provider contract.
    const categoryIds = new Set(category ? [category] : []);
    function includeChildren(row) {
      for (const child of row.children || []) {
        if (!Number.isSafeInteger(child.id) || child.id <= 0) throw new Error('invalid-category-identity');
        categoryIds.add(child.id); includeChildren(child);
      }
    }
    if (categoryRow?.is_group) includeChildren(categoryRow);
    const account = input.accountRef ? resolve(input.accountRef, 'acct', auth.principal) : null;
    const exclude = input.excludeAccountRef ? resolve(input.excludeAccountRef, 'acct', auth.principal) : null;
    const selected = [];
    const seen = new Set();
    let offset = 0; let complete = false;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ start_date: input.startDate, end_date: input.endDate,
        include_pending: 'true', include_group_children: 'true', limit: '250', offset: String(offset) });
      if (category) params.set('category_id', String(category));
      if (account) params.set(account.accountType === 'plaid' ? 'plaid_account_id' : 'manual_account_id', String(account.id));
      const data = await request('GET', '/transactions?' + params);
      if (!Array.isArray(data.transactions) || typeof data.has_more !== 'boolean') throw new Error('coverage-unavailable');
      for (const tx of data.transactions) {
        if (seen.has(tx.id)) throw new Error('duplicate-provider-identity');
        seen.add(tx.id);
        const acc = accountKey(tx);
        if (!date.safeParse(tx.date).success) throw new Error('malformed-date');
        if (tx.date < input.startDate || tx.date > input.endDate) continue;
        if (tx.is_group_parent === true) continue;
        if (category && !categoryIds.has(tx.category_id)) continue;
        if ((account || exclude) && !acc) throw new Error('account-evidence-unavailable');
        if (account && (acc[0] !== account.accountType || acc[1] !== account.id)) continue;
        if (exclude && acc && acc[0] === exclude.accountType && acc[1] === exclude.id) continue;
        if (input.merchant && !String(tx.payee || '').toLowerCase().includes(input.merchant.toLowerCase())) continue;
        selected.push(project(tx, auth.principal, categories, accounts));
      }
      if (!data.has_more) { complete = true; break; }
      if (!data.transactions.length) break;
      offset += 250;
    }
    if (!complete) return fail('query-too-large-narrow-date-window');
    const start = input.offset || 0; const limit = input.limit || 100;
    return { status: 'ok', source: 'Lunch Money v2', observedAt: new Date(now()).toISOString(),
      window: { startDate: input.startDate, endDate: input.endDate }, coverage: 'complete-provider-response',
      note: 'Provider ledger evidence, not Atlas budget membership or a claim that every bank has synced. Amounts use Lunch Money signed debit convention; currencies remain separate. Pending and posted rows are explicit. Group children are included and group parents excluded; split parents are excluded by the provider default. Never add parents to their children.',
      rows: selected.slice(start, start + limit), matchedCount: selected.length, hasMore: start + limit < selected.length,
      nextOffset: start + limit < selected.length ? start + limit : null, referenceExpiresInSeconds: TTL / 1000 };
  }
  async function categoryContextFor(tx, destination, credentialGate) {
    const from = tx.category_id == null ? null : await request('GET', '/categories/' + tx.category_id, undefined, credentialGate);
    const to = await request('GET', '/categories/' + destination, undefined, credentialGate);
    if (from && from.id !== tx.category_id || to.id !== destination || to.is_group || to.archived) throw new Error('category-not-editable');
    return { from: Standing.categorySignature(from), to: Standing.categorySignature(to) };
  }
  async function cleanupCategoryContext(tx, destination, credentialGate) {
    if (destination == null) return null;
    const from = tx.category_id == null ? null : await request('GET', '/categories/' + tx.category_id, undefined, credentialGate);
    const to = await request('GET', '/categories/' + destination, undefined, credentialGate);
    if (from && from.id !== tx.category_id || to.id !== destination || to.is_group || to.archived) throw new Error('category-not-editable');
    if ([from, to].filter(Boolean).some(row => ['is_income', 'exclude_from_budget', 'exclude_from_totals']
      .some(key => typeof row[key] !== 'boolean'))) throw new Error('category-financial-semantics-unavailable');
    const semantic = row => ['is_income', 'exclude_from_budget', 'exclude_from_totals'].map(k => row?.[k] === true)
      .concat(require('./card-minimum-category').categoryDebt(row && { ...row, isIncome: row.is_income,
        isGroup: row.is_group, excludeFromBudget: row.exclude_from_budget, excludeFromTotals: row.exclude_from_totals }) || null);
    return { from: Standing.categorySignature(from), to: Standing.categorySignature(to), toId: destination, toName: to.name,
      financialSemanticsUnchanged: fingerprint(semantic(from)) === fingerprint(semantic(to)) };
  }
  async function submitCleanupEvidence(input, auth) {
    if (!Standing.available(standing) || standing.cleanupEnabled !== true || typeof standing.adapter.admit !== 'function'
        || typeof standing.adapter.cleanupEffects !== 'function') return fail('standing-cleanup-disabled');
    const context = await standing.adapter.context();
    const gate = async candidate => { if (candidate.credentialDigest !== context.credentialDigest) throw new Error('provider-credential-changed'); };
    const candidate = await prepare({ transactionRef: input.transactionRef, cleanupInstruction: input.cleanupInstruction }, auth, null, gate, true);
    if (candidate.status === 'no-changes') return candidate;
    const review = structuredClone(input.review);
    if (review.categoryReceipt) {
      const items = [];
      for (const item of review.categoryReceipt.facts.items) items.push({ description: item.description, amount: item.amount,
        category_id: await categoryId(item.categoryRef, auth.principal, gate) });
      review.categoryReceipt.facts.items = items;
    }
    const effects = await standing.adapter.cleanupEffects(candidate);
    if (effects.metadataNeutral !== true || effects.categoryEvidenceNeutral !== true || effects.parserRevision !== context.parserRevision
        || effects.financialContextDigest !== context.financialContextDigest) return fail('cleanup-financial-effect-changed');
    const admitted = await standing.adapter.admit({ ...candidate, grantRef: input.grantRef, auth, review,
      cleanupInstruction: input.cleanupInstruction, transferProof: effects.transferProof });
    return { status: 'evidence-recorded', providerWrite: false, ...admitted, financialEffects: publicEffects(effects),
      instruction: 'Eligible for automatic routine cleanup under the existing signed instruction. Prepare and apply through standing tools, then report the durable history row. No individual confirmation is required. Uncertainty stays unresolved.' };
  }
  function publicEffects(effects) {
    if (!effects) return null;
    return { ...effects, comparisons: effects.comparisons.map(({ category, ...proof }, i) => ({ position: i === 0 ? 'original-category' : 'resulting-category', ...proof })) };
  }
  async function submitStandingEvidence(input, auth) {
    if (!Standing.available(standing) || typeof standing.adapter.admit !== 'function') return fail('standing-evidence-admission-disabled');
    const context = await standing.adapter.context();
    const credentialGate = async candidate => { if (candidate.credentialDigest !== context.credentialDigest) throw new Error('provider-credential-changed'); };
    const target = resolve(input.transactionRef, 'tx', auth.principal);
    const tx = await request('GET', '/transactions/' + target.id, undefined, credentialGate); editable(tx);
    if (tx.id !== target.id) throw new Error('identity-mismatch');
    const category = await categoryId(input.categoryRef, auth.principal, credentialGate);
    const body = { category_id: category };
    const review = { ...input.review, facts: { ...input.review.facts, items: [] } };
    for (const item of input.review.facts.items) review.facts.items.push({
      description: item.description, amount: item.amount, category_id: await categoryId(item.categoryRef, auth.principal, credentialGate) });
    const categoryContext = await categoryContextFor(tx, category, credentialGate);
    const admitted = await standing.adapter.admit({ grantRef: input.grantRef, auth, tx, body, review, categoryContext });
    return { status: 'evidence-recorded', providerWrite: false, ...admitted,
      instruction: 'Delegated client assertions passed server consistency and grant checks. Atlas did not fetch or independently verify the source. Prepare the exact category correction using this evidenceRef.' };
  }
  async function standingAudit(input, auth) {
    if (!Standing.available(standing) || typeof standing.adapter.audit !== 'function') return fail('standing-audit-disabled');
    const receipts = await standing.adapter.audit({ ...input, auth });
    // Private authority retains internal IDs for exact validation; MCP evidence
    // omits them. Audit uses the already recorded safe category projection.
    return { status: 'audit', providerWrite: false, receipts: receipts.map(receipt => {
      const review = receipt.delegatedReview;
      return { ...receipt, delegatedReview: review ? { ...review, facts: { ...review.facts,
        ...(review.facts.items ? { items: review.facts.items.map(item => ({ description: item.description, amount: item.amount,
          categoryRef: receipt.proposed?.categoryRef || null })) } : {}) },
        ...(review.categoryReceipt ? { categoryReceipt: { ...review.categoryReceipt, facts: { ...review.categoryReceipt.facts,
          items: review.categoryReceipt.facts.items.map(item => ({ description: item.description, amount: item.amount,
            categoryRef: receipt.proposed?.categoryRef || null })) } } } : {}) } : null };
    }) };
  }
  async function prepare(input, auth, standingInput = null, credentialGate, buildOnly = false) {
    const target = resolve(input.transactionRef, 'tx', auth.principal);
    const tx = await request('GET', '/transactions/' + target.id, undefined, credentialGate); editable(tx);
    if (tx.id !== target.id) throw new Error('identity-mismatch');
    const recipe = input.cleanupInstruction;
    if (recipe) {
      const currentCatalog = await catalog({ includeTags: !!recipe.changes.tagNamesAdd }, auth, credentialGate);
      input = { transactionRef: input.transactionRef, changes: Cleanup.resolve(recipe, currentCatalog) };
    }
    if ((recipe || ['payee', 'notesAppend', 'tagRefsAdd', 'transferLabel'].some(key => input.changes?.[key] !== undefined))
        && (tx.status !== 'reviewed' || tx.is_pending !== false)) throw new Error('cleanup-reviewed-posted-transaction-required');
    let body;
    if (input.changes) {
      body = {};
      if (input.changes.categoryRef !== undefined) body.category_id = await categoryId(input.changes.categoryRef, auth.principal, credentialGate);
      // Legacy notes input now means an addition too. No path replaces or
      // clears pre-existing notes; the exact resulting string is previewed.
      if (input.changes.notes !== undefined) body.notes = Standing.appendNotes(tx.notes, input.changes.notes);
      if (input.changes.notesAppend !== undefined) {
        const addition = input.changes.notesAppend;
        const alreadyPresent = (!standingInput || recipe) && typeof tx.notes === 'string'
          && (tx.notes === addition || tx.notes.endsWith('\n' + addition));
        body.notes = alreadyPresent ? tx.notes : Standing.appendNotes(tx.notes, addition);
      }
      if (input.changes.payee !== undefined || input.changes.transferLabel) {
        if (typeof tx.original_name !== 'string' || !tx.original_name.trim())
          throw new Error('original-bank-description-unavailable');
        if (input.changes.payee !== undefined) body.payee = input.changes.payee;
      }
      if (input.changes.tagRefsAdd) {
        tagIds(tx); // Unknown/malformed existing tags are not an empty set.
        body.additional_tag_ids = input.changes.tagRefsAdd.map(key => resolve(key, 'tag', auth.principal).id);
      }
    } else {
      const sum = input.splits.reduce((total, row) => total + cents(row.amount), 0);
      const parentAmount = providerCents(tx.amount);
      if (sum !== parentAmount || input.splits.some(row => cents(row.amount) === 0
        || Math.sign(cents(row.amount)) !== Math.sign(parentAmount))) throw new Error('split-must-conserve-parent-amount');
      body = { child_transactions: [] };
      for (const row of input.splits) body.child_transactions.push({ amount: row.amount,
        category_id: await categoryId(row.categoryRef, auth.principal), ...(row.notes === undefined ? {} : { notes: row.notes }) });
    }
    const context = await metadataContext(body, auth.principal, input.changes?.transferLabel, credentialGate);
    if (context.transfer) {
      const [from, to] = context.transfer, account = accountKey(tx);
      const sign = /^-/.test(tx.amount) ? -1 : 1;
      const side = sign === 1 ? from : to;
      if (from.type === to.type && from.id === to.id || !account
          || tx.plaid_account_id != null && tx.manual_account_id != null
          || account[0] !== side.type || account[1] !== side.id || !/[1-9]/.test(tx.amount))
        throw new Error('transfer-direction-unresolved');
      body.payee = 'Transfer: ' + from.name + ' → ' + to.name;
    }
    const cat = await catalogData(auth.principal, false, credentialGate);
    const categoryContext = recipe && (standingInput || buildOnly) ? await cleanupCategoryContext(tx, body.category_id, credentialGate)
      : standingInput && body.category_id != null ? await categoryContextFor(tx, body.category_id, credentialGate) : null;
    if (recipe && (standingInput || buildOnly)) {
      for (const key of ['payee', 'notes', 'category_id']) if (body[key] === tx[key]) delete body[key];
      if (body.additional_tag_ids) {
        body.additional_tag_ids = body.additional_tag_ids.filter(id => !tagIds(tx).includes(id));
        if (!body.additional_tag_ids.length) delete body.additional_tag_ids;
      }
    }
    if (recipe && Object.entries(body).every(([key, value]) => key === 'additional_tag_ids'
      ? value.every(id => tagIds(tx).includes(id)) : tx[key] === value)) {
      return { status: 'no-changes', providerWrite: false, writesAtlasState: false, automaticEdits: false,
        transaction: project(tx, auth.principal, cat.categories, cat.accounts),
        instruction: 'This cleanup instruction already matches the transaction. No preview or write is needed.' };
    }
    if (buildOnly) return { tx, body, metadataContext: context, categoryContext };
    const authorization = standingInput ? await Standing.authorize(standing, {
      ...standingInput, auth, tx, body, fingerprint: fingerprint(tx), now: now(),
      categoryContext, metadataContext: context,
    }) : null;
    sweep(); if (previews.size >= 100) throw new Error('preview-capacity');
    const id = 'edit-' + crypto.randomBytes(24).toString('hex');
    previews.set(id, { principal: auth.principal, targetId: target.id, before: tx,
      fingerprint: fingerprint(tx), body, metadataContext: context, transfer: input.changes?.transferLabel,
      cleanupInstruction: recipe || null, categoryContext,
      splits: !!input.splits, expires: now() + TTL, used: false, authorization });
    return { status: 'preview', previewId: id, expiresAt: new Date(now() + TTL).toISOString(),
      before: project(tx, auth.principal, cat.categories, cat.accounts),
      proposed: input.changes ? {
        ...(input.changes.categoryRef === undefined ? {} : { categoryRef: input.changes.categoryRef }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.payee === undefined ? {} : { payee: body.payee }),
        ...(body.additional_tag_ids ? { tagsAdded: context.tags.filter(t => body.additional_tag_ids.includes(t.id)).map(t => ({ tagRef: alias('tag', t.id, auth.principal, { label: t.name }), name: t.name })) } : {}),
        ...(context.transfer ? { transferLabel: { from: context.transfer[0].name, to: context.transfer[1].name,
          meaning: standingInput ? 'Display label supported by a unique paired bank reference; no money movement.' : 'Display label only, based on the supplied direction; no money movement or independent transfer verification.' } } : {}),
        ...(body.category_id === undefined ? {} : { category: cat.categories.find(c => c.id === body.category_id)?.name || null }) }
        : { splits: input.splits.map((row, i) => ({ ...row,
          category: cat.categories.find(c => c.id === body.child_transactions[i].category_id)?.name || null })) },
      ...(authorization ? { authorization: { mode: 'standing-grant', grantRef: authorization.grantRef,
        grantRevision: authorization.grantRevision, evidenceRef: authorization.evidenceRef } } : {}),
      ...(recipe ? { cleanupInstruction: recipe, automaticEdits: !!authorization, financialEffects: publicEffects(authorization?.financialEffects) } : {}),
      instruction: authorization
        ? 'No write has occurred. This exact preview is eligible only for apply_standing_lunchmoney_correction under its bounded owner grant. Report the audit receipt afterward; uncertain writes must not be retried.'
        : 'Show the exact before/proposed change to the user. Apply only after explicit confirmation for this preview. No write has occurred.', providerWrite: false };
  }
  async function apply(input, auth, standingMode = false) {
    sweep(); const preview = previews.get(input.previewId);
    if (!preview || preview.principal !== auth.principal || preview.used) return fail('preview-expired-or-already-used');
    if (!!preview.authorization !== standingMode) return fail('preview-authorization-mode-mismatch');
    if (standingMode && !Standing.available(standing)) return fail('standing-corrections-disabled');
    if (standingMode && blockedStandingGrants.has(preview.authorization.grantRef)) return fail('standing-grant-needs-read-only-reconciliation');
    if (locks.has(preview.targetId)) return fail('transaction-edit-in-progress');
    // Consume before the first await: concurrent calls and ambiguous write failures cannot retry.
    preview.used = true;
    locks.add(preview.targetId);
    let writeAttempted = false;
    let providerRequestReturned = false;
    let executionCredentialDigest = null;
    const executionGate = async candidate => { if (candidate.credentialDigest !== executionCredentialDigest) throw new Error('provider-credential-changed'); };
    let reservation = null;
    let afterRead = null;
    let auditAttempt = null;
    let auditCatalog = null;
    const startedAt = now();
    async function audit(result) {
      if (!standingMode || !reservation) return result;
      if (result.status === 'write-unverified') blockedStandingGrants.add(preview.authorization.grantRef);
      try {
        if (result.status === 'write-unverified') await standing.adapter.suspend({
          ...preview.authorization, attemptRef: reservation.attemptRef, reason: result.reason });
        const record = { reservation,
          outcome: result.status, reason: result.reason || null, verifiedByReadback: result.verifiedByReadback === true,
          finishedAt: now(), after: afterRead,
          providerWriteMayHaveOccurred: writeAttempted, providerRequestReturned };
        const recordFingerprint = fingerprint(record);
        // finish persists the outcome but MUST retain durable quarantine. A
        // committed outcome with a lost/malformed reply is still quarantined.
        const receipt = await standing.adapter.finish(record);
        if (!receipt || !/^receipt-[a-f0-9]{24}$/.test(receipt.receiptRef)
            || !/^actor-[a-f0-9]{24}$/.test(receipt.actorRef) || receipt.durable !== true
            || receipt.attemptRef !== reservation.attemptRef
            || receipt.recordFingerprint !== recordFingerprint) throw new Error('audit-unavailable');
        let continuation = 'read-only-reconciliation-required';
        if (result.status === 'applied') {
          try {
            const ack = await standing.adapter.acknowledgeVerified({ reservation,
              receiptRef: receipt.receiptRef, recordFingerprint });
            if (!ack || ack.acknowledged !== true) throw new Error('acknowledgment-unavailable');
            continuation = 'acknowledged';
          } catch (_) {
            // Provider readback and the durable attributed receipt are already
            // known. An uncertain ACK affects continuation, not this edit's
            // verified outcome. It cannot cause another provider attempt.
            blockedStandingGrants.add(preview.authorization.grantRef);
            continuation = 'acknowledgment-unconfirmed-check-before-next-correction';
          }
        }
        return { ...result, standingGrantContinuation: continuation,
          auditReceipt: { receiptRef: receipt.receiptRef, authorization: 'standing-grant',
          grantRef: preview.authorization.grantRef, grantRevision: preview.authorization.grantRevision,
          evidenceRef: preview.authorization.evidenceRef, startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date(now()).toISOString(), outcome: result.status,
          before: auditAttempt.before, proposed: auditAttempt.proposed, after: afterRead,
          actorRef: receipt.actorRef, financialEffects: auditAttempt.financialEffects || null,
          evidenceProvenance: preview.authorization.evidenceProvenance || null } };
      } catch (_) {
        blockedStandingGrants.add(preview.authorization.grantRef);
        try { await standing.adapter.suspend({ ...preview.authorization, attemptRef: reservation.attemptRef,
          reason: 'audit-outcome-unavailable' }); } catch (_) {}
        return { status: 'write-unverified', reason: 'audit-outcome-unavailable-do-not-retry',
          providerWriteMayHaveOccurred: writeAttempted };
      }
    }
    try {
      const current = await request('GET', '/transactions/' + preview.targetId);
      if (fingerprint(current) !== preview.fingerprint) return fail('transaction-changed-prepare-new-preview');
      editable(current);
      for (const id of preview.splits ? preview.body.child_transactions.map(c => c.category_id) : [preview.body.category_id]) {
        if (id != null) { const c = await request('GET', '/categories/' + id); if (c.id !== id || c.archived || c.is_group) throw new Error('category-not-editable'); }
      }
      const beforeSend = async ({ credentialDigest }) => {
        executionCredentialDigest = credentialDigest;
        if (preview.expires <= now()) throw new Error('preview-expired');
        if (!standingMode) {
          const liveContext = await metadataContext(preview.body, auth.principal, preview.transfer, executionGate);
          if (fingerprint(liveContext) !== fingerprint(preview.metadataContext)) throw new Error('metadata-catalog-changed');
          // Catalog checks may await multiple provider reads. Recheck AFTER
          // them so an external note added in that gap cannot be overwritten.
          const finalCurrent = await request('GET', '/transactions/' + preview.targetId, undefined, executionGate);
          if (fingerprint(finalCurrent) !== preview.fingerprint) throw new Error('transaction-changed-before-dispatch');
          editable(finalCurrent);
        }
        if (standingMode) {
          if (preview.expires <= now()) throw new Error('preview-expired');
          const candidate = preview.cleanupInstruction ? await prepare({ transactionRef: alias('tx', preview.targetId, auth.principal),
            cleanupInstruction: preview.cleanupInstruction }, auth, null, executionGate, true) : null;
          if (candidate && (fingerprint(candidate.tx) !== preview.fingerprint || fingerprint(candidate.body) !== fingerprint(preview.body)
              || fingerprint(candidate.metadataContext) !== fingerprint(preview.metadataContext))) throw new Error('cleanup-evidence-changed');
          const boundary = await Standing.authorize(standing, {
            ...preview.authorization, auth, credentialDigest, tx: current, body: preview.body,
            metadataContext: candidate?.metadataContext,
            categoryContext: candidate ? candidate.categoryContext : preview.body.category_id == null ? undefined
              : await categoryContextFor(current, preview.body.category_id, executionGate),
            fingerprint: fingerprint(current), now: now(),
          });
          if (JSON.stringify(stableAuthorization(boundary)) !== JSON.stringify(stableAuthorization(preview.authorization))) throw new Error('standing-grant-changed');
          const cat = await catalogData(auth.principal, false, executionGate);
          // Durable routine history carries fresh names for ALL existing tags,
          // even when the instruction adds none. Never depend on alias-cache
          // hydration by an earlier optional catalog call.
          if (candidate) cat.tags = await tagsData(auth.principal, executionGate);
          auditCatalog = cat;
          const expected = { ...current, ...preview.body };
          if (preview.body.additional_tag_ids) { delete expected.additional_tag_ids;
            expected.tag_ids = [...new Set([...tagIds(current), ...preview.body.additional_tag_ids])].sort((a, b) => a - b); }
          const attempt = { ...boundary, previewId: input.previewId, principal: auth.principal, clientId: auth.clientId,
            transactionId: preview.targetId, beforeProvider: current, expectedCategory: preview.body.category_id,
            expectedAfterFingerprint: require('./assistant-standing-store').observedWithoutTimestamp(expected),
            untargetedFingerprint: require('./assistant-standing-store').protectedFingerprint(current),
            categoryContext: candidate ? candidate.categoryContext : preview.body.category_id == null ? null : await categoryContextFor(current, preview.body.category_id, executionGate),
            ...(candidate ? { metadataContext: candidate.metadataContext, financialEffects: publicEffects(boundary.financialEffects) } : {}),
            beforeFingerprint: preview.fingerprint, proposedFingerprint: fingerprint(preview.body),
            expiresAt: preview.expires, requestedAt: now(),
            before: project(current, auth.principal, cat.categories, cat.accounts, cat.tags),
            proposed: { ...project(expected, auth.principal, cat.categories, cat.accounts, cat.tags),
              ...(preview.body.category_id === undefined ? {} : { categoryRef: alias('cat', preview.body.category_id, auth.principal) }) } };
          // Atomic durable reserve rechecks live revocation, expiry, revision,
          // budget and attempt limits; a pending/unverified attempt suspends the
          // grant until read-only reconciliation. No reservation is refunded.
          auditAttempt = attempt;
          reservation = await standing.adapter.reserve(attempt);
          if (!reservation || reservation.authorized !== true
              || !/^attempt-[a-f0-9]{24}$/.test(reservation.attemptRef)
              || reservation.grantRef !== boundary.grantRef
              || reservation.grantRevision !== boundary.grantRevision
              || reservation.durable !== true || preview.expires <= now()) throw new Error('standing-reservation-denied');
          // The shared authority now owns the target lease across grants and
          // instances. Re-read AFTER reservation so stale pre-lock reads cannot
          // overwrite another Atlas instance's completed correction.
          const credentialGate = async candidate => {
            if (candidate.credentialDigest !== credentialDigest) throw new Error('provider-credential-changed');
          };
          let lockedCurrent = await request('GET', '/transactions/' + preview.targetId, undefined, credentialGate);
          if (fingerprint(lockedCurrent) !== preview.fingerprint) throw new Error('transaction-changed-after-reservation');
          editable(lockedCurrent);
          if (preview.body.category_id != null) {
            const category = await request('GET', '/categories/' + preview.body.category_id, undefined, credentialGate);
            if (category.id !== preview.body.category_id || category.archived || category.is_group) throw new Error('category-not-editable');
          }
          if (candidate) {
            const lockedCandidate = await prepare({ transactionRef: alias('tx', preview.targetId, auth.principal),
              cleanupInstruction: preview.cleanupInstruction }, auth, null, credentialGate, true);
            if (fingerprint(lockedCandidate.tx) !== preview.fingerprint || fingerprint(lockedCandidate.body) !== fingerprint(preview.body)
                || fingerprint(lockedCandidate.metadataContext) !== fingerprint(candidate.metadataContext)
                || fingerprint(lockedCandidate.categoryContext) !== fingerprint(candidate.categoryContext)) throw new Error('cleanup-evidence-changed');
            const effects = await standing.adapter.cleanupEffects(lockedCandidate);
            Standing.validateCleanupEffects(effects, await standing.adapter.context(), boundary.financialEffects.transferProof);
            // Observation time and unrelated financial evidence may advance.
            // Permission/target bindings stay exact; every fresh effect proof
            // must independently pass, and the final one is durably recorded.
            attempt.financialEffects = publicEffects(effects);
          }
          const lease = await standing.adapter.verifyReservation({ ...attempt, reservation, checkedAt: now(),
            categoryContext: candidate ? candidate.categoryContext : preview.body.category_id == null ? null : await categoryContextFor(lockedCurrent, preview.body.category_id, credentialGate) });
          if (!lease || lease.valid !== true || lease.attemptRef !== reservation.attemptRef
              || preview.expires <= now()) throw new Error('standing-reservation-no-longer-valid');
          // Effect/catalog checks may await. This final pinned GET protects
          // pre-existing notes added by another client during that interval.
          lockedCurrent = await request('GET', '/transactions/' + preview.targetId, undefined, credentialGate);
          if (fingerprint(lockedCurrent) !== preview.fingerprint) throw new Error('transaction-changed-before-dispatch');
        }
        if (preview.expires <= now()) throw new Error('preview-expired');
        writeAttempted = true;
      };
      await request(preview.splits ? 'POST' : 'PUT', preview.splits
        ? '/transactions/split/' + preview.targetId : '/transactions/' + preview.targetId + '?update_balance=false', preview.body, beforeSend);
      providerRequestReturned = true;
      const after = await request('GET', '/transactions/' + preview.targetId, undefined, executionGate);
      const afterTags = standingMode && preview.cleanupInstruction ? await tagsData(auth.principal, executionGate) : undefined;
      if (standingMode) afterRead = project(after, auth.principal, auditCatalog.categories, auditCatalog.accounts, afterTags);
      let verified = after.id === preview.targetId;
      if (preview.splits) {
        const expected = preview.body.child_transactions.map(c => [cents(c.amount), c.category_id, c.notes ?? current.notes ?? '', current.date, current.currency]);
        const actual = (after.children || []).map(c => [providerCents(c.amount), c.category_id, c.notes ?? '', c.date, c.currency]);
        verified = verified && ['amount', 'currency', 'date', 'payee', 'plaid_account_id', 'manual_account_id'].every(key => after[key] === current[key]) && after.is_split_parent === true && expected.length === actual.length
          && JSON.stringify(expected.map(JSON.stringify).sort()) === JSON.stringify(actual.map(JSON.stringify).sort())
          && after.children.every(c => c.split_parent_id === preview.targetId
            && c.plaid_account_id === current.plaid_account_id && c.manual_account_id === current.manual_account_id
            && c.payee === current.payee);
      } else {
        verified = verified && Object.entries(preview.body).every(([key, value]) => key === 'notes'
          ? (after[key] || '') === value : key === 'additional_tag_ids'
            ? JSON.stringify(tagIds(after)) === JSON.stringify([...new Set([...tagIds(current), ...value])].sort((a, b) => a - b))
            : after[key] === value)
          && ['amount', 'currency', 'date', 'original_name', 'plaid_account_id', 'manual_account_id'].every(key => after[key] === current[key])
          && (preview.body.payee !== undefined || after.payee === current.payee)
          && (preview.body.category_id !== undefined || after.category_id === current.category_id)
          && (preview.body.notes !== undefined || (after.notes ?? '') === (current.notes ?? ''));
        // Additional tags are a provider command; the readback field is tag_ids.
        // Every other original field, including bank metadata/status, stays exact.
        const actualBody = { ...preview.body };
        if (actualBody.additional_tag_ids) { delete actualBody.additional_tag_ids; actualBody.tag_ids = after.tag_ids; }
        verified = verified && Standing.unchangedOtherFields(current, after, actualBody);
      }
      if (standingMode) {
        if (preview.authorization.evidenceProvenance) {
          const afterContext = preview.cleanupInstruction ? await cleanupCategoryContext(current, preview.categoryContext?.toId, executionGate)
            : await categoryContextFor(current, preview.body.category_id, executionGate);
          verified = verified && JSON.stringify(afterContext) === JSON.stringify(auditAttempt.categoryContext);
        }
        if (preview.cleanupInstruction) {
          const contextBody = preview.metadataContext.tags ? { additional_tag_ids: preview.metadataContext.tags.map(t => t.id) } : {};
          const liveContext = await metadataContext(contextBody, auth.principal, preview.transfer, executionGate);
          verified = verified && fingerprint(liveContext) === fingerprint(preview.metadataContext);
        }
      }
      if (!verified) return await audit({ status: 'write-unverified', reason: 'readback-did-not-match-do-not-retry', providerWriteMayHaveOccurred: true });
      const cat = await catalogData(auth.principal, false, executionGate);
      afterRead = project(after, auth.principal, cat.categories, cat.accounts, afterTags);
      return await audit({ status: 'applied', verifiedByReadback: true, writesAtlasState: false,
        transaction: project(after, auth.principal, cat.categories, cat.accounts, afterTags),
        ...(preview.splits ? { children: after.children.map(c => project(c, auth.principal, cat.categories, cat.accounts)) } : {}),
        instruction: standingMode
          ? 'Readback verified the bounded correction. Report before/after, evidence and audit receipt to the owner. Re-query for refreshed state.'
          : 'Lunch Money saved the edit. Re-query Lunch Money and get_atlas_current for refreshed evidence; no canonical Atlas policy was edited.' });
    } catch (_) {
      return await audit(writeAttempted ? { status: 'write-unverified', reason: 'provider-result-unknown-do-not-retry', providerWriteMayHaveOccurred: true }
        : fail('apply-rejected-before-write'));
    } finally { locks.delete(preview.targetId); }
  }
  async function prepareStanding(input, auth) {
    if (!Standing.available(standing)) return fail('standing-corrections-disabled');
    if (blockedStandingGrants.has(input.grantRef)) return fail('standing-grant-needs-read-only-reconciliation');
    return prepare({ transactionRef: input.transactionRef, ...(input.cleanupInstruction ? { cleanupInstruction: input.cleanupInstruction } : { changes: input.changes }) }, auth,
      { grantRef: input.grantRef, evidenceRef: input.evidenceRef });
  }
  async function applyStanding(input, auth) { return apply(input, auth, true); }
  async function invoke(operation, args, auth = {}) {
    if (!auth.principal) return fail('authenticated-subject-required');
    const denied = scopeDenial(operation, auth);
    if (denied) return denied;
    const parsed = schemas[operation]?.safeParse(args);
    if (!parsed?.success) return fail('invalid-arguments');
    try { return await ({ catalog, query, balanceHistory, recurring, prepare, apply, cleanupInstruction: Cleanup.create,
      prepareStanding, applyStanding, submitStandingEvidence, submitCleanupEvidence, standingAudit })[operation](parsed.data, auth); }
    catch (error) {
      return operation === 'catalog' || operation === 'query' || operation === 'balanceHistory' || operation === 'recurring'
        ? readFailure(operation, error) : fail('lunchmoney-operation-unavailable');
    }
  }
  return { invoke, standingEnabled: Standing.available(standing),
    standingCleanupEnabled: Standing.available(standing) && standing.cleanupEnabled === true && typeof standing.adapter.cleanupEffects === 'function',
    standingAdmissionEnabled: Standing.available(standing) && typeof standing.adapter.admit === 'function' && typeof standing.adapter.audit === 'function' };
}
module.exports = { READ_SCOPE, WRITE_SCOPE, STANDING_SCOPE: Standing.SCOPE, TTL, schemas, cents, requiredScope, scopeDenial, createService };
