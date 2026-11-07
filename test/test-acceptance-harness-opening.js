'use strict';
/* The acceptance harness serves its worlds through production's opening
 * shape, so acceptance figures are not double-deducted.
 *
 * Production's canonical document is dated at its last canonical write and
 * never carries priorAsOf; scripts/live-plan.js writes priorAsOf and the
 * matched postings when the live overlay advances the opening. The harness
 * used to date its canonical opening on the live day WITH priorAsOf Oct 9
 * and no matched postings, so Forecast re-deducted bills already posted
 * Oct 10-13 from a balance that already excluded them.
 *
 * Invented check-1 base world (no browser): as-of Oct 14, household
 * opening cash 2,500 (chequing 2,000 + 500; Savings is a reserve, not
 * opening cash). Hydro 90 posted Oct 12, inside that observed balance;
 * internet 60 is due Oct 28. With no spending the Oct 14 walk balance is
 * 2,500, not 2,500 − 90 = 2,410. The twin with hydro unpaid still owes it
 * and deducts it once: 2,410.
 */
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

function world(paid) {
  const w = H.baseWorld('2026-10-14');
  w.bills = [
    { id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed', payee: 'Invented hydro' },
    { id: 'net', label: 'Invented internet', amount: 60, frequency: 'monthly', day: 28, confidence: 'confirmed', payee: 'Invented net co' },
  ];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (paid) w.transactions.push(H.lm({ date: '2026-10-12', amount: 90, category: 'Utilities', account: 'chequing-a', payee: 'Invented hydro' }));
  return w;
}

console.log('=== canonical document has production\'s opening shape ===');
{
  const canonical = H.planOf(world(true)).opening;
  ok(!Object.prototype.hasOwnProperty.call(canonical, 'priorAsOf'), 'the canonical opening carries no priorAsOf', JSON.stringify(canonical));
  ok(canonical.asOf === '2026-10-09', 'it is dated at the last canonical opening (Oct 9), before the live day', canonical.asOf);
}

console.log('\n=== served (live overlay advanced) ===');
{
  const r = H.observe(world(true));
  ok(!r.error, 'the live overlay is admitted, not a failed refresh', r.error && r.error.message);
  const o = r.plan.opening;
  ok(o.asOf === '2026-10-14' && o.priorAsOf === '2026-10-09', 'live-plan advanced the opening Oct 9 → Oct 14 and wrote priorAsOf', `${o.asOf} / ${o.priorAsOf}`);
  ok((o.representedEvents || []).some(e => e.id === 'hydro' && e.date === '2026-10-12'),
    'the posted Oct 12 hydro is named as a matched posting', JSON.stringify(o.representedEvents));
  const sim = F.simulate(r.plan, o.asOf, { weeklyVariable: 0 });
  ok(sim.daily[0].date === '2026-10-14' && sim.daily[0].balance === 2500,
    'zero-spend Oct 14 balance is 2,500 — the paid hydro is not deducted again', JSON.stringify(sim.daily[0]));
}

console.log('\n=== twin: hydro unpaid ===');
{
  const r = H.observe(world(false));
  const sim = F.simulate(r.plan, r.plan.opening.asOf, { weeklyVariable: 0 });
  ok(sim.daily[0].balance === 2410, 'an unpaid Oct 12 hydro is still owed and deducted once: 2,500 − 90 = 2,410', JSON.stringify(sim.daily[0]));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nacceptance harness opening checks pass');
process.exit(failures ? 1 : 0);
