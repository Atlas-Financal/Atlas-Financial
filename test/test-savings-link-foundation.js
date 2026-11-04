'use strict';
// FOUNDATION — NOT COMPLETION. All identities, dates and values are invented.
// This suite blocks attribution/privacy regressions; it grants no activation.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const renderer = require('../public/savings-inventory');
const fx = require('./fixtures/savings-daily-allocation-contract');
const root = path.resolve(__dirname, '..');
const clone = structuredClone;
function fixture() {
  const x = fx.fixture();
  x.plan.savingsEarmarks.allocationPolicy = { order: 'due-date-first-combined-pool',
    effectiveFrom: '2026-10-05', source: 'Invented combined policy' };
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }, { kind: 'commitment', id: 'far' }];
  x.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: '2026-10-02', source: 'Invented anchor confirmation',
    pools: [{ poolId: 'club-pool', allocations: [{ goalRef: { kind: 'commitment', id: 'near' }, amount: 40 }] }] }];
  x.data = { meta: { asOf: x.asOf }, plan: x.plan, debts: [] };
  x.map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture', mappings: [
    { providerAccountId: 'invented-account-a', atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-a' } },
    { providerAccountId: 'invented-account-b', atlasRole: 'household-cash', canonical: { collection: 'cash', id: 'chequing-b' } },
  ], savingsLinks: { version: 3, anchorRevision: 1, links: [link('category'), link('tag')] } };
  x.payload = { fetchedAt: '2026-10-05T12:00:00.000Z', accounts: [],
    transactionWindow: { startDate: '2026-10-02', endDate: x.asOf, complete: true, hasMore: false },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
    categories: [{ id: 'invented-category', name: 'Invented goal category' }],
    transactions: [raw()] };
  return x;
}
function link(kind, id = 'near', occurrenceDate = '2026-10-21') {
  return { [kind === 'category' ? 'categoryId' : 'tagId']: 'invented-' + kind,
    goalRef: { kind: 'commitment', id }, occurrenceDate,
    effectiveFrom: '2026-10-02', effectiveThrough: '2026-10-31' };
}
function raw(extra = {}) {
  return { id: 'invented-provider-tx', account_id: 'invented-account-a', date: '2026-10-03',
    amount: '12.34', currency: 'cad', is_pending: false, category_id: 'invented-category',
    tag_ids: ['invented-tag'], payee: 'Invented merchant', ...extra };
}
function observe(x) {
  return O.observe({ provider: 'lunchmoney', payload: x.payload, accountMap: x.map, data: x.data,
    identity: { rules: [] }, fetchedAt: x.payload.fetchedAt }).currentPeriodActuals;
}
function evidence(x) { return observe(x).savingsLinks; }
function matches(x) { return evidence(x).evidence; }
function withoutLinks(value) {
  if (Array.isArray(value)) return value.map(withoutLinks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'savingsLinks').map(([k,v]) => [k, withoutLinks(v)]));
}
if (require.main === module) {
{
  const x = fixture(), before = JSON.stringify(x), p = observe(x);
  assert(p.savingsLinks, 'test-first: observer must carry canonical savings attribution');
  assert.equal(p.savingsLinks.mode, 'foundation');
  assert.equal(p.savingsLinks.version, 3);
  assert.equal(p.savingsLinks.anchorRevision, 1);
  assert.equal(p.savingsLinks.links.length, 2);
  assert.equal(p.savingsLinks.evidence.length, 1, 'one transaction, one attribution');
  assert.deepEqual(p.savingsLinks.evidence[0], { transactionRef: 'tx-1', date: '2026-10-03',
    linkRefs: ['link-1', 'link-2'], direction: 'charge', state: 'posted', reason: null,
    occurrenceKey: 'near@2026-10-21' });
  assert.equal(JSON.stringify(x), before, 'observation does not edit configuration, anchor or provider payload');
  assert(O.currentPeriodActualsLooksSanitized(p));
  assert.doesNotMatch(JSON.stringify(p.savingsLinks), /invented-(?:category|tag|account|provider|merchant)|categoryId|tagId|amount|payee/i);
  assert.doesNotMatch(JSON.stringify(p.transactions), /categoryId|tagIds|providerTransactionId/);
}
{
  const x = fixture(); x.map.savingsLinks.links[1] = link('tag', 'far', '2026-10-28');
  assert.equal(matches(x)[0].state, 'unresolved');
  assert.equal(matches(x)[0].reason, 'conflicting-links');
  assert.equal(matches(x)[0].occurrenceKey, null);
}
{
  const x = fixture(); x.map.savingsLinks.links[1].occurrenceDate = '2026-10-22';
  assert.equal(matches(x)[0].state, 'unresolved', 'a second occurrence cannot be silently chosen');
}
{
  const x = fixture(); x.map.savingsLinks.links.forEach(row => {
    row.goalRef = { kind: 'yearly-bill', id: 'home-cost' }; row.occurrenceDate = '2026-10-25';
  });
  x.map.savingsLinks.links[1].occurrenceDate = '2027-10-25';
  assert(evidence(x).links.every(row => row.status === 'linked'), 'both native annual occurrences exist');
  assert.equal(matches(x)[0].state, 'unresolved', 'two valid occurrences of one item are still a conflict');
}
{
  const x = fixture(); x.map.savingsLinks.version = 4;
  assert.equal(evidence(x).version, 4, 'the exact acquired mapping version is retained');
  x.plan.savingsEarmarks.history[0].confirmedAt = '2026-10-04';
  // A4a: no creation-date or anchor cutoff; covered history is evidence.
  assert.equal(matches(x)[0].state, 'posted', 'a purchase before the anchor confirmation is still item evidence');
  x.plan.savingsEarmarks.history[0].confirmedAt = '2026-10-06';
  assert.equal(matches(x)[0].state, 'unresolved', 'an anchor confirmed after the observation is not yet confirmed');
}
{
  // A4a: a later anchor does not erase a mapping that names a confirmed one.
  const x = fixture();
  x.plan.savingsEarmarks.history.push({ ...clone(x.plan.savingsEarmarks.history[0]), revision: 2, confirmedAt: '2026-10-04' });
  assert.equal(matches(x)[0].state, 'posted', 'the named confirmed anchor revision still resolves');
}
for (const mutate of [
  x => { x.map.savingsLinks.anchorRevision = 2; },
  x => { x.plan.savingsEarmarks.history.push({ ...clone(x.plan.savingsEarmarks.history[0]), revision: 1, confirmedAt: '2026-10-04' }); },
  x => { x.map.savingsLinks.links.forEach(l => { l.occurrenceDate = '2026-10-22'; }); },
  x => { x.map.savingsLinks.links.forEach(l => { l.goalRef.id = 'missing'; }); },
]) {
  const x = fixture(); mutate(x);
  assert.equal(matches(x)[0].state, 'unresolved', 'stale anchor or native target cannot qualify');
}
for (const extra of [ { is_pending: true }, { is_pending: undefined } ]) {
  const x = fixture(); x.payload.transactions = [raw(extra)];
  assert.equal(matches(x)[0].state, extra.is_pending === true ? 'pending' : 'unresolved');
}
for (const extra of [ { kind: 'transfer' }, { is_income: true }, { amount: '-12.34', is_income: true },
  { amount: '-12.34', kind: 'transfer' }, { amount: '0.00' },
  { exclude_from_totals: true }, { is_group: true }, { currency: 'usd' } ]) {
  const x = fixture(); x.payload.transactions = [raw(extra)];
  assert.equal(matches(x)[0].state, 'unresolved', 'nonconsumption, split parents and currency guards win');
}
{
  const x = fixture(); x.payload.transactions = [raw({ category_id: 'other-category', tag_ids: [],
    category_name: 'Invented goal category', payee: 'Invented near goal tournament' })];
  assert.deepEqual(matches(x), [], 'no category-name, merchant or broad category guessing');
  x.payload.transactions = [raw({ date: '2026-11-01' })];
  assert.deepEqual(matches(x), [], 'effective interval is exact');
  x.payload.transactions = [raw({ date: '2026-10-03T12:00:00Z' })];
  assert.deepEqual(matches(x), [], 'a non-calendar provider date cannot establish attribution');
}
{
  const x = fixture(); x.payload.transactions = [raw({ is_group: true }), raw({ id: 'invented-child', parent_id: 'invented-provider-tx' })];
  const p = matches(x);
  assert.equal(p.filter(e => e.state === 'posted').length, 1, 'split child survives, parent cannot consume');
}
{
  const x = fixture(); x.payload.transactions = [raw({ is_pending: true }), raw()];
  assert.equal(matches(x).length, 1, 'incumbent same-id pending replacement counts once');
  assert.equal(matches(x)[0].state, 'posted');
  x.payload.transactions = [raw({ id: 'invented-pending', is_pending: true }), raw()];
  assert(!matches(x).some(e => e.state === 'posted'), 'unproven different-id replacement remains unresolved');
  x.payload.transactions = [raw({ id: 'invented-pending', is_pending: true,
    plaid_metadata: { transaction_id: 'invented-pending-plaid' } }),
  raw({ plaid_metadata: { transaction_id: 'invented-posted-plaid', pending_transaction_id: 'invented-pending-plaid' } })];
  assert.equal(matches(x).length, 1, 'incumbent directed provider replacement produces one surviving attribution');
  assert.equal(matches(x)[0].state, 'posted');
}
for (const mutate of [
  m => { m.savingsLinks.version = 0; },
  m => { m.savingsLinks.links[0].tagId = 'invented-tag'; },
  m => { m.savingsLinks.links[0].effectiveFrom = '2026-02-30'; },
  m => { m.savingsLinks.links[0].amount = 12; },
]) {
  const x = fixture(); mutate(x.map);
  assert.throws(() => observe(x), /savings-links-invalid/);
}
{
  // Load current-main independently. Comparing the complete old publication
  // catches accidental household exclusion, paid relief or allocation changes.
  const baseSource = execFileSync('git', ['show', 'ce9ab5193d3c173f8a74c969a08f38f3ce4d7af5:public/forecast.js'],
    { cwd: root, encoding: 'utf8', maxBuffer: 4000000 });
  const baseContext = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(baseSource, baseContext);
  const base = baseContext.module.exports;
  const x = fixture(), p = observe(x), noLink = clone(x); delete noLink.map.savingsLinks;
  const plain = observe(noLink);
  assert.deepEqual(withoutLinks(p), plain, 'foundation leaves every existing observer field identical');
  const Module = require('node:module');
  const oldObserver = new Module(path.join(root, 'scripts/provider-observe.base.js'), module);
  oldObserver.filename = path.join(root, 'scripts/provider-observe.base.js');
  oldObserver.paths = Module._nodeModulePaths(path.join(root, 'scripts'));
  oldObserver._compile(execFileSync('git', ['show', 'ce9ab5193d3c173f8a74c969a08f38f3ce4d7af5:scripts/provider-observe.js'],
    { cwd: root, encoding: 'utf8', maxBuffer: 4000000 }), oldObserver.filename);
  const input = { provider: 'lunchmoney', payload: noLink.payload, accountMap: noLink.map,
    data: noLink.data, identity: { rules: [] }, fetchedAt: noLink.payload.fetchedAt };
  assert.deepEqual(JSON.parse(JSON.stringify(O.observe(input))), JSON.parse(JSON.stringify(oldObserver.exports.observe(input))),
    'no-link entire observer report retains the independently loaded pre-change shape');
  const opts = { ...x.opts, currentPeriodActuals: p, debts: [] };
  const a = F.recommend(x.plan, x.asOf, opts);
  const baseline = base.recommend(x.plan, x.asOf, { ...opts, currentPeriodActuals: plain });
  assert.deepEqual(JSON.parse(JSON.stringify(withoutLinks(a))), JSON.parse(JSON.stringify(baseline)),
    'all financial publications identical to independent current-main engine');
  assert.deepEqual(JSON.parse(JSON.stringify(F.recommend(x.plan, x.asOf, { ...opts, currentPeriodActuals: plain }))),
    JSON.parse(JSON.stringify(baseline)), 'no-link publication byte shape unchanged');
  const publication = F.savingsFundingPublication(a.savingsFunding, { asOf: x.asOf, advice: a });
  assert(publication?.rows.some(row => row.savingsLinks), 'real Forecast goal rows must carry foundation evidence');
  const html = renderer.html(publication, { asOf: x.asOf, advice: a });
  assert.match(html, /data-savings-link-evidence/);
  assert.match(html, /Posted evidence/);
  assert.match(html, /Category link/); assert.match(html, /Tag link/);
  assert.match(html, /Foundation/); assert.match(html, /version 3/); assert.match(html, /anchor revision 1/);
  const ctx = vm.createContext({ Forecast: F, SavingsInventory: renderer, console, addEventListener() {},
    document: { getElementById() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const script of ['app', 'bill-detail', 'budget-surface', 'plan']) {
    if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'public', script + '.js'), 'utf8'), ctx);
  }
  ctx.packet = publication;
  assert.match(vm.runInContext('budgetDailySavingsHtml(packet)', ctx), /data-savings-link-evidence/,
    'Budget existing goal detail integrates the evidence, not only the shared helper');
  const transfer = fixture(); transfer.payload.transactions = [raw({ kind: 'transfer' })];
  const transferPacket = observe(transfer);
  const transferView = F.recommend(transfer.plan, transfer.asOf,
    { ...transfer.opts, currentPeriodActuals: transferPacket, debts: [] });
  assert.equal(transferView.savingsFunding.rows.find(row => row.savingsLinks).savingsLinks.evidence[0].reason, 'nonconsumption',
    'the detail must preserve the reason a matched transfer remains unresolved');
  for (const mutate of [
    x => { x.payload.transactions = [raw({ is_pending: true })]; },
    x => { x.map.savingsLinks.links[1] = link('tag', 'far', '2026-10-28'); },
    x => { x.payload.transactions = [raw({ kind: 'transfer' })]; },
    x => { x.map.savingsLinks.anchorRevision = 2; },
  ]) {
    const candidate = fixture(); mutate(candidate);
    const withFoundation = observe(candidate); delete candidate.map.savingsLinks;
    const noFoundation = observe(candidate);
    const options = { ...candidate.opts, debts: [] };
    assert.deepEqual(JSON.parse(JSON.stringify(withoutLinks(F.recommend(candidate.plan, candidate.asOf,
      { ...options, currentPeriodActuals: withFoundation })))),
    JSON.parse(JSON.stringify(base.recommend(candidate.plan, candidate.asOf,
      { ...options, currentPeriodActuals: noFoundation }))), 'pending/conflict/transfer/stale-anchor financial parity');
  }
}
console.log('Savings link foundation: synthetic identity, conflict, privacy, detail and financial-parity proofs passed.');
}
module.exports = { fixture, observe, raw, link };
