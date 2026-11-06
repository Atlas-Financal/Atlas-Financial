'use strict';
// Astra audit A4 (#787 6684193703): a card minimum the card ledger already
// covered with a posted payment (#849 minimumCoverage[]) must not stay
// "still due" in the Bills close and be deducted a second time.
// Invented world (test/fixtures/card-coverage-aggregate-world.js): Bills 500,
// card 400, groceries allowance 150, a 25 card minimum due on the as-of, one
// 80 grocery purchase on the card. Every expected figure is written by hand.
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

const purchase = ['card', 80, null, 'purchase'];
const pay = (from, amount) => [[from, amount, null, 'cash'], ['card', -amount, null, 'credit']];
const close = rows => {
  const s = run(world(rows, rows.some(r => r[0] === 'savings') ? { savingsOpening: 1000 } : {}));
  const bills = s.advice.defaultView.billsAccountPeriodBalance;
  assert.equal(bills.status, 'ready', JSON.stringify(bills.issues));
  return { s, bills };
};

// Uncovered minimum: unchanged from main (no holder fact releases it). 500 - 25 minimum - 150 hold = 325.
{
  const { s, bills } = close([purchase]);
  assert.equal(s.coverage.minimumCoverage[0].status, 'to-confirm');
  assert.equal(bills.remainingBills, 25, 'the uncovered minimum stays due');
  assert.deepEqual(bills.coveredMinimums, []);
  assert.equal(bills.amount, 325);
}
// Covered exactly: the 25 left Bills once, in posted cash (475). The minimum is
// Paid with the payment as evidence and is not deducted again: 475 - 150 = 325.
{
  const { bills } = close([purchase, ...pay('bills', 25)]);
  assert.equal(bills.observedCash, 475);
  assert.equal(bills.remainingBills, 0, 'a covered minimum is not still due');
  assert.deepEqual(bills.coveredMinimums.map(m => [m.id, m.status, m.due, m.covered, m.remaining, m.paymentIds]),
    [['travel', 'paid', 25, 25, 0, ['coverage-payment-1']]]);
  assert.equal(bills.amount, 325, 'no double deduction (main closed at 300)');
}
// Partial: 20 paid leaves only the 5 remainder due: 480 - 5 - 150 = 325.
{
  const { bills } = close([purchase, ...pay('bills', 20)]);
  assert.equal(bills.remainingBills, 5, 'only the uncovered remainder stays due');
  assert.deepEqual(bills.coveredMinimums.map(m => [m.status, m.covered, m.remaining]), [['partial', 20, 5]]);
  assert.equal(bills.amount, 325, 'main closed at 305');
}
// Full payment of minimum + purchases from Bills: 395 cash, the 80 is
// household funding already made (hold 150 - 80 = 70): 395 - 0 - 70 = 325.
{
  const { bills } = close([purchase, ...pay('bills', 105)]);
  assert.equal(bills.remainingBills, 0);
  assert.equal(bills.household.remaining, 70);
  assert.equal(bills.amount, 325);
}
// Paid from Savings: Bills cash is untouched (500) and no Bills cash is due
// for the minimum: 500 - 0 - 70 = 430.
{
  const { bills } = close([purchase, ...pay('savings', 105)]);
  assert.equal(bills.observedCash, 500);
  assert.equal(bills.remainingBills, 0);
  assert.equal(bills.amount, 430);
}
// Conservation: across every payment size the money leaves Bills exactly once,
// so the close equals the no-payment close (Bills-funded cases).
for (const amount of [0, 5, 20, 25, 50, 105, 125]) {
  const rows = amount ? [purchase, ...pay('bills', amount)] : [purchase];
  const { s, bills } = close(rows);
  const excess = s.coverage.payments.reduce((sum, p) => sum + (p.cardPayment || 0), 0);
  assert.equal(bills.observedCash, 500 - amount, amount + ': posted cash');
  assert.equal(Math.round((bills.amount + excess) * 100), 32500, amount + ': cash counted once');
  // Every consumer agrees: the Bills close, its calendar, the from-today walk
  // and the period-view Bills list. Any one still deducting a covered minimum
  // fails here.
  const covered = Math.min(amount, 25), left = 25 - covered;
  assert.equal(s.period.fromTodayFunding.availableNow, bills.amount, amount + ': walk equals Bills close');
  const row = s.period.bills.filter(r => r.id === 'travel');
  assert.equal(row.length, 1, amount + ': one period-list row');
  assert.equal(row[0].remaining, left, amount + ': period list remainder');
  assert.equal(row[0].status === 'PAID', left === 0, amount + ': period list Paid iff fully covered');
  assert.equal(bills.remainingBills, left, amount + ': Bills close remainder');
  assert.deepEqual(bills.coveredMinimums.map(m => m.remaining), covered ? [left] : [], amount + ': calendar evidence');
  if (covered) assert.deepEqual(row[0].minimumCoverage.paymentIds, ['coverage-payment-1'], amount + ': payment evidence');
}
// A pending payment does not cover the minimum: it stays due as on main.
{
  const s = run(world([purchase, ['bills', 25, null, 'cash', { is_pending: true }],
    ['card', -25, null, 'credit', { is_pending: true }]]));
  const bills = s.advice.defaultView.billsAccountPeriodBalance;
  assert.notEqual(s.coverage.minimumCoverage[0]?.status, 'covered-by-payment');
  assert.deepEqual(bills.coveredMinimums || [], []);
}
console.log('bills covered minimum once: ok');
