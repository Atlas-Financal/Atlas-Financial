'use strict';
// #821 (owner decision 2026-11-08): a stale bank feed must not read as zero
// spending. Forecast.bankFeedFreshness is the one verdict the Budget page
// reads. Invented packets only; every expected date below is written by
// hand from the fixture rows, never computed with Forecast.
const assert = require('node:assert/strict');
const F = require('../public/forecast.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (err) { failures++; console.log('  FAIL ' + name + '\n       ' + err.message); }
}
const tx = (date, accountRole, extra = {}) => ({ id: 'invented-' + date + '-' + accountRole, date, accountRole,
  amount: 12.34, currency: 'cad', pending: false, ...extra });
const packet = (observationAsOf, transactions) => ({ schema: 'atlas-current-period-actuals/v1', observationAsOf,
  transactionWindow: { startDate: '2026-10-25', endDate: observationAsOf }, transactions });

test('a feed whose newest spending row is two days old is stale, dated to that row', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-01', 'household-cash'), tx('2026-11-06', 'revolving-credit')]));
  assert.equal(v.status, 'stale');
  assert.equal(v.newestTransactionDate, '2026-11-06');
  assert.equal(v.thresholdDays, 2);
});

test('a row dated yesterday keeps the feed fresh', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-07', 'household-cash')]));
  assert.equal(v.status, 'fresh');
  assert.equal(v.newestTransactionDate, '2026-11-07');
});

test('a pending row dated today is an imported transaction: fresh', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-02', 'household-cash'), tx('2026-11-08', 'revolving-credit', { pending: true })]));
  assert.equal(v.status, 'fresh');
  assert.equal(v.newestTransactionDate, '2026-11-08');
});

test('rows on savings, HELOC, mortgage or unmapped accounts do not prove the spending feed', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-03', 'household-cash'),
    tx('2026-11-08', 'household-reserve'), tx('2026-11-08', 'heloc'), tx('2026-11-08', 'mortgage'), tx('2026-11-08', 'unmapped')]));
  assert.equal(v.status, 'stale');
  assert.equal(v.newestTransactionDate, '2026-11-03');
});

test('no spending rows in the fetched window is stale, dated before the window start', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', []));
  assert.equal(v.status, 'stale');
  assert.equal(v.newestTransactionDate, null);
  assert.equal(v.windowStart, '2026-10-25');
});

test('undated, malformed or future-dated rows never make a feed fresh', () => {
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-01', 'household-cash'),
    tx(null, 'household-cash'), tx('2026-13-40', 'household-cash'), tx('2026-11-09', 'revolving-credit')]));
  assert.equal(v.status, 'stale');
  assert.equal(v.newestTransactionDate, '2026-11-01');
});

test('no packet, or a packet without an observation date, makes no claim', () => {
  assert.equal(F.bankFeedFreshness(null).status, 'unknown');
  assert.equal(F.bankFeedFreshness({ transactions: [tx('2026-11-08', 'household-cash')] }).status, 'unknown');
  assert.equal(F.bankFeedFreshness({ observationAsOf: '2026-11-08' }).status, 'unknown');
});

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
