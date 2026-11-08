'use strict';
/* Chronological Payday carryover trend (L-002 / L-006).
 *
 * Independent of the trend assembler as the specification:
 * Seaspan is +14 calendar days from the 2026-08-14 ACCOUNT_FACTS anchor.
 * Each plotted amount must equal the incumbent pastPeriodViews carryover
 * for that completed period. Unknown stays unknown; genuine $0 stays $0;
 * a known negative stays negative and prints as a deficit, not leftover.
 * Synthetic leftover / salary / bills, not live household cents.
 *
 * `node test/test-payday-carryover-trend.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function seaspanOnOrBefore(day) {
  let t = ANCHOR;
  while (t > day) t = addCalendarDays(t, -14);
  while (addCalendarDays(t, 14) <= day) t = addCalendarDays(t, 14);
  return t;
}
function independentCycle(asOf) {
  const start = seaspanOnOrBefore(asOf);
  const next = addCalendarDays(start, 14);
  return { start, end: addCalendarDays(next, -1), nextPayday: next };
}
function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}
function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function paydayCarryoverHtml\([\s\S]*?\n\}$/m, 'paydayCarryoverHtml'),
    grab(planSrc, /^function paydayCarryoverTrendHtml\([\s\S]*?\n\}$/m, 'paydayCarryoverTrendHtml'),
    grab(planSrc, /^function historicalPeriodHtml\([\s\S]*?\n\}$/m, 'historicalPeriodHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
    grab(planSrc, /^function periodBillsHtml\([\s\S]*?\n\}$/m, 'periodBillsHtml'),
    grab(planSrc, /^function householdBudgetHtml\([\s\S]*?\n\}$/m, 'householdBudgetHtml'),
    grab(planSrc, /^function budgetDigestHtml\([\s\S]*?\n\}$/m, 'budgetDigestHtml'),
    grab(planSrc, /^function firstCardHtml\([\s\S]*?\n\}$/m, 'firstCardHtml'),
    grab(planSrc, /^function otherCardsHtml\([\s\S]*?\n\}$/m, 'otherCardsHtml'),
    grab(planSrc, /^function bigPurchasesHtml\([\s\S]*?\n\}$/m, 'bigPurchasesHtml'),
    grab(planSrc, /^function paydayAllocationSummaryHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSummaryHtml'),
    grab(planSrc, /^function selectedPlanView\([\s\S]*?\n\}$/m, 'selectedPlanView'),
    grab(planSrc, /^function budgetPayPeriodContentHtml\([\s\S]*?\n\}$/m, 'budgetPayPeriodContentHtml'),
    grab(planSrc, /^function currentPaydayShellHtml\([\s\S]*?\n\}$/m, 'currentPaydayShellHtml'),
    grab(planSrc, /^function operatingSurfaceHtml\([\s\S]*?\n\}$/m, 'operatingSurfaceHtml'),
    // AMANDA SLICE 14 — the same-input schedule chain read by operatingSurfaceHtml.
    grab(planSrc, /^function budgetMonthPlanSpendSchedule\([\s\S]*?\n\}$/m, 'budgetMonthPlanSpendSchedule'),
    grab(planSrc, /^function budgetMonthKnobOpts\([\s\S]*?\n\}/m, 'budgetMonthKnobOpts'),
    grab(planSrc, /^function budgetTrajectoryCacheKeyFor\([\s\S]*?\n\}/m, 'budgetTrajectoryCacheKeyFor'),
    grab(planSrc, /^function simOpts\([\s\S]*?\n\}/m, 'simOpts'),
    grab(planSrc, /^function isValidIsoCalendarDate\([\s\S]*?\n\}/m, 'isValidIsoCalendarDate'),
    // AMANDA SLICE 9 — the drilldown predicate called by operatingSurfaceHtml.
    grab(planSrc, /^function budgetInPayPeriodDrilldown\([\s\S]*?\n\}$/m, 'budgetInPayPeriodDrilldown'),
    // AMANDA SLICE 3 — the Month view functions called by operatingSurfaceHtml.
    grab(planSrc, /^const BUDGET_MONTH_NAMES = [\s\S]*?\];/m, 'BUDGET_MONTH_NAMES'),
    grab(planSrc, /^function budgetMonthName\([\s\S]*?\n\}/m, 'budgetMonthName'),
    grab(planSrc, /^function budgetTrajectoryFor\([\s\S]*?\n\}/m, 'budgetTrajectoryFor'),
    grab(planSrc, /^function budgetGranularityToggleHtml\([\s\S]*?\n\}/m, 'budgetGranularityToggleHtml'),
    grab(planSrc, /^function budgetMonthTrustTag\([\s\S]*?\n\}/m, 'budgetMonthTrustTag'),
    grab(planSrc, /^function budgetMonthComponentRow\([\s\S]*?\n\}/m, 'budgetMonthComponentRow'),
    grab(planSrc, /^function budgetMonthVerdictHtml\([\s\S]*?\n\}/m, 'budgetMonthVerdictHtml'),
    grab(planSrc, /^function budgetMonthViewHtml\([\s\S]*?\n\}/m, 'budgetMonthViewHtml'),
    'let budgetGranularity = \'pay-period\'; let budgetSelectedMonth = null; let budgetTrajectoryCache = null; let budgetTrajectoryCacheKey = null; let budgetPayPeriodAnchorMonth = null; let budgetDrilldownPayPeriod = null; let budgetMonthScheduleCache = null; let budgetMonthScheduleCacheKey = null;',
    grab(planSrc, /^function paydayInstructionShellHtml\([\s\S]*?\n\}$/m, 'paydayInstructionShellHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ operatingSurfaceHtml, selectedPlanView, paydayCarryoverTrendHtml, money2 });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

const ANCHOR = '2026-08-14';
const AS_OF = '2026-09-09';
const PAYDAY_AS_OF = '2026-09-11';
const CARRY = 1000;
const ZERO_CARRY = 0;
const MORNING_CASH = 1800;
const DALE = 4000;
const AMANDA = 2000;

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 2000, rate: 21.99, payment: 250, pending: 0 },
];

function trendPlan(asOf, snapshot, cash) {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: cash, class: 'spendable',
      }],
    },
    opening: snapshot
      ? { asOf, paydaySnapshot: snapshot }
      : { asOf },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: ANCHOR, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — 15th', frequency: 'monthly',
        day: 15, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: { categories: [] },
  };
}

function snapshotAt(payday, opening) {
  return { periodStart: payday, asOf: payday, opening };
}

function recommendAt(plan, asOf, snapshot) {
  return F.recommend(plan, asOf, {
    targetBuffer: 500,
    debts,
    paydaySnapshot: snapshot || (plan.opening && plan.opening.paydaySnapshot),
  });
}

function pastByStart(advice, start) {
  return ((advice && advice.pastPeriodViews) || []).find(p => p && p.start === start) || null;
}

function trendByPayday(advice, payday) {
  return ((advice && advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points) || [])
    .find(p => p && p.payday === payday) || null;
}

function rowHtml(html, payday) {
  const re = new RegExp(
    `<li class="carryover-row"[^>]*data-carryover-payday="${payday}"[\\s\\S]*?</li>`
  );
  const m = re.exec(html);
  return m ? m[0] : '';
}

function paydayOrder(html) {
  const found = [];
  const re = /data-carryover-payday="(\d{4}-\d{2}-\d{2})"/g;
  let m;
  while ((m = re.exec(html))) found.push(m[1]);
  return found;
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const forecastSrc = read('public/forecast.js');

console.log('=== 1. trend copies incumbent carryover in independent chronological order ===');
{
  const current = independentCycle(AS_OF);
  const previous = independentCycle(addCalendarDays(current.start, -1));
  const earlier = independentCycle(addCalendarDays(previous.start, -1));
  ok(current.start === '2026-08-28' && previous.start === '2026-08-14'
      && earlier.start === '2026-07-31',
    'independent Seaspan grid is Jul 31 / Aug 14 / Aug 28');
  const snap = snapshotAt(current.start, CARRY);
  const plan = trendPlan(AS_OF, snap, 2300);
  const frozen = JSON.stringify(plan);
  const advice = recommendAt(plan, AS_OF, snap);
  ok(frozen === JSON.stringify(plan), 'recommend does not mutate the plan');
  const points = (advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points) || [];
  ok(points.length >= 2, 'Forecast publishes at least two completed-period trend points',
    'count=' + points.length);
  const dates = points.map(p => p.payday);
  const sorted = dates.slice().sort();
  ok(JSON.stringify(dates) === JSON.stringify(sorted),
    'trend points are oldest-to-newest by payday', dates.join(' → '));
  const prevPoint = trendByPayday(advice, previous.nextPayday);
  const earlyPoint = trendByPayday(advice, earlier.nextPayday);
  const prevPast = pastByStart(advice, previous.start);
  const earlyPast = pastByStart(advice, earlier.start);
  ok(prevPoint && prevPast, 'previous completed period is on both the trend and pastPeriodViews');
  ok(earlyPoint && earlyPast, 'earlier completed period is on both the trend and pastPeriodViews');
  ok(prevPoint.known === true && near(prevPoint.amount, CARRY),
    'Aug 28 trend amount is the recorded snapshot leftover',
    String(prevPoint && prevPoint.amount));
  ok(near(prevPoint.amount, prevPast.paydayCarryover),
    'Aug 28 trend amount equals incumbent pastPeriodViews carryover, not a second calculation');
  ok(earlyPoint.known !== true && earlyPoint.amount == null,
    'Jul 31–Aug 13 unknown carryover stays null on the trend');
  ok(earlyPast.paydayCarryoverKnown !== true && earlyPast.paydayCarryover == null,
    'incumbent pastPeriodViews also omits that unknown carryover');
  ok(earlyPoint.amount !== 0,
    'unknown is not stored as numeric 0');
  const idxEarly = dates.indexOf(earlier.nextPayday);
  const idxPrev = dates.indexOf(previous.nextPayday);
  ok(idxEarly >= 0 && idxPrev > idxEarly,
    'unknown earlier payday still sorts before the later known payday');
}

console.log('\n=== 2. genuine $0 is distinguishable from unknown ===');
{
  const payday = PAYDAY_AS_OF;
  const current = independentCycle(payday);
  ok(current.start === payday, 'independent grid places Sep 11 as a Seaspan payday');
  const previous = independentCycle(addCalendarDays(payday, -1));
  const earlier = independentCycle(addCalendarDays(previous.start, -1));
  const snap = snapshotAt(previous.start, ZERO_CARRY);
  const plan = trendPlan(payday, snap, MORNING_CASH);
  const advice = recommendAt(plan, payday, snap);
  const morningPoint = trendByPayday(advice, payday);
  const zeroPoint = trendByPayday(advice, previous.start);
  const unknownPoint = trendByPayday(advice, earlier.start);
  const morningPast = pastByStart(advice, previous.start);
  const zeroPast = pastByStart(advice, earlier.start);
  ok(morningPoint && morningPoint.known === true && near(morningPoint.amount, MORNING_CASH),
    'Sep 11 payday-morning leftover is the morning spendable cash',
    String(morningPoint && morningPoint.amount));
  ok(near(morningPoint.amount, morningPast.paydayCarryover),
    'Sep 11 trend amount equals incumbent pastPeriodViews carryover');
  ok(zeroPoint && zeroPoint.known === true && zeroPoint.amount === 0,
    'Aug 28 recorded $0 leftover is known $0, not omitted');
  ok(zeroPast && zeroPast.paydayCarryoverKnown === true && zeroPast.paydayCarryover === 0,
    'incumbent pastPeriodViews also keeps genuine $0');
  ok(unknownPoint && unknownPoint.known !== true && unknownPoint.amount == null,
    'Aug 14 boundary with no payday-boundary cash stays unknown');
  ok(zeroPoint.known === true && unknownPoint.known !== true,
    'known $0 and unknown are different trend states');
  const dates = ((advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points) || [])
    .map(p => p.payday);
  ok(dates.indexOf(earlier.start) < dates.indexOf(previous.start)
      && dates.indexOf(previous.start) < dates.indexOf(payday),
    'unknown, $0, and morning cash appear in independent chronological order',
    dates.join(' → '));
}

console.log('\n=== 3. Plan prints Forecast trend values; page does not compute them ===');
{
  const payday = PAYDAY_AS_OF;
  const previous = independentCycle(addCalendarDays(payday, -1));
  const earlier = independentCycle(addCalendarDays(previous.start, -1));
  const snap = snapshotAt(previous.start, ZERO_CARRY);
  const plan = trendPlan(payday, snap, MORNING_CASH);
  const advice = recommendAt(plan, payday, snap);
  const defaultHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'this-period', planView: advice.defaultView,
  });
  ok(!/More views/.test(defaultHtml) && !/value="payday-carryover"/.test(defaultHtml),
    'the Budget operating surface does not offer More views or Payday carryover');
  ok(!/data-payday-carryover-trend/.test(defaultHtml),
    'current-period UI does not print the carryover trend');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'payday-carryover',
    planView: composer.selectedPlanView(advice, 'payday-carryover'),
  });
  ok(/data-payday-carryover-trend/.test(html),
    'Payday carryover look renders the Forecast trend sheet');
  const order = paydayOrder(html);
  const expected = ((advice.paydayCarryoverTrend && advice.paydayCarryoverTrend.points) || [])
    .map(p => p.payday);
  ok(JSON.stringify(order) === JSON.stringify(expected),
    'printed payday order matches Forecast.paydayCarryoverTrend');
  ok(order.indexOf(earlier.start) < order.indexOf(previous.start)
      && order.indexOf(previous.start) < order.indexOf(payday),
    'printed order follows the independent Seaspan grid');
  const unknownRow = rowHtml(html, earlier.start);
  const zeroRow = rowHtml(html, previous.start);
  const morningRow = rowHtml(html, payday);
  ok(/data-carryover-known="false"/.test(unknownRow) && /Unknown/.test(unknownRow),
    'unknown period prints Unknown');
  ok(!unknownRow.includes(composer.money2(0)) && !unknownRow.includes(composer.money2(ZERO_CARRY)),
    'unknown period does not print $0.00');
  ok(/data-carryover-known="true"/.test(zeroRow) && /data-carryover-zero="true"/.test(zeroRow),
    'genuine $0 is marked known zero');
  ok(zeroRow.includes(composer.money2(0)),
    'genuine $0 prints the dollar amount $0.00');
  ok(morningRow.includes(composer.money2(MORNING_CASH)),
    'payday-morning leftover prints the incumbent dollar amount');
  ok(/Not savings, not income/.test(html),
    'trend copy does not classify carryover as savings or income');
  ok(!/grade|score|discipline|good|bad/i.test(html),
    'trend does not grade or score the household');
  const pick = /function selectedPlanView\([\s\S]*?\n\}/.exec(planSrc);
  ok(pick && /payday-carryover/.test(pick[0]) && !/Forecast\./.test(pick[0]),
    'the picker does not compute a carryover series');
  const surface = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surface && !/\bForecast\.[A-Za-z]+\s*\(/.test(surface[0]),
    'operatingSurfaceHtml still calls no Forecast function');
  const htmlFn = /function paydayCarryoverTrendHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(htmlFn && !/paydayBoundaryCash|establishPaydaySnapshot|recommend\(/.test(htmlFn[0]),
    'the trend printer copies Forecast fields and does not recalculate carryover');
  const assembler = /function planPaydayCarryoverTrend\([\s\S]*?\n  \}/.exec(forecastSrc);
  ok(assembler && !/paydayBoundaryCash|establishPaydaySnapshot/.test(assembler[0]),
    'the trend assembler copies pastPeriodViews carryover and does not re-walk payday cash');
}

console.log('\n=== 4. presenting the trend does not mutate Forecast outputs ===');
{
  const snap = snapshotAt(independentCycle(AS_OF).start, CARRY);
  const plan = trendPlan(AS_OF, snap, 2300);
  const before = JSON.stringify(plan);
  const first = recommendAt(plan, AS_OF, snap);
  const firstPast = JSON.stringify(first.pastPeriodViews);
  const firstTrend = JSON.stringify(first.paydayCarryoverTrend);
  const firstCal = JSON.stringify(first.defaultView && first.defaultView.calendarPeriods);
  const firstWeekly = first.weekly;
  composer.operatingSurfaceHtml({
    advice: first, weekly: first.weekly, recommended: first.weekly,
    planLook: 'payday-carryover',
    planView: composer.selectedPlanView(first, 'payday-carryover'),
  });
  composer.operatingSurfaceHtml({
    advice: first, weekly: first.weekly, recommended: first.weekly,
    planLook: 'this-period', planView: first.defaultView,
  });
  const second = recommendAt(plan, AS_OF, snap);
  ok(before === JSON.stringify(plan),
    'selecting the trend then current view does not mutate the plan');
  ok(firstPast === JSON.stringify(second.pastPeriodViews),
    'a second recommend reprints the same completed-period carryover');
  ok(firstTrend === JSON.stringify(second.paydayCarryoverTrend),
    'a second recommend reprints the same carryover trend');
  ok(firstCal === JSON.stringify(second.defaultView.calendarPeriods),
    'trend presentation does not rewrite current calendar periods');
  ok(firstWeekly === second.weekly,
    'trend presentation does not change the weekly cap');
  ok(firstPast === JSON.stringify(first.pastPeriodViews)
      && firstTrend === JSON.stringify(first.paydayCarryoverTrend),
    'rendering the trend does not mutate the first Forecast result in place');
}

console.log('\n=== 5. known negative carryover is a deficit, not leftover ===');
{
  const DEFICIT = -250;
  const LEFTOVER = 400;
  const current = independentCycle(AS_OF);
  const previous = independentCycle(addCalendarDays(current.start, -1));
  const earlier = independentCycle(addCalendarDays(previous.start, -1));
  ok(previous.nextPayday === '2026-08-28' && earlier.nextPayday === '2026-08-14',
    'independent Seaspan grid still dates the recorded snapshot at Aug 28');
  const snap = snapshotAt(previous.nextPayday, DEFICIT);
  const plan = trendPlan(AS_OF, snap, 2300);
  const advice = recommendAt(plan, AS_OF, snap);
  const deficitPoint = trendByPayday(advice, previous.nextPayday);
  const unknownPoint = trendByPayday(advice, earlier.nextPayday);
  const deficitPast = pastByStart(advice, previous.start);
  ok(deficitPoint && deficitPoint.known === true && near(deficitPoint.amount, DEFICIT),
    'recorded negative snapshot leftover stays negative on the Forecast trend',
    String(deficitPoint && deficitPoint.amount));
  ok(deficitPoint.amount < 0 && deficitPoint.amount !== Math.abs(DEFICIT),
    'Forecast does not flip a known deficit to leftover');
  ok(near(deficitPoint.amount, deficitPast.paydayCarryover),
    'negative trend amount equals incumbent pastPeriodViews carryover');
  ok(unknownPoint && unknownPoint.known !== true && unknownPoint.amount == null,
    'unknown earlier payday stays unknown beside the deficit');

  const forecastHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'payday-carryover',
    planView: composer.selectedPlanView(advice, 'payday-carryover'),
  });
  const forecastDeficitRow = rowHtml(forecastHtml, previous.nextPayday);
  ok(/data-carryover-sign="negative"/.test(forecastDeficitRow),
    'Forecast-published deficit row is marked negative');
  ok(/carryover-bar-negative/.test(forecastDeficitRow)
      && !/carryover-bar-positive/.test(forecastDeficitRow),
    'Forecast-published deficit uses the deficit bar, not the leftover-direction bar');
  ok(forecastDeficitRow.includes(composer.money2(DEFICIT)),
    'Forecast-published deficit prints the signed dollar amount');

  const unknownPayday = ANCHOR;
  const zeroPayday = addCalendarDays(ANCHOR, 14);
  const deficitPayday = addCalendarDays(ANCHOR, 28);
  const leftoverPayday = addCalendarDays(ANCHOR, 42);
  ok(unknownPayday === '2026-08-14' && zeroPayday === '2026-08-28'
      && deficitPayday === '2026-09-11' && leftoverPayday === '2026-09-25',
    'independent +14 grid supplies unknown / $0 / deficit / leftover paydays');
  const fourWay = {
    points: [
      { payday: unknownPayday, known: false, amount: null },
      { payday: zeroPayday, known: true, amount: 0 },
      { payday: deficitPayday, known: true, amount: DEFICIT },
      { payday: leftoverPayday, known: true, amount: LEFTOVER },
    ],
  };
  const html = composer.paydayCarryoverTrendHtml(fourWay);
  const unknownRow = rowHtml(html, unknownPayday);
  const zeroRow = rowHtml(html, zeroPayday);
  const deficitRow = rowHtml(html, deficitPayday);
  const leftoverRow = rowHtml(html, leftoverPayday);
  ok(/data-carryover-known="false"/.test(unknownRow) && /Unknown/.test(unknownRow),
    'four-way unknown period still prints Unknown');
  ok(!unknownRow.includes(composer.money2(0)) && !/carryover-bar/.test(unknownRow),
    'unknown period has no dollar bar and does not print $0.00');
  ok(/data-carryover-sign="zero"/.test(zeroRow) && /data-carryover-zero="true"/.test(zeroRow),
    'genuine $0 is marked known zero');
  ok(zeroRow.includes(composer.money2(0)) && !/carryover-bar-/.test(zeroRow),
    'genuine $0 prints $0.00 and has no leftover or deficit bar');
  ok(/data-carryover-sign="negative"/.test(deficitRow)
      && /carryover-bar-negative/.test(deficitRow)
      && !/carryover-bar-positive/.test(deficitRow),
    'known deficit is a negative-direction bar');
  ok(deficitRow.includes(composer.money2(DEFICIT)),
    'deficit row prints the signed amount');
  ok(/data-payday-carryover-amount>−\$/.test(deficitRow)
      && !/data-payday-carryover-amount>\$250/.test(deficitRow),
    'deficit amount is signed; it is not printed as leftover dollars');
  ok(/data-carryover-sign="positive"/.test(leftoverRow)
      && /carryover-bar-positive/.test(leftoverRow)
      && !/carryover-bar-negative/.test(leftoverRow),
    'known leftover is a positive-direction bar');
  ok(leftoverRow.includes(composer.money2(LEFTOVER)),
    'leftover row prints the independent leftover dollars');
  const maxAbs = Math.max(Math.abs(DEFICIT), Math.abs(LEFTOVER), Math.abs(0));
  const expectedDeficitWidth = ((Math.abs(DEFICIT) / maxAbs) * 50).toFixed(1);
  const expectedLeftoverWidth = ((Math.abs(LEFTOVER) / maxAbs) * 50).toFixed(1);
  ok(deficitRow.includes(`width:${expectedDeficitWidth}%`),
    'deficit bar length is half-track scale from independent max-abs',
    expectedDeficitWidth + '%');
  ok(leftoverRow.includes(`width:${expectedLeftoverWidth}%`),
    'leftover bar length is half-track scale from independent max-abs',
    expectedLeftoverWidth + '%');
  ok(Number(expectedDeficitWidth) < Number(expectedLeftoverWidth),
    'a smaller deficit does not out-scale a larger leftover in the leftover direction');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
