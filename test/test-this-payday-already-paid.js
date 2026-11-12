'use strict';
/* This-payday already-paid set, and cancelled CMAW dues drop.
 *
 * Independent of thisPaydayPaidFrom / alreadyPaidHtml: payday-date
 * expandEvents plus representedEvents decide what that cheque already
 * paid. Independently enumerated 15ths decide that cancelled CMAW dues
 * are gone. Synthetic cents are unlike live household figures (L-006).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const data = require('../data.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const PAYDAY = '2026-08-28';
const AS_OF = '2026-08-29';
const PRIOR = '2026-08-19';
const PAYROLL = 1111.11;
const MORTGAGE = 1234.56;
const FIT = 13.13;
const CHILD = 77.77;
const BCAA = 55.55;
const TRAVEL = 18.18;
const FEES = 44.44;

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
    `${source}\n({ operatingSurfaceHtml, money, money2 });`,
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

function syntheticPlan() {
  return {
    windowDays: 40,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 4000 },
    opening: {
      asOf: AS_OF,
      priorAsOf: PRIOR,
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
    commitments: [],
    budget: { categories: [] },
  };
}

function independentPaydayPaid(plan, payday) {
  const represented = new Set(
    ((plan.opening && plan.opening.representedEvents) || [])
      .filter(row => row && row.id && row.date)
      .map(row => row.id + '@' + row.date)
  );
  const events = F.expandEvents(plan, payday, payday, { keepRepresented: true });
  const inflows = events.filter(e => e && e.kind === 'income' && e.date === payday
    && represented.has(e.id + '@' + e.date));
  const bills = events.filter(e => e && e.amount < 0 && e.kind !== 'income'
    && e.date === payday && represented.has(e.id + '@' + e.date));
  return { inflows, bills, represented };
}

console.log('=== this-payday already-paid is the cheque date, not the whole period ===');
{
  const plan = syntheticPlan();
  const indep = independentPaydayPaid(plan, PAYDAY);
  ok(indep.inflows.length === 1 && indep.inflows[0].id === 'payroll'
      && near(indep.inflows[0].amount, PAYROLL),
    'independent payday-date stream has Seaspan in only');
  ok(indep.bills.some(e => e.id === 'mortgage' && near(-e.amount, MORTGAGE))
      && indep.bills.some(e => e.id === 'fit4less' && near(-e.amount, FIT))
      && indep.bills.length === 2,
    'independent payday-date stream has mortgage and Fit4Less paid only');
  ok(!indep.inflows.some(e => e.id === 'childBenefit')
      && !indep.bills.some(e => e.id === 'bcaa-aug15-outstanding'),
    'independent payday-date stream omits Aug 20 child benefit and Aug 16 BCAA');

  const action = F.currentPeriodAction(plan, AS_OF, {
    targetBuffer: 0,
    representedEvents: plan.opening.representedEvents,
  });
  ok(action.thisPayday === PAYDAY, 'thisPayday is the Aug 28 cheque date');
  const paidIds = [
    ...(action.thisPaydayPaid.inflows || []).map(r => r.id),
    ...(action.thisPaydayPaid.bills || []).map(r => r.id),
  ].sort();
  ok(JSON.stringify(paidIds) === JSON.stringify(['fit4less', 'mortgage', 'payroll'].sort()),
    'thisPaydayPaid is Seaspan, mortgage, Fit4Less',
    paidIds.join(','));
  ok(!(action.thisPaydayPaid.inflows || []).some(r => r.id === 'childBenefit'),
    'Aug 20 child benefit is not this payday already paid');
  ok(!(action.thisPaydayPaid.bills || []).some(r => r.id === 'bcaa-aug15-outstanding'),
    'Aug 16 BCAA is not this payday already paid');
  const dueIds = (action.thisPaydayDue || []).map(r => r.id).sort();
  ok(dueIds.includes('travel') && dueIds.includes('tdfees'),
    'Travel Visa min and TD fees stay still due',
    dueIds.join(','));
  ok(!dueIds.includes('bcaa-aug15-outstanding') && !dueIds.includes('mortgage')
      && !dueIds.includes('fit4less'),
    'previous-cycle BCAA and paid payday bills are not still due',
    dueIds.join(','));
}

console.log('\n=== default glance prints that set in kitchen-counter language ===');
{
  const plan = syntheticPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 0 });
  const composer = loadComposer();
  const html = composer.operatingSurfaceHtml({
    advice,
    weekly: advice.weekly,
    recommended: advice.weekly,
  });
  const glance = defaultGlance(html);
  const text = glance.replace(/<[^>]+>/g, ' ');
  ok(/Bills/.test(html) && /This Pay Period/.test(html) && /Next Pay Period/.test(html),
    'the bills heading is Bills, printed as This / Next Pay Period');
  ok(/data-payday-period-bills/.test(html),
    'period bills are one default-view list');
  const billsDetails = html.slice(html.indexOf('data-operating-question="04"'),
    html.indexOf('data-operating-question="05"'));
  ok(/Mortgage · Aug 28 · PAID/.test(billsDetails)
      && /Fit4Less membership · Aug 28 · PAID/.test(billsDetails),
    'This Pay Period still lists the payday mortgage and Fit4Less as PAID');
  ok(billsDetails.includes('−' + composer.money2(MORTGAGE))
      && billsDetails.includes('−' + composer.money2(FIT)),
    'those paid bills print as money out');
  const q2 = html.slice(html.indexOf('data-operating-question="02"'),
    html.indexOf('data-operating-question="03"'));
  const q4 = html.slice(html.indexOf('data-operating-question="04"'),
    html.indexOf('data-operating-question="05"'));
  ok(/Dale salary/.test(q2) && !/Dale salary/.test(q4)
      && !/Payroll — Seaspan/.test(q2),
    'Dale salary sits in the income block, not as a bill row');
  ok(!/Canada child benefit/.test(q2) && !/Canada child benefit/.test(q4),
    'Aug 20 child benefit is previous payday cycle, not this Aug 28–Sep 10 income');
  ok(/Current Balance/.test(html) && !/Leftover cash/.test(html)
      && !/Current cash flow/.test(html),
    'the leftover number is labelled Current Balance');
  ok(!/ICBC/.test(glance)
      && !/RESP/.test(glance) && !/CMAW/.test(glance)
      && !/union dues/i.test(glance),
    'default glance omits cancelled CMAW; previous-cycle BCAA stays off this window');
  ok(!/BCAA insurance · Aug 16/.test(glance) && !/posting unknown/i.test(text),
    'the August once BCAA row is previous payday cycle, not This Pay Period');
  ok(/TD account fees/.test(billsDetails)
      && /still due/.test(billsDetails)
      && billsDetails.includes('−' + composer.money2(FEES))
      && !/Travel Visa minimum/.test(billsDetails),
    'TD fees stay still due in this window; Travel Visa day 26 is the previous cycle');
  ok(!/unverified-settlement|\boverlay\b|\bForecast\b|\bAtlas\b|\bunverified\b|\brepresented\b/.test(text),
    'default glance stays kitchen-counter language');
  ok(/still due/.test(q4) && /PAID/.test(q4) && /This Pay Period/.test(html),
    'the payday-window bills list keeps PAID and still due together');
  ok(/Mortgage · Aug 28 · PAID/.test(q4) && /TD account fees/.test(q4),
    'paid mortgage stays listed beside still-due TD fees');
}

console.log('\n=== identified extra card payment on payday settles the min ===');
{
  const EXTRA = 40.4;
  const DUE = '2026-08-26';
  const plan = syntheticPlan();
  plan.opening.representedEvents = plan.opening.representedEvents.concat([
    { id: 'travel', date: DUE },
  ]);
  const opts = {
    targetBuffer: 0,
    representedEvents: plan.opening.representedEvents,
    currentPeriodActuals: {
      representedActuals: [
        { id: 'payroll', date: PAYDAY, actual: -PAYROLL, postedOn: PAYDAY },
        { id: 'travel', date: DUE, actual: -EXTRA, postedOn: PAYDAY },
      ],
      transactions: [],
      pendingCoverage: 'complete',
      transactionCoverage: 'complete',
    },
  };
  const events = F.expandEvents(plan, DUE, DUE, { keepRepresented: true });
  const travelEvent = events.find(e => e.id === 'travel' && e.date === DUE);
  ok(travelEvent && near(-travelEvent.amount, TRAVEL),
    'independent schedule still has the Travel Visa min on Aug 26');
  ok(EXTRA + 0.005 >= TRAVEL && !near(EXTRA, TRAVEL),
    'observed card credit covers the min and is not the scheduled $');

  const action = F.currentPeriodAction(plan, AS_OF, opts);
  const paidTravel = (action.thisPaydayPaid.bills || [])
    .find(r => r.id === 'travel');
  ok(paidTravel && paidTravel.date === PAYDAY
      && near(paidTravel.movement, -EXTRA),
    'already paid shows the extra payment on the payday posting date as money out');
  ok(!(action.thisPaydayDue || []).some(r => r.id === 'travel'),
    'covered Travel Visa min leaves still due');
  ok((action.thisPaydayPaid.inflows || []).some(r => r.id === 'payroll'
      && near(r.movement, PAYROLL)),
    'Seaspan glance movement is money in even when the packet actual is a credit-signed debit');
  ok(!(action.thisPaydayPaid.inflows || []).some(r => r.id === 'childBenefit'),
    'mid-period child benefit is still not dumped onto this payday');

  const control = F.currentPeriodAction(syntheticPlan(), AS_OF, {
    targetBuffer: 0,
    representedEvents: syntheticPlan().opening.representedEvents,
  });
  ok((control.thisPaydayDue || []).some(r => r.id === 'travel'),
    'without an identified card payment the min stays still due');

  const composer = loadComposer();
  const advice = F.recommend(plan, AS_OF, opts);
  const glance = defaultGlance(composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  }));
  ok(!/Travel Visa minimum/.test(glance),
    'payday-cycle waterfall does not list the previous-cycle Aug 26 Travel Visa min');
  ok(!/Travel Visa minimum · Aug 26 · still due/.test(glance),
    'covered previous-cycle min is not still due on this payday window');
}

console.log('\n=== page prints Forecast; it does not date-filter ===');
{
  const planSrc = read('public/plan.js');
  const paidFn = /function alreadyPaidRowsHtml\([\s\S]*?\n\}/.exec(planSrc);
  const dueFn = /function stillDueItems\([\s\S]*?\n\}/.exec(planSrc);
  ok(paidFn && /thisPaydayPaid/.test(paidFn[0]) && !/row\.date\s*===/.test(paidFn[0]),
    'alreadyPaidRowsHtml copies thisPaydayPaid and does not filter dates');
  ok(dueFn && /thisPaydayDue/.test(dueFn[0]) && !/frequency === 'once'/.test(dueFn[0]),
    'stillDueItems copies thisPaydayDue and does not classify once stubs');
}

console.log('\n=== cancelled CMAW dues are gone from Plan/Forecast bills ===');
{
  const plan = data.plan;
  const outstandingId = 'uniondues-aug15-outstanding';
  ok(!(plan.bills || []).some(b => b.id === 'uniondues' || b.id === outstandingId
      || /cmaw/i.test(b.label || '')),
    'canonical bills have no CMAW or uniondues row');
  const asOf = data.meta.asOf;
  const events = F.expandEvents(plan, '2026-08-16', '2027-08-15', {});
  const cmaw = events.filter(e => e.id === 'uniondues' || e.id === outstandingId
    || /cmaw|union dues/i.test(e.label || ''));
  ok(cmaw.length === 0, 'Forecast emits no CMAW cash event, including August',
    cmaw.map(e => e.id + '@' + e.date).join(','));
  function monthlyFifteenths(startIso, endIso) {
    const out = [];
    let [year, month] = startIso.split('-').map(Number);
    const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    const pad = n => String(n).padStart(2, '0');
    for (;;) {
      const iso = year + '-' + pad(month) + '-' + pad(Math.min(15, daysInMonth(year, month)));
      if (iso > endIso) break;
      if (iso >= startIso) out.push(iso);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    return out;
  }
  const fifteenths = monthlyFifteenths('2026-08-15', '2027-08-15');
  ok(fifteenths[0] === '2026-08-15' && fifteenths.length >= 12,
    'independent calendar still lists the 15ths');
  ok(!fifteenths.some(iso => events.some(e => e.date === iso && near(-e.amount, 25)
      && /cmaw|union/i.test((e.id || '') + (e.label || '')))),
    'none of those 15ths is a $25 CMAW cash event');
  ok(!/uniondues-aug15-outstanding/.test(JSON.stringify(plan.bills)),
    'the posting-unknown stub id is gone from bills');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
