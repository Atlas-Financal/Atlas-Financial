'use strict';
/* B4, the Stack Wallet Credit card and bottom sheet: render-only guarantees, checked in CI without a browser.
 * Invented data only: Forecast.cardPeriodMovements and Forecast.stackCreditLines are stubbed with hand-written
 * publications in A6b's shape, so every expected string below is written by hand, not computed by the code under test.
 *
 *   1. StackBlocks.barWidth: null unless both figures are published numbers and the whole is above zero; clamped 0–1.
 *   2. Closed card: "paid back / spent" from totals; a partial total always prints "excludes <card names>", a partial
 *      total naming no card prints no figure, and 'none' prints no figure. HELOC never appears in the totals line.
 *   3. Open rows: "Paid back $A of $B", the status word from the published status ("Paid back", "$X to go" in coral,
 *      "Upcoming"), "Minimum $X" whenever the amount is published, ✓ only when covered is true. HELOC: minimum only.
 *   4. No ratio or percent text reaches the page: a bar's width appears only inside a style attribute.
 *   5. The sheet, for a card line, a bill, a mortgage row and a budget row: published fields only.
 *   6. L-001: the two block files do no arithmetic on money (a payment's "+" replaces the printed minus sign).
 * `node test/test-stack-credit.js`
 */
const assert = require('node:assert/strict');
const { withTargets } = require('./lib/stack-credit-target');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };

function load(creditSrc) {
  const ctx = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {}, raw = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  // Desk ruling (E) (#1573): Forecast publishes the Credit lines on the view (stackSummary.credit) and the page reads them
  // there. This stand-in plays Forecast: it places the stubbed publication (ctx.Forecast.stackCreditLines, called as Forecast
  // calls it) on the selected view before the card reads it; with no stub, the view carries none.
  ctx.StackBlocks.register = (name, fn) => {
    raw[name] = fn;
    fns[name] = (el, c) => { publishCredit(c); return fn(el, c); };
    register(name, fns[name]);
  };
  vm.runInContext(creditSrc || read('public/stack-credit.js'), ctx);
  vm.runInContext(read('public/stack-sheet.js'), ctx);
  // A sheet opened directly reads the same view publication: the stand-in places it first, as for the card.
  if (ctx.StackSheet && typeof ctx.StackSheet.html === 'function') {
    const sheetHtml = ctx.StackSheet.html;
    ctx.StackSheet.html = (c, ...rest) => { publishCredit(c); return sheetHtml(c, ...rest); };
  }
  return { win: ctx, fns, raw };
}
function publishCredit(c) {
  const views = c && c.recommendation && Array.isArray(c.recommendation.payPeriodViews) ? c.recommendation.payPeriodViews : [];
  const view = views.find(v => v && v.start === c.selectedPeriodKey);
  if (!view) return;
  const F = c.Forecast || {};
  const pub = typeof F.cardPeriodMovements === 'function'
    ? F.cardPeriodMovements(c.plan, c.data && c.data.debts, c.data && c.data.meta && c.data.meta.asOf, { start: view.start, end: view.end },
      { liveOverlay: null }) : null;
  const credit = typeof F.stackCreditLines === 'function' ? F.stackCreditLines(pub, view.stackSummary ? view.stackSummary.bills : null) : null;
  view.stackSummary = { ...(view.stackSummary || {}), credit: credit || null };
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
    state: 'not-a-spend-card', status: null, minimumCovered: { value: 'unknown', trust: 'unavailable', reasons: [] }, transactions: [] },
];
const VIEW = {
  start: '2031-03-01', end: '2031-03-14',
  // The head's minimums come from the Credit totals, never from the waterfall's surplus.terms.credit (a different figure: it includes the HELOC's minimum).
  stackSummary: { bills: { amount: 1, trust: 'calculated' }, surplus: { amount: 10, terms: { credit: 999 }, trust: 'calculated' } },
  // A paid bill whose payment posted on another day, from another account, than planned (invented extra fields the
  // sheet must not read: Forecast publishes neither on the row).
  bills: [{ id: 'water', date: '2031-03-05', postedOn: '2031-03-07', paidFromLabel: 'Savings', label: 'Water', amount: 64, paidState: 'paid', payerLabel: 'Chequing' },
    { id: 'mort', date: '2031-03-12', label: 'Mortgage', amount: 1850, paidState: 'not-paid', payerLabel: 'Joint' }],
  householdBudget: [{ id: 'groceries', label: 'Groceries', spent: 310, planned: 500, remaining: 190, overspend: 0 },
    { id: 'fun', label: 'Fun', spent: 130, planned: 100, remaining: 0, overspend: 30 }],
};
// Forecast's billHistory (#1446) for the invented bills, newest first. Water's headline entry carries the paid actual
// (64), a different figure from nothing else on the row; an older one is unpublished; a future one is not history.
const HISTORY = {
  water: [
    { date: '2031-04-05', amount: 64, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
    { date: '2031-03-05', amount: 64, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true },
    { date: '2031-02-05', amount: 61.5, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true },
    { date: '2031-01-05', amount: null, amountBasis: 'schedule', trust: 'unavailable', paidState: 'not-paid' }],
  mort: [{ date: '2031-03-12', amount: 1850, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' }],
};
function context(totals, calls = []) {
  return {
    data: { debts: [], meta: { asOf: '2031-03-10' }, liveOverlay: null }, plan: {}, selectedPeriodKey: VIEW.start,
    recommendation: { payPeriodViews: [VIEW], billHistory: HISTORY },
    Forecast: {
      cardPeriodMovements: (...args) => { calls.push(args); return { invented: true }; },
      stackCreditLines: (pub, bills) => { calls.push(['lines', pub, bills]); return { lines: withTargets(LINES), totals }; },
    },
  };
}
// Forecast's published minimums over the same spend cards as paid: a sum, and how many are due and how many are covered.
const MINS = { minimumsPaid: { amount: 120, trust: 'calculated', reasons: [] }, minimumsDue: { amount: 345, trust: 'calculated', reasons: [] }, minimumsDueCount: 4, minimumsCoveredCount: 3, minimumsCoveredTrust: 'calculated' };
const TOTALS = {
  complete: { paid: 500, spent: 660, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [], ...MINS },
  partial: { paid: 500, spent: 660, trust: 'calculated', completeness: 'partial', excluded: ['tdcc'], reasons: ['x'], ...MINS },
  partialNone: { paid: 500, spent: 660, trust: 'calculated', completeness: 'partial', excluded: [], reasons: ['x'], ...MINS },
  none: { paid: null, spent: null, trust: 'unknown', completeness: 'none', excluded: ['travelvisa', 'cashback', 'tdcc'], reasons: ['x'], ...MINS },
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

console.log('2. closed card: "paid / card minimums due"');
{
  const complete = card(TOTALS.complete);
  ok(/data-stack-credit-total/.test(complete.html) && text(complete.html).startsWith('Credit paid / card minimums due $120 / $345 Blue Visa'),
    'complete: the head reads "Credit", its subtitle and the published paid toward the due minimums over those minimums (not totals.paid, which is 500)', text(complete.html).slice(0, 60));
  ok(/stack-credit-bar/.test(complete.html), 'complete: the total bar is drawn');
  // The head's paid side is totals.minimumsPaid, whatever the paid total's completeness (Dale, 2026-11-20: a partial or missing
  // paid total no longer turns it into "— / $345"); with the minimums due withheld, one soft dash alone.
  const partial = card(TOTALS.partial), none = card(TOTALS.none);
  for (const [label, c] of [['partial', partial], ["'none'", none]]) {
    ok(/data-stack-credit-total>/.test(c.html) && /stack-credit-bar" aria-hidden="true"><i style="width:75.0%">/.test(c.html) && !/\$500|\$660/.test(c.html)
      && text(c.html).startsWith('Credit paid / card minimums due $120 / $345 Blue Visa'), `${label}: the paid toward the due minimums over the minimums, not a dash; the bar is covered over due (3 of 4)`, text(c.html).slice(0, 70));
  }
  {
    const { fns } = load();
    const el = container();
    const ctx = context(TOTALS.none);
    ctx.recommendation = { payPeriodViews: [VIEW] };
    ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(LINES), totals: { ...TOTALS.none, minimumsPaid: { amount: null, trust: 'unavailable', reasons: ['minimums-due-withheld'] }, minimumsDue: { amount: null, trust: 'unavailable', reasons: ['bills-split-unavailable'] }, minimumsDueCount: null, minimumsCoveredCount: null, minimumsCoveredTrust: 'unavailable' } }) };
    fns.credit(el, ctx);
    ok(/data-stack-credit-total data-unpublished>—</.test(el.innerHTML) && text(el.innerHTML).startsWith('Credit paid / card minimums due — Blue Visa'),
      'paid and minimums both withheld: one dash, no figure');
  }
  {
    const { fns } = load();
    const el = container();
    fns.credit(el, { ...context(TOTALS.complete), Forecast: { cardPeriodMovements: () => ({}) } });
    ok(el.innerHTML === '', 'with no Credit publication on the view (stackSummary.credit) the card renders nothing');
  }
  // Desk ruling (E): the real renderer (no stand-in) prints the selected view's published Credit lines and needs no
  // Forecast function: Forecast here has none.
  {
    const { raw } = load();
    const el = container();
    const c = context(TOTALS.complete);
    const view = { ...VIEW, stackSummary: { ...VIEW.stackSummary, credit: { lines: withTargets(LINES), totals: TOTALS.complete } } };
    raw.credit(el, { ...c, recommendation: { ...c.recommendation, payPeriodViews: [view] }, Forecast: {} });
    ok(text(el.innerHTML).startsWith('Credit paid / card minimums due $120 / $345 Blue Visa'),
      'the card prints the view\'s published Credit lines, calling no Forecast function', text(el.innerHTML).slice(0, 60));
  }
}

// The six states of a row's "X / minimum", as one function so the mutants below can run it against altered source.
// Invented lines: paid, spent, minimum and the published to-go and coverage; the page only picks and prints.
const fig6 = (id, label, paid, spent, min, toGo, status, cv, trusts = {}) => ({ id, label,
  paid: paid == null ? null : fig(paid, trusts.paid), spent: spent == null ? null : fig(spent, trusts.spent), net: fig(0),
  minimum: min == null ? { amount: null, trust: 'unavailable', reasons: [trusts.minReason || 'no-minimum-due-in-period'] } : fig(min, trusts.min), toGo: fig(toGo, trusts.toGo), state: 'x', status,
  minimumCovered: { value: cv, trust: cv === 'unknown' ? 'unknown' : (trusts.cv || 'calculated'), reasons: [] }, transactions: [] });
const STATES = [
  fig6('over', 'Overpaid Card', 250, 90, 50, 0, 'paid-back', true),                  // 1 paid the minimum or more: green, ✓
  fig6('short', 'Short Card', 100, 100, 170, 0, 'paid-back', false),                  // 2 paid, below the minimum: plain
  { ...fig6('red', 'Red Card', 100, 260, 25, 175, 'to-go', false), target: { amount: 260, trust: 'calculated', reasons: [], newCharges: 260, minimum: 25, overLimitBy: 0 } }, // 3 behind its target: Paid back / target, plain (OD-033: never a red net)
  fig6('nothing', 'Quiet Card', 0, 0, 100, 0, 'paid-back', false),                     // 4 nothing spent or paid: $0 / $min, plain, no ✓ (the check is not covered)
  fig6('nomin', 'Free Card', 5, 5, null, 0, 'paid-back', 'unknown'),                  // 5 no minimum due: X alone, no ✓
  fig6('nopub', 'Dark Card', null, null, 50, null, null, 'unknown'),                      // 6 paid / spent unpublished: "— / $min"
  fig6('unk', 'Unknown Card', 100, 100, 50, 0, 'paid-back', 'unknown'),               // unknown coverage: no green, no ✓
  fig6('soonest', 'Upcoming Card', 20, 20, 40, 0, 'upcoming', true),                  // a future period: no colour, no ✓
  fig6('weak1', 'Weak Card', 100, 100, 50, 0, 'paid-back', true, { cv: 'unavailable' }),  // covered true on trust 'unavailable': no green, no ✓
  fig6('weak2', 'Odd Card', 100, 100, 50, 0, 'paid-back', true, { cv: 'unknown' }),       // covered true on an unrecognised trust word: no green, no ✓
  fig6('minoff', 'Hidden Card', 100, 100, null, 0, 'paid-back', 'unknown', { minReason: 'bills-split-unavailable' }), // the minimum is withheld, not "not due": "$100 / —", never reassurance
  { ...fig6('redcov', 'Covered Red Card', 100, 260, 25, 175, 'to-go', true), target: { amount: 260, trust: 'calculated', reasons: [], newCharges: 260, minimum: 25, overLimitBy: 0 } }, // the minimum covered, the target not: the ✓, plain ink (Neon REPORT 4)
  fig6('nothingcov', 'Odd Quiet Card', 0, 0, 100, 0, 'paid-back', true),               // a published covered check with nothing spent or paid: the ✓ shows (it is the check), the ink stays plain
  fig6('zero', 'Zero Card', 100, 100, 0, 0, 'paid-back', true),                         // a published $0 minimum is nothing owed: X alone, no ✓, like "not due"
  { ...fig6('weaktgt', 'Weak Target Card', 100, 100, 50, 0, 'paid-back', false), targetCovered: { value: true, trust: 'unavailable', reasons: [] } }, // targetCovered on trust unavailable: no green
  { ...fig6('pend', 'Pending Pay Card', 150, 120, 25, 0, 'paid-back', true), target: { amount: 120, trust: 'calculated', reasons: [], newCharges: 120, minimum: 25, overLimitBy: 0 },
    paidToward: { amount: 100, trust: 'calculated', reasons: [] } }, // 50 of the 150 paid is pending: Paid back is the posted 100, plain (100 < 120)
];
function states(creditSrc) {
  const { fns, win } = load(creditSrc);
  const ctx = context(TOTALS.complete);
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(STATES), totals: TOTALS.complete }) };
  const el = container();
  fns.credit(el, ctx);
  const rows = el.innerHTML.split('<li>').slice(1);
  const fig = r => (/<span class="stack-credit-fig stack-n">([\s\S]*?)<\/span><svg/.exec(r) || [])[1] || '';
  const out = {};
  out.over = text(rows[0]) === 'Overpaid Card +$250 / $50' && /stack-credit-x is-good"[^>]*>\+\$250</.test(rows[0]) && /stack-credit-tick is-on"/.test(rows[0]);
  out.short = text(rows[1]) === 'Short Card +$100 / $170' && !/is-good|is-bad|is-on/.test(rows[1]);
  out.red = text(rows[2]) === 'Red Card +$100 / $260' && !/is-good|is-bad|is-on/.test(rows[2]);
  out.nothing = text(rows[3]) === 'Quiet Card $0 / $100' && !/is-good|is-bad|is-on/.test(rows[3]);
  out.nomin = text(rows[4]) === 'Free Card +$5' && !/ \/ |is-good|is-on/.test(fig(rows[4]));
  out.nopub = text(rows[5]) === 'Dark Card — / $50' && !/is-good|is-bad|is-on/.test(rows[5]);
  out.unk = text(rows[6]) === 'Unknown Card +$100 / $50' && /stack-credit-x is-good"/.test(rows[6]) && !/is-on/.test(rows[6]);
  out.soonest = text(rows[7]) === 'Upcoming Card +$20 / $40' && !/is-good|is-bad/.test(rows[7]) && /stack-credit-tick is-on"/.test(rows[7]);
  out.weak = text(rows[8]) === 'Weak Card +$100 / $50' && text(rows[9]) === 'Odd Card +$100 / $50' && !/is-on/.test(rows[8] + rows[9]);
  out.weakTarget = text(rows[14]) === 'Weak Target Card +$100 / $50' && !/is-good|is-on/.test(rows[14]);
  out.pend = text(rows[15]) === 'Pending Pay Card +$100 / $120' && !/is-good/.test(rows[15]);
  out.redcov = text(rows[11]) === 'Covered Red Card +$100 / $260' && !/is-good|is-bad/.test(rows[11]) && /stack-credit-tick is-on/.test(rows[11]);
  out.nothingcov = text(rows[12]) === 'Odd Quiet Card $0 / $100' && !/is-good|is-bad/.test(rows[12]) && /stack-credit-tick is-on/.test(rows[12]);
  out.zero = text(rows[13]) === 'Zero Card +$100' && !/is-good|is-on| \/ /.test(rows[13].split('<svg class="stack-chev"')[0].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')) && /Not due this period/.test(win.StackSheet.html(ctx, 'card:zero'));
  out.minoff = text(rows[10]) === 'Hidden Card +$100 / \u2014' && !/is-good|is-on/.test(rows[10]) && /<i class="stack-credit-of"> \/ <span class="stack-credit-dash"/.test(rows[10]);
  out.sheetMinoff = /<dt>Minimum<\/dt><dd class="stack-n"><span class="stack-credit-dash"[^>]*>\u2014<\/span><\/dd>/.test(win.StackSheet.html(ctx, 'card:minoff')) && !/Not due this period/.test(win.StackSheet.html(ctx, 'card:minoff'));
  out.sheetOver = /<div class="stack-sheet-big stack-credit-big stack-n"><span class="stack-credit-x is-good"[^>]*>\+\$250<\/span><i class="stack-credit-of"> \/ \$50<\/i><\/div>/.test(win.StackSheet.html(ctx, 'card:over'));
  out.sheetRed = /<span class="stack-credit-x" role="img" aria-label="Paid back \$100">\+\$100<\/span><i class="stack-credit-of"> \/ \$260<\/i>/.test(win.StackSheet.html(ctx, 'card:red'));
  return out;
}

console.log('2b. the head: paid / card minimums due from Forecast\'s totals, a bar of covered over due (the in-house reviewer on #1481)');
{
  // The reviewer's probe, as Forecast would publish it: paid 500 on one card with a 30 minimum, a second card paid 0 with a 40
  // minimum (not covered), and a third with a 400 minimum and no payment evidence: 3 due, 1 covered, 470 due.
  const probe = { ...TOTALS.complete, paid: 500, minimumsPaid: { amount: 500, trust: 'calculated', reasons: [] }, minimumsDue: { amount: 470, trust: 'calculated', reasons: [] }, minimumsDueCount: 3, minimumsCoveredCount: 1 };
  const headOf = (creditSrc, totals) => {
    const { fns } = load(creditSrc);
    const el = container();
    fns.credit(el, context(totals));
    return el.innerHTML;
  };
  const html = headOf(undefined, probe);
  ok(text(html).startsWith('Credit paid / card minimums due $500 / $470 Blue Visa') && /stack-credit-bar" aria-hidden="true"><i style="width:33\.3%">/.test(html),
    'paid $500 over minimums $470 with 1 of 3 covered: the bar is a third, not full', text(html).slice(0, 50) + ' ' + (html.match(/width:[\d.]+%/) || [])[0]);
  ok(!/stack-credit-sub/.test(html) && /<span class="stack-credit-sr">paid \/ card minimums due<\/span>/.test(html)
    && /\.stack-credit-sr \{ position: absolute; width: 1px; height: 1px;[^}]*clip: rect\(0 0 0 0\)/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-credit.css'), 'utf8')),
    'no visible grey subtitle under Credit (Dale, 2026-11-20); the words stay as screen-reader-only text, really hidden');
  ok(!/999/.test(html), 'the head never reads the waterfall\'s Credit line (surplus.terms.credit, a different figure that includes the HELOC)');
  const full = headOf(undefined, { ...probe, minimumsDue: { amount: 55, trust: 'calculated', reasons: [] }, minimumsDueCount: 2, minimumsCoveredCount: 2 });
  ok(/stack-credit-bar" aria-hidden="true"><i style="width:100\.0%">/.test(full), 'every due minimum covered: the bar is full');
  const none = headOf(undefined, { ...probe, minimumsDue: { amount: 0, trust: 'calculated', reasons: [] }, minimumsDueCount: 0, minimumsCoveredCount: 0 });
  ok(/\$500<\/span><i class="">  ?\/ \$0<\/i>/.test(none.replace(/\s+/g, ' ').replace('> /', '>  /')) || /\/ \$0/.test(text(none)), 'nothing due: "$500 / $0"');
  ok(/stack-credit-bar" aria-hidden="true"><i style="width:0%">/.test(none), 'nothing due: an empty track (no ratio of zero)');
  const off = headOf(undefined, { ...probe, minimumsDue: { amount: null, trust: 'unavailable', reasons: ['bills-split-unavailable'] }, minimumsDueCount: null, minimumsCoveredCount: null, minimumsCoveredTrust: 'unavailable' });
  ok(text(off).startsWith('Credit paid / card minimums due $500 / — Blue Visa') && /stack-credit-bar" aria-hidden="true"><i style="width:0%">/.test(off),
    'a withheld minimums total: "$500 / —" and an empty track, never a guessed figure');
  // Dale, 2026-11-20 ("needs to 0 / owed if nothing has been paid yet"): a published $0 is printed, never a dash; a soft paid
  // figure is drawn soft; no published minimumsPaid (an older publication) is a dash.
  const zero = headOf(undefined, { ...probe, minimumsPaid: { amount: 0, trust: 'calculated', reasons: [] } });
  ok(text(zero).startsWith('Credit paid / card minimums due $0 / $470 Blue Visa') && !/\u2014 \//.test(text(zero).slice(0, 50)),
    'nothing paid toward the due minimums: "$0 / $470", never a dash');
  const soft120 = headOf(undefined, { ...probe, minimumsPaid: { amount: 120, trust: 'estimated', reasons: [] } });
  ok(text(soft120).startsWith('Credit paid / card minimums due $120 / $470') && /data-stack-credit-total><span>\$120<\/span>/.test(soft120) && !/data-stack-credit-total><span class="[^"]*stack-est/.test(soft120),
    'an estimated paid figure (a payment to confirm, or a card Forecast cannot see counted $0) prints in normal type: "$120 / $470", no soft styling (Dale, 2026-11-20)');
  const zeroEst = headOf(undefined, { ...probe, minimumsPaid: { amount: 0, trust: 'estimated', reasons: ['paid-unavailable-counted-as-zero'] } });
  ok(text(zeroEst).startsWith('Credit paid / card minimums due $0 / $470') && /data-stack-credit-total><span>\$0<\/span>/.test(zeroEst),
    'a due card Forecast cannot see counts $0 by owner decision: "$0 / $470" in normal type, not a dash');
  const cannotSee = headOf(undefined, { ...probe, minimumsPaid: { amount: null, trust: 'unavailable', reasons: ['paid-unavailable', 'account-transaction-evidence-unavailable'] } });
  ok(text(cannotSee).startsWith('Credit paid / card minimums due — / $470 Blue Visa') && !/\$0/.test(text(cannotSee).slice(0, 50)),
    'a past period with incomplete posted coverage (Forecast withholds the paid side): a dash over the published minimums, never a $0');
  const overpaid = headOf(undefined, { ...probe, minimumsPaid: { amount: 900, trust: 'calculated', reasons: [] } });
  ok(text(overpaid).startsWith('Credit paid / card minimums due $900 / $470'), 'an overpaid total prints its full published paid (uncapped)');
  const legacy = headOf(undefined, (({ minimumsPaid, ...rest }) => rest)(probe));
  ok(text(legacy).startsWith('Credit paid / card minimums due — / $470'), 'no published minimumsPaid: a dash on the paid side, never a guess');
  // mutants: the old head (paid over the same figure, a bar of paid over due) reads full on the probe, and must be caught
  const src = read('public/stack-credit.js');
  const oldBar = src.replace('bar(t.minimumsCoveredCount, t.minimumsDueCount,', 'bar(t.paid, due,');
  ok(oldBar !== src && /style="width:100\.0%"/.test(headOf(oldBar, probe)) && !/style="width:100\.0%"/.test(html),
    'MUTANT: a bar of paid over minimums due reads full on the probe (the false reassurance); the real bar does not');
  const waterfall = src.replace('const due = md && num(md.amount) ? md.amount : null;', 'const due = view.stackSummary.surplus.terms.credit;');
  ok(waterfall !== src && /\$500 \/ \$999/.test(text(headOf(waterfall, probe))) && !/999/.test(html),
    'MUTANT: a head that reads the waterfall\'s Credit line (which includes the HELOC) is caught');
}

console.log('3a. X has an accessible name, so colour is not the only signal (in-house reviewer on #1481)');
{
  const { fns, win } = load();
  const ctx = context(TOTALS.complete);
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(STATES.concat([fig6('softred', 'Soft Owed', 100, 260, 25, 160, 'to-go', false, { toGo: 'estimated' })])), totals: TOTALS.complete }) };
  const el = container();
  fns.credit(el, ctx);
  const rows = el.innerHTML.split('<li>').slice(1);
  const name = r => (/stack-credit-x[^"]*"( role="img" aria-label="([^"]*)")?/.exec(r) || [])[2];
  ok(name(rows[0]) === 'Paid back $250' && name(rows[1]) === 'Paid back $100' && name(rows[3]) === 'Paid back $0', 'X is named "Paid back $X" (OD-033)', [rows[0], rows[1], rows[3]].map(name).join(' | '));
  ok(name(rows[2]) === 'Paid back $100', 'a card behind its target is named the same way: no "Owes" (the left side is never a net)', name(rows[2]));
  ok(name(rows[16]) === 'Paid back $100', 'an estimated X is named exactly as a calculated one (no ", estimated")', name(rows[16]));
  ok(name(rows[5]) === undefined && /aria-label="not available"/.test(rows[5]), 'an unpublished X has no amount name; its dash is named "not available"');
  const sheet = win.StackSheet.html(ctx, 'card:red');
  ok(/stack-credit-x" role="img" aria-label="Paid back \$100">\+\$100</.test(sheet), 'the sheet\'s big figure carries the same name');
}

console.log('3. the row states (OD-033: "Paid back / Total to pay back", green when the target is reached, the ✓ when the minimum is covered)');
{
  const r = states();
  const names = {
    over: 'paid back the target or more: green "+$250 / $50" with the filled ✓',
    short: 'paid back below the target: "+$100 / $170" in plain ink, no ✓',
    red: 'behind its target: "+$100 / $260", the posted paid back (never the red net), plain ink, no ✓',
    nothing: 'nothing spent or paid: "$0 / $100" in plain ink, no ✓ (its check is not covered)',
    nomin: 'no minimum due: the amount alone, no "/ min", no ✓',
    nopub: 'paid and spent unpublished (the HELOC): "— / $50", plain ink, no ✓',
    unk: "an unknown minimum check: no ✓; the target reached is still green (two published checks, read apart)",
    soonest: "an upcoming line: no colour, and the ✓ only because its check is published covered",
    redcov: 'the minimum covered but not the target: the ✓ in plain ink, never green (Neon REPORT 4: green keys off the target)',
    nothingcov: 'a published covered check shows the ✓ even with nothing spent or paid, in plain ink (the row, the bar and the waterfall agree)',
    zero: 'a published $0 minimum is nothing owed: X alone, no ✓, "Not due this period" on the sheet',
    weak: 'a minimum check on trust unavailable or an unrecognised word shows no ✓ (the in-house reviewer\'s cross-check)',
    weakTarget: 'targetCovered on trust unavailable is no check: no green',
    pend: 'a pending payment is not paid back (Grok Bot condition 1): "+$100 / $120" from the posted paidToward, plain',
    minoff: 'a withheld minimum (bills split unavailable) reads "$100 / —", not "not due" (Codex on #1481)',
    sheetMinoff: 'the sheet\'s Minimum row is a dash for a withheld minimum, "Not due this period" only for the explicit no-minimum-due reason',
    sheetOver: 'the sheet\'s big figure is the same "Paid back / target" with the same colour',
    sheetRed: 'the sheet\'s big figure for a card behind its target is the same plain "Paid back / target"',
  };
  for (const key of Object.keys(names)) ok(r[key] === true, names[key], key);
  const html = card(TOTALS.complete).html;
  const rows = html.split('<li>').slice(1).map(text);
  ok(rows.length === 4, 'one row per published line', String(rows.length));
  ok(rows[0] === 'Blue Visa +$400 / $25' && rows[1] === 'Green Card +$100 / $30'
    && rows[2] === 'Red Card $0 / $15' && rows[3] === 'Line of credit — / $210', 'the four invented lines read as designed', rows.join(' | '));
  ok(/data-stack-sheet="card:cashback"/.test(html) && (html.match(/data-stack-sheet="card:/g) || []).length === 4, 'every row opens the sheet');
  ok(/<span class="stack-credit-tick is-on" role="img" aria-label="Minimum covered">/.test(html.split('<li>')[1]) && !/is-on|aria-label="Minimum/.test(html.split('<li>')[2].split('stack-credit-name')[0]),
    'a filled tick is read as "Minimum covered"; an empty one is not named');
  ok(!/Paid back|to go|not yet|covered ✓|Minimum \$|Owes/.test(text(html)), 'no printed words on the rows: no "Paid back", "$X to go", "Owes" or "Minimum $X covered ✓ / not yet" (the name is for a screen reader only)');
  ok(!/stack-credit-status|stack-credit-pill/.test(html), 'the old status column and pill are gone');
}

console.log('3b. an estimated field draws plain (owner decision, Dale, 2026-11-23: no estimate styling)');
{
  const { fns } = load();
  const MORE = [
    fig6('softx', 'Soft Paid', 100, 100, 50, 0, 'paid-back', true, { paid: 'estimated' }),
    fig6('softmin', 'Soft Minimum', 100, 100, 50, 0, 'paid-back', true, { min: 'estimated' }),
    fig6('softcv', 'Soft Check', 100, 100, 50, 0, 'paid-back', true, { cv: 'estimated' }),
    fig6('softred', 'Soft Owed', 100, 260, 25, 160, 'to-go', false, { toGo: 'estimated' }),
  ];
  const ctx = context(TOTALS.complete);
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(MORE), totals: TOTALS.complete }) };
  const el = container();
  fns.credit(el, ctx);
  const rows = el.innerHTML.split('<li>').slice(1);
  ok(/stack-credit-x is-good"[^>]*>\+\$100</.test(rows[0]) && /<i class="stack-credit-of"> \/ \$50<\/i>/.test(rows[0]), 'an estimated paid: X and "/ min" plain');
  ok(/stack-credit-x is-good"[^>]*>\+\$100</.test(rows[1]) && /<i class="stack-credit-of"> \/ \$50<\/i>/.test(rows[1]), 'an estimated minimum: "/ min" plain');
  ok(/stack-credit-tick is-on"/.test(rows[2]) && /stack-credit-x is-good"[^>]*>\+\$100</.test(rows[2]), 'an estimated coverage check: the ✓ plain');
  ok(/stack-credit-x[^"]*"[^>]*>\+\$100</.test(rows[3]) && !/is-bad|−/.test(rows[3]), 'an estimated toGo moves nothing: the row reads Paid back, plain, never a red net');
  ok(!/stack-est/.test(el.innerHTML), 'no estimate class on any row');
  const { win } = load();
  const sheet = win.StackSheet.html(ctx, 'card:softmin');
  ok(/<dt>Minimum<\/dt><dd class="stack-n"><span class="">\$50<\/span> <span class="">✓<\/span><\/dd>/.test(sheet),
    'the sheet\'s Minimum row: an estimated minimum draws the amount and the ✓ plain', sheet.match(/<dt>Minimum[\s\S]*?<\/dd>/)[0]);
  const sheetCv = win.StackSheet.html(ctx, 'card:softcv');
  ok(/<dt>Minimum<\/dt><dd class="stack-n"><span class="">\$50<\/span> <span class="">✓<\/span><\/dd>/.test(sheetCv),
    'an estimated coverage check: the amount and the ✓ plain', sheetCv.match(/<dt>Minimum[\s\S]*?<\/dd>/)[0]);
}

console.log('4. no ratio text');
{
  const html = card(TOTALS.complete).html;
  ok(!/%|\b0\.\d|ratio/i.test(text(html)), 'no percent, decimal ratio or ratio word in the text');
  const widths = [...html.matchAll(/width:([\d.]+)%/g)].map(m => m[1]);
  ok(widths.join() === '75.0', 'bar widths appear only as style widths (the head bar: Forecast\'s covered count over its due count, 3 of 4)', widths.join());
  ok((html.match(/%/g) || []).length === widths.length, 'every % in the markup is a bar width');
}

console.log('5. the sheet');
{
  const { win } = load();
  const ctx = context(TOTALS.complete);
  const visa = text(win.StackSheet.html(ctx, 'card:travelvisa'));
  ok(visa === 'Credit · Mar 1 – 14 Blue Visa +$400 / $25 Paid back $400 New charges $400 Minimum $25 ✓ Target $25'
    + ' Transactions Mar 3 Corner Grocer $150 Mar 9 Payment thank you +$400 Mar 10 Pending Cafe $12.50', 'card sheet', visa);
  const tx = win.StackSheet.html(ctx, 'card:travelvisa');
  ok(/class="is-pay"><span class="stack-sheet-txd">Mar 9/.test(tx) && /class=" is-pending"/.test(tx), 'a payment row is marked bold and a pending row dimmed');
  // A pending row also carries a hollow dot named "pending" (no printed word, rule B5); a posted row never does
  // (lead ruling, ATLAS LEAD 12, 2026-11-22, on Dale's walk: four pending rows dimmed alike read as plain grey text).
  const DOT = '<span class="stack-sheet-txp" role="img" aria-label="pending"></span>';
  const rowsOf = html => (html.match(/<li class="[^"]*">.*?<\/li>/g) || []);
  const pendingRows = rows => rows.filter(r => /^<li class="[^"]*is-pending/.test(r));
  const txRows = rowsOf(tx.slice(tx.indexOf('stack-sheet-tx"')));
  ok(txRows.length === 3 && pendingRows(txRows).length === 1 && pendingRows(txRows).every(r => r.includes(DOT))
    && txRows.filter(r => !/is-pending/.test(r)).every(r => !r.includes('stack-sheet-txp') && !/aria-label="pending"/.test(r)),
  'the pending row carries the hollow dot named "pending"; the posted rows carry none', JSON.stringify(txRows));
  ok(!/pending/i.test(text(tx).replace('Pending Cafe', '')),
    'no word "pending" is printed: the name is only the dot\'s accessible name');
  // All pending: nothing posted to compare against, so each row must carry the marker on its own.
  const saved = LINES[0].transactions;
  LINES[0].transactions = [{ date: '2031-03-10', name: 'Shop A', amount: 22.5, kind: 'purchase', payment: false, pending: true },
    { date: '2031-03-10', name: 'Shop B', amount: 230, kind: 'purchase', payment: false, pending: true },
    { date: '2031-03-10', name: 'Card transaction', amount: -230, kind: 'refund', payment: false, pending: true },
    { date: '2031-03-10', name: 'Shop B', amount: 230, kind: 'purchase', payment: false, pending: true }];
  try {
    const all = win.StackSheet.html(context(TOTALS.complete), 'card:travelvisa');
    const rows = rowsOf(all.slice(all.indexOf('stack-sheet-tx"')));
    ok(rows.length === 4 && rows.every(r => /^<li class="[^"]*is-pending/.test(r) && r.split(DOT).length === 2),
      'every row pending: every row is dimmed and carries exactly one dot named "pending"', JSON.stringify(rows));
    ok(text(all).includes('Paid back $400 New charges $400'), 'the marker moves no figure: Paid back and New charges print as before');
  } finally { LINES[0].transactions = saved; }
  // MUTANT: a sheet that drops the dot leaves an all-pending list unmarked, which the checks above reject.
  const src = read('public/stack-credit.js');
  ok(src.includes('${t.pending ? PENDING_DOT : \'\'}'), 'the mutant targets the pending-dot rule');
  const { win: mwin } = load(src.replace('${t.pending ? PENDING_DOT : \'\'}', ''));
  ok(!mwin.StackSheet.html(ctx, 'card:travelvisa').includes(DOT), 'MUTANT: without the dot rule no pending row is marked (the checks above fail on it)');
  ok(!/estimated|calculated|verified|≈|stack-sheet-bar|stack-credit-pill/.test(visa + tx.replace(/class="[^"]*"/g, '')), 'no tag printed, no bar or pill in the sheet');
  const heloc = text(win.StackSheet.html(ctx, 'card:heloc'));
  ok(heloc === 'Credit · Mar 1 – 14 Line of credit — / $210 Minimum $210', 'HELOC sheet: "— / $210" and its minimum, no ✓', heloc);
  const green = text(win.StackSheet.html(ctx, 'card:cashback'));
  ok(green === 'Credit · Mar 1 – 14 Green Card +$100 / $30 Paid back $100 New charges $260 Minimum $30 Target $30 Transactions', 'a card spending above its payments: Paid back, never a net; an empty list, no ✓', green);
  const red = text(win.StackSheet.html(ctx, 'card:tdcc'));
  ok(red === 'Credit · Mar 1 – 14 Red Card $0 / $15 Paid back $0 New charges $0 Minimum $15 Target $15 Transactions', "an upcoming card: '$0 / $15' and its minimum, no ✓", red);
  const water = text(win.StackSheet.html(ctx, 'bill:water@2031-03-05'));
  // Water is paid on a different date (Mar 7) from a different account (Savings) than scheduled (Mar 5, Chequing).
  ok(water === 'Bill · Mar 1 – 14 Water $64 ✓ Feb 5 $62 ✓ Jan 5 —' && !/Mar 5|Chequing|Mar 7|Savings|Due|Comes out|Apr 5/.test(water),
    'paid bill sheet: the amount and the check, then its earlier occurrences (date, amount or a dash, ✓ when paid); no planned or observed date and account, no future occurrence', water);
  const waterHtml = win.StackSheet.html(ctx, 'bill:water@2031-03-05'), mortHtml = win.StackSheet.html(ctx, 'mortgage:mort@2031-03-12');
  ok(waterHtml.includes('<span class="stack-sheet-check" role="img" aria-label="Paid">✓</span>') && !/Paid|Not paid/.test(text(waterHtml)),
    'a paid bill sheet shows the check (accessible name Paid) and no status word');
  ok(!mortHtml.includes('stack-sheet-check') && !mortHtml.includes('stack-sheet-togo') && !/Paid/.test(text(mortHtml)), 'an unpaid bill sheet shows no mark and no word');
  ok(text(win.StackSheet.html(ctx, 'mortgage:mort@2031-03-12')) === 'Mortgage · Mar 1 – 14 Mortgage $1,850 Mar 12 Joint', 'mortgage sheet');
  ok(text(win.StackSheet.html(ctx, 'budget:groceries')) === 'Budget · Mar 1 – 14 Groceries $310 / $500 Left $190', 'budget sheet');
  ok(text(win.StackSheet.html(ctx, 'budget:fun')) === 'Budget · Mar 1 – 14 Fun $130 / $100 Over $30', 'overspent budget sheet');
  ok(win.StackSheet.html(ctx, 'bill:water@2031-03-06') === null && win.StackSheet.html(ctx, 'card:nope') === null, 'an unknown key opens nothing');
  const bare = { ...ctx, Forecast: { cardPeriodMovements: () => ({}) } };
  ok(win.StackSheet.html(bare, 'card:travelvisa') === null, 'without Forecast.stackCreditLines nothing is read');
  const { win: w2 } = load();
  const states2 = context(TOTALS.complete);
  states2.Forecast = { ...states2.Forecast, stackCreditLines: () => ({ lines: withTargets(STATES), totals: TOTALS.complete }) };
  ok(text(w2.StackSheet.html(states2, 'card:nomin')) === 'Credit · Mar 1 – 14 Free Card +$5 Paid back $5 New charges $5 Minimum Not due this period Target $0 Transactions',
    'a card with no minimum due: "$5" alone and "Minimum Not due this period"', text(w2.StackSheet.html(states2, 'card:nomin')));
  ok(/Minimum \$50 Target \$50 Transactions/.test(text(w2.StackSheet.html(states2, 'card:unk'))) && !/✓/.test(text(w2.StackSheet.html(states2, 'card:unk'))),
    "an unknown coverage check: the minimum, no ✓");
}

console.log('5b. mutants: the checks above must catch each of these (a failing mutant proves the check is not vacuous)');
{
  const src = read('public/stack-credit.js');
  const run = mutant => { try { return Object.values(states(mutant)).every(Boolean); } catch (e) { return false; } };
  ok(run(src) === true, 'control: the real source passes every state check');
  const greenAlways = src.replace('min != null && cv === true', 'min != null');
  ok(greenAlways !== src && run(greenAlways) === false, 'MUTANT: green without a published covered check (a false or unknown check turns green) is caught');
  const greenOnUnknown = src.replace('min != null && cv === true', 'min != null && cv !== false');
  ok(greenOnUnknown !== src && run(greenOnUnknown) === false, 'MUTANT: an unknown coverage check read as covered is caught');
  const notDueAlways = src.replace("published == null && minReasons.includes('no-minimum-due-in-period')", 'published == null');
  ok(notDueAlways !== src && run(notDueAlways) === false, 'MUTANT: any null minimum read as "not due" (the withheld bills split reads as reassurance) is caught');
  const trustBlind = src.replace("&& COVERAGE_TRUST.includes(line.minimumCovered.trust) ? line.minimumCovered.value : null);", '? line.minimumCovered.value : null);');
  ok(trustBlind !== src && run(trustBlind) === false, 'MUTANT: a covered check read without its trust (green on trust unavailable) is caught');
  const redNoTick = src.replace('if (min != null && cv === true) {', "if (min != null && cv === true && line.status !== 'to-go') {");
  ok(redNoTick !== src && run(redNoTick) === false, 'MUTANT: no ✓ on a red row that has covered its minimum (the ✓ must mean covered, whatever the colour) is caught');
  const zeroDue = src.replace('const min = published === 0 ? null : published;', 'const min = published;');
  ok(zeroDue !== src && run(zeroDue) === false, 'MUTANT: a published $0 minimum read as a minimum due is caught');
  // The printed sign: "+" on a payment, nothing on $0, never a minus (OD-033: the left side is never a net).
  const noSign = src.replace("const signed = r => (r.x > 0 ? '+' + money(r.x) : money(r.x));", 'const signed = r => money(r.x);');
  ok(noSign !== src && run(noSign) === false, 'MUTANT: X printed without its "+" is caught');
  const zeroPlus = src.replace('r.x > 0 ?', 'r.x >= 0 ?');
  ok(zeroPlus !== src && run(zeroPlus) === false, 'MUTANT: a "+$0" (a sign on nothing) is caught');
  // Green keys off Forecast's targetCovered, never the minimum (Neon REPORT 4).
  const greenOnMinimum = src.replace("const covered = line.targetCovered && line.targetCovered.value === true && COVERAGE_TRUST.includes(line.targetCovered.trust);", 'const covered = cv === true;');
  ok(greenOnMinimum !== src && run(greenOnMinimum) === false, 'MUTANT: green keyed off the minimum covered (the old rule: a card short of its target turns green) is caught');
  const greenTrustBlind = src.replace('line.targetCovered.value === true && COVERAGE_TRUST.includes(line.targetCovered.trust)', 'line.targetCovered.value === true');
  ok(greenTrustBlind !== src && run(greenTrustBlind) === false, 'MUTANT: targetCovered read without its trust (green on trust unavailable) is caught');
  // Paid back is posted only (Grok Bot's condition 1): X reads paidToward, never line.paid (which counts pending payments).
  const paidWithPending = src.replace('const toward = amountOf(line.paidToward);', 'const toward = amountOf(line.paid) != null ? amountOf(line.paid) : amountOf(line.paidToward);');
  ok(paidWithPending !== src && run(paidWithPending) === false, 'MUTANT: Paid back read from line.paid (pending counted) is caught');
  const arith = src.replace('if (toward != null) out.x = toward;', 'if (toward != null) out.x = out.spent - toward;');
  // The static L-001 pattern (section 6) flags that arithmetic too.
  const ARITH = /\.reduce\(|Math\.(round|floor|ceil)\(|\b(amount|paid|spent|net|minimum|planned|remaining|overspend)\s*[+\-*/]\s|[\s(][+\-*/]\s*(paid|spent|t\.amount|\w+\.amount)\b/;
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''");
  ok(!ARITH.test(strip(src)) && ARITH.test(strip(arith)), 'the L-001 pattern passes the real source and flags the arithmetic mutant');
}

console.log('5b. a row without a card ledger reads the published paidToward in normal type (Dale, 2026-11-20)');
{
  const { fns } = load();
  const none = fig(null, 'unavailable');
  const tw = (amount, trust = 'estimated', reasons = []) => ({ amount, trust, reasons });
  // Invented lines shaped like Forecast's: a tracked card, a manual card owing 900, a manual card with nothing due, the HELOC.
  const LN = [
    { id: 'tracked', label: 'Tracked Card', paid: fig(0), spent: fig(0), minimum: fig(17), toGo: fig(0), status: 'paid-back', paidToward: tw(0, 'calculated'),
      minimumCovered: { value: false, trust: 'calculated' }, transactions: [] },
    { id: 'manual', label: 'Manual Card', paid: none, spent: none, minimum: fig(900), toGo: none, status: null,
      paidToward: tw(0, 'estimated', ['paid-unavailable-counted-as-zero']), minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
    { id: 'nodue', label: 'No Due Card', paid: none, spent: none, minimum: { amount: null, trust: 'unavailable', reasons: ['no-minimum-due-in-period'] }, toGo: none, status: null,
      paidToward: tw(0, 'estimated', ['paid-unavailable-counted-as-zero']), minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
    { id: 'heloc', label: 'HELOC', paid: null, spent: null, minimum: fig(814), toGo: none, status: null, state: 'not-a-spend-card',
      paidToward: tw(0), minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
    { id: 'helocpaid', label: 'HELOC Paid', paid: null, spent: null, minimum: fig(814), toGo: none, status: null, state: 'not-a-spend-card',
      paidToward: tw(150), minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
    { id: 'past', label: 'Past Card', paid: none, spent: none, minimum: fig(40), toGo: none, status: null,
      paidToward: { amount: null, trust: 'unavailable', reasons: ['paid-unavailable'] }, minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
    { id: 'legacy', label: 'Legacy Card', paid: none, spent: none, minimum: fig(25), toGo: none, status: null,
      minimumCovered: { value: 'unknown', trust: 'unavailable' }, transactions: [] },
  ];
  const ctx = context({ ...TOTALS.complete, minimumsPaid: { amount: 0, trust: 'estimated', reasons: ['paid-unavailable-counted-as-zero'] },
    minimumsDue: { amount: 917, trust: 'calculated', reasons: [] }, minimumsDueCount: 2, minimumsCoveredCount: 0 });
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(LN), totals: { ...TOTALS.complete, minimumsPaid: { amount: 0, trust: 'estimated', reasons: [] },
    minimumsDue: { amount: 917, trust: 'calculated', reasons: [] }, minimumsDueCount: 2, minimumsCoveredCount: 0 } }) };
  const el = container();
  fns.credit(el, ctx);
  const rows = el.innerHTML.split('<li>').slice(1);
  const fig4 = r => (/<span class="stack-credit-fig stack-n">([\s\S]*?)<\/span><svg/.exec(r) || [, ''])[1];
  ok(text(rows[1]) === 'Manual Card $0 / $900' && !/stack-est/.test(fig4(rows[1]).split('stack-credit-of')[0]),
    'a manual card reads "$0 / $900" in normal type, not a dash (the head already counts it $0)', text(rows[1]));
  ok(text(rows[2]) === 'No Due Card $0' && !/stack-est/.test(rows[2].split('stack-credit-of')[0].split('stack-credit-x')[1] || ''),
    'a card with nothing due this period reads "$0" alone, like Emerald, in normal type', text(rows[2]));
  ok(text(rows[3]) === 'HELOC $0 / $814', 'HELOC observed with nothing posted: "$0 / $814"', text(rows[3]));
  ok(text(rows[4]) === 'HELOC Paid +$150 / $814', 'HELOC observed with a posted payment: "+$150 / $814", like a card row', text(rows[4]));
  ok(text(rows[5]) === 'Past Card — / $40', 'missing history (a past period, a failed sync): the dash stays, with the minimum', text(rows[5]));
  ok(text(rows[6]) === 'Legacy Card — / $25', 'a line with no published paidToward (an older publication) keeps the dash');
  ok(text(rows[0]) === 'Tracked Card $0 / $17', 'a ledger-tracked card is read as before from its own paid and spent');
  const names = rows.map(r => (/stack-credit-x[^"]*"( role="img" aria-label="([^"]*)")?/.exec(r) || [])[2]);
  ok(names[1] === 'Paid back $0' && names[4] === 'Paid back $150', 'the figure is named for a screen reader without ", estimated" (normal type)', JSON.stringify(names));
  // MUTANT: the row ignores paidToward (the old reading): the manual card is a dash again, caught by the checks above.
  const src = read('public/stack-credit.js');
  const old = src.replace('if (toward != null) out.x = toward;', '');
  ok(old !== src, 'the row mutant targets the paidToward read');
  const { fns: oldFns } = load(old);
  const el2 = container(); oldFns.credit(el2, ctx);
  ok(text(el2.innerHTML.split('<li>').slice(1)[1]) === 'Manual Card — / $900', 'MUTANT: a row that ignores paidToward reads a dash for the manual card, which the check above rejects');
  const soft = src.replace('if (toward != null) out.x = toward;', "if (toward != null) { out.x = toward; out.xSoft = ' stack-est'; }");
  const { fns: softFns } = load(soft);
  const el3 = container(); softFns.credit(el3, ctx);
  ok(soft !== src && /stack-est/.test(el3.innerHTML.split('<li>').slice(1)[1].split('stack-credit-of')[0]), 'MUTANT: soft styling on the paidToward figure is caught (Dale: normal font)');
}

console.log('5c. a card with no paid / spent shows its last balance (#1447; Dale, 2026-11-20; lead ruling)');
{
  // Invented lines shaped like #1447's stackCreditLines: line.balance is the card's last balance snapshot with its trust.
  const bal = (amount, trust = 'calculated') => ({ amount, asOf: '2031-03-09', trust, reasons: trust === 'estimated' ? ['balance-before-statement-cycle'] : [] });
  const none = fig(null, 'unavailable');
  const MORE = [
    { id: 'both', label: 'Both Card', paid: fig(100), spent: fig(260), minimum: fig(30), toGo: fig(160), status: 'to-go',
      minimumCovered: { value: false, trust: 'calculated' }, balance: bal(1234.56), transactions: [] },
    { id: 'fresh', label: 'Fresh Card', paid: none, spent: none, minimum: fig(20), toGo: none, status: null,
      minimumCovered: { value: 'unknown', trust: 'unknown' }, balance: bal(812.4), transactions: [] },
    { id: 'stale', label: 'Stale Card', paid: none, spent: none, minimum: null, toGo: none, status: null,
      minimumCovered: { value: 'unknown', trust: 'unknown' }, balance: bal(305, 'estimated'), transactions: [] },
    { id: 'half', label: 'Half Card', paid: fig(50), spent: none, minimum: null, toGo: none, status: null,
      minimumCovered: { value: 'unknown', trust: 'unknown' }, balance: bal(77), transactions: [] },
    { id: 'blank', label: 'Blank Card', paid: none, spent: none, minimum: null, toGo: none, status: null,
      minimumCovered: { value: 'unknown', trust: 'unknown' }, balance: { amount: null, asOf: null, trust: 'unavailable', reasons: ['balance-unavailable'] }, transactions: [] },
    { id: 'heloc', label: 'Line of credit', paid: null, spent: null, minimum: fig(210), toGo: none, status: null,
      minimumCovered: { value: true, trust: 'calculated' }, balance: bal(9000), transactions: [] },
  ];
  const totals = { ...TOTALS.complete, balance: { amount: 2429.0, trust: 'estimated', completeness: 'complete', excluded: [], reasons: [] } };
  const { fns, win } = load();
  const ctx = context(totals);
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets(MORE), totals }) };
  const el = container();
  fns.credit(el, ctx);
  const rows = el.innerHTML.split('<li>').slice(1);
  ok(text(rows[0]) === 'Both Card +$100 / $30' && !/1,234|data-stack-credit-balance/.test(rows[0]),
    'paid and spent published: the design\'s row, and no balance');
  ok(text(rows[1]) === 'Fresh Card $812 \u2014 / $20' && /<small class="stack-credit-bal stack-n" data-stack-credit-balance role="img" aria-label="Last balance \$812">\$812</.test(rows[1]),
    'no paid / spent: the last balance, plain when calculated', text(rows[1]));
  ok(/<small class="stack-credit-bal stack-n" data-stack-credit-balance role="img" aria-label="Last balance \$305">\$305</.test(rows[2]),
    'an estimated balance draws plain, and is named "Last balance" like a calculated one');
  ok(text(rows[3]) === 'Half Card $77 +$50 / \u2014', 'only one of paid / spent published: the balance (no half "of"), and Paid back where it is published', text(rows[3]));
  ok(text(rows[4]) === 'Blank Card \u2014 / \u2014' && !/\$0|data-stack-credit-balance/.test(rows[4]), 'no balance published: nothing, never $0');
  ok(text(rows[5]) === 'Line of credit \u2014 / $210' && !/9,000/.test(rows[5]), 'HELOC: its minimum only, never its balance');
  ok(!/2,429/.test(el.innerHTML) && /data-stack-credit-total><span>\$120<\/span>/.test(el.innerHTML),
    "the head stays the paid toward the minimums due over the minimums due; totals.balance is not shown");
  const fresh = win.StackSheet.html(ctx, 'card:fresh'), stale = win.StackSheet.html(ctx, 'card:stale');
  ok(/stack-credit-big/.test(fresh) && !/data-stack-credit-balance/.test(fresh)
    && /<div class="stack-sheet-big stack-n" data-stack-credit-balance role="img" aria-label="Last balance \$305">\$305<\/div>/.test(stale),
    'the sheet: a card with a minimum or a figure to print shows its "X / min"; only a card with nothing else to print shows the balance as its big figure, plain, with the same screen-reader name');
  // Announced once: the role="img" element's name replaces its text, and no other element repeats the amount.
  const named = html => (html.match(/aria-label="Last balance[^"]*"/g) || []).length;
  ok(named(rows[1]) === 1 && named(rows[2]) === 1 && named(stale) === 1 && (rows[1].match(/\$812(?![\d.,])/g) || []).length === 2,
    'each surface names its balance once (the label and the visible number, nothing else)');
  ok(!/data-stack-credit-balance/.test(win.StackSheet.html(ctx, 'card:both')) && !/data-stack-credit-balance|\$0/.test(win.StackSheet.html(ctx, 'card:blank'))
    && !/9,000/.test(win.StackSheet.html(ctx, 'card:heloc')), 'the sheet: no balance beside paid / spent, none when unpublished, none for the HELOC');
  ok(!/balance|last|estimated|snapshot/i.test(text(el.innerHTML) + text(fresh) + text(stale)), 'no words');
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

console.log('7. row layout rules');
{
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-credit.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /html\.stack-view \.stack-root \.stack-credit-line \{([^}]*)\}/.exec(css);
  ok(rule && /border-top: 1\.5px solid var\(--stack-on-line\)/.test(rule[1]) && /padding: 14px 0/.test(rule[1]) && /grid-template-columns: 24px minmax\(0, 1fr\) auto 14px/.test(rule[1]),
    'the row rule sits under .stack-root (above the shell\'s button reset), so its divider and padding apply; the status column is auto beside a flexible middle');
}

console.log('8. sheet head: the date range in the kicker, the 64px figure, the small close mark');
{
  const { win } = load();
  const ctx = context(TOTALS.complete);
  const kicker = key => (/class="stack-sheet-kicker">([^<]*)</.exec(win.StackSheet.html(ctx, key)) || [])[1];
  ok(kicker('card:travelvisa') === 'Credit · Mar 1 – 14' && kicker('bill:water@2031-03-05') === 'Bill · Mar 1 – 14'
    && kicker('mortgage:mort@2031-03-12') === 'Mortgage · Mar 1 – 14' && kicker('budget:groceries') === 'Budget · Mar 1 – 14',
    'every sheet kicker names its kind and the selected pay period\'s range, as the waterfall header prints it', [kicker('card:travelvisa'), kicker('bill:water@2031-03-05')].join(' | '));
  ok(win.StackBlocks.rangeLabel({ start: '2031-03-01', end: '2031-03-14' }) === 'Mar 1 – 14' && win.StackBlocks.rangeLabel({ start: '2031-03-28', end: '2031-04-10' }) === 'Mar 28 – Apr 10',
    'the range is the shell\'s one label (the day alone within a month, both months across one)');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'stack-sheet.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\.stack-sheet-big \{[^}]*font-size: 64px/.test(css), 'the sheet figure is 64px');
  ok(/\.stack-sheet \.stack-sheet-close svg \{ width: 14px; height: 14px; \}/.test(css) && /\.stack-sheet \.stack-sheet-close \{[^}]*width: 36px; height: 36px/.test(css),
    'the close mark is a 14px × in a 36px dark circle (not stretched by the global svg rule)');
}

console.log('9. the repayment target after the slash (OD-028): above the minimum, over the limit, withheld');
{
  // Invented lines with Forecast's published target set explicitly (the page prints it; it never computes it).
  const tgt = (amount, trust, parts) => ({ amount, trust, reasons: [], ...parts });
  const over = { ...fig6('overlim', 'Over Card', 100, 236, 25, 136, 'to-go', true),
    target: tgt(363.4, 'estimated', { newCharges: 236, minimum: 25, overLimitBy: 127.4 }) };
  const above = { ...fig6('above', 'Busy Card', 300, 120, 40, 0, 'paid-back', true),
    target: tgt(120, 'calculated', { newCharges: 120, minimum: 40, overLimitBy: 0 }) };
  const off = { ...fig6('tgtoff', 'Withheld Card', 50, 50, 25, 0, 'paid-back', true),
    target: { amount: null, trust: 'unavailable', reasons: ['minimum-unavailable'], newCharges: null, minimum: null, overLimitBy: null } };
  const { win, fns } = load();
  const ctx = context(TOTALS.complete);
  ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: withTargets([over, above, off]), totals: TOTALS.complete }) };
  const el = container(); fns.credit(el, ctx);
  const rows = (el.innerHTML.match(/<li>.*?<\/li>/g) || []).map(text);
  ok(rows[0] === 'Over Card +$100 / $363' && rows[1] === 'Busy Card +$300 / $120' && rows[2] === 'Withheld Card +$50 / —',
    'rows read "Paid back / target": 363 (over the limit), 120 (new charges above the 40 minimum), a dash when withheld', JSON.stringify(rows));
  ok(!/is-good/.test(el.innerHTML.split('<li>')[1]) && /stack-credit-x is-good"/.test(el.innerHTML.split('<li>')[2]) && !/is-good/.test(el.innerHTML.split('<li>')[3]),
    'green only where paid back reached the target (300 of 120); 100 of 363 and a withheld target stay plain (Neon REPORT 4)');
  // Dale, 2026-11-23 (#1614): every figure draws the same whatever its trust, so an estimated target is not soft.
  ok(/stack-credit-of">\s*\/ \$363/.test(el.innerHTML) && /stack-credit-of">\s*\/ \$120/.test(el.innerHTML) && !/stack-est/.test(el.innerHTML),
    'the target draws in normal type whatever its trust (no estimate class)');
  ok((el.innerHTML.match(/stack-credit-tick is-on/g) || []).length === 3,
    'the ✓ still means only "minimum covered": all three minimums are covered though no target is paid in full');
  const sheet = text(win.StackSheet.html(ctx, 'card:overlim'));
  ok(sheet.includes('Paid back $100 New charges $236 Minimum $25 ✓ Over the limit by $127 Target $363'),
    'the sheet breaks the target down in plain words: new charges, minimum, over the limit by, target', sheet);
  ok(!text(win.StackSheet.html(ctx, 'card:above')).includes('Over the limit by'), 'a card under its limit prints no "Over the limit by" row');
  ok(text(win.StackSheet.html(ctx, 'card:tgtoff')).includes('Target —'), 'a withheld target prints a dash in the sheet');
}

console.log(`\nPASS Stack credit card and sheet (${checks})`);
