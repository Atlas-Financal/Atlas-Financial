'use strict';
/* Budget timeline must print Forecast's 2027 payroll estimate.
 *
 * The swipe suite stubs calendarWaterfallHtml, so it cannot see this.
 * This proof selects a Forecast.recommend row and renders it through the
 * real payPeriodTimelineHtml, calendarWaterfallHtml, and calendarIncomeHtml.
 * Amounts are the synthetic regime's own figures. No live household cents.
 *
 * `node test/test-budget-estimated-payroll-label.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (condition, label, detail = '') => {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
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
    grab(planSrc, /^function liveOperatingPlanUnavailable\([\s\S]*?\n\}$/m, 'liveOperatingPlanUnavailable'),
    grab(planSrc, /^function liveOperatingPlanNote\([\s\S]*?\n\}$/m, 'liveOperatingPlanNote'),
    grab(planSrc, /^function paydayGlanceCashNote\([\s\S]*?\n\}$/m, 'paydayGlanceCashNote'),
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function glanceSignedMoney\([\s\S]*?\n\}$/m, 'glanceSignedMoney'),
    grab(planSrc, /^function glanceMoney\([\s\S]*?\n\}$/m, 'glanceMoney'),
    grab(planSrc, /^function glanceLineLabel\([\s\S]*?\n\}$/m, 'glanceLineLabel'),
    grab(planSrc, /^function cashGlanceHtml\([\s\S]*?\n\}$/m, 'cashGlanceHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
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
    grab(planSrc, /^function payPeriodSelection\([\s\S]*?\n\}$/m, 'payPeriodSelection'),
    grab(planSrc, /^function payPeriodRangeLabel\([\s\S]*?\n\}$/m, 'payPeriodRangeLabel'),
    grab(planSrc, /^function payPeriodStatusLabel\([\s\S]*?\n\}$/m, 'payPeriodStatusLabel'),
    grab(planSrc, /^function payPeriodCloseMonth\([\s\S]*?\n\}$/m, 'payPeriodCloseMonth'),
    grab(planSrc, /^function payPeriodMonths\([\s\S]*?\n\}$/m, 'payPeriodMonths'),
    grab(planSrc, /^function payPeriodNavigatorHtml\([\s\S]*?\n\}$/m, 'payPeriodNavigatorHtml'),
    grab(planSrc, /^function budgetPlanSpendEarmarkHtml\([\s\S]*?\n\}$/m, 'budgetPlanSpendEarmarkHtml'),
    grab(planSrc, /^function payPeriodTimelineHtml\([\s\S]*?\n\}$/m, 'payPeriodTimelineHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({
      payPeriodTimelineHtml, calendarWaterfallHtml, calendarIncomeHtml, money2
    });`,
    { Forecast: F }
  );
}

const ANCHOR = '2026-08-14';
const AS_OF = '2026-10-09';
const DALE = 4000;
const DALE_2027 = 3849.40;
const OBSERVED = 4100;

function timelinePlan(asOf) {
  return {
    defaults: { targetBuffer: 500 },
    windowDays: 91,
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2000, class: 'spendable',
      }],
    },
    opening: { asOf },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: ANCHOR, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — 15th', frequency: 'monthly',
        day: 15, amount: 2000, confidence: 'confirmed',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'monthly',
        day: 20, amount: 500, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'mortgage', label: 'Mortgage', amount: 1600,
        frequency: 'monthly', day: 1, confidence: 'confirmed',
        payingAccount: 'chequing-a',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', plannedWeekly: 100 },
      ],
    },
    payrollPlanningAssumptions: {
      salaryRaiseFactor: 1.04,
      bonusRate: 0.18,
      authorizedThroughYear: 2027,
    },
  };
}

function recommend(plan, asOf, opts) {
  return F.recommend(plan, asOf || AS_OF, Object.assign({
    targetBuffer: 500,
    debts: [],
  }, opts || {}));
}

function incomeOn(period, id, date) {
  return ((period && period.income) || []).filter(row => row && row.id === id && (!date || row.date === date));
}

function payrollLine(html) {
  const match = String(html || '').match(/<div class="operating-line" data-period-income="payroll"[\s\S]*?<\/div>/);
  return match ? match[0] : '';
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');

console.log('=== Forecast 2027 payroll keeps its estimate on the real timeline ===');
{
  const plan = timelinePlan(AS_OF);
  const advice = recommend(plan);
  const period = (advice.payPeriodViews || []).find(row => row && row.id === 'future:2027-01-01');
  const dale = incomeOn(period, 'payroll', '2027-01-01')[0];
  ok(!!period && period.timelineRole === 'future' && period.start === '2027-01-01',
    'Forecast publishes future:2027-01-01');
  ok(dale && dale.status === 'estimated' && dale.settlement === 'estimated'
      && dale.confidence === 'estimated' && dale.incomeRegime === '2027-estimated'
      && near(dale.amount, DALE_2027) && dale.amount !== DALE,
    'Forecast January payroll stays estimated at 3849.40',
    dale && [dale.status, dale.settlement, dale.confidence, dale.incomeRegime, dale.amount].join(' '));

  const printed = '+' + composer.money2(dale.amount);
  const timeline = composer.payPeriodTimelineHtml(advice, period.id, null, advice.paydayAllocation, '', plan);
  const waterfall = composer.calendarWaterfallHtml(period, null, advice.paydayAllocation, plan);
  const income = composer.calendarIncomeHtml(period);
  const surfaces = [
    ['timeline', timeline],
    ['waterfall', waterfall],
    ['income', income],
  ];
  for (const [name, html] of surfaces) {
    const line = payrollLine(html);
    ok(line && /data-income-status="estimated"/.test(line)
        && /<span class="est">≈ estimated<\/span>/.test(line)
        && line.includes(printed)
        && /Dale salary/.test(line),
      name + ' shows the estimate marker, preserved status, and Forecast amount',
      line);
    ok(!/data-income-status="arriving"/.test(line),
      name + ' does not relabel the estimate as arriving');
  }
  ok(/data-calendar-waterfall="future:2027-01-01"/.test(timeline)
      && /data-calendar-income/.test(timeline)
      && /data-pay-period-swipe/.test(timeline),
    'the timeline HTML is the real waterfall and income renderer');
  ok(/data-household-as-of="2026-10-09"/.test(timeline)
      && !/data-household-as-of="2027-01-01"/.test(timeline),
    'the selected 2027 row still uses the household as-of, not its own start');
  ok(!/data-live-current-balance/.test(timeline),
    'the future estimated row still has no live Current Balance');
  ok(/data-selected-pay-period-status>[\s\S]*?Projected pay period\s*</.test(timeline),
    'the period heading stays the projected role label');
}

console.log('\n=== confirmed and observed payroll stay unmarked ===');
{
  const plan = timelinePlan(AS_OF);
  const advice = recommend(plan);
  const current = (advice.payPeriodViews || []).find(row => row && row.timelineRole === 'current');
  const currentDale = incomeOn(current, 'payroll', '2026-10-09')[0];
  const december = (advice.payPeriodViews || []).find(row => row && row.id === 'future:2026-12-18');
  const decemberDale = incomeOn(december, 'payroll', '2026-12-18')[0];
  ok(currentDale && !currentDale.incomeRegime && currentDale.status !== 'estimated'
      && near(currentDale.amount, DALE),
    'current 2026 Dale payroll is the confirmed fixture, not the 2027 estimate',
    currentDale && [currentDale.status, currentDale.confidence, currentDale.amount].join(' '));
  ok(decemberDale && !decemberDale.incomeRegime && decemberDale.status !== 'estimated'
      && decemberDale.settlement !== 'estimated' && near(decemberDale.amount, DALE),
    'December 2026 projected Dale payroll stays the confirmed fixture',
    decemberDale && [decemberDale.status, decemberDale.settlement, decemberDale.amount].join(' '));

  for (const [name, period, row] of [
    ['current confirmed', current, currentDale],
    ['december projected', december, decemberDale],
  ]) {
    const html = composer.payPeriodTimelineHtml(advice, period.id, null, advice.paydayAllocation, '', plan);
    const line = payrollLine(html);
    const printed = '+' + composer.money2(row.amount);
    ok(line && line.includes(printed)
        && !/≈ estimated/.test(line)
        && !/data-income-status="estimated"/.test(line)
        && /Dale salary/.test(line),
      name + ' payroll keeps its amount and has no estimate marker',
      line);
  }

  const observedPlan = timelinePlan('2027-01-01');
  observedPlan.startingCash.breakdown[0].value = OBSERVED;
  observedPlan.opening.representedEvents = [{ id: 'payroll', date: '2027-01-01' }];
  const observed = recommend(observedPlan, '2027-01-01', {
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1',
      observationAsOf: '2027-01-01',
      coverageStart: '2027-01-01',
      coverageThrough: '2027-01-01',
      pendingCoverage: 'complete',
      transactions: [],
      representedActuals: [{ id: 'payroll', date: '2027-01-01', actual: OBSERVED }],
    },
  });
  const observedPeriod = (observed.payPeriodViews || []).find(row => row && row.timelineRole === 'current');
  const observedDale = incomeOn(observedPeriod, 'payroll', '2027-01-01')[0];
  ok(observedDale && near(observedDale.amount, OBSERVED)
      && observedDale.amount !== DALE_2027
      && !observedDale.incomeRegime
      && observedDale.status !== 'estimated'
      && observedDale.settlement !== 'estimated',
    'settlement evidence supersedes the estimate on the Forecast row',
    observedDale && [observedDale.status, observedDale.settlement, observedDale.confidence, observedDale.incomeRegime, observedDale.amount].join(' '));
  const observedHtml = composer.payPeriodTimelineHtml(
    observed, observedPeriod.id, null, observed.paydayAllocation, '', observedPlan);
  const observedLine = payrollLine(observedHtml);
  const observedWaterfall = payrollLine(composer.calendarWaterfallHtml(
    observedPeriod, null, observed.paydayAllocation, observedPlan));
  const observedIncome = payrollLine(composer.calendarIncomeHtml(observedPeriod));
  const observedPrinted = '+' + composer.money2(observedDale.amount);
  for (const [name, line] of [
    ['timeline', observedLine],
    ['waterfall', observedWaterfall],
    ['income', observedIncome],
  ]) {
    ok(line && line.includes(observedPrinted)
        && !line.includes(composer.money2(DALE_2027))
        && !/≈ estimated/.test(line)
        && !/data-income-status="estimated"/.test(line)
        && /data-income-status="/.test(line),
      name + ' renders the observed Forecast row without an estimate marker',
      line);
  }
  ok(/data-live-current-balance/.test(observedHtml)
      && /data-household-as-of=/.test(observedHtml),
    'the current observed row still shows Current Balance and the household as-of');
}

console.log('\n=== the marker reads Forecast trust fields, not a date ===');
{
  ok(/row\.status === 'estimated'/.test(incomeFn)
      && /row\.settlement === 'estimated'/.test(incomeFn)
      && /row\.incomeRegime === '2027-estimated'/.test(incomeFn),
    'calendarIncomeHtml reads Forecast status, settlement, and incomeRegime');
  ok(!/Date\.now|new Date|period\.start|getFullYear|2027-01-01/.test(incomeFn),
    'calendarIncomeHtml does not infer the estimate from a clock or a period date');
  ok(!/3849\.40|4100|4000/.test(incomeFn),
    'calendarIncomeHtml does not infer the estimate from an amount');
}

if (failures) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
