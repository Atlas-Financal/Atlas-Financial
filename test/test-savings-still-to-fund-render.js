'use strict';
// PA-2b (Decision 2; Atlas #805 assessment): the real plan.js Budget Savings
// goals list renders Forecast's row-owned stillToFund — the ESTIMATED mark and
// its reason on the figure itself — and the legacy funding-schedule join
// (missing Saved read as 0) is retired. No page-side money math: the printed
// amount is the published row figure. Historical rows print Unknown with the
// published reason; projected rows print their own period-close figure.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');

function budget() {
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const ctx = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  ctx.window = ctx; ctx.matchMedia = () => ({ matches: false, addEventListener() {} });
  for (const script of ['app', 'bill-detail', 'savings-inventory', 'budget-surface', 'plan']) {
    if (script === 'bill-detail') vm.runInContext('App.boot=()=>{};', ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'public', script + '.js'), 'utf8'), ctx);
  }
  vm.runInContext('state.targetBuffer=20;state.extraDebtMonthly=0;state.debts=[];', ctx);
  return ctx;
}
function render(mutate, start) {
  const x = input();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once', date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  if (mutate) mutate(x);
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  const ctx = budget();
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice: a, liveOverlay: null, weekly: 0, weeklyOverride: 0 };
  ctx.period = a.payPeriodViews.find(p => p.start === start) || a.pastPeriodViews.find(p => p.start === start);
  assert.ok(ctx.period, `fixture: period ${start} exists`);
  // Exactly as the page calls it: with the live funding schedule (pre-review:
  // a null schedule could not detect a reintroduced schedule join).
  return { a, html: vm.runInContext('budgetSavingsGoalsHtml(src,period,budgetMonthPlanSpendSchedule(src,true))', ctx) };
}
const cells = html => html.split('data-budget-goal-still-to-fund>').slice(1)
  .map(p => p.split('</span></span></span>')[0]);
const text = cell => cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('current period: the row-owned figure prints ESTIMATED with the Decision 2 reason on the figure', () => {
  const { html } = render(null, '2026-10-02');
  const shown = cells(html).map(text);
  // Hand-derived: 1,500 needed - 119 saved; 1,000 needed - 0 saved.
  assert.deepEqual(shown.map(s => s.split(' Needed minus Saved')[0]), ['$1,381.00', '$1,000.00']);
  for (const cell of cells(html)) {
    assert.doesNotMatch(cell, /budget-v3-est|≈|>estimated</, 'the figure prints without an estimate mark');
    assert.match(text(cell), /Needed minus Saved\. It is a planning gap, not an unpaid balance\./);
  }
  assert.match(html, /data-budget-goal-still-to-fund-amount="1381"/);
});

test('projected period: prints that period-close figure, estimated, not today\'s gap', () => {
  const { a, html } = render(null, '2026-10-30');
  const view = a.payPeriodViews.find(p => p.start === '2026-10-30');
  const close = F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id }).forecastClosing;
  const published = close.rows.map(r => r.stillToFund);
  const shown = cells(html).map(c => Number(text(c).split('$')[1].split(' ')[0].replace(/,/g, '')));
  assert.deepEqual(shown, published, 'printed amounts are exactly the published period-close row figures');
  for (const cell of cells(html)) assert.doesNotMatch(cell, /budget-v3-est|≈|>estimated</, 'projected figure prints without an estimate mark');
  assert.notDeepEqual(shown, [1381, 1000], 'not today\'s current-period gap');
});

test('historical period: Unknown with the published reason, never a borrowed number', () => {
  const { html } = render(null, '2026-09-18');
  const all = cells(html);
  assert.ok(all.length > 0, 'fixture: historical goal rows render');
  for (const cell of all) {
    assert.match(cell, /budget-v3-unknown">Unknown/);
    assert.doesNotMatch(cell, /\$/, 'no amount printed');
    // Forecast's own published reason, not the page fallback.
    assert.match(text(cell), /Still to fund is unavailable: the (goal amount needed is not a known point value|amount saved for this goal is not known)/);
  }
  assert.doesNotMatch(html, /data-budget-goal-still-to-fund-amount/);
});

test('unknown input in the current period: Unknown with the specific published reason', () => {
  const { html } = render(x => { const c = x.plan.commitments.find(r => r.id === 'b'); delete c.amount; c.amountMin = 800; c.amountMax = 1200; }, '2026-10-02');
  const shown = cells(html).map(text);
  assert.ok(shown.some(s => /^Unknown .*needed is not a known point value/.test(s)), 'ranged need: Unknown with its reason');
  assert.ok(shown.every(s => !/\$0\.00/.test(s)), 'missing input never prints as 0');
});

test('the legacy schedule join is retired', () => {
  const src = fs.readFileSync(path.join(root, 'public/plan.js'), 'utf8');
  assert.doesNotMatch(src, /budgetGoalScheduleStillToFund/);
});
