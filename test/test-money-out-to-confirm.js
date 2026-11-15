'use strict';
// Money out, to confirm (Grok Bot's rule 17 answer on transfers; owner-approved audit, 1.0).
// A POSTED chequing debit filed as Transfer or Payment, with no other side proven through the
// ledger (a transfer group, link or mark; never a name or amount match), left cash, so it
// reduces the Budget's remainder ONCE as its own named term, "Money out, to confirm". It is not
// Other spending. A pending one is shown separately and is not added in. A proven card payment
// counts once, on the card side; a proven move between household accounts moves nothing out.
// Before this, the same $400 filed as Transfer left the remainder untouched (1,632.01) while
// filed as Shopping it reduced it (1,232.01). The printed terms must sum to the printed total.
// Invented data only: the Budget surface household plus extra legs; every expected figure is
// the fixture's own literal (remainder before the leg 1,632.01 = 4,050 - 1,665 - 752.99).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/budget-surface-data');
const { world } = require('./fixtures/money-out-worlds');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
function stubEl() {
  return { innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [] };
}

// Load the Budget page scripts in index.html order.
function page() {
  const els = new Map();
  const context = vm.createContext({ Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: { addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl() },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  // In a browser window is the global object; page scripts register on it.
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js',
    'budget-surface.js', 'plan.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), context);
  }
  // Charts need a real SVG DOM; they are not part of this surface.
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext(`globalThis.__retainedCalls = 0;
    const __retained = operatingSurfaceHtml;
    operatingSurfaceHtml = function (ctx) { globalThis.__retainedCalls++; return __retained(ctx); };
    const __active = budgetSurfaceHtml;
    budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };`, context);
  return {
    context,
    render(served) {
      context.served = served;
      // App.boot sets App.data to the served packet before renderPlan runs.
      vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
      vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
      return els.get('operating-surface-body').innerHTML;
    },
    rerender(js) { return vm.runInContext(`${js}; budgetSurfaceHtml(__ctx)`, context); },
  };
}


const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const cents = n => Math.round(Number(n) * 100);
function run(legs) {
  const p = page();
  const html = p.render(world(legs));
  const ctx = p.context.__ctx;
  const cur = ctx.advice.payPeriodViews.find(view => view.timelineRole === 'current');
  return { html, cur, terms: cur.predictedEndingBalanceTerms, other: (cur.householdBudget || []).find(row => row.id === 'other-spending') };
}
const BEFORE = 1632.01; // 4,050 income - 1,665 bills - 752.99 household hold: hand-derived from the fixture header
const DEBIT = 400;
const transfer = { category: 'transfer', amount: DEBIT };

console.log('\n=== the same $400 moves the remainder by the same amount however it is filed ===');
const control = run([]);
const shopping = run([{ category: 'shopping', amount: DEBIT }]);
const unproven = run([transfer]);
ok(cents(control.cur.balanceAfterDeductions) === cents(BEFORE), 'control: the remainder is 1,632.01', String(control.cur.balanceAfterDeductions));
ok(cents(shopping.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT), 'filed as Shopping: the remainder falls by 400.00', String(shopping.cur.balanceAfterDeductions));
ok(cents(unproven.cur.balanceAfterDeductions) === cents(shopping.cur.balanceAfterDeductions),
  'filed as Transfer with no proven other side: the remainder falls by the same 400.00', String(unproven.cur.balanceAfterDeductions));
ok(cents(unproven.cur.afterHouseholdBudget) === cents(shopping.cur.afterHouseholdBudget), 'the household remainder agrees too');
ok(unproven.terms?.moneyOutToConfirm === DEBIT && unproven.terms.closes === true,
  'the 400 is its own published term and the terms still close', JSON.stringify(unproven.terms));
ok(unproven.other?.spent === control.other?.spent, 'it is not Other spending (Other is unchanged)', JSON.stringify([unproven.other?.spent, control.other?.spent]));
ok(unproven.cur.balanceAfterDeductionsTrust === 'estimated',
  'the remainder reads estimated while a money-out term to confirm stands (never more certain; the fixture is already estimated through its partner pay)', unproven.cur.balanceAfterDeductionsTrust);
ok(unproven.cur.moneyOutToConfirm?.posted === DEBIT && unproven.cur.moneyOutToConfirm.pending === 0, 'the period publishes the posted amount');
ok(!shopping.terms?.moneyOutToConfirm && !control.terms?.moneyOutToConfirm, 'a Shopping debit or no debit publishes no money-out term');
const paymentLabel = run([{ category: 'payment', amount: DEBIT }]);
ok(cents(paymentLabel.cur.balanceAfterDeductions) === cents(BEFORE - DEBIT) && paymentLabel.terms?.moneyOutToConfirm === DEBIT,
  'filed as Payment, Transfer: the same, once');

console.log('\n=== the printed parts sum to the printed total ===');
{
  const row = key => (unproven.html.match(new RegExp('data-bad-term="' + key + '"[\\s\\S]*?data-bad-term-amount>([^<]*)<')) || [])[1];
  const printed = ['periodIncome', 'assignedBills', 'householdBudgetHold', 'moneyOutToConfirm', 'balanceAfterDeductions'].map(row);
  const n = text => (text == null ? null : cents(String(text).replace(/[^0-9.\-]/g, '')));
  ok(printed.every(value => value != null), 'every term, the money-out term included, is printed', JSON.stringify(printed));
  ok(n(printed[0]) - n(printed[1]) - n(printed[2]) - n(printed[3]) === n(printed[4]),
    'income - bills - household - money out = the printed remainder', JSON.stringify(printed));
  ok(/Money out, to confirm/.test(text(unproven.html)) && (unproven.html.match(/data-bad-term="moneyOutToConfirm"/g) || []).length === 1,
    'the term is labelled Money out, to confirm and printed once');
  ok(!/data-bad-term="moneyOutToConfirm"/.test(shopping.html), 'no such line on a Shopping debit');
}

console.log('\n=== a pending debit is shown separately and is not added in ===');
{
  const pending = run([{ category: 'transfer', amount: DEBIT, pending: true }]);
  ok(cents(pending.cur.balanceAfterDeductions) === cents(BEFORE) && !pending.terms?.moneyOutToConfirm,
    'the remainder is unchanged and there is no term', String(pending.cur.balanceAfterDeductions));
  ok(pending.cur.moneyOutToConfirm?.pending === DEBIT && pending.cur.moneyOutToConfirm.posted === 0, 'the pending amount is published separately', JSON.stringify(pending.cur.moneyOutToConfirm));
  ok(/data-money-out-pending/.test(pending.html) && /Pending money out, to confirm: \$400\.00/.test(text(pending.html)),
    'the page says so, and that it is not counted until it posts');
}

console.log('\n=== proven flows are not money out ===');
{
  // A proven move between two household accounts: both TD transfer legs with one reference.
  const moved = run([
    { account: 1002, category: 'transfer', amount: DEBIT, original: 'AB123 TFR-TO INVENTED SAVINGS', payee: 'Transfer out' },
    { account: 1001, category: 'transfer', amount: -DEBIT, original: 'AB123 TFR-FR INVENTED OPERATING', payee: 'Transfer in' },
  ]);
  ok(cents(moved.cur.balanceAfterDeductions) === cents(BEFORE) && !moved.terms?.moneyOutToConfirm && !moved.cur.moneyOutToConfirm,
    'a proven transfer pair (same reference, two household accounts) is not money out', String(moved.cur.balanceAfterDeductions));
  // A TD card payment by its recipient identity counts on the card side, once.
  const card = run([{ category: 'transfer', amount: DEBIT, original: 'AB124 TFR-TO C/C', payee: 'Card payment' }]);
  ok(cents(card.cur.balanceAfterDeductions) === cents(BEFORE) && !card.terms?.moneyOutToConfirm && !card.cur.moneyOutToConfirm,
    'a card payment by identity is not counted again as money out', String(card.cur.balanceAfterDeductions));
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
