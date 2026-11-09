'use strict';
/* Plan payday waterfall: Current Balance date is provider balance evidence,
 * not Atlas fetchedAt; Payday balance is displayed payday income,
 * before bills and household budget (L-002 / L-006). Opening cash is
 * not a term in that allocation waterfall.
 *
 * `node test/test-plan-payday-waterfall-balance.js`
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
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
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
    `${source}\n({ calendarWaterfallHtml, calendarWaterfallsHtml, glanceUpdatedNote, providerBalanceDate, money2 });`,
    { Forecast: F }
  );
}

const PAYDAY = '2026-09-11';
const OPENING_CASH = 1000;
const DALE = 2000;
const AMANDA = 1500;
const BILL = 80;
const GROCERIES = 450;

const debts = [
  {
    id: 'cashback', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 200, rate: 19.99, payment: 20, pending: 0,
  },
  {
    id: 'mortgage', label: 'Mortgage', secured: true,
    structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0,
  },
];

function paydayPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: OPENING_CASH },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [
      {
        id: 'netflix', label: 'Netflix', frequency: 'once',
        date: '2026-09-12', amount: BILL, confidence: 'confirmed',
      },
    ],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedMonthly: GROCERIES, ownerLine: 'Groceries',
        },
        {
          id: 'household', label: 'Household', class: 'essential',
          plannedMonthly: 75, ownerLine: 'Household',
        },
        {
          id: 'pets', label: 'Pets', class: 'essential',
          plannedMonthly: 200, ownerLine: 'Dog food',
        },
      ],
    },
  };
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}

function incomeRow(p, id) {
  return ((p && p.income) || []).find(r => r && r.id === id) || null;
}

const composer = loadComposer();
const planSrc = read('public/plan.js');
const forecastSrc = read('public/forecast.js');
const observeSrc = read('scripts/provider-observe.js');

console.log('=== 1. Provider balance date and fetchedAt stay distinct ===');
{
  const fetchedAt = '2026-09-04T18:00:00.000Z';
  const providerDay = '2026-09-03';
  ok(providerDay !== fetchedAt.slice(0, 10),
    'fixture provider day and Atlas fetch calendar day are different');
  const overlay = {
    applied: true,
    operatingPlan: 'live',
    fetchedAt,
    observedAt: fetchedAt,
    observedAsOf: '2026-09-04',
    observedCash: {
      complete: true,
      asOf: '2026-09-04',
      accounts: [
        { id: 'chequing-a', value: 400, evidenceDate: providerDay },
        { id: 'chequing-b', value: 200, evidenceDate: providerDay },
      ],
    },
  };
  ok(composer.providerBalanceDate(overlay) === providerDay,
    'providerBalanceDate uses cash evidenceDate, not overlay observedAsOf or fetchedAt');
  const note = composer.glanceUpdatedNote('2026-09-04', overlay);
  ok(/As of September 3/.test(note) && !/September 4/.test(note) && !/6:00/.test(note),
    'Current Balance note uses the provider observation date, not fetchedAt');
  const promptHtml = composer.calendarWaterfallsHtml({
    liveCurrentBalance: OPENING_CASH,
    asOf: '2026-09-04',
    calendarPeriods: [{
      id: 'this-pay-period',
      role: 'active',
      openingKnown: true,
      opening: OPENING_CASH,
      currentBalance: OPENING_CASH,
      available: OPENING_CASH,
      income: [],
      bills: [],
      householdBudget: [],
      cashNote: null,
    }],
    activeCalendarPeriodId: 'this-pay-period',
  }, 'this-pay-period', overlay, {
    available: OPENING_CASH,
    liveCurrentBalance: OPENING_CASH,
    cashBasis: { asOf: '2026-09-04' },
    asOf: '2026-09-04',
  });
  ok(/data-live-current-balance/.test(promptHtml)
      && /as of September 3/.test(promptHtml),
    'live Current Balance glance uses the provider observation date');
  ok(!/data-operating-prompt="Current balance as of September 3"/.test(promptHtml),
    'active payday card does not use Current Balance as a waterfall prompt');
  ok(!/6:00/.test(promptHtml) && !/18:00/.test(promptHtml),
    'live glance does not print the Atlas fetch date or time');
}

console.log('\n=== 2. No hardcoded Lunch Money hour and no browser-clock freshness ===');
{
  const dateFns = [
    grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate'),
    grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote'),
    grab(planSrc, /^function calendarWaterfallHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallHtml'),
    grab(planSrc, /^function liveCurrentBalanceHtml\([\s\S]*?\n\}$/m, 'liveCurrentBalanceHtml'),
    grab(planSrc, /^function calendarWaterfallsHtml\([\s\S]*?\n\}$/m, 'calendarWaterfallsHtml'),
  ].join('\n');
  ok(!/3\s*a\.?m\.?/i.test(dateFns) && !/\b03:00\b/.test(dateFns)
      && !/refresh hour|Lunch Money.*hour|assumed.*update/i.test(dateFns),
    'Current Balance date helpers do not hardcode a Lunch Money refresh hour');
  const glanceFn = grab(planSrc, /^function glanceUpdatedNote\([\s\S]*?\n\}$/m, 'glanceUpdatedNote');
  const providerFn = grab(planSrc, /^function providerBalanceDate\([\s\S]*?\n\}$/m, 'providerBalanceDate');
  ok(!/Date\.now/.test(glanceFn) && !/Date\.now/.test(providerFn)
      && !/new Date\(\s*\)/.test(glanceFn) && !/new Date\(\s*\)/.test(providerFn)
      && !/fetchedAt/.test(glanceFn) && !/fetchedAt/.test(providerFn),
    'date helpers do not use Date.now, a naked new Date(), or fetchedAt');
  ok(/observedAsOf|evidenceDate/.test(providerFn),
    'date helper reads incumbent provider observation fields');
  ok(!/3\s*a\.?m\.?|03:00/.test(observeSrc)
      || /updated_at|balance_as_of|genericAccountEvidenceInstant/.test(observeSrc),
    'provider-observe still dates cash from provider timestamps, not a clock hour');
}

console.log('\n=== 3. Current-period Payday balance = Dale + Amanda ===');
{
  const plan = paydayPlan();
  const advice = F.recommend(plan, PAYDAY, { targetBuffer: 0, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const dale = incomeRow(active, 'payroll');
  const amanda = incomeRow(active, 'amandaPayday');
  const independentOpening = OPENING_CASH;
  const independentPayday = roundCent(DALE + AMANDA);
  ok(active && active.role === 'active' && active.start === PAYDAY,
    'This Pay Period is the Sep 11 payday window');
  ok(near(active.opening, independentOpening)
      && near(active.currentBalance, independentOpening)
      && near(active.opening, advice.paydayAllocation.opening),
    'current opening is posted cash, not opening plus modelled payday income');
  ok(dale && near(dale.amount, DALE) && dale.alreadyInCash !== true,
    'Dale payday income is printed and arriving');
  ok(amanda && near(amanda.amount, AMANDA) && amanda.alreadyInCash !== true,
    'Amanda payday income is printed and arriving');
  ok(near(active.incomeAdded, roundCent(DALE + AMANDA)),
    'incomeAdded independently equals Dale + Amanda');
  ok(near(active.available, independentPayday)
      && near(active.available, roundCent(dale.amount + amanda.amount))
      && near(active.available, active.incomeTotal),
    'Payday balance independently equals Dale + Amanda');
  ok(!near(active.available, independentOpening)
      && !near(active.available, roundCent(independentOpening + DALE + AMANDA)),
    'Payday balance is not the opening and does not add opening cash');
}

console.log('\n=== 4. Bills and Household Budget stay downstream ===');
{
  const plan = paydayPlan();
  const advice = F.recommend(plan, PAYDAY, { targetBuffer: 0, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const afterPayday = roundCent(DALE + AMANDA);
  ok(near(active.remainingBills, BILL),
    'the Netflix bill is remaining in This Pay Period');
  ok(near(active.afterBills, roundCent(active.incomeTotal - BILL))
      && near(active.afterRemainingBills, active.afterBills)
      && !near(active.afterBills, roundCent(active.opening + active.incomeAdded - BILL)),
    'Balance after bills is displayed income minus assigned period bills, not opening plus income minus bills');
  ok(active.budgetHold != null && active.budgetHold > 0,
    'Household Budget still publishes a hold');
  ok(near(active.afterHouseholdBudget, roundCent(active.afterBills - active.budgetHold)),
    'Household Budget is subtracted after bills, not inside Payday balance');
  ok(near(active.available, afterPayday)
      && !near(active.available, active.afterRemainingBills)
      && !near(active.available, active.afterHouseholdBudget),
    'Payday balance excludes bills and household budget');
}

console.log('\n=== 5. Household-facing label and render-only page ===');
{
  const plan = paydayPlan();
  const advice = F.recommend(plan, PAYDAY, { targetBuffer: 0, debts });
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const html = composer.calendarWaterfallsHtml(
    advice.defaultView, 'this-pay-period', null, advice.paydayAllocation);
  ok(/data-live-current-balance/.test(html),
    'live Current Balance is rendered outside the payday card');
  ok(/Payday balance/.test(html) && html.includes(composer.money2(active.available)),
    'Income block prints Forecast period.available as Payday balance');
  ok(!/data-operating-prompt="Balance after payday"/.test(html),
    'waterfall does not publish a competing Balance after payday row');
  ok(!/data-operating-prompt="Available balance"/.test(html),
    'Available balance is no longer the payday-waterfall label');
  const incomeFn = grab(planSrc, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/period\.available/.test(incomeFn)
      && /Payday balance/i.test(incomeFn)
      && !/\.opening\s*\+/.test(incomeFn)
      && !/Assigned income/i.test(incomeFn)
      && !/Total income/i.test(incomeFn),
    'plan.js renders Forecast available as Payday balance; it does not compute opening + income');
  const nextHtml = composer.calendarWaterfallHtml(next, {
    applied: true,
    operatingPlan: 'live',
    fetchedAt: '2026-09-04T18:00:00.000Z',
    observedAsOf: '2026-09-03',
    observedCash: {
      complete: true,
      asOf: '2026-09-03',
      accounts: [{ id: 'chequing-a', value: 1, evidenceDate: '2026-09-03' }],
    },
  }, advice.paydayAllocation);
  ok(/data-operating-prompt="Opening balance"/.test(nextHtml),
    'Next Pay Period keeps Opening balance, not a live Current balance as-of');
  ok(!/Current balance as of/.test(nextHtml)
      && /Projected opening\. Not today's balance/.test(nextHtml),
    'next-period opening is not labelled as a provider-observed current balance');
  const cashLeftover = roundCent(
    (Number(active.opening) || 0) + (Number(active.incomeAdded) || 0)
    - (Number(active.periodBillLoad) || 0) - (Number(active.budgetHold) || 0));
  ok(next && next.projected === true && next.role === 'future'
      && near(next.opening, cashLeftover)
      && (active.projectedEnding == null || !near(next.opening, active.projectedEnding)
        || near(cashLeftover, active.projectedEnding)),
    'next-period future opening remains the previous cash leftover, not Balance After Deductions');
}

console.log('\n=== 6. Fail-closed date and dated opening stay honest ===');
{
  ok(composer.providerBalanceDate(null) == null, 'no overlay yields no provider date');
  ok(composer.providerBalanceDate({
    applied: false,
    operatingPlan: 'unavailable',
    fetchedAt: '2026-09-04T18:00:00.000Z',
    observedAsOf: '2026-09-03',
  }) == null, 'untrusted overlay does not publish a provider date');
  const disagreeingOverlay = {
    applied: true,
    operatingPlan: 'live',
    fetchedAt: '2026-09-04T18:00:00.000Z',
    observedAsOf: '2026-09-04',
    observedCash: {
      complete: true,
      accounts: [
        { id: 'chequing-a', evidenceDate: '2026-09-03' },
        { id: 'chequing-b', evidenceDate: '2026-09-02' },
      ],
    },
  };
  ok(composer.providerBalanceDate(disagreeingOverlay) == null,
    'disagreeing cash evidence dates fail closed');
  const undated = composer.glanceUpdatedNote('2026-09-04', disagreeingOverlay);
  ok(undated === 'Current Balance. Not credit.'
      && !/Updated/.test(undated) && !/As of/.test(undated)
      && !/Sep/.test(undated) && !/September/.test(undated),
    'trusted overlay with disagreeing cash dates prints Current Balance without a date');
  const disagreeingHtml = composer.calendarWaterfallsHtml({
    liveCurrentBalance: OPENING_CASH,
    asOf: '2026-09-04',
    calendarPeriods: [{
      id: 'this-pay-period',
      role: 'active',
      openingKnown: true,
      opening: OPENING_CASH,
      currentBalance: OPENING_CASH,
      available: OPENING_CASH,
      income: [],
      bills: [],
      householdBudget: [],
      cashNote: null,
    }],
    activeCalendarPeriodId: 'this-pay-period',
  }, 'this-pay-period', disagreeingOverlay, {
    available: OPENING_CASH,
    liveCurrentBalance: OPENING_CASH,
    cashBasis: { asOf: '2026-09-04' },
    asOf: '2026-09-04',
  });
  ok(/data-live-current-balance/.test(disagreeingHtml)
      && !/Updated Sep/.test(disagreeingHtml)
      && !/Updated September/.test(disagreeingHtml)
      && !/As of September/.test(disagreeingHtml)
      && !/as of September/.test(disagreeingHtml)
      && !/Current balance as of/.test(disagreeingHtml),
    'live glance with disagreeing cash dates does not invent a Current Balance date');
  const dated = composer.glanceUpdatedNote('2026-08-19', null);
  ok(/Updated Aug 19/.test(dated) && !/As of/.test(dated),
    'dated opening without provider evidence keeps Updated as-of, and does not invent a live date');
}

if (failures) {
  console.log(`\nFAILED ${failures}`);
  process.exit(1);
}
console.log('\nAll payday-waterfall balance proofs passed.');
