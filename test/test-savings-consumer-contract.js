'use strict';
/* G1 reassessment A: the Savings selector consumer contract (Atlas desk
 * ruling 6549108431 §1A and closure evidence 3 and 5; Muse 6549169779,
 * 6549605820). `node test/test-savings-consumer-contract.js`
 *
 * 1. The computed source contract (routes, raw packet reads, route callers,
 *    the pinned consumer closure, reviewed constructs) equals the reviewed
 *    manifest, test/fixtures/savings-consumer-manifest.json.
 * 2. An unmodelled consumer read, a new selector route or raw packet read, a
 *    changed gating helper or a forbidden construct breaks it.
 * 3. Every inventoried path names its capture.
 * 4. Behavioral check, independent of the collector's field lists: each probe
 *    edits the raw publication the same way for the real page code (rendered
 *    in a vm) and for the collector; whenever the rendered page moves, the
 *    collector's compared snapshot must move. That includes replays of the
 *    four recorded omission classes.
 *
 * Invented inputs only. Nothing is written.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Contract = require('./lib/savings-consumer-contract.js');
const F = require('../public/forecast.js');
const Snapshot = require('../scripts/figures-snapshot.js');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/savings-consumer-manifest.json'), 'utf8'));
const SOURCES = Contract.loadSources(ROOT);
const contractOf = sources => Contract.computeContract(sources, MANIFEST.roots);
const CURRENT = contractOf(SOURCES);

test('the computed source contract equals the reviewed manifest', () => {
  assert.equal(MANIFEST.version, 'atlas-savings-consumer-manifest/v1');
  assert.deepEqual(CURRENT.routes, MANIFEST.routes, 'selector routes');
  assert.deepEqual(CURRENT.rawPacketRoutes, MANIFEST.rawPacketRoutes, 'raw periodViews[].packet reads');
  assert.deepEqual(CURRENT.routeCallers, MANIFEST.routeCallers, 'route callers');
  const pins = new Map(MANIFEST.consumers.map(c => [c.id, c.sha256]));
  const unreviewed = CURRENT.consumers.filter(c => pins.get(c.id) !== c.sha256).map(c => c.id);
  const gone = MANIFEST.consumers.filter(c => !CURRENT.consumers.some(x => x.id === c.id)).map(c => c.id);
  assert.deepEqual({ unreviewed, gone }, { unreviewed: [], gone: [] },
    'consumer source changed: review the inventory (6549533135) before updating the manifest');
  assert.deepEqual(CURRENT.consumers.filter(c => c.forbidden).map(c => ({ id: c.id, constructs: c.forbidden })),
    MANIFEST.reviewedConstructs.map(({ id, constructs }) => ({ id, constructs })), 'unsupported constructs');
  assert.deepEqual(CURRENT.unresolvedCalls, MANIFEST.unresolvedCalls, 'unresolved call names');
  // Every route and raw read sits inside a modelled function.
  for (const id of [...CURRENT.routes, ...CURRENT.rawPacketRoutes]) assert.doesNotMatch(id, /outside a modelled function/, id);
});

test('an unmodelled read, a new route, a changed gating helper or a forbidden construct breaks the contract', () => {
  const edit = (file, find, replace) => {
    const sources = { ...SOURCES };
    assert.ok(sources[file].includes(find), 'probe anchor exists: ' + find);
    sources[file] = sources[file].replace(find, replace);
    return contractOf(sources);
  };
  const pinOf = (c, id) => (c.consumers.find(x => x.id === id) || {}).sha256;
  const card = 'public/plan.js#budgetSavingsGoalsHtml#1';
  // An unmodelled read inside the card.
  const read = edit('public/plan.js', 'function budgetSavingsGoalsHtml(ctx, period, schedule) {',
    'function budgetSavingsGoalsHtml(ctx, period, schedule) {\n  void ctx.advice?.savingsFunding?.newField;');
  assert.notEqual(pinOf(read, card), pinOf(CURRENT, card));
  // A gating helper changes (trust gate).
  const gate = edit('public/plan.js', "&& ['calculated', 'estimated'].includes(trust);", "&& ['calculated'].includes(trust);");
  assert.notEqual(pinOf(gate, 'public/plan.js#budgetV3Known#1'), pinOf(CURRENT, 'public/plan.js#budgetV3Known#1'));
  // A new selector route and a new raw packet read, in a new function.
  const route = edit('public/plan.js', 'function budgetDailySavingsFor(ctx, periodId = null) {',
    'function extraSavingsRoute(ctx) { return Forecast.savingsFundingPublication(ctx.advice.savingsFunding, {}); }\nfunction budgetDailySavingsFor(ctx, periodId = null) {');
  assert.ok(route.routes.includes('public/plan.js#extraSavingsRoute#1'));
  const raw = edit('public/plan.js', 'function budgetDailySavingsFor(ctx, periodId = null) {',
    'function extraRawRead(d, id) { return d.periodViews.find(v => v.id === id).packet; }\nfunction budgetDailySavingsFor(ctx, periodId = null) {');
  assert.ok(raw.rawPacketRoutes.includes('public/plan.js#extraRawRead#1'));
  // A route reached from a file the contract does not model is reported, never skipped.
  const stray = { ...SOURCES, 'public/zz-stray.js': 'const x = Forecast.savingsFundingPublication(a, b);\n' };
  assert.ok(contractOf(stray).routes.includes('public/zz-stray.js#<outside a modelled function>'));
  // A forbidden construct in a pinned consumer.
  const evil = edit('public/plan.js', 'function budgetDailySavingsFor(ctx, periodId = null) {',
    'function budgetDailySavingsFor(ctx, periodId = null) {\n  eval("");');
  assert.ok(evil.consumers.find(c => c.id === 'public/plan.js#budgetDailySavingsFor#1').forbidden.includes('eval'));
  // A new helper called from the card joins the closure (and is unpinned).
  const helper = edit('public/plan.js', 'function budgetSavingsGoalsHtml(ctx, period, schedule) {',
    'function zzNewSavingsHelper(row) { return row.secret; }\nfunction budgetSavingsGoalsHtml(ctx, period, schedule) {\n  zzNewSavingsHelper(ctx);');
  assert.ok(helper.consumers.some(c => c.id === 'public/plan.js#zzNewSavingsHelper#1'));
  // The scanner fails closed on source it cannot classify.
  assert.throws(() => Contract.mask('const a = "unterminated'), /scanner/);
});

test('every inventoried path names its capture; external dependencies are named, not claimed', () => {
  assert.ok(MANIFEST.paths.length >= 60);
  for (const p of MANIFEST.paths) {
    assert.ok(['itemized+evidence', 'evidence', 'external'].includes(p.capture), p.path);
    if (p.capture === 'itemized+evidence') assert.ok(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6'].includes(p.section), 'itemized keys stay on S1-S6: ' + p.path);
  }
  for (const s of ['S7', 'S8', 'S9', 'S10']) {
    assert.ok(MANIFEST.paths.some(p => p.section === s), s + ' is inventoried');
    assert.ok(MANIFEST.paths.filter(p => p.section === s).every(p => p.capture === 'evidence'), s + ' is captured by the evidence');
  }
  assert.ok(MANIFEST.external.length >= 10 && MANIFEST.external.every(e => e.dependency && e.collector));
});

// ---- behavioral check: the real page code against the collector -----------------
const inputs = Object.fromEntries(Snapshot.loadInventedInputs().map(i => [i.id, i]));
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
function pageContext(scripts) {
  const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' },
    Event: class { constructor(type) { this.type = type; } } });
  ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const script of scripts) {
    if (script === 'bill-detail' || (script === 'savings-inventory' && !scripts.includes('bill-detail'))) vm.runInContext('App.boot=()=>{};', ctx);
    const file = 'public/' + script + '.js';
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }
  return ctx;
}
const budget = pageContext(['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']);
const spend = pageContext(['app', 'savings-inventory', 'plan-spend']);
function adviceFor(input, edit) {
  const data = JSON.parse(JSON.stringify(input.doc.data));
  const advice = F.recommend(data.plan, data.meta.asOf, Snapshot.pageOptions(data, input.doc.periods));
  if (edit && advice.savingsFunding) edit(advice.savingsFunding, advice);
  return { data, advice };
}
// Every Budget surface for each selectable period and both funding lenses,
// the month view and drilldown, the #savings-inventory mount, and Plan spend.
function renderAll(input, edit) {
  const { data, advice } = adviceFor(input, edit);
  const parts = {};
  for (const ctx of [budget, spend]) {
    ctx.src = { plan: data.plan, debts: data.debts, asOf: data.meta.asOf, advice, liveOverlay: data.liveOverlay || null,
      weekly: advice.weekly, recommended: advice.weekly, weeklyOverride: null, periods: input.doc.periods,
      revolvingExtra: data.revolvingExtra, planLook: 'this-period', planPayPeriodId: null };
  }
  vm.runInContext(`state.targetBuffer=${JSON.stringify(data.plan.defaults.targetBuffer)};state.extraDebtMonthly=0;state.debts=src.debts;budgetGranularity='pay-period';budgetPayPeriodAnchorMonth=null;`, budget);
  for (const view of advice.payPeriodViews || []) {
    budget.src.planPayPeriodId = view.id;
    for (const lens of ['today', 'payday']) {
      parts['surface@' + view.start + '/' + lens] = vm.runInContext(`budgetFundingLens=${JSON.stringify(lens)};budgetSurfaceHtml(src)`, budget);
    }
  }
  budget.src.planPayPeriodId = null;
  parts.month = vm.runInContext("(() => { budgetGranularity='month'; try { return budgetSurfaceHtml(src); } finally { budgetGranularity='pay-period'; } })()", budget);
  parts.drilldown = vm.runInContext(`(() => { budgetPayPeriodAnchorMonth=${JSON.stringify(data.meta.asOf.slice(0, 7))}; try { return budgetSurfaceHtml(src); } finally { budgetPayPeriodAnchorMonth=null; } })()`, budget);
  parts.mount = vm.runInContext('SavingsInventory.html(src.advice.savingsFunding || (src.plan.savingsEarmarks?.allocationPolicy == null ? src.advice.savingsInventory : null), { asOf: src.asOf, advice: src.advice, plan: src.plan })', budget);
  parts.planSpend = vm.runInContext('(() => { const c = { advice: src.advice, plan: src.plan, asOf: src.asOf }; const h = planSpendPageHtml(src.advice, src.liveOverlay, c); return h.lede + h.list + SavingsInventory.html(src.advice.savingsFunding || (src.plan.savingsEarmarks?.allocationPolicy == null ? src.advice.savingsInventory : null), c); })()', spend);
  return parts;
}
function collect(input, edit) {
  const recommend = F.recommend;
  F.recommend = function wrapped(...args) {
    const advice = recommend.apply(this, args);
    if (edit && advice.savingsFunding) edit(advice.savingsFunding, advice);
    return advice;
  };
  try { return JSON.parse(JSON.stringify(Snapshot.buildFiguresSnapshot(JSON.parse(JSON.stringify(input.doc.data)), input.doc.periods))); }
  finally { F.recommend = recommend; }
}
function compare(input, a, b) {
  const pa = renderAll(input, a), pb = renderAll(input, b);
  const pageParts = Object.keys(pb).filter(k => pa[k] !== pb[k]).length;
  const ca = collect(input, a), cb = collect(input, b);
  const moved = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].filter(k => JSON.stringify(ca[k]) !== JSON.stringify(cb[k]));
  return { pageParts, moved };
}
const views = (sf, pred) => sf.periodViews.filter(v => v.packet && pred(v.packet));
const firstProjectedReady = sf => views(sf, p => p.forecastClosing && p.forecastClosing.status === 'ready')[0].packet;
const item = (sf, key) => sf.backing.items.find(i => i.key === key);
function groupClose(sf) {
  const view = sf.periodViews.find(v => v.packet && v.packet.forecastClosing && v.packet.forecastClosing.status === 'ready'
    && v.packet.forecastClosing.items.length === 2 && (v.packet.forecastClosing.allocations || []).length === 2);
  const close = view.packet.forecastClosing;
  const [r0, r1] = close.rows;
  const sum = k => Math.round((r0[k] + r1[k]) * 100) / 100;
  close.rows = [{ ...r0, key: 'group:invented-pair', label: 'Invented pair', members: [...r0.members, ...r1.members],
    forecastSaved: sum('forecastSaved'), forecastContribution: sum('forecastContribution'), needed: sum('needed'),
    stillToFund: sum('stillToFund') }];
  return close;
}
// [id, input, path, description, before edit, after edit, page must move]
const PROBES = [
  ['C1', 'savings-live-partial', 'period.proposal', 'Unsent top-up today (recorded class: funding-sheet lines)', null, sf => { sf.period.proposal += 1; }, true],
  ['C1b', 'savings-live-partial', 'period.entitlement', 'Funding entitlement (recorded class: funding-sheet lines)', null, sf => { sf.period.entitlement += 1; }, true],
  ['C2', 'savings-live-partial', 'rows[].saved', 'a goal row Saved', null, sf => { sf.rows[0].saved += 1; }, true],
  ['P1', 'savings-live-partial', 'backing.items[].neededRange', 'member neededRange absent -> {} (recorded class 4)', sf => { delete item(sf, 'near@2026-10-21').neededRange; }, sf => { item(sf, 'near@2026-10-21').neededRange = {}; }, true],
  ['P1b', 'savings-live-partial', 'rows[].neededRange', 'row neededRange absent -> {} (recorded class 4)', null, sf => { sf.rows[1].neededRange = {}; }, true],
  ['P2', 'savings-live-partial', 'rows[].commitmentCost', 'row commitmentCost absent -> {} (recorded class 4)', sf => { delete sf.rows[1].commitmentCost; }, sf => { sf.rows[1].commitmentCost = {}; }, true],
  ['R3', 'savings-chained-closes', 'rows[].commitmentCost.originalCost.range', 'cost range null -> absent (recorded class 3)',
    sf => { sf.rows.find(r => r.commitmentCost).commitmentCost.originalCost = { status: 'known', amount: 80, range: null }; },
    sf => { sf.rows.find(r => r.commitmentCost).commitmentCost.originalCost = { status: 'known', amount: 80 }; }, true],
  ['R1', 'savings-estimated-close', 'periodViews[].packet.forecastClosing.allocations', 'member redistribution, group totals unchanged (recorded class 1)', null, sf => {
    const close = views(sf, p => p.forecastClosing && p.forecastClosing.status === 'ready' && (p.forecastClosing.allocations || []).length >= 2)[0].packet.forecastClosing;
    const [x, y] = close.allocations;
    if (y.amount >= 0.1) { x.amount += 0.1; y.amount -= 0.1; } else { x.amount -= 0.1; y.amount += 0.1; }
  }, false],
  // Class 1 through the rendered consumer: two single-item rows of a ready
  // projected close are published as one grouped row (a valid packet shape),
  // so the card prints each member's This period from the allocations; the
  // group totals stay fixed while the distribution moves.
  ['R1p', 'savings-estimated-close', 'periodViews[].packet.forecastClosing.rows[].members + allocations', 'member redistribution in a rendered group (recorded class 1)',
    sf => { groupClose(sf); }, sf => { const close = groupClose(sf); const [x, y] = close.allocations; x.amount += 0.1; y.amount -= 0.1; }, true],
  ['P3', 'savings-live-partial', 'rows[].stillToFundReason', 'Still to fund reason text', sf => { Object.assign(sf.rows[0], { stillToFund: null, stillToFundTrust: 'unknown', stillToFundReason: 'Reason one.' }); }, sf => { Object.assign(sf.rows[0], { stillToFund: null, stillToFundTrust: 'unknown', stillToFundReason: 'Reason two.' }); }, true],
  ['P4', 'savings-live-partial', 'stock.reportedStock.amount', 'reported combined savings', null, sf => { sf.stock.reportedStock.amount += 1; }, true],
  ['P5', 'savings-live-partial', 'stock.amount', 'observed stock', sf => { sf.stock.reportedStock.status = 'unavailable'; }, sf => { sf.stock.reportedStock.status = 'unavailable'; sf.stock.amount += 1; }, true],
  ['P6', 'savings-live-partial', 'backing.pools[].observedCash', 'pool cash line', null, sf => { sf.backing.pools[0].observedCash += 1; }, true],
  ['P7', 'savings-live-partial', 'period.availableNow', 'Costs ahead capacity', null, sf => { sf.period.availableNow += 1; }, true],
  ['P8', 'savings-live-partial', 'lenses[].proposal', 'Costs ahead proposal', null, sf => { sf.lenses[0].proposal += 1; }, true],
  ['P9', 'savings-live-partial', 'lenses[].items[].contribution', 'Costs ahead item contribution', null, sf => { sf.lenses[0].items[0].contribution += 1; }, true],
  ['P10', 'savings-live-partial', 'lenses[].items[].cost', 'Costs ahead payday item cost', null, sf => { sf.lenses[1].items[0].cost += 1; }, true],
  ['P11', 'savings-live-partial', 'schedule.paydays[].contribution', 'schedule payday contribution', null, sf => { sf.schedule.paydays[0].contribution += 1; }, true],
  ['P12', 'savings-live-partial', 'schedule.paydays[].protectedAfterPayday', 'schedule protected after payday', null, sf => { sf.schedule.paydays[0].protectedAfterPayday += 1; }, true],
  ['P13', 'savings-live-partial', 'schedule.costs[].stillToFund', 'schedule cost still to fund', null, sf => { sf.schedule.costs[0].stillToFund += 1; }, true],
  ['P14', 'savings-live-partial', 'allocationDescription', 'allocation description text', null, sf => { sf.allocationDescription = 'Invented description.'; }, true],
  ['P15', 'savings-live-partial', 'period.reason', 'period reason text', null, sf => { sf.period.reason = 'Invented period reason.'; }, true],
  ['P16', 'savings-live-partial', 'backing.reason', 'backing reason text', null, sf => { sf.backing.reason = 'Invented backing reason.'; }, true],
  ['P17', 'savings-live-partial', 'goalAllocation.status', 'goal allocation status', null, sf => { sf.goalAllocation.status = 'unavailable'; }, true],
  ['P18', 'savings-estimated-close', 'periodViews[].packet.forecastClosing.assumptions', 'estimate assumptions', null, sf => { for (const v of views(sf, p => p.forecastClosing && p.forecastClosing.assumptions)) v.packet.forecastClosing.assumptions = ['Invented assumption.']; }, true],
  ['P19', 'savings-chained-closes', 'periodViews[].packet (selector-rejected)', 'calendar raw packet read', sf => { firstProjectedReady(sf).currency = 'USD'; }, sf => { const p = firstProjectedReady(sf); p.currency = 'USD'; p.forecastClosing.stock += 1; }, true],
  ['P20', 'savings-chained-closes', 'rows order', 'goal row order', null, sf => { sf.rows.reverse(); }, true],
  ['P21', 'savings-chained-closes', 'lenses order', 'Costs ahead lens order', null, sf => { sf.lenses.reverse(); }, true],
  ['P22', 'savings-chained-closes', 'backing.items[].label', 'member label', null, sf => { item(sf, 'near@2026-10-21').label = 'Invented member'; }, true],
  ['P23', 'savings-chained-closes', 'backing.items[].date', 'member date', null, sf => { item(sf, 'near@2026-10-21').date = '2026-10-22'; }, true],
  ['P24', 'savings-live-partial', 'backing.items[].id', 'annual-fee identity gate', null, sf => { item(sf, 'home-cost@2026-10-25').id = 'travelvisa-annual-fee-2027'; }, true],
  ['P25', 'savings-live-partial', 'backing.items[].savedTrust', 'member savedTrust', null, sf => { item(sf, 'near@2026-10-21').savedTrust = 'unknown'; }, true],
  ['P26', 'savings-live-partial', 'rows[].source', 'row source gate', null, sf => { sf.rows[1].source = 'commitment'; }, true],
  ['P27', 'savings-live-partial', 'rows[].needed', 'rounding boundary 1.005 -> 1.0049', sf => { sf.rows[1].needed = 1.005; }, sf => { sf.rows[1].needed = 1.0049; }, true],
  ['P31', 'savings-live-partial', 'lenses[].reason', 'Costs ahead lens reason', null, sf => { sf.lenses[0].reason = 'Invented lens reason.'; }, true],
  ['P32', 'savings-chained-closes', 'periodViews[].packet', 'a projected view packet dropped', null, sf => { views(sf, p => p.forecastClosing && p.forecastClosing.status === 'ready')[0].packet = null; }, true],
  ['P35', 'savings-chained-closes', 'rows[].members order', 'member order', null, sf => { sf.rows[0].members.reverse(); }, true],
  ['P36', 'savings-chained-closes', 'rows[] duplicate', 'duplicate goal row', null, sf => { sf.rows.push(JSON.parse(JSON.stringify(sf.rows[0]))); }, true],
  ['P40', 'savings-live-partial', 'backing.status', 'backing status', null, sf => { sf.backing.status = 'unavailable'; }, true],
];

test('behavioral check: whenever the rendered page moves, the collector moves (including the four recorded classes)', () => {
  const failures = [], pageStill = [];
  for (const [id, input, where, what, a, b, mustMove] of PROBES) {
    const r = compare(inputs[input], a, b);
    if (mustMove && !r.pageParts) pageStill.push(id + ' ' + where);
    if (r.pageParts && !r.moved.length) failures.push(id + ' ' + where + ': ' + what);
    if (!mustMove && !r.moved.length) failures.push(id + ' ' + where + ': collector unmoved');
  }
  assert.deepEqual(pageStill, [], 'each probe that must move the page does (the probe still reaches the consumer)');
  assert.deepEqual(failures, [], 'page moved but the collector did not');
});
