'use strict';
/* S3 (Grok Bot, rule 17, Plan #6 LM thread 2026-11-17: "B, one at a time,
 * with one guard"; opt-in per rule). A rule identified by its Lunch Money
 * recurring link that opts in with postingDateRule
 * 'lunchmoney-linked-earliest-unsettled' settles, for each linked posted
 * payment taken oldest first, the EARLIEST unsettled occurrence, never one
 * ahead of the next due occurrence, whatever date it posts. A second linked
 * payment in a cycle reads To confirm and never settles the next occurrence by
 * itself (Grok's guard), including after a refund and repay. "To confirm" is
 * the incumbent meaning for a link-identified bill (test-bill-link-cross-date-
 * conflict): the payment is represented by no bill and the occurrence stays
 * unsettled until Money checks it.
 *
 * Invented world (test/acceptance/harness.js): payday anchor 2026-10-09,
 * biweekly; the opening is dated 2026-10-09, so Sep 1 and Oct 1 sit inside
 * the opening cash (already settled). An invented $80 band-room bill,
 * monthly on the 1st, firstDue 2026-09-01, paid from Bills (chequing-a),
 * identified by the Lunch Money recurring link 7123457 alone.
 * Hand-derived, as of 2026-10-14 (periods Oct 9-22, Oct 23-Nov 5):
 *   - paid Oct 12, 20 days before Nov 1: the earliest unsettled occurrence is
 *     Nov 1 (the next due), so Nov 1 reads PAID. The incumbent 7-day early
 *     rule leaves it still due (control);
 *   - paid Oct 10 and Oct 12: Oct 10 settles Nov 1; Oct 12 is the second in
 *     the same cycle and would settle Dec 1, so it reads To confirm and Dec 1
 *     stays unsettled.
 * As of 2026-11-10 (period Nov 6-19): paid Nov 5 (late) settles Nov 1; a
 * second payment on Nov 8 reads To confirm and does not settle Dec 1.
 *
 * `node test/test-lunchmoney-linked-earliest-unsettled.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const ID = '7123457';
const RULE = 'lunchmoney-linked-earliest-unsettled';

let nextId = 640000;
const pay = (date, amount = 80, extra = {}) => H.lm({ id: ++nextId, date, amount, account: 'chequing-a',
  payee: 'Invented e-transfer', raw: { recurring_id: Number(ID), ...extra } });

function serve({ asOf = '2026-10-14', payments = [], rule = RULE, represented = [] }) {
  const w = H.baseWorld(asOf);
  w.bills = [{ id: 'band', label: 'Invented band room', amount: 80, frequency: 'monthly', day: 1, firstDue: '2026-09-01',
    confidence: 'estimated', dateConfidence: 'estimated', payingAccount: 'chequing-a', householdObligation: true }];
  w.identityRules = w.identityRules.concat([{ eventId: 'band', lunchMoneyRecurringIds: [ID], atlasAccountId: 'chequing-a',
    direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: rule }]);
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...payments];
  if (represented.length) w.planPatch = plan => {
    plan.opening = { ...(plan.opening || {}), representedEvents: represented.map(date => ({ id: 'band', date })) };
  };
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const bills = adv.defaultView.calendarPeriods.flatMap(p => (p.bills || []).filter(b => b.id === 'band'));
  const at = date => bills.find(b => b.date === date) || null;
  const paidOn = new Set((packet.representedActuals || []).filter(row => row.id === 'band').map(row => row.date));
  const row = date => packet.transactions.find(t => t.date === date && t.amount === 80) || null;
  return { applied: r.data.liveOverlay.applied, at, paidOn, row, report: r.report };
}
const due = b => !!b && /still due/i.test(b.status);

console.log('1. Paid 20 days early: the earliest unsettled occurrence (Nov 1) is paid');
{
  const s = serve({ payments: [pay('2026-10-12')] });
  ok(s.applied === true, 'the overlay applies');
  ok(s.paidOn.has('2026-11-01') && s.paidOn.size === 1, 'exactly Nov 1 is represented', JSON.stringify([...s.paidOn]));
  // Nov 1 sits in the next pay period, where Forecast prints a settled
  // future occurrence as planned rather than still due.
  ok(s.at('2026-11-01') && !due(s.at('2026-11-01')), 'Nov 1 no longer reads still due', s.at('2026-11-01') && s.at('2026-11-01').status);
  ok(s.row('2026-10-12') && s.row('2026-10-12').representedBill === true, 'the payment is the bill, not spending');
  const control = serve({ payments: [pay('2026-10-12')], rule: 'covers-early-or-due-on-or-before-posting' });
  ok(due(control.at('2026-11-01')) && !control.paidOn.has('2026-11-01'),
    'control: the incumbent 7-day rule leaves Nov 1 still due', control.at('2026-11-01') && control.at('2026-11-01').status);
}

console.log('2. A second linked payment in the cycle reads To confirm and settles nothing (Grok\'s guard)');
{
  const s = serve({ payments: [pay('2026-10-10'), pay('2026-10-12')] });
  ok(s.paidOn.has('2026-11-01') && !s.paidOn.has('2026-12-01') && s.paidOn.size === 1,
    'the first settles Nov 1; Dec 1 is not settled', JSON.stringify([...s.paidOn]));
  const second = s.row('2026-10-12');
  ok(second && second.representedBill !== true, 'the second is not the bill');
  ok(second && second.representedBill === false, 'the second is represented by no bill (To confirm)');
}

console.log('3. Refund then repay: the repay is the second payment in the cycle, To confirm');
{
  const s = serve({ payments: [pay('2026-10-10'), pay('2026-10-11', -80), pay('2026-10-12')] });
  ok(s.paidOn.has('2026-11-01') && !s.paidOn.has('2026-12-01') && s.paidOn.size === 1,
    'Nov 1 settled once; the repay does not settle Dec 1', JSON.stringify([...s.paidOn]));
  const repay = s.row('2026-10-12');
  ok(repay && repay.representedBill === false, 'the repay is represented by no bill (To confirm)');
}

console.log('4. Paid late: the overdue occurrence is settled; a second payment never settles the next one');
{
  const late = serve({ asOf: '2026-11-10', payments: [pay('2026-11-05')] });
  ok(late.paidOn.has('2026-11-01') && late.paidOn.size === 1, 'paid Nov 5: Nov 1 is represented', JSON.stringify([...late.paidOn]));
  const twice = serve({ asOf: '2026-11-10', payments: [pay('2026-11-05'), pay('2026-11-08')] });
  ok(twice.paidOn.has('2026-11-01') && !twice.paidOn.has('2026-12-01'), 'a second payment on Nov 8 does not settle Dec 1',
    JSON.stringify([...twice.paidOn]));
  const second = twice.row('2026-11-08');
  ok(second && second.representedBill === false, 'Nov 8 is represented by no bill (To confirm)');
  ok(due(twice.at('2026-12-01')) || !twice.at('2026-12-01'), 'Dec 1 is not settled by it',
    twice.at('2026-12-01') && twice.at('2026-12-01').status);
}

console.log('5. Unchanged gates: an inconsistent amount, an unlinked payment and a pending one settle nothing');
{
  const odd = serve({ payments: [pay('2026-10-12', 800)] });
  ok(!odd.paidOn.has('2026-11-01'), 'ten times the bill amount does not settle it', JSON.stringify([...odd.paidOn]));
  const unlinked = serve({ payments: [H.lm({ id: ++nextId, date: '2026-10-12', amount: 80, account: 'chequing-a',
    payee: 'Invented e-transfer' })] });
  ok(!unlinked.paidOn.has('2026-11-01'), 'an unlinked payment does not settle it');
  const pending = serve({ payments: [pay('2026-10-12', 80, { is_pending: true, status: 'pending' })] });
  ok(!pending.paidOn.has('2026-11-01'), 'a pending linked payment does not settle it');
}

console.log('5b. Never more than one ahead; a wrong-amount payment does not count in its cycle');
{
  // Nov 1 is already represented by the opening; Oct 12 has nothing left up
  // to its next due occurrence (Nov 1), and must not reach ahead to Dec 1.
  const ahead = serve({ payments: [pay('2026-10-12')], represented: ['2026-11-01'] });
  ok(!ahead.paidOn.has('2026-12-01'), 'with Nov 1 already settled, Oct 12 does not settle Dec 1', JSON.stringify([...ahead.paidOn]));
  // $800 on Oct 10 fails the amount bound; the $80 on Oct 12 is then the first
  // payment of the cycle and settles Nov 1.
  const mixed = serve({ payments: [pay('2026-10-10', 800), pay('2026-10-12')] });
  ok(mixed.paidOn.has('2026-11-01') && mixed.paidOn.size === 1, 'the $80 after an $800 still settles Nov 1',
    JSON.stringify([...mixed.paidOn]));
}

console.log('6. The assignment never reaches the served packet');
{
  const s = serve({ payments: [pay('2026-10-10'), pay('2026-10-12')] });
  const blob = JSON.stringify(s.row('2026-10-10')) + JSON.stringify(s.row('2026-10-12'));
  ok(!/lmLinkedAssignment|linkedSecondInCycle/.test(blob), 'no assignment field on the packet rows');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Lunch Money linked earliest-unsettled checks passed.');
