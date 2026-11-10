'use strict';
// Independent synthetic acceptance specification. No reference allocator/stub.
// Run: node --test test/test-savings-daily-allocation-contract.js
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../public/forecast');
const { fixture, transfer, advance, clone, monthBoundaryFixture } = require('./fixtures/savings-daily-allocation-contract');
const cents = value => { assert.equal(typeof value, 'number'); return Math.round(value * 100); };
function run(input = fixture()) {
  assert.equal(typeof F.savingsDailyFunding, 'function',
    'Forecast.savingsDailyFunding must publish the approved contract');
  const before = JSON.stringify(input);
  const out = F.savingsDailyFunding(input.plan, input.debts || [], input.asOf, input.opts);
  assert.equal(JSON.stringify(input), before, 'no confirmation, baseline or observed cash mutation');
  assert.equal(out.source, 'Forecast.savingsDailyFunding');
  assert.equal(out.asOf, input.asOf);
  assert.equal(out.currency, 'CAD');
  assert.equal(out.actionPermission, 'not-granted');
  assert.equal(out.moneyMovementPermission, 'not-granted');
  return out;
}
const item = (out, key) => { const row = out.backing.items.find(row => row.key === key); assert.ok(row, key); return row; };
const row = (out, key) => { const found = out.rows.find(row => row.key === key); assert.ok(found, key); return found; };
function period(out, entitlement, transferred, remaining, available, proposal = available) {
  assert.equal(out.period.status, 'ready');
  assert.equal(cents(out.period.entitlement), Math.round(entitlement * 100));
  assert.equal(cents(out.period.transferred), Math.round(transferred * 100));
  assert.equal(cents(out.period.remainingEntitlement), Math.round(remaining * 100));
  assert.equal(cents(out.period.availableNow), Math.round(available * 100));
  assert.equal(cents(out.period.proposal), Math.round(proposal * 100));
}
function fundingUnknown(out) {
  assert.equal(out.period.status, 'unavailable');
  assert.equal(out.period.availableNow, null);
  assert.equal(out.period.proposal, null);
  assert.ok(out.period.reason);
}

test('observed stock backs nearest member first; group/member stock is non-additive', () => {
  const out = run();
  assert.equal(cents(out.stock.amount), 11900);
  assert.equal(out.stock.evidenceTrust, 'verified');
  assert.equal(out.backing.basis, 'policy-derived-observed-backing');
  assert.equal(out.backing.trust, 'calculated');
  assert.equal(cents(item(out, 'near@2026-10-21').saved), 6000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 3500);
  assert.equal(cents(row(out, 'group:club').saved), 9500);
  assert.equal(cents(row(out, 'group:club').needed), 23000);
  assert.equal(cents(row(out, 'yearly-bill:home-cost').saved), 2400);
  assert.equal(out.stock.nonAdditive, true);
  assert.equal(out.backing.actualTransferred, null, 'earmark/policy allocation is not a transfer');
});
test('period 200 - 40 - 80 = 80; today 200 - 40 - 60 - 20 = 80', () => {
  const out = run(); period(out, 80, 0, 80, 80);
  assert.equal(cents(row(out, 'group:club').thisPeriod), 8000);
  assert.equal(cents(row(out, 'group:club').remainingThisPeriod), 8000);
  assert.equal(cents(row(out, 'group:club').saved), 9500, 'proposal never increases Saved');
});
test('same input/day is replace-only, not another 80 credited or accumulated', () => {
  const input = fixture(); assert.deepEqual(run(input), run(input));
  assert.equal(input.plan.savingsEarmarks.history.length, 0);
});
test('partial proven transfer 30: stock 149, period remaining 50, safe cash 50', () => {
  const out = run(transfer(fixture(), 30)); period(out, 80, 30, 50, 50);
  assert.equal(cents(out.stock.amount), 14900);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 6500);
});
test('transfer to the other configured pool counts once even when that pool has surplus', () => {
  const out = run(transfer(fixture(), 7, 'AA101', 'savings-dont-touch'));
  period(out, 80, 7, 73, 73); assert.equal(cents(out.stock.amount), 12600);
  assert.equal(cents(row(out, 'yearly-bill:home-cost').saved), 2400);
});
test('moving stock between savings pools is not new income or a cycle top-up', () => {
  const input = transfer(fixture(), 10, 'DD404', 'savings-dont-touch');
  input.plan.startingCash.breakdown[0].value += 10;
  input.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 10;
  input.plan.savingsPoolObservation.accounts[0].value -= 10;
  const source = input.opts.currentPeriodActuals.transactions.at(-2);
  source.atlasAccountId = 'savings'; source.accountRole = 'household-reserve';
  const out = run(input); period(out, 80, 0, 80, 80);
  assert.equal(cents(out.stock.amount), 11900);
});
test('a 50 cash floor protects 30 additional cash without changing the signed earned surplus', () => {
  const input = fixture(); input.plan.defaults.targetBuffer = 50;
  // Next cycle's native close is 45; five later dollars make its 50 floor
  // feasible too. This receipt cannot increase the current cycle's offer.
  input.plan.income.push({ id: 'next-floor', frequency: 'once', date: '2026-10-16', amount: 5, confidence: 'confirmed' });
  period(run(input), 80, 0, 80, 50);
});
test('missing protected operating cost amount withholds incremental funding', () => {
  const input = fixture(); delete input.plan.bills[0].amount; fundingUnknown(run(input));
});
test('distinct repeated transfers 30 + 20: one economic movement each, remaining 30', () => {
  const out = run(transfer(transfer(fixture(), 30), 20, 'BB202'));
  period(out, 80, 50, 30, 30); assert.equal(cents(out.stock.amount), 16900);
});
test('repeat provider records with identical IDs count the settled movement once', () => {
  const input = transfer(fixture(), 30);
  input.opts.currentPeriodActuals.transactions.push(...clone(input.opts.currentPeriodActuals.transactions.slice(-2)));
  period(run(input), 80, 30, 50, 50);
});
test('a full 80 transfer closes this cycle; larger stock cannot release another offer', () => {
  const out = run(transfer(fixture(), 80)); period(out, 80, 80, 0, 0);
  assert.equal(cents(out.stock.amount), 19900);
  assert.equal(cents(row(out, 'group:club').saved), 17500);
});
test('older carry can fund cash timing but cannot enlarge earned period entitlement', () => {
  const input = fixture(); input.plan.startingCash.breakdown[0].value += 500;
  input.plan.opening.paydaySnapshot.opening += 500;
  period(run(input), 80, 0, 80, 80);
});
test('future income raises full-cycle plan to 130 but is unavailable for today 80', () => {
  const input = fixture(); input.plan.income.push({ id: 'bonus', label: 'Invented later receipt',
    frequency: 'once', date: '2026-10-09', amount: 50, confidence: 'confirmed' });
  const out = run(input); period(out, 130, 0, 130, 80);
  assert.equal(cents(row(out, 'group:club').thisPeriod), 13000);
  assert.equal(cents(row(out, 'group:club').remainingThisPeriod), 8000);
});
test('already received payroll is counted in period flows once, not added to current cash', () => {
  const out = run(); period(out, 80, 0, 80, 80);
  assert.equal(cents(out.period.futureIncome), 0);
  assert.equal(cents(out.period.currentCash), 20000);
});
test('new evidenced income 10 after full transfer permits only fresh 10 today', () => {
  const input = advance(transfer(fixture(), 80), '2026-10-06');
  input.plan.startingCash.breakdown[0].value += 10;
  input.plan.income.push({ id: 'bonus', label: 'Invented fresh receipt', frequency: 'once',
    date: input.asOf, amount: 10, confidence: 'confirmed' });
  input.plan.opening.representedEvents.push({ id: 'bonus', date: input.asOf });
  input.opts.currentPeriodActuals.representedActuals.push({ id: 'bonus', date: input.asOf,
    actual: 10, transactionId: 'bonus-1' });
  input.opts.currentPeriodActuals.transactions.push({ id: 'bonus-1', date: input.asOf, amount: -10,
    pending: false, currency: 'CAD', isIncome: true, incomeId: 'bonus',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented fresh receipt' });
  period(run(input), 90, 80, 10, 10);
});
test('negative period remains -110; even positive older cash cannot offer a top-up', () => {
  const input = fixture(); input.plan.bills[0].amount = 230;
  input.plan.startingCash.breakdown[0].value += 500;
  input.plan.opening.paydaySnapshot.opening += 500;
  period(run(input), -110, 0, 0, 0);
});
test('negative operating balance gives known zero availability, not an absolute value', () => {
  const input = fixture(); input.plan.startingCash.breakdown[0].value = -12;
  input.plan.opening.paydaySnapshot.opening = -192; // -192 + 200 received - 20 spent = -12.
  period(run(input), 80, 0, 80, 0);
});
test('negative observed pool stock is signed; it does not back a positive Saved amount', () => {
  const input = fixture(); input.plan.savingsPoolObservation.accounts[0].value = -12;
  const out = run(input); assert.equal(cents(out.stock.amount), 1200);
  assert.equal(cents(item(out, 'near@2026-10-21').saved), 0);
  assert.equal(cents(out.backing.pools.find(pool => pool.id === 'club-pool').deficit), 1200);
});
for (const [name, edit] of [
  ['missing operating balance', input => { delete input.plan.startingCash.breakdown[0].value; }],
  ['incomplete current-cycle transactions', input => { input.opts.currentPeriodActuals.transactionCoverage.complete = false; }],
  ['coverage begins after payday', input => { input.opts.currentPeriodActuals.coverageStart = '2026-10-03'; }],
  ['unmatched transfer outflow', input => { transfer(input, 30); input.opts.currentPeriodActuals.transactions.pop(); }],
  ['pending paired transfer', input => { transfer(input, 30); input.opts.currentPeriodActuals.transactions.slice(-2).forEach(tx => { tx.pending = true; }); }],
  ['conflicting duplicate ID', input => { const tx = clone(input.opts.currentPeriodActuals.transactions[0]); tx.amount = -199; input.opts.currentPeriodActuals.transactions.push(tx); }],
  ['cross-day transfer legs', input => { transfer(input, 30); input.opts.currentPeriodActuals.transactions.at(-1).date = '2026-10-06'; }],
]) test(name + ' withholds top-ups while clear observed stock remains known', () => {
  const input = fixture(); edit(input); const out = run(input);
  fundingUnknown(out); assert.equal(out.stock.status, 'ready'); assert.equal(typeof out.stock.amount, 'number');
});
for (const [name, edit] of [
  ['missing savings account', input => { input.plan.savingsPoolObservation.accounts.pop(); }],
  ['stale savings account', input => { input.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-04'; }],
  ['duplicate configured account identity', input => { input.plan.savingsEarmarks.pools[1].accountId = 'savings'; }],
]) test(name + ' never becomes a partial combined stock or zero', () => {
  const input = fixture(); edit(input); const out = run(input);
  assert.equal(out.stock.status, 'unavailable'); assert.equal(out.stock.amount, null); fundingUnknown(out);
});
test('pending savings movement can retain observed headline stock but cannot prove clear backing', () => {
  const input = fixture(); input.plan.savingsPoolObservation.accounts[0].pendingState = 'unresolved';
  const out = run(input); assert.equal(cents(out.stock.amount), 11900);
  assert.equal(out.backing.status, 'unavailable'); assert.equal(row(out, 'group:club').saved, null); fundingUnknown(out);
});
test('a pending reserve debit contradicts a clear observation and withholds derived backing', () => {
  const input = fixture();
  input.opts.currentPeriodActuals.transactions.push({ id: 'pending-reserve-cost', date: input.asOf,
    amount: 60, pending: true, currency: 'CAD', atlasAccountId: 'savings',
    accountRole: 'household-reserve', displayedPayee: 'Invented pending club cost' });
  const out = run(input);
  assert.equal(out.stock.amount, 119); assert.equal(out.backing.status, 'unavailable');
  assert.equal(row(out, 'group:club').saved, null); fundingUnknown(out);
});
test('manual confirmed farther-cost assignment stays pinned; only residual stock is derived', () => {
  const input = fixture(); input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: input.asOf,
    source: 'Invented manual intent', pools: [{ poolId: 'club-pool', allocations: [
      { goalRef: { kind: 'commitment', id: 'far' }, amount: 50 },
    ] }, { poolId: 'home-pool', allocations: [] }] }];
  const out = run(input); assert.equal(cents(item(out, 'near@2026-10-21').saved), 4500);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 5000);
});
function homeCostEarmark(amount = 20) {
  const input = fixture();
  input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: input.asOf,
    source: 'Invented manual intent', pools: [
      { poolId: 'club-pool', allocations: [] },
      { poolId: 'home-pool', allocations: [
        { goalRef: { kind: 'yearly-bill', id: 'home-cost' }, amount },
      ] },
    ] }];
  return input;
}
function poolBacking(out) {
  return out.backing.pools.map(pool => ({
    id: pool.id, accountId: pool.accountId, status: pool.status,
    observed: pool.observedCash, encumberedManual: pool.encumberedManual, unallocated: pool.unallocated,
    saved: out.rows.filter(row => row.poolId === pool.id)
      .reduce((sum, row) => sum + (row.saved == null ? null : cents(row.saved)), 0),
  })).sort((a, b) => a.id.localeCompare(b.id));
}
test('per-pool backing is unchanged when pool, snapshot and observation arrays are permuted', () => {
  const expected = poolBacking(run(homeCostEarmark()));
  assert.equal(expected.find(pool => pool.id === 'club-pool').saved, 9500);
  assert.equal(expected.find(pool => pool.id === 'home-pool').encumberedManual, 20);
  for (const pool of expected) {
    assert.equal(pool.status, 'ready');
    assert.ok(pool.saved <= cents(pool.observed), pool.id + ' cannot exceed observed stock');
  }
  for (const edit of [
    input => { input.plan.savingsEarmarks.pools.reverse(); },
    input => { input.plan.savingsEarmarks.history[0].pools.reverse(); },
    input => { input.plan.savingsPoolObservation.accounts.reverse(); },
    input => {
      input.plan.savingsEarmarks.pools.reverse();
      input.plan.savingsEarmarks.history[0].pools.reverse();
      input.plan.savingsPoolObservation.accounts.reverse();
    },
  ]) {
    const input = homeCostEarmark(); edit(input);
    const out = run(input);
    assert.equal(out.status, 'ready');
    assert.deepEqual(poolBacking(out), expected);
    for (const pool of out.backing.pools) {
      const saved = out.rows.filter(row => row.poolId === pool.id)
        .reduce((sum, row) => sum + (row.saved == null ? 0 : cents(row.saved)), 0);
      assert.ok(saved <= cents(pool.observedCash), pool.id + ' cannot exceed observed stock');
    }
  }
});
test('a Home earmark of a Club goal cannot move 20 onto Club stock after pool reversal', () => {
  function crossPool() {
    const input = fixture();
    input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: input.asOf,
      source: 'Invented manual intent', pools: [
        { poolId: 'club-pool', allocations: [] },
        { poolId: 'home-pool', allocations: [
          { goalRef: { kind: 'commitment', id: 'far' }, amount: 20 },
        ] },
      ] }];
    return input;
  }
  const original = run(crossPool());
  const reversed = crossPool(); reversed.plan.savingsEarmarks.pools.reverse();
  const after = run(reversed);
  for (const out of [original, after]) {
    const clubSaved = row(out, 'group:club').saved;
    const club = out.backing.pools.find(pool => pool.id === 'club-pool');
    if (clubSaved != null) assert.ok(cents(clubSaved) <= cents(club.observedCash));
    assert.notEqual(clubSaved, 115);
    assert.equal(out.backing.status, 'unavailable');
    assert.match(out.backing.reason, /pool and account identity/);
  }
  assert.deepEqual(poolBacking(original), poolBacking(after));
});
test('unpaid past cost sorts before later needs; crossing its deadline never settles it', () => {
  const input = fixture(); input.plan.commitments[0].date = '2026-10-01';
  const out = run(input); assert.equal(cents(item(out, 'near@2026-10-01').saved), 6000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 3500);
  fundingUnknown(out); // Native unresolved-overdue safety is not waived by a virtual earmark.
});
test('future-effective settlement does not release a cost earlier than evidence permits', () => {
  const input = fixture(); input.plan.commitments[0].settledOn = '2026-10-06';
  const out = run(input); assert.equal(cents(item(out, 'near@2026-10-21').saved), 6000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 3500);
});
test('settled cost releases derived backing on its effective date, not manual intent', () => {
  const input = advance(fixture(), '2026-10-06'); input.plan.commitments[0].settledOn = input.asOf;
  const out = run(input); assert.equal(cents(item(out, 'near@2026-10-21').saved), 0);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 9500);
});
test('undated unknown protected need does not invent a date/zero or free its pool', () => {
  const input = fixture(); delete input.plan.commitments[0].date; delete input.plan.commitments[0].amount;
  input.plan.commitments[0].when = 'TBD';
  const out = run(input); assert.equal(row(out, 'group:club').saved, null);
  assert.equal(row(out, 'group:club').needed, null); fundingUnknown(out);
});
test('ranged need remains a range; no midpoint or floor is published as exact Needed', () => {
  const input = fixture(); delete input.plan.commitments[1].amount;
  input.plan.commitments[1].amountMin = 170; input.plan.commitments[1].amountMax = 190;
  const out = run(input); assert.equal(row(out, 'group:club').needed, null);
  assert.deepEqual(row(out, 'group:club').neededRange, { min: 230, max: 250 });
  assert.equal(row(out, 'group:club').thisPeriod, null);
});
test('recurring yearly bill stock is consumed once per occurrence, not reused next year', () => {
  const input = fixture(); input.plan.windowDays = 400;
  // windowDays is a view, not native knowledge authority. A valid one-cent
  // requirement outside the linked pools extends it without changing backing.
  input.plan.commitments.push({ id: 'horizon-marker', date: '2027-10-30', amount: 0.01, confidence: 'confirmed' });
  const out = run(input);
  assert.equal(cents(item(out, 'home-cost@2026-10-25').saved), 2400);
  assert.equal(cents(item(out, 'home-cost@2027-10-25').saved), 0);
});
test('cost-date ordering survives source-array reversal', () => {
  const input = fixture(); input.plan.commitments.reverse(); const out = run(input);
  assert.equal(cents(item(out, 'near@2026-10-21').saved), 6000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 3500);
});
test('an earlier cash deadline wins over the previous grouped display order', () => {
  const input = fixture(); input.plan.commitments[1].date = '2026-10-15'; const out = run(input);
  assert.equal(cents(item(out, 'far@2026-10-15').saved), 9500);
  assert.equal(cents(item(out, 'near@2026-10-21').saved), 0);
});
test('settlement does not silently release confirmed manual intent to another cost', () => {
  const input = fixture(); input.plan.commitments[0].settledOn = input.asOf;
  input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: input.asOf,
    source: 'Invented manual intent', pools: [{ poolId: 'club-pool', allocations: [
      { goalRef: { kind: 'commitment', id: 'near' }, amount: 40 },
    ] }, { poolId: 'home-pool', allocations: [] }] }];
  const out = run(input);
  assert.equal(cents(out.backing.pools.find(pool => pool.id === 'club-pool').encumberedManual), 4000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 5500);
});
test('shared goal ref reached directly and through a group is backed once', () => {
  const input = fixture(); input.plan.savingsEarmarks.pools[0].goalRefs.push({ kind: 'commitment', id: 'near' });
  const out = run(input);
  assert.equal(out.backing.items.filter(r => r.key === 'near@2026-10-21').length, 1);
  assert.equal(cents(row(out, 'group:club').saved), 9500);
});
test('a returned prior transfer is not fresh period income or a quota reset', () => {
  const input = transfer(fixture(), 80); transfer(input, -20, 'CC303');
  // Reverse identities/directions to represent one savings-to-operating movement.
  const legs = input.opts.currentPeriodActuals.transactions.slice(-2);
  legs[0].originalMerchant = 'CC303 TFR-FR Invented reserve';
  legs[1].originalMerchant = 'CC303 TFR-TO Invented operating';
  const out = run(input); period(out, 80, 80, 0, 0); assert.equal(cents(out.stock.amount), 17900);
});
test('new payday resets transfer quota by cycle identity; old savings stock carries once', () => {
  const input = advance(transfer(fixture(), 80), '2026-10-16');
  input.plan.startingCash.breakdown[0].value = 220;
  input.plan.opening.paydaySnapshot = { periodStart: input.asOf, asOf: input.asOf, opening: 20 };
  input.plan.opening.representedEvents = [{ id: 'payroll', date: input.asOf }];
  input.opts.currentPeriodActuals.coverageStart = input.asOf;
  input.opts.currentPeriodActuals.representedActuals.push({ id: 'payroll', date: input.asOf,
    actual: 200, transactionId: 'income-2' });
  input.opts.currentPeriodActuals.transactions.push({ id: 'income-2', date: input.asOf, amount: -200,
    pending: false, isIncome: true, currency: 'CAD', incomeId: 'payroll',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented next payroll' });
  // The 24 annual cost draws its separately backed home stock once.
  // Routine entitlement is 200 - 40 - 80 = 80; only 55 of goal need remains.
  const out = run(input); period(out, 80, 0, 80, 80, 55);
  assert.equal(out.period.start, '2026-10-16');
  assert.equal(cents(out.stock.amount), 19900); assert.equal(cents(out.period.unassigned), 2500);
});
test('spending saved money on household costs after a full transfer cannot reset entitlement', () => {
  const input = transfer(fixture(), 80);
  input.plan.savingsPoolObservation.accounts[0].value -= 20;
  input.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 20;
  input.opts.currentPeriodActuals.transactions.push({ id: 'saved-food', date: input.asOf, amount: 20,
    pending: false, currency: 'CAD', atlasAccountId: 'savings', accountRole: 'household-reserve',
    categoryLabel: 'Groceries', displayedPayee: 'Invented saved-money grocer' });
  const out = run(input); period(out, 80, 80, 0, 0);
  assert.equal(cents(out.stock.amount), 17900);
  assert.equal(cents(row(out, 'group:club').saved), 15500);
});
test('spending 60 on the linked goal reduces observed stock and need once; no new surplus', () => {
  const input = transfer(fixture(), 80);
  input.plan.savingsPoolObservation.accounts[0].value -= 60;
  input.plan.startingCash.breakdown.find(r => r.id === 'savings').value -= 60;
  input.plan.commitments[0].settledOn = input.asOf;
  input.opts.currentPeriodActuals.transactions.push({ id: 'saved-goal', date: input.asOf, amount: 60,
    pending: false, currency: 'CAD', atlasAccountId: 'savings', accountRole: 'household-reserve',
    kindHint: 'bill-payment', displayedPayee: 'Invented early club payment' });
  const out = run(input); period(out, 80, 80, 0, 0);
  assert.equal(cents(out.stock.amount), 13900);
  assert.equal(cents(row(out, 'group:club').needed), 17000);
  assert.equal(cents(row(out, 'group:club').saved), 11500);
});
test('untransferred observed stock growth changes backing but not the 80 earned entitlement', () => {
  const input = fixture(); input.plan.savingsPoolObservation.accounts[0].value += 100;
  input.plan.startingCash.breakdown.find(r => r.id === 'savings').value += 100;
  const out = run(input); period(out, 80, 0, 80, 80, 35);
  assert.equal(cents(out.stock.amount), 21900); assert.equal(out.backing.actualTransferred, null);
});
test('a private daily walk cannot change incumbent simulate/recommend options or manual intent', () => {
  const input = fixture(), ordinaryOpts = { ...input.opts }; delete ordinaryOpts.savingsAllocationPolicy;
  const before = F.simulate(input.plan, input.asOf, ordinaryOpts);
  run(input);
  assert.deepEqual(F.simulate(input.plan, input.asOf, input.opts), before);
  const actual = F.recommend(input.plan, input.asOf, input.opts), expected = F.recommend(input.plan, input.asOf, ordinaryOpts);
  delete actual.planOptions.savingsAllocationPolicy; delete actual.simOptions.savingsAllocationPolicy;
  assert.deepEqual(actual, expected, 'all incumbent results unchanged; only echoed caller metadata differs');
});
for (const [name, edit] of [
  ['observed cash disagrees with operating opening', input => { input.opts.operatingPlan = 'live'; input.opts.observedCash = {
    complete: true, asOf: input.asOf, accounts: [{ id: 'chequing-a', value: 199, evidenceDate: input.asOf },
      { id: 'chequing-b', value: 0, evidenceDate: input.asOf }] }; }],
  ['unexplained current cash increase', input => { input.plan.startingCash.breakdown[0].value += 10; }],
  ['missing original cash bridge', input => { delete input.plan.opening.paydaySnapshot; }],
  ['contradictory transfer account aliases', input => { transfer(input, 30); input.opts.currentPeriodActuals.transactions.at(-2).account = 'chequing-b'; }],
  ['unknown required obligation amount', input => { input.plan.obligations.push({ id: 'unknown-required', frequency: 'once', date: '2026-10-10', confidence: 'confirmed' }); }],
]) test(name + ' cannot authorize positive incremental funding', () => {
  const input = fixture(); edit(input); fundingUnknown(run(input));
});
test('current stock stays known while future manual intent is not applied retroactively', () => {
  const input = fixture(); input.plan.savingsEarmarks.history = [{ revision: 1, confirmedAt: '2026-10-06',
    source: 'Invented later intent', pools: [{ poolId: 'club-pool', allocations: [
      { goalRef: { kind: 'commitment', id: 'far' }, amount: 50 },
    ] }, { poolId: 'home-pool', allocations: [] }] }];
  const out = run(input); assert.equal(cents(out.stock.amount), 11900);
  assert.equal(cents(item(out, 'near@2026-10-21').saved), 6000);
  assert.equal(cents(item(out, 'far@2026-10-28').saved), 3500);
});
test('known future operating cash deficit blocks an apparently positive current top-up', () => {
  const input = fixture(); input.plan.defaults.targetBuffer = 50;
  fundingUnknown(run(input)); // Native next-cycle close is 45, five below the floor.
});
test('actual household overage reduces native entitlement; withdrawal cannot replay the spent quota', () => {
  const input = fixture(); input.opts.currentPeriodActuals.transactions[1].amount = 110;
  input.plan.startingCash.breakdown[0].value = 110; // 20 opening + 200 receipt - 110 actually spent.
  input.plan.income.push({ id: 'next-floor', frequency: 'once', date: '2026-10-16', amount: 5, confidence: 'confirmed' });
  period(run(input), 50, 0, 50, 50);
  transfer(input, 50); transfer(input, -20, 'EE505');
  input.opts.currentPeriodActuals.transactions.at(-2).originalMerchant = 'EE505 TFR-FR Invented reserve';
  input.opts.currentPeriodActuals.transactions.at(-1).originalMerchant = 'EE505 TFR-TO Invented operating';
  period(run(input), 50, 50, 0, 0);
});
test('income already deposited in savings is not another operating entitlement against old carry', () => {
  const input = fixture(); input.plan.commitments[1].amount = 500;
  input.plan.startingCash.breakdown[0].value += 500; input.plan.opening.paydaySnapshot.opening += 500;
  input.plan.savingsPoolObservation.accounts[0].value += 80; input.plan.startingCash.breakdown[2].value += 80;
  input.opts.currentPeriodActuals.transactions.push({ id: 'saved-income', date: input.asOf, amount: -80,
    pending: false, currency: 'CAD', atlasAccountId: 'savings', accountRole: 'household-reserve',
    isIncome: true, displayedPayee: 'Invented saved gift' });
  const out = run(input); period(out, 80, 0, 80, 80);
  assert.equal(out.period.nativePeriodSurplus, 160); assert.equal(out.period.alreadySavedIncome, 80);
});
test('payroll already received in savings cannot also allocate older operating carry', () => {
  const input = fixture(); input.plan.startingCash.breakdown[0].value = 700;
  input.plan.opening.paydaySnapshot.opening = 720;
  Object.assign(input.opts.currentPeriodActuals.transactions[0], { atlasAccountId: 'savings', accountRole: 'household-reserve' });
  input.plan.savingsPoolObservation.accounts[0].value += 200; input.plan.startingCash.breakdown[2].value += 200;
  const out = run(input); period(out, -120, 0, 0, 0);
  assert.equal(out.period.nativePeriodSurplus, 80); assert.equal(out.period.alreadySavedIncome, 200);
});
test('native card purchase cash hold remains protected independently of goal backing', () => {
  const observed = require('../scripts/live-plan').fromObservation(require('./fixtures/card-purchase-coverage-data')()).data;
  const input = fixture(); input.plan.cardPurchaseCoverage = clone(observed.plan.cardPurchaseCoverage);
  input.opts.currentPeriodActuals.coverageStart = '2026-09-18'; // Includes the known opening/purchase interval.
  input.debts = clone(observed.debts); input.opts.currentPeriodActuals.transactions.push(...clone(observed.liveOverlay.currentPeriodActuals.transactions));
  const out = run(input); period(out, 80, 0, 80, 0);
  delete input.plan.cardPurchaseCoverage; fundingUnknown(run(input));
});
test('independent physical ledger: each transfer/proposal conserves cash and keeps every dated floor', () => {
  for (const observedTransfer of [0, 1, 30, 50, 79, 80]) {
    const input = fixture(); if (observedTransfer) transfer(input, observedTransfer);
    const out = run(input), proposal = out.period.proposal;
    let operating = 200 - observedTransfer - proposal, club = 95 + observedTransfer + proposal, home = 24;
    assert.equal(operating + club + home, 319, 'moving money cannot create assets');
    // Spend the remaining allowance immediately, a stronger timing stress
    // than the native gradual household walk. No Forecast event helper here.
    operating -= 60; assert.ok(operating >= 20);
    operating -= 40; assert.ok(operating >= 20); // Oct 10 ordinary bill.
    operating += 200; operating -= 80; assert.ok(operating >= 20); // Oct 16 income/budget.
    const first = Math.min(club, 60); club -= first; operating -= 60 - first;
    assert.ok(operating >= 20); operating -= 40; assert.ok(operating >= 20); // Oct 24.
    home -= 24; assert.equal(home, 0); // Oct 25, paid from home stock once.
    const second = Math.min(club, 170); club -= second; operating -= 170 - second;
    assert.ok(operating >= 20); assert.equal(operating + club + home, 45);
    assert.equal(observedTransfer + proposal, 80, 'one earned quota, not cumulative refresh credit');
  }
});
test('pending/truncated coverage cannot become complete merely because another flag says complete', () => {
  const input = fixture(); input.opts.currentPeriodActuals.transactionCoverage.truncated = true;
  fundingUnknown(run(input));
});
test('missing or future-effective policy retains stock but cannot invent assigned backing', () => {
  const input = fixture(); delete input.opts.savingsAllocationPolicy;
  let out = run(input); fundingUnknown(out); assert.equal(out.stock.amount, 119);
  assert.equal(row(out, 'group:club').saved, null);
  input.opts.savingsAllocationPolicy = { ...fixture().opts.savingsAllocationPolicy, confirmedAt: '2026-10-06' };
  out = run(input); fundingUnknown(out); assert.equal(row(out, 'group:club').saved, null);
});
test('estimated cost/cash evidence cannot be promoted to calculated funding certainty', () => {
  const input = fixture(); input.plan.commitments[1].confidence = 'estimated';
  input.plan.startingCash.breakdown[0].confidence = 'estimated';
  const out = run(input); assert.equal(out.period.trust, 'estimated');
  assert.equal(row(out, 'group:club').thisPeriodTrust, 'estimated');
});
test('unlinked receipt cannot count once as scheduled payroll and again as other income', () => {
  const input = fixture(); input.opts.currentPeriodActuals.representedActuals = [];
  input.plan.startingCash.breakdown[0].value += 500; input.plan.opening.paydaySnapshot.opening += 500;
  fundingUnknown(run(input));
});
test('known physical income differing from native received-income amount closes the money claim', () => {
  const input = fixture(); input.opts.currentPeriodActuals.transactions[0].amount = -195;
  input.opts.currentPeriodActuals.representedActuals[0].actual = 195;
  input.plan.startingCash.breakdown[0].value -= 5;
  fundingUnknown(run(input));
});
test('cash moved to an unconfigured reserve cannot be silently reused as an unsent quota', () => {
  const input = transfer(fixture(), 20);
  input.opts.currentPeriodActuals.transactions.at(-1).atlasAccountId = 'unknown-reserve';
  input.plan.savingsPoolObservation.accounts[0].value -= 20; input.plan.startingCash.breakdown[2].value -= 20;
  fundingUnknown(run(input));
});
test('a goal linked to two pool roles withholds exact backing and destination claims', () => {
  const input = fixture(); input.plan.savingsEarmarks.pools[1].goalRefs.push({ kind: 'commitment', id: 'near' });
  const out = run(input); fundingUnknown(out); assert.equal(out.stock.amount, 119);
  assert.equal(item(out, 'near@2026-10-21').saved, null);
});
test('a month boundary uses the payroll cycle identity, not a calendar-month transfer reset', () => {
  const input = monthBoundaryFixture();
  // Missing merchant evidence preserves the 10 as Other spending, in addition
  // to the 80 category target: 200 - 40 - 80 - 10 = 70. Today is independently
  // 210 observed - 40 bill - 80 remaining category - 20 buffer = 70.
  const out = run(input); period(out, 70, 0, 70, 70, 55);
  assert.equal(out.period.start, '2026-10-30'); assert.equal(out.period.end, '2026-11-12');
  assert.equal(out.period.unassigned, 15);
});
test('known undated protected floor is not silently freed for linked savings goals', () => {
  const input = fixture(); input.plan.commitments.push({ id: 'undated-protected', label: 'Invented undated obligation',
    when: 'TBD', amount: 1000, confidence: 'confirmed', adjustable: false });
  const out = run(input); fundingUnknown(out);
  assert.equal(out.status, 'unavailable');
  assert.equal(out.stock.amount, 119, 'independently observed stock stays known');
  assert.equal(out.backing.status, 'ready', 'ordinary requirement does not erase Savings backing');
  assert.equal(row(out, 'group:club').thisPeriod, null, 'dependent contribution is Unknown, not zero');
  const source = F.fundingSequence(input.plan, input.asOf, input.opts).find(row => row.id === 'undated-protected');
  assert.equal(source.need, 1000); assert.equal(source.date, null);
});

// --- Split-parent bridge parity (diagnosis addendum, Atlas-authorized
// repair). The cash bridge inside savingsDailyFunding must apply the
// same qualified parent-exclusion as postedAccountMovements: a group
// parent is skipped only when matching children exist in the packet.
// Conservation in every case: payday opening 20, income -200, grocery
// spend 20 (split 12 + 8), current household chequing cash 200.
const splitChild = (id, amount, extra = {}) => ({ id, date: '2026-10-03', amount, pending: false,
  atlasAccountId: 'chequing-a', savingsPostingEvidence: 'posted', parentId: 'food-1',
  accountRole: 'household-cash', currency: 'CAD', categoryId: 'groceries',
  categoryLabel: 'Groceries', displayedPayee: 'Invented grocer split', ...extra });
function splitInput(children) {
  const input = fixture();
  const txs = input.opts.currentPeriodActuals.transactions;
  txs.find(t => t.id === 'food-1').isGroup = true;
  txs.push(...children);
  return input;
}
function childOnlyInput(children) {
  const input = fixture();
  const txs = input.opts.currentPeriodActuals.transactions;
  txs.splice(txs.findIndex(t => t.id === 'food-1'), 1);
  txs.push(...children);
  return input;
}
test('split parent + children: bridge parity with child-only input', () => {
  const kids = [splitChild('food-1a', 12), splitChild('food-1b', 8)];
  const split = run(splitInput(kids));
  assert.equal(split.period.status, 'ready');
  assert.deepEqual(split, run(childOnlyInput(kids)),
    'parent + children publishes exactly what children alone publish');
  const probe = splitInput(kids);
  const posted = F.postedAccountMovements(probe.plan, 'chequing-a',
    { start: '2026-10-02', through: probe.asOf }, probe.opts);
  assert.deepEqual(posted.movements.map(m => m.id), ['income-1', 'food-1a', 'food-1b'],
    'the sibling path excludes the qualified parent');
});
test('group parent with no children still counts (parent-only preserved)', () => {
  const input = fixture();
  input.opts.currentPeriodActuals.transactions.find(t => t.id === 'food-1').isGroup = true;
  assert.deepEqual(run(input), run(), 'an unqualified group parent is not skipped');
});
test('children with an unrelated parentId do not qualify the parent: double-count withholds', () => {
  const kids = [splitChild('food-1a', 12, { parentId: 'food-999' }),
    splitChild('food-1b', 8, { parentId: 'food-999' })];
  fundingUnknown(run(splitInput(kids)));
});
test('duplicate identical child rows count once', () => {
  const kids = [splitChild('food-1a', 12), splitChild('food-1a', 12), splitChild('food-1b', 8)];
  const out = run(splitInput(kids));
  assert.equal(out.period.status, 'ready');
  assert.deepEqual(out, run(childOnlyInput([splitChild('food-1a', 12), splitChild('food-1b', 8)])));
});
test('duplicate child identity with contradictory amount withholds', () => {
  const kids = [splitChild('food-1a', 12), splitChild('food-1a', 13), splitChild('food-1b', 8)];
  fundingUnknown(run(splitInput(kids)));
});
test('pending children: parent excluded, pending legs uncounted, mismatch withholds', () => {
  const kids = [splitChild('food-1a', 12, { pending: true }), splitChild('food-1b', 8, { pending: true })];
  fundingUnknown(run(splitInput(kids)));
});
test('children outside the bridge window still qualify the parent under the packet rule', () => {
  // The incumbent exclusion is packet-scoped: children present anywhere
  // in the packet qualify the parent. The bridge must not publish on
  // the in-window parent alone; the incoherent packet withholds.
  const input = splitInput([splitChild('food-1a', 12, { date: '2026-10-01' }),
    splitChild('food-1b', 8, { date: '2026-10-01' })]);
  fundingUnknown(run(input));
});
test('split parity holds on the second chequing account', () => {
  const onB = (input) => {
    input.plan.startingCash.breakdown[0].value = 0;
    input.plan.startingCash.breakdown[1].value = 200;
    for (const tx of input.opts.currentPeriodActuals.transactions) tx.atlasAccountId = 'chequing-b';
    return input;
  };
  const kidsB = [splitChild('food-1a', 12, { atlasAccountId: 'chequing-b' }),
    splitChild('food-1b', 8, { atlasAccountId: 'chequing-b' })];
  const split = run(onB(splitInput(kidsB)));
  assert.equal(split.period.status, 'ready');
  assert.deepEqual(split, run(onB(childOnlyInput(kidsB))));
});
test('a genuine cash mismatch still withholds', () => {
  const input = fixture();
  input.plan.startingCash.breakdown[0].value = 201;
  fundingUnknown(run(input));
});
