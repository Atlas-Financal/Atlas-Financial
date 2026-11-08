'use strict';
// Read-only proof against the incumbent observer, overlay and Forecast. This
// module supplies no classification policy and never persists household state.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const O = require('./provider-observe');
const Live = require('./live-plan');
const F = require('../public/forecast');
const Store = require('./assistant-standing-store');
const clone = x => JSON.parse(JSON.stringify(x));
const hash = Store.ownerDigest;
function check(ok) { if (!ok) throw new Error('cleanup-financial-proof-unavailable'); }
function exactCents(value) {
  check(typeof value === 'string' && value.length <= 64 && /^-?\d+(\.\d{1,4})?$/.test(value));
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  check(!/[1-9]/.test(fraction.slice(2)));
  const amount = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  check(amount <= BigInt(Number.MAX_SAFE_INTEGER));
  return negative ? -amount : amount;
}
function revision(root = path.resolve(__dirname, '..')) {
  // Pin all deployed calculation/parser dependencies, including transitive
  // modules. A code change requires a newly approved context, never a stale PASS.
  const h = crypto.createHash('sha256');
  for (const folder of ['scripts', 'public']) for (const name of fs.readdirSync(path.join(root, folder)).sort()) {
    if (name.endsWith('.js')) h.update(folder + '/' + name + '\0').update(fs.readFileSync(path.join(root, folder, name)));
  }
  return h.digest('hex');
}
function contextDigest({ data, accountMap, identity, periods }) { return hash({ data, accountMap, identity, periods }); }
// Only presentation/source text is removed. Derived identity/ownership flags,
// coverage, settlement, amounts, trust, dates, decisions and all numbers remain.
function financial(value) {
  if (Array.isArray(value)) return value.map(financial);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    'payee', 'originalName', 'notes', 'tags', 'displayedPayee', 'originalMerchant', 'updated_at',
  ].includes(key)).map(([key, v]) => [key, financial(v)]));
}
function projection(inputs, payload) {
  const result = Live.fromObservation({ ...inputs, payload });
  check(result.data?.liveOverlay?.applied === true);
  const forecast = Live.forecastFrom(result.data);
  // The household renderer uses these Forecast-owned rows. Check their trust
  // and classifications too, rather than only a headline total.
  const rows = F.baselineTrajectory(result.data.plan, result.data.debts, result.data.meta.asOf, {
    ...result.data.plan.defaults, periods: inputs.periods, currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals });
  check(rows.status === 'ready');
  return { report: result.report, data: result.data, forecast, rows };
}
function categoryFacts(projected) {
  const packet = projected.data.liveOverlay.currentPeriodActuals;
  const permitted = new Set(['categoryLabel', 'confirmedGrocery', 'confirmedFuel', 'fuelEvidence']);
  return financial({ packet: { ...packet, transactions: packet.transactions.map(row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => !permitted.has(key)))) },
    classifications: packet.transactions.map(row => {
      const c = F.classifyCurrentPeriodTransaction(row, projected.data.plan, { packet, currentPeriodActuals: packet });
      return c.householdSpending === true && ['spend', 'unclassified'].includes(c.kind)
        ? { id: row.id, kind: 'household-spending' }
        : c.kind === 'savings-paid' ? { id: row.id, kind: 'savings-paid' } : { id: row.id, ...c };
    }),
    cash: projected.data.plan.startingCash, debts: projected.data.debts });
}
function transferProof(payload, tx, metadataContext) {
  if (!metadataContext?.transfer) return undefined;
  const identity = row => F.classifyCurrentPeriodTransaction.derivedFlags({ originalName: row.original_name, originalMerchant: row.original_name });
  const directed = identity(tx);
  check(/^[A-Z]{2}\d{3}$/.test(directed.tfrReference || '') && ['TO', 'FR'].includes(directed.tfrDirection));
  const matches = payload.transactions.filter(row => identity(row).tfrReference === directed.tfrReference);
  check(matches.length === 2 && matches.some(row => row.id === tx.id));
  const other = matches.find(row => row.id !== tx.id);
  const [from, to] = metadataContext.transfer;
  const side = row => row.plaid_account_id != null && row.manual_account_id == null
    ? { type: 'plaid', id: row.plaid_account_id } : row.manual_account_id != null && row.plaid_account_id == null
      ? { type: 'manual', id: row.manual_account_id } : null;
  const account = (row, expected) => side(row)?.id === expected.id && side(row)?.type === expected.type;
  const debit = directed.tfrDirection === 'TO' ? tx : other, credit = debit === tx ? other : tx;
  check(identity(debit).tfrDirection === 'TO' && identity(credit).tfrDirection === 'FR'
    && account(debit, from) && account(credit, to) && (from.type !== to.type || from.id !== to.id)
    && debit.date === credit.date && debit.currency === credit.currency
    && /^\d+(\.\d{1,4})?$/.test(debit.amount) && /^-\d+(\.\d{1,4})?$/.test(credit.amount)
    && exactCents(debit.amount) > 0n && exactCents(debit.amount) === -exactCents(credit.amount)
    && matches.every(row => row.status === 'reviewed' && row.is_pending === false
      && !row.is_split_parent && row.split_parent_id == null && !row.is_group_parent && row.group_parent_id == null));
  return { kind: 'bank-directed-counterpart', reference: directed.tfrReference,
    counterpartFingerprint: Store.digest(other), transactionFingerprint: Store.digest(tx) };
}
function evaluate({ inputs, tx, body, parserRevision, metadataContext }) {
  const { payload, accountMap, data, identity, periods } = inputs;
  check(data?.plan && identity && accountMap?.provider === 'lunchmoney'
    && payload?.transactionWindow?.complete === true && payload?.pendingCoverage?.complete === true
    && payload.transactionWindow.startDate <= tx.date && payload.transactionWindow.endDate >= tx.date);
  const rows = payload.transactions.filter(row => row.id === tx.id);
  check(rows.length === 1);
  // GET /transactions/{id} always expands files; the observer's bulk read
  // requests metadata but not files. Compare every shared field canonically,
  // including provider metadata. If bulk supplies files, compare those too.
  // The executor still fingerprints the FULL by-ID row before dispatch and
  // verifies every untargeted by-ID field, including files, after the write.
  const observedTarget = { ...tx };
  if (!Object.hasOwn(rows[0], 'files')) delete observedTarget.files;
  check(hash(rows[0]) === hash(observedTarget));
  exactCents(tx.amount); // The real financial path cannot establish fractional/unsafe cents.
  // Missing parser inputs are unknown, not empty notes/tags or uncategorized.
  check(Object.hasOwn(tx, 'notes') && (tx.notes === null || typeof tx.notes === 'string')
    && Object.hasOwn(tx, 'category_id') && (tx.category_id === null || Number.isSafeInteger(tx.category_id) && tx.category_id > 0)
    && Array.isArray(tx.tag_ids) && tx.tag_ids.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(tx.tag_ids).size === tx.tag_ids.length);
  const categories = (payload.categories || []).flatMap(row => [row, ...(row.children || [])]);
  for (const id of new Set([tx.category_id, body.category_id].filter(id => id != null))) {
    const matches = categories.filter(row => row.id === id);
    check(matches.length === 1 && typeof matches[0].name === 'string' && matches[0].name.trim()
      && ['is_income', 'exclude_from_budget', 'exclude_from_totals'].every(key => typeof matches[0][key] === 'boolean'));
  }
  for (const id of [...tx.tag_ids, ...(body.additional_tag_ids || [])]) {
    const matches = (payload.tags || []).filter(row => row.id === id);
    check(matches.length === 1 && typeof matches[0].name === 'string' && matches[0].name.trim());
  }
  check(Array.isArray(payload.accounts) && new Set(payload.accounts.map(a => String(a.id))).size === payload.accounts.length);
  const accountId = tx.plaid_account_id ?? tx.manual_account_id;
  check(accountId != null && (tx.account_id == null || tx.account_id === accountId));
  check(accountMap.mappings.filter(row => String(row.providerAccountId) === String(accountId)).length === 1);
  const updated = clone(tx);
  for (const key of ['payee', 'notes']) if (body[key] !== undefined) updated[key] = body[key];
  if (body.additional_tag_ids) updated.tag_ids = [...new Set([...tx.tag_ids, ...body.additional_tag_ids])].sort((a, b) => a - b);
  const digestFor = row => {
    const next = clone(payload); next.transactions = next.transactions.map(t => t.id === tx.id ? row : t);
    const projected = projection({ data, accountMap, identity, periods }, next);
    return { financial: hash(financial(projected)), categoryFacts: hash(categoryFacts(projected)) };
  };
  const comparisons = [];
  for (const category of new Set([tx.category_id, body.category_id ?? tx.category_id])) {
    const before = digestFor({ ...tx, category_id: category }), after = digestFor({ ...updated, category_id: category });
    comparisons.push({ category, before: before.financial, after: after.financial, categoryFacts: before.categoryFacts });
  }
  const categoryBefore = comparisons[0].before, categoryAfter = comparisons.at(-1).before;
  return { schema: 'atlas-cleanup-financial-effects/v1', parserRevision,
    financialContextDigest: contextDigest({ data, accountMap, identity, periods }),
    metadataNeutral: comparisons.every(c => c.before === c.after), comparisons,
    categoryEvidenceNeutral: comparisons[0].categoryFacts === comparisons.at(-1).categoryFacts,
    categoryBefore, categoryAfter,
    categoryEffect: categoryBefore === categoryAfter ? 'none' : 'authorized-category-reclassification',
    ...(metadataContext?.transfer ? { transferProof: transferProof(payload, tx, metadataContext) } : {}) };
}
async function runtimeEffects({ env, projectRoot, context, tx, body, metadataContext, now }) {
  const data = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data.json'), 'utf8'));
  const accountMap = O.loadLiveAccountMap(env, data);
  const identity = JSON.parse(fs.readFileSync(path.join(projectRoot, 'docs/connectivity/transaction-identity.json'), 'utf8'));
  const periods = JSON.parse(fs.readFileSync(path.join(projectRoot, 'public/periods.json'), 'utf8'));
  const parserRevision = revision(projectRoot);
  check(parserRevision === context.parserRevision && contextDigest({ data, accountMap, identity, periods }) === context.financialContextDigest);
  const { token } = await require('./local-credentials').resolveLunchMoneyAccessToken({ env });
  check(Store.digest(token) === context.credentialDigest);
  const payload = await O.fetchLunchMoneyLive(token, new Date(now()).toISOString(), 400, { env });
  return evaluate({ inputs: { data, accountMap, identity, periods, payload }, tx, body, metadataContext, parserRevision });
}
module.exports = { revision, contextDigest, financial, evaluate, runtimeEffects, transferProof };
