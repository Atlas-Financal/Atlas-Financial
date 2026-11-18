'use strict';
/* D2 (lead dispatch 2026-11-18, census 12): a fixed bill paid in part keeps its remainder reserved.
 *
 *   1. A fixed bill (confirmed planned amount) with one linked posted payment below the planned amount stays still due:
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
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;

const HYDRO = { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' };
const pay = (amount, date = '2026-10-12') => H.lm({ date, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' });

function world(paid, { confidence = 'confirmed', pool = false, day = 12 } = {}) {
  const w = H.baseWorld();
  w.bills = [{ ...HYDRO, confidence, day }];
  if (pool) w.savingsPool = true;
  w.transactions = paid ? [pay(paid, '2026-10-' + String(day).padStart(2, '0'))] : [];
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const period = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  return { rec, period, row: period.bills.find(b => b.id === 'hydro'), day0: rec.sim.daily[0].balance,
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

console.log('1. A fixed bill paid $40 of $90 stays still due for $50');
{
  const r = part.row;
  ok(r && r.status === 'still due' && r.status !== 'PAID', 'the row is still due, not PAID', r && r.status);
  ok(r && r.actual === 40 && r.remaining === 50 && r.planned === 90, 'paid 40, remaining 50, planned 90', r && `${r.actual} ${r.remaining} ${r.planned}`);
  const line = text(ctx.rowHtml(r));
  ok(/Partly paid/.test(line) && /\$50\.00 still to pay/.test(line) && !/\bPaid ·/.test(line),
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

console.log('3b. One pay period later (as of Oct 24): the $50 carries, once');
{
  const later = paid => {
    const w = H.baseWorld('2026-10-24');
    w.bills = [{ ...HYDRO }];
    w.transactions = paid ? [pay(paid)] : [];
    const r = H.observe(w);
    if (r.error) throw r.error;
    const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
    const current = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
    const past = (rec.pastPeriodViews || []).find(p => p.start === '2026-10-09');
    return { current, past, carried: (current.bills || []).find(b => b.id === 'hydro' && b.date === '2026-10-12'),
      closed: past && (past.bills || []).find(b => b.id === 'hydro'), day0: rec.sim.daily[0].balance };
  };
  const lFull = later(90), lPart = later(40), lNone = later(0);
  ok(lPart.carried && lPart.carried.status === 'still due' && lPart.carried.remaining === 50,
    'the Oct 12 bill is carried into this period still due for 50 (as unpaid carries 90)',
    lPart.carried && `${lPart.carried.status} ${lPart.carried.remaining}`);
  ok(lNone.carried && lNone.carried.remaining === 90 && !lFull.carried, 'controls: unpaid carries 90, paid in full carries nothing',
    `${lNone.carried && lNone.carried.remaining} ${!!lFull.carried}`);
  ok(lPart.current.remainingBills === 50, 'this period holds 50 still to pay for it', lPart.current.remainingBills);
  ok(near(lPart.day0, lFull.day0 - 50) && near(lPart.day0, lNone.day0 + 40), 'the cash walk holds 50',
    `${lPart.day0} ${lFull.day0} ${lNone.day0}`);
  ok(lPart.closed && lPart.closed.actual === 40 && lPart.past.totalBillsThisPeriod === 40,
    'the closed period keeps its record: 40 paid there (40 + 50 carried = 90, counted once)',
    lPart.closed && `${lPart.closed.actual} ${lPart.past.totalBillsThisPeriod}`);
}

console.log('4. A variable bill (estimated amount) keeps today\'s behaviour');
{
  const eFull = world(90, { confidence: 'estimated' }), ePart = world(40, { confidence: 'estimated' });
  const r = ePart.row;
  ok(r && r.status === 'PAID' && r.remaining === 0 && r.actual === 40, 'paid 40 on an estimated 90: PAID, nothing remaining', r && `${r.status} ${r.remaining}`);
  ok(ePart.period.remainingBills === 0, 'nothing still to pay', ePart.period.remainingBills);
  ok(near(ePart.day0, eFull.day0), 'the cash walk holds nothing more than paid in full', `${ePart.day0} vs ${eFull.day0}`);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll partial-bill remainder checks passed.');
