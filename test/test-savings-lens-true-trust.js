'use strict';
// Savings lens items publish their true trust word (owner decision, Dale,
// 2026-11-08: "Yes, fix both"). Forecast's savings lenses ('today' and
// 'payday') used to relabel a calculated backing requirement as 'confirmed',
// so a calculated figure reached the page as owner-confirmed. The published
// lens confidence is now the backing item's trust, verbatim, and the real
// Budget renderer prints that cost as calculated without hiding it.
// Ledger and amounts are the invented savings-future-closing fixture.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(root, 'public/forecast'));
const input = require('./fixtures/savings-future-closing-data');

const TRUST = ['calculated', 'estimated', 'unknown'];

function advice(mutate) {
  const x = input();
  x.plan.income.push({ id: 'p0', label: 'Invented current receipt', frequency: 'once',
    date: '2026-10-09', amount: 400, confidence: 'confirmed' });
  if (mutate) mutate(x);
  return { x, a: F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] }) };
}

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

// Every lens row Forecast publishes, on the sealed packet and on each period
// publication the page can select.
function lensRows(a) {
  const packets = [a.savingsFunding, ...(a.savingsFunding.periodViews || []).map(view =>
    F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id }))];
  const rows = [];
  for (const packet of packets.filter(Boolean)) for (const lens of packet.lenses || []) {
    for (const item of lens.items || []) rows.push({ lens: lens.key, kind: 'item', item, backing: packet.backing });
    for (const item of lens.unscheduled || []) rows.push({ lens: lens.key, kind: 'unscheduled', item, backing: packet.backing });
  }
  return rows;
}

test('a calculated backing requirement publishes confidence "calculated" in both lenses', () => {
  const { a } = advice();
  const calculated = a.savingsFunding.backing.items.filter(item => item.trust === 'calculated');
  assert.ok(calculated.length >= 1, 'fixture: at least one calculated backing requirement');
  for (const key of ['today', 'payday']) {
    const lens = a.savingsFunding.lenses.find(row => row.key === key);
    assert.ok(lens, `${key} lens is published`);
    for (const source of calculated) {
      const item = lens.items.find(row => row.id === source.key);
      assert.ok(item, `${key}: ${source.key} is published once`);
      assert.equal(item.confidence, 'calculated', `${key}: ${source.key} keeps its calculated trust word`);
    }
  }
});

test('no savings-lens path emits "confirmed"; every lens row carries its backing trust verbatim', () => {
  for (const [label, mutate] of [
    ['as published', null],
    ['estimated source', x => { for (const c of x.plan.commitments || []) c.confidence = 'estimated'; }],
  ]) {
    const { a } = advice(mutate);
    const rows = lensRows(a);
    assert.ok(rows.length >= 2, `${label}: fixture publishes lens rows`);
    for (const { lens, kind, item, backing } of rows) {
      assert.notEqual(item.confidence, 'confirmed', `${label} ${lens} ${kind} ${item.id}: never relabelled owner-confirmed`);
      assert.ok(TRUST.includes(item.confidence), `${label} ${lens} ${kind} ${item.id}: closed trust word (${item.confidence})`);
      if (kind === 'item') {
        const source = backing.items.find(row => row.key === item.id);
        assert.ok(source, `${label} ${lens} ${item.id}: backed by a published requirement`);
        assert.equal(item.confidence, source.trust, `${label} ${lens} ${item.id}: verbatim backing trust`);
      }
    }
    if (label === 'estimated source')
      assert.ok(rows.some(row => row.item.confidence === 'estimated'), 'estimated source stays estimated in the lens');
  }
});

test('the real Budget renderer prints a calculated lens cost as calculated and keeps the figure', () => {
  const { x, a } = advice();
  const ctx = budget();
  ctx.src = { plan: x.plan, debts: [], asOf: x.asOf, advice: a, liveOverlay: null, weekly: 0, weeklyOverride: 0, planPayPeriodId: null };
  const html = vm.runInContext('budgetUpcomingFundingHtml(src)', ctx);
  const money = n => '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let checked = 0;
  for (const key of ['today', 'payday']) {
    const tail = html.split(`data-budget-funding-panel="${key}"`)[1];
    assert.ok(tail, `${key} panel renders`);
    const panel = key === 'today' ? tail.split('data-budget-funding-panel="payday"')[0] : tail.split('<aside')[0];
    const lens = a.savingsFunding.lenses.find(row => row.key === key);
    for (const item of lens.items.filter(row => row.confidence === 'calculated')) {
      const row = panel.split(`data-budget-funding-cost="${item.id}"`)[1];
      assert.ok(row, `${key}: ${item.id} renders`);
      const head = row.split('</div>')[0];
      assert.ok(head.includes(`<span class="budget-cash-sr">calculated </span>${money(item.cost)}`),
        `${key}: ${item.id} prints its cost tagged calculated (${head})`);
      assert.ok(!/budget-v3-unknown|budget-v3-est/.test(head), `${key}: ${item.id} cost is neither hidden nor marked estimated`);
      assert.ok(!/confirmed/i.test(head), `${key}: ${item.id} cost is not presented as confirmed`);
      checked++;
    }
  }
  assert.ok(checked >= 2, `calculated lens costs were actually rendered and checked (${checked})`);
});
