'use strict';
/* D2 (lead dispatch 2026-11-18, census 12; gate ruled on #1320): a fixed bill paid in part keeps its remainder reserved.
 * "Fixed" is `amountFixed: true`, derived from the bill's Lunch Money payment history (owner decision #821, 2026-11-18;
 * provider-observe derivedAmountFixedBills), never a hand mark: here, three earlier posted payments of exactly $90 on Jul,
 * Aug and Sep 12. `confirmed` alone is confidence in the planned figure, not a fixed price, so a confirmed bill without
 * that history is unchanged (section 0).
 *
 *   1. A fixed bill (marked, confirmed planned amount) with one linked posted payment below the planned amount stays still due:
 *      paid shows the amount paid, remaining shows the rest, and the rest is held once (bills still to pay, the cash walk,
 *      the payday plan, after-bills).
 *   2. The full planned cost is assigned once (Balance After Deductions, the period bill load, the bills total).
 *   3. A variable bill (estimated planned amount): its expected price alone proves no remaining debt, so it keeps today's
 *      behaviour (PAID, nothing held).
 *
 * Invented world: test/acceptance/harness.js base world as of 2026-10-14, current pay period Oct 9-22, one invented hydro
 * bill of $90 due Oct 12. The bank balances in that world do not move with the payment, so every comparison is between
 * worlds that differ only in the payment: paid in full ($90), paid in part ($40), and unpaid. By hand:
 *   - paid in part holds 90 - 40 = 50 more than paid in full, and 40 less than unpaid;
 *   - paid in part assigns the same full $90 as paid in full.
 * Expected values are written by hand from those rules, never read back from the code under test.
 *
 * `node test/test-bill-partial-remainder.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');
const { stackBillAmounts } = require('./lib/stack-bill-amounts');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, date = '2026-10-12') => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' });
// The history that derives the flag: three posted $90 payments for completed occurrences (on the bill's own due day),
// the newest within two months of the plan date. As in production, the 200-day read also carries the current period's
// payment itself (Codex P1 on #1355): `current` adds it, so a partial payment is in the history and must not turn the
// flag off.
const fixedHistory = (current = [], dates = ['2026-07-12', '2026-08-12', '2026-09-12']) =>
  ({ transactions: dates.map(d => pay(90, d)).concat(current) });

function world(paid, { confidence = 'confirmed', pool = false, day = 12, fixed = true } = {}) {
  const w = H.baseWorld();
  w.bills = [{ ...HYDRO, confidence, day }];
  if (pool) w.savingsPool = true;
  w.transactions = paid ? [pay(paid, '2026-10-' + String(day).padStart(2, '0'))] : [];
  if (fixed) w.amountHistory = fixedHistory(w.transactions);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  return { w, rec, period, row: period.bills.find(b => b.id === 'hydro'), day0: rec.sim.daily[0].balance,
    section: rec.defaultView.billSections[0], dv: rec.defaultView };
}

// the real Bills row printer, lifted by name from public/ (as test-bills-partly-paid.js does)
const src = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const lift = (text, name) => {
  const m = new RegExp(`^(?:const ${name} = |function ${name}\\()`, 'm').exec(text);
  if (!m) throw new Error(`printer ${name} not found`);
  const end = text.indexOf('\n\n', m.index);
  const next = text.slice(m.index).search(/\n(?:function |const |\/\/)/);
  return text.slice(m.index, m.index + Math.min(next > 0 ? next : Infinity, end > 0 ? end - m.index : Infinity));
};
const app = src('app.js'), planJs = src('plan.js');
const ctx = { console, Intl, Number, Math, String, Object, Array, JSON, Date, RegExp };
vm.createContext(ctx);
vm.runInContext([lift(app, 'escapeHtml'), lift(app, 'money2'), lift(app, 'fmtDateLong'), lift(planJs, 'isValidIsoCalendarDate'),
  lift(planJs, 'budgetBrowseKnown'), lift(planJs, 'budgetBrowseEscape'), lift(planJs, 'budgetBrowseMoney'),
  lift(planJs, 'budgetBillPresentation'), lift(planJs, 'budgetBillDisplayLabel'), lift(planJs, 'budgetBillBrowseRowHtml'),
  'this.rowHtml = budgetBillBrowseRowHtml;'].join('\n'), ctx);
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

const full = world(90), part = world(40), none = world(0);

test('Stack reserves only the unpaid part of a fixed bill and counts the full bill once', async () => {
  for (const [fixture, paid, remainder, checked] of [[part, 40, 50, false], [full, 90, 0, true], [none, null, 90, false]]) {
    const x = await stackBillAmounts(fixture.w, '2026-10-09', 'hydro', '2026-10-12');
    assert.deepEqual([x.bill.actual, x.bill.planned, x.bill.remaining, x.remaining, x.totals.other],
      [paid, 90, remainder, remainder, 90], 'the actual and held remainder assign the bill once');
    assert.equal(x.cardAmount, '$90', 'the card shows the full assigned bill');
    assert.deepEqual([x.cardPaid, x.sheetPaid], [checked, checked], 'only the fully paid occurrence gets the Paid check');
  }
});

console.log('0. A confirmed bill without the amountFixed mark is unchanged (PAID, nothing held)');
{
  // Confirmed is confidence in the planned 90, not a fixed price: 40 posted may simply be a cheaper bill. Every figure
  // equals the paid-in-full world except the row's own paid amount, as on main.
  const uFull = world(90, { fixed: false }), uPart = world(40, { fixed: false });
  const r = uPart.row;
  ok(r && r.status === 'PAID' && r.remaining === 0 && r.actual === 40 && r.paymentState === 'partly-paid' && !('partlyPaidRemainder' in r),
    'unmarked confirmed 90 paid 40: PAID, 0 remaining, the Partly paid label only', r && `${r.status} ${r.remaining} ${r.paymentState}`);
  ok(uPart.period.remainingBills === 0 && near(uPart.day0, uFull.day0) && uPart.dv.afterBills === uFull.dv.afterBills,
    'nothing still to pay; the cash walk and after bills equal paid in full', `${uPart.period.remainingBills} ${uPart.day0}/${uFull.day0}`);
  const flagged = F.expandEvents(H.observe(Object.assign(H.baseWorld(), { bills: [{ ...HYDRO }], amountHistory: fixedHistory() })).plan, '2026-10-01', '2026-10-31', {});
  const unflagged = F.expandEvents(H.observe(Object.assign(H.baseWorld(), { bills: [{ ...HYDRO }] })).plan, '2026-10-01', '2026-10-31', {});
  ok(flagged.some(e => e.id === 'hydro' && e.amountFixed === true) && unflagged.every(e => e.id !== 'hydro' || !('amountFixed' in e)),
    'the flag rides on the bill\'s events only when its payment history derives it');
}

console.log('1. A fixed bill paid $40 of $90 stays still due for $50');
{
  const r = part.row;
  ok(r && r.status === 'still due' && r.status !== 'PAID', 'the row is still due, not PAID', r && r.status);
  ok(r && r.actual === 40 && r.remaining === 50 && r.planned === 90, 'paid 40, remaining 50, planned 90', r && `${r.actual} ${r.remaining} ${r.planned}`);
  const line = text(ctx.rowHtml(r));
  ok(/Partly paid/.test(line) && /\$50\.00 still to pay/.test(line),
    'the Bills row still reads "Partly paid" with $50.00 still to pay (wording unchanged)', line);
  ok(part.period.paidBills === 40 && part.period.remainingBills === 50,
    'this period: paid bills 40, bills still to pay 50', `${part.period.paidBills} ${part.period.remainingBills}`);
  ok(full.period.remainingBills === 0 && none.period.remainingBills === 90, 'controls: paid in full 0 still to pay, unpaid 90',
    `${full.period.remainingBills} ${none.period.remainingBills}`);
}

console.log('2. The $50 is held once in cash');
{
  ok(near(part.day0, full.day0 - 50), 'the cash walk holds 50 more than paid in full', `${part.day0} vs ${full.day0}`);
  ok(near(part.day0, none.day0 + 40), 'and 40 less than unpaid (the 40 already left)', `${part.day0} vs ${none.day0}`);
  ok(near(part.dv.afterBills, full.dv.afterBills - 50), 'after bills is 50 lower than paid in full', `${part.dv.afterBills} vs ${full.dv.afterBills}`);
  const poolFull = world(90, { pool: true }).rec.paydayAllocation, poolPart = world(40, { pool: true }).rec.paydayAllocation;
  ok(poolFull && poolPart && poolPart.obligations.wanted === 50 && poolFull.obligations.wanted === 0,
    'the payday plan reserves the 50 (and nothing when paid in full)', `${poolPart && poolPart.obligations.wanted} ${poolFull && poolFull.obligations.wanted}`);
  // The current-period action list reads the same owner (second Bills row builder, currentPeriodBills).
  const action = world(40).rec.currentPeriodAction, actionFull = world(90).rec.currentPeriodAction;
  const aRow = action && (action.bills || []).find(b => b.id === 'hydro');
  const due = action && (action.thisPaydayDue || []).find(b => b.id === 'hydro');
  ok(aRow && aRow.remaining === 50 && aRow.actual === 40 && due && due.remaining === 50
    && !(actionFull.thisPaydayDue || []).some(b => b.id === 'hydro'),
    'the current-period action list: 50 remaining, listed due this payday (not when paid in full)', `${aRow && aRow.remaining} ${due && due.remaining}`);
}

console.log('2b. Due and paid in part on the as-of day (Oct 14): the same $50 is held');
{
  const tFull = world(90, { day: 14 }), tPart = world(40, { day: 14 }), tNone = world(0, { day: 14 });
  ok(tPart.row && tPart.row.status === 'still due' && tPart.row.remaining === 50, 'still due, 50 remaining',
    tPart.row && `${tPart.row.status} ${tPart.row.remaining}`);
  ok(near(tPart.day0, tFull.day0 - 50) && near(tPart.day0, tNone.day0 + 40), 'the cash walk holds 50: 50 below paid in full, 40 above unpaid',
    `${tPart.day0} ${tFull.day0} ${tNone.day0}`);
}

console.log('3. The full $90 is assigned once');
{
  ok(part.period.periodBillLoad === 90 && full.period.periodBillLoad === 90, 'period bill load 90, as paid in full',
    `${part.period.periodBillLoad} ${full.period.periodBillLoad}`);
  ok(part.period.balanceAfterDeductions === full.period.balanceAfterDeductions, 'Balance After Deductions equals paid in full',
    `${part.period.balanceAfterDeductions} ${full.period.balanceAfterDeductions}`);
  ok(part.section.total === 90 && part.section.remainingTotal === 50, 'the bills total is 90 (40 paid + 50 still to pay)',
    `${part.section.total} ${part.section.remainingTotal}`);
  ok(part.period.totalBillsThisPeriod === 90, 'the period bills total is 90', part.period.totalBillsThisPeriod);
}

console.log('3b. One pay period later: a partial payment keeps its evidence in its own period');
{
  const later = paid => {
    const w = H.baseWorld('2026-10-24');
    w.bills = [{ ...HYDRO }];
    w.transactions = paid ? [pay(paid)] : [];
    w.amountHistory = fixedHistory(w.transactions);
    const r = H.observe(w);
    if (r.error) throw r.error;
    const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
    const current = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
    const past = (rec.pastPeriodViews || []).find(p => p.start === '2026-10-09');
    return { current, past, carried: (current.bills || []).find(b => b.id === 'hydro' && b.date === '2026-10-12'),
      closed: past && (past.bills || []).find(b => b.id === 'hydro'), day0: rec.sim.daily[0].balance };
  };
  const lFull = later(90), lPart = later(40), lNone = later(0);
  for (const result of [lPart, lNone, lFull]) {
    ok(!result.carried && result.current.remainingBills === 0, 'no old bill reduces this period');
    ok(near(result.day0, lFull.day0), 'the same observed cash opens the new period');
  }
  ok(lPart.closed && lPart.closed.status === 'still due' && lPart.closed.actual === 40 && lPart.closed.remaining === 50,
    'the closed period retains both the 40 paid and the 50 shortfall');
  ok(lPart.past.paidBills === 40 && lPart.past.unconfirmedBills === 50 && lPart.past.periodBillLoad === 90,
    '40 paid + 50 unconfirmed = 90 assigned in the scheduled period');

}

console.log('3c. Only one linked posted instalment is a partial');
{
  // Two linked entries naming the occurrence (here 40 + 50) are not one instalment below plan: the incumbent reading
  // stands (PAID, nothing held), so no remainder is invented from one of them.
  const w = H.baseWorld();
  w.bills = [{ ...HYDRO }];
  w.transactions = [pay(40)];
  w.amountHistory = fixedHistory(w.transactions);
  const r = H.observe(w);
  if (r.error) throw r.error;
  const packet = JSON.parse(JSON.stringify(r.packet));
  const one = (packet.representedActuals || []).find(a => a.id === 'hydro');
  packet.representedActuals.push({ ...one, actual: 50, transactionId: 'invented-second' });
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: packet });
  const p = rec.defaultView.calendarPeriods.find(x => x.start <= w.asOf && x.end >= w.asOf);
  const row = p.bills.find(b => b.id === 'hydro');
  ok(one && row && row.status === 'PAID' && row.remaining === 0 && p.remainingBills === 0,
    'two linked entries: not a partial (PAID, nothing still to pay)', row && `${row.status} ${row.remaining} ${p.remainingBills}`);
}

console.log('3d. The Bills account closing balance holds the 50 (Codex P1 on #1320)');
{
  const closing = paid => {
    const w = H.baseWorld();
    w.bills = [{ ...HYDRO }];
    w.transactions = paid ? [pay(paid)] : [];
    w.amountHistory = fixedHistory(w.transactions);
    const r = H.observe(w);
    if (r.error) throw r.error;
    return F.billsAccountPeriodBalance(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  };
  const bFull = closing(90), bPart = closing(40);
  ok(bFull && bPart && bPart.remainingBills === 50 && bFull.remainingBills === 0 && near(bPart.amount, bFull.amount - 50),
    'remaining bills 50 (0 paid in full) and the closing balance 50 lower', bPart && `${bPart.remainingBills} ${bPart.amount} vs ${bFull && bFull.amount}`);
}

console.log('3e. A once bill paid in part stays in its scheduled period');
{
  // A once bill never has three payments, so the history never derives it fixed, and a hand mark is dropped from the
  // served plan (one authority). The Forecast mechanics #1320's P1 fixed are still pinned here by setting the flag on the
  // plan Forecast reads, which is what the derivation does for a recurring bill.
  const onceLater = (paid, { markInForecast = true } = {}) => {
    const w = H.baseWorld('2026-10-24');
    w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'once', date: '2026-10-12', confidence: 'confirmed', payee: 'Invented hydro',
      amountFixed: true }];
    w.transactions = paid ? [pay(paid)] : [];
    const r = H.observe(w);
    if (r.error) throw r.error;
    const served = r.plan.bills.find(b => b.id === 'hydro');
    if (markInForecast) served.amountFixed = true;
    const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
    const current = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
    return { current, row: (current.bills || []).find(b => b.id === 'hydro'), day0: rec.sim.daily[0].balance,
      servedMark: Object.hasOwn(served, 'amountFixed') && !markInForecast };
  };
  const oFull = onceLater(90), oPart = onceLater(40);
  const served = onceLater(40, { markInForecast: false });
  ok(served.servedMark === false, 'a hand amountFixed mark on a once bill is dropped from the served plan (derived only)');
  ok(!oPart.row && oPart.current.remainingBills === 0, 'the unpaid remainder of a past one-off stays in history');
  ok(!oFull.row && oFull.current.remainingBills === 0 && near(oPart.day0, oFull.day0),
    'both open on the observed cash without replaying a prior bill');

}

console.log('4. A variable bill (estimated amount) keeps today\'s behaviour');
{
  const eFull = world(90, { confidence: 'estimated' }), ePart = world(40, { confidence: 'estimated' });
  const r = ePart.row;
  ok(r && r.status === 'PAID' && r.remaining === 0 && r.actual === 40, 'paid 40 on an estimated 90: PAID, nothing remaining', r && `${r.status} ${r.remaining}`);
  ok(ePart.period.remainingBills === 0, 'nothing still to pay', ePart.period.remainingBills);
  ok(near(ePart.day0, eFull.day0), 'the cash walk holds nothing more than paid in full', `${ePart.day0} vs ${eFull.day0}`);
}

console.log('5. Paid in part early (due Oct 24, next pay period; paid Oct 21, as of Oct 21)');
{
  const early = (paid, confidence = 'confirmed') => {
    const w = H.baseWorld();
    w.asOf = '2026-10-21';
    w.bills = [{ ...HYDRO, day: 24, confidence, rule: { postingDateRule: 'covers-early-or-due-on-or-before-posting' } }];
    w.transactions = paid ? [pay(paid, '2026-10-21')] : [];
    // Completed: Jun, Jul, Aug 24 (Sep 24 is the latest due on or before Oct 21, so it is the current occurrence).
    w.amountHistory = fixedHistory(w.transactions, ['2026-06-24', '2026-07-24', '2026-08-24']);
    const r = H.observe(w);
    if (r.error) throw r.error;
    const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
    const next = rec.defaultView.calendarPeriods.find(p => p.role === 'future');
    const due = rec.sim.daily.find(d => d.date === '2026-10-24');
    return { next, row: (next.bills || []).find(b => b.id === 'hydro' && b.date === '2026-10-24'),
      onDue: due && due.balance, weekly: rec.weekly };
  };
  const eFull = early(90), ePart = early(40);
  ok(ePart.row && ePart.row.status === 'still due' && ePart.row.actual === 40 && ePart.row.remaining === 50,
    'next period: still due, 40 paid, 50 remaining', ePart.row && `${ePart.row.status} ${ePart.row.actual} ${ePart.row.remaining}`);
  // Unpaid picks a different weekly cap in this world, so the like-for-like control is paid in full (same weekly).
  ok(ePart.weekly === eFull.weekly && near(ePart.onDue, eFull.onDue - 50),
    'on the due date the cash walk holds 50 more than paid in full (same weekly cap)', `${ePart.onDue} vs ${eFull.onDue}; weekly ${ePart.weekly}/${eFull.weekly}`);
  ok(ePart.next.plannedPeriodCloseTerms && ePart.next.plannedPeriodCloseTerms.periodBillLoad === 50,
    'that period\'s cash close deducts only the 50 (the 40 left before its opening)',
    ePart.next.plannedPeriodCloseTerms && ePart.next.plannedPeriodCloseTerms.periodBillLoad);
  const vPart = early(40, 'estimated');
  ok(vPart.row && vPart.row.status === 'planned' && vPart.row.remaining === 90 && !('partlyPaidRemainder' in vPart.row),
    'an estimated bill paid in part early keeps today\'s behaviour: planned, 90 held', vPart.row && `${vPart.row.status} ${vPart.row.remaining}`);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll partial-bill remainder checks passed.');
