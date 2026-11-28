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
const costOf = (x, packet = observe(x)) => {
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
  assert.deepEqual(rolledCost.commitmentCost.taggedSpend,
    { status: 'withheld', amount: null, range: null, reason: 'tag-tally-withheld' },
    'a withheld tally reaches the bar as its own state: no amount, never zero');
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
  const { recon, ...fact } = costItem.commitmentCost.taggedSpend;
  assert.deepEqual(fact, { status: 'known', amount: 12.34, range: null, pendingAmount: 12.34, hasPurchases: true });
  assert.deepEqual(recon.map(row => [row.date, row.amount, row.pending]), [['2026-10-03', 12.34, true]]);
}
{ // Unusable tagged amounts in the packet cannot publish a subtotal or a zero row.
  for (const [amount, pending] of [[-5.001, false], [-5.001, true], [null, false], ['-5.00', true]]) {
    const x = tagged([raw({ amount: '20.00' }),
      raw({ id: 'invented-invalid-refund', date: '2026-10-04', amount: '-5.00', is_pending: pending })]);
    const packet = observe(x);
    const refund = packet.savingsLinks.evidence.find(row => row.direction === 'refund');
    packet.transactions.find(row => row.id === refund.transactionRef).amount = amount;
    const { pub, item: costItem } = costOf(x, packet);
    assert.equal(F.savingsLinkTarget.taggedEvidence(x.plan, x.asOf, packet), null);
    assert.equal(costItem.commitmentCost.taggedSpend, undefined);
    assert.equal(pub.rows.find(row => row.key === 'group:club').commitmentCost.taggedSpend, undefined);
  }
}
{ // The same tag can qualify display while the legacy anchor/pool gate holds.
  const x = tagged([raw({ id: 'made-up-twin', amount: '105.00', is_pending: true }),
    raw({ amount: '105.00' }),
    raw({ id: 'made-up-resolved-refund', date: '2026-10-04', amount: '-25.00' }),
    raw({ id: 'made-up-pending-refund', date: '2026-10-04', amount: '-5.00', is_pending: true }),
    raw({ id: 'made-up-unmatched', date: '2026-10-04', amount: '10.00', tag_ids: ['invented-tag-other'] })]);
  x.map.savingsLinks.anchorRevision = 99;
  x.plan.savingsEarmarks.history = [];
  x.plan.savingsEarmarks.pools[0].goalRefs = [];
  const { packet, item: costItem, pub } = costOf(x);
  const shared = F.savingsLinkTarget.taggedEvidence(x.plan, x.asOf, packet);
  assert.equal(F.savingsLinkTarget.taggedEvidence(x.plan, undefined, packet), null);
  assert.deepEqual(shared.links.map(link => [link.occurrenceKey, link.status, link.history]), [[NEAR, 'linked', 'complete']]);
  assert.deepEqual(shared.evidence.map(row => [row.occurrenceKey, row.direction, row.state]), [
    [NEAR, 'charge', 'posted'], [NEAR, 'refund', 'posted'], [NEAR, 'refund', 'pending'],
  ]);
  assert.ok(packet.savingsLinks.evidence.every(row => row.state === 'unresolved'));
  assert.ok(packet.transactions.every(tx => F.classifyCurrentPeriodTransaction(tx, x.plan, { packet }).kind !== 'savings-item'));
  const spend = costItem.commitmentCost.taggedSpend;
  assert.deepEqual([spend.amount, spend.pendingAmount, spend.pendingRefundAmount], [80, undefined, 5]);
  assert.deepEqual(spend.recon.map(tx => [tx.amount, tx.pending]), [[105, false], [-25, false], [-5, true]]);
  assert.doesNotMatch(JSON.stringify(spend.recon), /invented-tag|made-up-(?:twin|resolved-refund|pending-refund)|providerTransactionId/);
  assert.equal(costItem.commitmentCost.confirmedLinkedPaid.status, 'unconfigured');
  assert.equal(costItem.commitmentCost.unpaidCost.status, 'unconfigured');
  assert.equal(pub.rows.find(row => row.key === 'group:club').commitmentCost.taggedSpend.amount, 80,
    'a visible group includes the member with a tag');
  const oldPacket = structuredClone(packet);
  for (const row of oldPacket.savingsLinks.evidence) delete row.tagPostingState;
  const oldAdvice = F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: oldPacket, debts: [] });
  const old = oldAdvice.savingsFunding.rows.find(row => row.key === 'group:club');
  const newRow = pub.rows.find(row => row.key === 'group:club');
  for (const field of ['saved', 'needed', 'stillToFund', 'thisPeriod']) assert.deepEqual(newRow[field], old[field], field);
}
{ // A tagged unresolved transfer is scoped to its own exact item.
  const x = bothLinked([raw(), raw({ id: 'made-up-transfer', kind: 'transfer', tag_ids: ['invented-tag-far'] })]);
  const { ledger } = ledgerOf(x);
  assert.deepEqual(item(ledger).spent.recon.map(row => row.amount), [12.34]);
  assert.equal(ledger.items.find(row => row.occurrenceKey === 'far@2026-10-28').spent.withheld, true);
}
{ // The Savings list carries only the allowed display fields from Budget's projection.
  const read = notes => costOf(tagged([raw({ notes }),
    raw({ id: 'invented-unmarked-note', date: '2026-10-04', amount: '2.00', notes: 'Invented unmarked text' })]))
    .item.commitmentCost.taggedSpend;
  const withNote = read('item: Invented exhibit\nInvented second line');
  const withoutNote = read(undefined);
  const [marked, unmarked] = withNote.recon;
  const keys = ['amount', 'date', 'displayedPayee', 'id', 'originalMerchant', 'pending'];
  assert.deepEqual(Object.keys(marked).sort(), [...keys, 'displayedNote'].sort());
  assert.deepEqual(Object.keys(unmarked).sort(), keys);
  assert.equal(marked.displayedNote, 'Invented exhibit');
  const { displayedNote, ...markedWithoutNote } = marked;
  assert.deepEqual({ ...withNote, recon: [markedWithoutNote, unmarked] }, withoutNote);
}
{ // A configured group tag selects its unique native occurrence by date.
  const x = tagged([raw()], [{ ...link('tag'), goalRef: { kind: 'group', id: 'club' } }]);
  const { packet, pub } = costOf(x);
  assert.equal(F.savingsLinkTarget.taggedEvidence(x.plan, x.asOf, packet).links[0].occurrenceKey, NEAR);
  assert.equal(pub.rows.find(row => row.key === 'group:club').commitmentCost.taggedSpend.amount, 12.34);
  x.plan.commitments.find(row => row.id === 'far').date = '2026-10-21';
  const ambiguous = observe(x);
  assert.equal(F.savingsLinkTarget.taggedEvidence(x.plan, x.asOf, ambiguous).evidence[0].state, 'unresolved');
}
{ // (d) tagged refunds: a posted refund nets; a pending refund does not yet.
  const posted = tagged([raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04' })]);
  assert.deepEqual([cents(item(ledgerOf(posted).ledger).paid), cents(item(ledgerOf(posted).ledger).spent)], [7000, 7000]);
  const returned = tagged([raw(), raw({ id: 'made-up-full-refund', amount: '-12.34', date: '2026-10-04' })]);
  const returnedSpend = costOf(returned).item.commitmentCost.taggedSpend;
  assert.deepEqual([returnedSpend.amount, returnedSpend.hasPurchases, returnedSpend.recon.length],
    [0, true, 2], 'a returned purchase still opens the signed rows at a net of zero');
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
  beyond.payload.transactions.push(raw({ id: 'made-up-cutoff', date: '2026-11-04', amount: '9.00' }),
    raw({ id: 'made-up-late-transfer', date: '2026-11-05', kind: 'transfer' }));
  const boundary = item(ledgerOf(beyond).ledger).spent;
  assert.deepEqual([boundary.cents, boundary.recon.map(row => row.date)], [900, ['2026-11-04']],
    'the cutoff is inclusive and later unresolved rows stay outside it');
  const unresolved = tagged([raw({ kind: 'transfer' })]);
  assert.equal(cents(item(ledgerOf(unresolved).ledger).spent), null, 'unresolved evidence never earns a tally');
}
{ // Two configured tags for one occurrence make the exact target ambiguous.
  const x = tagged([raw()], [link('tag'), { ...link('tag'), tagId: 'invented-second-tag' }]);
  const { packet, ledger } = ledgerOf(x);
  assert.equal(item(ledger).spent.withheld, true);
  assert.equal(F.savingsLinkTarget.taggedEvidence(x.plan, x.asOf, packet).evidence[0].state, 'unresolved');
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
  const { goalBarTaggedAmount, goalBarBand, goalTagWithheldText } = blend.module.exports;
  const render = costItem => {
    const saved = costItem.commitmentCost.taggedSpend?.hasPurchases ? 40 : 0;
    context.row = { ...costItem, saved, savedTrust: 'calculated' };
    const html = vm.runInContext('budgetGoalPaidProgressHtml(row)', context);
    const attrs = Object.fromEntries([...html.slice(0, html.indexOf('>')).matchAll(/ (data-[a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const block = { getAttribute: name => attrs[name] ?? null };
    // final: the band class and width the visible Blend bar renders for this
    // goal (the same function the DOM code applies), with Saved 0 of 60 needed.
    return { html, attrs, tag: goalTagWithheldText(block), band: goalBarTaggedAmount(block), final: goalBarBand(block, saved, 60),
      segment: (html.match(/data-budget-goal-bar-paid style="--goal-paid:([0-9.]+)"/) || [])[1] ?? null };
  };
  const dated = (txs, links, through) => {
    const x = tagged(txs, links);
    x.asOf = x.data.meta.asOf = through; x.payload.fetchedAt = through + 'T12:00:00.000Z';
    x.payload.transactionWindow = { startDate: '2026-10-02', endDate: through, complete: true, hasMore: false };
    return x;
  };

  { // Pending-only tally with Paid withheld: Spent over funds, labelled pending.
    const { item: costItem } = costOf(tagged([raw({ is_pending: true })]));
    const out = render(costItem);
    assert.match(out.html, /data-budget-goal-paid-progress="funding"/);
    assert.match(out.html, /data-budget-goal-spent-amount="12\.34"/);
    assert.match(out.html, /<small>Spent<\/small>[\s\S]*?\$12\.34 \/ \$40\.00/);
    assert.match(out.html, /data-budget-goal-spent-pending="12\.34">incl\. \$12\.34 pending</, 'a pending purchase is labelled pending');
    assert.match(out.html, /data-budget-goal-paid><span class="budget-v3-unknown">Unknown<\/span>/, 'Paid stays Unknown');
    assert.deepEqual([out.segment, out.band, out.final.width], ['0.3085', 12.34, '0.3085']);
    // A posted twin of a pending row is counted once and carries no pending label.
    const twin = render(costOf(tagged([raw({ id: 'invented-pending', is_pending: true }), raw()])).item);
    assert.doesNotMatch(twin.html, /pending/);
    assert.equal(twin.segment, '0.3085');
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
    assert.doesNotMatch(out.html, /data-budget-goal-spent|data-budget-goal-tag-state/);
    assert.deepEqual([out.segment, out.band], ['0.2057', 12.34], 'bar falls back to Paid for an item with no tag');
    assert.deepEqual([out.final.band, out.final.width], ['is-red', '0.2057']);
    // A category-matched row beside a tag link does not count either.
    const mixed = tagged([raw({ tag_ids: [] })], [link('category'), link('tag')]);
    assert.equal(cents(item(ledgerOf(mixed).ledger).spent), 0, 'only tag-matched rows are summed');
  }
  const rolledWindow = x => {
    x.asOf = x.data.meta.asOf = '2026-11-05'; x.payload.fetchedAt = '2026-11-05T12:00:00.000Z';
    x.payload.transactionWindow = { startDate: '2026-10-30', endDate: '2026-11-05', complete: true, hasMore: false };
    return x;
  };
  // Full owner settlement on the published row (a settled item leaves the live roster, so the
  // fully-settled counterpart is the exact published fact shape the renderer receives).
  const full = costItem => ({ ...costItem, commitmentCost: { ...costItem.commitmentCost,
    ownerConfirmation: { status: 'full', confirmedOn: '2026-10-12' }, unpaidCost: { status: 'known', amount: 0, range: null } } });
  const ownerPaid = x => { x.plan.commitments.find(c => c.id === 'near').ownerPaid = { amount: 5, confirmedOn: '2026-10-04' }; return x; };
  { // P2: a withheld tally is its own display state; it never falls back to Paid.
    const out = render(costOf(rolledWindow(tagged([]))).item);
    assert.match(out.html, /data-budget-goal-tag-state="withheld"/);
    assert.match(out.html, /data-budget-goal-spent-withheld>Withheld</);
    assert.doesNotMatch(out.html, /data-budget-goal-spent-amount|data-budget-goal-bar-paid/);
    assert.equal(out.tag, 'Tagged spending: Withheld', 'the Blend row and window text for a withheld tally');
    assert.equal(out.band, null);
    assert.deepEqual([out.final.band, out.final.width], ['is-red', '0.0000'], 'only the Saved / required fallback (0 of 60): no tagged amount, never Paid');
    // Rolled window + a known owner-paid amount: Paid is not used for the tagged segment.
    const owner = ownerPaid(rolledWindow(tagged([])));
    const ownerOut = render(costOf(owner).item);
    assert.match(ownerOut.html, /data-budget-goal-tag-state="withheld"/);
    assert.doesNotMatch(ownerOut.html, /data-budget-goal-bar-paid/, 'no tagged segment filled from Paid while withheld');
    assert.equal(ownerOut.band, null);
    assert.equal(ownerOut.final.width, '0.0000', 'a known owner-paid 5.00 adds nothing to the withheld bar (it would be 0.0833)');
    // The exact published shape the reviewer described: withheld tally beside a KNOWN Paid
    // amount (synthetic Paid on the real withheld row): Paid must not fill the tagged segment.
    const withheldRow = costOf(rolledWindow(tagged([]))).item;
    const knownPaid = render({ ...withheldRow, commitmentCost: { ...withheldRow.commitmentCost,
      confirmedLinkedPaid: { status: 'known', amount: 5, range: null }, unpaidCost: { status: 'known', amount: 55, range: null } } });
    assert.match(knownPaid.html, /data-budget-goal-paid-amount="5"/, 'Paid is known and still printed');
    assert.match(knownPaid.html, /data-budget-goal-tag-state="withheld"/);
    assert.doesNotMatch(knownPaid.html, /data-budget-goal-bar-paid/);
    assert.equal(knownPaid.band, null);
    assert.equal(knownPaid.final.width, '0.0000');
    // The same owner-paid row with a complete window DOES have a tally (a control).
    const control = render(costOf(ownerPaid(tagged([]))).item);
    assert.match(control.html, /data-budget-goal-tag-state="known"/);
    // Rolled window + full settlement: Paid status stays 'paid' but no full geometry.
    const settled = render(full(costOf(rolledWindow(tagged([]))).item));
    assert.match(settled.html, /data-budget-goal-paid-progress="paid"/, 'Paid status unchanged');
    assert.match(settled.html, /data-budget-goal-tag-state="withheld"/);
    assert.doesNotMatch(settled.html, /data-budget-goal-bar-paid/);
    assert.notEqual(settled.final.band, 'is-paid', 'the Blend bar takes no full-paid shortcut while the tally is withheld');
    assert.equal(settled.final.width, '0.0000');
    // A rolled-window row with Paid known but no tag at all keeps the Paid fallback.
    const noTag = render(costOf((() => { const r = rolledWindow(tagged([raw()], [link('category')]));
      return r; })()).item);
    assert.doesNotMatch(noTag.html, /data-budget-goal-tag-state/);
  }
  { // P1: a fully Paid item's tagged geometry follows the published tally.
    // Paid's status, text and settlement are unchanged.
    const zero = render(full(costOf(tagged([])).item));
    assert.match(zero.html, /data-budget-goal-paid-progress="paid"/, 'Paid status stays paid');
    assert.match(zero.html, /data-budget-goal-tag-state="known"/);
    assert.equal(zero.tag, null, 'a known zero never says Withheld');
    assert.match(zero.html, /data-budget-goal-spent-amount="0"/);
    assert.doesNotMatch(zero.html, /data-budget-goal-bar-paid/, 'known zero tally: no full segment');
    assert.deepEqual([zero.band, zero.final.band, zero.final.width], [0, 'is-red', '0.0000'],
      'the rendered Blend band is the tally (0 of 60), not the full-paid shortcut');
    const part = render(full(costOf(tagged([raw()])).item));
    assert.match(part.html, /data-budget-goal-paid-progress="paid"/);
    assert.equal(part.segment, '0.3085', 'plan.js plots 12.34 over 40 in funds');
    assert.deepEqual([part.band, part.final.band, part.final.width], [12.34, 'is-amber', '0.3085']);
    assert.equal(part.tag, null, 'a known tally never says Withheld');
    // The same through the real ledger (no synthetic fact): charges that cover the plan make
    // Paid full (60.00 of 60.00) while the whole charge falls after the tally cutoff.
    const links = [{ ...link('tag'), effectiveThrough: '2026-12-31' }];
    const realFull = costOf(dated([raw({ id: 'big', date: '2026-11-05', amount: '60.00' })], links, '2026-11-05')).item;
    const realOut = render(realFull);
    assert.match(realOut.html, /data-budget-goal-paid-progress="paid"/, 'real Paid is full');
    assert.match(realOut.html, /data-budget-goal-paid-amount="60"/);
    assert.match(realOut.html, /data-budget-goal-spent-amount="0"/);
    assert.doesNotMatch(realOut.html, /data-budget-goal-bar-paid/);
    assert.deepEqual([realOut.final.band, realOut.final.width], ['is-red', '0.0000']);
    // Control: a full-paid item with NO tag keeps the incumbent full geometry.
    const noTag = render(full(costOf(tagged([raw()], [link('category')])).item));
    assert.match(noTag.html, /data-budget-goal-paid-progress="paid"/);
    assert.doesNotMatch(noTag.html, /data-budget-goal-tag-state/);
    assert.equal(noTag.tag, null, 'an untagged item never says Withheld');
    assert.equal(noTag.segment, '1');
    assert.deepEqual([noTag.final.band, noTag.final.width], ['is-paid', null]);
  }
  { // Mutant: no taggedSpend fact -> no Spent line and no bar geometry from it.
    const { item: costItem } = costOf(tagged([raw({ is_pending: true })]));
    const mutant = JSON.parse(JSON.stringify(costItem));
    delete mutant.commitmentCost.taggedSpend;
    assert.doesNotMatch(render(mutant).html, /data-budget-goal-spent|data-budget-goal-bar-paid/);
  }
}
console.log('Savings tagged-spend tally: (a)-(d), rollover withhold, tag-only, pending labels, cutoff, known-Paid, fully-Paid, withheld state and final bar/band display passed.');
