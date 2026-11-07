'use strict';
// A4a (#820): signed savings attribution and Forecast.savingsItemLedger,
// effects INACTIVE. All identities, dates and amounts are invented; the
// cent figures follow the adopted blueprint's invented examples (#787
// 6620986508 sections 2, 3 and 5). Expectations are hand-enumerated
// literals, not values read back from the code under test.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const renderer = require('../public/savings-inventory');
const { fixture, observe, raw, link } = require('./test-savings-link-foundation');
const root = path.resolve(__dirname, '..');
const L = F.savingsItemLedger;
const cents = fact => fact.cents;
const NEAR = 'near@2026-10-21', FAR = 'far@2026-10-28';

// ---------------------------------------------------------------- entry core
// P = N + C - X; U = max(L - P, 0) unless fully confirmed; Still = max(U - A, 0).
{
  const e = L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 10000, refundCents: 3000 } });
  assert.deepEqual([cents(e.charges), cents(e.refunds), cents(e.net), cents(e.paid), cents(e.unpaid)],
    [10000, 3000, 7000, 7000, 43000], 'refund: net paid 70, remaining 430');
  assert.deepEqual([e.charges.trust, e.net.trust, e.unpaid.trust], ['verified', 'calculated', 'estimated']);
}
{
  const e = L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 10000, refundCents: 10000 } });
  assert.deepEqual([cents(e.net), cents(e.unpaid)], [0, 50000], 'reversal: net 0, need returns to 500');
  const full = L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 10000, refundCents: 10000 },
    owner: { status: 'full', cents: null, confirmedOn: '2026-01-05' } });
  assert.equal(cents(full.unpaid), 0, 'an independent full owner confirmation still closes the reversed item');
  const unpaired = L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 0, refundCents: 10000 } });
  assert.deepEqual([cents(unpaired.net), cents(unpaired.paid), cents(unpaired.unpaid)], [null, null, null],
    'an unpaired reversal makes the affected totals Unknown');
  assert(unpaired.reasons.includes('refund-exceeds-charges'));
}
{
  // Owner amount overlapping a transaction (trap): partial 50 overlapping a
  // charge of 50 and a refund of 20 nets to 30, not 80 and not 100.
  const tx = { status: 'known', chargeCents: 5000, refundCents: 2000 };
  const owner = { status: 'partial', cents: 5000, confirmedOn: '2026-10-04' };
  assert.equal(cents(L.entry({ plannedCents: 20000, transactions: tx, owner,
    overlap: { status: 'known', cents: 5000 } }).paid), 3000, 'evidenced overlap: 50 + 50 - 20 - 50 = 30');
  const blind = L.entry({ plannedCents: 20000, transactions: tx, owner });
  assert.deepEqual([cents(blind.paid), cents(blind.unpaid)], [null, null], 'no blind sum or max when overlap is unknown');
  assert(blind.reasons.includes('overlap-unknown'));
  assert.equal(cents(L.entry({ plannedCents: 20000, transactions: tx, owner,
    overlap: { status: 'known', cents: 6000 } }).paid), null, 'an overlap larger than the owner amount is not evidence');
}
{
  const only = L.entry({ plannedCents: 20000, owner: { status: 'partial', cents: 5000, confirmedOn: '2026-10-04' } });
  assert.deepEqual([cents(only.paid), only.paid.trust, cents(only.unpaid), only.closed], [5000, 'verified', 15000, false],
    'owner-only partial: P = C without transaction proof; 50 of 200 leaves 150 and stays open');
  const covers = L.entry({ plannedCents: 20000, owner: { status: 'partial', cents: 25000, confirmedOn: '2026-10-04' } });
  assert.deepEqual([cents(covers.unpaid), covers.closed, covers.owner.status], [0, false, 'partial'],
    'a partial confirmation never closes the item, even when it reaches the planned cost');
  const full = L.entry({ plannedCents: 20000, owner: { status: 'full', cents: null, confirmedOn: '2026-01-05' } });
  assert.deepEqual([cents(full.paid), cents(full.unpaid), full.unpaid.trust, full.closed], [null, 0, 'verified', true],
    'full confirmation with unknown amount: U = 0, P Unknown');
  assert.equal(full.owner.dateRole, 'owner-confirmation');
  assert.equal(full.owner.confirmedOn, '2026-01-05');
  assert(!Object.hasOwn(full, 'paidOn') && !Object.hasOwn(full.owner, 'paidOn'),
    'a confirmation date is never published as a payment date (trap)');
}
{
  const over = L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 70000, refundCents: 0 } });
  assert.deepEqual([cents(over.unpaid), cents(over.overspend)], [0, 20000], 'overspend is a disclosure, not another debit');
  const done = L.entry({ plannedCents: 60000, transactions: { status: 'known', chargeCents: 50000, refundCents: 0 },
    owner: { status: 'full', cents: null, confirmedOn: '2026-10-04' } });
  assert.equal(cents(done.variance), null, 'variance is explanatory only when the actual total is known');
  const known = L.entry({ plannedCents: 60000, owner: { status: 'full', cents: 50000, confirmedOn: '2026-10-04' } });
  assert.deepEqual([cents(known.variance), cents(known.unpaid)], [10000, 0], 'variance 100 disclosed; no need remains');
  assert.equal(cents(L.entry({ plannedCents: 50000, transactions: { status: 'known', chargeCents: 10000, refundCents: 0 },
    shareCents: 30000 }).stillToFund), 10000, 'still to fund = max(U - A, 0)');
  assert.equal(cents(L.entry({ plannedCents: null, transactions: { status: 'known', chargeCents: 0, refundCents: 0 } }).unpaid),
    null, 'missing planned cost is never zero');
  assert.equal(cents(L.entry({ plannedCents: 500, transactions: { status: 'unknown' } }).paid), null,
    'missing transaction evidence is never zero');
}

// ----------------------------------------------------------------- pool core
const identity = pool => pool.cash.cents + pool.deficit.cents
  === pool.liability.cents + pool.shares.reduce((s, row) => s + row.cents, 0) + pool.unallocated.cents;
{
  // Prepaid from chequing: 100 reduces a 500 need to 400; Savings cash stays 1,000.
  const pool = L.pool({ cashCents: 100000, liabilities: [], needs: [
    { key: 'b', needDate: '2026-11-02', unpaidCents: 70000 }, { key: 'a', needDate: '2026-11-01', unpaidCents: 40000 }] });
  assert.deepEqual(pool.shares.map(cents), [60000, 40000], 'need-date order, input order preserved in output');
  assert.deepEqual([cents(pool.cash), cents(pool.funds), cents(pool.unallocated), cents(pool.deficit)], [100000, 100000, 0, 0]);
  assert.equal(L.entry({ plannedCents: 70000, transactions: { status: 'known', chargeCents: 0, refundCents: 0 },
    shareCents: 60000 }).stillToFund.cents, 10000, 'later gap is 100');
  assert(identity(pool));
}
{
  // Overspend larger than the pool: B 200, unpaid Savings-backed card 350.
  const pool = L.pool({ cashCents: 20000, liabilities: [{ ref: 'card-1', cents: 35000 }],
    needs: [{ key: 'a', needDate: '2026-11-01', unpaidCents: 10000 }] });
  assert.deepEqual([cents(pool.cash), cents(pool.liability), cents(pool.funds), cents(pool.deficit), cents(pool.unallocated)],
    [20000, 35000, -15000, 15000, 0], 'F = -150, deficit 150, observed cash stays 200');
  assert.deepEqual(pool.shares.map(cents), [0]);
  assert(identity(pool));
  assert.equal(pool.cash.trust, 'verified'); assert.equal(pool.deficit.trust, 'calculated');
}
{
  // Balance debit plus an N debit (trap): B is never reduced by historic N.
  const before = L.pool({ cashCents: 100000, liabilities: [], needs: [{ key: 'a', needDate: '2026-11-01', unpaidCents: 60000 }] });
  // Completed from Savings for 500: the observed balance is now 500 and U = 0.
  const done = L.entry({ plannedCents: 60000, owner: { status: 'full', cents: 50000, confirmedOn: '2026-10-04' } });
  const after = L.pool({ cashCents: 50000, liabilities: [], needs: [{ key: 'a', needDate: '2026-11-01', unpaidCents: done.unpaid.cents }] });
  assert.deepEqual([cents(before.unallocated), cents(after.unallocated)], [40000, 50000],
    'completed for 500: 500 left, not 0 (double debit) and not 600 (variance credit)');
  const over = L.entry({ plannedCents: 60000, owner: { status: 'full', cents: 70000, confirmedOn: '2026-10-04' } });
  assert.equal(cents(L.pool({ cashCents: 30000, liabilities: [], needs: [{ key: 'a', needDate: '2026-11-01',
    unpaidCents: over.unpaid.cents }] }).unallocated), 30000, 'completed for 700: 300 left');
}
{
  // Variance credit plus a released allocation (trap): a later item gets
  // only the observed remainder, never remainder + (L - actual).
  const pool = L.pool({ cashCents: 50000, liabilities: [], needs: [
    { key: 'done', needDate: '2026-11-01', unpaidCents: 0 }, { key: 'next', needDate: '2026-11-02', unpaidCents: 70000 }] });
  assert.deepEqual(pool.shares.map(cents), [0, 50000]);
  assert.equal(cents(pool.unallocated), 0);
}
{
  assert.equal(L.pool({ cashCents: 100, liabilities: [{ ref: 'x', cents: 50 }, { ref: 'x', cents: 50 }], needs: [] }).funds.cents,
    null, 'one liability reference has one cash-deduction owner: a repeat withholds, never debits twice');
  const undated = L.pool({ cashCents: 100, liabilities: [], needs: [{ key: 'a', needDate: null, unpaidCents: 10 }] });
  assert.deepEqual([undated.shares[0].cents, cents(undated.unallocated)], [null, null], 'no invented priority');
  const unknownNeed = L.pool({ cashCents: 100, liabilities: [], needs: [
    { key: 'a', needDate: '2026-11-01', unpaidCents: 10 }, { key: 'b', needDate: '2026-11-02', unpaidCents: null },
    { key: 'c', needDate: '2026-11-03', unpaidCents: 10 }] });
  assert.deepEqual(unknownNeed.shares.map(cents), [10, null, null], 'an unknown need withholds itself and later items');
  assert.equal(L.pool({ cashCents: null, needs: [] }).status, 'unavailable');
  // Atlas blocker 1 on 2440a8b: supplied liability evidence that is missing
  // or malformed is never zero liabilities; known cash stays visible.
  for (const liabilities of [{ status: 'unknown' }, undefined, null, 'none', 0]) {
    const pool = L.pool({ cashCents: 6000, liabilities, needs: [{ key: 'a', needDate: '2026-11-01', unpaidCents: 6000 }] });
    assert.deepEqual([pool.status, cents(pool.cash), cents(pool.liability), cents(pool.unallocated), pool.shares[0].cents],
      ['unavailable', 6000, null, null, null], 'malformed liabilities withhold allocation: ' + JSON.stringify(liabilities));
  }
  for (const needs of [{ status: 'unknown' }, undefined, null]) {
    const pool = L.pool({ cashCents: 6000, liabilities: [], needs });
    assert.deepEqual([pool.status, cents(pool.cash), cents(pool.unallocated)], ['unavailable', 6000, null],
      'a malformed needs list never reads as no needs: ' + JSON.stringify(needs));
  }
  const huge = L.pool({ cashCents: 100, needs: [], liabilities: [
    { ref: 'a', cents: Number.MAX_SAFE_INTEGER - 1 }, { ref: 'b', cents: 10 }] });
  assert.deepEqual([huge.status, cents(huge.liability), cents(huge.funds)], ['unavailable', null, null],
    'a liability sum beyond exact integer cents withholds');
  assert.equal(L.pool({ cashCents: -Number.MAX_SAFE_INTEGER, needs: [], liabilities: [{ ref: 'a', cents: 10 }] }).funds.cents, null,
    'cash minus liabilities beyond exact integer cents withholds');
}

// --------------------------------------------- observer -> publication -> ledger
const ledgerOf = (x, extra = {}) => {
  const packet = observe(x);
  return F.savingsItemLedger(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet, ...extra });
};
const item = (ledger, key) => ledger.items.find(row => row.occurrenceKey === key);
function trip() {
  // Invented costs from the blueprint: two items of 500 and 700.
  const x = fixture();
  x.plan.commitments.find(c => c.id === 'near').amount = 500;
  x.plan.commitments.find(c => c.id === 'far').amount = 700;
  x.map.savingsLinks.links = [link('category')];
  x.payload.transactions = [];
  return x;
}
{
  // Bare tag IDs resolve through resolveRawTags (#829 Codex P1 disposition).
  const x = trip();
  x.map.savingsLinks.links = [{ ...link('tag'), tagId: 501 }];
  x.payload.transactions = [raw({ id: 'bare', category_id: 'other', tag_ids: undefined, tags: [501], amount: '100.00' })];
  const evidence = observe(x).savingsLinks.evidence;
  assert.equal(evidence.length, 1, 'a tags: [501] transaction becomes a candidate');
  assert.equal(evidence[0].state, 'posted');
  assert.equal(cents(item(ledgerOf(x), NEAR).paid), 10000);
  x.payload.transactions = [raw({ id: 'bare', category_id: 'other', tag_ids: undefined, tags: [502], amount: '100.00' })];
  assert.deepEqual(observe(x).savingsLinks.evidence, [], 'an unknown bare tag ID stays unmatched');
  x.payload.transactions = [raw({ id: 'bare', category_id: 'other', tag_ids: undefined, tags: ['501x'], amount: '100.00' })];
  assert.deepEqual(observe(x).savingsLinks.evidence, [], 'a tag name never substitutes for an ID');
  x.map.savingsLinks.links = [{ ...link('tag'), tagId: 501 }, { ...link('tag', 'far', '2026-10-28'), tagId: 501 }];
  x.payload.transactions = [raw({ id: 'bare', category_id: 'other', tag_ids: undefined, tags: [501], amount: '100.00' })];
  assert.equal(observe(x).savingsLinks.evidence[0].reason, 'conflicting-links', 'an ambiguous bare tag stays unresolved');
}
{
  // Refund: planned 500, spending 100, a uniquely linked refund of 30.
  const x = trip();
  x.payload.transactions = [raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', date: '2026-10-04' })];
  const ev = observe(x).savingsLinks.evidence;
  assert.deepEqual(ev.map(row => [row.direction, row.state]), [['charge', 'posted'], ['refund', 'posted']]);
  const near = item(ledgerOf(x), NEAR);
  assert.deepEqual([near.charges, near.refunds, near.net, near.paid, near.unpaid].map(cents), [10000, 3000, 7000, 7000, 43000]);
  // A refund treated as income or Other (trap): an income-flagged credit is
  // not a refund; it stays visible as unresolved and the item is Unknown.
  x.payload.transactions = [raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-30.00', is_income: true })];
  const withIncome = ledgerOf(x);
  assert.equal(observe(x).savingsLinks.evidence[1].reason, 'nonconsumption');
  assert.equal(cents(item(withIncome, NEAR).paid), null);
  assert.equal(withIncome.unresolved.total, 1);
}
{
  // Reversal and unpaired reversal.
  const x = trip();
  x.payload.transactions = [raw({ id: 'c1', amount: '100.00' }), raw({ id: 'r1', amount: '-100.00', date: '2026-10-04' })];
  assert.deepEqual([item(ledgerOf(x), NEAR).net, item(ledgerOf(x), NEAR).unpaid].map(cents), [0, 50000]);
  x.payload.transactions = [raw({ id: 'r1', amount: '-100.00', date: '2026-10-04' })];
  assert.deepEqual([item(ledgerOf(x), NEAR).net, item(ledgerOf(x), NEAR).unpaid].map(cents), [null, null]);
}
{
  // Pre-item purchase: the item's anchor is confirmed later; the history
  // covers the purchase. No creation-date cutoff, no invented payment date.
  const x = trip();
  x.plan.savingsEarmarks.history[0].confirmedAt = '2026-10-04';
  x.payload.transactions = [raw({ id: 'early', amount: '100.00', date: '2026-10-02' })];
  const near = item(ledgerOf(x), NEAR);
  assert.deepEqual([near.paid, near.unpaid].map(cents), [10000, 40000]);
  assert(!JSON.stringify(near).includes('paidOn'));
  // Incomplete history makes it Unknown: the link reaches before the window.
  x.map.savingsLinks.links[0].effectiveFrom = '2026-09-01';
  const gap = ledgerOf(x);
  assert.equal(gap.items[0].paid.cents, null);
  assert(gap.items[0].reasons.includes('history-incomplete'));
  x.payload.transactionWindow.startDate = '2026-09-01';
  x.payload.transactions.push(raw({ id: 'sept', amount: '25.00', date: '2026-09-15' }));
  assert.equal(cents(item(ledgerOf(x), NEAR).paid), 12500, 'covered history counts purchases before the current period');
  x.payload.transactionWindow.complete = false;
  assert.equal(cents(item(ledgerOf(x), NEAR).paid), null, 'an incomplete window cannot establish lifetime totals');
  // Settlement evidence never lifts the coverage hold.
  x.payload.transactionWindow = { ...x.payload.transactionWindow, complete: true, startDate: '2026-10-02' };
  x.payload.transactions = [];
  const settle = { commitments: [{ goalId: 'commitment:near', links: [{ effectiveDate: '2026-10-03', assignedCents: 1000 }] }] };
  const held = item(ledgerOf(x, { settlementEvidence: settle }), NEAR);
  assert.deepEqual([cents(held.paid), cents(held.unpaid)], [null, null]);
  assert(held.reasons.includes('history-incomplete'));
  x.map.savingsLinks.links[0].effectiveFrom = '2026-10-02';
  assert.equal(cents(item(ledgerOf(x, { settlementEvidence: settle }), NEAR).paid), 1000,
    'with complete history and no linked rows, settlement is the sole source');
}
{
  // Two items, one category: neither receives the 80; a unique tag permits one.
  const x = trip();
  x.map.savingsLinks.links = [link('category'), link('category', 'far', '2026-10-28')];
  x.payload.transactions = [raw({ id: 'c1', amount: '80.00', tag_ids: [] })];
  const both = ledgerOf(x);
  assert.deepEqual(both.items.map(row => cents(row.paid)), [null, null]);
  assert.equal(both.unresolved.evidence.length, 1, 'the purchase stays visible for review');
  x.map.savingsLinks.links.push(link('tag'));
  x.payload.transactions = [raw({ id: 'c1', amount: '80.00' })];
  const tagged = ledgerOf(x);
  assert.deepEqual([cents(item(tagged, NEAR).paid), cents(item(tagged, FAR).paid)], [8000, 0], 'exactly one allocation of 80');
  // Ambiguous link: the category points to A and the tag points to B.
  x.map.savingsLinks.links = [link('category'), link('tag', 'far', '2026-10-28')];
  x.payload.transactions = [raw({ id: 'c1', amount: '60.00' })];
  const ambiguous = ledgerOf(x);
  assert.deepEqual(ambiguous.items.map(row => cents(row.paid)), [null, null], 'no guessed allocation, no duplicate total');
  assert.equal(ambiguous.unresolved.evidence[0].reason, 'conflicting-links');
  // Category and tag agreeing count once.
  x.map.savingsLinks.links = [link('category'), link('tag')];
  assert.equal(cents(item(ledgerOf(x), NEAR).paid), 6000, 'category plus tag counted once');
}
{
  // Prepaid from chequing: pool 1,000; needs 500 then 700; 100 prepaid.
  const x = trip();
  x.map.savingsLinks.links = [link('category'), link('tag', 'far', '2026-10-28')];
  x.payload.transactions = [raw({ id: 'c1', amount: '100.00', tag_ids: [], account_id: 'invented-account-a' })];
  const before = JSON.stringify(x.plan);
  const ledger = ledgerOf(x, { pool: { cashCents: 100000, liabilities: [] } });
  assert.equal(observe(x).transactions.find(t => t.id === 'tx-1').atlasAccountId, 'chequing-a');
  assert.deepEqual(ledger.items.map(row => [row.occurrenceKey, cents(row.unpaid), cents(row.share), cents(row.stillToFund)]),
    [[NEAR, 40000, 40000, 0], [FAR, 70000, 60000, 10000]]);
  assert.equal(cents(ledger.pool.cash), 100000, 'Savings cash stays 1,000');
  const malformed = ledgerOf(x, { pool: { cashCents: 6000, liabilities: { status: 'unknown' } } });
  assert.deepEqual([malformed.pool.status, cents(malformed.pool.cash), malformed.items.map(row => cents(row.share)),
    malformed.items.map(row => cents(row.stillToFund))], ['unavailable', 6000, [null, null], [null, null]],
  'through the plan-level ledger, unknown liabilities withhold every share (Atlas blocker 1)');
  assert.equal(JSON.stringify(x.plan), before, 'the ledger never writes the plan');
  assert(identity(ledger.pool));
}
{
  // Confirmed, then late spending; the unpaid sibling stays visible.
  const x = trip();
  x.map.savingsLinks.links = [link('category'), link('tag', 'far', '2026-10-28')];
  x.plan.commitments.find(c => c.id === 'near').settledOn = '2026-10-03';
  x.payload.transactions = [raw({ id: 'late', amount: '90.00', date: '2026-10-04', tag_ids: [] })];
  const ledger = ledgerOf(x);
  const near = item(ledger, NEAR), far = item(ledger, FAR);
  assert(near, 'a settled item keeps its late spend (retained identity, not only future events)');
  assert.deepEqual([near.closed, cents(near.unpaid), cents(near.charges), cents(near.paid)], [true, 0, 9000, null]);
  assert.deepEqual([near.owner.status, near.owner.confirmedOn, near.owner.dateRole], ['full', '2026-10-03', 'owner-confirmation']);
  assert(far && !far.closed && cents(far.unpaid) === 70000, 'a group-level confirmation never hides an unpaid sibling (trap)');
  // Owner partial overlapping linked transactions, through the plan ledger.
  delete x.plan.commitments.find(c => c.id === 'near').settledOn;
  x.payload.transactions = [raw({ id: 'c1', amount: '50.00', tag_ids: [] }), raw({ id: 'r1', amount: '-20.00', tag_ids: [] })];
  const confirmation = { occurrenceKey: NEAR, status: 'partial', cents: 5000, confirmedOn: '2026-10-04' };
  assert.equal(cents(item(ledgerOf(x, { confirmations: [{ ...confirmation, overlapRefs: ['tx-1'] }] }), NEAR).paid), 3000);
  assert.equal(cents(item(ledgerOf(x, { confirmations: [confirmation] }), NEAR).paid), null);
  assert.equal(cents(item(ledgerOf(x, { confirmations: [{ ...confirmation, overlapRefs: ['tx-9'] }] }), NEAR).paid), null,
    'an overlap reference outside the item evidence is not evidence');
  for (const confirmedOn of ['2027-01-01', null, '2026-02-30']) {
    const late = item(ledgerOf(x, { confirmations: [{ ...confirmation, status: 'full', confirmedOn }] }), NEAR);
    assert.deepEqual([late.closed, cents(late.unpaid)], [false, null],
      'a future, missing or malformed confirmation date never closes the item: ' + confirmedOn);
  }
}
{
  // Missing transaction ID: no fabricated identity; refresh is idempotent.
  const x = trip();
  x.payload.transactions = [raw({ id: undefined, amount: '40.00' })];
  assert.throws(() => observe(x), /stable id/, 'the observer refuses an identity-less transaction');
  x.payload.transactions = [raw({ id: 'c1', amount: '40.00' })];
  assert.deepEqual(ledgerOf(x), ledgerOf(x), 'refreshing twice yields the same ledger');
  const packet = observe(x);
  packet.savingsLinks.evidence[0].transactionRef = 'tx-9';
  const forged = F.savingsItemLedger(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet, pool: { cashCents: 100000, liabilities: [] } });
  assert.equal(forged.status, 'unavailable', 'a tx-N reference with no packet transaction earns no credit');
  assert.deepEqual(forged.items, []);
  assert.equal(cents(forged.pool.cash), 100000, 'the independently known pool stays visible');
}
{
  // Posted-with-reason and reasonless-unresolved rows are malformed.
  const x = trip();
  x.payload.transactions = [raw({ id: 'c1', amount: '40.00' })];
  for (const patch of [{ reason: 'nonconsumption' }, { state: 'unresolved', reason: null }, { direction: 'refund' }, { direction: undefined }]) {
    const packet = observe(x);
    Object.assign(packet.savingsLinks.evidence[0], patch);
    const pub = F.savingsItemLedger(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet });
    const direction = patch.direction === 'refund';
    assert(pub.status === 'unavailable' || direction && pub.unresolved.evidence.length === 1,
      'malformed evidence never qualifies: ' + JSON.stringify(patch));
  }
}
{
  // goalKey: null must not disappear: the unresolved list reaches every row.
  const x = fixture();
  x.map.savingsLinks.links.push({ ...link('tag', 'missing'), tagId: 'invented-unused-tag' });
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: observe(x), debts: [] });
  const pub = F.savingsFundingPublication(a.savingsFunding, { asOf: x.asOf, advice: a });
  const rows = pub.rows.filter(row => row.savingsLinks);
  assert(rows.length && rows.every(row => row.savingsLinks.unresolved.links.some(l => l.reason === 'native-target-unresolved')));
  const html = renderer.html(pub, { asOf: x.asOf, advice: a });
  assert.match(html, /data-savings-link-unresolved="1"/);
  assert.match(html, /Unresolved links and evidence: 1/);
  assert.match(html, /Item not found/);
  x.payload.transactions = [raw(), raw({ id: 'r1', amount: '-5.00', date: '2026-10-04' })];
  x.map.savingsLinks.links.pop();
  const b = F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: observe(x), debts: [] });
  const refundHtml = renderer.html(F.savingsFundingPublication(b.savingsFunding, { asOf: x.asOf, advice: b }), { asOf: x.asOf, advice: b });
  assert.match(refundHtml, /Posted refund evidence/);
  assert.doesNotMatch(refundHtml, /Paid on|payment date/i, 'evidence display never shows a payment date');
}

// ------------------------------------------- settlementRowRelief adapter parity
// The incumbent settlementRowRelief is loaded from a git blob of main before
// A4a and compared on every reachable shape; consumers see identical relief.
// Bills audit of 57cb421: the shared helper proves the full-load BAD family
// on the current engine, then restores the incumbent values exactly.
const restoreLegacyBadFamily = require('./bad-full-load-legacy');
const BASE = '9440e6a17df4571db24a7e6d5a074e671d37589d';
function baseEngine() {
  const source = execFileSync('git', ['show', BASE + ':public/forecast.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4000000 });
  const context = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const base = baseEngine();
{
  const evidence = (assigned, extra = {}) => ({ commitments: [{ goalId: 'commitment:near',
    links: [{ effectiveDate: '2026-10-03', assignedCents: assigned, ...extra }] }] });
  const shapes = [];
  for (const amount of [null, 0, 0.01, 60, 60.5, 170]) for (const assigned of [0, 1, 5999, 6000, 6001, 17000, -1, 1.5])
    for (const extra of [{}, { reversals: [{ date: '2026-10-04' }] }]) shapes.push({ amount, assigned, extra });
  for (const { amount, assigned, extra } of shapes) {
    const x = fixture();
    const near = x.plan.commitments.find(c => c.id === 'near');
    if (amount == null) delete near.amount; else near.amount = amount;
    const opts = { ...x.opts, settlementEvidence: evidence(assigned, extra), debts: [] };
    const now = JSON.parse(JSON.stringify(F.recommend(x.plan, x.asOf, opts)));
    const then = withheldHistoricalPools(JSON.parse(JSON.stringify(base.recommend(x.plan, x.asOf, opts))));
    assert.deepEqual(restoreLegacyBadFamily(now), restoreLegacyBadFamily.frozen(then), 'relief adapter parity: ' + JSON.stringify({ amount, assigned, extra }));
  }
}

// ---------------------------------------- savingsStillToFund ledger adapter
// Published Still to fund now reads the ledger entry core; every point and
// unknown shape equals the incumbent formula in the pre-A4a engine.
{
  const ctx = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(execFileSync('git', ['show', BASE + ':public/forecast.js'], { cwd: root, encoding: 'utf8', maxBuffer: 4000000 })
    .replace('const Forecast = {', 'const Forecast = { __stillToFund: savingsStillToFund,'), ctx);
  const ours = (() => { const c = { module: { exports: {} }, exports: {}, console };
    vm.runInNewContext(require('node:fs').readFileSync(path.join(root, 'public/forecast.js'), 'utf8')
      .replace('const Forecast = {', 'const Forecast = { __stillToFund: savingsStillToFund,'), c); return c.module.exports; })();
  const values = [null, undefined, 0, 0.01, 1, 59.99, 60, 60.005, 170, -5, NaN, Infinity, '60'];
  for (const needed of values) for (const saved of values)
    assert.equal(JSON.stringify(ours.__stillToFund(needed, saved)), JSON.stringify(ctx.module.exports.__stillToFund(needed, saved)),
      'savingsStillToFund adapter parity: ' + String(needed) + ' / ' + String(saved));
  assert.equal(ours.__stillToFund(500, 600).stillToFund, 0);
  assert.equal(ours.__stillToFund(700, 600).stillToFund, 100);
}

// ------------------------------------------- A4b: the same scenarios, live
// A4a pinned these as moving no figure. A4b enables the effects; each is a
// hand ledger (pool 95 + 24 = 119; near 60, home-cost 24, far 170 in
// need-date order). The no-link publication stays byte-identical to the
// independent pre-A4a engine.
const withoutLinks = value => Array.isArray(value) ? value.map(withoutLinks)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'savingsLinks').map(([key, v]) => [key, withoutLinks(v)])) : value;
const live = (x, packet) => F.recommend(x.plan, x.asOf, { ...x.opts, currentPeriodActuals: packet, debts: [] });
const backing = a => a.savingsFunding.backing.items.map(i => [i.key, i.needed, i.saved]);
const unknownItems = a => a.savingsFunding.unresolved.map(i => [i.key, i.needed]);
for (const [mutate, items, unknown, label] of [
  [x => { x.payload.transactions = [raw(), raw({ id: 'r1', amount: '-5.00', date: '2026-10-04' })]; },
    [['near@2026-10-21', 52.66, 52.66], ['home-cost@2026-10-25', 24, 24], ['far@2026-10-28', 170, 42.34]], [],
    'refund: 12.34 - 5.00 = 7.34 net, near 52.66'],
  [x => { x.map.savingsLinks.links[1].tagId = 501; x.payload.transactions = [raw({ tag_ids: undefined, tags: [501] })]; },
    [['near@2026-10-21', 47.66, 47.66], ['home-cost@2026-10-25', 24, 24], ['far@2026-10-28', 170, 47.34]], [],
    'bare tag ID: 12.34 once'],
  [x => { x.plan.savingsEarmarks.history[0].confirmedAt = '2026-10-04'; },
    [['near@2026-10-21', 47.66, 47.66], ['home-cost@2026-10-25', 24, 24], ['far@2026-10-28', 170, 47.34]], [],
    'pre-anchor purchase still counts'],
  [x => { x.map.savingsLinks.links.push(link('tag', 'missing')); },
    [['home-cost@2026-10-25', 24, null], ['far@2026-10-28', 170, null]], [['near@2026-10-21', null]],
    'an unresolved hit makes near Unknown and withholds allocation'],
  [x => { x.plan.commitments.find(c => c.id === 'near').settledOn = '2026-10-03'; },
    [['home-cost@2026-10-25', 24, 24], ['far@2026-10-28', 170, 95]], [],
    'settled item: late spend is the item\'s; far receives 119 - 24 = 95'],
  [x => { x.map.savingsLinks.links = [link('category'), link('category', 'far', '2026-10-28')]; },
    [['home-cost@2026-10-25', 24, null]], [['near@2026-10-21', null], ['far@2026-10-28', null]],
    'one category on two items: both Unknown, no guess'],
]) {
  const x = fixture(); mutate(x);
  const enabled = observe(x), a = live(x, enabled);
  assert.deepEqual(backing(a), items, label + ': backing');
  assert.deepEqual(unknownItems(a), unknown, label + ': Unknown items');
  delete x.map.savingsLinks;
  const plain = observe(x);
  assert.deepEqual(withoutLinks(enabled), plain, label + ': every existing observer field is unchanged');
  assert.deepEqual(restoreLegacyBadFamily(live(x, plain)), restoreLegacyBadFamily.frozen(withheldHistoricalPools(JSON.parse(JSON.stringify(base.recommend(x.plan, x.asOf,
    { ...x.opts, currentPeriodActuals: plain, debts: [] }))))), label + ': no-link publication equals the pre-A4a engine');
}
assert(O.currentPeriodActualsLooksSanitized((() => { const x = fixture(); return observe(x); })()));
console.log('Savings item ledger: edge cases, traps, adapter parity, A4b live effects and no-link parity passed.');

// #818 5.9 (PR #864): a completed period's savings packet withholds pool
// balances observed after its last day. The pinned engine predates that rule,
// so its publication gets exactly that one change before byte parity.
function withheldHistoricalPools(advice) {
  for (const view of advice?.savingsFunding?.periodViews || []) {
    const packet = view?.packet;
    if (packet?.period?.kind !== 'historical' || !Array.isArray(packet.backing?.pools)) continue;
    packet.backing.pools = packet.backing.pools.map(pool => typeof pool?.observedAsOf === 'string'
      && pool.observedAsOf <= packet.period.end ? pool : { ...pool, observedCash: null, observedAsOf: null });
  }
  return advice;
}
