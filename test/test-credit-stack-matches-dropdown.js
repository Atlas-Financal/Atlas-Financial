'use strict';
/* BUILD 7: the Credit stack and the income stack's Credit dropdown agree, current and completed pay periods alike.
 * Owner decisions: OD-052 (Dale, 2026-11-25: the Credit head reads "[total paid back]/[sum of the card targets]") and
 * OD-057 (the waterfall's Credit line reads the total still to pay back over the Credit deduction; the dropdown keeps its
 * caption and each card's Still to pay back). Every figure comes from Forecast's one card publication for the view
 * (stackSummary.credit and stackSummary.creditBreakdown); the page adds nothing up.
 *
 * Through the real Stack shell, Credit card and waterfall (no stub), on invented worlds:
 *   1. A completed pay period: a 25.00 minimum paid 20.00. The Credit stack reads +$20 / $25, the dropdown prints the
 *      5.00 Forecast published (main fell back to the full 25.00 minimum), and the Credit line reads $5 / $25: the
 *      historical cash deduction (the minimum) is kept.
 *   2. A current pay period (the invented card week): Travel 100 paid of 236, Cash Back 250 paid of 114.20 (overpaid).
 *      The head reads $350 / $350, plain (Cash Back's overpayment never covers Travel's shortfall); the dropdown 136 and 0;
 *      the Credit line $136 / $6 (the deduction is unchanged).
 *   3. A card over its limit (the invented card-coverage world): target 200.00, Credit line $200 / $165.
 *   3b. The dropdown is unchanged on a current period: main's renderer prints it byte for byte.
 *   4. In every case, per card and in total, read from the rendered page: dropdown = tile target − tile paid back
 *      (floored at 0); the Credit line's first figure = Σ the dropdown rows; the head = Σ tile paid back / Σ tile target over
 *      the cards with something to pay back; a card with nothing to pay back has no dropdown row and adds nothing.
 *   5. Mutants: the completed-period minimum fallback restored, the head restored to the minimums, the head summed over
 *      every card (a quiet card with no payment evidence then blanks it), and the Credit line reading the deduction twice.
 *
 * Invented data only; every expected figure is worked by hand. `node test/test-credit-stack-matches-dropdown.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Invented data only: the household history file that the live overlay's operating answer would load is replaced with an
// empty one before any module reads it.
const periodsPath = path.resolve(__dirname, '../public/periods.json');
const readFileOriginal = fs.readFileSync;
fs.readFileSync = (file, ...args) => (file === periodsPath ? JSON.stringify({ monthly: [] }) : readFileOriginal(file, ...args));
const Live = require('../scripts/live-plan');
const agg = require('./fixtures/card-coverage-aggregate-world');
const week = require('./fixtures/stack-card-week');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const dollars = s => (s == null || s === '' ? null : Number(String(s).replace(/[^\d.-]/g, '')));

// The engine, loaded from given sources (the mutants swap one file).
function engine(sources) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(sources(file), c);
  return c.Forecast;
}
// The real Stack shell, Credit card and waterfall, reading the selected view Forecast published.
function page(sources, rec, world, start) {
  const c = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('public/stack-shell.js'), c);
  const blocks = {};
  const register = c.StackBlocks.register.bind(c.StackBlocks);
  c.StackBlocks.register = (name, fn) => { blocks[name] = fn; register(name, fn); };
  vm.runInContext(sources('public/stack-credit.js'), c);
  vm.runInContext(sources('public/stack-waterfall.js'), c);
  const ctx = { data: { debts: world.debts, meta: { asOf: world.asOf } }, plan: world.plan, recommendation: rec, selectedPeriodKey: start };
  const el = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
  const card = el(); blocks.credit(card, ctx);
  const wf = c.StackWaterfall.html(ctx, { creditOpen: true });
  return read2(card.innerHTML, wf);
}
// What a reader sees: the head, each tile row (by debt id), each dropdown row (by debt id) and the Credit line.
function read2(card, wf) {
  const headHtml = (/data-stack-credit-total[^>]*>([\s\S]*?)<\/span><\/span><span class="stack-credit-go"/.exec(card) || [])[1] || '';
  const [headPaid, headTarget] = text(headHtml).split(' / ');
  const tiles = new Map();
  for (const m of card.matchAll(/data-stack-sheet="card:([^"]+)">([\s\S]*?)<\/li>/g)) {
    const fig = text((/<span class="stack-credit-fig stack-n">([\s\S]*?)<\/span><svg/.exec(m[2]) || [])[1] || '');
    const [paid, target] = fig.split(' / ');
    tiles.set(m[1], { paid: paid === '—' ? null : dollars(paid), target: target == null ? 0 : target === '—' ? null : dollars(target) });
  }
  const drop = new Map();
  for (const m of wf.matchAll(/<li class="wf-card" data-row="card" data-debt-id="([^"]+)">([\s\S]*?)<\/li>/g)) {
    // A breakdown row, or main's completed-period fallback row (the card's minimum), whichever the page printed.
    const amount = (/data-source="stackSummary\.(?:creditBreakdown\.rows|bills\.cardMinimums)\.\d+\.amount">([^<]*)</.exec(m[2]) || [])[1];
    drop.set(m[1], amount == null ? null : dollars(amount));
  }
  const line = (/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(wf) || [''])[0];
  const lineStill = (/data-source="stackSummary\.creditBreakdown\.stillToPayBack\.amount">([^<]*)</.exec(line) || [])[1];
  const lineCredit = (/data-source="stackSummary\.surplus\.terms\.credit">([^<]*)</.exec(line) || [])[1];
  return { card, wf, head: text(headHtml), headPaid: headPaid === '—' ? null : dollars(headPaid), headTarget: dollars(headTarget),
    headGreen: /data-stack-credit-total><span class="stack-credit-x is-good"/.test(card), tiles, drop,
    caption: /Still to pay back on each card/.test(wf), line: text(line), lineStill: dollars(lineStill), lineCredit: dollars(lineCredit) };
}
// Section 4's agreement, read from the rendered page only (whole dollars, as printed).
function agree(p, label) {
  const open = [...p.tiles].filter(([, t]) => t.target === null || t.target > 0);
  for (const [id, t] of open) {
    ok(p.drop.has(id) && p.drop.get(id) === Math.max(0, t.target - t.paid),
      `${label}: ${id}'s dropdown row is its tile's target − paid back`, JSON.stringify([t, p.drop.get(id)]));
  }
  for (const [id, t] of p.tiles) if (t.target === 0) ok(!p.drop.has(id), `${label}: ${id} has nothing to pay back, so no dropdown row`);
  const dropSum = [...p.drop.values()].reduce((s, v) => s + v, 0);
  ok(p.lineStill === dropSum, `${label}: the Credit line's still to pay back is Σ the dropdown rows`, JSON.stringify([p.lineStill, [...p.drop]]));
  ok(p.headPaid === open.reduce((s, [, t]) => s + t.paid, 0) && p.headTarget === open.reduce((s, [, t]) => s + t.target, 0),
    `${label}: the head is Σ tile paid back / Σ tile target over the cards with something to pay back`, p.head);
}

// 1. A completed pay period (invented world: periods 09-18..10-01 and 10-02..10-15; a 25.00 minimum due 09-25; 20.00 left
// the Bills account for the card on 09-26 and landed on it the same day). Today is 10-05, so 09-18 is completed.
const pay = (amount, date) => [['bills', amount, date, 'cash'], ['card', -amount, date, 'credit']];
const rolled = agg.world(pay(20, '2026-09-26'), { asOf: '2026-10-05', minimumDate: '2026-09-25' });
const rolledObs = Live.fromObservation(rolled).data;
const rolledArgs = [rolledObs.plan, rolled.asOf, { debts: rolledObs.debts, currentPeriodActuals: rolledObs.liveOverlay.currentPeriodActuals }];
const rolledWorld = { debts: rolledObs.debts, asOf: rolled.asOf, plan: rolledObs.plan };
const real = engine(read);
const COMPLETED = '2026-09-18';
const completed = (F = real, sources = read) => page(sources, F.recommend(...rolledArgs), rolledWorld, COMPLETED);

console.log('1. A completed pay period: the dropdown prints the remainder Forecast published, the deduction stays the minimum');
{
  const rec = real.recommend(...rolledArgs);
  const v = rec.payPeriodViews.find(p => p.start === COMPLETED);
  ok(v && v.role === 'lookback' && v.stackSummary.creditBreakdown && v.stackSummary.creditBreakdown.basis === 'minimums',
    'the 09-18 period is completed and its Credit term is its minimums', JSON.stringify(v && v.stackSummary.creditBreakdown));
  const p = completed();
  ok(p.tiles.get('travelvisa').paid === 20 && p.tiles.get('travelvisa').target === 25, 'the card row reads +$20 / $25', JSON.stringify(p.tiles.get('travelvisa')));
  ok(p.caption && p.drop.get('travelvisa') === 5 && p.drop.size === 1, 'the dropdown keeps its caption and prints the card\'s 5.00 (25.00 − 20.00), not the 25.00 minimum', JSON.stringify([...p.drop]));
  ok(p.line === '− Credit $5 / $25' && p.lineCredit === 25, 'the Credit line reads $5 / $25: still to pay back over the historical cash deduction, the minimum', p.line);
  ok(p.head === '$20 / $25' && !p.headGreen, 'the head reads $20 / $25, plain (the target is not paid back)', p.head);
  ok(v.stackSummary.surplus.terms.credit === 25, 'the Surplus still takes the 25.00 minimum for that period (unchanged)');
  agree(p, 'completed');
}

// 2. A current pay period (the invented card week, test/fixtures/stack-card-week, worked in test-credit-paid-back.js):
//   Travel target 236.00, paid back 100.00, 136.00 still; Cash Back target 114.20, paid back 250.00, 0 still (floored);
//   every other card target 0. Deduction (E) 6.25. Head Σ paid 350.00 over Σ target 350.20, printed $350 / $350.
const wk = week.fixture();
const wkArgs = [wk.plan, wk.asOf, { debts: wk.debts, currentPeriodActuals: wk.packet, cardPeriodBalanceEvidence: wk.balanceEvidence, cardLiveOverlay: wk.overlay }];
const wkWorld = { debts: wk.debts, asOf: wk.asOf, plan: wk.plan };
const current = (F = real, sources = read) => {
  const rec = F.recommend(...wkArgs);
  return page(sources, rec, wkWorld, rec.payPeriodViews.find(v => v.role === 'active').start);
};
console.log('2. A current pay period: the head is Σ paid back / Σ target; the Credit line is still to pay back / the deduction');
{
  const rec = real.recommend(...wkArgs);
  const v = rec.payPeriodViews.find(p => p.role === 'active');
  const t = v.stackSummary.credit.totals;
  ok(Math.round(t.paidBack.amount * 100) === 35000 && Math.round(t.target.amount * 100) === 35020 && t.targetCovered.value === false,
    'Forecast publishes paid back 350.00 over targets 350.20, not covered (Travel is short)', JSON.stringify([t.paidBack, t.target, t.targetCovered]));
  ok(v.stackSummary.creditBreakdown.basis === 'targets' && Math.round(v.stackSummary.creditBreakdown.stillToPayBack.amount * 100) === 13600,
    'the Credit line\'s still to pay back is 136.00 + 0, on the targets basis', JSON.stringify(v.stackSummary.creditBreakdown.stillToPayBack));
  const p = current();
  ok(p.head === '$350 / $350' && !p.headGreen, 'the head reads $350 / $350 and stays plain: Cash Back\'s overpayment never covers Travel', p.head);
  ok(p.tiles.get('travelvisa').paid === 100 && p.tiles.get('travelvisa').target === 236 && p.tiles.get('cashback').paid === 250 && p.tiles.get('cashback').target === 114,
    'the rows read +$100 / $236 and +$250 / $114', JSON.stringify([...p.tiles]));
  ok(p.drop.get('travelvisa') === 136 && p.drop.get('cashback') === 0 && p.drop.size === 2 && p.caption, 'the dropdown: its caption, Travel 136 and Cash Back 0', JSON.stringify([...p.drop]));
  ok(p.line === '− Credit $136 / $6' && p.lineCredit === 6, 'the Credit line reads $136 / $6 (the deduction unchanged)', p.line);
  agree(p, 'current');
}

// 3. A card over its limit (the invented card-coverage world, as in test-credit-paid-back.js 2a): a manual pay-down card 200.00
// over its 1,000 limit, 25.00 minimum, 60.00 paid from the Bills account. Target max(25, withheld charges, 200) = 200.00;
// the deduction nets the 35.00 paid beyond the minimum: 165.00. Its Still to pay back is 200.00.
console.log('3. A card over its limit');
{
  const w = agg.world([['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]], { card: 'mbna', payDownOnly: ['mbna', 'triangle'],
    edit: y => { y.payload.accounts[3].last_fetch = y.asOf + 'T17:00:00Z'; y.payload.accounts[3].plaid_last_successful_update = y.asOf + 'T17:00:00Z';
      const debt = y.data.debts.find(d => d.id === 'mbna'); debt.balance = (debt.limit || 1000) + 200; y.payload.accounts[3].balance = debt.balance; } });
  const o = Live.fromObservation(w).data, ov = o.liveOverlay;
  const rec = real.recommend(o.plan, w.asOf, { debts: o.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays } });
  const v = rec.payPeriodViews.find(p => p.role === 'active');
  const m = v.stackSummary.credit.lines.find(l => l.id === 'mbna');
  ok(Math.round(m.target.amount * 100) === 20000 && m.target.overLimitBy === 200, 'the over-limit card\'s target is its 200.00 over the limit', JSON.stringify(m.target));
  const p = page(read, rec, { debts: o.debts, asOf: w.asOf, plan: o.plan }, v.start);
  ok(p.drop.get('mbna') === 200 && p.line === '− Credit $200 / $165' && p.headTarget === 200,
    'the dropdown prints 200, the Credit line $200 / $165, and the head\'s target is 200', JSON.stringify([[...p.drop], p.line, p.head]));
  agree(p, 'over limit');
}

// The dropdown itself is unchanged on a current period (OD-057: "Leave the still to pay back descriptor in the credit card
// drop down"): main's waterfall renderer (before this change) and this one print byte-identical dropdowns from the same
// publication. Only the Credit line's own figure changed.
console.log('3b. The dropdown is unchanged: main\'s waterfall renderer prints the same dropdown on current periods');
{
  const cp = require('node:child_process');
  const MAIN = 'baad05d87a3c02a5ab50cd838ab76ef85860ca7d'; // main before this change
  const mainWaterfall = cp.execFileSync('git', ['show', MAIN + ':public/stack-waterfall.js'], { cwd: ROOT, encoding: 'utf8' });
  const onMain = file => (file === 'public/stack-waterfall.js' ? mainWaterfall : read(file));
  const dropdown = html => (/<ul class="wf-cards"[^>]*>[\s\S]*?<\/ul><\/li>/.exec(html) || [''])[0];
  const now = current(), then = current(real, onMain);
  ok(dropdown(now.wf) !== '' && dropdown(now.wf) === dropdown(then.wf) && /Still to pay back on each card/.test(dropdown(now.wf)),
    'the card week\'s dropdown (caption, rows, ✓) is byte-identical to main\'s renderer');
  ok(then.line === '− Credit $6' && now.line === '− Credit $136 / $6', 'only the Credit line changed: main printed $6, now $136 / $6', JSON.stringify([then.line, now.line]));
}

console.log('4. A card with nothing to pay back and no payment evidence does not blank the head');
{
  const rec = real.recommend(...rolledArgs);
  const heloc = rec.payPeriodViews.find(p => p.start === COMPLETED).stackSummary.credit.lines.find(l => l.id === 'heloc');
  ok(heloc && heloc.target.amount === 0 && heloc.paidBack.amount === null,
    'control: the HELOC has a $0 target and a withheld paid back in the completed period', JSON.stringify([heloc.target, heloc.paidBack]));
  ok(completed().headPaid === 20, 'the head still reads its $20 paid back');
}

console.log('5. Mutants: each must fail a check above');
{
  const fsrc = read('public/forecast.js');
  const fallback = fsrc.replace('    if (!entry || !entry.credit) return null;', '    if (!entry || !entry.credit || !entry.adjusts) return null;');
  const fb = completed(engine(file => (file === 'public/forecast.js' ? fallback : read(file))));
  ok(fallback !== fsrc && fb.drop.get('travelvisa') === 25 && fb.line === '− Credit $25',
    'MUTANT: the completed-period minimum fallback restored prints 25 in the dropdown (the defect), which section 1 rejects', JSON.stringify([[...fb.drop], fb.line]));
  const csrc = read('public/stack-credit.js');
  const overMinimums = csrc.replace("const pb = t.paidBack && typeof t.paidBack === 'object' ? t.paidBack : null;", 'const pb = t.minimumsPaid;')
    .replace("const tg = t.target && typeof t.target === 'object' ? t.target : null;", 'const tg = t.minimumsDue;');
  const om = current(real, file => (file === 'public/stack-credit.js' ? overMinimums : read(file)));
  ok(overMinimums !== csrc && om.head !== '$350 / $350', 'MUTANT: the head restored to paid over the minimums due is caught', om.head);
  const msrc = read('public/forecast-card-period.js');
  const everyLine = msrc.replace('const unseenPaid = openLines.filter(line => line.paidBack.amount === null);',
    'const unseenPaid = lines.filter(line => line.paidBack.amount === null);');
  const el = completed(engine(file => (file === 'public/forecast-card-period.js' ? everyLine : read(file))));
  ok(everyLine !== msrc && el.headPaid === null, 'MUTANT: a head summed over every card is blanked by the quiet HELOC, which section 4 rejects', el.head);
  const wsrc = read('public/stack-waterfall.js');
  const twice = wsrc.replace("const STILL_SOURCE = 'stackSummary.creditBreakdown.stillToPayBack.amount';", "const STILL_SOURCE = 'stackSummary.creditBreakdown.total';");
  const tw = current(real, file => (file === 'public/stack-waterfall.js' ? twice : read(file)));
  ok(twice !== wsrc && tw.line === '− Credit $6 / $6', 'MUTANT: a Credit line reading the deduction twice is caught', tw.line);
}

console.log('6. Review observations on 8125066b: a withheld deduction, and a reversal with nothing to pay back');
{
  // A Credit line whose Surplus (and so its deduction) is withheld prints a dash after the slash, never a dangling slash.
  const c = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('public/stack-shell.js'), c);
  vm.runInContext(read('public/stack-waterfall.js'), c);
  const view = { start: '2031-03-01', end: '2031-03-14', role: 'active',
    stackSummary: { income: {}, bills: { other: 0, mortgage: 0, cardMinimums: [], trust: 'calculated' },
      surplus: { amount: null, terms: null, trust: 'unavailable', projected: false, reason: 'invented' },
      creditBreakdown: { basis: 'targets', rows: [{ debtId: 'travelvisa', amount: 92, trust: 'estimated' }],
        stillToPayBack: { amount: 92, trust: 'estimated' }, total: 0, trust: 'estimated' } } };
  const html = c.StackWaterfall.html({ data: { debts: [] }, recommendation: { payPeriodViews: [view] }, selectedPeriodKey: view.start }, { creditOpen: true });
  const line = (/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(html) || [''])[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  ok(line === '− Credit $92 / —', 'a withheld deduction reads $92 / —, not a dangling slash', line);
  // An unidentified return withholds the head's paid side even when no line has anything to pay back, as minimumsPaid does.
  const cp =(() => { const c2 = { console }; c2.window = c2; vm.createContext(c2); vm.runInContext(read('public/forecast-card-period.js'), c2); return c2.ForecastCardPeriod; })();
  const zero = { amount: 0, trust: 'calculated', reasons: [] };
  const quietLine = { id: 'travelvisa', target: zero, paidBack: zero, targetCovered: { value: false, trust: 'calculated', reasons: [] } };
  const t = cp.creditHeadTotals([quietLine], [{ date: '2031-03-05', amount: -25 }]);
  ok(t.paidBack.amount === null && t.paidBack.reasons.includes('payment-direction-unresolved') && t.target.amount === 0,
    'an unidentified return with nothing to pay back: the head\'s paid side is withheld (a dash), the target 0', JSON.stringify(t.paidBack));
}

console.log(`\nPASS Credit stack matches the Credit dropdown (${checks})`);
