'use strict';
// Saved bank balances in the saved close (owner decision, Dale, 2026-11-15, #821 comment 6888727089: "yes, save the balances").
// PR 1 of the per-period bank check: at the existing, owner-approved period-close capture (no new read, schedule or provider
// call) the closing record also keeps the two chequing balances Forecast's observer read, each with its provider evidence date,
// and the edge (the period's household-day cutoff) they are to be read against. Figures and dates only: no transaction row,
// id, count or total, nothing computed. (The count and total of the posted rows on or after the evidence day were built here
// and cut on the lead's decision after three review rounds; they return as their own change if the bank check needs them.)
// Each balance is read exactly from the provider's delivered value: text by a strict rule, a number only through its shortest
// decimal text and the same rule. If either balance is missing, undated, not exactly readable, ambiguous or dated differently
// from the other, the accounts cannot be told apart, or an account is not CAD, the block is stored as unavailable with a fixed
// reason and NO value; a value is never guessed. Nothing is displayed and no Forecast periodBankCheck exists yet. Invented data
// only; the table needs no new column (the block rides in the closed JSON record text, so this is not a schema change).
const assert = require('node:assert/strict');
const History = require('../scripts/private-period-history');
const Pg = require('../scripts/private-period-history-postgres');
const { START, NEXT, input, capture } = require('./fixtures/private-period-history-input');
const { pgWorld, URL_VALUE } = require('./fixtures/period-history-pg-double');

const { digest, planAppend, validateCandidate, periodBankBalancesFor, exactCents } = History.contract;
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


// ---- S1: a normal close saves both balances with their one evidence date and the edge, and nothing else
{
  const saved = block(closing());
  assert.deepEqual(Object.keys(saved).sort(), ['accounts', 'edge', 'reason', 'status']);
  assert.equal(saved.status, 'saved'); assert.equal(saved.reason, null); checks += 2;
  assert.deepEqual(saved.accounts, [
    { id: 'chequing-a', balance: 1000.25, evidenceDate: DAY },
    { id: 'chequing-b', balance: 500.5, evidenceDate: DAY }]); checks++;
  assert.deepEqual(saved.edge, { rule: 'household-day', end: '2030-02-14', tz: 'America/Vancouver' }); checks++;
  ok(!JSON.stringify(saved).includes('savings') && !JSON.stringify(saved).includes(SEEN),
    'S1: the savings account and every provider string are absent from the block');
  validateCandidate(closing()); checks++;
}

// ---- S1b: no transaction row is read: whatever the rows look like, the block is the same two balances and nothing from them
const row = (id, account, date, amount, extra) => ({ id: SEEN + '-row-' + id, account_id: SEEN + '-account-' + account, date, amount,
  currency: 'cad', category_id: 'invented-category', payee: SEEN + ' Payee', is_pending: false, ...(extra || {}) });
const withRows = rows => clean => { clean.payload.transactions.push(...rows); };
{
  const plain = block(closing());
  const awkward = block(closing(clean => {
    clean.payload.transactions.push(row(1, 1, DAY, 12.34), row(2, 1, DAY, '10.0000000001', { currency: 'usd' }), row(3, 0, DAY, '1e300', { is_pending: null }),
      row(4, 0, DAY, '5', { id: 'dup' }), row(5, 2, DAY, '6', { id: 'dup' }), row(6, 0, 'not-a-date', '1'), row(7, 1, DAY, '2', { account_id: '' }));
    clean.payload.transactionWindow = { ...clean.payload.transactionWindow, hasMore: true, truncated: 1 };
  }));
  assert.deepEqual(awkward, plain); checks++;
  const noRows = block(closing(clean => { delete clean.payload.transactions; }));
  assert.deepEqual(noRows, plain); checks++;
  ok(!JSON.stringify(awkward).includes('postedOnOrAfter') && !JSON.stringify(awkward).includes('"count"') && !JSON.stringify(awkward).includes('"total"'),
    'S1b: no count or total of any row is stored');
  // a capitals or padded account currency is still CAD
  assert.equal(block(closing(clean => { clean.payload.accounts[0].currency = 'CAD'; clean.payload.accounts[1].currency = ' cad '; })).status, 'saved'); checks++;
}

// ---- S1c: the balance is read exactly from the delivered value
{
  const balances = (a, b, cash) => closing(clean => { clean.payload.accounts[0].balance = a; clean.payload.accounts[1].balance = b; }, { cash });
  // text: Lunch Money v2 writes four places; zeros after the second are fine
  const four = block(balances('1000.2500', '500.5000', [1000.25, 500.5, 100]));
  assert.equal(four.status, 'saved'); assert.deepEqual(four.accounts.map(a => a.balance), [1000.25, 500.5]); checks += 2;
  const forms = block(balances('-12.3', '7', [-12.3, 7, 100]));
  assert.equal(forms.status, 'saved'); assert.deepEqual(forms.accounts.map(a => a.balance), [-12.3, 7]); checks += 2;
  const edge = block(balances('999999999999.99', '0.01', [999999999999.99, 0.01, 100]));
  assert.equal(edge.status, 'saved'); assert.deepEqual(edge.accounts.map(a => a.balance), [999999999999.99, 0.01]); checks += 2;
  // a number is read through its shortest decimal text and the same rule: an ordinary one saves
  const num = block(balances(1000.25, -5, [1000.25, -5, 100]));
  assert.equal(num.status, 'saved'); assert.deepEqual(num.accounts.map(a => a.balance), [1000.25, -5]); checks += 2;
  // refusals: stored as unavailable with no value, never rounded or tolerated
  const REFUSED = [
    ['a nonzero third decimal in text', '1000.255', 1000.255], ['a nonzero fourth place in text', '1000.2501', 1000.2501],
    ['five decimals in text', '1000.25000', 1000.25], ['exponent notation', '1e3', 1000], ['a plus sign', '+5', 5], ['no integer digits', '.5', 0.5],
    ['a bare point', '5.', 5], ['padding', ' 5 ', 5], ['13 integer digits', '1000000000000.00', 1000000000000],
    ['a number with a long fraction', 0.30000000000000004, 0.30000000000000004],
    ['a number with a third decimal', 1000.255, 1000.255]];
  for (const [label, value, evidence] of REFUSED) {
    const b = block(balances(value, '500.5', [evidence, 500.5, 100]));
    assert.equal(b.status, 'unavailable', label); assert.equal(b.reason, 'balance-missing', label); assert.deepEqual(b.accounts, [], label + ': no value is stored');
    checks += 3; validateCandidate(balances(value, '500.5', [evidence, 500.5, 100])); checks++;
  }
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
  ['a chequing balance that is not CAD', 'currency-unconfirmed', clean => { clean.payload.accounts[1].currency = 'usd'; }],
  ['a chequing balance with no currency', 'currency-unconfirmed', clean => { delete clean.payload.accounts[0].currency; }],
  ['a chequing balance with an empty currency', 'currency-unconfirmed', clean => { clean.payload.accounts[0].currency = '  '; }],
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
// the exact reading itself, directly: text to whole cents, or null (never rounded, never tolerated)
{
  const READ = [['0', 0], ['-0', 0], ['7', 700], ['12.3', 1230], ['12.34', 1234], ['12.3400', 1234], ['10.0000', 1000], ['12.30', 1230], ['-4.3500', -435],
    ['999999999999.99', 99999999999999], ['0.01', 1], ['-12.3', -1230]];
  for (const [text, expected] of READ) { assert.equal(exactCents(text), expected, text); checks++; }
  const NULL = ['12.345', '12.0050', '12.3040', '12.30000', '10.0000000001', '1e3', '1e+21', '12e1', '+5', '.5', '5.', ' 5', '5 ', '', '-', '--5', '1000000000000', '1000000000000.00',
    '1,000.00', '12.', 'NaN', 'Infinity', 12.34, null, undefined, true, {}, []];
  for (const text of NULL) { assert.equal(exactCents(text), null, String(text)); checks++; }
}
// the pure selector, on invented observations: ambiguity and account identity are closed too
{
  const period = { start: START, end: '2030-02-14', timezone: 'America/Vancouver' };
  const obs = (id, value, day, extra) => ({ canonical: { collection: 'cash', id }, evidenceValue: value, evidenceDate: day, ...(extra || {}) });
  const good = { period,
    observations: [{ ...obs('chequing-a', 1.5, DAY), providerAccountId: 'p0' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }],
    accounts: [{ providerAccountId: 'p0', currency: 'cad' }, { providerAccountId: 'p1', currency: 'CAD' }],
    rawAccounts: [{ id: 'p0', balance: '1.5' }, { id: 'p1', balance: 3 }] };
  assert.equal(periodBankBalancesFor(good).status, 'saved'); checks++;
  const reason = (label, change, expected) => {
    const r = periodBankBalancesFor({ ...good, ...change });
    assert.equal(r.status, 'unavailable', label); assert.equal(r.reason, expected, label); assert.deepEqual(r.accounts, [], label); checks += 3;
  };
  reason('two cash observations for one account', { observations: [obs('chequing-a', 1, DAY), obs('chequing-a', 2, DAY), obs('chequing-b', 3, DAY)] }, 'balance-ambiguous');
  reason('an unknown observation', { observations: [obs('chequing-a', 1, DAY, { unknown: true }), obs('chequing-b', 3, DAY)] }, 'balance-undated');
  reason('a non-numeric observed value', { observations: [obs('chequing-a', '1.00', DAY), obs('chequing-b', 3, DAY)] }, 'balance-missing');
  reason('no observations', { observations: undefined }, 'balance-missing');
  reason('both balances on one provider account id (they cannot be told apart)', { observations: [{ ...obs('chequing-a', 1, DAY), providerAccountId: 'p' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p' }],
    accounts: [{ providerAccountId: 'p', currency: 'cad' }], rawAccounts: [{ id: 'p', balance: '1' }] }, 'balance-ambiguous');
  reason('a balance with no provider account id', { observations: [obs('chequing-a', 1.5, DAY), { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }] }, 'balance-ambiguous');
  reason('a balance with a blank provider account id', { observations: [{ ...obs('chequing-a', 1.5, DAY), providerAccountId: '  ' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }] }, 'balance-ambiguous');
  reason('an account missing from the delivered account list', { accounts: [{ providerAccountId: 'p1', currency: 'cad' }] }, 'balance-ambiguous');
  reason('an account listed twice', { accounts: [...good.accounts, { providerAccountId: 'p0', currency: 'cad' }] }, 'balance-ambiguous');
  reason('a raw account row missing', { rawAccounts: [{ id: 'p1', balance: 3 }] }, 'balance-ambiguous');
  reason('a raw account row listed twice', { rawAccounts: [...good.rawAccounts, { id: 'p0', balance: '1.5' }] }, 'balance-ambiguous');
  reason('no raw account rows at all', { rawAccounts: undefined }, 'balance-ambiguous');
  reason('the delivered balance differs from the observed value', { rawAccounts: [{ id: 'p0', balance: '1.6' }, { id: 'p1', balance: 3 }] }, 'balance-missing');
  reason('the delivered balance is missing', { rawAccounts: [{ id: 'p0' }, { id: 'p1', balance: 3 }] }, 'balance-missing');
  reason('the delivered balance is null', { rawAccounts: [{ id: 'p0', balance: null }, { id: 'p1', balance: 3 }] }, 'balance-missing');
  reason('the delivered balance is a boolean', { rawAccounts: [{ id: 'p0', balance: true }, { id: 'p1', balance: 3 }] }, 'balance-missing');
  reason('the delivered balance is not finite', { rawAccounts: [{ id: 'p0', balance: '1.5' }, { id: 'p1', balance: Infinity }] }, 'balance-missing');
  // an absurd magnitude is only ever tested on the pure selector (a full capture of such a balance is not a supported input)
  reason('a number in exponent form', { observations: [{ ...obs('chequing-a', 1e21, DAY), providerAccountId: 'p0' }, good.observations[1]], rawAccounts: [{ id: 'p0', balance: 1e21 }, good.rawAccounts[1]] }, 'balance-missing');
  reason('a number with a long fraction', { observations: [{ ...obs('chequing-a', 0.1 + 0.2, DAY), providerAccountId: 'p0' }, good.observations[1]], rawAccounts: [{ id: 'p0', balance: 0.1 + 0.2 }, good.rawAccounts[1]] }, 'balance-missing');
  // a blank provider id is refused even if the account list happens to carry the same blank id
  reason('a blank provider id that the lists carry too', { observations: [{ ...obs('chequing-a', 1.5, DAY), providerAccountId: '  ' }, good.observations[1]],
    accounts: [{ providerAccountId: '  ', currency: 'cad' }, good.accounts[1]], rawAccounts: [{ id: '  ', balance: '1.5' }, good.rawAccounts[1]] }, 'balance-ambiguous');
  // an unreadable delivered text is refused even when the observed value is zero (null would otherwise read as zero)
  reason('an unreadable delivered text beside an observed zero', { observations: [{ ...obs('chequing-a', 0, DAY), providerAccountId: 'p0' }, good.observations[1]],
    rawAccounts: [{ id: 'p0', balance: '+0' }, good.rawAccounts[1]] }, 'balance-missing');
  reason('a non-CAD account', { accounts: [{ providerAccountId: 'p0', currency: 'cad' }, { providerAccountId: 'p1', currency: 'usd' }] }, 'currency-unconfirmed');
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
  refuse('the cut edge cut on an account row (a count and total of rows)', c => { c.periodBankBalances.accounts[0].postedOnOrAfter = { count: 0, total: 0 }; });
  refuse('a saved block with a reason', c => { c.periodBankBalances.reason = 'balance-missing'; });
  refuse('an unavailable block that still carries a value (a guess)', c => { c.periodBankBalances.status = 'unavailable'; c.periodBankBalances.reason = 'balance-missing'; });
  refuse('an unavailable block with an unlisted reason', c => { c.periodBankBalances = { status: 'unavailable', reason: 'because', edge: c.periodBankBalances.edge, accounts: [] }; });
  refuse('an unavailable block with a cut reason', c => { c.periodBankBalances = { status: 'unavailable', reason: 'posted-coverage-incomplete', edge: c.periodBankBalances.edge, accounts: [] }; });
  refuse('two accounts dated differently', c => { c.periodBankBalances.accounts[1].evidenceDate = '2030-02-15'; });
  refuse('an undated balance', c => { c.periodBankBalances.accounts[0].evidenceDate = null; });
  refuse('accounts in the wrong order', c => { c.periodBankBalances.accounts.reverse(); });
  refuse('the savings account in place of chequing-b', c => { c.periodBankBalances.accounts[1].id = 'savings'; });
  refuse('a text balance', c => { c.periodBankBalances.accounts[0].balance = '1000'; });
  refuse('a non-finite balance', c => { c.periodBankBalances.accounts[0].balance = Infinity; });
  refuse('a balance that is not whole cents', c => { c.periodBankBalances.accounts[0].balance = 1000.255; });
  refuse('a balance of a trillion dollars or more', c => { c.periodBankBalances.accounts[0].balance = 1e12; });
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
  const servedBlock = served.periodHistory[0] && served.periodHistory[0].content.periodBankBalances;
  ok(servedBlock && Object.keys(servedBlock).sort().join() === 'accounts,edge,reason,status',
    'S7: the saved balances are served to Forecast as the closed block only');
  ok(servedBlock.accounts.every(a => Object.keys(a).sort().join() === 'balance,evidenceDate,id'),
    'S7: each served account row holds only allowlisted keys');

  console.log(`PASS saved bank balances in the saved close: ${checks} checks`);
})().catch(error => { console.error(error); process.exit(1); });
