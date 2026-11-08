'use strict';
// M11: a savings goal's remaining never goes negative, and an item paid
// above its planned cost never eats a sibling's need. `node test/test-goal-remaining-floor.js`
//
// Invented fixture (test-savings-link-foundation): items 'near' and 'far' in
// group 'club', set here to 500 and 700. One linked charge on 'near' arrives
// through the item ledger. Expectations are hand-derived:
//   charge 300  -> near 200 left; group 200 + 700 = 900
//   charge 600  -> near paid in full (overspend 100 is a disclosure); group 0 + 700 = 700
//   charge 1500 -> near paid in full; group 700, never 1200 - 1500 = -300
// linkedPaid stays the full paid fact (300 / 600 / 1500).
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('../public/forecast');
const { fixture, observe, raw, link } = require('./test-savings-link-foundation');

function goals(amount, refs) {
  const x = fixture();
  x.plan.commitments.find(c => c.id === 'near').amount = 500;
  x.plan.commitments.find(c => c.id === 'far').amount = 700;
  if (refs) x.plan.savingsEarmarks.pools[0].goalRefs = refs;
  x.map.savingsLinks.links = [link('category')];
  x.payload.transactions = [raw({ id: 'c1', amount })];
  const inv = F.savingsInventory(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: observe(x) });
  assert.equal(inv.status, 'ready');
  return Object.fromEntries(inv.pools.flatMap(p => p.plannedGoals).map(g => [g.key, g]));
}

test('one item: remaining floors at zero when the linked charge exceeds the item', () => {
  for (const [amount, paid, remaining] of [['300.00', 300, 200], ['500.00', 500, 0], ['600.00', 600, 0], ['1500.00', 1500, 0]]) {
    const near = goals(amount)['commitment:near'];
    assert.equal(near.linkedPaid, paid, `${amount}: linkedPaid is the full paid fact`);
    assert.equal(near.remaining, remaining, `${amount}: remaining`);
    assert.equal(near.remainingMax, remaining, `${amount}: remainingMax`);
  }
});

test('group: an overspent item never reduces its sibling’s need', () => {
  const refs = [{ kind: 'group', id: 'club' }];
  for (const [amount, remaining] of [['300.00', 900], ['600.00', 700], ['1500.00', 700]]) {
    const club = goals(amount, refs)['group:club'];
    assert.equal(club.target, 1200);
    assert.equal(club.remaining, remaining, `${amount}: group remaining`);
    assert.ok(club.remaining >= 0, `${amount}: group remaining is never negative`);
  }
});
