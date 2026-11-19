'use strict';
/* Lead dispatch 2026-11-18 (after #1315): a bill payment first seen pending on
 * a day other than its due date, then posted days later with no provider link,
 * is deducted once. #1315 fixed only the pending-on-the-due-date case.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend and the classifier.
 *
 * Invented world (as #1315's test): Dale 1400 on Fri Oct 9 (pay period
 * Oct 9-22); an invented $100 hydro bill due monthly on Thu the 15th, paid from
 * Bills, identified by its payee; plan date Sat Oct 17. With no payment the
 * period's balance after deductions is 900 (the bill's 100 reserved once).
 * Hand-derived: one payment, reserved through the bill or settling it, leaves
 * 900; deducting it twice gives 900 - 100 = 800. Two real payments give 800.
 *
 * `node test/test-pending-then-posted-bill-once.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

let nextId = 991000;
const debit = (date, { pending = false, amount = 100 } = {}) => H.lm({ id: ++nextId, date, amount, account: 'chequing-a',
  payee: 'Invented Hydro', category: 'Utilities', pending });

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
  const rows = (packet.transactions || []).filter(t => Math.abs(Number(t.amount)) !== 1400).map(t => ({
    date: t.date, pending: t.pending === true, duplicate: t.pendingPostedDuplicate === true, copy: t.pendingBillCopy === true,
    cls: F.classifyCurrentPeriodTransaction(t, r.data.plan, { currentPeriodActuals: packet }),
  }));
  const other = (current.householdBudget || []).find(b => b.id === 'other-spending') || {};
  return { bill, rows, remaining: current.remainingBills, balance: current.balanceAfterDeductions,
    claim: adv.currentPeriodAction.categoryRemainingClaim, other,
    paid: (packet.representedActuals || []).filter(x => x.id === 'hydro').map(x => x.date + (x.pending ? ':pending' : ':posted')) };
}
const held = row => row && row.cls.reason === 'near-due-bill-unconfirmed' && row.cls.billCandidate
  && row.cls.billCandidate.id === 'hydro' && row.cls.householdSpending !== true;
// The pending copy stays in the packet, set aside as a possible replacement
// and marked as the bill's pending copy; the posted payment is not flagged.
const pendingCopy = s => s.rows.length === 2 && s.rows.some(r => r.pending && r.duplicate && r.copy)
  && s.rows.every(r => r.pending || !r.copy);
const visiblePair = s => pendingCopy(s) && s.rows.every(r => r.pending || !r.duplicate);
// Before this change the copy was unclassified spending; it is no longer
// spent, but the claim stays classified-incomplete and Other is an estimate.
const cautious = s => s.claim === 'classified-incomplete' && s.other.spent === 0 && s.other.trust === 'estimated'
  && s.other.estimateReason === 'possible-duplicate';

console.log('1. Pending Oct 16, posted Oct 17, no provider link: deducted once, To confirm');
{
  const s = serve([debit('2026-10-16', { pending: true }), debit('2026-10-17')]);
  ok(s.balance === 900, 'balance after deductions 900, never 800', String(s.balance));
  ok(s.remaining === 100 && s.bill.status === 'still due', 'the bill stays reserved once; the unlinked off-date posted row does not make it Paid',
    JSON.stringify([s.remaining, s.bill.status]));
  ok(held(s.rows.find(r => !r.pending)), 'the posted row is held To confirm on the bill');
  ok(visiblePair(s), 'both rows stay in the packet; the pending side is the possible replacement, listed, never dropped');
  ok(cautious(s), 'no tag moves toward certainty: claim stays classified-incomplete; Other reads 0, estimated, possible duplicate',
    JSON.stringify([s.claim, s.other.spent, s.other.trust, s.other.estimateReason]));
}

console.log('2. Pending Oct 13, posted Oct 15 (the due date), no provider link: PAID once');
{
  const s = serve([debit('2026-10-13', { pending: true }), debit('2026-10-15')]);
  ok(s.balance === 900, 'balance after deductions 900, never 800', String(s.balance));
  ok(s.bill.status === 'PAID' && s.remaining === 0 && JSON.stringify(s.paid) === JSON.stringify(['2026-10-15:posted']),
    'the posted payment settles the bill: PAID once, nothing left to reserve', JSON.stringify([s.bill.status, s.remaining, s.paid]));
  ok(visiblePair(s), 'the pending row stays listed as the possible replacement');
  ok(cautious(s), 'claim stays classified-incomplete; Other is an estimate', JSON.stringify([s.claim, s.other.trust]));
}

console.log('3. The same class on one day: pending and posted Oct 17, no provider link');
{
  const s = serve([debit('2026-10-17', { pending: true }), debit('2026-10-17')]);
  ok(s.balance === 900, 'balance 900, never 800 (the posted copy keeps its hold)', String(s.balance));
  ok(held(s.rows.find(r => !r.pending)) && pendingCopy(s), 'the posted row is held To confirm; the pending row stays listed');
  ok(s.claim === 'classified-incomplete', 'claim stays classified-incomplete', s.claim);
}

console.log('4. A genuine second charge still deducts, never vanishes');
{
  const twoPosted = serve([debit('2026-10-15'), debit('2026-10-17')]);
  ok(twoPosted.balance === 800 && twoPosted.bill.status === 'PAID', 'posted Oct 15 and posted Oct 17: 800, as on main', String(twoPosted.balance));
  const pendingAfter = serve([debit('2026-10-15'), debit('2026-10-17', { pending: true })]);
  ok(pendingAfter.balance === 800 && !pendingAfter.rows.some(r => r.duplicate),
    'posted Oct 15, then a pending Oct 17 dated after it: not a copy, 800', JSON.stringify([pendingAfter.balance]));
  const otherAmount = serve([debit('2026-10-13', { pending: true, amount: 90 }), debit('2026-10-15')]);
  ok(otherAmount.balance === 810 && !otherAmount.rows.some(r => r.duplicate),
    'a pending of a different amount is not paired: it deducts (900 - 90 = 810)', String(otherAmount.balance));
  // Codex P2 on #1319: a posted row dated after the observation date (Oct 17)
  // is not yet evidence, so the pending is never paired to it as its copy.
  // Since #1400 (lead ruling 2026-11-19; Atlas blocker 6998836646) that same
  // future row no longer vetoes the lone-pending hold either: the pending is
  // the only current evidence, so it is held To confirm on the bill once (900).
  const future = serve([debit('2026-10-16', { pending: true }), debit('2026-10-18')]);
  const futurePending = future.rows.find(r => r.pending);
  ok(future.balance === 900 && !future.rows.some(r => r.duplicate) && held(futurePending),
    'a posted row dated after the observation date is not paired; the current pending is held once (900)', String(future.balance));
  const twoPending = serve([debit('2026-10-13', { pending: true }), debit('2026-10-14', { pending: true }), debit('2026-10-15')]);
  ok(!twoPending.rows.some(r => r.duplicate) && twoPending.balance === 700,
    'two pendings near one posted payment: no pairing, both deduct (900 - 200 = 700)', String(twoPending.balance));
}

console.log('5. Unchanged');
{
  const none = serve([]);
  ok(none.balance === 900 && none.bill.status === 'still due', 'no payment: still due, 900');
  const late = serve([debit('2026-10-17')]);
  ok(late.balance === 900 && held(late.rows[0]), 'posted Oct 17 alone: held To confirm, 900');
  // Pending on the due date, then posted two days later, is #1315's case and
  // is proved by test/test-near-due-pending-replacement.js on that PR.
  // The lone pending off the due date is now held once on the bill (lead
  // ruling 2026-11-19); test/test-lone-pending-bill-payment-once.js proves it.
  const lone = serve([debit('2026-10-16', { pending: true })]);
  ok(lone.balance === 900 && !lone.rows[0].duplicate && held(lone.rows[0]),
    'a lone pending off the due date is held To confirm on the bill, counted once (900)', String(lone.balance));
}

console.log('6. No trust tag moves toward more certainty');
{
  const base = serve([]), a = serve([debit('2026-10-16', { pending: true }), debit('2026-10-17')]);
  ok(a.bill.trust === base.bill.trust && a.bill.dateConfidence === base.bill.dateConfidence,
    'the bill keeps its own tags', JSON.stringify([a.bill.trust, base.bill.trust]));
}

console.log('7. A bill payment\'s pending copy still leaves the opening-to-payday gap unproven');
{
  // Invented: opening Oct 5, payday Oct 9, a pending household-cash debit on
  // Oct 7 inside the gap. A same-day possible replacement proves nothing is
  // missing (incumbent); a bill's pending copy does not, as before pairing.
  const gapPacket = flags => ({ paydayGapComplete: true, coverageStart: '2026-10-01', coverageThrough: '2026-10-17',
    transactionCoverage: 'complete', transactions: [{ id: 'tx-1', date: '2026-10-07', amount: 100, pending: true,
      accountRole: 'household-cash', atlasAccountId: 'chequing-a', ...flags }] });
  const gap = flags => Live.paydayGapCashFromReport({ currentPeriodActuals: gapPacket(flags),
    transactionWindow: { startDate: '2026-10-01', endDate: '2026-10-17', complete: true, hasMore: false, truncated: false } },
  { opening: { asOf: '2026-10-05' } }, '2026-10-09').complete;
  ok(gap({ pendingPostedDuplicate: true }) === true, 'control: a same-day possible replacement leaves the gap proven, as on main');
  ok(gap({}) === false, 'control: an unpaired pending leaves it unproven');
  ok(gap({ pendingPostedDuplicate: true, pendingBillCopy: true }) === false, 'a bill payment\'s pending copy leaves it unproven');
  const O = require('../scripts/provider-observe.js');
  const w = H.baseWorld('2026-10-17');
  H.productionOpening(w);
  const plan = H.planOf(w);
  plan.opening = { ...plan.opening, asOf: '2026-10-05' };
  const observed = flags => O.paydayGapCompleteFromEvidence({ plan, asOf: '2026-10-17', pendingCoverage: 'complete',
    window: { startDate: '2026-10-01', endDate: '2026-10-17', complete: true, hasMore: false, truncated: false },
    accountMap: H.accountMapOf(w), transactions: [{ id: 'tx-1', date: '2026-10-07', amount: 100, pending: true,
      accountRole: 'household-cash', ...flags }] });
  ok(observed({ pendingPostedDuplicate: true }) === true && observed({}) === false
    && observed({ pendingPostedDuplicate: true, pendingBillCopy: true }) === false,
  'the observer\'s own gap check: a possible replacement proves the gap, a bill\'s pending copy does not');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll pending-then-posted bill checks passed.');
