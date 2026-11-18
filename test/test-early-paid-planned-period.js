'use strict';
/* An occurrence paid early counts in the pay period it is planned in.
 *
 * Owner decision (Dale, #821 6961042821): "count it towards the pay period
 * it's planned in". A bill due in the NEXT pay period but paid in this one
 * reads Paid in its planned period, adds nothing to that period's remaining
 * bills, is never spend in the posting period, and its cash leaves once,
 * on the posting date. The cash walk already settles the occurrence
 * (representedKeySet), so the next period's cash close must not deduct it
 * again. Only a payment that covers the occurrence reads Paid. An early
 * partial of a fixed (confirmed) bill (D2, lead dispatch 2026-11-18) reads
 * still due in its planned period: the paid part shows as paid, the
 * remainder stays held, and the cash close deducts only the remainder,
 * because the paid part already left before that opening. A represented
 * occurrence with no observed amount stays planned too: representation proves
 * the occurrence, not the amount (lead ruling on #1301).
 *
 * Invented world only (test/acceptance/harness.js): biweekly salary 1,400
 * anchored 2026-10-09, so This Pay Period is Oct 9-22 and Next Pay Period
 * is Oct 23-Nov 5. One invented hydro bill, 90.00 monthly on the 24th, so
 * Oct 24 is on Next Pay Period. As-of Oct 21. Every expected value is hand
 * arithmetic on those inputs, not Forecast output.
 *
 * `node test/test-early-paid-planned-period.js`
 */
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-10-21';
const DUE = '2026-10-24';
const HYDRO = {
  id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 24,
  confidence: 'confirmed', payee: 'Invented hydro',
  rule: { postingDateRule: 'covers-early-or-due-on-or-before-posting' },
};
const pay = amount => H.lm({ date: AS_OF, amount, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' });

function run(amount, representedOnly = false) {
  const w = H.baseWorld();
  w.asOf = AS_OF;
  w.bills = [HYDRO];
  w.transactions = amount == null ? [] : [pay(amount)];
  // A plain represented occurrence: the opening names it (id + date) with no
  // observed payment amount at all.
  if (representedOnly) w.planPatch = plan => { plan.opening.representedEvents.push({ id: 'hydro', date: DUE }); };
  const r = H.observe(w);
  if (r.error) throw r.error;
  return F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
}
const period = (advice, role) => advice.defaultView.calendarPeriods.find(p => p.role === role);
const hydroRow = p => (p && p.bills || []).find(b => b && b.id === 'hydro' && b.date === DUE);
const closeBills = p => p && p.plannedPeriodCloseTerms ? p.plannedPeriodCloseTerms.periodBillLoad : undefined;

const control = run(null);
const early = run(90);
const partial = run(40);
const plain = run(null, true);

console.log('\n=== windows ===');
{
  const a = period(control, 'active'), n = period(control, 'future');
  ok(a && a.start === '2026-10-09' && a.end === '2026-10-22', 'This Pay Period is Oct 9-22', a && a.start + '..' + a.end);
  ok(n && n.start === '2026-10-23' && n.end === '2026-11-05', 'Next Pay Period is Oct 23-Nov 5', n && n.start + '..' + n.end);
}

console.log('\n=== control: no early payment, unchanged ===');
{
  const n = period(control, 'future');
  const row = hydroRow(n);
  ok(row && row.status !== 'PAID' && row.settlement === 'upcoming' && row.remaining === 90,
    'the Oct 24 hydro is still due next period: 90.00 remaining', row && `${row.status} ${row.settlement} ${row.remaining}`);
  ok(n.paidBills === 0 && n.remainingBills === 90 && n.totalBillsThisPeriod === 90,
    'next period: paid 0 + remaining 90 = total 90', [n.paidBills, n.remainingBills, n.totalBillsThisPeriod].join(' / '));
  ok(closeBills(n) === 90, 'the next cash close deducts the 90.00 once', String(closeBills(n)));
}

console.log('\n=== early: due next period, paid in full in this one ===');
{
  const n = period(early, 'future'), nc = period(control, 'future');
  const row = hydroRow(n);
  ok(row && row.status === 'PAID' && row.glanceKind === 'paid' && row.settlement === 'represented',
    'the Oct 24 hydro reads Paid in its planned (next) period', row && `${row.status} ${row.settlement}`);
  ok(row && row.actual === 90 && row.remaining === 0, 'with the 90.00 actual and nothing remaining', row && `${row.actual} ${row.remaining}`);
  ok(n.paidBills === 90 && n.remainingBills === 0 && n.totalBillsThisPeriod === 90,
    'next period: paid 90 + remaining 0 = total 90 (no reserve there)', [n.paidBills, n.remainingBills, n.totalBillsThisPeriod].join(' / '));
  ok(n.periodBillLoad === nc.periodBillLoad && n.periodBillLoad === 90,
    'it still counts in its planned period: assigned bill load 90, as in the control', String(n.periodBillLoad));
  ok(n.balanceAfterDeductions === nc.balanceAfterDeductions,
    'Balance After Deductions is the same as the control (income − assigned bills − budget)', `${n.balanceAfterDeductions} vs ${nc.balanceAfterDeductions}`);
  ok(closeBills(n) === 0, 'the next cash close deducts nothing for it: the cash already left', String(closeBills(n)));
  ok(n.opening === nc.opening, 'the next opening is the same walked cash as the control', `${n.opening} vs ${nc.opening}`);
  ok(n.paydaySweep === Math.round((nc.paydaySweep + 90) * 100) / 100,
    'so the next close is 90.00 above the control, not 90.00 taken twice', `${n.paydaySweep} vs ${nc.paydaySweep}`);

  const a = period(early, 'active'), ac = period(control, 'active');
  ok(!hydroRow(a), 'This Pay Period lists no Oct 24 occurrence');
  ok(a.remainingBills === ac.remainingBills && a.paidBills === ac.paidBills && a.periodBillLoad === ac.periodBillLoad,
    'This Pay Period bills are the same as the control', [a.paidBills, a.remainingBills, a.periodBillLoad].join(' / '));
  ok(a.budgetHold === ac.budgetHold && a.balanceAfterDeductions === ac.balanceAfterDeductions
      && JSON.stringify(a.budgetProgress) === JSON.stringify(ac.budgetProgress),
    'and it is never spend here: budget hold, BAD and budget progress match the control',
    `${a.budgetHold}/${a.balanceAfterDeductions} vs ${ac.budgetHold}/${ac.balanceAfterDeductions}`);
}

console.log('\n=== partial (D2): 40.00 of 90.00 paid early, fixed bill ===');
{
  // By hand: paid 40 shows as paid in the planned period, 90 - 40 = 50 stays held there, the full 90 is assigned once,
  // and the close deducts only the 50 (the 40 already left before that opening), so it is 40 above the control.
  const n = period(partial, 'future'), nc = period(control, 'future');
  const row = hydroRow(n);
  ok(row && row.status === 'still due' && row.settlement === 'represented' && row.actual === 40 && row.remaining === 50,
    'reads still due next period: 40.00 paid, 50.00 still held', row && `${row.status} ${row.settlement} ${row.actual} ${row.remaining}`);
  ok(row && row.paymentState === 'partly-paid' && row.shortfall === 50, 'and reads Partly paid, 50.00 short', row && JSON.stringify({ s: row.paymentState, sf: row.shortfall }));
  ok(n.paidBills === 40 && n.remainingBills === 50 && n.totalBillsThisPeriod === 90 && closeBills(n) === 50,
    'next period: paid 40 + remaining 50 = total 90; the cash close deducts the 50', [n.paidBills, n.remainingBills, n.totalBillsThisPeriod, closeBills(n)].join(' / '));
  ok(n.periodBillLoad === 90 && n.balanceAfterDeductions === nc.balanceAfterDeductions && n.opening === nc.opening,
    'assigned load 90 and BAD as the control; the same walked opening', `${n.periodBillLoad} ${n.balanceAfterDeductions}/${nc.balanceAfterDeductions} ${n.opening}/${nc.opening}`);
  ok(n.paydaySweep === Math.round((nc.paydaySweep + 40) * 100) / 100,
    'so the next close is 40.00 above the control: the paid part is not taken twice, the 50 is taken once', `${n.paydaySweep} vs ${nc.paydaySweep}`);
}

console.log('\n=== plain represented, no observed amount: stays planned ===');
{
  const n = period(plain, 'future');
  const row = hydroRow(n);
  // Representation proves the occurrence, not the amount (lead ruling #1301):
  // with no observed payment, nothing shows that 90.00 was covered.
  ok(row && row.status === 'planned' && row.settlement === 'upcoming' && row.remaining === 90,
    'a represented occurrence with no observed amount reads planned with the full 90.00 held', row && `${row.status} ${row.settlement} ${row.remaining}`);
  ok(n.paidBills === 0 && n.remainingBills === 90 && n.totalBillsThisPeriod === 90,
    'next period: paid 0 + remaining 90 = total 90 (no Paid invented)', [n.paidBills, n.remainingBills, n.totalBillsThisPeriod].join(' / '));
}

console.log(failures ? `\n${failures} FAILED` : '\nAll early-paid planned-period checks passed');
process.exit(failures ? 1 : 0);
