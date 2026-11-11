'use strict';
// Isolated exact-identity counterexamples from the #591 review. These pass
// through the provider pipeline; no amount/date matching or policy is added.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const View = require('../public/budget-card-movements');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');
function sharedDebit() {
  const x = fixture('backfill');
  x.payload.transactions[0].amount = 30; x.payload.transactions[1].amount = 30; x.payload.transactions[2].amount = -30;
  x.payload.accounts[0].balance = 470;
  x.payload.transactions.slice(1).forEach(tx => { tx.category_name = 'Credit Card Payment'; tx.notes = null; });
  x.payload.transactions.push({ ...x.payload.transactions[0], id: 'invented-second-purchase' },
    { ...x.payload.transactions[2], id: 'invented-second-credit' });
  fixture.confirm(x, 'invented-first-payment', 80002, 80003, [[80001, 30]]);
  fixture.confirm(x, 'invented-second-payment', 80002, 'invented-second-credit', [['invented-second-purchase', 30]]);
  return x;
}
function parentReversal() {
  const x = fixture('backfill');
  x.payload.transactions[0].amount = 30; x.payload.transactions[1].amount = 30; x.payload.transactions[2].amount = -30;
  fixture.confirm(x, 'invented-parent-payment', 80002, 80003, [[80001, 30]]);
  x.data.plan.cardPurchaseCoverage.payments.push(structuredClone(x.data.plan.cardPurchaseCoverage.payments[0]));
  x.payload.transactions.push(
    { id: 'invented-dependent-card-reversal', account_id: 3004, date: x.asOf, amount: 10, currency: 'cad', category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false },
    { id: 'invented-dependent-cash-reversal', account_id: 3001, date: x.asOf, amount: -10, currency: 'cad', category_name: 'Credit Card Payment', payee: 'Invented reversal', is_pending: false });
  x.payload.accounts[0].balance = 480; x.payload.accounts[3].balance = 410;
  x.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'invented-parent-payment',
    cardDebitRef: fixture.ref(x, 'invented-dependent-card-reversal'), cashCreditRef: fixture.ref(x, 'invented-dependent-cash-reversal'),
    allocations: [{ purchaseRef: fixture.ref(x, 80001), amount: 10 }], otherAmount: 0 });
  return x;
}
function reversalLegs(mode) {
  const x = parentReversal(); x.data.plan.cardPurchaseCoverage.payments.pop();
  const original = x.data.plan.cardPurchaseCoverage.reversals[0], second = structuredClone(original);
  if (mode !== 'shared-card' && mode !== 'shared-both') {
    x.payload.transactions.push({ ...x.payload.transactions.find(tx => tx.id === 'invented-dependent-card-reversal'), id: 'invented-second-card-reversal' });
    second.cardDebitRef = fixture.ref(x, 'invented-second-card-reversal');
    x.payload.accounts[3].balance = 420;
  }
  if (mode !== 'shared-cash' && mode !== 'shared-both') {
    x.payload.transactions.push({ ...x.payload.transactions.find(tx => tx.id === 'invented-dependent-cash-reversal'), id: 'invented-second-cash-reversal' });
    second.cashCreditRef = fixture.ref(x, 'invented-second-cash-reversal');
    x.payload.accounts[0].balance = 490;
  }
  x.data.plan.cardPurchaseCoverage.reversals.push(second);
  return x;
}
function purchaseOverAllocation() {
  const x = sharedDebit();
  x.payload.transactions = x.payload.transactions.filter(tx => tx.id !== 'invented-second-purchase');
  x.payload.transactions.push({ ...x.payload.transactions.find(tx => tx.id === 80002), id: 'invented-independent-debit' });
  x.data.plan.cardPurchaseCoverage.payments[1].debitRef = fixture.ref(x, 'invented-independent-debit');
  x.data.plan.cardPurchaseCoverage.payments[1].allocations = [{ purchaseRef: fixture.ref(x, 80001), amount: 30 }];
  x.payload.accounts[0].balance = 440; x.payload.accounts[3].balance = 370;
  return x;
}
function allocationOverReversal() {
  const x = reversalLegs('unique');
  for (const tx of x.payload.transactions) if (String(tx.id).includes('reversal')) tx.amount = tx.amount > 0 ? 20 : -20;
  x.data.plan.cardPurchaseCoverage.reversals.forEach(row => { row.allocations[0].amount = 20; });
  x.payload.accounts[0].balance = 510; x.payload.accounts[3].balance = 440;
  return x;
}
function otherAllocationReversal(amount) {
  const x = reversalLegs('unique');
  x.payload.transactions.find(tx => tx.id === 80002).amount = 50;
  x.payload.transactions.find(tx => tx.id === 80003).amount = -50;
  Object.assign(x.data.plan.cardPurchaseCoverage.payments[0], { otherAmount: 20, otherPurpose: 'prior-debt' });
  for (const tx of x.payload.transactions) if (String(tx.id).includes('reversal')) tx.amount = tx.amount > 0 ? amount : -amount;
  x.data.plan.cardPurchaseCoverage.reversals.forEach(row => { row.allocations = []; row.otherAmount = amount; });
  x.payload.accounts[0].balance = 450 + 2 * amount; x.payload.accounts[3].balance = 380 + 2 * amount;
  return x;
}
function project(x) {
  const before = JSON.stringify(x), data = Live.fromObservation(x).data;
  const opts = { debts: data.debts, currentPeriodActuals: data.liveOverlay.currentPeriodActuals };
  const financial = JSON.stringify(F.recommend(data.plan, x.asOf, opts));
  const pub = F.cardPeriodMovements(data.plan, data.debts, x.asOf, F.spendingCycle(data.plan, x.asOf), opts);
  assert.equal(JSON.stringify(F.recommend(data.plan, x.asOf, opts)), financial);
  assert.equal(JSON.stringify(x), before);
  return pub.cards.find(row => row.id === 'travelvisa').posted;
}
let failures = 0, checks = 0;
function test(label, run) {
  try { run(); checks++; console.log('PASS ' + label); }
  catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.message); }
}
for (const reverse of [false, true]) {
  test('shared debit invalidates both diagnostics, ' + (reverse ? 'reversed' : 'original') + ' owner-record order', () => {
    const x = sharedDebit(); if (reverse) x.data.plan.cardPurchaseCoverage.payments.reverse();
    const rows = project(x).filter(row => row.amount < 0);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.paymentAllocation.status), ['unreconciled', 'unreconciled']);
    assert.deepEqual(rows.map(row => row.paymentAllocation.backfill), [null, null]);
  });
  test('ambiguous parent withholds its dependent reversal, ' + (reverse ? 'reversed' : 'original') + ' owner-record order', () => {
    const x = parentReversal(); if (reverse) x.data.plan.cardPurchaseCoverage.payments.reverse();
    const rows = project(x);
    assert.equal(rows.find(row => row.amount === -30).paymentAllocation.status, 'unreconciled');
    assert.equal(rows.find(row => row.amount === 10).paymentAllocation.status, 'unreconciled');
    assert.equal(rows.find(row => row.amount === 10).paymentAllocation.backfill, null);
  });
}
test('ambiguous publication is independent of owner-record order', () => {
  const x = sharedDebit(), reversed = structuredClone(x); reversed.data.plan.cardPurchaseCoverage.payments.reverse();
  const facts = rows => rows.filter(row => row.amount < 0).map(row => row.paymentAllocation);
  assert.deepEqual(facts(project(x)), facts(project(reversed)));
});
test('genuine unique parent and reversal remain confirmed', () => {
  const x = parentReversal(); x.data.plan.cardPurchaseCoverage.payments.pop();
  const rows = project(x);
  assert.equal(rows.find(row => row.amount === -30).paymentAllocation.status, 'reconciled');
  assert.equal(rows.find(row => row.amount === 10).paymentAllocation.status, 'reconciled');
  assert.equal(rows.find(row => row.amount === 10).paymentAllocation.backfill, 10);
});
test('two unique payment pairs can partially cover one purchase', () => {
  const x = fixture('backfill');
  x.payload.transactions[0].amount = 30; x.payload.transactions[1].amount = 15; x.payload.transactions[2].amount = -15;
  x.payload.accounts[0].balance = 470;
  x.payload.transactions.push({ ...x.payload.transactions[1], id: 'invented-distinct-cash' },
    { ...x.payload.transactions[2], id: 'invented-distinct-credit' });
  fixture.confirm(x, 'invented-partial-one', 80002, 80003, [[80001, 15]]);
  fixture.confirm(x, 'invented-partial-two', 'invented-distinct-cash', 'invented-distinct-credit', [[80001, 15]]);
  const payments = project(x).filter(row => row.amount < 0);
  assert.deepEqual(payments.map(row => row.paymentAllocation.status), ['reconciled', 'reconciled']);
  assert.deepEqual(payments.map(row => row.paymentAllocation.backfill), [15, 15]);
});
for (const mode of ['shared-cash', 'shared-card', 'shared-both', 'unique']) {
  for (const reverse of [false, true]) test(mode + ' reversal legs, ' + (reverse ? 'reversed' : 'original') + ' record order', () => {
    const x = reversalLegs(mode); if (reverse) x.data.plan.cardPurchaseCoverage.reversals.reverse();
    const reversals = project(x).filter(row => row.amount === 10);
    assert.equal(reversals.length, mode === 'shared-card' || mode === 'shared-both' ? 1 : 2);
    assert.equal(reversals.every(row => row.paymentAllocation.status === (mode === 'unique' ? 'reconciled' : 'unreconciled')), true);
    assert.equal(reversals.every(row => row.paymentAllocation.backfill === (mode === 'unique' ? 10 : null)), true);
  });
  test(mode + ' reversal certainty is independent of record order', () => {
    const x = reversalLegs(mode), reverse = structuredClone(x); reverse.data.plan.cardPurchaseCoverage.reversals.reverse();
    const facts = rows => rows.filter(row => row.amount === 10).map(row => row.paymentAllocation);
    assert.deepEqual(facts(project(x)), facts(project(reverse)));
  });
}
for (const [label, build, amount, collection] of [
  ['purchase over-allocation', purchaseOverAllocation, -30, 'payments'],
  ['parent allocation over-reversal', allocationOverReversal, 20, 'reversals'],
  ['other allocation over-reversal', () => otherAllocationReversal(15), 15, 'reversals'],
]) {
  for (const reverse of [false, true]) test(label + ', ' + (reverse ? 'reversed' : 'original') + ' record order', () => {
    const x = build(); if (reverse) x.data.plan.cardPurchaseCoverage[collection].reverse();
    const rows = project(x).filter(row => row.amount === amount);
    assert.equal(rows.length, 2);
    assert.equal(rows.every(row => row.paymentAllocation.status === 'unreconciled'), true);
    assert.equal(rows.every(row => row.paymentAllocation.backfill === null), true);
  });
  test(label + ' diagnostics are order-independent', () => {
    const x = build(), reverse = structuredClone(x); reverse.data.plan.cardPurchaseCoverage[collection].reverse();
    const facts = rows => rows.filter(row => row.amount === amount).map(row => row.paymentAllocation);
    assert.deepEqual(facts(project(x)), facts(project(reverse)));
  });
}
for (const reverse of [false, true]) test('disjoint partial other-allocation reversals, ' + (reverse ? 'reversed' : 'original') + ' order', () => {
  const x = otherAllocationReversal(10); if (reverse) x.data.plan.cardPurchaseCoverage.reversals.reverse();
  const rows = project(x).filter(row => row.amount === 10);
  assert.deepEqual(rows.map(row => row.paymentAllocation.status), ['reconciled', 'reconciled']);
  assert.deepEqual(rows.map(row => row.paymentAllocation.cardPayment), [10, 10]);
  assert.deepEqual(rows.map(row => row.paymentAllocation.backfill), [0, 0]);
});
test('allocation copy asserts no unsupported confirmation timing and states reversal direction', () => {
  const x = reversalLegs('unique'), rows = project(x);
  const pub = { schema: 'atlas-card-period-movements/v1', source: 'Forecast.cardPeriodMovements', currency: 'CAD',
    start: '2026-09-18', end: '2026-10-01', through: x.asOf, role: 'current', cards: [{ id: 'travelvisa', label: 'Invented Travel',
      netChange: { amount: null }, opening: null, closing: null, reportedBalance: null, reasons: [], posted: rows, pending: [],
      postedCoverage: 'complete-provider-response', pendingCoverage: 'complete-provider-response' }] };
  const html = View.html(pub, { money: amount => '$' + amount.toFixed(2), date: value => value });
  assert.doesNotMatch(html, /at posting|purpose at posting/i);
  assert.match(html, /Confirmed payment allocation: purchase coverage \$30\.00 \/ other allocation \$0\.00/);
  assert.match(html, /Confirmed allocation reversal: purchase coverage removed \$10\.00 \/ other allocation reversed \$0\.00/);
  assert.match(html, /Payment and reversal allocations are shown separately\./);
});
test('cautions print only where they apply: none on an empty panel, each one beside what it qualifies', () => {
  // Owner direction 2026-11-11 (#821 6786578829). The wording is unchanged;
  // only an empty panel, which has nothing to qualify, drops it.
  const PAYMENT = /Purpose unconfirmed: payments do not automatically settle scheduled minimums; lender confirmation remains separate\./;
  const ALLOCATION = /Payment and reversal allocations are shown separately\. This window does not establish historical coverage or available cash\. Issuer minimum satisfaction remains separate\./;
  const panel = card => View.html({ schema: 'atlas-card-period-movements/v1', source: 'Forecast.cardPeriodMovements', currency: 'CAD',
    start: '2026-09-18', end: '2026-10-01', through: '2026-09-24', role: 'current', cards: [{ id: 'travelvisa', label: 'Invented Travel',
      netChange: { amount: null }, opening: null, closing: null, reportedBalance: null, reasons: [],
      postedCoverage: 'complete-provider-response', pendingCoverage: 'complete-provider-response', ...card }] },
    { money: amount => '$' + amount.toFixed(2), date: value => value });
  const purchase = { id: 'invented-purchase', date: '2026-09-20', payee: 'Invented shop', kind: 'purchase', direction: 'up', magnitude: 12, pending: false };
  const empty = panel({ posted: [], pending: [] });
  assert.match(empty, /No posted movements returned in this period\./);
  assert.doesNotMatch(empty, PAYMENT);
  assert.doesNotMatch(empty, ALLOCATION);
  const moved = panel({ posted: [purchase], pending: [] });
  assert.match(moved, PAYMENT);
  assert.doesNotMatch(moved, ALLOCATION);
  const pendingOnly = panel({ posted: [], pending: [{ ...purchase, id: 'invented-pending', pending: true }] });
  assert.match(pendingOnly, PAYMENT);
  // An unreadable list is never an observed empty list: the caution stays.
  assert.match(panel({ posted: null, pending: [] }), PAYMENT);
  const allocated = panel({ posted: [{ ...purchase, id: 'invented-payment', kind: 'payment', direction: 'down',
    paymentAllocation: { status: 'unreconciled', kind: 'payment', backfill: null, cardPayment: null, reason: 'coverage-identity-ambiguous' } }], pending: [] });
  assert.match(allocated, PAYMENT);
  assert.match(allocated, ALLOCATION);
});
if (failures) { console.error(failures + ' dependency regressions failed'); process.exitCode = 1; }
else console.log('PASS ' + checks + ' isolated diagnostic dependency regressions');
module.exports = { sharedDebit, parentReversal, reversalLegs, purchaseOverAllocation, allocationOverReversal, otherAllocationReversal };
