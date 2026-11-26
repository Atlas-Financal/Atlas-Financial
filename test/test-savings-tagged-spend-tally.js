'use strict';
// Tagged-spend tally on a savings item's bar (invented data only).
// The ledger's Paid (P = N + C - X) keeps its coverage/pending holds; the
// plain tally (spent, no stronger than calculated) sums resolved tagged
// purchases in the packet — posted and pending, a pending row counted once
// with its posted twin by the observer — minus posted tagged refunds,
// through two weeks after the item's own date, and reaches the bar as
// commitmentCost.taggedSpend even while Paid is withheld. It counts TAG
// evidence only, labels pending purchases as pending, is withheld (never a
// partial amount or zero) when the link's history is not complete in the
// packet, and drives the bar's tagged segment (not Paid). It never
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
  // reset by the period. When the window rolls past the link start, rows
  // before it are gone from the packet: the tally is WITHHELD (unknown, not a
  // partial amount and not zero), whether or not a stale row is still in the
  // input; Paid is withheld the same way.
  const x = tagged([raw()]);
  x.asOf = '2026-11-05';
  x.payload.transactionWindow = { startDate: '2026-10-02', endDate: '2026-11-05', complete: true, hasMore: false };
  assert.equal(cents(item(ledgerOf(x).ledger).spent), 1234, 'complete window keeps the earlier purchase');
  for (const txs of [[raw()], []]) {
    const rolled = tagged(txs);
    rolled.asOf = '2026-11-05';
    rolled.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false };
    const held = item(ledgerOf(rolled).ledger);
    assert.deepEqual([cents(held.paid), cents(held.spent), held.spent.trust], [null, null, 'unknown'],
      'a rolled window withholds the tally: never a partial amount, never zero');
  }
  // The same tag link with a complete window and genuinely no tagged rows is a known zero.
  const none = tagged([]);
  assert.equal(cents(item(ledgerOf(none).ledger).spent), 0);
  const { item: rolledCost } = costOf((() => { const r = tagged([]); r.asOf = '2026-11-05';
    r.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false }; return r; })());
  assert.equal(rolledCost.commitmentCost.taggedSpend, undefined, 'no taggedSpend fact reaches the bar when withheld');
}
{ // (c) pending with a posted twin counts once; pending alone counts as tally.
  const twin = tagged([raw({ id: 'invented-pending', is_pending: true }), raw()]);
  const twinLedger = ledgerOf(twin);
  assert.equal(twinLedger.packet.savingsLinks.evidence.length, 1, 'the observer counts the twin once');
  assert.deepEqual([cents(item(twinLedger.ledger).paid), cents(item(twinLedger.ledger).spent)], [1234, 1234]);
  assert.equal(item(twinLedger.ledger).spent.pendingCents, 0, 'the posted twin is not also counted as pending');
  const pending = tagged([raw({ is_pending: true })]);
  const held = item(ledgerOf(pending).ledger);
  assert.equal(cents(held.paid), null, 'Paid still withholds on pending evidence');
  assert.equal(cents(held.spent), 1234, 'the tally counts the pending purchase');
  assert.equal(held.spent.pendingCents, 1234, 'and labels it pending');
  const { item: costItem } = costOf(pending);
  assert.equal(costItem.commitmentCost.confirmedLinkedPaid.status, 'unavailable', 'Paid fact stays withheld on the row');
  assert.deepEqual(costItem.commitmentCost.taggedSpend, { status: 'known', amount: 12.34, range: null, pendingAmount: 12.34 });
}
{ // (d) tagged refunds: a posted refund nets; a pending refund does not yet.
  const posted = tagged([raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04' })]);
  assert.deepEqual([cents(item(ledgerOf(posted).ledger).paid), cents(item(ledgerOf(posted).ledger).spent)], [7000, 7000]);
  const pendingRefund = tagged([raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04', is_pending: true })]);
  const held = item(ledgerOf(pendingRefund).ledger);
  assert.deepEqual([cents(held.paid), cents(held.spent)], [null, 10000], 'pending refund withheld from Paid and not yet netted');
  assert.equal(held.spent.pendingRefundCents, 3000, 'the un-netted pending refund is labelled');
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
{ // The bar, through the real renderers: plan.js budgetGoalPaidProgressHtml
  // prints the stamps and segment; budget-blend.js goalBarTaggedAmount (the
  // visible band's input) reads the same stamps. The tagged segment follows the
  // tally, not Paid; Paid, Still to fund and their text are unchanged.
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  // budget-blend.js loaded with a loading-state stub document so it only exports.
  const blend = { module: { exports: {} }, document: { readyState: 'loading', addEventListener() {} }, console, setTimeout, clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInContext(script('budget-blend'), vm.createContext(Object.assign(blend, { window: blend })));
  const { goalBarTaggedAmount } = blend.module.exports;
  const render = costItem => {
    context.row = { ...costItem, saved: 0, savedTrust: 'calculated' };
    const html = vm.runInContext('budgetGoalPaidProgressHtml(row)', context);
    const attrs = Object.fromEntries([...html.slice(0, html.indexOf('>')).matchAll(/ (data-[a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    return { html, band: goalBarTaggedAmount({ getAttribute: name => attrs[name] ?? null }),
      segment: (html.match(/data-budget-goal-bar-paid style="--goal-paid:([0-9.]+)"/) || [])[1] ?? null };
  };
  const dated = (txs, links, through) => {
    const x = tagged(txs, links);
    x.asOf = x.data.meta.asOf = through; x.payload.fetchedAt = through + 'T12:00:00.000Z';
    x.payload.transactionWindow = { startDate: '2026-10-02', endDate: through, complete: true, hasMore: false };
    return x;
  };

  { // Pending-only tally with Paid withheld: Spent over the goal, labelled pending.
    const { item: costItem } = costOf(tagged([raw({ is_pending: true })]));
    const out = render(costItem);
    assert.match(out.html, /data-budget-goal-paid-progress="funding"/);
    assert.match(out.html, /data-budget-goal-spent-amount="12\.34"/);
    assert.match(out.html, /<small>Spent<\/small>[\s\S]*?\$12\.34 \/ \$60\.00/);
    assert.match(out.html, /data-budget-goal-spent-pending="12\.34">incl\. \$12\.34 pending</, 'a pending purchase is labelled pending');
    assert.match(out.html, /data-budget-goal-paid><span class="budget-v3-unknown">Unknown<\/span>/, 'Paid stays Unknown');
    assert.deepEqual([out.segment, out.band], ['0.2057', 12.34]);
    // A posted twin of a pending row is counted once and carries no pending label.
    const twin = render(costOf(tagged([raw({ id: 'invented-pending', is_pending: true }), raw()])).item);
    assert.doesNotMatch(twin.html, /pending/);
    assert.equal(twin.segment, '0.2057');
    // A pending refund is not netted and says so.
    const refund = render(costOf(tagged([raw({ id: 'c1', amount: '100.00' }),
      raw({ id: 'r1', amount: '-30.00', date: '2026-10-04', is_pending: true })])).item);
    assert.match(refund.html, /data-budget-goal-spent-pending-refund="30">\$30\.00 pending refund not yet netted</);
    assert.match(refund.html, /data-budget-goal-spent-amount="100"/);
  }
  { // Cutoff control: a posted tagged charge after item date + 14 days leaves
    // Paid nonzero and the tally zero; the segment and band follow the tally.
    const links = [{ ...link('tag'), effectiveThrough: '2026-12-31' }];
    const late = dated([raw({ id: 'late', date: '2026-11-05', amount: '20.00' })], links, '2026-11-05');
    const ledgerItem = item(ledgerOf(late).ledger);
    assert.deepEqual([cents(ledgerItem.paid), cents(ledgerItem.spent)], [2000, 0], 'Paid nonzero, tally zero');
    const { item: costItem } = costOf(late);
    assert.equal(costItem.commitmentCost.confirmedLinkedPaid.amount, 20);
    const out = render(costItem);
    assert.match(out.html, /data-budget-goal-paid-amount="20"/, 'Paid stamp is unchanged');
    assert.match(out.html, /data-budget-goal-spent-amount="0"/);
    assert.equal(out.segment, null, 'no tagged segment from the Paid amount');
    assert.equal(out.band, 0, 'the visible band reads the tally, not Paid');
  }
  { // Known-Paid control: an owner partial payment (Paid known, verified)
    // that differs from the tally does not set the tagged segment.
    const x = tagged([]);
    x.plan.commitments.find(c => c.id === 'near').ownerPaid = { amount: 5, confirmedOn: '2026-10-04' };
    const ledgerItem = item(ledgerOf(x).ledger);
    assert.deepEqual([cents(ledgerItem.paid), cents(ledgerItem.spent)], [500, 0]);
    const out = render(costOf(x).item);
    assert.match(out.html, /data-budget-goal-paid-amount="5"/);
    assert.match(out.html, /data-budget-goal-spent-amount="0"/);
    assert.equal(out.segment, null);
    assert.equal(out.band, 0);
  }
  { // Tag evidence only: a category-only link earns no tally; incumbent
    // category-based Paid, its bar fallback and Still to fund are unchanged.
    const x = tagged([raw()], [link('category')]);
    const ledgerItem = item(ledgerOf(x).ledger);
    assert.deepEqual([cents(ledgerItem.paid), cents(ledgerItem.spent)], [1234, null]);
    const { item: costItem } = costOf(x);
    assert.equal(costItem.commitmentCost.taggedSpend, undefined);
    const out = render(costItem);
    assert.doesNotMatch(out.html, /data-budget-goal-spent/);
    assert.deepEqual([out.segment, out.band], ['0.2057', 12.34], 'bar falls back to Paid when no tally is published');
    // A category-matched row beside a tag link does not count either.
    const mixed = tagged([raw({ tag_ids: [] })], [link('category'), link('tag')]);
    assert.equal(cents(item(ledgerOf(mixed).ledger).spent), 0, 'only tag-matched rows are summed');
  }
  { // A withheld tally (rolled window) prints no Spent line, no segment from it.
    const x = tagged([]);
    x.asOf = x.data.meta.asOf = '2026-11-05'; x.payload.fetchedAt = '2026-11-05T12:00:00.000Z';
    x.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false };
    const out = render(costOf(x).item);
    assert.doesNotMatch(out.html, /data-budget-goal-spent|data-budget-goal-bar-paid/);
    assert.equal(out.band, null);
  }
  { // Mutant: no taggedSpend fact -> no Spent line and no bar geometry from it.
    const { item: costItem } = costOf(tagged([raw({ is_pending: true })]));
    const mutant = JSON.parse(JSON.stringify(costItem));
    delete mutant.commitmentCost.taggedSpend;
    assert.doesNotMatch(render(mutant).html, /data-budget-goal-spent|data-budget-goal-bar-paid/);
  }
}
console.log('Savings tagged-spend tally: (a)-(d), rollover withhold, tag-only, pending labels, cutoff, known-Paid and bar/band display passed.');
