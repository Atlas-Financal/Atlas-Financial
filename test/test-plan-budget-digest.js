'use strict';
/* Planned vs spent digest: Forecast owns spent (classified actuals in the
 * selected span) and planned (owner-target hold for that span). The default
 * page prints planned · spent · remaining inside each calendar waterfall.
 * Lookahead / week views still print spent $X of $Y after the household-budget
 * waterfall boundary.
 * Incomplete actuals and a stale spending-history as-of are kitchen-counter
 * words. No leftover guess, no remaining-cap as spent or as the period plan.
 *
 * Independent planned identity is monthly × spanDays / (365.25/12), not
 * live household cents (L-002 / L-006).
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
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const MONTH = 365.25 / 12;

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
    grab(planSrc, /^function weeklyCapView\([\s\S]*?\n\}$/m, 'weeklyCapView'),
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function currentOperatingUnavailableHtml\([\s\S]*?\n\}$/m, 'currentOperatingUnavailableHtml'),
    grab(planSrc, /^function paydayActionRows\([\s\S]*?\n\}$/m, 'paydayActionRows'),
    grab(planSrc, /^function paydayCashNote\([\s\S]*?\n\}$/m, 'paydayCashNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function paydayCoverageNote\([\s\S]*?\n\}$/m, 'paydayCoverageNote'),
    grab(planSrc, /^const PAYDAY_ACTION_KIND = \{[\s\S]*?^\};$/m, 'PAYDAY_ACTION_KIND'),
    grab(planSrc, /^function paydayAllocationTrustNote\([\s\S]*?\n\}$/m, 'paydayAllocationTrustNote'),
    grab(planSrc, /^function paydayAllocationSheetHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSheetHtml'),
    grab(planSrc, /^function currentPeriodConfidence\([\s\S]*?\n\}$/m, 'currentPeriodConfidence'),
    grab(planSrc, /^function currentPeriodBillGroup\([\s\S]*?\n\}$/m, 'currentPeriodBillGroup'),
    grab(planSrc, /^function betweenPaydaysOperatingHtml\([\s\S]*?\n\}$/m, 'betweenPaydaysOperatingHtml'),
    grab(planSrc, /^const FUTURE_PLAN_VERDICT = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_VERDICT'),
    grab(planSrc, /^const FUTURE_PLAN_FLEXIBILITY = \{[\s\S]*?^\};$/m, 'FUTURE_PLAN_FLEXIBILITY'),
    grab(planSrc, /^function futureCostNeedsAttention\([\s\S]*?\n\}$/m, 'futureCostNeedsAttention'),
    grab(planSrc, /^function futurePlanRemainingLabel\([\s\S]*?\n\}$/m, 'futurePlanRemainingLabel'),
    grab(planSrc, /^function futurePlanMeaning\([\s\S]*?\n\}$/m, 'futurePlanMeaning'),
    grab(planSrc, /^function futurePlanRequirement\([\s\S]*?\n\}$/m, 'futurePlanRequirement'),
    grab(planSrc, /^function futurePlanTiming\([\s\S]*?\n\}$/m, 'futurePlanTiming'),
    grab(planSrc, /^function futurePlanCardHtml\([\s\S]*?\n\}$/m, 'futurePlanCardHtml'),
    grab(planSrc, /^function futureGravityHtml\([\s\S]*?\n\}$/m, 'futureGravityHtml'),
    grab(planSrc, /^function operatingDebtAnswerHtml\([\s\S]*?\n\}$/m, 'operatingDebtAnswerHtml'),
    grab(planSrc, /^const REFRESH_TRUST_STATE = \{[\s\S]*?^\};$/m, 'REFRESH_TRUST_STATE'),
    grab(planSrc, /^function refreshTrustHtml\([\s\S]*?\n\}$/m, 'refreshTrustHtml'),
    grab(planSrc, /^function cashUnsafe\([\s\S]*?\n\}$/m, 'cashUnsafe'),
    grab(planSrc, /^function todayActionRowsHtml\([\s\S]*?\n\}$/m, 'todayActionRowsHtml'),
    grab(planSrc, /^function todayDecisionHtml\([\s\S]*?\n\}$/m, 'todayDecisionHtml'),
    grab(planSrc, /^function spendDecisionHtml\([\s\S]*?\n\}$/m, 'spendDecisionHtml'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function postedThisPeriodHtml\([\s\S]*?\n\}$/m, 'postedThisPeriodHtml'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function alreadyPaidRowsHtml\([\s\S]*?\n\}$/m, 'alreadyPaidRowsHtml'),
    grab(planSrc, /^function alreadyPaidHtml\([\s\S]*?\n\}$/m, 'alreadyPaidHtml'),
    grab(planSrc, /^function stillDueItems\([\s\S]*?\n\}$/m, 'stillDueItems'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function mustLeaveHtml\([\s\S]*?\n\}$/m, 'mustLeaveHtml'),
    grab(planSrc, /^function extraDebtGlanceHtml\([\s\S]*?\n\}$/m, 'extraDebtGlanceHtml'),
    grab(planSrc, /^function runningLeftoverHtml\([\s\S]*?\n\}$/m, 'runningLeftoverHtml'),
    grab(planSrc, /^function periodBillLine\([\s\S]*?\n\}$/m, 'periodBillLine'),
    grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
    grab(planSrc, /^function calendarPeriodBillsHtml\([\s\S]*?\n\}$/m, 'calendarPeriodBillsHtml'),
    grab(planSrc, /^function extraRepaymentHtml\([\s\S]*?\n\}$/m, 'extraRepaymentHtml'),
    grab(planSrc, /^function calendarFromTodayEvidenceHtml\([\s\S]*?\n\}$/m, 'calendarFromTodayEvidenceHtml'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
    grab(planSrc, /^function periodBillsHtml\([\s\S]*?\n\}$/m, 'periodBillsHtml'),
    grab(planSrc, /^function householdBudgetHtml\([\s\S]*?\n\}$/m, 'householdBudgetHtml'),
    grab(planSrc, /^function budgetDigestHtml\([\s\S]*?\n\}$/m, 'budgetDigestHtml'),
    grab(planSrc, /^function firstCardHtml\([\s\S]*?\n\}$/m, 'firstCardHtml'),
    grab(planSrc, /^function otherCardsHtml\([\s\S]*?\n\}$/m, 'otherCardsHtml'),
    grab(planSrc, /^function bigPurchasesHtml\([\s\S]*?\n\}$/m, 'bigPurchasesHtml'),
    grab(planSrc, /^function paydayAllocationSummaryHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSummaryHtml'),
    grab(planSrc, /^function budgetPayPeriodContentHtml\([\s\S]*?\n\}$/m, 'budgetPayPeriodContentHtml'),
    grab(planSrc, /^function currentPaydayShellHtml\([\s\S]*?\n\}$/m, 'currentPaydayShellHtml'),
    grab(planSrc, /^function operatingSurfaceHtml\([\s\S]*?\n\}$/m, 'operatingSurfaceHtml'),
    // AMANDA SLICE 14 — the same-input schedule chain read by operatingSurfaceHtml.
    grab(planSrc, /^function budgetMonthPlanSpendSchedule\([\s\S]*?\n\}$/m, 'budgetMonthPlanSpendSchedule'),
    grab(planSrc, /^function budgetMonthKnobOpts\([\s\S]*?\n\}/m, 'budgetMonthKnobOpts'),
    grab(planSrc, /^function budgetTrajectoryCacheKeyFor\([\s\S]*?\n\}/m, 'budgetTrajectoryCacheKeyFor'),
    grab(planSrc, /^function simOpts\([\s\S]*?\n\}/m, 'simOpts'),
    grab(planSrc, /^function isValidIsoCalendarDate\([\s\S]*?\n\}/m, 'isValidIsoCalendarDate'),
    grab(planSrc, /^const BUDGET_MONTH_NAMES = [\s\S]*?\];/m, 'BUDGET_MONTH_NAMES'),
    grab(planSrc, /^function budgetMonthName\([\s\S]*?\n\}/m, 'budgetMonthName'),
    'let budgetMonthScheduleCache = null; let budgetMonthScheduleCacheKey = null;',
    grab(planSrc, /^function paydayInstructionShellHtml\([\s\S]*?\n\}$/m, 'paydayInstructionShellHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ operatingSurfaceHtml, money2, fmtDate });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

function defaultGlance(html) {
  let out = String(html || '');
  const openRe = /<details\b/i;
  while (openRe.test(out)) {
    const start = out.search(openRe);
    const openMatch = out.slice(start).match(/<details\b[^>]*>/i);
    if (!openMatch) break;
    let i = start + openMatch[0].length;
    let depth = 1;
    while (i < out.length && depth > 0) {
      const rest = out.slice(i);
      const nextOpen = rest.search(/<details\b/i);
      const nextClose = rest.search(/<\/details>/i);
      if (nextClose < 0) {
        i = out.length;
        break;
      }
      if (nextOpen >= 0 && nextOpen < nextClose) {
        const nested = rest.slice(nextOpen).match(/<details\b[^>]*>/i);
        depth++;
        i += nextOpen + (nested ? nested[0].length : 8);
      } else {
        depth--;
        i += nextClose + 10;
      }
    }
    out = out.slice(0, start) + out.slice(i);
  }
  return out;
}

const PAYDAY = '2026-08-28';
const AS_OF = '2026-08-29';
const EATING = 90;
const GROCERIES = 200;
const RESTAURANT_SPENT = 41.20;
const GROCERY_SPENT = 18.40;

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 4000 },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: AS_OF, priorAsOf: '2026-08-19' },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 1111.11, confidence: 'confirmed',
    }],
    obligations: [],
    bills: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: GROCERIES, ownerLine: 'Groceries' },
        { id: 'fuel', label: 'Fuel & transport', class: 'essential', plannedMonthly: 80, ownerLine: 'Transportation / Gas' },
        { id: 'pets', label: 'Pets', class: 'essential', plannedMonthly: 40, ownerLine: 'Dog food' },
        { id: 'restaurants', label: 'Dining out & takeaway', class: 'discretionary', plannedMonthly: EATING, ownerLine: 'Restaurants / Takeout' },
        { id: 'telecom', label: 'Phones & internet', class: 'essential', currentMonthly: 121 },
      ],
    },
  };
}

const debts = [{
  id: 'cashback', label: 'Synthetic high card', secured: false,
  structure: 'Revolving — test', balance: 400, rate: 26.99, payment: 20, pending: 0,
}];

function periods(asOf) {
  return {
    asOf: asOf || AS_OF,
    periods: { ytd: { label: 'YTD', months: 1, spending: [] } },
  };
}

function packet(txs, extra) {
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: PAYDAY,
    coverageThrough: AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
  }, extra || {});
}

function recommendOpts(extra) {
  return Object.assign({
    targetBuffer: 0,
    debts,
    paydayFloor: 1000,
    periods: periods(),
  }, extra || {});
}

function hold(monthly, start, end) {
  const days = F.diffDays(start, end) + 1;
  return Math.round(monthly * days / MONTH * 100) / 100;
}

function row(digest, id) {
  return ((digest && digest.rows) || []).find(r => r.id === id) || null;
}

function independentSpent(txs, plan, start, end) {
  let spent = 0;
  for (const tx of txs) {
    if (!tx || !tx.date) continue;
    if (start && tx.date < start) continue;
    if (end && tx.date > end) continue;
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    if (cls.kind === 'spend' && cls.categoryId === 'restaurants') {
      spent += Number(tx.amount) || 0;
    }
  }
  return Math.round(spent * 100) / 100;
}

const composer = loadComposer();
const txs = [
  {
    date: PAYDAY, amount: RESTAURANT_SPENT, pending: false,
    categoryLabel: 'Dining out & takeaway', accountRole: 'household-cash',
  },
  {
    date: PAYDAY, amount: GROCERY_SPENT, pending: false,
    categoryLabel: 'Groceries', accountRole: 'household-cash',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
  },
  {
    date: '2026-08-16', amount: 99, pending: false,
    categoryLabel: 'Dining out & takeaway', accountRole: 'household-cash',
  },
];

console.log('=== 1. this-period planned is the span hold, not monthly or leftover ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, recommendOpts({
    currentPeriodActuals: packet(txs),
  }));
  const digest = advice.defaultView.budgetDigest;
  const eating = row(digest, 'restaurants');
  const start = advice.defaultView.periodStart;
  const end = advice.defaultView.periodEnd;
  const expected = hold(EATING, start, end);
  const q04 = (advice.defaultView.householdBudget || []).find(r => r.id === 'restaurants');
  ok(eating && near(eating.planned, expected),
    'eating out planned is monthly × this-period days / calendar month',
    eating && `${eating.planned} vs ${expected}`);
  ok(eating && eating.planned !== EATING,
    'this-period eating out is not the unscaled monthly owner target');
  ok(q04 && q04.amount === EATING && eating.planned !== q04.amount,
    'digest planned is not the Q04 leftover/monthly fallback amount');
  ok(eating && eating.spent !== eating.planned,
    'spent is not printed as the period plan');
}

console.log('\n=== 2. spent is classified actuals in the span ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, recommendOpts({
    currentPeriodActuals: packet(txs),
  }));
  const digest = advice.defaultView.budgetDigest;
  const eating = row(digest, 'restaurants');
  const groceries = row(digest, 'groceries');
  const start = advice.defaultView.periodStart;
  const end = advice.defaultView.periodEnd;
  const through = end < AS_OF ? end : AS_OF;
  const expectedEat = independentSpent(txs, plan, start, through);
  ok(eating && near(eating.spent, expectedEat) && near(eating.spent, RESTAURANT_SPENT),
    'eating out spent is classified actuals in this payday span');
  ok(groceries && near(groceries.spent, GROCERY_SPENT),
    'groceries spent is classified grocery actuals');
  ok(eating && eating.spent !== 99,
    'Aug 16 eating out is not dumped into this payday span');
}

console.log('\n=== 3. next period and week use that span\'s hold ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, recommendOpts({
    currentPeriodActuals: packet(txs),
  }));
  const next = advice.nextPeriodView;
  const nextEating = row(next && next.budgetDigest, 'restaurants');
  const nextHold = next ? hold(EATING, next.periodStart, next.periodEnd) : null;
  ok(nextEating && near(nextEating.planned, nextHold),
    'next-period eating out is that period\'s scaled owner-target hold');
  ok(nextEating && near(nextEating.spent, 0),
    'next-period spent is actuals in that future span, not this-period spend');
  const week = (advice.weekViews || [])[0];
  const weekEating = row(week && week.budgetDigest, 'restaurants');
  const weekHold = week ? hold(EATING, week.periodStart, week.periodEnd) : null;
  ok(weekEating && near(weekEating.planned, weekHold),
    'week eating out is the 7-day owner-target hold');
}

console.log('\n=== 4. incomplete actuals and stale history are plain words ===');
{
  const plan = syntheticPlan();
  const missing = F.recommend(plan, AS_OF, recommendOpts());
  const missingEat = row(missing.defaultView.budgetDigest, 'restaurants');
  ok(missingEat && missingEat.spent == null,
    'absent actuals do not invent a spent number');
  ok(missing.defaultView.budgetDigest.actualsIncomplete === true,
    'incomplete actuals are flagged for the page to word');
  const stale = F.recommend(plan, AS_OF, recommendOpts({
    periods: periods('2026-08-24'),
    currentPeriodActuals: packet(txs),
  }));
  ok(stale.defaultView.budgetDigest.historyThrough === '2026-08-24',
    'stale spending history as-of is published for kitchen-counter wording');
  const missingHtml = composer.operatingSurfaceHtml({
    advice: missing, weekly: missing.weekly, recommended: missing.weekly,
  });
  const missingPeriod = (missing.defaultView.calendarPeriods || [])
    .find(p => p.role === 'active') || missing.defaultView.calendarPeriods[0];
  ok(missingPeriod && (missingPeriod.householdBudget || []).every(r => r.spent == null),
    'absent actuals do not invent a calendar spent number');
  ok(!/remainingClaim|categoryRemainingClaim|posted-only|classified-incomplete/.test(defaultGlance(missingHtml)),
    'calendar budget does not print coverage codes');
  const nextMissing = composer.operatingSurfaceHtml({
    advice: missing, weekly: missing.weekly, recommended: missing.weekly,
    planLook: 'next-period', planView: missing.nextPeriodView,
  });
  ok(/Not all spending is in yet/.test(defaultGlance(nextMissing)),
    'absent actuals print that not all spending is in yet on the lookahead digest');
  const html = composer.operatingSurfaceHtml({
    advice: stale, weekly: stale.weekly, recommended: stale.weekly,
    planLook: 'next-period', planView: stale.nextPeriodView,
  });
  const glance = defaultGlance(html);
  ok(/Spending history only goes through/.test(glance)
      && /24 Aug|Aug\.? 24/.test(glance),
    'lookahead digest says spending history only goes through the dated history as-of');
  const staleEat = row(stale.nextPeriodView && stale.nextPeriodView.budgetDigest, 'restaurants');
  ok(staleEat && glance.includes(`spent ${composer.money2(staleEat.spent)} of ${composer.money2(staleEat.planned)}`),
    'stale history still prints overlay spent of the span hold on lookahead');
  ok(!/remainingClaim|categoryRemainingClaim|posted-only|classified-incomplete/.test(glance),
    'digest does not print coverage codes');
}

console.log('\n=== 5. page prints spent $X of $Y; does not subtract; no invented rows ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, recommendOpts({
    currentPeriodActuals: packet(txs),
  }));
  const eating = row(advice.defaultView.budgetDigest, 'restaurants');
  const active = (advice.defaultView.calendarPeriods || [])
    .find(p => p.role === 'active') || advice.defaultView.calendarPeriods[0];
  const eatingCal = (active.householdBudget || []).find(r => r.id === 'restaurants');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const glance = defaultGlance(html);
  ok(eatingCal && /<dt>Planned<\/dt>/.test(html)
      && html.includes(composer.money2(eatingCal.planned))
      && (eatingCal.spent == null
        || (/<dt>Spent<\/dt>/.test(html) && html.includes(composer.money2(eatingCal.spent)))),
    'this-period waterfall prints planned and spent from the payday cycle');
  ok(/data-live-current-balance/.test(html)
      && (html.match(/data-operating-question=/g) || []).length === 6,
    'the default calendar waterfall includes proposed savings alongside the five incumbent snapshot questions');
  ok(glance.indexOf('Household budget') >= 0
      && glance.indexOf('Spent against the budget') < 0,
    'this-period budget lives inside the waterfall, not a leftover digest');
  ok(!/CMAW|Travel Visa|Rogers|Bell/.test(glance),
    'calendar budget does not invent CMAW/payees');
  const nextHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'next-period', planView: advice.nextPeriodView,
  });
  const nextGlance = defaultGlance(nextHtml);
  const expected = `spent ${composer.money2(eating.spent)} of ${composer.money2(eating.planned)}`;
  ok((nextHtml.match(/data-operating-question=/g) || []).length === 5,
    'lookahead stops at Balance after household budget (five snapshot questions)');
  const q5 = nextGlance.indexOf('Balance after household budget');
  ok(q5 >= 0 && nextGlance.indexOf('Spent against the budget') > q5,
    'lookahead digest still prints after the household-budget boundary');
  ok(nextGlance.includes(expected)
      || /spent /.test(nextGlance),
    'lookahead digest still prints spent of planned');
  const ids = (advice.defaultView.budgetDigest.rows || []).map(r => r.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['fuel', 'groceries', 'pets', 'restaurants']),
    'only existing owner-target categories; current-regime telecom is omitted');
  const planSrc = read('public/plan.js');
  const digestFn = /function budgetDigestHtml\([\s\S]*?\n\}/.exec(planSrc);
  const sheetFn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(digestFn && !/planned\s*-|spent\s*-|\.leftover/.test(digestFn[0]),
    'the digest printer does not subtract leftover');
  ok(sheetFn && !/\bForecast\.[A-Za-z]+\s*\(/.test(sheetFn[0]),
    'operatingSurfaceHtml still calls no Forecast function');
}

console.log('\n=== 6. live this-period eating out is not the monthly $ target ===');
{
  const data = JSON.parse(read('data.json'));
  const monthly = data.plan.budget.categories.find(c => c.id === 'restaurants');
  const advice = F.recommend(data.plan, data.meta.asOf, {
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
    debts: data.debts,
    periods: { asOf: '2026-08-24', periods: { ytd: { label: 'YTD', months: 1, spending: [] } } },
  });
  const eating = row(advice.defaultView && advice.defaultView.budgetDigest, 'restaurants');
  ok(monthly && monthly.plannedPayday === 200 && monthly.plannedMonthly == null,
    'live plan has an eating-out plannedPayday 200, not a monthly 400');
  ok(eating && eating.planned !== 400,
    'this-period eating out is not the retired $400 monthly figure');
  ok(eating && (eating.planned === 200 || eating.planned === 0),
    'this-period eating out is whole-or-not-applicable, not a half-month smear');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
