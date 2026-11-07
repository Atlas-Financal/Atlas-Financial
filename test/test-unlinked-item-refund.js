'use strict';
// The packet behind test/browser-unlinked-item-refund.js, without a browser:
// an inbound row with no item link of its own that shares its account and
// merchant with a linked item charge is flagged, and the item's link
// evidence gains one unresolved 'refund-unlinked' row. Controls (different
// merchant, different account, a refund carrying the tag) are unchanged.
// Invented household from test/acceptance/harness.js; no household figure.
//
//   node test/test-unlinked-item-refund.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');

const TRIP = '2026-12-01';
function world(extra) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: TRIP, amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.tags = [{ id: 201, name: 'invented-trip-tag' }];
  w.links = [{ tagId: 201, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: TRIP,
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
    H.lm({ id: 1, date: '2026-10-10', amount: 80, category: 'Restaurants', tagIds: [201], payee: 'Invented trip diner' }),
    H.lm({ id: 2, date: '2026-10-12', amount: -80, category: 'Restaurants', payee: 'Invented trip diner', ...extra })];
  return w;
}
function observed(extra) {
  const { packet, error } = H.observe(world(extra));
  assert.equal(error, null);
  const refund = packet.transactions.find(tx => tx.amount === -80);
  assert.ok(refund, 'positive control: the refund row is in the packet');
  return { packet, refund, evidence: packet.savingsLinks.evidence.filter(e => e.transactionRef === refund.id) };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
}

check('an untagged refund at the same merchant and account is flagged and unresolves the item', () => {
  const { packet, refund, evidence } = observed({});
  assert.equal(refund.linkedItemRefundUnresolved, true);
  assert.deepEqual(evidence.map(e => [e.direction, e.state, e.reason, e.occurrenceKey]), [['refund', 'unresolved', 'refund-unlinked', null]]);
  assert.deepEqual(evidence[0].linkRefs, packet.savingsLinks.evidence.find(e => e.direction === 'charge').linkRefs);
});
check('the same merchant in different case and spacing still matches', () => {
  const { refund } = observed({ payee: '  invented   TRIP diner ' });
  assert.equal(refund.linkedItemRefundUnresolved, true);
});
for (const [name, extra] of [
  ['a different merchant', { payee: 'Invented home diner' }],
  ['a different account', { account: 'chequing-a' }],
]) {
  check(`control: ${name} is not flagged and adds no evidence`, () => {
    const { refund, evidence } = observed(extra);
    assert.equal(refund.linkedItemRefundUnresolved, undefined);
    assert.deepEqual(evidence, []);
  });
}
check('a refund dated after the observation is not flagged and keeps the link publication', () => {
  const { packet, refund, evidence } = observed({ date: '2026-10-20' });
  assert.equal(refund.linkedItemRefundUnresolved, undefined);
  assert.deepEqual(evidence, []);
  assert.ok(packet.savingsLinks.evidence.every(e => e.date <= packet.observationAsOf),
    'no evidence row is dated after the observation (Forecast would refuse the whole publication)');
  assert.deepEqual(packet.savingsLinks.evidence.map(e => [e.direction, e.reason]), [['charge', null]]);
});
check('control: a refund carrying the tag nets as resolved item evidence', () => {
  const { refund, evidence } = observed({ tagIds: [201] });
  assert.equal(refund.linkedItemRefundUnresolved, undefined);
  assert.deepEqual(evidence.map(e => [e.direction, e.reason]), [['refund', null]]);
});
console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
