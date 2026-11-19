'use strict';
/* B4, the Stack Wallet Credit card and bottom sheet: render-only guarantees, checked in CI without a browser.
 * Invented data only: Forecast.cardPeriodMovements and Forecast.stackCreditLines are stubbed with hand-written
 * publications in A6b's shape, so every expected string below is written by hand, not computed by the code under test.
 *
 *   1. StackBlocks.barWidth: null unless both figures are published numbers and the whole is above zero; clamped 0–1.
 *   2. Closed card: "paid back / spent" from totals; a partial total always prints "excludes <card names>", a partial
 *      total naming no card prints no figure, and 'none' prints no figure. HELOC never appears in the totals line.
 *   3. Open rows: "Paid back $A of $B", the status word from the published status ("Paid back", "$X to go" in coral,
 *      "Upcoming"), "Minimum $X covered ✓ / not yet" from minimumCovered, nothing for 'unknown'. HELOC: minimum only.
 *   4. No ratio or percent text reaches the page: a bar's width appears only inside a style attribute.
 *   5. The sheet, for a card line, a bill, a mortgage row and a budget row: published fields only.
 *   6. L-001: the two block files do no arithmetic on money (a payment's "+" replaces the printed minus sign).
 * `node test/test-stack-credit.js`
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
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  ctx.StackBlocks.register = (name, fn) => { fns[name] = fn; register(name, fn); };
  vm.runInContext(read('public/stack-credit.js'), ctx);
  vm.runInContext(read('public/stack-sheet.js'), ctx);
  return { win: ctx, fns };
}
const container = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const fig = (amount, trust = 'calculated') => ({ amount, trust, reasons: [] });

// Invented lines: three spend cards and a HELOC, names and amounts made up for this test.
const LINES = [
  { id: 'travelvisa', label: 'Blue Visa', paid: fig(400), spent: fig(400), net: fig(0), minimum: fig(25), toGo: fig(0),
    state: 'x', status: 'paid-back', minimumCovered: { value: true, trust: 'calculated', reasons: [] },
    transactions: [{ date: '2031-03-03', name: 'Corner Grocer', amount: 150, kind: 'purchase', payment: false, pending: false },
      { date: '2031-03-09', name: 'Payment thank you', amount: -400, kind: 'payment', payment: true, pending: false },
      { date: '2031-03-10', name: 'Pending Cafe', amount: 12.5, kind: 'purchase', payment: false, pending: true }] },
  { id: 'cashback', label: 'Green Card', paid: fig(100), spent: fig(260), net: fig(160), minimum: fig(30), toGo: fig(160),
    state: 'x', status: 'to-go', minimumCovered: { value: false, trust: 'calculated', reasons: [] }, transactions: [] },
  { id: 'tdcc', label: 'Red Card', paid: fig(0), spent: fig(0), net: fig(0), minimum: fig(15), toGo: fig(null),
    state: 'x', status: 'upcoming', minimumCovered: { value: 'unknown', trust: 'unknown', reasons: ['x'] }, transactions: [] },
  { id: 'heloc', label: 'Line of credit', paid: null, spent: null, net: null, minimum: fig(210), toGo: fig(null),
    state: 'not-a-spend-card', status: null, minimumCovered: { value: true, trust: 'calculated', reasons: [] }, transactions: [] },
];
const VIEW = {
  start: '2031-03-01', end: '2031-03-14', stackSummary: { bills: { amount: 1 } },
  // A paid bill whose payment posted on another day, from another account, than planned (invented extra fields the
  // sheet must not read: Forecast publishes neither on the row).
  bills: [{ id: 'water', date: '2031-03-05', postedOn: '2031-03-07', paidFromLabel: 'Savings', label: 'Water', amount: 64, paidState: 'paid', payerLabel: 'Chequing' },
    { id: 'mort', date: '2031-03-12', label: 'Mortgage', amount: 1850, paidState: 'not-paid', payerLabel: 'Joint' }],
  householdBudget: [{ id: 'groceries', label: 'Groceries', spent: 310, planned: 500, remaining: 190, overspend: 0 },
    { id: 'fun', label: 'Fun', spent: 130, planned: 100, remaining: 0, overspend: 30 }],
};
function context(totals, calls = []) {
  return {
    data: { debts: [], meta: { asOf: '2031-03-10' }, liveOverlay: null }, plan: {}, selectedPeriodKey: VIEW.start,
    recommendation: { payPeriodViews: [VIEW] },
    Forecast: {
      cardPeriodMovements: (...args) => { calls.push(args); return { invented: true }; },
      stackCreditLines: (pub, bills) => { calls.push(['lines', pub, bills]); return { lines: LINES, totals }; },
    },
  };
}
const TOTALS = {
  complete: { paid: 500, spent: 660, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [] },
  partial: { paid: 500, spent: 660, trust: 'calculated', completeness: 'partial', excluded: ['tdcc'], reasons: ['x'] },
  partialNone: { paid: 500, spent: 660, trust: 'calculated', completeness: 'partial', excluded: [], reasons: ['x'] },
  none: { paid: null, spent: null, trust: 'unknown', completeness: 'none', excluded: ['travelvisa', 'cashback', 'tdcc'], reasons: ['x'] },
};
function card(totals) {
  const { fns } = load();
  const el = container();
  const calls = [];
  fns.credit(el, context(totals, calls));
  return { html: el.innerHTML, calls };
}

console.log('1. StackBlocks.barWidth');
{
  const { win } = load();
  const bw = win.StackBlocks.barWidth;
  ok([[null, 5], [5, null], [undefined, 5], ['3', 5], [NaN, 5], [5, Infinity], [3, 0], [3, -2], [0, 0]].every(([a, b]) => bw(a, b) === null),
    'null for an unpublished, non-numeric, zero or negative whole');
  ok(bw(1, 4) === 0.25 && bw(9, 4) === 1 && bw(-3, 4) === 0 && bw(0, 4) === 0, 'a ratio clamped to 0–1');
}

console.log('2. closed card totals');
{
  const complete = card(TOTALS.complete);
  ok(/data-stack-credit-total/.test(complete.html) && text(complete.html).startsWith('Credit $500 / $660 paid back / spent'),
    'complete: "$500 / $660 paid back / spent"', text(complete.html).slice(0, 60));
  ok(!/excludes/.test(complete.html), 'complete: no "excludes"');
  const partial = card(TOTALS.partial);
  ok(/data-stack-credit-excludes>excludes Red Card</.test(partial.html) && /\$500/.test(partial.html),
    'partial: the total prints with "excludes Red Card"');
  const partialNone = card(TOTALS.partialNone);
  ok(!/data-stack-credit-total|paid back \/ spent|stack-credit-bar/.test(partialNone.html),
    'partial naming no excluded card: no total, label or bar is printed');
  const none = card(TOTALS.none);
  ok(!/data-stack-credit-total|paid back \/ spent|stack-credit-bar/.test(none.html) && !/excludes/.test(none.html),
    "'none': no total, label, bar or excludes line");
  ok(!/Line of credit/.test(text(partial.html).split('Blue Visa')[0]), 'HELOC is not named in the closed totals line');
  {
    const { fns } = load();
    const el = container();
    fns.credit(el, { ...context(TOTALS.complete), Forecast: { cardPeriodMovements: () => ({}) } });
    ok(el.innerHTML === '', 'without Forecast.stackCreditLines (A6b not yet on main) the card renders nothing');
  }
  const [args, linesCall] = complete.calls;
  ok(args[3].start === VIEW.start && args[3].end === VIEW.end && args[4].liveOverlay === null && linesCall[2] === VIEW.stackSummary.bills,
    'reads the selected period, the applied overlay (none here) and view.stackSummary.bills');
}

console.log('3. open rows');
{
  const html = card(TOTALS.complete).html;
  const rows = html.split('<li>').slice(1).map(text);
  ok(rows.length === 4, 'one row per published line', String(rows.length));
  ok(rows[0] === 'Blue Visa Paid back Paid back $400 of $400 Minimum $25 covered ✓', 'paid-back row', rows[0]);
  ok(rows[1] === 'Green Card $160 to go Paid back $100 of $260 Minimum $30 not yet', 'to-go row', rows[1]);
  ok(/stack-credit-status stack-n is-togo">\$160 to go/.test(html), '"$160 to go" carries the coral class');
  ok(rows[2] === 'Red Card Upcoming Paid back $0 of $0', "upcoming row; minimumCovered 'unknown' prints no minimum line", rows[2]);
  ok(rows[3] === 'Line of credit Minimum $210 covered ✓', 'HELOC: its minimum only', rows[3]);
  ok(/data-stack-sheet="card:cashback"/.test(html) && (html.match(/data-stack-sheet="card:/g) || []).length === 4, 'every row opens the sheet');
  ok(/stack-credit-tick is-on/.test(html.split('<li>')[1]) && !/is-on/.test(html.split('<li>')[2]), 'the tick is filled only for Paid back');
}

console.log('4. no ratio text');
{
  const html = card(TOTALS.complete).html;
  ok(!/%|\b0\.\d|ratio/i.test(text(html)), 'no percent, decimal ratio or ratio word in the text');
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(m => m[1]);
  ok(widths.join() === '75.8,100.0,38.5', 'bar widths appear only as style widths (totals, Blue Visa, Green Card; none for $0 of $0 or HELOC)', widths.join());
  ok((html.match(/%/g) || []).length === widths.length, 'every % in the markup is a bar width');
}

console.log('5. the sheet');
{
  const { win } = load();
  const ctx = context(TOTALS.complete);
  const visa = text(win.StackSheet.html(ctx, 'card:travelvisa'));
  ok(visa === 'Credit Blue Visa $400 of $400 Paid back Spent on it this pay period $400 Paid onto it $400 Minimum $25 Covered ✓'
    + ' Transactions Mar 3 Corner Grocer $150 Mar 9 Payment thank you +$400 Mar 10 Pending Cafe $12.50', 'card sheet', visa);
  const tx = win.StackSheet.html(ctx, 'card:travelvisa');
  ok(/class="is-pay"><span class="stack-sheet-txd">Mar 9/.test(tx) && /class=" is-pending"/.test(tx), 'a payment row is marked bold and a pending row dimmed');
  ok(!/estimated|calculated|verified|≈/i.test(visa), 'no tag printed');
  const heloc = text(win.StackSheet.html(ctx, 'card:heloc'));
  ok(heloc === 'Credit Line of credit Minimum $210 Covered ✓', 'HELOC sheet: its minimum only', heloc);
  const green = text(win.StackSheet.html(ctx, 'card:cashback'));
  ok(/\$160 to go/.test(green) && /Minimum \$30 Not yet/.test(green) && /Transactions$/.test(green), 'to-go sheet with an empty list', green);
  const red = text(win.StackSheet.html(ctx, 'card:tdcc'));
  ok(!/Minimum/.test(red), "'unknown' minimum check prints nothing in the sheet", red);
  const water = text(win.StackSheet.html(ctx, 'bill:water@2031-03-05'));
  ok(water === 'Bill Water $64 Paid Due Mar 5 Comes out of Chequing' && !/Paid on|Paid from|Mar 7|Savings/.test(water),
    'paid bill sheet: the scheduled date reads Due and the planned account Comes out of, never as observed evidence', water);
  ok(text(win.StackSheet.html(ctx, 'mortgage:mort@2031-03-12')) === 'Mortgage Mortgage $1,850 Not paid Due Mar 12 Comes out of Joint', 'mortgage sheet');
  ok(text(win.StackSheet.html(ctx, 'budget:groceries')) === 'Budget Groceries $310 / $500 Spent $310 Budget $500 Left $190', 'budget sheet');
  ok(text(win.StackSheet.html(ctx, 'budget:fun')) === 'Budget Fun $130 / $100 Spent $130 Budget $100 Over $30', 'overspent budget sheet');
  ok(win.StackSheet.html(ctx, 'bill:water@2031-03-06') === null && win.StackSheet.html(ctx, 'card:nope') === null, 'an unknown key opens nothing');
  const bare = { ...ctx, Forecast: { cardPeriodMovements: () => ({}) } };
  ok(win.StackSheet.html(bare, 'card:travelvisa') === null, 'without Forecast.stackCreditLines nothing is read');
}

console.log('6. L-001: no arithmetic on money');
{
  for (const file of ['public/stack-credit.js', 'public/stack-sheet.js']) {
    // Code only: comments and plain '...' strings (printed words such as 'paid back / spent') are removed first.
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
    ok(!/\.reduce\(|Math\.(round|floor|ceil)\(|\b(amount|paid|spent|net|minimum|planned|remaining|overspend)\s*[+\-*/]\s|[\s(][+\-*/]\s*(paid|spent|t\.amount|\w+\.amount)\b/.test(src),
      `${file}: no sum, rounding or arithmetic on a figure`);
  }
  const both = read('public/stack-credit.js') + read('public/stack-sheet.js');
  ok(!/Math\.\w+\(/.test(both.replace(/Math\.min\(1, Math\.max\(0,/g, '')), 'no Math call in either block file');
}

console.log(`\nPASS Stack credit card and sheet (${checks})`);
