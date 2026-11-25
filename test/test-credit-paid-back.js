'use strict';
/* OD-033 (Dale, 2026-11-23): each Stack Credit card row reads "Paid back / Total to pay back", and each card's Still to pay
 * back shows in the income stack's Credit dropdown, display only: (E)'s Credit total, Balance After Deductions and Surplus
 * are unchanged. Desk ruling (1) (Plan #6): "Use 'Already counted above' only for amounts actually counted above ... Don't
 * force the rows to add up with a catch-all offset." Grok Bot (rule 17): (1) Paid back is posted payments tied to that card
 * in the same pay period; (2) the "Already counted above" offset for a card is exactly that card's purchases already held;
 * (3) a payment shows as paid on one card's row only. Lead (2026-11-24): option B, with a plain caption so nobody reads the
 * card rows as summing to the Credit line. Dale (2026-11-24, #1617 7121410691): no "Already counted above" row in that
 * dropdown; each card's own counted charges stay on its line's deduction.
 *
 *   1. The lead's worked case, per line (Forecast's card module and its dropdown builder, invented publications): every
 *      dropdown figure is checked against that card's own published figures, never against the total.
 *   2. The invented card week through the real recommend and the real page scripts (no stub): the waterfall's dropdown
 *      and the Credit card print Forecast's figures, and Credit, Balance After Deductions and Surplus are byte-equal to main.
 *   2a. A world where the old catch-all offset (the targets minus the Credit term) and the honest row differ, the same way.
 *   2b, 2c. A reversed receiving-side entry leaves the spend card’s payer evidence intact. The HELOC reads the paying side too
 *       (Dale, #821 7161929211): its own posted rows are never read.
 *   3. Mutants: each guard above, removed, is caught.
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
const fx = require('./fixtures/stack-card-week');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// main before this change, for the byte-equal controls.
const BASE = 'b2a821ebd356a91deea07f586a49bf5fbaefc933'; // main with #1617 merged, before this change (it still prints the row)
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
  cards: cards.map(([id, rows, payerAmount = 0]) => ({ id, label: 'Invented ' + id, posted: rows, pending: [],
    payerPaid: payerAmount === 0
      ? { amount: 0, trust: 'estimated', reasons: ['no-confirmed-paying-side-payments'] }
      : { amount: payerAmount, trust: 'calculated', reasons: [] },
    postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] } })) });
const row = (kind, amount, extra = {}) => ({ date: '2031-03-05', payee: 'Invented', amount, kind, ...extra });
const RECONCILED = { paymentAllocation: { status: 'reconciled' } };
// Card A: min 25, no new charges, 100 over its limit (utilisation), a posted 75 payment onto it (25 for the minimum, 50 beyond
// it, the beyond-minimum term). Target max(25, 0, 100) = 100 (estimated: a payment could have hidden part of the overage).
// due = 100 − 0 = 100; netted min(50, max(0, 100 − 25)) = 50; deduction 50. Paid back 75; still to pay back 100 − 75 = 25.
// Card B: min 25, 150 of purchases (all in the Household budget hold) and a 50 refund on the card: Spent 100, target
// max(25, 100, 0) = 100; 150 already counted above; due max(0, 100 − 150) = 0; deduction 0. Nothing paid back: 100 still.
const worked = pub([
  ['a', [row('payment', -75, RECONCILED)], 75],
  ['b', [row('charge', 150), row('refund', -50)]],
]);
const BILLS = { cardMinimums: [{ debtId: 'a', amount: 25 }, { debtId: 'b', amount: 25 }], trust: 'calculated' };
const UTIL = [{ id: 'a', overLimitBy: 100, used: 1100, limit: 1000, balanceTrust: 'calculated' },
  { id: 'b', overLimitBy: 0, used: 100, limit: 1000, balanceTrust: 'calculated' }];
const credit = M.stackCreditLines(worked, BILLS, UTIL, new Map([['a', 5000]]));
const A = credit.lines.find(l => l.id === 'a'), B = credit.lines.find(l => l.id === 'b');
ok(cents(A.target.amount) === 10000 && cents(A.deduction.amount) === 5000 && cents(A.deduction.alreadyCounted) === 0
  && cents(A.deduction.beyondNetted) === 5000 && cents(A.paidBack.amount) === 7500,
  'card A: target 100.00, nothing counted above, 50.00 beyond netted, deduction 50.00, paid back 75.00', JSON.stringify([A.target.amount, A.deduction, A.paidBack]));
ok(cents(B.target.amount) === 10000 && cents(B.deduction.amount) === 0 && cents(B.deduction.alreadyCounted) === 15000
  && cents(B.deduction.countedOffset) === 10000 && cents(B.paidBack.amount) === 0,
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
  return cents(r.amount) === Math.max(0, cents(line.target.amount) - cents(line.paidBack.amount));
}), 'proof 1: each card row is that card\'s target − paid back (A 25.00, B 100.00), worked from its own line', JSON.stringify(drop.rows));
// Proof 2: no "Already counted above" row (Dale, 7121410691); each card's counted charges stay on its own line (A 0, B 150),
// exactly that card's purchases already held (Grok Bot's condition 2).
ok(!Object.hasOwn(drop, 'alreadyCounted') && Object.keys(drop).sort().join() === 'rows,total,trust'
  && cents(A.deduction.alreadyCounted) === 0 && cents(B.deduction.alreadyCounted) === 15000,
  'proof 2: the dropdown has no "Already counted above" row; each card keeps its own counted charges on its line (0.00, 150.00)', JSON.stringify(Object.keys(drop)));
// Proof 3: the Credit line is Σ each line's deduction (50 + 0), (E) unchanged.
ok(cents(drop.total) === cents(A.deduction.amount) + cents(B.deduction.amount) && cents(drop.total) === 5000,
  'proof 3: the Credit line is Σ deductions, 50.00 + 0 = 50.00', String(drop.total));
ok(cents(drop.rows[0].amount) + cents(drop.rows[1].amount) !== cents(drop.total),
  'the rows are display only and do not add up to the Credit line (25 + 100 ≠ 50), which the caption says');
// Grok Bot condition 3: one payment, one row. A's 75 is paid back on A alone; B shows none.
ok(cents(A.paidBack.amount) + cents(B.paidBack.amount) === 7500, 'condition 3: the one 75.00 payment shows as paid back on card A only');
// Grok Bot condition 1: a pending payment is not paid back.
{
  const pend = pub([['a', []]]);
  pend.cards[0].pending = [row('payment', -75, RECONCILED)];
  const line = M.stackCreditLines(pend, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.paid.amount) === 7500 && cents(line.paidBack.amount) === 0 && cents(line.stillToPayBack.amount) === 10000,
    'condition 1: a pending 75.00 payment is in Paid but not Paid back: 0 paid back, 100.00 still to pay back', JSON.stringify([line.paid, line.paidBack]));
}
// A posted receiving-side payment alone remains visible in card movements.
const receiptOnly = pub([['a', [row('payment', -75, RECONCILED)]]]);
{
  const line = M.stackCreditLines(receiptOnly, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(line.paid.amount === 75 && line.paidToward.amount === 0 && line.paidBack.amount === 0
    && line.minimumCovered.value === false && line.stillToPayBack.amount === 100,
    'an allocated card-side receipt with no posted payer debit cannot repay the card or cover its minimum');
}
// Unknown stays unknown: a withheld paid back or target withholds Still to pay back, never $0.
{
  const failed = pub([['a', [row('payment', -75, RECONCILED)]]]);
  failed.cards[0].payerPaid = { amount: null, trust: 'unavailable', reasons: ['posted-coverage-incomplete'] };
  failed.cards[0].postedMovement = { trust: 'unavailable', completeness: 'none', reasons: ['sync-failed'] };
  const past = { ...failed, role: 'past' };
  const line = M.stackCreditLines(past, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(line.paidBack.amount === null && line.stillToPayBack.amount === null && line.stillToPayBack.trust === 'unavailable'
    && line.targetCovered.value === 'unknown', 'a withheld paid back leaves Still to pay back unknown (null), never $0', JSON.stringify(line.stillToPayBack));
  const noBills = M.stackCreditLines(worked, null, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(noBills.target.amount === null && noBills.stillToPayBack.amount === null, 'a withheld target leaves Still to pay back unknown');
}
// Paid back beyond the target: Still to pay back is 0, never negative, and the row is green.
{
  const over = pub([['a', [row('charge', 40), row('payment', -90, RECONCILED)], 90]]);
  const line = M.stackCreditLines(over, { cardMinimums: [{ debtId: 'a', amount: 25 }], trust: 'calculated' },
    [{ id: 'a', overLimitBy: 0, used: 0, limit: 1000, balanceTrust: 'calculated' }], new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.target.amount) === 4000 && line.stillToPayBack.amount === 0 && line.targetCovered.value === true,
    'paid back 90.00 against a 40.00 target: still to pay back 0 (floored), target covered', JSON.stringify([line.target.amount, line.stillToPayBack, line.targetCovered]));
}

console.log('2. Through recommend and the real page scripts, on the invented card week');
// The invented card week (fixtures/stack-card-week: no standalone card credits, which #1618 leaves unconfirmed), worked by hand:
//   Travel: Spent 236.00 (charges 172.40 + 28.75 + 28.60 pending, interest 6.25), target 236.00; charges counted above
//     229.75; posted payments 100.00. Deduction 236.00 − 229.75 = 6.25 (the interest). Still to pay back 236.00 − 100.00 = 136.00.
//   Cash Back: target 114.20, all of it counted above; paid back 250.00. Deduction 0. Still to pay back 0 (floored).
//   Every other card: target 0 and nothing counted above (or its counted charges withheld: it adds nothing).
// Main (with #1617) printed "Already counted above −$344" (229.75 + 114.20); this change prints no such row (Dale, 7121410691).
// Each card keeps its counted charges on its own line. The Credit line is (E)'s 6.25, as main.
const x = fx.fixture();
// This comparison isolates the removed counted row with current balance evidence on every card.
for (const observation of x.overlay.overlays) observation.evidenceDate = x.asOf;
const opts = { debts: x.debts, currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, cardLiveOverlay: x.overlay };
const advice = F.recommend(x.plan, x.asOf, opts), oldAdvice = OLD.recommend(x.plan, x.asOf, opts);
const view = advice.payPeriodViews.find(v => v.role === 'active'), oldView = oldAdvice.payPeriodViews.find(v => v.role === 'active');
const b = view.stackSummary.creditBreakdown;
const travel = view.stackSummary.credit.lines.find(l => l.id === 'travelvisa'), cash = view.stackSummary.credit.lines.find(l => l.id === 'cashback');
ok(cents(travel.target.amount) === 23600 && cents(travel.paidBack.amount) === 10000 && cents(travel.stillToPayBack.amount) === 13600
  && cents(cash.target.amount) === 11420 && cents(cash.paidBack.amount) === 25000 && cash.stillToPayBack.amount === 0,
  'Travel 100 paid back of 236, 136 still; Cash Back 250 paid back of 114.20, 0 still', JSON.stringify([travel.stillToPayBack, cash.stillToPayBack]));
ok(!Object.hasOwn(b, 'alreadyCounted') && cents(travel.deduction.alreadyCounted) === 22975 && cents(cash.deduction.alreadyCounted) === 11420
  && cents(oldView.stackSummary.creditBreakdown.alreadyCounted.amount) === -34395,
  'no "Already counted above" row is published (main published −343.95); each card keeps its counted charges on its line (229.75, 114.20)',
  JSON.stringify(Object.keys(b)));
ok(cents(b.total) === 625 && b.total === oldView.stackSummary.creditBreakdown.total, 'the Credit line is (E)\'s 6.25, as main');
// Credit, Balance After Deductions and Surplus byte-equal to main, on every view.
const sameAsMain = (rec, old) => rec.payPeriodViews.length === old.payPeriodViews.length && rec.payPeriodViews.every((v, i) => {
  const o = old.payPeriodViews[i];
  return JSON.stringify([v.balanceAfterDeductions, v.balanceAfterDeductionsTrust, v.predictedEndingBalanceTerms, v.stackSummary && v.stackSummary.surplus])
    === JSON.stringify([o.balanceAfterDeductions, o.balanceAfterDeductionsTrust, o.predictedEndingBalanceTerms, o.stackSummary && o.stackSummary.surplus])
    && JSON.stringify(v.stackSummary && v.stackSummary.credit && v.stackSummary.credit.totals.deduction)
    === JSON.stringify(o.stackSummary && o.stackSummary.credit && o.stackSummary.credit.totals.deduction);
});
ok(sameAsMain(advice, oldAdvice),
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
function render(sources, rec, world = x) {
  const sel = rec.payPeriodViews.find(v => v.role === 'active');
  const ctx = { data: { debts: world.debts, meta: { asOf: world.asOf } }, plan: world.plan, recommendation: rec, selectedPeriodKey: sel.start };
  const { c, blocks } = page(sources);
  const el = () => ({ innerHTML: '', addEventListener: () => {}, querySelector: () => null });
  const card = el(); blocks.credit(card, ctx);
  const W = c.StackWaterfall || null;
  const wf = W && typeof W.html === 'function' ? W.html(ctx, { creditOpen: true }) : (() => { const e = el(); blocks.waterfall(e, ctx); return e.innerHTML; })();
  return { card: card.innerHTML, wf };
}
const live = render(read, advice);
const items = html => (html.match(/<li class="wf-card[^"]*"[^>]*>[\s\S]*?<\/li>/g) || []).map(text);
const dropRows = items(live.wf);
ok(dropRows[0] === 'Still to pay back on each card', 'the dropdown opens with its plain caption (lead, 2026-11-24)', JSON.stringify(dropRows));
const travelRow = dropRows.find(r => /\$136\b/.test(r));
ok(!!travelRow && !/Already counted above/.test(text(live.wf)) && !/data-row="already-counted"/.test(live.wf) && !/\$344\b/.test(live.wf),
  'the dropdown prints the caption and Travel\'s 136 still to pay back, and no "Already counted above" row (Dale, 7121410691)', JSON.stringify(dropRows));
const cardRows = (live.card.match(/<li>[\s\S]*?<\/li>/g) || []).map(text);
const travelCard = cardRows.find(r => /\/ \$236\b/.test(r)), cashCard = cardRows.find(r => /\/ \$114\b/.test(r));
ok(!!travelCard && /\+\$100 \/ \$236/.test(travelCard) && !!cashCard && /\+\$250 \/ \$114/.test(cashCard),
  'the Credit card rows read Paid back / Total to pay back: "+$100 / $236" and "+$250 / $114"', JSON.stringify(cardRows));
const rowHtml = id => (live.card.match(new RegExp('<li><button class="stack-credit-line" type="button" data-stack-sheet="card:' + id + '">[\\s\\S]*?</li>')) || [''])[0];
ok(/stack-credit-x is-good"/.test(rowHtml('cashback')) && !/is-good/.test(rowHtml('travelvisa')),
  'green only where paid back reached the target: Cash Back green, Travel plain', '');
ok(!/stack-est|≈|estimated/i.test(live.card + live.wf), 'no estimate styling or words anywhere (OD-034), though these figures are estimated inside Forecast');
// Main (with #1617) printed the same card rows and an "Already counted above −$344" row: the same page scripts on main's engine and page.
const mainPage = render(show, oldAdvice);
const creditLine = html => (/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(html) || [''])[0];
ok(creditLine(live.wf) !== '' && creditLine(live.wf) === creditLine(mainPage.wf),
  'the Credit line itself prints exactly as on main', text(creditLine(live.wf)));
ok(/Already counted above −\$344/.test(text(mainPage.wf)) && /\$136\b/.test(text(mainPage.wf)),
  'control: main\'s dropdown printed Travel\'s 136 and "Already counted above −$344", the row this change removes', text(mainPage.wf).slice(0, 240));
ok(items(live.wf).join('|') === items(mainPage.wf).filter(r => !/^Already counted above/.test(r)).join('|'),
  'the dropdown is main\'s, less exactly the one row: the caption and every card row are unchanged');

console.log('2a. Through recommend and the real page: beyond-minimum netting, the Credit line unchanged and no counted row');
// The invented card-coverage world (fixtures/card-coverage-aggregate-world): a manual pay-down-only card, 200.00 over its
// limit, with its 25.00 minimum due and a posted 60.00 payment from the bills account (35.00 beyond the minimum). By hand:
// target max(25.00, new charges withheld, 200.00) = 200.00; nothing counted above (its charges are not seen); due 200.00;
// netted min(35.00, 200.00 − 25.00) = 35.00; deduction 165.00 (the Credit line). The card's Still to pay back is 200.00.
const OVER = (() => {
  const { world } = require('./fixtures/card-coverage-aggregate-world');
  const Live = require('../scripts/live-plan');
  const w = world([['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]], { card: 'mbna', payDownOnly: ['mbna', 'triangle'],
    edit: y => { y.payload.accounts[3].last_fetch = y.asOf + 'T17:00:00Z'; y.payload.accounts[3].plaid_last_successful_update = y.asOf + 'T17:00:00Z';
      const debt = y.data.debts.find(d => d.id === 'mbna');
      debt.evidenceDate = y.asOf;
      debt.balance = (debt.limit || 1000) + 200;
      y.payload.accounts[3].balance = debt.balance; } });
  const o = Live.fromObservation(w); const ov = o.data.liveOverlay;
  const args = [o.data.plan, w.asOf, { debts: o.data.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays } }];
  return { args, world: { debts: o.data.debts, asOf: w.asOf, plan: o.data.plan } };
})();
let overAdvice;
{
  overAdvice = F.recommend(...OVER.args);
  const oldOver = OLD.recommend(...OVER.args);
  const v = overAdvice.payPeriodViews.find(p => p.role === 'active'), ov = oldOver.payPeriodViews.find(p => p.role === 'active');
  const m = v.stackSummary.credit.lines.find(l => l.id === 'mbna');
  ok(cents(m.target.amount) === 20000 && cents(m.deduction.amount) === 16500 && cents(m.deduction.beyondNetted) === 3500 && m.deduction.alreadyCounted === null
    && cents(m.stillToPayBack.amount) === 20000, 'the card: target 200.00, 35.00 beyond netted, deduction 165.00, nothing counted above, 200.00 still to pay back',
    JSON.stringify([m.target.amount, m.deduction, m.stillToPayBack]));
  ok(!Object.hasOwn(v.stackSummary.creditBreakdown, 'alreadyCounted'), 'no "Already counted above" figure is published', JSON.stringify(Object.keys(v.stackSummary.creditBreakdown)));
  ok(cents(v.stackSummary.creditBreakdown.total) === 16500 && sameAsMain(overAdvice, oldOver), 'Credit 165.00, and Credit, BAD and Surplus are byte-equal to main on every view');
  const pg = render(read, overAdvice, OVER.world), mpg = render(show, oldOver, OVER.world);
  ok(!/Already counted above/.test(text(pg.wf)) && /\$200\b/.test(text(pg.wf)) && /Still to pay back on each card/.test(text(pg.wf))
    && creditLine(pg.wf) === creditLine(mpg.wf), 'the page: the caption and the card\'s 200 still to pay back, no counted row, the Credit line as main',
    JSON.stringify(items(pg.wf)));
}

console.log('2b. A reversed card receipt cannot revoke or repeat the named payer-side payment');
{
  const y = fx.fixture();
  y.packet.transactions.find(tx => tx.id === 'payment-a').amount = 100;
  const yOpts = { debts: y.debts, currentPeriodActuals: y.packet, cardPeriodBalanceEvidence: y.balanceEvidence, cardLiveOverlay: y.overlay };
  const yr = F.recommend(y.plan, y.asOf, yOpts);
  const yOld = OLD.recommend(y.plan, y.asOf, yOpts);
  const yv = yr.payPeriodViews.find(v => v.role === 'active');
  const t = yv.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(t.paidBack.amount === 100 && t.stillToPayBack.amount === 136 && t.targetCovered.value === false,
    'the posted payer note still repays 100 of the 236 target when the receiving row is reversed');
  const dropTravel = yv.stackSummary.creditBreakdown.rows.find(r => r.debtId === 'travelvisa');
  ok(dropTravel.amount === 136, 'the dropdown reads 136 still to pay back');
  ok(t.paidToward.amount === travel.paidToward.amount
    && JSON.stringify(yv.stackSummary.credit.totals.minimumsPaid) === JSON.stringify(view.stackSummary.credit.totals.minimumsPaid)
    && JSON.stringify(t.minimumCovered) === JSON.stringify(travel.minimumCovered),
    'reversing the receiving row changes neither the minimum check nor the sum of due cards’ payer payments');
  ok(sameAsMain(yr, yOld), 'Credit, Balance After Deductions and Surplus are byte-equal to main with the debit too');
  const pg = render(read, yr);
  const row = (pg.card.match(/<li><button class="stack-credit-line" type="button" data-stack-sheet="card:travelvisa">[\s\S]*?<\/li>/) || [''])[0];
  ok(/\+\$100 \/ \$236/.test(text(row)) && items(pg.wf).some(r => /\$136\b/.test(r)),
    'both views continue to show the payer-derived amounts');
}

console.log('2c. The HELOC reads the paying side like a card; its own posted rows are never read');
// Superseded rule: the HELOC used to count its own posted payment rows (and withhold on a mixed credit and debit). Dale's
// ruling (#821 7161929211, "It can be counted when it leaves the bills account") and Grok Bot's rule 17 answer (the
// HELOC-side TFR-FR receipt is ignored for Paid back and is never a reversal) move it to the payer's published figure.
// An invented HELOC publication card: a posted 150.00 credit and a 50.00 debit on the HELOC itself, against an 80.00 minimum.
const helocPub = (posted, payerPaid) => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2031-03-10',
  cards: [{ id: 'heloc', label: 'HELOC', syncState: 'proven', postedCoverage: 'complete-provider-response', reasons: [], posted, pending: [],
    ...(payerPaid ? { payerPaid } : {}) }] });
const HELOC_BILLS = { cardMinimums: [{ debtId: 'heloc', amount: 80 }], trust: 'calculated' };
const helocLine = (posted, payerPaid, mod = M) => mod.stackCreditLines(helocPub(posted, payerPaid), HELOC_BILLS, [], new Map()).lines.find(l => l.id === 'heloc');
const PAYER_100 = { amount: 100, trust: 'calculated', reasons: [] };
{
  const mixed = helocLine([row('payment', -150), row('payment', 50)], PAYER_100);
  ok(cents(mixed.paidBack.amount) === 10000 && cents(mixed.paidToward.amount) === 10000 && mixed.stillToPayBack.amount === 0
    && mixed.targetCovered.value === true && mixed.minimumCovered.value === true && !mixed.paidBack.reasons.includes('payment-direction-unresolved'),
    'HELOC with a 150 credit and a 50 debit on its own ledger and 100.00 paid from Bills: Paid back is the payer\'s 100.00, covered',
    JSON.stringify([mixed.paidBack, mixed.stillToPayBack, mixed.targetCovered]));
  const unseen = helocLine([row('payment', -150)]);
  ok(unseen.paidBack.amount === null && unseen.paidBack.reasons.includes('paying-side-coverage-incomplete'),
    'control: with no paying-side figure, the HELOC\'s own 150.00 credit is not counted; Paid back is withheld', JSON.stringify(unseen.paidBack));
}
// The same credits and debits on every receiving ledger change no line: each reads its payer.
{
  const ids = ['a', 'b', 'c'];
  const sweepPub = withDebit => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2031-03-10',
    cards: ids.map(id => ({ id, label: 'Invented ' + id, pending: [], payerPaid: { amount: 120, trust: 'calculated', reasons: [] },
      postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] },
      posted: [row('payment', -120, RECONCILED)].concat(withDebit ? [row('payment', 20, RECONCILED)] : []) }))
      .concat([{ id: 'heloc', label: 'HELOC', syncState: 'proven', postedCoverage: 'complete-provider-response', reasons: [], pending: [],
        payerPaid: { amount: 120, trust: 'calculated', reasons: [] },
        posted: [row('payment', -120)].concat(withDebit ? [row('payment', 20)] : []) }]) });
  const bills = { cardMinimums: ids.concat(['heloc']).map(debtId => ({ debtId, amount: 40 })), trust: 'calculated' };
  const withDebits = M.stackCreditLines(sweepPub(true), bills, [], new Map()).lines;
  const without = M.stackCreditLines(sweepPub(false), bills, [], new Map()).lines;
  ok(withDebits.length === 4 && withDebits.every(l => cents(l.paidBack.amount) === 12000),
    'every line, the HELOC included, reads its payer: debits on the receiving ledgers change nothing',
    JSON.stringify(withDebits.map(l => [l.id, l.paidBack.amount])));
  const figures = lines => JSON.stringify(lines.map(l => [l.id, l.paidBack, l.paidToward, l.stillToPayBack, l.targetCovered, l.minimumCovered]));
  ok(figures(withDebits) === figures(without), 'control: with the debits removed every line\'s Paid back figures are identical');
}
// The legacy card summary carries none of the internal inputs.
{
  const shape = Object.keys(F.stackCardSummary(pub([['a', [row('payment', -75, RECONCILED)]]]))[0]).sort().join();
  ok(shape === ['id', 'label', 'net', 'paid', 'spent', 'state', 'transactions'].sort().join(),
    'Forecast.stackCardSummary publishes no internal inputs for calculating the row', shape);
}

console.log('3. Mutants: each must fail a check above');
{
  const src = read('public/forecast.js');
  // The removed row restored on the page (main's waterfall row, read from main's breakdown): section 2 rejects it.
  const wsrcRow = read('public/stack-waterfall.js');
  const rowBack = wsrcRow.replace('    return caption + cards;',
    "    return caption + cards + '<li class=\"wf-card\" data-row=\"already-counted\"><span class=\"wf-name\"><b>Already counted above</b></span><span class=\"wf-amt\">−$344</span></li>';");
  ok(rowBack !== wsrcRow, 'the row mutant targets the dropdown');
  const rb = render(file => (file === 'public/stack-waterfall.js' ? rowBack : read(file)), advice);
  ok(/Already counted above/.test(text(rb.wf)), 'MUTANT: the "Already counted above" row restored is printed, which section 2 rejects');
  // The removed figure restored in Forecast's breakdown: the shape checks above reject it.
  const figBack = src.replace('    return { rows, total: entry.creditCents / 100, trust };', '    return { rows, alreadyCounted: { amount: 0, trust }, total: entry.creditCents / 100, trust };');
  ok(figBack !== src && Object.hasOwn(engine(file => (file === 'public/forecast.js' ? figBack : read(file))).stackCreditBreakdown(entry, BILLS), 'alreadyCounted'),
    'MUTANT: the "Already counted above" figure restored in the breakdown is published, which proof 2 rejects');
  const cp2 = read('public/forecast-card-period.js');
  const payerRead = 'paidTowardOf(card, published(card.id))';
  const pendingMutant = cp2.replace(payerRead,
    `(card.paid.amount !== null ? { amount: card.paid.amount, trust: card.paid.trust, reasons: [] } : ${payerRead})`);
  ok(pendingMutant !== cp2, 'the pending mutant targets paid back');
  const PM = realm(file => (file === 'public/forecast-card-period.js' ? pendingMutant : read(file))).ForecastCardPeriod;
  const pend = pub([['a', []]]);
  pend.cards[0].pending = [row('payment', -75, RECONCILED)];
  const line = PM.stackCreditLines(pend, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.stillToPayBack.amount) === 2500, 'MUTANT: Still to pay back from line.paid (the pending 75 counted) reads 25.00, not the 100.00 condition 1 pins', JSON.stringify(line.stillToPayBack));
  const receiptMutant = cp2.replace(payerRead, `(card.paidPosted || ${payerRead})`);
  const receiptModule = realm(file => (file === 'public/forecast-card-period.js' ? receiptMutant : read(file))).ForecastCardPeriod;
  const receiptLine = receiptModule.stackCreditLines(receiptOnly, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(receiptMutant !== cp2 && receiptLine.paidBack.amount === 75 && receiptLine.minimumCovered.value === true,
    'MUTANT: restoring receiving-side authority counts the posted receipt and covers the minimum without a payer debit');
  // The superseded HELOC rule restored: only the HELOC's own posted payment rows count.
  const helocFrom = "      if (card.id === 'heloc' && !pubCard) return future ? countedZero(['future-not-observed'])\n";
  const helocSide = cp2.replace(helocFrom,
    "      if (card.id === 'heloc') { let c = 0; for (const r of (pubCard && pubCard.posted) || []) if (r.kind === 'payment') c -= Math.round(r.amount * 100);\n"
    + "        return { amount: c / 100, trust: 'estimated', reasons: [] }; }\n" + helocFrom);
  ok(helocSide !== cp2, 'the HELOC mutant targets the paying-side read');
  const HM = realm(file => (file === 'public/forecast-card-period.js' ? helocSide : read(file))).ForecastCardPeriod;
  const hm = helocLine([row('payment', -150)], undefined, HM);
  ok(cents(hm.paidBack.amount) === 15000, 'MUTANT (HELOC-side rule restored): the HELOC\'s own 150.00 credit counts again, which section 2c rejects');
  const leak = cp2.replace('cards.map(({ paidPosted, chargesCounted, ...card }) => card)', 'cards.map(({ chargesCounted, ...card }) => card)');
  ok(leak !== cp2 && Object.keys(realm(file => (file === 'public/forecast-card-period.js' ? leak : read(file))).Forecast
    .stackCardSummary(pub([['a', []]]))[0]).includes('paidPosted'), 'MUTANT (internal amount not stripped): the summary leaks paidPosted, which section 2c rejects');
  const wsrc = read('public/stack-waterfall.js');
  const noCaption = wsrc.replace("const caption = cards ?", "const caption = false ?");
  ok(noCaption !== wsrc, 'the caption mutant targets the caption');
  const nc = render(file => (file === 'public/stack-waterfall.js' ? noCaption : read(file)), advice);
  ok(items(nc.wf)[0] !== 'Still to pay back on each card', 'MUTANT: the dropdown without its caption is caught');
}

console.log(`\nPASS Credit rows: Paid back / Total to pay back and Still to pay back (${checks})`);
