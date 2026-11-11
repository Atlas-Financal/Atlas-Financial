'use strict';
/* The acceptance harness serves every world through production's opening
 * shape, so a bill posted between the canonical opening and the live day is
 * deducted once, as on the real page, not twice.
 *
 * Production's canonical document is dated at its last write and carries no
 * priorAsOf; scripts/live-plan.js advances it to the live day and writes
 * priorAsOf and the matched postings itself. A harness that dated the
 * canonical opening on the live day (with priorAsOf preset and no matched
 * postings) made Forecast deduct bills already inside the observed balance
 * again.
 *
 * Invented world, no browser: as-of Oct 14, opening cash 2,500. Hydro 90
 * posted Oct 12, already inside the observed balance; with no spending the
 * Oct 14 walk balance is 2,500, not 2,410. The twin with hydro unpaid still
 * owes it and deducts it once: 2,410. Hand-derived; nothing read back from
 * Forecast.
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

console.log('=== served through production\'s opening (no opt-in call) ===');
{
  const r = H.observe(world(true));
  ok(!r.error, 'the live overlay is admitted', r.error && r.error.message);
  const o = r.plan.opening;
  ok(o.asOf === '2026-10-14' && o.priorAsOf === '2026-10-09', 'live-plan advanced the opening Oct 9 -> Oct 14 and wrote priorAsOf', `${o.asOf} / ${o.priorAsOf}`);
  ok((o.representedEvents || []).some(e => e.id === 'hydro' && e.date === '2026-10-12'),
    'the posted Oct 12 hydro is a matched posting', JSON.stringify(o.representedEvents));
  const sim = F.simulate(r.plan, o.asOf, { weeklyVariable: 0 });
  ok(sim.daily[0].date === '2026-10-14' && sim.daily[0].balance === 2500,
    'zero-spend Oct 14 balance is 2,500: the posted hydro is deducted once (never again)', JSON.stringify(sim.daily[0]));
}

console.log('\n=== twin: hydro unpaid ===');
{
  const r = H.observe(world(false));
  const sim = F.simulate(r.plan, r.plan.opening.asOf, { weeklyVariable: 0 });
  ok(sim.daily[0].balance === 2410, 'an unpaid Oct 12 hydro is still owed and deducted once: 2,500 - 90 = 2,410', JSON.stringify(sim.daily[0]));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nacceptance harness opening checks pass');
process.exit(failures ? 1 : 0);
