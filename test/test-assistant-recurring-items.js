'use strict';
/* S0 (LEDGER A; Dale 2026-11-17): the assistant's GET-only, sanitized Lunch
 * Money recurring-items read. Schedule evidence only, reviewed items only,
 * aliases only. No payee, description, notes, amount or category crosses.
 *
 * Invented provider data only; every expected value is hand-written.
 * `node test/test-assistant-recurring-items.js`
 */
const assert = require('node:assert/strict');
const { createService, READ_SCOPE, WRITE_SCOPE } = require('../scripts/assistant-lunchmoney');
const Mcp = require('../scripts/assistant-mcp');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const now = Date.parse('2026-11-17T18:00:00Z');
  // Plaid and manual accounts deliberately share provider id 4: they must map to different references.
  const plaid = [{ id: 4, name: 'Invented Chequing' }];
  const manual = [{ id: 4, name: 'Invented Cash' }, { id: 9, name: 'Invented Card' }];
  const SECRETS = ['Invented Utility Co', 'INVENTED UTIL 0042', 'Invented note text', '123.45', '67.80', '88.10'];
  const reviewedMonthly = {
    id: 701, description: 'Invented Utility Co', status: 'reviewed', source: 'manual',
    created_by: 55, created_at: '2026-01-02T03:04:05Z', updated_at: '2026-02-03T04:05:06Z',
    transaction_criteria: { start_date: '2026-01-01', end_date: null, anchor_date: '2026-01-15', payee: 'Invented Utility Co',
      amount: '123.45', to_base: 123.45, currency: 'cad', granularity: 'month', quantity: 1,
      plaid_account_id: 4, manual_account_id: null },
    overrides: { payee: 'INVENTED UTIL 0042', notes: 'Invented note text', category_id: 3 },
    matches: { request_start_date: '2026-10-01', request_end_date: '2026-11-30',
      expected_occurrence_dates: ['2026-11-15', '2026-10-15'],
      found_transactions: [{ date: '2026-10-13', transaction_id: 5001 }],
      missing_transaction_dates: ['2026-11-15'] } };
  const reviewedQuarterlyManual = {
    id: 702, description: 'Invented Insurer', status: 'reviewed', source: 'transaction',
    created_by: 55, created_at: '2026-01-02T03:04:05Z', updated_at: '2026-02-03T04:05:06Z',
    transaction_criteria: { start_date: '2026-03-01', end_date: '2027-02-28', anchor_date: '2026-03-01', payee: 'Invented Insurer',
      amount: '67.80', currency: 'cad', granularity: 'month', quantity: 3, plaid_account_id: null, manual_account_id: 4 },
    overrides: {}, matches: { request_start_date: '2026-10-01', request_end_date: '2026-11-30',
      expected_occurrence_dates: [], found_transactions: [], missing_transaction_dates: [] } };
  const suggested = { id: 703, description: 'Invented Suggestion', status: 'suggested', source: 'system',
    transaction_criteria: { anchor_date: '2026-10-01', amount: '88.10', currency: 'cad', granularity: 'week', quantity: 2,
      plaid_account_id: 4, manual_account_id: null, start_date: null, end_date: null, payee: 'Invented Suggestion' },
    overrides: {}, matches: null };
  let items = [suggested, reviewedQuarterlyManual, reviewedMonthly];
  let envelope = items => items;
  const calls = [];
  let failRecurring = false;
  const tx = { id: 5001, date: '2026-10-13', amount: '123.45', currency: 'cad', payee: 'Invented Utility Co', notes: null,
    category_id: 3, plaid_account_id: 4, manual_account_id: null, is_pending: false, status: 'reviewed', recurring_id: 701 };
  const service = createService({ now: () => now, resolveToken: async () => 'synthetic-test-token',
    fetch: async (url, opts) => {
      const u = new URL(url); const p = u.pathname.replace('/v2', '');
      calls.push({ path: p, method: opts.method, query: u.searchParams });
      let data;
      if (p === '/categories') data = { categories: [{ id: 3, name: 'Invented Utilities' }] };
      else if (p === '/plaid_accounts') data = { plaid_accounts: plaid };
      else if (p === '/manual_accounts') data = { manual_accounts: manual };
      else if (p === '/transactions') data = { transactions: [tx], has_more: false };
      else if (p === '/recurring_items') data = envelope(structuredClone(items));
      else throw new Error('unexpected path ' + p);
      const failed = failRecurring && p === '/recurring_items';
      return { ok: !failed, status: failed ? 429 : 200, json: async () => structuredClone(data) };
    } });
  const auth = { principal: 'owner', scopes: [READ_SCOPE] };
  const input = { startDate: '2026-10-01', endDate: '2026-11-30' };

  console.log('Reviewed items only, schedule evidence only');
  const r = await service.invoke('recurring', input, auth);
  ok(r.status === 'ok' && r.coverage === 'complete-provider-response', 'the read succeeds and is complete', JSON.stringify(r.diagnostic || r.coverage));
  ok(r.itemCount === 2 && r.suggestedExcluded === 1, 'two reviewed items; the suggested one is excluded and counted');
  ok(r.writesAtlasState === false && r.providerWrite === false, 'no Atlas or provider write');
  const recCalls = calls.filter(c => c.path === '/recurring_items');
  ok(recCalls.length === 1 && recCalls[0].method === 'GET', 'exactly one GET to /recurring_items');
  ok(recCalls[0].query.get('start_date') === '2026-10-01' && recCalls[0].query.get('end_date') === '2026-11-30'
    && !recCalls[0].query.has('include_suggested'), 'it sends the window and never asks for suggested items');
  ok(calls.every(c => c.method === 'GET'), 'every provider call is a GET');
  const [monthly, quarterly] = r.items;
  ok(monthly.granularity === 'month' && monthly.quantity === 1 && monthly.anchorDate === '2026-01-15'
    && monthly.startDate === '2026-01-01' && monthly.endDate === null && monthly.status === 'reviewed',
  'the monthly item: granularity, quantity, anchor, start and a documented null end');
  ok(quarterly.granularity === 'month' && quarterly.quantity === 3 && quarterly.endDate === '2027-02-28',
    'every 3 months is reported as month × 3, never rewritten');
  ok(JSON.stringify(monthly.matches) === JSON.stringify({ windowStart: '2026-10-01', windowEnd: '2026-11-30',
    expectedDates: ['2026-10-15', '2026-11-15'], foundTransactions: [{ date: '2026-10-13', transactionRef: monthly.matches.foundTransactions[0].transactionRef }],
    missingDates: ['2026-11-15'] }), 'expected, found and missing dates as Lunch Money reports them, sorted',
  JSON.stringify(monthly.matches));
  ok(/^rec-[a-f0-9]{24}$/.test(monthly.recurringRef) && monthly.recurringRef !== quarterly.recurringRef, 'items carry distinct opaque references');
  ok(monthly.accountMapping === 'catalog' && quarterly.accountMapping === 'catalog' && monthly.accountRef !== quarterly.accountRef,
    'plaid 4 and manual 4 map to different catalog account references');
  const catalog = await service.invoke('catalog', {}, auth);
  ok(catalog.accounts.some(a => a.accountRef === monthly.accountRef) && catalog.accounts.some(a => a.accountRef === quarterly.accountRef),
    'each account reference is the catalog\'s own reference');

  console.log('The found transaction is the same row get_lunchmoney_transactions returns');
  const q = await service.invoke('query', { startDate: '2026-10-01', endDate: '2026-10-31' }, auth);
  ok(q.status === 'ok' && q.rows[0].transactionRef === monthly.matches.foundTransactions[0].transactionRef,
    'the found transaction reference equals the transactions read\'s reference for that row');

  console.log('Nothing beyond schedule evidence crosses');
  const blob = JSON.stringify(r);
  ok(SECRETS.every(s => !blob.includes(s)), 'no payee, description, notes or amount text appears');
  // Item keys only: the envelope's own `source` names the provider ("Lunch Money v2"), as every read does.
  ok(!/"(payee|description|notes|amount|currency|to_base|category|categoryRef|overrides|created_by|source|id|plaid_account_id|manual_account_id|transaction_id)"\s*:/.test(JSON.stringify(r.items)),
    'no payee, description, notes, amount, currency, category, override, creator, source or raw id key');
  ok(!/\b(701|702|703|5001)\b/.test(blob.replace(/"20\d\d-\d\d-\d\d"/g, '')), 'no raw provider id appears');

  console.log('Fail closed');
  envelope = items => ({ recurring_items: items, has_more: true });
  const paged = await service.invoke('recurring', input, auth);
  ok(paged.status === 'ok' && paged.coverage === 'incomplete-provider-response', 'a paginated-looking envelope is never called complete');
  envelope = items => items;
  items = [reviewedMonthly, { ...reviewedQuarterlyManual, id: 701 }];
  const dup = await service.invoke('recurring', input, auth);
  ok(dup.status === 'unavailable' && dup.diagnostic.code === 'duplicate-provider-identity', 'a duplicate item id fails the whole read');
  items = [{ ...reviewedMonthly, id: '701' }];
  ok((await service.invoke('recurring', input, auth)).diagnostic.code === 'invalid-provider-identity', 'a non-integer item id fails the whole read');
  items = [{ ...reviewedMonthly, status: undefined }];
  const noStatus = await service.invoke('recurring', input, auth);
  ok(noStatus.itemCount === 0 && noStatus.statusUnavailable === 1 && noStatus.coverage === 'incomplete-provider-response',
    'a missing status is never treated as reviewed');
  items = [{ ...reviewedMonthly, transaction_criteria: { ...reviewedMonthly.transaction_criteria, granularity: 'fortnight', quantity: 0, anchor_date: '2026-02-30' } }];
  const bad = await service.invoke('recurring', input, auth);
  ok(bad.items[0].granularity === null && bad.items[0].quantity === null && bad.items[0].anchorDate === null
    && JSON.stringify(bad.items[0].unavailableFields) === JSON.stringify(['granularity', 'quantity', 'anchorDate'])
    && bad.coverage === 'incomplete-provider-response', 'an unknown granularity, zero quantity or impossible date is unavailable, never guessed',
  JSON.stringify(bad.items[0].unavailableFields));
  items = [{ ...reviewedMonthly, matches: { ...reviewedMonthly.matches, found_transactions: [{ date: '2026-10-13', transaction_id: 'x' }] } }];
  const badFound = await service.invoke('recurring', input, auth);
  ok(badFound.items[0].matches.foundTransactions === null && badFound.items[0].unavailableFields.includes('foundTransactions'),
    'a malformed found transaction makes the found list unavailable');
  items = [{ ...reviewedMonthly, transaction_criteria: { ...reviewedMonthly.transaction_criteria, plaid_account_id: 99 } }];
  ok((await service.invoke('recurring', input, auth)).items[0].accountMapping === 'unavailable', 'an account not in the catalog maps to unavailable, never a guess');
  items = [reviewedMonthly];
  failRecurring = true;
  const failed = await service.invoke('recurring', input, auth);
  ok(failed.status === 'unavailable' && failed.diagnostic.stage === 'recurring-items-request' && failed.diagnostic.upstreamStatus === 429,
    'a provider failure is reported by stage and status only');
  failRecurring = false;

  console.log('Arguments and scope');
  for (const badInput of [{}, { startDate: '2026-10-01' }, { startDate: '2026-11-30', endDate: '2026-10-01' },
    { startDate: '2025-01-01', endDate: '2026-11-30' }, { ...input, includeSuggested: true }]) {
    ok((await service.invoke('recurring', badInput, auth)).reason === 'invalid-arguments', 'rejects ' + JSON.stringify(badInput));
  }
  ok((await service.invoke('recurring', input, { principal: 'owner', scopes: [WRITE_SCOPE] })).reason === 'transaction-read-scope-required',
    'the read scope is required');

  console.log('MCP tool');
  ok(Mcp && typeof Mcp === 'object', 'positive control: the MCP module loads');
  const mcpSource = require('fs').readFileSync(require('path').join(__dirname, '../scripts/assistant-mcp.js'), 'utf8');
  ok(/\['get_lunchmoney_recurring_items', 'recurring', /.test(mcpSource), 'get_lunchmoney_recurring_items is registered on the recurring operation');

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll recurring-items read checks passed.');
})().catch(error => { console.error(error); process.exit(1); });
