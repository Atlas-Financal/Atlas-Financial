'use strict';
/* Stack page: a household budget category sheet prints the figures Forecast published for it, and nothing else
 * (C1 S4 B1: the replacement proof for the classic Household Budget markup assertions about Spent, Planned and
 * Remaining, which retire with the classic page).
 *
 *   1. hand-built rows: spent / budget in the headline and Left (or Over) as published, to the whole dollar;
 *   2. a figure Forecast did not publish prints nothing: never $0, and never a number made from other data (the live
 *      overlay's transactions, a recon list) when Spent is withheld; a published $0 prints $0;
 *   3. on every invented figures input, every household budget row of every pay period: the printed Spent, budget and
 *      Left or Over equal the published values, formatted independently here (whole dollars, half away from zero);
 *   4. mutation: the sheet source with each of six figure-affecting breaks fails this test (so the proof can fail).
 *
 * The transaction list under a sheet is test-stack-budget-transactions. Invented data only.
 * `node test/test-stack-budget-sheet-figures.js` */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function loadWith(sheetSource) {
  const ctx = { console: { log() {}, warn() {}, error() {}, info() {} }, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  vm.runInContext(sheetSource, ctx);
  return ctx;
}
const sheetFor = win => (view, id, extra = {}) => win.StackSheet.html(
  Object.assign({ recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start }, extra), 'budget:' + id);

// The independent formatter: a published number to whole dollars, half away from zero, a true minus, '' for anything
// that is not a published number. Written here so the sheet's own formatter is not the oracle.
const whole = v => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const cents = Math.round(Math.abs(v) * 100);
  const dollars = Math.floor(cents / 100) + (cents % 100 >= 50 ? 1 : 0);
  const text = '$' + dollars.toLocaleString('en-CA');
  return dollars === 0 ? text : (v < 0 ? '−' : '') + text;
};
// What the sheet printed: the headline's Spent and budget, and the one row below it (Left or Over).
function printed(html) {
  const big = /<div class="stack-sheet-big stack-n"><span[^>]*>([^<]*)<\/span>(?:<i[^>]*> \/ ([^<]*)<\/i>)?<\/div>/.exec(html);
  const dts = [...html.matchAll(/<div><dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd><\/div>/g)].map(m => [m[1], m[2]]);
  return { spent: big ? big[1] : null, budget: big ? (big[2] == null ? '' : big[2]) : null, rows: dts };
}
const view = (rows, over = {}) => Object.assign({ start: '2031-03-01', householdBudget: rows }, over);
const row = (over = {}) => Object.assign({ id: 'groceries', label: 'Groceries', spent: 75.75, planned: 500, remaining: 424.25, overspend: 0 }, over);
const expected = r => {
  const over = typeof r.overspend === 'number' && r.overspend > 0;
  return { spent: whole(r.spent), budget: typeof r.planned === 'number' ? whole(r.planned) : '',
    rows: over ? [['Over', whole(r.overspend)]] : (whole(r.remaining) ? [['Left', whole(r.remaining)]] : []) };
};

// Every claim of this test, as a list of problems for a given sheet source ([] means the sheet printed exactly what
// Forecast published). Run on the real sheet, and again on each mutant, which must produce at least one.
function problems(sheetSource) {
  const win = loadWith(sheetSource);
  const sheet = sheetFor(win);
  const bad = [];
  const check = (what, r, extra) => {
    const got = printed(sheet(view([r]), r.id, extra));
    const want = expected(r);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(what + ': printed ' + JSON.stringify(got) + ' expected ' + JSON.stringify(want));
  };
  check('published', row());
  check('half away from zero', row({ spent: 2.5, planned: 7.5, remaining: 5 }));
  check('refund-negative remaining', row({ spent: 600, planned: 500, remaining: -100, overspend: 0 }));
  check('over budget', row({ spent: 1100, planned: 900, remaining: 0, overspend: 200 }));
  check('published zero spent', row({ spent: 0, planned: 900, remaining: 900, recon: [] }));
  check('spent withheld (null)', row({ spent: null, planned: 900, remaining: 900, withheldReason: 'coverage lost' }));
  check('no plan published', row({ planned: null, remaining: null }));
  // The live overlay's transactions and a recon list are in the context, but Spent is withheld: nothing printed is
  // made from them (the classic page summed overlay rows into a list; the Stack page reads Forecast's figures only).
  const overlay = { data: { liveOverlay: { currentPeriodActuals: { transactions: [{ id: 'tx-o', amount: 61.37, date: '2031-03-05' }] } } } };
  check('withheld Spent beside overlay transactions', row({ spent: null, planned: 900, remaining: 900, withheldReason: 'coverage lost',
    recon: [{ date: '2031-03-05', amount: 61.37, displayedPayee: 'Overlay shop', pending: false }], reconMatchesSpent: true }), overlay);
  return bad;
}

const sheetSource = read('public/stack-sheet.js');

console.log('1. Published rows print as published');
{
  const win = loadWith(sheetSource); const sheet = sheetFor(win);
  const p = printed(sheet(view([row()]), 'groceries'));
  ok(p.spent === '$76' && p.budget === '$500' && JSON.stringify(p.rows) === '[["Left","$424"]]', 'Spent, budget and Left print as published, to the whole dollar', JSON.stringify(p));
  const over = printed(sheet(view([row({ spent: 1100, planned: 900, remaining: 0, overspend: 200 })]), 'groceries'));
  ok(JSON.stringify(over.rows) === '[["Over","$200"]]', 'an overspent category prints Over with the published overspend and no Left row', JSON.stringify(over));
}

console.log('2. An unpublished figure prints nothing');
{
  const win = loadWith(sheetSource); const sheet = sheetFor(win);
  const withheld = printed(sheet(view([row({ spent: null, planned: 900, remaining: 900, withheldReason: 'coverage lost' })]), 'groceries'));
  ok(withheld.spent === '' && withheld.budget === '$900', 'a withheld Spent prints nothing (not $0), beside the published budget', JSON.stringify(withheld));
  const overlay = { data: { liveOverlay: { currentPeriodActuals: { transactions: [{ id: 'tx-o', amount: 61.37 }] } } } };
  const html = sheet(view([row({ spent: null, planned: 900, remaining: 900, withheldReason: 'coverage lost' })]), 'groceries', overlay);
  ok(!/61|\$39|\$839/.test(html.replace(/<[^>]*>/g, ' ')), 'no number made from the live overlay\'s transactions appears when Spent is withheld');
  const zero = printed(sheet(view([row({ spent: 0, planned: 900, remaining: 900, recon: [] })]), 'groceries'));
  ok(zero.spent === '$0', 'a published $0 prints $0', JSON.stringify(zero));
  const noPlan = printed(sheet(view([row({ planned: null, remaining: null })]), 'groceries'));
  ok(noPlan.budget === '' && noPlan.rows.length === 0, 'an unpublished budget and Left print nothing', JSON.stringify(noPlan));
}

console.log('3. Every household budget row on every invented figures input');
{
  const F = require('../public/forecast.js');
  const Snap = require('../scripts/figures-snapshot.js');
  const win = loadWith(sheetSource); const sheet = sheetFor(win);
  let rows = 0, withheldRows = 0, overRows = 0;
  for (const inp of Snap.loadInventedInputs()) {
    const data = structuredClone(inp.doc.data);
    const rec = F.recommend(data.plan, data.meta.asOf, Snap.pageOptions(data, inp.doc.periods == null ? null : structuredClone(inp.doc.periods)));
    for (const v of rec.payPeriodViews) {
      for (const item of Array.isArray(v.householdBudget) ? v.householdBudget : []) {
        if (!item || item.id == null) continue;
        const html = sheet(JSON.parse(JSON.stringify(v)), item.id);
        if (html == null) continue;
        const got = printed(html), want = expected(item);
        assert.deepStrictEqual(got, want, `${inp.id} ${v.start} ${item.id}`);
        rows++;
        if (typeof item.spent !== 'number') withheldRows++;
        if (item.overspend > 0) overRows++;
      }
    }
  }
  ok(rows >= 50, 'the corpus has many rows, so the comparison is not vacuous (' + rows + ' rows, ' + withheldRows + ' with Spent unpublished, ' + overRows + ' over budget)');
  ok(withheldRows > 0 || overRows > 0, 'the corpus includes unpublished-Spent or over-budget rows');
}

console.log('4. The proof can fail');
{
  ok(problems(sheetSource).length === 0, 'the real sheet prints exactly what the hand-built cases publish');
  const mutants = [
    ['Spent drawn from the plan', 'esc(money(item.spent))', 'esc(money(item.planned))'],
    ['the budget drawn from Spent', '/ ${esc(money(item.planned))}', '/ ${esc(money(item.spent))}'],
    ['Left drawn from Spent', "row('Left', money(item.remaining), rest)", "row('Left', money(item.spent), rest)"],
    ['Over drawn from the remaining', "row('Over', money(item.overspend), rest)", "row('Over', money(item.remaining), rest)"],
    ['an unpublished Spent printed as $0', 'esc(money(item.spent))', 'esc(money(item.spent || 0))'],
    ['Over and Left swapped', "(over ? row('Over', money(item.overspend), rest) : row('Left', money(item.remaining), rest))",
      "(over ? row('Left', money(item.remaining), rest) : row('Over', money(item.overspend), rest))"],
  ];
  for (const [what, from, to] of mutants) {
    assert.ok(sheetSource.split(from).length === 2, 'the mutation target appears once: ' + what);
    const found = problems(sheetSource.replace(from, to));
    ok(found.length > 0, 'a sheet with ' + what + ' fails this test', found[0] ? found[0].slice(0, 90) : '');
  }
}

console.log(`test-stack-budget-sheet-figures: ${checks} checks passed`);
