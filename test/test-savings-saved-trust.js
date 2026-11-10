'use strict';
// Savings audit PR 3: Saved is never tagged "calculated" when an estimated
// requirement sets it.
//
// One Savings pool fills needs in need-date order (Ai = min(Ui, F - earlier
// A)). So an item's Saved depends on its own need and on every need allocated
// before it. If any of those needs is an estimate, Saved is an estimate too.
// Before this fix Saved was tagged "calculated" whenever it was known.
// This change only moves tags toward less trust; it never upgrades one.
//
// Invented household (test/acceptance/harness.js) served through the
// production path; expectations are hand-derived and written as literals.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const H = require('./acceptance/harness.js');
const AS_OF = '2026-10-14';

// Pool 1,000; trip (Nov 20) then gift (Dec 10), each with its own amount and
// confidence.
function publication(commitments, planPatch) {
  H.resetCaptures();
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = commitments;
  w.planPatch = planPatch;
  w.groups = [{ id: 'club', label: 'Invented club', planSpendSummary: true }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data } = H.dataOf(w), o = data.liveOverlay;
  const advice = F.recommend(data.plan, AS_OF, { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals,
    operatingPlan: o.operatingPlan, observedCash: o.observedCash });
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: AS_OF, advice });
  return { advice, pub };
}
function read(trip, gift) {
  const { advice, pub } = publication([
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: trip[0], confidence: trip[1], sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: gift[0], confidence: gift[1], sinkingFund: true }]);
  const row = id => pub.rows.find(r => r.key === 'commitment:' + id);
  // Every lens (today, payday) prints the same Saved; its tag must agree.
  const lens = id => [...new Set((advice.savingsFunding.lenses || []).flatMap(l => l.items || [])
    .filter(i => i.requirementId === id).map(i => i.savedTrust))];
  return { trip: [row('trip').saved, row('trip').savedTrust], gift: [row('gift').saved, row('gift').savedTrust],
    lens: { trip: lens('trip'), gift: lens('gift') } };
}

{
  // Trip 600 estimated, gift 600 confirmed: Saved 600 / 400. The trip's
  // own need is an estimate, and the gift's 400 is 1,000 - 600 (estimated):
  // both Saved figures are estimated.
  const r = read([600, 'estimated'], [600, 'confirmed']);
  assert.deepEqual(r.trip, [600, 'estimated'], 'Saved set by its own estimated need');
  assert.deepEqual(r.gift, [400, 'estimated'], 'Saved set by an earlier estimated need');
  assert.deepEqual(r.lens, { trip: ['estimated'], gift: ['estimated'] }, 'the funding lenses carry the same tag');
  // The dependency is real: changing only the trip estimate moves both.
  const moved = read([700, 'estimated'], [600, 'confirmed']);
  assert.deepEqual([moved.trip[0], moved.gift[0]], [700, 300], 'only the trip estimate changed; both Saved moved');
  assert.deepEqual([moved.trip[1], moved.gift[1]], ['estimated', 'estimated']);
}
{
  // Earlier confirmed, later estimated: the trip's 600 does not depend on
  // the gift, so it stays calculated; the gift's 400 is estimated.
  const r = read([600, 'confirmed'], [600, 'estimated']);
  assert.deepEqual(r.trip, [600, 'calculated'], 'a later estimate never downgrades an earlier share');
  assert.deepEqual(r.gift, [400, 'estimated']);
  assert.deepEqual(r.lens, { trip: ['calculated'], gift: ['estimated'] });
}
{
  // Positive control, never upgraded either way: both confirmed stay calculated.
  const r = read([600, 'confirmed'], [600, 'confirmed']);
  assert.deepEqual([r.trip, r.gift], [[600, 'calculated'], [400, 'calculated']]);
  assert.deepEqual(r.lens, { trip: ['calculated'], gift: ['calculated'] });
}

{
  // A group straddles a separate estimated need. Hand allocation from 1,000:
  // early club 200; separate need 300; late club 500 of 600. Group Saved is
  // 700, not 800. Only the first share is independent of the estimate.
  const { advice, pub } = publication([
    { id: 'late', label: 'Invented late', group: 'club', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
    { id: 'middle', label: 'Invented middle', date: '2026-11-30', amount: 300, confidence: 'estimated', sinkingFund: true },
    { id: 'early', label: 'Invented early', group: 'club', date: '2026-11-20', amount: 200, confidence: 'confirmed', sinkingFund: true },
  ], plan => { plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'group', id: 'club' }, { kind: 'commitment', id: 'middle' }]; });
  assert.deepEqual(advice.savingsFunding.backing.items.map(i => [i.id, i.saved, i.savedTrust ?? 'calculated']),
    [['early', 200, 'calculated'], ['middle', 300, 'estimated'], ['late', 500, 'estimated']],
    'causal order is need date, not declaration order or grouping');
  const group = pub.rows.find(r => r.key === 'group:club');
  assert.deepEqual([group.saved, group.savedTrust, group.needed], [700, 'estimated', 800],
    'group Saved includes the weaker interleaved dependency');

  // Exercise both production member printers even where Chromium is unavailable.
  // The standalone browser companion covers the real page boot separately.
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
    if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', script + '.js'), 'utf8'), ctx);
  }
  ctx.member = { item: advice.savingsFunding.backing.items.find(i => i.id === 'late'), thisPeriod: 0 };
  const shown = vm.runInContext('budgetSavingsMemberFigures(member,"calculated").saved', ctx);
  assert.match(shown, /estimated[^]*\$500\.00/, 'Budget member keeps the causal Saved estimate');
  assert.doesNotMatch(shown, /calculated/, 'Budget member does not promote Saved');
  ctx.funding = advice.savingsFunding; ctx.advice = advice;
  const inventory = vm.runInContext('SavingsInventory.html(funding,{asOf:"2026-10-14",advice})', ctx);
  assert.match(inventory, /Invented late[^]*?Currently backed<\/dt><dd>\$500\.00 <small>estimated<\/small>/,
    'unchanged current-main inventory member honors the Saved-specific estimate');
  for (const trust of ['calculated', 'estimated', 'unknown']) for (const savedTrust of [undefined, 'estimated']) {
    ctx.member = { item: { saved: 500, needed: 600, trust, ...(savedTrust ? { savedTrust } : {}) }, thisPeriod: 0 };
    const result = vm.runInContext('budgetSavingsMemberFigures(member,"calculated").saved', ctx);
    const expected = trust === 'unknown' ? 'budget-v3-unknown' : savedTrust || trust;
    assert.ok(result.includes(expected), 'member preserves weaker need/Saved trust: ' + trust + '/' + savedTrust);
    assert.ok(vm.runInContext('budgetSavingsMemberFigures(member,"calculated",true).saved', ctx).includes('budget-v3-unknown'),
      'historical member remains withheld');
  }
}
for (const confidence of ['confirmed', 'estimated', 'unknown']) {
  // Missing point amount cannot become a known zero or an estimated Saved.
  const { advice, pub } = publication([
    { id: 'trip', label: 'Invented unknown trip', date: '2026-11-20', amount: null, confidence, sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true },
  ]);
  assert.ok(pub.rows.length >= 2, 'unknown control reaches published goal rows');
  for (const row of pub.rows) assert.deepEqual([row.saved, row.savedTrust], [null, 'unknown'],
    confidence + ': withheld Saved remains unknown');
  for (const lens of advice.savingsFunding.lenses || []) for (const item of lens.items || [])
    assert.deepEqual([item.saved, item.savedTrust], [null, 'unknown'], 'withheld lens Saved remains unknown');
}
{
  // An owner-paid display row consumes no share and no preceding estimate.
  const { pub } = publication([
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'estimated', sinkingFund: true },
    { id: 'gift', label: 'Invented paid gift', date: '2026-12-10', amount: 600, confidence: 'confirmed', sinkingFund: true, settledOn: '2026-10-12' },
  ]);
  const paid = pub.rows.find(r => r.key === 'commitment:gift');
  assert.deepEqual([paid.paymentStatus, paid.saved, paid.savedTrust, paid.needed], ['paid', 0, 'calculated', 0],
    'paid zero remains calculated despite an earlier estimated allocation');
}
console.log('Saved trust: estimated when its own or any earlier-allocated need is estimated; never upgraded.');
