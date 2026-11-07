'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Detail = require('../public/bill-detail');
const source = require('./fixtures/card-backfill-data');
const coverageFixture = require('./fixtures/card-purchase-coverage-data');
function fixture(...args) {
  const x=source(...args);
  x.data.plan.cardPurchaseCoverage=coverageFixture('before').data.plan.cardPurchaseCoverage;
  x.payload.transactions.forEach(t=>{t.currency='cad';});
  coverageFixture.confirm(x,'confirmed-invented-backfill',80002,80003,[[80001,80]]);
  return x;
}
const canonicalBefore = fs.readFileSync(require.resolve('../data.json'), 'utf8');
const cards = [['travelvisa', 'travel'], ['cashback', 'cashback'], ['tdcc', 'tdcc'],
  ['triangle', 'triangle'], ['mbna', 'mbna']];
function run(x) {
  const before = JSON.stringify(x);
  const result = Live.fromObservation(x);
  assert.equal(result.data.liveOverlay.applied, true);
  assert.equal(JSON.stringify(x), before, 'observation and inputs remain immutable');
  const advice = F.recommend(result.data.plan, x.asOf, { debts: result.data.debts,
    currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals });
  const period = advice.payPeriodViews.find(row => row.start === '2026-09-18');
  const bill = advice.defaultView.bills.find(row => row.id === x.eventId);
  return { ...result, advice, period, bill };
}
function unconfirmed(x) {
  const r = run(x);
  assert.equal(r.report.representedEventCandidates.filter(row => row.id === x.eventId).length, 0);
  assert.equal(r.report.currentPeriodActuals.representedActuals.filter(row => row.id === x.eventId).length, 0);
  assert.equal(r.data.plan.opening.representedEvents.filter(row => row.id === x.eventId).length, 0);
  assert.notEqual(r.bill.status, 'PAID');
  assert.equal(r.bill.remaining, 25, 'only the existing scheduled minimum remains reserved');
  if (r.advice.cardCoverageUnavailable) {
    assert.equal(r.period.fromTodayFunding.status,'unavailable');
    assert.equal(r.period.fromTodayFunding.contribution,null,'ambiguous coverage cannot authorize funding');
  } else assert.equal(r.period.fromTodayFunding.operatingBills, 25);
  return r;
}
for (const [card, event] of cards) {
  const x = fixture(card, event);
  const r = unconfirmed(x);
  // Independent double-entry ledger: 500 - 80 = 420; 400 + 80 - 80 = 400.
  assert.equal(r.data.plan.startingCash.breakdown[0].value, 420);
  assert.equal(r.data.debts[0].balance, 400);
  assert.equal(r.period.householdBudget[0].spent, 80);
  assert.equal(r.period.householdBudget[0].remaining, 70, '150 allowance - 80 consumption');
  assert.equal(r.period.householdBudget[0].recon.length, 1, 'transfer legs are not expenses');
  assert.equal(r.period.totalBillsThisPeriod, 25, 'backfill 80 is not a minimum-payment actual');
  assert.equal(r.period.paidBills, 0);
  assert.equal(r.period.fromTodayFunding.availableNow, 420 - 25 - 70);
  assert.deepEqual(Detail.evidence(r.bill, r.data).payments, [],
    'backfill is not linked as minimum-payment evidence in the real bill sheet');
  assert.match(Detail.html(r.bill, r.data), /Missing evidence does not mean unpaid/);
  assert.deepEqual(run(x).advice, r.advice, 'repeated observation cannot accumulate movements');
  for (const note of [null, 'Minimum payment', 'not a backfill', 'purchase backfill', 'minimum and backfill']) {
    const ambiguous = fixture(card, event);
    ambiguous.payload.transactions.forEach(tx => { tx.notes = note; });
    unconfirmed(ambiguous); // Free text is not an approved intent schema.
  }
  for (const amount of [25, 80, 200]) {
    const ambiguous = fixture(card, event);
    ambiguous.payload.transactions[1].amount = amount;
    ambiguous.payload.transactions[2].amount = -amount;
    ambiguous.payload.accounts[0].balance = 500 - amount;
    ambiguous.payload.accounts[3].balance = 400 + 80 - amount;
    unconfirmed(ambiguous); // Exact amount and excess are both insufficient.
  }
  // Independent issuer/owner evidence confirms this exact occurrence using
  // the established input, even when the observed payment is a backfill.
  const confirmed = fixture(card, event);
  confirmed.data.plan.opening.representedEvents = [{ id: event, date: confirmed.asOf }];
  const paid = run(confirmed);
  assert.equal(paid.bill.status, 'PAID');
  assert.equal(paid.bill.remaining, 0, 'proven issuer settlement is preserved');
  assert.equal(paid.period.fromTodayFunding.operatingBills, 0);
  assert.equal(paid.period.householdBudget[0].spent, 80);
  assert.equal(paid.report.representedEventCandidates.length, 0,
    'confirmation is not manufactured transaction linkage or payment intent');
  assert.equal(paid.data.debts[0].balance, 400, 'no second liability is invented');
  const wrongDate = fixture(card, event);
  wrongDate.data.plan.opening.representedEvents = [{ id: event, date: '2026-09-21' }];
  assert.notEqual(run(wrongDate).bill.status, 'PAID', 'confirmation cannot settle a different occurrence');
}
for (const payee of ['PAYMENT - THANK YOU REFUND', 'PAYMENT - THANK YOU REVERSAL', 'Invented refund']) {
  const x = fixture();
  x.payload.transactions = [x.payload.transactions[2]];
  x.payload.transactions[0].payee = payee;
  unconfirmed(x);
}
const refund = fixture();
refund.payload.transactions.push({ id: 80004, account_id: 3004, date: refund.asOf,
  amount: -20, currency: 'cad', payee: 'Invented grocer', category_name: 'Groceries', is_pending: false });
refund.payload.accounts[3].balance = 380;
const refunded = unconfirmed(refund);
// G3a (acceptance 7.8; lead ruling 2026-11-06, disclosed in PR #856): the
// posted -20 Groceries card credit is an identified Groceries refund and
// nets in the Budget row: 80 - 20 = 60 (main: 80). It is never a second
// purchase (never 100) and never income or Other.
const refundedGroceries = refunded.period.householdBudget[0];
assert.equal(refundedGroceries.spent, 60, 'an identified Groceries card refund nets the Budget row once');
assert.notEqual(refundedGroceries.spent, 100, 'a refund never becomes a second purchase');
assert.deepEqual(refundedGroceries.recon.map(r => r.amount).sort((a, b) => a - b), [-20, 80],
  'the drill-down lists the purchase and its refund once each');
assert.equal(refunded.data.debts[0].balance, 380);
// Card side, once only (lead condition): category netting changes no card or
// cash figure. Hand values below equal main's output for this fixture: the
// card ledger keeps the 80 purchase covered by its 80 backfill with nothing
// refunded against coverage, and cash is not credited by a card refund.
{
  const packet = refunded.data.liveOverlay.currentPeriodActuals;
  const pub = F.visaPaymentReconciliation(packet.transactions,
    { plan: refunded.data.plan, asOf: refund.asOf, packet, debts: refunded.data.debts });
  assert.deepEqual(pub.purchases.map(p => [p.amount, p.covered, p.refunded, p.remaining]), [[80, 80, 0, 0]],
    'card coverage is unchanged by category netting');
  assert.deepEqual(pub.payments.map(p => [p.amount, p.backfill, p.cardPayment]), [[80, 80, 0]]);
  assert.deepEqual(pub.issues.map(i => i.code), ['coverage-payment-or-credit-purpose-unconfirmed']);
  assert.equal(refunded.data.plan.startingCash.breakdown[0].value, 420, 'a card refund credits no cash');
}

const pending = fixture();
pending.payload.transactions[0].is_pending = true;
pending.payload.accounts[3].balance = 320; // 400 old debt - 80 transfer; 80 still pending.
const pend = unconfirmed(pending);
assert.equal(pend.period.householdBudget[0].spent, 80);
assert.equal(pend.data.debts[0].balance, 320);
assert.equal(pend.data.debts[0].pending, 80);
const posted = fixture();
const post = unconfirmed(posted);
assert.equal(post.data.debts[0].balance + post.data.debts[0].pending,
  pend.data.debts[0].balance + pend.data.debts[0].pending);
assert.equal(post.period.householdBudget[0].spent, pend.period.householdBudget[0].spent);

// Directed pending->posted identity must not inherit minimum settlement.
const replacement = fixture();
replacement.payload.transactions.push({ ...replacement.payload.transactions[2],
  id: 80005, is_pending: true, date: '2026-09-19', plaid_transaction_id: 'invented-pending' });
replacement.payload.transactions[2].plaid_pending_transaction_id = 'invented-pending';
unconfirmed(replacement);
const pendingPayment = fixture();
pendingPayment.payload.transactions[1].is_pending = true;
pendingPayment.payload.transactions[2].is_pending = true;
pendingPayment.payload.accounts[0].balance = 500;
pendingPayment.payload.accounts[3].balance = 480;
unconfirmed(pendingPayment);

const overdue = fixture();
overdue.data.plan.obligations[0].date = '2026-09-19';
assert.equal(unconfirmed(overdue).bill.settlement, 'unverified',
  'elapsed minimum remains unverified rather than claiming an unpaid lender obligation');
const issuerConfirmed = fixture();
issuerConfirmed.data.plan.obligations[0].date = '2026-09-25';
issuerConfirmed.data.plan.opening.representedEvents = [{ id: issuerConfirmed.eventId, date: '2026-09-25' }];
assert.equal(run(issuerConfirmed).bill.remaining, 0, 'exact prepaid issuer confirmation also survives refresh');

// Exercise the incumbent Budget printer with actual observer -> Forecast
// outputs. No financial formatting or UI changes are made by this repair.
const screen = run(fixture());
const context = vm.createContext({ Forecast: F, BillDetail: Detail, console, addEventListener() {},
  document: { addEventListener() {}, querySelectorAll() { return []; },
    getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' } });
vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
vm.runInContext('App.boot = () => {};', context);
vm.runInContext(fs.readFileSync(require.resolve('../public/plan.js'), 'utf8'), context);
context.row = screen.period; context.plan = screen.data.plan;
context.overlay = screen.data.liveOverlay; context.alloc = screen.advice.paydayAllocation;
const html = vm.runInContext('calendarWaterfallHtml(row, overlay, alloc, plan)', context);
assert.match(html, /Current chequing cash<\/span><span>\$420\.00/);
assert.match(html, /Remaining bills and debt payments<\/span><span>\$25\.00/);
assert.match(html, /Remaining household needs<\/span><span>\$70\.00/);

// Guard both observation/reconciliation and direct identity helper. A different
// mapped revolving card inherits this safety without an event-name whitelist.
const renamed = fixture('invented-card', 'invented-minimum');
renamed.identity = { rules: [{ eventId: renamed.eventId, atlasAccountId: renamed.cardId,
  payeePattern: 'PAYMENT - THANK YOU', direction: 'credit', settlesWhen: 'amount-at-least' }] };
unconfirmed(renamed);
const normalized = O.normalizeLunchMoneyTransaction(renamed.payload.transactions[2]);
assert.deepEqual(O.representedEventCandidates({ plan: renamed.data.plan,
  transactions: [normalized], accountMap: renamed.accountMap, identityRules: renamed.identity.rules }), []);
assert.equal(fs.readFileSync(require.resolve('../data.json'), 'utf8'), canonicalBefore);
console.log('test-card-backfill-intent: independent purchase/transfer/minimum/refund/pending/ambiguity PASS');
