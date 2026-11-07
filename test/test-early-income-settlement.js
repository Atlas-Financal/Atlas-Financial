'use strict';
/* Early income is settled once.
 *
 * Income that posts before its scheduled date is already inside the live
 * opening cash. The cash walk must not add that occurrence again, and the
 * Budget income row must say the same thing the walk does. Two settlement
 * paths name an early receipt:
 *   - an identity-linked posting (observer candidate, early-or-due rule);
 *   - the unique child-benefit weekend pairing (privacy-stripped credit).
 * Where identity is ambiguous (two compatible credits), the occurrence is
 * withheld: never added, never called received.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js
 * fromObservation -> Forecast.recommend. Expected figures are hand arithmetic
 * in test/fixtures/early-income-settlement-worlds.js, not Atlas output.
 *
 * `node test/test-early-income-settlement.js`
 */
const F = require('../public/forecast.js');
const { H, childBenefit, rent } = require('./fixtures/early-income-settlement-worlds');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

function run(w) {
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const asOf = data.plan.opening.asOf;
  const opts = { debts: data.debts, targetBuffer: 0, currentPeriodActuals: packet };
  const advice = F.recommend(data.plan, asOf, opts);
  const walk = F.expandEvents(data.plan, asOf, F.addDays(asOf, 21), opts)
    .filter(e => e.kind === 'income').map(e => e.id + '@' + e.date);
  const rows = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .flatMap(p => p.income || []);
  const other = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .flatMap(p => (p.otherIncome && p.otherIncome.items) || []);
  return { data, advice, walk, rows, other, asOf };
}
const row = (r, id, date) => r.rows.find(x => x && x.id === id && x.date === date) || null;

console.log('=== 1. Child benefit posted Fri for a Sun occurrence (weekend pairing) ===');
{
  const control = run(childBenefit('control'));
  const early = run(childBenefit('early'));
  ok(control.asOf === '2026-10-17' && early.asOf === '2026-10-17', 'live opening is the Oct 17 observation');
  ok(control.advice.weekly === 405, 'control (not yet posted): $405/week', String(control.advice.weekly));
  ok(control.walk.includes('childBenefit@2026-10-18'), 'control: the walk still expects Oct 18 +250');
  ok(early.advice.weekly === 405, 'early posting: $405/week, same as not yet posted', String(early.advice.weekly));
  ok(!early.walk.includes('childBenefit@2026-10-18'), 'early: the walk does not add Oct 18 again');
  ok(early.walk.includes('payroll@2026-10-23'), 'positive control: the next payroll is still in the walk');
  const cb = row(early, 'childBenefit', '2026-10-18');
  ok(cb && cb.status === 'received' && Number(cb.actual) === 250 && cb.settlement === 'represented',
    'early: Budget row says received $250, represented', JSON.stringify(cb && [cb.status, cb.actual, cb.settlement]));
  ok(!early.other.some(x => x && Math.abs(Number(x.amount)) === 250), 'early: the credit is not also Other income');
}

console.log('=== 2. Identity-linked rent posted Fri Oct 30 for Sun Nov 1 ===');
{
  const control = run(rent('control'));
  const early = run(rent('early'));
  ok(control.advice.weekly === 465, 'control (not yet posted): $465/week', String(control.advice.weekly));
  ok(control.walk.includes('rent@2026-11-01'), 'control: the walk still expects Nov 1 +800');
  ok(early.advice.weekly === 465, 'early posting: $465/week, same as not yet posted', String(early.advice.weekly));
  ok(!early.walk.includes('rent@2026-11-01'), 'early: the walk does not add Nov 1 again');
  const named = (early.data.plan.opening.representedEvents || [])
    .find(x => x.id === 'rent' && x.date === '2026-11-01');
  ok(!!named && named.effectiveAsOf === '2026-10-31', 'early: live opening names rent@2026-11-01 effective Oct 31',
    JSON.stringify(named));
  const refused = ((early.data.liveOverlay && early.data.liveOverlay.refused) || [])
    .filter(x => x && x.eventId === 'rent');
  ok(refused.length === 0, 'early: the rent posting is no longer refused as not-live-as-of', JSON.stringify(refused));
  const r = row(early, 'rent', '2026-11-01');
  ok(r && r.status === 'received' && r.settlement === 'represented', 'early: Budget row says received, represented',
    JSON.stringify(r && [r.status, r.settlement]));
}

console.log('=== 3. Ambiguous early child benefit (two 250 credits) is withheld, not doubled ===');
{
  const amb = run(childBenefit('ambiguous'));
  ok(amb.advice.weekly === 405, 'ambiguous: $405/week (occurrence withheld)', String(amb.advice.weekly));
  ok(!amb.walk.includes('childBenefit@2026-10-18'), 'ambiguous: the walk does not add Oct 18');
  const cb = row(amb, 'childBenefit', '2026-10-18');
  ok(cb && cb.status !== 'received' && cb.notReliedUpon === true
    && cb.notReliedUponReason === 'early-inbound-ambiguous',
  'ambiguous: Budget row is not relied upon, never received', JSON.stringify(cb && [cb.status, cb.notReliedUpon, cb.notReliedUponReason]));
}

console.log('=== 4. Ambiguous early rent (two tenant credits) is withheld, not doubled ===');
{
  const amb = run(rent('ambiguous'));
  ok(amb.advice.weekly === 465, 'ambiguous: $465/week (occurrence withheld)', String(amb.advice.weekly));
  ok(!amb.walk.includes('rent@2026-11-01'), 'ambiguous: the walk does not add Nov 1');
  const guard = (amb.data.plan.opening.notReliedUponEvents || [])
    .find(x => x.id === 'rent' && x.date === '2026-11-01');
  ok(!!guard && guard.reason === 'early-inbound-ambiguous', 'ambiguous: live opening withholds rent@2026-11-01',
    JSON.stringify(guard));
  ok(!(amb.data.plan.opening.representedEvents || []).some(x => x.id === 'rent'), 'ambiguous: rent is not named represented');
  const r = row(amb, 'rent', '2026-11-01');
  ok(r && r.status !== 'received' && r.notReliedUpon === true, 'ambiguous: Budget row is not relied upon',
    JSON.stringify(r && [r.status, r.notReliedUpon, r.notReliedUponReason]));
}

console.log('=== 5. Contract boundaries of the early-income helper ===');
{
  const plan = { income: [{ id: 'rent', frequency: 'monthly', day: 1, amount: 800 }], bills: [], obligations: [] };
  ok(F.prepaidIncomeOccurrence(plan, 'rent', '2026-11-01', '2026-10-31') === true, 'exact future occurrence qualifies');
  ok(F.prepaidIncomeOccurrence(plan, 'rent', '2026-11-02', '2026-10-31') === false, 'a non-occurrence date does not');
  ok(F.prepaidIncomeOccurrence(plan, 'rent', '2026-10-31', '2026-10-31') === false, 'the opening date itself is not prepaid');
  ok(F.prepaidIncomeOccurrence(plan, 'levy', '2026-11-01', '2026-10-31') === false, 'an unknown stream does not');
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nAll early-income settlement checks passed.');
