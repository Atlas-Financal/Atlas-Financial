'use strict';
/* Focused proof for Forecast.unallocatedCash(). The correctness cases are
 * hand-computed from literal ending cash, buffer, monthly reserve and window
 * length, using the calendar month 365.25 / 12 — not the function that now
 * produces the answer.
 *
 * Until this move public/plan.js decided the ledger, where no test could
 * reach it. B73 recorded the mutation: halving the reserve-window conversion
 * left npm test green.
 */
const fs = require('fs');
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
const cents = n => Math.round(n * 100);
const same = (a, b) => cents(a) === cents(b);
const read = p => sourceText(fs.readFileSync(p, 'utf8'));
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/* A month is a Gregorian year of 365.25 days divided by twelve. Re-derived
 * here so this file can disagree with the engine. A 91-day window is then
 * 91 / (365.25 / 12) months of reserve — not a rounded 3.
 *
 *   ending cash          $5,000.00
 *   target buffer          $500.00
 *   reserve per month      $200.00
 *   window                    91 days
 *
 *   months  = 91 / (365.25 / 12) = 91 × 12 / 365.25
 *   reserves = $200 × months
 *   unallocated = $5,000 − $500 − reserves
 */
const DAYS_PER_MONTH = 365.25 / 12;
const ENDING = 5000;
const BUFFER = 500;
const RESERVE_MONTHLY = 200;
const WINDOW_DAYS = 91;
const HAND_MONTHS = WINDOW_DAYS / DAYS_PER_MONTH;
const HAND_RESERVES = RESERVE_MONTHLY * HAND_MONTHS;
const HAND_AMOUNT = ENDING - BUFFER - HAND_RESERVES;

const FIX = {
  sim: { ending: ENDING, buffer: BUFFER },
  budget: { reserveMonthly: RESERVE_MONTHLY },
  plan: { windowDays: WINDOW_DAYS },
};

console.log('=== hand-computed unallocated remainder ===');
const next = F.unallocatedCash(FIX.sim, FIX.budget, FIX.plan);
ok(HAND_MONTHS === WINDOW_DAYS * 12 / 365.25,
  'the month count is 91 × 12 / 365.25, from the calendar');
ok(!!next, 'a result is returned');
ok(next && same(next.ending, ENDING) && same(next.buffer, BUFFER),
  'ending cash and buffer pass through as given');
ok(next && same(next.reserves, HAND_RESERVES),
  'reserves over 91 days are $200 × 91 / (365.25 / 12)',
  next ? String(next.reserves) : 'none');
ok(next && same(next.amount, HAND_AMOUNT),
  'unallocated is $5,000 − $500 − those reserves',
  next ? String(next.amount) : 'none');
ok(next && next.id === 'leftover' && next.negative === false,
  'a leftover of thousands of dollars is free cash, not a shortfall');
ok(HAND_AMOUNT === ENDING - BUFFER - RESERVE_MONTHLY * WINDOW_DAYS * 12 / 365.25,
  'the expected remainder is the arithmetic identity');

console.log('\n=== no monthly reserve means no window conversion ===');
const none = F.unallocatedCash({ ending: 1000, buffer: 500 }, null, { windowDays: 91 });
ok(none && same(none.reserves, 0) && same(none.amount, 500) && none.id === 'leftover',
  'a missing budget accrues no reserve and leaves $500',
  none ? String(none.amount) : 'none');
ok(F.unallocatedCash({ ending: 1000, buffer: 500 }, { reserveMonthly: 0 }, { windowDays: 91 }).amount === 500,
  'a zero monthly reserve is the same as a missing budget');

console.log('\n=== zero boundary: wording cannot contradict the rounded figure ===');
/* money2 formats the absolute value to two decimals. The verdict has to be
 * the verdict of that printed cent, or the household reads leftover cash
 * next to $0.00 — or no free cash next to $0.01. */
const at = amount => F.unallocatedCash({ ending: amount, buffer: 0 }, { reserveMonthly: 0 }, { windowDays: 91 });

const fourTenths = at(0.004);
ok(money2(0.004) === '$0.00', 'four tenths of a cent prints $0.00');
ok(fourTenths.id === 'none' && fourTenths.negative === false && same(fourTenths.amount, 0.004),
  'and is not free cash — the old `> 0` would have said leftover beside $0.00');

const halfCent = at(0.005);
ok(money2(0.005) === '$0.01', 'half a cent prints $0.01');
ok(halfCent.id === 'leftover' && halfCent.negative === false,
  'and is leftover — EPSILON as `> 0.005` would have said none beside $0.01');

const exactZero = at(0);
ok(money2(0) === '$0.00' && exactZero.id === 'none' && exactZero.negative === false,
  'exactly $0.00 is no free cash, without a negative class');

const oneCent = at(0.01);
ok(money2(0.01) === '$0.01' && oneCent.id === 'leftover',
  'one published cent of leftover is free cash');

const tinyNeg = at(-0.004);
ok(money2(-0.004) === '−$0.00' && tinyNeg.id === 'none' && tinyNeg.negative === false,
  'a sub-cent shortfall prints −$0.00 and does not wear the negative class');

const oneCentShort = at(-0.01);
ok(money2(-0.01) === '−$0.01' && oneCentShort.id === 'none' && oneCentShort.negative === true,
  'one published cent short is no free cash and is negative');

const halfCentShort = at(-0.005);
ok(money2(-0.005) === '−$0.01' && halfCentShort.id === 'none' && halfCentShort.negative === true,
  'half a cent short prints −$0.01, matches the negative class, and is not leftover');

console.log('\n=== live plan: conversion independent of the engine function ===');
const plan = data.plan;
const asOf = data.meta.asOf;
const advice = F.recommend(plan, asOf, {
  scenario: 'expected', incomeOverrides: {}, disabled: [], extraDebtMonthly: 0,
  targetBuffer: plan.defaults.targetBuffer,
});
const budget = F.budgetBreakdown(plan, periods, {
  paypalPerMonth: data.paypal ? data.paypal.perMonth : 0,
  disabled: [],
  weeklyCap: advice.weekly,
  recommendedWeekly: advice.weekly,
});
ok(budget && budget.reserveMonthly === 0 && periods.source.categoryClaim === 'incomplete',
  'no named Tax history means no numeric reserve is invented; source uncertainty stays published',
  budget ? String(budget.reserveMonthly) : 'none');
const liveExpectedReserves = budget.reserveMonthly * (plan.windowDays / DAYS_PER_MONTH);
const liveExpectedAmount = advice.sim.ending - advice.sim.buffer - liveExpectedReserves;
const live = F.unallocatedCash(advice.sim, budget, plan);
ok(plan.windowDays === 91 && advice.sim.buffer === 500,
  'the published window is 91 days against a $500 buffer');
ok(live && same(live.reserves, liveExpectedReserves) && same(live.amount, liveExpectedAmount),
  'live unallocated is ending − buffer − the published reserve × window / (365.25 / 12)',
  live ? `${money2(live.amount)} (reserves ${money2(live.reserves)})` : 'none');
ok(live && ((live.amount > 0.005) === (live.id === 'leftover')),
  'a positive remainder is leftover; otherwise it is not');

console.log('\n=== page is a renderer ===');
const page = read('public/plan.js');
const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const { pageCodeMatching, pageScriptsMatching } = require('./lib/page-scripts');
// Positive "the classic page reads Forecast.X" assertions stay on plan.js and retire with it (C1 S7, docs/C1_TEST_DISPOSITIONS.md Q4);
// the "never" assertions read every page script, the Stack page included.
const never = (...res) => pageCodeMatching(...res);
ok(/Forecast\.unallocatedCash\(/.test(page),
  'the Plan page reads the remainder from Forecast.unallocatedCash');
ok(/UNALLOCATED_NOTE/.test(page),
  'the page looks the sentence up from a wording map');
ok(never(/windowDays\s*\/\s*\(\s*365\.25\s*\/\s*12\s*\)/).length === 0,
  'the page no longer converts the monthly reserve over the window (no page script, classic or Stack)', never(/windowDays\s*\/\s*\(\s*365\.25\s*\/\s*12\s*\)/).join(', ') || 'none');
ok(never(/sim\.ending\s*-\s*sim\.buffer\s*-\s*reserves/).length === 0,
  'the page no longer subtracts buffer and reserves from ending cash (no page script, classic or Stack)', never(/sim\.ending\s*-\s*sim\.buffer\s*-\s*reserves/).join(', ') || 'none');
ok(never(/unallocated\s*<=\s*0/, /unallocated\s*<\s*0/).length === 0,
  'the page no longer picks the verdict or the negative class from the remainder (no page script, classic or Stack)', never(/unallocated\s*<=\s*0/, /unallocated\s*<\s*0/).join(', ') || 'none');

console.log('\n=== mutation: halving the window conversion now fails ===');
const FORECAST_SRC = read('public/forecast.js');
const FROM = '    const monthsInWindow = windowDays / (365.25 / 12);';
const TO = '    const monthsInWindow = windowDays / (365.25 / 12) / 2;';
ok(FORECAST_SRC.split(FROM).length - 1 === 1,
  'the window conversion appears once in the engine, so the mutation is aimed');
const sandbox = { module: { exports: {} } };
try {
  vm.runInNewContext(FORECAST_SRC.replace(FROM, TO), sandbox, { filename: 'forecast-mutant.js' });
} catch (e) {
  ok(false, 'mutant engine loads', e.message);
}
const mutant = sandbox.module.exports;
const broken = mutant && mutant.unallocatedCash(FIX.sim, FIX.budget, FIX.plan);
const halvedReserves = HAND_RESERVES / 2;
ok(mutant && broken && same(broken.reserves, halvedReserves)
  && !same(broken.amount, HAND_AMOUNT)
  && same(broken.amount, ENDING - BUFFER - halvedReserves),
  'halving the conversion halves the reserve and inflates unallocated',
  broken ? String(broken.amount) : 'mutant missing');
ok(next && same(next.amount, HAND_AMOUNT),
  'the real engine still answers the hand-computed remainder on the same fixture');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
