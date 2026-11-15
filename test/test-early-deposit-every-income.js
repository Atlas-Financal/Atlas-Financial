'use strict';
// A2 (owner-approved audit, 1.0): an early deposit must not be counted twice. A scheduled
// income that posts a day before its date is already inside today's cash; the cash walk
// still counts the occurrence on its scheduled day, which inflated the weekly cap until
// then (invented benefit $500 scheduled Aug 21, posted Aug 20: weekly 1,255 against 1,210
// when it posts on time). The early-deposit guard existed for payroll and the salary pair
// only; it now covers every scheduled income with its own credit identity rule into Bills.
// Required outcome: the early case equals the on-time case, or withholds. Here it withholds
// (the operating plan is unavailable with the existing "occurrence is unresolved" reason),
// so no figure counts the deposit twice. Invented data only, through the real observer and
// overlay path; expectations are the fixture's own literals.
const assert = require('node:assert/strict');
const fx = require('./fixtures/budget-surface-data');
const Live = require('../scripts/live-plan');

let checks = 0;
const ok = (cond, label, detail) => { assert.ok(cond, label + (detail ? ' - ' + detail : '')); checks++; };

// A $500 monthly benefit (id 'benefit') scheduled on `schedDay`, one posting on `postDay`.
// The deposit is already inside the observed Bills balance (1,215 + 500).
function world(schedDay, postDay, { payee = 'Synthetic benefit', rule = true } = {}) {
  const data = fx.canonical();
  data.plan.income.push({ id: 'benefit', label: 'Synthetic benefit', frequency: 'monthly', day: schedDay, amount: 500, confidence: 'confirmed' });
  const payload = fx.payload();
  payload.accounts.find(account => account.id === 1001).balance += 500;
  payload.transactions.push({ id: 93001, account_id: 1001, date: '2026-08-' + String(postDay).padStart(2, '0'), amount: -500,
    currency: 'cad', payee, category_id: 15, is_pending: false, status: 'cleared' });
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    ...(rule ? [{ eventId: 'benefit', payeePattern: 'Synthetic benefit', atlasAccountId: 'chequing-a', direction: 'credit' }] : [])] };
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}
const overlay = data => data.liveOverlay;
const represented = data => (overlay(data).representedEvents || []).map(event => event.id + '@' + event.date);

// On time: the posting is the Aug 20 occurrence, represented once, the plan is live.
const onTime = world(20, 20);
ok(overlay(onTime).applied === true && overlay(onTime).operatingPlan === 'live', 'on-time deposit: the operating plan is live');
ok(represented(onTime).includes('benefit@2026-08-20'), 'on-time deposit: the occurrence is represented once, inside current cash', represented(onTime).join(','));

// Early: posted Aug 20 for the Aug 21 occurrence. It is not represented (the guard never
// attaches a receipt to a future occurrence), so the walk would count Aug 21 again:
// the plan is withheld instead, with the existing unresolved-occurrence reason.
const early = world(21, 20);
ok(overlay(early).applied === true && overlay(early).operatingPlan === 'unavailable',
  'early deposit: the operating plan is withheld, never a cap with the deposit counted twice', String(overlay(early).operatingPlan));
ok(/scheduled occurrence is unresolved/i.test(overlay(early).operatingPlanNote || ''),
  'early deposit: the reason is the unresolved-occurrence note', (overlay(early).operatingPlanNote || '').slice(0, 120));
ok(!represented(early).some(id => id.startsWith('benefit@')), 'early deposit: it is not attached to the future occurrence');

// Controls: nothing else is withheld by the wider guard.
const otherPayee = world(21, 20, { payee: 'Synthetic refund' });
ok(overlay(otherPayee).operatingPlan === 'live', 'a credit that does not match the income identity rule withholds nothing');
const noRule = world(21, 20, { rule: false });
ok(overlay(noRule).operatingPlan === 'live', 'an income with no identity rule is left to its own evidence (unchanged)');
const previous = world(14, 14);
ok(overlay(previous).operatingPlan === 'live', 'a deposit on its own earlier scheduled day withholds nothing');
// Late postings are not early ones (blocker on #1147): income has no after-the-day tolerance, so
// a deposit one day late, or a Friday occurrence landing Monday, is unclaimed. It is that
// occurrence's late posting, never an early one for NEXT month's, so the plan stays live (the
// same as it was before the guard was widened; byte-identity with main for these worlds was
// checked outside this test, by hashing the served document on both trees).
for (const [label, sched, post] of [['one day late (scheduled Aug 18, posted Aug 19)', 18, 19], ['Friday occurrence landing Monday (Aug 14 -> Aug 17)', 14, 17]]) {
  const late = world(sched, post);
  ok(overlay(late).applied === true && overlay(late).operatingPlan === 'live', label + ': the operating plan stays live', String(overlay(late).operatingPlan));
  ok(!(late.liveOverlay.currentPeriodActuals && late.liveOverlay.currentPeriodActuals.incomeReconciliation),
    label + ': no unresolved-occurrence hold on next month');
}

// The occurrence just before the credit decides (second blocker on #1147: the first repair
// looked at EVERY earlier occurrence, so one old unposted occurrence in the window switched the
// early-deposit hold off for every later credit). A biweekly benefit, observed Aug 27 (the
// Aug 14 occurrence is after the Aug 13 opening, so its on-time posting is claimed and
// represented). An extra credit on Aug 27 for the Aug 28 occurrence is the NEXT one arriving
// early and must withhold, whatever older occurrences did; when the previous occurrence was
// never posted, a credit after it is its late posting and stays live.
function biweekly({ anchor, postDates, windowStart = '2026-07-20' }) {
  const asOf = '2026-08-27';
  const data = fx.canonical();
  data.plan.income.push({ id: 'benefit', label: 'Synthetic benefit', frequency: 'biweekly', anchor, amount: 500, confidence: 'confirmed' });
  const payload = fx.payload();
  payload.fetchedAt = asOf + 'T18:00:00.000Z';
  payload.transactionWindow.startDate = windowStart;
  payload.transactionWindow.endDate = asOf;
  for (const account of payload.accounts) { account.updated_at = asOf + 'T17:55:00.000Z'; account.balance_last_update = asOf + 'T17:55:00.000Z'; }
  payload.accounts.find(account => account.id === 1001).balance += 500 * postDates.length;
  let id = 93100;
  for (const date of postDates) {
    payload.transactions.push({ id: ++id, account_id: 1001, date, amount: -500, currency: 'cad', payee: 'Synthetic benefit',
      category_id: 15, is_pending: false, status: 'cleared' });
  }
  const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [...fx.identity.rules,
    { eventId: 'benefit', payeePattern: 'Synthetic benefit', atlasAccountId: 'chequing-a', direction: 'credit' }] };
  return Live.fromObservation({ data, payload, accountMap: fx.map, identity }).data;
}
{
  // Window from Aug 1: only Aug 14 (claimed) and Aug 28 are in play. The common recurring case.
  const claimedEarly = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14', '2026-08-27'], windowStart: '2026-08-01' });
  ok(represented(claimedEarly).includes('benefit@2026-08-14'), 'control: the Aug 14 occurrence is claimed by its own on-time posting', represented(claimedEarly).join(','));
  ok(overlay(claimedEarly).operatingPlan === 'unavailable',
    'claimed previous occurrence + an early credit for the next: withheld', String(overlay(claimedEarly).operatingPlan));
  const onTimeOnly = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14'], windowStart: '2026-08-01' });
  ok(overlay(onTimeOnly).operatingPlan === 'live', 'control: the on-time posting alone stays live', String(overlay(onTimeOnly).operatingPlan));
  // Window from Jul 20 also holds the Jul 31 occurrence, which nothing claims. It is older than the
  // previous occurrence and must not switch the hold off (fails on the first repair).
  const oldUnclaimed = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-14', '2026-08-27'] });
  ok(!represented(oldUnclaimed).includes('benefit@2026-07-31') && represented(oldUnclaimed).includes('benefit@2026-08-14'),
    'control: Jul 31 is unclaimed and Aug 14 is claimed', represented(oldUnclaimed).join(','));
  ok(overlay(oldUnclaimed).operatingPlan === 'unavailable',
    'an older unclaimed occurrence in the window does not turn the early-deposit hold off', String(overlay(oldUnclaimed).operatingPlan));
  // The previous occurrence itself never posted: a credit after it is its late posting.
  const lateRecurring = biweekly({ anchor: '2026-08-14', postDates: ['2026-08-16'] });
  ok(overlay(lateRecurring).operatingPlan === 'live', 'recurring income posted two days late stays live', String(overlay(lateRecurring).operatingPlan));
}
console.log(`PASS early deposit counted once for every scheduled income: ${checks} checks`);
