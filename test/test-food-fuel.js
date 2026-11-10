'use strict';
/* Focused proof for the Plan page's remaining food-and-fuel monthly figures.
 * Forecast.budgetBreakdown already decides target vs historical as each
 * category's `gross` (pre-dated). The cap block publishes the grocery/fuel
 * pair from that field; `planned` stays the post-dated amount the weekly
 * cap uses. Until this move the page found the two categories and printed
 * `target || historical`.
 *
 * Before the move, replacing `food.target || food.historical` with
 * `food.historical` left npm test green — ALL 20 SUITES PASSED.
 */
const fs = require('fs');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('./fixtures/retired-fuel-policy')(require('../data.json'));
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const same = (a, b) => a === b;
const read = p => sourceText(fs.readFileSync(p, 'utf8'));

/* Independent fixture. Owner targets beat the historical averages.
 *
 *   Groceries  plannedMonthly $1,200   historical $11,000 / 10 = $1,100
 *   Fuel       plannedMonthly   $800   historical  $6,000 / 10 =   $600
 *
 *   gross (pre-dated) groceries = $1,200  (target, not $1,100)
 *   gross (pre-dated) fuel      =   $800  (target, not $600)
 *   planned, with nothing dated, equals gross
 */
const FIXTURE_PLAN = {
  windowDays: 91,
  budget: {
    basis: 'ytd',
    categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: 1200 },
      { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedMonthly: 800 },
      { id: 'dining', label: 'Dining', class: 'discretionary', from: ['Dining'], plannedMonthly: 400 },
    ],
  },
};
const FIXTURE_PERIODS = {
  periods: {
    ytd: {
      label: 'Year to date', months: 10,
      spending: [
        { label: 'Groceries', total: 11000 },
        { label: 'Fuel', total: 6000 },
        { label: 'Dining', total: 5000 },
      ],
    },
  },
};
const HAND_GROCERIES_HIST = 11000 / 10;
const HAND_FUEL_HIST = 6000 / 10;
const HAND_GROCERIES_MONTHLY = 1200;
const HAND_FUEL_MONTHLY = 800;

const breakdownOf = (plan, extra) => F.budgetBreakdown(plan, FIXTURE_PERIODS,
  Object.assign({ weeklyCap: 600 }, extra || {}));

console.log('=== hand-computed monthly grocery and fuel figures ===');
ok(HAND_GROCERIES_HIST === 1100 && HAND_FUEL_HIST === 600,
  'historical averages are $11,000/10 and $6,000/10');
ok(HAND_GROCERIES_MONTHLY !== HAND_GROCERIES_HIST
  && HAND_FUEL_MONTHLY !== HAND_FUEL_HIST,
  'the owner targets are not the historical averages — the fallback is load-bearing');

const breakdown = breakdownOf(FIXTURE_PLAN);
const cap = breakdown.cap;
const groceries = breakdown.categories.find(c => c.id === 'groceries');
const fuel = breakdown.categories.find(c => c.id === 'fuel');
ok(!!cap && !!groceries && !!fuel, 'a cap result and both categories are returned');
ok(groceries && same(groceries.gross, HAND_GROCERIES_MONTHLY)
  && same(groceries.planned, HAND_GROCERIES_MONTHLY)
  && groceries.source === 'owner-target',
  'category gross is the $1,200 owner target; planned matches with nothing dated');
ok(fuel && same(fuel.gross, HAND_FUEL_MONTHLY) && fuel.source === 'owner-target',
  'fuel gross is the $800 owner target');
ok(cap && same(cap.groceriesMonthly, groceries.gross)
  && same(cap.fuelMonthly, fuel.gross),
  'the cap publishes those gross amounts, not a second target-vs-historical choice');
ok(cap && cap.groceriesHasOwnerTarget === true
  && cap.groceriesHasOwnerTarget === (groceries.source === 'owner-target'),
  'the owner-target chip follows category source');

console.log('\n=== fallback: no owner target uses the historical average ===');
const noTargetPlan = {
  windowDays: 91,
  budget: {
    basis: 'ytd',
    categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: null },
      { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'] },
    ],
  },
};
const none = breakdownOf(noTargetPlan);
ok(none && same(none.categories.find(c => c.id === 'groceries').gross, HAND_GROCERIES_HIST)
  && none.categories.find(c => c.id === 'groceries').source === 'historical-actual'
  && same(none.cap.groceriesMonthly, HAND_GROCERIES_HIST)
  && same(none.cap.fuelMonthly, HAND_FUEL_HIST)
  && none.cap.groceriesHasOwnerTarget === false,
  'missing targets print $1,100 and $600 historical, with no owner-target chip');

console.log('\n=== a $0 owner target is a figure, not a missing one ===');
/* The page used `target || historical`. A household that budgets $0 for
 * groceries would have published the historical average instead. */
const zeroPlan = {
  windowDays: 91,
  budget: {
    basis: 'ytd',
    categories: [
      { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedMonthly: 0 },
      { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedMonthly: 800 },
    ],
  },
};
const zero = breakdownOf(zeroPlan);
const zeroG = zero.categories.find(c => c.id === 'groceries');
ok(zeroG && same(zeroG.gross, 0) && zeroG.source === 'owner-target'
  && same(zero.cap.groceriesMonthly, 0) && zero.cap.groceriesHasOwnerTarget === true,
  'a $0 grocery target publishes $0, not the $1,100 historical',
  zeroG ? String(zeroG.gross) : 'none');
ok((0 || HAND_GROCERIES_HIST) === HAND_GROCERIES_HIST,
  'confirming `||` would have fallen through to historical');

console.log('\n=== dated items reduce planned, not the published monthly gross ===');
/* A $100 dated grocery bill. gross stays the $1,200 target; planned is
 * $1,100. The Plan sentence is the household budget, not the cap remainder. */
const datedPlan = {
  windowDays: 91,
  // A6 (#726): a dayless monthly bill is undated and leaves its category's
  // dated figure unknown; day 1 keeps this check on its subject.
  bills: [{ label: 'dated grocery', amount: 100, frequency: 'monthly', day: 1, budgetCategory: 'groceries' }],
  budget: FIXTURE_PLAN.budget,
};
const dated = breakdownOf(datedPlan);
const datedG = dated.categories.find(c => c.id === 'groceries');
ok(datedG && same(datedG.gross, HAND_GROCERIES_MONTHLY)
  && same(datedG.planned, HAND_GROCERIES_MONTHLY - 100)
  && same(datedG.dated, 100),
  'dated $100 leaves gross at $1,200 and planned at $1,100');
ok(dated.cap && same(dated.cap.groceriesMonthly, datedG.gross)
  && same(dated.cap.foodFuelPlannedMonthly, datedG.planned + HAND_FUEL_MONTHLY),
  'the sentence still prints gross; the weekly pair uses planned');

console.log('\n=== live plan: owner-target literals, not the averages ===');
const LIVE_GROCERIES_PAYDAY = 900;
const LIVE_GROCERIES = Math.round(LIVE_GROCERIES_PAYDAY * (365.25 / 12) / 14 * 100) / 100;
const LIVE_FUEL_PAYDAY = 325;
const LIVE_FUEL = Math.round(LIVE_FUEL_PAYDAY * (365.25 / 12) / 14 * 100) / 100;
const LIVE_GROCERIES_HIST = 11380.12 / 8;
const LIVE_FUEL_HIST = 6517.05 / 8;
ok(data.plan.budget.categories.find(c => c.id === 'groceries').plannedPayday === LIVE_GROCERIES_PAYDAY
  && data.plan.budget.categories.find(c => c.id === 'groceries').plannedMonthly == null
  && data.plan.budget.categories.find(c => c.id === 'groceries').plannedWeekly == null,
  'data.json grocery target is $900/payday with no stored monthly, not $450/week');
ok(data.plan.budget.categories.find(c => c.id === 'fuel').plannedPayday === LIVE_FUEL_PAYDAY
  && data.plan.budget.categories.find(c => c.id === 'fuel').plannedMonthly == null,
  'data.json fuel target is $325/payday');
ok(periods.periods.ytd.months === 8
  && periods.periods.ytd.spending.find(s => s.label === 'Groceries').total === 11380.12
  && periods.periods.ytd.spending.find(s => s.label === 'Fuel & transport').total === 6517.05,
  'cleaned YTD grocery/fuel totals are $11,380.12 and $6,517.05 over 8 months');
ok(LIVE_GROCERIES !== LIVE_GROCERIES_HIST && LIVE_FUEL !== LIVE_FUEL_HIST,
  'those averages are $1,422.52 and $814.63 — not the published monthly figures');

const liveAdv = F.recommend(data.plan, data.meta.asOf, {
  scenario: data.plan.defaults.scenario, targetBuffer: data.plan.defaults.targetBuffer,
  extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: data.debts,
  extraDebtTarget: data.plan.nextDollar.target, fundingSources: data.plan.funding.options,
});
const liveB = F.budgetBreakdown(data.plan, periods, {
  paypalPerMonth: data.paypal.perMonth, disabled: [],
  weeklyCap: liveAdv.weekly, recommendedWeekly: liveAdv.weekly,
});
const liveG = liveB.categories.find(c => c.id === 'groceries');
const liveF = liveB.categories.find(c => c.id === 'fuel');
ok(liveG && liveF && same(liveG.gross, LIVE_GROCERIES) && same(liveF.gross, LIVE_FUEL)
  && liveG.dated === 0 && liveF.dated === 0
  && same(liveG.planned, LIVE_GROCERIES) && same(liveF.planned, LIVE_FUEL),
  'live grocery/fuel gross are payday-annualized $900 groceries / payday-annualized fuel; nothing dated');
ok(liveB.cap && same(liveB.cap.groceriesMonthly, liveG.gross)
  && same(liveB.cap.fuelMonthly, liveF.gross)
  && liveB.cap.groceriesHasOwnerTarget === true,
  'live Plan sentence is payday-annualized groceries and payday-annualized fuel, both owner targets',
  liveB.cap ? `${liveB.cap.groceriesMonthly} / ${liveB.cap.fuelMonthly}` : 'none');
ok(liveB.cap && same(liveB.cap.foodFuelPlannedMonthly, LIVE_GROCERIES + LIVE_FUEL),
  'and the already-owned weekly pair still sums those same two planned months',
  liveB.cap ? String(liveB.cap.foodFuelPlannedMonthly) : 'none');

console.log('\n=== page is a renderer; againstCap does not re-decide ===');
const page = read('public/plan.js');
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok(/cap\.groceriesMonthly/.test(page) && /cap\.fuelMonthly/.test(page),
  'the Plan page reads the monthly figures from the cap block');
ok(/cap\.groceriesHasOwnerTarget/.test(page),
  'and the owner-budget chip from the returned flag');
ok(!/id === 'groceries'/.test(pageCode) && !/id === 'fuel'/.test(pageCode),
  'the page no longer selects the grocery or fuel category');
ok(!/target\s*\|\|\s*\w*\.?historical/.test(pageCode),
  'the page no longer chooses target || historical');

const FORECAST_SRC = read('public/forecast.js');
const againstStart = FORECAST_SRC.indexOf('function againstCap(');
const againstEnd = FORECAST_SRC.indexOf('function projectDebts', againstStart);
const againstSrc = againstStart >= 0 && againstEnd > againstStart
  ? FORECAST_SRC.slice(againstStart, againstEnd) : '';
ok(!!againstSrc, 'againstCap is readable from engine source');
ok(/groceriesMonthly = groceries\.gross/.test(againstSrc)
  && /fuelMonthly = fuel\.gross/.test(againstSrc),
  'againstCap reads category gross for the grocery/fuel monthly figures');
ok(/groceriesHasOwnerTarget = groceries\.source === 'owner-target'/.test(againstSrc),
  'and owner-target state from category source');
ok(!/target\s*!=\s*null\s*\?/.test(againstSrc),
  'againstCap does not re-implement target vs historical');

console.log('\n=== mutation: the incumbent gross choice now fails ===');
const FROM = '      const gross = target != null ? target\n'
  + '        : regime ? (datedTotal == null ? null : (undatedCurrent || 0) + datedTotal)\n'
  + '        : historical;';
const TO = '      const gross = historical;';
ok(FORECAST_SRC.split(FROM).length - 1 === 1,
  'the target-vs-historical choice appears once in the engine, so the mutation is aimed');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(FORECAST_SRC.replace(FROM, TO), sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const brokenB = mutant && mutant.budgetBreakdown(FIXTURE_PLAN, FIXTURE_PERIODS, { weeklyCap: 600 });
const brokenG = brokenB && brokenB.categories.find(c => c.id === 'groceries');
ok(mutant && brokenG && same(brokenG.gross, HAND_GROCERIES_HIST)
  && same(brokenB.cap.groceriesMonthly, HAND_GROCERIES_HIST)
  && !same(brokenB.cap.groceriesMonthly, HAND_GROCERIES_MONTHLY),
  'dropping the owner target publishes $1,100 historical instead of $1,200',
  brokenB ? String(brokenB.cap.groceriesMonthly) : 'mutant missing');
ok(cap && same(cap.groceriesMonthly, HAND_GROCERIES_MONTHLY)
  && same(groceries.gross, HAND_GROCERIES_MONTHLY),
  'the real engine still answers the hand-computed $1,200 on the same fixture');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
