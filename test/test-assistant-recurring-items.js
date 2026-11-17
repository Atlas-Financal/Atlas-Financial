'use strict';
/* S0 (LEDGER A; Dale 2026-11-17) and its follow-up: the assistant's GET-only,
 * sanitized Lunch Money recurring-items read, now served by the one reviewed
 * reader (scripts/provider-recurring-items.js). Schedule evidence only,
 * reviewed items only, aliases only. No payee, description, notes, amount or
 * category crosses. An absent required key is unavailable; a documented null
 * stays null (Codex P2 on #1278).
 *
 * The recurring endpoint is a loopback stub (the reader's own test seam);
 * the catalog and transactions use the service's injected fetch. Invented
 * provider data only; every expected value is hand-written.
 * `node test/test-assistant-recurring-items.js`
 */
const http = require('node:http');
const { createService, READ_SCOPE, WRITE_SCOPE } = require('../scripts/assistant-lunchmoney');

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
  const meta = { created_by: 55, created_at: '2026-01-02T03:04:05Z', updated_at: '2026-02-03T04:05:06Z' };
  const reviewedMonthly = {
    id: 701, description: 'Invented Utility Co', status: 'reviewed', source: 'manual', ...meta,
    transaction_criteria: { start_date: '2026-01-01', end_date: null, anchor_date: '2026-01-15', payee: 'Invented Utility Co',
      amount: '123.45', to_base: 123.45, currency: 'cad', granularity: 'month', quantity: 1,
      plaid_account_id: 4, manual_account_id: null },
    overrides: { payee: 'INVENTED UTIL 0042', notes: 'Invented note text', category_id: 3 },
    matches: { request_start_date: '2026-10-01', request_end_date: '2026-11-30',
      expected_occurrence_dates: ['2026-11-15', '2026-10-15'],
      found_transactions: [{ date: '2026-10-13', transaction_id: 5001 }],
      missing_transaction_dates: ['2026-11-15'] } };
  const reviewedQuarterlyManual = {
    id: 702, description: 'Invented Insurer', status: 'reviewed', source: 'transaction', ...meta,
    transaction_criteria: { start_date: '2026-03-01', end_date: '2027-02-28', anchor_date: '2026-03-01', payee: 'Invented Insurer',
      amount: '67.80', currency: 'cad', granularity: 'month', quantity: 3, plaid_account_id: null, manual_account_id: 4 },
    overrides: {}, matches: { request_start_date: '2026-10-01', request_end_date: '2026-11-30',
      expected_occurrence_dates: [], found_transactions: [], missing_transaction_dates: [] } };
  const suggested = { id: 703, description: 'Invented Suggestion', status: 'suggested', source: 'system', ...meta,
    transaction_criteria: { anchor_date: '2026-10-01', amount: '88.10', currency: 'cad', granularity: 'week', quantity: 2,
      plaid_account_id: 4, manual_account_id: null, start_date: null, end_date: null, payee: 'Invented Suggestion' },
    overrides: {}, matches: null };
  const criteria = (item, patch) => ({ ...item, transaction_criteria: { ...item.transaction_criteria, ...patch } });
  const without = (obj, key) => { const copy = { ...obj }; delete copy[key]; return copy; };
  const withoutCriterion = (item, key) => ({ ...item, transaction_criteria: without(item.transaction_criteria, key) });

  // Loopback stub for GET /v2/recurring_items.
  let body = { recurring_items: [suggested, reviewedQuarterlyManual, reviewedMonthly] };
  let statusCode = 200;
  const stubCalls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    stubCalls.push({ method: req.method, path: u.pathname, query: u.searchParams, auth: req.headers.authorization });
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(statusCode >= 200 && statusCode < 300 ? JSON.stringify(body) : '{"error":"invented"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v2`;

  const fetchCalls = [];
  const tx = { id: 5001, date: '2026-10-13', amount: '123.45', currency: 'cad', payee: 'Invented Utility Co', notes: null,
    category_id: 3, plaid_account_id: 4, manual_account_id: null, is_pending: false, status: 'reviewed', recurring_id: 701 };
  const service = createService({ now: () => now, env: { ATLAS_LUNCHMONEY_API_BASE: base },
    resolveToken: async () => 'synthetic-test-token',
    fetch: async (url, opts) => {
      const p = new URL(url).pathname.replace('/v2', '');
      fetchCalls.push({ path: p, method: opts.method });
      let data;
      if (p === '/categories') data = { categories: [{ id: 3, name: 'Invented Utilities' }] };
      else if (p === '/plaid_accounts') data = { plaid_accounts: plaid };
      else if (p === '/manual_accounts') data = { manual_accounts: manual };
      else if (p === '/transactions') data = { transactions: [tx], has_more: false };
      else throw new Error('unexpected injected path ' + p);
      return { ok: true, status: 200, json: async () => structuredClone(data) };
    } });
  const auth = { principal: 'owner', scopes: [READ_SCOPE] };
  const input = { startDate: '2026-10-01', endDate: '2026-11-30' };
  const read = async next => { body = Array.isArray(next) ? { recurring_items: next } : next; return service.invoke('recurring', input, auth); };

  try {
    console.log('Served by the one reviewed reader: reviewed items only, schedule evidence only');
    const r = await service.invoke('recurring', input, auth);
    ok(r.status === 'ok' && r.coverage === 'complete-provider-response', 'the read succeeds and is complete', JSON.stringify(r.diagnostic || r.coverage));
    ok(r.itemCount === 2 && r.suggestedExcluded === 1, 'two reviewed items; the suggested one is excluded and counted');
    ok(r.writesAtlasState === false && r.providerWrite === false, 'no Atlas or provider write');
    ok(stubCalls.length === 1 && stubCalls[0].method === 'GET' && stubCalls[0].path === '/v2/recurring_items',
      'exactly one GET, to /recurring_items, through the shared reader', JSON.stringify(stubCalls.map(c => c.path)));
    ok(stubCalls[0].query.get('start_date') === '2026-10-01' && stubCalls[0].query.get('end_date') === '2026-11-30'
      && stubCalls[0].query.get('include_suggested') === 'false', 'it sends the window and explicitly asks for no suggested items');
    ok(stubCalls[0].auth === 'Bearer synthetic-test-token', 'the assistant\'s own resolved credential is used');
    ok(!fetchCalls.some(c => c.path.startsWith('/recurring')) && fetchCalls.every(c => c.method === 'GET'),
      'the assistant service makes no recurring request of its own; its catalog calls are GETs');
    const [monthly, quarterly] = r.items;
    ok(monthly.granularity === 'month' && monthly.quantity === 1 && monthly.anchorDate === '2026-01-15'
      && monthly.startDate === '2026-01-01' && monthly.endDate === null && monthly.status === 'reviewed' && !monthly.unavailableFields,
    'the monthly item: granularity, quantity, anchor, start, and a documented null end with nothing unavailable');
    ok(quarterly.granularity === 'month' && quarterly.quantity === 3 && quarterly.endDate === '2027-02-28',
      'every 3 months is reported as month × 3, never rewritten');
    ok(JSON.stringify(monthly.matches) === JSON.stringify({ windowStart: '2026-10-01', windowEnd: '2026-11-30',
      expectedDates: ['2026-10-15', '2026-11-15'], foundTransactions: [{ date: '2026-10-13', transactionRef: monthly.matches.foundTransactions[0].transactionRef }],
      missingDates: ['2026-11-15'] }), 'expected, found and missing dates as Lunch Money reports them, sorted', JSON.stringify(monthly.matches));
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
    ok(!/"(payee|description|notes|amount|currency|to_base|category|categoryId|categoryRef|overrides|createdBy|created_by|source|id|providerId|plaidAccountId|manualAccountId|transactionId)"\s*:/.test(JSON.stringify(r.items)),
      'no payee, description, notes, amount, currency, category, override, creator, source or raw id key');
    ok(!/\b(701|702|703|5001)\b/.test(blob.replace(/"20\d\d-\d\d-\d\d"/g, '')), 'no raw provider id appears');

    console.log('Absent required key vs documented null (Codex P2 on #1278)');
    const absentStart = await read([withoutCriterion(reviewedMonthly, 'start_date')]);
    ok(absentStart.items[0].startDate === null && JSON.stringify(absentStart.items[0].unavailableFields) === JSON.stringify(['startDate'])
      && absentStart.coverage === 'incomplete-provider-response', 'an ABSENT start_date is unavailable and the read is incomplete',
    JSON.stringify(absentStart.items[0].unavailableFields));
    const absentEnd = await read([withoutCriterion(reviewedMonthly, 'end_date')]);
    ok(absentEnd.items[0].endDate === null && JSON.stringify(absentEnd.items[0].unavailableFields) === JSON.stringify(['endDate'])
      && absentEnd.coverage === 'incomplete-provider-response', 'an ABSENT end_date is unavailable and the read is incomplete');
    const explicitNulls = await read([criteria(reviewedMonthly, { start_date: null, end_date: null })]);
    ok(explicitNulls.items[0].startDate === null && explicitNulls.items[0].endDate === null && !explicitNulls.items[0].unavailableFields
      && explicitNulls.coverage === 'complete-provider-response', 'explicit nulls stay null and the read stays complete');
    const absentAccount = await read([withoutCriterion(reviewedMonthly, 'manual_account_id')]);
    ok(absentAccount.items[0].accountMapping === 'unavailable' && absentAccount.items[0].unavailableFields.includes('account'),
      'an absent account key makes the account unavailable, never a guess');
    const droppedOnly = await read([criteria(without(reviewedMonthly, 'description'), { amount: 'n/a' })]);
    ok(droppedOnly.coverage === 'complete-provider-response' && !droppedOnly.items[0].unavailableFields,
      'a malformed field this read never publishes (description, amount) does not mark it incomplete');

    console.log('Fail closed');
    const paged = await read({ recurring_items: [reviewedMonthly], has_more: true });
    ok(paged.status === 'ok' && paged.coverage === 'incomplete-provider-response', 'a paginated-looking envelope is never called complete');
    const malformed = await read({ items: [reviewedMonthly] });
    ok(malformed.status === 'unavailable' && malformed.diagnostic.code === 'recurring-items-unavailable', 'a malformed envelope fails the whole read');
    const dup = await read([reviewedMonthly, { ...reviewedQuarterlyManual, id: 701 }]);
    ok(dup.status === 'unavailable' && dup.diagnostic.code === 'duplicate-provider-identity', 'a duplicate item id fails the whole read');
    const badId = await read([{ ...reviewedMonthly, id: 'x701' }]);
    ok(badId.status === 'unavailable' && badId.diagnostic.code === 'invalid-provider-identity', 'an invalid item id fails the whole read');
    const noStatus = await read([without(reviewedMonthly, 'status')]);
    ok(noStatus.itemCount === 0 && noStatus.statusUnavailable === 1 && noStatus.coverage === 'incomplete-provider-response',
      'a missing status is never treated as reviewed');
    const bad = await read([criteria(reviewedMonthly, { granularity: 'fortnight', quantity: 0, anchor_date: '2026-02-30' })]);
    ok(bad.items[0].granularity === null && bad.items[0].quantity === null && bad.items[0].anchorDate === null
      && JSON.stringify(bad.items[0].unavailableFields) === JSON.stringify(['granularity', 'quantity', 'anchorDate'])
      && bad.coverage === 'incomplete-provider-response', 'an unknown granularity, zero quantity or impossible date is unavailable, never guessed',
    JSON.stringify(bad.items[0].unavailableFields));
    const badFound = await read([{ ...reviewedMonthly, matches: { ...reviewedMonthly.matches, found_transactions: [{ date: '2026-10-13', transaction_id: 'x' }] } }]);
    ok(badFound.items[0].matches === null && badFound.items[0].unavailableFields.includes('matches'),
      'a malformed found transaction makes the matches unavailable as a whole');
    const nullMatches = await read([{ ...reviewedMonthly, matches: null }]);
    ok(nullMatches.items[0].matches === null && JSON.stringify(nullMatches.items[0].unavailableFields) === JSON.stringify(['matches'])
      && nullMatches.coverage === 'incomplete-provider-response', 'a reviewed item with null matches is unavailable, never complete (Codex P2 on #1280)',
    JSON.stringify(nullMatches.items[0].unavailableFields));
    const otherAccount = await read([criteria(reviewedMonthly, { plaid_account_id: 99 })]);
    ok(otherAccount.items[0].accountMapping === 'unavailable', 'an account not in the catalog maps to unavailable, never a guess');
    body = { recurring_items: [reviewedMonthly] };
    for (const code of [429, 404, 500]) {
      statusCode = code;
      const failed = await service.invoke('recurring', input, auth);
      ok(failed.status === 'unavailable' && failed.diagnostic.stage === 'recurring-items-request'
        && failed.diagnostic.code === 'provider-request-failed' && failed.diagnostic.upstreamStatus === code,
      `HTTP ${code} is reported by stage, code and status only`, JSON.stringify(failed.diagnostic));
    }
    statusCode = 401;
    const rejected = await service.invoke('recurring', input, auth);
    ok(rejected.diagnostic.stage === 'recurring-items-request' && rejected.diagnostic.code === 'provider-request-failed'
      && !JSON.stringify(rejected).includes('synthetic-test-token'), 'a rejected credential is reported without the token');
    statusCode = 200;
    const before = stubCalls.length;
    const noToken = createService({ now: () => now, env: { ATLAS_LUNCHMONEY_API_BASE: base }, resolveToken: async () => null,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ categories: [], plaid_accounts: [], manual_accounts: [] }) }) });
    const missing = await noToken.invoke('recurring', input, auth);
    ok(missing.status === 'unavailable' && stubCalls.length === before, 'no credential: unavailable, and no recurring request is sent',
      JSON.stringify(missing.diagnostic));

    console.log('Arguments and scope');
    for (const badInput of [{}, { startDate: '2026-10-01' }, { startDate: '2026-11-30', endDate: '2026-10-01' },
      { startDate: '2025-01-01', endDate: '2026-11-30' }, { ...input, includeSuggested: true }]) {
      ok((await service.invoke('recurring', badInput, auth)).reason === 'invalid-arguments', 'rejects ' + JSON.stringify(badInput));
    }
    ok((await service.invoke('recurring', input, { principal: 'owner', scopes: [WRITE_SCOPE] })).reason === 'transaction-read-scope-required',
      'the read scope is required');

    console.log('MCP tool');
    const mcpSource = require('fs').readFileSync(require('path').join(__dirname, '../scripts/assistant-mcp.js'), 'utf8');
    ok(/\['get_lunchmoney_recurring_items', 'recurring', /.test(mcpSource), 'get_lunchmoney_recurring_items is registered on the recurring operation');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll recurring-items read checks passed.');
})().catch(error => { console.error(error); process.exit(1); });
