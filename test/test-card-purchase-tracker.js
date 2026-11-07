'use strict';
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Detail = require('../public/bill-detail');
const Live = require('../scripts/live-plan');
const fixture = require('./fixtures/card-purchase-coverage-data');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Independent publication regression: an observed purchase is not evidence
// that its household coverage is known. No real owner rows or cents are used.
const unknown = fixture();
delete unknown.data.plan.cardPurchaseCoverage;
const observed = Live.fromObservation(unknown);
const packet = observed.data.liveOverlay.currentPeriodActuals;
const ledger = F.visaPaymentReconciliation(packet.transactions, {
  plan: unknown.data.plan, asOf: unknown.asOf, packet, debts: unknown.data.debts
});
assert.equal(ledger.status, 'unavailable');
assert.equal(ledger.reservedCash, null);
assert.equal(ledger.purchases[0].amount, 80);
assert(!Detail.visaPaymentsHtml([], ledger).includes('$80.00 to cover'),
  'unknown coverage must not present the observed purchase as a confirmed amount to cover');

function run(x) {
  const before = JSON.stringify(x), live = Live.fromObservation(x);
  const advice = F.recommend(live.data.plan, x.asOf, {
    debts: live.data.debts, currentPeriodActuals: live.data.liveOverlay.currentPeriodActuals
  });
  assert.equal(JSON.stringify(x), before, 'synthetic inputs remain immutable');
  const period = advice.payPeriodViews.find(p => p.start === '2026-09-18');
  const category = period.householdBudget.find(row => row.id === 'groceries');
  return { live, advice, period, category, tx: category.recon[0] };
}
function transfer(amount, confirm = true) {
  const x = fixture('backfill');
  x.payload.transactions[0].amount = 41.35;
  x.payload.transactions[1].amount = amount;
  x.payload.transactions[2].amount = -amount;
  x.payload.accounts[0].balance = 500 - amount;
  x.payload.accounts[3].balance = 441.35 - amount;
  if (confirm) fixture.confirm(x, 'invented-explicit-allocation', 80002, 80003, [[80001, amount]]);
  return x;
}
const source = fs.readFileSync(path.join(__dirname, '../public/plan.js'), 'utf8');
const metric = source.match(/^function householdBudgetMetric\([\s\S]*?\n\}/m)[0];
const render = vm.runInNewContext(metric + '\n householdBudgetMetric', {
  money2: amount => '$' + amount.toFixed(2), fmtDate: date => date
});
const html = r => render('Spent', r.category.spent, { recon: r.category.recon, id: 'groceries' });
const unconfirmed = run(unknown);
assert.equal(unconfirmed.tx.cardPurchaseCoverage.status, 'unconfirmed');
assert.equal(unconfirmed.tx.cardPurchaseCoverage.remaining, null);
assert.match(html(unconfirmed), /Coverage unconfirmed/);
assert.doesNotMatch(html(unconfirmed), /still to cover/);

const purchase = run(fixture());
assert.equal(purchase.tx.cardPurchaseCoverage.status, 'awaiting-coverage');
assert.equal(purchase.tx.cardPurchaseCoverage.remaining, 80);
assert.equal(purchase.category.remaining, 150 - 80);
assert.equal(purchase.period.liveCurrentBalance, 500);
assert.match(html(purchase), /is-card-coverage-open/);
assert.match(html(purchase), /Card purchase/);
assert.match(html(purchase), /\$80.00 still to cover/);

const partial = run(transfer(12.10)), full = run(transfer(41.35));
assert.equal(partial.tx.cardPurchaseCoverage.remaining, 29.25, '4135 - 1210 = 2925 cents');
assert.equal(partial.advice.cardPurchaseCoverage.reservedCash, 29.25);
assert.match(html(partial), /\$29.25 still to cover/);
assert.equal(full.tx.cardPurchaseCoverage.status, 'resolved');
assert.equal(full.tx.cardPurchaseCoverage.remaining, 0);
assert.doesNotMatch(html(full), /is-card-coverage-open/);
assert.match(html(full), /Invented grocer/);
assert.match(html(full), /\$41.35/);
for (const r of [partial, full]) {
  assert.equal(r.category.spent, 41.35, 'original purchase stays one category expense');
  assert.equal(r.category.remaining, 108.65);
  assert.equal(r.category.recon.length, 1, 'paired transfer is not another expense');
  assert.equal(r.period.fromTodayFunding.operatingBills, 25, 'backfill leaves scheduled minimum intact');
}
assert.equal(partial.period.liveCurrentBalance, 487.90);
assert.equal(full.period.liveCurrentBalance, 458.65);
assert.equal(full.live.data.debts[0].balance, 400);

// An equal-amount pair without explicit allocation does not clear the marker.
const ambiguous = run(transfer(41.35, false));
assert.equal(ambiguous.tx.cardPurchaseCoverage.status, 'unconfirmed');
assert.equal(ambiguous.tx.cardPurchaseCoverage.remaining, null);
assert.match(html(ambiguous), /Coverage unconfirmed/);
assert.doesNotMatch(html(ambiguous), /Coverage resolved|still to cover/);

const pending = fixture(); pending.payload.transactions[0].is_pending = true;
const pendingResult = run(pending);
assert.equal(pendingResult.category.spent, 80);
assert.equal(pendingResult.tx.pending, true);
assert.equal(pendingResult.tx.cardPurchaseCoverage.remaining, 80);
assert.match(html(pendingResult), /Pending/);
const pendingPair = transfer(41.35); pendingPair.payload.transactions[2].is_pending = true;
assert.equal(run(pendingPair).tx.cardPurchaseCoverage.status, 'unconfirmed');
const declared = transfer(41.35);
declared.data.plan.cardPurchaseCoverage.payments[0].confirmed = false;
assert.equal(run(declared).tx.cardPurchaseCoverage.status, 'unconfirmed', 'declared intent alone is not verified coverage');
const notObserved = transfer(41.35);
notObserved.payload.transactions = notObserved.payload.transactions.slice(0, 1);
assert.equal(run(notObserved).tx.cardPurchaseCoverage.status, 'unconfirmed', 'even declared confirmed intent needs both observed posted legs');

const refund = fixture();
refund.payload.transactions.push({ ...refund.payload.transactions[0], id: 80006, amount: -31.25,
  payee: 'Invented refund', category_name: 'Refund' });
refund.payload.accounts[3].balance = 448.75;
refund.data.plan.cardPurchaseCoverage.refunds = [{ confirmed: true,
  purchaseRef: fixture.ref(refund, 80001), refundRef: fixture.ref(refund, 80006) }];
const refunded = run(refund);
assert.equal(refunded.tx.cardPurchaseCoverage.remaining, 48.75, '8000 - 3125 = 4875 cents');
assert.equal(refunded.category.spent, 80);
assert.equal(refunded.category.recon.length, 1);
assert.equal(refunded.period.liveCurrentBalance, 500);
const fullRefund = structuredClone(refund);
fullRefund.payload.transactions[1].amount = -80;
fullRefund.data.plan.cardPurchaseCoverage.refunds[0].refundRef = fixture.ref(fullRefund, 80006);
assert.equal(run(fullRefund).tx.cardPurchaseCoverage.status, 'resolved');

// Current rows never hide older protected cash or relax whole-ledger trust.
const older = fixture();
older.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'invented-old-opening-row',
  accountId: 'travelvisa', date: '2026-09-10', amount: 22.45, covered: 0, categoryLabel: 'Groceries' }];
const carried = run(older);
assert.equal(carried.advice.cardPurchaseCoverage.reservedCash, 102.45);
assert.equal(carried.category.spent, 80, 'earlier purchase is not current category spending');
assert.equal(carried.category.recon.length, 1);
assert.equal(carried.advice.cardPurchaseCoverage.earlierPeriods.remaining, 22.45);
assert.doesNotMatch(Detail.visaPaymentsHtml([], carried.advice.cardPurchaseCoverage), /\$80\.00/);
// Opening carry predates the provider window and has no category transaction
// or new payment. Its protected cash still needs an explainable source.
const openingOnly = fixture('before');
openingOnly.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'invented-opening-only',
  accountId: 'travelvisa', date: '2026-09-10', amount: 30, covered: 0, categoryLabel: 'Groceries' }];
const openingResult = run(openingOnly), openingCoverage = openingResult.advice.cardPurchaseCoverage;
assert.equal(openingCoverage.status, 'ready');
assert.equal(openingCoverage.reservedCash, 30);
assert.equal(openingCoverage.payments.length, 0);
assert.equal(openingResult.category.spent, 0);
assert.equal(openingResult.category.recon.length, 0);
const openingHtml = Detail.visaPaymentsHtml([], openingCoverage);
assert.match(openingHtml, /Earlier periods/);
assert.match(openingHtml, /\$30\.00 still to cover/);
assert.match(openingHtml, /2026-09-10/);
assert.match(openingHtml, /Groceries/);
assert.doesNotMatch(openingHtml, /Card purchases to cover|invented-opening-only|travelvisa/);
const openingUnknown = structuredClone(openingOnly);
openingUnknown.data.plan.cardPurchaseCoverage.opening.confirmed = false;
const unknownCarry = run(openingUnknown).advice.cardPurchaseCoverage;
assert.equal(unknownCarry.status, 'unavailable');
assert.equal(unknownCarry.reservedCash, null);
assert.match(Detail.visaPaymentsHtml([], unknownCarry), /Coverage unconfirmed/);
assert.doesNotMatch(Detail.visaPaymentsHtml([], unknownCarry), /\$30\.00|still to cover|Coverage resolved/);
const openingCovered = structuredClone(openingOnly);
openingCovered.data.plan.cardPurchaseCoverage.opening.purchases[0].covered = 30;
assert.equal(run(openingCovered).advice.cardPurchaseCoverage.reservedCash, 0);
assert.equal(Detail.visaPaymentsHtml([], run(openingCovered).advice.cardPurchaseCoverage), '');
// A valid cutover need not align with payday. The period-boundary purchase
// is protected by the opening but has no observed category evidence.
const midCutover = fixture('before');
midCutover.data.plan.cardPurchaseCoverage.opening.asOf = '2026-09-19';
midCutover.payload.transactionWindow.startDate = '2026-09-19';
midCutover.data.plan.cardPurchaseCoverage.opening.purchases = [{ ref: 'invented-mid-cutover',
  accountId: 'travelvisa', date: '2026-09-18', amount: 21.37, covered: 0, categoryLabel: 'Groceries' }];
const midResult = run(midCutover), midCoverage = midResult.advice.cardPurchaseCoverage;
assert.equal(midCoverage.status, 'ready');
assert.equal(midCoverage.reservedCash, 21.37);
assert.equal(midResult.category.recon.length, 0);
assert.equal(midResult.category.spent, null, 'incomplete period coverage does not invent zero spend');
assert.equal(midResult.period.fromTodayFunding.status, 'unavailable');
assert.match(Detail.visaPaymentsHtml([], midCoverage), /2026-09-18.*Groceries.*\$21\.37 still to cover/);
// Observed current evidence replaces the fallback only by exact reference.
const observedOpening = fixture();
observedOpening.payload.transactions[0].date = '2026-09-18';
observedOpening.data.plan.cardPurchaseCoverage.opening.asOf = '2026-09-19';
observedOpening.data.plan.cardPurchaseCoverage.opening.purchases = [{
  ref: fixture.ref(observedOpening, 80001), accountId: 'travelvisa', date: '2026-09-18',
  amount: 80, covered: 0, categoryLabel: 'Groceries' }];
const observedOpeningResult = run(observedOpening);
assert.equal(observedOpeningResult.category.spent, 80);
assert.equal(observedOpeningResult.category.recon.length, 1);
assert.equal(observedOpeningResult.tx.cardPurchaseCoverage.remaining, 80);
assert.equal(observedOpeningResult.advice.cardPurchaseCoverage.earlierPeriods, null,
  'opening row already printed in its category is not duplicated');
// A named non-calendar category has no Budget row, so its provider row is
// not printed and cannot suppress the opening carry.
const hiddenCategory = structuredClone(observedOpening);
Object.assign(hiddenCategory.data.plan.budget.categories[0], { id: 'health', label: 'Health', from: ['Groceries'] });
delete hiddenCategory.data.plan.budget.categories[0].plannedPayday;
delete hiddenCategory.data.plan.budget.categories[0].plannedWeekly;
const hiddenLive = Live.fromObservation(hiddenCategory).data;
const hiddenAdvice = F.recommend(hiddenLive.plan, hiddenCategory.asOf,
  { debts: hiddenLive.debts, currentPeriodActuals: hiddenLive.liveOverlay.currentPeriodActuals });
assert.equal(hiddenAdvice.cardPurchaseCoverage.earlierPeriods.remaining, 80,
  'a provider row without a published category row cannot suppress opening evidence');
// A calendar category with no target this period still prints its confirmed
// spend on a $0-planned row, so the same $80 is counted once there and the
// opening carry does not repeat it.
const untargeted = structuredClone(observedOpening);
delete untargeted.data.plan.budget.categories[0].plannedPayday;
delete untargeted.data.plan.budget.categories[0].plannedWeekly;
const untargetedResult = run(untargeted);
assert.equal(untargetedResult.category.planned, 0, 'no target this period prints planned $0');
assert.equal(untargetedResult.category.spent, 80);
assert.equal(untargetedResult.category.hold, 80, 'hold = max(0, spent)');
assert.equal(untargetedResult.advice.cardPurchaseCoverage.earlierPeriods, null,
  'the untargeted row already prints the purchase; carry does not count it again');
const sameDay = fixture();
sameDay.data.plan.cardPurchaseCoverage.opening.asOf = '2026-09-19';
sameDay.payload.transactions[0].date = '2026-09-19';
assert.equal(run(sameDay).category.spent, 80);
assert.equal(run(sameDay).advice.cardPurchaseCoverage.earlierPeriods, null,
  'same-day cutover purchase belongs to its observed current category');
const equalAmount = structuredClone(midCutover);
equalAmount.payload.transactionWindow.startDate = '2026-09-18';
equalAmount.payload.transactions = [ { ...fixture().payload.transactions[0], amount: 21.37 } ];
const equalResult = run(equalAmount);
assert.equal(equalResult.category.spent, 21.37);
assert.equal(equalResult.advice.cardPurchaseCoverage.reservedCash, 42.74);
assert.equal(equalResult.advice.cardPurchaseCoverage.earlierPeriods.remaining, 21.37,
  'equal cents and category do not identify the opening purchase');
const midResolved = structuredClone(midCutover);
midResolved.data.plan.cardPurchaseCoverage.opening.purchases[0].covered = 21.37;
assert.equal(Detail.visaPaymentsHtml([], run(midResolved).advice.cardPurchaseCoverage), '');
const midUnknown = structuredClone(midCutover);
midUnknown.data.plan.cardPurchaseCoverage.opening.confirmed = false;
assert.match(Detail.visaPaymentsHtml([], run(midUnknown).advice.cardPurchaseCoverage), /Coverage unconfirmed/);
assert.doesNotMatch(Detail.visaPaymentsHtml([], run(midUnknown).advice.cardPurchaseCoverage), /\$21\.37|still to cover/);
const midHistory = structuredClone(midCutover);
midHistory.asOf = '2026-10-03';
midHistory.payload.fetchedAt = midHistory.asOf + 'T18:00:00Z';
midHistory.payload.transactionWindow.endDate = midHistory.asOf;
midHistory.payload.accounts.forEach(a => { a.updated_at = midHistory.asOf + 'T17:00:00Z'; a.balance_last_update = midHistory.asOf + 'T17:00:00Z'; });
const historyResult = run(midHistory);
const historyCurrent = historyResult.advice.payPeriodViews.find(p => p.start === '2026-10-02');
assert.equal(historyCurrent.householdBudget.find(r => r.id === 'groceries').spent, 0);
assert.equal(historyResult.advice.cardPurchaseCoverage.reservedCash, 21.37);
assert.match(Detail.visaPaymentsHtml([], historyResult.advice.cardPurchaseCoverage), /2026-09-18.*Groceries.*\$21\.37/);
const olderUnknown = transfer(41.35);
olderUnknown.payload.transactions.push({ ...olderUnknown.payload.transactions[0], id: 80007,
  date: '2026-09-19', amount: -7.15, category_name: 'Refund' });
const blocked = run(olderUnknown);
assert.equal(blocked.advice.cardPurchaseCoverage.status, 'unavailable');
assert.equal(blocked.tx.cardPurchaseCoverage.status, 'unconfirmed', 'unknown ledger prevents claiming a resolved purchase');
assert.equal(blocked.period.fromTodayFunding.availableNow, null);

const rolled = transfer(12.10);
rolled.asOf = '2026-10-03';
rolled.payload.fetchedAt = rolled.asOf + 'T18:00:00Z';
rolled.payload.transactionWindow.endDate = rolled.asOf;
rolled.payload.accounts.forEach(a => { a.updated_at = rolled.asOf + 'T17:00:00Z'; a.balance_last_update = rolled.asOf + 'T17:00:00Z'; });
rolled.payload.transactions.slice(1).forEach(tx => { tx.date = rolled.asOf; });
rolled.payload.transactions.push({ ...rolled.payload.transactions[0], id: 80008,
  date: rolled.asOf, amount: 9.80, payee: 'Invented next-period grocer' });
rolled.payload.accounts[3].balance = 439.05;
const acrossPeriods = run(rolled);
const newPeriod = acrossPeriods.advice.payPeriodViews.find(p => p.start === '2026-10-02');
const newCategory = newPeriod.householdBudget.find(r => r.id === 'groceries');
assert.equal(acrossPeriods.category.spent, 41.35);
assert.equal(acrossPeriods.tx.cardPurchaseCoverage.remaining, 29.25);
assert.equal(newCategory.spent, 9.80, 'new period shows only its own purchase expense');
assert.equal(newCategory.recon.length, 1);
assert.equal(newCategory.recon[0].cardPurchaseCoverage.remaining, 9.80);
assert.equal(acrossPeriods.advice.cardPurchaseCoverage.reservedCash, 39.05,
  '2925 carried cents plus 980 current cents; a new period never resets coverage');
assert.equal(acrossPeriods.advice.cardPurchaseCoverage.earlierPeriods.remaining, 29.25);
assert.equal(acrossPeriods.advice.cardPurchaseCoverage.earlierPeriods.cards[0].purchaseCount, 1,
  'current purchase is excluded from the earlier-period source');
const multipleCarry = structuredClone(openingOnly);
multipleCarry.data.plan.cardPurchaseCoverage.opening.purchases.push({ ref: 'invented-second-opening',
  accountId: 'travelvisa', date: '2026-09-12', amount: 22.45, covered: 12.10, categoryLabel: 'Groceries' });
const multipleCoverage = run(multipleCarry).advice.cardPurchaseCoverage;
assert.equal(multipleCoverage.earlierPeriods.remaining, 40.35, '3000 + 2245 - 1210 = 4035 cents');
assert.equal(multipleCoverage.earlierPeriods.cards.length, 1, 'one compact source per card, not a purchase list');
assert.equal(multipleCoverage.earlierPeriods.cards[0].purchaseCount, 2);
assert.equal(multipleCoverage.earlierPeriods.cards[0].latestDate, '2026-09-12');
assert.equal(multipleCoverage.earlierPeriods.cards[0].purchases[1].remaining, 10.35);
assert.match(Detail.visaPaymentsHtml([], multipleCoverage), /\$10\.35 still to cover/);
assert.equal(run(multipleCarry).category.spent, 0);
assert.equal(blocked.advice.cardPurchaseCoverage.earlierPeriods.remaining, null);
assert.equal(blocked.advice.cardPurchaseCoverage.earlierPeriods.cards.length, 0,
  'whole-ledger ambiguity withholds all precise carry claims');

// Cash transactions have no card marker; labels stay escaped, refs private.
const cash = fixture(); cash.payload.transactions[0].account_id = 3002;
assert.equal(run(cash).tx.cardPurchaseCoverage, undefined);
const malicious = fixture(); malicious.payload.transactions[0].payee = 'Invented <img onerror=alert(1)>';
assert.doesNotMatch(html(run(malicious)), /<img/);
for (const r of [purchase, partial, full, unconfirmed]) {
  assert.doesNotMatch(JSON.stringify(r.tx.cardPurchaseCoverage), /coverageRef|purchaseRef|transaction|80001/);
}
console.log('PASS card category markers: purchase/partial/full/refund/pending/ambiguity, cash/minimum/expense conservation, opening cutover/boundary/same-day/history, safe rendering');
