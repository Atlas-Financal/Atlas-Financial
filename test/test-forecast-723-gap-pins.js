'use strict';
/* ATLAS-026 (#723) gap (4) pin: partial-period double-count.
 *
 * Test-only. Documents current Forecast behaviour at main 860328fc for a
 * pay period that is part-way through (as-of between paydays):
 *   - a bill paid inside the elapsed part of the period is counted once:
 *     it moves from remaining to paid, and the period bill load, after-bills,
 *     Balance After Deductions and predicted ending do not change;
 *   - the live balance that already reflects that payment is not used as
 *     the period opening (which would subtract the bill a second time);
 *   - the next (future) period opens from the same figure and carries only
 *     its own bill, so in-period payment evidence never changes future
 *     funding inputs and no bill appears in two periods;
 *   - the current-period figures are invariant as the as-of advances
 *     through the period (no remaining-days reslice).
 *
 * Gap (5) (sealed lookback with a missing receipt amount) is deliberately
 * NOT pinned here: Muse ruled 2026-10-30 that it goes to Engine
 * classification on #723 (comment 6523977278).
 *
 * Synthetic fixtures only; amounts are unlike live household figures.
 */
const F = require('../public/forecast.js');

let failures = 0;
let passes = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passes++; else failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005);

const PAYDAY = '2026-10-30';
const NEXT_PAYDAY = '2026-11-13';
const PAY = 1000;
const OPENING = 50;
const ELAPSED = 120; // dated 2026-11-02, inside the elapsed part of the period
const LATER = 30;    // dated 2026-11-10, still ahead in the current period
const NEXT = 80;     // dated 2026-11-20, next period only

function plan(asOf, paidElapsed) {
  const represented = [{ id: 'payroll', date: PAYDAY }];
  if (paidElapsed) represented.push({ id: 'b-elapsed', date: '2026-11-02' });
  return {
    windowDays: 120,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: {
      asOf,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: represented,
    },
    startingCash: { breakdown: [{ id: 'chequing-a',
      value: OPENING + PAY - (paidElapsed ? ELAPSED : 0) }, { id: 'chequing-b', value: 0 }] },
    income: [{ id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02',
      amount: PAY, confidence: 'confirmed' }],
    bills: [
      { id: 'b-elapsed', label: 'Synthetic elapsed bill', frequency: 'once',
        date: '2026-11-02', amount: ELAPSED, confidence: 'confirmed' },
      { id: 'b-later', label: 'Synthetic later bill', frequency: 'once',
        date: '2026-11-10', amount: LATER, confidence: 'confirmed' },
      { id: 'b-next', label: 'Synthetic next bill', frequency: 'once',
        date: '2026-11-20', amount: NEXT, confidence: 'confirmed' },
    ],
    obligations: [], commitments: [], budget: { categories: [] },
  };
}

function views(asOf, paidElapsed) {
  const advice = F.recommend(plan(asOf, paidElapsed), asOf, { weeklyVariable: 0, debts: [] });
  const ppv = advice.payPeriodViews || [];
  return {
    advice,
    cur: ppv.find(p => p.start === PAYDAY),
    next: ppv.find(p => p.start === NEXT_PAYDAY),
    all: ppv,
  };
}
const billIds = p => (p && p.bills || []).map(b => b.id);
const billOccurrences = (all, id) => all.reduce((n, p) => n + billIds(p).filter(x => x === id).length, 0);

console.log('\n§1 Mid-period, elapsed bill NOT yet evidenced as paid (as-of 2026-11-05)');
const unpaid = views('2026-11-05', false);
ok(unpaid.cur && unpaid.cur.role === 'active', 'current period 2026-10-30 is the active period');
ok(unpaid.next && unpaid.next.role === 'future', 'next period 2026-11-13 is future');
ok(eq(unpaid.cur.opening, OPENING), 'current opening is the payday snapshot, not the live balance', `opening=${unpaid.cur.opening}`);
ok(eq(unpaid.cur.incomeTotal, PAY), 'current income counted once', `incomeTotal=${unpaid.cur.incomeTotal}`);
ok(eq(unpaid.cur.periodBillLoad, ELAPSED + LATER), 'current bill load = elapsed + later bill', `load=${unpaid.cur.periodBillLoad}`);
ok(eq(unpaid.cur.paidBills, 0) && eq(unpaid.cur.remainingBills, ELAPSED + LATER), 'nothing paid, all remaining');
ok(eq(unpaid.cur.afterBills, PAY - ELAPSED - LATER), 'after-bills = income − bill load', `afterBills=${unpaid.cur.afterBills}`);
ok(eq(unpaid.cur.balanceAfterDeductions, PAY - ELAPSED - LATER), 'BAD = income − bills (no budget in fixture)');

console.log('\n§2 Same moment, elapsed bill evidenced as PAID (represented + live balance reflects it)');
const paid = views('2026-11-05', true);
ok(eq(paid.cur.opening, OPENING), 'opening stays the payday snapshot; live balance (already net of the bill) is not the opening', `opening=${paid.cur.opening} live=${paid.cur.liveCurrentBalance}`);
ok(eq(paid.cur.liveCurrentBalance, OPENING + PAY - ELAPSED), 'live balance is published separately and already net of the paid bill', `live=${paid.cur.liveCurrentBalance}`);
ok(eq(paid.cur.paidBills, ELAPSED), 'paid bill disclosed as paid', `paid=${paid.cur.paidBills}`);
ok(eq(paid.cur.remainingBills, LATER), 'paid bill leaves remaining', `remaining=${paid.cur.remainingBills}`);
ok(eq(paid.cur.paidBills + paid.cur.remainingBills, paid.cur.periodBillLoad), 'paid + remaining = period bill load (one count)');
ok(eq(paid.cur.periodBillLoad, unpaid.cur.periodBillLoad), 'period bill load unchanged by payment evidence', `${paid.cur.periodBillLoad} vs ${unpaid.cur.periodBillLoad}`);
ok(eq(paid.cur.afterBills, unpaid.cur.afterBills), 'after-bills unchanged by payment evidence (not deducted twice)', `${paid.cur.afterBills} vs ${unpaid.cur.afterBills}`);
ok(eq(paid.cur.balanceAfterDeductions, unpaid.cur.balanceAfterDeductions), 'BAD unchanged by payment evidence');
ok(eq(paid.cur.predictedEndingBalance, unpaid.cur.predictedEndingBalance), 'predicted ending unchanged by payment evidence', `${paid.cur.predictedEndingBalance}`);
const paidRow = (paid.cur.bills || []).find(b => b.id === 'b-elapsed');
ok(paidRow && /paid/i.test(String(paidRow.status)), 'elapsed bill row is marked paid', `status=${paidRow && paidRow.status}`);
const due = (paid.advice.currentPeriodAction && paid.advice.currentPeriodAction.thisPaydayDue) || [];
ok(!due.some(d => d.id === 'b-elapsed') && due.some(d => d.id === 'b-later'), 'this-payday due list drops the paid bill and keeps the later one', `due=${due.map(d => d.id).join(',')}`);

console.log('\n§3 Future period: no carry-over double count');
for (const [label, v] of [['unpaid', unpaid], ['paid', paid]]) {
  ok(eq(v.next.opening, OPENING + PAY - ELAPSED - LATER), `${label}: next opens from current cash once (50 + 1000 − 150)`, `opening=${v.next.opening}`);
  ok(eq(v.next.periodBillLoad, NEXT) && billIds(v.next).join(',') === 'b-next', `${label}: next period carries only its own bill`, `bills=${billIds(v.next).join(',')}`);
  ok(eq(v.next.incomeTotal, PAY), `${label}: next income counted once`);
  for (const id of ['b-elapsed', 'b-later', 'b-next']) {
    ok(billOccurrences(v.all, id) === 1, `${label}: ${id} appears in exactly one published period`, `count=${billOccurrences(v.all, id)}`);
  }
}
ok(eq(paid.next.opening, unpaid.next.opening) && eq(paid.next.balanceAfterDeductions, unpaid.next.balanceAfterDeductions)
  && eq(paid.next.predictedEndingBalance, unpaid.next.predictedEndingBalance),
  'in-period payment evidence does not change future-period funding inputs');

console.log('\n§4 As-of advancing through the period does not reslice the current period');
const base = views(PAYDAY, false).cur;
for (const asOf of ['2026-11-01', '2026-11-05', '2026-11-11']) {
  const c = views(asOf, false).cur;
  const same = ['opening', 'incomeTotal', 'periodBillLoad', 'afterBills', 'balanceAfterDeductions', 'predictedEndingBalance']
    .every(k => eq(c[k], base[k]));
  ok(same, `as-of ${asOf}: current-period figures equal the payday-day figures`,
    `load=${c.periodBillLoad} bad=${c.balanceAfterDeductions} pe=${c.predictedEndingBalance}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) {
  console.log('FAILURES');
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
