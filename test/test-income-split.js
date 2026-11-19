'use strict';
/* Stack Wallet A1 (Dale, 2026-11-19, #821 7012644117; lead ruling F5, ATLAS LEAD 11): each pay period publishes
 * stackSummary.income = { dale, amanda, other, total }, the waterfall lines down to Total income, set as the last step
 * on the published result from each view's final fields (publishStackSummary). Each line is { amount, trust }, with a
 * reason when withheld. dale + amanda + other equals incomeTotal to the cent; 'named' income streams count as Other.
 * Each line carries the trust its own rows earn, never more certain than the total. A withheld incomeTotal withholds
 * every line.
 *
 * Path: invented raw Lunch Money rows -> scripts/live-plan.js fromObservation -> Forecast.recommend payPeriodViews.
 *
 * Invented world (test/fixtures/card-coverage-aggregate-world.js): as of 2026-09-20, pay period Sep 18 - Oct 1, Dale's
 * payroll 1,000 (confirmed). Added income in the period, by hand:
 *   - Amanda's salary (id amandaSalary, "Tennis BC - invented"): 600 on Sep 25, confirmed;
 *   - Other income (id other-income:invented-rent): 100 on Sep 28, confirmed;
 *   - a named stream (id side-gig): 50 on Sep 29, estimated.
 *   dale 1,000 calculated; amanda 600 calculated; other 100 + 50 = 150, estimated (the side income is an estimate);
 *   total 1,000 + 600 + 150 = 1,750 = incomeTotal.
 *
 * `node test/test-income-split.js`
 */
const assert = require('node:assert/strict');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AMANDA = { id: 'amandaSalary', label: 'Tennis BC - invented', frequency: 'once', date: '2026-09-25', amount: 600, confidence: 'confirmed' };
const OTHER = { id: 'other-income:invented-rent', label: 'Invented rent', frequency: 'once', date: '2026-09-28', amount: 100,
  confidence: 'confirmed', otherIncome: true };
const NAMED = { id: 'side-gig', label: 'Invented side income', frequency: 'once', date: '2026-09-29', amount: 50, confidence: 'estimated' };
function periods(streams) {
  const s = run(world([['card', 80, null, 'purchase']], { edit: x => { x.data.plan.income.push(...streams.map(r => ({ ...r }))); } }));
  return s.advice.payPeriodViews;
}
const active = views => views.find(v => v.role === 'active');
const sumCents = split => ['dale', 'amanda', 'other'].reduce((c, k) => c + Math.round(split[k].amount * 100), 0);
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const split = v => v.stackSummary.income;
const lines = x => ({ dale: x.dale, amanda: x.amanda, other: x.other });

console.log('all three lines');
{
  const v = active(periods([AMANDA, OTHER, NAMED]));
  ok(same(lines(split(v)), { dale: { amount: 1000, trust: 'calculated' }, amanda: { amount: 600, trust: 'calculated' },
    other: { amount: 150, trust: 'estimated' } }), 'Dale 1,000 calculated; Amanda 600 calculated; Other 150 estimated', JSON.stringify(split(v)));
  ok(same(split(v).total, { amount: 1750, trust: 'estimated' }), 'total copies incomeTotal 1,750 and its estimated trust');
  ok(v.incomeTotal === 1750 && sumCents(split(v)) === 175000, 'the lines sum to incomeTotal 1,750 exactly');
  ok(v.incomeTrust === 'estimated', 'the total stays estimated, as one of its lines is');
}

console.log('a named stream counts as Other income (lead ruling F5)');
{
  const v = active(periods([NAMED]));
  ok(split(v).other.amount === 50 && split(v).amanda.amount === 0 && v.incomeTotal === 1050,
    'the named 50 is Other; Amanda 0; total 1,050', JSON.stringify(split(v)));
}

console.log('Dale only');
{
  const v = active(periods([]));
  ok(same(split(v), { dale: { amount: 1000, trust: 'calculated' }, amanda: { amount: 0, trust: 'calculated' },
    other: { amount: 0, trust: 'calculated' }, total: { amount: 1000, trust: 'calculated' } }),
  'Dale 1,000; Amanda and Other 0, calculated (no rows to estimate)');
}

console.log('every period, past and future');
{
  const views = periods([AMANDA, OTHER, NAMED]);
  for (const v of views) {
    if (typeof v.incomeTotal === 'number') {
      ok(sumCents(split(v)) === Math.round(v.incomeTotal * 100), v.role + ' ' + v.start + ': the lines sum to incomeTotal ' + v.incomeTotal);
    } else {
      ok(['dale', 'amanda', 'other', 'total'].every(k => split(v)[k].amount === null && split(v)[k].trust === 'unavailable'),
        v.role + ' ' + v.start + ': incomeTotal withheld, so every line is unavailable');
    }
  }
  const past = views.filter(v => v.role === 'lookback' && v.incomeTrust === 'estimated' && v.incomeTotal > 0);
  ok(past.length > 0 && past.every(v => ['dale', 'amanda', 'other'].some(k => split(v)[k].trust === 'estimated')),
    'a past period built on unproven planned income keeps an estimated line, as its total does');
}

console.log('a withheld income total withholds every line');
{
  const v = active(periods([{ ...AMANDA, amount: null }]));
  ok(v.incomeTotal === null && v.incomeTrust === 'unavailable', 'an unknown receipt amount withholds incomeTotal');
  ok(['dale', 'amanda', 'other', 'total'].every(k => split(v)[k].amount === null && split(v)[k].trust === 'unavailable'
    && typeof split(v)[k].reason === 'string'), 'and every line is null, unavailable, with a reason: never zero, never Dale\'s alone');
}

console.log('a period withheld after the waterfall (whole-plan hold) is never left stale');
{
  // Live.withoutCompleteRefresh sets the whole-plan hold; later passes null the active period's figures in place.
  const x = world([['card', 80, null, 'purchase']], { edit: w => { w.data.plan.income.push({ ...AMANDA }); } });
  const d = Live.withoutCompleteRefresh(run(x).observed.data);
  const views = F.recommend(d.plan, x.asOf, F.budgetRecommendInputs(d, {})).payPeriodViews;
  const now = views.find(v => v.role === 'active');
  ok(now.operatingPlanUnavailable === true && now.incomeTotal === null, 'the hold withholds the active period\'s income');
  ok(['dale', 'amanda', 'other', 'total'].every(k => split(now)[k].amount === null && split(now)[k].trust === 'unavailable'),
    'and the split follows it: nothing computed before the hold survives', JSON.stringify(split(now)));
  const later = views.find(v => v.role === 'future' && typeof v.incomeTotal === 'number');
  ok(later && later.incomeTrust === 'estimated'
    && ['dale', 'amanda', 'other', 'total'].every(k => split(later)[k].trust === 'estimated'),
  'a future period estimated as a whole (OD-022) keeps every line estimated, never more certain than its total',
  later && JSON.stringify(split(later)));
}

console.log(`\nAll income split checks passed (${checks}).`);
