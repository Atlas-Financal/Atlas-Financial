'use strict';
/* Next pay-period lookahead + week picker: Forecast owns the dollars,
 * plan.js prints the selected view, no invented bills, leftover identity
 * is the existing waterfall helper against the already-run walk.
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
const MONTH_DAYS = 365.25 / 12;

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
    `${source}\n({ operatingSurfaceHtml, money2 });`,
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

function bannedOnGlance(html) {
  const text = defaultGlance(html).replace(/<[^>]+>/g, ' ');
  return /paydayAllocation|thisPaydayPaid|thisPaydayDue|representedEvents|unverified-settlement|true surplus|owner-fact/.exec(text)
    || /defaultView|nextPeriodView|weekViews|weekView/.exec(text)
    || /\bunverified\b|\brepresented\b|\boverlay\b|\bForecast\b|\bAtlas\b/i.exec(text)
    || /posting unknown/i.exec(text)
    || /leftover cash|current cash flow/i.exec(text)
    || /(?<![A-Za-z])asOf(?![A-Za-z])/.exec(text);
}

const PAYDAY = '2026-08-28';
const AS_OF = '2026-08-29';
const NEXT_PAYDAY = '2026-09-11';
const PAYROLL = 1111.11;
const MORTGAGE = 1234.56;
const FIT = 13.13;
const CHILD = 77.77;
const BCAA = 55.55;
const TRAVEL = 18.18;
const FEES = 44.44;
const GROCERIES = 200;
const FUEL = 80;
const PETS = 40;
const EATING = 90;

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 0 },
    windowDays: 91,
    startingCash: { amount: 4000 },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: {
      asOf: AS_OF,
      priorAsOf: '2026-08-19',
      representedEvents: [
        { id: 'payroll', date: PAYDAY },
        { id: 'mortgage', date: PAYDAY },
        { id: 'fit4less', date: PAYDAY },
        { id: 'childBenefit', date: '2026-08-20' },
        { id: 'bcaa-aug15-outstanding', date: '2026-08-16' },
      ],
    },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: '2026-08-14', amount: PAYROLL, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Canada child benefit', frequency: 'monthly',
        day: 20, amount: CHILD, confidence: 'confirmed',
      },
    ],
    obligations: [
      {
        id: 'mortgage', label: 'Mortgage', frequency: 'biweekly',
        anchor: '2026-08-14', amount: MORTGAGE, confidence: 'confirmed',
        debtId: 'mortgage', effect: 'payment',
      },
      {
        id: 'travel', label: 'Travel Visa minimum', frequency: 'monthly',
        day: 26, amount: TRAVEL, confidence: 'confirmed',
        debtId: 'travelvisa', effect: 'payment',
      },
    ],
    bills: [
      {
        id: 'fit4less', label: 'Fit4Less membership', frequency: 'biweekly',
        anchor: '2026-08-14', amount: FIT, confidence: 'confirmed',
      },
      {
        id: 'tdfees', label: 'TD account fees (two accounts)', frequency: 'monthly',
        day: 30, amount: FEES, confidence: 'confirmed',
      },
      {
        id: 'bcaa-aug15-outstanding',
        label: 'BCAA insurance — 15 August posting unknown',
        frequency: 'once', date: '2026-08-16', amount: BCAA, confidence: 'confirmed',
      },
    ],
    commitments: [
      {
        id: 'camp', label: 'Synthetic camp', date: '2026-10-01',
        amount: 500, flexibility: 'required', confidence: 'confirmed',
      },
    ],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: GROCERIES, ownerLine: 'Groceries' },
        { id: 'fuel', label: 'Fuel & transport', class: 'essential', plannedMonthly: FUEL, ownerLine: 'Transportation / Gas' },
        { id: 'pets', label: 'Pets', class: 'essential', plannedMonthly: PETS, ownerLine: 'Dog food' },
        { id: 'restaurants', label: 'Dining out & takeaway', class: 'discretionary', plannedMonthly: EATING, ownerLine: 'Restaurants / Takeout' },
      ],
    },
  };
}

const debts = [
  {
    id: 'cashback', label: 'Synthetic high card', secured: false,
    structure: 'Revolving — test', balance: 400, rate: 26.99, payment: 20, pending: 0,
  },
  {
    id: 'mbna', label: 'Synthetic other card', secured: false,
    structure: 'Revolving — test', balance: 200, rate: 21.74, payment: 15, pending: 0,
  },
  {
    id: 'heloc', label: 'HELOC', secured: true,
    structure: 'Interest-only revolving — never amortises', balance: 1000, rate: 4.9, payment: 0, pending: 0,
  },
  {
    id: 'mortgage', label: 'Mortgage', secured: true,
    structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0,
  },
];

function roundCent(n) {
  return Math.round(Number(n) * 100) / 100;
}

const composer = loadComposer();
const plan = syntheticPlan();
const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });

console.log('=== 1. next pay period is Forecast\'s next payday, not a hardcoded date ===');
{
  const next = advice.nextPeriodView;
  const action = advice.currentPeriodAction;
  ok(next && action && next.periodStart === action.nextPayday,
    'next-period start copies currentPeriodAction.nextPayday');
  ok(next.periodStart === NEXT_PAYDAY,
    'biweekly Seaspan from 14 Aug lands the next payday on 11 Sep');
  ok(next.periodEnd && next.periodEnd > next.periodStart,
    'next-period end is the day before the payday after that');
  ok(next.billsHeading === 'Bills this pay period'
      && next.extraLabel === 'Extra this payday',
    'next-period copy stays kitchen-counter pay-period language');
}

console.log('\n=== 2. next-period Current Balance is walk leftover plus that payday\'s income ===');
{
  const next = advice.nextPeriodView;
  const sim = advice.sim;
  const idx = (sim.daily || []).findIndex(d => d.date === next.periodStart);
  const opening = idx > 0 ? sim.daily[idx - 1].balance : null;
  const independent = roundCent(opening + PAYROLL);
  ok(opening != null && near(next.currentBalance, independent),
    'Current Balance is previous close plus Seaspan income',
    `view ${next.currentBalance} vs ${independent}`);
  const events = F.expandEvents(plan, next.periodStart, next.periodEnd);
  let unpaid = 0;
  for (const e of events) {
    if (!e || e.date < next.periodStart || e.date > next.periodEnd) continue;
    if (e.kind !== 'obligation' && e.kind !== 'bill' && e.kind !== 'commitment') continue;
    if (!(e.amount < 0)) continue;
    unpaid += -e.amount;
  }
  unpaid = roundCent(unpaid);
  const days = F.diffDays(next.periodStart, next.periodEnd) + 1;
  const scale = days / MONTH_DAYS;
  const budget = roundCent([GROCERIES, FUEL, PETS, EATING]
    .map(m => roundCent(m * scale))
    .reduce((s, n) => s + n, 0));
  const afterBills = roundCent(independent - unpaid);
  const afterBudget = roundCent(afterBills - budget);
  ok(near(next.afterBills, afterBills),
    'after bills is opening minus that period\'s unpaid joint-cash bills');
  ok(near(next.afterHouseholdBudget, afterBudget),
    'after household budget uses owner targets scaled to that period');
  ok(near(next.afterDebtRepayment, afterBudget)
      && near(next.afterBigPurchases, afterBudget)
      && next.firstCard && near(next.firstCard.extraThisPayday, 0),
    'extra and set-aside stay $0 on the lookahead (this payday\'s surplus, not a second waterfall)');
}

console.log('\n=== 3. next-period bills are that span only; no invented payees ===');
{
  const ids = (advice.nextPeriodView.bills || []).map(r => r.id);
  ok(ids.includes('payroll') && ids.includes('mortgage') && ids.includes('fit4less'),
    'next payday income, mortgage, and gym are on the list');
  ok(ids.includes('childBenefit'),
    '20 Sep child benefit falls inside the next period');
  ok(!ids.includes('tdfees') && !ids.includes('travel')
      && !ids.includes('bcaa-aug15-outstanding') && !ids.includes('camp'),
    'later-month fees, Travel Visa min, prior once stub, and October camp stay off');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'next-period', planView: advice.nextPeriodView,
  });
  const glance = defaultGlance(html);
  ok(/Payroll — Seaspan/.test(glance) && /still due/.test(glance),
    'future-period bills print still due');
  ok(glance.includes('+' + composer.money2(PAYROLL))
      && glance.includes('−' + composer.money2(MORTGAGE)),
    'movements print money in as + and money out as −');
  ok(!/Rogers/.test(glance) && !/Bell/.test(glance) && !/CMAW/.test(glance)
      && !/Dale spending/.test(glance) && !/Amanda spending/.test(glance),
    'lookahead does not invent bills or adult spending rows');
  const banned = bannedOnGlance(html);
  ok(!banned, 'lookahead glance has no Forecast field names or settlement code words',
    banned && banned[0]);
  const lookaheadPrompts = [
    'Current Balance',
    'Bills this pay period',
    'Balance after bills',
    'Household budget',
    'Balance after household budget',
  ];
  let prev = -1;
  for (const label of lookaheadPrompts) {
    const at = glance.indexOf(label);
    ok(at > prev, `next-period lookahead prints ${label} in waterfall order`);
    prev = at;
  }
  ok((html.match(/data-operating-question=/g) || []).length === 5,
    'next-period lookahead has five snapshot questions, not debt or big-purchase rows');
  ok(!/Credit card to pay off first|Other credit cards|Balance after debt repayment|Big purchases on the horizon|Balance after big purchase allocation/.test(glance),
    'next-period lookahead omits debt-repayment and big-purchase waterfall rows');
}

console.log('\n=== 4. week views come from the Forecast walk; picker asks for that week ===');
{
  const weeks = advice.weekViews || [];
  const simWeeks = (advice.sim && advice.sim.weeks) || [];
  ok(weeks.length === simWeeks.length && weeks.length > 1,
    'one published week view per simulated week');
  ok(weeks.every((row, i) => row.periodStart === simWeeks[i].start
      && row.periodEnd === simWeeks[i].end
      && near(row.currentBalance, simWeeks[i].opening)),
    'week Current Balance is that week\'s simulated opening');
  const paydayWeek = weeks.find(row =>
    row.periodStart <= NEXT_PAYDAY && row.periodEnd >= NEXT_PAYDAY);
  ok(paydayWeek && (paydayWeek.bills || []).some(r => r.id === 'payroll'),
    'the week that contains 11 Sep publishes that week\'s Seaspan pay');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  ok(!/More views/.test(html) && !/What to look at/.test(html)
      && !/<select class="numin" data-plan-look>/.test(html)
      && !/value="next-period"/.test(html),
    'the Budget surface leaves pay periods to the selector and does not offer More views');
  const weekHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'week:' + paydayWeek.periodStart, planView: paydayWeek,
  });
  const glance = defaultGlance(weekHtml);
  ok(/Bills this week/.test(glance) && !/Bills this pay period/.test(glance),
    'the week printout uses week language, not pay-period language');
  ok(!/Credit card to pay off first|Balance after big purchase allocation/.test(glance),
    'week lookahead omits debt-repayment and big-purchase waterfall rows');
  ok((weekHtml.match(/data-operating-question=/g) || []).length === 5,
    'week lookahead stops at Balance after household budget');
  ok(/Payroll — Seaspan/.test(glance) && !/Rogers/.test(glance),
    'the week printout shows Forecast bills for that week, not invented payees');
  const planSrc = read('public/plan.js');
  const pick = /function selectedPlanView\([\s\S]*?\n\}/.exec(planSrc);
  ok(pick && /advice\.weekViews/.test(pick[0]) && /advice\.nextPeriodView/.test(pick[0])
      && !/Forecast\./.test(pick[0]),
    'the picker selects a Forecast-published view; it does not compute one');
}

console.log('\n=== 5. page still does not subtract leftover ===');
{
  const planSrc = read('public/plan.js');
  const fn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  const content = /function budgetPayPeriodContentHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'operatingSurfaceHtml calls no Forecast function');
  ok(fn && !/view\.currentBalance\s*-|afterBills\s*-|allocatedObligations/.test(fn[0]),
    'the payday sheet does not subtract leftover');
  ok(content && /ctx\.planView \|\| advice\.defaultView/.test(content[0]),
    'the sheet prints the selected Forecast view');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
