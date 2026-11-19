'use strict';
/* Lead ruling 2026-11-19 (BACKLOG "A lone pending bill payment off its due
 * date stays deducted beside the reserve", from #1319): a lone pending
 * identity debit within a still-due bill's near-due reach, with nothing
 * posted, is held To confirm on that bill while pending and counted once. The
 * bill is not settled: it stays reserved. Once it posts, #1319's path takes
 * over unchanged. Two pendings for one bill, or one pending that fits two
 * bills, keep the incumbent cautious path.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend and the classifier.
 *
 * Invented world (#1319's): Dale 1400 on Fri Oct 9 (pay period Oct 9-22, next
 * payday Oct 23); an invented $100 hydro bill due monthly on the 15th, paid
 * from Bills, identified by its payee; plan date Sat Oct 17. With no payment
 * the period's balance after deductions is 900 (the 100 reserved once).
 * Hand-derived: one payment counted once leaves 900; counted twice, 800.
 *
 * `node test/test-lone-pending-bill-payment-once.js`
 */
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

let nextId = 993000;
const debit = (date, { pending = false, amount = 100, payee = 'Invented Hydro', category = 'Utilities', id, notes } = {}) =>
  H.lm({ id: id || ++nextId, date, amount, account: 'chequing-a', payee, category, pending, notes });
const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 100, frequency: 'monthly', day: 15, firstDue: '2026-09-15',
  confidence: 'confirmed', payingAccount: 'chequing-a', householdObligation: true };

function serve(txs, { asOf = '2026-10-17', bills = [HYDRO], rules } = {}) {
  const w = H.baseWorld(asOf);
  w.windowStart = '2026-10-01';
  w.bills = bills;
  w.identityRules = w.identityRules.concat(rules
    || bills.map(b => ({ eventId: b.id, payeePattern: 'Invented Hydro', atlasAccountId: 'chequing-a', direction: 'debit' })));
  w.transactions = [H.lm({ id: ++nextId, date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a',
    payee: 'Invented employer' }), ...txs];
  H.productionOpening(w);
  const r = Live.fromObservation({ data: H.canonicalOf(w, H.planOf(w)), payload: H.rawPayload(w),
    accountMap: H.accountMapOf(w), identity: H.identityOf(w) });
  if (r.error) throw r.error;
  const packet = r.data.liveOverlay.currentPeriodActuals;
  const adv = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: packet, debts: r.data.debts });
  const periods = adv.defaultView.calendarPeriods;
  const current = periods.find(p => p.start <= asOf && p.end >= asOf);
  const next = periods.find(p => p.start > current.end);
  const rows = (packet.transactions || []).filter(t => Math.abs(Number(t.amount)) !== 1400).map(t => ({
    id: t.id, date: t.date, pending: t.pending === true, duplicate: t.pendingPostedDuplicate === true,
    copy: t.pendingBillCopy === true, nearDue: t.nearDueBillCandidate || null,
    cls: F.classifyCurrentPeriodTransaction(t, r.data.plan, { currentPeriodActuals: packet }),
  }));
  const billIn = (period, id) => ((period && period.bills) || []).filter(b => b.id === id);
  return { current, next, rows, billIn, balance: current.balanceAfterDeductions, remaining: current.remainingBills,
    claim: adv.currentPeriodAction.categoryRemainingClaim,
    paid: (packet.representedActuals || []).filter(x => x.id === 'hydro').map(x => x.date + (x.pending ? ':pending' : ':posted')) };
}
const held = row => !!(row && row.cls.reason === 'near-due-bill-unconfirmed' && row.cls.billCandidate
  && row.cls.billCandidate.id === 'hydro' && row.cls.householdSpending !== true);
const spent = row => !!(row && row.cls.householdSpending === true);

const base = serve([]);
console.log('0. Control: no payment');
ok(base.balance === 900 && base.remaining === 100, 'no payment: the 100 reserved once, balance 900', JSON.stringify([base.balance, base.remaining]));

console.log('1. Once, not twice: a lone pending off the due date');
for (const date of ['2026-10-16', '2026-10-13', '2026-10-17']) {
  const s = serve([debit(date, { pending: true })]);
  const [row] = s.rows;
  ok(s.balance === 900, `pending ${date}: balance 900, never 800`, String(s.balance));
  ok(held(row) && row.nearDue && row.nearDue.pendingDebit === true && row.nearDue.date === '2026-10-15',
    `pending ${date}: held To confirm on the Oct 15 occurrence, marked pendingDebit`, JSON.stringify([row.cls.reason, row.nearDue]));
  const [bill] = s.billIn(s.current, 'hydro');
  ok(bill && bill.status === 'still due' && s.remaining === 100 && s.paid.length === 0,
    `pending ${date}: the bill is not settled; it stays reserved once`, JSON.stringify([bill && bill.status, s.remaining, s.paid]));
  ok(s.claim === 'classified-incomplete', `pending ${date}: the category claim stays classified-incomplete while pending`, s.claim);
  ok(bill && bill.trust === base.billIn(base.current, 'hydro')[0].trust, `pending ${date}: the bill keeps its own trust tag`);
}

console.log('2. Posting later does not double-count');
{
  const pendingId = ++nextId;
  const before = serve([debit('2026-10-16', { pending: true, id: pendingId })]);
  // Lunch Money replaces the pending row with a posted one (new id) a day later.
  const after = serve([debit('2026-10-17')], { asOf: '2026-10-18' });
  ok(before.balance === 900 && after.balance === 900, 'pending Oct 16 (900), then posted Oct 17 in its place (900)',
    JSON.stringify([before.balance, after.balance]));
  ok(held(after.rows[0]) && !after.rows[0].nearDue.pendingDebit, 'once posted, #1319\'s posted hold takes over, unmarked');
  // Both rows seen at once, same amount, no provider link: #1319's pairing, unchanged.
  const both = serve([debit('2026-10-16', { pending: true }), debit('2026-10-17')]);
  const p = both.rows.find(r => r.pending), q = both.rows.find(r => !r.pending);
  ok(both.balance === 900 && p.duplicate && p.copy && !p.nearDue && held(q),
    'pending and posted together: the pending is the posted payment\'s copy (#1319), never held as well, 900',
    JSON.stringify([both.balance, p.duplicate, p.copy, p.nearDue]));
  // Posted on the due date beside the pending: PAID once.
  const paid = serve([debit('2026-10-13', { pending: true }), debit('2026-10-15')]);
  ok(paid.balance === 900 && paid.billIn(paid.current, 'hydro')[0].status === 'PAID'
    && !paid.rows.find(r => r.pending).nearDue, 'pending Oct 13 then posted on the due date: PAID once, 900, the pending not held',
  JSON.stringify([paid.balance]));
}

console.log('3. The claim and gap checks stay cautious: unresolved cases keep the incumbent path');
{
  const two = serve([debit('2026-10-13', { pending: true }), debit('2026-10-16', { pending: true })]);
  ok(two.balance === 700 && two.rows.every(r => !r.nearDue && spent(r)),
    'two pendings for one bill: neither held, both deduct (900 - 200 = 700), as on main', String(two.balance));
  const twoBills = [HYDRO, { ...HYDRO, id: 'hydro-b', label: 'Invented hydro B', day: 17, firstDue: '2026-09-17' }];
  const control = serve([], { bills: twoBills });
  const fits2 = serve([debit('2026-10-16', { pending: true })], { bills: twoBills });
  ok(!fits2.rows[0].nearDue && spent(fits2.rows[0]) && fits2.balance === control.balance - 100,
    'one pending that fits two bills (due Oct 15 and Oct 17): not held, deducts once, as on main',
    JSON.stringify([fits2.balance, control.balance]));
  const mixed = serve([debit('2026-10-13', { pending: true, amount: 90 }), debit('2026-10-16')]);
  const mp = mixed.rows.find(r => r.pending);
  ok(!mp.nearDue && spent(mp) && held(mixed.rows.find(r => !r.pending)) && mixed.balance === 810,
    'a pending beside a posted identity debit of another amount: the pending is not held (810), as on main', String(mixed.balance));
  // A posted identity debit near the bill that is not itself held (here it
  // fails the amount gate) still keeps a pending beside it unheld.
  const besidePosted = serve([debit('2026-10-13', { pending: true }), debit('2026-10-16', { amount: 400 })]);
  ok(besidePosted.rows.every(r => !r.nearDue) && besidePosted.balance === 400,
    'a pending beside a posted identity debit that fails the amount gate: neither held, both deduct (900 - 500 = 400)',
    String(besidePosted.balance));
  const over = serve([debit('2026-10-16', { pending: true, amount: 400 })]);
  ok(!over.rows[0].nearDue && over.balance === 500, 'a pending far above the bill fails the amount gate: deducts (900 - 400 = 500)',
    String(over.balance));
  const far = serve([debit('2026-10-11', { pending: true })]);
  ok(!far.rows[0].nearDue && spent(far.rows[0]) && far.balance === 800,
    'a pending outside the near-due reach (4 days before): deducts, as on main', String(far.balance));
  const strangerTx = { pending: true, payee: 'Invented Grocer', category: 'Groceries' };
  const stranger = serve([debit('2026-10-16', strangerTx)]);
  const strangerPosted = serve([debit('2026-10-16', { ...strangerTx, pending: false })]);
  ok(!stranger.rows[0].nearDue && stranger.rows[0].cls.reason === strangerPosted.rows[0].cls.reason
    && stranger.balance === strangerPosted.balance,
  'a pending without the bill\'s identity: not named; it reads as its posted twin (its own category)',
  JSON.stringify([stranger.rows[0].cls.reason, stranger.balance, strangerPosted.balance]));
  // The gap check reads only the pending row's own flags; a held pending is
  // not a possible replacement, so the opening-to-payday gap stays unproven.
  const gap = flags => Live.paydayGapCashFromReport({ currentPeriodActuals: { paydayGapComplete: true, coverageStart: '2026-10-01',
    coverageThrough: '2026-10-17', transactionCoverage: 'complete', transactions: [{ id: 'tx-1', date: '2026-10-07', amount: 100,
      pending: true, accountRole: 'household-cash', atlasAccountId: 'chequing-a', ...flags }] },
  transactionWindow: { startDate: '2026-10-01', endDate: '2026-10-17', complete: true, hasMore: false, truncated: false } },
  { opening: { asOf: '2026-10-05' } }, '2026-10-09').complete;
  ok(gap({ nearDueBillCandidate: { id: 'hydro', date: '2026-10-08', offsetDays: 1, pendingDebit: true } }) === false,
    'a held pending inside the opening-to-payday gap leaves the gap unproven');
}

console.log('3b. Rows dated after the observation date (Oct 17) never veto the hold (Atlas blocker on #1400)');
{
  const futurePosted = serve([debit('2026-10-16', { pending: true }), debit('2026-10-18')]);
  const fp = futurePosted.rows.find(r => r.pending);
  ok(futurePosted.balance === 900 && held(fp) && fp.nearDue.pendingDebit === true && !fp.duplicate,
    'a posted identity debit dated Oct 18: no veto, the Oct 16 pending is held once (900), not paired', String(futurePosted.balance));
  const futurePending = serve([debit('2026-10-16', { pending: true }), debit('2026-10-18', { pending: true })]);
  const cur = futurePending.rows.find(r => r.date === '2026-10-16'), fut = futurePending.rows.find(r => r.date === '2026-10-18');
  ok(futurePending.balance === 900 && held(cur) && !fut.nearDue,
    'a second pending dated Oct 18: no veto, the Oct 16 pending is held once (900); the future pending is not held',
    JSON.stringify([futurePending.balance, fut.nearDue]));
  const sameDayPosted = serve([debit('2026-10-13', { pending: true }), debit('2026-10-17', { amount: 400 })]);
  ok(sameDayPosted.rows.every(r => !r.nearDue) && sameDayPosted.balance === 400,
    'a posted identity debit dated on the observation date (Oct 17) still vetoes: neither held (400)', String(sameDayPosted.balance));
  const sameDayPending = serve([debit('2026-10-14', { pending: true }), debit('2026-10-17', { pending: true })]);
  ok(sameDayPending.rows.every(r => !r.nearDue) && sameDayPending.balance === 700,
    'a second pending dated on the observation date still vetoes: neither held (700)', String(sameDayPending.balance));
  // The posted settlement and pairing paths are unchanged: a posted payment
  // on the due date settles PAID, and a future posted row is still never a copy.
  const settledPaid = serve([debit('2026-10-15')]);
  ok(settledPaid.balance === 900 && settledPaid.billIn(settledPaid.current, 'hydro')[0].status === 'PAID'
    && JSON.stringify(settledPaid.paid) === JSON.stringify(['2026-10-15:posted']),
  'the posted settlement path is unchanged: posted on the due date, PAID once (900)');
}

console.log('4. Cross-period carry matches the posted twin');
{
  // Bill due Oct 23 (the next payday): the occurrence is in the next pay
  // period. A pending on Oct 21 is near it but across a payday, so, exactly
  // like a posted debit there (#965), it stays spending in its own period,
  // and the next period still reserves the bill once.
  const late = { ...HYDRO, day: 23, firstDue: '2026-09-23' };
  const ctl = serve([], { asOf: '2026-10-21', bills: [late] });
  const pend = serve([debit('2026-10-21', { pending: true })], { asOf: '2026-10-21', bills: [late] });
  const post = serve([debit('2026-10-21')], { asOf: '2026-10-21', bills: [late] });
  ok(pend.rows[0].nearDue && !held(pend.rows[0]) && spent(pend.rows[0]),
    'pending Oct 21 for the Oct 23 bill: named, but across a payday it is not held; it is spending in its own period');
  ok(pend.balance === post.balance && pend.balance === ctl.balance - 100,
    'the current period reads as with the posted twin (one 100 deducted)', JSON.stringify([pend.balance, post.balance, ctl.balance]));
  const nb = pend.billIn(pend.next, 'hydro'), cb = ctl.billIn(ctl.next, 'hydro');
  ok(nb.length === 1 && cb.length === 1 && nb[0].amount === cb[0].amount && nb[0].status === cb[0].status
    && pend.next.balanceAfterDeductions === post.next.balanceAfterDeductions,
  'the next period reserves the bill once, as with the posted twin', JSON.stringify([nb[0] && nb[0].status, pend.next.balanceAfterDeductions]));
  // Bill due Oct 8 (the previous pay period): a pending on Oct 10 is near it
  // but the occurrence is before this period starts: spending here, as posted.
  const early = { ...HYDRO, day: 8, firstDue: '2026-09-08' };
  const e = serve([debit('2026-10-10', { pending: true })], { bills: [early] });
  const ep = serve([debit('2026-10-10')], { bills: [early] });
  ok(!held(e.rows[0]) && e.balance === ep.balance, 'pending Oct 10 for the Oct 8 bill (previous period): not held, as the posted twin',
    JSON.stringify([e.balance, ep.balance]));
}

console.log('5. No overlap with #1388 (unproven transfer hold) or #1394 (manual-card payments)');
{
  // #1388: a Transfer / Payment category debit is held as unproven unless an
  // identity proves the other side. A lone pending bill payment that carries
  // the Transfer category is held once, on the bill, never also as unproven.
  // A Transfer-labelled row is excluded before the near-due hold is read, so
  // the pending reads exactly as its posted twin: counted once, never twice.
  const t = serve([debit('2026-10-16', { pending: true, category: 'Transfer' })]);
  const tp = serve([debit('2026-10-16', { category: 'Transfer' })]);
  ok(t.balance === 900 && tp.balance === 900 && t.rows[0].cls.reason === tp.rows[0].cls.reason
    && t.rows[0].cls.householdSpending !== true,
  'pending bill payment in the Transfer category: one exclusion, as its posted twin (900), not also an unproven hold',
  JSON.stringify([t.balance, tp.balance, t.rows[0].cls.reason, tp.rows[0].cls.reason]));
  // #1394: a manual-card payment ("card payment: MBNA") is not a bill
  // identity: it is never a near-due candidate, so its path is untouched.
  const card = serve([debit('2026-10-16', { pending: true, payee: 'Invented card bill', category: 'Uncategorised',
    notes: 'card payment: MBNA' })]);
  ok(!card.rows[0].nearDue, 'a pending manual-card payment is not named on the bill (its #1394 path is untouched)');
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll lone pending bill payment checks passed.');
