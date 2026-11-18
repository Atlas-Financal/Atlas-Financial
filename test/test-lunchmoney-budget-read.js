'use strict';
/* PR A of "budget amounts come from Lunch Money budgets" (owner decision, #821,
 * 2026-11-18; lead rulings Q1-Q5). The observer reads Lunch Money budgets,
 * GET only, and the packet keeps, for each group the plan names, one
 * `budgeted` per Lunch Money budget period:
 *   the group's own budget (level 'group'), else the sum of its categories'
 *   budgets skipping categories with none (level 'children'), else null.
 * FOUNDATION — NOT COMPLETION: Forecast does not read the block yet (PR B),
 * so no figure moves.
 *
 * Proved here, on invented data only:
 *   1. the live fetch sends only GETs: one /budgets/settings and one /summary
 *      with occurrences, from 120 days before today to 200 days after;
 *   2. per named group and period, the budgeted value and level are exactly
 *      the hand-derived ones below (group first, then children, then null);
 *   3. groups the plan does not name, activity, notes and currency text never
 *      reach the packet; a plan id that is not a Lunch Money integer id names
 *      nothing;
 *   4. the structural sanitizer rejects any other shape;
 *   5. it is absent from the assistant / MCP packet and the figures snapshot;
 *   6. a failed read, or invalid settings, is recorded as unavailable and the
 *      observation still serves; every other packet field is identical with
 *      or without the block;
 *   7. the memory replay copy gives the same block as the live read, for a
 *      catalog naming a group both ways (nested children and a child's
 *      group_id).
 *
 * `node test/test-lunchmoney-budget-read.js`
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

// Invented catalog: groups 9100 (children 201, 202), 9200 (children 203, 204),
// 9300 (child 301, not named by the plan).
const CATEGORIES = [
  { id: 9100, name: 'Invented food group', is_group: true, children: [{ id: 201, name: 'Invented a' }, { id: 202, name: 'Invented b' }] },
  { id: 9200, name: 'Invented fun group', is_group: true, children: [{ id: 203, name: 'Invented c' }] },
  { id: 204, name: 'Invented d', group_id: 9200 },
  { id: 9300, name: 'Invented other group', is_group: true, children: [{ id: 301, name: 'Invented e' }] },
  { id: 108, name: 'Payroll', is_income: true },
];
const OCT = ['2026-10-01', '2026-10-31'], NOV = ['2026-11-01', '2026-11-30'], DEC = ['2026-12-01', '2026-12-31'];
const occ = ([start, end], budgeted) => ({ in_range: true, start_date: start, end_date: end,
  other_activity: 12345.67, recurring_activity: 0, budgeted,
  budgeted_amount: budgeted == null ? null : String(budgeted), budgeted_currency: budgeted == null ? null : 'cad',
  notes: 'Invented budget note' });
const summaryRow = (id, oct, nov, dec) => ({ category_id: id,
  totals: { other_activity: 12345.67, recurring_activity: 0, budgeted: null, available: null, recurring_remaining: 0, recurring_expected: 0 },
  occurrences: [occ(OCT, oct), occ(NOV, nov), occ(DEC, dec)] });
// Hand-derived expectations:
//   9100: Oct  group 500                          -> 500    'group'
//         Nov  group null; children 250 + 100.75   -> 350.75 'children'
//         Dec  group null; children null, null     -> null   null
//   9200: no group row; children 203 (40, 40, 45) and 204 (null, null, null)
//         -> 40, 40, 45 'children'
//   9400: named, absent from catalog and summary  -> null, null, null
//   9300: not named -> never published (its 999 too)
const SUMMARY = { aligned: false, categories: [
  summaryRow(9100, 500, null, null),
  summaryRow(201, 300, 250, null),
  summaryRow(202, null, 100.75, null),
  summaryRow(203, 40, 40, 45),
  summaryRow(204, null, null, null),
  summaryRow(9300, 999, 999, 999),
  summaryRow(301, 999, 999, 999),
] };
const SETTINGS = { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01',
  budget_hide_no_activity: false, budget_use_last_day_of_month: false, budget_income_option: 'max',
  budget_rollover_left_to_budget: false };
const EXPECTED = {
  9100: [[OCT, 500, 'group'], [NOV, 350.75, 'children'], [DEC, null, null]],
  9200: [[OCT, 40, 'children'], [NOV, 40, 'children'], [DEC, 45, 'children']],
  9400: [[OCT, null, null], [NOV, null, null], [DEC, null, null]],
};
const expectedFor = id => EXPECTED[id].map(([[start, end], budgeted, level]) => ({ start, end, budgeted, level }));

const baseRoutes = (extra = {}) => ({
  '/me': { body: { account_id: 1 } },
  '/plaid_accounts': { body: { plaid_accounts: [] } },
  '/manual_accounts': { body: { manual_accounts: [] } },
  '/categories': { body: { categories: CATEGORIES } },
  '/tags': { body: { tags: [] } },
  '/transactions': { body: { transactions: [], has_more: false } },
  '/recurring_items': { body: { recurring_items: [] } },
  '/budgets/settings': { body: SETTINGS },
  '/summary': { body: SUMMARY },
  ...extra,
});
const live = (base, now) => O.fetchLunchMoneyLive('invented-token', now, 14,
  { env: { ATLAS_LUNCHMONEY_API_BASE: base } });

// An invented served world whose plan names groups 9100, 9200 and 9400
// (and one fixture-style id that is not a Lunch Money integer id).
function serve(budgets, groupIds = { groceries: 9100, restaurants: 9200, extra: 9400, other: 'fixture-group:x' }, categories = CATEGORIES) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ id: 610001, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const data = H.canonicalOf(w, H.planOf(w));
  const rows = data.plan.budget.categories;
  rows.forEach(row => { if (groupIds[row.id] != null) row.lunchMoneyCategoryGroupId = groupIds[row.id]; });
  rows.push({ id: 'extra', label: 'Invented extra', class: 'discretionary', lunchMoneyCategoryGroupId: groupIds.extra },
    { id: 'other-fixture', label: 'Invented fixture', class: 'discretionary', lunchMoneyCategoryGroupId: groupIds.other });
  const payload = { ...H.rawPayload(w), categories, ...(budgets === undefined ? {} : { lunchMoneyBudgets: budgets }) };
  const result = Live.fromObservation({ data, payload, accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  return { data: result.data, packet: result.data.liveOverlay.currentPeriodActuals };
}

(async () => {
  console.log('1. GET only: one /budgets/settings and one /summary, 120 days back to 200 days ahead, with occurrences');
  let fetched;
  await withStub(baseRoutes(), async (base, seen) => {
    fetched = await live(base, '2026-10-14T18:00:00.000Z');
    ok(seen.length > 0 && seen.every(r => r.method === 'GET'), 'every request the live fetch sends is a GET',
      JSON.stringify(seen.map(r => r.method + ' ' + r.path)));
    const settings = seen.filter(r => r.path === '/v2/budgets/settings');
    const summary = seen.filter(r => r.path === '/v2/summary');
    ok(settings.length === 1 && summary.length === 1, 'exactly one settings read and one summary read',
      settings.length + ' / ' + summary.length);
    // Oct 14 - 120 days = Jun 16; Oct 14 + 200 days = May 2 2027.
    ok(summary[0] && summary[0].query.start_date === '2026-06-16' && summary[0].query.end_date === '2027-05-02'
      && summary[0].query.include_occurrences === 'true',
      'its range is Jun 16 2026 to May 2 2027, with occurrences', JSON.stringify(summary[0] && summary[0].query));
    ok(fetched.lunchMoneyBudgets && fetched.lunchMoneyBudgets.status === 'read', 'the read is recorded');
  });

  console.log('2-3. Per named group and period: the group budget, else the children, else null');
  const s = serve(fetched.lunchMoneyBudgets);
  const block = s.packet.lunchMoneyBudgets;
  ok(block && block.status === 'read' && block.granularity === 'month' && block.quantity === 1 && block.anchorDate === '2026-01-01',
    'the packet carries the block with the budget period settings', JSON.stringify(block && { ...block, byGroup: undefined }));
  ok(block && JSON.stringify(Object.keys(block.byGroup)) === JSON.stringify(['9100', '9200', '9400']),
    'exactly the named Lunch Money groups (the fixture-style id names nothing)', JSON.stringify(block && Object.keys(block.byGroup)));
  for (const id of ['9100', '9200', '9400']) {
    ok(block && JSON.stringify(block.byGroup[id]) === JSON.stringify(expectedFor(id)),
      `group ${id} as derived by hand`, JSON.stringify(block && block.byGroup[id]));
  }
  const blob = JSON.stringify(block);
  ok(!blob.includes('9300') && !blob.includes('301') && !blob.includes('999'), 'an unnamed group and its category never leave');
  ok(!blob.includes('12345') && !blob.includes('Invented budget note') && !/cad|budgeted_amount|activity|available|notes/.test(blob),
    'no activity, notes, currency text or raw field names');
  ok(O.currentPeriodActualsLooksSanitized(s.packet), 'positive control: the packet passes the sanitizer');
  const none = serve(fetched.lunchMoneyBudgets, {});
  ok(none.packet.lunchMoneyBudgets && JSON.stringify(none.packet.lunchMoneyBudgets.byGroup) === '{}',
    'a plan that names no group publishes no group', JSON.stringify(none.packet.lunchMoneyBudgets));

  console.log('4. The structural sanitizer rejects anything else');
  const withBlock = b => ({ ...s.packet, lunchMoneyBudgets: b });
  const period = patch => withBlock({ ...block, byGroup: { ...block.byGroup, 9100: [{ ...block.byGroup['9100'][0], ...patch }] } });
  ok(!O.currentPeriodActualsLooksSanitized(period({ activity: 5 })), 'an extra period key');
  ok(!O.currentPeriodActualsLooksSanitized(period({ budgeted: '500' })), 'a budget as text');
  ok(!O.currentPeriodActualsLooksSanitized(period({ level: 'category' })), 'an unknown level');
  ok(!O.currentPeriodActualsLooksSanitized(period({ budgeted: null })), 'null budget with a level');
  ok(!O.currentPeriodActualsLooksSanitized(period({ start: 'soon' })), 'a non-date start');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, byGroup: { 'Invented group': [] } })), 'a non-numeric group id');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, notes: 'x' })), 'an extra block key');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, granularity: 'fortnight' })), 'an unknown granularity');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ source: 'provider-observe:lunchmoney', status: 'unavailable',
    reason: 'Invented free text' })), 'free text as an unavailable reason');

  console.log('5. Absent from the assistant / MCP packet and the figures snapshot');
  {
    const Assistant = require('../scripts/assistant-packet.js');
    let packet = null, error = null;
    try { packet = Assistant.buildPacket({ data: s.data, periods: [], questionsMarkdown: '' }); } catch (e) { error = e; }
    ok(packet && !error, 'positive control: the assistant packet builds from the same served data', error && error.message);
    const a = JSON.stringify(packet || {});
    ok(!/lunchMoneyBudgets|byGroup|350\.75/.test(a), 'the assistant packet carries no budget block');
    const Snapshot = require('../scripts/figures-snapshot.js');
    let snap = null, snapError = null;
    try { snap = Snapshot.buildFiguresSnapshot(s.data, []); } catch (e) { snapError = e; }
    ok(snap && !snapError, 'positive control: the figures snapshot builds from the same served data', snapError && snapError.message);
    ok(!/lunchMoneyBudgets|byGroup|350\.75/.test(JSON.stringify(snap || {})), 'the figures snapshot carries no budget block');
  }

  console.log('6. A failed read is unavailable and the observation still serves; nothing else moves');
  await withStub(baseRoutes({ '/summary': { status: 500, body: {} } }), async base => {
    const failed = await live(base, '2026-10-14T18:00:00.000Z');
    ok(failed.lunchMoneyBudgets && failed.lunchMoneyBudgets.status === 'unavailable'
      && failed.lunchMoneyBudgets.reason === 'budget-read-failed', 'a 500 on /summary is recorded as unavailable',
      JSON.stringify(failed.lunchMoneyBudgets));
    const f = serve(failed.lunchMoneyBudgets);
    ok(f.packet.lunchMoneyBudgets && f.packet.lunchMoneyBudgets.status === 'unavailable', 'the packet records it as unavailable');
    ok(Array.isArray(f.packet.transactions) && f.packet.transactions.length === s.packet.transactions.length,
      'the observation still serves its transactions');
  });
  const bad = serve({ status: 'read', settings: { ...SETTINGS, budget_period_granularity: 'fortnight' }, summary: SUMMARY });
  ok(bad.packet.lunchMoneyBudgets && bad.packet.lunchMoneyBudgets.reason === 'budget-settings-invalid',
    'invalid period settings are recorded as unavailable', JSON.stringify(bad.packet.lunchMoneyBudgets));
  const strip = p => { const out = { ...p }; delete out.lunchMoneyBudgets; return JSON.stringify(out); };
  const without = serve(undefined);
  ok(!('lunchMoneyBudgets' in without.packet), 'with no budget read, the packet has no block');
  ok(strip(s.packet) === strip(without.packet), 'every other packet field is identical with or without the block');

  console.log('7. The memory replay copy gives the same block as the live read');
  {
    // Group 9200 names child 203 by nesting and child 204 by its own group_id.
    // Hand-derived: Oct 40 + 60 = 100 'children' (live and replayed alike).
    const Memory = require('../scripts/server-observation-memory.js');
    const summary = { ...SUMMARY, categories: SUMMARY.categories.map(row => row.category_id === 204 ? summaryRow(204, 60, null, null) : row) };
    await withStub(baseRoutes({ '/summary': { body: summary } }), async base => {
      const liveRead = await live(base, '2026-10-14T18:00:00.000Z');
      let replayed = null, error = null;
      try { replayed = Memory.sourceInputs(liveRead); } catch (e) { error = e; }
      ok(replayed && !error, 'positive control: the live observation is a valid replay input', error && error.message);
      const a = serve(liveRead.lunchMoneyBudgets, undefined, liveRead.categories).packet.lunchMoneyBudgets;
      const b = replayed && serve(replayed.lunchMoneyBudgets, undefined, replayed.categories).packet.lunchMoneyBudgets;
      ok(a && a.byGroup['9200'][0].budgeted === 100 && a.byGroup['9200'][0].level === 'children',
        'live: 9200 in October is 40 + 60 = 100 from its children', JSON.stringify(a && a.byGroup['9200'][0]));
      ok(b && JSON.stringify(b) === JSON.stringify(a), 'replayed: the same block, byte for byte', JSON.stringify(b && b.byGroup['9200'][0]));
      const kept = replayed && JSON.stringify(replayed.lunchMoneyBudgets);
      ok(kept && !kept.includes('12345') && !kept.includes('Invented budget note') && !/budgeted_amount|activity|notes|cad/.test(kept),
        'the replay copy keeps no activity, notes or currency text');
    });
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
