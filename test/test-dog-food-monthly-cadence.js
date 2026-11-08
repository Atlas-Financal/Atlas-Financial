'use strict';
/* Dog food is $100 on alternating Seaspan payday periods
 * (standing every-other-Seaspan hold).
 *
 * Independent of Forecast helpers under change (L-002): expected
 * planned amounts are grouped from an independently walked biweekly
 * calendar plus an ON-phase start. Household Budget totals are summed
 * from the incumbent owner-target components, not by reading Forecast
 * back to itself.
 *
 * `node test/test-dog-food-monthly-cadence.js`
 */
const F = require('../public/forecast.js');
const liveData = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  }
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

function addDays(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function diffDays(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Independent Seaspan calendar: 14-day steps from the supplied anchor.
function independentSeaspanDates(anchor, from, to) {
  const out = [];
  let t = anchor;
  while (t > from) t = addDays(t, -14);
  while (t <= to) {
    if (t >= from) out.push(t);
    t = addDays(t, 14);
  }
  return out;
}

function independentCycleStart(payrollAnchor, iso) {
  const dates = independentSeaspanDates(payrollAnchor, addDays(iso, -42), iso);
  let start = null;
  for (const d of dates) {
    if (d <= iso) start = d;
  }
  return start;
}

function independentDogFoodPlanned(onStart, cycleStart) {
  const delta = diffDays(onStart, cycleStart);
  if (delta % 14 !== 0) return 0;
  return (delta / 14) % 2 === 0 ? 100 : 0;
}

const OTHER_TARGETS = {
  groceries: 900,
  fuel: 325,
  household: 37.5,
  restaurants: 200,
  'dale-guilt-free': 150,
  'amanda-guilt-free': 150,
};
const OTHER_TOTAL = roundCent(Object.values(OTHER_TARGETS).reduce((s, n) => s + n, 0));
const WITH_DOG = roundCent(OTHER_TOTAL + 100);
const WITHOUT_DOG = OTHER_TOTAL;

ok(near(OTHER_TOTAL, 1762.50) && near(WITH_DOG, 1862.50) && near(WITHOUT_DOG, 1762.50),
  'independent component sum: $1,762.50 without Dog food, $1,862.50 with it');
ok(near(WITH_DOG - WITHOUT_DOG, 100),
  'the two period totals differ by exactly $100');

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 100, rate: 21.99, payment: 25, pending: 0 },
];

function budgetCats(cadence, anchor) {
  const pets = {
    id: 'pets', label: 'Pets', class: 'essential',
    plannedPayday: 100, plannedMonthly: null, ownerLine: 'Dog food',
  };
  if (cadence) pets.paydayCadence = cadence;
  if (anchor) pets.paydayCadenceAnchor = anchor;
  return [
    { id: 'groceries', label: 'Groceries', class: 'essential',
      plannedWeekly: 450, plannedMonthly: null, ownerLine: 'Groceries' },
    { id: 'fuel', label: 'Fuel', class: 'essential',
      plannedPayday: 325, plannedMonthly: null, ownerLine: 'Fuel' },
    { id: 'household', label: 'Household', class: 'essential',
      plannedPayday: 37.5, plannedMonthly: null, ownerLine: 'Household' },
    pets,
    { id: 'restaurants', label: 'Dining', class: 'discretionary',
      plannedPayday: 200, plannedMonthly: null, ownerLine: 'Eating out' },
    { id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary',
      plannedPayday: 150, plannedMonthly: null, ownerLine: 'Dale guilt-free spending' },
    { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary',
      plannedPayday: 150, plannedMonthly: null, ownerLine: 'Amanda guilt-free spending' },
  ];
}

function syntheticPlan(payrollAnchor, cadence, cadenceAnchor) {
  return {
    defaults: { targetBuffer: 500, windowDays: 91 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: payrollAnchor },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: payrollAnchor, amount: 4000, confidence: 'confirmed',
      },
    ],
    bills: [],
    commitments: [],
    obligations: [],
    budget: { categories: budgetCats(cadence, cadenceAnchor) },
  };
}

function budgetRow(period, id) {
  return ((period && period.householdBudget) || []).find(r => r && r.id === id) || null;
}

function periodOn(advice, start) {
  return ((advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(p => p && p.start === start) || null;
}

function recommendOn(plan, asOf) {
  return F.recommend(plan, asOf, { targetBuffer: 500, debts });
}

function petsHold(period) {
  const pets = budgetRow(period, 'pets');
  if (!pets) return { shown: false, planned: 0, remaining: 0, hold: 0 };
  return {
    shown: true,
    planned: Number(pets.planned) || 0,
    remaining: pets.remaining == null ? 0 : Number(pets.remaining) || 0,
    hold: Number(pets.hold) || 0,
  };
}

const CALENDAR_MONTH_DAYS = 365.25 / 12;
function monthlySmear(amount, days) {
  return roundCent(amount * Math.max(0, Number(days) || 0) / CALENDAR_MONTH_DAYS);
}

function petsEssential(alloc) {
  const row = ((((alloc || {}).essentials || {}).items) || []).find(i => i && i.id === 'pets') || null;
  if (!row) return { shown: false, required: 0, planned: 0, monthly: 0 };
  return {
    shown: true,
    required: Number(row.required) || 0,
    planned: Number(row.planned) || 0,
    monthly: Number(row.monthly) || 0,
  };
}

function proveStarts(label, plan, onStart, starts) {
  console.log(`\n=== ${label} ===`);
  const expectedByStart = new Map();
  for (const start of starts) {
    const expected = independentDogFoodPlanned(onStart, start);
    expectedByStart.set(start, expected);
    ok(expected === 100 || expected === 0,
      `${start} independent Dog food is $100 or $0`, String(expected));
  }

  for (const start of starts) {
    const advice = recommendOn(plan, start);
    const period = periodOn(advice, start);
    const pets = petsHold(period);
    const expected = expectedByStart.get(start);
    ok(!!period, `${start} Forecast publishes that operating period`);
    if (expected === 100) {
      ok(pets.shown && near(pets.planned, 100) && near(pets.hold, 100),
        `${start} ON cycle holds Dog food $100`,
        JSON.stringify(pets));
    } else {
      ok(!pets.shown || (near(pets.planned, 0) && near(pets.hold, 0)),
        `${start} OFF cycle is not a this-cycle Dog food hold`,
        JSON.stringify(pets));
      ok(near(pets.planned, 0) && near(pets.remaining, 0) && near(pets.hold, 0),
        `${start} OFF cycle target/remaining/hold are 0`,
        JSON.stringify(pets));
    }
    for (const [id, amount] of Object.entries(OTHER_TARGETS)) {
      const row = budgetRow(period, id);
      ok(row && near(row.planned, amount),
        `${start} ${id} planned stays $${amount}`,
        row && String(row.planned));
    }
    const independentHold = roundCent(OTHER_TOTAL + expected);
    ok(period && near(period.budgetHold, independentHold),
      `${start} Household Budget hold is independently $${independentHold.toFixed(2)}`,
      period && String(period.budgetHold));

    const alloc = advice.paydayAllocation;
    const essential = petsEssential(alloc);
    const smear = monthlySmear(100, alloc && alloc.periodDays);
    ok(near(essential.required, expected) && near(essential.planned, expected),
      `${start} payday essentials Dog food is independently $${expected}`,
      JSON.stringify(essential));
    ok(!near(smear, expected),
      `${start} independent hold $${expected} is not the $${smear.toFixed(2)} monthly smear`);
    ok(!near(essential.required, smear),
      `${start} payday essentials is not the remaining-days smear`,
      String(essential.required));
  }
}

const LIVE_ANCHOR = '2026-08-14';
const ON_START = '2026-08-28';
const livePlan = syntheticPlan(LIVE_ANCHOR, 'every-other-seaspan', ON_START);

console.log('\n=== independent ON/OFF phase from Aug 28 ON start ===');
{
  ok(independentDogFoodPlanned(ON_START, '2026-08-14') === 0,
    'independent: Aug 14 is OFF');
  ok(independentDogFoodPlanned(ON_START, '2026-08-28') === 100,
    'independent: Aug 28 is ON (period containing 2026-09-03 Surrey Meat)');
  ok(independentDogFoodPlanned(ON_START, '2026-09-11') === 0,
    'independent: Sep 11 is OFF');
  ok(independentDogFoodPlanned(ON_START, '2026-09-25') === 100,
    'independent: Sep 25 is ON');
  ok(independentDogFoodPlanned(ON_START, '2026-10-09') === 0,
    'independent: Oct 9 is OFF');
  ok(independentDogFoodPlanned(ON_START, '2026-10-23') === 100,
    'independent: Oct 23 is ON');
  ok(independentCycleStart(LIVE_ANCHOR, '2026-09-03') === '2026-08-28',
    'independent: 2026-09-03 purchase sits in the Aug 28–Sep 10 ON cycle');
  ok(independentCycleStart(LIVE_ANCHOR, '2026-08-04') === '2026-07-31',
    'independent: 2026-08-04 purchase sits in the Jul 31–Aug 13 cycle');
  ok(independentDogFoodPlanned(ON_START, '2026-07-31') === 100,
    'independent: Jul 31 stays ON with the same phase (contains 2026-08-04)');
}

proveStarts(
  '1. Sep 11–24 OFF and Sep 25 ON',
  livePlan, ON_START, ['2026-09-11', '2026-09-25']
);

proveStarts(
  '2. prior ON cycle and next OFF/ON windows',
  livePlan, ON_START, ['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']
);

const THREE_ANCHOR = '2026-01-02';
const THREE_ON = '2026-01-02';
const threePlan = syntheticPlan(THREE_ANCHOR, 'every-other-seaspan', THREE_ON);

proveStarts(
  '3. synthetic January Seaspan windows alternate',
  threePlan, THREE_ON, ['2026-01-02', '2026-01-16', '2026-01-30']
);
{
  const januaryStarts = ['2026-01-02', '2026-01-16', '2026-01-30'];
  const independentJanuary = januaryStarts.reduce(
    (s, d) => s + independentDogFoodPlanned(THREE_ON, d), 0);
  const forecastJanuary = januaryStarts.reduce((s, d) => {
    const period = periodOn(recommendOn(threePlan, d), d);
    return roundCent(s + petsHold(period).planned);
  }, 0);
  ok(independentJanuary === 200 && near(forecastJanuary, 200),
    'three January-starting cycles plan $200 Dog food (ON/OFF/ON)',
    `independent ${independentJanuary} / Forecast ${forecastJanuary}`);
}

console.log('\n=== 4. year boundary keeps the same 14-day parity ===');
{
  ok(addDays('2026-01-02', 26 * 14) === '2027-01-01',
    'independent: 26 Seaspan steps from 2026-01-02 is 2027-01-01');
  ok(independentDogFoodPlanned(THREE_ON, '2025-12-05') === 100,
    'independent: Dec 5 2025 is two 14-day steps before Jan 2 → ON');
  ok(independentDogFoodPlanned(THREE_ON, '2025-12-19') === 0,
    'independent: Dec 19 2025 is one 14-day step before Jan 2 → OFF');
  ok(independentDogFoodPlanned(THREE_ON, '2026-01-02') === 100,
    'independent: Jan 2 2026 is the ON anchor');
  ok(independentDogFoodPlanned(THREE_ON, '2027-01-01') === 100,
    'independent: Jan 1 2027 is 26 even steps from Jan 2 2026 → ON');
  proveStarts(
    '4b. Forecast year-boundary assignment',
    threePlan, THREE_ON, ['2025-12-05', '2025-12-19', '2026-01-02', '2027-01-01']
  );
}

console.log('\n=== 5–6. other targets unchanged; totals reconcile by components ===');
{
  const off = periodOn(recommendOn(livePlan, '2026-09-11'), '2026-09-11');
  const on = periodOn(recommendOn(livePlan, '2026-09-25'), '2026-09-25');
  ok(off && near(off.budgetHold, WITHOUT_DOG),
    'Sep 11 OFF period hold is independently $1,762.50');
  ok(on && near(on.budgetHold, WITH_DOG),
    'Sep 25 ON period hold is independently $1,862.50');
  ok(off && on && near(on.budgetHold - off.budgetHold, 100),
    'the two Forecast holds differ by exactly $100');
  ok(off && near(off.afterHouseholdBudget,
      roundCent(off.afterRemainingBills - off.budgetHold)),
    'OFF leftover is remaining-bills minus the $1,762.50 hold');
  ok(on && near(on.afterHouseholdBudget,
      roundCent(on.afterRemainingBills - on.budgetHold)),
    'ON leftover is remaining-bills minus the $1,862.50 hold');
}

console.log('\n=== payday essentials matches Household Budget ON/OFF ===');
{
  const windows = [
    { start: '2026-08-28', expected: 100, label: 'Aug 28–Sep 10 ON' },
    { start: '2026-09-11', expected: 0, label: 'Sep 11–24 OFF' },
    { start: '2026-09-25', expected: 100, label: 'Sep 25–Oct 8 ON' },
  ];
  for (const row of windows) {
    const advice = recommendOn(livePlan, row.start);
    const period = periodOn(advice, row.start);
    const hold = petsHold(period);
    const essential = petsEssential(advice.paydayAllocation);
    const smear = monthlySmear(100, 14);
    ok(independentDogFoodPlanned(ON_START, row.start) === row.expected,
      `${row.label} independent calendar is $${row.expected}`);
    ok(near(hold.planned, row.expected) && near(hold.hold, row.expected),
      `${row.label} Household Budget Dog food is $${row.expected}`,
      JSON.stringify(hold));
    ok(near(essential.required, row.expected) && near(essential.planned, row.expected),
      `${row.label} payday essentials Dog food is $${row.expected}`,
      JSON.stringify(essential));
    ok(near(hold.planned, essential.required),
      `${row.label} Household Budget and payday essentials agree`);
    ok(!near(smear, row.expected) && !near(essential.required, smear),
      `${row.label} is not the $${smear.toFixed(2)} remaining-days smear`);
    ok(near(essential.monthly, 100),
      `${row.label} master-plan monthly equivalent stays $100`,
      String(essential.monthly));
  }
}

console.log('\n=== current and next period use the same standing rule ===');
{
  const advice = recommendOn(livePlan, '2026-09-11');
  const current = (advice.defaultView.calendarPeriods || [])
    .find(p => p && p.id === 'this-pay-period');
  const next = (advice.defaultView.calendarPeriods || [])
    .find(p => p && p.id === 'next-pay-period');
  ok(current && current.start === '2026-09-11' && current.end === '2026-09-24',
    'This Pay Period is Sep 11–24');
  ok(next && next.start === '2026-09-25',
    'Next Pay Period starts on the following Seaspan payday');
  const currentPets = petsHold(current);
  const nextPets = petsHold(next);
  ok(!currentPets.shown || (near(currentPets.planned, 0) && near(currentPets.hold, 0)),
    'This Pay Period does not show Dog food as an active hold');
  ok(near(currentPets.planned, 0) && near(currentPets.remaining, 0),
    'This Pay Period Dog food target/remaining are 0');
  ok(nextPets.shown && near(nextPets.planned, 100) && near(nextPets.hold, 100),
    'Next Pay Period Dog food is $100 from the same standing rule, not a Sep 11 special case');
}

console.log('\n=== week views hold Dog food only on ON Seaspan starts ===');
{
  const advice = recommendOn(livePlan, '2026-09-11');
  const weeks = advice.weekViews || [];
  ok(weeks.length > 1, 'week views exist');
  let onPaydayWeeks = 0;
  let offPaydayWeeks = 0;
  let emptyWeeks = 0;
  const horizonEnd = addDays('2026-09-11', 40);
  for (const week of weeks) {
    if (!week.periodStart || week.periodStart > horizonEnd) continue;
    const dates = independentSeaspanDates(LIVE_ANCHOR, week.periodStart, week.periodEnd);
    const qualifying = dates.filter(d => independentDogFoodPlanned(ON_START, d) === 100);
    const pets = (week.householdBudget || []).find(r => r.id === 'pets');
    const digest = ((week.budgetDigest && week.budgetDigest.rows) || [])
      .find(r => r.id === 'pets');
    if (qualifying.length > 0) {
      onPaydayWeeks += 1;
      ok(pets && near(pets.amount, 100 * qualifying.length),
        `week ${week.periodStart} containing an ON Dog food payday holds $100`,
        pets && String(pets.amount));
      ok(digest && near(digest.planned, 100 * qualifying.length),
        `week ${week.periodStart} digest holds $100`,
        digest && String(digest.planned));
    } else if (dates.length > 0) {
      offPaydayWeeks += 1;
      ok(!pets,
        `week ${week.periodStart} with only an OFF payday omits Dog food`);
      ok(!digest,
        `week ${week.periodStart} digest omits Dog food on an OFF payday week`);
    } else {
      emptyWeeks += 1;
      ok(!pets, `week ${week.periodStart} with no payday omits Dog food`);
    }
    ok(!pets || !near(pets.amount, 50),
      `week ${week.periodStart} is not a $50 Dog food proration`);
  }
  ok(onPaydayWeeks > 0 && offPaydayWeeks > 0 && emptyWeeks > 0,
    'week proof covers ON payday, OFF payday, and no-payday weeks',
    `${onPaydayWeeks} on / ${offPaydayWeeks} off / ${emptyWeeks} empty`);
}

console.log('\n=== monthly equivalent is $100, not a 14-day $50 smear ===');
{
  const periods = {
    asOf: '2026-09-11',
    periods: { ytd: { label: 'YTD', months: 8, spending: [] } },
  };
  const bd = F.budgetBreakdown(livePlan, periods, {});
  const pets = (bd.categories || []).find(c => c.id === 'pets');
  const fuel = (bd.categories || []).find(c => c.id === 'fuel');
  const smeared = roundCent(100 * (365.25 / 12) / 14);
  const fuelMonthly = roundCent(325 * (365.25 / 12) / 14);
  ok(pets && near(pets.target, 100) && !near(pets.target, smeared) && !near(pets.target, 50),
    'Dog food master-plan monthly target is $100, not $50 and not payday-smeared',
    pets && String(pets.target));
  ok(fuel && near(fuel.target, fuelMonthly),
    'Fuel monthly equivalent is still payday-annualized $325',
    fuel && String(fuel.target));
}

console.log('\n=== purchase-date anchor resolves through spendingCycle ===');
{
  const purchasePlan = syntheticPlan(LIVE_ANCHOR, 'every-other-seaspan', '2026-09-03');
  const off = periodOn(recommendOn(purchasePlan, '2026-09-11'), '2026-09-11');
  const on = periodOn(recommendOn(purchasePlan, '2026-08-28'), '2026-08-28');
  ok(!petsHold(off).shown || near(petsHold(off).planned, 0),
    'anchor 2026-09-03 still makes Sep 11 OFF');
  ok(petsHold(on).shown && near(petsHold(on).planned, 100),
    'anchor 2026-09-03 still makes Aug 28 ON');
}

console.log('\n=== missing cadence anchor fails closed ===');
{
  const noAnchor = syntheticPlan(LIVE_ANCHOR, 'every-other-seaspan', null);
  const first = periodOn(recommendOn(noAnchor, '2026-08-28'), '2026-08-28');
  const later = periodOn(recommendOn(noAnchor, '2026-09-11'), '2026-09-11');
  ok(!petsHold(first).shown && !petsHold(later).shown,
    'without paydayCadenceAnchor, every-other-seaspan never holds');
}

console.log('\n=== absent cadence keeps every-payday Dog food (fixture compatibility) ===');
{
  const every = syntheticPlan(LIVE_ANCHOR, null);
  const first = periodOn(recommendOn(every, '2026-09-11'), '2026-09-11');
  const later = periodOn(recommendOn(every, '2026-09-25'), '2026-09-25');
  ok(budgetRow(first, 'pets') && near(budgetRow(first, 'pets').planned, 100),
    'without paydayCadence, Sep 11 still plans $100');
  ok(budgetRow(later, 'pets') && near(budgetRow(later, 'pets').planned, 100),
    'without paydayCadence, Sep 25 still plans $100 — default is every Seaspan payday');
}

console.log('\n=== live data.json uses the standing every-other-Seaspan rule ===');
{
  const pets = (liveData.plan.budget.categories || []).find(c => c.id === 'pets');
  ok(pets && pets.plannedPayday === 100 && pets.paydayCadence === 'every-other-seaspan',
    'live pets plannedPayday is 100 with every-other-seaspan cadence',
    pets && `${pets.plannedPayday}/${pets.paydayCadence}`);
  ok(pets && pets.paydayCadenceAnchor === '2026-08-28',
    'live pets paydayCadenceAnchor is the Aug 28 ON start');
  ok(pets && /every-other-Seaspan/i.test(pets.why || '') && /2026-09-11/.test(pets.why || ''),
    'live pets why cites Dale standing every-other-Seaspan rule');
  const rec = recommendOn(liveData.plan, '2026-09-11');
  const current = (rec.defaultView.calendarPeriods || [])
    .find(p => p && p.id === 'this-pay-period');
  const next = (rec.defaultView.calendarPeriods || [])
    .find(p => p && p.id === 'next-pay-period');
  ok(current && current.start === '2026-09-11' && current.end === '2026-09-24',
    'live This Pay Period is Sep 11–24');
  const livePets = petsHold(current);
  ok(!livePets.shown || (near(livePets.planned, 0) && near(livePets.hold, 0)),
    'live Sep 11–24 does not show Dog food as an active hold');
  ok(near(livePets.planned, 0) && near(livePets.remaining, 0),
    'live Sep 11–24 Dog food target/remaining are 0');
  ok(next && next.start === '2026-09-25'
      && petsHold(next).shown && near(petsHold(next).planned, 100),
    'live Next Pay Period still holds Dog food $100 from the standing rule');
  const liveEssential = petsEssential(rec.paydayAllocation);
  ok(near(liveEssential.required, 0) && near(liveEssential.planned, 0),
    'live Sep 11–24 payday essentials Dog food is $0',
    JSON.stringify(liveEssential));
  const liveOn = recommendOn(liveData.plan, '2026-08-28');
  const liveOnEssential = petsEssential(liveOn.paydayAllocation);
  const liveNextEssential = petsEssential(recommendOn(liveData.plan, '2026-09-25').paydayAllocation);
  ok(near(liveOnEssential.required, 100) && near(liveNextEssential.required, 100),
    'live Aug 28 and Sep 25 payday essentials Dog food are $100',
    `${liveOnEssential.required} / ${liveNextEssential.required}`);
}

console.log('\n=== 7. Surrey Meat classification is unchanged ===');
{
  const txs = [
    { date: '2026-09-12', amount: 48.2, categoryLabel: 'Groceries',
      displayedPayee: 'SURREY MEAT PKR _F', originalMerchant: 'SURREY MEAT PKR _F' },
    { date: '2026-09-12', amount: 48.2, categoryLabel: 'Pets',
      displayedPayee: 'SURREY MEAT PKR', originalMerchant: 'SURREY MEAT PKR' },
    { date: '2026-09-12', amount: 48.2, categoryLabel: 'Groceries',
      displayedPayee: 'SURREY MEAT PAC _F', originalMerchant: 'SURREY MEAT PAC _F' },
  ];
  // H1 (lead decision 2026-11-07): the explicit Lunch Money category wins;
  // a Groceries label stays Groceries, a Pets label is Dog food.
  for (const tx of txs) {
    const cls = F.classifyCurrentPeriodTransaction(tx, livePlan, {});
    const want = tx.categoryLabel === 'Pets' ? 'pets' : 'groceries';
    ok(cls && cls.kind === 'spend' && cls.categoryId === want,
      `${tx.originalMerchant} labelled ${tx.categoryLabel} classifies as ${want}`,
      cls && `${cls.kind}/${cls.categoryId}/${cls.includeReason || cls.reason}`);
    ok(want !== 'pets' || cls.includeReason === 'dog-food-merchant' || cls.reason === 'dog-food-merchant',
      `${tx.originalMerchant} labelled Pets keeps the dog-food-merchant reason`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
