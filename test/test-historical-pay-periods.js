'use strict';
/* Completed historical pay-period navigation (L-002 / L-006).
 *
 * Independent of spendingCycle / pastPeriodViews as the specification:
 * Seaspan is +14 calendar days from the 2026-08-14 ACCOUNT_FACTS anchor.
 * Carryover, salary, bills, and other-income are synthetic fixtures, not
 * live household cents.
 *
 * `node test/test-historical-pay-periods.js`
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
    grab(planSrc, /^function badTimelineHtml\([\s\S]*?\n\}$/m, 'badTimelineHtml'),
    grab(planSrc, /^function paydayCarryoverHtml\([\s\S]*?\n\}$/m, 'paydayCarryoverHtml'),
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
    ...['payPeriodSelection', 'payPeriodRangeLabel', 'payPeriodStatusLabel',
      'payPeriodNavigatorHtml', 'payPeriodCloseMonth', 'payPeriodMonths',
      'payPeriodTimelineHtml', 'budgetPlanSpendEarmarkHtml'].map(name =>
      grab(planSrc, new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm'), name)),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ operatingSurfaceHtml, selectedPlanView, historicalPeriodHtml, badTimelineHtml, money2 });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

const ANCHOR = '2026-08-14';
const AS_OF = '2026-09-09';
const CARRY = 1000;
const DALE = 4000;
const AMANDA = 2000;
const PAST_GIFT = 50;
const LIVE_GIFT = 75;
const BILL_PREV = 80;
const BILL_EARLIER = 90;
const BILL_RECUR_PREV = 120;
const GROCERY_PREV = 40;
const GROCERY_LIVE = 55;
const GROCERY_WEEKLY = 100;
const LIVE_CASH = 2300;

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 2000, rate: 21.99, payment: 250, pending: 0 },
];

function historyPlan() {
  const current = independentCycle(AS_OF);
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: LIVE_CASH, class: 'spendable',
      }],
    },
    opening: {
      asOf: AS_OF,
      paydaySnapshot: {
        periodStart: current.start,
        asOf: current.start,
        opening: CARRY,
      },
      representedEvents: [
        { id: 'bill-prev', date: '2026-08-21' },
        { id: 'bill-earlier', date: '2026-08-07' },
      ],
    },
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
    bills: [
      {
        id: 'bill-prev', label: 'Synthetic previous bill', amount: BILL_PREV,
        frequency: 'once', date: '2026-08-21', confidence: 'confirmed',
      },
      {
        id: 'bill-earlier', label: 'Synthetic earlier bill', amount: BILL_EARLIER,
        frequency: 'once', date: '2026-08-07', confidence: 'confirmed',
      },
      {
        id: 'bill-recur-prev', label: 'Synthetic recurring previous',
        amount: BILL_RECUR_PREV, frequency: 'monthly', day: 21,
        confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedWeekly: GROCERY_WEEKLY, ownerLine: 'Groceries',
          from: ['Groceries'],
        },
      ],
    },
  };
}

function actualsPacket() {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: '2026-07-31',
    coverageThrough: AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [
      {
        id: 'tx-past-gift',
        date: '2026-08-20',
        amount: -PAST_GIFT,
        isIncome: true,
        categoryLabel: 'gifts',
        displayedPayee: 'Past gift',
        accountRole: 'household-cash',
      },
      {
        id: 'tx-live-gift',
        date: '2026-09-04',
        amount: -LIVE_GIFT,
        isIncome: true,
        categoryLabel: 'gifts',
        displayedPayee: 'Live gift',
        accountRole: 'household-cash',
      },
      {
        id: 'tx-grocery-prev',
        date: '2026-08-20',
        amount: GROCERY_PREV,
        pending: false,
        categoryLabel: 'Groceries',
        accountRole: 'household-cash',
        displayedPayee: 'Save-On-Foods',
        originalMerchant: 'Save-On-Foods',
      },
      {
        id: 'tx-grocery-live',
        date: '2026-09-04',
        amount: GROCERY_LIVE,
        pending: false,
        categoryLabel: 'Groceries',
        accountRole: 'household-cash',
        displayedPayee: 'Save-On-Foods',
        originalMerchant: 'Save-On-Foods',
      },
    ],
    representedActuals: [],
  };
}

function recommend(plan) {
  return F.recommend(plan, AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: actualsPacket(),
    paydaySnapshot: plan.opening.paydaySnapshot,
  });
}

function incomeIds(period) {
  return ((period && period.income) || []).map(r => r && r.id).filter(Boolean);
}
function billIds(period) {
  return ((period && period.bills) || []).map(r => r && r.id).filter(Boolean);
}
function incomeRow(period, id) {
  return ((period && period.income) || []).find(r => r && r.id === id) || null;
}
function billRow(period, id) {
  return ((period && period.bills) || []).find(r => r && r.id === id) || null;
}
function budgetRow(period, id) {
  return ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;
}

const composer = loadComposer();
const planSrc = read('public/plan.js');

console.log('=== 1. two completed periods use the independent Seaspan grid ===');
{
  const current = independentCycle(AS_OF);
  const previous = independentCycle(addCalendarDays(current.start, -1));
  const earlier = independentCycle(addCalendarDays(previous.start, -1));
  ok(current.start === '2026-08-28' && current.end === '2026-09-10',
    'independent current window is Aug 28–Sep 10');
  ok(previous.start === '2026-08-14' && previous.end === '2026-08-27',
    'independent previous window is Aug 14–Aug 27');
  ok(earlier.start === '2026-07-31' && earlier.end === '2026-08-13',
    'independent earlier window is Jul 31–Aug 13');
  const plan = historyPlan();
  const frozen = JSON.stringify(plan);
  const advice = recommend(plan);
  ok(frozen === JSON.stringify(plan),
    'recommend does not mutate the plan');
  const past = advice.pastPeriodViews || [];
  ok(past.length >= 2, 'Forecast publishes at least two completed periods',
    'count=' + past.length);
  const prev = past[0];
  const early = past[1];
  ok(prev && prev.start === previous.start && prev.end === previous.end,
    'previous completed period dates follow the independent Seaspan grid');
  ok(early && early.start === earlier.start && early.end === earlier.end,
    'earlier completed period dates follow the independent Seaspan grid');
  ok(prev.start !== early.start && prev.end !== early.end,
    'the two completed periods are distinct date windows');
  ok(prev.start !== current.start && early.start !== current.start,
    'completed periods are not the current operating window');
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  ok(active && active.start === current.start && active.end === current.end,
    'default this-pay-period is unchanged current Seaspan window');
}

console.log('\n=== 2. each completed period has its own income and bills ===');
{
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const prevIncome = incomeIds(prev);
  const earlyIncome = incomeIds(early);
  const liveIncome = incomeIds(active);
  ok(prevIncome.includes('payroll') && (prev.income || []).some(r => r.date === '2026-08-14'),
    'previous period includes the Aug 14 Seaspan payday');
  ok(earlyIncome.includes('payroll') && (early.income || []).some(r => r.date === '2026-07-31'),
    'earlier period includes the Jul 31 Seaspan payday');
  ok(!(prev.income || []).some(r => r.date === '2026-07-31'),
    'previous period does not reprint the Jul 31 payday');
  ok(!(early.income || []).some(r => r.date === '2026-08-14'),
    'earlier period does not reprint the Aug 14 payday');
  ok(prevIncome.includes('amandaSalary15')
    && (prev.income || []).some(r => r.date === '2026-08-15'),
    'previous period includes Amanda 15 Aug');
  ok(!(early.income || []).some(r => r.date === '2026-08-15'),
    'earlier period does not include Amanda 15 Aug');
  ok(billIds(prev).includes('bill-prev') && !billIds(prev).includes('bill-earlier'),
    'previous period bills stay inside Aug 14–27');
  ok(billIds(early).includes('bill-earlier') && !billIds(early).includes('bill-prev'),
    'earlier period bills stay inside Jul 31–Aug 13');
  ok(!billIds(active).includes('bill-prev') && !billIds(active).includes('bill-earlier'),
    'current period does not inherit completed-period bills');
  const prevTotal = roundCent(DALE + AMANDA + PAST_GIFT);
  const earlyTotal = roundCent(DALE);
  ok(near(prev.incomeTotal, prevTotal),
    'previous income is Aug 14 payroll + Amanda 15th + past gift',
    `${prev.incomeTotal} vs ${prevTotal}`);
  ok(near(early.incomeTotal, earlyTotal),
    'earlier income is Jul 31 payroll only',
    `${early.incomeTotal} vs ${earlyTotal}`);
  ok(prev.incomeTotal !== early.incomeTotal,
    'the two completed periods do not share one income total');
  ok(prev.incomeTotal !== active.incomeTotal,
    'previous period income is not today\'s income relabeled');
}

console.log('\n=== 3. historical actuals stay inside their payday window ===');
{
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const prevPayees = (prev.income || []).map(r => r.label);
  const earlyPayees = (early.income || []).map(r => r.label);
  const livePayees = (active.income || []).map(r => r.label);
  ok(prevPayees.some(l => /Past gift/.test(l)),
    'Aug 20 gift lands in the Aug 14–27 period');
  ok(!prevPayees.some(l => /Live gift/.test(l)),
    'Sep 4 gift does not leak into the completed August period');
  ok(!earlyPayees.some(l => /Past gift/.test(l) || /Live gift/.test(l)),
    'neither gift lands in Jul 31–Aug 13');
  ok(livePayees.some(l => /Live gift/.test(l)),
    'Sep 4 gift stays on the current period');
  ok(!livePayees.some(l => /Past gift/.test(l)),
    'Aug 20 gift does not reprint as current-period income');
}

console.log('\n=== 4. payday carryover is known cash carried forward, not income ===');
{
  const current = independentCycle(AS_OF);
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  ok(prev.paydayCarryoverKnown === true && near(prev.paydayCarryover, CARRY),
    'previous period carryover is the recorded Aug 28 payday opening',
    String(prev.paydayCarryover));
  ok(prev.paydayCarryoverAsOf === current.start,
    'carryover is dated at the next payday, not today');
  ok(prev.paydayCarryoverSource === 'snapshot',
    'carryover source is the recorded payday snapshot');
  const incomeLabels = (prev.income || []).map(r => `${r.id} ${r.label} ${r.incomeClass || ''}`);
  ok(!incomeLabels.some(s => /carryover|carried forward|opening/i.test(s)),
    'carryover is not a salary, Other Income, or opening income row');
  ok(!(prev.otherIncome && prev.otherIncome.items || []).some(r =>
    r && near(r.amount, CARRY)),
    'carryover is not classified as Other Income');
  ok(!near(prev.incomeTotal, CARRY),
    'Payday balance is not the leftover cash relabeled as income');
  ok(near(prev.incomeTotal, roundCent(DALE + AMANDA + PAST_GIFT)),
    'Payday balance stays period income without the leftover cash');
  ok(early.paydayCarryoverKnown !== true && early.paydayCarryover == null,
    'earlier period omits carryover when no payday-boundary cash is known');
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  ok(active && near(active.opening, CARRY),
    'current period opening is the same leftover counted once as opening');
}

console.log('\n=== 5. timeline replaces legacy past picker; historical rows stay renderable ===');
{
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  const defaultHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'this-period', planView: advice.defaultView,
  });
  ok(!/Previous pay period/.test(defaultHtml) && !/value="past:/.test(defaultHtml),
    'More views no longer duplicates completed-period navigation');
  ok(/payPeriodTimelineHtml\([\s\S]*?advice/.test(read('public/plan.js')),
    'the household surface routes Forecast payPeriodViews through the timeline');
  ok(!/data-payday-carryover/.test(defaultHtml),
    'current-period UI does not print payday carryover');
  ok(/data-live-current-balance/.test(defaultHtml),
    'current-period UI still prints live Current Balance');
  const prevView = composer.selectedPlanView(advice, 'past:2026-08-14');
  ok(prevView && prevView.start === prev.start && prevView.end === prev.end,
    'picker selects the Forecast previous-period view');
  const prevHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'past:2026-08-14', planView: prevView,
  });
  ok(/data-historical-period/.test(prevHtml),
    'previous period renders as a completed-period sheet');
  ok(/data-payday-carryover/.test(prevHtml) && prevHtml.includes(composer.money2(CARRY)),
    'previous period prints Payday carryover $1,000');
  ok(!/data-live-current-balance/.test(prevHtml),
    'completed-period sheet does not reprint live Current Balance');
  ok(/Past gift/.test(prevHtml) && !/Live gift/.test(prevHtml),
    'previous-period print keeps Aug 20 actuals and omits Sep 4');
  ok(/Synthetic previous bill/.test(prevHtml) && !/Synthetic earlier bill/.test(prevHtml),
    'previous-period print keeps that period\'s bill');
  ok(/data-income-status="planned"/.test(prevHtml)
      && /data-period-income="payroll"/.test(prevHtml),
    'unproven previous-period payroll prints as planned, not received');
  ok(/data-bill-status="planned"/.test(prevHtml)
      && /Synthetic recurring previous/.test(prevHtml),
    'unproven previous-period recurring bill prints as planned, not PAID');
  ok(/data-payday-household-budget/.test(prevHtml)
      && prevHtml.includes(composer.money2(GROCERY_PREV)),
    'previous-period print shows classified grocery actuals');
  ok(!prevHtml.includes(composer.money2(GROCERY_LIVE)),
    'previous-period household budget omits current-period grocery spend');
  const earlyView = composer.selectedPlanView(advice, 'past:2026-07-31');
  ok(earlyView && earlyView.start === early.start && earlyView.end === early.end,
    'picker selects the Forecast earlier-period view');
  const earlyHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'past:2026-07-31', planView: earlyView,
  });
  ok(/data-historical-period/.test(earlyHtml),
    'earlier period renders as a completed-period sheet');
  ok(!/data-payday-carryover/.test(earlyHtml),
    'earlier period does not invent a carryover figure');
  ok(/Jul 31/.test(earlyHtml) && !/Past gift/.test(earlyHtml),
    'earlier-period print uses its own dates and not the later gift');
  ok(/Synthetic earlier bill/.test(earlyHtml) && !/Synthetic previous bill/.test(earlyHtml),
    'earlier-period print keeps that period\'s bill');
  const pick = /function selectedPlanView\([\s\S]*?\n\}/.exec(planSrc);
  ok(pick && /advice\.pastPeriodViews/.test(pick[0]) && !/Forecast\./.test(pick[0]),
    'the picker selects a Forecast-published past view; it does not compute one');
  const surface = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surface && !/\bForecast\.[A-Za-z]+\s*\(/.test(surface[0]),
    'operatingSurfaceHtml still calls no Forecast function');
}

console.log('\n=== 6. payday-morning carryover and unknown history stay honest ===');
{
  const payday = '2026-09-11';
  const current = independentCycle(payday);
  ok(current.start === payday,
    'independent grid places Sep 11 as a Seaspan payday');
  const previous = independentCycle(addCalendarDays(payday, -1));
  const plan = historyPlan();
  plan.opening = { asOf: payday };
  plan.startingCash.breakdown[0].value = 1800;
  const advice = F.recommend(plan, payday, { targetBuffer: 500, debts });
  const prev = (advice.pastPeriodViews || []).find(p => p && p.start === previous.start);
  ok(prev && prev.paydayCarryoverKnown === true && near(prev.paydayCarryover, 1800),
    'on payday morning, previous-period carryover is that morning\'s spendable cash');
  ok(prev.paydayCarryoverSource === 'payday-morning',
    'payday-morning carryover is not labelled snapshot or income');
  const noSnap = historyPlan();
  delete noSnap.opening.paydaySnapshot;
  noSnap.opening.asOf = AS_OF;
  const unknown = F.recommend(noSnap, AS_OF, { targetBuffer: 500, debts });
  const unknownPrev = (unknown.pastPeriodViews || [])[0];
  ok(unknownPrev && unknownPrev.paydayCarryoverKnown !== true
      && unknownPrev.paydayCarryover == null,
    'mid-period without a snapshot omits carryover rather than inventing it');
}

console.log('\n=== 7. switching views does not mutate canonical state ===');
{
  const plan = historyPlan();
  const before = JSON.stringify(plan);
  const first = recommend(plan);
  const second = recommend(plan);
  composer.operatingSurfaceHtml({
    advice: first, weekly: first.weekly, recommended: first.weekly,
    planLook: 'past:2026-08-14',
    planView: composer.selectedPlanView(first, 'past:2026-08-14'),
  });
  composer.operatingSurfaceHtml({
    advice: first, weekly: first.weekly, recommended: first.weekly,
    planLook: 'this-period', planView: first.defaultView,
  });
  ok(before === JSON.stringify(plan),
    'selecting historical then current views does not mutate the plan');
  ok(JSON.stringify(first.pastPeriodViews) === JSON.stringify(second.pastPeriodViews),
    'a second recommend reprints the same completed periods');
  ok(JSON.stringify(first.defaultView.calendarPeriods)
      === JSON.stringify(second.defaultView.calendarPeriods),
    'historical navigation does not rewrite current calendar periods');
}

console.log('\n=== 8. unproven historical schedule is planned, not received/PAID ===');
{
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const prevPayroll = incomeRow(prev, 'payroll');
  const earlyPayroll = incomeRow(early, 'payroll');
  const livePayroll = incomeRow(active, 'payroll');
  const prevGift = (prev.income || []).find(r => r && /Past gift/.test(r.label));
  const recur = billRow(prev, 'bill-recur-prev');
  ok(prevPayroll && prevPayroll.status === 'planned' && prevPayroll.actual == null,
    'Aug 14 Seaspan planned amount is planned, not a received fact');
  ok(near(prevPayroll.amount, DALE) && prevPayroll.planned === DALE,
    'unproven payroll still lists the planned amount, labelled planned');
  ok(earlyPayroll && earlyPayroll.status === 'planned',
    'Jul 31 Seaspan planned amount is also planned, not received');
  ok(prevGift && prevGift.status === 'received' && near(prevGift.actual, PAST_GIFT),
    'transaction-backed Other Income stays received at the observed amount');
  ok(recur && recur.status === 'planned' && recur.actual == null,
    'unproven recurring bill is planned, not PAID from today\'s cadence');
  ok(near(recur.planned, BILL_RECUR_PREV),
    'unproven recurring bill keeps the planned amount as planned');
  ok(livePayroll && livePayroll.status !== 'planned',
    'current-period payroll is not sealed as historical planned');
  ok(!(active.bills || []).some(r => r && r.id === 'bill-recur-prev'),
    'current period does not inherit the completed-period recurring bill');
}

console.log('\n=== 9. completed sheet publishes household-budget actuals for the window ===');
{
  const plan = historyPlan();
  const advice = recommend(plan);
  const prev = (advice.pastPeriodViews || [])[0];
  const early = (advice.pastPeriodViews || [])[1];
  const active = ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === 'this-pay-period');
  const prevGroceries = budgetRow(prev, 'groceries');
  const earlyGroceries = budgetRow(early, 'groceries');
  const liveGroceries = budgetRow(active, 'groceries');
  ok(prevGroceries && near(prevGroceries.spent, GROCERY_PREV),
    'previous period Groceries spent is the Aug 20 actual',
    String(prevGroceries && prevGroceries.spent));
  ok(prevGroceries.remaining == null,
    'completed-period remaining is not a live reserve');
  ok(near(prevGroceries.hold, GROCERY_PREV)
      && near(prev.budgetHold, GROCERY_PREV),
    'completed-period household-budget total is observed spent, not the planned hold');
  ok(!(prevGroceries.recon || []).some(tx => tx && tx.id === 'tx-grocery-live'),
    'Sep 4 grocery does not leak into the completed August budget');
  ok(earlyGroceries && earlyGroceries.spent === 0,
    'earlier period with no grocery actuals does not invent spent');
  ok(liveGroceries && near(liveGroceries.spent, GROCERY_LIVE),
    'current period still classifies the Sep 4 grocery actual');
  const prevHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'past:2026-08-14',
    planView: composer.selectedPlanView(advice, 'past:2026-08-14'),
  });
  ok(/data-operating-question="06"/.test(prevHtml)
      && /data-payday-household-budget/.test(prevHtml),
    'completed sheet renders Forecast householdBudget');
  ok(/data-budget-category="groceries"/.test(prevHtml)
      && prevHtml.includes(composer.money2(GROCERY_PREV)),
    'completed sheet prints the window\'s grocery actual');
  const uncovered = historyPlan();
  const shortPacket = actualsPacket();
  shortPacket.coverageStart = '2026-08-28';
  const withheld = F.recommend(uncovered, AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: shortPacket,
    paydaySnapshot: uncovered.opening.paydaySnapshot,
  });
  const withheldPrev = (withheld.pastPeriodViews || [])[0];
  const withheldGroceries = budgetRow(withheldPrev, 'groceries');
  ok(withheldGroceries && withheldGroceries.spent == null,
    'incomplete historical coverage omits spent rather than inventing it');
  ok(near(withheldPrev.budgetHold, 0),
    'unproven historical spent does not become a completed-period total');
}

console.log('\n=== 10. finalized historical facts close every publication alias ===');
{
  function fixture(payrollActual = 4017.25, billActuals = true) {
    const plan = historyPlan();
    plan.opening.priorAsOf = '2026-08-13';
    plan.opening.representedEvents.push({ id: 'payroll', date: ANCHOR });
    const packet = actualsPacket();
    packet.representedActuals = [
      ...(payrollActual == null ? [] : [{ id: 'payroll', date: ANCHOR, actual: payrollActual }]),
      ...(billActuals ? [
        { id: 'bill-prev', date: '2026-08-21', actual: 93.40, transactionId: 'tx-bill-prev', postedOn: '2026-08-21' },
        { id: 'bill-recur-prev', date: '2026-08-21', actual: 126.60, transactionId: 'tx-bill-recur-prev', postedOn: '2026-08-21' },
      ] : []),
    ];
    // A completed-period bill is PAID only when a posted transaction in the
    // packet backs its settlement entry, as the observer emits it. The rows
    // carry the posted stamps (postedOn, CAD, mapped account) the published
    // row needs to call the amount posted, so the observed actual is deducted
    // (lead design, #1063: only posted evidence changes the deduction).
    if (billActuals) {
      packet.transactions.push(
        { id: 'tx-bill-prev', date: '2026-08-21', amount: 93.40, pending: false, currency: 'cad', atlasAccountId: 'chequing-a',
          accountRole: 'household-cash', displayedPayee: 'Synthetic payee A', representedBill: true },
        { id: 'tx-bill-recur-prev', date: '2026-08-21', amount: 126.60, pending: false, currency: 'cad', atlasAccountId: 'chequing-a',
          accountRole: 'household-cash', displayedPayee: 'Synthetic payee B', representedBill: true });
    }
    return { plan, packet };
  }
  const run = ({ plan, packet }) => F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts, currentPeriodActuals: packet,
    paydaySnapshot: plan.opening.paydaySnapshot,
  });
  const past = advice => advice.pastPeriodViews.find(p => p.start === ANCHOR);
  function closure(p, income, assigned, hold, label) {
    // Independent integer-cent arithmetic on the fixture, not a Forecast helper.
    const afterBills = (Math.round(income * 100) - Math.round(assigned * 100)) / 100;
    const afterBudget = (Math.round(afterBills * 100) - Math.round(hold * 100)) / 100;
    for (const key of ['incomeTotal', 'available']) ok(p[key] === income, label + ' ' + key);
    ok(p.periodBillLoad === assigned && p.budgetHold === hold, label + ' independent deductions');
    for (const key of ['afterBills', 'afterRemainingBills']) ok(p[key] === afterBills, label + ' ' + key);
    for (const key of ['afterHouseholdBudget', 'balanceAfterDeductions', 'predictedEndingBalance',
      'afterDebtRepayment', 'afterBigPurchases', 'projectedEnding']) {
      ok(p[key] === afterBudget, label + ' ' + key);
    }
    for (const key of ['afterBills', 'afterHouseholdBudget', 'afterDebtRepayment', 'afterBigPurchases']) {
      ok(p.leftover[key] === p[key], label + ' leftover.' + key);
    }
    const t = p.predictedEndingBalanceTerms;
    ok(t && t.periodIncome === income && t.assignedBills === assigned
      && t.householdBudgetHold === hold && t.balanceAfterDeductions === afterBudget,
    label + ' identity terms match finalized facts');
    ok(t && t.periodIncome - t.assignedBills - t.householdBudgetHold === afterBudget
      && t.closes === true && t.identity === 'balance-after-deductions'
      && p.predictedEndingBalanceIdentity === t.identity, label + ' independent identity closure');
  }
  const f = fixture();
  const before = JSON.stringify(f);
  const advice = run(f);
  const p = past(advice);
  // Finding 6 (#821 6788704527): both bills were paid above plan (80 -> 93.40,
  // 120 -> 126.60), so the deduction is what left, once: 220, and the three
  // totals agree. (Was: the deduction stayed at the planned 200.)
  closure(p, 6067.25, 220, 40, 'unequal actuals');
  ok(p.totalBillsThisPeriod === 220 && p.paidBills === 220 && p.periodBillLoad === 220,
    'displayed bills, paid disclosure and assigned deduction all equal 93.40 + 126.60');
  ok(p.openingKnown === false && p.opening == null && p.incomeAdded == null,
    'finalized income does not invent historical opening cash');
  ok(p.paydayCarryover === CARRY, 'recorded carryover survives finalization');
  ok(advice.payPeriodViews.find(row => row.id === p.id) === p,
    'default timeline consumes the incumbent finalized historical object');
  const html = composer.operatingSurfaceHtml({ advice, weekly: advice.weekly,
    recommended: advice.weekly, planLook: 'this-period', planPayPeriodId: 'past:2026-08-14',
    planView: advice.defaultView });
  ok(html.includes('data-selected-pay-period="past:2026-08-14"'),
    'default this-period timeline selects completed Aug 14 window');
  for (const amount of [6067.25, 5847.25, 220, 93.40, 126.60]) {
    ok(html.includes(composer.money2(amount)), 'default timeline prints finalized ' + amount);
  }
  ok(!html.includes(composer.money2(5807.25))
    && /data-bad-term="balanceAfterDeductions" data-bad-term-trust="unavailable"/.test(html)
    && /data-budget-result-trust="unavailable"/.test(html)
    && /data-bad-historical-withheld/.test(html),
    'historical arithmetic alone cannot qualify whole-period BAD or the result; original source evidence stays separate');
  ok(/Paid bills this period<\/span><span>\$220\.00/.test(html),
    'paid disclosure on default timeline matches settled rows');
  const qualified = fixture();
  qualified.packet.representedActuals.push({ id: 'amandaSalary15', date: '2026-08-15', actual: 2000 });
  qualified.plan.opening.representedEvents.push({ id: 'amandaSalary15', date: '2026-08-15' });
  const qualifiedAdvice = run(qualified);
  const qualifiedPeriod = past(qualifiedAdvice);
  const components = ['income', 'bills', 'household'].map(key => qualifiedPeriod.budgetProgress[key].actual);
  ok(components.every(part => part.completeness === 'complete'),
    'Forecast qualifies all three historical components independently');
  const qualifiedHtml = composer.operatingSurfaceHtml({ advice: qualifiedAdvice,
    weekly: qualifiedAdvice.weekly, recommended: qualifiedAdvice.weekly, planLook: 'this-period',
    planPayPeriodId: 'past:2026-08-14', planView: qualifiedAdvice.defaultView });
  // 4,017.25 observed payroll + 2,000 observed partner + 50 observed gift
  // minus 220 deducted bills (93.40 + 126.60, both above plan) minus 40
  // observed Household = 5,807.25.
  ok(qualifiedHtml.includes(composer.money2(5807.25))
    && !/data-bad-historical-withheld/.test(qualifiedHtml),
    'qualified historical BAD survives the real Forecast to native renderer path');
  const qualifiedTimeline = composer.badTimelineHtml(qualifiedAdvice, true, null)
    .match(/data-bad-timeline-period="past:2026-08-14"[^>]*>([\s\S]*?)<\/li>/);
  ok(qualifiedTimeline && qualifiedTimeline[1].includes(composer.money2(5807.25)),
    'the river source preserves the same independently reconciled historical figure');
  const second = run(f);
  ok(JSON.stringify(f) === before && JSON.stringify(p) === JSON.stringify(past(second)),
    'repeated publication mutates neither plan nor packet and is deterministic');
  const payrollOnly = run(fixture(4017.25, false));
  closure(past(payrollOnly), 6067.25, 200, 40, 'payroll-only change');
  const billOnly = run(fixture(4000, true));
  closure(past(billOnly), 6050, 220, 40, 'bill-only change');
  ok(past(billOnly).paidBills === 220, 'bill-only change updates paid disclosure');
  const missing = run(fixture(null, false));
  closure(past(missing), 6050, 200, 40, 'missing actuals');
  ok(incomeRow(past(missing), 'payroll').actual == null
    && billRow(past(missing), 'bill-recur-prev').status === 'planned',
    'missing actuals do not invent amounts or settlement');
  const estimated = fixture();
  estimated.plan.income[0].confidence = 'estimated';
  const ep = past(run(estimated));
  closure(ep, 6067.25, 220, 40, 'estimated input');
  ok(ep.incomeTrust === 'estimated' && ep.afterBillsTrust === 'estimated'
    && ep.balanceAfterDeductionsTrust === 'estimated', 'all dependent trust remains estimated');
  const short = fixture();
  short.packet.coverageStart = '2026-08-28';
  const sp = past(run(short));
  ok(budgetRow(sp, 'groceries').spent == null && sp.budgetHold === 0,
    'incomplete coverage still withholds historical spending');
  // Coverage starting after the payments means the published rows cannot call
  // the amounts posted (displayAmountBasis 'unconfirmed-actual'), so the plan
  // of 80 + 120 is deducted (lead design, #1063). Was: 220.
  ok(['bill-prev', 'bill-recur-prev'].every(id => billRow(sp, id).displayAmountBasis === 'unconfirmed-actual'),
    'incomplete coverage: the published rows mark the paid amounts unconfirmed');
  closure(sp, 6067.25, 200, 0, 'incomplete coverage');
  const excluded = fixture();
  excluded.plan.opening.asOf = '2026-08-28';
  delete excluded.plan.opening.priorAsOf;
  excluded.plan.obligations = [{ id: 'opening-minimum', label: 'Synthetic opening minimum',
    debtId: 'triangle', frequency: 'monthly', day: 21, firstDue: '2026-09-21',
    amount: 30, confidence: 'confirmed', payingAccount: 'chequing-a' }];
  const xp = past(run(excluded));
  const stub = billRow(xp, 'opening-minimum');
  ok(stub && stub.settledInOpening === true, 'true opening-settled minimum remains flagged');
  ok(xp.periodBillLoad === 220, 'opening-settled minimum is excluded from assigned deduction (bills deducted at their above-plan actuals)');
  const cadenceOpening = { plan: historyPlan(), packet: actualsPacket() };
  const cp = past(run(cadenceOpening));
  // Bills audit of 57cb421: the unproven recurring 120 before the dated
  // opening was paid from this period's income, so BAD deducts it: 80 + 120.
  closure(cp, 6050, 200, 40, 'incumbent cadence-opening allocation');
  ok(billRow(cp, 'bill-recur-prev').status === 'planned' && cp.paidBills === 80,
    'unproven cadence opening remains planned and is deducted once in the assigned load');
  const unresolved = fixture(null, false);
  unresolved.plan.opening.notReliedUponEvents = [{ id: 'amandaSalary15',
    date: '2026-08-15', reason: 'unconfirmed-transfer' }];
  const up = past(run(unresolved));
  ok(incomeRow(up, 'amandaSalary15').status === 'unresolved'
    && incomeRow(up, 'amandaSalary15').notReliedUpon === true,
    'historical finalization preserves unresolved not-relied-upon status');
  closure(up, 6050, 200, 40, 'unresolved settlement');
  const unknown = fixture();
  unknown.plan.income[0].confidence = 'unknown';
  const unknownPeriod = past(run(unknown));
  ok(unknownPeriod.incomeTrust === 'unavailable' && unknownPeriod.afterBillsTrust === 'unavailable'
    && unknownPeriod.balanceAfterDeductionsTrust === 'unavailable',
    'unknown confidence remains withheld across dependent trust');
  const zero = fixture(0);
  closure(past(run(zero)), 2050, 220, 40, 'observed zero payroll');
  ok(/assigned amounts/.test(html) && /settled amounts/.test(html),
    'default timeline explains the assigned deduction and settlement disclosure bases');
  for (const key of ['calendarPeriods']) {
    ok(JSON.stringify(advice.defaultView[key]) === JSON.stringify(payrollOnly.defaultView[key]),
      'historical bill actuals do not rewrite current/next ' + key);
    ok(JSON.stringify(advice.defaultView[key]) === JSON.stringify(missing.defaultView[key]),
      'historical payroll and bill actuals do not rewrite current/next ' + key);
  }
  ok(JSON.stringify(advice.payPeriodViews.filter(row => row.timelineRole === 'future'))
    === JSON.stringify(payrollOnly.payPeriodViews.filter(row => row.timelineRole === 'future')),
    'historical bill actuals do not rewrite further future periods');
  const controls = fixture();
  controls.plan.bills.push(
    { id: 'current-control', label: 'Synthetic current bill', frequency: 'once',
      date: '2026-09-04', amount: 30, confidence: 'confirmed' },
    { id: 'future-control', label: 'Synthetic future bill', frequency: 'once',
      date: '2026-09-14', amount: 60, confidence: 'confirmed' });
  controls.packet.representedActuals.push(
    { id: 'current-control', date: '2026-09-04', actual: 42 },
    { id: 'future-control', date: '2026-09-14', actual: 72 });
  const controlAdvice = run(controls);
  const current = controlAdvice.defaultView.calendarPeriods.find(row => row.role === 'active');
  const next = controlAdvice.defaultView.calendarPeriods.find(row => row.role === 'future');
  // No posted transaction backs the 42, so the published row calls it an
  // unconfirmed actual and the plan of 30 is deducted (lead design, #1063:
  // only posted evidence changes the deduction). The paid disclosure still
  // prints 42; that disagreement is #907 (pending shown as Paid), NEXT PR.
  ok(billRow(current, 'current-control').status === 'PAID'
    && billRow(current, 'current-control').displayAmountBasis === 'unconfirmed-actual'
    && current.periodBillLoad === 30 && current.paidBills === 42,
    'current unconfirmed above plan (30 -> 42): the deduction keeps the plan of 30; disclosure unchanged (#907)');
  ok(billRow(next, 'future-control').status === 'planned'
    && next.paidBills === 0 && next.remainingBills === next.periodBillLoad,
    'future represented occurrence stays planned and outside paid disclosure');
}

console.log('\n=== 11. #723 gap (5): a sealed lookback withholds an unknown scheduled receipt ===');
{
  // Engine classification 6524178220 / scope 6524772978. Failing-before
  // evidence is test/test-forecast-723-gap5-repro.js (from #801). Synthetic
  // one-off receipt 'extra' dated inside the completed Aug 14 window.
  const REASON = 'A scheduled receipt in this period has an unknown amount (income-unavailable), so period income is not published.';
  function fixture(extraAmount, opts = {}) {
    const plan = historyPlan();
    plan.opening.priorAsOf = '2026-08-13';
    plan.opening.representedEvents.push({ id: 'payroll', date: ANCHOR });
    if (extraAmount !== undefined) {
      const extra = { id: 'extra', label: 'Synthetic receipt', frequency: 'once',
        date: '2026-08-18', confidence: 'confirmed' };
      if (extraAmount !== 'missing') extra.amount = extraAmount;
      plan.income.push(extra);
    }
    const packet = actualsPacket();
    packet.representedActuals = [
      { id: 'payroll', date: ANCHOR, actual: opts.payrollActual ?? 4017.25 },
      { id: 'bill-prev', date: '2026-08-21', actual: 93.40 },
      { id: 'bill-recur-prev', date: '2026-08-21', actual: 126.60 },
    ];
    return { plan, packet, adjust: opts.adjust || null };
  }
  const run = ({ plan, packet, adjust }) => F.recommend(plan, AS_OF, Object.assign({
    targetBuffer: 500, debts, currentPeriodActuals: packet,
    paydaySnapshot: plan.opening.paydaySnapshot,
  }, adjust ? { incomeOccurrenceAdjust: adjust } : {}));
  const pastOf = advice => advice.pastPeriodViews.find(p => p.start === ANCHOR);
  const timelineOf = advice => advice.payPeriodViews.find(p => p.start === ANCHOR);
  const notPast = advice => JSON.stringify(advice.payPeriodViews.filter(p => p.start > ANCHOR));
  const otherHistory = advice => JSON.stringify(advice.pastPeriodViews.filter(p => p.start !== ANCHOR));
  const independent = p => JSON.stringify({
    periodBillLoad: p.periodBillLoad, totalBillsThisPeriod: p.totalBillsThisPeriod,
    paidBills: p.paidBills, budgetHold: p.budgetHold, paydayCarryover: p.paydayCarryover,
    openingKnown: p.openingKnown, opening: p.opening, paydaySweep: p.paydaySweep,
    bills: p.bills, householdBudget: p.householdBudget,
  });
  const controlAdvice = run(fixture());
  const control = pastOf(controlAdvice);
  // 4,017.25 observed payroll + 2,000 planned partner + 50 observed gift.
  ok(control.incomeTotal === 6067.25 && control.incomeTrust !== 'unavailable'
      && !control.incomeUnavailableReason, 'control: completed window publishes its income');

  function expectWithheld(advice, label) {
    for (const [family, p] of [['pastPeriodViews', pastOf(advice)], ['payPeriodViews', timelineOf(advice)]]) {
      ok(!!p, `${label} (${family}): period exists`);
      if (!p) continue;
      // Each dependent key must be PRESENT and null: deleting a field must not pass.
      for (const key of ['incomeTotal', 'available', 'afterBills', 'afterRemainingBills',
        'afterHouseholdBudget', 'balanceAfterDeductions', 'predictedEndingBalance']) {
        ok(Object.prototype.hasOwnProperty.call(p, key) && p[key] === null,
          `${label} (${family}): ${key} present and withheld`, String(p[key]));
      }
      ok(p.incomeTrust === 'unavailable' && p.afterBillsTrust === 'unavailable'
          && p.balanceAfterDeductionsTrust === 'unavailable',
        `${label} (${family}): dependent trust is unavailable`,
        `${p.incomeTrust}/${p.afterBillsTrust}/${p.balanceAfterDeductionsTrust}`);
      ok(p.incomeUnavailableReason === REASON,
        `${label} (${family}): the exact income-unavailable reason`, String(p.incomeUnavailableReason));
      ok(p.predictedEndingBalanceTerms == null || p.predictedEndingBalanceTerms.closes !== true,
        `${label} (${family}): no closing identity on withheld income`);
    }
  }

  for (const amount of ['missing', null, NaN, 'abc']) {
    const label = `unknown ${amount === 'missing' ? 'missing' : String(amount)} receipt`;
    const advice = run(fixture(amount));
    expectWithheld(advice, label);
    const p = pastOf(advice);
    ok(incomeRow(p, 'payroll') && incomeRow(p, 'payroll').amount === 4017.25
        && incomeRow(p, 'payroll').status === incomeRow(control, 'payroll').status
        && incomeRow(p, 'amandaSalary15') && incomeRow(p, 'amandaSalary15').amount === AMANDA,
      `${label}: known rows keep their amounts and planned/received status (mixed known + unknown)`);
    ok(independent(p) === independent(control),
      `${label}: opening, bills, budget, carryover and sweep evidence unchanged`);
    ok(notPast(advice) === notPast(controlAdvice),
      `${label}: current and future periods byte-identical (no lookback propagation)`);
    ok(otherHistory(advice) === otherHistory(controlAdvice),
      `${label}: other retained history unchanged`);
  }

  const zero = pastOf(run(fixture(0)));
  ok(zero.incomeTotal === 6067.25 && zero.incomeTrust === control.incomeTrust
      && !zero.incomeUnavailableReason && zero.balanceAfterDeductions === control.balanceAfterDeductions,
    'genuine planned zero is a known zero: the period publishes exactly as the control');
  const observedZero = pastOf(run(fixture(undefined, { payrollActual: 0 })));
  ok(observedZero.incomeTotal === 2050 && observedZero.incomeTrust !== 'unavailable'
      && !observedZero.incomeUnavailableReason,
    'observed actual zero on a planned row is a qualified basis, not withheld (0 + 2,000 + 50)');
  const positive = pastOf(run(fixture(300)));
  ok(positive.incomeTotal === 6367.25 && !positive.incomeUnavailableReason,
    'known planned positive publishes (6,067.25 + 300)');
  ok(control.incomeTotal === 6067.25 && incomeRow(control, 'payroll').actual === 4017.25,
    'qualified actual substitution: observed payroll replaces its planned amount');

  const extraAdjust = adj => (s) => s && s.id === 'extra' ? adj : null;
  const overridden = pastOf(run(fixture(null, { adjust: extraAdjust({ amount: 300, confidence: 'confirmed' }) })));
  ok(overridden.incomeTotal === 6367.25 && !overridden.incomeUnavailableReason,
    'override with a valid amount disposes of the unknown occurrence');
  const overriddenZero = pastOf(run(fixture(null, { adjust: extraAdjust({ amount: 0 }) })));
  ok(overriddenZero.incomeTotal === 6067.25 && !overriddenZero.incomeUnavailableReason,
    'override with a declared zero disposes of the unknown occurrence');
  const omitted = pastOf(run(fixture(null, { adjust: extraAdjust({ omit: true }) })));
  ok(omitted.incomeTotal === 6067.25 && !omitted.incomeUnavailableReason,
    'omission disposes of the unknown occurrence');
  const disabled = fixture(null);
  const disabledAdvice = F.recommend(disabled.plan, AS_OF, { targetBuffer: 500, debts,
    currentPeriodActuals: disabled.packet, paydaySnapshot: disabled.plan.opening.paydaySnapshot,
    disabled: ['extra'] });
  ok(pastOf(disabledAdvice).incomeTotal === 6067.25 && !pastOf(disabledAdvice).incomeUnavailableReason,
    'exclusion (disabled stream) disposes of the unknown occurrence');
  expectWithheld(run(fixture(300, { adjust: extraAdjust({ amount: -5 }) })),
    'invalid negative override');
  // Atlas BLOCKING B1 (#803 review 5714735912): an invalid adjustment on an
  // Other Income occurrence that independent posted-receipt reconciliation
  // later qualifies must publish from that actual in a sealed lookback,
  // exactly as in the active period and as on base. Without a receipt the
  // marked row stays unresolved and withholds. No priorAsOf here, so the
  // occurrence takes the ordinary expected-row path that reconciliation reads.
  {
    const reconPlan = (refundDate) => ({
      defaults: { targetBuffer: 500 },
      startingCash: { breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2300, class: 'spendable' }] },
      opening: { asOf: AS_OF, paydaySnapshot: { periodStart: '2026-09-11', asOf: '2026-09-11', opening: 1000 },
        representedEvents: [] },
      income: [
        { id: 'payroll', frequency: 'biweekly', anchor: ANCHOR, amount: 2000, confidence: 'confirmed' },
        { id: 'partner', frequency: 'monthly', day: 15, amount: 1500, confidence: 'confirmed' },
        { id: 'refund', label: 'Synthetic refund', frequency: 'once', date: refundDate, amount: 175,
          incomeClass: 'other', confidence: 'estimated' },
      ],
      bills: [], obligations: [], commitments: [], budget: { categories: [] },
    });
    const reconPacket = (refundDate, withReceipt) => ({
      schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
      coverageStart: '2026-07-31', coverageThrough: AS_OF, transactionCoverage: 'complete', pendingCoverage: 'complete',
      representedActuals: [],
      transactions: withReceipt ? [{ id: 'tx-refund', date: refundDate, amount: -175, isIncome: true,
        categoryLabel: 'gifts', displayedPayee: 'Synthetic refund', accountRole: 'household-cash' }] : [],
    });
    const reconRun = (refundDate, adjAmount, withReceipt) => F.recommend(reconPlan(refundDate), AS_OF, {
      targetBuffer: 500, debts, currentPeriodActuals: reconPacket(refundDate, withReceipt),
      incomeOccurrenceAdjust: (s) => s && s.id === 'refund' ? { amount: adjAmount, confidence: 'confirmed' } : null,
    });
    for (const [label, adjAmount] of [["string '250'", '250'], ['boolean true', true]]) {
      // Sealed lookback (Aug 14 window): payroll 2,000 + partner 1,500 + reconciled refund 175.
      const sealedAdvice = reconRun('2026-08-20', adjAmount, true);
      for (const [family, p] of [['pastPeriodViews', pastOf(sealedAdvice)], ['payPeriodViews', timelineOf(sealedAdvice)]]) {
        const refund = incomeRow(p, 'refund');
        ok(p && p.incomeTotal === 3675 && p.incomeTrust !== 'unavailable' && !p.incomeUnavailableReason
            && p.balanceAfterDeductions != null,
          `B1 sealed lookback ${label} + reconciled receipt (${family}): publishes from the actual`,
          p && `${p.incomeTotal}/${p.incomeTrust}`);
        ok(refund && refund.amount === 175 && refund.actual === 175 && refund.status === 'received'
            && refund.reconciledFrom === 'unique-unmatched-same-date',
          `B1 sealed lookback ${label} (${family}): the reconciled row keeps its actual and received status`);
      }
      const unresolved = reconRun('2026-08-20', adjAmount, false);
      expectWithheld(unresolved, `B1 sealed lookback ${label} without a receipt`);
      // Active control (Aug 28 window holds as-of Sep 9): same publication.
      const active = reconRun('2026-09-02', adjAmount, true).payPeriodViews
        .find(p => p.start <= '2026-09-02' && p.end >= '2026-09-02');
      ok(active && active.role === 'active' && active.incomeTrust !== 'unavailable' && !active.incomeUnavailableReason
          && incomeRow(active, 'refund') && incomeRow(active, 'refund').actual === 175,
        `B1 active control ${label} + reconciled receipt: publishes from the actual`,
        active && `${active.role}/${active.incomeTotal}/${active.incomeTrust}`);
    }
    const valid = pastOf(reconRun('2026-08-20', 175, true));
    ok(valid.incomeTotal === 3675 && !valid.incomeUnavailableReason,
      'B1 valid numeric adjustment + reconciled receipt: publishes unchanged');
  }
  // A non-numeric override is not asserted here: with priorAsOf this
  // occurrence takes the not-relied-upon row path, which carries no
  // invalid-adjustment mark in the active period either (separate
  // ATLAS-026 finding, outside gap 5). The sealed-lookback non-numeric
  // case is pinned in test-budget-timeline-pay-periods.js.
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
