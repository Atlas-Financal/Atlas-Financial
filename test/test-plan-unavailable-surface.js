'use strict';
/* Page-level unavailable operating state. When liveOverlay.operatingPlan is
 * unavailable, the Plan surface must fail closed at the page, not by
 * repeating the dated waterfall with eleven unavailable cards.
 *
 * Uses the incumbent dated opening on this main (data.json) plus the same
 * fail-closed overlay fixture path as test-live-plan.js. Independent cash:
 * the startingCash breakdown sum still includes designated savings as
 * reserve evidence (L-002); Forecast dated currentBalance / printed last
 * trusted opening is household chequing only. Live overlay cents are not
 * the specification (L-006). Forecast remains the calculation authority.
 *
 * `node test/test-plan-unavailable-surface.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));

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
    grab(planSrc, /^const OPERATING_SURFACE_LEDE = .*$/m, 'OPERATING_SURFACE_LEDE'),
    grab(planSrc, /^function applyUnavailableOperatingChrome\([\s\S]*?\n\}$/m, 'applyUnavailableOperatingChrome'),
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
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
    grab(planSrc, /^function periodBillsHtml\([\s\S]*?\n\}$/m, 'periodBillsHtml'),
    grab(planSrc, /^function householdBudgetHtml\([\s\S]*?\n\}$/m, 'householdBudgetHtml'),
    grab(planSrc, /^function budgetDigestHtml\([\s\S]*?\n\}$/m, 'budgetDigestHtml'),
    grab(planSrc, /^function firstCardHtml\([\s\S]*?\n\}$/m, 'firstCardHtml'),
    grab(planSrc, /^function otherCardsHtml\([\s\S]*?\n\}$/m, 'otherCardsHtml'),
    grab(planSrc, /^function bigPurchasesHtml\([\s\S]*?\n\}$/m, 'bigPurchasesHtml'),
    grab(planSrc, /^function paydayAllocationSummaryHtml\([\s\S]*?\n\}$/m, 'paydayAllocationSummaryHtml'),
    grab(planSrc, /^function unavailableOperatingSurfaceHtml\([\s\S]*?\n\}$/m, 'unavailableOperatingSurfaceHtml'),
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
    `${source}\n({ operatingSurfaceHtml, unavailableOperatingSurfaceHtml, refreshTrustHtml, applyUnavailableOperatingChrome, money2, fmtDateLong });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

function independentDatedCash(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return Math.round(rows.reduce((s, r) => s + (Number(r && r.value) || 0), 0) * 100) / 100;
}

function independentChequing(plan) {
  const rows = (plan && plan.startingCash && plan.startingCash.breakdown) || [];
  return Math.round(rows.reduce((s, r) => {
    if (!r || (r.id !== 'chequing-a' && r.id !== 'chequing-b')) return s;
    return s + (Number(r.value) || 0);
  }, 0) * 100) / 100;
}

function independentHub(plan) {
  const rows = ((plan && plan.startingCash && plan.startingCash.breakdown) || [])
    .filter(r => r && r.id === 'chequing-a');
  if (rows.length !== 1) return null;
  const value = Number(rows[0].value);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function independentBell(plan) {
  return ((plan && plan.bills) || []).find(row => row && row.id === 'bell') || null;
}

function count(html, re) {
  return (String(html || '').match(re) || []).length;
}

function chromeDoc() {
  const store = {
    kicker: { textContent: 'This payday' },
    heading: { textContent: 'This payday' },
    lede: { textContent: 'Current Balance, bills this pay period, household budget, the card to pay extra toward, other cards, and big purchases — each with leftover after that step.' },
    summary: { textContent: 'View full current-period worksheet' },
  };
  const surface = {
    querySelector(sel) {
      if (sel === '.kicker') return store.kicker;
      if (sel === 'h1') return store.heading;
      if (sel === '.lede') return store.lede;
      return null;
    },
  };
  const payday = {
    querySelector(sel) {
      if (sel === 'summary') return store.summary;
      return null;
    },
  };
  return {
    store,
    getElementById(id) {
      if (id === 'operating-surface') return surface;
      if (id === 'payday-answer') return payday;
      return null;
    },
  };
}

const liveData = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const composer = loadComposer();
const OPENING = String(liveData.plan.opening.asOf);
const DATED_CASH = independentDatedCash(liveData.plan);
const CHEQUING_CASH = independentChequing(liveData.plan);
const HUB_CASH = independentHub(liveData.plan);
const BELL = independentBell(liveData.plan);
const NOTE = 'Current plan unavailable. The dated opening is stale.';

console.log('=== 1. incumbent dated opening is still Aug 19 / $939.62 ===');
{
  ok(OPENING === '2026-08-19',
    'canonical opening on this main is still 2026-08-19');
  ok(near(DATED_CASH, 939.62),
    'independent startingCash breakdown still sums to $939.62',
    String(DATED_CASH));
  ok(near(CHEQUING_CASH, 939.04) && !near(CHEQUING_CASH, DATED_CASH),
    'independent household chequing is $939.04; designated savings stays on the breakdown',
    String(CHEQUING_CASH));
  ok(BELL && near(Number(BELL.amount), 160) && BELL.day === 15 && BELL.needsDate !== true
      && BELL.firstDue === '2026-10-15',
    'independent Bell row is standing $160, dated on the 15th from October');
}

console.log('\n=== 2. Forecast unavailable walk keeps the dated opening ===');
{
  const advice = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
  });
  ok(advice.operatingPlanUnavailable === true && advice.defaultView.asOf === OPENING,
    'Forecast keeps the dated opening as-of; it does not invent a later as-of');
  ok(near(Number(advice.defaultView.currentBalance), CHEQUING_CASH),
    'Forecast dated currentBalance is the independent chequing opening');
  ok(!(advice.defaultView.undatedBills || []).some(row => row && row.id === 'bell'),
    'Forecast no longer publishes Bell as an undated needsDate row');
}

console.log('\n=== 3. real Plan rendering path: compact unavailable state ===');
{
  const OBSERVED = '2026-08-31';
  const liveOverlay = {
    applied: false,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
    historicalOpeningAsOf: OPENING,
    observedAsOf: OBSERVED,
  };
  const refreshTrust = {
    displayState: 'attention-needed',
    overlayApplied: false,
    observedAsOf: OBSERVED,
    reconciledAsOf: null,
    exactFiguresAvailable: false,
    remainingClaim: 'unavailable',
    coverageLimits: [],
    unresolvedMaterial: [],
    canonicalProposalWaiting: false,
    refreshPath: 'on-demand-reload',
  };
  const advice = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
    operatingPlan: liveOverlay.operatingPlan,
    operatingPlanNote: liveOverlay.operatingPlanNote,
  });
  const html = composer.operatingSurfaceHtml({
    advice,
    weekly: advice.weekly,
    recommended: advice.weekly,
    liveOverlay,
    refreshTrust,
    asOf: OPENING,
  });

  ok(advice.defaultView.asOf === OPENING && near(Number(advice.defaultView.currentBalance), CHEQUING_CASH),
    'unavailable Forecast result retains the exact dated opening/as-of');
  ok(/data-unavailable-primary/.test(html)
      && /data-current-operating="unavailable"/.test(html)
      && /data-operating-plan="unavailable"/.test(html),
    'page contains one clear current-plan-unavailable primary state');
  ok(count(html, /<p class="operating-lead">Current plan unavailable<\/p>/g) === 1,
    'primary unavailable heading is emitted once');
  ok(count(html, /The dated opening is stale/g) === 1,
    'stale-opening note is not repeated eleven times',
    String(count(html, /The dated opening is stale/g)));
  ok(!/>Current Balance</.test(html) && !/Current Balance/.test(html),
    'dated cash is not labelled Current Balance');
  ok(/data-last-trusted-opening/.test(html)
      && /Last trusted opening/.test(html)
      && /Dated balance — not current/.test(html)
      && html.includes(composer.money2(CHEQUING_CASH))
      && /August 19/.test(html),
    'dated cash is explicitly dated/non-current and keeps the independent chequing opening / Aug 19');
  ok(!/data-calendar-waterfall/.test(html)
      && !/data-calendar-period-picker/.test(html)
      && !/>This payday</.test(html)
      && !/Pay periods this month/.test(html)
      && !/>Pay periods</.test(html),
    'normal active pay-period waterfall does not render as current');
  ok(!/data-operating-question=/.test(html)
      && !/data-operating-prompt="Income"/.test(html)
      && !/data-operating-prompt="Balance after payday"/.test(html)
      && !/data-operating-prompt="Bills"/.test(html)
      && !/data-operating-prompt="Household budget"/.test(html)
      && !/data-operating-prompt="Extra credit-card repayment"/.test(html)
      && !/data-operating-prompt="Big-purchase savings"/.test(html)
      && !/data-operating-prompt="Projected ending balance"/.test(html),
    'current Income / Available / Bills / Household Budget / extra-debt / big-purchase / projected-ending cards are withheld');
  ok(!/View full current-period worksheet/.test(html)
      && /View dated August 19 plan/.test(html)
      && /not today's operating plan/.test(html),
    'dated-plan access is historical, not a current trusted worksheet');
  ok(!/Updated August 31/.test(html)
      && !/Updated Aug 31/.test(html)
      && /Later refresh observed August 31 was not applied/.test(html),
    'refresh/observation timestamp cannot be mistaken for financial as-of');
  ok(!/needs confirmation/.test(html),
    'unavailable surface does not keep a stale Bell needs-confirmation row');
  ok(html.includes(composer.money2(CHEQUING_CASH))
      && !html.includes(composer.money2(DATED_CASH))
      && !html.includes('August 31 opening')
      && advice.defaultView.asOf === '2026-08-19',
    'no later as-of is invented on the rendered page');
}

console.log('\n=== 4. heading chrome distinguishes dated plan from current payday ===');
{
  const doc = chromeDoc();
  composer.applyUnavailableOperatingChrome(true, OPENING, {
    applied: false,
    historicalOpeningAsOf: OPENING,
    operatingPlan: 'unavailable',
    operatingPlanNote: NOTE,
  }, doc);
  ok(doc.store.heading.textContent === 'Current plan unavailable'
      && doc.store.kicker.textContent === 'Current plan unavailable',
    'page heading is Current plan unavailable, not This payday');
  ok(/Last trusted financial opening is August 19/.test(doc.store.lede.textContent)
      && /later live refresh could not safely advance/.test(doc.store.lede.textContent)
      && !/Current Balance/.test(doc.store.lede.textContent),
    'lede uses incumbent provenance and does not call dated cash Current Balance');

  composer.applyUnavailableOperatingChrome(false, OPENING, { applied: true }, doc);
  ok(doc.store.heading.textContent === 'This payday'
      && doc.store.kicker.textContent === 'This payday',
    'trusted chrome restores This payday');

  const stubIds = {};
  const stubDoc = {
    getElementById(id) {
      stubIds[id] = stubIds[id] || { id };
      return stubIds[id];
    },
  };
  let stubThrew = false;
  try {
    composer.applyUnavailableOperatingChrome(true, OPENING, {
      applied: false,
      historicalOpeningAsOf: OPENING,
      operatingPlan: 'unavailable',
    }, stubDoc);
  } catch (err) {
    stubThrew = true;
  }
  ok(!stubThrew,
    'unavailable chrome is a no-op on stub nodes that have no querySelector');
}

console.log('\n=== 5. trusted control keeps the normal This payday waterfall ===');
{
  const trusted = F.recommend(liveData.plan, OPENING, {
    debts: liveData.debts,
    revolvingExtra: liveData.revolvingExtra,
    targetBuffer: liveData.plan.defaults.targetBuffer,
  });
  const html = composer.operatingSurfaceHtml({
    advice: trusted,
    weekly: trusted.weekly,
    recommended: trusted.weekly,
  });
  ok(trusted.operatingPlanUnavailable !== true
      && /data-calendar-waterfall/.test(html)
      && /Current Balance/.test(html)
      && /Pay periods/.test(html)
      && !/data-unavailable-primary/.test(html)
      && !/data-last-trusted-opening/.test(html),
    'trusted operating plan still prints This payday / pay-period / waterfall experience');
  ok(near(Number(trusted.defaultView.currentBalance), CHEQUING_CASH),
    'trusted control does not move current figures');
  const liveAmount = /data-live-current-balance-amount>([^<]+)/.exec(html);
  ok(HUB_CASH != null
      && liveAmount
      && liveAmount[1] === composer.money2(HUB_CASH)
      && /Current Balance/.test(html)
      && !near(HUB_CASH, CHEQUING_CASH)
      && !near(HUB_CASH, DATED_CASH),
    'trusted waterfall prints independent hub (chequing-a) cash as Current Balance, not pooled A+B and not the savings-inclusive dated opening');
}

console.log('\n=== 6. page remains a renderer; Forecast is unchanged ===');
{
  const planSrc = read('public/plan.js');
  const forecastSrc = read('public/forecast.js');
  const surfaceFn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  const unavailableFn = /function unavailableOperatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surfaceFn && /liveOperatingPlanUnavailable/.test(surfaceFn[0])
      && /unavailableOperatingSurfaceHtml/.test(surfaceFn[0])
      && !/\bForecast\.[A-Za-z]+\s*\(/.test(surfaceFn[0]),
    'operatingSurfaceHtml uses one root-level unavailable branch and calls no Forecast function');
  ok(unavailableFn && /data-unavailable-primary/.test(unavailableFn[0])
      && /Last trusted opening/.test(unavailableFn[0])
      && /Dated balance — not current/.test(unavailableFn[0])
      && !/\bForecast\.[A-Za-z]+\s*\(/.test(unavailableFn[0])
      && !/\.reduce\(/.test(unavailableFn[0]),
    'unavailableOperatingSurfaceHtml is presentation-only');
  ok(/applyUnavailableOperatingChrome\(planUnavailable, asOf, d\.liveOverlay\)/.test(planSrc),
    'renderPlan applies unavailable heading chrome from the same fail-closed verdict');
  ok(/function withholdCurrentOperatingClaims/.test(forecastSrc)
      && /opts\.operatingPlan !== 'unavailable'/.test(forecastSrc),
    'Forecast unavailable withhold path is unchanged by this presentation PR');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
