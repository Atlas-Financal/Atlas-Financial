'use strict';
// One sign and estimate convention on the Budget page. Wording only: each
// string is proved on invented input, and the amounts, tags and kinds are
// pinned to independently written invented values (and, where the main
// branch is reachable, to main's output on the same fixture).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execSync } = require('node:child_process');
const F = require('../public/forecast');
const Detail = require('../public/bill-detail');
const View = require('../public/budget-card-movements');
const { fixture, copy, helocFixture } = require('./fixtures/card-period-movements-data');
let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

function loadPlan(source) {
  const context = vm.createContext({ Forecast: F, BillDetail: Detail, console, served: {}, period: {},
    document: { addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; }, documentElement: { dataset: {}, style: {} } },
    window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/' }, addEventListener() {} });
  vm.runInContext(fs.readFileSync(require.resolve('../public/app.js'), 'utf8'), context);
  vm.runInContext(`App.boot = () => {}; App.once = () => {}; App.register = () => {};`, context);
  vm.runInContext(source, context);
  return context;
}
const planSource = fs.readFileSync(require.resolve('../public/plan.js'), 'utf8');
const ctx = loadPlan(planSource);
const present = row => { ctx.row = row; return vm.runInContext('budgetCategoryPresentation(row)', ctx); };

// 1. Category row: a negative remaining prints its magnitude plus "over".
const base = { spent: 130, planned: 100, trust: 'calculated' };
const negative = present({ ...base, remaining: -30 });
eq([negative.kind, negative.label.includes('−'), /\$30\.00 over$/.test(negative.label), negative.label.includes('remaining')],
  ['over', false, true, false], 'negative remaining reads as magnitude + over');
eq(present({ ...base, remaining: -30, trust: 'estimated', confidence: 'estimated' }).label.includes('≈'), true, 'estimate marker kept');
eq(/\$30\.00 over$/.test(present({ ...base, remaining: 0, overspend: 30 }).label), true, 'published overspend branch unchanged');
eq(/\$20\.00 left$/.test(present({ ...base, remaining: 20 }).label), true, 'positive remaining still "left"');
eq(present({ ...base, remaining: 0 }).label, 'All used', 'zero remaining unchanged');
eq([present({ ...base, remaining: -30 }).spentKnown, present({ ...base, remaining: -30 }).trust], [true, null], 'tag unchanged');

// 2. periodBillLine keeps its "about" prefix (owner preference 2026-11-11: no new ≈ marks).
eq(planSource.includes("const about = amountTrust === 'estimated' && amount != null ? 'about ' : '';"), true, 'bill line keeps about');

// Owner decision 2026-11-11: no added explainer lines (no step 05 caption, no card sign note).
eq(planSource.includes('before the household budget'), false, 'no step 05 explainer caption');
eq(planSource.includes('compactNote'), false, 'no compact step caption');

// 4. The HELOC fallback label, amounts untouched; no card sign note.
const fmt = { money: v => '$' + v.toFixed(2), date: v => v };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay || null });
const x = fixture(), pub = publish(x);
const html = View.html(pub, fmt);
eq(html.includes('data-card-movement-sign-note') || html.includes('raises the card balance'), false, 'no sign explainer in the card panels');
const h = helocFixture ? helocFixture() : null;
if (h) {
  const unlabeled = copy(h);
  for (const tx of unlabeled.packet.transactions) delete tx.displayedPayee;
  const row = publish(unlabeled).cards.find(c => c.id === 'heloc');
  const rowsOf = r => [...r.posted, ...r.pending];
  eq(rowsOf(row).every(tx => tx.payee === 'Transaction'), true, 'HELOC fallback payee is "Transaction"');
  const card = publish(unlabeled).cards.find(c => c.id !== 'heloc' && rowsOf(c).length);
  if (card) eq(rowsOf(card).every(tx => tx.payee === 'Card transaction'), true, 'card fallback payee unchanged');
  // Amounts, kinds, directions and tags are the invented values, unchanged.
  const labeled = publish(h).cards.find(c => c.id === 'heloc');
  eq(rowsOf(row).map(t => [t.amount, t.direction, t.pending]), rowsOf(labeled).map(t => [t.amount, t.direction, t.pending]), 'label-only: amounts/directions/pending identical');
  // Kinds on the unlabeled input are the invented, independently written values
  // (the classifier reads the payee text, so kinds are compared on this input only).
  eq(rowsOf(row).map(t => [t.amount, t.kind]), [[500, 'movement-unconfirmed'], [-600, 'payment'], [125.35, 'interest'], [900, 'movement-unconfirmed']], 'kinds and amounts on the unlabeled HELOC input');
  eq(JSON.stringify(row.netChange), JSON.stringify(labeled.netChange), 'net change and tag identical');
}

// Same-fixture comparison against main, when main is reachable.
let mainFiles = null;
try {
  mainFiles = ['public/forecast-card-period.js', 'public/budget-card-movements.js'].map(f => execSync('git show origin/main:' + f, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString());
} catch { /* shallow checkout: the pinned invented values above still stand */ }
if (mainFiles) {
  const mainView = { exports: {} };
  vm.runInNewContext(mainFiles[1], { module: mainView, console });
  // The "as of <date>" note on a stale manual-statement card face (its own PR)
  // is stripped from both sides, so this comparison holds whether or not main has it.
  const noAsOf = html => html.replace(/ <small class="card-movement-asof" data-card-movement-asof>[^<]*<\/small>/g, '').replace(/\s+/g, '');
  eq(noAsOf(View.html(pub, fmt)), noAsOf(mainView.exports.html(pub, fmt)), 'panel HTML equals main');
}
console.log('PASS budget sign and estimate convention (' + checks + ' checks)');
