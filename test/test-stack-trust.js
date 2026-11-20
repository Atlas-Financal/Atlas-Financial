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
 *   5b. Cards (B3): a projected period softens every printed card figure; an actual one only the estimated amounts.
 *   6. No rendered text says "estimated", "projected" or "≈", and no rule underlines (owner).
 *   7. The shell's chips and every block read the one rule (no block decides trust on its own).
 *   8. No explanatory text: every block and sheet prints only the page's names, the invented names, figures and ✓.
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
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('public/stack-shell.js'), ctx);
  const fns = {};
  const register = ctx.StackBlocks.register.bind(ctx.StackBlocks);
  ctx.StackBlocks.register = (name, fn) => { fns[name] = fn; register(name, fn); };
  for (const f of ['waterfall', 'cards', 'credit', 'sheet']) vm.runInContext(read(`public/stack-${f}.js`), ctx);
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
    budgetProgress: { household: { actual: fig(635, 'calculated'), planned: fig(1010, 'calculated') } },
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
    selectedPeriodKey: v.start, recommendation: { payPeriodViews: [v], billHistory: {
      water: [{ date: '2031-03-05', amount: 64, amountBasis: 'schedule', trust: 'estimated', paidState: 'not-paid' }],
      power: [{ date: '2031-03-06', amount: 80, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true }] } },
    Forecast: { cardPeriodMovements: () => ({}), stackCreditLines: () => ({ lines: LINES,
      totals: { paid: 500, spent: 660, trust: totalsTrust, completeness: 'complete', excluded: [], reasons: [],
        minimumsPaid: { amount: 500, trust: totalsTrust, reasons: [] }, minimumsDue: { amount: 55, trust: 'calculated', reasons: [] }, minimumsDueCount: 2, minimumsCoveredCount: 1, minimumsCoveredTrust: totalsTrust } }) },
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

console.log('4. credit card and its sheet (the design\'s "X / minimum", soft per field)');
{
  const { fns, win } = load();
  const el = container();
  fns.credit(el, context(view('actual')));
  const rows = el.innerHTML.split('<li>').slice(1);
  const softIn = h => classed(h).filter(e => e.cls.includes('stack-est')).map(e => e.cls.find(c => /^stack-credit-/.test(c))).sort().join(',');
  ok(!/stack-est/.test(el.innerHTML.split('<li>')[0]), 'calculated totals: the paid total, the minimums due and the bar are not soft');
  ok(softIn(rows[0]) === '', 'Blue Visa (all calculated): nothing soft', softIn(rows[0]));
  ok(softIn(rows[1]) === 'stack-credit-of,stack-credit-x',
    'Green Card (spent, toGo and minimum estimated): the figure X and the "/ min" are soft', softIn(rows[1]));
  const el2 = container();
  fns.credit(el2, context(view('actual'), 'estimated'));
  ok(/data-stack-credit-total><span class="stack-est">\$500</.test(el2.innerHTML) && /stack-credit-bar stack-est/.test(el2.innerHTML), 'estimated totals: the paid total and its bar are soft');
  const ctx = context(view('actual'));
  const green = win.StackSheet.html(ctx, 'card:cashback');
  ok(/stack-credit-x is-bad stack-est"[^>]*>−\$160</.test(green) && /<dt>Spent on it<\/dt><dd class="stack-n"><span class="stack-est">\$260<\/span>/.test(green)
    && /<dt>Paid onto it<\/dt><dd class="stack-n"><span class="">\$100<\/span>/.test(green) && /<dt>Minimum<\/dt><dd class="stack-n"><span class="stack-est">\$30<\/span><\/dd>/.test(green),
  'Green Card sheet: the estimated figures are soft, the calculated "Paid onto it" is not');
  ok(!/stack-est/.test(win.StackSheet.html(ctx, 'card:travelvisa')), 'Blue Visa sheet: nothing soft');
  const projected = context(view('projected'));
  const pEl = container();
  fns.credit(pEl, projected);
  ok(/data-stack-credit-total><span class="stack-est">/.test(pEl.innerHTML) && pEl.innerHTML.split('<li>').slice(1).every(r => /stack-credit-x[^"]* stack-est"/.test(r) || /stack-credit-dash/.test(r)),
    'a projected period: the total and every line are soft');
}

console.log('4b. the covered ✓ always shows when covered, soft on estimated evidence (Atlas on #1444)');
{
  // The same covered line, its paid and spent published calculated, then with paid estimated (an unconfirmed payment
  // allocation), then in a projected period.
  const { fns, win } = load();
  const line = (paidTrust, spentTrust) => [{ id: 'travelvisa', label: 'Blue Visa', paid: fig(400, paidTrust), spent: fig(400, spentTrust),
    minimum: fig(25, 'calculated'), toGo: fig(0, 'calculated'), status: 'paid-back', minimumCovered: { value: true, trust: 'calculated' }, transactions: [] }];
  const render = (v, lines) => {
    const ctx = context(v);
    ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines, totals: { paid: 400, spent: 400, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [] } }) };
    const el = container(); fns.credit(el, ctx);
    return { row: el.innerHTML.split('<li>')[1], sheet: win.StackSheet.html(ctx, 'card:travelvisa') };
  };
  const firm = render(view('actual'), line('calculated', 'calculated'));
  ok(/stack-credit-tick is-on" role="img" aria-label="Minimum covered"/.test(firm.row) && /<dd class="stack-n"><span class="">\$25<\/span> <span class="">✓<\/span><\/dd>/.test(firm.sheet),
    'calculated paid and spent: the row tick is filled and the sheet\'s Minimum row has its ✓, plain');
  for (const [label, r] of [['estimated paid', render(view('actual'), line('estimated', 'calculated'))],
    ['a projected period', render(view('projected'), line('calculated', 'calculated'))]]) {
    ok(/stack-credit-tick is-on stack-est" role="img" aria-label="Minimum covered, estimated"/.test(r.row)
      && /<span class="stack-est">✓<\/span>/.test(r.sheet) && /stack-credit-x is-good stack-est"[^>]*>\+\$400</.test(r.row),
      `${label}: the tick and the ✓ still show (covered), soft, read as "Minimum covered, estimated"`);
    ok(!/estimated/i.test(r.row.replace(/<[^>]*>/g, ' ') + r.sheet.replace(/<[^>]*>/g, ' ')), `${label}: no word "estimated" is added`);
  }
  // The ✓ is the covered claim alone (the coverage check, the minimum and paid): an estimated spent softens X (the colour reads
  // it) but not the ✓.
  const spentSoft = render(view('actual'), line('calculated', 'estimated'));
  ok(/stack-credit-tick is-on" role="img" aria-label="Minimum covered"/.test(spentSoft.row) && /stack-credit-x is-good stack-est"[^>]*>\+\$400</.test(spentSoft.row)
    && /<span class="">✓<\/span>/.test(spentSoft.sheet), 'estimated spent: the figure is soft, the ✓ (a coverage claim) is not');
}

console.log('4c. the sheet\'s minimum amount and its ✓ carry their own treatment (Codex on #1475)');
{
  const { win } = load();
  const sheet = (v, minTrust, covTrust) => {
    const ctx = context(v);
    const line = [{ id: 'travelvisa', label: 'Blue Visa', paid: fig(100, 'calculated'), spent: fig(100, 'calculated'), minimum: fig(30, minTrust),
      toGo: fig(0, 'calculated'), status: 'paid-back', minimumCovered: { value: true, trust: covTrust }, transactions: [] }];
    ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: line, totals: { paid: 100, spent: 100, trust: 'calculated', completeness: 'complete', excluded: [], reasons: [] } }) };
    return win.StackSheet.html(ctx, 'card:travelvisa');
  };
  const minRow = h => (/<dt>Minimum<\/dt><dd class="stack-n">([\s\S]*?)<\/dd>/.exec(h) || [])[1];
  ok(minRow(sheet(view('actual'), 'estimated', 'calculated')) === '<span class="stack-est">$30</span> <span class="stack-est">✓</span>',
    'an estimated minimum amount: the amount is soft and so is the ✓ (the covered claim is read from it)');
  ok(minRow(sheet(view('actual'), 'calculated', 'estimated')) === '<span class="">$30</span> <span class="stack-est">✓</span>', 'estimated coverage alone: the ✓ is soft, the amount is not');
  ok(minRow(sheet(view('projected'), 'calculated', 'calculated')) === '<span class="stack-est">$30</span> <span class="stack-est">✓</span>', 'a projected period: both are soft');
  ok(minRow(sheet(view('actual'), 'calculated', 'calculated')) === '<span class="">$30</span> <span class="">✓</span>', 'calculated minimum and coverage: neither is soft');
}

console.log('5. bill and budget sheets');
{
  const { win } = load();
  const ctx = context(view('actual'));
  ok(/stack-sheet-big stack-n stack-est/.test(win.StackSheet.html(ctx, 'bill:water@2031-03-05')), 'an estimated bill amount is soft');
  ok(!/stack-est/.test(win.StackSheet.html(ctx, 'bill:power@2031-03-06')), 'a calculated bill amount is not');
  const g = win.StackSheet.html(ctx, 'budget:groceries');
  ok(/stack-sheet-big stack-n">/.test(g) && /<i class="stack-est"> \//.test(g) && !/Spent<\/dt>|Budget<\/dt>/.test(g)
    && /Left<\/dt><dd class="stack-n stack-est"/.test(g),
  'budget: calculated spent plain; estimated planned and left soft; no Spent or Budget row');
  ok(/stack-sheet-big stack-n stack-est/.test(win.StackSheet.html(context(view('projected')), 'bill:power@2031-03-06')), 'a projected period: a bill is soft');
  // Which of Spent, the plan and Left are soft, read from each budget sheet's headline and Left row.
  const soft = key => {
    const h = win.StackSheet.html(ctx, key);
    const big = /<div class="stack-sheet-big stack-n"><span( class="stack-est")?>[^<]*<\/span>(?:<i( class="stack-est")?>)?/.exec(h);
    const dd = name => new RegExp(`${name}</dt><dd class="stack-n( stack-est)?"`).exec(h);
    return [big && big[1] ? 'spent' : '', big && big[2] ? 'plan' : '', dd('Left')[1] ? 'Left' : ''].filter(Boolean).join(',');
  };
  ok(soft('budget:carried') === 'plan,Left', 'a carried budget (row trust only): the plan and Left are soft, Spent is not', soft('budget:carried'));
  ok(soft('budget:dup') === 'spent,Left', 'a possible duplicate (calculated plan): Spent and Left are soft, the plan is not', soft('budget:dup'));
  ok(soft('budget:other') === 'Left', 'Other spending: its undated plan is never soft; Left follows the row', soft('budget:other'));
  ok(soft('budget:firm') === '', 'a calculated row: nothing soft', soft('budget:firm'));
}

console.log('5c. the bill sheet reads billHistory, the one source for an occurrence amount and trust (#1446)');
{
  // An invented bill whose row amount (100, calculated) differs from its occurrence entry (112.40, estimated: the posted
  // actual on an unconfirmed allocation), plus a bill with no entry, one with an unpublished amount, and prototype-like ids.
  const { win } = load();
  const v = view('actual');
  v.bills = [
    { id: 'hydro', date: '2031-03-08', label: 'Hydro', amount: 100, displayAmountTrust: 'calculated', paidState: 'paid', payerLabel: 'Chequing' },
    { id: 'gym', date: '2031-03-09', label: 'Gym', amount: 40, displayAmountTrust: 'calculated', paidState: 'not-paid', payerLabel: 'Chequing' },
    { id: 'phone', date: '2031-03-11', label: 'Phone', amount: 55, displayAmountTrust: 'calculated', paidState: 'not-paid', payerLabel: 'Chequing' },
    { id: 'constructor', date: '2031-03-12', label: 'Odd', amount: 9, displayAmountTrust: 'calculated', paidState: 'not-paid', payerLabel: 'Chequing' }];
  const ctx = context(v);
  ctx.recommendation.billHistory = {
    hydro: [
      { date: '2031-04-08', amount: 100, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
      { date: '2031-03-08', amount: 112.4, amountBasis: 'unconfirmed-actual', trust: 'estimated', paidState: 'paid' },
      { date: '2031-02-08', amount: 98.1, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true },
      { date: '2031-01-08', amount: 97, amountBasis: 'schedule', trust: 'estimated', paidState: 'not-paid' }],
    phone: [{ date: '2031-03-11', amount: null, amountBasis: 'schedule', trust: 'unavailable', paidState: 'not-paid' }],
  };
  const hydro = win.StackSheet.html(ctx, 'bill:hydro@2031-03-08');
  ok(/<div class="stack-sheet-big stack-n stack-est">\$112<\/div>/.test(hydro) && !/\$100\b/.test(hydro),
    'the headline is this occurrence\'s entry, amount and trust together (soft $112, printed in whole dollars), never the row\'s amount and trust');
  const rows = [...hydro.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  ok(rows.length === 2 && /Feb 8/.test(rows[0]) && /Jan 8/.test(rows[1]) && !/Apr 8|Mar 8/.test(rows.join('')),
    'history: the earlier occurrences only, newest first (no later or future one, not the headline itself)', rows.length);
  ok(/stack-sheet-txa stack-n">\$98</.test(rows[0]) && /stack-sheet-check/.test(rows[0])
    && /stack-sheet-txa stack-n stack-est">\$97</.test(rows[1]) && !/stack-sheet-check/.test(rows[1]),
    'each row: its amount (soft when estimated) and a ✓ only when paid');
  ok(!/[A-Za-z]{3,}/.test(rows.map(r => r.replace(/<[^>]*>/g, ' ').replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, '')).join(' ')),
    'history rows carry no words, only dates, amounts and ✓');
  for (const [key, label] of [['bill:gym@2031-03-09', 'no entry'], ['bill:phone@2031-03-11', 'an unpublished amount'],
    ['bill:constructor@2031-03-12', 'a prototype-like id']]) {
    const h = win.StackSheet.html(ctx, key);
    ok(/<div class="stack-sheet-big stack-n"><span role="img" aria-label="not available">—<\/span><\/div>/.test(h)
      && !/\$\d/.test(h.split('stack-sheet-big')[1].split('</div>')[0]) && !/stack-sheet-hist/.test(h),
      `${label}: the headline is a dash read as "not available", never the row amount or $0; no history`);
  }
  // Atlas on #1453, 1: a paid occurrence whose amount is still the schedule (a pending payment) shows the check with a
  // dash, never the scheduled amount; a posted actual keeps its amount. In the headline and in a history row.
  const pend = context(view('actual'));
  pend.recommendation.payPeriodViews[0].bills = [
    { id: 'water2', date: '2031-03-07', label: 'Water', amount: 90, displayAmountTrust: 'calculated', paidState: 'paid', payerLabel: 'Chequing' },
    { id: 'gas', date: '2031-03-09', label: 'Gas', amount: 70, displayAmountTrust: 'calculated', paidState: 'paid', payerLabel: 'Chequing' }];
  pend.recommendation.billHistory = {
    water2: [{ date: '2031-03-07', amount: 90, amountBasis: 'schedule', trust: 'calculated', paidState: 'paid' },
      { date: '2031-02-07', amount: 88, amountBasis: 'schedule', trust: 'calculated', paidState: 'paid' },
      { date: '2031-01-07', amount: 86.4, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true }],
    gas: [{ date: '2031-03-09', amount: 71.2, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true }],
  };
  const w2 = win.StackSheet.html(pend, 'bill:water2@2031-03-07');
  const w2rows = [...w2.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  // Owner (Dale, #1465 7046237901): a pending payment is not confirmed, so no check until it posts.
  ok(/<div class="stack-sheet-big stack-n"><span role="img" aria-label="not available">—<\/span><\/div>/.test(w2)
    && !/stack-sheet-check/.test(w2.split('stack-sheet-hist')[0]) && !/\$90/.test(w2),
    'headline: a pending occurrence on its schedule shows a dash and no check, never the scheduled $90');
  ok(w2rows.length === 2 && /aria-label="not available">—/.test(w2rows[0]) && !/stack-sheet-check/.test(w2rows[0]) && !/\$88/.test(w2)
    && /\$86</.test(w2rows[1]) && /stack-sheet-check/.test(w2rows[1]),
    'history: a pending row on its schedule shows a dash and no check; a confirmed posted row keeps its amount and check');
  ok(/<div class="stack-sheet-big stack-n">\$71<\/div><span class="stack-sheet-check"/.test(win.StackSheet.html(pend, 'bill:gas@2031-03-09')),
    'control: a paid posted actual shows its amount beside the check');
  const unpaidSched = context(view('actual'));
  unpaidSched.recommendation.payPeriodViews[0].bills = [{ id: 'tv', date: '2031-03-12', label: 'TV', amount: 30, displayAmountTrust: 'calculated', paidState: 'not-paid', payerLabel: 'Chequing' }];
  unpaidSched.recommendation.billHistory = { tv: [{ date: '2031-03-12', amount: 30, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' }] };
  ok(/stack-sheet-big stack-n">\$30</.test(win.StackSheet.html(unpaidSched, 'bill:tv@2031-03-12')), 'control: an unpaid scheduled amount still shows (no check beside it)');

  // Atlas on #1453, 2: history is bounded by Forecast's observation date (data.meta.asOf 2031-03-10) as well as by the
  // selected occurrence, so a future bill's history never lists another future schedule; its own schedule stays its headline.
  const fut = context(view('projected'));
  fut.recommendation.payPeriodViews[0].bills = [{ id: 'hydro', date: '2031-05-08', label: 'Hydro', amount: 100, displayAmountTrust: 'calculated', paidState: 'not-paid', payerLabel: 'Chequing' }];
  fut.recommendation.billHistory = { hydro: [
    { date: '2031-05-08', amount: 101, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
    { date: '2031-04-08', amount: 100, amountBasis: 'schedule', trust: 'calculated', paidState: 'not-paid' },
    { date: '2031-03-08', amount: 112.4, amountBasis: 'unconfirmed-actual', trust: 'estimated', paidState: 'paid' },
    { date: '2031-02-08', amount: 98.1, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', paidConfirmed: true }] };
  const may = win.StackSheet.html(fut, 'bill:hydro@2031-05-08');
  const mayRows = [...may.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
  ok(/stack-sheet-big stack-n stack-est">\$101</.test(may) && mayRows.length === 2 && /Mar 8/.test(mayRows[0]) && /Feb 8/.test(mayRows[1])
    && !/Apr 8/.test(may), 'a future bill: its own schedule is the headline; history lists only occurrences on or before the observation date');
  const noAsOf = context(view('projected'));
  Object.assign(noAsOf, { recommendation: fut.recommendation, data: { ...noAsOf.data, meta: {} } });
  ok(!/stack-sheet-hist/.test(win.StackSheet.html(noAsOf, 'bill:hydro@2031-05-08')), 'without an observation date, no history is listed');

  const projected = context(view('projected'));
  projected.recommendation.billHistory = ctx.recommendation.billHistory;
  const pv = projected.recommendation.payPeriodViews[0];
  pv.bills = v.bills;
  ok(/stack-sheet-big stack-n stack-est">\$112</.test(win.StackSheet.html(projected, 'bill:hydro@2031-03-08'))
    && /stack-sheet-txa stack-n stack-est">\$98</.test(win.StackSheet.html(projected, 'bill:hydro@2031-03-08')),
    'a projected period: the headline and every history amount are soft');
}

console.log('5d. the bill sheet matches its entry by occurrence identity (#1455), never by a coinciding date');
{
  const { win } = load();
  const mk = (bills, history) => { const c = context(view('actual')); c.recommendation.payPeriodViews[0].bills = bills; c.recommendation.billHistory = history; return c; };
  const row = (o) => ({ id: 'tri', label: 'Triangle', amount: 50, displayAmountTrust: 'calculated', payerLabel: 'Chequing', ...o });
  const HIST = { tri: [
    { date: '2031-03-10', amount: 55.25, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', occurrence: 'tri@2031-03-07', paidConfirmed: true },
    { date: '2031-02-07', amount: 49, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', occurrence: 'tri@2031-02-07', paidConfirmed: true }] };
  // A statement moved the occurrence from Mar 7 to Mar 10; the current row carries its occurrenceKey.
  const moved = win.StackSheet.html(mk([row({ date: '2031-03-10', scheduledDate: '2031-03-07', occurrenceKey: 'tri@2031-03-07', paidState: 'paid' })], HIST),
    'bill:tri@2031-03-10');
  ok(/stack-sheet-big stack-n">\$55<\/div><span class="stack-sheet-check"/.test(moved) && (moved.match(/<li>/g) || []).length === 1 && /Feb 7/.test(moved),
    'a moved occurrence finds its entry by identity: its amount and ✓, and only the earlier occurrence below');
  // A saved close kept the old date and its unpaid copy: same identity, but its paid state disagrees with the entry.
  const saved = win.StackSheet.html(mk([row({ date: '2031-03-07', paidState: 'not-paid' })], HIST), 'bill:tri@2031-03-07');
  ok(/<div class="stack-sheet-big stack-n"><span role="img" aria-label="not available">—<\/span><\/div>/.test(saved) && !/55\.25/.test(saved),
    "a saved close's unpaid copy never shows the current paid copy's amount, and does not list it as history");
  // The row's date coincides with another occurrence's effective date: no match by date.
  const other = win.StackSheet.html(mk([row({ date: '2031-03-10', occurrenceKey: 'tri@2031-03-10', paidState: 'paid' })], HIST), 'bill:tri@2031-03-10');
  ok(/aria-label="not available">—/.test(other.split('stack-sheet-big')[1].split('</div>')[0]) && !/55\.25/.test(other),
    'a coinciding date with a different identity matches nothing (a dash, never another occurrence\'s amount)');
  // Without occurrenceKey the identity is id@scheduledDate, then id@date.
  const bySched = win.StackSheet.html(mk([row({ date: '2031-03-10', scheduledDate: '2031-03-07', paidState: 'paid' })], HIST), 'bill:tri@2031-03-10');
  ok(/stack-sheet-big stack-n">\$55</.test(bySched), 'no occurrenceKey: the identity is id@scheduledDate');
  const foreignKey = win.StackSheet.html(mk([row({ date: '2031-03-10', scheduledDate: '2031-03-07', occurrenceKey: 'other@2031-03-10', paidState: 'paid' })], HIST), 'bill:tri@2031-03-10');
  ok(/stack-sheet-big stack-n">\$55</.test(foreignKey), "an occurrenceKey for another bill is ignored (the scheduled date decides)");
  // The row's own occurrence, published on another date (another copy): a dash headline, and never listed as its history.
  const self = win.StackSheet.html(mk([row({ date: '2031-03-12', occurrenceKey: 'tri@2031-03-07', paidState: 'paid' })], HIST), 'bill:tri@2031-03-12');
  ok(/aria-label="not available">—/.test(self.split('stack-sheet-big')[1].split('</div>')[0]) && !/55\.25/.test(self) && (self.match(/<li>/g) || []).length === 1,
    "the row's own occurrence on another date is neither its headline nor its history");
  // Same paid state, different date (Atlas on #1456): a saved copy never shows the later copy's amount beside its own date.
  const sameState = win.StackSheet.html(mk([row({ date: '2031-03-07', paidState: 'paid' })], HIST), 'bill:tri@2031-03-07');
  ok(/aria-label="not available">—/.test(sameState.split('stack-sheet-big')[1].split('</div>')[0]) && !/55\.25/.test(sameState),
    'a saved copy in the same paid state, on its old date, gets a dash (never the later copy\'s amount)');
  // Same date, different paid state: a saved unpaid copy of an occurrence the current period has since paid.
  const PAIDNOW = { tri: [{ date: '2031-03-07', amount: 52.1, amountBasis: 'posted-actual', trust: 'calculated', paidState: 'paid', occurrence: 'tri@2031-03-07', paidConfirmed: true }] };
  const unpaidCopy = win.StackSheet.html(mk([row({ date: '2031-03-07', paidState: 'not-paid' })], PAIDNOW), 'bill:tri@2031-03-07');
  ok(/aria-label="not available">—/.test(unpaidCopy.split('stack-sheet-big')[1].split('</div>')[0]) && !/52\.10/.test(unpaidCopy),
    'a saved unpaid copy on the same date never shows the paid copy\'s amount');
}

console.log('5e. producer to sheet: a statement-moved occurrence beside a saved close (#1455\'s world, Atlas on #1456)');
{
  // #1455's invented world (test-stack-bill-history 1b): an Oct 7 card minimum (43.21) saved unpaid in the Sep 25 to
  // Oct 8 close; the issuer statement moves it to Oct 10 at 47.39. Real Forecast.recommend publishes both rows; the sheet
  // renders each from the published billHistory.
  const F = require('../public/forecast.js');
  const source = require('./fixtures/card-backfill-data');
  const LATER = '2026-10-12', OCT = { start: '2026-09-25', end: '2026-10-08' };
  const KEYS = ['id', 'label', 'kind', 'date', 'planned', 'amount', 'actual', 'remaining', 'settlement', 'status', 'cardPaid', 'confidence'];
  const fixture = statement => {
    const x = source('triangle', 'triangle');
    x.data.meta.asOf = x.asOf = LATER;
    const p = x.data.plan;
    p.opening = { asOf: LATER, priorAsOf: '2026-08-19', representedEvents: [] };
    p.income[0].anchor = '2026-09-25';
    p.startingCash.breakdown[0].value = 785.17;
    p.budget.categories = [];
    p.obligations = [{ id: 'triangle', label: 'Invented card minimum', debtId: 'triangle', effect: 'payment', frequency: 'monthly',
      day: 7, firstDue: '2026-10-07', amount: 43.21, confidence: 'estimated', payingAccount: 'chequing-a',
      ...(statement ? { statementOccurrences: [{ scheduledDate: '2026-10-07', dueDate: '2026-10-10', minimum: 47.39, currency: 'cad', confidence: 'confirmed' }] } : {}) }];
    return x;
  };
  const runWith = (statement, periodHistory) => { const x = fixture(statement);
    return F.recommend(x.data.plan, LATER, { debts: x.data.debts, ...(periodHistory ? { periodHistory } : {}) }); };
  const before = runWith(false);
  const oct = before.payPeriodViews.find(v => v.start === OCT.start && v.end === OCT.end);
  const close = { schema: 'atlas-private-period-history-projection/v1', capturedAt: '2026-10-09T19:00:00.000Z',
    content: { period: { ...OCT, timezone: 'America/Vancouver' }, kind: 'closing', asOf: OCT.end, closingState: 'provisional',
      planBasis: 'see-baseline-revision', provenance: { policyFingerprint: null },
      publication: { start: OCT.start, end: OCT.end, bills: (oct.bills || []).map(r => Object.fromEntries(KEYS.filter(k => Object.hasOwn(r, k)).map(k => [k, r[k]]))) } } };
  const rec = runWith(true, [close]);
  const savedView = rec.payPeriodViews.find(v => v.start === OCT.start);
  const currentView = rec.payPeriodViews.find(v => v.timelineRole === 'current');
  const savedRow = savedView.bills.find(b => b.id === 'triangle'), currentRow = currentView.bills.find(b => b.id === 'triangle');
  ok(savedRow && savedRow.date === '2026-10-07' && savedRow.paidState === currentRow.paidState && currentRow.date === '2026-10-10',
    'the world: the saved copy (Oct 7) and the current copy (Oct 10) share a paid state', JSON.stringify([savedRow && savedRow.date, currentRow && currentRow.date]));
  const { win } = load();
  const sheet = (v, key) => win.StackSheet.html({ data: { meta: { asOf: LATER } }, plan: {}, recommendation: rec, selectedPeriodKey: v.start,
    Forecast: { cardPeriodMovements: () => ({}) } }, key);
  const saved = sheet(savedView, 'bill:triangle@2026-10-07'), current = sheet(currentView, 'bill:triangle@2026-10-10');
  const headline = h => h.split('stack-sheet-big')[1].split('</div>')[0];
  ok(/aria-label="not available">—/.test(headline(saved)) && !/\$4[37](?![\d.,])|47\.39|43\.21/.test(saved) && /Oct 7/.test(saved),
    "the saved Oct 7 copy: a dash, never the statement's 47.39 beside Oct 7 (a pair neither period publishes)", headline(saved));
  ok(/\$47$/.test(headline(current)) && /Oct 10/.test(current), 'control: the current Oct 10 copy shows its own 47.39', headline(current));
}

console.log('5b. cards');
{
  const { fns } = load();
  const cards = v => { const el = container(); fns.cards(el, context(v)); return el.innerHTML; };
  // Every printed figure in the cards: a headline (sc-f) or a row amount (sc-a, or the spent / plan inside it).
  const figures = html => [...html.matchAll(/<(span|i|b)([^>]*)>(\$[^<]*|[^<]*\$[\d,.]+[^<]*)</g)];
  const projected = cards(view('projected'));
  const printed = figures(projected);
  const unsoft = printed.filter(m => !/stack-est/.test(m[2]) && !/class="[^"]*sc-a[^"]*"/.test(m[2]));
  ok(printed.length > 0 && unsoft.length === 0, 'a projected period: every printed card figure is soft',
    unsoft.map(m => m[0]).join(' | '));
  const actual = cards(view('actual'));
  const g = /data-stack-sheet="budget:groceries"[\s\S]*?<\/li>/.exec(actual);
  ok(g && /<span>\$310(\.00)?<\/span><i class="stack-est"> \/ \$500/.test(g[0]),
    'an actual period: the Groceries plan (estimated) is soft, its calculated Spent is not', g && g[0]);
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
    const cel = container(); fns.cards(cel, ctx); all.push(cel.innerHTML);
  }
  ok(!/estimated|projected|≈/i.test(text(all.join(' '))), 'the rendered text never says estimated, projected or ≈');
  const css = ['stack', 'stack-waterfall', 'stack-cards', 'stack-credit', 'stack-sheet'].map(f => read(`public/${f}.css`)).join('\n');
  ok(!/text-decoration[^;]*(underline|dotted)|border-bottom[^;]*dotted/i.test(css), 'no Stack stylesheet underlines or dots a figure');
}

console.log('7. one rule, read by every block');
{
  const shell = read('public/stack-shell.js');
  ok(/StackBlocks\.estClass\(surplus && surplus\.trust, view\)/.test(shell), "the shell's chips read the surplus's published trust through the rule");
  for (const f of ['waterfall', 'cards', 'credit', 'sheet']) {
    const src = read(`public/stack-${f}.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    ok(/estClass|isEstimated/.test(src) && !/=== 'estimated'|evidenceState === 'projected'/.test(src),
      `stack-${f}.js uses the shell's rule and decides no trust itself`);
  }
}

console.log('8. no explanatory text anywhere on the page (owner, 2026-11-20)');
{
  // Every block and every sheet, in an actual and a projected period, with every credit status, a partial total and a
  // withheld surplus. The rendered text, once the invented names and the printed figures and dates are removed, may hold
  // only the page's own names. Any other word (a status, a reason, a hint) fails.
  const { fns, win } = load();
  const more = [...LINES,
    { id: 'tdcc', label: 'Red Card', paid: fig(0, 'calculated'), spent: fig(0, 'calculated'), minimum: fig(15, 'calculated'), toGo: fig(null, 'unknown'),
      status: 'upcoming', minimumCovered: { value: 'unknown', trust: 'unknown' }, transactions: [] },
    { id: 'gold', label: 'Gold Card', paid: fig(5, 'calculated'), spent: fig(9, 'calculated'), minimum: null, toGo: fig(null, 'unknown'),
      status: null, minimumCovered: { value: 'unknown', trust: 'unknown' }, transactions: [
        { date: '2031-03-04', name: 'Corner Grocer', amount: 9, payment: false, pending: true }] },
    { id: 'heloc', label: 'Line of credit', paid: null, spent: null, minimum: fig(210, 'calculated'), toGo: fig(null, 'unknown'),
      status: null, minimumCovered: { value: 'unknown', trust: 'unknown' }, transactions: [] }];
  const withheld = v => ({ ...v, stackSummary: { ...v.stackSummary,
    surplus: { amount: null, terms: null, trust: 'unavailable', projected: false, reason: 'Surplus after deductions is unavailable.' } } });
  const negative = v => ({ ...v, stackSummary: { ...v.stackSummary, surplus: { ...v.stackSummary.surplus, amount: -40 } } });
  const texts = [];
  for (const v of [view('actual'), view('projected'), withheld(view('actual')), negative(view('actual'))]) {
    for (const completeness of ['complete', 'partial', 'none']) {
      const ctx = context(v);
      ctx.Forecast = { ...ctx.Forecast, stackCreditLines: () => ({ lines: more, totals: { paid: 500, spent: 660, trust: 'calculated',
        completeness, excluded: completeness === 'complete' ? [] : ['tdcc'], reasons: ['x'] } }) };
      const wf = container(); fns.waterfall(wf, ctx); texts.push(wf.innerHTML);
      const cr = container(); fns.credit(cr, ctx); texts.push(cr.innerHTML);
      const cd = container(); fns.cards(cd, ctx); texts.push(cd.innerHTML);
      for (const key of ['card:travelvisa', 'card:cashback', 'card:tdcc', 'card:gold', 'card:heloc', 'bill:water@2031-03-05',
        'bill:power@2031-03-06', 'budget:groceries', 'budget:carried', 'budget:other']) texts.push(win.StackSheet.html(ctx, key) || '');
    }
  }
  const names = ['Blue Visa', 'Green Card', 'Red Card', 'Gold Card', 'Line of credit', 'Water', 'Power', 'Chequing', 'Groceries',
    'Dining', 'Pharmacy', 'Other spending', 'Fuel', 'Corner Grocer'];
  const PAGE = new Set(['Budget', 'Bills', 'Bill', 'Mortgage', 'Credit', 'Spent', 'Paid', 'Minimum', 'Left', 'Over', 'Transactions',
    'Dale’s', 'Amanda’s', 'Other', 'Total', 'income', 'Surplus', 'Deficit', 'after', 'deductions', 'of', 'Close',
    // The design's income tiles in the waterfall (decoration, aria-hidden): D, A and $.
    'D', 'A', '$']);
  const leftover = html => {
    let t = text(html).replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’');
    for (const n of names) t = t.split(n).join(' ');
    // the two head subtitles from the approved design, exactly (no other wording)
    t = t.split('paid / card minimums due').join(' ').split('spent / budget').join(' ');
    // the design's Credit wording (Dale, 2026-11-20, the Credit Minimum mock-up), exactly: the row lines and the sheet rows
    for (const phrase of ['Spent on it', 'Paid onto it', 'Not due this period']) t = t.split(phrase).join(' ');
    t = t.replace(/[−+-]?\$[\d,]+(\.\d\d)?/g, ' ').replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}( \u2013 ((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) )?\d{1,2})?\b/g, ' ')
      .replace(/[✓=−+\/—·]/g, ' ');
    return t.split(/\s+/).filter(w => w && !PAGE.has(w));
  };
  const words = [...new Set(texts.flatMap(leftover))];
  ok(texts.every(t => text(t) !== ''), 'every one of the renders printed something (the word check is not vacuous)',
    String(texts.filter(t => text(t) === '').length));
  ok(texts.length === 156 && words.length === 0, 'the rendered Stack blocks and sheets hold only names, numbers and ✓', words.join(' | '));
  const control = leftover('<p>Paid back $5 to go Upcoming excludes Red Card Covered ✓ Not yet unavailable Due Mar 5 Comes out of Chequing Paid in full Minimum met Not due this period Paid onto it</p>');
  ok(['Upcoming', 'excludes', 'unavailable', 'Due', 'Comes', 'out', 'full', 'met', 'back', 'to', 'go', 'Covered', 'yet'].every(w => control.includes(w))
    && !control.includes('onto') && !control.includes('Not due') && !control.includes('period'),
    'control: other status, reason and label words (including the old "Paid back", "to go", "Covered" and "Not yet") are caught as leftovers; only the design\'s exact Credit phrases pass', control.join(' '));
}

console.log(`\nPASS Stack trust treatment (${checks})`);
