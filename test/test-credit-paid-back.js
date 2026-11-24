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
 *   2. The invented card week through the real recommend and the real page scripts (no stub): the waterfall's dropdown
 *      and the Credit card print Forecast's figures, and Credit, Balance After Deductions and Surplus are byte-equal to main.
 *   2a. A world where the old catch-all offset (the targets minus the Credit term) and the honest row differ, the same way.
 *   2b, 2c. A posted payment debit withholds Paid back on every line, the HELOC included.
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
const BASE = '17ee87debff166e4314913b49b948f2501e17ed3'; // main at the catch-up (after #1618), before this change
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
// Proof 2: the "Already counted above" row is Σ each card's charges counted above (A 0 + B 150), Grok Bot's condition 2.
ok(cents(drop.alreadyCounted.amount) === -(cents(A.deduction.alreadyCounted) + cents(B.deduction.alreadyCounted)) && cents(drop.alreadyCounted.amount) === -15000,
  'proof 2: "Already counted above" is −(0.00 + 150.00) = −150.00, the two cards\' own counted charges', JSON.stringify(drop.alreadyCounted));
// Proof 3: the Credit line is Σ each line's deduction (50 + 0), (E) unchanged.
ok(cents(drop.total) === cents(A.deduction.amount) + cents(B.deduction.amount) && cents(drop.total) === 5000,
  'proof 3: the Credit line is Σ deductions, 50.00 + 0 = 50.00', String(drop.total));
ok(cents(drop.rows[0].amount) + cents(drop.rows[1].amount) + cents(drop.alreadyCounted.amount) !== cents(drop.total),
  'the rows are display only and do not add up to the Credit line (25 + 100 − 150 ≠ 50), which the caption says');
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
// Unknown stays unknown: a withheld paid back or target withholds Still to pay back, never $0.
{
  const failed = pub([['a', [row('payment', -75, RECONCILED)]]]);
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
  const over = pub([['a', [row('charge', 40), row('payment', -90, RECONCILED)]]]);
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
// "Already counted above" = −(229.75 + 114.20) = −343.95, from the cards' own counted charges. The Credit line is (E)'s 6.25.
const x = fx.fixture();
const opts = { debts: x.debts, currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, cardLiveOverlay: x.overlay };
const advice = F.recommend(x.plan, x.asOf, opts), oldAdvice = OLD.recommend(x.plan, x.asOf, opts);
const view = advice.payPeriodViews.find(v => v.role === 'active'), oldView = oldAdvice.payPeriodViews.find(v => v.role === 'active');
const b = view.stackSummary.creditBreakdown;
const travel = view.stackSummary.credit.lines.find(l => l.id === 'travelvisa'), cash = view.stackSummary.credit.lines.find(l => l.id === 'cashback');
ok(cents(travel.target.amount) === 23600 && cents(travel.paidBack.amount) === 10000 && cents(travel.stillToPayBack.amount) === 13600
  && cents(cash.target.amount) === 11420 && cents(cash.paidBack.amount) === 25000 && cash.stillToPayBack.amount === 0,
  'Travel 100 paid back of 236, 136 still; Cash Back 250 paid back of 114.20, 0 still', JSON.stringify([travel.stillToPayBack, cash.stillToPayBack]));
ok(cents(b.alreadyCounted.amount) === -34395, 'the row: "Already counted above" −343.95, the two cards\' own counted charges', JSON.stringify(b.alreadyCounted));
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
const travelRow = dropRows.find(r => /\$136\b/.test(r)), countedRow = dropRows.find(r => /^Already counted above/.test(r));
ok(!!travelRow && countedRow === 'Already counted above −$344', 'the dropdown prints Travel\'s 136 still to pay back and "Already counted above −$344" (−343.95)',
  JSON.stringify(dropRows));
const cardRows = (live.card.match(/<li>[\s\S]*?<\/li>/g) || []).map(text);
const travelCard = cardRows.find(r => /\/ \$236\b/.test(r)), cashCard = cardRows.find(r => /\/ \$114\b/.test(r));
ok(!!travelCard && /\+\$100 \/ \$236/.test(travelCard) && !!cashCard && /\+\$250 \/ \$114/.test(cashCard),
  'the Credit card rows read Paid back / Total to pay back: "+$100 / $236" and "+$250 / $114"', JSON.stringify(cardRows));
const rowHtml = id => (live.card.match(new RegExp('<li><button class="stack-credit-line" type="button" data-stack-sheet="card:' + id + '">[\\s\\S]*?</li>')) || [''])[0];
ok(/stack-credit-x is-good"/.test(rowHtml('cashback')) && !/is-good/.test(rowHtml('travelvisa')),
  'green only where paid back reached the target: Cash Back green, Travel plain', '');
ok(!/stack-est|≈|estimated/i.test(live.card + live.wf), 'no estimate styling or words anywhere (OD-034), though these figures are estimated inside Forecast');
// Main printed each card at its target in the dropdown: the same page scripts on main's engine and page.
const mainPage = render(show, oldAdvice);
const creditLine = html => (/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(html) || [''])[0];
ok(creditLine(live.wf) !== '' && creditLine(live.wf) === creditLine(mainPage.wf),
  'the Credit line itself prints exactly as on main', text(creditLine(live.wf)));
ok(/\$236\b/.test(text(mainPage.wf)) && !/\$136\b/.test(text(mainPage.wf)), 'control: main\'s dropdown printed Travel at its 236 target, not what is still owed',
  text(mainPage.wf).slice(0, 200));

console.log('2a. Through recommend and the real page: a world where the old catch-all offset and the honest row differ');
// After #1618 no card credit nets as a refund, so the refund floor cannot hide in the row; the beyond-minimum netting can. The
// invented card-coverage world (fixtures/card-coverage-aggregate-world): a manual pay-down-only card, 200.00 over its limit,
// with its 25.00 minimum due and a posted 60.00 payment from the bills account (35.00 beyond the minimum). By hand: target
// max(25.00, new charges withheld, 200.00) = 200.00; nothing counted above (its charges are not seen); due 200.00; netted
// min(35.00, 200.00 − 25.00) = 35.00; deduction 165.00. Honest "Already counted above" = 0 (nothing was counted above), so
// the row is not printed. Main's catch-all offset = 200.00 − 165.00 = 35.00, printed as "Already counted above −$35".
const OVER = (() => {
  const { world } = require('./fixtures/card-coverage-aggregate-world');
  const Live = require('../scripts/live-plan');
  const w = world([['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]], { card: 'mbna', payDownOnly: ['mbna', 'triangle'],
    edit: y => { y.payload.accounts[3].last_fetch = y.asOf + 'T17:00:00Z'; y.payload.accounts[3].plaid_last_successful_update = y.asOf + 'T17:00:00Z';
      const debt = y.data.debts.find(d => d.id === 'mbna'); debt.balance = (debt.limit || 1000) + 200; y.payload.accounts[3].balance = debt.balance; } });
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
  ok(v.stackSummary.creditBreakdown.alreadyCounted.amount === 0 && cents(ov.stackSummary.creditBreakdown.alreadyCounted.amount) === -3500,
    'the honest row is 0 (nothing counted above); main\'s catch-all offset was −35.00 (the netted payment, under the wrong name)',
    JSON.stringify([v.stackSummary.creditBreakdown.alreadyCounted, ov.stackSummary.creditBreakdown.alreadyCounted]));
  ok(cents(v.stackSummary.creditBreakdown.total) === 16500 && sameAsMain(overAdvice, oldOver), 'Credit 165.00, and Credit, BAD and Surplus are byte-equal to main on every view');
  const pg = render(read, overAdvice, OVER.world), mpg = render(show, oldOver, OVER.world);
  ok(!/Already counted above/.test(text(pg.wf)) && /\$200\b/.test(text(pg.wf)) && /Still to pay back on each card/.test(text(pg.wf)),
    'the page: the caption and the card\'s 200 still to pay back; no "Already counted above" row, since nothing was counted above', JSON.stringify(items(pg.wf)));
  ok(/Already counted above −\$35/.test(text(mpg.wf)), 'control: main\'s page printed "Already counted above −$35" for a payment, not a counted charge', text(mpg.wf).slice(0, 240));
}

console.log('2b. A posted payment row that debits the card (ChatGPT, #1617 7120269248): Paid back withheld, never negative');
// The same invented card week, with Travel's posted 100.00 payment flipped from a credit to a debit, its explicit payment hint
// kept. Before the repair: Paid back −100.00 and Still to pay back 336.00 (more than the 236.00 target), printed in the
// dropdown. Now: Paid back is withheld (direction unresolved), so Still to pay back is too: a dash on both views, never a
// negative and never above the target. paidToward, the head's minimumsPaid and the minimum check are unchanged.
let flipped;
{
  const y = fx.fixture();
  y.packet.transactions.find(t => t.id === 'payment-a').amount = 100;
  const yOpts = { debts: y.debts, currentPeriodActuals: y.packet, cardPeriodBalanceEvidence: y.balanceEvidence, cardLiveOverlay: y.overlay };
  const yr = F.recommend(y.plan, y.asOf, yOpts), yOld = OLD.recommend(y.plan, y.asOf, yOpts);
  flipped = yr;
  const yv = yr.payPeriodViews.find(v => v.role === 'active'), yo = yOld.payPeriodViews.find(v => v.role === 'active');
  const t = yv.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(t.paidBack.amount === null && t.paidBack.reasons.includes('payment-direction-unresolved') && t.stillToPayBack.amount === null
    && t.targetCovered.value === 'unknown', 'a posted payment debit: Paid back withheld (payment-direction-unresolved), Still to pay back withheld, never −100 / 336',
    JSON.stringify([t.paidBack, t.stillToPayBack]));
  const row = yv.stackSummary.creditBreakdown.rows.find(r => r.debtId === 'travelvisa');
  ok(row && row.amount === null, 'the dropdown\'s Travel row is withheld too (a dash), never 336', JSON.stringify(row));
  const ot = yo.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(cents(t.paidToward.amount) === cents(ot.paidToward.amount) && JSON.stringify(yv.stackSummary.credit.totals.minimumsPaid) === JSON.stringify(yo.stackSummary.credit.totals.minimumsPaid)
    && JSON.stringify(t.minimumCovered) === JSON.stringify(ot.minimumCovered),
    'paidToward, the head\'s minimumsPaid and the minimum check are as main (only the display value is qualified)');
  ok(yr.payPeriodViews.every((v, i) => JSON.stringify([v.balanceAfterDeductions, v.stackSummary && v.stackSummary.surplus, v.stackSummary && v.stackSummary.credit && v.stackSummary.credit.totals.deduction])
    === JSON.stringify([yOld.payPeriodViews[i].balanceAfterDeductions, yOld.payPeriodViews[i].stackSummary && yOld.payPeriodViews[i].stackSummary.surplus,
      yOld.payPeriodViews[i].stackSummary && yOld.payPeriodViews[i].stackSummary.credit && yOld.payPeriodViews[i].stackSummary.credit.totals.deduction])),
  'Credit, Balance After Deductions and Surplus are byte-equal to main with the debit too');
  // Control: the ordinary credit (the unedited week, section 2) still publishes Paid back 100.00, so only the debit withholds.
  ok(cents(travel.paidBack.amount) === 10000, 'control: the same payment as an ordinary credit is Paid back 100.00 (section 2)');
  // The page: both views print a dash for Travel, no minus anywhere.
  const pg = render(read, yr);
  const travelCard = (pg.card.match(/<li><button class="stack-credit-line" type="button" data-stack-sheet="card:travelvisa">[\s\S]*?<\/li>/) || [''])[0];
  ok(/— \/ \$236/.test(text(travelCard)) && !/−|\u2212|-\$/.test(text(travelCard)), 'the Credit card row reads "— / $236": no negative paid back', text(travelCard));
  const dropTravel = items(pg.wf).find(r => /^Synthetic card|^travelvisa|^Travel/i.test(r)) || items(pg.wf)[1];
  ok(!/\$336/.test(pg.wf) && !/−\$100/.test(pg.wf) && /—/.test(dropTravel), 'the dropdown prints a dash for Travel, never $336', JSON.stringify(items(pg.wf)));
}

console.log('2c. Every line, the HELOC included, withholds Paid back on a posted payment debit (ChatGPT, #1617 7120927392)');
// The HELOC line's paid comes from its own posted rows, not the card figures. An invented HELOC publication card: a posted
// 150.00 payment credit and a posted 50.00 payment debit (net +100.00) against an 80.00 minimum. Paid back, Still to pay
// back and target covered are withheld; its paidToward (the head's input) stays the incumbent 100.00.
const helocPub = posted => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2031-03-10',
  cards: [{ id: 'heloc', label: 'HELOC', syncState: 'proven', postedCoverage: 'complete-provider-response', reasons: [], posted, pending: [] }] });
const HELOC_BILLS = { cardMinimums: [{ debtId: 'heloc', amount: 80 }], trust: 'calculated' };
const helocLine = (posted, mod = M) => mod.stackCreditLines(helocPub(posted), HELOC_BILLS, [], new Map()).lines.find(l => l.id === 'heloc');
{
  const mixed = helocLine([row('payment', -150), row('payment', 50)]);
  ok(mixed.paidBack.amount === null && mixed.paidBack.reasons.includes('payment-direction-unresolved') && mixed.stillToPayBack.amount === null
    && mixed.targetCovered.value === 'unknown' && cents(mixed.paidToward.amount) === 10000,
    'HELOC, 150 credit and 50 debit: Paid back, Still to pay back and target covered withheld; paidToward stays 100.00',
    JSON.stringify([mixed.paidBack, mixed.stillToPayBack, mixed.targetCovered]));
  const plain = helocLine([row('payment', -150)]);
  ok(cents(plain.paidBack.amount) === 15000 && plain.stillToPayBack.amount === 0 && plain.targetCovered.value === true,
    'control: the HELOC with an ordinary 150.00 credit is Paid back 150.00 of its 80.00 target, covered');
}
// The sweep (lead, 2026-11-24): on a publication where every spend card and the HELOC carries a posted payment debit beside
// a credit, every published line withholds Paid back. The same publication with the debits removed publishes each line.
{
  const ids = ['a', 'b', 'c'];
  const sweepPub = withDebit => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current', asOf: '2031-03-10',
    cards: ids.map(id => ({ id, label: 'Invented ' + id, pending: [], postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] },
      posted: [row('payment', -120, RECONCILED)].concat(withDebit ? [row('payment', 20, RECONCILED)] : []) }))
      .concat([{ id: 'heloc', label: 'HELOC', syncState: 'proven', postedCoverage: 'complete-provider-response', reasons: [], pending: [],
        posted: [row('payment', -120)].concat(withDebit ? [row('payment', 20)] : []) }]) });
  const bills = { cardMinimums: ids.concat(['heloc']).map(debtId => ({ debtId, amount: 40 })), trust: 'calculated' };
  const withDebits = M.stackCreditLines(sweepPub(true), bills, [], new Map()).lines;
  const without = M.stackCreditLines(sweepPub(false), bills, [], new Map()).lines;
  ok(withDebits.length === 4 && withDebits.every(l => l.paidBack.amount === null && l.paidBack.reasons.includes('payment-direction-unresolved')
    && l.stillToPayBack.amount === null && l.targetCovered.value === 'unknown'),
    'the sweep: every line (three cards and the HELOC) withholds Paid back where a posted payment debits it',
    JSON.stringify(withDebits.map(l => [l.id, l.paidBack.amount])));
  ok(without.length === 4 && without.every(l => cents(l.paidBack.amount) === 12000), 'control: with the debits removed every line publishes Paid back 120.00',
    JSON.stringify(without.map(l => [l.id, l.paidBack.amount])));
}
// The legacy card summary carries none of the internal inputs.
{
  const shape = Object.keys(F.stackCardSummary(pub([['a', [row('payment', -75, RECONCILED)]]]))[0]).sort().join();
  ok(shape === ['id', 'label', 'net', 'paid', 'spent', 'state', 'transactions'].sort().join(),
    'Forecast.stackCardSummary publishes no internal input (paidPosted, chargesCounted, postedPaymentDebit)', shape);
}

console.log('3. Mutants: each must fail a check above');
{
  const src = read('public/forecast.js');
  const plugMutant = src.replace("alreadyCounted: { amount: countedCents ? -countedCents / 100 : 0,",
    "alreadyCounted: { amount: -(rows.reduce((sum, row) => sum + stackCents(lines.find(l => String(l.id) === String(row.debtId)) ? lines.find(l => String(l.id) === String(row.debtId)).target.amount : row.amount), 0) - entry.creditCents) / 100 || 0,");
  ok(plugMutant !== src, 'the plug mutant targets the already-counted row');
  const PF = engine(file => (file === 'public/forecast.js' ? plugMutant : read(file)));
  const pv = PF.recommend(...OVER.args).payPeriodViews.find(v => v.role === 'active');
  ok(cents(pv.stackSummary.creditBreakdown.alreadyCounted.amount) === -3500,
    'MUTANT: the catch-all offset restored prints −35.00 in the 2a world, which section 2a rejects');
  const cp2 = read('public/forecast-card-period.js');
  const pendingMutant = cp2.replace('const paidToward = paidTowardOf(card, published(card.id));',
    'const paidToward = card.paid.amount !== null ? { amount: card.paid.amount, trust: card.paid.trust, reasons: [] } : paidTowardOf(card, published(card.id));');
  ok(pendingMutant !== cp2, 'the pending mutant targets paid back');
  const PM = realm(file => (file === 'public/forecast-card-period.js' ? pendingMutant : read(file))).ForecastCardPeriod;
  const pend = pub([['a', []]]);
  pend.cards[0].pending = [row('payment', -75, RECONCILED)];
  const line = PM.stackCreditLines(pend, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(cents(line.stillToPayBack.amount) === 2500, 'MUTANT: Still to pay back from line.paid (the pending 75 counted) reads 25.00, not the 100.00 condition 1 pins', JSON.stringify(line.stillToPayBack));
  const debitBlind = cp2.replace("const debit = card.id === 'heloc' ? postedPaymentDebitOf(published('heloc')) : card.postedPaymentDebit === true;",
    "const debit = card.id === 'heloc' ? postedPaymentDebitOf(published('heloc')) : false;");
  ok(debitBlind !== cp2, 'the debit mutant targets the paid-back qualification');
  const PD = engine(file => (file === 'public/forecast-card-period.js' ? debitBlind : read(file)));
  const y = fx.fixture(); y.packet.transactions.find(t => t.id === 'payment-a').amount = 100;
  const dl = PD.recommend(y.plan, y.asOf, { debts: y.debts, currentPeriodActuals: y.packet, cardPeriodBalanceEvidence: y.balanceEvidence, cardLiveOverlay: y.overlay })
    .payPeriodViews.find(v => v.role === 'active').stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(dl.paidBack.amount === null, 'MUTANT (debit flag off): the negative-floor still withholds a net −100 (belt and braces), so the next mutant drops both');
  // A mixed card: a 150.00 posted payment credit and a 50.00 posted payment debit net to +100.00; the debit leaves the
  // direction unresolved, so Paid back is withheld. With the debit flag off it would print a confident +100.00.
  const mixed = pub([['a', [row('payment', -150, RECONCILED), row('payment', 50, RECONCILED)]]]);
  const real = M.stackCreditLines(mixed, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  const mut = realm(file => (file === 'public/forecast-card-period.js' ? debitBlind : read(file))).ForecastCardPeriod
    .stackCreditLines(mixed, BILLS, UTIL, new Map()).lines.find(l => l.id === 'a');
  ok(real.paidBack.amount === null && real.paidBack.reasons.includes('payment-direction-unresolved') && cents(real.paidToward.amount) === 10000,
    'a mixed card (150 credit, 50 debit): Paid back withheld; paidToward stays the incumbent 100.00', JSON.stringify(real.paidBack));
  ok(cents(mut.paidBack.amount) === 10000, 'MUTANT (debit flag off): the mixed card prints a confident +100.00, which the check above rejects');
  const bothOff = debitBlind.replace('(debit || cents(paidToward.amount) < 0)', '(debit)');
  const PB = engine(file => (file === 'public/forecast-card-period.js' ? bothOff : read(file)));
  const bl = PB.recommend(y.plan, y.asOf, { debts: y.debts, currentPeriodActuals: y.packet, cardPeriodBalanceEvidence: y.balanceEvidence, cardLiveOverlay: y.overlay })
    .payPeriodViews.find(v => v.role === 'active').stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(bothOff !== debitBlind && cents(bl.paidBack.amount) === -10000 && cents(bl.stillToPayBack.amount) === 33600,
    'MUTANT (no qualification): Paid back −100.00 and Still to pay back 336.00 come back, which section 2b rejects', JSON.stringify([bl.paidBack, bl.stillToPayBack]));
  const helocBlind = cp2.replace("const debit = card.id === 'heloc' ? postedPaymentDebitOf(published('heloc')) : card.postedPaymentDebit === true;", 'const debit = card.postedPaymentDebit === true;');
  ok(helocBlind !== cp2, 'the HELOC mutant targets the HELOC debit read');
  const HM = realm(file => (file === 'public/forecast-card-period.js' ? helocBlind : read(file))).ForecastCardPeriod;
  const hm = helocLine([row('payment', -150), row('payment', 50)], HM);
  ok(cents(hm.paidBack.amount) === 10000 && hm.targetCovered.value === true, 'MUTANT (HELOC debit not read): Paid back 100.00 and covered true come back, which section 2c rejects');
  const leak = cp2.replace('cards.map(({ paidPosted, chargesCounted, postedPaymentDebit, ...card }) => card)', 'cards.map(({ paidPosted, chargesCounted, ...card }) => card)');
  ok(leak !== cp2 && Object.keys(realm(file => (file === 'public/forecast-card-period.js' ? leak : read(file))).Forecast
    .stackCardSummary(pub([['a', []]]))[0]).includes('postedPaymentDebit'), 'MUTANT (flag not stripped): the summary leaks postedPaymentDebit, which section 2c rejects');
  const wsrc = read('public/stack-waterfall.js');
  const noCaption = wsrc.replace("const caption = cards ?", "const caption = false ?");
  ok(noCaption !== wsrc, 'the caption mutant targets the caption');
  const nc = render(file => (file === 'public/stack-waterfall.js' ? noCaption : read(file)), advice);
  ok(items(nc.wf)[0] !== 'Still to pay back on each card', 'MUTANT: the dropdown without its caption is caught');
}

console.log(`\nPASS Credit rows: Paid back / Total to pay back and Still to pay back (${checks})`);
