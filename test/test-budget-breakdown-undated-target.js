'use strict';
/* Monthly Budget (Forecast.budgetBreakdown): a declared Other payday target
 * with no usable start date is unknown, never applied as if always in
 * effect, never the historical average and never $0. A target amount that is
 * not a real number ('tbd') is unknown too. Counterpart of #962 C4 / #1210
 * for the pay-period path.
 *
 * Every input is invented. Expected values are worked by hand from the
 * calendar identity (a month is 365.25 / 12 days, a payday cycle 14 days),
 * not from the producing helpers:
 *   280 per payday  -> 280 * 30.4375 / 14 = 608.75 / month
 *   200 per payday  -> 200 * 30.4375 / 14 = 434.8214... -> 434.82 / month
 *   historical Other  300 over 2 months  -> 150 / month
 *   historical Groceries 600 over 2 months -> 300 / month
 * `node test/test-budget-breakdown-undated-target.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast.js');
const fx = require('./fixtures/other-period-target');

const AS_OF = '2026-10-04';
const periods = { periods: { ytd: { label: 'Invented window', months: 2, spending: [
  { label: 'Invented groceries', total: 600 }, { label: 'Invented other', total: 300 }] } } };
function plan(other, groceries) {
  return { windowDays: 91, opening: { asOf: AS_OF }, bills: [], commitments: [],
    budget: { categories: [
      Object.assign({ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 200,
        historyCategories: ['Invented groceries'] }, groceries || {}),
      Object.assign({ id: 'other-spend', label: 'Other spend', class: 'essential',
        historyCategories: ['Invented other'] }, other),
    ] } };
}
function breakdown(other, groceries) {
  const bd = F.budgetBreakdown(plan(other, groceries), periods, { asOf: AS_OF, weeklyCap: 500 });
  return { bd, other: bd.categories.find(c => c.id === 'other-spend'),
    groceries: bd.categories.find(c => c.id === 'groceries') };
}
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 0.005,
  `${msg}: ${actual} != ${expected}`);

// Control: a valid date in effect applies the payday target (unchanged).
{
  const { bd, other, groceries } = breakdown({ plannedPayday: 280, targetEffectiveFrom: '2026-09-25' });
  near(other.target, 608.75, 'valid dated Other target');
  near(other.gross, 608.75, 'valid gross');
  near(other.planned, 608.75, 'valid planned');
  assert.equal(other.source, 'owner-target');
  assert.equal(other.withheldReason, undefined);
  near(groceries.target, 434.82, 'groceries target');
  near(bd.essentialMonthly, 434.82 + 608.75, 'essential monthly');
  assert.ok(bd.cap, 'cap verdict published');
}
// Control: a valid date not yet in effect is not applied (unchanged).
{
  const { bd, other } = breakdown({ plannedPayday: 280, targetEffectiveFrom: '2026-12-01' });
  assert.equal(other.target, null);
  near(other.gross, 150, 'future-dated target falls back to the historical average');
  near(bd.essentialMonthly, 434.82 + 150, 'essential monthly');
}

// Undated: missing, null, '', not-a-date, impossible date -> Unknown.
const undated = [['missing', {}], ['null', { targetEffectiveFrom: null }],
  ['empty', { targetEffectiveFrom: '' }], ['not-a-date', { targetEffectiveFrom: 'not-a-date' }],
  ['2026-02-30', { targetEffectiveFrom: '2026-02-30' }]];
for (const [name, extra] of undated) {
  const { bd, other, groceries } = breakdown(Object.assign({ plannedPayday: 280 }, extra));
  assert.equal(other.withheldReason, 'target-undated', name);
  assert.equal(other.target, null, `${name}: never applied as if always in effect`);
  assert.equal(other.gross, null, `${name}: not the historical average, not $0`);
  assert.equal(other.planned, null, name);
  assert.equal(other.reserved, 0, name);
  assert.equal(other.fullyDated, false, name);
  assert.equal(other.source, 'owner-target', `${name}: the row is still a declared target`);
  near(other.historical, 150, `${name}: history stays published`);
  near(groceries.planned, 434.82, `${name}: other categories unchanged`);
  for (const key of ['essentialMonthly', 'requiredMonthly', 'cap'])
    assert.equal(bd[key], null, `${name}: ${key} withholds`);
  assert.equal(bd.discretionaryMonthly, 0, `${name}: totals Other does not feed stay known`);
}

// A non-numeric amount is Unknown, never 0, dated or not.
for (const [name, other, reason] of [
  ['tbd dated', { plannedPayday: 'tbd', targetEffectiveFrom: '2026-09-25' }, 'target-invalid'],
  ['tbd undated', { plannedPayday: 'tbd' }, 'target-undated']]) {
  const { bd, other: row } = breakdown(other);
  assert.equal(row.withheldReason, reason, name);
  assert.notEqual(row.target, 0, `${name}: never $0`);
  assert.equal(row.target, null, name);
  assert.equal(row.planned, null, name);
  assert.equal(bd.essentialMonthly, null, name);
}

// No plannedPayday: no payday target, unchanged from main.
{
  const { other, bd } = breakdown({});
  assert.equal(other.target, null);
  near(other.gross, 150, 'no target reads the historical average');
  assert.equal(other.withheldReason, undefined);
  near(bd.essentialMonthly, 434.82 + 150, 'essential monthly');
}
{
  const { other } = breakdown({ plannedMonthly: 150 });
  near(other.target, 150, 'an undated monthly-only Other target stays always in effect');
  assert.equal(other.withheldReason, undefined);
}
// Other categories keep their incumbent undated semantics.
{
  const { groceries } = breakdown({ plannedPayday: 280, targetEffectiveFrom: '2026-09-25' });
  near(groceries.target, 434.82, 'undated groceries payday target is always in effect');
  const bad = breakdown({ plannedPayday: 280, targetEffectiveFrom: '2026-09-25' },
    { targetEffectiveFrom: 'not-a-date' }).groceries;
  assert.equal(bad.target, null);
  near(bad.gross, 300, 'non-Other invalid date keeps its incumbent historical fallback');
  assert.equal(bad.withheldReason, undefined);
}

// Consumers: the payday allocation withholds rather than dropping Other.
{
  const f = fx.build();
  const p = { periods: { ytd: { label: 'Invented', months: 1, spending: [] } }, asOf: f.date };
  const opts = { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet, periods: p };
  const ok = F.paydayAllocation(f.plan, f.date, opts);
  assert.notEqual(ok.status, 'unavailable', 'dated control allocation is available');
  assert.ok(ok.essentials.items.some(r => r.id === 'other-spend'));
  for (const [name, mutate] of [['missing', c => { delete c.targetEffectiveFrom; }],
    ['not-a-date', c => { c.targetEffectiveFrom = 'not-a-date'; }]]) {
    const g = fx.build();
    mutate(g.plan.budget.categories.at(-1));
    const a = F.paydayAllocation(g.plan, g.date,
      { ...g.plan.defaults, debts: [], currentPeriodActuals: g.packet, periods: p });
    assert.equal(a.status, 'unavailable', `${name}: allocation withholds`);
    assert.equal(a.budgetTargets && a.budgetTargets.withheldReason, 'target-undated', name);
    assert.equal(a.essentials.wanted, null, `${name}: essential need is unknown, not the rest without Other`);
    assert.equal(a.available, null, name);
    assert.doesNotThrow(() => F.currentPeriodAction(g.plan, g.date,
      { ...g.plan.defaults, debts: [], currentPeriodActuals: g.packet, periods: p }), name);
  }
}
// No spending history: the essential items do not depend on where Other
// sits in the list. With Other first and undated, every other essential
// category still publishes its item; only the total is unknown.
{
  const opts = g => ({ ...g.plan.defaults, debts: [], currentPeriodActuals: g.packet });
  const otherFirst = g => {
    const cats = g.plan.budget.categories, i = cats.findIndex(c => c.id === 'other-spend');
    cats.unshift(...cats.splice(i, 1));
    return g;
  };
  const control = otherFirst(fx.build());
  const known = F.paydayAllocation(control.plan, control.date, opts(control)).essentials.items
    .map(r => r.id).filter(id => id !== 'other-spend').sort();
  assert.ok(known.length >= 2, 'control has other essential items');
  const g = otherFirst(fx.build());
  delete g.plan.budget.categories[0].targetEffectiveFrom;
  const a = F.paydayAllocation(g.plan, g.date, opts(g));
  assert.equal(a.status, 'unavailable', 'no-history: allocation withholds');
  assert.equal(a.essentials.wanted, null, 'no-history: total unknown');
  assert.deepEqual(a.essentials.items.map(r => r.id).sort(), known,
    'no-history: every other essential item survives, whatever the order');
}
console.log('budget breakdown undated Other target: ok');
