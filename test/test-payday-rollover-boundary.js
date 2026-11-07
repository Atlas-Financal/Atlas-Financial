'use strict';
/* Sep 10 → Sep 11 payday rollover.
 *
 * Independent of paydayCalendar / spendingCycle as the specification:
 * Seaspan is +14 calendar days from the 2026-08-14 anchor (ACCOUNT_FACTS).
 * Leftover cash and new salary are synthetic fixtures, not live cents (L-006).
 *
 * The producing functions are not the proof: leftover + salary, income
 * membership, and the 14-day grid are reconstructed beside Forecast.
 *
 * `node test/test-payday-rollover-boundary.js`
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
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function periodFromPayday(payday) {
  const next = addCalendarDays(payday, 14);
  return { start: payday, end: addCalendarDays(next, -1), nextPayday: next };
}
function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
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
    grab(planSrc, /^function calendarPickerHtml\([\s\S]*?\n\}$/m, 'calendarPickerHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarWaterfallHtml, calendarWaterfallsHtml, money2 });`,
    { Forecast: F }
  );
}

const ANCHOR = '2026-08-14';
const SEP10 = '2026-09-10';
const SEP11 = '2026-09-11';
const CARRY = 1000;
const SALARY = 4300;
const AMANDA = 2168.85;
const CHILD = 153.59;
const NETFLIX = 26.87;
const INDEPENDENT_AVAILABLE = roundCent(CARRY + SALARY);
const PERIOD_INCOME = roundCent(SALARY + AMANDA + CHILD);

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 2000, rate: 21.99, payment: 250, pending: 0 },
];

function rolloverPlan(openingAsOf, cash, extraOpening) {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{
        id: 'chequing-a', label: 'BILLS ACCOUNT', value: cash, class: 'spendable',
      }],
    },
    opening: Object.assign({
      asOf: openingAsOf,
      representedEvents: [{ id: 'payroll', date: '2026-08-28' }],
    }, extraOpening || {}),
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: ANCHOR, amount: SALARY, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — 15th', frequency: 'monthly',
        day: 15, amount: AMANDA, confidence: 'confirmed', firstDue: '2026-09-15',
      },
      {
        id: 'childBenefit', label: 'Child benefit', frequency: 'monthly',
        day: 20, amount: CHILD, confidence: 'confirmed',
      },
    ],
    obligations: [],
    bills: [
      {
        id: 'netflix', label: 'Netflix', frequency: 'monthly', day: 17,
        amount: NETFLIX, confidence: 'confirmed', payingAccount: 'chequing-a',
      },
    ],
    commitments: [],
    groups: [],
    funding: { options: [] },
    budget: {
      weeklyVariable: 0,
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 100 },
      ],
    },
  };
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function incomeRow(p, id, date) {
  return ((p && p.income) || []).find(r => r && r.id === id && r.date === date);
}

const expectedBefore = periodFromPayday('2026-08-28');
const expectedOn = periodFromPayday(SEP11);
const expectedFollowing = periodFromPayday(expectedOn.nextPayday);

console.log('=== 1. Independent Seaspan grid around the Sep 11 boundary ===');
{
  ok(addCalendarDays(ANCHOR, 14) === '2026-08-28',
    'first payday after the 14 Aug anchor is 28 Aug');
  ok(addCalendarDays('2026-08-28', 14) === SEP11,
    'next Seaspan payday from 28 Aug is 11 Sep');
  ok(expectedBefore.end === SEP10 && expectedBefore.nextPayday === SEP11,
    'period containing Sep 10 ends Sep 10; next payday is Sep 11');
  ok(expectedOn.start === SEP11 && expectedOn.end === '2026-09-24'
      && expectedOn.nextPayday === '2026-09-25',
    'period beginning Sep 11 ends Sep 24; following payday is Sep 25');
  ok(expectedFollowing.start === '2026-09-25' && expectedFollowing.end === '2026-10-08',
    'the following pay period is Sep 25–Oct 8');
  ok(F.financialDate('2026-09-11T06:59:59Z') === SEP10
      && F.financialDate('2026-09-11T07:00:00Z') === SEP11
      && F.financialDate('2026-09-11T00:00:00-07:00') === SEP11,
    'America/Vancouver local midnight is the Sep 11 financial date');
}

console.log('\n=== 2. Before rollover: current ends Sep 10, next payday Sep 11 ===');
{
  const plan = rolloverPlan(SEP10, CARRY);
  const advice = F.recommend(plan, SEP10, { targetBuffer: 500, debts });
  const action = advice.currentPeriodAction;
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const nextView = advice.nextPeriodView;
  ok(active && active.start === expectedBefore.start && active.end === expectedBefore.end,
    'This Pay Period is Aug 28–Sep 10',
    active && `${active.start}–${active.end}`);
  ok(action && action.nextPayday === SEP11 && action.thisPayday === expectedBefore.start,
    'currentPeriodAction next payday is Sep 11 Seaspan, thisPayday is Aug 28');
  ok(action.periodEnd === SEP10,
    'action periodEnd is Sep 10, not truncated to a later Amanda date');
  ok(next && next.start === expectedOn.start && next.end === expectedOn.end,
    'Next Pay Period is Sep 11–Sep 24');
  ok(nextView && nextView.periodStart === SEP11 && nextView.periodEnd === expectedOn.end,
    'nextPeriodView is the Sep 11 Seaspan period, not Amanda Sep 15');
  ok(!incomeRow(active, 'payroll', SEP11),
    'Sep 11 salary is absent from the still-current period');
  const leftoverIsIncome = (active.income || []).some(r =>
    r && near(r.amount, CARRY) && r.id !== 'payroll');
  ok(!leftoverIsIncome,
    'Sep 10 leftover cash is not classified as income');
  ok(near(advice.paydayAllocation.available, CARRY),
    'before payday, allocation available is leftover cash only');
}

console.log('\n=== 3. On Sep 11 leftover $1,000 is opening, $4,300 salary is income, once ===');
{
  const plan = rolloverPlan(SEP11, CARRY);
  const first = F.recommend(plan, SEP11, { targetBuffer: 500, debts });
  const reload = F.recommend(plan, SEP11, { targetBuffer: 500, debts });
  const action = first.currentPeriodAction;
  const active = period(first.defaultView, 'this-pay-period');
  const next = period(first.defaultView, 'next-pay-period');
  const nextView = first.nextPeriodView;
  const payroll = incomeRow(active, 'payroll', SEP11);
  const amanda = incomeRow(active, 'amandaSalary15', '2026-09-15');
  ok(action.mode === 'payday' && action.thisPayday === SEP11
      && action.periodStart === SEP11 && action.periodEnd === expectedOn.end
      && action.nextPayday === expectedOn.nextPayday,
    'on Sep 11, currentPeriodAction is payday Sep 11–24, next payday Sep 25');
  ok(active && active.start === expectedOn.start && active.end === expectedOn.end,
    'This Pay Period becomes Sep 11–Sep 24 automatically');
  ok(next && next.start === expectedFollowing.start && next.end === expectedFollowing.end,
    'the following pay period becomes Next Pay Period');
  ok(nextView && nextView.periodStart === expectedOn.nextPayday
      && nextView.periodEnd === expectedFollowing.end,
    'nextPeriodView is Sep 25–Oct 8, not Amanda Sep 15–24');
  ok(active.openingKnown === true && near(active.opening, CARRY),
    'opening/carryover is leftover $1,000');
  ok(payroll && near(payroll.amount, SALARY) && payroll.alreadyInCash !== true
      && payroll.otherIncome !== true,
    'Sep 11 salary is period income, not already-in-cash and not Other Income');
  ok(amanda && near(amanda.amount, AMANDA),
    'Sep 15 Amanda stays income inside the Seaspan period, not a payday reset');
  const payrollCount = (active.income || []).filter(r => r.id === 'payroll').length;
  ok(payrollCount === 1,
    'salary appears exactly once in the new current period');
  ok(near(active.incomeTotal, PERIOD_INCOME) && near(active.available, PERIOD_INCOME)
      && !near(active.available, INDEPENDENT_AVAILABLE)
      && !near(active.available, roundCent(CARRY + PERIOD_INCOME)),
    'Payday balance is period income, not leftover and not leftover plus income');
  ok(near(first.paydayAllocation.available, INDEPENDENT_AVAILABLE),
    'paydayAllocation.available independently equals leftover + same-day salary');
  const paidBills = (active.bills || []).filter(r =>
    r && (r.status === 'PAID' || r.settlement === 'represented'));
  ok(paidBills.length === 0,
    'crossing the date does not manufacture bill settlement');
  ok(!(action.inflows || []).some(r => r && r.settlement === 'represented'),
    'crossing the date does not manufacture salary settlement');
  ok(reload.currentPeriodAction.thisPayday === action.thisPayday
      && reload.currentPeriodAction.nextPayday === action.nextPayday
      && period(reload.defaultView, 'this-pay-period').start === active.start
      && near(period(reload.defaultView, 'this-pay-period').opening, CARRY),
    'a second recommend on the same as-of reprints the same period and opening');
}

console.log('\n=== 4. Represented Friday salary does not forget it is payday ===');
{
  const plan = rolloverPlan(SEP11, roundCent(CARRY + SALARY), {
    representedEvents: [{ id: 'payroll', date: SEP11 }],
  });
  const advice = F.recommend(plan, SEP11, { targetBuffer: 500, debts });
  const action = advice.currentPeriodAction;
  const active = period(advice.defaultView, 'this-pay-period');
  const payroll = incomeRow(active, 'payroll', SEP11);
  ok(action.mode === 'payday' && action.thisPayday === SEP11
      && action.nextPayday === expectedOn.nextPayday
      && action.periodEnd === expectedOn.end,
    'represented Seaspan still leaves payday mode on Sep 11 with next payday Sep 25');
  ok(payroll && payroll.alreadyInCash === true && payroll.otherIncome !== true
      && near(payroll.amount, SALARY),
    'posted salary is received/already in cash, not leftover relabelled as Other Income');
  ok(F.paydayPeriodOrigin(plan, SEP11) === SEP11,
    'paydayPeriodOrigin stays Sep 11 after the cheque is represented');
  ok(F.paydayPeriodOrigin(plan, '2026-09-16') === SEP11,
    'after Amanda\'s 15th, origin remains the Sep 11 Seaspan payday');
}

console.log('\n=== 5. Snapshot leftover stays distinct from posted salary ===');
{
  const plan = rolloverPlan(SEP11, roundCent(CARRY + SALARY), {
    priorAsOf: SEP10,
    paydaySnapshot: { periodStart: SEP11, asOf: SEP11, opening: CARRY },
    representedEvents: [{ id: 'payroll', date: SEP11 }],
  });
  const advice = F.recommend(plan, SEP11, { targetBuffer: 500, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const payroll = incomeRow(active, 'payroll', SEP11);
  ok(active.openingKnown === true && near(active.opening, CARRY)
      && active.openingSource === 'snapshot',
    'live overlay with a payday snapshot keeps leftover $1,000 as opening');
  ok(payroll && near(payroll.amount, SALARY),
    'posted salary remains a distinct income row');
  ok(!near(active.opening, roundCent(CARRY + SALARY)),
    'opening is not leftover plus salary');
  ok(near(advice.paydayAllocation.liveCurrentBalance, roundCent(CARRY + SALARY))
      && near(advice.defaultView.liveCurrentBalance, roundCent(CARRY + SALARY)),
    'live Current Balance is hub chequing-a leftover plus posted salary, not a rewritten opening');
}

console.log('\n=== 6. Active household print hides Opening; it does not add leftover as income ===');
{
  const plan = rolloverPlan(SEP11, CARRY);
  const advice = F.recommend(plan, SEP11, { targetBuffer: 500, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const composer = loadComposer();
  const html = composer.calendarWaterfallHtml(active, null, advice.paydayAllocation);
  ok(!/data-operating-prompt="Opening balance"/.test(html),
    'active waterfall hides Opening balance');
  ok(!/Carried forward, not income/.test(html),
    'carried-forward note is not required on the active household print');
  ok(/Dale salary/.test(html) && html.includes(composer.money2(SALARY))
      && !/Payroll — Seaspan/.test(html),
    'salary prints in the income block from Forecast');
  ok(/Payday balance/.test(html) && html.includes(composer.money2(active.available)),
    'Payday balance remains Forecast period.available');
  const incomeFn = grab(read('public/plan.js'),
    /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  const waterfallFn = grab(read('public/plan.js'),
    /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml');
  ok(/period\.available/.test(incomeFn) && !/\.opening\s*\+/.test(incomeFn)
      && !/\.opening\s*\+/.test(waterfallFn),
    'plan.js does not compute opening + income as a second available figure');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll payday-rollover-boundary checks passed.');
