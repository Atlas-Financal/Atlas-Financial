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
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const H = require('./acceptance/harness.js');
const AS_OF = '2026-10-14';

// Pool 1,000; trip (Nov 20) then gift (Dec 10), each with its own amount and
// confidence.
function read(trip, gift) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: trip[0], confidence: trip[1], sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: gift[0], confidence: gift[1], sinkingFund: true }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data } = H.dataOf(w), o = data.liveOverlay;
  const advice = F.recommend(data.plan, AS_OF, { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals,
    operatingPlan: o.operatingPlan, observedCash: o.observedCash });
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: AS_OF, advice });
  const row = id => pub.rows.find(r => r.key === 'commitment:' + id);
  return { trip: [row('trip').saved, row('trip').savedTrust], gift: [row('gift').saved, row('gift').savedTrust] };
}

{
  // Trip 600 estimated, gift 600 confirmed: Saved 600 / 400. The trip's
  // own need is an estimate, and the gift's 400 is 1,000 - 600 (estimated):
  // both Saved figures are estimated.
  const r = read([600, 'estimated'], [600, 'confirmed']);
  assert.deepEqual(r.trip, [600, 'estimated'], 'Saved set by its own estimated need');
  assert.deepEqual(r.gift, [400, 'estimated'], 'Saved set by an earlier estimated need');
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
}
{
  // Positive control, never upgraded either way: both confirmed stay calculated.
  const r = read([600, 'confirmed'], [600, 'confirmed']);
  assert.deepEqual([r.trip, r.gift], [[600, 'calculated'], [400, 'calculated']]);
}
console.log('Saved trust: estimated when its own or any earlier-allocated need is estimated; never upgraded.');
