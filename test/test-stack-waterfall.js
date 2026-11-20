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
globalThis.StackBlocks = { register: (name, fn) => registered.push([name, fn]) };
const W = require(FILE);
delete globalThis.StackBlocks;

// Independent of the block: $1,234.50 with U+2212 for a negative.
const fmt = v => (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const readPath = (obj, p) => p.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), obj);
const unescape = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const cells = html => [...html.matchAll(/<span class="n" data-source="([^"]+)"( data-unpublished="true")?>([^<]*)<\/span>/g)]
  .map(m => ({ source: m[1], unpublished: !!m[2], text: unescape(m[3]) }));
const MONEY = /[−+]?\$[\d,]+\.\d\d/g;

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
    const expect = c.source === W.LINE_SOURCES.surplus ? (v > 0 ? '+' : '') + fmt(v) : fmt(v);
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
  ok(/data-source="stackSummary.income.total.amount">\$3,000\.50</.test(c.innerHTML)
    && /data-source="stackSummary.surplus.terms.credit">\$35\.25</.test(c.innerHTML)
    && /data-source="stackSummary.surplus.amount">\+\$865\.25</.test(c.innerHTML),
    'the Total, the Credit line and the Surplus are read from their published values (3,000.50; 35.25; +865.25)');
  ok(/<ul class="wf-cards" hidden>/.test(c.innerHTML), 'Credit starts closed');
  c.clickCredit();
  const open = proveSourced(c.innerHTML, view, 'Credit open');
  const cardCells = open.filter(x => /cardMinimums/.test(x.source));
  ok(cardCells.length === 2 && cardCells[0].text === '$25.00' && cardCells[1].text === '$10.25',
    'opened, Credit lists one row per card with its published minimum', JSON.stringify(cardCells));
  ok(/<b>Invented card A<\/b>/.test(c.innerHTML) && /<b>triangle<\/b>/.test(c.innerHTML),
    'each card row is named by its debt label, else its id');
  const cardRows = [...c.innerHTML.matchAll(/<li class="wf-card"[^>]*>([\s\S]*?)<\/li>/g)].map(m => m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  ok(cardRows.join('|') === 'Invented card A $25.00|triangle $10.25' && !/<small/.test(c.innerHTML),
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
  ok(blank.length === 7 && cs.find(x => x.source === W.LINE_SOURCES.total).text === '$2,900.00'
    && cs.find(x => x.source === W.LINE_SOURCES.budget).text === '$750.00',
    'its withheld lines are blank; its published total and budget still print', blank.join(', '));
  ok(!/\$0\.00/.test(c.innerHTML), 'nothing reads $0');
  ok(/disabled/.test(c.innerHTML) && /<ul class="wf-cards" hidden><\/ul>/.test(c.innerHTML), 'with no published minimums, Credit has no rows to open');
  const slab = /<div class="wf-slab[^"]*" data-row="surplus">([\s\S]*?)<\/div>\s*<\/section>/.exec(c.innerHTML);
  ok(slab && !/is unavailable|wf-reason/.test(c.innerHTML) && /<span class="wf-dash" aria-hidden="true">\u2014<\/span>$/.test(slab[1])
    && slab[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() === '= Surplus after deductions \u2014',
    'a withheld surplus shows its name and a dash: no reason sentence, no amount', slab && slab[1]);
  const shown = fakeContainer();
  W.render(shown, ctxOf([fullView()]));
  ok(!/wf-dash/.test(shown.innerHTML), 'a published surplus has no dash');
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
    && /data-source="stackSummary.surplus.amount">−\$120\.40</.test(html), 'a negative surplus reads Deficit after deductions, −$120.40');
  const zero = fullView();
  zero.stackSummary.surplus.amount = 0;
  ok(/Surplus after deductions/.test(W.html(ctxOf([zero]), {})) && /data-source="stackSummary.surplus.amount">\$0\.00</.test(W.html(ctxOf([zero]), {})),
    'a published zero is a Surplus of $0.00 (it is published, so it prints)');
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
      ? (readPath(view, x.source) > 0 ? '+' : '') + fmt(readPath(view, x.source)) : fmt(readPath(view, x.source))));
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

console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nAll ${checks} stack waterfall checks passed`);
process.exit(failures ? 1 : 0);
