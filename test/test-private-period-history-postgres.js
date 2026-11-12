'use strict';
// Hosted PostgreSQL period-history backend: what is stored, what is refused,
// and how the shared connection owner's 'period-history' profile preflights.
// Offline: injected pg.Client double, invented data, no network, no credential.
// The storage guarantees themselves are proved by the shared contract suite
// (test-private-period-history-store-contract.js) against both backends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { createSettlementEvidencePostgresConnection: openOwner } = require('../scripts/settlement-evidence-postgres-connection');
const { START, NEXT, input, capture } = require('./fixtures/private-period-history-input');
const { pgWorld, URL_VALUE, CANARY, HOST } = require('./fixtures/period-history-pg-double');

const { digest, canonical } = History.contract;
const SENTINEL = 'Zqsentinelx';
const trustClean = !Object.keys(process.env).some(k => /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i.test(k));
const skip = trustClean ? false : 'process environment carries TLS-trust variables the connection owner refuses; run with them unset';
const env = (value = URL_VALUE) => ({ [Pg.ENV_NAME]: value });
const rejectsWith = (p, code) => assert.rejects(p, e => (code instanceof RegExp ? code.test(e.code) : e.code === code)
  && !String(e.message).includes(CANARY) && !JSON.stringify(e.diagnostic || null).includes(CANARY), String(code));
function reseal(candidate) {
  const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
  return { ...body, captureId: digest(body) };
}
function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach(v => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out); }
  return out;
}

test('P1 projection is a closed allowlist: no evidence, receipts or transaction-level rows', () => {
  const candidate = capture(input({ bills: [{ id: 'hydro', label: 'Invented hydro', amount: 50, frequency: 'monthly', day: 5, confidence: 'confirmed' }] }));
  const p = Pg.project(candidate);
  assert.deepEqual(Object.keys(p).sort(), ['captureId', 'capturedAt', 'content', 'schema', 'sourceSchema']);
  assert.deepEqual(Object.keys(p.content).sort(), ['asOf', 'cutoff', 'declaredAt', 'effectiveFrom', 'engine', 'kind', 'period',
    'planBasis', 'provenance', 'publication', 'reason', 'closingState', 'sourceCompleteness'].sort());
  assert.deepEqual(Object.keys(p.content.provenance).sort(), ['accountMapFingerprint', 'fetchedAt', 'identityFingerprint',
    'pendingCoverage', 'policyFingerprint', 'provider', 'sourceFingerprint', 'transactionWindow']);
  assert.deepEqual(Object.keys(p.content.engine).sort(), ['commit', 'filesFingerprint']);
  const keys = keysDeep(p);
  for (const banned of ['evidence', 'recon', 'pendingRecon', 'displayedPayee', 'originalMerchant', 'observationReceipt',
    'reconciliationReceipt', 'payload', 'transactions', 'accountMap', 'payerLabel', 'payingAccount', 'items', 'files',
    'paydayBoundaryBillsObservation', 'postedBillsAccountMovements', 'billsAccountPeriodBalance', 'budgetProgress', 'cashNote'])
    assert.ok(!keys.has(banned), 'projection never carries ' + banned);
  // Native values are reprinted, not recalculated.
  const full = candidate.content.publication;
  for (const key of ['opening', 'plannedPeriodClose', 'predictedEndingBalance', 'budgetHold', 'incomeTotal', 'periodBillLoad'])
    assert.equal(p.content.publication[key], full[key], key);
  assert.equal(p.content.publication.householdBudget.find(r => r.id === 'groceries').spent, 12.34);
  assert.equal(p.content.publication.bills[0].label, 'Invented hydro');
});

test('P2 adversarial sentinel: provider-only text reaches the full record but never the stored projection', { skip }, async () => {
  const candidate = capture(input({ sentinel: SENTINEL }));
  assert.ok(JSON.stringify(candidate).toLowerCase().includes(SENTINEL.toLowerCase()), 'the sentinel is present in the evidence');
  assert.ok(JSON.stringify(candidate.content.publication).toLowerCase().includes(SENTINEL.toLowerCase()),
    'Forecast\'s own publication carries the merchant in its recon rows');
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
  assert.equal((await store.append({ enabled: true, candidate })).status, 'appended');
  const stored = w.committed.map(r => r.record).join('\n') + JSON.stringify(w.queries);
  assert.equal(stored.toLowerCase().split(SENTINEL.toLowerCase()).length - 1, 0, 'zero sentinel occurrences in anything sent to PostgreSQL');
  assert.equal(stored.split(CANARY).length - 1, 0, 'the connection password is never sent as data');
  for (const q of w.queries) assert.match(q.text, /^(SELECT |BEGIN$|COMMIT$|ROLLBACK$|INSERT INTO "atlas_period_history"\.revisions )/, 'no DDL or rewrite');
});

test('P3 provider-text guard refuses a provider string inside an allowlisted field', () => {
  const candidate = capture(input({ sentinel: SENTINEL }));
  const forged = JSON.parse(JSON.stringify(candidate));
  forged.content.publication.income[0].label = SENTINEL + ' Market'; // provider payee in a plan-shaped field
  assert.throws(() => Pg.project(reseal(forged)), e => e.code === 'history-projection-provider-text');
  // Unplanned other-income rows are never projected at all.
  const other = JSON.parse(JSON.stringify(candidate));
  other.content.publication.income.push({ ...other.content.publication.income[0], id: 'other', label: 'Other deposit', otherIncome: true });
  assert.equal(Pg.project(reseal(other)).content.publication.income.length, 1);
  // Provider text equal to a projection KEY, or a numeric id equal to an amount,
  // is not a leak: only projected string values are compared.
  const benign = input();
  benign.payload.transactions[0].notes = 'status';
  benign.payload.transactions[0].id = 1500; // the period opening amount
  benign.payload.transactions.push({ ...benign.payload.transactions[0], id: 'sourceFingerprint', payee: 'closingState', notes: 'periodBillLoadTrust' });
  assert.equal(Pg.project(capture(benign)).schema, Pg.PROJECTION_SCHEMA);
});

function richInput(sentinel) {
  // Provider text in every Obs-1 source: provider categories (and a child
  // category), category_name, split children, and plaid_metadata.
  const data = input({ sentinel });
  const tx = data.payload.transactions[0];
  data.payload.categories.push({ id: 'cat-x', name: sentinel + ' Category', group_name: sentinel + ' Group',
    children: [{ id: 'cat-y', name: sentinel + ' Subcategory' }] });
  tx.category_name = sentinel + ' Category';
  tx.plaid_metadata = { name: sentinel + ' PLAID NAME', merchant_name: sentinel + ' Merchant', category: [sentinel + ' Plaid Category'],
    location: { city: sentinel + 'ville', address: '1 ' + sentinel + ' Street' }, payment_meta: { payee: sentinel + ' Payee' },
    transaction_id: sentinel + '-plaid-tx' };
  tx.children = [{ id: sentinel + '-child', payee: sentinel + ' Child Payee', notes: sentinel + ' child note',
    amount: '2.00', category_name: sentinel + ' Child Category' }];
  return data;
}

test('P2b Obs-1 sources: categories, children and plaid_metadata never reach the store, and forged copies are refused', { skip }, async () => {
  const candidate = capture(richInput(SENTINEL));
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
  assert.equal((await store.append({ enabled: true, candidate })).status, 'appended');
  const stored = (w.committed.map(r => r.record).join('\n') + JSON.stringify(w.queries)).toLowerCase();
  assert.equal(stored.split(SENTINEL.toLowerCase()).length - 1, 0, 'zero sentinel occurrences');
  const forge = (path, text) => {
    const copy = JSON.parse(JSON.stringify(candidate));
    path(copy.content.publication, text);
    return () => Pg.project(reseal(copy));
  };
  const refused = e => e.code === 'history-projection-provider-text';
  for (const text of [SENTINEL + ' Category', SENTINEL + ' Subcategory', SENTINEL + ' Group', SENTINEL + ' Child Category',
    SENTINEL + ' Plaid Category']) {
    assert.throws(forge((p, t) => { p.householdBudget[0].label = t + ' extra'; }, text), refused, 'category in a budget label: ' + text);
    assert.throws(forge((p, t) => { p.income[0].label = t; }, text), refused, 'category in an income label: ' + text);
    assert.throws(forge((p, t) => { p.label = t; }, text), refused, 'category in the period label: ' + text);
  }
  for (const text of [SENTINEL + ' Child Payee', SENTINEL + ' child note', SENTINEL + '-child', SENTINEL + ' Merchant',
    SENTINEL + ' PLAID NAME', SENTINEL + 'ville', SENTINEL + ' Payee', SENTINEL + '-plaid-tx']) {
    assert.throws(forge((p, t) => { p.householdBudget[0].label = t; }, text), refused, 'free text in a budget label: ' + text);
    assert.throws(forge((p, t) => { p.bills = [{ id: 'x', label: 'x', status: t }]; }, text), refused, 'free text in an enum field: ' + text);
  }
});

test('P2c household category vocabulary does not block a real capture', () => {
  const data = input();
  // Common household categories that also occur inside Forecast's fixed
  // identity strings ("...-minus-bills-budget-and-annual-savings") and labels.
  data.payload.categories.push(...['Bills', 'Income', 'Savings', 'Fuel', 'Household'].map((name, i) => ({ id: 'c' + i, name })));
  data.payload.transactions[0].category_name = 'Groceries';
  assert.equal(Pg.project(capture(data)).schema, Pg.PROJECTION_SCHEMA);
});

test('P3b balance terms keep every reconciling deduction Forecast publishes', () => {
  const candidate = capture(input());
  const forged = JSON.parse(JSON.stringify(candidate));
  const pub = forged.content.publication;
  pub.predictedEndingBalanceTerms = { ...pub.predictedEndingBalanceTerms, savingsItemSpending: 10,
    balanceAfterDeductions: pub.predictedEndingBalanceTerms.balanceAfterDeductions - 10 };
  pub.plannedPeriodCloseTerms = { ...pub.plannedPeriodCloseTerms, savingsItemSpending: 10, earlierCardPurchaseReserve: 5 };
  const p = Pg.project(reseal(forged)).content.publication;
  assert.deepEqual(p.predictedEndingBalanceTerms, pub.predictedEndingBalanceTerms, 'no term dropped while closes stays true');
  assert.deepEqual(p.plannedPeriodCloseTerms, pub.plannedPeriodCloseTerms);
});

test('P4 stored records outside the pinned shape fail closed on read', { skip }, async () => {
  const candidate = capture(input());
  const breakers = [
    row => { row.content.evidence = { input: {} }; },
    row => { row.content.publication.householdBudget[0].recon = []; },
    row => { row.content.provenance.observationReceipt = null; },
    row => { row.content.publication.cashNote = 'x'; },
    row => { row.content.engine.files = []; },
    row => { row.extra = true; },
    row => { row.content.publication.opening = 'not-a-number'; },
  ];
  for (const breakRow of breakers) {
    const w = pgWorld();
    const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
    await store.append({ enabled: true, candidate });
    const row = JSON.parse(w.committed[0].record);
    breakRow(row);
    const { revisionId, ...body } = row;
    const resealed = { ...body, revisionId: digest(body) }; // even a correctly re-hashed row is refused
    w.committed[0] = { sequence: 1, revision_id: resealed.revisionId, record: canonical(resealed) };
    await rejectsWith(store.read(), 'history-projection-invalid');
  }
});

test('P5 the 1.0 close-to-opening comparison fields survive projection across two periods', { skip }, async () => {
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
  const first = capture(input()), closing = capture(input({ day: NEXT, kind: 'closing' }));
  const next = capture(input({ day: NEXT, kind: 'first-observed', periodStart: NEXT, capturedAt: NEXT + 'T18:09:00Z' }));
  for (const c of [first, closing, next]) await store.append({ enabled: true, candidate: c });
  const rows = await Promise.all((await store.read()).map(m => store.read({ revisionId: m.revisionId })));
  const CLOSE = ['plannedPeriodClose', 'plannedPeriodCloseTrust', 'plannedPeriodCloseTerms', 'predictedEndingBalance', 'end'];
  const OPEN = ['opening', 'openingKnown', 'openingAsOf', 'openingSource', 'paydayBoundaryOpening', 'currentBalance', 'start'];
  for (const [row, full] of [[rows[0], first], [rows[1], closing]])
    for (const key of CLOSE) assert.deepEqual(row.content.publication[key], full.content.publication[key], 'close field ' + key);
  for (const key of OPEN) assert.deepEqual(rows[2].content.publication[key], next.content.publication[key], 'opening field ' + key);
  assert.equal(rows[1].content.period.end, '2030-02-14'); assert.equal(rows[2].content.period.start, NEXT);
});

test('P6 legacy v1 candidates project without completeness labels', { skip }, async () => {
  const dir = path.join(__dirname, 'fixtures', 'private-period-history-v1');
  const row = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).sort()[0]), 'utf8'));
  const candidate = { schema: row.schema, capturedAt: row.capturedAt, content: row.content, captureId: row.captureId };
  const p = Pg.project(candidate);
  assert.equal(p.sourceSchema, History.LEGACY_SCHEMA);
  for (const key of ['sourceCompleteness', 'closingState', 'cutoff']) assert.ok(!Object.hasOwn(p.content, key));
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
  const result = await store.append({ enabled: true, candidate });
  assert.equal(result.closingState, 'unknown');
  assert.equal((await store.read({ revisionId: result.revisionId })).sourceSchema, History.LEGACY_SCHEMA);
});

test('P7 connection string: verify-full only, direct host only, code-only errors', () => {
  const ok = Pg.parseDatabaseUrl(URL_VALUE);
  assert.deepEqual(ok, { host: HOST, port: 5432, database: 'neondb', user: 'atlas_period_history_writer', password: CANARY,
    ssl: { rejectUnauthorized: true, servername: HOST } });
  assert.equal(Pg.parseDatabaseUrl(URL_VALUE.replace(HOST, HOST + ':6543')).port, 6543);
  assert.equal(Pg.parseDatabaseUrl(URL_VALUE.replace(CANARY, 'p%40ss%2Fw')).password, 'p@ss/w');
  const cases = [
    [undefined, 'history-store-unconfigured'], ['', 'history-store-unconfigured'],
    ['not a url ' + CANARY, 'history-store-config-invalid'],
    [URL_VALUE.replace('postgresql:', 'http:'), 'history-store-config-invalid'],
    [URL_VALUE.replace(HOST, 'ep-invented-archive-000000-pooler.example.test'), 'history-store-config-invalid'],
    [URL_VALUE.replace(HOST, '10.0.0.5'), 'history-store-config-invalid'],
    [URL_VALUE.replace('/neondb', '/'), 'history-store-config-invalid'],
    [URL_VALUE.replace(':' + CANARY, ''), 'history-store-config-invalid'],
    [URL_VALUE + '#x', 'history-store-config-invalid'],
    [URL_VALUE.split('?')[0], 'history-store-tls-required'],
    ...['disable', 'allow', 'prefer', 'require', 'verify-ca', 'no-verify'].map(mode => [URL_VALUE.replace('verify-full', mode), 'history-store-tls-required']),
    [URL_VALUE + '&channel_binding=require', 'history-store-tls-required'],
    [URL_VALUE + '&sslrootcert=/tmp/ca.pem', 'history-store-tls-required'],
  ];
  for (const [value, code] of cases) {
    assert.throws(() => Pg.parseDatabaseUrl(value), e => e.code === code && e.message === code
      && !JSON.stringify(e).includes(CANARY) && !String(e.stack).includes(CANARY), code + ' for case');
  }
});

test('P8 shared owner: closed profile set; settlement default untouched; archive preflight refuses unsafe catalogs', { skip }, async () => {
  const base = () => ({ Client: pgWorld().Client, config: Pg.parseDatabaseUrl(URL_VALUE), schema: 'atlas_period_history' });
  for (const extra of [{ profile: 'archive' }, { profile: '' }, { profile: null }, { profile: 'period-history', scope: 'x' },
    { profile: 'period-history', terminalHistory: { householdId: 'household-' + 'a'.repeat(32), ledgerNamespace: 'ledger-' + 'b'.repeat(32) } },
    { profile: 'settlement' } /* settlement still requires its scope */]) {
    const w = pgWorld(); const opts = { ...base(), Client: w.Client, ...extra };
    await assert.rejects(openOwner(opts), e => e.code === 'SETTLEMENT_CONNECTION' && e.diagnostic.category === 'invalid-config');
    assert.equal(w.constructed, 0, 'refused before any client is constructed');
  }
  const w = pgWorld();
  const owner = await openOwner({ ...base(), Client: w.Client, profile: 'period-history' });
  assert.equal(w.config.application_name, 'atlas-period-history');
  assert.deepEqual(w.config.ssl, { rejectUnauthorized: true, servername: HOST });
  assert.deepEqual(Object.keys(owner).sort(), ['onLoss', 'periodHistory', 'retire', 'status']);
  assert.ok(w.queries.slice(0, 4).every(q => /^SELECT\b/.test(q.text)));
  assert.equal((await owner.retire()).close, 'confirmed');

  const unsafe = [
    c => { c.role.connectionLimit = -1; }, c => { c.role.superuser = true; }, c => { c.identity.searchPath = 'public'; },
    c => { c.privileges.tables = false; }, c => { c.privileges.schemaCreate = true; }, c => { c.privileges.functions = false; },
    c => { c.schema.push({ ...c.schema[0], name: 'extra' }); }, c => { c.schema[0].unsafe = true; },
    c => { c.schema[0].columns[2].type = 'jsonb'; }, c => { c.schema[0].columns[1].notNull = false; },
    c => { c.schema[0].primaryKey = ['revision_id']; }, c => { c.schema[0].rls = true; }, c => { c.schema.length = 0; },
  ];
  for (const mutate of unsafe) {
    const bad = pgWorld(); mutate(bad.catalog);
    await rejectsWith(Pg.openPeriodHistoryPostgres({ env: env(), Client: bad.Client }), 'history-store-unavailable');
    assert.equal(bad.ends, 1, 'the refused session is retired');
  }
  const tls = pgWorld(); const Original = tls.Client;
  class Unverified extends Original { constructor(c) { super(c); this.connection.stream.authorized = false; } }
  await rejectsWith(Pg.openPeriodHistoryPostgres({ env: env(), Client: Unverified }), 'history-store-unavailable');
});

test('P8b every rewrite grant on the archive table refuses the session (evaluated per emitted predicate)', { skip }, async () => {
  const grants = [['acl', 'UPDATE'], ['acl', 'DELETE'], ['acl', 'TRUNCATE'], ['acl', 'TRIGGER'], ['columnAcl', 'UPDATE'], ['columnAcl', 'REFERENCES']];
  for (const [set, privilege] of grants) {
    const w = pgWorld(); w.catalog[set].add(privilege);
    await assert.rejects(Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client }),
      e => e.code === 'history-store-unavailable' && e.diagnostic?.stage === 'privileges', set + ' ' + privilege);
  }
  for (const missing of ['SELECT', 'INSERT']) {
    const w = pgWorld(); w.catalog.acl.delete(missing);
    await assert.rejects(Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client }), e => e.diagnostic?.stage === 'privileges', 'without ' + missing);
  }
});

test('P4b a correctly re-hashed row with a broken chain link fails closed', { skip }, async () => {
  for (const breakLink of [row => { row.previousRevision = null; }, row => { row.previousRevision = 'a'.repeat(64); }]) {
    const w = pgWorld();
    const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
    await store.append({ enabled: true, candidate: capture(input()) });
    await store.append({ enabled: true, candidate: capture(input({ day: NEXT, kind: 'closing' })) });
    const row = JSON.parse(w.committed[1].record);
    breakLink(row);
    const { revisionId, ...body } = row;
    const resealed = { ...body, revisionId: digest(body) };
    w.committed[1] = { sequence: 2, revision_id: resealed.revisionId, record: canonical(resealed) };
    await rejectsWith(store.read(), 'history-integrity-failed');
  }
});

test('P5b the 1.0 comparison fields and complete balance terms are pinned in every projection', () => {
  // Obs 3: the projection is a closed allowlist. A Forecast term or field not
  // on it is dropped on purpose; these fields must never be among the dropped.
  const CLOSE = ['plannedPeriodClose', 'plannedPeriodCloseTrust', 'plannedPeriodCloseTerms', 'predictedEndingBalance', 'end'];
  const OPEN = ['opening', 'openingKnown', 'openingAsOf', 'openingSource', 'paydayBoundaryOpening', 'currentBalance', 'start'];
  for (const candidate of [capture(input()), capture(input({ day: NEXT, kind: 'closing' })),
    capture(input({ day: NEXT, kind: 'first-observed', periodStart: NEXT, capturedAt: NEXT + 'T18:09:00Z' }))]) {
    const native = candidate.content.publication, projected = Pg.project(candidate).content.publication;
    for (const key of [...CLOSE, ...OPEN]) {
      assert.ok(Object.hasOwn(native, key), 'Forecast still publishes ' + key);
      assert.ok(Object.hasOwn(projected, key), 'projection keeps ' + key);
      assert.deepEqual(projected[key], native[key], key);
    }
    for (const key of ['plannedPeriodCloseTerms', 'predictedEndingBalanceTerms'])
      if (native[key]) assert.deepEqual(Object.keys(projected[key]).sort(), Object.keys(native[key]).sort(), key + ' keeps every term');
  }
});

test('P9 concurrency and uncertain commits fail closed without inventing success', { skip }, async () => {
  const candidate = capture(input());
  const busy = pgWorld({ locked: false });
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: busy.Client });
  await rejectsWith(store.append({ enabled: true, candidate }), 'history-capture-busy');
  assert.equal(busy.committed.length, 0);

  const race = pgWorld();
  race.committed.push({ sequence: 1, revision_id: 'x', record: 'x' });
  const raced = await Pg.openPeriodHistoryPostgres({ env: env(), Client: race.Client });
  await rejectsWith(raced.append({ enabled: true, candidate }), 'history-integrity-failed');
  // A non-cooperating writer that ignored the lock and took the sequence first.
  const clash = pgWorld({ fail: ({ text }) => /^INSERT/.test(text) ? Object.assign(new Error(CANARY), { code: '23505' }) : null });
  const clashed = await Pg.openPeriodHistoryPostgres({ env: env(), Client: clash.Client });
  await rejectsWith(clashed.append({ enabled: true, candidate }), /^history-(capture-busy|store-unavailable)$/);
  assert.equal(clash.committed.length, 0);

  let commitSeen = false;
  const lost = pgWorld({ fail: ({ text }) => text === 'COMMIT' && !commitSeen && (commitSeen = true)
    ? Object.assign(new Error(CANARY), { code: 'ECONNRESET' }) : null });
  const first = await Pg.openPeriodHistoryPostgres({ env: env(), Client: lost.Client });
  await rejectsWith(first.append({ enabled: true, candidate }), /^history-(commit-uncertain|store-unavailable)$/);
  await rejectsWith(first.read(), 'history-store-unavailable'); // the lost session is retired, never reused
  const second = await Pg.openPeriodHistoryPostgres({ env: env(), Client: lost.Client });
  const retried = await second.append({ enabled: true, candidate });
  assert.equal(retried.status, 'appended', 'nothing committed, so the retry appends once');
  assert.equal((await second.append({ enabled: true, candidate })).status, 'duplicate');

  // Concurrent callers on one session are serialized whole-transaction.
  const together = pgWorld();
  const shared = await Pg.openPeriodHistoryPostgres({ env: env(), Client: together.Client });
  const results = await Promise.all([capture(input()), capture(input({ day: NEXT, kind: 'closing' })),
    capture(input({ day: NEXT, kind: 'first-observed', periodStart: NEXT, capturedAt: NEXT + 'T18:09:00Z' }))]
    .map(c => shared.append({ enabled: true, candidate: c })));
  assert.deepEqual(results.map(r => r.sequence), [1, 2, 3]);
  const verbs = together.queries.slice(4).map(q => q.text.split(' ')[0]);
  assert.deepEqual(verbs, ['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT', 'BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT',
    'BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT'], 'no interleaved transactions');
});

test('P10 import is inert: no driver, environment read or network until opened', () => {
  const source = fs.readFileSync(require.resolve('../scripts/private-period-history-postgres'), 'utf8');
  const top = source.split('\n').filter(line => /^const .*require\(/.test(line));
  assert.deepEqual(top, ["const History = require('./private-period-history');"]);
  assert.match(source, /env = process\.env/);
  assert.equal(Pg.ENV_NAME, 'ATLAS_PERIOD_HISTORY_DATABASE_URL');
});

test('P-loss the period-history session reports loss synchronously, before the connection is released', { skip }, async () => {
  const w = pgWorld();
  const store = await Pg.openPeriodHistoryPostgres({ env: env(), Client: w.Client });
  assert.equal(typeof store.onLoss, 'function');
  let fired = 0, unsubscribedFired = 0, endsAtLoss = null;
  store.onLoss(() => { fired++; endsAtLoss = w.ends; });
  const off = store.onLoss(() => { unsubscribedFired++; }); off();
  w.clients[0].emit('error', new Error(CANARY));
  assert.equal(fired, 1, 'the loss watcher ran synchronously on the driver error');
  assert.equal(endsAtLoss, 0, 'it ran before the connection was released');
  assert.equal(unsubscribedFired, 0, 'an unsubscribed watcher never runs');
  let late = 0; store.onLoss(() => { late++; });
  assert.equal(late, 1, 'subscribing after the loss fires at once');
  await rejectsWith(store.read(), /^history-/);
  await store.retire();
});
