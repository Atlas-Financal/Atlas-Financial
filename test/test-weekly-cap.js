'use strict';
/* Focused proof for the weekly↔monthly conversion and the discretionary-room
 * verdict. `node test/test-weekly-cap.js`
 *
 * The household reads a WEEKLY figure; the budget is derived in MONTHS. One
 * conversion sits between them, and it decides a published verdict —
 * "Discretionary room — nothing left. The cap is below what normal life
 * costs." Until this move `public/plan.js` owned all of it, and so did
 * `scripts/figures-snapshot.js`: three copies of one constant, none of them
 * compared with the others. The page's could be changed from 4.35 to 4.00 —
 * moving every budget-derived /wk figure it publishes by about 8% — and
 * `npm test` stayed green.
 *
 * Four kinds of check:
 *
 *   1. THE CALENDAR IDENTITY, re-derived here rather than imported. `Forecast`
 *      deliberately does not export the constant: a test that imported it
 *      would prove the engine agrees with itself. This file computes
 *      365.25 / 12 / 7 from the definition of a Gregorian year and requires
 *      the engine to match, so the two can genuinely disagree.
 *   2. HAND-COMPUTED CASES on literal fixtures, with every expected figure
 *      reasoned in the comment above it.
 *   3. THE BOUNDARY, both sides — a cap above, exactly at, and below the
 *      essential need.
 *   4. MUTATION — the constant, the verdict, the room and the shortfall each
 *      broken in the engine source, and the answer required to change.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const data = require('../data.json');
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const read = p => sourceText(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const cents = n => Math.round(n * 100);

/* --------------------------------------------------- the calendar identity */
/* Derived from what a year and a week ARE, not copied from the engine:
 * 365.25 days in a Gregorian year (three common years and one leap in four),
 * twelve months in a year, seven days in a week. */
const DAYS_IN_YEAR = 365 + 1 / 4;
const WEEKS = DAYS_IN_YEAR / 12 / 7;

console.log('=== 1. the conversion is the calendar\'s, and the engine has no other ===');
ok(near(WEEKS, 4.348214285714286),
  'the identity computes 4.3482142857… weeks a month', String(WEEKS));
ok(near(F.monthlyFromWeekly(1), WEEKS),
  'a $1/week cap is $4.3482…/month — the engine agrees with the calendar',
  String(F.monthlyFromWeekly(1)));
ok(near(F.monthlyFromWeekly(1250), 1250 * WEEKS) && near(F.monthlyFromWeekly(0), 0),
  'and it scales linearly, through zero');
ok(F.WEEKS_PER_MONTH === undefined,
  'the constant is NOT exported — a test importing it would prove nothing');
{
  // Three months of weeks is a quarter of a year, to the day. An independent
  // route to the same number.
  ok(near(WEEKS * 12 * 7, 365.25), 'twelve months of weeks is one Gregorian year');
  ok(near(F.monthlyFromWeekly(7) * 12, 365.25),
    'and $7/week — a dollar a day — is $365.25 a year through the engine',
    String(F.monthlyFromWeekly(7) * 12));
}

/* ------------------------------------------------------------- fixtures */
/* A minimal plan and history, so every monthly figure below is a literal.
 * Two essential categories and one discretionary, no dated items, no sinking
 * funds — the arithmetic is meant to be checkable by hand. */
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
        { label: 'Groceries', total: 11000 },   // $1,100/month historical
        { label: 'Fuel', total: 6000 },         //   $600/month historical
        { label: 'Dining', total: 5000 },       //   $500/month historical
      ],
    },
  },
};
const budgetAt = (weeklyCap, extra) => F.budgetBreakdown(FIXTURE_PLAN, FIXTURE_PERIODS,
  Object.assign({ weeklyCap }, extra || {}));

console.log('\n=== 2. hand-computed: a cap well above the essential need ===');
/* The owner targets beat the historical averages, so planned is $1,200 + $800
 * = $2,000/month essential and $400/month discretionary. Nothing is dated, so
 * nothing is netted off.
 *
 * At $600/week the cap is 600 × 4.3482142857… = $2,608.928571…/month.
 *
 *   essential monthly  2000
 *   essential weekly   2000 / 4.3482142857… = 459.95893223819…
 *   room monthly       2608.928571… − 2000  = 608.928571…
 *   room weekly        608.928571… / 4.3482142857… = 140.0411…
 *   food+fuel planned  2000/month, 459.9589…/week (all of the essentials here)
 *   food+fuel historic 1100 + 600 = 1700/month, 390.9651…/week
 *   household discretionary  400/month → 91.9918…/week
 *   room vs household  budget 91.9918… vs room 140.0411… → EXCEEDS by 48.0493…
 *   inCap              2000 + 400 = 2400;  overCap = 0 (cap is larger)
 */
{
  const b = budgetAt(600);
  const c = b.cap;
  ok(b.requiredMonthly === 2000 && b.discretionaryMonthly === 400,
    'the fixture derives $2,000 essential and $400 discretionary a month',
    `${b.requiredMonthly} / ${b.discretionaryMonthly}`);
  ok(near(c.monthly, 600 * WEEKS), 'the monthly cap is the weekly cap × weeks-per-month',
    String(c.monthly));
  ok(near(c.monthly, 2608.9285714285716), 'which is $2,608.9285…', String(c.monthly));
  ok(near(c.essentialWeekly, 2000 / WEEKS) && near(c.essentialWeekly, 459.95893223819303),
    'the weekly essential need is requiredMonthly ÷ weeks-per-month',
    String(c.essentialWeekly));
  ok(c.hasDiscretionaryRoom === true, 'a cap above the need leaves room');
  ok(near(c.discretionaryRoomMonthly, 608.9285714285716)
    && near(c.discretionaryRoomWeekly, 608.9285714285716 / WEEKS),
  'the room is the positive remainder after the essentials',
  `${c.discretionaryRoomMonthly} / ${c.discretionaryRoomWeekly}`);
  ok(c.essentialShortfallMonthly === 0 && c.essentialShortfallWeekly === 0,
    'and there is no shortfall');
  ok(near(c.foodFuelPlannedMonthly, 2000) && near(c.foodFuelPlannedWeekly, 2000 / WEEKS),
    'planned food and fuel reconcile with their monthly inputs',
    String(c.foodFuelPlannedWeekly));
  ok(near(c.foodFuelHistoricalMonthly, 1700) && near(c.foodFuelHistoricalWeekly, 1700 / WEEKS),
    'and so do the historical ones — $11,000 + $6,000 over ten months',
    String(c.foodFuelHistoricalWeekly));
  ok(near(c.groceriesPlannedWeekly, 1200 / WEEKS) && near(c.fuelPlannedWeekly, 800 / WEEKS),
    'each of groceries and fuel converts on its own');
  ok(near(c.groceriesPlannedWeekly + c.fuelPlannedWeekly, c.foodFuelPlannedWeekly),
    'and the two add to the pair');
  ok(near(c.householdDiscretionaryWeekly, 400 / WEEKS),
    'the household\'s own discretionary budget is converted the same way',
    String(c.householdDiscretionaryWeekly));
  ok(c.roomVersusHousehold.verdict === 'exceeds',
    'and here the room EXCEEDS that budget, which is named rather than signed',
    c.roomVersusHousehold.verdict);
  // 400/W = 91.9917864… budgeted; 600 − 2000/W = 140.0410677… left. The gap is
  // 48.0492813…, and it is reported as that rather than as −48.0492813….
  ok(near(c.roomVersusHousehold.weekly, Math.abs(400 / WEEKS - (600 - 2000 / WEEKS)))
    && near(c.roomVersusHousehold.weekly, 48.04928131416837)
    && c.roomVersusHousehold.weekly > 0,
  'by $48.0492813…/wk — a magnitude, never a negative number',
  String(c.roomVersusHousehold.weekly));
  ok(near(c.inCapMonthly, 2400) && c.overCapMonthly === 0,
    'the categories total $2,400 against a larger cap, so nothing has to come off',
    `${c.inCapMonthly} / ${c.overCapMonthly}`);
}

console.log('\n=== 3. hand-computed: a cap BELOW the essential need ===');
/* At $400/week the cap is 400 × 4.3482142857… = $1,739.2857…/month against a
 * $2,000 essential need.
 *
 *   shortfall monthly  2000 − 1739.285714… = 260.714285…
 *   shortfall weekly   260.714285… / 4.3482142857… = 59.95893223819…
 *                      = 459.95893… − 400, the essential week minus the cap week
 *   room               none, and reported as exactly zero rather than negative
 *   overCap            2400 − 1739.285714… = 660.714285…
 */
{
  const c = budgetAt(400).cap;
  ok(c.hasDiscretionaryRoom === false, 'a cap below the need leaves no room');
  ok(c.discretionaryRoomMonthly === 0 && c.discretionaryRoomWeekly === 0,
    'the room is exactly zero, never negative',
    `${c.discretionaryRoomMonthly} / ${c.discretionaryRoomWeekly}`);
  ok(near(c.essentialShortfallMonthly, 260.71428571428567),
    'the monthly shortfall is the exact remainder', String(c.essentialShortfallMonthly));
  ok(near(c.essentialShortfallWeekly, 260.71428571428567 / WEEKS)
    && near(c.essentialShortfallWeekly, 59.95893223819301),
  'and the weekly shortfall converts with the same identity',
  String(c.essentialShortfallWeekly));
  ok(near(c.essentialShortfallWeekly, c.essentialWeekly - 400),
    'which reconciles independently: essential/week − cap/week',
    `${c.essentialWeekly} − 400 = ${c.essentialWeekly - 400}`);
  ok(near(c.overCapMonthly, 660.7142857142853),
    'and the categories overrun the cap by the full difference', String(c.overCapMonthly));
}

console.log('\n=== 4. the boundary, from both sides and exactly on it ===');
/* The essential need is $2,000/month. The weekly cap that lands exactly there
 * is 2000 / 4.3482142857… = $459.94200105…/week. The page compared two
 * unrounded monthly sums with a bare `>`, so a cap a hundredth of a cent under
 * published "nothing left — the cap is below what normal life costs" beside a
 * shortfall that rounds to $0/week. The engine's epsilon is half a cent, finer
 * than any of these figures is published to. */
{
  const exact = 2000 / WEEKS;
  const on = budgetAt(exact).cap;
  ok(near(on.monthly, 2000, 1e-9), 'the boundary cap really is $2,000/month', String(on.monthly));
  ok(on.hasDiscretionaryRoom === true,
    'a cap EXACTLY at the essential need leaves room — of zero, not "nothing left"');
  ok(cents(on.discretionaryRoomWeekly) === 0 && cents(on.essentialShortfallWeekly) === 0,
    'with both room and shortfall at $0.00');

  const hair = budgetAt(exact - 0.0000001).cap;
  ok(hair.hasDiscretionaryRoom === true,
    'a cap a ten-millionth of a dollar under is still at the need, not below it');
  ok(cents(hair.essentialShortfallWeekly) === 0,
    'and its shortfall is $0.00 — which is why calling it a shortfall was wrong');

  // A real cent under is a real shortfall. The epsilon must not swallow money
  // the household can actually see.
  const realCent = budgetAt((2000 - 0.02) / WEEKS).cap;
  ok(realCent.hasDiscretionaryRoom === false,
    'two cents a month under the need IS below it', String(realCent.essentialShortfallMonthly));
  ok(cents(realCent.essentialShortfallMonthly) === 2,
    'and the shortfall is the two cents', String(realCent.essentialShortfallMonthly));

  const above = budgetAt(exact + 1).cap;
  ok(above.hasDiscretionaryRoom === true && above.discretionaryRoomWeekly > 0,
    'a dollar a week above the need leaves a dollar a week of room',
    String(above.discretionaryRoomWeekly));
  ok(near(above.discretionaryRoomWeekly, 1, 1e-9),
    'exactly a dollar', String(above.discretionaryRoomWeekly));
}

console.log('\n=== 5. the cap measured is the cap being SHOWN ===');
/* The household can set its own weekly figure. The budget must be measured
 * against what the page displays — comparing the essentials with a
 * recommendation nobody is looking at describes a different plan. The
 * recommended figure stays available beside it, because the page still says
 * "your setting — the forecast supports $X/wk". */
{
  const override = budgetAt(900, { recommendedWeekly: 600 }).cap;
  ok(override.weekly === 900, 'the active cap is the override', String(override.weekly));
  ok(near(override.monthly, 900 * WEEKS),
    'and the monthly figure follows the override, not the recommendation',
    String(override.monthly));
  ok(override.recommendedWeekly === 600,
    'the recommendation remains independently available', String(override.recommendedWeekly));
  ok(override.isOverride === true, 'and the result says the two differ');

  const same = budgetAt(600, { recommendedWeekly: 600 }).cap;
  ok(same.isOverride === false, 'with no override set, nothing is flagged as one');

  const silent = budgetAt(900).cap;
  ok(silent.recommendedWeekly === null && silent.isOverride === false,
    'a caller that names no recommendation gets null rather than a guess');

  // The decisive case: an override BELOW the need while the recommendation is
  // above it. Measuring the recommendation would publish room that the figure
  // on screen does not leave.
  const low = budgetAt(400, { recommendedWeekly: 600 }).cap;
  ok(low.hasDiscretionaryRoom === false,
    'an override below the need reports no room, though the recommendation would have left some');
  ok(budgetAt(600, { recommendedWeekly: 600 }).cap.hasDiscretionaryRoom === true,
    'and the recommendation on its own does leave room — so the two genuinely differ');
}

console.log('\n=== 6. no cap named, no verdict invented ===');
{
  const b = F.budgetBreakdown(FIXTURE_PLAN, FIXTURE_PERIODS, {});
  ok(b.cap === null, 'a caller that names no cap gets null, not a cap of zero');
  ok(b.requiredMonthly === 2000, 'while the monthly budget is unaffected');
  ok(F.budgetBreakdown(FIXTURE_PLAN, null, { weeklyCap: 600 }) === null,
    'and no spending history still returns null overall');
}

console.log('\n=== 7. the published plan reconciles ===');
/* The real numbers, checked against the identity rather than against the
 * engine's own arithmetic. */
{
  const plan = data.plan, asOf = data.meta.asOf;
  const adv = F.recommend(plan, asOf, {
    scenario: plan.defaults.scenario, targetBuffer: plan.defaults.targetBuffer,
    extraDebtMonthly: 0, incomeOverrides: {}, disabled: [], debts: data.debts,
    extraDebtTarget: plan.nextDollar.target, fundingSources: plan.funding.options,
  });
  const b = F.budgetBreakdown(plan, periods, {
    paypalPerMonth: data.paypal.perMonth, disabled: [],
    weeklyCap: adv.weekly, recommendedWeekly: adv.weekly,
  });
  const c = b.cap;
  const inCapRequired = b.categories
    .filter(cat => cat.class === 'essential' || cat.class === 'unknown')
    .reduce((s, cat) => s + (cat.planned || 0), 0);
  const inCapDisc = b.categories
    .filter(cat => cat.class === 'discretionary')
    .reduce((s, cat) => s + (cat.planned || 0), 0);
  const reservedRequired = b.categories
    .filter(cat => cat.class === 'essential' || cat.class === 'unknown')
    .reduce((s, cat) => s + (cat.reserved || 0), 0);
  ok(near(c.monthly, adv.weekly * WEEKS),
    `the published $${adv.weekly}/week cap is $${c.monthly.toFixed(2)}/month`);
  ok(near(b.requiredMonthly, inCapRequired + reservedRequired),
    'coverage required still includes reserved current-regime',
    `${b.requiredMonthly.toFixed(2)} = ${inCapRequired.toFixed(2)} + ${reservedRequired.toFixed(2)}`);
  ok(near(c.essentialWeekly, inCapRequired / WEEKS),
    'the published weekly essential need divides the in-cap monthly remainder',
    `${inCapRequired.toFixed(2)} → ${c.essentialWeekly.toFixed(2)}`);
  ok(c.discretionaryRoomWeekly >= 0, 'discretionary room is never published negative');
  ok(c.essentialWeekly + 0.005 >= adv.weekly
    ? c.discretionaryRoomWeekly === 0
    : near(c.essentialWeekly + c.discretionaryRoomWeekly, adv.weekly, 1e-9),
    'essential need + discretionary room = the weekly cap when room exists; otherwise the cap is fully essential',
    `${c.essentialWeekly.toFixed(2)} + ${c.discretionaryRoomWeekly.toFixed(2)} = ${adv.weekly}`);
  ok(c.essentialMonthly + 0.005 >= c.monthly
    ? c.discretionaryRoomMonthly === 0
    : near(c.essentialMonthly + c.discretionaryRoomMonthly, c.monthly, 1e-9),
    'and the same identity holds in months');
  ok(near(c.inCapMonthly, inCapRequired + inCapDisc),
    'the in-cap total is the planned remainder, not coverage including reserved');
  ok(near(c.overCapMonthly, Math.max(0, c.inCapMonthly - c.monthly), 1e-9),
    'and the overrun is the floored difference between in-cap spend and the monthly cap',
    `$${c.overCapMonthly.toFixed(2)}/month`);
}

console.log('\n=== 8. mutation: breaking the engine breaks the answer ===');
const FORECAST_SRC = read('public/forecast.js');
function mutant(from, to) {
  from = sourceText(from);
  to = sourceText(to);
  const occurrences = FORECAST_SRC.split(from).length - 1;
  if (occurrences !== 1) return { error: `target appears ${occurrences} time(s)` };
  const sandbox = { module: { exports: {} } };
  try {
    vm.runInNewContext(FORECAST_SRC.replace(from, to), sandbox, { filename: 'forecast-mutant.js' });
  } catch (e) { return { error: e.message }; }
  return { engine: sandbox.module.exports };
}
const mBudget = (m, weeklyCap, extra) => m.budgetBreakdown(FIXTURE_PLAN, FIXTURE_PERIODS,
  Object.assign({ weeklyCap }, extra || {})).cap;

const MUTATIONS = [
  { label: 'the 4.35 → 4.00 mutation the page hid is now visible',
    from: '  const WEEKS_PER_MONTH = 365.25 / 12 / 7;',
    to: '  const WEEKS_PER_MONTH = 4.00;',
    check: m => !near(mBudget(m, 600).essentialWeekly, 2000 / WEEKS, 0.01),
    real: () => near(budgetAt(600).cap.essentialWeekly, 2000 / WEEKS) },

  { label: 'dropping the leap-quarter day moves every weekly figure',
    from: '  const WEEKS_PER_MONTH = 365.25 / 12 / 7;',
    to: '  const WEEKS_PER_MONTH = 365 / 12 / 7;',
    check: m => !near(mBudget(m, 600).monthly, 600 * WEEKS, 1e-9),
    real: () => near(budgetAt(600).cap.monthly, 600 * WEEKS, 1e-9) },

  { label: 'reversing the monthly conversion turns a cap into a fraction of itself',
    from: '  function monthlyFromWeekly(weekly) { return weekly * WEEKS_PER_MONTH; }',
    to: '  function monthlyFromWeekly(weekly) { return weekly / WEEKS_PER_MONTH; }',
    check: m => !near(m.monthlyFromWeekly(600), 600 * WEEKS, 0.01),
    real: () => near(F.monthlyFromWeekly(600), 600 * WEEKS, 1e-9) },

  { label: 'dropping the room test publishes room where the cap cannot pay the essentials',
    from: '    const hasDiscretionaryRoom = atLeast(monthly, requiredMonthly);',
    to: '    const hasDiscretionaryRoom = true;',
    check: m => mBudget(m, 400).hasDiscretionaryRoom === true,
    real: () => budgetAt(400).cap.hasDiscretionaryRoom === false },

  { label: 'a bare comparison calls a cap exactly at the need a shortfall',
    from: '    const hasDiscretionaryRoom = atLeast(monthly, requiredMonthly);',
    to: '    const hasDiscretionaryRoom = monthly > requiredMonthly;',
    check: m => mBudget(m, 2000 / WEEKS).hasDiscretionaryRoom === false,
    real: () => budgetAt(2000 / WEEKS).cap.hasDiscretionaryRoom === true },

  { label: 'unbounding the room reports a negative remainder as spending money',
    from: '    const discretionaryRoomMonthly = Math.max(0, monthly - requiredMonthly);',
    to: '    const discretionaryRoomMonthly = monthly - requiredMonthly;',
    check: m => mBudget(m, 400).discretionaryRoomMonthly < 0,
    real: () => budgetAt(400).cap.discretionaryRoomMonthly === 0 },

  { label: 'reversing the shortfall reports the wrong figure below the need',
    from: '    const essentialShortfallMonthly = Math.max(0, requiredMonthly - monthly);',
    to: '    const essentialShortfallMonthly = Math.max(0, monthly - requiredMonthly);',
    check: m => mBudget(m, 400).essentialShortfallMonthly === 0,
    real: () => cents(budgetAt(400).cap.essentialShortfallMonthly) === 26071 },

  { label: 'measuring the recommendation instead of the override describes a plan nobody is shown',
    from: '    const weekly = opts.weeklyCap;',
    to: '    const weekly = opts.recommendedWeekly != null ? opts.recommendedWeekly : opts.weeklyCap;',
    check: m => mBudget(m, 400, { recommendedWeekly: 600 }).hasDiscretionaryRoom === true,
    real: () => budgetAt(400, { recommendedWeekly: 600 }).cap.hasDiscretionaryRoom === false },

  { label: 'a signed difference lets the page publish a negative shortfall again',
    from: `      weekly: Math.abs(householdDiscretionaryWeekly - roomWeekly),`,
    to: `      weekly: householdDiscretionaryWeekly - roomWeekly,`,
    check: m => mBudget(m, 600).roomVersusHousehold.weekly < 0,
    real: () => budgetAt(600).cap.roomVersusHousehold.weekly > 0 },

  { label: 'calling every case a shortfall mislabels a cap that leaves more than the budget',
    from: `      verdict: below(roomWeekly, householdDiscretionaryWeekly) ? 'short'
        : below(householdDiscretionaryWeekly, roomWeekly) ? 'exceeds'
          : 'meets',`,
    to: `      verdict: 'short',`,
    check: m => mBudget(m, 600).roomVersusHousehold.verdict === 'short',
    real: () => budgetAt(600).cap.roomVersusHousehold.verdict === 'exceeds' },

  { label: 'swapping the two sides of the comparison inverts the verdict',
    from: `      verdict: below(roomWeekly, householdDiscretionaryWeekly) ? 'short'
        : below(householdDiscretionaryWeekly, roomWeekly) ? 'exceeds'
          : 'meets',`,
    to: `      verdict: below(householdDiscretionaryWeekly, roomWeekly) ? 'short'
        : below(roomWeekly, householdDiscretionaryWeekly) ? 'exceeds'
          : 'meets',`,
    check: m => mBudget(m, 600).roomVersusHousehold.verdict === 'short'
      && mBudget(m, 400).roomVersusHousehold.verdict === 'exceeds',
    real: () => budgetAt(600).cap.roomVersusHousehold.verdict === 'exceeds' },
];
for (const m of MUTATIONS) {
  const built = mutant(m.from, m.to);
  if (built.error) { ok(false, m.label, built.error); continue; }
  ok(m.check(built.engine) && m.real(), m.label);
}

console.log('\n=== 9. the page and the snapshot divide nothing ===');
{
  const planSrc = read('public/plan.js');
  const snapSrc = read('scripts/figures-snapshot.js');
  for (const [name, src] of [['public/plan.js', planSrc], ['scripts/figures-snapshot.js', snapSrc]]) {
    ok(!/365\.25\s*\/\s*12\s*\/\s*7/.test(src),
      `${name} holds no copy of the weeks-per-month constant`);
    ok(!/WEEKS_PER_MONTH/.test(src), `${name} names no such constant at all`);
  }
  ok(!/const perWeek =/.test(planSrc), 'the page has no conversion helper');
  ok(!/recMonthly/.test(planSrc), 'and no monthly-cap arithmetic of its own');
  ok(!/Math\.max\(0, recMonthly - required\)/.test(planSrc),
    'no discretionary-room arithmetic');
  ok(!/const short = required - recMonthly/.test(planSrc), 'and no shortfall arithmetic');
  ok(/Forecast\.monthlyFromWeekly\(/.test(planSrc), 'the page reads the monthly conversion from Forecast');
  ok(/\bF\.monthlyFromWeekly\(/.test(snapSrc), 'and so does the snapshot script');
  // Finish-line audit finding 12: through the shared builder, which takes the
  // on-screen weekly figure and the recommendation from the advice.
  ok(/Forecast\.budgetBreakdownInputs\(d, advice, \{ knobs: state, weekly, asOf \}\)/.test(planSrc)
      && /weeklyCap: opts\.weekly,/.test(FORECAST_SRC) && /recommendedWeekly: advice && advice\.weekly,/.test(FORECAST_SRC),
    'and the page tells the engine which cap is on screen');
  ok(/cap\.hasDiscretionaryRoom/.test(planSrc),
    'the discretionary-room verdict is read, not decided');
}

console.log('\n=== 9b. the room-versus-budget sentence, rendered on all three sides ===');
/* The blocking review's finding, and the gap in the proof that let it through:
 * section 2 asserted the negative comparison and never rendered it. The page's
 * clause map is lifted from source here — not copied — and every verdict is put
 * through it. A rendered financial sentence may never contain a negative
 * amount: "the plan is −$48/wk short of it and something has to give" is what
 * the signed field published. */
{
  const planSrc = read('public/plan.js');
  const appSrc = read('public/app.js');
  const grab = (src, re, what) => {
    const m = re.exec(src);
    ok(!!m, `${what} is readable from its source`);
    return m ? m[0] : '';
  };
  const moneySrc = grab(appSrc, /^const money = .*$/m, 'money()');
  const MAP_SRC = grab(planSrc, /^const ROOM_VERSUS_HOUSEHOLD = \{[\s\S]*?^\};$/m,
    'the room-versus-budget clause map');
  const ROOM = vm.runInNewContext(`${moneySrc}\n${MAP_SRC}\nROOM_VERSUS_HOUSEHOLD;`);

  const engineVerdicts = ['short', 'meets', 'exceeds'];
  ok(Object.keys(ROOM).sort().join(',') === engineVerdicts.slice().sort().join(','),
    'the page words exactly the three verdicts the engine can emit',
    Object.keys(ROOM).join(','));

  // One fixture per verdict, each built through the real engine.
  //   $600/wk → room $140.04 vs budget $91.99  → exceeds
  //   $400/wk → no room at all                 → short (by the whole budget)
  //   the meeting point                        → meets
  const meetsAt = budgetAt(600).cap.essentialWeekly + budgetAt(600).cap.householdDiscretionaryWeekly;
  const CASES = [
    { what: 'exceeds', weekly: 600 },
    { what: 'short', weekly: 460 },
    { what: 'meets', weekly: meetsAt },
  ];
  for (const k of CASES) {
    const c = budgetAt(k.weekly).cap;
    const r = c.roomVersusHousehold;
    ok(r.verdict === k.what, `a $${k.weekly.toFixed(2)}/wk cap is "${k.what}"`, r.verdict);
    const sentence = `own budget for those comes to ${vm.runInNewContext(`${moneySrc}\nmoney`)(c.householdDiscretionaryWeekly)}/wk, `
      + ROOM[r.verdict](r);
    ok(!/−\$/.test(sentence),
      `and its rendered sentence carries no negative amount — ${k.what}`, sentence);
    ok(!/undefined|NaN/.test(sentence), `nor undefined or NaN — ${k.what}`);
    if (k.what === 'short') {
      ok(/so the plan is \$\d[\d,]*\/wk short of it and something has to give\.$/.test(sentence),
        'the short sentence is the wording the household reads today', sentence);
    }
    if (k.what === 'exceeds') {
      ok(/and the plan leaves \$48\/wk more than that\.$/.test(sentence),
        'and the exceeds sentence says what is actually true', sentence);
    }
    if (k.what === 'meets') {
      ok(/which is what the plan leaves\.$/.test(sentence),
        'and the meets sentence claims neither', sentence);
    }
  }

  // The old shape, rendered, to show exactly what was being published.
  const money = vm.runInNewContext(`${moneySrc}\nmoney`);
  const c600 = budgetAt(600).cap;
  const signed = c600.householdDiscretionaryWeekly - c600.discretionaryRoomWeekly;
  ok(signed < 0 && /^−\$/.test(money(signed)),
    'the field this replaced rendered as a negative dollar amount',
    `so the plan is ${money(signed)}/wk short of it and something has to give.`);
}

console.log('\n=== 10. the real page, booted, on both sides of the sentence ===');
/* Everything above proves the engine and renders through its clause map. This
 * runs the page — `public/app.js`, `public/forecast.js`, `public/plan.js` in
 * the order `index.html` loads them, against a stub DOM, through `App.boot()`
 * on the real `data.json` — and reads back what the household is shown. It is
 * booted TWICE: once at the recommendation, and once with a $1,800/week
 * override, the setting the blocking review found publishing a negative
 * shortfall. The page no longer restores knobs from storage (finish-line audit
 * finding 9: their controls are hidden), so an override is applied to the
 * page's own `state` once boot has rendered and re-rendered through
 * App.rerender(): the same inputs, end to end through the real page. */
function bootPage(storedKnobs, payload, periodsOverride) {
  const body = payload || data;
  const per = periodsOverride || periods;
  const els = new Map();
  const makeEl = id => {
    const el = {
      id, textContent: '', value: '', placeholder: '', checked: false, hidden: false,
      className: '', style: {}, children: [], listeners: {}, attributes: {},
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      append(...children) { for (const child of children) this.appendChild(child); },
      remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; } },
      insertAdjacentHTML(_, h) { this.innerHTML = String(h); },
      querySelectorAll: () => [],
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML',
      { get: () => html, set(v) { html = String(v); el.children = []; el.textContent = ''; el.htmlWrites = (el.htmlWrites || 0) + 1; } });
    return el;
  };
  const get = id => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const sandbox = {
    document: {
      getElementById: get,
      createElement: () => makeEl('created'),
      createElementNS: () => makeEl('svg'),
      querySelector: () => null, querySelectorAll: () => [],
      documentElement: makeEl('html'), body: { scrollHeight: 0 },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, scrollY: 0, console,
    fetch: url => Promise.resolve({ status: 200, ok: true,
      json: () => (String(url).includes('periods') ? per
        : String(url).includes('balance-history') ? null : body) }),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  Object.assign(sandbox, { AbortController, setTimeout, clearTimeout });
  vm.createContext(sandbox);
  for (const file of ['public/app.js', 'public/forecast.js', 'public/budget-surface.js', 'public/plan.js']) {
    vm.runInContext(read(file), sandbox, { filename: file });
  }
  // Queued before any caller's timer, so it runs first, after boot's
  // microtasks have drained.
  if (storedKnobs) setTimeout(() => {
    sandbox.__knobs = JSON.stringify(storedKnobs);
    vm.runInContext('Object.assign(state, JSON.parse(__knobs)); App.rerender();', sandbox);
  }, 0);
  return { get, run: script => vm.runInContext(script, sandbox) };
}
// Exact synthetic ledger corpus, independent of any withdrawal consumer.
function reversalRendererFixture(withReversal) {
  const C = require('../scripts/planned-obligation-settlement-contract');
  const d = require('./fixtures/savings-daily-consumer-data')();
  d.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  const householdId = 'household-' + 'a'.repeat(32), actorId = 'session-' + 'b'.repeat(64);
  const op = n => 'operation-' + n.toString(16).padStart(32, '0');
  const evidence = { accountId: 'chequing-a', currency: 'cad', direction: 'debit', date: '2026-10-03', cents: 6000, posted: true };
  const link = { version: 1, kind: 'link', goalId: 'commitment:near', txRef: 'tx-' + 'c'.repeat(32),
    evidence, evidenceDigest: C.digest(evidence), assignedCents: 2500, asOf: '2026-10-05' };
  const counter = { ...evidence, direction: 'credit', cents: 1000 };
  const commands = [link, ...(withReversal ? [{ version: 1, kind: 'reverse', targetOperationId: op(1),
    counterTxRef: 'tx-' + 'd'.repeat(32), counterEvidence: counter, counterEvidenceDigest: C.digest(counter), cents: 1000 }] : []),
  { ...link, goalId: 'commitment:far', assignedCents: 2000 }];
  let body = C.adopt({ householdId });
  commands.forEach((command, i) => {
    const p = C.prepare(body, { householdId, actorId, operationId: op(i + 1), command, now: 100 + i * 2 });
    body = C.confirmCandidate(body, { householdId, actorId, preview: p.preview,
      confirmationDigest: p.confirmationDigest, now: 101 + i * 2 }).document;
  });
  d.settlementEvidenceStatus = { status: 'qualified' };
  d.settlementEvidence = C.effectiveEvidence(JSON.parse(body));
  return d;
}
const flat = s => s.replace(/\s+/g, ' ').trim();
const settle = () => new Promise(r => setTimeout(r, 0));

(async () => {
  /* --- at the recommendation: the page follows the engine, not copied cents --- */
  const plan = data.plan;
  const asOf = data.meta.asOf;
  const advice = F.recommend(plan, asOf, {
    scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: plan.defaults.targetBuffer,
    debts: data.debts,
    extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
    fundingSources: plan.funding && plan.funding.options,
  });
  const liveBudget = F.budgetBreakdown(plan, periods, {
    paypalPerMonth: data.paypal && data.paypal.perMonth,
    weeklyCap: advice.weekly, recommendedWeekly: advice.weekly,
  });
  const cap = liveBudget.cap;
  const dol = n => '$' + Math.round(Math.abs(n)).toLocaleString('en-CA');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const def = bootPage(null);
  await settle();
  const capSplit = flat(def.get('cap-split').innerHTML);
  const budgetOut = flat(def.get('budget-out').innerHTML);
  const tiles = flat(def.get('hero-tiles').innerHTML);
  const catsNote = def.get('budget-cats-note').textContent;

  ok(new RegExp(esc(dol(cap.essentialWeekly))).test(capSplit),
    'the booted page shows the engine\'s weekly essential need');
  ok(new RegExp(esc(dol(cap.discretionaryRoomWeekly))).test(capSplit),
    'and the engine\'s weekly discretionary room');
  ok(new RegExp(`Groceries ${esc(dol(cap.groceriesPlannedWeekly))}, fuel ${esc(dol(cap.fuelPlannedWeekly))}`).test(capSplit),
    'with groceries and fuel split per week');
  ok(new RegExp(`≈ ${esc(dol(cap.monthly))} a month`).test(capSplit),
    'and the cap said in months');
  const roomNote = h => (/own budget for those comes to [^<]*/.exec(h) || ['(not found)'])[0];
  // The sentence is rendered only when the engine reports discretionary room;
  // otherwise the page says "Nothing.". A missing sentence must fail, not pass
  // as the '(not found)' fallback string.
  const sentence = /own budget for those comes to [^<]*/.exec(capSplit);
  ok(cap.hasDiscretionaryRoom
    ? !!sentence && /\$\d/.test(sentence[0]) && !/undefined|NaN/.test(sentence[0])
    : !sentence && /Nothing\./.test(capSplit),
    'and the household-budget sentence matches the engine: present and finite with room, "Nothing." without',
    `hasDiscretionaryRoom=${cap.hasDiscretionaryRoom}; ${sentence ? 'sentence present' : 'sentence absent'}`);
  ok(new RegExp(`${esc(dol(cap.monthly))} / month`).test(budgetOut),
    'the ledger says the same monthly cap');
  ok(cap.hasDiscretionaryRoom
    ? new RegExp(`${esc(dol(cap.discretionaryRoomWeekly))} / week`).test(budgetOut)
    : /nothing left|\$0/.test(budgetOut),
    'and reports discretionary room the same way the engine does');
  ok(cap.householdDiscretionaryWeekly == null
    || !cap.hasDiscretionaryRoom
    || new RegExp(`${esc(dol(cap.householdDiscretionaryWeekly))}/week`).test(budgetOut + capSplit)
    || /own budget/.test(budgetOut + capSplit),
    'against the household\'s own discretionary budget');
  ok(new RegExp(`${esc(dol(cap.essentialWeekly))}/wk`).test(tiles)
    && new RegExp(`${esc(dol(cap.foodFuelPlannedWeekly))}/wk of it food and fuel`).test(tiles),
    'the tiles carry the weekly need and its food-and-fuel share');
  ok(new RegExp(`${esc(dol(cap.inCapMonthly))}/month against a cap of ${esc(dol(cap.monthly))}/month`).test(catsNote),
    'and the category note reconciles against the monthly cap');
  ok(new RegExp(`essential rows, which are ${esc(dol(cap.essentialMonthly))}/month`).test(catsNote),
    'and names the in-cap essential remainder, not coverage including reserved');

  /* --- at a $1,800/week override: the state the review found --- */
  const overCap = F.budgetBreakdown(plan, periods, {
    paypalPerMonth: data.paypal && data.paypal.perMonth,
    weeklyCap: 1800, recommendedWeekly: advice.weekly,
  }).cap;
  const over = bootPage({ weeklyVariable: 1800 });
  await settle();
  const overSplit = flat(over.get('cap-split').innerHTML);

  const overSentence = /own budget for those comes to [^<]*/.exec(overSplit);
  ok(overCap.hasDiscretionaryRoom === true && !!overSentence
      && /\$\d/.test(overSentence[0]) && !/undefined|NaN/.test(overSentence[0]),
    'at the override the engine reports room and the household-budget sentence is present and finite',
    overSentence ? 'sentence present' : 'sentence absent');
  ok(new RegExp(esc(dol(overCap.discretionaryRoomWeekly))).test(overSplit),
    'at a stored $1,800/wk override the page shows the engine\'s room', roomNote(overSplit));
  ok(overCap.roomVersusHousehold && overCap.roomVersusHousehold.verdict === 'exceeds'
    ? /leaves/.test(overSplit) && !/short of it and something has to give/.test(overSplit)
    : true,
    'and the household-budget sentence matches the engine verdict',
    roomNote(overSplit));
  ok(!/short of it and something has to give/.test(overSplit) || overCap.roomVersusHousehold.verdict !== 'exceeds',
    'not that it is short of it when the override exceeds the household budget');
  ok(!/−\$/.test(overSplit),
    'and no negative dollar amount reaches the household', roomNote(overSplit));

  for (const [name, html] of [['cap-split', capSplit], ['budget-out', budgetOut],
    ['hero-tiles', tiles], ['budget-cats-note', catsNote], ['cap-split @1800', overSplit]]) {
    ok(!/undefined|NaN|\[object/.test(html),
      `${name} contains no undefined, NaN or [object Object]`);
  }

  console.log('\n=== 11. unfunded sentinel is not a household cap on the Plan page ===');
  /* Same page harness as section 10, on synthetic fixtures so live cents
   * cannot become the specification (L-006). Independent gap = buffer − cash. */
  const envelope = plan => ({
    meta: { asOf: '2026-08-16' },
    debts: [], revolvingExtra: [], paypal: null, helocHistory: [],
    plan: Object.assign({
      obligations: [], bills: [], commitments: [], actions: [],
      budget: FIXTURE_PLAN.budget,
    }, plan, {
      defaults: Object.assign(
        { scenario: 'expected', extraDebtMonthly: 0, targetBuffer: 0 },
        plan.defaults || {}),
    }),
  });
  const rec = (payload, extra) => F.recommend(payload.plan, payload.meta.asOf, Object.assign({
    scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
    targetBuffer: payload.plan.defaults.targetBuffer,
    fundingSources: payload.plan.funding && payload.plan.funding.options,
    debts: [], extraFacilities: [], extraDebtTarget: null,
  }, extra || {}));
  const capSurfaces = page => ({
    tiles: flat(page.get('hero-tiles').innerHTML),
    headline: flat(page.get('cap-headline').innerHTML),
    split: flat(page.get('cap-split').innerHTML),
    basis: flat(page.get('cap-basis').innerHTML),
    budgetOut: flat(page.get('budget-out').innerHTML),
    budgetBasis: String(page.get('budget-basis').textContent || ''),
    payday: flat(page.get('payday-answer-body').innerHTML),
  });
  const capTile = html => {
    const m = /Weekly household cap<\/div> <div class="val">([^<]*)<\/div> <div class="note">(.*?)<\/div>/.exec(html);
    return m ? { val: m[1].trim(), note: m[2].trim() } : { val: '', note: '' };
  };
  const capAmt = html => {
    const m = /cap-amt">([^<]*)/.exec(html);
    return m ? m[1].trim() : '';
  };
  const splitTotal = html => {
    const m = /cap-part-lab">Total<\/div> <div class="cap-part-amt">([\s\S]*?)<\/div>/.exec(html);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  const UNFUNDED_BUFFER = 400;
  const UNFUNDED_CASH = 150;
  const unfundedPayload = envelope({
    windowDays: 21,
    defaults: { targetBuffer: UNFUNDED_BUFFER },
    startingCash: { amount: UNFUNDED_CASH, note: '' },
    income: [{
      id: 'later-pay', label: 'Later pay', frequency: 'once',
      date: '2026-08-30', amount: 3000, confidence: 'confirmed',
    }],
    funding: {
      heading: 'Cover the gap', note: '',
      options: [{ id: 'empty', label: 'Empty pot', short: 'empty', available: 0, rank: 1 }],
    },
  });
  const unfundedAdvice = rec(unfundedPayload);
  const unfundedStatus = F.planStatus(unfundedAdvice, { weeklyOverride: null, sim: unfundedAdvice.sim });
  const independentGap = UNFUNDED_BUFFER - UNFUNDED_CASH;
  ok(unfundedAdvice.mode === 'openingGap' && unfundedAdvice.weekly === 0
    && unfundedAdvice.funding && unfundedAdvice.funding.feasible === false
    && unfundedStatus.id === 'unfunded',
    'synthetic thin cash is an unfunded opening gap with a zero weekly sentinel',
    `${unfundedAdvice.mode} weekly=${unfundedAdvice.weekly} status=${unfundedStatus.id}`);
  ok(near(independentGap, unfundedAdvice.gap.amount)
    && near(independentGap, unfundedAdvice.funding.shortfall),
    'engine shortfall equals independent buffer minus cash',
    `${independentGap} vs ${unfundedAdvice.funding.shortfall}`);

  const unfundedPage = bootPage(null, unfundedPayload, FIXTURE_PERIODS);
  await settle();
  const retainedHeadline = { html: unfundedPage.get('cap-headline').innerHTML, writes: unfundedPage.get('cap-headline').htmlWrites };
  let hiddenError = null;
  try {
    unfundedPage.run(`document.getElementById('road-ahead').hidden = true;
      globalThis.hiddenCounterfactualCalls = 0;
      const originalCounterfactuals = Forecast.counterfactuals;
      Forecast.counterfactuals = (...args) => { hiddenCounterfactualCalls++; return originalCounterfactuals(...args); };
      try { App.rerender(); } finally { Forecast.counterfactuals = originalCounterfactuals; }`);
  } catch (error) { hiddenError = error; }
  ok(!hiddenError, 'hidden diagnostics unfunded sentinel completes renderer', hiddenError?.message || '');
  ok(unfundedPage.run('hiddenCounterfactualCalls') === 0, 'hidden diagnostics never enables counterfactual calculations');
  ok(unfundedPage.get('cap-headline').htmlWrites === retainedHeadline.writes
    && unfundedPage.get('cap-headline').innerHTML === retainedHeadline.html,
  'hidden unfunded headline is untouched until diagnostics are requested');
  unfundedPage.run(`document.getElementById('road-ahead').hidden = false; App.rerender();`);
  const u = capSurfaces(unfundedPage);
  const uTile = capTile(u.tiles);
  ok(uTile.val === 'unavailable',
    'hero Weekly household cap is unavailable, not $0/wk', uTile.val);
  ok(!/\$0\/wk/.test(uTile.val),
    'hero cap value does not claim $0/wk');
  ok(/no feasible weekly cap/i.test(uTile.note) && /protected shortfall is solved/.test(uTile.note),
    'hero note says the funding shortfall must be solved first');
  ok(!/forecast supports/.test(uTile.note),
    'and does not claim Forecast supports a cap');
  ok(capAmt(u.headline) === 'unavailable' && !/\$0/.test(capAmt(u.headline)),
    'large cap headline is unavailable, not $0', capAmt(u.headline));
  ok(splitTotal(u.split) === 'unavailable' && !/\$0\/wk/.test(splitTotal(u.split)),
    'cap-split Total is unavailable, not $0/wk', splitTotal(u.split));
  ok(!/largest weekly spend/.test(u.basis) && /protected funding shortfall is solved/.test(u.basis),
    'cap-basis does not call zero the largest safe weekly spend');
  ok(/unavailable/.test(u.budgetOut) && !/<b>\$0 \/ week<\/b>/.test(u.budgetOut),
    'budget ledger does not publish $0 / week as the household cap');
  ok(!/largest weekly spend/.test(u.budgetBasis) && /protected funding shortfall is solved/.test(u.budgetBasis),
    'budget-basis does not call zero the largest safe weekly spend');
  ok(/no feasible weekly cap/i.test(u.payday) && !/\$0\/week/.test(u.payday),
    'payday Safe to spend still refuses the sentinel');
  ok(u.tiles.includes(String(independentGap)) || u.headline.includes('250.00') || /\$250/.test(u.tiles + u.headline),
    'the independent $250 shortfall remains visible on the cap surfaces');

  const overridePage = bootPage({
    scenario: 'expected', targetBuffer: UNFUNDED_BUFFER,
    extraDebtMonthly: 0, weeklyVariable: 75, incomeOverrides: {}, disabled: [],
  }, unfundedPayload, FIXTURE_PERIODS);
  await settle();
  const ovr = capSurfaces(overridePage);
  const oTile = capTile(ovr.tiles);
  ok(oTile.val === 'unavailable',
    'with a typed override the hero cap is still unavailable', oTile.val);
  ok(/your setting is \$75\/wk/.test(oTile.note),
    'the override is visible as the user setting', oTile.note.slice(0, 160));
  ok(/not a supported weekly cap/.test(oTile.note) && !/forecast supports/.test(oTile.note),
    'and is not presented as Forecast-supported or safe');
  ok(capAmt(ovr.headline) === 'unavailable' && !/\$75/.test(capAmt(ovr.headline)),
    'the override is not the large cap headline');
  ok(/protected funding shortfall is solved/.test(oTile.note + ovr.headline + ovr.basis),
    'the unresolved gap remains the controlling message');
  ok(!/Master-plan cap/.test(ovr.payday) && /no feasible weekly cap/i.test(ovr.payday),
    'payday still refuses to treat the override as a cap');

  const fatPayload = envelope({
    windowDays: 21,
    defaults: { targetBuffer: 200 },
    startingCash: { amount: 5000, note: '' },
    income: [{
      id: 'pay', label: 'Pay', frequency: 'once',
      date: '2026-08-30', amount: 2000, confidence: 'confirmed',
    }],
    bills: [{
      id: 'bill', label: 'Small bill', frequency: 'once',
      date: '2026-08-20', amount: 100, confidence: 'confirmed',
    }],
  });
  const fatAdvice = rec(fatPayload);
  const leftover = 5000 - 100 - 200;
  ok(leftover > 0 && fatAdvice.weekly > 0 && fatAdvice.mode === 'normal'
    && !(fatAdvice.funding && fatAdvice.funding.feasible === false),
    'surplus after bill and buffer independently implies a positive feasible cap',
    `leftover ${leftover} weekly $${fatAdvice.weekly}`);
  const fatPage = bootPage(null, fatPayload, FIXTURE_PERIODS);
  await settle();
  const f = capSurfaces(fatPage);
  const fTile = capTile(f.tiles);
  const fatLabel = '$' + Math.round(Math.abs(fatAdvice.weekly)).toLocaleString('en-CA') + '/wk';
  ok(fTile.val === fatLabel,
    'a feasible positive cap still renders as dollar/wk on the hero tile', fTile.val);
  ok(capAmt(f.headline) === '$' + Math.round(Math.abs(fatAdvice.weekly)).toLocaleString('en-CA'),
    'and as the large cap headline', capAmt(f.headline));
  ok(!/unavailable/.test(fTile.val + capAmt(f.headline) + splitTotal(f.split)),
    'and does not borrow the unfunded unavailable wording');
  ok(/largest weekly spend/.test(f.basis),
    'feasible-cap basis copy is unchanged');

  const tightPayload = envelope({
    windowDays: 14,
    defaults: { targetBuffer: 800 },
    startingCash: { amount: 800, note: '' },
    income: [],
  });
  const tightAdvice = rec(tightPayload);
  ok(tightAdvice.mode === 'normal' && tightAdvice.weekly === 0
    && !(tightAdvice.funding && tightAdvice.funding.feasible === false),
    'cash equal to the buffer with no outflows is a feasible $0 cap',
    `${tightAdvice.mode} weekly=${tightAdvice.weekly}`);
  const tightPage = bootPage(null, tightPayload, FIXTURE_PERIODS);
  await settle();
  const t = capSurfaces(tightPage);
  const tTile = capTile(t.tiles);
  ok(tTile.val === '$0/wk',
    'a genuine feasible-zero cap still renders as $0/wk', tTile.val);
  ok(capAmt(t.headline) === '$0',
    'and the large headline is $0');
  ok(splitTotal(t.split).indexOf('$0') !== -1,
    'and the cap-split Total is $0/wk', splitTotal(t.split));
  ok(!/no feasible weekly cap/i.test(tTile.note + t.headline + t.basis + t.payday),
    'and is not described as an unfunded gap');

  console.log('=== reversal uncertainty: real renderer, stale clearing and override fence ===');
  for (const override of [null, 1800]) {
    const ready = reversalRendererFixture(false), unknown = reversalRendererFixture(true);
    const advice = F.recommend(unknown.plan, unknown.meta.asOf, { ...unknown.plan.defaults, ...unknown.liveOverlay,
      debts: unknown.debts, weeklyVariable: override, settlementEvidence: unknown.settlementEvidence });
    ok(advice.weekly === null && /remaining cost is uncertain/.test(advice.operatingPlanNote),
      'exact25/reversal10/sibling20 fixture publishes unknown weekly permission with its reason');
    ok(F.budgetBreakdown(unknown.plan, periods, { weeklyCap: advice.weekly }).cap === null,
      'unchanged budgetBreakdown publishes null cap rather than invented zero');
    const page = bootPage(override == null ? null : { weeklyVariable: override }, ready);
    await settle();
    const ids = ['cap-headline', 'cap-split', 'cap-basis', 'budget-out', 'budget-basis', 'budget-cats-note', 'hero-tiles'];
    const before = ids.map(id => ({ html: page.get(id).innerHTML, text: page.get(id).textContent }));
    const diagnosticIds = ['hero-tiles', 'cap-headline', 'phases', 'risk-list'];
    const diagnosticBefore = diagnosticIds.map(id => ({ html: page.get(id).innerHTML, text: page.get(id).textContent, writes: page.get(id).htmlWrites }));
    const categories = page.get('budget-cats').innerHTML;
    page.run("document.getElementById('road-ahead').hidden = true");
    ready.settlementEvidence = unknown.settlementEvidence;
    let error = null; try { page.run('App.rerender()'); } catch (e) { error = e; }
    ok(!error, 'ready to unknown rerender does not throw', error ? error.message : '');
    ok(diagnosticIds.every((id, i) => page.get(id).innerHTML === diagnosticBefore[i].html
      && page.get(id).textContent === diagnosticBefore[i].text && page.get(id).htmlWrites === diagnosticBefore[i].writes),
    'unknown rerender leaves every explicitly hidden diagnostic mount untouched');
    for (const id of ids.filter(id => !diagnosticIds.includes(id))) {
      ok((page.get(id).innerHTML + page.get(id).textContent).includes(advice.operatingPlanNote),
        id + ' refreshes active cap state while diagnostics are hidden');
    }
    page.run("document.getElementById('road-ahead').hidden = false; App.rerender()");
    const view = page.run('weeklyCapView({weekly:null, operatingPlanNote:"published uncertainty"}, state.weeklyVariable)');
    ok(view.hasFeasibleCap === false && view.weekly === null && view.reason === 'published uncertainty',
      'published unknown wins even with an explicit weekly override');
    for (const id of ids) {
      const output = page.get(id).innerHTML + page.get(id).textContent;
      ok(output.includes(advice.operatingPlanNote), id + ' replaces stale permission with the published reason');
      ok(!/protected funding shortfall|\$0\/wk|\$0\s*\/\s*week/.test(output), id + ' invents neither zero nor shortfall');
    }
    const essentialTile = /Essential variable need<\/div>\s*<div class="val">([^<]*)<\/div>\s*<div class="note">([\s\S]*?)<\/div>/.exec(page.get('hero-tiles').innerHTML);
    ok(ready.plan.budget.categories[0].plannedWeekly === 40, 'independently invented groceries stay positive');
    ok(essentialTile?.[1] === 'unavailable' && essentialTile[2].includes(advice.operatingPlanNote),
      'absent cap withholds essential and food/fuel hero publication rather than inventing zero');
    ok(page.get('budget-cats').innerHTML === categories, 'independently known category/history facts survive');
    ready.settlementEvidence = reversalRendererFixture(false).settlementEvidence;
    page.run('App.rerender()');
    ok(ids.every((id, i) => page.get(id).innerHTML === before[i].html && page.get(id).textContent === before[i].text),
      'unknown to ready restores the unchanged ready control');
  }
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
