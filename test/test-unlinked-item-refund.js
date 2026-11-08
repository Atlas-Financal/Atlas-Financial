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
const F = require('../public/forecast.js');

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
check('a split refund parent whose child carries the tag adds no unresolved evidence', () => {
  const w = world({ id: 2, raw: { is_group: true } });
  w.transactions.push(H.lm({ id: 3, date: '2026-10-12', amount: -80, category: 'Restaurants', tagIds: [201],
    payee: 'Invented trip diner', raw: { parent_id: 2 } }));
  const { packet, error } = H.observe(w);
  assert.equal(error, null);
  const ev = packet.savingsLinks.evidence;
  assert.deepEqual(ev.map(e => [e.direction, e.state, e.reason]).sort(), [['charge', 'posted', null], ['refund', 'posted', null]],
    'the tagged child nets as resolved evidence; the parent adds nothing');
});
check('a refund points only at the item its charge resolves to', () => {
  // Trip category links two items; the charge's tag picks the first. An
  // untagged same-merchant refund unresolves that item only.
  const w = world({});
  w.transactions[1] = H.lm({ id: 1, date: '2026-10-10', amount: 80, category: 'Trip', tagIds: [201], payee: 'Invented trip diner' });
  w.commitments.push({ id: 'camp', label: 'Invented camp', date: TRIP, amount: 300, confidence: 'confirmed', sinkingFund: true });
  const link = (k, id, goal) => ({ [k]: id, goalRef: { kind: 'commitment', id: goal }, occurrenceDate: TRIP,
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' });
  w.links = [link('categoryId', 106, 'trip'), link('categoryId', 106, 'camp'), link('tagId', 201, 'trip')];
  const { packet, error } = H.observe(w);
  assert.equal(error, null);
  const byRef = new Map(packet.savingsLinks.links.map(l => [l.ref, l]));
  const refund = packet.transactions.find(tx => tx.amount === -80);
  const ev = packet.savingsLinks.evidence.find(e => e.transactionRef === refund.id);
  assert.equal(ev && ev.reason, 'refund-unlinked');
  assert.ok(ev.linkRefs.length > 0 && ev.linkRefs.every(ref => byRef.get(ref).goalRef.id === 'trip'),
    'the refund names only trip links, never the camp link: ' + JSON.stringify(ev.linkRefs.map(r => byRef.get(r).goalRef.id)));
});
// #927 interaction: a flagged refund is a possible refund of the item, so
// it must never settle an unrelated expected one-off of the same amount.
function rebateStatus(refundPayee) {
  const w = world({ account: 'chequing-a', payee: refundPayee, category: 'Gifts' });
  w.transactions[1] = H.lm({ id: 1, date: '2026-10-10', amount: 80, category: 'Restaurants', tagIds: [201],
    account: 'chequing-a', payee: 'Invented trip diner' });
  w.income.push({ id: 'rebate', label: 'Invented rebate', frequency: 'once', date: '2026-10-20', amount: 80,
    incomeClass: 'other', confidence: 'confirmed' });
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  const refund = packet.transactions.find(tx => tx.amount === -80);
  const view = F.recommend(data.plan, data.meta.asOf, { currentPeriodActuals: packet, debts: data.debts }).defaultView;
  const period = view.calendarPeriods.find(p => p.id === 'this-pay-period');
  const rows = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (o.id === 'rebate' && 'status' in o) { rows.push(o.status); return; }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(period, 0);
  assert.ok(rows.length > 0, 'positive control: the expected rebate row is published');
  return { flagged: refund.linkedItemRefundUnresolved === true, statuses: [...new Set(rows)] };
}
check('a flagged refund never settles an unrelated expected one-off of the same amount', () => {
  const r = rebateStatus('Invented trip diner');
  assert.equal(r.flagged, true);
  assert.deepEqual(r.statuses, ['arriving'], 'the planned 80 rebate is still arriving, not received');
});
check('control: the same unflagged refund at another merchant still settles the one-off (#927)', () => {
  const r = rebateStatus('Invented rebate office');
  assert.equal(r.flagged, false);
  assert.deepEqual(r.statuses, ['received']);
});
check('control: a refund carrying the tag nets as resolved item evidence', () => {
  const { refund, evidence } = observed({ tagIds: [201] });
  assert.equal(refund.linkedItemRefundUnresolved, undefined);
  assert.deepEqual(evidence.map(e => [e.direction, e.reason]), [['refund', null]]);
});
console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
