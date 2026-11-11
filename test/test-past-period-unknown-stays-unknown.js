'use strict';
// A past period never turns unknown into $0 or "none" (#821 finish-line audit,
// finding 13). Invented data only.
//   (a) A completed period older than the fetch window has UNKNOWN spending.
//       Forecast stamps its placeholder household hold Unavailable, and the hero
//       must print Unavailable, never "$0.00". Other published figures keep their
//       owner-decided treatment (#818 5.7). A period inside the window is unchanged.
//   (b) A recurring bill whose amount is unknown stays unknown after its period
//       closes: the bill load is withheld and the Bills section says so, never
//       "No bills in this period". A known-amount bill is unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/other-period-target');

const ROOT = path.join(__dirname, '..');
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(ROOT, 'public', name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const render = (period, plan, compact) => {
  context.p = period; context.plan = plan;
  return vm.runInContext('calendarWaterfallHtml(p,null,null,plan,' + compact + ')', context);
};
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const section = (html, prompt) => { const at = html.indexOf('data-operating-prompt="' + prompt + '"'); return at < 0 ? '' : html.slice(at, at + 900); };

// ---- (a) completed period older than the fetch window -------------------
const f = fx.build(618.73);                       // fetch window starts 2026-09-10
const advice = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
const views = advice.payPeriodViews;
const older = views.filter(v => v.timelineRole === 'past' && v.end < '2026-09-10');
const inWindow = views.find(v => v.start === '2026-09-11');
ok(older.length >= 3, 'fixture has completed periods wholly before the fetch window');
for (const v of older) {
  ok(v.budgetHoldTrust === 'unavailable', v.start + ': the placeholder household hold is stamped Unavailable, not left as a calculated 0');
  ok(v.householdBudget.every(r => r.spent === null), v.start + ': every category row stays unknown, none is 0');
  const html = render(v, f.plan, false);
  ok(/Unavailable/.test(section(html, 'Household budget')) && !/\$0\.00/.test(section(html, 'Household budget')),
    v.start + ': the hero prints Unavailable for Household budget, never $0.00');
}
ok(inWindow && inWindow.timelineRole === 'past' && inWindow.budgetHold === 83.14 && inWindow.budgetHoldTrust === null && inWindow.balanceAfterDeductions === 1316.86,
  'control: a completed period INSIDE the window keeps its figures and trust (hold 83.14, balance 1316.86)');
ok(/\$83\.14/.test(section(render(inWindow, f.plan, true), 'Household budget')), 'control: its hero still prints the amount');

// ---- (b) unknown-amount recurring bill, before and after close -----------
function billPlan(asOf, amount) {
  return { opening: { asOf, representedEvents: [] }, defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    startingCash: { breakdown: [
      { id: 'chequing-a', label: 'Invented bills', value: 2000, evidenceDate: asOf, confidence: 'confirmed' },
      { id: 'chequing-b', label: 'Invented spending', value: 150, evidenceDate: asOf, confidence: 'confirmed' }] },
    income: [{ id: 'payroll', label: 'Invented salary', frequency: 'biweekly', anchor: '2031-03-07', amount: 1400, confidence: 'confirmed' }],
    bills: [{ id: 'invented-utility', label: 'Invented utility', frequency: 'monthly', day: 12, amount,
      confidence: amount == null ? 'estimated' : 'confirmed', payingAccount: 'chequing-a' }],
    obligations: [], commitments: [], groups: [], funding: { options: [] },
    budget: { categories: [{ id: 'groceries', label: 'groceries', class: 'essential', plannedPayday: 100, confidence: 'confirmed', from: [] }] } };
}
const periodOn = (asOf, amount) => {
  const plan = billPlan(asOf, amount);
  const view = F.recommend(plan, asOf, { debts: [], targetBuffer: 0 }).payPeriodViews.find(v => v.start === '2031-03-07');
  return { plan, view };
};
const current = periodOn('2031-03-10', null);   // the period is still open
const closed = periodOn('2031-03-24', null);    // the same period after it closed
ok(current.view.timelineRole === 'current' && current.view.periodBillLoad === null, 'while current: the unknown bill withholds the bill load');
ok(closed.view.timelineRole === 'past', 'the same period is completed later');
ok(closed.view.periodBillLoad === null && closed.view.periodBillLoadTrust === 'unavailable',
  'after close: the bill load stays withheld, not 0 calculated');
ok(closed.view.afterBills === null && closed.view.balanceAfterDeductions === null, 'after close: balance after bills and after deductions stay withheld');
for (const compact of [true, false]) {
  const html = render(closed.view, closed.plan, compact);
  ok(!/No bills in this period/.test(html), 'after close (' + (compact ? 'compact' : 'full') + '): never says "No bills in this period"');
  const bills = section(html, 'Bills').slice(0, 2600);
  ok(!/\$0\.00/.test(bills.replace(/<[^>]+>/g, ' ').split('Balance after bills')[0]), 'after close (' + (compact ? 'compact' : 'full') + '): the Bills section prints no $0.00');
  if (compact) ok(/Original plan: Unavailable/.test(html.replace(/<[^>]+>/g, '')), 'after close (compact): the original plan is Unavailable');
  else ok(/Unavailable/.test(section(html, 'Bills').replace(/<[^>]+>/g, ' ')), 'after close (full): the Bills row says Unavailable');
}
// The completed-period Bills list itself (empty rows, withheld load) says Unavailable.
context.p = closed.view;
ok(/data-bills-unavailable/.test(vm.runInContext('calendarPeriodBillsHtml(p)', context))
  && /Unavailable\. Forecast did not publish this period.s bill total/.test(vm.runInContext('calendarPeriodBillsHtml(p)', context)),
  'after close: the Bills list with no rows says Unavailable, not "No bills in this period"');
// Control: a known-amount bill is unchanged after close, and a period with no
// bill at all still says so.
const knownClosed = periodOn('2031-03-24', 80);
ok(knownClosed.view.timelineRole === 'past' && knownClosed.view.periodBillLoad === 80 && knownClosed.view.periodBillLoadTrust === 'calculated',
  'control: a known-amount bill keeps its calculated load after close');
const noBill = (() => {
  const plan = billPlan('2031-03-24', 80); plan.bills = [];
  return { plan, view: F.recommend(plan, '2031-03-24', { debts: [], targetBuffer: 0 }).payPeriodViews.find(v => v.start === '2031-03-07') };
})();
ok(noBill.view.periodBillLoad === 0 && /No bills in this period/.test(render(noBill.view, noBill.plan, false)) && !/data-bills-unavailable/.test(render(noBill.view, noBill.plan, false)),
  'control: a period that truly has no bills still says "No bills in this period"');
context.p = noBill.view;
ok(/No bills in this period/.test(vm.runInContext('calendarPeriodBillsHtml(p)', context)), 'control: the Bills list for a period with no bills still says "No bills in this period"');

console.log('All past-period unknown-stays-unknown checks passed (' + checks + ').');
