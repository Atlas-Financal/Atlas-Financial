'use strict';
/* The waterfall's Credit dropdown (owner, Dale, 2026-11-20): "only showing what minimums are due that pay period. And once
 * that minimum is paid I want a check mark here as well."
 *
 *   - Its rows are exactly Forecast's stackSummary.bills.cardMinimums for the selected period: a card with no minimum due
 *     in the period has no row.
 *   - A row carries a check exactly when the Credit block's one reading (StackCredit.line, Forecast.stackCreditLines)
 *     publishes that card's minimumCovered.value as true, joined by debt id. Soft when that coverage is estimated. None
 *     for false or 'unknown', none in a projected or future period, none without a published coverage.
 *   - Amounts and the Credit total are unchanged.
 *
 * Driven through the rendered waterfall with the real shell, waterfall and Credit block. Invented ids, names and amounts.
 * `node test/test-stack-credit-minimum-checks.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function load(waterfallSource = read('public/stack-waterfall.js')) {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  ctx.StackBlocks.register = (name, fn) => { fns[name] = fn; register(name, fn); };
  vm.runInContext(waterfallSource, ctx);
  vm.runInContext(read('public/stack-credit.js'), ctx);
  return fns;
}
const fig = (amount, trust = 'calculated') => ({ amount, trust, reasons: [] });
const covered = (value, trust = 'calculated') => ({ value, trust, reasons: [] });
const line = (id, cov) => ({ id, label: 'Forecast ' + id, paid: fig(1), spent: fig(1), net: fig(0), minimum: fig(10), toGo: fig(0),
  state: 'x', status: 'paid-back', minimumCovered: cov, balance: fig(null), transactions: [] });

// Invented period: three minimums due (cardA paid, cardB not yet, cardE paid on an estimated check), the HELOC's cash
// minimum with no published coverage, and cardC whose minimum is not due this period although its coverage reads true.
const LINES = [line('cardA', covered(true)), line('cardB', covered(false)), line('cardC', covered(true)),
  line('cardD', covered('unknown')), line('cardE', covered(true, 'estimated')), line('heloc', covered('unknown'))];
function view(over = {}) {
  return Object.assign({ start: '2031-03-01', end: '2031-03-14', timelineRole: 'current',
    stackSummary: { bills: { mortgage: 0, other: 0, trust: 'calculated',
      cardMinimums: [{ debtId: 'cardA', amount: 25 }, { debtId: 'cardB', amount: 30 }, { debtId: 'cardD', amount: 15 },
        { debtId: 'cardE', amount: 12 }, { debtId: 'heloc', amount: 210 }] },
      surplus: { amount: 1, terms: { income: 1, bills: 0, household: 0, mortgage: 0, credit: 292 }, trust: 'calculated' } } }, over);
}
function render(v, { lines = LINES, source } = {}) {
  const fns = load(source);
  const el = { innerHTML: '', addEventListener: () => {}, querySelector: () => null };
  fns.waterfall(el, { data: { debts: [], meta: { asOf: '2031-03-10' }, liveOverlay: null }, plan: {},
    recommendation: { payPeriodViews: [v] }, selectedPeriodKey: v.start,
    Forecast: lines ? { cardPeriodMovements: () => ({}), stackCreditLines: () => ({ lines, totals: { completeness: 'complete' } }) } : null });
  const rows = Object.fromEntries([...el.innerHTML.matchAll(/<li class="wf-card" data-row="card" data-debt-id="([^"]*)">([\s\S]*?)<\/li>/g)]
    .map(m => [m[1], m[2]]));
  return { html: el.innerHTML, rows };
}
const CHECK = /<span class="wf-check( stack-est)?" role="img" aria-label="Minimum paid(, estimated)?">✓<\/span>/;

console.log('1. Only the minimums due this pay period');
{
  const { rows } = render(view());
  ok(JSON.stringify(Object.keys(rows)) === '["cardA","cardB","cardD","cardE","heloc"]', 'the rows are exactly the period\'s cardMinimums, in order',
    JSON.stringify(Object.keys(rows)));
  ok(!('cardC' in rows), 'a card with no minimum due this period has no row, even with a covered check published');
}

console.log('2. A check once the minimum is paid');
{
  const { html, rows } = render(view());
  ok(CHECK.test(rows.cardA) && !/stack-est/.test(rows.cardA.match(CHECK)[0]), 'due and covered (calculated): a plain check', rows.cardA);
  ok(!CHECK.test(rows.cardB), 'due but not covered: no check');
  ok(!CHECK.test(rows.cardD), 'coverage unknown: no check');
  ok(CHECK.test(rows.cardE) && /stack-est/.test(rows.cardE.match(CHECK)[0]), 'covered on an estimated check: a soft check');
  ok(/aria-label="Minimum paid">/.test(rows.cardA) && /aria-label="Minimum paid, estimated">/.test(rows.cardE),
    'the accessible name says "estimated" exactly for the soft check');
  ok(!CHECK.test(rows.heloc), 'the HELOC with no published coverage: no check');
  ok(/\$25\.00/.test(rows.cardA) && /\$30\.00/.test(rows.cardB) && /\$210\.00/.test(rows.heloc), 'each row keeps its published amount');
  ok((html.match(/✓/g) || []).length === 2, 'exactly two checks in the dropdown');
}

console.log('3. Never guessed');
{
  ok(!CHECK.test(render(view({ timelineRole: 'future' })).html), 'a future period: no check');
  ok(!CHECK.test(render(view({ evidenceState: 'projected' })).html), 'a projected period: no check');
  ok(!CHECK.test(render(view(), { lines: null }).html), 'no Credit reading (no Forecast): no check, and the rows still show');
  ok(Object.keys(render(view(), { lines: null }).rows).length === 5, 'the due rows are unchanged without a reading');
  const byName = [line('Forecast cardB', covered(true))];
  ok(!CHECK.test(render(view(), { lines: byName }).html), 'a line whose id differs is never matched by its name');
}

console.log('4. Mutants are caught');
{
  const src = read('public/stack-waterfall.js');
  const truthy = src.replace('if (!covered || covered.value !== true) return \'\';', 'if (!covered || !covered.value) return \'\';');
  assert.notEqual(truthy, src);
  ok(CHECK.test(render(view(), { source: truthy }).rows.cardD), 'reading coverage as truthy (a check for \'unknown\') is caught');
  const noFuture = src.replace("if (!view || view.timelineRole === 'future' || view.evidenceState === 'projected') return '';", "if (!view) return '';");
  assert.notEqual(noFuture, src);
  ok(CHECK.test(render(view({ timelineRole: 'future' }), { source: noFuture }).html), 'dropping the projected-period guard is caught');
}

console.log(`\nAll ${checks} credit minimum check checks passed`);
