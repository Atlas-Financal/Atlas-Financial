'use strict';
// Provider -> live overlay -> Forecast, with independent invented arithmetic.
const assert = require('node:assert/strict');
const F = require(process.env.ATLAS_PAYMENT_TRANSFER_FORECAST || '../public/forecast');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');

function confirmed(category = 'Payment, Transfer', kind = null) {
  const x = fixture('backfill');
  for (const tx of x.payload.transactions.slice(1)) {
    tx.category_name = category;
    tx.notes = null;
    if (kind) tx.kind = kind;
  }
  fixture.confirm(x, 'explicit-full', 80002, 80003, [[80001, 80]]);
  return x;
}
const LmGroups = require('./lm-groups-fixture.js');
function run(x) {
  const before = JSON.stringify(x);
  const plan = LmGroups.groupPlan(x.data.plan);
  const observed = Live.fromObservation({ ...x, data: { ...x.data, plan }, payload: LmGroups.groupPayload(x.payload, plan) });
  const packet = observed.data.liveOverlay.currentPeriodActuals;
  const advice = F.recommend(observed.data.plan, x.asOf, { debts: observed.data.debts,
    currentPeriodActuals: packet });
  assert.equal(JSON.stringify(x), before, 'no financial input mutation');
  const period = advice.payPeriodViews.find(p => p.start === '2026-09-18');
  return { observed, packet, advice, period, coverage: advice.cardPurchaseCoverage };
}
for (const [category, kind] of [['Payment, Transfer', null], ['Uncategorised', 'payment'],
  ['Uncategorised', 'bill-payment'], ['Uncategorised', 'transfer']]) {
  const state = run(confirmed(category, kind));
  assert.equal(state.coverage.status, 'ready', `${category}/${kind}: exact confirmed pair admitted`);
  assert.equal(state.coverage.reservedCash, 0);
  assert.equal(state.coverage.payments[0].backfill, 80);
  assert.equal(state.coverage.payments[0].satisfiesMinimum, false);
  assert.equal(state.period.householdBudget[0].spent, 80, 'the purchase is counted once');
  assert.equal(state.period.householdBudget[0].hold, 150, 'original category allowance unchanged');
  assert.equal(state.period.liveCurrentBalance, 420, 'posted Bills stock, no transfer replay');
  assert.equal(state.observed.data.debts[0].balance, 400, 'posted debt stock, no transfer replay');
  assert.equal(state.period.fromTodayFunding.operatingBills, 25, 'scheduled minimum still protected');
  // Independent cents: 420 cash - 25 minimum - 70 remaining grocery - 0 coverage.
  assert.equal(state.period.fromTodayFunding.availableNow, 325);
}

const partial = confirmed();
partial.payload.transactions[1].amount = 20; partial.payload.transactions[2].amount = -20;
partial.payload.accounts[0].balance = 480; partial.payload.accounts[3].balance = 460;
partial.data.plan.cardPurchaseCoverage.payments[0].allocations[0].amount = 20;
const partly = run(partial);
assert.equal(partly.coverage.status, 'ready');
assert.equal(partly.coverage.reservedCash, 60);
assert.equal(partly.period.fromTodayFunding.availableNow, 480 - 25 - 70 - 60);

const split = confirmed();
split.payload.transactions[1].amount = 100; split.payload.transactions[2].amount = -100;
split.payload.accounts[0].balance = 400; split.payload.accounts[3].balance = 380;
Object.assign(split.data.plan.cardPurchaseCoverage.payments[0], { otherAmount: 20, otherPurpose: 'required-payment' });
const allocated = run(split);
assert.equal(allocated.coverage.status, 'ready');
assert.equal(allocated.coverage.payments[0].backfill, 80);
assert.equal(allocated.coverage.payments[0].cardPayment, 20);
assert.equal(allocated.coverage.payments[0].satisfiesMinimum, false, 'other purpose is not issuer settlement evidence');
assert.equal(allocated.period.fromTodayFunding.operatingBills, 25);

const reversed = confirmed();
reversed.payload.transactions.push(
  { id: 80004, account_id: 3004, date: reversed.asOf, amount: 20, currency: 'cad', category_name: 'Payment, Transfer', payee: 'Invented reversal', is_pending: false },
  { id: 80005, account_id: 3001, date: reversed.asOf, amount: -20, currency: 'cad', category_name: 'Payment, Transfer', payee: 'Invented reversal', is_pending: false });
reversed.payload.accounts[0].balance = 440; reversed.payload.accounts[3].balance = 420;
reversed.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'explicit-full',
  cardDebitRef: fixture.ref(reversed, 80004), cashCreditRef: fixture.ref(reversed, 80005),
  allocations: [{ purchaseRef: fixture.ref(reversed, 80001), amount: 20 }], otherAmount: 0 });
const reversal = run(reversed);
assert.equal(reversal.coverage.status, 'ready');
assert.equal(reversal.coverage.reservedCash, 20);
assert.equal(reversal.period.householdBudget[0].spent, 80, 'reversal is not another purchase');
assert.equal(reversal.period.fromTodayFunding.availableNow, 440 - 25 - 70 - 20);
const pendingReversal = structuredClone(reversed); pendingReversal.payload.transactions.at(-1).is_pending = true;
assert.equal(run(pendingReversal).coverage.status, 'unavailable');

const refunded = structuredClone(partial);
refunded.payload.transactions.push({ id: 80004, account_id: 3004, date: refunded.asOf,
  amount: -20, currency: 'cad', category_name: 'Refund', payee: 'Invented grocer refund', is_pending: false });
refunded.payload.accounts[3].balance = 440;
refunded.data.plan.cardPurchaseCoverage.refunds.push({ confirmed: true,
  purchaseRef: fixture.ref(refunded, 80001), refundRef: fixture.ref(refunded, 80004) });
assert.equal(run(refunded).coverage.reservedCash, 40, 'explicit refund reduces uncovered principal once');
const unconfirmedRefund = structuredClone(refunded);
unconfirmedRefund.data.plan.cardPurchaseCoverage.refunds = [];
assert.equal(run(unconfirmedRefund).coverage.status, 'unavailable');

// Even exact category/amount/date and explicit backfill notes cannot supply intent.
for (const mutation of [
  x => { x.data.plan.cardPurchaseCoverage.payments = []; },
  x => { x.data.plan.cardPurchaseCoverage.payments[0].confirmed = false; },
  x => { x.data.plan.cardPurchaseCoverage.payments[0].debitRef = 'unknown-ref'; },
  x => { x.data.plan.cardPurchaseCoverage.payments[0].allocations[0].amount = 79.99; },
  x => { x.data.plan.cardPurchaseCoverage.payments[0].otherAmount = 1; },
  x => { x.data.plan.cardPurchaseCoverage.payments[0].otherAmount = 20; x.data.plan.cardPurchaseCoverage.payments[0].otherPurpose = 'guessed'; },
  x => { x.data.plan.cardPurchaseCoverage.payments.push(structuredClone(x.data.plan.cardPurchaseCoverage.payments[0])); },
  x => { x.data.plan.cardPurchaseCoverage.payments.push({ ...structuredClone(x.data.plan.cardPurchaseCoverage.payments[0]), id: 'reused-legs' }); },
  x => { x.payload.transactions[1].is_pending = true; },
  x => { x.payload.transactions[2].is_pending = true; },
  x => { x.payload.transactions[1].currency = 'usd'; },
  x => { x.payload.transactions[2].currency = null; },
  x => { x.payload.transactions[1].amount = 81; },
  x => { x.payload.transactions[1].account_id = 3002; },
  x => { x.payload.transactions[2].account_id = 3002; },
  x => { x.payload.transactions[1].category_name = 'Groceries'; x.payload.transactions[2].category_name = 'Groceries'; },
]) {
  const x = confirmed(); mutation(x);
  const state = run(x);
  assert.equal(state.coverage.status, 'unavailable', 'invalid evidence cannot authorize coverage');
  assert.equal(state.period.fromTodayFunding.availableNow, null);
}
const noIntent = confirmed(); noIntent.data.plan.cardPurchaseCoverage.payments = [];
noIntent.payload.transactions.slice(1).forEach(t => { t.notes = 'Backfill for this purchase; not minimum.'; });
assert.equal(run(noIntent).coverage.status, 'unavailable');
for (const key of ['transactionCoverage', 'pendingCoverage']) {
  const state = run(confirmed());
  const packet = { ...state.packet, [key]: 'incomplete' };
  const advice = F.recommend(state.observed.data.plan, state.observed.data.liveOverlay.asOf || noIntent.asOf,
    { debts: state.observed.data.debts, currentPeriodActuals: packet });
  assert.equal(advice.cardPurchaseCoverage.status, 'unavailable');
  assert.equal(advice.paydayAllocation.available, null);
}
for (const mutation of [
  packet => { Object.assign(packet.transactions.find(t => t.amount < 0), { atlasAccountId: 'cashback', account: 'cashback' }); },
  packet => { packet.transactions.find(t => t.amount < 0).pendingPostedAmbiguous = true; },
]) {
  const state = run(confirmed()), packet = structuredClone(state.packet);
  mutation(packet);
  const ledger = F.visaPaymentReconciliation(packet.transactions, { plan: state.observed.data.plan,
    debts: state.observed.data.debts, packet, asOf: noIntent.asOf });
  assert.equal(ledger.status, 'unavailable', 'different card or ambiguous replacement cannot authorize a pair');
}

// An unrelated cash transfer remains outside card confirmation requirements.
const unrelated = fixture('purchase');
unrelated.payload.transactions.push({ id: 89999, account_id: 3001, date: unrelated.asOf,
  amount: 10, currency: 'cad', category_name: 'Payment, Transfer', kind: 'transfer',
  payee: 'Invented Savings transfer', is_pending: false });
const separate = run(unrelated);
assert.equal(separate.coverage.status, 'ready');
assert.equal(separate.coverage.reservedCash, 80);

console.log('PASS explicitly confirmed provider payment/transfer legs; independent cash/spending/minimum conservation and negative controls');
