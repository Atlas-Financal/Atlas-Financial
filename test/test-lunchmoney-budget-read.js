'use strict';
/* "Budget amounts come from Lunch Money budgets" (owner decision, #821,
 * 2026-11-18; lead rulings Q1-Q5 and the 2026-11-18 group-id ruling). The
 * observer reads Lunch Money budgets, GET only. Each plan budget row names its
 * Lunch Money category group by numeric id (an integer, which survives a
 * rename); the id is checked against the observation's own /categories read.
 * The packet keeps, per Atlas row id, either one `budgeted` per Lunch Money
 * budget period:
 *   the group's own budget (level 'group'), else the sum of its categories'
 *   budgets skipping categories with none (level 'children'), else null;
 * or, when the id is missing, archived, or a category rather than a group,
 * an unavailable row with a closed reason. No Lunch Money id leaves.
 * FOUNDATION — NOT COMPLETION: Forecast does not read the block yet (PR B2),
 * so no figure moves.
 *
 * Proved here, on invented data only:
 *   1. the live fetch sends only GETs: one /budgets/settings and one /summary
 *      with occurrences, from 120 days before today to 200 days after;
 *   2. per named row and period, the budgeted value and level are exactly
 *      the hand-derived ones below (group first, then children, then null);
 *      a renamed group still resolves by its id; a missing id, an archived
 *      group and an id that is a category each fail closed for that row only;
 *      an id that is not an integer names nothing;
 *   3. groups the plan does not name, every Lunch Money id, activity, notes
 *      and currency text never reach the packet;
 *   4. the structural sanitizer rejects any other shape;
 *   5. it is absent from the assistant / MCP packet and the figures snapshot;
 *   6. a failed read, or invalid settings, is recorded as unavailable and the
 *      observation still serves; every other packet field is identical with
 *      or without the block;
 *   7. the memory replay copy gives the same block as the live read, for a
 *      catalog naming a group both ways (nested children and a child's
 *      group_id), for a rename and a missing id, and for a malformed summary
 *      (the same budget-summary-invalid reason).
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
// 9300 (child 301, not named by the plan), and an archived group (9700).
const CATEGORIES = [
  { id: 9100, name: 'Invented food group', is_group: true, children: [{ id: 201, name: 'Invented a' }, { id: 202, name: 'Invented b' }] },
  { id: 9200, name: 'Invented fun group', is_group: true, children: [{ id: 203, name: 'Invented c' }] },
  { id: 204, name: 'Invented d', group_id: 9200 },
  { id: 9300, name: 'Invented other group', is_group: true, children: [{ id: 301, name: 'Invented e' }] },
  { id: 9700, name: 'Invented retired group', is_group: true, archived: true, children: [] },
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
//   'extra' names 9400, absent from the catalog    -> group-id-missing
//   'retired' names the archived group 9700        -> group-id-missing
//   'leaf' names 201, a category, not a group      -> group-id-not-group
//   'text' names '9100' as text, 'fixture' a fixture-style id -> nothing
//   9300: not named -> never published (its 999 too)
const SUMMARY = { aligned: false, categories: [
  summaryRow(9100, 500, null, null),
  summaryRow(201, 300, 250, null),
  summaryRow(202, null, 100.75, null),
  summaryRow(203, 40, 40, 45),
  summaryRow(204, null, null, null),
  summaryRow(9300, 999, 999, 999),
  summaryRow(301, 999, 999, 999),
  summaryRow(9700, 777, 777, 777),
] };
const SETTINGS = { budget_period_granularity: 'month', budget_period_quantity: 1, budget_period_anchor_date: '2026-01-01',
  budget_hide_no_activity: false, budget_use_last_day_of_month: false, budget_income_option: 'max',
  budget_rollover_left_to_budget: false };
const EXPECTED = {
  groceries: [[OCT, 500, 'group'], [NOV, 350.75, 'children'], [DEC, null, null]],
  restaurants: [[OCT, 40, 'children'], [NOV, 40, 'children'], [DEC, 45, 'children']],
};
const expectedFor = id => ({ status: 'read',
  periods: EXPECTED[id].map(([[start, end], budgeted, level]) => ({ start, end, budgeted, level })) });
const EXPECTED_ROWS = ['extra', 'fixture', 'groceries', 'leaf', 'restaurants', 'retired', 'text'];

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

// An invented served world whose plan rows name Lunch Money groups by id.
// Any id the shipped plan carries is cleared first.
const IDS = { groceries: 9100, restaurants: 9200, extra: 9400, retired: 9700, leaf: 201,
  text: '9100', fixture: 'fixture-group:x' };
const EXTRA_ROWS = ['extra', 'retired', 'leaf', 'text', 'fixture'];
function serve(budgets, ids = IDS, categories = CATEGORIES) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ id: 610001, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  H.productionOpening(w);
  const data = H.canonicalOf(w, H.planOf(w));
  const rows = data.plan.budget.categories;
  rows.forEach(row => { delete row.lunchMoneyCategoryGroupId; if (ids[row.id] != null) row.lunchMoneyCategoryGroupId = ids[row.id]; });
  for (const id of EXTRA_ROWS) {
    if (ids[id] != null) rows.push({ id, label: 'Invented ' + id, class: 'discretionary', lunchMoneyCategoryGroupId: ids[id] });
  }
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

  console.log('2-3. Per named row and period: the group budget, else the children, else null; ids fail closed');
  const s = serve(fetched.lunchMoneyBudgets);
  const block = s.packet.lunchMoneyBudgets;
  ok(block && block.status === 'read' && block.granularity === 'month' && block.quantity === 1 && block.anchorDate === '2026-01-01',
    'the packet carries the block with the budget period settings', JSON.stringify(block && { ...block, byRow: undefined }));
  ok(block && JSON.stringify(Object.keys(block.byRow)) === JSON.stringify(EXPECTED_ROWS),
    'exactly the rows that name a group, keyed by Atlas row id',
    JSON.stringify(block && Object.keys(block.byRow)));
  for (const id of ['groceries', 'restaurants']) {
    ok(block && JSON.stringify(block.byRow[id]) === JSON.stringify(expectedFor(id)),
      `${id} as derived by hand`, JSON.stringify(block && block.byRow[id]));
  }
  ok(block && JSON.stringify(block.byRow.extra) === JSON.stringify({ status: 'unavailable', reason: 'group-id-missing' }),
    'an id the catalog does not carry fails closed (group-id-missing)', JSON.stringify(block && block.byRow.extra));
  ok(block && JSON.stringify(block.byRow.retired) === JSON.stringify({ status: 'unavailable', reason: 'group-id-missing' }),
    'an archived group fails closed (group-id-missing)', JSON.stringify(block && block.byRow.retired));
  ok(block && JSON.stringify(block.byRow.leaf) === JSON.stringify({ status: 'unavailable', reason: 'group-id-not-group' }),
    'an id that is a category, not a group, fails closed (group-id-not-group)', JSON.stringify(block && block.byRow.leaf));
  for (const id of ['text', 'fixture']) {
    ok(block && JSON.stringify(block.byRow[id]) === JSON.stringify({ status: 'unavailable', reason: 'group-id-invalid' }),
      `a row whose id is not a positive integer (${id}) fails closed (group-id-invalid)`, JSON.stringify(block && block.byRow[id]));
  }
  {
    // Lead rulings 2026-11-18: duplicates fail closed, a labelled row waiting
    // for its id names nothing, archived categories leave the children sum,
    // and a failed catalog read has its own reason.
    const plan = rows => ({ budget: { categories: rows } });
    const raw = fetched.lunchMoneyBudgets;
    const by = (rows, cats = CATEGORIES) => O.sanitizedBudgetEvidence(raw, cats, plan(rows)).byRow;
    const shared = by([{ id: 'groceries', lunchMoneyCategoryGroupId: 9100 }, { id: 'restaurants', lunchMoneyCategoryGroupId: 9100 },
      { id: 'travel', lunchMoneyCategoryGroupId: 9200 }]);
    ok(shared.groceries.reason === 'group-id-duplicate' && shared.restaurants.reason === 'group-id-duplicate'
      && shared.travel.status === 'read', 'two rows sharing a group id both fail closed (group-id-duplicate); the third reads',
      JSON.stringify(shared));
    const twice = by([{ id: 'groceries', lunchMoneyCategoryGroupId: 9100 }, { id: 'groceries', lunchMoneyCategoryGroupId: 9200 }]);
    ok(JSON.stringify(twice) === JSON.stringify({ groceries: { status: 'unavailable', reason: 'row-id-duplicate' } }),
      'an Atlas row id used twice fails closed (row-id-duplicate)', JSON.stringify(twice));
    const labelled = by([{ id: 'groceries', lunchMoneyCategoryGroupLabel: 'Invented food group' },
      { id: 'travel', lunchMoneyCategoryGroupLabel: 'Invented fun group', lunchMoneyCategoryGroupId: 'Invented fun group' },
      { id: 'sport', lunchMoneyCategoryGroupId: -5 }, { id: 'tax', lunchMoneyCategoryGroupId: 9100.5 }]);
    ok(!('groceries' in labelled), 'a labelled row with no id yet names nothing (waiting for its id)', JSON.stringify(labelled));
    ok(['travel', 'sport', 'tax'].every(id => labelled[id] && labelled[id].reason === 'group-id-invalid'),
      'a malformed id (text, negative, fractional) fails closed (group-id-invalid)', JSON.stringify(labelled));
    const failedCatalog = by([{ id: 'groceries', lunchMoneyCategoryGroupId: 9100 }], null);
    ok(JSON.stringify(failedCatalog) === JSON.stringify({ groceries: { status: 'unavailable', reason: 'categories-read-failed' } }),
      'a failed categories read fails closed (categories-read-failed)', JSON.stringify(failedCatalog));
    // Child 202 archived: November's children sum is 250 (201) only, not 350.75.
    const archivedChild = CATEGORIES.map(c => c.id === 9100
      ? { ...c, children: [{ id: 201, name: 'Invented a' }, { id: 202, name: 'Invented b', archived: true }] } : c);
    const ac = by([{ id: 'groceries', lunchMoneyCategoryGroupId: 9100 }], archivedChild).groceries.periods[1];
    ok(ac && ac.budgeted === 250 && ac.level === 'children', 'an archived category leaves its group\'s children sum (Nov 250)',
      JSON.stringify(ac));
    // The same through a child's own group_id.
    const archivedLoose = CATEGORIES.map(c => c.id === 204 ? { ...c, archived: true } : c);
    const summary204 = { ...raw, summary: { ...raw.summary, categories: raw.summary.categories.map(r => r.category_id === 204
      ? { ...r, occurrences: r.occurrences.map((o, i) => i === 0 ? { ...o, budgeted: 60 } : o) } : r) } };
    const al = O.sanitizedBudgetEvidence(summary204, archivedLoose, plan([{ id: 'restaurants', lunchMoneyCategoryGroupId: 9200 }]))
      .byRow.restaurants.periods[0];
    ok(al && al.budgeted === 40, 'an archived category named by its own group_id leaves the sum too (Oct 40, not 100)', JSON.stringify(al));
    const sane = O.sanitizedBudgetEvidence(raw, CATEGORIES, plan([{ id: 'groceries', lunchMoneyCategoryGroupId: 9100 },
      { id: 'restaurants', lunchMoneyCategoryGroupId: 9100 }, { id: 'travel', lunchMoneyCategoryGroupId: 'x' }]));
    ok(O.budgetEvidenceLooksSanitized(sane), 'positive control: every new reason passes the structural check');
  }
  {
    // Dale renames the food group in Lunch Money: its id is unchanged, so the
    // row still reads the same budgets.
    const renamed = CATEGORIES.map(c => c.id === 9100 ? { ...c, name: 'Invented food group (renamed)' } : c);
    const r = serve(fetched.lunchMoneyBudgets, IDS, renamed).packet.lunchMoneyBudgets;
    ok(r && JSON.stringify(r.byRow.groceries) === JSON.stringify(expectedFor('groceries')),
      'a renamed group still resolves by its id, with the same budgets', JSON.stringify(r && r.byRow.groceries));
    // The group is removed: only its row fails closed.
    const removed = CATEGORIES.filter(c => c.id !== 9100);
    const g = serve(fetched.lunchMoneyBudgets, IDS, removed).packet.lunchMoneyBudgets;
    ok(g && JSON.stringify(g.byRow.groceries) === JSON.stringify({ status: 'unavailable', reason: 'group-id-missing' })
      && JSON.stringify(g.byRow.restaurants) === JSON.stringify(expectedFor('restaurants')),
      'a removed group fails closed for its row only', JSON.stringify(g && g.byRow.groceries));
  }
  const blob = JSON.stringify(block);
  ok(!blob.includes('9300') && !blob.includes('301') && !blob.includes('999') && !blob.includes('777'),
    'an unnamed or archived group, or a category named as a group, and their budgets never leave');
  ok(!/9100|9200|9400|9700|\b20[1-4]\b|Invented/.test(blob), 'no Lunch Money id or name leaves');
  ok(!blob.includes('12345') && !blob.includes('Invented budget note') && !/cad|budgeted_amount|activity|"available"|notes/.test(blob),
    'no activity, notes, currency text or raw field names');
  ok(O.currentPeriodActualsLooksSanitized(s.packet), 'positive control: the packet passes the sanitizer');
  const none = serve(fetched.lunchMoneyBudgets, {});
  ok(none.packet.lunchMoneyBudgets && JSON.stringify(none.packet.lunchMoneyBudgets.byRow) === '{}',
    'a plan that names no group publishes no row', JSON.stringify(none.packet.lunchMoneyBudgets));

  console.log('4. The structural sanitizer rejects anything else');
  const withBlock = b => ({ ...s.packet, lunchMoneyBudgets: b });
  const period = patch => withBlock({ ...block, byRow: { ...block.byRow,
    groceries: { status: 'read', periods: [{ ...block.byRow.groceries.periods[0], ...patch }] } } });
  const row = entry => withBlock({ ...block, byRow: { ...block.byRow, groceries: entry } });
  ok(!O.currentPeriodActualsLooksSanitized(period({ activity: 5 })), 'an extra period key');
  ok(!O.currentPeriodActualsLooksSanitized(period({ budgeted: '500' })), 'a budget as text');
  ok(!O.currentPeriodActualsLooksSanitized(period({ level: 'category' })), 'an unknown level');
  ok(!O.currentPeriodActualsLooksSanitized(period({ budgeted: null })), 'null budget with a level');
  ok(!O.currentPeriodActualsLooksSanitized(period({ start: 'soon' })), 'a non-date start');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, byRow: { 'Invented group': { status: 'read', periods: [] } } })),
    'a row key that is not an Atlas row id');
  ok(!O.currentPeriodActualsLooksSanitized(withBlock({ ...block, byRow: { 9100: { status: 'read', periods: [] } } })),
    'an all-digit row key (the shape of a Lunch Money id)');
  ok(!O.currentPeriodActualsLooksSanitized(row({ status: 'unavailable', reason: 'Invented free text' })), 'a free-text row reason');
  ok(!O.currentPeriodActualsLooksSanitized(row({ status: 'unavailable', reason: 'group-name-missing', name: 'x' })), 'an extra row key');
  ok(!O.currentPeriodActualsLooksSanitized(row([])), 'a row that is a bare list');
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
    ok(!/lunchMoneyBudgets|byRow|350\.75/.test(a), 'the assistant packet carries no budget block');
    const Snapshot = require('../scripts/figures-snapshot.js');
    let snap = null, snapError = null;
    try { snap = Snapshot.buildFiguresSnapshot(s.data, []); } catch (e) { snapError = e; }
    ok(snap && !snapError, 'positive control: the figures snapshot builds from the same served data', snapError && snapError.message);
    ok(!/lunchMoneyBudgets|byRow|350\.75/.test(JSON.stringify(snap || {})), 'the figures snapshot carries no budget block');
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
      const oct = x => x && x.byRow.restaurants.periods[0];
      ok(oct(a) && oct(a).budgeted === 100 && oct(a).level === 'children',
        'live: restaurants (group 9200) in October is 40 + 60 = 100 from its children', JSON.stringify(oct(a)));
      ok(b && JSON.stringify(b) === JSON.stringify(a), 'replayed: the same block, byte for byte', JSON.stringify(oct(b)));
      ok(b && b.byRow.leaf.reason === 'group-id-not-group' && b.byRow.extra.reason === 'group-id-missing'
        && b.byRow.text.reason === 'group-id-invalid'
        && b.byRow.retired.reason === 'group-id-missing',
        'replayed: the category id, the missing id and the archived group fail closed exactly as live');
      const kept = replayed && JSON.stringify(replayed.lunchMoneyBudgets);
      ok(kept && !kept.includes('12345') && !kept.includes('Invented budget note') && !/budgeted_amount|activity|notes|cad/.test(kept),
        'the replay copy keeps no activity, notes or currency text');
    });
    // A rename, live and replayed.
    const renamed = CATEGORIES.map(c => c.id === 9100 ? { ...c, name: 'Invented food group (renamed)' } : c);
    await withStub(baseRoutes({ '/categories': { body: { categories: renamed } } }), async base => {
      const liveRead = await live(base, '2026-10-14T18:00:00.000Z');
      const replayed = Memory.sourceInputs(liveRead);
      const a = serve(liveRead.lunchMoneyBudgets, undefined, liveRead.categories).packet.lunchMoneyBudgets;
      const b = serve(replayed.lunchMoneyBudgets, undefined, replayed.categories).packet.lunchMoneyBudgets;
      ok(a.byRow.groceries.status === 'read' && JSON.stringify(b) === JSON.stringify(a),
        'a rename: live still reads the group by id, and the replay is byte-identical', JSON.stringify(b && b.byRow.groceries));
    });
    // A malformed summary: live and replay give the same reason (carry (b)).
    await withStub(baseRoutes({ '/summary': { body: { categories: 'not a list' } } }), async base => {
      const liveRead = await live(base, '2026-10-14T18:00:00.000Z');
      const replayed = Memory.sourceInputs(liveRead);
      const a = serve(liveRead.lunchMoneyBudgets, undefined, liveRead.categories).packet.lunchMoneyBudgets;
      const b = serve(replayed.lunchMoneyBudgets, undefined, replayed.categories).packet.lunchMoneyBudgets;
      ok(a.reason === 'budget-summary-invalid' && JSON.stringify(b) === JSON.stringify(a),
        'a malformed summary: live and replay both read budget-summary-invalid', JSON.stringify(b));
    });
    // Invalid settings: live and replay give the same reason.
    await withStub(baseRoutes({ '/budgets/settings': { body: { budget_period_granularity: 'fortnight' } } }), async base => {
      const liveRead = await live(base, '2026-10-14T18:00:00.000Z');
      const replayed = Memory.sourceInputs(liveRead);
      const a = serve(liveRead.lunchMoneyBudgets, undefined, liveRead.categories).packet.lunchMoneyBudgets;
      const b = serve(replayed.lunchMoneyBudgets, undefined, replayed.categories).packet.lunchMoneyBudgets;
      ok(a.reason === 'budget-settings-invalid' && JSON.stringify(b) === JSON.stringify(a),
        'invalid settings: live and replay both read budget-settings-invalid', JSON.stringify(b));
    });
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
