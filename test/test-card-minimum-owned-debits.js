'use strict';
// The card-minimum owner export (desk 6893166367; Grok Bot, Plan #6).
// Forecast.cardMinimumOwnedDebits names the debits the card-minimum owner
// counts, keyed by recorded identity:
//   (a) only accepted, posted records are exported, durable and derived;
//   (b) each debit appears once, so a later consumer can count it once;
//   (c) a withdrawn derived record drops out on the next observation;
//   (d) an unreadable owner input reads Unavailable, never an empty set.
// The hashed identities stay out of the published cardMinimumState.
// Invented plan, ids and cents only; each expectation is stated per case.
//
//   node test/test-card-minimum-owned-debits.js
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const clone = v => JSON.parse(JSON.stringify(v));
const hex = ch => ch.repeat(64);
const D1 = hex('a'), D2 = hex('b'), D3 = hex('c');
const AS_OF = '2026-10-20';

function plan({ sent, packet } = {}) {
  return {
    opening: { asOf: '2026-10-01', representedEvents: [] },
    debts: [{ id: 'triangle', label: 'Invented card A', structure: 'Revolving', secured: false, balance: 500 },
      { id: 'mbna', label: 'Invented card B', structure: 'Revolving', secured: false, balance: 400 }],
    obligations: [
      { id: 'min-a', debtId: 'triangle', effect: 'payment', label: 'Invented card A minimum', frequency: 'monthly',
        day: 7, amount: 25, confidence: 'confirmed', payingAccount: 'chequing-a',
        ...(sent ? { sentPayments: sent } : {}) },
      { id: 'min-b', debtId: 'mbna', effect: 'payment', label: 'Invented card B minimum', frequency: 'monthly',
        day: 12, amount: 30, confidence: 'confirmed', payingAccount: 'chequing-a' },
    ],
    ...(packet !== undefined ? { cardMinimumCategoryEvidence: packet } : {}),
  };
}
function record(debitId, extra) {
  return Object.assign({ scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum', debitId,
    postedOn: '2026-10-06', amount: 25, currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
    cashIncludedAsOf: '2026-10-06' }, extra || {});
}
function derived(debitId, extra) {
  return Object.assign({ id: 'min-b', scheduledDate: '2026-10-12', confirmed: true, intent: 'minimum', debitId,
    postedOn: '2026-10-12', amount: 30, currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
    cashIncludedAsOf: AS_OF, movementIdentity: { source: 'lunchmoney-minimum-category', debitId } }, extra || {});
}
const packetOf = payments => ({ source: 'lunchmoney-minimum-category', asOf: AS_OF, payments });
const out = p => F.cardMinimumOwnedDebits(p, AS_OF);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n=== (a) accepted, posted records are exported ===');
{
  const r = out(plan());
  ok(r.status === 'available' && same(r.debitIds, []), 'no owner records: available and empty', JSON.stringify(r));
  const durable = out(plan({ sent: [record(D1)] }));
  ok(durable.status === 'available' && same(durable.debitIds, [D1]), 'a durable accepted record is exported', JSON.stringify(durable));
  const both = out(plan({ sent: [record(D1)], packet: packetOf([derived(D2)]) }));
  ok(both.status === 'available' && same(both.debitIds, [D1, D2]), 'durable and derived records are exported together', JSON.stringify(both));
  const future = out(plan({ sent: [record(D1, { postedOn: '2026-10-25', scheduledDate: '2026-11-07', cashIncludedAsOf: null })] }));
  ok(future.status === 'available' && same(future.debitIds, []), 'a record posted after the as-of date is not exported yet', JSON.stringify(future));
  const backfill = out(plan({ sent: [record(D1, { intent: 'purchase-backfill' })] }));
  ok(backfill.status === 'available' && same(backfill.debitIds, []), 'a purchase backfill is not a minimum: not exported', JSON.stringify(backfill));
  const pendingDerived = out(plan({ packet: packetOf([derived(D2, { pending: true })]) }));
  ok(pendingDerived.status === 'available' && same(pendingDerived.debitIds, []), 'a pending derived record is not exported', JSON.stringify(pendingDerived));
}

console.log('\n=== (b) each debit once; conflicts are rejected, never chosen ===');
{
  // Grok Bot Q2: two owner records of one debit disagree; neither is chosen and the debit is To confirm, not Unavailable.
  const twice = out(plan({ sent: [record(D1), record(D1, { scheduledDate: '2026-11-07', postedOn: '2026-10-08', cashIncludedAsOf: null })] }));
  ok(twice.status === 'available' && same(twice.debitIds, []) && same(twice.disagreementDebitIds, [D1]),
    'one debit recorded for two occurrences: owned by neither, named as a disagreement (To confirm)', JSON.stringify(twice));
  // Grok Bot Q2: the ledger's link names another card or occurrence for an owner-recorded debit.
  const contradicted = out(plan({ sent: [record(D1)], packet: { ...packetOf([]), disagreements: [D1] } }));
  ok(contradicted.status === 'available' && same(contradicted.debitIds, []) && same(contradicted.disagreementDebitIds, [D1]),
    'an owner record the ledger link contradicts: owned by neither, named as a disagreement', JSON.stringify(contradicted));
  ok(F.cardMinimumState(plan({ sent: [record(D1)], packet: { ...packetOf([]), disagreements: [D1] } }), AS_OF).payments.length === 0,
    'and the card minimum is not marked sent for it');
  const dupPacket = out(plan({ packet: packetOf([derived(D2), derived(D2, { scheduledDate: '2026-11-12' })]) }));
  ok(dupPacket.status === 'available' && same(dupPacket.debitIds, []),
    'one derived debit offered twice is rejected by the derived validator: not exported', JSON.stringify(dupPacket));
}

console.log('\n=== (c) a withdrawn derived record drops out on the next observation ===');
{
  const first = out(plan({ packet: packetOf([derived(D2), derived(D3, { id: 'min-a', scheduledDate: '2026-10-07', postedOn: '2026-10-07', amount: 25 })]) }));
  ok(first.status === 'available' && same(first.debitIds, [D2, D3]), 'first observation: both derived debits exported', JSON.stringify(first));
  const second = out(plan({ packet: packetOf([derived(D2)]) }));
  ok(second.status === 'available' && same(second.debitIds, [D2]), 'next observation without the link: that debit is no longer exported', JSON.stringify(second));
}

console.log('\n=== (d) an unreadable owner input reads Unavailable, naming what could not be read ===');
{
  // No readable identity: any debit could be the one it owns, so the whole export is Unavailable.
  for (const [what, p, word] of [
    ['a derived packet from another source', plan({ packet: { source: 'other', asOf: AS_OF, payments: [] } }), 'ledger minimum links'],
    ['a derived packet without a payments list', plan({ packet: { source: 'lunchmoney-minimum-category', asOf: AS_OF } }), 'ledger minimum links'],
    ['a derived packet with no readable date', plan({ packet: { source: 'lunchmoney-minimum-category', asOf: 'soon', payments: [] } }), 'ledger minimum links'],
    ['durable records that are not a list', plan({ sent: { debitId: D1 } }), 'records'],
    ['a durable record missing its identity', plan({ sent: [record(undefined)] }), 'evidence'],
  ]) {
    const r = out(p);
    ok(r.status === 'unavailable' && r.debitIds === null && r.unreadable.some(u => u.what === word),
      `${what}: Unavailable, naming "${word}"`, JSON.stringify(r));
  }
  // A readable identity: only that debit is unknown; other owned debits are unaffected.
  for (const [what, bad, word] of [
    ['a durable record of unconfirmed purpose', record(D1, { intent: undefined }), 'purpose'],
    ['an unconfirmed durable record', record(D1, { confirmed: false }), 'evidence'],
  ]) {
    const r = out(plan({ sent: [bad], packet: packetOf([derived(D2)]) }));
    ok(r.status === 'available' && same(r.unknownDebitIds, [D1]) && same(r.debitIds, [D2])
      && r.unreadable.length === 1 && r.unreadable[0].id === 'min-a' && r.unreadable[0].what === word,
      `${what}: only its own debit is unknown (named "${word}"), the other card's debit is still owned`, JSON.stringify(r));
  }
  const cashGap = out(plan({ sent: [record(D1, { cashIncludedAsOf: undefined })] }));
  ok(cashGap.status === 'available' && same(cashGap.debitIds, [D1]),
    'a cash-inclusion gap concerns the amount, not ownership: the debit is still exported', JSON.stringify(cashGap));
  ok(F.cardMinimumState(plan({ sent: [record(D1, { cashIncludedAsOf: undefined })] }), AS_OF).status === 'unavailable',
    'control: the published state still reads unavailable for that gap (unchanged)');
}

console.log('\n=== the published state is unchanged and carries no identities ===');
{
  const p = plan({ sent: [record(D1)], packet: packetOf([derived(D2)]) });
  const before = clone(p);
  const state = F.cardMinimumState(p, AS_OF);
  const blob = JSON.stringify(state);
  ok(!blob.includes(D1) && !blob.includes(D2), 'cardMinimumState publishes no debit identity');
  ok(!Object.hasOwn(state, 'owned') && !Object.hasOwn(state, 'debitIds'), 'cardMinimumState has no export field');
  F.cardMinimumOwnedDebits(p, AS_OF);
  ok(same(p, before), 'the export does not modify the plan');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
