'use strict';
/* Household information architecture: nav Budget | Forecast | Bills | Subscriptions | Credit | Plan spend,
 * routable Bills / Subscriptions / Credit / Forecast / Plan spend pages on the incumbent
 * header (content proved in test-bills-page.js, test-subscriptions-page.js,
 * test-credit-page.js, test-planning-page.js and test-plan-spend-page.js), and a Plan waterfall that
 * ends at Balance After Deductions. Talk remains routable off the dock.

 *
 * Presentation only. Forecast still computes the extra-debt / big-purchase
 * chain and the projected ending; this suite proves those fields survive and
 * still reconcile by independent arithmetic, while the household Plan surface
 * prints nothing past Q07.
 *
 * The last section starts server.js with synthetic secrets so the shells are
 * proved routable behind the same session gate as every other page.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');
const { spawn } = require('child_process');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const PASS = 'synthetic-site-password';
const SECRET = 'synthetic-session-secret';

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const exists = file => fs.existsSync(path.join(ROOT, file));

const HOUSEHOLD_NAV = [
  ['/', 'Budget'],
  ['/planning.html', 'Forecast'],
  ['/bills.html', 'Bills'],
  ['/subscriptions.html', 'Subscriptions'],
  ['/credit.html', 'Credit'],
  ['/plan-spend.html', 'Plan spend'],
];
const RETIRED_FROM_NAV = ['Modellers', 'Deep Dive', 'Records'];
const REMOVED_ROWS = [
  'Extra credit-card repayment',
  'Balance after debt repayment',
  'Big-purchase savings',
  'Projected ending balance',
];
const KEPT_ROWS = [
  'Income',
  'Bills',
  'Balance after bills',
  'Household budget',
  'Balance After Deductions',

];

function siteNav(html) {
  const match = /<nav class="sitenav(?: [^"]*)?" aria-label="Pages">([\s\S]*?)<\/nav>/.exec(html);
  if (!match) return null;
  return [...match[1].matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)].map(m => {
    const labelled = /class="sitenav-label"[^>]*>([^<]+)</.exec(m[3]);
    return {
      href: m[1],
      current: /aria-current="page"/.test(m[2]),
      label: (labelled ? labelled[1] : m[3]).replace(/<[^>]+>/g, '').trim(),
    };
  });
}

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
    `${source}\n({ operatingSurfaceHtml, calendarWaterfallHtml, weeklyCapView, paydayCoverageNote, money2 });`,
    { Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } }
  );
}

function currentAdvice() {
  const plan = data.plan;
  const asOf = data.meta.asOf;
  return F.recommend(plan, asOf, {
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
}

console.log('=== 1. Budget has no page nav; the other household pages keep the six links ===');
{
  const page = read('public/index.html');
  ok(siteNav(page) === null, 'the Budget page has no page nav');
  ok(!/class="sitenav sitenav-household"/.test(page),
    'the Budget page does not reserve a household dock');
  ok(/class="blend-brand"/.test(page) && /data-blend-theme/.test(page),
    'the Budget header is the logo and the theme control');
  ok(!/data-nav="budget"/.test(page) && !/data-nav="forecast"/.test(page),
    'Budget does not print the household destination links');
}

console.log('\n=== 2. Bills, Subscriptions, Credit, Forecast and Plan spend shells share the household nav on the incumbent header ===');
for (const [page, label, id] of [['bills.html', 'Bills', 'bills'], ['subscriptions.html', 'Subscriptions', 'subscriptions'], ['credit.html', 'Credit', 'credit'], ['planning.html', 'Forecast', 'planning'], ['plan-spend.html', 'Plan spend', 'plan-spend']]) {
  ok(exists('public/' + page), `${page} exists`);
  const html = read('public/' + page);
  const nav = siteNav(html);
  ok(nav && JSON.stringify(nav.map(l => [l.href, l.label])) === JSON.stringify(HOUSEHOLD_NAV),
    `${page} carries the same six household nav links in the same order`);
  const current = nav ? nav.filter(l => l.current) : [];
  ok(current.length === 1 && current[0].label === label,
    `${page} marks ${label} as the aria-current page`);
  ok(new RegExp(`<title>Household finances — ${label.toLowerCase()}</title>`).test(html)
      && new RegExp(`<h1>${label}</h1>`).test(html)
      && new RegExp(`data-page-shell="${id}"`).test(html),
    `${page} identifies itself as ${label}`);
  ok(/class="brand">Household finances</.test(html) && /id="asof"/.test(html)
      && /id="theme-btn"/.test(html) && /action="\/logout"/.test(html)
      && /<link rel="stylesheet" href="\/styles.css">/.test(html)
      && /<meta name="robots" content="noindex, nofollow">/.test(html),
    `${page} uses the incumbent header: brand, as-of chip, theme, sign out, stylesheet, noindex`);
  ok(/<script src="\/app.js"><\/script>/.test(html)
      && /<script src="\/forecast.js"><\/script>/.test(html)
      && new RegExp(`<script src="/${id}\\.js(?:\\?[^"]*)?"></script>`).test(html)
      && !/<script>/.test(html),
    `${page} loads the shared core, the Forecast engine and its own page script, and no inline script (CSP)`);
  const pageScript = read(`public/${id}.js`);
  ok(/App\.boot\(/.test(pageScript) && /App\.register\(/.test(pageScript),
    `${id}.js boots the shared core and renders through the shared data hook (served /data.json, one as-of chip)`);
  ok(!/\$\d|\d\.\d\d\b|%/.test(html.replace(/<meta[^>]*>/g, '')),
    `${page} hardcodes no figure — every figure arrives through the shared boot`);
  for (const href of [...html.matchAll(/href="(\/[^"#]*)"/g)].map(m => m[1])) {
    const target = href === '/' ? 'public/index.html' : 'public' + href;
    ok(exists(target), `${page} link ${href} resolves to a file`);
  }
}

{
  ok(exists('public/talk.html'), 'talk.html exists');
  const html = read('public/talk.html');
  const nav = siteNav(html);
  ok(nav && JSON.stringify(nav.map(l => [l.href, l.label])) === JSON.stringify(HOUSEHOLD_NAV),
    'talk.html carries the same six household nav links in the same order');
  ok(nav && !nav.some(l => l.label === 'Talk' || l.href === '/talk.html'),
    'talk.html household nav has no Talk tab');
  ok(nav && nav.filter(l => l.current).length === 0,
    'talk.html marks no dock destination current');
  ok(/<title>Household finances — talk<\/title>/.test(html)
      && /<h1>Talk to Atlas<\/h1>/.test(html)
      && /data-page-shell="talk"/.test(html),
    'talk.html identifies itself as Talk to Atlas');
  ok(/class="brand">Household finances</.test(html) && /id="asof"/.test(html)
      && /id="theme-btn"/.test(html) && /action="\/logout"/.test(html)
      && /<link rel="stylesheet" href="\/styles.css">/.test(html)
      && /<meta name="robots" content="noindex, nofollow">/.test(html),
    'talk.html uses the incumbent header: brand, as-of chip, theme, sign out, stylesheet, noindex');
  ok(/<script src="\/app.js"><\/script>/.test(html)
      && /<script src="\/talk.js"><\/script>/.test(html)
      && !/forecast\.js/.test(html)
      && !/<script>/.test(html),
    'talk.html loads the shared core and its own page script, not Forecast, and no inline script (CSP)');
  const pageScript = read('public/talk.js');
  ok(/App\.boot\(/.test(pageScript) && /talkModelAvailable/.test(pageScript)
      && /TALK_ASK_PATH/.test(pageScript),
    'talk.js boots the shared core and gates Send on the Talk model path');
  ok(!/\$\d|\d\.\d\d\b|%/.test(html.replace(/<meta[^>]*>/g, '')),
    'talk.html hardcodes no figure');
  for (const href of [...html.matchAll(/href="(\/[^"#]*)"/g)].map(m => m[1])) {
    const target = href === '/' ? 'public/index.html' : 'public' + href;
    ok(exists(target), `talk.html link ${href} resolves to a file`);
  }
}

console.log('\n=== 3. Modellers, Deep Dive, Records leave the household nav but stay routable ===');
{
  ok(siteNav(read('public/index.html')) === null, 'index.html has no page nav');
  for (const page of ['bills.html', 'subscriptions.html', 'credit.html', 'planning.html', 'plan-spend.html', 'talk.html']) {
    const nav = siteNav(read('public/' + page)) || [];
    ok(!nav.some(l => RETIRED_FROM_NAV.includes(l.label))
        && !nav.some(l => /modellers|deepdive|records/.test(l.href)),
      `${page} household nav has no Modellers / Deep Dive / Records entry`);
  }
  for (const page of ['modellers.html', 'deepdive.html', 'records.html']) {
    ok(exists('public/' + page), `${page} still exists (not deleted; only removed from the household nav)`);
  }
  for (const script of ['modellers.js', 'deepdive.js', 'records.js']) {
    ok(exists('public/' + script), `${script} still exists`);
  }
}

console.log('\n=== 4 + 5. Plan waterfall keeps Balance After Deductions and stops there ===');
{
  const advice = currentAdvice();
  const composer = loadComposer();
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay,
  });
  const active = (advice.defaultView.calendarPeriods || []).find(p => p.role === 'active')
    || advice.defaultView.calendarPeriods[0];
  ok(/data-calendar-waterfall=/.test(html), 'the default Plan renders the calendar waterfall');
  ok(/data-live-current-balance/.test(html)
      && html.indexOf('data-live-current-balance') < html.indexOf('data-operating-prompt="Income"'),
    'live Current Balance prints before the payday snapshot');
  let previous = -1;
  for (const prompt of KEPT_ROWS) {
    const at = html.indexOf(`data-operating-prompt="${prompt}"`);
    ok(at > previous, `${prompt} is printed, in order`);
    previous = at;
  }
  ok(/data-operating-question="07"[^>]*data-operating-prompt="Balance After Deductions"/.test(html),
    'Q07 is Balance After Deductions');
  ok(html.includes(composer.money2(active.afterHouseholdBudget)),
    'Q07 prints the Forecast afterHouseholdBudget figure');
  const questions = [...html.matchAll(/data-operating-question="([^"]+)"/g)].map(m => m[1]);
  const expectedQs = ['02', '04', '05', '06', 'savings', '07'];
  ok(questions.join(',') === expectedQs.join(',') && !questions.includes('03'),
    'the active snapshot includes the bounded proposed-savings disclosure before Q07',
    questions.join(','));

  for (const prompt of REMOVED_ROWS) {
    ok(!html.includes(prompt), `${prompt} is not on the Plan`);
  }
  ok(!/data-payday-first-card|data-card-id=|data-payday-big-purchases|Other credit cards/.test(html),
    'no card row or big-purchase row is rendered (not merely hidden)');
  ok(!/operating-ending/.test(html),
    'no ending-styled row remains in the calendar waterfall');
  ok(!/Extra credit-card repayment|Big-purchase savings|Projected ending balance|Balance after debt repayment/
    .test(composer.calendarWaterfallHtml(active, data.liveOverlay, advice.paydayAllocation)),
  'calendarWaterfallHtml itself emits none of the four removed prompts');
  const both = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly,
    liveOverlay: data.liveOverlay, planCalendarShow: 'both',
  });
  const sections = (both.match(/<section class="calendar-waterfall"/g) || []).length;
  const activeSection = (both.match(/data-calendar-role="active"[\s\S]*?<\/section>/) || [''])[0];
  const futureSection = (both.match(/data-calendar-role="future"[\s\S]*?<\/section>/) || [''])[0];
  const activeQs = activeSection.match(/data-operating-question=/g) || [];
  const futureQs = futureSection.match(/data-operating-question=/g) || [];
  const expectedActiveCount = 6;
  ok(sections === (advice.defaultView.calendarPeriods || []).length,
    'Show both renders every calendar period',
    `${sections} vs ${(advice.defaultView.calendarPeriods || []).length}`);
  ok(activeQs.length === expectedActiveCount,
    'Show both active snapshot has six questions including proposed savings, without opening',
    String(activeQs.length));
  ok(futureQs.length === 7,
    'Show both future snapshot includes opening as the seventh question',
    String(futureQs.length));
  ok(/data-live-current-balance/.test(both),
    'Show both still prints live Current Balance outside the snapshots');
  ok(!/data-operating-prompt="Current Balance"/.test(activeSection),
    'active snapshot does not print live Current Balance as Q01');
  ok(!/data-operating-prompt="Opening balance"/.test(activeSection),
    'active snapshot does not print payday-boundary opening');
  ok(/data-operating-prompt="Opening balance"/.test(futureSection),
    'future snapshot prints Opening balance');

  ok(!REMOVED_ROWS.some(prompt => both.includes(prompt)),
    'Show both still omits extra-debt and ending rows');
  const planSrc = read('public/plan.js');
  const fn = /function calendarWaterfallHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(fn && !/'08'|'09'|'10'|'11'/.test(fn[0]) && !/projectedEnding|afterDebtRepayment/.test(fn[0]),
    'calendarWaterfallHtml stops at Q07 in source, not by CSS');
  const surfaceFn = /function operatingSurfaceHtml\([\s\S]*?\n\}/.exec(planSrc);
  ok(surfaceFn && !/data-operating-warnings/.test(surfaceFn[0])
      && !/operating-limit warn/.test(surfaceFn[0]),
    'operatingSurfaceHtml stops emitting the advisory block in source, not by CSS');
  ok(!/data-operating-warnings/.test(html)
      && !/There is no feasible weekly cap/.test(html)
      && !/stays unfunded/.test(html)
      && !/data-refresh-attention/.test(html)
      && !/class="operating-limit warn"/.test(html),
    'the default Plan does not render the advisory block after Balance After Deductions');

  ok(!/There is no feasible weekly cap/.test(composer.calendarWaterfallHtml(active, data.liveOverlay, advice.paydayAllocation)),
    'calendarWaterfallHtml itself emits no weekly-cap advisory');
  const infeasibleAdvice = JSON.parse(JSON.stringify(advice));
  infeasibleAdvice.mode = 'infeasible';
  infeasibleAdvice.weekly = 0;
  infeasibleAdvice.infeasible = {
    label: 'Synthetic protected cost', date: '2026-10-02', shortfall: 321.11,
  };
  infeasibleAdvice.funding = { feasible: false, shortfall: 621.11 };
  infeasibleAdvice.paydayAllocation.risks = [
    { id: 'obligations', reason: 'This payday cannot cover required obligations in cash.', shortfall: 40.5 },
  ];
  const capCopy = composer.weeklyCapView(infeasibleAdvice);
  ok(capCopy.hasFeasibleCap === false
      && /There is no feasible weekly cap/.test(capCopy.reason)
      && /Synthetic protected cost/.test(capCopy.reason)
      && capCopy.reason.includes(composer.money2(321.11)),
    'weeklyCapView still composes the infeasible copy for other views');
  const infeasibleHtml = composer.operatingSurfaceHtml({
    advice: infeasibleAdvice, weekly: 0, recommended: 0,
  });
  ok(/data-operating-prompt="Balance After Deductions"/.test(infeasibleHtml)

      && !/data-operating-warnings/.test(infeasibleHtml)
      && !/There is no feasible weekly cap/.test(infeasibleHtml)
      && !/Synthetic protected cost/.test(infeasibleHtml)
      && !/This payday cannot cover required obligations in cash/.test(infeasibleHtml),
    'infeasible Forecast output is not printed as an advisory after Q07');
  const coverage = composer.paydayCoverageNote(advice.currentPeriodAction);
  ok(typeof coverage === 'string' && coverage.length > 0
      && (infeasibleHtml + html).indexOf(coverage) === -1,
    'paydayCoverageNote still exists and is not dumped onto the usable Plan');
  ok(!/display:\s*none[^}]*operating-question|data-operating-question="(08|09|10|11)"[^}]*display:\s*none/
    .test(read('public/styles.css') + read('public/household-view.css')),
  'no stylesheet hides waterfall rows');
  const page = read('public/index.html');
  ok(!/extra debt and big purchases/.test(page)
      && !/Live Current Balance, then this payday’s income, bills and household budget\./.test(page),
    'the Budget page does not render the removed This payday lede');
  ok(!/extra debt and big purchases/.test(planSrc),
    'the plan.js lede constant matches');
}

console.log('\n=== 6. Forecast still computes the chain past the household-budget boundary ===');
{
  const advice = currentAdvice();
  const alloc = advice.paydayAllocation;
  const periodsOut = advice.defaultView.calendarPeriods || [];
  const active = periodsOut.find(p => p.role === 'active');
  const next = periodsOut.find(p => p.role === 'future');
  ok(active && active.extraDebt && typeof active.extraDebt.allocated === 'number'
      && Array.isArray(active.bigPurchases) && active.firstCard,
    'the active period still carries extraDebt, firstCard, and bigPurchases');
  if (active.afterHouseholdBudget != null) {
    const purchasesTaken = (active.bigPurchases || [])
      .reduce((s, r) => s + (Number(r.allocation) || 0), 0);
    const independentAfterDebt = Math.round((active.afterHouseholdBudget - active.extraDebt.allocated) * 100) / 100;
    const independentEnding = Math.round((independentAfterDebt - purchasesTaken) * 100) / 100;
    ok(typeof active.afterDebtRepayment === 'number'
        && typeof active.projectedEnding === 'number',
      'Balance After Deductions still publishes afterDebtRepayment and projectedEnding');
    ok(near(active.afterDebtRepayment, independentAfterDebt),
      'afterDebtRepayment = afterHouseholdBudget − extraDebt.allocated (independent arithmetic)');
    ok(near(active.projectedEnding, independentEnding),
      'projectedEnding = afterDebtRepayment − Σ big-purchase allocation (independent arithmetic)');
    const cashLeftover = active.paydayBoundaryOpening === true
      && active.opening != null && active.incomeAdded != null
      && active.periodBillLoad != null && active.budgetHold != null
      ? Math.round((Number(active.opening) + Number(active.incomeAdded)
        - Number(active.periodBillLoad) - Number(active.budgetHold)) * 100) / 100
      : null;
    if (cashLeftover != null) {
      ok(next && next.openingKnown && near(next.opening, cashLeftover),
        'the next pay period opens from cash leftover, not from Balance After Deductions');
    } else {
      ok(!next || next.opening == null || next.openingSource !== 'carry-forward'
          || !near(next.opening, active.projectedEnding),
        'next period does not inherit Balance After Deductions as its opening');
    }
  } else {
    ok(false, 'Balance After Deductions publishes without a payday-boundary opening');
  }
  ok(alloc && alloc.extraDebt && typeof alloc.extraDebt.allocated === 'number'
      && alloc.runningLeftover && typeof alloc.runningLeftover.afterDebtRepayment === 'number'
      && typeof alloc.runningLeftover.afterBigPurchases === 'number',
    'paydayAllocation.extraDebt and runningLeftover.afterDebtRepayment / afterBigPurchases remain');
  const forecastSrc = read('public/forecast.js');
  ok(/projectedEnding:\s*afterBigPurchases/.test(forecastSrc)
      && /afterDebtRepayment,/.test(forecastSrc)
      && /bigPurchases:\s*purchases\.items/.test(forecastSrc),
    'forecast.js still publishes projectedEnding, afterDebtRepayment and bigPurchases on each period');
}

console.log('\n=== 7. the shells are routable behind the incumbent session gate ===');
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
    server.on('error', reject);
  });
}
function startAtlas(env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('server start timeout\n' + stderr));
    }, 8000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!settled && /listening/.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stop: () => new Promise(done => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }, 2000);
          }),
        });
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${stderr}`));
    });
  });
}
(async () => {
  const port = await freePort();
  const env = Object.assign({}, process.env);
  for (const key of Object.keys(env)) {
    if (/^(ATLAS_|LUNCHMONEY_)/.test(key)) delete env[key];
  }
  Object.assign(env, { SITE_PASSWORD: PASS, SESSION_SECRET: SECRET, PORT: String(port) });
  const atlas = await startAtlas(env);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const page of ['/bills.html', '/subscriptions.html', '/credit.html', '/planning.html', '/plan-spend.html', '/talk.html']) {
      const anon = await fetch(base + page, { redirect: 'manual' });
      ok(anon.status === 302 && /\/login$/.test(anon.headers.get('location') || ''),
        `${page} without a session redirects to /login`);
    }
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(PASS)}`,
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok(login.status === 302 && /^hfd_session=/.test(cookie), 'synthetic login issues a session');
    for (const [page, label] of [['/bills.html', 'Bills'], ['/subscriptions.html', 'Subscriptions'], ['/credit.html', 'Credit'], ['/planning.html', 'Forecast'], ['/plan-spend.html', 'Plan spend'], ['/', 'Budget']]) {
      const res = await fetch(base + page, { headers: { cookie } });
      const body = await res.text();
      const nav = siteNav(body);
      if (page === '/') {
        ok(res.status === 200 && nav === null && /id="operating-surface"/.test(body),
          '/ serves 200 with the operating surface and no page nav');
      } else if (page === '/planning.html') {
        // Retired route (PR #632): /planning.html is no longer served. The URL
        // answers the approved 302 to / instead; the page's nav markup facts
        // remain pinned against public/planning.html itself in section 2.
        const retired = await fetch(base + page, { headers: { cookie }, redirect: 'manual' });
        ok(retired.status === 302 && (retired.headers.get('location') || '') === '/',
          '/planning.html answers the approved 302 to / (Forecast page retired, not served)');
      } else {
        ok(res.status === 200 && nav
            && JSON.stringify(nav.map(l => [l.href, l.label])) === JSON.stringify(HOUSEHOLD_NAV)
            && nav.find(l => l.current).label === label,
          `${page} serves 200 with the household nav and ${label} current`);
      }
      ok(/no-store/.test(res.headers.get('cache-control') || '')
          && /script-src 'self'/.test(res.headers.get('content-security-policy') || ''),
        `${page} carries the incumbent no-store and CSP headers`);
    }
    {
      const res = await fetch(base + '/talk.html', { headers: { cookie } });
      const body = await res.text();
      const nav = siteNav(body);
      ok(res.status === 200 && /<h1>Talk to Atlas<\/h1>/.test(body)
          && nav && JSON.stringify(nav.map(l => [l.href, l.label])) === JSON.stringify(HOUSEHOLD_NAV)
          && !nav.some(l => l.label === 'Talk')
          && nav.filter(l => l.current).length === 0,
        '/talk.html remains routable with the household dock and no Talk tab');
    }
    for (const script of ['/bills.js', '/subscriptions.js', '/credit.js', '/planning.js', '/plan-spend.js', '/talk.js']) {
      const res = await fetch(base + script, { headers: { cookie } });
      ok(res.status === 200, `${script} is served to a session`);
    }
    for (const page of ['/modellers.html', '/deepdive.html', '/records.html']) {
      const res = await fetch(base + page, { headers: { cookie } });
      ok(res.status === 200, `${page} remains routable to a session`);
    }
  } finally {
    await atlas.stop();
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
