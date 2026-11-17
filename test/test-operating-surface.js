'use strict';
/* AF-OPERATE-02 — the homepage leads with five ordered operating answers,
 * composed from incumbent Forecast outputs. No page-side financial arithmetic.
 */
const { loadBudgetPage, liveBudgetComposerSource } = require('./lib/budget-page-harness');
const fs = require('fs');
const path = require('path');
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
  // The real Budget page (test/lib/budget-page-harness.js). operatingSurfaceHtml
  // is the live composition: the Today card plus the compact pay-period content.
  const page = loadBudgetPage({ Forecast: F, state: { scenario: null, targetBuffer: 500, extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: null, extraDebtTarget: null, extraFacilities: null } });
  return { operatingSurfaceHtml: ctx => page.surfaceHtml(ctx),
    paydayCoverageNote: page.get('paydayCoverageNote'), money2: page.get('money2') };
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
  // Live Budget: Current balance is the Today card hero, printed before the
  // selected period; the compact period prints Reported combined savings
  // after its result instead of a Proposed savings step.
  const prompts = [
    'Current Balance',
    'Income',
    'Bills',
    'Balance after bills',
    'Household budget',
    'Balance After Deductions',
  ];

  // Check headings, not repeated words in the account caption or details.
  const waterfall = rendered.slice(rendered.indexOf('data-live-current-balance'));
  let previous = -1;
  for (const prompt of prompts) {
    const at = prompt === 'Current Balance'
      ? waterfall.indexOf('data-budget-cash-hero')
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
  ok(/Household budget/.test(rendered) && /<h2>Current balance<\/h2>/.test(rendered)
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
  const fn = liveBudgetComposerSource(planSrc);
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
