'use strict';
/* OD-033 (Dale, 2026-11-23): each Stack Credit card row reads "Paid back / Total to pay back", and each card's Still to pay
 * back shows in the income stack's Credit dropdown, display only: (E)'s Credit total, Balance After Deductions and Surplus
 * are unchanged. Desk ruling (1) (Plan #6): "Use 'Already counted above' only for amounts actually counted above ... Don't
 * force the rows to add up with a catch-all offset." Grok Bot (rule 17): (1) Paid back is posted payments tied to that card
 * in the same pay period; (2) the "Already counted above" offset for a card is exactly that card's purchases already held;
 * (3) a payment shows as paid on one card's row only. Lead (2026-11-24): option B, with a plain caption so nobody reads the
 * card rows as summing to the Credit line.
 *
 *   1. The lead's worked case, per line (Forecast's card module and its dropdown builder, invented publications): every
 *      dropdown figure is checked against that card's own published figures, never against the total.
 *   2. A world where the old catch-all offset (the targets minus the Credit term) and the honest row differ, through the
 *      real recommend and the real page scripts (no stub): the waterfall's dropdown and the Credit card print Forecast's
 *      figures, and Credit, Balance After Deductions and Surplus are byte-equal to main.
 *   3. Mutants: the plug restored, Still to pay back built from line.paid (pending counted), and the caption dropped.
 *
 * Invented data only; every expected figure is worked by hand. `node test/test-credit-paid-back.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const M = require('../public/forecast-card-period');
const fx = require('./fixtures/card-posted-period-movement-data');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// main before this change, for the byte-equal controls.
const BASE = 'e4c7b1a3fa0743f159dab3db1d877390a80c5279';
const show = file => cp.execFileSync('git', ['show', BASE + ':' + file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function realm(sources) {
  const c = { console };
  c.window = c;
  vm.createContext(c);
  for (const file of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(sources(file), c);
  return c;
}
const engine = sources => realm(sources).Forecast;
const OLD = engine(show);

console.log('1. The lead\'s worked case, per line: card A (target 100, nothing counted, 50 paid beyond) and card B (target 100, 150 counted)');
const pub = cards => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2031-03-10',
  cards: cards.map(([id, rows]) => ({ id, label: 'Invented ' + id, posted: rows, pending: [],
    postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] } })) });
const row = (kind, amount, extra = {}) => ({ date: '2031-03-05', payee: 'Invented', amount, kind, ...extra });
const RECONCILED = { paymentAllocation: { status: 'reconciled' } };
// Card A: min 25, no new charges, 100 over its limit (utilisation), a posted 75 payment onto it (25 for the minimum, 50 beyond
// it, the beyond-minimum term). Target max(25, 0, 100) = 100 (estimated: a payment could have hidden part of the overage).
// due = 100 − 0 = 100; netted min(50, max(0, 100 − 25)) = 50; deduction 50. Paid back 75; still to pay back 100 − 75 = 25.
// Card B: min 25, 150 of purchases (all in the Household budget hold) and a 50 refund on the card: Spent 100, target
// max(25, 100, 0) = 100; 150 already counted above; due max(0, 100 − 150) = 0; deduction 0. Nothing paid back: 100 still.
const worked = pub([
  ['a', [row('payment', -75, RECONCILED)]],
  ['b', [row('charge', 150), row('refund', -50)]],
]);
const BILLS = { cardMinimums: [{ debtId: 'a', amount: 25 }, { debtId: 'b', amount: 25 }], trust: 'calculated' };
const UTIL = [{ id: 'a', overLimitBy: 100, used: 1100, limit: 1000, balanceTrust: 'calculated' },
  { id: 'b', overLimitBy: 0, used: 100, limit: 1000, balanceTrust: 'calculated' }];
const credit = M.stackCreditLines(worked, BILLS, UTIL, new Map([['a', 5000]]));
const A = credit.lines.find(l => l.id === 'a'), B = credit.lines.find(l => l.id === 'b');
ok(cents(A.target.amount) === 10000 && cents(A.deduction.amount) === 5000 && cents(A.deduction.alreadyCounted) === 0
  && cents(A.deduction.beyondNetted) === 5000 && cents(A.paidToward.amount) === 7500,
  'card A: target 100.00, nothing counted above, 50.00 beyond netted, deduction 50.00, paid back 75.00', JSON.stringify([A.target.amount, A.deduction, A.paidToward]));
ok(cents(B.target.amount) === 10000 && cents(B.deduction.amount) === 0 && cents(B.deduction.alreadyCounted) === 15000
  && cents(B.deduction.countedOffset) === 10000 && cents(B.paidToward.amount) === 0,
  'card B: target 100.00, 150.00 counted above (100.00 of it covers the target), deduction 0, paid back 0', JSON.stringify([B.target.amount, B.deduction]));
ok(cents(A.stillToPayBack.amount) === 2500 && cents(B.stillToPayBack.amount) === 10000,
  'Still to pay back: A 100.00 − 75.00 = 25.00; B 100.00 − 0 = 100.00', JSON.stringify([A.stillToPayBack, B.stillToPayBack]));
ok(A.targetCovered.value === false && B.targetCovered.value === false, 'neither card has paid back its target: no green on either row');
// The view's dropdown, built by Forecast from those lines (the entry periodCardCredit hands it: Credit = Σ deductions).
const entry = { adjusts: true, creditCents: cents(A.deduction.amount) + cents(B.deduction.amount), credit, trust: credit.totals.deduction.trust };
const drop = F.stackCreditBreakdown(entry, BILLS);
// Proof 1: each card's dropdown row is that card's target − paid back.
ok(drop.rows.length === 2 && drop.rows.every(r => {
  const line = credit.lines.find(l => l.id === r.debtId);
  return cents(r.amount) === Math.max(0, cents(line.target.amount) - cents(line.paidToward.amount));
}), 'proof 1: each card row is that card\'s target − paid back (A 25.00, B 100.00), worked from its own line', JSON.stringify(drop.rows));
// Proof 2: the "Already counted above" row is Σ each card's charges counted above (A 0 + B 150), Grok Bot's condition 2.
ok(cents(drop.alreadyCounted.amount) === -(cents(A.deduction.alreadyCounted) + cents(B.deduction.alreadyCounted)) && cents(drop.alreadyCounted.amount) === -15000,
  'proof 2: "Already counted above" is −(0.00 + 150.00) = −150.00, the two cards\' own counted charges', JSON.stringify(drop.alreadyCounted));
// Proof 3: the Credit line is Σ each line's deduction (50 + 0), (E) unchanged.
ok(cents(drop.total) === cents(A.deduction.amount) + cents(B.deduction.amount) && cents(drop.total) === 5000,
  'proof 3: the Credit line is Σ deductions, 50.00 + 0 = 50.00', String(drop.total));
ok(cents(drop.rows[0].amount) + cents(drop.rows[1].amount) + cents(drop.alreadyCounted.amount) !== cents(drop.total),
  'the rows are display only and do not add up to the Credit line (25 + 100 − 150 ≠ 50), which the caption says');
// Grok Bot condition 3: one payment, one row. A's 75 is paid back on A alone; B shows none.
ok(cents(A.paidToward.amount) + cents(B.paidToward.amount) === 7500, 'condition 3: the one 75.00 payment shows as paid back on card A only');
// Grok Bot condition 1: a pending payment is not paid back.
{
  const pend = pub([['a', []]]);
  pend.cards[0].pending = [row('payment', -75, RECONCILED)];
  const line = M.stackCreditLines(pend, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.paid.amount) === 7500 && cents(line.paidToward.amount) === 0 && cents(line.stillToPayBack.amount) === 10000,
    'condition 1: a pending 75.00 payment is in Paid but not Paid back: 0 paid back, 100.00 still to pay back', JSON.stringify([line.paid, line.paidToward]));
}
// Unknown stays unknown: a withheld paid back or target withholds Still to pay back, never $0.
{
  const failed = pub([['a', [row('payment', -75, RECONCILED)]]]);
  failed.cards[0].postedMovement = { trust: 'unavailable', completeness: 'none', reasons: ['sync-failed'] };
  const past = { ...failed, role: 'past' };
  const line = M.stackCreditLines(past, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(line.paidToward.amount === null && line.stillToPayBack.amount === null && line.stillToPayBack.trust === 'unavailable'
    && line.targetCovered.value === 'unknown', 'a withheld paid back leaves Still to pay back unknown (null), never $0', JSON.stringify(line.stillToPayBack));
  const noBills = M.stackCreditLines(worked, null, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(noBills.target.amount === null && noBills.stillToPayBack.amount === null, 'a withheld target leaves Still to pay back unknown');
}
// Paid back beyond the target: Still to pay back is 0, never negative, and the row is green.
{
  const over = pub([['a', [row('charge', 40), row('payment', -90, RECONCILED)]]]);
  const line = M.stackCreditLines(over, { cardMinimums: [{ debtId: 'a', amount: 25 }], trust: 'calculated' },
    [{ id: 'a', overLimitBy: 0, used: 0, limit: 1000, balanceTrust: 'calculated' }], new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.target.amount) === 4000 && line.stillToPayBack.amount === 0 && line.targetCovered.value === true,
    'paid back 90.00 against a 40.00 target: still to pay back 0 (floored), target covered', JSON.stringify([line.target.amount, line.stillToPayBack, line.targetCovered]));
}

console.log('2. Through recommend and the real page scripts: a world where the old catch-all offset and the honest row differ');
// The invented card week (fixtures/card-posted-period-movement-data), worked by hand from its rows:
//   Travel: Spent 236.00 (charges 172.40 + 63.75 + 28.60 pending, interest 6.25, refund −35.00), target 236.00; charges counted
//     above 264.75; posted payments 100.00. Deduction max(0, 236.00 − 264.75) = 0. Still to pay back 236.00 − 100.00 = 136.00.
//   Cash Back: target 114.20, all of it counted above; paid back 250.00. Deduction 0. Still to pay back 0 (floored).
//   Every other card: target 0 and nothing counted above (or its counted charges withheld: it adds nothing).
// Honest "Already counted above" = −(264.75 + 114.20) = −378.95. The old catch-all offset (Σ targets − Credit) =
// −(236.00 + 114.20 − 0) = −350.20: it hid Travel's 28.75 floor inside a row named "Already counted above".
const x = fx.fixture();
const opts = { debts: x.debts, currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, cardLiveOverlay: x.overlay };
const advice = F.recommend(x.plan, x.asOf, opts), oldAdvice = OLD.recommend(x.plan, x.asOf, opts);
const view = advice.payPeriodViews.find(v => v.role === 'active'), oldView = oldAdvice.payPeriodViews.find(v => v.role === 'active');
const b = view.stackSummary.creditBreakdown;
const travel = view.stackSummary.credit.lines.find(l => l.id === 'travelvisa'), cash = view.stackSummary.credit.lines.find(l => l.id === 'cashback');
ok(cents(travel.target.amount) === 23600 && cents(travel.paidToward.amount) === 10000 && cents(travel.stillToPayBack.amount) === 13600
  && cents(cash.target.amount) === 11420 && cents(cash.paidToward.amount) === 25000 && cash.stillToPayBack.amount === 0,
  'Travel 100 paid back of 236, 136 still; Cash Back 250 paid back of 114.20, 0 still', JSON.stringify([travel.stillToPayBack, cash.stillToPayBack]));
ok(cents(b.alreadyCounted.amount) === -37895, 'the honest row: "Already counted above" −378.95, the two cards\' own counted charges', JSON.stringify(b.alreadyCounted));
const plug = b.rows.reduce((sum, r) => {
  const line = view.stackSummary.credit.lines.find(l => l.id === r.debtId);
  return sum + cents(line ? line.target.amount : r.amount);
}, 0) - cents(b.total);
ok(plug === 35020 && cents(oldView.stackSummary.creditBreakdown.alreadyCounted.amount) === -35020 && plug !== -cents(b.alreadyCounted.amount),
  'the old catch-all offset was −350.20 (main prints it); the honest row is −378.95: they differ by Travel\'s 28.75 floor',
  JSON.stringify(oldView.stackSummary.creditBreakdown.alreadyCounted));
ok(cents(b.total) === 0 && b.total === oldView.stackSummary.creditBreakdown.total, 'the Credit line is (E)\'s 0.00, as main');
// Credit, Balance After Deductions and Surplus byte-equal to main, on every view.
const same = advice.payPeriodViews.every((v, i) => {
  const o = oldAdvice.payPeriodViews[i];
  return JSON.stringify([v.balanceAfterDeductions, v.balanceAfterDeductionsTrust, v.predictedEndingBalanceTerms, v.stackSummary && v.stackSummary.surplus])
    === JSON.stringify([o.balanceAfterDeductions, o.balanceAfterDeductionsTrust, o.predictedEndingBalanceTerms, o.stackSummary && o.stackSummary.surplus])
    && JSON.stringify(v.stackSummary && v.stackSummary.credit && v.stackSummary.credit.totals.deduction)
    === JSON.stringify(o.stackSummary && o.stackSummary.credit && o.stackSummary.credit.totals.deduction);
});
ok(same && advice.payPeriodViews.length === oldAdvice.payPeriodViews.length,
  `Credit, Balance After Deductions (its trust and terms) and Surplus are byte-equal to main on all ${advice.payPeriodViews.length} views`);

// The page: the real Stack shell, the real Credit card and the real waterfall, reading the view Forecast published (no stub,
// no stand-in publication).
function page(sources) {
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
  return { c, blocks };
}
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ctxFor = rec => ({ data: { debts: x.debts, meta: { asOf: x.asOf } }, plan: x.plan, recommendation: rec, selectedPeriodKey: view.start });
function render(sources, rec) {
  const { c, blocks } = page(sources);
  const el = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
  const card = el(); blocks.credit(card, ctxFor(rec));
  const W = c.StackWaterfall || null;
  const wf = W && typeof W.html === 'function' ? W.html(ctxFor(rec), { creditOpen: true }) : (() => { const e = el(); blocks.waterfall(e, ctxFor(rec)); return e.innerHTML; })();
  return { card: card.innerHTML, wf };
}
const live = render(read, advice);
const items = html => (html.match(/<li class="wf-card[^"]*"[^>]*>[\s\S]*?<\/li>/g) || []).map(text);
const dropRows = items(live.wf);
ok(dropRows[0] === 'Still to pay back on each card', 'the dropdown opens with its plain caption (lead, 2026-11-24)', JSON.stringify(dropRows));
const travelRow = dropRows.find(r => /\$136\b/.test(r)), countedRow = dropRows.find(r => /^Already counted above/.test(r));
ok(!!travelRow && countedRow === 'Already counted above −$379', 'the dropdown prints Travel\'s 136 still to pay back and "Already counted above −$379" (−378.95), never the plug\'s −$350',
  JSON.stringify(dropRows));
ok(!/\$350\b/.test(live.wf), 'the catch-all offset (−350.20) appears nowhere on the page');
const cardRows = (live.card.match(/<li>[\s\S]*?<\/li>/g) || []).map(text);
const travelCard = cardRows.find(r => /\/ \$236\b/.test(r)), cashCard = cardRows.find(r => /\/ \$114\b/.test(r));
ok(!!travelCard && /\+\$100 \/ \$236/.test(travelCard) && !!cashCard && /\+\$250 \/ \$114/.test(cashCard),
  'the Credit card rows read Paid back / Total to pay back: "+$100 / $236" and "+$250 / $114"', JSON.stringify(cardRows));
const rowHtml = id => (live.card.match(new RegExp('<li><button class="stack-credit-line" type="button" data-stack-sheet="card:' + id + '">[\\s\\S]*?</li>')) || [''])[0];
ok(/stack-credit-x is-good"/.test(rowHtml('cashback')) && !/is-good/.test(rowHtml('travelvisa')),
  'green only where paid back reached the target: Cash Back green, Travel plain', '');
ok(!/stack-est|≈|estimated/i.test(live.card + live.wf), 'no estimate styling or words anywhere (OD-034), though these figures are estimated inside Forecast');
// Main printed the targets in the dropdown and the catch-all offset: the same page scripts on main's engine and page.
const mainPage = render(show, oldAdvice);
const creditLine = html => (/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(html) || [''])[0];
ok(creditLine(live.wf) !== '' && creditLine(live.wf) === creditLine(mainPage.wf),
  'the Credit line itself prints exactly as on main (here withheld with the remainder, as main withholds it)', text(creditLine(live.wf)));
ok(/Already counted above −\$350/.test(text(mainPage.wf)) && /\$236\b/.test(text(mainPage.wf)),
  'control: main\'s page printed Travel at its 236 target and "Already counted above −$350" (the plug)', text(mainPage.wf).slice(0, 200));

console.log('3. Mutants: each must fail a check above');
{
  const src = read('public/forecast.js');
  const plugMutant = src.replace("alreadyCounted: { amount: countedCents ? -countedCents / 100 : 0,",
    "alreadyCounted: { amount: -(rows.reduce((sum, row) => sum + stackCents(lines.find(l => String(l.id) === String(row.debtId)) ? lines.find(l => String(l.id) === String(row.debtId)).target.amount : row.amount), 0) - entry.creditCents) / 100 || 0,");
  ok(plugMutant !== src, 'the plug mutant targets the already-counted row');
  const PF = engine(file => (file === 'public/forecast.js' ? plugMutant : read(file)));
  const pv = PF.recommend(x.plan, x.asOf, opts).payPeriodViews.find(v => v.role === 'active');
  ok(cents(pv.stackSummary.creditBreakdown.alreadyCounted.amount) === -35020 && cents(pv.stackSummary.creditBreakdown.alreadyCounted.amount) !== -37895,
    'MUTANT: the catch-all offset restored prints −350.20, which section 2 rejects');
  const cp2 = read('public/forecast-card-period.js');
  const pendingMutant = cp2.replace('const paidToward = paidTowardOf(card, published(card.id));',
    'const paidToward = card.paid.amount !== null ? { amount: card.paid.amount, trust: card.paid.trust, reasons: [] } : paidTowardOf(card, published(card.id));');
  ok(pendingMutant !== cp2, 'the pending mutant targets paid back');
  const PM = realm(file => (file === 'public/forecast-card-period.js' ? pendingMutant : read(file))).ForecastCardPeriod;
  const pend = pub([['a', []]]);
  pend.cards[0].pending = [row('payment', -75, RECONCILED)];
  const line = PM.stackCreditLines(pend, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.stillToPayBack.amount) === 2500, 'MUTANT: Still to pay back from line.paid (the pending 75 counted) reads 25.00, not the 100.00 condition 1 pins', JSON.stringify(line.stillToPayBack));
  const wsrc = read('public/stack-waterfall.js');
  const noCaption = wsrc.replace("const caption = cards ?", "const caption = false ?");
  ok(noCaption !== wsrc, 'the caption mutant targets the caption');
  const nc = render(file => (file === 'public/stack-waterfall.js' ? noCaption : read(file)), advice);
  ok(items(nc.wf)[0] !== 'Still to pay back on each card', 'MUTANT: the dropdown without its caption is caught');
}

console.log(`\nPASS Credit rows: Paid back / Total to pay back and Still to pay back (${checks})`);
