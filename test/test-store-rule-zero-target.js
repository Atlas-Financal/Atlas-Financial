'use strict';
/* BACKLOG (#902 follow-up): "an uncategorised store-rule row at a zero target is not counted". Verified stale on
 * main: a household-cash debit Lunch Money left uncategorised, that an owner store rule (merchant rule) puts in a
 * Household category, counts once as spending even when that category's target is zero, and Balance After
 * Deductions falls by its amount. This pins it.
 *
 * Path: invented raw Lunch Money payload -> scripts/live-plan.js (acceptance harness) -> Forecast.recommend's
 * current pay period (Oct 9-22).
 *
 * Invented world (test/acceptance/harness.js base world): pay 1400 on Oct 9; Restaurants 100 per pay period;
 * Groceries per case below. By hand, Balance After Deductions = 1400 - (each category's hold) with no bills, and a
 * category's hold is its target, or what was spent in it when that is more:
 *   - Groceries target 0, nothing spent:          1400 - 0 - 100  = 1300
 *   - Groceries target 0, an uncategorised 50 at a store-rule grocer (Walmart): hold 50 -> 1400 - 50 - 100 = 1250
 *   - the same for Fuel at a store-rule fuel station (Pitt Meadows CE), Groceries at 300: 1400 - 300 - 50 - 100 = 950
 *   - no Groceries row at all: the 50 is Other spending, hold 50 -> 1250
 *   - control, Groceries target 300: the 50 is inside the target -> 1400 - 300 - 100 = 1000 either way
 * Every target shape that reads zero (plannedPayday 0, plannedWeekly 0, monthly 0, no target) gives the same.
 * Lost coverage withholds the figure (unknown) rather than dropping the row.
 *
 * `node test/test-store-rule-zero-target.js`
 */
const F = require('../public/forecast.js');
const H = require('./acceptance/harness.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

function period({ payee = 'WALMART', groceries, fuel, amount = 50, coverage } = {}) {
  const w = H.baseWorld();
  w.budget = w.budget.filter(c => c.id !== 'groceries')
    .concat(groceries ? [{ id: 'groceries', label: 'Groceries', class: 'essential', confidence: 'confirmed', from: ['Groceries'], ...groceries }] : [])
    .concat(fuel ? [{ id: 'fuel', label: 'Fuel', class: 'essential', confidence: 'confirmed', from: ['Gas'], ...fuel }] : []);
  if (coverage) w.coverage = coverage;
  w.transactions = amount ? [H.lm({ date: '2026-10-12', amount, category: null, account: 'chequing-a', payee })] : [];
  const r = H.observe(w);
  if (r.error) throw r.error;
  const rec = F.recommend(r.plan, w.asOf, { currentPeriodActuals: r.packet });
  const p = rec.defaultView.calendarPeriods.find(x => x.start <= w.asOf && x.end >= w.asOf);
  const tx = (r.packet.transactions || []).find(t => Number(t.amount) === amount);
  return { p, cls: tx && F.classifyCurrentPeriodTransaction(tx, r.plan, { currentPeriodActuals: r.packet }) };
}

console.log('1. An uncategorised store-rule row at a zero target counts once');
for (const [shape, target] of [['plannedPayday 0', { plannedPayday: 0 }], ['plannedWeekly 0', { plannedWeekly: 0 }],
  ['monthly 0', { monthly: 0 }], ['no target field', {}]]) {
  const none = period({ groceries: target, amount: 0 }), spent = period({ groceries: target });
  ok(none.p.balanceAfterDeductions === 1300 && spent.p.balanceAfterDeductions === 1250,
    `Groceries ${shape}: an uncategorised 50 at Walmart lowers BAD 1300 -> 1250`, `${none.p.balanceAfterDeductions} -> ${spent.p.balanceAfterDeductions}`);
  ok(spent.cls && spent.cls.kind === 'spend' && spent.cls.householdSpending === true && spent.cls.categoryId === 'groceries',
    `Groceries ${shape}: the store rule names Groceries and the row is household spending`, JSON.stringify(spent.cls));
}
{
  const spent = period({ payee: 'PITT MEADOWS CE 123', groceries: { plannedPayday: 300 }, fuel: { plannedPayday: 0 } });
  ok(spent.p.balanceAfterDeductions === 950 && spent.cls && spent.cls.categoryId === 'fuel',
    'Fuel at a zero target: an uncategorised 50 at the store-rule fuel station counts (950)', `${spent.p.balanceAfterDeductions} ${spent.cls && spent.cls.categoryId}`);
}

console.log('2. With no category row, the store-rule row is Other spending, counted');
{
  const none = period({ amount: 0 }), spent = period();
  const other = (spent.p.householdBudget || []).find(h => h && h.otherSpending);
  ok(none.p.balanceAfterDeductions === 1300 && spent.p.balanceAfterDeductions === 1250 && other && other.spent === 50,
    'no Groceries row: BAD 1300 -> 1250, Other spending holds the 50', `${none.p.balanceAfterDeductions} -> ${spent.p.balanceAfterDeductions} other ${other && other.spent}`);
}

console.log('3. Controls');
{
  const inside = period({ groceries: { plannedPayday: 300 } }), empty = period({ groceries: { plannedPayday: 300 }, amount: 0 });
  ok(inside.p.balanceAfterDeductions === 1000 && empty.p.balanceAfterDeductions === 1000,
    'Groceries target 300: a 50 inside the target leaves BAD at 1000', `${empty.p.balanceAfterDeductions} / ${inside.p.balanceAfterDeductions}`);
  const lost = period({ groceries: { plannedPayday: 0 }, coverage: { complete: false, hasMore: true } });
  ok(lost.p.balanceAfterDeductions == null && lost.p.balanceAfterDeductionsTrust === 'unavailable',
    'lost coverage withholds BAD (unknown), never a figure with the row dropped', `${lost.p.balanceAfterDeductions} ${lost.p.balanceAfterDeductionsTrust}`);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll store-rule zero-target checks passed.');
