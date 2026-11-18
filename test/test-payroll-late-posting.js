'use strict';
/* Census rank 3 (lead dispatch 2026-11-17): a paycheque that posts one business
 * day late no longer blanks the live plan.
 *
 * A STOPGAP: the LM recurring-matches slice (pay settled from Lunch Money's own
 * expected/found pairing) retires it.
 *
 * Rule (scripts/provider-observe.js futureIncomeUncertainty, payroll only):
 * a POSTED payroll-identified credit dated within one business day after the
 * payday just before it, when nothing claimed that payday, is that payday's
 * late posting. Since the lead's 2026-11-18 dispatch the matcher settles that
 * payday from it, at its actual amount, exactly as on time; it is never the next pay and is never the next pay. Business
 * days are Forecast's (Monday to Friday, no holiday calendar). A second
 * qualifying credit, a credit two business days late, or a credit not explicitly posted still holds the plan exactly as before.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance
 * harness) -> served data -> Forecast.recommend. Invented schedule: biweekly
 * pay of 1400 from Friday 2026-10-09; plan date 2026-10-14 (a Wednesday). Every
 * expected value is hand-derived from that schedule.
 * `node test/test-payroll-late-posting.js`
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const pay = (date, raw, payee = 'Invented employer', amount = 1400) =>
  H.lm({ date, amount: -amount, category: 'Payroll', account: 'chequing-a', payee, raw });
function run(txs, asOf) {
  const w = H.baseWorld();
  if (asOf) w.asOf = asOf;
  w.transactions = txs;
  const r = H.dataOf(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.data.plan, w.asOf, { currentPeriodActuals: r.packet, debts: r.data.debts });
  const current = rec.defaultView.calendarPeriods.find(p => p.start <= w.asOf && p.end >= w.asOf);
  const future = F.expandEvents(r.data.plan, w.asOf, '2026-11-30', {})
    .filter(e => e.kind === 'income').map(e => e.date + ':' + e.amount);
  return { r, current, future, operatingPlan: r.data.liveOverlay.operatingPlan, note: r.data.liveOverlay.operatingPlanNote };
}
const live = s => s.operatingPlan === 'live' && !s.note;
const held = s => s.operatingPlan === 'unavailable';

// Hand-derived: paydays 2026-10-23, 2026-11-06 and 2026-11-20 lie after the plan date, each 1400, each once.
const FUTURE = ['2026-10-23:1400', '2026-11-06:1400', '2026-11-20:1400'];

console.log('Business days are Forecast\'s: Monday to Friday, no holiday calendar');
ok(F.businessDaysAfter('2026-10-09', '2026-10-12') === 1, 'Friday to Monday is one business day');
ok(F.businessDaysAfter('2026-10-09', '2026-10-13') === 2, 'Friday to Tuesday is two');
ok(F.businessDaysAfter('2026-10-09', '2026-10-10') === 0, 'Friday to Saturday is none');

console.log('The late-Monday paycheque restores the plan');
const onTime = run([pay('2026-10-09')]);
// A replay re-reads the SAME Lunch Money row, so the late deposit keeps one provider id.
const lateTx = () => pay('2026-10-12', { id: 91001 });
const late = run([lateTx()]);
ok(live(onTime), 'positive control: the on-time Friday pay keeps the plan live');
ok(live(late), 'the pay landing Monday, one business day late, keeps the plan live', JSON.stringify([late.operatingPlan, late.note]));
ok(!(late.r.data.plan.incomeReconciliation && late.r.data.plan.incomeReconciliation.status === 'unavailable'),
  'no posted-income-occurrence-unresolved hold is published');
ok(!/Early deposit to confirm/.test(JSON.stringify(late.r.data)), 'the misleading "Early deposit to confirm … Dale approves" note is gone');

console.log('Zero second cash: the late pay settles its own payday once and is never the next pay');
ok(JSON.stringify(late.future) === JSON.stringify(FUTURE), 'the next three paydays are 1400 each, once each', JSON.stringify(late.future));
ok(JSON.stringify(late.future) === JSON.stringify(onTime.future), 'the future is identical to the on-time case');
ok(late.current.incomeTotal === 1400 && late.current.incomeAdded === 1400,
  'this period\'s income is 1400, never 2800 (the deposit is not counted beside its payday)',
  JSON.stringify([late.current.incomeTotal, late.current.incomeAdded]));
for (const key of ['available', 'afterBills', 'balanceAfterDeductions', 'plannedPeriodClose', 'budgetHold']) {
  ok(late.current[key] === onTime.current[key], `${key} equals the on-time case (${onTime.current[key]})`, String(late.current[key]));
}
// Lead dispatch 2026-11-18 (OWNER DECISION pending on the PR): the late pay now settles the payday, so it is tagged
// exactly as the on-time pay, never more certain than on time.
ok(late.current.incomeTrust === onTime.current.incomeTrust
  && late.current.balanceAfterDeductionsTrust === onTime.current.balanceAfterDeductionsTrust,
  'the late case is tagged exactly as the on-time case, never more certain',
  JSON.stringify([late.current.incomeTrust, onTime.current.incomeTrust, late.current.balanceAfterDeductionsTrust]));

console.log('A replay is idempotent');
const again = run([lateTx()]);
ok(JSON.stringify(again.r.data.liveOverlay) === JSON.stringify(late.r.data.liveOverlay)
  && JSON.stringify(again.future) === JSON.stringify(late.future), 'the same observation twice gives the same served result');
const nextRefresh = run([lateTx()], '2026-10-20');
ok(live(nextRefresh) && JSON.stringify(nextRefresh.future) === JSON.stringify(FUTURE),
  'the next refresh (2026-10-20) still sees the same credit: still live, the next payday still 1400 once',
  JSON.stringify([nextRefresh.operatingPlan, nextRefresh.future]));

console.log('Everything else still holds');
ok(held(run([pay('2026-10-12'), pay('2026-10-13')])), 'two payroll credits after the same unclaimed payday hold the plan');
ok(held(run([pay('2026-10-09'), pay('2026-10-12')])), 'an extra credit after a payday already claimed on time holds the plan');
// Codex P2 on #1290: two compatible receipts on the payday leave it ambiguous, not claimed; a Monday credit must not be
// absorbed as its late pay (main holds this case too).
ok(held(run([pay('2026-10-09', { id: 91101 }), pay('2026-10-09', { id: 91102 }), pay('2026-10-12', { id: 91103 })])),
  'a late credit after a payday whose own receipts compete holds the plan');
ok(held(run([pay('2026-10-13')])), 'a pay two business days late (Tuesday) holds the plan');
ok(held(run([pay('2026-10-12', { is_pending: null })])), 'a late credit not explicitly posted holds the plan');

// Lead dispatch 2026-11-18: the late credit now settles the payday at its actual amount, exactly as on time. Hand-
// derived: on time, a 700 credit publishes 700 and a 2800 publishes 2800; late, the same (never 1400, never 1401).
console.log('A late credit of any amount settles at that amount, exactly as on time');
for (const amount of [700, 1, 2800, 1400.5, 1399.99]) {
  const lateOdd = run([pay('2026-10-12', undefined, undefined, amount)]);
  const onTimeOdd = run([pay('2026-10-09', undefined, undefined, amount)]);
  ok(live(lateOdd) && lateOdd.current.incomeTotal === amount, `a late credit of ${amount} is live and publishes ${amount}`,
    JSON.stringify([lateOdd.operatingPlan, lateOdd.current && lateOdd.current.incomeTotal]));
  ok(live(onTimeOdd) && onTimeOdd.current.incomeTotal === amount, `control: on time, the same ${amount} is live and publishes ${amount}`,
    JSON.stringify([onTimeOdd.operatingPlan, onTimeOdd.current.incomeTotal]));
}
ok(live(run([pay('2026-10-12', undefined, undefined, 1400.004)])), 'a credit within half a cent of 1400 (the identity epsilon) is absorbed');
// Order: a non-qualifying credit listed first must not let a qualifying one after it through, and two exact credits
// hold in either order.
ok(held(run([pay('2026-10-12', { id: 91201 }, undefined, 700), pay('2026-10-12', { id: 91202 })])),
  'a short credit listed before an exact one on the same Monday holds the plan');
ok(held(run([pay('2026-10-12', { id: 91302 }), pay('2026-10-12', { id: 91301 }, undefined, 700)])),
  'an exact credit listed before a short one holds the plan');
ok(held(run([pay('2026-10-12', { id: 91402 }), pay('2026-10-12', { id: 91401 })])),
  'two exact credits, the higher id listed first, hold the plan');
const unidentified = run([pay('2026-10-12', undefined, 'Invented stranger')]);
const unidentifiedMain = 'unchanged from main: this hold reads payroll-identified credits only';
ok(unidentified.operatingPlan === 'live', 'an unidentified credit was never read by this hold, and still is not (' + unidentifiedMain + ')');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll payroll late-posting checks passed.');
