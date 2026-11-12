'use strict';
/* Future pay-period Other Spend is an owner planning assumption.
 *
 * Owner 2026-09-26: reserve exactly $400 Other Spend on every future pay
 * period, through Forecast, once. Current and completed periods do not
 * receive it. The incumbent $800/month other-spend target stays on
 * budgetBreakdown / Road Ahead and is not smeared into the calendar
 * (800 × 14 / (365.25/12) is the excluded cycle amount).
 *
 * Independent of calendarHouseholdBudget (L-002). Synthetic fixtures, not
 * live cents, are the behaviour specification (L-006). The live plan is
 * checked only as a delta against the same plan with the field removed.
 *
 * `node test/test-future-other-spend-reserve.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
// Preserve these retired-policy regression assertions against the explicitly
// dated historical policy. The active 450 policy has its own independent suite.
const canonical = require('../data.json');
const live = JSON.parse(JSON.stringify(canonical));
const retiredOther = live.plan.budget.categories.find(row => row.id === 'other-spend');
const historicalOther = retiredOther.targetHistory?.find(row => row.effectiveThrough === '2026-09-24');
if (!historicalOther) throw new Error('missing dated retired Other policy');
Object.assign(retiredOther, historicalOther);
delete retiredOther.plannedPayday; delete retiredOther.targetEffectiveFrom; delete retiredOther.targetHistory;
if (!(live.meta.asOf <= historicalOther.effectiveThrough)) throw new Error('retired policy cannot stand in for an active-period assertion');
const periods = require('../public/periods.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const RESERVE = 400;
const OTHER_MONTHLY = 800;
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const EXCLUDED_CYCLE = roundCent(OTHER_MONTHLY * 14 / CALENDAR_MONTH_DAYS);
const OTHER_ID = 'other-spend';
const AS_OF = '2026-09-11';
const PAYDAY = '2026-08-28';

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const names = [
    'liveOperatingPlanUnavailable',
    'liveOperatingPlanNote',
    'paydayGlanceCashNote',
    'providerBalanceDate',
    'glanceUpdatedNote',
    'glanceSignedMoney',
    'glanceMoney',
    'glanceLineLabel',
    'cashGlanceHtml',
    'liveCurrentBalanceHtml',
    'runningLeftoverHtml',
    'periodBillLine',
    'calendarCurrentUnavailableHtml',
    'calendarIncomeHtml',
    'householdBudgetCycleText',
    'householdBudgetMetric',
    'householdBudgetCategoryHtml',
    'calendarBudgetHtml',
    'calendarPeriodBillsHtml',
    'periodBillsHtml',
    'extraRepaymentHtml',
    'calendarFromTodayEvidenceHtml',
    'calendarWaterfallHtml',
    'payPeriodSelection',
    'payPeriodMoveSelection',
    'payPeriodRangeLabel',
    'payPeriodStatusLabel',
    'payPeriodNavigatorHtml',
    'payPeriodCloseMonth',
    'payPeriodMonths',
    'payPeriodWheelSelection',
    'budgetPlanSpendEarmarkHtml',
    'payPeriodTimelineHtml',
    'budgetPayPeriodContentHtml',
    'currentPaydayShellHtml',
    'operatingSurfaceHtml',
    'paydayInstructionShellHtml',
    // AMANDA SLICE 14 — the shell's planned block reads the caller-passed
    // same-input schedule; the harness must include its (pure) chain.
    'budgetMonthPlanSpendSchedule',
    'budgetMonthKnobOpts',
    'budgetTrajectoryCacheKeyFor',
    'simOpts',
    'budgetMonthName',
  ];
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^const BUDGET_MONTH_NAMES = [\s\S]*?\];/m, 'BUDGET_MONTH_NAMES'),
    'let budgetMonthScheduleCache = null; let budgetMonthScheduleCacheKey = null;',
  ].concat(names.map(name => grab(
    planSrc,
    new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}$', 'm'),
    name
  ))).join('\n');
  return vm.runInNewContext(
    `${source}\n({ operatingSurfaceHtml, calendarBudgetHtml, calendarWaterfallHtml, money2 });`,
    // AMANDA SLICE 14: minimal page-state stub for simOpts (read by
    // budgetMonthKnobOpts inside the schedule chain).
    { Forecast: F,
      state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0,
        incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null,
        extraFacilities: null } }
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syntheticPlan(reserve) {
  const categories = [
    { id: 'groceries', label: 'Groceries', class: 'essential',
      plannedPayday: 900, ownerLine: 'Groceries' },
    { id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 325, ownerLine: 'Fuel' },
    {
      id: OTHER_ID, label: 'Other spend', class: 'essential', from: [],
      plannedMonthly: OTHER_MONTHLY, ownerLine: 'Other spend',
      targetSource: 'owner-stated-2026-09-18',
    },
  ];
  if (reserve != null) {
    categories[2].futurePayPeriodReserve = reserve;
    categories[2].futurePayPeriodReserveSource = 'owner-stated-2026-09-26';
  }
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 2000, confidence: 'confirmed',
    }],
    bills: [{
      id: 'hydro', label: 'Hydro', amount: 100, frequency: 'monthly', day: 3,
      confidence: 'confirmed', payingAccount: 'chequing-a',
    }],
    obligations: [],
    commitments: [],
    budget: { categories },
  };
}

function recommend(plan, asOf) {
  return F.recommend(plan, asOf || AS_OF, {
    targetBuffer: 500,
    debts: [],
  });
}

function periodByRole(advice, role) {
  const rows = (advice.defaultView && advice.defaultView.calendarPeriods) || [];
  return rows.find(p => p && p.role === role) || null;
}

function budgetRow(period, id) {
  return ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;
}

function holdSum(period) {
  return roundCent(((period && period.householdBudget) || [])
    .reduce((sum, row) => sum + (Number(row && row.hold) || 0), 0));
}

function categoryBlock(html, id) {
  return String(html || '').split(/data-budget-category="/).slice(1)
    .map(chunk => 'data-budget-category="' + chunk)
    .find(chunk => chunk.startsWith('data-budget-category="' + id + '"')) || '';
}

function questionBlock(html, prompt) {
  const marker = `data-operating-prompt="${prompt}"`;
  const at = String(html || '').indexOf(marker);
  if (at < 0) return '';
  const next = html.indexOf('data-operating-prompt="', at + marker.length);
  return html.slice(at, next < 0 ? html.length : next);
}

function totalBlock(html) {
  const marker = 'data-household-budget-total';
  const at = String(html || '').indexOf(marker);
  if (at < 0) return '';
  const end = html.indexOf('</p>', at);
  return html.slice(at, end < 0 ? html.length : end);
}

const composer = loadComposer();
ok(near(EXCLUDED_CYCLE, 367.97),
  'independent excluded smear is $800 × 14 / calendar-month days = $367.97, not $400');

console.log('\n=== 1. Budget operating surface drops the header and More views ===');
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  const operating = page.slice(page.indexOf('id="operating-surface"'), page.indexOf('id="payday-answer"'));
  ok(!/class="brand">Household finances</.test(page),
    'Budget page does not render the Household finances brand row');
  ok(!/id="theme-btn"/.test(page) && !/action="\/logout"/.test(page),
    'Budget page does not render Theme or Sign out');
  ok(!/id="asof"/.test(page),
    'Budget page does not render the as-at chip');
  ok(!/<h1>This payday<\/h1>/.test(page)
      && !/Live Current Balance, then this payday/.test(page),
    'Budget page does not render the This payday heading or its lede');
  ok(/id="operating-surface"/.test(operating)
      && /id="operating-surface-body"/.test(operating)
      && !/<h1/.test(operating),
    'the operating surface opens on its body, with no heading ahead of it');
  ok(!/data-nav="budget"/.test(page) && !/data-nav="forecast"/.test(page),
    'the Budget page does not carry the household nav links');
  const bills = fs.readFileSync(path.join(__dirname, '..', 'public/bills.html'), 'utf8');
  ok(/id="theme-btn"/.test(bills) && /action="\/logout"/.test(bills) && /id="asof"/.test(bills),
    'theme, sign out, and the as-at chip remain on other Atlas pages');
  const planSrc = read('public/plan.js');
  const surface = grab(planSrc, /^function operatingSurfaceHtml\([\s\S]*?\n\}$/m, 'operatingSurfaceHtml');
  ok(!/More views/.test(surface) && !/data-plan-look/.test(surface),
    'operatingSurfaceHtml does not build a More views control');
  const timeline = grab(planSrc, /^function payPeriodTimelineHtml\([\s\S]*?\n\}$/m, 'payPeriodTimelineHtml');
  ok(timeline.indexOf('liveCurrentBalanceHtml') >= 0
      && timeline.indexOf('liveCurrentBalanceHtml') < timeline.indexOf('payPeriodNavigatorHtml')
      && timeline.indexOf('payPeriodNavigatorHtml') < timeline.indexOf('calendarWaterfallHtml'),
    'Current Balance is printed before the pay-period selector and financial cards');
}

console.log('\n=== 2. Current Balance precedes the linked selectors ===');
{
  const advice = recommend(syntheticPlan(RESERVE));
  const html = composer.operatingSurfaceHtml({
    advice, weekly: advice.weekly, recommended: advice.weekly, plan: syntheticPlan(RESERVE),
  });
  const selectorAt = html.indexOf('data-pay-period-navigator');
  const monthAt = html.indexOf('data-budget-wheel="month"');
  const periodAt = html.indexOf('data-budget-wheel="period"');
  const balanceAt = html.indexOf('data-live-current-balance');
  const incomeAt = html.indexOf('data-operating-prompt="Income"');
  const billsAt = html.indexOf('data-operating-prompt="Bills"');
  const budgetAt = html.indexOf('data-operating-prompt="Household budget"');
  const badAt = html.indexOf('data-operating-prompt="Balance After Deductions"');
  ok(selectorAt ===  html.indexOf('data-budget-wheel') || monthAt > selectorAt,
    'month wheel is inside the navigator');
  ok(balanceAt >= 0 && selectorAt > balanceAt && monthAt > selectorAt && periodAt > monthAt
      && incomeAt > periodAt && billsAt > incomeAt
      && budgetAt > billsAt && badAt > budgetAt,
    'order is Current Balance, month, pay period, Income, Bills, Household Budget, Balance After Deductions');
  ok(!/More views/.test(html) && !/data-plan-look/.test(html),
    'rendered Budget surface has no More views control');
  ok(!/Household finances/.test(html) && !/Theme: Auto/.test(html) && !/Sign out/.test(html),
    'rendered operating sheet does not reprint the removed header');
}

console.log('\n=== 3. current period does not receive the $400; a future period does, once ===');
{
  const advice = recommend(syntheticPlan(RESERVE));
  const bare = recommend(syntheticPlan(null));
  const current = periodByRole(advice, 'active');
  const future = periodByRole(advice, 'future');
  const bareCurrent = periodByRole(bare, 'active');
  const bareFuture = periodByRole(bare, 'future');
  const row = budgetRow(future, OTHER_ID);
  ok(current && !budgetRow(current, OTHER_ID),
    'current Household Budget has no Other Spend reserve row');
  ok(current && bareCurrent && near(current.budgetHold, bareCurrent.budgetHold)
      && near(current.balanceAfterDeductions, bareCurrent.balanceAfterDeductions)
      && near(current.incomeTotal, bareCurrent.incomeTotal)
      && near(current.periodBillLoad, bareCurrent.periodBillLoad),
    'current income, bills, hold, and Balance After Deductions are unchanged by the future-only field');
  ok(row && row.label === 'Other Spend' && row.planningAssumption === true
      && row.confidence === 'estimated' && row.trust === 'estimated'
      && row.futurePayPeriodReserve === true && near(row.planned, RESERVE)
      && near(row.hold, RESERVE) && row.spent == null,
    'future period publishes exactly $400 Other Spend as an estimated planning assumption');
  ok(future && future.budgetHoldTrust === 'estimated'
      && future.balanceAfterDeductionsTrust === 'estimated',
    'Forecast stamps the future hold and Balance After Deductions estimated');
  ok(current && current.budgetHoldTrust !== 'estimated'
      && current.balanceAfterDeductionsTrust !== 'estimated',
    'the current period does not receive the estimated stamp');
  ok((future.householdBudget || []).filter(r => r && r.id === OTHER_ID).length === 1,
    'the future Other Spend row appears exactly once');
  ok(near(holdSum(future), future.budgetHold),
    'category holds sum to budgetHold, so the $400 is not added again beside the rows');
  ok(near(future.budgetHold - bareFuture.budgetHold, RESERVE),
    'future deductions increase by exactly $400',
    `${future.budgetHold} vs ${bareFuture.budgetHold}`);
  ok(near(bareFuture.balanceAfterDeductions - future.balanceAfterDeductions, RESERVE),
    'future Balance After Deductions falls by exactly $400');
  ok(near(future.balanceAfterDeductions, roundCent(
    future.incomeTotal - future.periodBillLoad - future.budgetHold
  )), 'future BAD remains income − bills − hold');
  ok(near(future.incomeTotal, bareFuture.incomeTotal)
      && near(future.periodBillLoad, bareFuture.periodBillLoad),
    'future income and bills do not move');
  ok(!near(row.hold, EXCLUDED_CYCLE),
    'the reserve is not the $367.97 monthly smear');
  const html = composer.calendarBudgetHtml(future);
  const otherBlock = categoryBlock(html, OTHER_ID);
  const groceryBlock = categoryBlock(html, 'groceries');
  ok(/data-budget-category="other-spend"/.test(html)
      && /Other Spend/.test(html)
      && html.includes(composer.money2(RESERVE))
      && (html.match(/data-budget-category="other-spend"/g) || []).length === 1,
    'Budget prints the Forecast Other Spend amount and does not invent a second one');
  ok(/data-budget-trust="estimated"/.test(otherBlock)
      && /<span class="est">≈ estimated<\/span>/.test(otherBlock)
      && otherBlock.includes(composer.money2(RESERVE)),
    'the future Other Spend row is visibly ≈ estimated');
  ok(groceryBlock && !/≈ estimated/.test(groceryBlock)
      && !/data-budget-trust="estimated"/.test(groceryBlock),
    'other future Household Budget rows do not gain this estimate marker');
  const total = totalBlock(html);
  ok(/data-budget-hold-trust="estimated"/.test(total)
      && /<span class="est">≈ estimated<\/span>/.test(total)
      && /data-household-budget-total-amount>[^<]*</.test(total)
      && total.includes(composer.money2(future.budgetHold)),
    'the future Household Budget total is visibly estimated and still prints Forecast budgetHold');
  const waterfall = composer.calendarWaterfallHtml(future);
  const bad = questionBlock(waterfall, 'Balance After Deductions');
  const afterBills = questionBlock(waterfall, 'Balance after bills');
  ok(/data-balance-trust="estimated"/.test(bad)
      && /<span class="est">≈ estimated<\/span>/.test(bad)
      && bad.includes(composer.money2(future.balanceAfterDeductions)),
    'future Balance After Deductions is visibly estimated and still prints the Forecast remainder');
  ok(!/data-balance-trust="estimated"/.test(afterBills)
      && !/≈ estimated/.test(afterBills),
    'Balance after bills does not inherit the Other Spend estimate marker');
  const currentHtml = composer.calendarBudgetHtml(current);
  const currentWaterfall = composer.calendarWaterfallHtml(current);
  ok(!/data-budget-category="other-spend"/.test(currentHtml),
    'current Household Budget HTML does not print Other Spend');
  ok(!/≈ estimated/.test(currentHtml) && !/data-budget-hold-trust="estimated"/.test(currentHtml),
    'the current Household Budget total does not gain the estimate marker');
  ok(current.balanceAfterDeductionsTrust == null
      && current.plannedCostFunding.trust === 'estimated'
      && /data-balance-trust="estimated"/.test(currentWaterfall)
      && /≈ estimated/.test(questionBlock(currentWaterfall, 'Balance After Deductions')),
    'original current deductions remain calculated; the proposed-funding remainder discloses future allowance estimates');
}

console.log('\n=== 4. Forecast stays the authority; unrelated published figures stay put ===');
{
  const withField = syntheticPlan(RESERVE);
  const withoutField = syntheticPlan(null);
  const a = recommend(withField);
  const b = recommend(withoutField);
  ok(near(a.weekly, b.weekly),
    'the weekly cap does not move', `${a.weekly} vs ${b.weekly}`);
  const bdA = F.budgetBreakdown(withField, periods, {});
  const bdB = F.budgetBreakdown(withoutField, periods, {});
  const rowA = ((bdA && bdA.categories) || []).find(c => c && c.id === OTHER_ID);
  const rowB = ((bdB && bdB.categories) || []).find(c => c && c.id === OTHER_ID);
  ok(rowA && rowB && near(rowA.planned, OTHER_MONTHLY) && near(rowB.planned, OTHER_MONTHLY)
      && near(rowA.target, OTHER_MONTHLY),
    'budgetBreakdown still publishes the $800/month target and ignores the future reserve');
  const liveCat = (live.plan.budget.categories || []).find(c => c && c.id === OTHER_ID);
  ok(liveCat && liveCat.plannedMonthly === OTHER_MONTHLY
      && liveCat.futurePayPeriodReserve === RESERVE
      && liveCat.plannedPayday == null,
    'live other-spend keeps plannedMonthly 800 and records futurePayPeriodReserve 400');
  const opts = {
    debts: live.debts || [],
    targetBuffer: live.plan.defaults && live.plan.defaults.targetBuffer,
  };
  const liveWith = F.recommend(live.plan, live.meta.asOf, opts);
  const stripped = clone(live.plan);
  const strippedCat = stripped.budget.categories.find(c => c && c.id === OTHER_ID);
  delete strippedCat.futurePayPeriodReserve;
  delete strippedCat.futurePayPeriodReserveSource;
  const liveWithout = F.recommend(stripped, live.meta.asOf, opts);
  ok(near(liveWith.weekly, liveWithout.weekly),
    'live weekly cap is unchanged by the reserve');
  const viewsA = liveWith.payPeriodViews || [];
  const viewsB = liveWithout.payPeriodViews || [];
  ok(viewsA.length === viewsB.length && viewsA.length > 0,
    'the live timeline length does not change');
  let futureRows = 0;
  for (let i = 0; i < viewsA.length; i++) {
    const left = viewsA[i];
    const right = viewsB[i];
    ok(left.start === right.start && left.timelineRole === right.timelineRole,
      'timeline row ' + left.start + ' keeps its role');
    ok(near(left.incomeTotal, right.incomeTotal) && near(left.periodBillLoad, right.periodBillLoad),
      left.start + ' income and bills do not move');
    if (left.timelineRole === 'current' || left.timelineRole === 'past') {
      ok(!budgetRow(left, OTHER_ID),
        left.timelineRole + ' ' + left.start + ' has no Other Spend reserve');
      ok(left.budgetHoldTrust !== 'estimated'
          && left.balanceAfterDeductionsTrust === right.balanceAfterDeductionsTrust,
        left.timelineRole + ' ' + left.start + ' does not gain trust from the Other Spend reserve');
      ok(near(left.budgetHold, right.budgetHold)
          && near(left.balanceAfterDeductions, right.balanceAfterDeductions),
        left.timelineRole + ' hold and Balance After Deductions do not move');
    } else {
      futureRows += 1;
      const published = budgetRow(left, OTHER_ID);
      ok(published && near(published.planned, RESERVE) && near(published.hold, RESERVE)
          && published.confidence === 'estimated' && published.trust === 'estimated',
        left.timelineRole + ' ' + left.start + ' publishes exactly $400 Other Spend as estimated');
      ok(left.budgetHoldTrust === 'estimated'
          && left.balanceAfterDeductionsTrust === 'estimated',
        left.start + ' hold and Balance After Deductions are stamped estimated');
      ok(near(left.budgetHold - right.budgetHold, RESERVE),
        left.start + ' deductions include the $400 once');
      ok(near(right.balanceAfterDeductions - left.balanceAfterDeductions, RESERVE),
        left.start + ' Balance After Deductions changes by exactly $400');
      ok(near(holdSum(left), left.budgetHold),
        left.start + ' hold equals the sum of its rows');
    }
  }
  ok(futureRows > 0, 'at least one future live row was checked');
  const forecastSrc = read('public/forecast.js');
  ok(/function futurePayPeriodOtherSpend\(/.test(forecastSrc)
      && /calendarHouseholdBudget\(/.test(forecastSrc)
      && /holdTrust = 'estimated'/.test(forecastSrc)
      && /budgetHoldTrust:/.test(forecastSrc)
      && /balanceAfterDeductionsTrust:/.test(forecastSrc)
      && !/balanceAfterDeductions\s*-\s*400/.test(read('public/plan.js'))
      && !/budgetHold\s*\+\s*400/.test(read('public/plan.js')),
    'the $400 enters through Forecast; plan.js does not subtract or add it');
  const planSrc = read('public/plan.js');
  ok(/row\.confidence === 'estimated'/.test(planSrc)
      && /row\.trust === 'estimated'/.test(planSrc)
      && /period\.budgetHoldTrust === 'estimated'/.test(planSrc)
      && /period\.balanceAfterDeductionsTrust/.test(planSrc)
      && /≈ estimated/.test(planSrc),
    'Budget prints Forecast estimated trust and does not invent the marker');
  const liveCurrent = viewsA.find(row => row && row.timelineRole === 'current');
  const livePast = viewsA.find(row => row && row.timelineRole === 'past');
  const liveFuture = viewsA.find(row => row && (row.timelineRole === 'next' || row.timelineRole === 'future'));
  const liveCurrentHtml = composer.calendarWaterfallHtml(liveCurrent);
  const livePastHtml = composer.calendarWaterfallHtml(livePast);
  const livePastBad = questionBlock(livePastHtml, 'Balance After Deductions');
  const livePastResult = /<div[^>]*data-budget-period-result[^>]*>[\s\S]*?<\/div>/.exec(livePastHtml)?.[0] || '';
  const liveFutureHtml = composer.calendarWaterfallHtml(liveFuture);
  const liveFutureOther = categoryBlock(liveFutureHtml, OTHER_ID);
  const liveFutureTotal = totalBlock(liveFutureHtml);
  const liveFutureBad = questionBlock(liveFutureHtml, 'Balance After Deductions');
  ok(liveFuture
      && /data-budget-trust="estimated"/.test(liveFutureOther)
      && /<span class="est">≈ estimated<\/span>/.test(liveFutureOther)
      && /data-budget-hold-trust="estimated"/.test(liveFutureTotal)
      && /<span class="est">≈ estimated<\/span>/.test(liveFutureTotal)
      && liveFutureTotal.includes(composer.money2(liveFuture.budgetHold))
      && /data-balance-trust="estimated"/.test(liveFutureBad)
      && /<span class="est">≈ estimated<\/span>/.test(liveFutureBad)
      && liveFutureBad.includes(composer.money2(liveFuture.balanceAfterDeductions)),
    'a live future pay period shows ≈ estimated on Other Spend, the total, and Balance After Deductions');
  ok(liveCurrent && !/data-budget-hold-trust="estimated"/.test(liveCurrentHtml)
      && /data-balance-trust="estimated"/.test(liveCurrentHtml)
        === (liveCurrent.balanceAfterDeductionsTrust === 'estimated')
      && !/data-budget-category="other-spend"/.test(liveCurrentHtml),
    'the live current pay period preserves income/bill trust without the Other Spend reserve marker');
  ok(livePast && !/data-budget-hold-trust="estimated"/.test(livePastHtml)
      && !/data-budget-category="other-spend"/.test(livePastHtml),
    'a live past pay period does not receive the future-only Other Spend reserve marker');
  // An estimated engine remainder does not establish qualified whole-period
  // historical BAD. Require withholding at each aggregate publication hook;
  // source terms and the current/future estimated-state checks stay separate.
  ok(livePast && Number.isFinite(livePast.balanceAfterDeductions)
      && livePast.balanceAfterDeductionsTrust === 'estimated'
      && /data-budget-result-trust="unavailable"/.test(livePastBad)
      && /Unavailable<span data-budget-result-amount><\/span>/.test(livePastBad)
      && !/data-balance-trust="estimated"/.test(livePastBad),
    'historical Q07 withholds the estimated model remainder as Unavailable with no result amount');
  ok(/data-budget-result-trust="unavailable"/.test(livePastResult)
      && /Unavailable<span data-budget-result-amount><\/span>/.test(livePastResult),
    'historical hero withholds the aggregate result with an empty amount hook');
  ok(/data-bad-term="balanceAfterDeductions" data-bad-term-trust="unavailable"><span data-bad-term-label>[^<]*<\/span><span data-bad-term-value>Unavailable<span data-bad-term-amount><\/span>/.test(livePastBad)
      && /data-bad-historical-withheld/.test(livePastBad),
    'historical BAD term is unavailable with no amount and retains the whole-period qualification warning');
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAll assertions passed.');
