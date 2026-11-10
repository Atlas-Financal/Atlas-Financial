'use strict';
/* Future-window demotion (#821 Next up; state-machine map, problem 9).
 *
 * A bill occurrence dated after asOf in a role-future window is disclosed as
 * not yet paid (status planned, settlement upcoming, remaining = full
 * amount). It must not also keep the observed actual, the excess disclosure
 * or the observed movement. Synthetic data only. Expected values are literal
 * hand arithmetic, not Forecast helper output.
 *
 * Fixture: biweekly payroll 4000 anchored 2026-08-14, as-of 2026-10-09,
 * a 42.00 once-bill on 2026-11-10 (window Nov 6-19, role future) and a second
 * 42.00 estimated once-bill on 2026-11-11 with no receipt, so the window's
 * bill load is 42 + 42 = 84.00 in every case.
 *
 * `node test/test-future-window-demotion.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-10-09';
const DUE = '2026-11-10';

function plan() {
  return {
    defaults: { targetBuffer: 500 }, windowDays: 91,
    startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2000, class: 'spendable' }] },
    opening: { asOf: AS_OF, representedEvents: [{ id: 'fut', date: DUE }] },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [{ id: 'payroll', label: 'Payroll', frequency: 'biweekly', anchor: '2026-08-14', amount: 4000, confidence: 'confirmed' }],
    bills: [
      { id: 'fut', label: 'Future bill', amount: 42, frequency: 'once', date: DUE, confidence: 'confirmed', payingAccount: 'chequing-a' },
      { id: 'cur', label: 'Estimated bill', amount: 42, frequency: 'once', date: '2026-11-11', confidence: 'estimated', payingAccount: 'chequing-a' },
    ],
    obligations: [], commitments: [], budget: { categories: [] },
  };
}

function run(actual, extraRows) {
  const packet = { representedActuals: [{ id: 'fut', date: DUE, actual }].concat(extraRows || []) };
  const before = JSON.stringify(packet);
  const advice = F.recommend(plan(), AS_OF, { targetBuffer: 500, debts: [], currentPeriodActuals: packet });
  return { advice, packet, untouched: JSON.stringify(packet) === before };
}
function rowIn(views, id) {
  for (const p of views || []) for (const r of p.bills || []) if (r && r.id === id && r.date === DUE) return { p, r };
  return null;
}

// [label, observed actual, expected excess (null = none)]
const CASES = [
  ['zero payment', 0, null],
  ['underpayment (30.00 of 42.00)', 30, null],
  ['equal payment (42.00)', 42, null],
  ['overpayment (50.00 of 42.00, 8.00 over)', 50, 8],
];

for (const [label, actual] of CASES) {
  console.log('\n=== ' + label + ' ===');
  const { advice, untouched } = run(actual);
  // The published rows the Budget timeline reads (payPeriodViews). The
  // Nov 6-19 window is a further-future row, not in calendarPeriods.
  const sources = [['payPeriodViews', advice.payPeriodViews]];
  for (const [name, views] of sources) {
    const hit = rowIn(views, 'fut');
    if (!hit) { ok(false, name + ': row present'); continue; }
    const { p, r } = hit;
    ok(p.timelineRole === 'future', name + ': row is in a future window');
    ok(r.status === 'planned' && r.glanceKind === 'planned' && r.settlement === 'upcoming', name + ': planned / upcoming');
    ok(r.remaining === 42, name + ': full 42.00 still owed');
    ok(r.actual === 0, name + ': no observed actual kept', String(r.actual));
    ok(r.movement === -42, name + ': scheduled movement restored', String(r.movement));
    ok(r.excess === undefined && r.excessTrust === undefined && r.excessSource === undefined, name + ': no excess disclosure');
    ok(r.planned === 42 && r.amount === 42, name + ': assigned load (planned / amount) unchanged');
    ok(p.periodBillLoad === 84, name + ': window bill load is the assigned 84.00', String(p.periodBillLoad));
    ok(p.paidBills === 0, name + ': nothing counted as paid', String(p.paidBills));
  }
  ok(untouched, 'source receipt (representedActuals) is not mutated');
}

console.log('\n=== load and balance are identical across all four cases ===');
{
  const loads = CASES.map(([, a]) => {
    const hit = rowIn(run(a).advice.payPeriodViews, 'fut');
    return hit && [hit.p.periodBillLoad, hit.p.balanceAfterDeductions, hit.p.remainingBills].join('|');
  });
  ok(loads.every(x => x && x === loads[0]), 'periodBillLoad / balanceAfterDeductions / remainingBills do not vary with the observed actual', loads[0]);
}

console.log('\n=== non-future and unmatched rows are untouched ===');
{
  const { advice } = run(50);
  const hit = rowIn(advice.payPeriodViews, 'cur');
  ok(!hit, 'unmatched bill on another date is not keyed by the receipt');
  // The un-observed 2026-11-11 row (own id) keeps a zero-actual upcoming face.
  let other = null;
  for (const p of advice.payPeriodViews || []) for (const r of p.bills || []) if (r && r.id === 'cur') other = r;
  ok(other && other.actual === 0 && other.excess === undefined && other.remaining === 42,
    'a future bill with no receipt is unchanged: actual 0, remaining 42, no excess');
}

console.log(failures ? `\n${failures} FAILED` : '\nAll future-window demotion checks passed');
process.exit(failures ? 1 : 0);
