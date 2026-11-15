'use strict';
// Authorized addition (funding-plan authority): the current pay period
// publishes `paydaySchedule`, the one payday funding schedule the Today sheet
// reprints (cut from the same selected-Budget walk as every period's
// plannedCostFunding). Frozen-engine parity suites validate it here, then
// remove exactly this field before comparing with the older engine, as they
// already do for other authorized additions. Every other field stays
// byte-compared. The validation covers the point of the addition: every
// payday row the schedule prints equals the contribution AND the trust tag the
// matching period publishes, and the schedule's own trust is a published word.
// It fails when it validated nothing (a suite that no longer publishes the
// schedule must not pass silently), and it deletes only `paydaySchedule` on a
// current-period node whose schedule it validated (or an identical copy of it).
const assert = require('node:assert/strict');
const cents = v => Math.round(Number(v) * 100);
const TRUST = ['calculated', 'estimated'];
function stripPaydaySchedule(advice) {
  const views = Array.isArray(advice && advice.payPeriodViews) ? advice.payPeriodViews : [];
  const published = new Map();
  let validated = 0, rows = 0;
  for (const period of views) {
    if (!Object.hasOwn(period, 'paydaySchedule')) continue;
    assert.equal(period.timelineRole, 'current', 'paydaySchedule is published on the current period only');
    const schedule = period.paydaySchedule;
    assert.equal(schedule.source, 'Forecast.planSpendPaydayFunding');
    assert.equal(schedule.basis, 'selected-Budget-period');
    assert.ok(['ready', 'funding-gap', 'unavailable'].includes(schedule.status), 'schedule status is a published word');
    if (schedule.status !== 'unavailable') {
      assert.ok(TRUST.includes(schedule.fundingTrust), 'the schedule carries a published funding trust');
      for (const row of schedule.paydays) {
        assert.ok(TRUST.includes(row.trust), 'schedule payday ' + row.payday + ' carries a published trust');
        const match = views.find(p => p.start === row.payday && p.plannedCostFunding);
        if (!match || match.plannedCostFunding.status === 'unavailable') continue;
        assert.equal(cents(row.contribution), cents(match.plannedCostFunding.contribution),
          'schedule payday ' + row.payday + ' equals that period\'s published contribution');
        assert.equal(row.trust, match.plannedCostFunding.trust,
          'schedule payday ' + row.payday + ' carries that period\'s published trust tag');
        rows++;
      }
    }
    published.set(period.start, schedule);
    validated++;
  }
  assert.ok(validated > 0, 'paydaySchedule was published and validated (nothing to exclude means the control proves nothing)');
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Object.hasOwn(node, 'paydaySchedule')) {
      assert.equal(node.timelineRole, 'current', 'only a current-period node carries paydaySchedule');
      assert.deepEqual(node.paydaySchedule, published.get(node.start), 'a copy of paydaySchedule is the validated one');
      delete node.paydaySchedule;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated, rows };
}
module.exports = { stripPaydaySchedule };
