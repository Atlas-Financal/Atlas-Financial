'use strict';
/* #821 audit finding 17, first slice: a malformed declared amount or
 * frequency on a bill, commitment, household target or the cash buffer
 * fails closed at the one place Forecast reads the plan for amounts
 * (scheduledAmountState). It publishes as unknown or unavailable. It is
 * never coerced to 0, never string-concatenated, and nothing is silently
 * dropped. A well-formed plan publishes exactly what it did before.
 *
 * Invented world, as-of Wed 2026-10-14. Biweekly pay 1,400 anchored Fri
 * 2026-10-09 (This Pay Period Oct 9 - Oct 22, Next Oct 23 - Nov 5), cash
 * 5,000, buffer 500, hydro 90 on the 20th, rent 900 on the 25th, and one
 * household target: groceries 100 a payday.
 *
 * Hand-worked expectations (from the inputs, not from Atlas):
 *   This Pay Period: bills 90 (hydro), after bills 1,400 - 90 = 1,310,
 *                    hold 100, Balance After Deductions 1,310 - 100 = 1,210.
 *   Next Pay Period: bills 900 (rent), after bills 1,400 - 900 = 500,
 *                    hold 100, Balance After Deductions 400.
 *   A declared target of 0 is a real zero: This Pay Period BAD 1,310.
 *
 * The figures read are the ones the Budget and Plan pages print:
 * Forecast.recommend().defaultView and its calendarPeriods.
 *
 *   node test/test-plan-input-fail-closed.js
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
};
const AS_OF = '2026-10-14';
const plan = mut => {
  const p = {
    defaults: { targetBuffer: 500 }, startingCash: { amount: 5000 },
    opening: { asOf: AS_OF, priorAsOf: '2026-10-09', representedEvents: [] },
    income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: '2026-10-09', amount: 1400, confidence: 'confirmed' }],
    bills: [
      { id: 'hydro', label: 'Invented hydro', frequency: 'monthly', day: 20, amount: 90, confidence: 'confirmed' },
      { id: 'rent', label: 'Invented rent', frequency: 'monthly', day: 25, amount: 900, confidence: 'confirmed' },
    ],
    obligations: [],
    commitments: [{ id: 'roof', label: 'Invented roof', date: '2026-12-01', amount: 2000, flexibility: 'fixed' }],
    budget: { categories: [
      { id: 'groceries', label: 'Invented groceries', plannedPayday: 100 },
      { id: 'health', label: 'Invented health', plannedMonthly: 40 },
    ] },
  };
  if (mut) mut(p);
  return p;
};
const read = (p, opts) => {
  const r = F.recommend(p, AS_OF, Object.assign({ debts: [] }, opts || {}));
  const v = r.defaultView;
  const by = id => v.calendarPeriods.find(x => x.id === id);
  return { r, v, cur: by('this-pay-period'), next: by('next-pay-period'),
    status: r.scheduledAmounts ? r.scheduledAmounts.status : 'ready',
    unknowns: r.scheduledAmounts ? r.scheduledAmounts.unknowns : [] };
};
const nullish = x => x === null || x === undefined;
// Any published field named buffer / requiredCashFloor that is not a real number
// (the only string it may be is a trust label such as 'calculated').
const TRUST_WORDS = new Set(['calculated', 'estimated', 'unknown', 'unavailable', 'verified']);
const textBuffers = result => {
  const found = [];
  const seen = new WeakSet();
  const walk = (node, at) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (/^(buffer|requiredCashFloor)$/.test(key) && value != null
        && !(typeof value === 'number' && Number.isFinite(value)) && !TRUST_WORDS.has(value)) {
        found.push(at + '.' + key);
      }
      walk(value, at + '.' + key);
    }
  };
  walk(result, 'result');
  return found;
};

console.log('\n=== 1. controls: a well-formed plan is known and unchanged ===');
{
  const g = read(plan());
  ok(g.status === 'ready' && g.unknowns.length === 0, 'no scheduled-amount unknown');
  ok(g.cur.afterBills === 1310 && g.cur.budgetHold === 100 && g.cur.balanceAfterDeductions === 1210,
    'This Pay Period: after bills 1,310, hold 100, Balance After Deductions 1,210');
  ok(g.next.afterBills === 500 && g.next.budgetHold === 100 && g.next.balanceAfterDeductions === 400,
    'Next Pay Period: after bills 500, hold 100, Balance After Deductions 400');
  ok(g.r.paydayAllocation && g.r.paydayAllocation.buffer === 500 && g.r.paydayAllocation.allocatedTotal != null,
    'the payday allocation reads the 500 buffer and allocates');
  ok(typeof g.next.opening === 'number' && typeof g.next.paydaySweep === 'number',
    'the next period publishes an opening and a sweep');
  const zeroTarget = read(plan(p => { p.budget.categories[0].plannedPayday = 0; }));
  ok(zeroTarget.status === 'ready' && zeroTarget.cur.budgetHold === 0 && zeroTarget.cur.balanceAfterDeductions === 1310,
    'a declared target of 0 is a real zero: hold 0, Balance After Deductions 1,310');
  const zeroBuffer = read(plan(p => { p.defaults.targetBuffer = 0; }));
  ok(zeroBuffer.status === 'ready', 'a declared buffer of 0 is a real zero, not unknown');
  const unset = read(plan(p => { delete p.defaults.targetBuffer; }));
  ok(unset.status === 'ready', 'an unset buffer is unchanged (not declared)');
  const noTarget = read(plan(p => { p.budget.categories[0].plannedPayday = null; }));
  ok(noTarget.status === 'ready', 'a null target is "not declared" and unchanged');
}

console.log('\n=== 2. the cash buffer: text, blank, true, an array, NaN or a negative is unknown ===');
for (const [label, value] of [['text "500"', '500'], ['text "tbd"', 'tbd'], ['blank ""', ''], ['blank " "', ' '],
  ['true', true], ['array [500]', [500]], ['NaN', NaN], ['negative -1', -1], ['Infinity', Infinity]]) {
  for (const where of ['plan default', 'caller override']) {
    const g = where === 'plan default'
      ? read(plan(p => { p.defaults.targetBuffer = value; }))
      : read(plan(), { targetBuffer: value });
    const named = g.unknowns.some(u => u.carrier === 'buffer');
    ok(g.status === 'unavailable' && named, `${label} (${where}): scheduled amounts unavailable, buffer named`);
    const a = g.r.paydayAllocation;
    ok(a.status === 'unavailable' && a.allocatedTotal === null && a.movable === null && nullish(a.buffer),
      `${label} (${where}): the payday allocation is withheld, not a figure built on the buffer`);
    ok(g.r.sim.ending === null && g.r.sim.shortfall === null && nullish(g.r.sim.buffer) && g.r.weekly === null,
      `${label} (${where}): the cash walk and the weekly cap are withheld`);
    ok(g.next.opening === null && g.next.paydaySweep === null,
      `${label} (${where}): the next period's opening and sweep are withheld with the rest (no half-state)`);
    ok(textBuffers(g.r).length === 0,
      `${label} (${where}): the buffer is not republished as a figure`, textBuffers(g.r).join(', '));
  }
}

console.log('\n=== 3. a household target: blank, "tbd", true, negative or NaN is unknown, never a $0 target ===');
for (const field of ['plannedPayday', 'plannedWeekly', 'plannedMonthly']) {
  for (const [label, value] of [['blank ""', ''], ['text "tbd"', 'tbd'], ['text "100"', '100'], ['true', true],
    ['negative -5', -5], ['NaN', NaN]]) {
    const g = read(plan(p => { p.budget.categories[0][field] = value; }));
    const named = g.unknowns.some(u => u.carrier === 'target' && u.id === 'groceries');
    ok(g.status === 'unavailable' && named, `${field} ${label}: scheduled amounts unavailable, groceries named`);
    ok(g.cur.budgetHold === null && g.cur.balanceAfterDeductions === null && g.cur.predictedEndingBalance === null
      && g.next.budgetHold === null && g.next.balanceAfterDeductions === null,
      `${field} ${label}: hold and Balance After Deductions are unknown in both periods (not 1,310 / 500)`);
    ok(g.v.balanceAfterDeductions === null && g.v.predictedEndingBalance === null,
      `${field} ${label}: the default view's Balance After Deductions is unknown`);
    ok(g.cur.balanceAfterDeductionsTrust === 'unavailable' && g.cur.budgetHoldTrust !== 'calculated',
      `${field} ${label}: the period is stamped unavailable`);
    const row = (g.cur.householdBudget || []).find(x => x.id === 'groceries');
    ok(row && row.withheldReason === 'target-invalid' && row.planned === null && row.hold === null && row.remaining === null,
      `${field} ${label}: the groceries row is listed with every amount unknown, not dropped and not $0`);
    ok(g.next.opening === null && g.next.paydaySweep === null,
      `${field} ${label}: the next period's opening and sweep, built on the unknown hold, are unknown`);
    ok(g.v.billsAccountPeriodBalance.household.target === null,
      `${field} ${label}: the Bills account's household target is unknown, not 0`);
  }
}
{
  const hist = read(plan(p => { p.budget.categories[0].targetHistory = [{ effectiveThrough: '2026-06-30', plannedPayday: 'tbd' }]; }));
  ok(hist.status === 'unavailable' && hist.unknowns.some(u => u.carrier === 'target'),
    'a malformed amount in a dated prior target is unknown too');
  const other = read(plan(p => { p.budget.categories[1].plannedMonthly = 'tbd'; }));
  ok(other.status === 'unavailable' && other.unknowns.some(u => u.carrier === 'target' && u.id === 'health')
    && other.cur.budgetHold === null && other.cur.balanceAfterDeductions === null,
    'a malformed target on a category the Budget does not print still makes the hold unknown (the total would be wrong)');
}

console.log('\n=== 4. a bill\'s frequency: a mistyped value never makes a required payment vanish ===');
for (const [label, value] of [['"Monthly"', 'Monthly'], ['"MONTHLY"', 'MONTHLY'], ['"monthly " (trailing space)', 'monthly '],
  ['"monthy"', 'monthy'], ['blank ""', ''], ['null', null], ['a number', 5], ['true', true]]) {
  const g = read(plan(p => { p.bills[1].frequency = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'bill' && u.id === 'rent'),
    `${label}: scheduled amounts unavailable, rent named (not dropped)`);
  ok(g.next.periodBillLoad === null && g.next.afterBills === null && g.next.balanceAfterDeductions === null
    && g.cur.balanceAfterDeductions === null,
    `${label}: the bill load and Balance After Deductions are unknown, not 0 or the other bill alone`);
}

console.log('\n=== 5. a bill or commitment amount: text, blank, true, an array, negative or zero is unknown ===');
for (const [label, value] of [['text "tbd"', 'tbd'], ['blank ""', ''], ['comma text "1,900"', '1,900'], ['true', true],
  ['array [900]', [900]], ['negative -5', -5], ['zero 0', 0], ['null', null]]) {
  const g = read(plan(p => { p.bills[1].amount = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'bill' && u.id === 'rent'),
    `bill amount ${label}: unavailable, rent named`);
  ok(g.next.periodBillLoad === null && g.next.afterBills === null && g.next.balanceAfterDeductions === null,
    `bill amount ${label}: the next period's bill load and Balance After Deductions are unknown, not 0`);
}
for (const [label, value] of [['text "tbd"', 'tbd'], ['blank ""', ''], ['true', true], ['negative -5', -5], ['zero 0', 0]]) {
  const g = read(plan(p => { p.commitments[0].amount = value; }));
  ok(g.status === 'unavailable' && g.unknowns.some(u => u.carrier === 'commitment' && u.id === 'roof'),
    `commitment amount ${label}: unavailable, roof named`);
}

console.log('\n=== 6. the committed plan reads as well-formed: nothing new is flagged ===');
{
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const committed = data.plan;
  const asOf = committed.opening && committed.opening.asOf;
  const state = F.scheduledAmountState(committed, asOf, '2027-12-31', { targetBuffer: committed.defaults.targetBuffer });
  ok(!state.unknowns.some(u => u.carrier === 'target' || u.carrier === 'buffer'),
    'no household target or buffer in the committed plan is flagged');
  ok(typeof committed.defaults.targetBuffer === 'number' && Number.isFinite(committed.defaults.targetBuffer)
    && committed.defaults.targetBuffer >= 0, 'the committed buffer is a finite number of zero or more');
  const types = new Set();
  for (const cat of committed.budget.categories) for (const row of [cat].concat(cat.targetHistory || [])) {
    for (const f of ['plannedWeekly', 'plannedPayday', 'plannedMonthly']) {
      if (row && row[f] != null) types.add(typeof row[f] === 'number' && Number.isFinite(row[f]) && row[f] >= 0);
    }
  }
  ok(types.size === 1 && types.has(true), 'every declared committed target is a finite number of zero or more');
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll plan-input fail-closed checks passed.');
