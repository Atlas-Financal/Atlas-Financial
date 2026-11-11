'use strict';
/* An Unknown debt balance or asset value never becomes $0 inside a total.
 *
 * Before this change Forecast.publicationTotals summed `balance || 0` and
 * `value || 0`, and Forecast.compactSnapshot summed secured `balance || 0`.
 * With an invented line of credit whose balance is Unknown, Deep Dive printed
 * a precise "Total debt" under the note "Every consumer debt in the household
 * is now captured. Nothing outstanding.", Records printed a precise "Financial
 * accounts only", and the Plan's "Mortgage + HELOC" tile printed a precise sum
 * — while the Credit page showed the same balance as Unknown.
 *
 * Every number below is invented. Every expected string is written by hand;
 * nothing here calls the code under test to compute an expectation. The page
 * strings come from running the real page renderers (public/deepdive.js,
 * public/records.js, public/plan.js) in a VM and capturing what they write.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
let checks = 0;
const ok = (cond, label) => { assert.ok(cond, label); checks++; console.log(`  PASS  ${label}`); };
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; console.log(`  PASS  ${label}`); };

// Page formatters, written independently with the same output shape as
// public/app.js: whole dollars for money, cents for money2, U+2212 minus.
const money = n => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-CA');
const money2 = n => (n < 0 ? '−$' : '$') + Math.abs(Number(n)).toLocaleString('en-CA', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function world({ locBalance, rrspValue, helocBalance }) {
  return {
    meta: { asOf: '2026-10-14', coverage: 'Invented coverage', transactions: 1, statements: 1, disclaimer: 'Invented.' },
    debts: [
      { id: 'mortgage', label: 'Invented mortgage', balance: 400000, secured: true, annualInterest: 12000 },
      { id: 'heloc', label: 'Invented HELOC', balance: helocBalance, secured: true, annualInterest: 600 },
      { id: 'loc', label: 'Invented line of credit', balance: locBalance, confidence: 'estimated', annualInterest: 0 },
      { id: 'card-a', label: 'Invented card', balance: 1000, annualInterest: 0 },
    ],
    assets: [
      { label: 'Invented chequing', value: 500 },
      { label: 'Invented RRSP', value: rrspValue },
    ],
    plan: { startingCash: { amount: 500, breakdown: [], heldElsewhere: [] }, commitments: [] },
  };
}

// Run a page renderer and capture what it writes to one element, stopping
// right after that write so the rest of the page does not need a DOM.
function capture(file, fn, data, targetId) {
  const stop = new Error('captured');
  let html = null;
  const nodes = {};
  const ctx = { escapeHtml: require('./app-escape-html'),
    Forecast: F, console, money, money2, module: { exports: {} },
    App: { once() {}, register() {}, boot() {} },
    document: { getElementById: () => null },
    Event: function Event() {},
    $: id => {
      if (!nodes[id]) {
        nodes[id] = { dataset: {}, setAttribute() {} };
        if (id === targetId) {
          Object.defineProperty(nodes[id], 'innerHTML', { configurable: true,
            set(value) { html = value; throw stop; } });
        }
      }
      return nodes[id];
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read(file), ctx);
  try { ctx[fn](...data); } catch (e) { if (e !== stop) throw e; }
  assert.notEqual(html, null, `${file} reached #${targetId}`);
  return html;
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('=== control: every balance and value known ===');
{
  // Hand: debt 400,000 + 20,000 + 2,000 + 1,000 = 423,000.
  //       assets 500 + 1,500 = 2,000; financial 2,000 − 423,000 = −421,000.
  //       secured 400,000 + 20,000 = 420,000.
  const d = world({ locBalance: 2000, rrspValue: 1500, helocBalance: 20000 });
  const dive = text(capture('public/deepdive.js', 'renderDeepDive', [d], 'tiles'));
  ok(dive.includes('Total debt $423,000'), 'Deep Dive prints the hand total $423,000');
  ok(dive.includes('Every consumer debt in the household is now captured. Nothing outstanding.'),
    'the completeness note is kept when every balance is known');
  const rec = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec.includes('Total assets $2,000.00'), 'Records total assets $2,000.00');
  ok(rec.includes('Total known debt $423,000.00'), 'Records total known debt $423,000.00');
  ok(rec.includes('Financial accounts only −$421,000.00'), 'Records financial accounts only −$421,000.00');
  ok(!/unknown/i.test(rec), 'Records says nothing is unknown');
  const plan = text(capture('public/plan.js', 'renderPlanSettlementUnavailable', [d, 'invented'], 'snapshot-tiles'));
  ok(plan.includes('Mortgage + HELOC $420,000 secured on the home'), 'Plan tile prints the hand secured total $420,000');
}

console.log('\n=== the dispatch repro: line of credit and RRSP Unknown ===');
{
  const d = world({ locBalance: null, rrspValue: null, helocBalance: 20000 });
  const dive = text(capture('public/deepdive.js', 'renderDeepDive', [d], 'tiles'));
  ok(dive.includes('Total debt Unknown 1 debt balance is unknown, so the total is unknown.'),
    'Deep Dive prints Total debt Unknown and says one balance is unknown');
  ok(!dive.includes('Nothing outstanding'), 'Deep Dive no longer claims nothing is outstanding');
  ok(!dive.includes('$421,000') && !dive.includes('$401,000'), 'no partial debt sum is printed as the total');
  const rec = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec.includes('Invented RRSP Unknown'), 'Records prints the RRSP row as Unknown, not $0.00');
  ok(!rec.includes('$0.00'), 'Records prints no $0.00 anywhere');
  ok(rec.includes('Total assets (1 asset value unknown) Unknown'), 'Records total assets is Unknown, with the reason');
  ok(rec.includes('Total known debt (1 debt balance unknown) Unknown'), 'Records total debt is Unknown, with the reason');
  ok(/Financial accounts only \(1 asset value unknown\) \(1 debt balance unknown\) Unknown/.test(rec),
    'Records financial accounts only is Unknown, with both reasons');
  ok(!rec.includes('−$420,500.00') && !rec.includes('$500.00</strong>'), 'no partial net figure is printed');
  // The line of credit is unsecured, so the secured tile stays known.
  const plan = text(capture('public/plan.js', 'renderPlanSettlementUnavailable', [d, 'invented'], 'snapshot-tiles'));
  ok(plan.includes('Mortgage + HELOC $420,000 secured on the home'),
    'an unknown unsecured balance does not touch the secured tile');
}

console.log('\n=== a secured balance Unknown ===');
{
  const d = world({ locBalance: 2000, rrspValue: 1500, helocBalance: null });
  const plan = text(capture('public/plan.js', 'renderPlanSettlementUnavailable', [d, 'invented'], 'snapshot-tiles'));
  ok(plan.includes('Mortgage + HELOC Unknown a secured balance is unknown'),
    'Plan tile prints Mortgage + HELOC Unknown when the HELOC balance is unknown');
  ok(!plan.includes('$400,000'), 'the mortgage alone is not printed as the secured total');
  const dive = text(capture('public/deepdive.js', 'renderDeepDive', [d], 'tiles'));
  ok(dive.includes('Total debt Unknown'), 'Deep Dive total debt is Unknown too');
}

console.log('\n=== every form of missing value is Unknown; zero stays zero ===');
for (const [label, v] of [['undefined', undefined], ['empty string', ''], ['text', 'n/a'], ['NaN', NaN], ['Infinity', Infinity]]) {
  const d = world({ locBalance: v, rrspValue: v, helocBalance: v });
  const rec = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec.includes('Total known debt (2 debt balances unknown) Unknown') && rec.includes('Total assets (1 asset value unknown) Unknown'),
    `${label} is Unknown, never $0`);
}
{
  const d = world({ locBalance: 0, rrspValue: 0, helocBalance: 0 });
  const rec = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec.includes('Total known debt $401,000.00') && rec.includes('Total assets $500.00') && rec.includes('Invented RRSP $0.00'),
    'a recorded zero is a known $0, not Unknown');
}
{
  // A cash-linked asset whose cash row is missing is Unknown, not $0.
  const d = world({ locBalance: 2000, rrspValue: 1500, helocBalance: 20000 });
  d.assets.push({ label: 'Invented linked cash', cash: 'no-such-row' });
  const rec = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec.includes('Invented linked cash Unknown') && rec.includes('Total assets (1 asset value unknown) Unknown'),
    'a cash-linked asset with no cash row is Unknown');
  d.plan.startingCash.breakdown.push({ id: 'no-such-row', value: 250 });
  const rec2 = text(capture('public/records.js', 'renderRecords', [d], 'assets'));
  ok(rec2.includes('Invented linked cash $250.00') && rec2.includes('Total assets $2,250.00'),
    'once the cash row exists its value counts (hand: 500 + 1,500 + 250)');
}

console.log('\n=== positions.csv generator refuses a partial asset total ===');
{
  const { regenerateComputedRows } = require('../scripts/positions-summary.js');
  if (typeof regenerateComputedRows === 'function') {
    const d = world({ locBalance: 2000, rrspValue: null, helocBalance: 20000 });
    assert.throws(() => regenerateComputedRows(d, '', { periods: null }), /asset value\(s\) unknown/);
    checks++; console.log('  PASS  positions-summary throws instead of writing a partial total');
  }
}

console.log('\n=== interest: an Unknown annual-interest figure is never $0 ===');
{
  // Hand control: annual 12,000 + 600 + 0 + 0 = 12,600; ex-mortgage 600;
  // monthly 12,600 / 12 = 1,050; ex-mortgage 600 / 12 = 50.
  const d = world({ locBalance: 2000, rrspValue: 1500, helocBalance: 20000 });
  const dive = text(capture('public/deepdive.js', 'renderDeepDive', [d], 'tiles'));
  ok(dive.includes('Interest cost / year $12,600 $600 excluding the mortgage About $1,050 every month, of which about $50 is not the mortgage'),
    'known interest: Deep Dive prints the hand totals $12,600 / $600 / $1,050 / $50');
  const plan = text(capture('public/plan.js', 'renderPlanSettlementUnavailable', [d, 'invented'], 'snapshot-tiles'));
  ok(plan.includes('Interest cost / month $1,050 across every debt'), 'known interest: Plan tile prints $1,050');

  // The line of credit's interest is Unknown (not the mortgage).
  const u = world({ locBalance: 2000, rrspValue: 1500, helocBalance: 20000 });
  u.debts.find(x => x.id === 'loc').annualInterest = null;
  const dive2 = text(capture('public/deepdive.js', 'renderDeepDive', [u], 'tiles'));
  ok(dive2.includes('Interest cost / year Unknown Unknown excluding the mortgage 1 debt interest figure is unknown, so the interest cost is unknown.'),
    'unknown interest: Deep Dive interest tile, its ex-mortgage line and its note are Unknown');
  ok(!dive2.includes('$12,600') && !dive2.includes('$1,050'), 'no partial interest sum is printed');
  const plan2 = text(capture('public/plan.js', 'renderPlanSettlementUnavailable', [u, 'invented'], 'snapshot-tiles'));
  ok(plan2.includes('Interest cost / month Unknown a debt interest figure is unknown'), 'unknown interest: Plan tile reads Unknown');

  // Only the mortgage's interest Unknown: the ex-mortgage figure stays known.
  const m = world({ locBalance: 2000, rrspValue: 1500, helocBalance: 20000 });
  m.debts.find(x => x.id === 'mortgage').annualInterest = undefined;
  const dive3 = text(capture('public/deepdive.js', 'renderDeepDive', [m], 'tiles'));
  ok(dive3.includes('Interest cost / year Unknown $600 excluding the mortgage'),
    'unknown mortgage interest leaves the ex-mortgage $600 known');
}

console.log('\n=== the assistant packet ChatGPT answers from ===');
{
  // Invented served packet from the shared Budget fixture, with an invented
  // mortgage and HELOC added. Hand: secured 300,000 + 20,000 = 320,000;
  // monthly interest (600 + 9,000 + 1,200) / 12 = 900.
  const fx = require('./fixtures/budget-surface-data.js');
  const Assistant = require('../scripts/assistant-packet.js');
  const build = ({ heloc, helocInterest }) => {
    const data = fx.served();
    data.debts[0].annualInterest = 600;
    data.debts.push(
      { id: 'mortgage', label: 'Invented mortgage', secured: true, balance: 300000, annualInterest: 9000 },
      { id: 'heloc', label: 'Invented HELOC', secured: true, balance: heloc, annualInterest: helocInterest, limit: 50000 });
    return Assistant.buildPacket({ data, periods: null, questionsMarkdown: '', now: '2026-08-20T18:00:00.000Z', env: {} })
      .current.debts;
  };
  const known = build({ heloc: 20000, helocInterest: 1200 });
  eq([known.securedDebt, known.monthlyInterest], [320000, 900], 'known: packet securedDebt 320,000 and monthlyInterest 900');
  const unknownBalance = build({ heloc: null, helocInterest: 1200 });
  eq(unknownBalance.securedDebt, null, 'unknown HELOC balance: packet securedDebt is null, not 300,000');
  eq(unknownBalance.monthlyInterest, 900, 'and monthly interest is unaffected by a balance');
  const unknownInterest = build({ heloc: 20000, helocInterest: null });
  eq(unknownInterest.monthlyInterest, null, 'unknown HELOC interest: packet monthlyInterest is null, not 800');
  eq(unknownInterest.securedDebt, 320000, 'and secured debt is unaffected by an interest figure');
}

console.log(`\n${checks} checks passed`);
