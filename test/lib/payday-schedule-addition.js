'use strict';
// Authorized addition (funding-plan authority): the current pay period
// publishes `paydaySchedule`, the one payday funding schedule the Today sheet
// reprints (cut from the same selected-Budget walk as every period's
// plannedCostFunding). Frozen-engine parity suites validate it here, then
// remove exactly this key before comparing with the older engine, as they
// already do for other authorized additions. Every other field stays
// byte-compared. The validation includes the point of the addition: every
// payday row the schedule prints equals the contribution the matching
// period publishes.
const assert = require('node:assert/strict');
const cents = v => Math.round(Number(v) * 100);
function stripPaydaySchedule(advice) {
  const views = Array.isArray(advice && advice.payPeriodViews) ? advice.payPeriodViews : [];
  let validated = 0, rows = 0;
  for (const period of views) {
    if (!Object.hasOwn(period, 'paydaySchedule')) continue;
    assert.equal(period.timelineRole, 'current', 'paydaySchedule is published on the current period only');
    const schedule = period.paydaySchedule;
    assert.equal(schedule.source, 'Forecast.planSpendPaydayFunding');
    assert.equal(schedule.basis, 'selected-Budget-period');
    assert.ok(['ready', 'funding-gap', 'unavailable'].includes(schedule.status), 'schedule status is a published word');
    if (schedule.status !== 'unavailable') {
      for (const row of schedule.paydays) {
        const match = views.find(p => p.start === row.payday && p.plannedCostFunding);
        if (!match || match.plannedCostFunding.status === 'unavailable') continue;
        assert.equal(cents(row.contribution), cents(match.plannedCostFunding.contribution),
          'schedule payday ' + row.payday + ' equals that period\'s published contribution');
        rows++;
      }
    }
    validated++;
  }
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    delete node.paydaySchedule;
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated, rows };
}
module.exports = { stripPaydaySchedule };
