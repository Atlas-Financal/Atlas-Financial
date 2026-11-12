'use strict';
/* Plan payday operating sheet — six glance answers from incumbent Forecast.
 *
 * Independent identities prove the page copies Forecast.recommend fields
 * and does not mix overdraft into spendable cash, invent a second planner,
 * or publish leftover remainder as the next move. Synthetic cents are
 * unlike live household figures.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const C = require('../public/forecast-chequing.js');
const OA = require('../scripts/operating-answer.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

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
    `${source}\n({ operatingSurfaceHtml, mustLeaveHtml, alreadyPaidHtml, paydayAllocationSummaryHtml, futureGravityHtml, weeklyCapView, money, money2 });`,
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
  // NOTE (Slice 6 repair, PR #444): "true surplus" was removed from this
  // ban. It is not a field name -- it is inside Forecast's published
  // household-facing strategy reason, which the Slice 6 Systems Review
  // explicitly requires to stay visible on this surface (the unknown-
  // pending uncertainty statement itself contains the phrase). Field
  // names and settlement code words remain banned.
  return /paydayAllocation|currentPeriodAction|Forecast\.recommend|representedEvents|unverified-settlement|owner-fact/.exec(text)
    || /\bunverified\b|\brepresented\b|\boverlay\b|\bForecast\b|\bAtlas\b/i.exec(text)
    || /posting unknown/i.exec(text)
    || /(?<![A-Za-z])asOf(?![A-Za-z])/.exec(text);
}

function liveGlance(html) {
  const start = html.indexOf('data-live-current-balance');
  if (start < 0) return '';
  const end = html.indexOf('</div>', start);
  return html.slice(start, end < 0 ? html.length : end + 6);
}

function question(html, number) {
  const start = html.indexOf(`data-operating-question="${number}"`);
  if (start < 0) return '';
  const end = html.indexOf('data-operating-question=', start + 1);
  const certainty = html.indexOf('data-operating-certainty', start + 1);
  const allocation = html.indexOf('data-payday-allocation-details', start + 1);
  let stop = html.length;
  if (end >= 0) stop = end;
  if (certainty >= 0 && certainty < stop) stop = certainty;
  if (allocation >= 0 && allocation < stop) stop = allocation;
  return html.slice(start, stop);
}

function currentAdvice() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  const advice = F.recommend(plan, asOf, {
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
  });
  return { plan, asOf, advice };
}

function independentSpendable(plan, asOf) {
  const opening = F.startingCashAmount(plan);
  const todayEvents = F.expandEvents(plan, asOf, asOf, {});
  let todayIncome = 0;
  for (const e of todayEvents) {
    if (e.kind === 'income') todayIncome += e.amount;
  }
  return Math.round((opening + todayIncome) * 100) / 100;
}

const composer = loadComposer();

console.log('=== 1. one spendable cash figure, no overdraft in the number ===');
{
  const { plan, asOf, advice } = currentAdvice();
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const live = liveGlance(html);
  const independent = independentSpendable(plan, asOf);
  const liveCash = advice.paydayAllocation.liveCurrentBalance != null
    ? advice.paydayAllocation.liveCurrentBalance
    : F.startingCashAmount(plan);
  const independentHub = Math.round(((plan.startingCash && plan.startingCash.breakdown) || [])
    .filter(r => r && r.id === 'chequing-a')
    .reduce((s, r) => s + (Number(r.value) || 0), 0) * 100) / 100;
  const independentChequing = Math.round(((plan.startingCash && plan.startingCash.breakdown) || [])
    .filter(r => r && (r.id === 'chequing-a' || r.id === 'chequing-b'))
    .reduce((s, r) => s + (Number(r.value) || 0), 0) * 100) / 100;
  const chequing = C.chequingAvailability(plan, data.revolvingExtra, data.liveOverlay);
  ok(near(advice.paydayAllocation.available, independent),
    'Forecast.paydayAllocation.available independently equals spendable opening plus same-day income');
  ok(near(liveCash, independentHub) && !near(independentHub, independentChequing),
    'live Current Balance independently equals BILLS ACCOUNT hub cash, not Chequing A + Chequing B');
  ok(live.includes(composer.money2(liveCash)),
    'live Current Balance is posted planning-hub cash');
  ok(/data-live-current-balance/.test(live) && /Current Balance/.test(live),
    'live cash is labelled Current Balance, not credit');
  ok(chequing.status === 'available' && !near(chequing.available, independent),
    'chequingAvailability (which includes unused overdraft) is a different number');
  ok(!live.includes(composer.money2(chequing.available)),
    'Plan cash does not publish the overdraft-inclusive chequingAvailability figure');
  ok((html.match(/data-live-current-balance-amount/g) || []).length === 1,
    'the payday sheet publishes exactly one live Current Balance amount');
  const liveHit = bannedOnGlance(html);
  ok(!liveHit, 'live default glance has no Forecast field names or settlement code words',
    liveHit && liveHit[0]);
}

console.log('\n=== 2. recommend weekly cap, never a fake $0/week yes ===');
{
  const { advice } = currentAdvice();
  const healthy = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
  });
  const q4 = question(healthy, '04');
  ok(/Bills/.test(q4) && /data-payday-period-bills/.test(q4),
    'Q4 on the default view is bills');
  ok(!/data-spend-decision="amount"/.test(healthy)
    && !healthy.includes(`${composer.money(advice.weekly)} / week`),
    'feasible recommend weekly is not dumped onto the default Plan');

  const blocked = JSON.parse(JSON.stringify(advice));
  blocked.mode = 'infeasible';
  blocked.weekly = 0;
  blocked.infeasible = {
    label: 'Synthetic protected cost', date: '2026-10-02', shortfall: 321.11,
  };
  blocked.funding = { feasible: false, shortfall: 621.11 };
  const infeasibleHtml = composer.operatingSurfaceHtml({
    advice: blocked, weekly: 0, recommended: 0,
  });
  const infeasibleQ6 = question(infeasibleHtml, '06');
  ok(/Household budget/.test(infeasibleQ6),
    'infeasible recommend does not replace household budget with a weekly yes');
  ok(!/data-spend-decision="amount"/.test(infeasibleHtml),
    'infeasible recommend does not publish a weekly yes');
  ok(!/\$0 \/ week/.test(infeasibleHtml) && !/Spend at most \$0/.test(infeasibleHtml),
    'infeasible weekly = 0 is not a fake $0/week yes');
  const capCopy = composer.weeklyCapView(blocked);
  ok(capCopy.hasFeasibleCap === false
      && /Synthetic protected cost/.test(capCopy.reason)
      && capCopy.reason.includes(composer.money2(321.11)),
    'weeklyCapView still names the failing constraint and shortfall');
  ok(!/data-operating-warnings/.test(infeasibleHtml)
      && !/Synthetic protected cost/.test(infeasibleHtml)
      && !infeasibleHtml.includes(composer.money2(321.11))
      && !/There is no feasible weekly cap/.test(infeasibleHtml),
    'the usable Plan does not print that infeasible copy as an advisory');

  const modeOnly = JSON.parse(JSON.stringify(advice));
  modeOnly.mode = 'infeasible';
  modeOnly.weekly = 0;
  modeOnly.infeasible = null;
  const modeOnlyHtml = composer.operatingSurfaceHtml({
    advice: modeOnly, weekly: 0, recommended: 0,
  });
  const modeCopy = composer.weeklyCapView(modeOnly);
  ok(/no safe weekly spend/i.test(modeCopy.reason),
    'weeklyCapView still refuses a weekly yes when mode is infeasible without a fail object');
  ok(!/\$0 \/ week/.test(modeOnlyHtml)
      && !/data-operating-warnings/.test(modeOnlyHtml)
      && !/no safe weekly spend/i.test(modeOnlyHtml),
    'infeasible mode without a fail object still refuses a weekly yes and prints no advisory');
}

console.log('\n=== 3. extra debt only from paydayAllocation surplus ===');
{
  const { advice } = currentAdvice();
  const zeroAdvice = JSON.parse(JSON.stringify(advice));
  zeroAdvice.paydayAllocation.extraDebt.allocated = 0;
  zeroAdvice.paydayAllocation.extraDebt.target = { id: 'high', label: 'Synthetic high card' };
  for (const period of (zeroAdvice.defaultView && zeroAdvice.defaultView.calendarPeriods) || []) {
    if (!period) continue;
    if (period.extraDebt) period.extraDebt.allocated = 0;
    if (period.firstCard) period.firstCard.extraThisPayday = 0;
  }
  if (zeroAdvice.defaultView && zeroAdvice.defaultView.firstCard) {
    zeroAdvice.defaultView.firstCard.extraThisPayday = 0;
  }
  const zeroHtml = composer.operatingSurfaceHtml({
    advice: zeroAdvice, weekly: zeroAdvice.weekly, recommended: zeroAdvice.weekly,
  });
  ok(!question(zeroHtml, '08') && !/data-payday-first-card/.test(zeroHtml),
    'the default Plan prints no extra-repayment row after Balance After Deductions');
  ok(!/Pay extra/.test(zeroHtml) && !/Put \$40/.test(zeroHtml),
    'a named target is not a pay instruction when allocated is $0');

  const plusAdvice = JSON.parse(JSON.stringify(advice));
  plusAdvice.paydayAllocation.extraDebt.allocated = 40;
  plusAdvice.paydayAllocation.extraDebt.target = { id: 'high', label: 'Synthetic high card' };
  if (plusAdvice.defaultView && plusAdvice.defaultView.firstCard) {
    plusAdvice.defaultView.firstCard.extraThisPayday = 40;
    plusAdvice.defaultView.firstCard.label = 'Synthetic high card';
  }
  for (const period of (plusAdvice.defaultView && plusAdvice.defaultView.calendarPeriods) || []) {
    if (!period) continue;
    if (period.extraDebt) {
      period.extraDebt.allocated = 40;
      period.extraDebt.target = { id: 'high', label: 'Synthetic high card' };
    }
    if (period.firstCard) {
      period.firstCard.extraThisPayday = 40;
      period.firstCard.label = 'Synthetic high card';
    }
  }
  const plusHtml = composer.operatingSurfaceHtml({
    advice: plusAdvice, weekly: plusAdvice.weekly, recommended: plusAdvice.weekly,
  });
  ok(/Extra on focus debt/.test(plusHtml)
      && /Optional extra on Synthetic high card/.test(plusHtml)
      && plusHtml.includes(composer.money2(40)),
    'a positive extraDebt allocation prints its Forecast-owned amount and target label on the default Plan shell');
  ok(!/\[object Object\]/.test(plusHtml),
    'the printed extra-debt target is the Forecast-published label, never a raw object');
  const activePeriod = ((plusAdvice.defaultView && plusAdvice.defaultView.calendarPeriods) || [])
    .find(p => p && p.role === 'active');
  ok(activePeriod && activePeriod.extraDebt && near(activePeriod.extraDebt.allocated, 40)
      && activePeriod.extraDebt.target && activePeriod.extraDebt.target.label === 'Synthetic high card',
    'the extraDebt facility and amount remain on the Forecast period the page reads');
}

console.log('\n=== 4. majorPlans set-aside this payday vs later ON TRACK ===');
{
  const html = composer.futureGravityHtml({
    knowledge: { days: 400 },
    majorPlans: [
      {
        id: 'later', label: 'Later required cost', when: 'Nov 2026',
        need: 2000, remaining: 0, verdict: 'ON TRACK',
        confidence: 'estimated', flexibility: 'required',
      },
      {
        id: 'now', label: 'Near purchase', when: null, date: '2026-09-20',
        need: 500, remaining: 120, verdict: 'AT RISK',
        confidence: 'confirmed', flexibility: 'required',
      },
    ],
    paydayAllocation: {
      futureCosts: [
        { id: 'later', allocated: 0 },
        { id: 'now', allocated: 88.5, label: 'Near purchase' },
      ],
      optional: [],
      unresolved: [],
    },
  });
  const sheet = composer.operatingSurfaceHtml({
    advice: {
      weekly: 90, mode: 'ok',
      majorPlans: [
        {
          id: 'later', label: 'Later required cost', when: 'Nov 2026',
          need: 2000, remaining: 0, verdict: 'ON TRACK',
          confidence: 'estimated', flexibility: 'required',
        },
        {
          id: 'now', label: 'Near purchase', when: null, date: '2026-09-20',
          need: 500, remaining: 120, verdict: 'AT RISK',
          confidence: 'confirmed', flexibility: 'required',
        },
      ],
      paydayAllocation: {
        available: 100, remainder: 1.14, extraDebt: { allocated: 0 },
        obligations: { items: [] },
        futureCosts: [
          { id: 'later', allocated: 0 },
          { id: 'now', allocated: 88.5, label: 'Near purchase' },
        ],
        optional: [], unresolved: [], risks: [],
      },
    },
    weekly: 90, recommended: 90,
  });
  const glance = defaultGlance(sheet);
  ok(!/Later required cost · ON TRACK/.test(glance),
    'ON TRACK future costs are not a default-view dump');
  ok(!/See later bills and big purchases/.test(sheet)
    && !/Later required cost/.test(sheet),
    'later-bills inventory dump stays off the default Plan');
}

console.log('\n=== 5. still due uses kitchen-counter labels, not settlement code words ===');
{
  const html = composer.mustLeaveHtml({
    obligations: {
      wanted: 50, allocated: 50, shortfall: 0, items: [
        {
          id: 'travel', label: 'Travel Visa minimum', date: '2026-08-26',
          amount: 17, allocated: 17, settlement: 'unverified', confidence: 'confirmed',
        },
        {
          id: 'tdfees', label: 'TD account fees (two accounts)', date: '2026-08-30',
          amount: 35.9, allocated: 35.9, settlement: 'upcoming', confidence: 'confirmed',
        },
      ],
    },
  });
  ok(/Travel Visa minimum · Aug 26 · still due/.test(html),
    'unposted Travel Visa stays still due without an invented payee');
  ok(/TD account fees \(two accounts\) · Aug 30 · still due/.test(html),
    'TD fees stay still due without an invented payee');
  ok(!/unverified/.test(html) && !/represented/.test(html),
    'still-due glance does not print settlement code words');
}

console.log('\n=== 5b. leftover lists earned posted actuals, not an invented spend list ===');
{
  const action = {
    mode: 'between-paydays',
    thisPayday: '2026-08-28',
    thisPaydayPaid: {
      payday: '2026-08-28',
      inflows: [],
      bills: [
        {
          id: 'mortgage', label: 'Mortgage', date: '2026-08-28',
          planned: 1600, actual: 1234.56, remaining: 0,
          settlement: 'represented', confidence: 'confirmed',
          payingAccount: 'chequing-a',
          payerLabel: 'BILLS ACCOUNT (Chequing A)',
        },
      ],
    },
    thisPaydayDue: [
      {
        id: 'fit4less', label: 'Fit4Less membership', date: '2026-08-28',
        planned: 11.54, amount: 11.54, remaining: 11.54,
        settlement: 'unverified', confidence: 'confirmed',
        payingAccount: 'chequing-a',
        payerLabel: 'BILLS ACCOUNT (Chequing A)',
      },
    ],
    bills: [
      {
        id: 'mortgage', label: 'Mortgage', date: '2026-08-28',
        planned: 1600, actual: 1234.56, remaining: 0,
        settlement: 'represented', confidence: 'confirmed',
      },
      {
        id: 'fit4less', label: 'Fit4Less membership', date: '2026-08-28',
        planned: 11.54, actual: null, remaining: 11.54,
        settlement: 'unverified', confidence: 'confirmed',
      },
    ],
  };
  const leave = composer.mustLeaveHtml({
    obligations: {
      wanted: 11.54, allocated: 11.54, shortfall: 0, items: [
        {
          id: 'fit4less', label: 'Fit4Less membership', date: '2026-08-28',
          amount: 11.54, allocated: 11.54, settlement: 'unverified', confidence: 'confirmed',
        },
      ],
    },
  }, action);
  ok(/Fit4Less membership · Aug 28 · still due/.test(leave)
    && !/Mortgage/.test(leave) && !/BILLS ACCOUNT/i.test(leave),
    'still due lists unposted Fit4Less and not the paid mortgage or paying account');
  ok(/Still needs to leave/.test(leave) && /data-payday-still-due/.test(leave),
    'still due is labelled as money that still needs to leave');
  const already = composer.alreadyPaidHtml(action);
  ok(/data-payday-already-paid/.test(already) && /Mortgage · Aug 28 · paid/.test(already)
      && !/BILLS ACCOUNT/i.test(already),
    'already paid lists the paid mortgage without paying account');
  ok(/Already paid from this payday/.test(already),
    'already paid is labelled paid, not leftover to pay');
  ok(/\$1,234\.56/.test(already),
    'paid mortgage uses Forecast actual, not a page-invented total');
  ok(!/Fit4Less membership · Aug 28 · paid/.test(already),
    'unposted Fit4Less is not presented as paid');
  ok(/Payroll — Seaspan/.test(composer.alreadyPaidHtml({
    thisPaydayPaid: {
      payday: '2026-08-28',
      inflows: [{
        id: 'payroll', label: 'Payroll — Seaspan', date: '2026-08-28',
        planned: 1000, actual: 1000, settlement: 'represented',
      }],
      bills: action.thisPaydayPaid.bills,
    },
  })) && /Payroll — Seaspan · Aug 28 · in/.test(composer.alreadyPaidHtml({
    thisPaydayPaid: {
      payday: '2026-08-28',
      inflows: [{
        id: 'payroll', label: 'Payroll — Seaspan', date: '2026-08-28',
        planned: 1000, actual: 1000, settlement: 'represented',
      }],
      bills: [],
    },
  })),
    'already paid prints represented payday income as in');
  const leftover = composer.paydayAllocationSummaryHtml({
    lines: [{ key: 'obligations', kind: 'obligations', label: 'Bills', amount: 11.54 }],
    remainder: 88.12,
    obligations: { allocated: 11.54, wanted: 11.54, shortfall: 0, items: [] },
    essentials: { allocated: 0, wanted: 0, shortfall: 0 },
    extraDebt: { allocated: 0 },
    futureCosts: [],
    mode: 'between-paydays',
    payday: '2026-09-11',
  }, action);
  ok(/Left after that/.test(leftover) && /Mortgage · Aug 28 · paid/.test(leftover),
    'folded reservation list still names paid actuals beside leftover cash');
}

console.log('\n=== 6. operating-answer copies Forecast; page does not recalculate ===');
{
  const oa = read('scripts/operating-answer.js');
  ok(/Forecast\.recommend/.test(oa) && /paydayAllocation\.available/.test(oa),
    'operating-answer.js asks Forecast.recommend and copies paydayAllocation.available');
  ok(!/function paydayAllocation|function currentPeriodAction|function recommend\(/.test(oa),
    'operating-answer.js does not reimplement Forecast authorities');
  const { plan, asOf, advice } = currentAdvice();
  const packet = OA.fromRefreshedState({
    plan, debts: data.debts, revolvingExtra: data.revolvingExtra,
    meta: { asOf },
  }, { mode: 'canonical' });
  ok(near(packet.moneyAvailable.value, advice.paydayAllocation.available),
    'operating-answer moneyAvailable copies Forecast.paydayAllocation.available');
  ok(near(packet.currentSpendingPermission.weekly, advice.weekly),
    'operating-answer weekly copies Forecast.recommend.weekly');
  ok(packet.extraDebtAllocation.allocated === advice.paydayAllocation.extraDebt.allocated,
    'operating-answer extra debt copies Forecast.paydayAllocation.extraDebt');

  const planSrc = read('public/plan.js');
  const fn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/\bForecast\.[A-Za-z]+\s*\(/.test(fn[0]),
    'operatingSurfaceHtml calls no Forecast function');
  ok(fn && !/\.reduce\(|monthlyFromWeekly|projectDebts|fundingSequence/.test(fn[0]),
    'the payday sheet does not total, convert, or walk debts');
}

console.log('\n=== leftover remainder is not the next move ===');
{
  const html = composer.operatingSurfaceHtml({
    advice: {
      weekly: 90,
      mode: 'ok',
      currentPeriodAction: {
        mode: 'between-paydays', nextPayday: '2026-09-15',
        todayActions: [], bills: [], noMovementToday: true,
        remainingClaim: 'unavailable',
      },
      paydayAllocation: {
        available: 100, remainder: 1.14, extraDebt: { allocated: 0 },
        obligations: { items: [] }, futureCosts: [], unresolved: [], risks: [],
      },
      majorPlans: [],
    },
    weekly: 90, recommended: 90,
  });
  const q6 = question(html, '06');
  ok(!/This week's spend is \$90 until September 15/.test(html)
      && !/data-spend-decision=/.test(html),
    'with no pay/extra/set-aside, this week\'s spend is not dumped onto the default Plan');
  ok(!/\$1\.14/.test(q6) && !/LEFT OVER/.test(q6),
    'allocation remainder is not the first-card instruction');
  ok(!/is due/.test(html) || !/No payment or transfer is required today/.test(html),
    'next move is not a due-date warning that also says do not pay');
  const hit = bannedOnGlance(html);
  ok(!hit, 'default glance has no Forecast field names or settlement code words',
    hit && hit[0]);
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
