'use strict';
// Saved bank balances in the saved close (owner decision, Dale, 2026-11-15, #821 comment 6888727089: "yes, save the balances").
// PR 1 of the per-period bank check: at the existing, owner-approved period-close capture (no new read, schedule or provider
// call) the closing record also keeps the two chequing balances Forecast's observer read, each with its provider evidence date,
// and the edge (the period's household-day cutoff) they are to be read against. Figures only: no transaction rows, ids or
// payees, nothing computed. If either balance is missing, undated, ambiguous or dated differently from the other the block is
// stored as unavailable with a fixed reason and NO value; a value is never guessed. Nothing is displayed and no Forecast
// periodBankCheck exists yet (non-goals). Per account the block also keeps the EDGE CUT: the count and total of the posted
// transactions dated on or after that account's evidence date that were in the same fetch (counts and totals only, no ids). Invented data only; the table needs no new column (the block rides in the closed
// JSON record text, so this is not a schema change).
const assert = require('node:assert/strict');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, NEXT, input, capture } = require('./fixtures/private-period-history-input');
const { pgWorld, URL_VALUE } = require('./fixtures/period-history-pg-double');

const { digest, planAppend, validateCandidate, periodBankBalancesFor } = History.contract;
let checks = 0;
const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };
const throwsCode = (fn, code, label) => { assert.throws(fn, e => e.code === code, label); checks++; };
const SEEN = 'Zqbalancesentinel';
const DAY = '2030-02-16'; // the closing capture day: after the period's last household day (Feb 14)

// A closing capture of the invented Feb 1-14 period, read on Feb 16, with chequing balances 1,000.00 and 500.00 (cents kept).
function closing(mutate, { cash = [1000.25, 500.5, 100], sentinel = SEEN } = {}) {
  const raw = input({ day: DAY, kind: 'closing', periodStart: START, cash, sentinel });
  const clean = JSON.parse(JSON.stringify(raw)); delete clean.kind; delete clean.periodStart;
  const time = clean.capturedAt; delete clean.capturedAt;
  if (mutate) mutate(clean);
  return History.captureClosing(clean, { now: () => new Date(time) });
}
const block = candidate => candidate.content.periodBankBalances;
const reseal = candidate => { const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
  return { ...body, captureId: digest(body) }; };
const mutated = (candidate, fn) => { const copy = JSON.parse(JSON.stringify(candidate)); fn(copy.content); return reseal(copy); };

// ---- S1: a normal close saves both balances with their one evidence date, and the edge
{
  const saved = block(closing());
  assert.deepEqual(Object.keys(saved).sort(), ['accounts', 'edge', 'reason', 'status']);
  assert.equal(saved.status, 'saved'); assert.equal(saved.reason, null); checks += 2;
  const none = { count: 0, total: 0 }; // the fixture's one transaction is dated Feb 1, before the evidence day
  assert.deepEqual(saved.accounts, [
    { id: 'chequing-a', balance: 1000.25, evidenceDate: DAY, postedOnOrAfter: none },
    { id: 'chequing-b', balance: 500.5, evidenceDate: DAY, postedOnOrAfter: none }]); checks++;
  assert.deepEqual(saved.edge, { rule: 'household-day', end: '2030-02-14', tz: 'America/Vancouver' }); checks++;
  ok(!JSON.stringify(saved).includes('savings') && !JSON.stringify(saved).includes(SEEN),
    'S1: the savings account and every provider string are absent from the block');
  validateCandidate(closing()); checks++;
}

// ---- S1b: the edge cut: counts and totals of the POSTED rows on or after each account's evidence day, from the same fetch
const row = (id, account, date, amount, extra) => ({ id: SEEN + '-row-' + id, account_id: SEEN + '-account-' + account, date, amount,
  currency: 'cad', category_id: 'invented-category', payee: SEEN + ' Payee', is_pending: false, ...(extra || {}) });
const withRows = rows => clean => { clean.payload.transactions.push(...rows); };
{
  const saved = block(closing(withRows([
    row(1, 1, DAY, '12.34'),                       // chequing-b, the evidence day: in the fetch, counted
    row(2, 0, '2030-02-17', '100'),                 // chequing-a, after the evidence day: counted
    row(3, 1, '2030-02-15', '77.77'),               // chequing-b, the day BEFORE the evidence day: not counted
    row(4, 1, DAY, '4.35'), row(5, 1, DAY, '4.35'), row(9, 1, DAY, '4.35'), // whole-cent sum: three 4.35 rows sum to 13.049999999999997 in floating point; the total must be exactly 13.05 + 12.34
    row(6, 1, DAY, '5', { is_pending: true }),      // pending: not at the bank yet, excluded
    row(7, 2, DAY, '999'),                          // the savings account: outside the pool, excluded
    row(8, 0, DAY, '-250')])));                     // a credit (provider sign: debit positive): counted with its sign
  assert.deepEqual(saved.accounts.map(a => [a.id, a.postedOnOrAfter]), [
    ['chequing-a', { count: 2, total: -150 }],
    ['chequing-b', { count: 4, total: 25.39 }]]); checks++;
  assert.equal(saved.status, 'saved'); checks++;
  ok(!JSON.stringify(saved).includes(SEEN) && !JSON.stringify(saved).includes('row'), 'S1b: no id, payee or row reaches the block');
  // a pending non-CAD row is not at the bank, so it does not make the block unavailable
  assert.equal(block(closing(withRows([row(1, 1, DAY, '12.34', { currency: 'usd', is_pending: true })]))).status, 'saved'); checks++;
}

// whole cents: three 4.35 rows sum to 13.049999999999997 in floating point; the stored total is exactly 13.05 (and validates)
{
  const candidate = closing(withRows([row(1, 0, DAY, '4.35'), row(2, 0, DAY, '4.35'), row(3, 0, DAY, '4.35')]));
  assert.deepEqual(block(candidate).accounts[0].postedOnOrAfter, { count: 3, total: 13.05 }); checks++;
  validateCandidate(candidate); checks++;
}

// ---- S2: every unusable balance stores the block as unavailable, with a fixed reason and no value
const UNAVAILABLE = [
  ['chequing-b is not observed', 'balance-missing', clean => { clean.payload.accounts = clean.payload.accounts.filter((_, i) => i !== 1); }],
  ['chequing-a carries no balance', 'balance-missing', clean => { delete clean.payload.accounts[0].balance; }],
  ['chequing-b has no balance date at all', 'balance-undated', clean => {
    for (const key of ['balance_as_of', 'balance_last_update', 'updated_at']) delete clean.payload.accounts[1][key]; }],
  ['chequing-a is dated after the request', 'balance-undated', clean => {
    clean.payload.accounts[0].balance_as_of = clean.payload.accounts[0].balance_last_update = clean.payload.accounts[0].updated_at = '2030-02-20T17:59:00Z'; }],
  ['the two balances are dated on different days', 'balance-dates-differ', clean => {
    clean.payload.accounts[1].balance_as_of = clean.payload.accounts[1].balance_last_update = clean.payload.accounts[1].updated_at = '2030-02-15T17:59:00Z'; }],
  ['a posted non-CAD row on chequing-b', 'currency-unconfirmed', withRows([row(1, 1, DAY, '12.34', { currency: 'usd' })])],
  ['a posted row with no currency on chequing-a, dated before the evidence day', 'currency-unconfirmed', withRows([row(1, 0, '2030-02-10', '3', { currency: null })])],
  ['a posted row with unknown pending state', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); delete r.is_pending; return r; })()])],
  ['the posted window has more rows', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, hasMore: true }; }],
  ['the posted window is truncated', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, truncated: true }; }],
  ['the posted window starts after the evidence day', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, startDate: '2030-02-17' }; }],
  ['the posted window ends before the fetch day', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, endDate: '2030-02-15' }; }],
  ['a split child on chequing-b on or after the evidence day', 'transaction-structure-unsupported', withRows([row(1, 1, DAY, '12.34', { parent_id: SEEN + '-parent' })])],
  ['a transaction group on chequing-a on or after the evidence day', 'transaction-structure-unsupported', withRows([row(1, 0, DAY, '12.34', { is_group: true })])],
];
for (const [label, reason, change] of UNAVAILABLE) {
  const candidate = closing(change);
  const b = block(candidate);
  assert.equal(b.status, 'unavailable', label); assert.equal(b.reason, reason, label);
  assert.deepEqual(b.accounts, [], label + ': no value is stored');
  assert.deepEqual(b.edge, { rule: 'household-day', end: '2030-02-14', tz: 'America/Vancouver' }, label);
  checks += 4;
  validateCandidate(candidate); checks++;
}
// ambiguity is closed too (two cash observations for one account): the pure selector, on invented observations
{
  const period = { start: START, end: '2030-02-14', timezone: 'America/Vancouver' };
  const obs = (id, value, day, extra) => ({ canonical: { collection: 'cash', id }, evidenceValue: value, evidenceDate: day, ...(extra || {}) });
  const twice = periodBankBalancesFor({ period, observations: [obs('chequing-a', 1, DAY), obs('chequing-a', 2, DAY), obs('chequing-b', 3, DAY)] });
  assert.equal(twice.status, 'unavailable'); assert.equal(twice.reason, 'balance-ambiguous'); assert.deepEqual(twice.accounts, []); checks += 3;
  const unknown = periodBankBalancesFor({ period, observations: [obs('chequing-a', 1, DAY, { unknown: true }), obs('chequing-b', 3, DAY)] });
  assert.equal(unknown.reason, 'balance-undated'); checks++;
  const nonFinite = periodBankBalancesFor({ period, observations: [obs('chequing-a', '1.00', DAY), obs('chequing-b', 3, DAY)] });
  assert.equal(nonFinite.status, 'unavailable'); assert.deepEqual(nonFinite.accounts, []); checks += 2;
  const none = periodBankBalancesFor({ period, observations: undefined });
  assert.equal(none.reason, 'balance-missing'); checks++;
}

// ---- S3: only the saved close carries it
{
  const original = capture(input({ kind: 'original' }));
  ok(!Object.hasOwn(original.content, 'periodBankBalances'), 'S3: an original record has no balance block');
  const first = capture(input({ day: NEXT, kind: 'first-observed' }));
  ok(!Object.hasOwn(first.content, 'periodBankBalances'), 'S3: a first-observed record has no balance block');
}

// ---- S4: the record contract refuses anything outside the closed block
{
  const base = closing();
  const refuse = (label, fn) => throwsCode(() => validateCandidate(mutated(base, fn)), 'history-schema-invalid', label);
  refuse('an extra key in the block', c => { c.periodBankBalances.guess = 1; });
  refuse('an extra key on an account row', c => { c.periodBankBalances.accounts[0].payee = 'x'; });
  refuse('a saved block with a reason', c => { c.periodBankBalances.reason = 'balance-missing'; });
  refuse('an unavailable block that still carries a value (a guess)', c => { c.periodBankBalances.status = 'unavailable'; c.periodBankBalances.reason = 'balance-missing'; });
  refuse('an unavailable block with an unlisted reason', c => { c.periodBankBalances = { status: 'unavailable', reason: 'because', edge: c.periodBankBalances.edge, accounts: [] }; });
  refuse('two accounts dated differently', c => { c.periodBankBalances.accounts[1].evidenceDate = '2030-02-15'; });
  refuse('an undated balance', c => { c.periodBankBalances.accounts[0].evidenceDate = null; });
  refuse('accounts in the wrong order', c => { c.periodBankBalances.accounts.reverse(); });
  refuse('the savings account in place of chequing-b', c => { c.periodBankBalances.accounts[1].id = 'savings'; });
  refuse('a non-finite balance', c => { c.periodBankBalances.accounts[0].balance = '1000'; });
  refuse('an account row with no edge cut', c => { delete c.periodBankBalances.accounts[0].postedOnOrAfter; });
  refuse('an extra key in the edge cut (an id would ride here)', c => { c.periodBankBalances.accounts[0].postedOnOrAfter.ids = ['x']; });
  refuse('a negative edge-cut count', c => { c.periodBankBalances.accounts[0].postedOnOrAfter.count = -1; });
  refuse('a fractional edge-cut count', c => { c.periodBankBalances.accounts[0].postedOnOrAfter.count = 1.5; });
  refuse('an edge-cut total that is not whole cents', c => { c.periodBankBalances.accounts[0].postedOnOrAfter.total = 12.345; });
  refuse('a text edge-cut total', c => { c.periodBankBalances.accounts[0].postedOnOrAfter.total = '12.34'; });
  refuse('a different edge', c => { c.periodBankBalances.edge.end = '2030-02-15'; });
  refuse('a block on a non-closing record', c => { c.kind = 'first-observed'; });
  const legacy = JSON.parse(JSON.stringify(base)); legacy.schema = History.LEGACY_SCHEMA;
  for (const key of ['sourceCompleteness', 'closingState', 'cutoff']) delete legacy.content[key];
  throwsCode(() => validateCandidate(reseal(legacy)), 'history-schema-invalid', 'a legacy v1 record never carries it');
  // a v2 record saved before this change (no block) still validates
  const before = mutated(base, c => { delete c.periodBankBalances; });
  validateCandidate(before); checks++;
}

// ---- S5: a retry across the deployment is idempotent: the block is a pure function of the keyed payload, so it stays out of the
// content key. A close captured BEFORE this change (no block) and the same observation captured again AFTER it are one revision.
{
  const after = closing();
  const before = mutated(after, c => { delete c.periodBankBalances; });
  const chain = planAppend([], before).chain;
  const stored = { ...before, ...chain, revisionId: digest({ ...before, ...chain }) };
  assert.equal(planAppend([stored], after).status, 'duplicate'); checks++;
  // a genuinely different observation is still a conflict for the singleton closing (the block does not make it a duplicate)
  const other = closing(clean => { clean.payload.accounts[0].balance = 999; }, { cash: [999, 500.5, 100] });
  assert.throws(() => planAppend([stored], other), e => e.code === 'history-original-or-closing-conflict'); checks++;
}

// ---- S6: the hosted store keeps the block in the closed projection and nothing else rides along
(async () => {
  const candidate = closing();
  const projected = Pg.project(candidate);
  assert.deepEqual(projected.content.periodBankBalances, block(candidate)); checks++;
  assert.notEqual(projected.content.periodBankBalances, block(candidate)); checks++; // rebuilt, not shared by reference
  ok(!JSON.stringify(projected).includes(SEEN), 'S6: no provider string reaches the projection');
  // the projection refuses a block outside the shape (the closed allowlist)
  throwsCode(() => Pg.project(mutated(candidate, c => { c.periodBankBalances.accounts[0].payee = 'x'; })), 'history-schema-invalid', 'projection: extra key');
  // round trip through the store double: appended, read back byte-exact, and the stored text holds only figures and dates
  const trustClean = !Object.keys(process.env).some(k => /^(?:PG.*|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_.*)$/i.test(k));
  if (trustClean) {
    const world = pgWorld();
    const store = await Pg.openPeriodHistoryPostgres({ env: { [Pg.ENV_NAME]: URL_VALUE }, Client: world.Client });
    const result = await store.append({ enabled: true, candidate });
    assert.equal(result.status, 'appended'); checks++;
    const stored = JSON.parse(world.committed[0].record);
    assert.deepEqual(stored.content.periodBankBalances, block(candidate)); checks++;
    assert.ok(!world.committed.map(r => r.record).join('\n').includes(SEEN), 'no provider text in the stored record'); checks++;
    const back = await store.read({ revisionId: result.revisionId });
    assert.deepEqual(back.content.periodBankBalances, block(candidate)); checks++;
  } else console.log('  (store round trip skipped: process environment carries TLS-trust variables the connection owner refuses)');

  // ---- S7: nothing is displayed: the read side serves only the fields Forecast reprints
  const Read = require('../scripts/period-history-read');
  const record = { ...projected, sequence: 1, contentKey: 'k'.repeat(64), previousRevision: null, baselineRevision: null, revisionId: 'a'.repeat(64) };
  const served = await new Promise(resolve => {
    let now = 0;
    const reader = Read.create({ env: { [Read.FLAG]: 'on' }, clock: () => now, log: () => {},
      openStore: async () => ({ async read(opts) { return opts ? record : [{ revisionId: record.revisionId, kind: 'closing', period: record.content.period }]; }, async retire() {} }) });
    const doc = { meta: { asOf: DAY } };
    reader.withHistory(doc);
    setTimeout(() => resolve(reader.withHistory({ meta: { asOf: DAY } })), 20);
  });
  ok(Array.isArray(served.periodHistory) && served.periodHistory.length === 1, 'S7: the closing is served');
  ok(!JSON.stringify(served).includes('periodBankBalances') && !JSON.stringify(served).includes('chequing-a'),
    'S7: the saved balances are not served: no displayed figure and no data.json change');

  console.log(`PASS saved bank balances in the saved close: ${checks} checks`);
})().catch(error => { console.error(error); process.exit(1); });
