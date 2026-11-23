'use strict';
// H2-5 (desk ruling, Plan #6; narrowed by the lead to the cash close, and to
// a close that opens on the cutover walk). A future card minimum that
// Forecast's settlement decision proves the issuer satisfied for this exact
// statement occurrence, with the sent debit already inside the as-of cash,
// is not deducted again from a period close whose opening is the cutover walk
// from that cash. The row stays Planned; remaining and the planned bill load
// keep the full minimum. A carry-forward close gets no relief: its chain can
// start from a payday snapshot taken before the debit (Codex P1 on #1589).
// Invented values only.
const F = require('../public/forecast.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
// Cash 3000 observed on 2026-10-14 already reflects the 120 minimum debit
// posted 2026-10-12. snap: an optional payday snapshot on 2026-10-09.
function world({ snap = null, sent = {}, noSent = false, noIssuer = false, cashDate = '2026-10-14' } = {}) {
  const plan = {
    opening: Object.assign({ asOf: '2026-10-14',
      representedEvents: noIssuer ? [] : [{ id: 'card-min', date: '2026-10-25', effectiveAsOf: '2026-10-12' }] },
      snap != null ? { paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: snap } } : {}),
    startingCash: { asOf: '2026-10-14', breakdown: [
      { id: 'chequing-a', value: 3000, confidence: 'confirmed', evidenceDate: cashDate },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-14' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2000, confidence: 'confirmed' }],
    obligations: [Object.assign({
      id: 'card-min', label: 'Card Min', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 25, amount: 120,
      confidence: 'confirmed', payingAccount: 'chequing-a',
    }, noSent ? {} : { sentPayments: [Object.assign({ scheduledDate: '2026-10-25', postedOn: '2026-10-12', amount: 120, currency: 'cad',
      confirmed: true, pending: false, intent: 'minimum', fundingAccountId: 'chequing-a', debitId: 'a'.repeat(64),
      cashIncludedAsOf: '2026-10-12' }, sent)] })],
    bills: [], commitments: [], budget: { categories: [] },
  };
  const a = F.recommend(plan, '2026-10-14', {
    weeklyVariable: 0,
    debts: [{ id: 'triangle', label: 'Card', structure: 'Revolving', secured: false, balance: 1500, pending: 0, rate: 0.2, limit: 5000 }],
  });
  const next = a.payPeriodViews.find(v => v.start === '2026-10-23');
  return { next, row: next.bills.find(b => b.id === 'card-min' && b.date === '2026-10-25') };
}

console.log('\n=== 1. cutover-walk close: a satisfied, cash-included minimum is deducted once ===');
{
  const { next, row } = world();
  const control = world({ noSent: true }).next;
  ok(next.openingSource === 'cutover-walk', 'the close opens on the cutover walk', next.openingSource);
  ok(row.status === 'planned' && row.cashPaymentStatus === 'sent', 'row stays Planned with money sent separate');
  ok(row.planned === 120 && row.amount === 120, 'contractual minimum and gross amount intact', { planned: row.planned, amount: row.amount });
  ok(next.opening === control.opening, 'same walked opening as the unpaid control', { opening: next.opening, control: control.opening });
  // close = opening + 2000 payday - bills; the control deducts 120, relief deducts 0.
  ok(control.paydaySweep === Math.round((control.opening + 2000 - 120) * 100) / 100, 'control close deducts the minimum once', control.paydaySweep);
  ok(next.paydaySweep === Math.round((next.opening + 2000) * 100) / 100, 'relief close: no second deduction', next.paydaySweep);
  ok(Math.round((next.paydaySweep - control.paydaySweep) * 100) === 12000, 'relief is exactly one minimum (120)');
  ok(next.remainingBills === 120 && next.periodBillLoad === 120, 'remaining and planned load keep the full minimum',
    { remainingBills: next.remainingBills, periodBillLoad: next.periodBillLoad });
}

console.log('\n=== 2. no relief without the proof (the incumbent withheld close stands) ===');
{
  for (const [label, o] of [
    ['sent alone (issuer unproven)', { noIssuer: true }],
    ['sent for a different cycle', { sent: { scheduledDate: '2026-11-25' } }],
    ['cash inclusion unproven', { sent: { cashIncludedAsOf: null } }],
  ]) {
    const n = world(o).next;
    ok(n.paydaySweep === null && n.plannedPeriodClose === null, label + ': close stays withheld, never relieved', n.paydaySweep);
  }
}

console.log('\n=== 2b. cutover walk seeded from a balance dated before the debit gets no relief ===');
{
  // #1589 review: the funding account balance is dated 2026-10-09, before the
  // 2026-10-12 debit, so the walk seed never had it removed.
  const stale = world({ cashDate: '2026-10-09' }).next;
  const staleControl = world({ cashDate: '2026-10-09', noSent: true }).next;
  ok(stale.openingSource === 'cutover-walk' && stale.paydaySweep != null, 'still a cutover-walk close with a sweep', { src: stale.openingSource, sweep: stale.paydaySweep });
  ok(stale.paydaySweep === staleControl.paydaySweep, 'pre-debit seed: deducted like the unpaid control, no relief',
    { sweep: stale.paydaySweep, control: staleControl.paydaySweep });
  // Balance dated the day of inclusion holds the debit: relief applies.
  const sameDay = world({ cashDate: '2026-10-12' }).next;
  const sameDayControl = world({ cashDate: '2026-10-12', noSent: true }).next;
  ok(sameDay.paydaySweep != null && Math.round((sameDay.paydaySweep - sameDayControl.paydaySweep) * 100) === 12000,
    'balance dated on the inclusion date: relief of exactly 120', { sweep: sameDay.paydaySweep, control: sameDayControl.paydaySweep });
}

console.log('\n=== 3. carry-forward closes get no relief (known limit) ===');
{
  // Codex P1: the snapshot (1120 on 2026-10-09) predates the debit; the
  // chain never removed it. 1120 + 2000 = 3120 active close; 3120 + 2000 - 120 = 5000.
  const pre = world({ snap: 1120 }).next;
  ok(pre.openingSource === 'carry-forward' && pre.plannedPeriodClose === 5000, 'pre-debit snapshot: close 5000 (not 5120)', pre.plannedPeriodClose);
  // A snapshot taken after the debit (880 on 2026-10-09, debit 2026-10-08)
  // already reflects it, but the chain origin is not threaded: no relief.
  // 880 + 2000 = 2880; 2880 + 2000 - 120 = 4760 (a cautious understatement).
  const post = world({ snap: 880, sent: { postedOn: '2026-10-08', cashIncludedAsOf: '2026-10-08' } }).next;
  ok(post.openingSource === 'carry-forward' && post.plannedPeriodClose === 4760, 'post-debit snapshot: still deducted (4760)', post.plannedPeriodClose);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
