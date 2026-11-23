'use strict';
// The live Lunch Money acquisition runs its independent reads in parallel under a small cap (provider-observe
// liveParallelReads). Invented responses from a loopback mock; no credential, household data or figure.
// Proves: the same requests and the same payload as a sequential read; acquire time near the slowest read, not the
// sum; at most LIVE_READ_CONCURRENCY reads in flight; manual_accounts -> /assets fallback order kept; a required read
// failing late fails the whole fetch closed and cancels the rest; an outer abort cancels everything in flight; the
// earliest-listed genuine failure is the one reported.
const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const O = require('../scripts/provider-observe');
const Timing = require('../scripts/refresh-stage-timing');

let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; };
const NOW = '2026-10-14T18:00:00.000Z';
const BODY = {
  '/v2/me': { user_id: 1, account_id: 7 },
  '/v2/plaid_accounts': { plaid_accounts: [{ id: 1001, name: 'Invented chequing', balance: '10.00', currency: 'cad' }] },
  '/v2/manual_accounts': { manual_accounts: [{ id: 3001, name: 'Invented manual', balance: '5.00', currency: 'cad' }] },
  '/v2/assets': { assets: [{ id: 3002, name: 'Invented asset', balance: '6.00', currency: 'cad' }] },
  '/v2/categories': { categories: [{ id: 1, name: 'Invented category' }] },
  '/v2/tags': { tags: [{ id: 2, name: 'invented-tag' }] },
  '/v2/recurring_items': { recurring_items: [] },
  '/v2/budgets/settings': { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01' },
  '/v2/summary': { aligned: false, categories: [] },
};
function txBody(url) {
  const pending = url.searchParams.get('is_pending') === 'true';
  const start = url.searchParams.get('start_date');
  const id = pending ? 9001 : start && start < '2026-06-01' ? 8001 : 7001;
  return { has_more: false, transactions: [{ id, date: '2026-10-10', amount: '1.00', currency: 'cad', payee: 'Invented', is_pending: pending }] };
}

async function mock(opts = {}) {
  const calls = [], open = new Set();
  let inFlight = 0, peak = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const name = url.pathname + (url.pathname === '/v2/transactions' ? (url.searchParams.get('is_pending') === 'true' ? '?pending'
      : url.searchParams.get('start_date') < '2026-06-01' ? '?history' : '?window') : '');
    calls.push({ name, at: performance.now() });
    const counted = name !== '/v2/me';
    if (counted) { inFlight++; peak = Math.max(peak, inFlight); }
    open.add(res);
    let finished = false;
    const end = () => { if (finished) return; finished = true; if (counted) inFlight--; open.delete(res); };
    res.once('close', end);
    const delay = (opts.delay && opts.delay[name]) || 5;
    setTimeout(() => {
      if (res.destroyed) return end();
      const status = (opts.status && opts.status[name]) || 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? (url.pathname === '/v2/transactions' ? txBody(url) : BODY[url.pathname] || {}) : { error: 'invented' }));
      end();
    }, delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, get peak() { return peak; }, get open() { return open.size; }, base: 'http://127.0.0.1:' + server.address().port + '/v2',
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const fetchLive = (m, extra = {}) => O.fetchLunchMoneyLive('invented-token', NOW, 30,
  { env: { [O.API_BASE_ENV]: m.base }, amountHistory: true, ...extra });
const names = m => m.calls.map(c => c.name).sort();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  console.log('1. The same requests, and the payload carries every read');
  {
    const m = await mock();
    const payload = await fetchLive(m);
    const expected = ['/v2/budgets/settings', '/v2/categories', '/v2/manual_accounts', '/v2/me', '/v2/plaid_accounts',
      '/v2/recurring_items', '/v2/summary', '/v2/tags', '/v2/transactions?history', '/v2/transactions?pending', '/v2/transactions?window'];
    assert.deepEqual(names(m), expected); checks++;
    ok(m.calls[0].name === '/v2/me', '/me is read first, before any other read');
    ok(payload.accounts.map(a => a.id).join() === '1001,3001', 'plaid then manual accounts, as before');
    ok(payload.categories.length === 1 && payload.tags.length === 1, 'categories and tags');
    ok(payload.transactions.map(t => t.id).sort().join() === '7001,9001', 'window and pending merged');
    ok(payload.amountHistory.transactions[0].id === 8001 && payload.recurringItems.status === 'read'
      && payload.lunchMoneyBudgets.status === 'read', 'history, recurring and budget blocks present');
    ok(m.peak <= 4, 'at most four reads in flight: ' + m.peak);
    await m.close();
  }

  console.log('2. manual_accounts 404 still falls back to /assets, after it');
  {
    const m = await mock({ status: { '/v2/manual_accounts': 404 } });
    const payload = await fetchLive(m);
    const order = m.calls.map(c => c.name);
    ok(order.indexOf('/v2/assets') > order.indexOf('/v2/manual_accounts'), 'assets requested after the manual_accounts 404');
    ok(payload.accounts.some(a => a.id === 3002), 'the fallback assets are used');
    await m.close();
  }

  console.log('3. Acquire time is near the slowest read, not the sum');
  {
    const delay = { '/v2/me': 40, '/v2/transactions?window': 400, '/v2/transactions?pending': 150, '/v2/transactions?history': 150,
      '/v2/plaid_accounts': 150, '/v2/manual_accounts': 150, '/v2/categories': 150, '/v2/tags': 150,
      '/v2/recurring_items': 150, '/v2/budgets/settings': 75, '/v2/summary': 75 };
    const sum = Object.values(delay).reduce((a, b) => a + b, 0);
    const m = await mock({ delay });
    let stages;
    const started = performance.now();
    await Timing.run(() => fetchLive(m), s => { stages = s; });
    const took = performance.now() - started;
    ok(took < sum * 0.6, 'parallel acquire ' + Math.round(took) + ' ms, well under the sequential sum ' + sum + ' ms');
    ok(took >= 40 + 400 - 20, 'not faster than /me plus the slowest read');
    ok(stages && stages.providerReads.transactions >= 380 && stages.providerReads.tags >= 140, 'per-read ms reach the stage line');
    await m.close();
  }

  console.log('4. A required read failing late fails the whole fetch closed and cancels the rest');
  {
    const m = await mock({ delay: { '/v2/tags': 200, '/v2/transactions?window': 2000, '/v2/transactions?history': 2000 },
      status: { '/v2/tags': 503 } });
    const started = performance.now();
    await assert.rejects(fetchLive(m), error => /\/v2\/tags failed with HTTP 503/.test(error.message)); checks++;
    ok(performance.now() - started < 1500, 'the failure does not wait for the slow reads');
    await pause(100);
    ok(m.open === 0, 'no request is left open after the failure');
    await m.close();
  }

  console.log('5. The reported failure is the earliest-listed read that genuinely failed, never a cancellation');
  {
    const m = await mock({ delay: { '/v2/categories': 300, '/v2/tags': 20 }, status: { '/v2/categories': 503, '/v2/tags': 503 } });
    await assert.rejects(fetchLive(m), error => /failed with HTTP 503/.test(error.message)); checks++;
    await m.close();
    // A failure aborts the reads still in flight, so a later read's own error may never arrive: the reported
    // failure is the earliest-listed read that genuinely failed. Each order below is deterministic; when both
    // fail together, it is one of the two genuine 503s, never a cancellation.
    for (const [cat, tag, want] of [[10, 80, /\/v2\/categories failed with HTTP 503/], [80, 10, /\/v2\/tags failed with HTTP 503/],
      [20, 20, /\/v2\/(categories|tags) failed with HTTP 503/]]) {
      const m2 = await mock({ delay: { '/v2/categories': cat, '/v2/tags': tag }, status: { '/v2/categories': 503, '/v2/tags': 503 } });
      await assert.rejects(fetchLive(m2), error => want.test(error.message)); checks++;
      await m2.close();
    }
  }

  console.log('6. An outer abort mid-flight cancels every read');
  {
    const m = await mock({ delay: { '/v2/transactions?window': 3000, '/v2/plaid_accounts': 3000, '/v2/categories': 3000, '/v2/tags': 3000 } });
    const controller = new AbortController();
    const work = fetchLive(m, { signal: controller.signal });
    await pause(150);
    const before = m.calls.length;
    controller.abort();
    await assert.rejects(work, error => /cancelled/i.test(error.message)); checks++;
    await pause(150);
    ok(m.open === 0, 'no request is left open after the abort');
    ok(m.calls.length === before, 'no read starts after the abort');
    await m.close();
  }

  console.log('7. A genuine failure is not masked by an outer abort that lands with it');
  {
    // Deterministic: the categories read aborts the outer signal, then fails genuinely. The earlier-listed sibling
    // rejects with the cancellation first; the genuine failure must still be the one reported.
    const outer = new AbortController();
    const cancellable = signal => new Promise((_, reject) => signal.addEventListener('abort',
      () => reject(new Error('Live refresh cancelled.')), { once: true }));
    const tasks = [['tags', cancellable], ['categories', async () => { await pause(5); outer.abort();
      throw new Error('/v2/categories failed with HTTP 503'); }], ['recurring', cancellable]];
    await assert.rejects(O.liveParallelReads(tasks, outer.signal), error => /categories failed with HTTP 503/.test(error.message)); checks++;
    const onlyAbort = new AbortController();
    const quiet = O.liveParallelReads([['tags', cancellable], ['recurring', cancellable]], onlyAbort.signal);
    onlyAbort.abort();
    await assert.rejects(quiet, error => error.message === 'Live refresh cancelled.'); checks++;
  }

  console.log(`provider acquire parallel: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exit(1); });
