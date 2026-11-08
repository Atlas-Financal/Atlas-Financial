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
// Lead rule-6 call on Atlas's re-review of 6bb0e32 (Option A): every
// `confidence || 'estimated'` default on rows that reach Budget period terms
// or planned-cost trust now defaults only an absent word. A supplied blank or
// falsy word fails closed. Three end-to-end paths, invented inputs only.
const FALSY = ['', '  ', 0, false];
const current = advice => advice.payPeriodViews.find(r => r.timelineRole === 'current');

// 1. Pending Other Income reconciled onto an expected once-only stream
//    (attachObservedOtherIncome). Invented: a $200 side gig expected Aug 24
//    and one pending $200 income deposit the same day.
function pendingOtherIncome(word) {
  const data = fx.served();
  const stream = { id: 'other-income:invented-gig', label: 'Invented side gig', frequency: 'once', date: '2026-08-24', amount: 200 };
  if (word !== undefined) stream.confidence = word;
  data.plan.income.push(stream);
  data.liveOverlay.currentPeriodActuals.transactions.push({ id: 'invented-gig-pending', date: '2026-08-24', amount: -200,
    pending: true, isIncome: true, accountRole: 'household-cash', atlasAccountId: 'chequing-a',
    displayedPayee: 'Invented side gig', categoryLabel: 'Income' });
  // C3 (#857): a pending receipt never settles an expectation by date and
  // amount alone; the pending deposit reaches the expected stream through
  // its identity-rule link, the qualified path that still attaches it.
  const actuals = data.liveOverlay.currentPeriodActuals;
  actuals.representedActuals = (actuals.representedActuals || []).concat([{ id: stream.id, date: stream.date,
    actual: -200, postedOn: stream.date, transactionId: 'invented-gig-pending' }]);
  const { html, advice } = render(data);
  const cur = current(advice);
  assert.match(JSON.stringify(cur), /"reconciledFrom":"identity-qualified-receipt"/,
    `pending Other Income ${JSON.stringify(word)}: the pending receipt reconciles onto the expected stream`);
  return { cur, hero: heroText(html) };
}
{
  const { cur, hero } = pendingOtherIncome(undefined);
  assert.equal(cur.incomeTrust, 'estimated', 'pending Other Income, missing word: income term stays estimated');
  assert.doesNotMatch(hero, /Unavailable/, 'pending Other Income, missing word: the hero still prints a figure');
}
for (const word of FALSY.concat(['guessed'])) {
  const { cur, hero } = pendingOtherIncome(word);
  assert.equal(cur.incomeTrust, 'unavailable', `pending Other Income ${JSON.stringify(word)}: the income term is unknown, never estimated`);
  assert.equal(cur.balanceAfterDeductionsTrust, 'unavailable', `pending Other Income ${JSON.stringify(word)}: the period result is unknown`);
  assert.match(hero, /Unavailable/, `pending Other Income ${JSON.stringify(word)}: the Budget hero prints Unavailable`);
}

// 2. An obligation's planned cash minimum (capitalisingCashMinimumOccurrences).
//    Invented: a capitalising loan with a $50 cash minimum on the 22nd.
function obligation(fields) {
  const data = fx.served();
  data.plan.obligations.push(Object.assign({ id: 'invented-loan', label: 'Invented loan', frequency: 'monthly', day: 22,
    amount: 30, nonCash: true, effect: 'capitalise', cashPayment: 50, cashDay: 22 }, fields));
  const { html, advice } = render(data);
  const cur = current(advice);
  assert.match(JSON.stringify(cur), /invented-loan/, 'the invented cash minimum sits on the current period');
  return { cur, hero: heroText(html) };
}
{
  const { cur, hero } = obligation({});
  assert.equal(cur.periodBillLoadTrust, 'estimated', 'obligation, missing word: the bill-load term stays estimated');
  assert.doesNotMatch(hero, /Unavailable/, 'obligation, missing word: the hero still prints a figure');
}
for (const fields of FALSY.map(word => ({ confidence: word })).concat(FALSY.map(word => ({ cashConfidence: word, confidence: 'confirmed' })))) {
  const { cur, hero } = obligation(fields);
  const label = JSON.stringify(fields);
  assert.equal(cur.periodBillLoadTrust, 'unavailable', `obligation ${label}: the bill-load term is unknown, never estimated`);
  assert.equal(cur.balanceAfterDeductionsTrust, 'unavailable', `obligation ${label}: the period result is unknown`);
  assert.match(hero, /Unavailable/, `obligation ${label}: the Budget hero prints Unavailable`);
}

// 2b. The same cash minimum on the Bills list: a blank word never prints a
//     bare figure that reads like a confirmed one (pre-review finding). It
//     prints Unavailable; a missing word keeps its estimated mark.
function billsListLoan(fields) {
  const data = fx.served();
  data.plan.obligations.push(Object.assign({ id: 'invented-loan', label: 'Invented loan', frequency: 'monthly', day: 22,
    amount: 30, nonCash: true, effect: 'capitalise', cashPayment: 50, cashDay: 22 }, fields));
  const html = budgetPage()(data).html;
  const m = /<button[^>]*data-budget-bill-open="invented-loan"[\s\S]*?<\/button>/.exec(html);
  assert.ok(m, `bills list ${JSON.stringify(fields)}: the invented loan row renders`);
  return strip(m[0]);
}
assert.match(billsListLoan({}), /estimated \$50\.00/, 'bills list, missing word: the cash minimum keeps its estimated mark');
for (const word of ['', 0]) {
  const row = billsListLoan({ confidence: word });
  assert.doesNotMatch(row, /\$50\.00/, `bills list ${JSON.stringify(word)}: no bare figure`);
  assert.match(row, /Unavailable/, `bills list ${JSON.stringify(word)}: the amount prints Unavailable`);
}

// 2c. A monthly stream's receipt before its first due date (the opening
//     receipt row in calendarIncomeSections) keeps a supplied blank word, so
//     the period income term it feeds fails closed (pre-review finding).
//     Invented: $300 monthly on the 1st, first due Sep 1; the Jul 31 period.
function earlyReceipt(word) {
  const data = fx.served();
  const stream = { id: 'invented-rent-in', label: 'Invented rent received', frequency: 'monthly', day: 1, firstDue: '2026-09-01', amount: 300 };
  if (word !== undefined) stream.confidence = word;
  data.plan.income.push(stream);
  const { advice } = render(data);
  const view = advice.pastPeriodViews.concat(advice.payPeriodViews).find(v => v.start === '2026-07-31');
  assert.ok(view && JSON.stringify(view).includes('invented-rent-in'), `early receipt ${JSON.stringify(word)}: the Jul 31 period carries the receipt`);
  return view;
}
assert.equal(earlyReceipt(undefined).incomeTrust, 'estimated', 'early receipt, missing word: income term stays estimated');
for (const word of FALSY) {
  const view = earlyReceipt(word);
  assert.equal(view.incomeTrust, 'unavailable', `early receipt ${JSON.stringify(word)}: the income term is unknown, never estimated`);
  assert.equal(view.balanceAfterDeductionsTrust, 'unavailable', `early receipt ${JSON.stringify(word)}: the period result is unknown`);
}

// 3. A commitment (planned cost). Invented: the fixture's $400 school trip on
//    Sep 12. Each case renders in a fresh page so no earlier render's payday
//    section can carry over.
function commitment(word) {
  const data = fx.served();
  const cost = data.plan.commitments.find(row => row.id === 'school-trip');
  if (word === undefined) delete cost.confidence; else cost.confidence = word;
  const { html, advice } = budgetPage()(data);
  const text = strip(html);
  const lines = [];
  for (let i = text.indexOf('School trip'); i >= 0; i = text.indexOf('School trip', i + 1)) lines.push(text.slice(i, i + 60));
  return { advice, lines };
}
{
  const { advice, lines } = commitment(undefined);
  assert.equal(advice.planSpendPaydayFunding.fundingTrust, 'estimated', 'commitment, missing word: planned-cost trust stays estimated');
  assert.ok(lines.some(line => /≈ estimated \$400\.00/.test(line)), 'commitment, missing word: the cost still prints as an estimate');
}
for (const word of FALSY.concat(['unknown'])) {
  const { advice, lines } = commitment(word);
  assert.equal(advice.planSpendPaydayFunding.fundingTrust, 'unavailable', `commitment ${JSON.stringify(word)}: planned-cost trust is unknown, never estimated`);
  const items = advice.payPeriodViews.flatMap(view => ((view.plannedCostFunding || {}).items || []).filter(item => item.id === 'school-trip'));
  assert.ok(items.length && items.every(item => item.confidence !== 'estimated'), `commitment ${JSON.stringify(word)}: no planned-cost item restamps the word as estimated`);
  assert.ok(lines.length && lines.every(line => !/\$\d/.test(line.slice(0, 40)) && !/estimate/.test(line.slice(0, 40))),
    `commitment ${JSON.stringify(word)}: the page prints no figure or estimate for the cost`, lines);
}
console.log('unrecognised waterfall trust words fail closed: ok');
