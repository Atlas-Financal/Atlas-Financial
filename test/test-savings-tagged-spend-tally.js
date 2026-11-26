'use strict';
// Tagged-spend tally on a savings item's bar (invented data only).
// The ledger's Paid (P = N + C - X) keeps its coverage/pending holds; the
// plain tally (spent, no stronger than calculated) sums resolved tagged
// purchases in the packet — posted and pending, a pending row counted once
// with its posted twin by the observer — minus posted tagged refunds,
// through two weeks after the item's own date, and reaches the bar as
// commitmentCost.taggedSpend even while Paid is withheld. It never
// relieves need, backing or Still to fund.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const { fixture, observe, raw, link } = require('./test-savings-link-foundation');
const NEAR = 'near@2026-10-21';
const cents = fact => fact.cents;

function tagged(txs, links) {
  const x = fixture();
  x.map.savingsLinks.links = links || [link('tag')];
  x.payload.transactions = txs;
  return x;
}
const ledgerOf = x => {
  const packet = observe(x);
  return { packet, ledger: F.savingsItemLedger(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet }) };
};
const item = ledger => ledger.items.find(row => row.occurrenceKey === NEAR);
const costOf = x => {
  const packet = observe(x);
  const advice = F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet, debts: [] });
  const pub = F.savingsFundingPublication(advice.savingsFunding, { asOf: x.asOf, advice });
  const items = [...(advice.savingsFunding.backing.items || []), ...(advice.savingsFunding.unresolved || [])];
  return { packet, advice, pub, item: items.find(row => row.key === NEAR) };
};
const bothLinked = txs => tagged(txs, [link('tag'), { ...link('tag', 'far', '2026-10-28'), tagId: 'invented-tag-far' }]);

{ // (a) complete coverage: a posted purchase already showed as Paid and tally.
  const { ledger } = ledgerOf(tagged([raw()]));
  assert.deepEqual([cents(item(ledger).paid), cents(item(ledger).spent), item(ledger).spent.trust], [1234, 1234, 'calculated']);
  const { item: costItem, pub } = costOf(bothLinked([raw()]));
  assert.equal(costItem.commitmentCost.taggedSpend.amount, 12.34);
  assert.equal(costItem.commitmentCost.confirmedLinkedPaid.amount, 12.34);
  assert.equal(pub.rows.find(row => row.key === 'group:club').commitmentCost.taggedSpend.amount, 12.34,
    'with one tag per item, the group bar aggregates each item tally once');
}
{ // (b) across a pay-period boundary within the window: the tally is not
  // reset by the period; a window that no longer covers the link start
  // withholds Paid but the observed tally in the packet still shows.
  const x = tagged([raw()]);
  x.asOf = '2026-11-05';
  x.payload.transactionWindow = { startDate: '2026-10-02', endDate: '2026-11-05', complete: true, hasMore: false };
  assert.equal(cents(item(ledgerOf(x).ledger).spent), 1234);
  const reset = tagged([raw()]);
  reset.asOf = '2026-11-05';
  reset.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false };
  const held = item(ledgerOf(reset).ledger);
  assert.deepEqual([cents(held.paid), cents(held.spent)], [null, 1234], 'Paid withheld, observed tally still on the bar');
}
{ // (c) pending with a posted twin counts once; pending alone counts as tally.
  const twin = tagged([raw({ id: 'invented-pending', is_pending: true }), raw()]);
  const twinLedger = ledgerOf(twin);
  assert.equal(twinLedger.packet.savingsLinks.evidence.length, 1, 'the observer counts the twin once');
  assert.deepEqual([cents(item(twinLedger.ledger).paid), cents(item(twinLedger.ledger).spent)], [1234, 1234]);
  const pending = tagged([raw({ is_pending: true })]);
  const held = item(ledgerOf(pending).ledger);
  assert.equal(cents(held.paid), null, 'Paid still withholds on pending evidence');
  assert.equal(cents(held.spent), 1234, 'the tally counts the pending purchase');
  const { item: costItem } = costOf(pending);
  assert.equal(costItem.commitmentCost.confirmedLinkedPaid.status, 'unavailable', 'Paid fact stays withheld on the row');
  assert.deepEqual(costItem.commitmentCost.taggedSpend, { status: 'known', amount: 12.34, range: null });
}
{ // (d) tagged refunds: a posted refund nets; a pending refund does not yet.
  const posted = tagged([raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04' })]);
  assert.deepEqual([cents(item(ledgerOf(posted).ledger).paid), cents(item(ledgerOf(posted).ledger).spent)], [7000, 7000]);
  const pendingRefund = tagged([raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04', is_pending: true })]);
  const held = item(ledgerOf(pendingRefund).ledger);
  assert.deepEqual([cents(held.paid), cents(held.spent)], [null, 10000], 'pending refund withheld from Paid and not yet netted');
}
{ // The tally stops two weeks after the item's own date (2026-10-21 + 14d),
  // even when the link interval runs longer; an unresolved row hides it.
  const links = [{ ...link('tag'), effectiveThrough: '2026-12-31' }];
  const late = tagged([raw({ id: 'late', date: '2026-11-02', amount: '20.00' })], links);
  late.asOf = late.data.meta.asOf = '2026-11-04'; late.payload.fetchedAt = '2026-11-04T12:00:00.000Z';
  late.payload.transactionWindow = { startDate: '2026-10-02', endDate: '2026-11-04', complete: true, hasMore: false };
  assert.equal(cents(item(ledgerOf(late).ledger).spent), 2000, '2026-11-02 is within two weeks of 2026-10-21');
  const beyond = tagged([raw({ id: 'late', date: '2026-11-05', amount: '20.00' })], links);
  beyond.asOf = beyond.data.meta.asOf = '2026-11-05'; beyond.payload.fetchedAt = '2026-11-05T12:00:00.000Z';
  beyond.payload.transactionWindow = { startDate: '2026-10-02', endDate: '2026-11-05', complete: true, hasMore: false };
  assert.equal(cents(item(ledgerOf(beyond).ledger).spent), 0, '2026-11-05 is past the two-week tally window');
  const unresolved = tagged([raw({ kind: 'transfer' })]);
  assert.equal(cents(item(ledgerOf(unresolved).ledger).spent), null, 'unresolved evidence never earns a tally');
}
{ // Tagged rows leave Household Budget and Other Spending in every state.
  for (const txs of [[raw()], [raw({ is_pending: true })],
    [raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04' })]]) {
    const x = tagged(txs), packet = observe(x);
    for (const tx of packet.transactions) {
      const cls = F.classifyCurrentPeriodTransaction(tx, x.plan, { packet, currentPeriodActuals: packet });
      assert.equal(cls.kind, 'savings-item');
      assert.equal(cls.householdSpending, false);
    }
  }
}
{ // The bar: with Paid withheld, the progress bar shows Spent over the goal
  // amount and stamps the spent amount; Paid and Still to fund are unchanged.
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  const { item: costItem } = costOf(tagged([raw({ is_pending: true })]));
  context.row = { ...costItem, saved: 0, savedTrust: 'calculated' };
  const html = vm.runInContext('budgetGoalPaidProgressHtml(row)', context);
  assert.match(html, /data-budget-goal-paid-progress="funding"/);
  assert.match(html, /data-budget-goal-spent-amount="12\.34"/);
  assert.match(html, /<small>Spent<\/small>[\s\S]*?\$12\.34 \/ \$60\.00/);
  assert.match(html, /data-budget-goal-paid><span class="budget-v3-unknown">Unknown<\/span>/, 'Paid stays Unknown');
  // Mutant: no taggedSpend fact -> no Spent line and no bar geometry from it.
  const mutant = JSON.parse(JSON.stringify(costItem));
  delete mutant.commitmentCost.taggedSpend;
  context.row = { ...mutant, saved: 0, savedTrust: 'calculated' };
  const mutantHtml = vm.runInContext('budgetGoalPaidProgressHtml(row)', context);
  assert.doesNotMatch(mutantHtml, /data-budget-goal-spent|data-budget-goal-bar-paid/);
}
console.log('Savings tagged-spend tally: (a)-(d), two-week window, Budget/Other exclusion and bar display passed.');
