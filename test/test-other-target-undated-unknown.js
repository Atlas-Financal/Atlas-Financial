'use strict';
/* #962 C4: an Other payday target (plannedPayday on the other-spend category)
 * declared without a usable targetEffectiveFrom is Unknown, never silently
 * dropped as if no target existed.
 *
 * Invented world only (test/fixtures/other-period-target.js): six named
 * payday targets 220 + 85 + 60 + 35 + 45 + 30 = 475, an Other target of 450
 * effective 2026-09-25, one invented 137.26 Other observation in This Pay
 * Period (Sep 25 - Oct 8), as of 2026-10-04.
 *
 * Hand-worked expectations, from the inputs, not from Forecast:
 *   (a) valid date:  plan 475 + 450 = 925; hold 475 + max(450, 137.26) = 925.
 *   (b) undated:     the Other plan and every total that would include it
 *                    are unknown (null). Never 475 (the plan without it) and
 *                    never 475 + 137.26 = 612.26 (the hold without it).
 *   (c) no plannedPayday and no date ("no target"): plan 475; Other row
 *       planned null, hold 137.26 (actual only); hold 475 + 137.26 = 612.26.
 *
 *   node test/test-other-target-undated-unknown.js
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const fx = require('./fixtures/other-period-target');

let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (c, label) => { assert.ok(c, label); checks++; };

function world(mutate) {
  const f = fx.build(137.26);
  const cat = f.plan.budget.categories.find(row => row.id === 'other-spend');
  if (mutate) mutate(cat);
  const opts = { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet };
  const advice = F.recommend(f.plan, f.date, opts);
  const view = role => advice.payPeriodViews.find(p => p.timelineRole === role);
  return { f, advice, current: view('current'), next: view('next') };
}
const otherRow = p => p.householdBudget.find(row => row.id === 'other-spending');
const reserveRow = p => p.householdBudget.find(row => row.id === 'other-spend');

// (a) control: a valid date applies the target; totals include it.
{
  const { advice, current, next } = world();
  ok(!advice.scheduledAmounts || advice.scheduledAmounts.status !== 'unavailable', 'valid: scheduled amounts ready');
  eq(otherRow(current).planned, 450, 'valid: Other plan 450');
  eq(otherRow(current).hold, 450, 'valid: Other hold max(450, 137.26) = 450');
  eq(otherRow(current).withheldReason, undefined, 'valid: Other row not withheld');
  eq(current.budgetHold, 925, 'valid: hold 475 + 450');
  eq(current.budgetProgress.household.planned.amount, 925, 'valid: household plan 475 + 450');
  eq(next.budgetHold, 925, 'valid: next hold 475 + 450');
  eq(advice.paydayAllocation.status === 'unavailable', false, 'valid: payday allocation published');
}

// (b) target present, date unusable: Unknown, never the omitted number.
for (const [label, set] of [
  ['missing', cat => { delete cat.targetEffectiveFrom; }],
  ['null', cat => { cat.targetEffectiveFrom = null; }],
  ['blank', cat => { cat.targetEffectiveFrom = ''; }],
  ['not-a-date', cat => { cat.targetEffectiveFrom = 'not-a-date'; }],
  ['impossible 2026-02-30', cat => { cat.targetEffectiveFrom = '2026-02-30'; }],
]) {
  const { advice, current, next } = world(set);
  const s = advice.scheduledAmounts;
  ok(s && s.status === 'unavailable', `${label}: scheduled amounts unavailable`);
  ok(s.unknowns.some(u => u.carrier === 'target' && u.id === 'other-spend' && u.reason === 'plan-target-undated'),
    `${label}: the Other target is named as undated`);
  ok(/no valid effective date/.test(s.reason), `${label}: the reason names the missing date`);
  for (const [role, p] of [['current', current], ['next', next]]) {
    const row = otherRow(p);
    ok(row, `${label} ${role}: the Other row is listed, not dropped`);
    eq([row.planned, row.plannedPayday, row.hold, row.remaining, row.overspend], [null, null, null, null, null],
      `${label} ${role}: the Other plan, hold, remaining and overspend are unknown`);
    eq(row.withheldReason, 'target-undated', `${label} ${role}: withheld as target-undated`);
    eq(row.targetEffectiveFrom, null, `${label} ${role}: no effective date is invented`);
    eq(reserveRow(p), undefined, `${label} ${role}: no retired reserve stands in for the target`);
    eq(p.budgetHold, null, `${label} ${role}: the household hold is unknown (not 475 or 612.26)`);
    eq(p.balanceAfterDeductions, null, `${label} ${role}: Balance After Deductions is unknown`);
    eq(p.balanceAfterDeductionsTrust, 'unavailable', `${label} ${role}: stamped unavailable`);
    eq(p.budgetProgress.household.planned.amount, null, `${label} ${role}: the household plan is unknown (not 475)`);
  }
  eq(otherRow(current).spent, 137.26, `${label}: the observed Other actual stays published`);
  eq(advice.paydayAllocation.status, 'unavailable', `${label}: the payday allocation is withheld`);
  eq(advice.paydayAllocation.allocatedTotal, null, `${label}: no allocated total`);
}

// (c) no target at all: unchanged "no target" behaviour.
{
  const { advice, current, next } = world(cat => { delete cat.plannedPayday; delete cat.targetEffectiveFrom; });
  ok(!advice.scheduledAmounts || advice.scheduledAmounts.status !== 'unavailable', 'no target: scheduled amounts ready');
  const row = otherRow(current);
  eq([row.planned, row.hold, row.withheldReason], [null, 137.26, undefined], 'no target: Other is actual only');
  eq(current.budgetHold, 612.26, 'no target: hold 475 + 137.26');
  eq(current.budgetProgress.household.planned.amount, 475, 'no target: household plan 475');
  eq(next.budgetHold, 475, 'no target: next hold 475');
  eq(otherRow(next), undefined, 'no target: no Other row next period');
  const nullPayday = world(cat => { cat.plannedPayday = null; cat.targetEffectiveFrom = 'not-a-date'; });
  eq(nullPayday.current.budgetHold, 612.26, 'null plannedPayday with a bad date is still "no target"');
}

// Codex review on 210d930: withholding the target keeps the observed actual's
// possible-duplicate caution. A pending look-alike of the Other spend keeps
// the household actual estimated (never calculated) on the undated path,
// as it is on the dated path.
for (const undated of [false, true]) {
  const f = fx.build(137.26, undefined, { pendingOther: 137.26 });
  for (const t of f.packet.transactions) if (t.pending === true) t.pendingPostedDuplicate = true;
  const cat = f.plan.budget.categories.find(row => row.id === 'other-spend');
  if (undated) delete cat.targetEffectiveFrom;
  const advice = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
  const current = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  const row = otherRow(current);
  const label = undated ? 'undated' : 'dated';
  eq(row.trust, 'estimated', `${label}: possible-duplicate Other row stays estimated`);
  eq(row.estimateReason, 'possible-duplicate', `${label}: possible-duplicate reason kept`);
  eq(current.budgetProgress.household.actual.trust, 'estimated', `${label}: household actual stays estimated`);
}

// Both surfaces read the same undated Other target the same way (Grok's
// condition for C4 with #1243): the pay-period view and the monthly Budget
// (budgetBreakdown) both withhold it as target-undated, never a number. With a
// valid date, both apply it.
for (const [label, mutate] of [['missing', c => { delete c.targetEffectiveFrom; }],
  ['not-a-date', c => { c.targetEffectiveFrom = 'not-a-date'; }], ['dated', null]]) {
  const { f, current } = world(mutate);
  const periodRow = otherRow(current);
  const monthly = F.budgetBreakdown(f.plan, { periods: { ytd: { label: 'Invented', months: 1, spending: [] } } },
    { asOf: f.date }).categories.find(c => c.id === 'other-spend');
  if (label === 'dated') {
    ok(periodRow.withheldReason == null && periodRow.planned != null, 'dated: pay-period view applies the Other target');
    ok(monthly.withheldReason == null && monthly.target != null, 'dated: monthly Budget applies the Other target');
  } else {
    eq([periodRow.withheldReason, periodRow.planned], ['target-undated', null], `${label}: pay-period Other row is Unknown`);
    eq([monthly.withheldReason, monthly.target, monthly.planned], ['target-undated', null, null],
      `${label}: monthly Budget Other row is Unknown`);
  }
}

// (d) Mixed reasons: an undated Other target alongside a non-numeric target
// on another category. Both causes are listed; the published reason is the
// general one, never the undated-only or invalid-only message, which would
// each name only half the cause.
{
  const f = fx.build(137.26);
  const cats = f.plan.budget.categories;
  delete cats.find(row => row.id === 'other-spend').targetEffectiveFrom;
  cats.find(row => row.id === 'fuel').plannedPayday = 'tbd';
  const advice = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
  const s = advice.scheduledAmounts;
  eq(s.status, 'unavailable', 'mixed: scheduled amounts unavailable');
  ok(s.unknowns.some(u => u.id === 'other-spend' && u.reason === 'plan-target-undated'), 'mixed: undated Other listed');
  ok(s.unknowns.some(u => u.id === 'fuel' && u.reason === 'plan-amount-invalid'), 'mixed: invalid target listed');
  eq([...s.issues].sort(), ['plan-amount-invalid', 'plan-target-undated'], 'mixed: both issues published');
  eq(s.reason, 'A scheduled amount or date is missing or invalid, so its dependent totals and spending claims are unknown.',
    'mixed: the general reason, not a single-cause message');
}

// (e) A non-numeric Other payday target on the pay-period view: the Other row
// is listed with the plan amounts unknown and withheld as target-invalid
// (a valid date does not rescue an amount that is not a number).
{
  const { advice, current, next } = world(cat => { cat.plannedPayday = 'tbd'; });
  ok(advice.scheduledAmounts.unknowns.some(u => u.id === 'other-spend' && u.reason === 'plan-amount-invalid'),
    'invalid: the Other target is named as an invalid amount');
  for (const [role, p] of [['current', current], ['next', next]]) {
    const row = otherRow(p);
    ok(row, `invalid ${role}: the Other row is listed, not dropped`);
    eq([row.planned, row.plannedPayday, row.hold, row.remaining, row.overspend], [null, null, null, null, null],
      `invalid ${role}: the Other plan, hold, remaining and overspend are unknown`);
    eq(row.withheldReason, 'target-invalid', `invalid ${role}: withheld as target-invalid`);
    eq(p.budgetHold, null, `invalid ${role}: the household hold is unknown`);
    eq(p.budgetProgress.household.planned.amount, null, `invalid ${role}: the household plan is unknown`);
  }
  eq(otherRow(current).spent, 137.26, 'invalid: the observed Other actual stays published');
}

// (f) A dated targetHistory entry does not date the current target. The
// fixture's prior entry carries effectiveThrough only: it says when the old
// target ended, not when the current one began. Inferring "the day after"
// would invent a date, so an undated top-level target stays Unknown even with
// dated history. This is the intended, cautious reading (lead, 2026-11-17).
{
  const { f, current } = world(cat => { delete cat.targetEffectiveFrom; });
  const cat = f.plan.budget.categories.find(row => row.id === 'other-spend');
  ok(Array.isArray(cat.targetHistory) && cat.targetHistory.length === 1
    && /^\d{4}-\d{2}-\d{2}$/.test(cat.targetHistory[0].effectiveThrough), 'history: a dated prior entry is present');
  eq([otherRow(current).withheldReason, otherRow(current).planned], ['target-undated', null],
    'history: the current Other target is still Unknown');
  eq(current.budgetHold, null, 'history: the household hold is still unknown');
}

console.log(`test-other-target-undated-unknown: ${checks} checks passed`);
