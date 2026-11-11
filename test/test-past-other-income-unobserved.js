'use strict';
// A completed period the bank data does not cover never prints Other income as
// a confident $0.00 (#821 finish-line audit, finding 13 class; the household
// hold was fixed in #1062). Invented data only; every expectation is written
// by hand.
//   - Forecast: a lookback period whose actuals the packet cannot cover
//     publishes otherIncome { amount: null, items, unavailable: true }.
//     Available, Balance After Deductions and the period income are unchanged.
//   - Page (plan.js calendarIncomeHtml, through calendarWaterfallHtml): the
//     Other income line reads Unavailable with a note, never $0.00, and an
//     income section with nothing named never says "No income in this period".
//   - Controls: the completed period inside the window, the current period and
//     the plan-only view (no packet) keep a known 0.
// `node test/test-past-other-income-unobserved.js`
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
const incomeHtml = period => { context.p = period; return vm.runInContext('calendarIncomeHtml(p)', context); };
const waterfall = (period, plan, compact) => {
  context.p = period; context.plan = plan;
  return vm.runInContext('calendarWaterfallHtml(p,null,null,plan,' + compact + ')', context);
};
let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const views = (f, packet) => F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [],
  ...(packet === undefined ? { currentPeriodActuals: f.packet } : packet ? { currentPeriodActuals: packet } : {}) }).payPeriodViews;
const otherLine = html => { const at = html.indexOf('data-other-income'); return at < 0 ? '' : html.slice(at, at + 700); };

// Fixture: observed Oct 4, fetch window from Sep 10; pay periods start Jul 3,
// Jul 17, Jul 31, Aug 14, Aug 28 (completed, before or straddling the window),
// Sep 11 (completed, inside the window), Sep 25 (current).
const f = fx.build(618.73);
const all = views(f);
const OLDER = ['2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14', '2026-08-28'];
for (const start of OLDER) {
  const v = all.find(p => p.start === start);
  ok(v && v.timelineRole === 'past', start + ': completed period exists');
  ok(v.otherIncome.amount === null && v.otherIncome.unavailable === true,
    start + ': Other income is published unobserved (null), not 0');
  ok(v.available === 1400 && v.balanceAfterDeductions === 1400 && v.incomeTrust === 'calculated',
    start + ': available 1,400, BAD 1,400 and income trust are unchanged');
  const line = otherLine(incomeHtml(v));
  ok(/Unavailable/.test(line) && !/\$0\.00/.test(line), start + ': the Other income line reads Unavailable, never $0.00');
  ok(/data-other-income-unobserved/.test(incomeHtml(v)), start + ': the page says why');
  for (const compact of [false, true]) {
    const html = waterfall(v, f.plan, compact);
    ok(!/Other income<\/span><span>\$0\.00/.test(html), start + (compact ? ' compact' : ' full') + ': no $0.00 Other income on the page');
  }
}

// Controls: covered periods keep a known zero (true zero: no unlinked credit).
for (const start of ['2026-09-11', '2026-09-25']) {
  const v = all.find(p => p.start === start);
  ok(v.otherIncome.amount === 0 && v.otherIncome.unavailable === undefined, start + ': covered period keeps Other income 0');
  ok(/Other income<\/span><span>\$0\.00/.test(incomeHtml(v)), start + ': covered period still prints $0.00 (a true zero)');
}
const inWindow = all.find(p => p.start === '2026-09-11');
ok(inWindow.balanceAfterDeductions === 1316.86 && inWindow.budgetHold === 83.14,
  'control: the in-window completed period keeps hold 83.14 and BAD 1,316.86');

// Plan-only view (no observation): nothing is claimed observed, so nothing
// changes; the incumbent plan-only shape stays.
for (const v of views(f, null).filter(p => p.timelineRole === 'past')) {
  ok(v.otherIncome.amount === 0 && v.otherIncome.unavailable === undefined, v.start + ': plan-only view unchanged');
}

// An observed credit inside the straddling period stays listed; the total is
// still unknown, because the days before the window are not observed.
// The fixture has no category list, so the sanitizer cannot mark the credit
// as income; set the sanitized isIncome flag the real category list would.
const credit = fx.build(618.73, fx.asOf, { extraTx: [{ date: '2026-09-10', amount: -50, categoryLabel: 'Income' }] });
credit.packet.transactions.find(t => t.date === '2026-09-10' && Number(t.amount) === -50).isIncome = true;
const straddle = views(credit).find(p => p.start === '2026-08-28');
ok(straddle.otherIncome.amount === null && straddle.otherIncome.items.length === 1,
  'straddling period: the observed credit is listed and the total stays unknown');
ok(straddle.available === 1450, 'straddling period: available still counts the observed 50 (1,400 + 50), as before');
const sline = otherLine(incomeHtml(straddle));
ok(/class="other-income-tx"/.test(sline) && /data-other-income-amount>Unavailable/.test(sline)
  && /data-other-income-total>Unavailable/.test(incomeHtml(straddle)),
'straddling period: the credit is shown and its total reads Unavailable');

// "No income in this period" is never claimed for an unobserved period.
const bare = { ...all.find(p => p.start === '2026-08-14'), income: [] };
ok(!/No income in this period/.test(incomeHtml(bare)) && /Unavailable/.test(otherLine(incomeHtml(bare))),
  'an unobserved period with nothing named does not say "No income in this period"');
const bareCovered = { ...inWindow, income: [] };
ok(/No income in this period/.test(incomeHtml(bareCovered)), 'control: a covered period with nothing still says so');

console.log(`All past-period Other income checks passed (${checks}).`);
