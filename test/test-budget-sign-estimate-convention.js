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

// 2. periodBillLine: estimated signed amount uses the ≈ marker; the rendered
// figure itself is pinned in test-bill-detail-budget-integration.js.
eq(planSource.includes("const about = amountTrust === 'estimated' && amount != null ? '≈ ' : '';"), true, 'bill line uses ≈');

// 3. Step 05 caption states it is before the household budget.
eq(planSource.includes("note: 'Period income after the bill deduction, before the household budget'"), true, 'step 05 caption');
eq(planSource.includes("compactNote: 'Before the household budget'"), true, 'step 05 caption on the compact Budget page');

// 4 + 5. Card movements note and the HELOC fallback label, amounts untouched.
const fmt = { money: v => '$' + v.toFixed(2), date: v => v };
const publish = x => F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
  { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay || null });
const x = fixture(), pub = publish(x);
const html = View.html(pub, fmt);
eq((html.match(/data-card-movement-sign-note>A \+ amount raises the card balance; a − amount lowers it\./g) || []).length, pub.cards.length, 'sign note in every card panel');
const h = helocFixture ? helocFixture() : null;
if (h) {
  const unlabeled = copy(h);
  for (const tx of unlabeled.packet.transactions) delete tx.displayedPayee;
  const row = publish(unlabeled).cards.find(c => c.id === 'heloc');
  const rowsOf = r => [...r.posted, ...r.pending];
  eq(rowsOf(row).every(tx => tx.payee === 'Transaction'), true, 'HELOC fallback payee is "Transaction"');
  const card = publish(unlabeled).cards.find(c => c.id !== 'heloc' && rowsOf(c).length);
  if (card) eq(rowsOf(card).every(tx => tx.payee === 'Card transaction'), true, 'card fallback payee unchanged');
  eq(View.html(publish(h), fmt).includes('A + amount raises the HELOC balance'), true, 'HELOC note names the HELOC');
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
  const norm = s => s.replace(/<p class="card-movement-note" data-card-movement-sign-note>[^<]*<\/p>\s*/g, '');
  const mainView = { exports: {} };
  vm.runInNewContext(mainFiles[1], { module: mainView, console });
  eq(norm(View.html(pub, fmt)).replace(/\s+/g, ''), norm(mainView.exports.html(pub, fmt)).replace(/\s+/g, ''), 'panel HTML equals main except the sign note (stripped from both, so it holds once main has it too)');
}
console.log('PASS budget sign and estimate convention (' + checks + ' checks)');
