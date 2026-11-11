'use strict';
// The real observer/overlay, Forecast, page scripts and authenticated server.
// Transport, account identities, amounts and credentials are synthetic only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const UI = require('../public/savings-inventory');
const { withServer } = require('./test-savings-evidence-integration');
const { backedFixture } = require('./fixtures/reserve-aware-funding');
function input() {
  const data = backedFixture();
  data.plan.startingCash.breakdown = [{ id: 'chequing-a', value: 1000 }, { id: 'chequing-b', value: 0 }];
  const ids = ['chequing-a', 'chequing-b', 'savings', 'savings-dont-touch'];
  const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
    mappings: ids.map((id, i) => ({ providerAccountId: String(1001 + i),
      canonical: { collection: 'cash', id }, atlasRole: i < 2 ? 'household-cash' : 'household-reserve' })) };
  const day = data.meta.asOf;
  const payload = { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00.000Z',
    transactionWindow: { startDate: day, endDate: day, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
    accounts: [1000, 0, 301.17, 99.99].map((balance, i) => ({ id: 1001 + i, type: 'cash', balance,
      currency: 'cad', balance_as_of: day + 'T17:55:00.000Z' })),
    categories: [{ id: 11, name: 'Income', is_income: true, exclude_from_totals: false }],
    transactions: [{ id: 91001, account_id: 1001, date: day, amount: -1000, currency: 'cad', payee: 'SEASPAN PAYROLL',
      category_id: 11, is_pending: false, status: 'cleared' }],
  };
  return { data, map, payload };
}
function context(script, mounts = {}) {
  const ctx = vm.createContext({ Forecast: F, SavingsInventory: UI, console, addEventListener() {},
    document: { addEventListener() {}, querySelectorAll() { return []; }, getElementById(id) { return mounts[id] || null; },
      documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), ctx);
  vm.runInContext('App.boot = () => {};', ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../public/' + script), 'utf8'), ctx);
  return ctx;
}
function proveServed(served) {
  assert.equal(served.liveOverlay.applied, true);
  const advice = F.recommend(served.plan, served.meta.asOf, { debts: served.debts,
    currentPeriodActuals: served.liveOverlay.currentPeriodActuals,
    observedCash: served.liveOverlay.observedCash, operatingPlan: served.liveOverlay.operatingPlan });
  const current = advice.payPeriodViews.find(p => p.start === '2026-08-14');
  assert.equal(current.fromTodayFunding.status, 'ready');
  assert.equal(current.fromTodayFunding.currentCash, 1000);
  assert.equal(current.fromTodayFunding.contribution, 80.63);
  assert.equal(current.fromTodayFunding.items[0].actualSaved, 169.37);
  assert.equal(current.fromTodayFunding.items[0].remainingGap, 350);
  const budget = context('plan.js');
  Object.assign(budget, { row: current, overlay: served.liveOverlay, alloc: advice.paydayAllocation, plan: served.plan });
  const html = vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', budget);
  assert.match(html, /data-from-today="2026-08-14"/);
  assert.match(html, /Proposed to set aside now<\/span><span>\$80\.63/);
  assert.match(html, /Actual saved: \$169\.37 calculated backing/);
  assert.match(html, /A new proposal dated/);
  assert.doesNotMatch(html, /Backed assignments are included once/);
  assert.doesNotMatch(html, /Additional contributions are withheld/);
  const mounts = Object.fromEntries(['savings-inventory', 'plan-spend-lede', 'plan-spend-list', 'plan-spend-note']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const spend = context('plan-spend.js', mounts); spend.served = served;
  vm.runInContext('renderPlanSpend(served, null)', spend);
  assert.match(mounts['plan-spend-list'].innerHTML, /Already saved for this cost/);
  assert.match(mounts['plan-spend-list'].innerHTML, /\$169\.37/);
  assert.match(mounts['savings-inventory'].innerHTML, /count backed assignments once/);
  return { advice, current, html };
}
function proveProjection() {
  const source = input(), original = JSON.stringify(source);
  const result = Live.fromObservation({ data: source.data, payload: source.payload, accountMap: source.map,
    identity: { scenarios: [], transactionHints: {}, transactionIdentityDecisions: {}, prepaidCommitments: {} } });
  const proof = proveServed(result.data);
  assert.equal(result.writesCanonicalState, false);
  assert.equal(JSON.stringify(source), original);
  return proof;
}
async function main() {
  proveProjection();
  const source = input();
  await withServer(source, async server => {
    const first = await server.get(), proof = proveServed(first);
    assert.deepEqual(proveServed(await server.get()).current, proof.current, 'repeated authenticated GET cannot accumulate assignments or cash');
    assert.deepEqual(first.plan.savingsEarmarks, source.data.plan.savingsEarmarks);
    const unknown = input(); unknown.data.plan.savingsEarmarks.history = [];
    server.write(unknown); const served = await server.get();
    const advice = F.recommend(served.plan, served.meta.asOf, { currentPeriodActuals: served.liveOverlay.currentPeriodActuals });
    assert.equal(advice.planSpendPaydayFunding.status, 'unavailable');
    assert.equal(advice.savingsInventory.pools[0].intent, null);
    assert.equal(advice.savingsInventory.pools[0].unallocated, null);
  });
  console.log('PASS reserve-aware funding: authenticated GET -> observer -> overlay -> Forecast -> Budget From today and actual Plan Spend mounts');
}
module.exports = { input, proveProjection, proveServed };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
