'use strict';
/* B5, one visual trust treatment across the Stack page: checked in CI without a browser, on invented data only.
 *
 * Owner: no text labels, no dotted underlines; an estimated figure must never look verified. The shell's one rule
 * (StackBlocks.isEstimated / estClass): a figure whose published trust is 'estimated', or any figure of a pay period
 * Forecast publishes as projected (evidenceState 'projected'), carries the class stack-est; nothing else does.
 *
 *   1. The rule itself: estimated and projected only; calculated, verified, unknown, unavailable and absent never.
 *   2. Waterfall (an actual period, mixed trust): exactly the rows whose published trust is estimated carry the class.
 *   3. Waterfall (a projected period): every printed figure carries it.
 *   4. Credit card and its sheet: exactly the figures read from estimated paid / spent / toGo / minimum / totals.
 *   5. Bill and budget sheets: from displayAmountTrust, spentTrust, plannedTrust and trust.
 *   6. No rendered text says "estimated", "projected" or "≈", and no rule underlines (owner).
 *   7. The shell's chips and every block read the one rule (no block decides trust on its own).
 * The expected sets below are written by hand from the invented world, not computed by the code under test.
 * `node test/test-stack-trust.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function load() {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  ctx.StackBlocks.register = (name, fn) => { fns[name] = fn; register(name, fn); };
  for (const f of ['waterfall', 'credit', 'sheet']) vm.runInContext(read(`public/stack-${f}.js`), ctx);
  return { win: ctx, fns };
}
const container = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const fig = (amount, trust) => ({ amount, trust, reasons: [] });
// Every element carrying a class attribute, as [classList, its own text] pairs (outer tag, then inner text).
const classed = html => [...html.matchAll(/<(\w+)[^>]*class="([^"]*)"[^>]*>([^<]*)/g)].map(m => ({ cls: m[2].split(/\s+/), text: m[3] }));

// An invented actual period: income mixed, bills calculated, budget hold estimated, surplus estimated.
function view(evidenceState) {
  return {
    start: '2031-03-01', end: '2031-03-14', role: 'active', evidenceState,
    budgetHold: 900, budgetHoldTrust: 'estimated',
    stackSummary: {
      income: { dale: fig(2000, 'calculated'), amanda: fig(1500, 'estimated'), other: fig(100, 'calculated'), total: fig(3600, 'estimated') },
      bills: { mortgage: 1200, cardMinimums: [{ debtId: 'travelvisa', amount: 25 }], other: 300, trust: 'calculated' },
      surplus: { amount: 1175, terms: { credit: 25 }, trust: 'estimated', projected: evidenceState === 'projected' },
    },
    bills: [
      { id: 'water', date: '2031-03-05', label: 'Water', amount: 64, displayAmountTrust: 'estimated', paidState: 'not-paid', payerLabel: 'Chequing' },
      { id: 'power', date: '2031-03-06', label: 'Power', amount: 80, displayAmountTrust: 'calculated', paidState: 'paid', payerLabel: 'Chequing' },
    ],
    householdBudget: [{ id: 'groceries', label: 'Groceries', spent: 310, spentTrust: 'calculated', planned: 500, plannedTrust: 'estimated',
      remaining: 190, trust: 'estimated', overspend: 0 },
    // Forecast's real producer shapes (public/forecast.js): a carried Lunch Money budget publishes only the row's trust;
    // a possible duplicate publishes the row estimated with a calculated plan and no spentTrust.
    { id: 'carried', label: 'Dining', spent: 120, planned: 200, remaining: 80, overspend: 0, trust: 'estimated', estimateReason: 'x' },
    { id: 'dup', label: 'Pharmacy', spent: 45, planned: 60, remaining: 15, overspend: 0, trust: 'estimated', plannedTrust: 'calculated', estimateReason: 'possible-duplicate' },
    // An Other spending row: its plan is the owner's undated target, never estimated by the row.
    { id: 'other', label: 'Other spending', spent: 90, planned: 150, remaining: 60, overspend: 0, trust: 'estimated', otherSpending: true },
    { id: 'firm', label: 'Fuel', spent: 70, planned: 100, remaining: 30, overspend: 0, trust: 'calculated' }],
  };
}
const LINES = [
  { id: 'travelvisa', label: 'Blue Visa', paid: fig(400, 'calculated'), spent: fig(400, 'calculated'), minimum: fig(25, 'calculated'),
    toGo: fig(0, 'calculated'), status: 'paid-back', minimumCovered: { value: true, trust: 'calculated' }, transactions: [] },
  { id: 'cashback', label: 'Green Card', paid: fig(100, 'calculated'), spent: fig(260, 'estimated'), minimum: fig(30, 'estimated'),
    toGo: fig(160, 'estimated'), status: 'to-go', minimumCovered: { value: false, trust: 'estimated' }, transactions: [] },
];
function context(v, totalsTrust = 'calculated') {
  return {
    data: { debts: [{ id: 'travelvisa', label: 'Blue Visa' }], meta: { asOf: '2031-03-10' }, liveOverlay: null }, plan: {},
    selectedPeriodKey: v.start, recommendation: { payPeriodViews: [v] },
    Forecast: { cardPeriodMovements: () => ({}), stackCreditLines: () => ({ lines: LINES,
      totals: { paid: 500, spent: 660, trust: totalsTrust, completeness: 'complete', excluded: [], reasons: [] } }) },
  };
}
const waterfall = (fns, ctx) => { const el = container(); fns.waterfall(el, ctx); return el.innerHTML; };
const estSources = html => [...html.matchAll(/<span class="n( stack-est)?" data-source="([^"]+)">/g)]
  .filter(m => m[1]).map(m => m[2]).sort().join(',');
const allSources = html => [...html.matchAll(/<span class="n( stack-est)?" data-source="([^"]+)">/g)].map(m => m[2]).sort().join(',');

console.log('1. the one rule');
{
  const { win } = load();
  const B = win.StackBlocks;
  ok(B.isEstimated('estimated') && B.isEstimated('calculated', { evidenceState: 'projected' }), "'estimated', or a projected period");
  ok(['calculated', 'verified', 'unknown', 'unavailable', null, undefined, 'Estimated', 'projected'].every(t => !B.isEstimated(t, { evidenceState: 'actual' })),
    'calculated, verified, unknown, unavailable, absent and look-alike words are never estimated');
  ok(B.estClass('estimated') === ' stack-est' && B.estClass('calculated') === '', 'estClass gives the one class name or nothing');
}

console.log('2. waterfall, an actual period with mixed trust');
{
  const { fns } = load();
  const html = waterfall(fns, context(view('actual')));
  ok(estSources(html) === ['budgetHold', 'stackSummary.income.amanda.amount', 'stackSummary.income.total.amount', 'stackSummary.surplus.amount'].join(','),
    'exactly Amanda, Total income, Budget and the Surplus are soft (their published trust is estimated)', estSources(html));
}

console.log('3. waterfall, a projected period');
{
  const { fns } = load();
  const html = waterfall(fns, context(view('projected')));
  ok(estSources(html) === allSources(html) && allSources(html).split(',').length === 10, 'every printed figure is soft', estSources(html));
}

console.log('4. credit card and its sheet');
{
  const { fns, win } = load();
  const el = container();
  fns.credit(el, context(view('actual')));
  const rows = el.innerHTML.split('<li>').slice(1);
  const softIn = h => classed(h).filter(e => e.cls.includes('stack-est')).map(e => e.cls.find(c => /^stack-credit-/.test(c))).sort().join(',');
  ok(!/stack-est/.test(el.innerHTML.split('<li>')[0]), 'calculated totals: the total and its bar are not soft');
  ok(softIn(rows[0]) === '', 'Blue Visa (all calculated): nothing soft', softIn(rows[0]));
  ok(softIn(rows[1]) === 'stack-credit-min,stack-credit-minibar,stack-credit-status,stack-credit-sub-line',
    'Green Card (spent, toGo and minimum estimated): its paid-of-spent, bar, status and minimum are soft', softIn(rows[1]));
  const el2 = container();
  fns.credit(el2, context(view('actual'), 'estimated'));
  ok(/stack-credit-figure stack-n stack-est/.test(el2.innerHTML) && /stack-credit-bar stack-est/.test(el2.innerHTML), 'estimated totals: the total and its bar are soft');
  const ctx = context(view('actual'));
  const green = win.StackSheet.html(ctx, 'card:cashback');
  ok(/stack-sheet-big stack-n stack-est/.test(green) && /Spent on it this pay period<\/dt><dd class="stack-n stack-est"/.test(green)
    && /Paid onto it<\/dt><dd class="stack-n">/.test(green) && /stack-sheet-pill is-togo stack-est/.test(green),
  'Green Card sheet: the estimated figures are soft, the calculated "Paid onto it" is not');
  ok(!/stack-est/.test(win.StackSheet.html(ctx, 'card:travelvisa')), 'Blue Visa sheet: nothing soft');
  ok(/<dt class="stack-est">Minimum \$30<\/dt>/.test(green), 'the estimated minimum amount itself (in its label) is soft, not only "Not yet"');
  ok(/<dt>Minimum \$25<\/dt>/.test(win.StackSheet.html(ctx, 'card:travelvisa')), 'a calculated minimum label is not');
  const projected = context(view('projected'));
  const pEl = container();
  fns.credit(pEl, projected);
  ok(/stack-credit-figure stack-n stack-est/.test(pEl.innerHTML) && pEl.innerHTML.split('<li>').slice(1).every(r => /stack-credit-sub-line stack-est/.test(r)),
    'a projected period: the total and every line are soft');
}

console.log('5. bill and budget sheets');
{
  const { win } = load();
  const ctx = context(view('actual'));
  ok(/stack-sheet-big stack-n stack-est/.test(win.StackSheet.html(ctx, 'bill:water@2031-03-05')), 'an estimated bill amount is soft');
  ok(!/stack-est/.test(win.StackSheet.html(ctx, 'bill:power@2031-03-06')), 'a calculated bill amount is not');
  const g = win.StackSheet.html(ctx, 'budget:groceries');
  ok(/stack-sheet-big stack-n">/.test(g) && /<i class="stack-est"> \//.test(g) && /Spent<\/dt><dd class="stack-n">/.test(g)
    && /Budget<\/dt><dd class="stack-n stack-est"/.test(g) && /Left<\/dt><dd class="stack-n stack-est"/.test(g),
  'budget: calculated spent plain; estimated planned and left soft');
  ok(/stack-sheet-big stack-n stack-est/.test(win.StackSheet.html(context(view('projected')), 'bill:power@2031-03-06')), 'a projected period: a bill is soft');
  // Which of Spent, the plan and Left are soft, read from each budget sheet's own printed values.
  const soft = key => {
    const h = win.StackSheet.html(ctx, key);
    const big = /<div class="stack-sheet-big stack-n"><span( class="stack-est")?>[^<]*<\/span>(?:<i( class="stack-est")?>)?/.exec(h);
    const dd = name => new RegExp(`${name}</dt><dd class="stack-n( stack-est)?"`).exec(h);
    return [big && big[1] ? 'spent' : '', big && big[2] ? 'plan' : '', dd('Spent')[1] ? 'Spent' : '', dd('Budget')[1] ? 'Budget' : '',
      dd('Left')[1] ? 'Left' : ''].filter(Boolean).join(',');
  };
  ok(soft('budget:carried') === 'plan,Budget,Left', 'a carried budget (row trust only): the plan and Left are soft, Spent is not', soft('budget:carried'));
  ok(soft('budget:dup') === 'spent,Spent,Left', 'a possible duplicate (calculated plan): Spent and Left are soft, the plan is not', soft('budget:dup'));
  ok(soft('budget:other') === 'Left', 'Other spending: its undated plan is never soft; Left follows the row', soft('budget:other'));
  ok(soft('budget:firm') === '', 'a calculated row: nothing soft', soft('budget:firm'));
}

console.log('6. no words, no underline');
{
  const { fns, win } = load();
  const all = [];
  for (const state of ['actual', 'projected']) {
    const ctx = context(view(state), 'estimated');
    all.push(waterfall(fns, ctx));
    const el = container(); fns.credit(el, ctx); all.push(el.innerHTML);
    for (const key of ['card:cashback', 'card:travelvisa', 'bill:water@2031-03-05', 'budget:groceries']) all.push(win.StackSheet.html(ctx, key));
  }
  ok(!/estimated|projected|≈/i.test(text(all.join(' '))), 'the rendered text never says estimated, projected or ≈');
  const css = ['stack', 'stack-waterfall', 'stack-cards', 'stack-credit', 'stack-sheet'].map(f => read(`public/${f}.css`)).join('\n');
  ok(!/text-decoration[^;]*(underline|dotted)|border-bottom[^;]*dotted/i.test(css), 'no Stack stylesheet underlines or dots a figure');
}

console.log('7. one rule, read by every block');
{
  const shell = read('public/stack-shell.js');
  ok(/StackBlocks\.estClass\(surplus && surplus\.trust, view\)/.test(shell), "the shell's chips read the surplus's published trust through the rule");
  for (const f of ['waterfall', 'credit', 'sheet']) {
    const src = read(`public/stack-${f}.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok(/estClass|isEstimated/.test(src) && !/=== 'estimated'|evidenceState === 'projected'/.test(src),
      `stack-${f}.js uses the shell's rule and decides no trust itself`);
  }
}

console.log(`\nPASS Stack trust treatment (${checks})`);
