'use strict';

// The live Budget page prints the selected pay period in its COMPACT form:
// budgetSurfaceParts().periodHtml -> budgetPayPeriodContentHtml(compact)
// -> calendarWaterfallHtml(..., compactOverview = true). The full form
// (test-budget-stepped-layout.js) stays covered there because the live
// calendarWaterfallsHtml fallback still prints it. This suite proves the same
// rule on the compact face the household reads: each question summary prints
// a Forecast-published value, never a sum of its detail rows, and an
// untrusted or non-finite value prints Unknown / Unavailable, not a number.
//
// What the compact face prints (from calendarWaterfallHtml):
//   02 Income, 04 Bills, 06 Household budget: Forecast.budgetPeriodProgress
//     actual / planned pair (period.budgetProgress), not period totals;
//   05 Balance after bills: period.afterBills;
//   07 Balance After Deductions: for the current period the compact face
//     always takes the daily-savings branch (budgetDailySavingsFor returns a
//     packet, available or not), so it prints Forecast's published
//     period.afterHouseholdBudget ("before unsent savings top-ups").
// Reported combined savings needs a savings inventory publication and is
// covered by the savings suites, not here. Invented data throughout.
const assert = require('node:assert/strict');
const { loadBudgetPage } = require('./lib/budget-page-harness');

const page = loadBudgetPage();
const parts = page.get('budgetSurfaceParts')();
let checks = 0;
const ok = (value, why) => { assert.ok(value, why); checks++; };

const field = (amount, trust = 'calculated', completeness = 'complete') => ({ amount, trust, completeness });
// Every published value deliberately differs from the sum of its detail rows
// and from the full-form period total, so a page that added details up (or
// printed the wrong publication) prints a number this suite forbids.
function period(overrides = {}) {
  return Object.assign({
    id: 'current', start: '2026-09-25', end: '2026-10-08', rangeLabel: 'Sep 25 – Oct 8',
    timelineRole: 'current', role: 'active', projected: false, openingKnown: true, opening: 600,
    available: 1800, periodBillLoad: 300, budgetHold: 200,
    afterBills: 1450, afterHouseholdBudget: 1234, predictedEndingBalance: 1199,
    incomeTrust: 'calculated', periodBillLoadTrust: 'calculated', afterBillsTrust: 'calculated',
    budgetHoldTrust: 'calculated', balanceAfterDeductionsTrust: 'calculated',
    // Detail rows: income 999, bills 123, household planned 301 / spent 40.
    income: [{ id: 'payroll', incomeClass: 'dale', label: 'Salary', amount: 999, date: '2026-09-25', status: 'received' }],
    otherIncome: { amount: 0, items: [] },
    bills: [{ id: 'required', label: 'Required payment', amount: -123, movement: -123, date: '2026-10-08', status: 'still due' }],
    householdBudget: [{ id: 'groceries', label: 'Groceries', planned: 301, spent: 40, remaining: 261 }],
    budgetProgressAsOf: '2026-09-30',
    budgetProgress: {
      source: 'Forecast.budgetPeriodProgress', asOf: '2026-09-30', currency: 'CAD', start: '2026-09-25', end: '2026-10-08',
      income: { actual: field(1111), planned: field(1777) },
      bills: { actual: field(222), planned: field(333) },
      household: { actual: field(44), planned: field(211) },
    },
  }, overrides);
}
const plan = { defaults: { targetBuffer: 0 }, opening: { asOf: '2026-09-30' }, startingCash: { amount: 777 },
  income: [], bills: [], obligations: [], commitments: [], budget: { categories: [] } };
function render(row) {
  const ctx = { advice: { defaultView: { asOf: '2026-09-30' }, payPeriodViews: [row],
    paydayAllocation: { obligations: { shortfall: 0 }, essentials: { shortfall: 0 } } }, plan,
  asOf: '2026-09-30', weekly: 0, debts: [] };
  const before = JSON.stringify(ctx);
  const html = parts.periodHtml(ctx);
  assert.equal(JSON.stringify(ctx), before, 'rendering must not mutate the Forecast output');
  return html;
}
// The visible text of one question's closed summary row.
function summary(html, number) {
  const after = html.split(`data-operating-question="${number}"`)[1];
  assert.ok(after, 'question ' + number + ' is printed on the compact face');
  return after.split('</summary>')[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
const has = (text, amount) => text.includes('$' + amount.toLocaleString('en-CA', { minimumFractionDigits: 2 }));

const html = render(period());
ok(/data-calendar-waterfall="current"/.test(html), 'the live compact period face is printed');

// 1. Each summary prints its published value, never a detail sum or a full-form total.
const cases = [
  ['02', [1111, 1777], [999, 1800]],
  ['04', [222, 333], [123, 300]],
  ['05', [1450], [1500]],                 // 1800 - 300 would be 1500
  ['06', [44, 211], [301, 40, 200]],
  ['07', [1234], [1250, 1199]],           // 1450 - 200 would be 1250; 1199 is the other final field
];
for (const [number, printed, forbidden] of cases) {
  const text = summary(html, number);
  for (const amount of printed) ok(has(text, amount), `${number}: prints the published ${amount}`);
  for (const amount of forbidden) ok(!has(text, amount), `${number}: never prints ${amount} (a detail sum or another figure)`);
}

// 2. An estimated published value carries the ≈ estimated mark on the compact face.
const estimated = render(period({
  afterBillsTrust: 'estimated', balanceAfterDeductionsTrust: 'estimated',
  budgetProgress: Object.assign({}, period().budgetProgress, {
    income: { actual: field(1111, 'estimated'), planned: field(1777) } }),
}));
for (const number of ['02', '05', '07']) {
  ok(/≈/.test(summary(estimated, number)) && /estimated/.test(summary(estimated, number)),
    number + ': an estimated published value is marked ≈ estimated');
}
ok(!/≈/.test(summary(estimated, '04')), '04: a calculated value carries no ≈ mark');

// 3. An untrusted or non-finite published value prints Unknown / Unavailable, never a number.
for (const bad of [undefined, null, false, '', '1450', NaN, Infinity]) {
  const label = 'bad value ' + String(bad === '' ? "''" : bad);
  const row = period({ afterBills: bad, predictedEndingBalance: bad, afterHouseholdBudget: bad,
    budgetProgress: Object.assign({}, period().budgetProgress, {
      income: { actual: field(bad), planned: field(bad) } }) });
  const out = render(row);
  ok(/Unavailable/.test(summary(out, '05')) && !/\$/.test(summary(out, '05')), label + ': 05 prints Unavailable');
  ok(/Unavailable/.test(summary(out, '07')) && !/\$/.test(summary(out, '07')), label + ': 07 prints Unavailable');
  ok(/Unknown/.test(summary(out, '02')) && !/\$/.test(summary(out, '02')), label + ': 02 prints Unknown');
}
for (const trust of ['unknown', 'unavailable', 'verified-looking']) {
  const out = render(period({ afterBillsTrust: trust, balanceAfterDeductionsTrust: trust,
    budgetProgress: Object.assign({}, period().budgetProgress, {
      bills: { actual: field(222, trust), planned: field(333, trust) } }) }));
  ok(/Unavailable/.test(summary(out, '05')) && !has(summary(out, '05'), 1450), `trust ${trust}: 05 prints Unavailable`);
  ok(/Unavailable/.test(summary(out, '07')) && !has(summary(out, '07'), 1234), `trust ${trust}: 07 prints Unavailable`);
  ok(/Unknown/.test(summary(out, '04')) && !has(summary(out, '04'), 222), `trust ${trust}: 04 prints Unknown`);
}

console.log('PASS compact Budget face prints Forecast-published values, never detail sums; untrusted values print Unknown/Unavailable: ' + checks + ' checks');
