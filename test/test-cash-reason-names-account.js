'use strict';
// Bug hunt finding 5: with both chequing balances stale, the Cash needed sheet
// printed the same sentence twice with nothing to tell the two apart. Forecast
// already publishes one reason per account with its account label; the sheet now
// prints that label under each reason. Reason codes, wording of the sentence and
// which figures are withheld are unchanged. Entirely invented data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const H = require('./acceptance/harness');
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);

const SENTENCE = 'This chequing balance is not current for the proposal date.';
// The acceptance fixture's chequing balances are not dated to the proposal day, so both
// accounts publish a stale reason: exactly the repeated-sentence case.
function sheet() {
  const w = H.baseWorld();
  const { data, error } = H.dataOf(w); assert.equal(error, null);
  const o = data.liveOverlay;
  const advice = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: o.currentPeriodActuals,
    operatingPlan: o.operatingPlan, observedCash: o.observedCash });
  const current = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  context.ctx = { asOf: w.asOf, plan: data.plan, advice, liveOverlay: o };
  return { advice, failures: (current.fromTodayFunding.evidenceFailures || []), html: vm.runInContext('budgetTodayCashCardHtml(ctx)', context) };
}

const both = sheet();
const stale = both.failures.filter(f => f.code === 'cash-account-stale');
assert.equal(stale.length, 2, 'control: Forecast publishes one stale reason per chequing account');
assert.equal(new Set(stale.map(f => f.accountLabel)).size, 2, 'control: each reason carries a different account label');
assert.ok(stale.every(f => f.message === SENTENCE), 'control: the reason sentence is unchanged');
const items = both.html.match(/<li data-budget-cash-reason="cash-account-stale">.*?<\/li>/gs) || [];
assert.equal(items.length, 2, 'the sheet prints one line per stale account');
for (const f of stale) {
  assert.ok(items.some(li => li.includes(SENTENCE) && li.includes('<small data-budget-cash-reason-context>' + f.accountLabel + '</small>')),
    'the line for ' + f.accountLabel + ' names its account');
}
assert.notEqual(items[0], items[1], 'the two lines are not identical text');
// A sheet with no per-account reason prints no context line.
context.ctx.advice.payPeriodViews.find(p => p.timelineRole === 'current').fromTodayFunding.evidenceFailures = [];
assert.doesNotMatch(vm.runInContext('budgetTodayCashCardHtml(ctx)', context), /data-budget-cash-reason-context/, 'no reasons, no context line');
// A reason with no account, category or date prints exactly as before.
context.ctx.advice.payPeriodViews.find(p => p.timelineRole === 'current').fromTodayFunding.evidenceFailures = [{ code: 'actuals-stale', message: 'The spending observation is stale.', action: '' }];
const plain = vm.runInContext('budgetTodayCashCardHtml(ctx)', context);
assert.match(plain, /<li data-budget-cash-reason="actuals-stale">The spending observation is stale\.<\/li>/, 'a reason without account context is unchanged');
console.log('Cash needed sheet names the account behind each reason: passed');
