'use strict';
/* The Budget period view prints every term Forecast deducts.
 *
 * Forecast's Balance After Deductions deducts linked savings-item spending
 * paid from chequing as its own published term (savingsItemSpending). The
 * page used to print only income, bills and household, so the printed terms
 * did not add up to the printed result. Invented case, hand-computed here:
 *
 *   payroll                      1,400
 *   assigned bills                   0
 *   household hold                 400
 *   trip purchase (linked item)    100   paid from chequing
 *   Balance After Deductions       1,400 - 0 - 400 - 100 = 900
 *
 * Control (no purchase): 1,400 - 0 - 400 = 1,000, with no item term and the
 * terms block byte-identical to the printer's previous wording.
 *
 * Runs the production observation path (scripts/live-plan via the
 * acceptance harness's dataOf) and Forecast.recommend, then the incumbent
 * plan.js printer (calendarWaterfallHtml) in a VM.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./acceptance/harness');
const F = require('../public/forecast');

const INCOME = 1400, HOLD = 400, ITEM = 100;
function world(purchase) {
  const w = H.baseWorld();
  w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-12-01', amount: 500, confidence: 'confirmed', sinkingFund: true }];
  w.savingsPool = {};
  w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-12-01',
    effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
  w.transactions = [H.lm({ date: '2026-10-09', amount: -INCOME, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (purchase) w.transactions.push(H.lm({ date: '2026-10-11', amount: ITEM, category: 'Trip', payee: 'Invented airline' }));
  return w;
}
function current(purchase) {
  const w = world(purchase);
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null, 'invented observation is accepted');
  const advice = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet });
  const v = advice.payPeriodViews.find(p => p.timelineRole === 'current');
  assert.ok(v, 'the current period is published');
  return { v, plan: data.plan };
}

// The incumbent page printer, booted as in test-bad-terms-print.js.
const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const render = (period, plan, compact) => { context.period = period; context.plan = plan; context.compact = compact;
  return vm.runInContext('calendarWaterfallHtml(period,null,null,plan,compact)', context); };

const termsBlock = html => { const m = html.match(/<div class="operating-lines budget-bad-terms" data-bad-terms[\s\S]*?Balance After Deductions<\/span>.*?<\/div>/); assert.ok(m, 'terms block printed'); return m[0]; };
const terms = block => [...block.matchAll(/data-bad-term="([A-Za-z]+)" data-bad-term-trust="([a-z]+)"><span data-bad-term-label>[^<]*<\/span><span data-bad-term-value>.*?<span data-bad-term-amount>([^<]*)<\/span>/g)]
  .map(m => ({ key: m[1], trust: m[2], amount: m[3] }));
const cents = text => { const m = text.match(/^(−?)\$([\d,]+)\.(\d\d)$/); assert.ok(m, 'money text: ' + text);
  return (m[1] ? -1 : 1) * (Number(m[2].replace(/,/g, '')) * 100 + Number(m[3])); };
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

{
  const { v, plan } = current(true);
  eq(v.predictedEndingBalanceTerms.savingsItemSpending, ITEM, 'Forecast publishes the linked purchase as its own term');
  for (const compact of [true, false]) {
    const html = render(v, plan, compact);
    const block = termsBlock(html);
    const t = terms(block);
    eq(t.map(x => x.key), ['periodIncome', 'assignedBills', 'householdBudgetHold', 'savingsItemSpending', 'balanceAfterDeductions'],
      'every deducted term is printed, in order');
    t.forEach(x => eq(x.trust, 'calculated', x.key + ' is calculated'));
    const [I, B, Hh, It, R] = t.map(x => cents(x.amount));
    eq([I, B, Hh, It, R], [INCOME * 100, 0, HOLD * 100, ITEM * 100, (INCOME - HOLD - ITEM) * 100], 'printed terms match the invented inputs');
    eq(I - B - Hh - It, R, 'printed terms add up to the printed result, to the cent');
    assert.match(block, /less assigned bills, the household amount and linked savings-item spending\./); checks++;
    // The waterfall step the Budget hero reads (budget-blend TERM_SOURCES 'item').
    const step = html.match(/data-operating-question="item"[\s\S]*?<\/details>|data-operating-question="item"[\s\S]{0,1500}/);
    assert.ok(step, 'a Savings item spending step is printed'); checks++;
    assert.match(step[0], /Savings item spending/); checks++;
    assert.match(step[0], /\$100\.00/); checks++;
    const order = [...html.matchAll(/data-operating-question="([^"]+)"/g)].map(m => m[1]);
    const at = k => order.indexOf(k);
    assert.ok(at('06') < at('item') && at('item') < at('07'), 'the item step sits between household and the result: ' + order); checks++;
  }
}
{
  const { v, plan } = current(false);
  eq(Object.hasOwn(v.predictedEndingBalanceTerms, 'savingsItemSpending'), false, 'control: no item term is published');
  for (const compact of [true, false]) {
    const html = render(v, plan, compact);
    const block = termsBlock(html);
    const t = terms(block);
    eq(t.map(x => x.key), ['periodIncome', 'assignedBills', 'householdBudgetHold', 'balanceAfterDeductions'], 'control: three terms and the result');
    const [I, B, Hh, R] = t.map(x => cents(x.amount));
    eq([I, B, Hh, R], [INCOME * 100, 0, HOLD * 100, (INCOME - HOLD) * 100]);
    eq(I - B - Hh, R);
    assert.match(block, /less assigned bills and the household amount\./); checks++;
    eq(/data-operating-question="item"/.test(html), false, 'control: no item step');
  }
}
// An unavailable publication prints the item term Unavailable, never a fallback.
{
  const { v, plan } = current(true);
  const html = render({ ...v, predictedEndingBalanceTerms: { ...v.predictedEndingBalanceTerms, closes: false } }, plan, true);
  const block = termsBlock(html);
  eq(/data-bad-terms-status="unavailable"/.test(block), true);
  eq(/\$100\.00/.test(block), false, 'no item amount when the terms are unavailable');
}
console.log(`ok - savings-item spending is printed as its own Balance After Deductions term (${checks} checks)`);
