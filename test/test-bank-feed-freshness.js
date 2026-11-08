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

// The page notice says only what the dates show (Atlas review 6725463013):
// a transaction date is not an import or arrival time, and an empty window
// is not a known arrival before it. The real renderer function is run with
// a fixed date formatter; expected text is written by hand.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8');
const noticeFn = /^function budgetBankFeedNoticeHtml\([\s\S]*?\n\}$/m.exec(planSrc);
const notice = feed => vm.runInNewContext(`${noticeFn[0]}\nbudgetBankFeedNoticeHtml(feed);`, {
  feed, fmtDate: d => 'D<' + d + '>', budgetBrowseEscape: v => String(v).replace(/</g, '&lt;').replace(/>/g, '&gt;'),
});
const textOf = html => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const TAIL = ' Recent spending may be missing, so the spending shown here is incomplete and not final.';
const SCOPE = 'On the household chequing and credit-card accounts';

test('the notice names the newest spending-account transaction date, never an arrival date', () => {
  // A row dated 2026-11-06 may have been imported today; the notice must not say when it arrived.
  const html = notice({ status: 'stale', asOf: '2026-11-08', newestTransactionDate: '2026-11-06', windowStart: '2026-10-25' });
  assert.equal(textOf(html), SCOPE + ', the newest transaction dated on or before D<2026-11-08> is dated D<2026-11-06>.' + TAIL);
  assert.match(html, /<time datetime="2026-11-06">/);
  assert.doesNotMatch(html, /arriv|import/i);
});

test('newer savings or HELOC rows do not contradict the notice: it is scoped to what the verdict read', () => {
  // The same packet as the savings/HELOC case above: those rows are 2026-11-08, the verdict 2026-11-03.
  const v = F.bankFeedFreshness(packet('2026-11-08', [tx('2026-11-03', 'household-cash'),
    tx('2026-11-08', 'household-reserve'), tx('2026-11-08', 'heloc')]));
  const text = textOf(notice(v));
  assert.equal(text, SCOPE + ', the newest transaction dated on or before D<2026-11-08> is dated D<2026-11-03>.' + TAIL);
  assert.doesNotMatch(text, /newest bank transaction Atlas has|Atlas has no bank transactions/i);
});

test('an empty window states only that no spending-account transaction is dated in it', () => {
  const html = notice({ status: 'stale', asOf: '2026-11-08', newestTransactionDate: null, windowStart: '2026-10-25' });
  assert.equal(textOf(html), SCOPE + ', Atlas has no transactions dated from D<2026-10-25> to D<2026-11-08>.' + TAIL);
  assert.doesNotMatch(html, /arriv|import|before/i);
});

test('no window start: no date is invented', () => {
  const html = notice({ status: 'stale', asOf: '2026-11-08', newestTransactionDate: null, windowStart: null });
  assert.equal(textOf(html), SCOPE + ', Atlas has no dated transactions for this period.' + TAIL);
  assert.doesNotMatch(html, /<time|arriv/i);
});

test('a fresh or absent verdict renders no notice', () => {
  assert.equal(notice(null), '');
});

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
