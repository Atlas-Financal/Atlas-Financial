'use strict';
// Independent invented ledger: 119 saved backs 60 + 24 + 35. The later
// 170 cost therefore needs 135 in new proposals. No live household cents.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/savings-daily-allocation-contract');
const { policy } = require('./fixtures/chronological-savings-data');
const cents = amount => Math.round(amount * 100);
let failed = 0;
function test(name, check) {
  try { check(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
function recommend(change = () => {}) {
  const input = policy(fx.advance(fx.fixture(), '2026-10-07'));
  change(input);
  const before = JSON.stringify(input);
  const advice = F.recommend(input.plan, input.asOf, { ...input.opts, debts: [] });
  assert.equal(JSON.stringify(input), before, 'query preserves input and observations');
  const current = advice.payPeriodViews.find(row => row.timelineRole === 'current');
  const next = advice.payPeriodViews.find(row => row.timelineRole === 'next');
  return { input, advice, current, next };
}
const gaps = packet => Object.fromEntries(packet.items.map(row => [row.id, row.remainingGap]));
const nextForward = current => current.fromTodayFunding.periods.find(row => row.payday === '2026-10-16');
const baseline = recommend();

test('income-only next-period gaps deduct existing backing and this route\'s proposals once', () => {
  const packet = baseline.next.plannedCostFunding;
  assert.equal(packet.status, 'funding-gap');
  assert.equal(packet.contribution, 200 - 40 - 80);
  assert.equal(packet.gap.shortBy, 170 - 35 - 80);
  assert.deepEqual(gaps(packet), { near: 0, 'home-cost': 0, far: 170 - 35 - 80 });
});
test('from-today seed gaps deduct current backing without turning it into actual saved', () => {
  const packet = baseline.current.fromTodayFunding;
  assert.equal(packet.status, 'ready');
  assert.equal(packet.contribution, (60 + 24 + 170 - 119) - (200 - 40 - 80));
  assert.deepEqual(gaps(packet), { near: 0, 'home-cost': 0, far: 170 - 35 - 55 });
});
test('from-today cumulative proposals close the remaining need without restarting paid costs', () => {
  const packet = nextForward(baseline.current);
  assert.equal(packet.contribution, 80);
  assert.equal(packet.items.find(row => row.id === 'far').cumulativeProposed, 55 + 80);
  assert.deepEqual(gaps(packet), { near: 0, 'home-cost': 0, far: 170 - 35 - (55 + 80) });
  for (const row of baseline.current.fromTodayFunding.periods) {
    if (row.payday >= '2026-10-16' && row.items.length) {
      assert.deepEqual(gaps(row), { near: 0, 'home-cost': 0, far: 0 });
    }
  }
});
test('combined backing stays policy-derived, proposals stay projected, future actuals stay null', () => {
  const s = baseline.advice.savingsFunding;
  assert.deepEqual(s.backing.items.map(row => [row.id, row.saved]),
    [['near', 60], ['home-cost', 24], ['far', 35]]);
  assert.ok(s.schedule.costs.every(row => row.actualSaved === null));
  assert.deepEqual(s.schedule.costs.map(row => row.protectedNow), [60, 24, 35]);
  for (const packet of [baseline.next.plannedCostFunding, baseline.current.fromTodayFunding,
    ...baseline.current.fromTodayFunding.periods]) {
    assert.ok(packet.items.every(row => row.actualSaved === null));
  }
  const future = F.savingsFundingPublication(s, { advice: baseline.advice,
    asOf: baseline.input.asOf, periodId: baseline.next.id });
  assert.equal(future.period.actualSaved, null);
  assert.equal(future.stock.amount, null);
  assert.equal(baseline.current.fromTodayFunding.actualSaved, null);
  assert.equal(baseline.current.fromTodayFunding.originalPaydayPlan, null);
});
test('one native payment consumes backing plus proposals, and internal transfers conserve cash', () => {
  const rows = baseline.current.fromTodayFunding.periods;
  const payments = rows.flatMap(row => row.payments || []);
  assert.deepEqual(payments.map(row => [row.id, row.amount, row.reserveFunded, row.protectedConsumed]),
    [['near', 60, 60, 0], ['home-cost', 24, 24, 0], ['far', 170, 35, 135]]);
  assert.equal(payments.reduce((sum, row) => sum + cents(row.reserveFunded), 0), 11900);
  assert.equal(payments.reduce((sum, row) => sum + cents(row.protectedConsumed), 0), 13500);
  const transfers = rows.reduce((sum, row) => sum + cents(row.contribution), 0);
  assert.equal(transfers, 13500);
  const operatingClose = 20000 + 20000 - 8000 - 14000 - transfers;
  const savingsClose = 11900 + transfers - 25400;
  assert.equal(operatingClose, 4500);
  assert.equal(savingsClose, 0);
  assert.equal(operatingClose + savingsClose, 31900 + 20000 - (8000 + 14000 + 25400));
});
test('odd cents conserve observed backing and proposals at both publication sites', () => {
  const r = recommend(input => {
    input.plan.startingCash.breakdown[2].value = input.plan.savingsPoolObservation.accounts[0].value = 95.01;
    input.plan.commitments[1].amount = 170.03;
  });
  const backing = r.advice.savingsFunding.backing;
  assert.equal(backing.items.reduce((sum, row) => sum + cents(row.saved), 0), 11901);
  assert.equal(r.current.fromTodayFunding.contribution, 55.02);
  assert.equal(cents(r.next.plannedCostFunding.items.find(row => row.id === 'far').remainingGap),
    17003 - (11901 - 6000 - 2400) - 8000);
  assert.equal(cents(r.current.fromTodayFunding.items.find(row => row.id === 'far').remainingGap),
    17003 - 3501 - 5502);
  assert.deepEqual(gaps(nextForward(r.current)), { near: 0, 'home-cost': 0, far: 0 });
});
test('excess stock and settled requirements are capped; gaps never go below zero', () => {
  for (const zeroNeed of [false, true]) {
    const r = recommend(input => {
      input.plan.startingCash.breakdown[2].value = input.plan.savingsPoolObservation.accounts[0].value = 500.01;
      if (zeroNeed) input.plan.commitments[1].settledOn = input.asOf;
    });
    const totalNeed = zeroNeed ? 60 + 24 : 60 + 24 + 170;
    const s = r.advice.savingsFunding;
    assert.equal(s.backing.items.reduce((sum, row) => sum + cents(row.saved), 0), cents(totalNeed));
    assert.equal(cents(s.backing.unallocated), 52401 - cents(totalNeed));
    for (const packet of [r.next.plannedCostFunding, r.current.fromTodayFunding, nextForward(r.current)]) {
      assert.equal(packet.contribution, 0);
      assert.ok(packet.items.every(row => row.remainingGap === 0));
    }
  }
});
test('authored zero requirement withholds backing and dependent proposals', () => {
  const r = recommend(input => { input.plan.commitments[1].amount = 0; });
  assert.equal(r.advice.savingsFunding.backing.status, 'unavailable');
  assert.ok(r.advice.savingsFunding.backing.items.every(row => row.saved === null));
  for (const packet of [r.next.plannedCostFunding, r.current.fromTodayFunding]) {
    assert.equal(packet.status, 'unavailable'); assert.equal(packet.contribution, null);
  }
});
test('known zero stock is zero backing, while missing/stale/pending stock withholds gaps', () => {
  const zero = recommend(input => {
    input.plan.startingCash.breakdown[2].value = input.plan.startingCash.heldElsewhere[0].value = 0;
    input.plan.savingsPoolObservation.accounts.forEach(row => { row.value = 0; });
  });
  assert.equal(zero.advice.savingsFunding.stock.amount, 0);
  assert.ok(zero.advice.savingsFunding.backing.items.every(row => row.saved === 0));
  for (const packet of [zero.next.plannedCostFunding, zero.current.fromTodayFunding]) {
    assert.notEqual(packet.status, 'unavailable');
    assert.ok(packet.items.every(row => cents(row.remainingGap) === cents(row.cost) - cents(row.cumulativeProposed)));
  }
  for (const kind of ['missing', 'null', 'stale', 'pending']) {
    const r = recommend(input => {
      const row = input.plan.savingsPoolObservation.accounts[0];
      if (kind === 'missing') input.plan.savingsPoolObservation.accounts.pop();
      if (kind === 'null') row.value = null;
      if (kind === 'stale') row.evidenceDate = '2026-10-06';
      if (kind === 'pending') row.pendingState = 'unresolved';
    });
    for (const packet of [r.next.plannedCostFunding, r.current.fromTodayFunding]) {
      assert.equal(packet.status, 'unavailable', kind);
      assert.equal(packet.contribution, null);
      assert.ok(packet.items.every(row => row.remainingGap == null), kind);
    }
  }
});
test('unknown price and undated costs retain null gaps and cannot become precise funding', () => {
  for (const kind of ['price', 'date']) {
    const r = recommend(input => {
      if (kind === 'price') input.plan.commitments[1].amount = null;
      if (kind === 'date') delete input.plan.commitments[1].date;
    });
    const cost = r.advice.savingsFunding.unresolved.find(row => row.id === 'far');
    assert.ok(cost, 'the named unresolved requirement remains present');
    assert.equal(cost.saved, null);
    for (const packet of [r.next.plannedCostFunding, r.current.fromTodayFunding]) {
      assert.equal(packet.status, 'unavailable');
      assert.equal(packet.contribution, null);
      assert.equal(packet.actualSaved, null);
      assert.ok(packet.items.every(row => row.remainingGap == null));
    }
  }
});
test('legacy confirmed assignments retain their gaps and actual saved distinction', () => {
  const r = recommend(input => {
    input.plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-10-08';
    input.plan.savingsEarmarks.pools[1].reconciledOn = input.asOf;
    input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: input.asOf,
      source: 'Independent invented assignment confirmation', pools: [
        { poolId: 'club-pool', allocations: [{ goalRef: { kind: 'group', id: 'club' }, amount: 95 }] },
        { poolId: 'home-pool', allocations: [{ goalRef: { kind: 'yearly-bill', id: 'home-cost' }, amount: 24 }] },
      ] }];
  });
  assert.deepEqual(gaps(r.next.plannedCostFunding), { near: 0, 'home-cost': 0, far: 55 });
  assert.deepEqual(gaps(r.current.fromTodayFunding), { near: 0, 'home-cost': 0, far: 80 });
  assert.deepEqual(gaps(nextForward(r.current)), { near: 0, 'home-cost': 0, far: 0 });
  assert.deepEqual(r.next.plannedCostFunding.items.map(row => row.actualSaved), [60, 24, 35]);
});

if (failed) { console.error(failed + ' Budget backing-gap regressions failed'); process.exitCode = 1; }
