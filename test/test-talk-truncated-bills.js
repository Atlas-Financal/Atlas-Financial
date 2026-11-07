'use strict';
// Talk never claims a complete pay-period bill list when the packet carried
// only part of it. Invented household only: 40 bills, of which the 34 paid
// ones sort first and the 6 still due sort after the packet's 32-row cap.
//
// Expected counts come from the inputs below (40 bills, 6 due, cap 32), not
// from the code under test.
//   node test/test-talk-truncated-bills.js
const assert = require('node:assert/strict');
const Assistant = require('../scripts/assistant-packet.js');
const TP = require('../scripts/talk-presentation.js');
const TalkSession = require('../scripts/talk-session.js');

const AS_OF = '2026-09-10';
const PAID = 34;
const DUE = 6;
const TOTAL = PAID + DUE;
const CAP = 32;

function invented(paid, due) {
  const bills = [];
  const represented = [];
  for (let i = 0; i < paid; i++) {
    const date = '2026-09-' + String(10 + (i % 3)).padStart(2, '0');
    bills.push({ id: 'paid' + i, label: 'Invented paid ' + i, frequency: 'once', date, amount: 10, confidence: 'confirmed' });
    represented.push({ id: 'paid' + i, date });
  }
  for (let i = 0; i < due; i++) {
    bills.push({ id: 'due' + i, label: 'Invented due ' + i, frequency: 'once', date: '2026-09-23', amount: 20, confidence: 'confirmed' });
  }
  return {
    meta: { asOf: AS_OF },
    plan: {
      windowDays: 200,
      defaults: { targetBuffer: 0 },
      opening: { asOf: AS_OF, representedEvents: represented },
      startingCash: { amount: 4000 },
      income: [
        { id: 'p1', label: 'Pay 1', frequency: 'once', date: AS_OF, amount: 2000, confidence: 'confirmed' },
        { id: 'p2', label: 'Pay 2', frequency: 'once', date: '2026-09-25', amount: 2000, confidence: 'confirmed' },
      ],
      obligations: [], bills, commitments: [],
      budget: { categories: [{ id: 'g', label: 'Groceries', class: 'essential', plannedMonthly: 0, ownerLine: 'Groceries' }] },
      nextDollar: { policy: 'highest-interest', provenance: 'owner-stated' },
    },
    debts: [{ id: 'card', label: 'Synthetic card', secured: false, structure: 'Revolving — test',
      balance: 8000, rate: 19.99, limit: 10000, pending: 0 }],
  };
}

function packetFor(data) {
  return Assistant.buildPacket({ data, periods: null, now: '2026-09-10T12:00:00.000Z', env: {}, questionsMarkdown: '' });
}

const ref = (ask, extra) => Object.assign({ status: 'resolved-reference', referentKey: 'payday-remaining-bills', ask }, extra || {});
const present = (packet, ask, extra) => TP.presentPaydayRemainingBills(ref(ask, extra), packet);

// Hand-built packet around a bills list, for the Talk-only cases.
function handPacket(bills, extra) {
  return { schema: Assistant.SCHEMA, asOf: AS_OF, forecast: { currentPeriodAction: Object.assign({
    status: 'ok', source: 'Forecast.currentPeriodAction', bills }, extra || {}) } };
}
const row = (id, settlement) => ({ id, label: 'Invented ' + id, date: '2026-09-20', planned: 15, remaining: 15,
  actual: settlement === 'represented' ? 15 : null, settlement, confidence: 'confirmed' });

// 1. The packet carries the cap, the total and the truncation flag.
const big = packetFor(invented(PAID, DUE));
const action = big.forecast.currentPeriodAction;
assert.equal(Assistant.CURRENT_PERIOD_BILLS_MAX, CAP);
assert.equal(action.bills.length, CAP, 'packet carries 32 rows');
assert.equal(action.billsTotal, TOTAL, 'packet carries the full count');
assert.equal(action.billsTruncated, true, 'packet marks the list truncated');
assert.equal(action.bills.filter(b => b.settlement !== 'represented').length, 0,
  'the six due bills fell beyond the cap (the defect setup)');

const small = packetFor(invented(2, 1)).forecast.currentPeriodAction;
assert.equal(small.bills.length, 3);
assert.equal(small.billsTotal, 3);
assert.equal(small.billsTruncated, false, 'a short list is complete');

// 2. "What bills are left?" never says none for a truncated list.
const remaining = present(big, 'remaining');
assert.ok(!remaining.answer.includes('Forecast lists no remaining payday bills'), remaining.answer);
assert.ok(remaining.answer.includes(`showing ${CAP} of ${TOTAL} payday bills`), remaining.answer);
assert.equal(remaining.trust, 'unavailable', 'an incomplete none is unavailable, not calculated');

// 3. Named bill beyond the cap is unavailable, not "not listed".
const named = present(big, 'named', { billLabel: 'Invented due 3' });
assert.ok(!named.answer.includes('does not list'), named.answer);
assert.ok(named.answer.includes(`showing ${CAP} of ${TOTAL}`), named.answer);
assert.equal(named.trust, 'unavailable');
const shownNamed = present(big, 'named', { billLabel: 'Invented paid 0' });
assert.ok(shownNamed.answer.includes('Invented paid 0 is represented'), shownNamed.answer);
assert.notEqual(shownNamed.trust, 'unavailable', 'a bill that is shown still answers');
assert.ok(shownNamed.answer.includes(`This list is incomplete (showing ${CAP} of ${TOTAL} payday bills)`),
  'a found bill on an incomplete list says another bill could also match: ' + shownNamed.answer);

// 4. Covered list: shown rows plus an incompleteness note.
const covered = present(big, 'covered');
assert.ok(covered.answer.includes(TP.REMAINING_BILLS_COVERED_LEAD), covered.answer);
assert.ok(covered.answer.includes(`This list is incomplete (showing ${CAP} of ${TOTAL} payday bills)`), covered.answer);

// 5. A truncated list that does show due bills says it is incomplete.
const mixed = handPacket([row('a', 'upcoming')].concat(Array.from({ length: CAP - 1 }, (_, i) => row('r' + i, 'represented'))),
  { billsTotal: 50, billsTruncated: true });
const mixedAnswer = present(mixed, 'remaining');
assert.ok(mixedAnswer.answer.includes('Invented a is still due'), mixedAnswer.answer);
assert.ok(mixedAnswer.answer.includes('showing 32 of 50 payday bills'), mixedAnswer.answer);
const emptyCovered = present(handPacket([row('a', 'upcoming')], { billsTotal: 9, billsTruncated: true }), 'covered');
assert.equal(emptyCovered.trust, 'unavailable');
assert.ok(!emptyCovered.answer.includes(TP.REMAINING_BILLS_COVERED_EMPTY), emptyCovered.answer);

// 5b. A row Forecast listed but the packet could not project (no id, no
// label) also makes the list incomplete, below the cap.
{
  const Forecast = require('../public/forecast.js');
  const recommend = Forecast.recommend;
  Forecast.recommend = function (...args) {
    const advice = recommend.apply(this, args);
    if (advice && advice.currentPeriodAction && Array.isArray(advice.currentPeriodAction.bills)) {
      advice.currentPeriodAction.bills.push({ date: '2026-09-23', planned: 20, remaining: 20, settlement: 'upcoming' });
    }
    return advice;
  };
  let dropped;
  try { dropped = packetFor(invented(2, 0)).forecast.currentPeriodAction; } finally { Forecast.recommend = recommend; }
  assert.equal(dropped.bills.length, 2, 'unprojectable row is not carried');
  assert.equal(dropped.billsTotal, 3);
  assert.equal(dropped.billsTruncated, true);
  const answer = present({ forecast: { currentPeriodAction: dropped } }, 'remaining');
  assert.equal(answer.trust, 'unavailable', answer.answer);
  assert.ok(answer.answer.includes('showing 2 of 3 payday bills'), answer.answer);
}

// 6. Complete lists keep their existing answers.
const done = present(packetFor(invented(3, 0)), 'remaining');
assert.equal(done.answer, 'Forecast lists no remaining payday bills before the next payday.');
assert.equal(done.trust, 'calculated');
const notListed = present(packetFor(invented(3, 0)), 'named', { billLabel: 'Invented missing' });
assert.ok(notListed.answer.includes('does not list Invented missing'), notListed.answer);

// 7. Completeness rule: a packet without the fields at the cap, or one whose
// flag disagrees with its count, is incomplete.
const cmp = TP.remainingBillsCompleteness;
const rows = n => Array.from({ length: n }, (_, i) => row('x' + i, 'represented'));
assert.deepEqual(cmp({ bills: rows(CAP) }), { complete: false, listed: CAP, total: null });
assert.ok(present(handPacket(rows(CAP)), 'remaining').answer.includes('showing only the first 32 payday bills'));
assert.equal(cmp({ bills: rows(5) }).complete, true, 'legacy short list is complete');
assert.equal(cmp({ bills: rows(5), billsTruncated: false, billsTotal: 7 }).complete, false, 'count mismatch is incomplete');
assert.equal(cmp({ bills: rows(5), billsTruncated: false }).complete, false, 'missing count with flag is incomplete');
assert.equal(cmp({ bills: rows(5), billsTruncated: false, billsTotal: 5 }).complete, true);
assert.deepEqual(cmp({ bills: rows(5), billsTruncated: true, billsTotal: 3 }), { complete: false, listed: 5, total: null },
  'an impossible total is not printed');
assert.equal(cmp(null).complete, false);

// 8. Session: "the one still-due bill" is not named from a truncated list.
const one = [row('solo', 'upcoming')].concat(rows(CAP - 1));
const truncSession = TalkSession.resolveVerifiedReference({ question: 'What bills are left?', priorTurn: null,
  packet: handPacket(one, { billsTotal: 40, billsTruncated: true }) });
assert.equal(truncSession.status, 'resolved-reference');
assert.equal(truncSession.billId, undefined, 'no single-bill referent from a truncated list');
const fullSession = TalkSession.resolveVerifiedReference({ question: 'What bills are left?', priorTurn: null,
  packet: handPacket([row('solo', 'upcoming'), row('r', 'represented')], { billsTotal: 2, billsTruncated: false }) });
assert.equal(fullSession.billId, 'solo', 'a complete list still names its only due bill');

console.log('Talk never claims a complete bill list from a truncated packet: ok');
