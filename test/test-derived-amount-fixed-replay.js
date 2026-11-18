'use strict';
/* Lead ask (c) on #1355: the derived amountFixed result must replay from observation memory, so that a
 * household with a fixed bill still serves browser reads from memory instead of a full live fetch. Memory keeps
 * only the derivation record (source, status, window, bill ids), never the 200-day history rows.
 *
 * Path: a loopback stand-in for the Lunch Money API -> Live.applyForServer (live fetch, observer, overlay)
 * -> ObservationMemory.sourceInputs evidence -> Live.applyForServer again with that evidence (warm read).
 *
 * Invented world: test/fixtures/budget-surface-data (plan date Aug 20, 2026) plus one invented $100 monthly RESP
 * bill due on the 15th, identified by the shipped RESP rule (TD WATERHOUSE I REP on chequing-a). The 200-day read
 * returns three completed $100 payments (May 15, Jun 15, Jul 15), so by hand the bill derives fixed. The Aug 15
 * occurrence is the current one, so its payment never decides.
 *
 * `node test/test-derived-amount-fixed-replay.js`
 */
const http = require('node:http');
const assert = require('node:assert/strict');
const Fixture = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');
const Memory = require('../scripts/server-observation-memory');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const CLOCK = Fixture.payload().fetchedAt;
const resp = (id, date) => ({ id, account_id: 1001, date, amount: '100.0000', currency: 'cad', payee: 'TD WATERHOUSE I REP',
  original_name: 'TD WATERHOUSE I REP', category_id: null, is_pending: false, status: 'cleared' });
const HISTORY = [resp(93101, '2026-05-15'), resp(93102, '2026-06-15'), resp(93103, '2026-07-15')];

async function stub(payload) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push(url.pathname + (url.searchParams.get('start_date') ? '?' + url.searchParams.get('start_date') : ''));
    if (req.method !== 'GET') throw new Error('write');
    const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    if (p === '/v2/me') return send({ id: 1 });
    if (p === '/v2/plaid_accounts') return send({ plaid_accounts: payload.accounts });
    if (p === '/v2/manual_accounts') return send({ manual_accounts: [] });
    if (p === '/v2/categories') return send({ categories: payload.categories });
    if (p === '/v2/tags') return send({ tags: [] });
    if (p === '/v2/budgets/settings') return send({ budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01' });
    if (p === '/v2/summary') return send({ aligned: false, categories: [] });
    if (p === '/v2/transactions') {
      const isPending = url.searchParams.get('is_pending') === 'true';
      const start = url.searchParams.get('start_date');
      const history = start && start < '2026-05-01';
      const rows = isPending ? payload.transactions.filter(tx => tx.is_pending)
        : history ? HISTORY.concat(payload.transactions.filter(tx => !tx.is_pending)) : payload.transactions;
      return send({ transactions: rows, has_more: false });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, calls, close: () => new Promise(r => server.close(r)) };
}

(async () => {
  const canonical = Fixture.canonical();
  canonical.plan.bills.push({ id: 'resp', label: 'Invented RESP', amount: 100, frequency: 'monthly', day: 15,
    confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true });
  const payload = { ...Fixture.payload(), tags: [] };
  const mock = await stub(payload);
  try {
    const env = { ATLAS_LIVE_OVERLAY: 'live', LUNCHMONEY_ACCESS_TOKEN: 'SYNTHETIC-CREDENTIAL-CANARY',
      ATLAS_LUNCHMONEY_API_BASE: mock.base, ATLAS_LIVE_OVERLAY_NOW: CLOCK,
      ATLAS_PROVIDER_ACCOUNT_MAP_JSON: JSON.stringify({ ...Fixture.map, scope: 'live' }) };
    let observation = null;
    const live = await Live.applyForServer(canonical, env, { onObservation(value) { observation = value; } });
    const fixedLive = (live.plan.bills.find(b => b.id === 'resp') || {}).amountFixed === true;
    ok(fixedLive && mock.calls.some(c => c.startsWith('/v2/transactions?2026-02')), 'live: the 200-day read derives the invented RESP bill fixed',
      JSON.stringify([fixedLive, mock.calls.filter(c => c.startsWith('/v2/transactions'))]));
    ok(observation && observation.qualified === true && observation.evidence && observation.evidence.schema === Memory.SCHEMA,
      'live: the observation qualifies and keeps replay evidence (a fixed bill no longer defeats replay)',
      JSON.stringify(observation && { qualified: observation.qualified, evidence: !!observation.evidence }));
    if (!observation || !observation.evidence) throw new Error('no evidence to replay');
    const kept = observation.evidence.payload;
    ok(!Object.hasOwn(kept, 'amountHistory') && kept.amountFixedDerivation
      && JSON.stringify(Object.keys(kept.amountFixedDerivation).sort()) === JSON.stringify(['billIds', 'obligationIds', 'source', 'status', 'window'])
      && JSON.stringify(kept.amountFixedDerivation.billIds) === JSON.stringify(['resp']),
      'memory keeps only the derivation record (source, status, window, bill and obligation ids), never the history rows',
      JSON.stringify(kept.amountFixedDerivation));
    // The bill sheet's series (Dale, 2026-11-18) keeps each identified payment's date and amount for replay, and
    // nothing else of the row: no payee, no provider id.
    ok(!JSON.stringify(kept).includes('93101') && !JSON.stringify(kept.billPaymentHistory).includes('TD WATERHOUSE'),
      'no history row is retained in memory: the series keeps dates and amounts only');
    const before = mock.calls.length;
    const warm = await Live.applyForServer(canonical, env, { evidence: structuredClone(observation.evidence) });
    ok(mock.calls.length === before, 'warm read replays from memory with 0 provider GETs', String(mock.calls.length - before));
    // The bill sheet's series (Dale, 2026-11-18) replays too: the RESP payments in the six months (Mar to Aug).
    const respSeries = ((live.liveOverlay.billPaymentHistory || {}).bills || []).find(b => b.billId === 'resp');
    ok(respSeries && respSeries.payments.length >= 3 && JSON.stringify(warm.liveOverlay.billPaymentHistory) === JSON.stringify(live.liveOverlay.billPaymentHistory),
      'the bill sheet\'s series replays from memory unchanged', JSON.stringify(respSeries));
    assert.deepStrictEqual(warm, live);
    ok(true, 'the replayed publication equals the live one, fixed flag included');
    // A record in memory is only trusted in its own clean shape: anything else replays as not fixed.
    const forged = structuredClone(observation.evidence);
    forged.payload.amountFixedDerivation = { source: 'lunchmoney-payment-history', status: 'complete', window: null, billIds: ['resp', 42] };
    const bad = await Live.applyForServer(canonical, env, { evidence: forged });
    ok((bad.plan.bills.find(b => b.id === 'resp') || {}).amountFixed !== true, 'a malformed record in memory fixes no bill');
    // A well-formed record naming a bill id the plan does not have fixes nothing beyond the plan's own bills.
    const extra = structuredClone(observation.evidence);
    extra.payload.amountFixedDerivation = { ...extra.payload.amountFixedDerivation, billIds: ['not-a-plan-bill', 'resp'] };
    const widened = await Live.applyForServer(canonical, env, { evidence: extra });
    const fixedIds = widened.plan.bills.filter(b => b.amountFixed === true).map(b => b.id);
    ok(JSON.stringify(fixedIds) === JSON.stringify(['resp']) && !widened.plan.bills.some(b => b.id === 'not-a-plan-bill'),
      'a well-formed record naming an extra bill id fixes only the plan\'s own bills and adds none', JSON.stringify(fixedIds));
  } finally { await mock.close(); }
  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll derived amountFixed replay checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
