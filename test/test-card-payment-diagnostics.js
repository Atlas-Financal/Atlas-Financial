'use strict';
// Invented provider evidence, through the real observer and live-overlay path.
// 500 Bills cash + 400 card debt + 80 purchase - 80 transfer => 420 cash,
// 400 debt. Allocation publication must not change that independent ledger.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
function seed() {
  const x = fixture('backfill');
  x.payload.transactions.slice(1).forEach(tx => { tx.category_name = 'Payment, Transfer'; tx.notes = null; });
  return fixture.confirm(x, 'invented-explicit-allocation', 80002, 80003, [[80001, 80]]);
}
function run(x) {
  const before = JSON.stringify(x), observed = Live.fromObservation(x);
  const data = observed.data, packet = data.liveOverlay.currentPeriodActuals;
  const options = { debts: data.debts, currentPeriodActuals: packet };
  const advice = F.recommend(data.plan, x.asOf, options);
  const financialBefore = JSON.stringify(advice);
  const cycle = F.spendingCycle(data.plan, x.asOf);
  const pub = F.cardPeriodMovements(data.plan, data.debts, x.asOf, cycle, options);
  eq(JSON.stringify(F.recommend(data.plan, x.asOf, options)), financialBefore, 'diagnostics leave all Forecast money results unchanged');
  eq(JSON.stringify(x), before, 'provider input is immutable');
  const card = pub.cards.find(row => row.id === x.cardId);
  const payment = card.posted.find(row => row.paymentAllocation?.kind === 'payment')
    || card.posted.find(row => row.amount < 0);
  return { pub, card, payment, data, packet, advice };
}
const positive = run(seed());
eq(positive.payment.paymentAllocation?.status, 'reconciled', 'confirmed allocation appears on the exact posted card leg');
eq(positive.payment.paymentAllocation.backfill, 80, 'independently declared 8000 cents of purchase coverage');
eq(positive.payment.paymentAllocation.cardPayment, 0, 'no invented nonpurchase allocation');
eq(positive.payment.paymentAllocation.purchases, [{ date: '2026-09-20', amount: 80, categoryLabel: 'Groceries' }], 'only sanitized covered-purchase facts');
eq(positive.data.plan.startingCash.breakdown[0].value, 420, '500 - 80 Bills cash');
eq(positive.data.debts[0].balance, 400, '400 + 80 - 80 debt');
const period = positive.advice.payPeriodViews.find(row => row.start === '2026-09-18');
eq(period.householdBudget[0].spent, 80, 'purchase spending counts once');
eq(period.fromTodayFunding.operatingBills, 25, 'backfill does not prove issuer minimum satisfaction');
eq(period.fromTodayFunding.availableNow, 325, '420 - 25 minimum - 70 remaining grocery');

const unknownOpening = seed(); unknownOpening.data.plan.cardPurchaseCoverage.opening.confirmed = false;
const unknown = run(unknownOpening);
eq(unknown.advice.cardPurchaseCoverage.status, 'unavailable', 'unknown global opening still withholds readiness');
eq(unknown.payment.paymentAllocation.status, 'reconciled', 'observed explicit allocation survives unknown legacy opening');
eq(unknown.advice.paydayAllocation.available, null, 'diagnostics never promote available cash');

const other = seed();
other.data.debts.push({ id: 'cashback', label: 'Another invented card', structure: 'Revolving', balance: 90, pending: 0, rate: 0, limit: 1000 });
other.accountMap.mappings.push({ providerAccountId: 'invented-other-account', canonical: { collection: 'debts', id: 'cashback' }, atlasRole: 'revolving-credit' });
other.payload.accounts.push({ id: 'invented-other-account', name: 'Other invented provider card', type: 'credit', subtype: 'credit_card', currency: 'cad', balance: 90, updated_at: other.asOf + 'T17:00:00Z', balance_last_update: other.asOf + 'T17:00:00Z' });
other.payload.transactions.push({ id: 'invented-other-credit', account_id: 'invented-other-account', date: other.asOf, amount: -80, currency: 'cad', category_name: 'Credit Card Payment', payee: 'PAYMENT - THANK YOU', is_pending: false });
const isolated = run(other);
eq(isolated.advice.cardPurchaseCoverage.status, 'unavailable', 'unallocated other-card credit keeps global state unavailable');
eq(isolated.payment.paymentAllocation.status, 'reconciled', 'another card does not erase a qualifying allocation');
eq(isolated.pub.cards.find(row => row.id === 'cashback').posted[0].paymentAllocation.status, 'unreconciled', 'same-value other card never inherits the match');

const noIntent = seed(); noIntent.data.plan.cardPurchaseCoverage.payments = [];
noIntent.payload.transactions.push({ ...noIntent.payload.transactions[1], id: 'invented-equal-debit' });
const unresolved = run(noIntent);
eq(unresolved.payment.paymentAllocation.status, 'unreconciled', 'same amount/date/category and candidate cash legs cannot supply purpose');
eq(unresolved.payment.paymentAllocation.backfill, null, 'unknown allocation is not zero');

const split = seed(); split.payload.transactions[1].amount = 100; split.payload.transactions[2].amount = -100;
split.payload.accounts[0].balance = 400; split.payload.accounts[3].balance = 380;
Object.assign(split.data.plan.cardPurchaseCoverage.payments[0], { otherAmount: 20, otherPurpose: 'required-payment' });
const splitResult = run(split);
eq([splitResult.payment.paymentAllocation.backfill, splitResult.payment.paymentAllocation.cardPayment], [80, 20], '8000 + 2000 = 10000 allocated cents');
eq(splitResult.advice.payPeriodViews.find(row => row.start === '2026-09-18').fromTodayFunding.operatingBills, 25, 'household required-payment purpose still does not settle the issuer minimum');

const reversed = seed();
reversed.payload.transactions.push(
  { id: 'invented-card-reversal', account_id: 3004, date: reversed.asOf, amount: 20, currency: 'cad', category_name: 'Payment, Transfer', payee: 'Invented reversal', is_pending: false },
  { id: 'invented-cash-reversal', account_id: 3001, date: reversed.asOf, amount: -20, currency: 'cad', category_name: 'Payment, Transfer', payee: 'Invented reversal', is_pending: false });
reversed.payload.accounts[0].balance = 440; reversed.payload.accounts[3].balance = 420;
reversed.data.plan.cardPurchaseCoverage.reversals.push({ confirmed: true, paymentId: 'invented-explicit-allocation',
  cardDebitRef: fixture.ref(reversed, 'invented-card-reversal'), cashCreditRef: fixture.ref(reversed, 'invented-cash-reversal'),
  allocations: [{ purchaseRef: fixture.ref(reversed, 80001), amount: 20 }], otherAmount: 0 });
const reversal = run(reversed);
eq(reversal.card.posted.find(row => row.amount === 20).paymentAllocation.kind, 'reversal', 'verified reversal stays a separate posted movement');
eq(reversal.card.posted.find(row => row.amount === 20).paymentAllocation.backfill, 20, 'explicit 2000-cent reversal is reprinted');
eq(reversal.advice.cardPurchaseCoverage.reservedCash, 20, '8000 covered - 2000 reversed leaves 2000 protected');

for (const [label, mutate] of [
  ['pending cash leg', x => { x.payload.transactions[1].is_pending = true; }],
  ['pending card leg', x => { x.payload.transactions[2].is_pending = true; }],
  ['wrong unit', x => { x.payload.transactions[1].currency = 'usd'; }],
  ['duplicate provider row', x => { x.payload.transactions.push(structuredClone(x.payload.transactions[2])); }],
  ['duplicate owner record', x => { x.data.plan.cardPurchaseCoverage.payments.push(structuredClone(x.data.plan.cardPurchaseCoverage.payments[0])); }],
  ['reused legs', x => { x.data.plan.cardPurchaseCoverage.payments.push({ ...structuredClone(x.data.plan.cardPurchaseCoverage.payments[0]), id: 'invented-reused-legs' }); }],
]) {
  const x = seed(); mutate(x); const result = run(x);
  eq(result.card.posted.concat(result.card.pending).some(row => row.paymentAllocation?.status === 'reconciled'), false, label + ': no false confirmed allocation');
  eq(result.advice.cardPurchaseCoverage.status, 'unavailable', label + ': financial gate preserved');
}
const pendingReverse = structuredClone(reversed); pendingReverse.payload.transactions.at(-1).is_pending = true;
const pending = run(pendingReverse);
eq(pending.card.posted.find(row => row.amount === 20).paymentAllocation?.status, 'unreconciled', 'pending reversal counterpart cannot confirm reversal');
const duplicateReverse = structuredClone(reversed);
duplicateReverse.data.plan.cardPurchaseCoverage.reversals.push(structuredClone(duplicateReverse.data.plan.cardPurchaseCoverage.reversals[0]));
eq(run(duplicateReverse).card.posted.find(row => row.amount === 20).paymentAllocation.status, 'unreconciled', 'reused reversal legs never produce a false confirmation');

// Existing explicit household minimum intent and lender receipt are distinct
// from purchase allocation. Exercise both through the observer, without adding
// an exclusivity policy or manufacturing a consumer-only financial defect.
const minimum = seed();
minimum.data.plan.obligations[0].sentPayments = [{ intent: 'minimum', confirmed: true,
  pending: false, scheduledDate: minimum.asOf, postedOn: minimum.asOf, currency: 'cad',
  amount: 80, debitId: fixture.ref(minimum, 80002), fundingAccountId: 'chequing-a', cashIncludedAsOf: minimum.asOf }];
minimum.data.plan.opening.representedEvents = [{ id: 'travel', date: minimum.asOf }];
const independentMinimum = run(minimum);
eq(independentMinimum.payment.paymentAllocation.status, 'reconciled', 'qualifying purchase allocation remains visible alongside existing independent minimum evidence');
eq(F.cardMinimumState(independentMinimum.data.plan, minimum.asOf).payments[0].issuerMinimumStatus, 'satisfied', 'independent existing issuer receipt remains satisfied');

const untrustedPurpose = seed();
untrustedPurpose.data.plan.cardPurchaseCoverage.payments[0].otherPurpose = 'invented-private-evidence-ref';
eq(run(untrustedPurpose).payment.paymentAllocation.otherPurpose, null, 'unneeded arbitrary owner text is not published');

// Publication carries request-local row ids only, never allocation refs or source ids.
for (const result of [positive, unknown, isolated, unresolved, splitResult, reversal, pending]) {
  const printed = JSON.stringify(result.pub);
  eq(/pc-|coverageRef|purchaseRef|debitRef|creditRef|paymentId|parentRef|diagnosticCreditRef|8000[123]|invented-explicit-allocation|invented-other-account/.test(printed), false, 'private source and allocation identities stay internal');
}
console.log('PASS card payment diagnostics: ' + checks + ' synthetic provider/invariant checks');
