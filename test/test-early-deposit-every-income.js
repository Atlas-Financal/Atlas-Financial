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
// occurrence's late posting, never an early one for NEXT month's, so the plan stays live, exactly
// as it did before the guard was widened (byte-identical to main for these worlds).
for (const [label, sched, post] of [['one day late (scheduled Aug 18, posted Aug 19)', 18, 19], ['Friday occurrence landing Monday (Aug 14 -> Aug 17)', 14, 17]]) {
  const late = world(sched, post);
  ok(overlay(late).applied === true && overlay(late).operatingPlan === 'live', label + ': the operating plan stays live', String(overlay(late).operatingPlan));
  ok(!(late.liveOverlay.currentPeriodActuals && late.liveOverlay.currentPeriodActuals.incomeReconciliation),
    label + ': no unresolved-occurrence hold on next month');
}
// An extra credit after an occurrence that WAS claimed can still be the next one arriving early.
{
  const both = world(21, 20);
  ok(overlay(both).operatingPlan === 'unavailable', 'control: the early deposit still withholds');
}
console.log(`PASS early deposit counted once for every scheduled income: ${checks} checks`);
