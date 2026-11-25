'use strict';
// A household Budget category row's printed Remaining is the remainder the from-today household hold uses
// (heldRemainder): one rule, no second calculation. The page prints Forecast's `remaining` field and computes
// nothing; this suite drives the real chain, Forecast.recommend -> the page's own renderer (plan.js
// calendarWaterfallHtml, loaded in a vm as test/test-budget-household-total-display.js does).
//
// Invented worlds, each worked by hand (card world: Bills 500, card minimum 25, one Groceries allowance of 150
// with a 75 weekly figure; a purchase of 80 on the card; the from-today figure is 500 - reserve - remainder - 25):
//   1 oversize linked refund. Refund 120 of the 80 purchase: spent 80 - 120 = -40, hold = max(150, -40) = 150,
//     held remainder = min(150, 150 - (-40)) = 150. The row used to print planned - spent = 190. Refund 105:
//     spent -25, remainder 150 (it printed 175). A refund of exactly 80 nets spent to 0: remainder 150.
//   3 normal rows. No refund: spent 80, remainder 150 - 80 = 70. Refund 30: spent 50, remainder 100.
//     Both are unchanged by this change. An overspent row (a purchase of 200, plan 150): spent 200, hold 200,
//     held remainder 0, but the row keeps printing the signed planned - spent = -50 and Over 50: the page reads that
//     negative as Over, the fact the household needs, and this change does not decide otherwise.
//   2 negative-hold Other row. Fuel holds 150 untouched; Groceries has an explicit $0 monthly target, so it has no
//     row of its own and its purchase 80 and linked refund 120 join Other spending: spent -40, no target, so its hold
//     is its net -40. It holds nothing (held remainder 0) and carries no plan, so the page prints no Remaining for
//     it: it is never printed as $0.00. Fuel prints its 150. Available now 500 - 0 - 150 - 25 = 325.
//   4 Other spending with no target, positive spend. Purchase 80 only: Other spent 80, hold 80, nothing printed
//     for Remaining; Fuel 150; available 500 - 80 - 150 - 25 = 245. With a refund of 30: Other 50, available 275.
//   5 Other spending WITH a dated target of 100: a net refund into Other (spent -40) holds the 100 target: hold =
//     max(100, -40) = 100, held remainder 100, prints 100 (it printed 100 + 40 = 140); spent 50 prints 50; spent 80
//     prints 20; spent 130 is over plan and prints the signed 100 - 130 = -30.
// Identity tying the page to the hold, for the card world: available now = 500 - reserve - (the printed Remaining
// of every row, where the row prints one and is not over plan, plus the held remainder of an unprinted row,
// which is 0 for a negative hold) - 25.
// Mutant: restore planned - spent for the printed Remaining and the oversize cases fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const render = (period, plan) => { context.period = period; context.plan = plan; return vm.runInContext('calendarWaterfallHtml(period,null,null,plan,true)', context); };
const money = n => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n).replace(/^-/, '−');

// The block the page prints for one category, and the Remaining it carries (null when the row prints none).
function block(html, id) {
  const part = html.split('data-budget-category="' + id + '"')[1];
  assert.ok(part, 'the page prints a ' + id + ' row');
  return part.split('data-budget-category=')[0];
}
function printedRemaining(html, id) {
  const m = /<dt>Remaining<\/dt><dd>([^<]*)<\/dd>/.exec(block(html, id).replace(/\s+/g, ' '));
  return m ? m[1] : null;
}
const purchase = ['card', 80, null, 'purchase'];
const asRefund = (amount = 30, account = 'card') => [account, -amount, null, 'refund', { is_group_parent: true }];
const probeEdit = x => { x.data.plan.budget.categories = [
  { id: 'fuel', label: 'Fuel', class: 'essential', plannedPayday: 150, plannedWeekly: 75, confidence: 'confirmed' },
  { id: 'groceries', label: 'Groceries', class: 'essential', plannedMonthly: 0, confidence: 'confirmed' }]; };
const rowOf = (s, id) => s.period.householdBudget.find(r => r.id === id);
const cardWorld = (rows, opts, runner) => {
  const s = (runner || run)(world(rows, opts));
  return { s, html: render(s.period, s.observed.data.plan) };
};
// The hold's remainder, worked from the published hold and spent by the stated rule (never from `remaining`).
const hold = (h, spent) => Math.max(0, Math.min(h, Math.max(0, h - spent)));

// A mutant copy of Forecast with the row's Remaining restored to planned - spent, and the same chain run on it.
const SRC = fs.readFileSync(path.join(__dirname, '../public/forecast.js'), 'utf8');
const AUTHORITY = /function budgetRowRemaining\(row\) \{[\s\S]*?\r?\n  \}/;
assert.ok(AUTHORITY.test(SRC), 'budgetRowRemaining, the one authority for the printed Remaining, is found in forecast.js');
const mutantFile = path.join(os.tmpdir(), 'forecast-mutant-' + process.pid + '.js');
fs.writeFileSync(mutantFile, SRC.replace(AUTHORITY, 'function budgetRowRemaining(row) { return roundCent(row.planned - row.spent); }')
  .replace("require('./forecast-card-period')", "require(" + JSON.stringify(path.join(__dirname, '../public/forecast-card-period')) + ")"));
const Mutant = require(mutantFile);
const runMutant = x => {
  const observed = Live.fromObservation(x);
  const packet = observed.data.liveOverlay.currentPeriodActuals;
  const advice = Mutant.recommend(observed.data.plan, x.asOf, { debts: observed.data.debts, currentPeriodActuals: packet });
  const period = advice.payPeriodViews.find(p => p.role === 'active');
  return { observed, packet, advice, period, coverage: advice.cardPurchaseCoverage };
};

console.log('1. An oversize linked refund: the printed Remaining is the hold, never past it');
for (const [refund, spent, printed] of [[120, -40, 150], [105, -25, 150], [80, 0, 150]]) {
  const { s, html } = cardWorld([purchase, asRefund(refund)]);
  const row = rowOf(s, 'groceries');
  eq([row.spent, row.hold, row.remaining], [spent, 150, printed], 'refund ' + refund + ': published spent, hold, remaining');
  eq(row.remaining, hold(row.hold, row.spent), 'refund ' + refund + ': the published Remaining is the hold remainder');
  eq(printedRemaining(html, 'groceries'), money(printed), 'refund ' + refund + ': the page prints ' + money(printed));
  eq([s.coverage.reservedCash, s.period.fromTodayFunding.availableNow], [Math.max(0, spent), 500 - Math.max(0, spent) - printed - 25],
    'refund ' + refund + ': available now 500 - reserve - the printed remainder - 25');
}

console.log('2. A negative-hold Other row (purchase and refund join Other): no Remaining printed, never $0.00');
{
  const { s, html } = cardWorld([purchase, asRefund(120)], { edit: probeEdit });
  eq(s.period.householdBudget.map(r => [r.id, r.hold, r.spent, r.remaining]),
    [['fuel', 150, 0, 150], ['other-spending', -40, -40, null]], 'published rows');
  eq(printedRemaining(html, 'fuel'), money(150), 'Fuel prints its untouched 150');
  eq(printedRemaining(html, 'other-spending'), null, 'Other prints no Remaining at all: not $0.00 and not 40');
  assert.doesNotMatch(block(html, 'other-spending'), /Remaining/); checks++;
  eq([s.coverage.reservedCash, s.period.fromTodayFunding.availableNow], [0, 500 - 0 - (150 + hold(-40, -40)) - 25],
    'available now 500 - 0 - (150 + 0) - 25 = 325');
}

console.log('3. Normal rows and an overspent row are as before');
for (const [rows, spent, remaining, over] of [[[purchase], 80, 70, 0], [[purchase, asRefund(30)], 50, 100, 0],
  [[['card', 200, null, 'purchase']], 200, -50, 50]]) {
  const { s, html } = cardWorld(rows);
  const row = rowOf(s, 'groceries');
  eq([row.spent, row.remaining, row.overspend], [spent, remaining, over], 'spent ' + spent + ': remaining ' + remaining);
  eq(printedRemaining(html, 'groceries'), money(remaining), 'the page prints ' + money(remaining));
  if (over === 0) eq(row.remaining, hold(row.hold, row.spent), 'within plan the printed Remaining is the hold remainder');
  else eq([row.hold, hold(row.hold, row.spent)], [200, 0], 'over plan the hold remainder is 0 while the row keeps the signed overspend');
}

console.log('4. Other spending with no target prints no Remaining');
for (const [rows, otherSpent, available] of [[[purchase], 80, 245], [[purchase, asRefund(30)], 50, 275]]) {
  const { s, html } = cardWorld(rows, { edit: probeEdit });
  eq(s.period.householdBudget.map(r => [r.id, r.hold, r.spent, r.remaining]),
    [['fuel', 150, 0, 150], ['other-spending', otherSpent, otherSpent, null]], 'published rows');
  eq(printedRemaining(html, 'other-spending'), null, 'no Remaining for a no-target Other row');
  eq(s.period.fromTodayFunding.availableNow, available, 'available now ' + available);
}

console.log('5. Other spending with a dated target of 100');
{
  // As world 2, plus a dated Other target of 100 (effective before the period), so Other carries a plan.
  const dated = x => { probeEdit(x); x.data.plan.budget.categories.push({ id: 'other-spend', label: 'Other spend', class: 'essential',
    plannedPayday: 100, plannedMonthly: null, targetEffectiveFrom: '2026-09-01', confidence: 'confirmed' }); };
  // [rows, Other spent, Other remaining, Other over]: net refund -40 holds the 100 target (it printed 100 + 40 = 140);
  // spent 50 leaves 50; spent 80 leaves 20; spent 130 is over by 30 and keeps the signed -30.
  for (const [rows, spent, remaining, over] of [[[purchase, asRefund(120)], -40, 100, 0], [[purchase, asRefund(30)], 50, 50, 0],
    [[purchase], 80, 20, 0], [[['card', 130, null, 'purchase']], 130, -30, 30]]) {
    const { s, html } = cardWorld(rows, { edit: dated });
    const row = rowOf(s, 'other-spending');
    eq([row.planned, row.spent, row.remaining, row.overspend], [100, spent, remaining, over], 'Other published, spent ' + spent);
    eq(printedRemaining(html, 'other-spending'), money(remaining), 'the page prints ' + money(remaining));
    if (over === 0) eq(row.remaining, hold(row.hold, row.spent), 'within plan: the hold remainder');
  }
}

console.log('6. Household totals do not move');
{
  const base = cardWorld([purchase, asRefund(120)]).s.period, again = cardWorld([purchase, asRefund(120)]).s.period;
  eq([base.budgetHold, base.fromTodayFunding.availableNow, base.balanceAfterDeductions],
    [again.budgetHold, again.fromTodayFunding.availableNow, again.balanceAfterDeductions], 'repeatable');
  eq([base.budgetHold, base.fromTodayFunding.availableNow], [150, 325], 'hold 150 and available now 325 are the hand-worked 150 and 500 - 0 - 150 - 25');
}

console.log('7. Mutant: planned - spent restored for the printed Remaining fails the oversize cases');
{
  const s = runMutant(world([purchase, asRefund(120)]));
  const row = s.period.householdBudget.find(r => r.id === 'groceries');
  eq(row.remaining, 190, 'the mutant prints 190 on a 150 hold');
  assert.notEqual(row.remaining, hold(row.hold, row.spent), 'so the agreement checks above would fail'); checks++;
  const normal = runMutant(world([purchase]));
  eq(normal.period.householdBudget.find(r => r.id === 'groceries').remaining, 70, 'the mutant leaves a normal row alone: the cases above are what catch it');
  // And the same oversize case run against the mutant's own published row fails the agreement assertion.
  assert.throws(() => assert.equal(row.remaining, hold(row.hold, row.spent)), /Expected values to be strictly equal|AssertionError/); checks++;
}
try { fs.unlinkSync(mutantFile); } catch (e) { /* tmp cleanup only */ }
console.log('ok: ' + checks + ' checks');
