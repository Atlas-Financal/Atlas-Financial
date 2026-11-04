'use strict';
// Real server and page mounts. All accounts, evidence and credentials are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const UI = require('../public/savings-inventory');
const { withServer } = require('./test-savings-evidence-integration');
const { AS_OF, fixture, propertyTaxFixture, clone } = require('./fixtures/savings-earmarks');
const ROOT = path.join(__dirname, '..');
function renderSurfaces(served) {
  const build = script => {
    const inventory = { innerHTML: '' };
    let advice;
    const context = vm.createContext({ console, addEventListener() {}, SavingsInventory: UI,
      document: { addEventListener() {}, querySelectorAll() { return []; },
        getElementById(id) { return id === 'savings-inventory' ? inventory : null; }, documentElement: { dataset: {}, style: {} } },
      window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
      localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' },
      Forecast: { ...F, recommend(plan, date, opts) { advice = F.recommend(plan, date, opts); return advice; } } });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
    vm.runInContext('App.boot = () => {};', context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', script), 'utf8'), context);
    context.served = served;
    if (script === 'plan.js') {
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts });', context);
      // Focused mount only; a separate real browser run covers the full DOM.
      try { vm.runInContext('renderPlan(served, null, null)', context); }
      catch (error) { assert.match(error.message, /null/); }
    } else vm.runInContext('renderPlanSpend(served, null)', context);
    assert.ok(inventory.innerHTML); assert.ok(advice);
    return { html: inventory.innerHTML, advice };
  };
  const budget = build('plan.js'), spend = build('plan-spend.js');
  assert.equal(budget.html, spend.html, 'both actual page mounts print identical inventory');
  assert.deepEqual(budget.advice.savingsInventory, spend.advice.savingsInventory);
  return budget;
}
async function main() {
  await withServer(fixture(), async server => {
    for (const [balance, residual, deficit] of [[301.17, 53.37, 0], [326.21, 78.41, 0], [259.06, 11.26, 0], [200, null, 47.80]]) {
      const input = fixture(); input.payload.accounts.find(a => a.id === 1003).balance = balance;
      server.write(input); const served = await server.get();
      assert.equal(served.liveOverlay.applied, true);
      assert.deepEqual(served.plan.savingsEarmarks, input.data.plan.savingsEarmarks);
      const { advice } = renderSurfaces(served), pool = advice.savingsInventory.pools[0];
      assert.equal(pool.unallocated, residual); assert.equal(pool.deficit, deficit);
      assert.equal(advice.planSpendPaydayFunding.status, 'unavailable');
      assert.ok(!advice.operatingPlanUnavailable);
    }
    for (const mode of ['stale', 'missing', 'no-date', 'currency', 'noncash', 'duplicate-account', 'pending']) {
      const input = fixture(), account = input.payload.accounts.find(a => a.id === 1003);
      if (mode === 'stale') { account.updated_at = '2026-08-19T17:55:00.000Z'; account.balance_last_update = '2026-08-19T17:55:00.000Z'; }
      if (mode === 'missing') input.payload.accounts = input.payload.accounts.filter(a => a.id !== 1003);
      if (mode === 'no-date') delete account.updated_at;
      if (mode === 'currency') account.currency = 'usd';
      if (mode === 'noncash') account.type = 'credit';
      if (mode === 'duplicate-account') input.payload.accounts.push(clone(account));
      if (mode === 'pending') input.payload.transactions.push({ id: 95001, account_id: 1003, date: AS_OF, amount: 2.09, payee: 'Synthetic withdrawal', is_pending: true });
      server.write(input); const served = await server.get(); const { advice } = renderSurfaces(served);
      assert.equal(served.liveOverlay.applied, true, mode + ' reserve leaves valid chequing usable');
      const pool = advice.savingsInventory.pools[0];
      assert.equal(pool.intent, 247.80); assert.equal(pool.unallocated, null);
      assert.ok(pool.allocations.every(a => a.backed === null));
      assert.ok(!advice.operatingPlanUnavailable);
      assert.equal(F.baselineTrajectory(served.plan, served.debts, served.meta.asOf, { weeklyVariable: 0 }).additionalCashRequired.fundedByDesignatedSavings.amount, null);
    }
    const transfer = fixture();
    transfer.payload.accounts.find(a => a.id === 1003).balance = 281.17;
    transfer.payload.accounts.find(a => a.id === 1004).balance = 164.08;
    transfer.payload.transactions.push(
      { id: 95002, account_id: 1003, date: AS_OF, amount: 20, payee: 'AB321 TFR-TO', is_pending: false },
      { id: 95003, account_id: 1004, date: AS_OF, amount: -20, payee: 'AB321 TFR-FR', is_pending: false });
    server.write(transfer); const served = await server.get(); const actuals = served.liveOverlay.currentPeriodActuals;
    assert.ok(O.currentPeriodActualsLooksSanitized(actuals));
    assert.equal(F.householdInternalMovements(served.plan, { currentPeriodActuals: actuals }).filter(m => m.amount === 20).length, 1);
    for (const tx of actuals.transactions.filter(t => t.tfrReference === 'AB321')) assert.equal(F.classifyCurrentPeriodTransaction(tx, served.plan, { currentPeriodActuals: actuals }).kind, 'internal-movement');
    const out = renderSurfaces(served).advice.savingsInventory;
    assert.equal(out.pools[0].unallocated, 33.37); assert.equal(out.pools[1].unallocated, 64.09);
    assert.deepEqual(served.plan.savingsEarmarks, transfer.data.plan.savingsEarmarks);
    const refund = fixture(); refund.payload.accounts.find(a => a.id === 1003).balance = 309.26;
    refund.payload.transactions.push({ id: 95004, account_id: 1003, date: AS_OF, amount: -8.09, payee: 'Synthetic refund', is_pending: false });
    server.write(refund); const refunded = await server.get();
    assert.equal(renderSurfaces(refunded).advice.savingsInventory.pools[0].unallocated, 61.46);
    assert.deepEqual(refunded.plan.savingsEarmarks, refund.data.plan.savingsEarmarks);
    const empty = fixture(); delete empty.data.plan.savingsEarmarks; empty.map.mappings.pop(); empty.payload.accounts.pop();
    server.write(empty); assert.equal(renderSurfaces(await server.get()).advice.savingsInventory.status, 'setup-unknown');
    const propertyTax = propertyTaxFixture(); server.write(propertyTax);
    const taxServed = await server.get(), taxRendered = renderSurfaces(taxServed);
    assert.equal(taxServed.liveOverlay.applied, true);
    assert.deepEqual(taxServed.plan.savingsEarmarks, propertyTax.data.plan.savingsEarmarks);
    assert.deepEqual(taxServed.plan.budget.categories, propertyTax.data.plan.budget.categories);
    const taxGoal = taxRendered.advice.savingsInventory.goals.find(g => g.goalRef.kind === 'budget-reserve');
    assert.equal(taxGoal.target, 487.63); assert.equal(taxGoal.targetTrust, 'estimated');
    assert.equal(taxGoal.intent, 103.27); assert.equal(taxGoal.backed, 103.27);
    assert.equal(taxRendered.advice.savingsInventory.pools[1].unallocated, 29.68);
    assert.match(taxRendered.html, /Synthetic property tax/);
    assert.equal(taxRendered.advice.planSpendPaydayFunding.status, 'unavailable');
    const taxEvents = F.expandEvents(taxServed.plan, AS_OF, '2026-11-18')
      .filter(e => e.id === 'synthetic-property-tax');
    assert.equal(taxEvents.length, 1); assert.equal(taxEvents[0].kind, 'reserve');
    assert.equal(taxEvents[0].amount, -487.63); assert.equal(taxEvents[0].date, '2026-10-21');
    const unknownTax = propertyTaxFixture(); unknownTax.data.plan.savingsEarmarks.history = [];
    server.write(unknownTax);
    const unknownTaxOut = renderSurfaces(await server.get()).advice.savingsInventory;
    assert.equal(unknownTaxOut.pools[1].status, 'intent-unknown');
    assert.equal(unknownTaxOut.pools[1].intent, null); assert.equal(unknownTaxOut.pools[1].unallocated, null);
    assert.deepEqual(unknownTaxOut.goals, []);
    const map = clone(fixture().map); map.scope = 'local'; O.assertLiveMap(map, { data: fixture().data });
    map.mappings.find(row => row.canonical.id === 'synthetic-reserve-b').atlasRole = 'household-cash';
    assert.throws(() => O.assertLiveMap(map, { data: fixture().data }), /unsupported-atlas-role/);
  });
  console.log('PASS savings integration: real authenticated server, GET observation/refresh, independent reserve evidence, pool transfers/refunds, preserved intent and both page mounts');
}
module.exports = { renderSurfaces, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
