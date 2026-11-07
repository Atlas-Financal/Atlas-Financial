'use strict';
// #818 acceptance 5.7 boundary. A completed period's reconstructed Balance
// After Deductions is a Budget-page presentation marked ≈ estimated. It never
// feeds a decision surface (today's payday shell, Today cash card) or the
// period-history archive that the 1.0 two-period reality check will read.
// Invented household only (other-period-target fixture).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const fx = require('./fixtures/other-period-target');

const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
  document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
  localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
const call = (expr, vars) => { Object.assign(context, vars); return vm.runInContext(expr, context); };

const f = fx.build(618.73);
const advice = F.recommend(f.plan, f.date, { ...f.plan.defaults, debts: [], currentPeriodActuals: f.packet });
const views = advice.payPeriodViews;
const current = views.find(v => v.timelineRole === 'current');
assert.ok(current, 'fixture has a current period');
// Mark the earliest row as a completed, unqualified period with trusted terms.
const pastIndex = views.indexOf(current) > 0 ? 0 : views.indexOf(current) + 1;
const base = views[pastIndex];
// Household spending evidenced for this exact period (Atlas 6701429360),
// with the close also settlement-evidenced: income complete for the period
// and every bill settled or known-unpaid under precise coverage.
const evidenced = { source: 'Forecast.budgetPeriodProgress', start: base.start, end: base.end,
  coverage: { remainingClaim: 'precise' },
  income: { actual: { amount: 1400, trust: 'calculated', completeness: 'complete', evidence: [] } },
  bills: { actual: { amount: 0, trust: 'calculated', completeness: 'partial', evidence: [] } },
  household: { actual: { amount: 100, trust: 'calculated', completeness: 'complete' } } };
const past = { ...base, timelineRole: 'past', lookback: true, budgetProgress: evidenced,
  householdBudget: (base.householdBudget || []).map(row => row && !row.informational ? { ...row, spent: Number.isFinite(row.spent) ? row.spent : 0 } : row),
  incomeTrust: 'calculated', periodBillLoadTrust: 'calculated', budgetHoldTrust: 'calculated', balanceAfterDeductionsTrust: 'calculated' };
const untrusted = { ...past, incomeTrust: 'unknown' };
const adviceWith = row => ({ ...advice, payPeriodViews: views.map((v, i) => i === pastIndex ? row : v) });
const reconstructed = adviceWith(past), withheld = adviceWith(untrusted);

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };

// The page shows the reconstruction, as estimated only.
const shown = call('calendarWaterfallHtml(p,null,null,plan,true)', { p: past, plan: f.plan });
ok(/data-bad-historical-reconstructed/.test(shown) && /data-budget-result-trust="estimated"/.test(shown)
  && !/data-budget-result-trust="(calculated|verified)"/.test(shown), 'the completed period shows the reconstruction only as estimated');
const hidden = call('calendarWaterfallHtml(p,null,null,plan,true)', { p: untrusted, plan: f.plan });
ok(/data-bad-historical-withheld/.test(hidden) && /data-budget-result-trust="unavailable"/.test(hidden),
  'an untrusted term keeps it withheld');
// Missing spending is never zero, in both layouts (Atlas 6701429360).
for (const [label, row] of [
  ['unevidenced household spending', { ...past, budgetProgress: { ...evidenced, household: { actual: { amount: null, trust: 'unavailable', completeness: 'unavailable' } } } }],
  ['partial household spending', { ...past, budgetProgress: { ...evidenced, household: { actual: { amount: 100, trust: 'calculated', completeness: 'partial' } } } }],
  ['an unavailable coverage window', { ...past, budgetProgress: { ...evidenced, coverage: { remainingClaim: 'unavailable' } } }],
  ['no period evidence', { ...past, budgetProgress: null }],
  ['a category with no evidenced spending', { ...past, householdBudget: past.householdBudget.map((r, i) => i === 0 ? { ...r, spent: null } : r) }],
]) {
  for (const compact of [true, false]) {
    const html = call('calendarWaterfallHtml(p,null,null,plan,c)', { p: row, plan: f.plan, c: compact });
    ok(!/data-bad-historical-reconstructed/.test(html) && /data-budget-result-trust="unavailable"/.test(html),
      label + ' keeps the close Unavailable (' + (compact ? 'compact' : 'full') + ')');
  }
  const timeline = call('badTimelineHtml({ payPeriodViews: [p] }, true, null)', { p: row });
  ok(/data-bad-term-trust="unavailable"/.test(timeline), label + ': the hidden timeline row is Unavailable');
}

// Settlement evidence (execution review 6702317341): the close contradicts
// the period when its paycheque never arrived or a bill is unaccounted; a
// bill known unpaid under precise coverage, or settled by period evidence,
// keeps the estimate.
const billRow = patch => ({ id: 'invented-bill', date: base.start, actual: null, ...patch });
for (const [label, row, shows] of [
  ['income not received for the period', { ...past, budgetProgress: { ...evidenced, income: { actual: { amount: 1200, trust: 'calculated', completeness: 'partial', evidence: [] } } } }, false],
  ['income amount unknown for the period', { ...past, budgetProgress: { ...evidenced, income: { actual: { amount: null, trust: 'unavailable', completeness: 'partial', evidence: [] } } } }, false],
  ['a bill neither settled nor known-unpaid', { ...past, bills: [billRow({ status: 'still due', settlement: 'unverified' })] }, false],
  ['a bill with a contested settlement', { ...past, bills: [billRow({ status: 'planned', settlement: 'not-relied-upon' })] }, false],
  ['a bill whose date is still unknown', { ...past, bills: [billRow({ status: 'planned', settlement: 'unverified', needsDate: true })] }, false],
  ['coverage short of precise cannot prove a bill unpaid', { ...past, bills: [billRow({ status: 'planned', settlement: 'unverified' })], budgetProgress: { ...evidenced, coverage: { remainingClaim: 'posted-only' } } }, false],
  ['a bill known unpaid under precise coverage', { ...past, bills: [billRow({ status: 'planned', settlement: 'unverified' })] }, true],
  ['a bill settled by a period-evidence entry', { ...past, bills: [billRow({ status: 'still due', settlement: 'unverified' })], budgetProgress: { ...evidenced, bills: { actual: { amount: 50, trust: 'calculated', completeness: 'partial', evidence: [{ id: 'invented-bill', date: base.start, actual: 50 }] } } } }, true],
  ['a bill settled as paid on the row', { ...past, bills: [billRow({ status: 'PAID', settlement: 'represented', actual: 50 })] }, true],
]) {
  for (const compact of [true, false]) {
    const html = call('calendarWaterfallHtml(p,null,null,plan,c)', { p: row, plan: f.plan, c: compact });
    ok(shows
      ? /data-bad-historical-reconstructed/.test(html) && /data-budget-result-trust="estimated"/.test(html)
      : !/data-bad-historical-reconstructed/.test(html) && /data-budget-result-trust="unavailable"/.test(html),
      label + (shows ? ' keeps the close estimated' : ' keeps the close Unavailable') + ' (' + (compact ? 'compact' : 'full') + ')');
  }
  const timeline = call('badTimelineHtml({ payPeriodViews: [p] }, true, null)', { p: row });
  ok(shows ? /data-bad-term-trust="estimated"/.test(timeline) : /data-bad-term-trust="unavailable"/.test(timeline),
    label + ': the hidden timeline row agrees');
}

// Decision surfaces read the current period only: identical either way.
const sealed = JSON.stringify(reconstructed);
for (const [name, expr] of [
  ['payday instruction shell', 'currentPaydayShellHtml({ advice: a, plan, planPayPeriodId: id })'],
  ['Today cash card', 'budgetTodayCashCardHtml({ advice: a, plan, planPayPeriodId: id })'],
]) {
  let left, right;
  try {
    left = call(expr, { a: reconstructed, plan: f.plan, id: past.id });
    right = call(expr, { a: withheld, plan: f.plan, id: past.id });
  } catch (error) { assert.fail(name + ' threw: ' + error.message); }
  ok(typeof left === 'string' && left === right, name + ' is unchanged by the completed-period reconstruction');
  ok(!left.includes('data-bad-historical-reconstructed'), name + ' never prints the reconstruction');
}
ok(JSON.stringify(reconstructed) === sealed, 'rendering never rewrites the Forecast publication');

// The archive's capture and projection never load the page code, so a page
// reconstruction cannot reach a captured record or the reality check.
const loaded = () => Object.keys(require.cache).map(file => path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/'));
require('../scripts/private-period-history');
require('../scripts/private-period-history-postgres');
ok(!loaded().some(file => /^public\/(plan|budget-blend|budget-surface|app)\.js$/.test(file)),
  'capture and projection load no page renderer');
const { input, capture } = require('./fixtures/private-period-history-input');
const Pg = require('../scripts/private-period-history-postgres');
const record = capture(input({ day: '2030-02-15', kind: 'closing' }));
const projected = Pg.project(record);
ok(projected.content.publication.balanceAfterDeductionsTrust === record.content.publication.balanceAfterDeductionsTrust,
  'a captured close keeps Forecast\'s native trust');
ok(!JSON.stringify(projected).includes('reconstructed'), 'no page reconstruction label is captured');

console.log('PASS closed-period reconstruction stays a page presentation: ' + checks + ' checks');
