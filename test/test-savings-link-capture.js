'use strict';
// G1 compatibility for the enabled savings links (A4b effects on), invented input only.
// G1's fixed root grammar and validators remain unchanged.
const assert = require('node:assert/strict');
const { fixture, observe } = require('./test-savings-link-foundation');
const consumer = require('./fixtures/savings-daily-consumer-data');
const Snapshot = require('../scripts/figures-snapshot');
const Comment = require('../scripts/figures-comment');
const x = fixture(), data = consumer();
data.plan = x.plan; data.meta.asOf = x.asOf;
data.liveOverlay.currentPeriodActuals = observe(x);
const without = structuredClone(data);
delete without.liveOverlay.currentPeriodActuals.savingsLinks;
const financial = value => Snapshot.buildFiguresSnapshot(value, null);
const capture = value => ({ ...financial(value), ...Snapshot.captureEvidence(value, null) });
assert.equal(Comment.captureEvidenceProblems(capture(without), ['']), 0, 'unchanged no-link capture remains valid');
assert.equal(Comment.captureEvidenceProblems(capture(data), ['']), 0,
  'enabled foundation must fit the existing G1 publication grammar without a validator change');
// A4b: effects are enabled. The one linked fact is a posted 12.34 charge
// to near (planned 60). Every itemized field that moves must move by
// exactly that charge, in the direction the rules give: cash and later
// shares +12.34 (near's later cash event is 47.66, so the item costs 60
// once), needs, holds and gaps -12.34, and near's Paid / unpaid facts
// become known (12.34 / 47.66). The household remainder and the planned
// close do not move: the item term deducts what the hold no longer does.
const C = 1234;
const expected = {
  'plan.bindingBalance': C, 'plan.endingCash': C, 'plan.lowestCash': C, 'payday.futureCosts': -C, 'payday.unallocated': C,
  'operating.this.householdBudgetTotal': -C, 'totals.commitments': -C,
  'scoreboard.day30.cash': C, 'scoreboard.day60.cash': C, 'scoreboard.day90.cash': C,
  'planning.near.need': -C, 'planning.near.allocated': -C, 'planning.far.projectedByDeadline': -C,
  'period.2026-10-02.budgetHold': -C,
  'savings.current.row.group:club.needed': -C, 'savings.current.row.group:club.stillToFund': -C,
  'savings.current.item.near@2026-10-21.saved': -C, 'savings.current.item.near@2026-10-21.needed': -C,
  'savings.current.item.far@2026-10-28.saved': C, 'savings.current.item.far@2026-10-28.stillToFund': -C,
};
const facts = { 'savings.current.item.near@2026-10-21.cost.confirmedLinkedPaid.status': ['unconfigured', 'known'],
  'savings.current.item.near@2026-10-21.cost.confirmedLinkedPaid.amount': [null, 12.34],
  'savings.current.item.near@2026-10-21.cost.unpaidCost.status': ['unconfigured', 'known'],
  'savings.current.item.near@2026-10-21.cost.unpaidCost.amount': [null, 47.66] };
const on = financial(data), off = financial(without);
const moved = [...new Set([...Object.keys(on), ...Object.keys(off)])].filter(k => JSON.stringify(on[k]) !== JSON.stringify(off[k]));
assert.deepEqual(moved.sort(), [...Object.keys(expected), ...Object.keys(facts)].sort(), 'exactly the item-effect fields move');
for (const [key, delta] of Object.entries(expected))
  assert.equal(Math.round(on[key] * 100) - Math.round(off[key] * 100), delta, key + ' moves by the linked charge once');
for (const [key, [was, now]] of Object.entries(facts)) assert.deepEqual([off[key], on[key]], [was, now], key);
console.log('Enabled savings links: G1 capture valid; itemized fields move only by the linked charge, once.');
