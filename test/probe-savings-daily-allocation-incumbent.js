'use strict';
// Positive bounded probes of existing authority; independent invented inputs only.
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../public/forecast');
const LmGroups = require('./lm-groups-fixture.js');
const Contract = require('./fixtures/savings-daily-allocation-contract');
const lmGrouped = input => { input.plan = LmGroups.groupPlan(input.plan);
  if (input.opts && input.opts.currentPeriodActuals) input.opts.currentPeriodActuals = LmGroups.groupPacket(input.opts.currentPeriodActuals, input.plan);
  return input; };
const { transfer, clone } = Contract;
const fixture = (...a) => lmGrouped(Contract.fixture(...a));
const monthBoundaryFixture = (...a) => lmGrouped(Contract.monthBoundaryFixture(...a));
test('native Budget selectors publish 200 income once, 40 bills, 80 budget and 80 surplus', () => {
  const input = fixture(), before = JSON.stringify(input);
  const p = F.recommend(input.plan, input.asOf, input.opts).payPeriodViews.find(p => p.timelineRole === 'current');
  assert.equal(p.incomeTotal, 200); assert.equal(p.totalBillsThisPeriod, 40);
  assert.equal(p.budgetHold, 80); assert.equal(p.balanceAfterDeductions, 80);
  assert.equal(p.opening, 20); assert.equal(p.liveCurrentBalance, 200);
  assert.equal(p.householdBudget[0].spent, 20); assert.equal(p.householdBudget[0].remaining, 60);
  assert.equal(JSON.stringify(input), before);
});
test('current observations are verified but empty history does not prove confirmed assignments', () => {
  const input = fixture(), out = F.savingsInventory(input.plan, input.asOf);
  assert.deepEqual(out.pools.map(p => p.observedCash), [95, 24]);
  assert.ok(out.pools.every(p => p.observedTrust === 'verified' && p.intentKnown === false));
  assert.equal(out.goals.length, 0);
  assert.ok(out.pools.flatMap(p => p.plannedGoals).every(g => g.backed === null));
});
test('native pairing supports both reserve identities without making income/consumption', () => {
  for (const destination of ['savings', 'savings-dont-touch']) {
    const input = transfer(fixture(), 7, 'AA101', destination);
    const before = JSON.stringify(input), moves = F.householdInternalMovements(input.plan, input.opts);
    assert.equal(moves.length, 1); assert.equal(moves[0].amount, 7);
    assert.equal(moves[0].sourceAccountId, 'chequing-a'); assert.equal(moves[0].destinationAccountId, destination);
    assert.equal(moves[0].householdIncome, 0); assert.equal(moves[0].householdConsumption, 0);
    assert.equal(moves[0].householdAssetDelta, 0); assert.equal(JSON.stringify(input), before);
  }
});
test('recorded payday opening is usable; removing it cannot reconstruct an earlier date from current cash', () => {
  const input = fixture();
  assert.deepEqual(F.establishPaydaySnapshot(input.plan, '2026-10-02', input.opts),
    { periodStart: '2026-10-02', asOf: '2026-10-02', opening: 20 });
  delete input.plan.opening.paydaySnapshot;
  assert.equal(F.establishPaydaySnapshot(input.plan, '2026-10-02', input.opts), null);
});
test('hypothetical timeline preserves unknown Saved and counts 119 pool stock only once', () => {
  const input = fixture(), before = JSON.stringify(input);
  const out = F.savingsFundingTimeline(input.plan, [], input.asOf, input.opts);
  assert.equal(out.status, 'ready'); assert.equal(out.actualContributions, null);
  assert.ok(out.goals.every(g => g.actualSaved === null));
  assert.equal(Math.round(out.daily[0].combined * 100), 31329); // 200 - 5.71 daily groceries + 119.
  assert.equal(JSON.stringify(input), before);
});
test('additional backing lowers the legacy proposal without new income: residual is not transfer-neutral', () => {
  const fx = require('./fixtures/planned-savings-clarity-data');
  const first = fx('backed-ready'), next = clone(first);
  next.plan.savingsEarmarks.history[0].pools[0].allocations[0].amount += 100;
  next.plan.savingsPoolObservation.accounts[0].value += 100;
  const funding = data => F.recommend(data.plan, data.meta.asOf, {}).payPeriodViews
    .find(p => p.timelineRole === 'current').plannedCostFunding;
  const before = JSON.stringify([first, next]), a = funding(first), b = funding(next);
  assert.equal(a.operatingPeriodSurplus, 500); assert.equal(b.operatingPeriodSurplus, 500);
  assert.equal(a.contribution, 177.96); assert.equal(b.contribution, 77.96);
  assert.equal(a.afterProposedFunding, 322.04); assert.equal(b.afterProposedFunding, 422.04);
  // This is a backing-only probe, not a claim that an observed transfer occurred.
  assert.equal(JSON.stringify([first, next]), before);
});
test('native month-crossing cycle retains uncategorized spending outside the category allowance', () => {
  const input = monthBoundaryFixture(), before = JSON.stringify(input);
  const p = F.recommend(input.plan, input.asOf, input.opts).payPeriodViews.find(p => p.timelineRole === 'current');
  assert.equal(p.start, '2026-10-30'); assert.equal(p.end, '2026-11-12');
  assert.equal(p.incomeTotal, 200); assert.equal(p.periodBillLoad, 40);
  const grocery = p.householdBudget.find(row => row.id === 'groceries');
  const other = p.householdBudget.find(row => row.otherSpending);
  assert.equal(grocery.hold, 80); assert.equal(grocery.spent, 0);
  assert.equal(other.hold, 10); assert.equal(other.spent, 10);
  assert.equal(other.recon[0].includeReason, 'grocery-merchant-missing');
  // Independent physical ledger: received 200, bill 40, grocery allowance 80,
  // unassigned incurred cost 10. The 20 carry is never period income.
  assert.equal(p.balanceAfterDeductions, 70);
  assert.equal(210 - 40 - 80 - 20, 70, 'current cash/remaining-cost method agrees');
  assert.equal(JSON.stringify(input), before);
});
