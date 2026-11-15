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
  // the provider may write the account currency in capitals: that is still CAD
  assert.equal(block(closing(clean => { clean.payload.accounts[0].currency = 'CAD'; clean.payload.accounts[1].currency = ' cad '; })).status, 'saved'); checks++;
  // a pending copy beside a posted copy of one transaction id is not a repeat: the pending row is not at the bank
  const pendingCopy = block(closing(withRows([row(1, 1, DAY, '10', { id: 'pc-1' }), row(2, 1, DAY, '10', { id: 'pc-1', is_pending: true })])));
  assert.deepEqual([pendingCopy.status, pendingCopy.accounts[1].postedOnOrAfter], ['saved', { count: 1, total: 10 }]); checks++;
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
  ['one transaction id delivered twice as posted on chequing-b (identical copies)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '10', { id: 'dup-1' }), row(2, 1, DAY, '10', { id: 'dup-1' })])],
  ['one transaction id delivered twice as posted on chequing-a (differing copies)', 'posted-coverage-incomplete', withRows([row(1, 0, DAY, '10', { id: 'dup-2' }), row(2, 0, '2030-02-17', '11', { id: 'dup-2' })])],
  ['one transaction id delivered twice on chequing, dated before the evidence day', 'posted-coverage-incomplete', withRows([row(1, 1, '2030-02-10', '10', { id: 'dup-3' }), row(2, 1, '2030-02-10', '10', { id: 'dup-3' })])],
  ['a chequing balance that is not CAD', 'currency-unconfirmed', clean => { clean.payload.accounts[1].currency = 'usd'; }],
  ['a chequing balance with no currency', 'currency-unconfirmed', clean => { delete clean.payload.accounts[0].currency; }],
  ['a posted amount with sub-cent precision (refused, never rounded)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '10.005')])],
  ['a split child on chequing-b on or after the evidence day', 'transaction-structure-unsupported', withRows([row(1, 1, DAY, '12.34', { parent_id: SEEN + '-parent' })])],
  ['a transaction group on chequing-a on or after the evidence day', 'transaction-structure-unsupported', withRows([row(1, 0, DAY, '12.34', { is_group: true })])],
  // pending state: only a strict boolean is evidence (Grok's rule-17 condition, recorded on the PR)
  ['a posted row whose is_pending is null', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); r.is_pending = null; return r; })()])],
  ['a posted row whose is_pending is the text false', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); r.is_pending = 'false'; return r; })()])],
  ['a posted row whose is_pending is the text true', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); r.is_pending = 'true'; return r; })()])],
  ['a posted row whose is_pending is 0', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); r.is_pending = 0; return r; })()])],
  ['a posted row whose is_pending is 1', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); r.is_pending = 1; return r; })()])],
  ['a row with unknown pending state dated before the evidence day', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, '2030-02-10', '12.34'); r.is_pending = null; return r; })()])],
  ['a row with unknown pending state on chequing-a on the evidence day', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 0, DAY, '3'); delete r.is_pending; return r; })()])],
  ['a posted chequing row the observer marks as contradictory evidence', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12.34', { contradictoryEvidence: true })])],
  // a missing collection is not an empty one
  ['the transactions collection is missing', 'posted-coverage-incomplete', clean => { delete clean.payload.transactions; }],
  ['the transactions collection is null', 'posted-coverage-incomplete', clean => { clean.payload.transactions = null; }],
  ['the window declares two different start dates', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, startDate: '2030-02-01', start_date: '2030-02-02' }; }],
  ['the window declares two different end dates', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, endDate: DAY, end_date: '2030-02-17' }; }],
  // a posted id shared by a chequing row and another account is a conflicted identity
  ['one id posted on chequing-a and on savings with different amounts', 'posted-coverage-incomplete', withRows([row(1, 0, DAY, '10', { id: 'x-1' }), row(2, 2, DAY, '25', { id: 'x-1' })])],
  ['one id posted on savings and then on chequing-b (other order, different amounts)', 'posted-coverage-incomplete', withRows([row(1, 2, DAY, '25', { id: 'x-2' }), row(2, 1, DAY, '10', { id: 'x-2' })])],
  ['one id posted identically on chequing-a and on savings', 'posted-coverage-incomplete', withRows([row(1, 0, DAY, '10', { id: 'x-3' }), row(2, 2, DAY, '10', { id: 'x-3' })])],
  // arithmetic that cannot be held exactly is refused, never stored as a known total
  ['a running sum that passes the exact-integer range (91 rows of the largest accepted amount)', 'posted-coverage-incomplete',
    withRows(Array.from({ length: 91 }, (_, n) => row(100 + n, 1, DAY, '999999999999.99')))],
  // the amount is read from the provider's own decimal text, exactly: nothing else is accepted
  ['an amount of 70368744177664.01 (14 integer digits: the reproduction that float arithmetic turned into the wrong cent)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '70368744177664.01')])],
  ['an amount of 90071992547409.91 (14 integer digits)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '90071992547409.91')])],
  ['an amount of 10.0000000001 (more than two decimals)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '10.0000000001')])],
  ['an amount of 1e300 (exponent notation)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '1e300')])],
  ['an amount of 12e1 (exponent notation)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12e1')])],
  ['an amount of a delivered number type (not text)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, 12.34)])],
  ['an amount of +5 (a plus sign)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '+5')])],
  ['an amount of .5 (no integer digits)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '.5')])],
  ['an amount of 5. (a bare point)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '5.')])],
  ['an amount of  5 (padding)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, ' 5')])],
  ['an amount of empty text', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '')])],
  ['an amount of 12.345 (a nonzero third decimal)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12.345')])],
  ['an amount of 12.0050 (a nonzero digit in the fourth place)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12.0050')])],
  ['an amount of 12.30000 (five decimals, even all zeros after the second)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12.30000')])],
  ['an amount of 12.3040 (a nonzero third decimal)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '12.3040')])],
  ['an amount of 13 integer digits (one past the limit)', 'posted-coverage-incomplete', withRows([row(1, 1, DAY, '1000000000000.00')])],
  ['a posted chequing row dated with invalid text', 'posted-coverage-incomplete', withRows([row(1, 1, 'not-a-date', '12.34')])],
  ['the window declares truncated as the number 1 (not a strict false)', 'posted-coverage-incomplete', clean => { clean.payload.transactionWindow = { ...clean.payload.transactionWindow, truncated: 1 }; }],
  ['a posted row that names no account', 'posted-coverage-incomplete', withRows([(() => { const r = row(1, 1, DAY, '12.34'); delete r.account_id; return r; })()])],
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
// controls beside the refusals above: the same shapes that are fine stay saved
{
  const none = { count: 0, total: 0 };
  // a collection delivered as an empty array, with consistent coverage, is a real zero
  const empty = block(closing(clean => { clean.payload.transactions = []; }));
  assert.equal(empty.status, 'saved'); assert.deepEqual(empty.accounts.map(a => a.postedOnOrAfter), [none, none]); checks += 2;
  // the window's two spellings of one date agree
  assert.equal(block(closing(clean => { const w = clean.payload.transactionWindow; clean.payload.transactionWindow = { ...w, start_date: w.startDate, end_date: w.endDate }; })).status, 'saved'); checks++;
  // a savings copy that is still pending leaves one posted copy: counted once
  const pendingCopy = block(closing(withRows([row(1, 0, DAY, '10', { id: 'x-4' }), row(2, 2, DAY, '25', { id: 'x-4', is_pending: true })])));
  assert.equal(pendingCopy.status, 'saved'); assert.deepEqual(pendingCopy.accounts[0].postedOnOrAfter, { count: 1, total: 10 }); checks += 2;
  // an id repeated only among non-chequing accounts does not touch the chequing cuts
  assert.equal(block(closing(withRows([row(1, 2, DAY, '5', { id: 'x-5' }), row(2, 2, DAY, '6', { id: 'x-5' })]))).status, 'saved'); checks++;
  // the exact parse: the largest accepted amount, one decimal digit, a minus sign, a negative zero, and ordinary sums
  const big = block(closing(withRows([row(1, 1, DAY, '999999999999.99'), row(2, 1, DAY, '0.04')])));
  assert.equal(big.status, 'saved'); assert.deepEqual(big.accounts[1].postedOnOrAfter, { count: 2, total: 1000000000000.03 }); checks += 2;
  // Lunch Money v2's four-place text saves exactly: 12.3400, 10.0000 and 12.3 are 12.34, 10 and 12.30
  const v2 = block(closing(withRows([row(1, 1, DAY, '12.3400'), row(2, 1, DAY, '10.0000'), row(3, 1, DAY, '12.3'), row(4, 0, DAY, '-4.3500')])));
  assert.equal(v2.status, 'saved');
  assert.deepEqual(v2.accounts.map(a => a.postedOnOrAfter), [{ count: 1, total: -4.35 }, { count: 3, total: 34.64 }]); checks += 2;
  const forms = block(closing(withRows([row(1, 1, DAY, '-12.3'), row(2, 1, DAY, '-0'), row(3, 1, DAY, '7'), row(4, 1, DAY, '0.5')])));
  assert.equal(forms.status, 'saved'); assert.deepEqual(forms.accounts[1].postedOnOrAfter, { count: 4, total: -4.8 }); checks += 2;
  assert.ok(!Object.is(forms.accounts[1].postedOnOrAfter.total, -0)); checks++;
  // a posted row that is pending and names no account does not matter (it is not at the bank)
  assert.equal(block(closing(withRows([(() => { const r = row(1, 1, DAY, '5', { is_pending: true }); delete r.account_id; return r; })()]))).status, 'saved'); checks++;
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
  // a posted chequing row with no transaction id cannot be told apart from a repeat: unavailable (a savings row without one is ignored)
  {
    const sel = rows => periodBankBalancesFor({ period, observations: [{ ...obs('chequing-a', 1, DAY), providerAccountId: 'p0' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }],
      transactions: rows, rawTransactions: rows.map(t => ({ id: t.providerTransactionId, amount: '1' })), transactionsPresent: true,
      transactionWindow: { startDate: '2030-02-01', endDate: DAY, complete: true, hasMore: false, truncated: false, savingsFetchCoverage: { complete: true, startDate: '2030-02-01', endDate: DAY } },
      fetchedAt: DAY + 'T18:00:00Z', accounts: [{ providerAccountId: 'p0', currency: 'cad' }, { providerAccountId: 'p1', currency: 'cad' }] });
    const r = (account, id) => ({ providerAccountId: account, providerTransactionId: id, pending: false, currency: 'cad', savingsPostingEvidence: 'posted', date: DAY, amount: 1 });
    assert.equal(sel([r('p0', 'a')]).status, 'saved'); checks++;
    assert.equal(sel([r('p0', null)]).reason, 'posted-coverage-incomplete'); checks++;
    assert.equal(sel([r('p9', null), r('p0', 'a')]).status, 'saved'); checks++;
    // a posted row with no account id cannot be shown not to be chequing; a pending one is not at the bank
    assert.equal(sel([r(null, 'b'), r('p0', 'a')]).reason, 'posted-coverage-incomplete'); checks++;
    assert.equal(sel([{ ...r(null, 'b'), pending: true }, r('p0', 'a')]).status, 'saved'); checks++;
    // the raw rows must be the normalized rows, one for one: an extra raw row, or a raw row with another id, is unavailable
    const selRaw = (rows, raws) => periodBankBalancesFor({ period, observations: [{ ...obs('chequing-a', 1, DAY), providerAccountId: 'p0' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }],
      transactions: rows, rawTransactions: raws, transactionsPresent: true,
      transactionWindow: { startDate: '2030-02-01', endDate: DAY, complete: true, hasMore: false, truncated: false, savingsFetchCoverage: { complete: true, startDate: '2030-02-01', endDate: DAY } },
      fetchedAt: DAY + 'T18:00:00Z', accounts: [{ providerAccountId: 'p0', currency: 'cad' }, { providerAccountId: 'p1', currency: 'cad' }] });
    assert.equal(selRaw([r('p0', 'a')], [{ id: 'a', amount: '1' }]).status, 'saved'); checks++;
    assert.equal(selRaw([r('p0', 'a')], [{ id: 'a', amount: '1' }, { id: 'z', amount: '1' }]).reason, 'posted-coverage-incomplete'); checks++;
    assert.equal(selRaw([r('p0', 'a')], [{ id: 'other', amount: '1' }]).reason, 'posted-coverage-incomplete'); checks++;
    assert.equal(periodBankBalancesFor({ period, observations: [{ ...obs('chequing-a', 1, DAY), providerAccountId: 'p0' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p1' }],
      transactions: [r('p0', 'a')], rawTransactions: [], transactionsPresent: true,
      transactionWindow: { startDate: '2030-02-01', endDate: DAY, complete: true, hasMore: false, truncated: false, savingsFetchCoverage: { complete: true, startDate: '2030-02-01', endDate: DAY } },
      fetchedAt: DAY + 'T18:00:00Z', accounts: [{ providerAccountId: 'p0', currency: 'cad' }, { providerAccountId: 'p1', currency: 'cad' }] }).reason, 'posted-coverage-incomplete'); checks++;
  }
  // two cash observations sharing one provider account id cannot be told apart: unavailable, never a double sum
  const shared = periodBankBalancesFor({ period, observations: [{ ...obs('chequing-a', 1, DAY), providerAccountId: 'p' }, { ...obs('chequing-b', 3, DAY), providerAccountId: 'p' }],
    transactions: [], transactionWindow: { startDate: '2030-02-01', endDate: DAY, complete: true, hasMore: false, truncated: false }, fetchedAt: DAY + 'T18:00:00Z',
    accounts: [{ providerAccountId: 'p', currency: 'cad' }] });
  assert.equal(shared.reason, 'posted-coverage-incomplete'); assert.deepEqual(shared.accounts, []); checks += 2;
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
