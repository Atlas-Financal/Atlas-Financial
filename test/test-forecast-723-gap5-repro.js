'use strict';
/* ATLAS-026 (#723) gap (5) failing-before reproducer.
 *
 * Test-only. Encodes the behaviour required by Atlas's Engine classification
 * on #723 (comment 6524178220, STILL BROKEN): once a pay period becomes a
 * sealed lookback, a scheduled receipt whose amount is unknown (missing,
 * null, NaN, non-numeric) must still be withheld with a specific reason. It
 * must never publish as a calculated zero, which is indistinguishable from a
 * genuine planned zero.
 *
 * Expected at main 860328fc: the "lookback unknown" cases FAIL (that is the
 * defect); every control case PASSES. The Engine repair (separate dispatch,
 * public/forecast.js only) should turn this file green without changing the
 * controls. Not registered in test/test.js; Engine registers on handoff.
 *
 * Synthetic fixtures only; amounts are unlike live household figures.
 *
 * Authored by Grok (#801, head 0efbd9c6). Carried into the Engine repair
 * by Claude Code under the dispatcher's load rebalance and registered in
 * test/test.js. Per Atlas's acceptance gaps (#801 comment 6524874146), the
 * withheld checks now require each dependent key to be present and null and
 * the reason to be the exact income-unavailable string.
 */
const F = require('../public/forecast.js');

let failures = 0;
let passes = 0;
const ok = (cond, label, detail = '') => {
  if (cond) passes++; else failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005);

const PERIOD = '2026-10-16';     // receipt period (Oct 16 - 29)
const ACTIVE_ASOF = '2026-10-20'; // receipt period is the active period
const LOOKBACK_ASOF = '2026-11-05'; // receipt period is a sealed lookback
const BILL = 120;
const POSITIVE = 500;
const PAY = 1000;
const REASON = 'A scheduled receipt in this period has an unknown amount (income-unavailable), so period income is not published.';

function plan(asOf, receiptAmount, payrollAmount = 0, omitAmount = false) {
  const receipt = { id: 'r1', label: 'Synthetic receipt', frequency: 'once',
    date: PERIOD, confidence: 'confirmed' };
  if (!omitAmount) receipt.amount = receiptAmount;
  return {
    windowDays: 120,
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: {
      asOf,
      paydaySnapshot: { periodStart: '2026-10-30', asOf: '2026-10-30', opening: 50 },
      representedEvents: [{ id: 'payroll', date: '2026-10-30' }],
    },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 50 }] },
    income: [
      { id: 'payroll', frequency: 'biweekly', anchor: '2026-10-02',
        amount: payrollAmount, confidence: 'confirmed' },
      receipt,
    ],
    bills: [{ id: 'b1', label: 'Synthetic bill', frequency: 'once',
      date: '2026-10-20', amount: BILL, confidence: 'confirmed' }],
    obligations: [], commitments: [], budget: { categories: [] },
  };
}

function views(asOf, amt, payroll, omit) {
  const a = F.recommend(plan(asOf, amt, payroll, omit), asOf, { weeklyVariable: 0, debts: [] });
  const find = list => (list || []).find(p => p && p.start === PERIOD);
  return { ppv: find(a.payPeriodViews), past: find(a.pastPeriodViews) };
}

function expectWithheld(view, label) {
  if (!view) { ok(false, `${label}: period view present`); return; }
  ok(view.incomeTotal === null, `${label}: incomeTotal withheld (null)`, `got ${view.incomeTotal}`);
  ok(view.incomeTrust === 'unavailable', `${label}: incomeTrust unavailable`, `got ${view.incomeTrust}`);
  ok(view.incomeUnavailableReason === REASON,
    `${label}: specific withhold reason published`, `got ${view.incomeUnavailableReason}`);
  for (const k of ['available', 'afterBills', 'balanceAfterDeductions', 'predictedEndingBalance']) {
    ok(Object.prototype.hasOwnProperty.call(view, k) && view[k] === null,
      `${label}: dependent ${k} withheld`, `got ${view[k]}`);
  }
}

// A sealed lookback period in this fixture has no observation of the receipt, so a
// known positive receipt is planned but unproven: its income, and what follows
// from it, read estimated. A genuine planned zero contributes nothing unproven and
// the active period keeps calculated. The amounts are the same.
function expectKnown(view, label, income, trust = 'calculated') {
  if (!view) { ok(false, `${label}: period view present`); return; }
  ok(eq(view.incomeTotal, income), `${label}: incomeTotal ${income}`, `got ${view.incomeTotal}`);
  ok(view.incomeTrust === trust, `${label}: incomeTrust ${trust}`, `got ${view.incomeTrust}`);
  ok(eq(view.afterBills, income - BILL), `${label}: afterBills ${income - BILL}`, `got ${view.afterBills}`);
  ok(eq(view.balanceAfterDeductions, income - BILL), `${label}: BAD ${income - BILL}`, `got ${view.balanceAfterDeductions}`);
}

const UNKNOWN = [
  ['missing amount', undefined, true],
  ['null amount', null, false],
  ['NaN amount', NaN, false],
  ['non-numeric amount', 'abc', false],
];

console.log('Controls: active period withholds unknown amounts (already correct at main)');
for (const [name, amt, omit] of UNKNOWN) {
  expectWithheld(views(ACTIVE_ASOF, amt, 0, omit).ppv, `active ${name}`);
}

console.log('Controls: known amounts stay distinct (active and lookback)');
for (const asOf of [ACTIVE_ASOF, LOOKBACK_ASOF]) {
  const role = asOf === ACTIVE_ASOF ? 'active' : 'lookback';
  const trust = role === 'lookback' ? 'estimated' : 'calculated';
  expectKnown(views(asOf, 0).ppv, `${role} genuine planned zero`, 0);
  expectKnown(views(asOf, POSITIVE).ppv, `${role} known positive`, POSITIVE, trust);
  if (role === 'lookback') {
    expectKnown(views(asOf, 0).past, `lookback pastPeriodViews genuine planned zero`, 0);
    expectKnown(views(asOf, POSITIVE).past, `lookback pastPeriodViews known positive`, POSITIVE, trust);
  }
}

console.log('Defect (expected FAIL at main 860328fc): sealed lookback publishes unknown as calculated zero');
for (const [name, amt, omit] of UNKNOWN) {
  const v = views(LOOKBACK_ASOF, amt, 0, omit);
  expectWithheld(v.ppv, `lookback payPeriodViews ${name}`);
  expectWithheld(v.past, `lookback pastPeriodViews ${name}`);
}

console.log('Defect (expected FAIL at main 860328fc): mixed known payroll + unknown receipt in lookback');
{
  const v = views(LOOKBACK_ASOF, null, PAY);
  expectWithheld(v.ppv, 'lookback mixed payPeriodViews');
  expectWithheld(v.past, 'lookback mixed pastPeriodViews');
  const ctrl = views(LOOKBACK_ASOF, 0, PAY).ppv;
  // The payroll is planned and never observed in this lookback fixture, so it reads estimated.
  expectKnown(ctrl, 'control: lookback known payroll + genuine zero receipt', PAY, 'estimated');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
