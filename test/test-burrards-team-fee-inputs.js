'use strict';
// Deliberate current-input reconciliation against the Oct 1 owner approval,
// as settled by the Nov 2 owner confirmation (all three fees PAID).
// Behaviour below uses invented amounts; live fee cents are not its fixture.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const data = require('../data.json');
const fixture = require('./fixtures/budget-funding-data');
const cents = n => Math.round(n * 100);
const ids = ['burrards-logan-team-fee-oct', 'burrards-logan-team-fee-nov', 'burrards-linden-team-fee'];
const rows = data.plan.commitments;
assert.equal(rows.some(r => r.id === 'burrards-team-fees'), false,
  'the superseded September aggregate must not coexist with its replacement');
const approved = ids.map(id => {
  assert.equal(rows.filter(r => r.id === id).length, 1, `${id} has one canonical row`);
  return rows.find(r => r.id === id);
});
assert.deepEqual(approved.map(r => cents(r.amount)), [20288, 20287, 34000]);
assert.deepEqual(approved.map(r => r.date || null), ['2026-10-16', '2026-11-01', '2026-10-20']);
assert.deepEqual(approved.map(r => r.confidence), ['confirmed', 'confirmed', 'estimated']);
assert.ok(approved.every(r => r.budgetCategory === 'sport' && r.sinkingFund === true
  && r.settledOn === '2026-11-02' && r.funded == null && r.actualSaved == null));
assert.equal(approved.slice(0, 2).reduce((n, r) => n + cents(r.amount), 0), 40575);
assert.equal(approved.reduce((n, r) => n + cents(r.amount), 0), 74575);
assert.equal(F.commitmentCashDate(approved[2]), '2026-10-20', 'Linden uses the explicit October 7 owner planning-date update');
assert.match(approved[2].note, /Owner-confirmed 2026-11-02: the fee was invoiced and is PAID/, 'the Nov 2 owner confirmation records the Linden fee as invoiced and paid');
for (const id of ['burrard1', 'burrard2']) {
  assert.equal(rows.find(r => r.id === id).settledOn, '2026-08-16', 'paid registrations are separate');
}

// Independent invented timeline: one outdated $77 aggregate becomes two
// unpaid instalments $101.01/$101.02 and an undated protected $303 estimate.
// Only the commitment roster changes; cash/income/bill/household inputs stay.
const base = fixture();
base.meta.asOf = base.plan.opening.asOf = '2026-09-25';
base.plan.bills = base.plan.bills.filter(r => r.frequency === 'biweekly');
base.plan.commitments = [{ id: 'old-fee', label: 'Old aggregate', date: '2026-09-15',
  amount: 77, confidence: 'estimated', budgetCategory: 'sport', sinkingFund: true }];
const prior = F.recommend(base.plan, base.meta.asOf, {});
assert.match(prior.payPeriodViews[0].plannedCostFunding.reason, /overdue.*77\.00/i);
const updated = structuredClone(base);
updated.plan.commitments = [
  { id: 'fee-one', label: 'First fee', date: '2026-10-16', amount: 101.01, confidence: 'confirmed' },
  { id: 'fee-two', label: 'Second fee', date: '2026-11-01', amount: 101.02, confidence: 'confirmed' },
  { id: 'fee-held', label: 'Undated proposal', when: 'Approval and due date pending', amount: 303, confidence: 'estimated' },
];
const untouched = structuredClone(updated); untouched.plan.commitments = base.plan.commitments;
assert.deepEqual(untouched, base);
const original = JSON.stringify(updated);
const events = F.expandEvents(updated.plan, '2026-09-25', '2026-11-05', {})
  .filter(e => ['old-fee', 'fee-one', 'fee-two', 'fee-held'].includes(e.id));
assert.deepEqual(events.map(e => ({ id: e.id, date: e.date, amount: e.amount })), [
  { id: 'fee-one', date: '2026-10-16', amount: -101.01 },
  { id: 'fee-two', date: '2026-11-01', amount: -101.02 },
]);
assert.equal(events.reduce((n, r) => n + cents(-r.amount), 0), 10101 + 10102);
const seq = F.fundingSequence(updated.plan, updated.meta.asOf, {});
const held = seq.find(r => r.id === 'fee-held');
assert.equal(held.date, null);
assert.equal(held.bounds.floor, 303);
assert.equal(held.flexibility, 'required');
const advice = F.recommend(updated.plan, updated.meta.asOf, {});
const current = advice.payPeriodViews.find(p => p.start === '2026-09-25').plannedCostFunding;
assert.equal(current.status, 'unavailable', 'known dated instalments do not resolve the separate required-undated fee');
assert.equal(current.contribution, null);
const heldPublication = current.unscheduled.find(r => r.id === 'fee-held');
assert.equal(heldPublication.date, null);
for (const k of ['contribution', 'cumulativeProposed', 'remainingGap', 'actualSaved']) {
  assert.equal(heldPublication[k], null, `${k} is unavailable for the undated estimate`);
}
assert.ok(current.items.every(r => r.actualSaved === null));
assert.equal(current.originalPaydayPlan, null);
// A separate invented dated estimate isolates the other evidence gates.
// The original proposal above remains undated and unavailable.
const datedEvidenceControl = structuredClone(updated.plan);
datedEvidenceControl.commitments.find(row => row.id === 'fee-held').date = '2027-01-15';
const between = F.recommend(datedEvidenceControl, '2026-10-01', {});
assert.match(between.payPeriodViews.find(p => p.start === '2026-10-09').plannedCostFunding.reason,
  /Current-period spending evidence is incomplete/);
// Passing either instalment's date does not invent payment or release it.
const overdue = F.recommend(datedEvidenceControl, '2026-11-06', {});
assert.match(overdue.payPeriodViews.find(p => p.start === '2026-11-06').plannedCostFunding.reason,
  /overdue.*202\.03/i);
assert.equal(JSON.stringify(updated), original);
console.log('PASS approved fee input reconciliation + synthetic replacement-only exact cents, unpaid dates/events once, undated protection/null funding, unchanged evidence gates and no mutation');
