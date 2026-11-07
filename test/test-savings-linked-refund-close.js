'use strict';
// Savings audit PR 2: a linked refund is credited to the Bills close.
//
// A linked item purchase leaves the household reserve and is deducted from
// the close (and Balance After Deductions) once, as the A4b item term. A
// linked refund returns cash to the same account, and the item ledger already
// nets it (Paid = charges - refunds). Before this fix the close's item term
// skipped refunds, so the close stayed low by the refund. Now the term nets
// linked refunds per item, floored at zero.
//
// Invented household (test/acceptance/harness.js), served through the
// production path (scripts/live-plan.js fromObservation). Every expected
// figure is derived by hand in the comments, never computed by the code.
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const H = require('./acceptance/harness.js');
const AS_OF = '2026-10-14';
const link = (id, categoryId, date) => ({ categoryId, goalRef: { kind: 'commitment', id }, occurrenceDate: date,
  effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' });

// Payday snapshot opening 2,000 on Oct 9 (payroll 1,400 represented), plan
// Groceries 300 + Eating out 100. Trip (500, Nov 20) is linked to category
// Trip; gift (700, Dec 10) to category Gifts.
function world(txs) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.commitments = [
    { id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 500, confidence: 'confirmed', sinkingFund: true },
    { id: 'gift', label: 'Invented gift', date: '2026-12-10', amount: 700, confidence: 'confirmed', sinkingFund: true }];
  w.links = [link('trip', 106, '2026-11-20'), link('gift', 107, '2026-12-10')];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    ...txs.map(t => H.lm({ payee: 'Invented airline', ...t }))];
  w.planPatch = plan => { plan.opening.paydaySnapshot = { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 2000 };
    plan.opening.representedEvents = [{ id: 'payroll', date: '2026-10-09' }]; };
  return w;
}
function read(txs) {
  const { data } = H.dataOf(world(txs)), o = data.liveOverlay;
  const advice = F.recommend(data.plan, AS_OF, { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals,
    operatingPlan: o.operatingPlan, observedCash: o.observedCash });
  const v = advice.payPeriodViews.find(view => view.start <= AS_OF && view.end >= AS_OF);
  return { close: v.plannedPeriodClose, bad: v.balanceAfterDeductions, term: v.plannedPeriodCloseTerms?.savingsItemSpending ?? 0 };
}
const charge = { date: '2026-10-10', amount: 100, category: 'Trip' };
const refund = amount => ({ date: '2026-10-12', amount: -amount, category: 'Trip' });

// Control, by hand: close = snapshot opening 2,000 + payroll 1,400 - 0
// bills - 400 reserve = 3,000; BAD = 1,400 - 0 - 400 = 1,000.
const none = read([]);
assert.deepEqual([none.close, none.bad, none.term], [3000, 1000, 0]);
{
  // 100 charge: term 100, close 100 below the control (unchanged behaviour).
  const r = read([charge]);
  assert.deepEqual([r.term, r.bad], [100, 900]);
  assert.equal(r.close, 2900, 'close 3,000 - 100');
}
{
  // 100 charge, 30 refund: the item paid 70 net, so the term is 70 and the
  // close is 70 below the control (the bug kept it 100 below).
  const r = read([charge, refund(30)]);
  assert.equal(r.term, 70, 'the close nets the linked refund');
  assert.equal(r.bad, 930, 'BAD = 1,400 - 0 - 400 - 70');
  assert.equal(r.close, 2930, 'close 3,000 - 70: credited the 30 refund (the bug showed 2,900)');
}
{
  // Full reversal (100 then -100): net 0, close equals the control.
  const r = read([charge, refund(100)]);
  assert.deepEqual([r.term, r.close, r.bad], [0, 3000, 1000]);
}
{
  // Refund larger than the charge this cycle (100 then -130): floored at
  // zero, never a credit beyond the item's own charges this cycle.
  const r = read([charge, refund(130)]);
  assert.deepEqual([r.term, r.close], [0, 3000]);
}
{
  // Per item, not pooled: trip 100 - 30 = 70; a 50 gift refund with no gift
  // charge this cycle floors at 0 and does not offset the trip. Term 70.
  const r = read([charge, refund(30), { date: '2026-10-12', amount: -50, category: 'Gifts', payee: 'Invented gift shop' }]);
  assert.equal(r.term, 70, 'a refund only nets its own item');
}
{
  // A refund to the Savings account is in observed Savings, never the close.
  const r = read([charge, { ...refund(30), account: 'savings' }]);
  assert.equal(r.term, 100, 'a Savings-account refund does not credit the Bills close');
}
console.log('Linked refund: the close nets linked refunds per item, floored at zero.');
