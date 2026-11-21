'use strict';
/* Stack page waterfall block (B2): every printed amount is a named published
 * value, copied as is.
 *
 * public/stack-waterfall.js prints the selected pay period's waterfall
 * (three income lines, Total income, − Bills, − Budget, − Mortgage, − Credit,
 * = Surplus or Deficit after deductions), Credit opening in place to one row
 * per card minimum. This proves, on invented data only:
 *   1. each amount cell names its source, and its text is that published value
 *      formatted, digit for digit (independent formatter here), including each
 *      per-card minimum row once Credit is opened;
 *   2. no money appears on the block outside a sourced cell (so nothing is
 *      summed or derived on the page);
 *   3. an unpublished value prints nothing for its row (F8), never $0: a saved
 *      close's withheld lines, a withheld bills split, a withheld surplus;
 *   4. the slab reads Deficit after deductions, with a true minus, only when
 *      the published surplus is negative;
 *   5. the period is chosen by its start date (the key), else the current one;
 *   6. the block registers with the Stack shell as 'waterfall';
 *   7. on a real Forecast recommendation for an invented harness world, every
 *      printed amount still equals its published source;
 *   8. the source has no money arithmetic (no reduce, no Math, no + or −
 *      between figures).
 *
 * `node test/test-stack-waterfall.js` */
const fs = require('node:fs');
const path = require('node:path');

let failures = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ' — ' + detail : ''}`);
};

const FILE = path.join(__dirname, '..', 'public', 'stack-waterfall.js');
// 6. Registration: a shell registry present before the file loads receives it.
const registered = [];
// The block prints through the shell's one money format, so the stub carries the real shell's StackBlocks.money.
const shellMoney = (() => {
  const sandbox = { window: {}, location: { search: '' }, URLSearchParams, Intl, Map, Number, String, Object, Array, JSON, Math, console };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-shell.js'), 'utf8'), sandbox);
  return sandbox.window.StackBlocks.money;
})();
globalThis.StackBlocks = { register: (name, fn) => registered.push([name, fn]), money: shellMoney };
const W = require(FILE);

// Independent of the block and the shell: whole dollars, half away from zero ($1,234.50 prints $1,235), U+2212 for a
// negative, no sign on an amount that prints as $0.
const dollars = v => Math.floor(Math.abs(v) + 0.5);
const fmt = v => (v < 0 && dollars(v) ? '−' : '') + '$' + String(dollars(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtSigned = v => (v > 0 && dollars(v) ? '+' : '') + fmt(v);
const readPath = (obj, p) => p.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), obj);
const unescape = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cells = html => [...html.matchAll(/<span class="n" data-source="([^"]+)"( data-unpublished="true")?>([^<]*)<\/span>/g)]
  .map(m => ({ source: m[1], unpublished: !!m[2], text: unescape(m[3]) }));
const MONEY = /[−+]?\$[\d,]+(?:\.\d+)?/g;

function fakeContainer() {
  const c = { innerHTML: '', handlers: [] };
  c.addEventListener = (type, fn) => c.handlers.push([type, fn]);
  c.clickCredit = () => { for (const [type, fn] of c.handlers) if (type === 'click') fn({ target: { closest: () => ({ disabled: false }) } }); };
  return c;
}

// Invented published views.
function fullView(over = {}) {
  return Object.assign({
    id: 'p-2026-10-09', start: '2026-10-09', timelineRole: 'current', budgetHold: 800,
    stackSummary: {
      income: { dale: { amount: 1700, trust: 'calculated' }, amanda: { amount: 1200, trust: 'calculated' },
        other: { amount: 100.5, trust: 'estimated' }, total: { amount: 3000.5, trust: 'estimated' } },
      bills: { mortgage: 1000, cardMinimums: [{ debtId: 'mbna', amount: 25 }, { debtId: 'triangle', amount: 10.25 }], other: 300, trust: 'calculated' },
      surplus: { amount: 865.25, terms: { income: 3000.5, bills: 300, household: 800, mortgage: 1000, credit: 35.25 }, trust: 'estimated', projected: false },
    },
  }, over);
}
const ctxOf = (views, key, debts) => ({ data: { debts: debts || [{ id: 'mbna', label: 'Invented card A' }] }, plan: {},
  recommendation: { payPeriodViews: views }, selectedPeriodKey: key, Forecast: null });

function proveSourced(html, view, label) {
  const cs = cells(html);
  const published = cs.filter(c => !c.unpublished);
  const wrong = published.filter(c => {
    const v = readPath(view, c.source);
    const expect = c.source === W.LINE_SOURCES.surplus ? fmtSigned(v) : fmt(v);
    return typeof v !== 'number' || c.text !== expect;
  });
  ok(wrong.length === 0, `${label}: every printed amount is its named published value`, JSON.stringify(wrong));
  const blankWrong = cs.filter(c => c.unpublished && (c.text !== '' || typeof readPath(view, c.source) === 'number'));
  ok(blankWrong.length === 0, `${label}: a blank cell is exactly an unpublished value`, JSON.stringify(blankWrong));
  const printed = (html.match(MONEY) || []).length;
  ok(printed === published.length, `${label}: no money is printed outside a sourced cell`, `${printed} amounts, ${published.length} sourced`);
  return cs;
}

console.log('1–2. Every amount is a named published value');
{
  const view = fullView();
  const c = fakeContainer();
  W.render(c, ctxOf([view]));
  const closed = proveSourced(c.innerHTML, view, 'Credit closed');
  ok(closed.length === 11 && closed.every(x => !x.unpublished) && closed.filter(x => /cardMinimums/.test(x.source)).length === 2,
    'nine lines plus the two (hidden) card rows, all published: three income lines, total, bills, budget, mortgage, credit, surplus',
    closed.map(x => x.source).join(', '));
  ok(/data-source="stackSummary.income.total.amount">\$3,001</.test(c.innerHTML)
    && /data-source="stackSummary.surplus.terms.credit">\$35</.test(c.innerHTML)
    && /data-source="stackSummary.surplus.amount">\+\$865</.test(c.innerHTML),
    'the Total, the Credit line and the Surplus are read from their published values (3,000.50; 35.25; +865.25, printed in whole dollars, half away from zero: $3,001, $35, +$865)');
  ok(/<ul class="wf-cards" hidden>/.test(c.innerHTML), 'Credit starts closed');
  c.clickCredit();
  const open = proveSourced(c.innerHTML, view, 'Credit open');
  const cardCells = open.filter(x => /cardMinimums/.test(x.source));
  ok(cardCells.length === 2 && cardCells[0].text === '$25' && cardCells[1].text === '$10',
    'opened, Credit lists one row per card with its published minimum', JSON.stringify(cardCells));
  ok(/<b>Invented card A<\/b>/.test(c.innerHTML) && /<b>triangle<\/b>/.test(c.innerHTML),
    'each card row is named by its debt label, else its id');
  const cardRows = [...c.innerHTML.matchAll(/<li class="wf-card"[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  ok(cardRows.join('|') === 'Invented card A $25|triangle $10' && !/<small/.test(c.innerHTML),
    'each card row is its name and its minimum, no descriptor word (owner, 2026-11-20)', cardRows.join('|'));
  ok(/aria-expanded="true"/.test(c.innerHTML) && !/<ul class="wf-cards" hidden>/.test(c.innerHTML), 'the toggle reports itself open');
  c.clickCredit();
  ok(/<ul class="wf-cards" hidden>/.test(c.innerHTML), 'a second click closes it');
}

console.log('3. Unpublished values print nothing (F8)');
{
  // A saved close: income total kept, the lines withheld; the bills split and
  // the surplus withheld (as Forecast publishes them for a saved close).
  const line = { amount: null, trust: 'unavailable', reason: 'withheld' };
  const saved = fullView({ timelineRole: 'past', id: 'p-past', start: '2026-09-25', budgetHold: 750,
    stackSummary: {
      income: { dale: { ...line }, amanda: { ...line }, other: { ...line }, total: { amount: 2900, trust: 'calculated' } },
      bills: { mortgage: null, cardMinimums: null, other: null, trust: 'unavailable', reason: 'withheld' },
      surplus: { amount: null, terms: null, trust: 'unavailable', projected: false, reason: 'Surplus after deductions is unavailable.' },
    } });
  const c = fakeContainer();
  W.render(c, ctxOf([fullView(), saved], '2026-09-25'));
  const cs = proveSourced(c.innerHTML, saved, 'saved close');
  const blank = cs.filter(x => x.unpublished).map(x => x.source);
  ok(blank.length === 7 && cs.find(x => x.source === W.LINE_SOURCES.total).text === '$2,900'
    && cs.find(x => x.source === W.LINE_SOURCES.budget).text === '$750',
    'its withheld lines are blank; its published total and budget still print', blank.join(', '));
  ok(!/\$0(?![\d.,])/.test(c.innerHTML), 'nothing reads $0');
  ok(/disabled/.test(c.innerHTML) && /<ul class="wf-cards" hidden><\/ul>/.test(c.innerHTML), 'with no published minimums, Credit has no rows to open');
  const slab = /<div class="wf-slab[^"]*" data-row="surplus">([\s\S]*?)<\/div>\s*<\/section>/.exec(c.innerHTML);
  ok(slab && !/is unavailable|wf-reason/.test(c.innerHTML) && /<span class="wf-dash" role="img" aria-label="not available">\u2014<\/span>$/.test(slab[1])
    && slab[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() === '= Surplus after deductions \u2014',
    'a withheld surplus shows its name and a dash: no reason sentence, no amount', slab && slab[1]);
  const shown = fakeContainer();
  W.render(shown, ctxOf([fullView()]));
  ok(!/wf-dash/.test(shown.innerHTML), 'a published surplus has no dash');
  // A card whose minimum is not published: its row shows the name and a dash (read as "not available"), never $0.
  const gap = fullView();
  gap.stackSummary.bills.cardMinimums = [{ debtId: 'mbna', amount: 25 }, { debtId: 'triangle', amount: null }];
  const g = fakeContainer();
  W.render(g, ctxOf([gap]));
  proveSourced(g.innerHTML, gap, 'unpublished card minimum');
  const gapRows = [...g.innerHTML.matchAll(/<li class="wf-card"[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  ok(gapRows.length === 2 && /data-unpublished="true"><\/span><span class="wf-dash" role="img" aria-label="not available">—<\/span><\/span>$/.test(gapRows[1])
    && !/wf-dash/.test(gapRows[0]) && !/\$0(?![\d.,])/.test(gapRows[1]),
    'an unpublished card minimum: a dash in its row, never $0; a published one has no dash', gapRows[1]);
  const none = fakeContainer();
  W.render(none, ctxOf([{ id: 'x', start: '2026-10-09', timelineRole: 'current' }]));
  ok(cells(none.innerHTML).every(x => x.unpublished) && !MONEY.test(none.innerHTML), 'a period with no stackSummary prints no amount at all');
  const missing = fakeContainer();
  W.render(missing, ctxOf([fullView()], 'no-such-period'));
  ok(/data-unpublished="true"/.test(missing.innerHTML) && !MONEY.test(missing.innerHTML), 'an unknown key selects no period and prints nothing');
}

console.log('4. Surplus or Deficit, from the published sign');
{
  const neg = fullView();
  neg.stackSummary.surplus.amount = -120.4;
  const html = W.html(ctxOf([neg]), {});
  ok(/Deficit after deductions/.test(html) && /class="wf-slab neg"/.test(html)
    && /data-source="stackSummary.surplus.amount">−\$120</.test(html), 'a negative surplus reads Deficit after deductions, −$120');
  const zero = fullView();
  zero.stackSummary.surplus.amount = 0;
  ok(/Surplus after deductions/.test(W.html(ctxOf([zero]), {})) && /data-source="stackSummary.surplus.amount">\$0</.test(W.html(ctxOf([zero]), {})),
    'a published zero is a Surplus of $0 (it is published, so it prints)');
}

console.log('5. Period selection');
{
  const a = fullView({ id: 'pa', start: '2026-10-09', timelineRole: 'current' });
  const b = fullView({ id: 'pb', start: '2026-10-23', timelineRole: 'future' });
  ok(W.selectedView(ctxOf([a, b], '2026-10-23')) === b, 'by start date');
  ok(W.selectedView(ctxOf([a, b], 'pb')) === null, 'a key is a start date only: a view id selects nothing');
  ok(W.selectedView(ctxOf([b, a], null)) === a, 'with no key, the current period');
}

console.log('6. Shell registration');
ok(registered.length === 1 && registered[0][0] === 'waterfall' && registered[0][1] === W.render,
  'registers render with StackBlocks as "waterfall"');

console.log('7. A real Forecast recommendation (invented harness world)');
{
  const H = require('./acceptance/harness.js');
  const F = require('../public/forecast.js');
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed' }];
  w.obligations = [
    { id: 'inv-mortgage', label: 'Invented mortgage', debtId: 'mortgage', effect: 'payment', frequency: 'monthly', day: 16, amount: 300, confidence: 'confirmed', payingAccount: 'chequing-a' },
    { id: 'inv-card-a', label: 'Invented card A minimum', debtId: 'mbna', effect: 'payment', frequency: 'monthly', day: 15, amount: 25, confidence: 'confirmed', payingAccount: 'chequing-a' },
  ];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const rec = F.recommend(data.plan, w.asOf, { debts: data.debts, currentPeriodActuals: packet });
  let periods = 0;
  for (const view of rec.payPeriodViews || []) {
    const c = fakeContainer();
    W.render(c, { data, plan: data.plan, recommendation: rec, selectedPeriodKey: view.start, Forecast: F });
    c.clickCredit();
    const cs = cells(c.innerHTML);
    const bad = cs.filter(x => !x.unpublished && x.text !== (x.source === W.LINE_SOURCES.surplus
      ? fmtSigned(readPath(view, x.source)) : fmt(readPath(view, x.source))));
    const leaked = (c.innerHTML.match(MONEY) || []).length !== cs.filter(x => !x.unpublished).length;
    if (!bad.length && !leaked) periods++;
  }
  ok(periods === (rec.payPeriodViews || []).length && periods > 3,
    `every period of the recommendation prints only its published values (${periods} periods)`);
}

console.log('8. No money arithmetic in the block');
{
  const src = fs.readFileSync(FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\.reduce\(|Math\.|\bparseFloat\b|\bNumber\(/.test(src), 'no reduce, Math, parseFloat or Number() in the block');
  ok(!/\b(amount|value|v)\s*[-+*/]\s*[\w(]/.test(src.replace(/['"`][^'"`\n]*['"`]/g, '""')),
    'no figure is added, subtracted, multiplied or divided');
}

console.log('9. The design\'s marks: letter tiles on the income lines, card-colour swatches on the deductions');
{
  const out = W.html(ctxOf([fullView()]), {});
  const mark = row => { const m = new RegExp(`data-row="${row}"[^>]*>[\\s\\S]*?<span class="lab">(<span class="wf-av[^"]*"(?: style="--wf-k:var\\(--stack-([a-z]+)\\)")? aria-hidden="true">([^<]*)</span>)?`).exec(out); return m ? [m[1] ? 'mark' : '', m[2] || '', m[3] || ''] : null; };
  const got = Object.fromEntries(['dale', 'amanda', 'other', 'total', 'bills', 'budget', 'mortgage'].map(r => [r, mark(r)]));
  const credit = /data-row="credit"[\s\S]*?<span class="lab"><span class="wf-av wf-sw" style="--wf-k:var\(--stack-cards\)" aria-hidden="true"><\/span>Credit/.test(out);
  ok(got.dale.join() === 'mark,,D' && got.amanda.join() === 'mark,,A' && got.other.join() === 'mark,,$'
    && got.total.join() === ',,' && got.bills.join() === 'mark,bills,' && got.budget.join() === 'mark,budget,'
    && got.mortgage.join() === 'mark,mort,' && credit,
  'D, A and $ tiles on the income lines; bills, budget, mortgage and credit swatches; none on Total (all aria-hidden)', JSON.stringify(got));
}

console.log('10. The Mortgage line opens the mortgage sheet (owner, Dale, 2026-11-20: no Mortgage card)');
{
  const row = (over = {}) => Object.assign({ id: 'mortgage', debtId: 'mortgage', date: '2026-10-15', amount: 1000, paidState: 'not-paid' }, over);
  const lineOf = bills => { const out = W.html(ctxOf([fullView({ bills })]), {});
    const m = /<li class="wf-line[^"]*" data-row="mortgage">([\s\S]*?)<\/li>/.exec(out); return m ? m[1] : ''; };
  const keyOf = bills => { const m = /data-stack-sheet="([^"]*)"/.exec(lineOf(bills)); return m ? m[1] : null; };
  ok(keyOf([{ id: 'water', date: '2026-10-05', paidState: 'paid' }, row()]) === 'mortgage:mortgage@2026-10-15'
    && /<button type="button" class="wf-toggle"/.test(lineOf([row()])),
    'the line is a button keyed to the period\'s mortgage row, as the card row was (mortgage:<id>@<date>)');
  ok(keyOf([row({ id: 'm1', debtId: 'mortgage', date: '2026-10-20' })]) === 'mortgage:m1@2026-10-20',
    'a row named by its debt (debtId mortgage) is found the same way');
  ok(keyOf([row({ paidState: 'carried' })]) === null && keyOf([row({ paidState: undefined })]) === null
    && keyOf([row({ date: null })]) === null && keyOf([]) === null && keyOf(undefined) === null,
    'no tap without a published row: a carried row, no paid state, no date, or no bills leaves a plain line');
  ok(/data-source="stackSummary\.bills\.mortgage"/.test(lineOf([row()])) && /data-source="stackSummary\.bills\.mortgage"/.test(lineOf([])),
    'tappable or plain, the line prints the same published amount (stackSummary.bills.mortgage)');
  ok(keyOf([row({ id: 'a"b' })]) === 'mortgage:a&quot;b@2026-10-15', 'the key is escaped in the attribute');
  // A published mortgage obligation (the invented fixture's mortgageObligation, #1465) through the real Forecast: the
  // current period's line is a button keyed to its own mortgage row, and it prints the published amount, which is that
  // row's amount (the browser proof checks that the sheet it opens heads with the same printed value).
  const F = require('../public/forecast.js');
  const data = require('./fixtures/budget-surface-data').served({ mortgageObligation: true });
  const rec = F.recommend(data.plan, data.meta && data.meta.asOf, F.budgetRecommendInputs(data, { periods: null, settlementEvidence: null }));
  const view = (rec.payPeriodViews || []).find(v => v.role === 'active');
  const mort = view && (view.bills || []).find(r => r && (r.debtId === 'mortgage' || r.id === 'mortgage'));
  const out = W.html({ data, plan: data.plan, recommendation: rec, selectedPeriodKey: view && view.start, Forecast: F }, {});
  const line = (/<li class="wf-line[^"]*" data-row="mortgage">([\s\S]*?)<\/li>/.exec(out) || [])[1] || '';
  ok(!!mort && typeof view.stackSummary.bills.mortgage === 'number' && view.stackSummary.bills.mortgage > 0
    && view.stackSummary.bills.mortgage === mort.amount
    && line.includes(`data-stack-sheet="mortgage:${mort.id}@${mort.date}"`)
    && line.includes(`data-source="stackSummary.bills.mortgage">${fmt(mort.amount)}<`),
  'the fixture\'s real mortgage obligation: the current period\'s line opens its own row and prints that row\'s published amount',
  JSON.stringify({ published: view && view.stackSummary.bills.mortgage, row: mort && [mort.id, mort.date, mort.amount] }));
}

console.log('9. The minimum\'s due date beside each Credit card name (Dale, 2026-11-21)');
{
  // Forecast's own marks on the view's bill rows, invented: one dated occurrence for mbna, two for triangle, an undated
  // one for a third card, a malformed date for a fourth, and a row not marked a card minimum.
  const mark = (id, debt, date) => ({ id, date, label: id, amount: 10, stackBillPart: 'cardMinimum', stackBillDebtId: debt });
  const view = fullView({
    bills: [mark('a', 'mbna', '2026-10-12'), mark('t1', 'triangle', '2026-10-03'), mark('t2', 'triangle', '2026-10-17'),
      mark('u', 'undated', null), mark('m', 'bad', '10/05/2026'), { ...mark('o', 'other', '2026-10-09'), stackBillPart: 'other' }],
  });
  view.stackSummary.bills.cardMinimums = [{ debtId: 'mbna', amount: 25 }, { debtId: 'triangle', amount: 10 }, { debtId: 'undated', amount: 5 }, { debtId: 'bad', amount: 5 }, { debtId: 'other', amount: 5 }];
  const dues = src => {
    const html = W.html(ctxOf([src]), { creditOpen: true });
    return [...html.matchAll(/<li class="wf-card"[^>]*>([\s\S]*?)<\/li>/g)].map(m => (/class="wf-due">([^<]*)</.exec(m[1]) || [])[1] || null);
  };
  ok(JSON.stringify(dues(view)) === JSON.stringify(['Oct 12', null, null, null, null]),
    'a date prints only on the card with exactly one dated occurrence; two occurrences, an undated row, a malformed date and an unmarked row print none', JSON.stringify(dues(view)));
  ok(/<b>Invented card A<\/b><span class="wf-due">Oct 12<\/span>/.test(W.html(ctxOf([view]), { creditOpen: true })), 'the date sits right beside the card name');
  // A shape-valid date that is not a calendar day (month 13, Feb 30, day 00) shows nothing and never breaks the render.
  for (const bad of ['2026-13-05', '2026-02-30', '2026-10-00', '2026-04-31', '2026-00-10']) {
    const badView = fullView({ bills: [mark('a', 'mbna', bad)] });
    badView.stackSummary.bills.cardMinimums = [{ debtId: 'mbna', amount: 25 }];
    let out = null, threw = null;
    try { out = dues(badView); } catch (e) { threw = e.message; }
    ok(threw === null && out.length === 1 && out[0] === null, `a calendar-invalid date (${bad}) prints no date and does not throw`, threw || JSON.stringify(out));
  }
  const leap = fullView({ bills: [mark('a', 'mbna', '2028-02-29')] });
  leap.stackSummary.bills.cardMinimums = [{ debtId: 'mbna', amount: 25 }];
  ok(dues(leap)[0] === 'Feb 29', 'a real leap day still prints', String(dues(leap)[0]));
  ok(dues({ ...view, bills: undefined }).every(d => d === null), 'no bill rows (the split withheld): no date, never a guess');
  ok(/\.wf-card \.wf-due \{[^}]*color: var\(--stack-on2\)/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-waterfall.css'), 'utf8')), 'the date is the muted ink, small');
  // Mutant: reading the first row whatever the count prints a guessed date for the two-occurrence card.
  const src = fs.readFileSync(FILE, 'utf8');
  const mutated = src.replace('rows.length === 1 ?', 'rows.length >= 1 ?');
  ok(mutated !== src, 'the mutation applies');
  const Module = require('node:module');
  const mm = new Module(FILE);
  mm.filename = FILE;
  mm.paths = Module._nodeModulePaths(path.dirname(FILE));
  mm._compile(mutated, FILE);
  const mutantDues = [...mm.exports.html(ctxOf([view]), { creditOpen: true }).matchAll(/<li class="wf-card"[^>]*>([\s\S]*?)<\/li>/g)]
    .map(x => (/class="wf-due">([^<]*)</.exec(x[1]) || [])[1] || null);
  ok(mutantDues[1] === 'Oct 3', 'mutant: dropping the exactly-one rule prints a guessed date for the two-occurrence card and is caught', JSON.stringify(mutantDues));
}

console.log('11. A real Forecast recommendation whose operating plan is unavailable (C1 S4 B2)');
{
  // Replaces the classic page's printed "unavailable Plan surface lists no income, bills or budget dollars"
  // (test-plan-calendar-waterfalls.js section 18): with the operating plan unavailable Forecast publishes no income
  // or surplus for the current period, and the Stack waterfall must then print no amount for it, never $0.
  const H = require('./acceptance/harness.js');
  const F = require('../public/forecast.js');
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  const { data, packet, error } = H.dataOf(w);
  if (error) throw error;
  const base = { debts: data.debts, currentPeriodActuals: packet };
  const trusted = F.recommend(data.plan, w.asOf, base);
  const unavailable = F.recommend(data.plan, w.asOf, Object.assign({ operatingPlan: 'unavailable', operatingPlanNote: 'Current plan unavailable. The dated opening is stale.' }, base));
  const render = (rec, view, mod) => {
    const c = fakeContainer();
    (mod || W).render(c, { data, plan: data.plan, recommendation: rec, selectedPeriodKey: view.start, Forecast: F });
    return c.innerHTML;
  };
  const activeOf = rec => rec.payPeriodViews.find(v => v.role === 'active');
  const aT = activeOf(trusted), aU = activeOf(unavailable);
  ok(unavailable.operatingPlanUnavailable === true && aU.stackSummary.income.total.amount == null && aU.stackSummary.surplus.amount == null
      && aT.stackSummary.income.total.amount === 1400,
    'independent facts: the trusted current period publishes $1,400 income, the unavailable one publishes none');
  const htmlT = render(trusted, aT), htmlU = render(unavailable, aU);
  ok(/\$1,400/.test(htmlT), 'control: the trusted current period prints its $1,400 income');
  ok(!MONEY.test(htmlU) && cells(htmlU).every(x => x.unpublished), 'the unavailable current period prints no amount at all (MONEY pattern, every cell blank)');
  MONEY.lastIndex = 0;
  ok(!/\$0(?![\d.,])/.test(htmlU), 'and nothing reads $0');
  let periods = 0;
  for (const view of unavailable.payPeriodViews) {
    const html = render(unavailable, view);
    const cs = cells(html);
    const bad = cs.filter(x => !x.unpublished && x.text !== (x.source === W.LINE_SOURCES.surplus ? fmtSigned(readPath(view, x.source)) : fmt(readPath(view, x.source))));
    const blankBad = cs.filter(x => x.unpublished && typeof readPath(view, x.source) === 'number');
    if (!bad.length && !blankBad.length && (html.match(MONEY) || []).length === cs.filter(x => !x.unpublished).length) periods++;
  }
  ok(periods === unavailable.payPeriodViews.length, 'every period of the unavailable recommendation prints only its published values (' + periods + ' periods)');
  // Mutation: print an unpublished amount as 0; the unavailable current period then shows money and the test above fails.
  const src = fs.readFileSync(FILE, 'utf8');
  const from = ["return isAmount(value)\n      ?", "sign ? signed(value) : money(value)"];
  ok(from.every(f => src.split(f).length === 2), 'the mutation targets appear once');
  const mutated = src.replace(from[0], 'return true\n      ?').replace(from[1], 'sign ? signed(value || 0) : money(value || 0)');
  const Module = require('node:module');
  const mm = new Module(FILE);
  mm.filename = FILE;
  mm.paths = Module._nodeModulePaths(path.dirname(FILE));
  mm._compile(mutated, FILE);
  const mutantHtml = render(unavailable, aU, mm.exports);
  MONEY.lastIndex = 0;
  ok(MONEY.test(mutantHtml), 'mutant: printing an unpublished amount as $0 shows money on the unavailable period and is caught');
  MONEY.lastIndex = 0;
}

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack waterfall checks passed`);
process.exit(failures ? 1 : 0);
