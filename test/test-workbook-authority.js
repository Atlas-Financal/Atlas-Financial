'use strict';
/* Workbook evidence cannot silently become current owner policy.
 * `node test/test-workbook-authority.js`
 *
 * The 2026-08-31 owner-locked period table wins. A historical per-paycheque
 * workbook or a My Recommendation section does not replace them without an
 * explicit targetSource transition away from owner-stated-2026-08-31.
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const data = require('./fixtures/retired-fuel-policy')(
  require('./fixtures/retired-other-policy')(require('../data.json')));
const periods = require('../public/periods.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

const OWNER_SOURCE = 'owner-stated-2026-08-31';
const GROCERY_SOURCE = 'owner-stated-2026-09-22';
const OWNER_PAYDAY_TARGETS = {
  fuel: 325,
  restaurants: 200,
  'dale-guilt-free': 150,
  'amanda-guilt-free': 150,
};
const GROCERY_PAYDAY = 900;
const DOG_FOOD_PAYDAY = 100;
const RETIRED_HOLD_IDS = ['health', 'sport', 'shopping', 'subscriptions'];

// Approximate monthly equivalents from HOME BUDGET.xlsx per-paycheque lines.
// These are historical planning figures. They must not become plannedMonthly
// while targetSource is still the Aug. 10 owner statement.
const HISTORICAL_WORKBOOK_MONTHLY = {
  groceries: 1200,
  fuel: 400,
};

const cats = data.plan.budget.categories;
const byId = id => cats.find(c => c.id === id);
const questions = fs.readFileSync(path.join(__dirname, '..', 'docs', '01_OPEN_QUESTIONS.md'), 'utf8');
const note = data.plan.budget.ownerTargets.note;

console.log('=== 2026-08-31 owner period table is the live policy ===');
for (const [id, amount] of Object.entries(OWNER_PAYDAY_TARGETS)) {
  const c = byId(id);
  ok(!!c, `category ${id} exists`);
  ok(c && c.plannedPayday === amount && c.plannedMonthly == null,
    `${id} plannedPayday stays $${amount}, not a plannedMonthly half-month encoding`,
    c ? `${c.plannedPayday} / ${c.plannedMonthly}` : 'missing');
  ok(c && c.targetSource === OWNER_SOURCE,
    `${id} targetSource remains ${OWNER_SOURCE}`,
    c ? String(c.targetSource) : 'missing');
}
{
  const g = byId('groceries');
  ok(g && g.plannedPayday === GROCERY_PAYDAY && g.plannedMonthly == null
      && g.plannedWeekly == null,
    'groceries owner target is plannedPayday 900 with no stored monthly, not weekly 450',
    g ? `${g.plannedPayday} / ${g.plannedMonthly} / ${g.plannedWeekly}` : 'missing');
  ok(g && g.targetSource === GROCERY_SOURCE,
    'groceries targetSource is owner-stated-2026-09-22');
  ok(g && /2026-09-22/.test(g.why || '') && /retired/.test(g.why || '')
      && !/is \$900 per calendar month/.test(g.why || ''),
    'groceries why records the 2026-09-22 payday reserve and retires the calendar-month pair');
}
{
  const p = byId('pets');
  ok(p && p.plannedPayday === DOG_FOOD_PAYDAY && p.plannedMonthly == null,
    'dog food owner target is plannedPayday 100, not plannedMonthly 55',
    p ? `${p.plannedPayday} / ${p.plannedMonthly}` : 'missing');
  ok(p && p.paydayCadence === 'every-other-seaspan',
    'dog food paydayCadence is every-other-seaspan',
    p ? String(p.paydayCadence) : 'missing');
  ok(p && p.paydayCadenceAnchor === '2026-08-28',
    'dog food paydayCadenceAnchor is the Aug 28 ON Seaspan start',
    p ? String(p.paydayCadenceAnchor) : 'missing');
  ok(p && p.targetSource === OWNER_SOURCE,
    'pets targetSource remains owner-stated-2026-08-31');
  ok(p && /every-other-Seaspan/i.test(p.why || '') && /2026-09-11/.test(p.why || ''),
    'pets why records the standing every-other-Seaspan restatement on 2026-09-11/12',
    p ? String(p.why) : 'missing');
  ok(p && !/cadence restated by owner 2026-09-05/.test(p.why || ''),
    'pets why does not invent a UTC-date restatement');
}
for (const id of RETIRED_HOLD_IDS) {
  const c = byId(id);
  ok(!!c, `retired mapping category ${id} still exists`);
  ok(c && c.plannedMonthly == null, `${id} has no household-budget plannedMonthly`,
    c ? String(c.plannedMonthly) : 'missing');
  ok(c && c.plannedPayday == null && c.plannedWeekly == null,
    `${id} has no plannedPayday or plannedWeekly hold`,
    c ? `${c.plannedPayday}/${c.plannedWeekly}` : 'missing');
}
{
  const h = byId('household');
  ok(h && h.plannedMonthly === 0 && h.plannedPayday == null && h.plannedWeekly == null,
    'household explicit planning baseline is $0 monthly, not a payday hold',
    h ? `${h.plannedMonthly}/${h.plannedPayday}/${h.plannedWeekly}` : 'missing');
  ok(h && h.ownerLine === 'Household' && h.targetSource === 'owner-stated-2026-09-04',
    'household $0 baseline names the 2026-09-04 owner instruction',
    h ? `${h.ownerLine}/${h.targetSource}` : 'missing');
  ok(h && Array.isArray(h.historyCategories) && h.historyCategories.indexOf('Household') >= 0,
    'household still maps the Household classification label');
  ok(h && /plannedMonthly 0/.test(h.why || '')
      && /2026-09-04/.test(h.why || '')
      && /2026-08-31/.test(h.why || ''),
    'household why records the 2026-09-04 zero baseline and preserves 2026-08-31 provenance');
  ok(h && !/2026-09-05/.test(h.why || ''),
    'household why does not advance that removal to the UTC date 2026-09-05');
}
{
  const o = byId('other-spend');
  ok(o && o.plannedMonthly === 800 && o.plannedPayday == null && o.plannedWeekly == null,
    'other-spend owner target is plannedMonthly 800, not a payday or weekly cadence',
    o ? `${o.plannedMonthly}/${o.plannedPayday}/${o.plannedWeekly}` : 'missing');
  ok(o && o.ownerLine === 'Other spend' && o.targetSource === 'owner-stated-2026-09-18',
    'other-spend names the 2026-09-18 owner instruction',
    o ? `${o.ownerLine}/${o.targetSource}` : 'missing');
  ok(o && o.label === 'Other spend',
    'other-spend is the Other spend–labeled planning home, not uncategorised');
  ok(byId('uncategorised') && byId('uncategorised').plannedMonthly == null,
    'uncategorised stays the unmatched-merchant remainder, not the $800 planning home');
}

console.log('\n=== historical / advisory workbook values cannot overwrite that policy ===');
ok(byId('groceries').plannedPayday === GROCERY_PAYDAY
  && byId('groceries').plannedMonthly == null
  && byId('groceries').plannedMonthly !== HISTORICAL_WORKBOOK_MONTHLY.groceries,
  'groceries is $900/payday with no stored monthly, not the historical workbook ~$1,200/month');
ok(byId('fuel').plannedPayday === OWNER_PAYDAY_TARGETS.fuel
  && byId('fuel').plannedMonthly !== HISTORICAL_WORKBOOK_MONTHLY.fuel,
  'fuel is $325/payday, not the historical workbook ~$400/month');
for (const c of cats) {
  if (c.plannedMonthly == null) continue;
  const src = String(c.targetSource || '');
  ok(!/workbook|recommendation|monthly_budget_tracker|home budget/i.test(src),
    `${c.id} is not sourced from a workbook or recommendation`, src || '(none)');
}
ok(!/My Recommendation/.test(JSON.stringify(cats.map(c => c.targetSource))),
  'no category names My Recommendation as its authority');

console.log('\n=== Q0 / live notes no longer claim the workbooks are missing ===');
ok(/### Q0\.[^\n]*\n\*\*Status:\*\*\s*ANSWERED/.test(questions),
  'canonical Q0 is ANSWERED');
ok(!/### Q0\.[\s\S]*?\*\*Status:\*\*\s*OPEN/.test(questions),
  'canonical Q0 is not still OPEN');
ok(!/still absent|never supplied|never reached this repository|still not absorbed/i.test(note),
  'ownerTargets.note does not claim the workbooks are missing');
ok(/classified/.test(note) && /HOUSEHOLD_BUDGET_WORKBOOKS_2026-08-16/.test(note),
  'ownerTargets.note points at the classification record');
ok(/Household currently has no planned Household Budget payday hold/.test(note)
    && /explicit \$0 monthly planning baseline/.test(note)
    && /2026-09-04/.test(note)
    && /\$1,825\.00/.test(note)
    && /\$1,725\.00/.test(note)
    && /2026-09-22/.test(note),
  'ownerTargets.note retires the Household $37.50 hold and records the remaining cycle totals');
ok(/Other spend \$800\/month/.test(note)
    && /plannedMonthly 800/.test(note)
    && /other-spend/.test(note)
    && /2026-09-18/.test(note)
    && /not a payday hold/.test(note),
  'ownerTargets.note includes the Other spend $800/month monthly lock');
ok(!/Household \$37\.50;/.test(note) && !/2026-09-05/.test(note),
  'ownerTargets.note does not keep Household $37.50 as a current target or use the UTC date');

console.log('\n=== Forecast still reads the 2026-08-31 owner targets ===');
const budget = F.budgetBreakdown(data.plan, periods, { paypalPerMonth: data.paypal.perMonth });
const groceries = budget.categories.find(c => c.id === 'groceries');
const fuel = budget.categories.find(c => c.id === 'fuel');
const groceryMonthly = Math.round(GROCERY_PAYDAY * (365.25 / 12) / 14 * 100) / 100;
const fuelMonthly = Math.round(325 * (365.25 / 12) / 14 * 100) / 100;
const pets = budget.categories.find(c => c.id === 'pets');
const petsSmeared = Math.round(100 * (365.25 / 12) / 14 * 100) / 100;
ok(groceries && Math.abs(groceries.target - groceryMonthly) < 0.01
  && fuel && Math.abs(fuel.target - fuelMonthly) < 0.01 && fuel.target !== 650,
  'engine grocery target annualizes payday $900; fuel is payday 325 annualized');
ok(pets && Math.abs(pets.target - 100) < 0.01 && Math.abs(pets.target - petsSmeared) > 1,
  'engine dog-food target is $100/month, not $100 annualized over 26 Seaspan cycles',
  pets ? String(pets.target) : 'missing');
ok(Math.abs((groceries.planned + fuel.planned) - (groceryMonthly + fuelMonthly)) < 0.01,
  'food+fuel requirement is payday-annualized groceries plus payday-annualized fuel');
ok(Math.abs(325 * (365.25 / 14) - 12 * (325 * (365.25 / 12) / 14)) < 1e-9,
  'independent: fuel payday cycles and 12 calendar months are the same annual amount');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
