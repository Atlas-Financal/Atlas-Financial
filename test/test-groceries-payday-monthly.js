'use strict';
/* Groceries is $900 per 14-day Seaspan payday cycle (owner 2026-09-22).
 *
 * The 2026-09-18 pair (plannedPayday 450 and plannedMonthly 900) is retired.
 * plannedMonthly is null, the payday-only schema Fuel already uses. Month and
 * trajectory surfaces annualize that payday amount through Forecast. They do
 * not keep a second stored monthly grocery target.
 *
 * Independent of Forecast.paydayCyclePlanned / ownerTargetMonthly (L-002):
 * a declared plannedPayday 900 on a 14-day Seaspan window is already the
 * cycle reserve. The month figure is that payday amount × (365.25/12) / 14.
 * Hold is max(planned, eligible actual). Balance After Household Budget
 * moves by the hold difference from a $450 reserve, not by a second grocery
 * deduction.
 *
 * `node test/test-groceries-payday-monthly.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const live = require('./fixtures/retired-fuel-policy')(
  require('./fixtures/retired-other-policy')(require('../data.json')));
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

const GROCERY_PAYDAY = 900;
const PRIOR_GROCERY_PAYDAY = 450;
const RESERVE_DELTA = GROCERY_PAYDAY - PRIOR_GROCERY_PAYDAY;
const SEASPAN_ANCHOR = '2026-08-14';
const AS_OF = '2026-09-18';
const CYCLE_START = '2026-09-11';
const CYCLE_END = '2026-09-24';
const CALENDAR_MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = CALENDAR_MONTH_DAYS / 7;
const GROCERY_MONTHLY = roundCent(GROCERY_PAYDAY * CALENDAR_MONTH_DAYS / 14);
const PRIOR_ANNUALIZED_MONTHLY = roundCent(PRIOR_GROCERY_PAYDAY * CALENDAR_MONTH_DAYS / 14);
const STALE_STORED_MONTHLY = 900;
const WEEKLY_TIMES_TWO = roundCent(PRIOR_GROCERY_PAYDAY * 2);

function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function independentSeaspanStart(anchor, asOf) {
  let start = anchor;
  while (start > asOf) start = addDays(start, -14);
  let next = addDays(start, 14);
  while (next <= asOf) {
    start = next;
    next = addDays(start, 14);
  }
  return { start, end: addDays(next, -1), nextPayday: next };
}

function independentOwnerTargetMonthly(cat) {
  if (!cat) return null;
  if (cat.plannedWeekly != null) {
    return roundCent(Number(cat.plannedWeekly) * CALENDAR_MONTH_DAYS / 7);
  }
  if (cat.plannedMonthly != null && cat.plannedPayday != null) {
    return roundCent(Number(cat.plannedMonthly) || 0);
  }
  if (cat.plannedPayday != null) {
    if (cat.paydayCadence === 'first-seaspan-of-month'
        || cat.paydayCadence === 'every-other-seaspan') {
      return roundCent(Number(cat.plannedPayday) || 0);
    }
    return roundCent(Number(cat.plannedPayday) * CALENDAR_MONTH_DAYS / 14);
  }
  if (cat.plannedMonthly != null) return roundCent(Number(cat.plannedMonthly) || 0);
  return null;
}

function independentPaydayCyclePlanned(cat) {
  if (!cat) return null;
  if (cat.plannedWeekly != null) return roundCent(Number(cat.plannedWeekly) * 2);
  if (cat.plannedPayday != null) return roundCent(Number(cat.plannedPayday) || 0);
  if (cat.plannedMonthly != null) {
    const monthly = Number(cat.plannedMonthly) || 0;
    if (monthly === 0) return null;
    return roundCent(monthly * 14 / CALENDAR_MONTH_DAYS);
  }
  return null;
}

function independentHold(planned, spent) {
  return roundCent(Math.max(planned, spent));
}

function cats(plan) {
  return (plan && plan.budget && plan.budget.categories) || [];
}
function byId(plan, id) {
  return cats(plan).find(c => c && c.id === id) || null;
}
function budgetRow(period, id) {
  return ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;
}
function periodById(rec, id) {
  return ((rec && rec.defaultView && rec.defaultView.calendarPeriods) || [])
    .find(p => p && p.id === id) || null;
}
function groceryEssential(alloc) {
  return ((alloc && alloc.essentials && alloc.essentials.items) || [])
    .find(r => r && r.id === 'groceries') || null;
}

function syntheticPlan(payday) {
  return {
    defaults: { targetBuffer: 500, windowDays: 91 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: AS_OF },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: SEASPAN_ANCHOR, amount: 4000, confidence: 'confirmed',
    }],
    bills: [],
    commitments: [],
    obligations: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: payday,
          plannedMonthly: null, ownerLine: 'Groceries',
          targetSource: 'owner-stated-2026-09-22',
        },
        {
          id: 'fuel', label: 'Fuel', class: 'essential',
          plannedPayday: 325, plannedMonthly: null, ownerLine: 'Fuel',
        },
        {
          id: 'pets', label: 'Pets', class: 'essential',
          plannedPayday: 100, plannedMonthly: null, ownerLine: 'Dog food',
          paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-08-28',
        },
        {
          id: 'restaurants', label: 'Dining', class: 'discretionary',
          plannedPayday: 200, plannedMonthly: null, ownerLine: 'Eating out',
        },
        {
          id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary',
          plannedPayday: 150, plannedMonthly: null, ownerLine: 'Dale guilt-free spending',
        },
        {
          id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary',
          plannedPayday: 150, plannedMonthly: null, ownerLine: 'Amanda guilt-free spending',
        },
        {
          id: 'household', label: 'Household supplies & utilities', class: 'essential',
          from: ['Household'], plannedMonthly: 0, ownerLine: 'Household',
        },
      ],
    },
  };
}

function groceryTx(amount, date) {
  return {
    id: 'groc-' + date + '-' + amount,
    date,
    amount,
    pending: false,
    categoryLabel: 'Groceries',
    displayedPayee: 'Save-On-Foods',
    originalMerchant: 'Save-On-Foods',
    merchantKnown: true,
    accountRole: 'household-cash',
  };
}

function actuals(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: '2026-09-01',
    coverageThrough: AS_OF,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
  };
}

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 100, rate: 21.99, payment: 25, pending: 0 },
];

ok(near(GROCERY_MONTHLY, 1956.70) && near(PRIOR_ANNUALIZED_MONTHLY, 978.35)
    && WEEKLY_TIMES_TWO === 900 && RESERVE_DELTA === 450
    && !near(GROCERY_MONTHLY, STALE_STORED_MONTHLY)
    && !near(GROCERY_MONTHLY, PRIOR_ANNUALIZED_MONTHLY),
  'independent: $900/payday annualizes to $1,956.70/month; stale stored $900 and old $978.35 are different');

console.log('\n=== 1. Live JSON home is groceries plannedPayday 900, plannedMonthly null ===');
{
  const row = byId(live.plan, 'groceries');
  ok(!!row && row.id === 'groceries' && row.label === 'Groceries'
      && row.class === 'essential' && row.ownerLine === 'Groceries'
      && Array.isArray(row.from) && row.from.length === 1 && row.from[0] === 'Groceries',
    'Groceries stays the same category and Groceries classification');
  ok(row && row.plannedPayday === GROCERY_PAYDAY && row.plannedMonthly == null
      && row.plannedWeekly == null,
    'exact JSON home is plannedPayday 900 and plannedMonthly null',
    row ? `${row.plannedPayday}/${row.plannedMonthly}` : 'missing');
  ok(row && row.targetSource === 'owner-stated-2026-09-22',
    'targetSource names the 2026-09-22 instruction');
  ok(row && /\$900 per 14-day Seaspan payday cycle/.test(row.why || '')
      && /2026-09-22/.test(row.why || '')
      && /retired/.test(row.why || '')
      && /plannedMonthly is null/.test(row.why || '')
      && /Iron Butcher/.test(row.why || '')
      && !/is \$900 per calendar month/.test(row.why || '')
      && !/plannedPayday 450 plus plannedMonthly 900 so the month surface stays \$900/.test(row.why || ''),
    'why records the payday reserve and retires the 2026-09-18 pair as current');
  ok(independentPaydayCyclePlanned(row) === GROCERY_PAYDAY,
    'independent: plannedPayday 900 on a 14-day cycle is already 900',
    String(independentPaydayCyclePlanned(row)));
  ok(independentOwnerTargetMonthly(row) === GROCERY_MONTHLY,
    'independent: null plannedMonthly annualizes the payday amount',
    String(independentOwnerTargetMonthly(row)));
  const note = live.plan.budget.ownerTargets.note;
  ok(/2026-09-22 for Groceries/.test(note)
      && /\$900 per 14-day Seaspan payday cycle/.test(note)
      && /\$1,825\.00/.test(note) && /\$1,725\.00/.test(note)
      && !/\$450 per 14-day Seaspan payday cycle \(\$900\/month\)/.test(note)
      && !/\$1,375\.00/.test(note) && !/\$1,275\.00/.test(note),
    'ownerTargets note records the newer instruction and the new cycle totals');
}

console.log('\n=== 2. Named fuel / household / pets / guilt-free / other-spend amounts are unchanged ===');
{
  const fuel = byId(live.plan, 'fuel');
  const household = byId(live.plan, 'household');
  const pets = byId(live.plan, 'pets');
  const restaurants = byId(live.plan, 'restaurants');
  const dale = byId(live.plan, 'dale-guilt-free');
  const amanda = byId(live.plan, 'amanda-guilt-free');
  const other = byId(live.plan, 'other-spend');
  ok(fuel && fuel.plannedPayday === 325 && fuel.plannedMonthly == null
      && fuel.plannedWeekly == null && fuel.ownerLine === 'Fuel',
    'fuel stays plannedPayday 325');
  ok(household && household.plannedMonthly === 0 && household.plannedPayday == null
      && household.ownerLine === 'Household',
    'household stays the explicit $0 monthly baseline');
  ok(pets && pets.plannedPayday === 100 && pets.plannedMonthly == null
      && pets.paydayCadence === 'every-other-seaspan'
      && pets.paydayCadenceAnchor === '2026-08-28'
      && pets.ownerLine === 'Dog food',
    'dog food stays plannedPayday 100 every-other-seaspan');
  ok(restaurants && restaurants.plannedPayday === 200 && restaurants.plannedMonthly == null,
    'eating out stays plannedPayday 200');
  ok(dale && dale.plannedPayday === 150 && amanda && amanda.plannedPayday === 150
      && dale.plannedMonthly == null && amanda.plannedMonthly == null,
    'guilt-free stays $150 / $150 per payday');
  ok(other && other.plannedMonthly === 800 && other.plannedPayday == null
      && other.plannedWeekly == null && other.targetSource === 'owner-stated-2026-09-18',
    'other-spend stays plannedMonthly 800');
}

console.log('\n=== 3. Every applicable Seaspan period reserves exactly $900 ===');
{
  const independent = independentSeaspanStart(SEASPAN_ANCHOR, AS_OF);
  ok(independent.start === CYCLE_START && independent.end === CYCLE_END
      && independent.nextPayday === '2026-09-25',
    'independent 14-day steps from Aug 14: Sep 11–24, next payday Sep 25');
  const plan = syntheticPlan(GROCERY_PAYDAY);
  const starts = ['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09'];
  ok(starts.every((start, i) => i === 0 || start === addDays(starts[i - 1], 14)),
    'the five starts are successive 14-day Seaspan paydays');
  for (const start of starts) {
    const rec = F.recommend(plan, start, { targetBuffer: 500, debts });
    const current = periodById(rec, 'this-pay-period');
    const groc = budgetRow(current, 'groceries');
    const fuel = budgetRow(current, 'fuel');
    const restaurants = budgetRow(current, 'restaurants');
    ok(current && current.start === start && current.end === addDays(start, 13),
      `This Pay Period is the 14-day window starting ${start}`,
      current ? `${current.start}–${current.end} days=${current.days}` : 'missing');
    ok(groc && near(groc.planned, GROCERY_PAYDAY) && near(groc.plannedPayday, GROCERY_PAYDAY)
        && near(groc.hold, GROCERY_PAYDAY) && groc.plannedWeekly == null
        && near(groc.monthly, GROCERY_MONTHLY),
      `Groceries planned/hold is $900 on ${start}`,
      groc ? `planned=${groc.planned} hold=${groc.hold} monthly=${groc.monthly}` : 'missing');
    ok(groc && groc.plannedWeekly == null && near(groc.plannedPayday, GROCERY_PAYDAY)
        && !near(groc.planned, PRIOR_GROCERY_PAYDAY)
        && !near(groc.planned, roundCent(STALE_STORED_MONTHLY * 14 / CALENDAR_MONTH_DAYS)),
      `Planned is the payday field, not the retired $450 or a $900-month smear on ${start}`);
    ok(fuel && near(fuel.planned, 325) && restaurants && near(restaurants.planned, 200),
      `fuel $325 and eating out $200 are unchanged on ${start}`);
  }
  const off = F.recommend(plan, '2026-09-11', { targetBuffer: 500, debts });
  const on = F.recommend(plan, '2026-08-28', { targetBuffer: 500, debts });
  ok(!budgetRow(periodById(off, 'this-pay-period'), 'pets')
      || near(budgetRow(periodById(off, 'this-pay-period'), 'pets').planned, 0),
    'Sep 11 remains a Dog food OFF cycle');
  ok(budgetRow(periodById(on, 'this-pay-period'), 'pets')
      && near(budgetRow(periodById(on, 'this-pay-period'), 'pets').planned, 100),
    'Aug 28 remains a Dog food ON cycle');
}

console.log('\n=== 4. Hold is max(planned, eligible actual); under-plan spend is not deducted twice ===');
{
  const plan = syntheticPlan(GROCERY_PAYDAY);
  const underSpent = 200;
  const overSpent = 1100;
  const betweenSpent = 600;
  const under = F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts,
    currentPeriodActuals: actuals([groceryTx(underSpent, '2026-09-12')]),
  });
  const over = F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts,
    currentPeriodActuals: actuals([groceryTx(overSpent, '2026-09-12')]),
  });
  const between = F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts,
    currentPeriodActuals: actuals([groceryTx(betweenSpent, '2026-09-16')]),
  });
  const underRow = budgetRow(periodById(under, 'this-pay-period'), 'groceries');
  const overRow = budgetRow(periodById(over, 'this-pay-period'), 'groceries');
  const betweenRow = budgetRow(periodById(between, 'this-pay-period'), 'groceries');
  const underPeriod = periodById(under, 'this-pay-period');
  ok(underRow && near(underRow.spent, underSpent)
      && near(underRow.planned, GROCERY_PAYDAY)
      && near(underRow.hold, independentHold(GROCERY_PAYDAY, underSpent))
      && near(underRow.remaining, roundCent(GROCERY_PAYDAY - underSpent))
      && near(underRow.overspend, 0),
    'under $900, hold stays the reserve and remaining is planned − spent',
    underRow ? `spent=${underRow.spent} hold=${underRow.hold} remaining=${underRow.remaining}` : 'missing');
  ok(underRow && !near(underRow.hold, roundCent(GROCERY_PAYDAY + underSpent))
      && !near(underRow.hold, roundCent(GROCERY_PAYDAY - underSpent)),
    'under-plan grocery spend is not added to the reserve and is not the deduction');
  ok(underPeriod && near(underPeriod.afterHouseholdBudget,
      roundCent(underPeriod.afterBills - underPeriod.budgetHold))
      && !near(underPeriod.afterHouseholdBudget,
        roundCent(underPeriod.afterBills - GROCERY_PAYDAY - underSpent)),
    'Balance After Household Budget subtracts the hold once');
  ok(overRow && near(overRow.spent, overSpent)
      && near(overRow.hold, independentHold(GROCERY_PAYDAY, overSpent))
      && near(overRow.overspend, roundCent(overSpent - GROCERY_PAYDAY))
      && near(overRow.hold, roundCent(GROCERY_PAYDAY + overRow.overspend)),
    'over the reserve, hold is max(planned, spent) = planned + overspend',
    overRow ? `hold=${overRow.hold} over=${overRow.overspend}` : 'missing');
  ok(betweenRow && near(betweenRow.hold, GROCERY_PAYDAY)
      && near(betweenRow.spent, betweenSpent),
    'spend between the retired $450 and $900 still holds the full $900 reserve');
}

console.log('\n=== 5. Balance After Household Budget moves by the reserve difference from $450 ===');
{
  const cases = [
    { label: 'no actuals', spent: null, expectedDelta: RESERVE_DELTA },
    { label: 'spent $200 under both reserves', spent: 200, expectedDelta: RESERVE_DELTA },
    { label: 'spent $600 between the reserves', spent: 600, expectedDelta: roundCent(GROCERY_PAYDAY - 600) },
    { label: 'spent $1,100 over both reserves', spent: 1100, expectedDelta: 0 },
  ];
  for (const item of cases) {
    const opts = { targetBuffer: 500, debts };
    if (item.spent != null) {
      opts.currentPeriodActuals = actuals([groceryTx(item.spent, '2026-09-12')]);
    }
    const now = F.recommend(syntheticPlan(GROCERY_PAYDAY), AS_OF, opts);
    const prior = F.recommend(syntheticPlan(PRIOR_GROCERY_PAYDAY), AS_OF, opts);
    const nowPeriod = periodById(now, 'this-pay-period');
    const priorPeriod = periodById(prior, 'this-pay-period');
    const nowG = budgetRow(nowPeriod, 'groceries');
    const priorG = budgetRow(priorPeriod, 'groceries');
    const independentNow = item.spent == null
      ? GROCERY_PAYDAY : independentHold(GROCERY_PAYDAY, item.spent);
    const independentPrior = item.spent == null
      ? PRIOR_GROCERY_PAYDAY : independentHold(PRIOR_GROCERY_PAYDAY, item.spent);
    ok(nowG && priorG && near(nowG.hold, independentNow) && near(priorG.hold, independentPrior)
        && near(nowG.hold - priorG.hold, item.expectedDelta),
      `${item.label}: grocery hold differs by the independent reserve gap`,
      nowG && priorG ? `${nowG.hold} − ${priorG.hold}` : 'missing');
    ok(nowPeriod && priorPeriod
        && near(priorPeriod.afterHouseholdBudget - nowPeriod.afterHouseholdBudget, item.expectedDelta)
        && near(nowPeriod.budgetHold - priorPeriod.budgetHold, item.expectedDelta)
        && near(nowPeriod.afterBills, priorPeriod.afterBills),
      `${item.label}: Balance After Household Budget falls by that same gap and bills do not move`,
      nowPeriod && priorPeriod
        ? `${priorPeriod.afterHouseholdBudget} − ${nowPeriod.afterHouseholdBudget}` : 'missing');
    ok(budgetRow(nowPeriod, 'fuel') && budgetRow(priorPeriod, 'fuel')
        && near(budgetRow(nowPeriod, 'fuel').planned, budgetRow(priorPeriod, 'fuel').planned),
      `${item.label}: fuel planned does not move with the grocery reserve`);
  }

  const liveNow = F.recommend(live.plan, live.meta.asOf, { debts: live.debts || debts });
  const priorPlan = JSON.parse(JSON.stringify(live.plan));
  const priorRow = byId(priorPlan, 'groceries');
  priorRow.plannedPayday = PRIOR_GROCERY_PAYDAY;
  const livePrior = F.recommend(priorPlan, live.meta.asOf, { debts: live.debts || debts });
  for (const id of ['this-pay-period', 'next-pay-period']) {
    const nowPeriod = periodById(liveNow, id);
    const priorPeriod = periodById(livePrior, id);
    ok(nowPeriod && priorPeriod && budgetRow(nowPeriod, 'groceries')
        && near(budgetRow(nowPeriod, 'groceries').planned, GROCERY_PAYDAY)
        && near(budgetRow(priorPeriod, 'groceries').planned, PRIOR_GROCERY_PAYDAY)
        && near(nowPeriod.budgetHold - priorPeriod.budgetHold, RESERVE_DELTA)
        && near(priorPeriod.afterHouseholdBudget - nowPeriod.afterHouseholdBudget, RESERVE_DELTA),
      `live ${id} reserves $900 and Balance After Household Budget is $450 lower than the retired reserve`,
      nowPeriod && priorPeriod
        ? `hold ${priorPeriod.budgetHold} → ${nowPeriod.budgetHold}; BAD ${priorPeriod.afterHouseholdBudget} → ${nowPeriod.afterHouseholdBudget}`
        : 'missing');
  }
}

console.log('\n=== 6. Payday allocation uses the $900 cycle reserve, not a monthly smear ===');
{
  const plan = syntheticPlan(GROCERY_PAYDAY);
  const smear14 = roundCent(STALE_STORED_MONTHLY * 14 / CALENDAR_MONTH_DAYS);
  ok(smear14 > 413 && smear14 < 415 && !near(smear14, GROCERY_PAYDAY),
    'independent: a stored monthly $900 × 14 / (365.25/12) is ~$414, not $900',
    String(smear14));
  for (const asOf of [CYCLE_START, AS_OF]) {
    const alloc = F.paydayAllocation(plan, asOf, { targetBuffer: 500, debts });
    const groc = groceryEssential(alloc);
    const rec = F.recommend(plan, asOf, { targetBuffer: 500, debts });
    const action = F.currentPeriodAction(plan, asOf, { targetBuffer: 500, debts });
    const actGroc = ((action && action.categories) || []).find(r => r && r.id === 'groceries');
    ok(groc && near(groc.planned, GROCERY_PAYDAY) && near(groc.required, GROCERY_PAYDAY)
        && near(groc.monthly, GROCERY_MONTHLY) && !near(groc.planned, smear14),
      `paydayAllocation groceries planned/required is $900 asOf ${asOf}`,
      groc ? `planned=${groc.planned} monthly=${groc.monthly}` : 'missing');
    ok(groceryEssential(rec.paydayAllocation)
        && near(groceryEssential(rec.paydayAllocation).planned, GROCERY_PAYDAY),
      `recommend.paydayAllocation groceries planned is $900 asOf ${asOf}`);
    ok(actGroc && near(actGroc.planned, GROCERY_PAYDAY) && !near(actGroc.planned, smear14),
      `currentPeriodAction groceries planned is $900 asOf ${asOf}`);
  }
}

console.log('\n=== 7. Month and trajectory consume the payday authority, not a second grocery target ===');
{
  const plan = syntheticPlan(GROCERY_PAYDAY);
  const fixturePeriods = {
    asOf: AS_OF,
    periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1 }] } },
  };
  const bd = F.budgetBreakdown(plan, fixturePeriods, {});
  const groc = (bd.categories || []).find(c => c.id === 'groceries');
  const fuel = (bd.categories || []).find(c => c.id === 'fuel');
  const fuelMonthly = roundCent(325 * CALENDAR_MONTH_DAYS / 14);
  ok(groc && groc.source === 'owner-target' && near(groc.target, GROCERY_MONTHLY)
      && near(groc.planned, GROCERY_MONTHLY) && near(groc.gross, GROCERY_MONTHLY)
      && !near(groc.target, STALE_STORED_MONTHLY)
      && !near(groc.target, PRIOR_ANNUALIZED_MONTHLY),
    'budgetBreakdown groceries is the annualized $900 payday, not stored $900 or old $978.35',
    groc ? `${groc.target}/${groc.planned}/${groc.gross}` : 'missing');
  ok(fuel && near(fuel.target, fuelMonthly),
    'fuel month surface still annualizes $325',
    fuel ? String(fuel.target) : 'missing');

  const liveBd = F.budgetBreakdown(live.plan, periods, {
    paypalPerMonth: live.paypal ? live.paypal.perMonth : 0,
  });
  const liveG = (liveBd.categories || []).find(c => c.id === 'groceries');
  ok(liveG && liveG.source === 'owner-target' && near(liveG.target, GROCERY_MONTHLY)
      && near(liveG.planned, GROCERY_MONTHLY),
    'live month grocery target is the same annualized payday authority',
    liveG ? String(liveG.target) : 'missing');

  // Independent of figures-snapshot.js: published weekly essentials are
  // requiredMonthly / (365.25/12/7). The positions.csv weeks-covered note
  // uses monthly × 12/52 and is not budget.requiredPerWeek.
  const liveFuel = (liveBd.categories || []).find(c => c.id === 'fuel');
  const independentRequiredWeekly = roundCent(liveBd.requiredMonthly / WEEKS_PER_MONTH);
  const foodFuelMonthly = roundCent((liveG && liveG.planned || 0) + (liveFuel && liveFuel.planned || 0));
  const independentFoodFuelWeekly = roundCent(foodFuelMonthly / WEEKS_PER_MONTH);
  const positionsWeeklySmear = roundCent(liveBd.requiredMonthly * 12 / 52);
  ok(near(liveBd.requiredMonthly, 4859.94),
    'live required monthly is the published $4,859.94',
    String(liveBd.requiredMonthly));
  ok(near(independentRequiredWeekly, 1117.69)
      && !near(positionsWeeklySmear, independentRequiredWeekly)
      && near(positionsWeeklySmear, 1121.52),
    'published weekly essentials are $1,117.69, not the 12/52 smear $1,121.52',
    `${independentRequiredWeekly} smear=${positionsWeeklySmear}`);
  ok(near(foodFuelMonthly, 2663.28) && near(independentFoodFuelWeekly, 612.50),
    'published food-and-fuel weekly is $612.50 from the same calendar conversion',
    `${foodFuelMonthly} → ${independentFoodFuelWeekly}`);

  const monthOnly = {
    windowDays: 91,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: '2026-06-15' },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-06-12', amount: 2000, confidence: 'estimated',
    }],
    obligations: [], bills: [], commitments: [],
    budget: {
      basis: 'ytd',
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: GROCERY_PAYDAY, plannedMonthly: null,
          ownerLine: 'Groceries',
        },
        {
          id: 'travel', label: 'Travel', class: 'discretionary', from: ['Travel'],
        },
      ],
    },
  };
  const trajDebts = [{
    id: 'card', label: 'Synthetic card', balance: 600, pending: 0, rate: 19.99,
    rateConvention: 'card', structure: 'Revolving — synthetic', secured: false, limit: 1500,
  }];
  const trajPeriods = {
    periods: {
      ytd: { label: 'YTD fixture', months: 1, spending: [{ label: 'Groceries', total: 1 }] },
    },
  };
  const traj = F.baselineTrajectory(monthOnly, trajDebts, '2026-06-15', { periods: trajPeriods });
  const july = (traj.months || []).find(m => m.month === '2026-07');
  const walkDays = july && july.stage1 && july.stage1.householdBudget
    && july.stage1.householdBudget.walkDays;
  const expectedWeekly = roundCent(GROCERY_MONTHLY / WEEKS_PER_MONTH);
  const expectedSmear = roundCent(expectedWeekly * walkDays / 7);
  const staleSmear = roundCent(roundCent(STALE_STORED_MONTHLY / WEEKS_PER_MONTH) * walkDays / 7);
  const groceryLine = ((july && july.stage1 && july.stage1.householdBudget
    && july.stage1.householdBudget.lines) || []).find(row => row && row.label === 'Groceries');
  ok(traj && traj.status === 'ready' && july && july.stage1 && july.stage1.householdBudget,
    'synthetic trajectory publishes Stage 1 household budget');
  ok(near(expectedWeekly, roundCent(GROCERY_PAYDAY * 7 / 14)),
    'the weekly rate of a $900 / 14-day reserve is $450; that is not a stored weekly target');
  ok(traj.weeklyVariable && near(traj.weeklyVariable.amount, expectedWeekly),
    'trajectory weeklyVariable is the annualized payday amount / calendar weeks',
    traj.weeklyVariable ? `${traj.weeklyVariable.amount} vs ${expectedWeekly}` : 'missing');
  ok(groceryLine && near(groceryLine.amount, expectedSmear) && !near(groceryLine.amount, staleSmear),
    'trajectory Groceries line is that same monthly smear, not a stored $900/month smear',
    groceryLine ? `${groceryLine.amount} vs ${expectedSmear}` : 'missing');
  ok(!((july.stage1.householdBudget.lines) || []).some(row => /travel/i.test(row.label || '')),
    'historical Travel is not a second grocery or household-budget line');

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8');
  const trajFn = src.slice(
    src.indexOf('function baselineTrajectoryHouseholdBudgetLines'),
    src.indexOf('function baselineTrajectoryWalkVariableDays'));
  ok(/budgetBreakdown\(/.test(trajFn) && /c\.planned/.test(trajFn)
      && !/groceries/.test(trajFn) && !/\b900\b/.test(trajFn) && !/\b450\b/.test(trajFn),
    'trajectory household-budget lines read budgetBreakdown planned and do not recompute groceries');
}

console.log('\n=== 8. Classification of a Groceries transaction is unchanged ===');
{
  const tx = {
    date: '2026-09-12', amount: 42.15, categoryLabel: 'Groceries',
    displayedPayee: 'SAVE ON FOODS', originalMerchant: 'SAVE ON FOODS',
  };
  const cls = F.classifyCurrentPeriodTransaction(tx, live.plan, {});
  ok(cls && cls.kind === 'spend' && (cls.categoryId === 'groceries' || cls.atlasRow === 'groceries'),
    'a Groceries-labelled transaction still classifies as groceries',
    cls ? `${cls.kind}/${cls.categoryId || cls.atlasRow}` : 'missing');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
