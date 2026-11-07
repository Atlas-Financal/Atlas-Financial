'use strict';
/* An impossible settlement date never settles a commitment.
 *
 * Invented case: as-of 2026-10-14; a 500 requirement due 2026-10-20.
 * settledOn '2026-09-31' (September has 30 days) or '2026-02-31' is
 * date-shaped but is no calendar day. Before the fix either one settled
 * the requirement: Forecast dropped the 500 outflow, the current period's
 * leftover after big purchases read 1,000 instead of 500, and the goal
 * vanished from the Budget page. Malformed evidence must leave the row
 * unpaid, exactly as if no settlement were recorded.
 *
 * Production observation path (live-plan via the acceptance harness's
 * dataOf) and Forecast.recommend; the expected figures are hand-derived:
 * unsettled leftover = 1,000 - 500 = 500.
 */
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const F = require('../public/forecast');
const NEED = 500;
function run(settledOn) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'tickets', label: 'Invented tickets', date: '2026-10-20', amount: NEED,
    confidence: 'confirmed', ...(settledOn === undefined ? {} : { settledOn }) }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  const opts = { debts: data.debts, currentPeriodActuals: packet };
  const advice = F.recommend(data.plan, w.asOf, opts);
  const sim = F.simulate(data.plan, w.asOf, opts);
  const current = advice.payPeriodViews.find(v => v.timelineRole === 'current');
  return {
    plans: advice.majorPlans.map(p => p.id),
    outflow: sim.events.filter(e => e.id === 'tickets' || /Invented tickets/.test(e.label || '')).reduce((s, e) => s + e.amount, 0),
    ending: sim.ending,
    leftover: current.afterBigPurchases,
  };
}
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const unsettled = run(undefined);
eq(unsettled.plans, ['tickets']);
eq(unsettled.outflow, -NEED);
const settled = run('2026-10-12');
eq(settled.plans, [], 'a real confirmation date still settles');
eq(settled.outflow, 0);
eq(Math.round((settled.leftover - unsettled.leftover) * 100), NEED * 100, 'settling frees exactly the need');
eq(Math.round((settled.ending - unsettled.ending) * 100), NEED * 100);
for (const bad of ['2026-09-31', '2026-02-31', '2026-02-29', '2026-04-31', '2025-06-31']) {
  eq(run(bad), unsettled, bad + ' is no calendar day: the requirement stays unpaid');
}
// Leap day is a real date and settles (control for the leap rule).
eq(run('2024-02-29').plans, [], '2024-02-29 is a real day');
// The settledBy boundary itself must be a real day.
eq(F.commitmentSettledBy({ settledOn: '2026-02-28' }, '2026-02-31'), false);
eq(F.commitmentSettledOn({ settledOn: '2026-02-31' }), null);
console.log(`  PASS  impossible settlement dates never settle a commitment (${checks} checks)`);
