'use strict';
/* AF-OPERATE-02 — the homepage leads with five ordered operating answers,
 * composed from incumbent Forecast outputs. No page-side financial arithmetic.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const grab = (src, re, label) => {
    const match = re.exec(src);
    if (!match) throw new Error('missing ' + label);
    return match[0];
  };
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
    `${source}\n({ operatingSurfaceHtml, paydayCoverageNote, money2 });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

function currentResult() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  const opts = {
    scenario: 'expected',
    targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: 0,
    disabled: [],
    fundingSources: plan.funding && plan.funding.options,
    debts: data.debts,
    extraFacilities: data.revolvingExtra,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    periods,
    paypalPerMonth: data.paypal && data.paypal.perMonth,
  };
  const advice = F.recommend(plan, asOf, opts);
  const debtProjection = F.projectDebts(plan, data.debts, asOf,
    Object.assign({}, advice.simOptions, {
      weeklyVariable: advice.weekly,
      extraFacilities: data.revolvingExtra,
      extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    }));
  return { plan, asOf, advice, debtProjection };
}

console.log('=== homepage order and secondary detail ===');
{
  const html = read('public/index.html');
  const firstSection = /<section id="([^"]+)"/.exec(html);
  ok(firstSection && firstSection[1] === 'operating-surface',
    'the decision-first operating surface is the first homepage section');
  ok(html.indexOf('id="operating-surface"') < html.indexOf('id="payday-answer"')
    && html.indexOf('id="payday-answer"') < html.indexOf('id="outlook"'),
  'diagnostic mounts follow the operating surface');
  const detail = /<section id="payday-answer"[\s\S]*?<\/section>/.exec(html);
  ok(detail && /hidden/.test(detail[0])
    && !/View full current-period worksheet/.test(detail[0]),
  'the current-period worksheet is not on the default Plan surface');
  ok(!/Why \/ Road ahead/.test(html)
    && /id="road-ahead"[^>]*hidden/.test(html),
    'Why / Road ahead is not a default Plan disclosure');
  for (const id of ['payday-answer-body', 'status-band', 'nextmove-card', 'cap-headline',
    'major-plans-list', 'risk-list', 'hero-ledger', 'balance-history']) {
    ok((html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1,
      `existing diagnostic mount ${id} remains exactly once`);
  }
}

console.log('\n=== seven ordered payday-sheet questions ===');
{
  const { plan, asOf, advice, debtProjection } = currentResult();
  const composer = loadComposer();
  const rendered = composer.operatingSurfaceHtml({
    plan, asOf, advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay,
  });
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

  // Check headings, not repeated words in the account caption or details.
  const waterfall = rendered.slice(rendered.indexOf('data-live-current-balance'));
  let previous = -1;
  for (const prompt of prompts) {
    const at = prompt === 'Current Balance'
      ? waterfall.indexOf('<p class="live-current-balance-label">Current Balance</p>')
      : waterfall.indexOf(`data-operating-prompt="${prompt}"`);
    ok(at > previous, `${prompt} appears in the required order`);
    previous = at;
  }
  const snapshotQs = 6;
  ok(/data-live-current-balance/.test(rendered)
      && (rendered.match(/data-operating-question=/g) || []).length === snapshotQs
      && !/data-operating-prompt="Current Balance"/.test(rendered)
      && !/data-operating-prompt="Opening balance"/.test(rendered),
    'the default surface prints live Current Balance outside the payday snapshot');
  ok(!/Extra credit-card repayment|Balance after debt repayment|Big-purchase savings|Projected ending balance/.test(rendered),
    'the default surface stops at Balance After Deductions');

}

console.log('\n=== every displayed financial answer traces to incumbents ===');
{
  const { plan, advice, debtProjection } = currentResult();
  const composer = loadComposer();
  const target = advice.paydayAllocation.extraDebt.target;
  const rendered = composer.operatingSurfaceHtml({
    plan, asOf: data.meta.asOf, advice, weekly: advice.weekly,
    recommended: advice.weekly, liveOverlay: data.liveOverlay,
  });
  const independentCash = (plan.startingCash.breakdown || [])
    .reduce((sum, row) => {
      if (!row || (row.id !== 'chequing-a' && row.id !== 'chequing-b')) return sum;
      return sum + Number(row.value || 0);
    }, 0);
  const independentHub = (plan.startingCash.breakdown || [])
    .reduce((sum, row) => {
      if (!row || row.id !== 'chequing-a') return sum;
      return sum + Number(row.value || 0);
    }, 0);

  ok(near(advice.paydayAllocation.available, independentCash),
    'incumbent payday available reconciles to the independent chequing opening plus same-day income');
  ok(rendered.includes(composer.money2(independentHub)),
    'the displayed Current Balance is independently the planning-hub cash');
  ok(/Household budget/.test(rendered) && /Current Balance/.test(rendered)
      && /Balance After Deductions/.test(rendered)
      && !/Extra credit-card repayment/.test(rendered)
      && !/Projected ending balance/.test(rendered),
    'the default waterfall publishes the operating plan steps through Balance After Deductions');

  ok(!rendered.includes(`$${advice.weekly.toLocaleString('en-CA')} / week`),
    'the weekly-cap diagnostic is not on the default operating surface');
  ok(!/See how payday is reserved/.test(rendered)
      && !/View full current-period worksheet/.test(rendered),
    'allocation-sheet and worksheet disclosures stay off the default Plan');
  const extra = advice.paydayAllocation.extraDebt.allocated;
  ok(typeof extra === 'number' && isFinite(extra)
      && (extra === 0 || (target && target.label)),
    'Forecast.paydayAllocation.extraDebt still decides the extra-debt amount and target');
  ok(!/Put \$/.test(rendered) && !/Pay extra/.test(rendered)
      && !rendered.includes('Extra debt money this payday goes to')
      && !/data-payday-first-card/.test(rendered),
    'the default Plan prints no extra-repayment instruction or card row after the household-budget boundary');
  const remainingUnavailable = !advice.currentPeriodAction
    || advice.currentPeriodAction.remainingClaim === 'unavailable';
  const coverageCopy = composer.paydayCoverageNote(advice.currentPeriodAction);
  if (remainingUnavailable) {
    ok(typeof coverageCopy === 'string' && coverageCopy.length > 0
        && !rendered.includes(coverageCopy)
        && !/data-operating-warnings/.test(rendered),
      'unavailable remaining is not printed as a coverage warning on the default Plan');
  }
  for (const risk of advice.paydayAllocation.risks || []) {
    ok(typeof risk.reason === 'string' && risk.reason.length > 0
        && typeof risk.shortfall === 'number'
        && !rendered.includes(risk.reason)
        && !/data-operating-warnings/.test(rendered),
      `funding limitation remains on Forecast paydayAllocation.risks ${risk.id} and is not printed`);
  }
}

console.log('\n=== Q4 follows the incumbent extra-debt allocation ===');
{
  const { advice } = currentResult();
  const composer = loadComposer();
  const target = { label: 'Synthetic incumbent debt target', confidence: 'verified' };
  const zeroAdvice = JSON.parse(JSON.stringify(advice));
  zeroAdvice.paydayAllocation.extraDebt.allocated = 0;
  zeroAdvice.paydayAllocation.extraDebt.target = target;
  const zero = composer.operatingSurfaceHtml({
    advice: zeroAdvice, liveOverlay: data.liveOverlay,
  });
  ok(!zero.includes('No extra debt this payday.')
    && /data-operating-question="05"/.test(zero),
    'zero extra still keeps the leftover-after-budget question');
  ok(!zero.includes('$0.00 extra principal allocated this payday'),
    'zero leftover after bills does not print a fake extra-principal payment amount on the glance');
  ok(!zero.includes(`Pay extra`) && !zero.includes(`Extra debt money this payday goes to ${target.label}`),
    'zero allocation does not say the target receives leftover cash');

  const positiveAdvice = JSON.parse(JSON.stringify(advice));
  positiveAdvice.paydayAllocation.extraDebt.allocated = 25;
  positiveAdvice.paydayAllocation.extraDebt.target = target;
  if (positiveAdvice.defaultView && positiveAdvice.defaultView.firstCard) {
    positiveAdvice.defaultView.firstCard.extraThisPayday = 25;
    positiveAdvice.defaultView.firstCard.label = target.label;
  }
  const periods = (positiveAdvice.defaultView && positiveAdvice.defaultView.calendarPeriods) || [];
  for (const period of periods) {
    if (period && period.firstCard) {
      period.firstCard.extraThisPayday = 25;
      period.firstCard.label = target.label;
    }
  }
  const positive = composer.operatingSurfaceHtml({
    advice: positiveAdvice, liveOverlay: data.liveOverlay,
  });
  ok(positive.includes(target.label) && /Extra on focus debt/.test(positive)
      && positive.includes(composer.money2(25)),
    'positive extra repayment prints its Forecast-owned target and amount on the default Plan shell');
  ok(!/\[object Object\]/.test(positive),
    'the printed extra-debt target is the Forecast-published label, never a raw object');
  ok(!/data-payday-first-card/.test(positive),
    'the old incumbent first-card row stays off the default Plan');
  const positiveActive = periods.find(p => p && p.role === 'active');
  ok(positiveActive && positiveActive.firstCard
      && positiveActive.firstCard.extraThisPayday === 25
      && positiveActive.firstCard.label === target.label,
    'the incumbent target and allocated amount remain on the Forecast period the page reads');
}

console.log('\n=== page remains a renderer, not a financial authority ===');
{
  const planSrc = read('public/plan.js');
  const fn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(!!fn, 'the operating-surface formatter is a bounded readable function');
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'the formatter calls no Forecast function and consumes the one result passed to it');
  ok(fn && !/\.reduce\(|monthlyFromWeekly|projectDebts|majorPlans|fundingSequence/.test(fn[0]),
    'the formatter contains no page-side totals, conversions, debt walk, or future-plan calculation');
  const remount = /^function budgetRemount\([\s\S]*?\n\}/m.exec(planSrc);
  ok(/budgetRemount\(operatingMount, surfaceCtx\)/.test(planSrc)
    && remount && /mount\.innerHTML = budgetSurfaceHtml\(ctx\)/.test(remount[0])
    && !/\bForecast\.|\.reduce\(|monthlyFromWeekly|projectDebts|fundingSequence/.test(remount[0])
    && /advice,/.test(planSrc)
    && !/extraDebtTarget: debtProj\.byId/.test(planSrc),
  'renderPlan passes incumbent context through the active renderer remount without financial calculation or a page-selected target');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
