'use strict';
/* Lead 2026-11-18 (found while verifying census rank 16): a near-due bill
 * payment that is first seen pending and then posts days later, without a
 * provider link between the two rows, was counted twice. The pending row made
 * a pending-only bill row (linked evidence, never a payment), and the
 * near-due check read that row as "already settled", so the posted copy lost
 * its To-confirm hold and counted as household spending while the bill stayed
 * reserved. Now a pending-only row never counts as settled there: the posted
 * copy stays held To confirm on the bill. The payment is deducted once, and a
 * posted copy the provider links to the pending row still settles the bill.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend and the classifier.
 *
 * Invented world: Dale 1400 on Fri Oct 9 (pay period Oct 9-22); an invented
 * $100 hydro bill due monthly on Thu the 15th, paid from Bills, identified by
 * its payee; plan date Sat Oct 17. With no payment the period's balance after
 * deductions is 900 in this world (the bill's 100 reserved once). Hand-derived:
 * the one payment, reserved through the bill, must leave it at 900; deducting it
 * twice (reserved and also spent) gives 900 - 100 = 800. A second real payment
 * beside a bill a posted payment already settled is spending, so that gives 800.
 *
 * `node test/test-near-due-pending-replacement.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

// Every trust, confidence and claim field in the recommend() output.
const TAG_KEY = /trust|confidence|claim|certain|verified|precis/i;

let nextId = 990000;
const debit = (date, { pending = false, raw, amount = 100 } = {}) => H.lm({ id: ++nextId, date, amount, account: 'chequing-a',
  payee: 'Invented Hydro', category: 'Utilities', pending, raw });

function serve(txs, asOf = '2026-10-17') {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-10-01';
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 100, frequency: 'monthly', day: 15, firstDue: '2026-09-15',
    confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true }];
  w.identityRules = w.identityRules.concat([{ eventId: 'hydro', payeePattern: 'Invented Hydro', atlasAccountId: 'chequing-a', direction: 'debit' }]);
  w.transactions = [H.lm({ id: ++nextId, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...txs];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const current = adv.defaultView.calendarPeriods.find(p => p.start <= asOf && p.end >= asOf);
  const bill = (current.bills || []).find(b => b.id === 'hydro' && b.date === '2026-10-15');
  const rows = (packet.transactions || []).filter(t => t.category === 'Utilities' || /hydro/i.test(String(t.payee || t.description || '')) || [90, 100, 100.01].includes(Math.abs(Number(t.amount)))).map(t => ({
    amount: Math.abs(Number(t.amount)),
    date: t.date, pending: t.pending === true,
    cls: F.classifyCurrentPeriodTransaction(t, r.data.plan, { currentPeriodActuals: packet }),
  }));
  const tags = {};
  (function walk(o, path, seen) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k], q = path + '.' + k;
      if (TAG_KEY.test(k) && (typeof v !== 'object' || v === null)) tags[q] = v;
      walk(v, q, seen);
    }
  })(adv, '', new Set());
  return { bill, rows, tags, claim: adv.currentPeriodAction.categoryRemainingClaim,
    remaining: current.remainingBills, balance: current.balanceAfterDeductions,
    paid: (packet.representedActuals || []).filter(x => x.id === 'hydro').map(x => x.date + (x.pending ? ':pending' : ':posted')) };
}
const spends = row => row.cls.householdSpending === true;

console.log('1. Pending on the due date, then posted two days later with no provider link');
{
  const s = serve([debit('2026-10-15', { pending: true }), debit('2026-10-17')]);
  ok(s.balance === 900, 'the payment is deducted once: balance after deductions 900, never 800', String(s.balance));
  ok(s.remaining === 100 && s.bill.status === 'pending', 'the bill stays reserved once and reads Payment pending, not Paid',
    JSON.stringify([s.remaining, s.bill.status]));
  const posted = s.rows.find(r => !r.pending);
  ok(posted && !spends(posted) && posted.cls.reason === 'near-due-bill-unconfirmed' && posted.cls.billCandidate
    && posted.cls.billCandidate.id === 'hydro', 'the posted copy is held To confirm on the bill, never household spending',
    JSON.stringify(posted && posted.cls));
  ok(s.rows.every(r => !spends(r)), 'neither row is household spending while the bill is reserved');
}

console.log('2. A posted copy the provider links to the pending row settles the bill once');
for (const [label, postedOn] of [['two days late', '2026-10-17'], ['on the due date', '2026-10-15']]) {
  const s = serve([debit('2026-10-15', { pending: true, raw: { plaid_metadata: { transaction_id: 'P-' + postedOn } } }),
    debit(postedOn, { raw: { plaid_metadata: { transaction_id: 'Q-' + postedOn, pending_transaction_id: 'P-' + postedOn } } })]);
  ok(s.bill.status === 'PAID' && s.remaining === 0 && s.balance === 900 && JSON.stringify(s.paid) === JSON.stringify(['2026-10-15:posted']),
    `linked, posted ${label}: PAID once, nothing left to reserve, balance 900`, JSON.stringify([s.bill.status, s.remaining, s.balance, s.paid]));
}

console.log('3. Unchanged cases');
{
  const none = serve([]);
  ok(none.balance === 900 && none.remaining === 100 && none.bill.status === 'still due', 'no payment: still due, reserved, balance 900');
  const pending = serve([debit('2026-10-15', { pending: true })]);
  ok(pending.balance === 900 && pending.remaining === 100 && pending.bill.status === 'pending', 'pending only: Payment pending, reserved, 900');
  const late = serve([debit('2026-10-17')]);
  ok(late.balance === 900 && late.remaining === 100 && late.rows[0].cls.reason === 'near-due-bill-unconfirmed',
    'a posted payment two days late on its own: held To confirm, reserved, 900');
  // A real second payment beside an occurrence a posted payment already settled is still spending (two debits, 800).
  const second = serve([debit('2026-10-15'), debit('2026-10-17')]);
  ok(second.bill.status === 'PAID' && second.remaining === 0 && second.balance === 800
    && spends(second.rows.find(r => r.date === '2026-10-17')),
    'paid on the due date plus another payment two days later: the second is spending (800), as on main',
    JSON.stringify([second.bill.status, second.balance]));
}

console.log('4. No trust, confidence or claim field moves from main (pending on the 15th, posted on the 17th)');
{
  // Captured from main c5250847 for this exact invented case (before the
  // hold): the category remaining claim reads classified-incomplete there.
  const onMain = require('./fixtures/near-due-pending-replacement-main-tags.json');
  const s = serve([debit('2026-10-15', { pending: true }), debit('2026-10-17')]);
  const keys = new Set([...Object.keys(onMain), ...Object.keys(s.tags)]);
  const moved = [...keys].filter(k => s.tags[k] !== onMain[k]);
  ok(Object.keys(onMain).length > 100 && moved.length === 0,
    `all ${Object.keys(onMain).length} fields equal main, so none moves toward certainty`, JSON.stringify(moved.map(k => [k, onMain[k], s.tags[k]])));
  ok(s.claim === 'classified-incomplete', 'the unresolved pending copy keeps the category remaining claim classified-incomplete, never precise', s.claim);
  // Control: a posted payment late on its own (no pending copy) keeps main's claim too.
  const late = serve([debit('2026-10-17')]);
  ok(late.claim === 'precise', 'control: a lone late posted payment held To confirm reads precise, as on main', late.claim);
}

console.log('5. Pending on the due date, then a posted debit at a different amount (#1315 re-review note)');
{
  // Hand-derived, same world (income 1400, Household 400, the 100 bill reserved once: 900 with no other spend).
  // The posted debit is that pending charge posting only if it is the pending amount to the cent. Any other amount
  // may be a separate charge beside a bill still pending, so the cautious reading keeps the bill reserved (pending)
  // and counts the posted debit as spending: 900 - 90 = 810, and 900 - 100.01 = 799.99. Reading the 90 as the bill
  // would publish 900, overstating cash by 90 whenever it is a second charge.
  for (const [label, amount, balance] of [['90 (a lower final amount, or a separate charge)', 90, 810], ['100.01 (one cent over)', 100.01, 799.99]]) {
    const s = serve([debit('2026-10-15', { pending: true }), debit('2026-10-16', { amount })]);
    const posted = s.rows.find(r => !r.pending && r.amount === amount);
    ok(s.balance === balance, `posted ${label}: balance after deductions ${balance}, never 900`, String(s.balance));
    ok(s.remaining === 100 && s.bill.status === 'pending', `posted ${label}: the bill stays reserved once and reads Payment pending`,
      JSON.stringify([s.remaining, s.bill.status]));
    ok(posted && spends(posted), `posted ${label}: the posted debit is household spending, not held on the bill`, JSON.stringify(posted && posted.cls));
  }
  // Controls: the exact amount is the pending charge posting (900, section 1); a lower posted debit with no
  // pending copy keeps the incumbent near-due tolerance (held To confirm on the bill, 900).
  const exact = serve([debit('2026-10-15', { pending: true }), debit('2026-10-16')]);
  ok(exact.balance === 900, 'control: posted at exactly the pending 100.00 is that charge posting: 900', String(exact.balance));
  const alone = serve([debit('2026-10-16', { amount: 90 })]);
  const held = alone.rows.find(r => !r.pending && r.amount === 90);
  ok(alone.balance === 900 && held && held.cls.reason === 'near-due-bill-unconfirmed',
    'control: a lone posted 90 with no pending copy keeps the incumbent tolerance (held To confirm, 900)', JSON.stringify([alone.balance, held && held.cls.reason]));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll near-due pending-replacement checks passed.');
