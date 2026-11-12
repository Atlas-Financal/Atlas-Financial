'use strict';
/* Default Plan view contract: order, kitchen-counter labels, Forecast-owned
 * running leftover, paid bills stay listed, no invented payees.
 *
 * Independent leftover identity uses paydayAllocation allocated amounts,
 * not the page and not live household cents (L-002 / L-006).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');
const surfaceFixture = require('./fixtures/budget-surface-data');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
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
    const inner = out.slice(start + openMatch[0].length, i - 10);
    const summary = inner.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/i);
    const visible = /\sopen(?:\s|>)/.test(openMatch[0]) ? inner : (summary ? summary[0] : '');
    out = out.slice(0, start) + visible + out.slice(i);
  }
  return out;
}

function bannedOnGlance(html) {
  const text = defaultGlance(html).replace(/<[^>]+>/g, ' ');
  // NOTE (Slice 6 repair, PR #444): "true surplus" was removed from this
  // ban. It is not a field name -- it is inside Forecast's published
  // household-facing strategy reason, which the Slice 6 Systems Review
  // explicitly requires to stay visible on this surface (the unknown-
  // pending uncertainty statement itself contains the phrase). Field
  // names and settlement code words remain banned.
  return /paydayAllocation|thisPaydayPaid|thisPaydayDue|representedEvents|unverified-settlement|owner-fact/.exec(text)
    || /\bunverified\b|\brepresented\b|\boverlay\b|\bForecast\b|\bAtlas\b/i.exec(text)
    || /posting unknown/i.exec(text)
    || /leftover cash|current cash flow/i.exec(text)
    || /(?<![A-Za-z])asOf(?![A-Za-z])/.exec(text);
}

const PAYDAY = '2026-08-28';
const AS_OF = '2026-08-29';
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
    startingCash: { amount: 4000 },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: {
      asOf: AS_OF,
      priorAsOf: '2026-08-19',
      paydaySnapshot: {
        periodStart: PAYDAY,
        asOf: PAYDAY,
        opening: 4000,
      },
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

const composer = loadComposer();

console.log('=== 1. Forecast-owned running leftover identity ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const alloc = advice.paydayAllocation;
  const view = advice.defaultView;
  const futureTaken = (alloc.futureCosts || [])
    .reduce((s, r) => s + (Number(r.allocated) || 0), 0);
  const afterBills = Math.round((alloc.available - alloc.obligations.allocated) * 100) / 100;
  const afterBudget = Math.round((afterBills - alloc.essentials.allocated) * 100) / 100;
  const afterDebt = Math.round((afterBudget - alloc.extraDebt.allocated) * 100) / 100;
  const afterPurchases = Math.round((afterDebt - futureTaken) * 100) / 100;
  ok(view && alloc.runningLeftover, 'recommend publishes defaultView and runningLeftover');
  ok(near(view.currentBalance, alloc.available)
      && near(view.currentBalance, alloc.runningLeftover.currentBalance),
    'Current Balance copies paydayAllocation.available');
  ok(near(view.afterBills, afterBills)
      && near(view.afterHouseholdBudget, afterBudget)
      && near(view.afterDebtRepayment, afterDebt)
      && near(view.afterBigPurchases, afterPurchases),
    'running leftover after each displayed consume equals available minus those allocated amounts');
  ok(near(view.afterBills, alloc.runningLeftover.afterBills),
    'defaultView leftover is the paydayAllocation leftover, not a page total');
}

console.log('\n=== 2. default view order and kitchen-counter labels ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const glance = defaultGlance(html);
  const active = (advice.defaultView.calendarPeriods || []).find(p => p.role === 'active')
    || advice.defaultView.calendarPeriods[0];
  const prompts = [
    'Current Balance',
    'Income',
    'Bills',
    'Balance after bills',
    'Household budget',
    'Proposed savings',
    'Balance After Deductions',
  ];

  // Check headings rather than repeated account-caption words.
  const waterfall = glance.slice(glance.indexOf('data-live-current-balance'));
  let previous = -1;
  for (const prompt of prompts) {
    const at = prompt === 'Current Balance'
      ? waterfall.indexOf('live-current-balance-label')
      : waterfall.indexOf(`data-operating-prompt="${prompt}"`);
    ok(at > previous, `${prompt} appears on the default view in order`);
    previous = at;
  }
  const snapshotQs = 6;
  ok(/data-live-current-balance/.test(html)
      && (html.match(/data-operating-question=/g) || []).length === snapshotQs
      && !/data-operating-prompt="Current Balance"/.test(html)
      && !/data-operating-prompt="Opening balance"/.test(html),
    'the default surface has live Current Balance plus the payday snapshot questions');

  const pickerAt = html.indexOf('data-calendar-period-picker');
  const liveAt = html.indexOf('data-live-current-balance');
  ok(liveAt >= 0 && pickerAt > liveAt,
    'Current Balance prints before the pay period selector');
  const incomePromptAt = html.indexOf('data-operating-prompt="Income"');
  const incomeLineAt = html.indexOf('data-period-income=');
  const paydayAt = html.indexOf('data-payday-balance');
  ok(incomePromptAt >= 0 && incomeLineAt > incomePromptAt && paydayAt > incomeLineAt
      && paydayAt < html.indexOf('data-operating-prompt="Bills"'),
    'Payday balance closing total sits under income lines, not above income');
  ok(!/Extra credit-card repayment|Balance after debt repayment|Big-purchase savings|Projected ending balance/.test(html),
    'the default surface stops at Balance After Deductions');

  ok(/data-live-current-balance/.test(html) && /Current Balance/.test(glance)
      && !/leftover cash/i.test(glance)
      && !/current cash flow/i.test(glance),
    'live cash is labelled Current Balance, not leftover or current cash flow');
  const banned = bannedOnGlance(html);
  ok(!banned, 'default glance has no Forecast field names or settlement code words',
    banned && banned[0]);
  ok(!/See how payday is reserved/.test(html)
      && !/See later bills and big purchases/.test(html)
      && !/See current-period details/.test(html)
      && !/Notes behind these numbers/.test(html)
      && !/How sure is this\?/.test(html)
      && !/data-refresh-trust-state=/.test(html)
      && !/data-refresh-attention/.test(html)
      && !/data-operating-warnings/.test(html)
      && !/There is no feasible weekly cap/.test(html)
      && !/stays unfunded/.test(html)
      && !/class="operating-limit warn"/.test(html),
    'default usable Plan does not render explainer, worksheet, trust-card, or advisory-block clutter');
}

console.log('\n=== 3. bills this pay period: paid stay listed, history stays off ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const ids = (advice.defaultView.bills || []).map(r => r.id);
  ok(ids.includes('mortgage') && ids.includes('fit4less'),
    'paid mortgage and gym stay on the period-bill list');
  ok(ids.includes('tdfees') && !ids.includes('travel'),
    'still-due TD fees stay; Travel Visa day 26 is the previous payday cycle');
  ok(!ids.includes('childBenefit') && !ids.includes('bcaa-aug15-outstanding'),
    'income stays off the bills list; Aug 16 BCAA is the previous payday cycle');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const glance = defaultGlance(html);
  const bills = html.slice(html.indexOf('data-operating-question="04"'), html.indexOf('data-operating-question="05"'));
  const income = html.slice(html.indexOf('data-operating-question="02"'), html.indexOf('data-operating-question="04"'));
  ok(/Mortgage · Aug 28 · PAID/.test(bills)
      && /Fit4Less membership · Aug 28 · PAID/.test(bills),
    'expanded bills retain the paid bills and PAID classification');
  ok(/TD account fees \(two accounts\) · Aug 30 · still due/.test(bills),
    'later-in-window bills stay still due in the expanded list');
  ok(/Dale salary/.test(income) && !/Canada child benefit/.test(income)
      && !/Payroll — Seaspan/.test(income),
    'Dale salary prints in the income block; Aug 20 child benefit is previous cycle');
  ok(!/Rogers/.test(glance) && !/CMAW/.test(glance),
    'glance does not invent bills');
  ok(bills.includes('−' + composer.money2(MORTGAGE)),
    'bill movements print money out as −');
}

console.log('\n=== 4. household budget prints existing owner targets only ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const budgetIds = (advice.defaultView.householdBudget || []).map(r => r.id).sort();
  ok(JSON.stringify(budgetIds) === JSON.stringify(['fuel', 'groceries', 'pets', 'restaurants']),
    'prints groceries, fuel, dog food, eating out');
  ok(!(advice.defaultView.householdBudget || []).some(r => /Dale|Amanda/i.test(r.label)),
    'does not invent Dale or Amanda spending rows');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const glance = defaultGlance(html);
  const household = html.slice(html.indexOf('data-operating-question="06"'), html.indexOf('data-operating-question="07"'));
  ok(/Groceries/.test(household) && /Fuel/.test(household) && /Dog food/.test(household)
      && /Eating out/.test(household),
    'expanded household details retain kitchen-counter category labels');
  ok(!/Dale spending/.test(household) && !/Amanda spending/.test(household),
    'missing owner-target adults are omitted');
}

console.log('\n=== 5. first card is revolving extra; HELOC stays off the card lists ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const view = advice.defaultView;
  ok(view.firstCard && view.firstCard.id === 'cashback',
    'first card is the highest-rate revolving card');
  ok(view.firstCard.extraThisPayday != null,
    'extra this payday is published even when it is $0');
  ok((view.otherCards || []).some(r => r.id === 'mbna')
      && !(view.otherCards || []).some(r => r.id === 'heloc' || r.id === 'mortgage'),
    'other cards include the remaining revolving card and omit HELOC/mortgage');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  ok(!/data-payday-first-card/.test(html) && !/data-card-id=/.test(html),
    'the default Plan waterfall prints no card rows after the household-budget boundary');
  const nextHtml = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    planLook: 'next-period', planView: advice.nextPeriodView,
  });
  const nextGlance = defaultGlance(nextHtml);
  ok(!/Credit card to pay off first/.test(nextGlance)
      && !/Other credit cards/.test(nextGlance)
      && !/Balance after debt repayment/.test(nextGlance)
      && !/Big purchases on the horizon/.test(nextGlance)
      && !/Balance after big purchase allocation/.test(nextGlance),
    'next-period lookahead does not print debt or big-purchase waterfall rows');
  ok(nextGlance.indexOf('Balance after household budget') >= 0
      && nextGlance.indexOf('Household budget') < nextGlance.indexOf('Balance after household budget'),
    'next-period lookahead still prints through Balance after household budget');
}

console.log('\n=== 6. big purchases print Forecast cost and $0 saved; page does not subtract ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0, debts });
  const camp = (advice.defaultView.bigPurchases || []).find(r => r.id === 'camp');
  ok(camp && near(camp.cost, 500) && near(camp.savedSoFar, 0),
    'big purchase cost is Forecast need; saved so far is $0 when Forecast has no savings plan');
  const planSrc = read('public/plan.js');
  const fn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'operatingSurfaceHtml calls no Forecast function');
  ok(fn && !/view\.currentBalance\s*-|afterBills\s*-|allocatedObligations/.test(fn[0]),
    'the payday sheet does not subtract leftover');
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  ok(defaultGlance(html).includes(composer.money2(
    (advice.defaultView.calendarPeriods.find(p => p.role === 'active')
      || advice.defaultView.calendarPeriods[0]).afterBills)),
    'balance after bills prints the Forecast leftover');
}

console.log('\n=== 7. compact freshness remains; worksheet clutter is gone from the page ===');
{
  const page = read('public/index.html');
  ok(!/id="asof"/.test(page) && !/id="theme-btn"/.test(page),
    'the Budget page does not render the as-of chip or theme control');
  ok(/id="payday-answer" hidden/.test(page) && /id="road-ahead" hidden/.test(page),
    'worksheet and road-ahead diagnostic mounts are hidden from the default Plan');
  ok(!/View full current-period worksheet/.test(page) && !/Why \/ Road ahead/.test(page),
    'View full current-period worksheet and Why / Road ahead are not default Plan copy');
}

const DIAGNOSTIC_MOUNTS = ['hero-tiles', 'cap-headline', 'phases', 'risk-list'];

// Real page scripts and Forecast, with an invented input generation. Only SVG
// drawing and browser event wiring are stubbed; renderPlan and its consumers run.
function diagnosticPage(hidden) {
  const elements = new Map(), writes = new Map();
  const metrics = { counterfactualCalls: 0, phaseCalls: 0 };
  let advice;
  const element = (id = '') => {
    let html = DIAGNOSTIC_MOUNTS.includes(id) ? '<i>retained ' + id + '</i>' : '';
    const attrs = {};
    return { get innerHTML() { return html; }, set innerHTML(value) {
      html = String(value); writes.set(id, (writes.get(id) || 0) + 1);
    }, textContent: '', hidden: false, value: '', dataset: {}, children: [],
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; }, hasAttribute(k) { return Object.hasOwn(attrs, k); },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, replaceChildren() {}, insertAdjacentHTML() {}, closest() { return null; } };
  };
  if (hidden !== 'absent') {
    const root = element('road-ahead'); root.hidden = hidden;
    elements.set('road-ahead', root);
  }
  for (const id of DIAGNOSTIC_MOUNTS) elements.set(id, element(id));
  const forecast = { ...F,
    recommend(...args) { advice = F.recommend(...args); return advice; },
    counterfactuals(...args) { metrics.counterfactualCalls++; return F.counterfactuals(...args); },
    planPhases(...args) { metrics.phaseCalls++; return F.planPhases(...args); },
  };
  const context = vm.createContext({ escapeHtml: require('./app-escape-html'), Forecast: forecast, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) {
        if (id === 'road-ahead' && hidden === 'absent') return null;
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
      }, documentElement: { dataset: {}, style: {} }, createElement: element, createElementNS: element, body: element() },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context);
  vm.runInContext('App.boot=()=>{}; App.once=()=>{}; App.register=()=>{};', context);
  for (const name of ['forecast-chequing', 'balance-history', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan'])
    vm.runInContext(script(name), context);
  vm.runInContext('forecastChart=()=>{}; renderCalendar=()=>{};', context);
  return { metrics, writes, elements,
    render(served) {
      context.served = served;
      context.periods = { periods: { ytd: { label: 'Invented month', months: 1, spending: [] } } };
      vm.runInContext("Object.defineProperty(App, 'data', { get:()=>served, configurable:true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts:served.debts, weeklyVariable:40 }); renderPlan(served,periods,null);', context);
      const output = Object.fromEntries([...elements].map(([id, el]) => [id, { html: el.innerHTML, text: el.textContent }]));
      return { output, advice: JSON.stringify(advice) };
    },
  };
}

function diagnosticFixture(kind) {
  if (kind === 'withheld-savings') return surfaceFixture.served({ withheldSavings: true });
  const data = surfaceFixture.canonical();
  if (kind === 'opening-gap') {
    data.plan.startingCash.breakdown.forEach(row => { row.value = 0; });
    data.plan.funding = { options: [{ id: 'invented-cover', label: 'Invented outside cash', short: 'invented cash',
      available: 0, debtId: null, rank: 1 }] };
  }
  return data;
}

console.log('\n=== 8. explicit hidden diagnostics skip counterfactual work only ===');
{
  const html = read('public/index.html'), start = html.indexOf('<section id="road-ahead"');
  let depth = 0, end;
  for (const tag of html.slice(start).matchAll(/<\/?section\b[^>]*>/g)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (!depth) { end = start + tag.index + tag[0].length; break; }
  }
  ok(start >= 0 && end > start && DIAGNOSTIC_MOUNTS.every(id => html.slice(start, end).includes('id="' + id + '"')),
    'all four counterfactual consumers belong to the hidden road-ahead root');
}
for (const kind of ['current', 'opening-gap', 'withheld-savings']) {
  const data = diagnosticFixture(kind), before = JSON.stringify(data);
  const hidden = diagnosticPage(true), requested = diagnosticPage(false), absent = diagnosticPage('absent'), unspecified = diagnosticPage(undefined);
  const h = hidden.render(data), shown = requested.render(data), legacy = absent.render(data), unset = unspecified.render(data);
  ok(hidden.metrics.counterfactualCalls === 0, kind + ': explicit hidden root makes zero counterfactual calls');
  ok(hidden.metrics.phaseCalls === 0, kind + ': hidden phase consumer does not rebuild diagnostic alternatives');
  for (const id of DIAGNOSTIC_MOUNTS) {
    ok(!hidden.writes.get(id) && h.output[id].html === '<i>retained ' + id + '</i>',
      kind + ': hidden ' + id + ' is not rendered');
    ok(requested.writes.get(id) === 1 && shown.output[id].html !== '<i>retained ' + id + '</i>',
      kind + ': requested ' + id + ' renders its native output');
    ok(JSON.stringify(shown.output[id]) === JSON.stringify(legacy.output[id])
        && JSON.stringify(shown.output[id]) === JSON.stringify(unset.output[id]),
      kind + ': ' + id + ' output identical when diagnostics requested or root absent/unspecified');
  }
  ok(requested.metrics.counterfactualCalls === 1 && absent.metrics.counterfactualCalls === 1 && unspecified.metrics.counterfactualCalls === 1,
    kind + ': requested, absent and unspecified roots preserve the original call');
  const active = output => Object.fromEntries(Object.entries(output)
    .filter(([id]) => id !== 'road-ahead' && !DIAGNOSTIC_MOUNTS.includes(id)));
  ok(JSON.stringify(active(h.output)) === JSON.stringify(active(shown.output)),
    kind + ': every other render mount, including operating/Savings/payday, stays identical');
  ok(!!h.output['operating-surface-body'].html && !!h.output['payday-answer-body'].html,
    kind + ': preservation check covers populated active and payday consumers');
  ok(h.advice === shown.advice && shown.advice === legacy.advice && legacy.advice === unset.advice,
    kind + ': financial publications and qualification stay identical');
  ok(JSON.stringify(data) === before, kind + ': all modes preserve the invented source generation');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
