'use strict';
/* S1 (owner decision #821 6956651970; lead dispatch 2026-11-17): the observer
 * reads Lunch Money recurring items once per observation, GET only, and its
 * sanitizer keeps only REVIEWED items whose id a transaction-identity rule
 * names (lunchMoneyRecurringIds), reduced to schedule fields:
 *   {recurringId, granularity, quantity, anchorDate, startDate, endDate,
 *    currency, accountRole, expectedDates[], foundTransactionLocalIds[]}.
 * No payee, description, notes, category or amount leaves. FOUNDATION — NOT
 * COMPLETION: nothing reads the block yet (S2), so no figure moves.
 *
 * Proved here, on invented data only:
 *   1. the live fetch sends only GETs, and the recurring GET is
 *      /recurring_items with the transaction window and include_suggested=false;
 *   2. suggested, unnamed and malformed items are dropped and counted by reason;
 *   3. the kept item carries exactly the schedule fields, with found
 *      transactions as packet-local ids (never provider ids);
 *   4. no payee, description, notes, category or amount text reaches the packet;
 *   5. the structural sanitizer rejects an extra key, free text, or a provider id;
 *   6. it is absent from the assistant / MCP packet and the figures snapshot;
 *   7. a failed recurring read is recorded as unavailable and the observation
 *      still serves; every other packet field is identical with or without it.
 *
 * `node test/test-lunchmoney-recurring-read.js`
 */
const http = require('node:http');
const O = require('../scripts/provider-observe.js');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const NAMED = '7123457';
const SECRET = ['INVENTED BAND ROOM PAYEE', 'Invented band room description', 'Invented override note',
  'Invented override payee', '80.0000'];
const criteria = extra => ({ start_date: '2026-01-01', end_date: null, granularity: 'month', quantity: 1,
  anchor_date: '2026-01-01', payee: SECRET[0], amount: SECRET[4], to_base: 80, currency: 'CAD',
  plaid_account_id: 9001, manual_account_id: null, ...extra });
const item = (id, status, extra = {}) => ({
  id, description: SECRET[1], status,
  transaction_criteria: criteria(extra.criteria),
  overrides: { payee: SECRET[3], notes: SECRET[2], category_id: 104 },
  matches: status === 'suggested' ? null : { request_start_date: '2026-09-01', request_end_date: '2026-10-14',
    expected_occurrence_dates: ['2026-09-01', '2026-10-01'],
    found_transactions: extra.found || [], missing_transaction_dates: [] },
  created_by: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', source: 'manual',
});

// A loopback stand-in for the Lunch Money API that records every request.
async function withStub(routes, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const route = routes[url.pathname.replace(/^\/v2/, '')];
    const out = typeof route === 'function' ? route(url) : route;
    if (!out) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(out.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/v2`, seen); }
  finally { await new Promise(r => server.close(r)); }
}
const baseRoutes = recurring => ({
  '/me': { body: { account_id: 1 } },
  '/plaid_accounts': { body: { plaid_accounts: [] } },
  '/manual_accounts': { body: { manual_accounts: [] } },
  '/categories': { body: { categories: [] } },
  '/tags': { body: { tags: [] } },
  '/transactions': { body: { transactions: [], has_more: false } },
  '/recurring_items': recurring,
});
const live = (base, now) => O.fetchLunchMoneyLive('invented-token', now, 14,
  { env: { ATLAS_LUNCHMONEY_API_BASE: base } });

// An invented world: one monthly band-room bill identified by its recurring link alone.
function world() {
  const w = H.baseWorld();
  w.bills = [{ id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 1, confidence: 'estimated' }];
  w.identityRules = w.identityRules.concat([{ eventId: 'band', lunchMoneyRecurringIds: [NAMED, '7123460'],
    atlasAccountId: 'chequing-a', direction: 'debit' }]);
  w.transactions = [
    H.lm({ id: 610001, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 610002, date: '2026-10-01', amount: 80, account: 'chequing-a', payee: 'Invented e-transfer',
      raw: { recurring_id: Number(NAMED) } }),
    H.lm({ id: 610003, date: '2026-10-10', amount: 60, category: 'Restaurants', payee: 'Invented diner' }),
  ];
  return w;
}
function serve(w, recurringItems) {
  H.productionOpening(w);
  const payload = { ...H.rawPayload(w), ...(recurringItems === undefined ? {} : { recurringItems }) };
  const result = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload,
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  return { data: result.data, packet: result.data.liveOverlay.currentPeriodActuals };
}

(async () => {
  const rawItems = [
    item(Number(NAMED), 'reviewed', { found: [{ date: '2026-10-01', transaction_id: 610002 },
      { date: '2026-09-01', transaction_id: 699999 }] }),
    item(7123458, 'reviewed'),                                         // not named by any rule
    item(7123460, 'suggested'),                                        // named, but only a suggestion
    item(7123461, 'reviewed', { criteria: { granularity: 'fortnight' } }), // malformed, and not named
  ];
  // The fourth item is named too, so its drop is the schedule check, not the name.
  const malformedNamed = item(7123462, 'reviewed', { criteria: { granularity: 'fortnight' } });
  // An invalid start date reads back as null: it must not pass as "no start date".
  const badStartNamed = item(7123463, 'reviewed', { criteria: { start_date: '2026-13-45' } });

  console.log('1. One GET of /recurring_items, from the transaction window start to 31 days past its end, suggestions not requested');
  let fetched;
  await withStub(baseRoutes({ body: { recurring_items: [...rawItems, malformedNamed, badStartNamed] } }), async (base, seen) => {
    fetched = await live(base, '2026-10-14T18:00:00.000Z');
    ok(seen.length > 0 && seen.every(r => r.method === 'GET'), 'every request the live fetch sends is a GET',
      JSON.stringify(seen.map(r => r.method + ' ' + r.path)));
    const rec = seen.filter(r => r.path === '/v2/recurring_items');
    ok(rec.length === 1, 'exactly one recurring read', String(rec.length));
    const tx = seen.find(r => r.path === '/v2/transactions' && r.query.start_date);
    // S3: the same read reaches 31 days past the window's end (Oct 14 + 31 =
    // Nov 14) so Lunch Money can report the next expected occurrence.
    ok(rec[0] && tx && rec[0].query.start_date === tx.query.start_date && tx.query.end_date === '2026-10-14'
      && rec[0].query.end_date === '2026-11-14',
      'its range is the transaction window, ending 31 days later', JSON.stringify(rec[0] && rec[0].query));
    ok(rec[0] && rec[0].query.include_suggested === 'false', 'suggestions are not requested');
    ok(fetched.recurringItems && fetched.recurringItems.status === 'read', 'the read is recorded');
  });

  console.log('2-4. Only reviewed, rule-named items, reduced to schedule fields');
  const w = world();
  const named = { status: 'read', read: { ...fetched.recurringItems.read } };
  // Name the malformed item in the world's rule so the schedule check, not the name, drops it.
  w.identityRules[w.identityRules.length - 1].lunchMoneyRecurringIds.push('7123462', '7123463');
  const s = serve(w, named);
  const block = s.packet.lunchMoneyRecurring;
  ok(block && block.status === 'read', 'the packet carries the block', JSON.stringify(block));
  ok(block && block.items.length === 1, 'exactly one item kept', String(block && block.items.length));
  ok(block && JSON.stringify(block.dropped) === JSON.stringify({ 'not-reviewed': 1, 'not-named': 2, 'schedule-invalid': 2 }),
    'drops counted by reason: 1 suggestion, 2 unnamed, 2 malformed', JSON.stringify(block && block.dropped));
  const kept = block && block.items[0];
  const billRow = s.packet.transactions.find(t => t.amount === 80);
  ok(kept && JSON.stringify(Object.keys(kept)) === JSON.stringify(['recurringId', 'granularity', 'quantity',
    'anchorDate', 'startDate', 'endDate', 'currency', 'accountRole', 'expectedDates', 'foundTransactionLocalIds']),
  'exactly the schedule fields', JSON.stringify(kept && Object.keys(kept)));
  ok(kept && kept.recurringId === NAMED && kept.granularity === 'month' && kept.quantity === 1
    && kept.anchorDate === '2026-01-01' && kept.startDate === '2026-01-01' && kept.endDate === null
    && kept.currency === 'cad' && kept.accountRole === 'household-cash'
    && JSON.stringify(kept.expectedDates) === '["2026-09-01","2026-10-01"]',
  'values as written by hand', JSON.stringify(kept));
  ok(kept && billRow && JSON.stringify(kept.foundTransactionLocalIds) === JSON.stringify([billRow.id]),
    'found transactions are this packet\'s local ids; one outside the packet is left out',
    JSON.stringify(kept && kept.foundTransactionLocalIds) + ' vs ' + (billRow && billRow.id));
  const blob = JSON.stringify(s.packet);
  ok(SECRET.every(text => !blob.includes(text)), 'no payee, description, notes or amount text in the packet');
  ok(!blob.includes('610002') && !blob.includes('699999') && !blob.includes('9001'),
    'no provider transaction or account id in the packet');
  ok(O.currentPeriodActualsLooksSanitized(s.packet), 'positive control: the packet passes the sanitizer');

  console.log('5. The structural sanitizer rejects anything else');
  const withBlock = b => ({ ...s.packet, lunchMoneyRecurring: b });
  const itemWith = patch => withBlock({ ...block, items: [{ ...kept, ...patch }] });
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ payee: 'Invented' })), 'an extra item key (payee)');
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ amount: 80 })), 'an extra item key (amount)');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, description: 'x' })), 'an extra block key');
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ foundTransactionLocalIds: ['610002'] })), 'a provider transaction id');
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ granularity: 'fortnight' })), 'an unknown granularity');
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ anchorDate: 'soon' })), 'a non-date anchor');
  ok(!O.currentPeriodActualsLooksSanitized(itemWith({ currency: 'Invented' })), 'free text as currency');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, dropped: { ...block.dropped, other: 1 } })),
    'an unknown drop reason');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ source: 'provider-observe:lunchmoney', status: 'unavailable',
    reason: 'Invented free text' })), 'free text as an unavailable reason');

  console.log('6. Absent from the assistant / MCP packet and the figures snapshot');
  {
    const Assistant = require('../scripts/assistant-packet.js');
    let packet = null, error = null;
    try { packet = Assistant.buildPacket({ data: s.data, periods: [], questionsMarkdown: '' }); } catch (e) { error = e; }
    ok(packet && !error, 'positive control: the assistant packet builds from the same served data', error && error.message);
    const a = JSON.stringify(packet || {});
    // The one place a recurring id is published is uncertainty.recurringScheduleRefusals.unnamed: the reviewed items no rule
    // names (7123458 reads; 7123461 is malformed, so it is listed unavailable), and never the named item (see test-recurring-unnamed-list).
    const unnamedList = packet && packet.uncertainty && packet.uncertainty.recurringScheduleRefusals
      && packet.uncertainty.recurringScheduleRefusals.unnamed;
    ok(!/lunchMoneyRecurring|foundTransactionLocalIds/.test(a) && !a.includes(NAMED)
      && unnamedList && unnamedList.items.map(i => i.recurringId + ':' + i.status).join(',') === '7123458:read,7123461:unavailable'
      && (a.match(/recurringId/g) || []).length === 2,
      'the assistant packet carries no recurring block; a recurring id appears only in the unnamed list', JSON.stringify(unnamedList));
    const Snapshot = require('../scripts/figures-snapshot.js');
    let snap = null, snapError = null;
    try { snap = Snapshot.buildFiguresSnapshot(s.data, []); } catch (e) { snapError = e; }
    ok(snap && !snapError, 'positive control: the figures snapshot builds from the same served data', snapError && snapError.message);
    const f = JSON.stringify(snap || {});
    ok(!/lunchMoneyRecurring|recurringId|foundTransactionLocalIds/.test(f) && !f.includes(NAMED),
      'the figures snapshot carries no recurring block');
  }

  console.log('7. A failed read is unavailable and the observation still serves; nothing else moves');
  await withStub(baseRoutes({ status: 500, body: {} }), async base => {
    const failed = await live(base, '2026-10-14T18:00:00.000Z');
    ok(failed.recurringItems && failed.recurringItems.status === 'unavailable'
      && failed.recurringItems.reason === 'recurring-read-failed', 'a 500 is recorded as unavailable',
    JSON.stringify(failed.recurringItems));
    ok(Array.isArray(failed.transactions), 'the rest of the fetch is unaffected');
    const u = serve(world(), failed.recurringItems);
    ok(JSON.stringify(u.packet.lunchMoneyRecurring) === JSON.stringify({ source: 'provider-observe:lunchmoney',
      status: 'unavailable', reason: 'recurring-read-failed' }), 'the packet says unavailable, with a fixed reason');
  });
  await withStub(baseRoutes({ body: { recurring_items: rawItems, has_more: true } }), async base => {
    const paged = await live(base, '2026-10-14T18:00:00.000Z');
    const u = serve(world(), paged.recurringItems);
    ok(u.packet.lunchMoneyRecurring && u.packet.lunchMoneyRecurring.status === 'unavailable',
      'a response with paging keys (items may be missing) is unavailable, never a partial list',
      JSON.stringify(u.packet.lunchMoneyRecurring));
  });
  {
    const without = serve(world(), undefined).packet;
    const withIt = serve(world(), named).packet;
    ok(!('lunchMoneyRecurring' in without), 'with no recurring read (fixtures, older payloads) the block is absent');
    const { lunchMoneyRecurring, ...rest } = withIt;
    ok(JSON.stringify(rest) === JSON.stringify(without), 'every other packet field is identical with or without the read');
  }

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nAll Lunch Money recurring read checks passed.');
})().catch(err => { console.error(err); process.exit(1); });
