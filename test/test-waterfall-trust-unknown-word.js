'use strict';
// LOW (trust vocabulary): a bill or income row whose trust word is outside
// the published vocabulary makes its period term unknown, never estimated.
// `node test/test-waterfall-trust-unknown-word.js`
//
// Fixture: test/fixtures/budget-surface-data.js (invented). Its 'internet'
// bill sits on the current pay period's waterfall. Expectations are by hand:
// a recognised word (confirmed / verified / calculated / estimated / planned)
// or a missing word leaves the bill-load term estimated as before; an
// unrecognised word ('guessed', 'inferred', 'possible', a number) makes the
// bill-load term and every term built on it unavailable, exactly as an
// explicit 'unknown' already does, and the Budget hero prints Unavailable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');
const fx = require('./fixtures/budget-surface-data.js');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function stubEl() {
  return {
    innerHTML: '', textContent: '', hidden: false, value: '',
    style: { setProperty() {}, getPropertyValue() { return ''; } }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, hasAttribute() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentHTML() {}, closest() { return null; }, children: [],
  };
}
function budgetPage() {
  const els = new Map();
  const context = vm.createContext({
    Forecast: F, console, addEventListener() {}, setTimeout, clearTimeout,
    document: {
      addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
      getElementById(id) { if (!els.has(id)) els.set(id, stubEl()); return els.get(id); },
      documentElement: { dataset: {}, style: {} }, createElement: stubEl, createElementNS: stubEl, body: stubEl(),
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { pathname: '/', search: '' },
  });
  context.window = Object.assign(context, { matchMedia() { return { matches: false, addEventListener() {} }; } });
  vm.runInContext(read('public/app.js'), context);
  vm.runInContext('App.boot = () => {}; App.once = () => {}; App.register = () => {};', context);
  for (const f of ['forecast-chequing.js', 'balance-history.js', 'bill-detail.js', 'savings-inventory.js', 'budget-surface.js', 'plan.js']) {
    vm.runInContext(read(path.join('public', f)), context);
  }
  vm.runInContext('forecastChart = () => {}; renderCalendar = () => {};', context);
  vm.runInContext('const __active = budgetSurfaceHtml; budgetSurfaceHtml = function (ctx) { globalThis.__ctx = ctx; return __active(ctx); };', context);
  return served => {
    context.served = served;
    vm.runInContext("Object.defineProperty(App, 'data', { get: () => served, configurable: true });", context);
    vm.runInContext('Object.assign(state, served.plan.defaults, { debts: served.debts }); renderPlan(served, null, null);', context);
    return { html: els.get('operating-surface-body').innerHTML, advice: context.__ctx.advice };
  };
}
const render = budgetPage();
const heroText = html => { const m = /data-budget-period-result(?:=|>|\s)[\s\S]*?<\/div>/.exec(html); return m ? strip(m[0]) : ''; };

function run(word, target = 'bill') {
  const data = fx.served();
  const bill = target === 'bill' ? data.plan.bills.find(b => b.id === 'internet') : data.plan.income[0];
  assert.ok(bill, `fixture has the ${target} row`);
  if (word === undefined) delete bill.confidence; else bill.confidence = word;
  const { html, advice } = render(data);
  return { cur: advice.payPeriodViews.find(r => r.timelineRole === 'current'), hero: heroText(html) };
}

for (const word of [undefined, 'confirmed', 'verified', 'calculated', 'estimated', 'planned']) {
  const { cur, hero } = run(word);
  assert.equal(cur.periodBillLoadTrust, 'estimated', `${String(word)}: a recognised or missing word keeps the bill load estimated`);
  assert.notEqual(cur.balanceAfterDeductionsTrust, 'unavailable', `${String(word)}: the period result stays published`);
  assert.doesNotMatch(hero, /Unavailable/, `${String(word)}: the hero still prints a figure`);
}
for (const word of ['guessed', 'inferred', 'possible', 'unknown', 42, '', '  ', 0, false]) {
  const { cur, hero } = run(word);
  assert.equal(cur.periodBillLoadTrust, 'unavailable', `${String(word)}: an unrecognised word makes the bill-load term unknown, never estimated`);
  assert.equal(cur.balanceAfterDeductionsTrust, 'unavailable', `${String(word)}: the dependent period result is unknown too`);
  assert.match(hero, /Unavailable/, `${String(word)}: the Budget hero prints Unavailable`);
}
// Atlas finding 1 on 1bc7ac6: a blank or falsy word on a scheduled income
// row is a supplied invalid value, not a missing one. It must fail closed
// too, while a missing income word stays estimated.
{
  const { cur, hero } = run(undefined, 'income');
  assert.equal(cur.incomeTrust, 'estimated', 'missing income word: income term stays estimated');
  assert.doesNotMatch(hero, /Unavailable/, 'missing income word: the hero still prints a figure');
}
for (const word of ['', '  ', 0, false, 'guessed']) {
  const { cur, hero } = run(word, 'income');
  assert.equal(cur.incomeTrust, 'unavailable', `income ${JSON.stringify(word)}: the income term is unknown, never estimated`);
  assert.equal(cur.balanceAfterDeductionsTrust, 'unavailable', `income ${JSON.stringify(word)}: the period result is unknown`);
  assert.match(hero, /Unavailable/, `income ${JSON.stringify(word)}: the Budget hero prints Unavailable`);
}
console.log('unrecognised waterfall trust words fail closed: ok');
