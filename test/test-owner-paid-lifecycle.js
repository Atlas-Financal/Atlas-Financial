'use strict';
// A5 (#819, #821 item 4): owner-confirmed Paid. Owner rules R1 and R5:
// the owner's word is proof; settledOn is the FULL confirmation date (never
// a payment date); `ownerPaid: { amount, confirmedOn }` is a PARTIAL
// confirmation and never closes the item; a confirmed item is Paid for the
// rest of its pay period and absent from later periods.
//
// Invented fixture (test/fixtures/savings-daily-allocation-contract.js):
// 'near' 60 due 2026-10-21, 'far' 170 due 2026-10-28, a yearly 'home-cost'
// 24; reported Savings 95 + 24 = 119; the cycle runs 2026-10-02..10-15 and
// the next opens 2026-10-16. Every expectation is hand-derived from those
// numbers, not read from Forecast:
//   none:    near 60, far 170; shares near 60, home 24, far 119-60-24 = 35
//   partial: owner says 25 of near paid -> need 60-25 = 35, one cash event
//            of -35; shares near 35, home 24, far 119-35-24 = 60
//   full:    near need 0 and no cash event; shares home 24, far 119-24 = 95;
//            near still listed this period as Paid (owner-confirmed), with
//            the actual amount Unknown; absent from 2026-10-16 on.
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/savings-daily-allocation-contract');
const { policy } = require('./fixtures/chronological-savings-data');

function world(day = '2026-10-07', mutate) {
  const x = policy(fx.advance(fx.fixture(), day));
  x.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }, { kind: 'commitment', id: 'far' }];
  if (mutate) mutate(x.plan.commitments[0]);
  return x;
}
const partial = c => { c.ownerPaid = { amount: 25, confirmedOn: '2026-10-06' }; };
// The full-confirmation display row is for an ungrouped item (a grouped
// member keeps the incumbent group roster), so these cases ungroup 'near'.
const full = c => { delete c.group; c.settledOn = '2026-10-06'; };
function surfaces(x) {
  const opts = x.opts;
  return {
    seq: F.fundingSequence(x.plan, x.asOf, opts),
    events: F.simulate(x.plan, x.asOf, { ...opts, debts: [] }).events.filter(e => ['near', 'far'].includes(e.id)),
    funding: F.savingsDailyFunding(x.plan, [], x.asOf, opts),
  };
}
const need = (s, id) => s.seq.find(r => r.id === id)?.need;
const item = (s, id) => s.funding.backing.items.find(i => i.id === id);
const row = (s, id) => s.funding.rows.find(r => r.key === 'commitment:' + id);

test('baseline: no confirmation keeps the full need and the hand-derived shares', () => {
  const s = surfaces(world());
  assert.equal(s.funding.backing.status, 'ready');
  assert.equal(need(s, 'near'), 60);
  assert.deepEqual(s.events.map(e => [e.id, e.amount]), [['near', -60], ['far', -170]]);
  assert.deepEqual(['near', 'home-cost', 'far'].map(id => item(s, id).saved), [60, 24, 35]);
});

test('partial owner confirmation of 25 of 60 leaves 35, counted once across need, cash and backing', () => {
  const s = surfaces(world('2026-10-07', partial));
  assert.equal(need(s, 'near'), 35);
  assert.deepEqual(s.events.map(e => [e.id, e.amount]), [['near', -35], ['far', -170]], 'one cash event, never 60 and never 35 twice');
  assert.deepEqual(['near', 'home-cost', 'far'].map(id => item(s, id).saved), [35, 24, 60]);
  const near = item(s, 'near');
  assert.notEqual(near.paymentStatus, 'paid', 'a partial confirmation never closes the item');
  assert.deepEqual(near.commitmentCost.ownerConfirmation,
    { status: 'partial', amount: 25, confirmedOn: '2026-10-06', dateRole: 'owner-confirmation' });
  assert.deepEqual(near.commitmentCost.paid, { status: 'known', amount: 25, range: null });
  assert.equal(near.commitmentCost.confirmedLinkedPaid.amount, 0, 'the owner amount is never a linked payment assignment');
  assert.equal(near.commitmentCost.unpaidCost.amount, 35);
});

test('full owner confirmation: Paid this period with Unknown actual, no need, no cash, freed backing', () => {
  const s = surfaces(world('2026-10-07', full));
  assert.equal(s.seq.some(r => r.id === 'near'), false, 'excluded from the funding sequence');
  assert.deepEqual(s.events.map(e => e.id), ['far']);
  assert.equal(item(s, 'near'), undefined, 'a display row, never a backing item');
  const near = row(s, 'near');
  assert.equal(near.paymentStatus, 'paid');
  assert.equal(near.paymentSource, 'owner-confirmed');
  assert.equal(near.confirmedOn, '2026-10-06');
  assert.equal(near.paidOn, null, 'the confirmation date is never a payment date');
  assert.equal(near.needed, 0);
  assert.equal(near.saved, 0);
  assert.equal(near.stillToFund, 0);
  assert.equal(near.commitmentCost.ownerConfirmation.status, 'full');
  assert.equal(near.commitmentCost.ownerConfirmation.amount, null, 'no owner amount is invented');
  assert.equal(near.commitmentCost.paid.status, 'unavailable');
  assert.equal(near.commitmentCost.unpaidCost.amount, 0);
  assert.equal(item(s, 'far').saved, 95);
  assert.equal(s.funding.status, 'ready');
  assert.ok(!s.funding.period.allocations.some(a => a.id.startsWith('near@')), 'no contribution is proposed for a paid item');
  // Same pay period, later day: still listed.
  assert.equal(row(surfaces(world('2026-10-15', full)), 'near')?.paymentStatus, 'paid');
});

test('full owner confirmation retires at the next opening; the unpaid item stays', () => {
  const s = surfaces(world('2026-10-16', full));
  assert.equal(row(s, 'near'), undefined);
  assert.equal(item(s, 'near'), undefined);
  assert.equal(s.seq.some(r => r.id === 'near'), false);
  assert.ok(item(s, 'far'));
});

test('invalid ownerPaid fails closed to the full need', () => {
  const cases = {
    zero: { amount: 0, confirmedOn: '2026-10-06' },
    negative: { amount: -5, confirmedOn: '2026-10-06' },
    whole: { amount: 60, confirmedOn: '2026-10-06' },
    over: { amount: 61, confirmedOn: '2026-10-06' },
    future: { amount: 25, confirmedOn: '2026-10-08' },
    badDate: { amount: 25, confirmedOn: '2026-13-01' },
    extraKey: { amount: 25, confirmedOn: '2026-10-06', paidOn: '2026-10-06' },
    stringAmount: { amount: '25', confirmedOn: '2026-10-06' },
    notObject: 25,
  };
  for (const [name, value] of Object.entries(cases)) {
    const s = surfaces(world('2026-10-07', c => { c.ownerPaid = value; }));
    assert.equal(need(s, 'near'), 60, name);
    assert.equal(s.events.find(e => e.id === 'near').amount, -60, name);
    assert.equal(item(s, 'near').commitmentCost.ownerConfirmation, undefined, name);
  }
  // Beside settledOn it is refused; settledOn alone means full.
  const both = world('2026-10-07', c => { full(c); c.ownerPaid = { amount: 25, confirmedOn: '2026-10-06' }; });
  assert.equal(F.commitmentSettledBy(both.plan.commitments[0], both.asOf), true);
  assert.equal(row(surfaces(both), 'near').commitmentCost.ownerConfirmation.status, 'full');
  assert.equal(surfaces(both).seq.some(r => r.id === 'near'), false);
  // A ranged commitment has no point amount to be partly paid.
  const ranged = world('2026-10-07', c => { delete c.amount; c.amountMin = 50; c.amountMax = 70; partial(c); });
  assert.equal(surfaces(ranged).events.some(e => e.id === 'near'), false, 'unchanged ranged handling');
  assert.equal(item(surfaces(ranged), 'near')?.commitmentCost?.ownerConfirmation, undefined);
});

test('readers that do not know ownerPaid still treat the row as unpaid with its full need', () => {
  const x = world('2026-10-07', partial), row = x.plan.commitments[0];
  // Forecast's settledOn readers.
  assert.equal(F.commitmentSettledOn(row), null);
  assert.equal(F.commitmentSettledBy(row, '2026-12-31'), false);
  assert.equal(F.commitmentStatus(row), 'unsettled');
  // The opts-free inventory goal (no relief index) keeps the stated target.
  const inventory = F.savingsInventory(x.plan, x.asOf);
  const goal = inventory.pools.flatMap(p => p.plannedGoals).find(g => g.key === 'commitment:near');
  assert.equal(goal.target, 60);
  assert.notEqual(goal.settled, true);
  // reconcile.js reads canonical settledOn only: an ownerPaid row has none.
  const Reconcile = require('../scripts/reconcile');
  const canonical = Reconcile.readCanonical({ plan: x.plan }, { collection: 'commitments', id: 'near' });
  assert.equal(canonical.found, true);
  assert.equal(canonical.settledOn, null);
  assert.equal(canonical.value, 60, 'the stated amount is unchanged');
  // The planned-input edit contract refuses a row carrying an owner
  // confirmation, as it refuses settledOn (test-planned-input-contract.js).
});
