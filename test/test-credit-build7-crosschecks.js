'use strict';
/* BUILD 7 (OD-052, OD-057) after #1673: three end-to-end cross-checks, invented provider payload -> the real observer
 * (Live.fromObservation) -> Forecast.recommend -> the real Stack shell, Credit card and waterfall. Every expected figure is
 * worked by hand; the household history file is replaced with an empty one before any module reads it.
 *
 * World (test/fixtures/card-coverage-aggregate-world.js, as in test-card-issuer-receipt-payment.js): income 1,000; the Travel
 * card's 25 minimum due on the as-of; a 150 groceries hold; an 80 grocery purchase and 9 of interest on Travel.
 *
 *   1. The repaired card receipt and one payer debit: a posted issuer receipt of 105 on the card and the 105 Bills debit that
 *      funded it are one payment. Spent 89; target max(25, 89, 0) = 89; Paid back 105 once; Still to pay back 0; covered.
 *      The head reads Paid back over target over the cards with something to pay back (105 / 89), green; the Credit line
 *      reads the dropdown's 0 over the deduction 9; the dropdown row is 0.
 *   2. A real Budget offset, reconciled independently: the 80 purchase sits in the groceries Spent the hold deducts, so the
 *      deduction is 89 - 80 = 9. The Surplus is worked from its own terms: 1,000 - 0 (other bills) - 150 (hold) - 0
 *      (mortgage) - 9 (Credit) = 841, and the printed waterfall cells add up to the printed Surplus.
 *   3. A completed period beside a retained current-period reading: today 10-05, the 09-18 period completed with its 25
 *      minimum paid 20. Its Credit term stays the minimum (25) and its dropdown prints the published remainder (5); a retained
 *      reading for the current period never reaches the completed view, which shows no retained line.
 *
 * Invented data only. `node test/test-credit-build7-crosschecks.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const periodsPath = path.resolve(__dirname, '../public/periods.json');
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...args) => (file === periodsPath ? JSON.stringify({ monthly: [] }) : readFile(file, ...args));

const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const { world } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);
const ROOT = path.join(__dirname, '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const dollars = s => (s == null || s === '' ? null : Number(String(s).replace(/[^\d.-]/g, '')));

// The real Stack page blocks, reading the selected view Forecast published.
function page(rec, data, start) {
  const c = { console, URLSearchParams, Intl, Map, WeakMap, Number, String, Object, Array, JSON, Math, Date,
    location: { search: '?view=classic' }, document: { addEventListener: () => {}, getElementById: () => null } };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(read('public/stack-shell.js'), c);
  const blocks = {};
  const register = c.StackBlocks.register.bind(c.StackBlocks);
  c.StackBlocks.register = (name, fn) => { blocks[name] = fn; register(name, fn); };
  vm.runInContext(read('public/stack-credit.js'), c);
  vm.runInContext(read('public/stack-waterfall.js'), c);
  const ctx = { data: { debts: data.debts, meta: { asOf: data.asOf } }, plan: data.plan, recommendation: rec, selectedPeriodKey: start };
  const card = { innerHTML: '', addEventListener: () => {}, querySelector: () => null };
  blocks.credit(card, ctx);
  const wf = c.StackWaterfall.html(ctx, { creditOpen: true });
  const cell = source => {
    const m = new RegExp('data-source="' + source.replace(/\./g, '\\.') + '"( data-unpublished="true")?>([^<]*)<').exec(wf);
    return !m ? undefined : m[1] ? null : dollars(m[2]);
  };
  const row = id => {
    const m = new RegExp('data-debt-id="' + id + '">([\\s\\S]*?)</li>').exec(wf);
    const amt = m && /data-source="stackSummary\.(?:creditBreakdown\.rows|bills\.cardMinimums)\.\d+\.amount"( data-unpublished="true")?>([^<]*)</.exec(m[1]);
    return !amt ? undefined : amt[1] ? null : dollars(amt[2]);
  };
  return { card: card.innerHTML, wf, cell, row,
    head: text((/data-stack-credit-total[^>]*>([\s\S]*?)<\/span><\/span><span class="stack-credit-go"/.exec(card.innerHTML) || [])[1] || ''),
    green: /data-stack-credit-total><span class="stack-credit-x is-good"/.test(card.innerHTML),
    line: text((/<li class="wf-line wf-credit[\s\S]*?<\/button>/.exec(wf) || [''])[0]) };
}

const synced = x => { x.payload.accounts[3].last_fetch = x.asOf + 'T17:00:00Z'; x.payload.accounts[3].plaid_last_successful_update = x.asOf + 'T17:00:00Z'; };
function advise(rows, extra = {}) {
  const x = world(rows, { edit: synced, ...extra });
  const o = Live.fromObservation(x).data, ov = o.liveOverlay;
  const rec = F.recommend(o.plan, x.asOf, { debts: o.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays }, ...(extra.opts || {}) });
  return { rec, data: { debts: o.debts, plan: o.plan, asOf: x.asOf }, overlay: ov };
}
const transfer = { category_name: 'Transfer' };
const purchase = ['card', 80, null, 'purchase'];
const interest = ['card', 9, null, 'purchase', { payee: 'INTEREST CHARGES', category_name: 'Interest' }];
const receipt = ['card', -105, null, 'credit', { payee: 'PAYMENT - THANK YOU', original_name: 'PAYMENT - THANK YOU', ...transfer }];
const payerDebit = ['bills', 105, null, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', ...transfer }];

console.log('1. The repaired card receipt and one payer debit: one payment, through the head, the Credit line and the dropdown');
const one = advise([purchase, interest, payerDebit, receipt]);
const v1 = one.rec.payPeriodViews.find(p => p.role === 'active');
const l1 = v1.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
{
  ok(cents(l1.spent.amount) === 8900 && cents(l1.target.amount) === 8900 && cents(l1.paidBack.amount) === 10500
    && l1.stillToPayBack.amount === 0 && l1.targetCovered.value === true,
    'Travel: Spent 89, target 89, Paid back 105 once (not 210), Still to pay back 0, covered',
    JSON.stringify([l1.spent.amount, l1.target.amount, l1.paidBack.amount, l1.stillToPayBack.amount]));
  ok(l1.transactions.filter(t => t.amount === -105).length === 1 && l1.transactions.find(t => t.amount === -105).payment === true,
    'the receipt is published once, as the card side of the payment');
  const t = v1.stackSummary.credit.totals;
  const open = v1.stackSummary.credit.lines.filter(l => l.target.amount === null || cents(l.target.amount) > 0);
  ok(open.length === 1 && open[0].id === 'travelvisa' && cents(t.paidBack.amount) === 10500 && cents(t.target.amount) === 8900
    && t.targetCovered.value === true, 'the head totals: Paid back 105 over target 89, over the one card with something to pay back, covered');
  const b = v1.stackSummary.creditBreakdown;
  ok(b.basis === 'targets' && b.rows.length === 1 && b.rows[0].debtId === 'travelvisa' && b.rows[0].amount === 0
    && b.stillToPayBack.amount === 0 && cents(b.total) === 900, 'the breakdown: Travel 0 still, line total 0, deduction 9');
  const p = page(one.rec, one.data, v1.start);
  ok(p.head === '$105 / $89' && p.green, 'the page head reads $105 / $89, green (every target paid back)', p.head);
  ok(p.line === '− Credit $0 / $9' && p.row('travelvisa') === 0 && /Still to pay back on each card/.test(p.wf),
    'the page Credit line reads $0 / $9 and the dropdown row $0, under its caption', p.line);
}

console.log('2. A real Budget offset, reconciled independently against the deduction and the Surplus');
{
  const groceries = (v1.householdBudget || []).find(row => row && row.id === 'groceries');
  ok(groceries && cents(groceries.spent) === 8000 && cents(v1.budgetHold) === 15000,
    'the 80 purchase is in the groceries Spent the 150 hold deducts', JSON.stringify([groceries && groceries.spent, v1.budgetHold]));
  const d = l1.deduction;
  ok(cents(d.alreadyCounted) === 8000 && cents(d.countedOffset) === 8000 && cents(d.beyondNetted) === 0 && cents(d.amount) === 900
    && cents(d.target) - cents(d.countedOffset) - cents(d.beyondNetted) === cents(d.amount),
    'the deduction is 89 - 80 (the offset already counted above) - 0 = 9', JSON.stringify(d));
  const s = v1.stackSummary.surplus, terms = s.terms;
  ok(cents(terms.income) === 100000 && cents(terms.bills) === 0 && cents(terms.household) === 15000 && cents(terms.mortgage) === 0
    && cents(terms.credit) === 900 && cents(s.amount) === 84100,
    'Surplus by hand: 1,000 - 0 - 150 - 0 - 9 = 841, its Credit term the deduction', JSON.stringify(s));
  ok(cents(s.amount) === cents(terms.income) - cents(terms.bills) - cents(terms.household) - cents(terms.mortgage) - cents(terms.credit),
    'the Surplus closes on its own published terms');
  ok(cents(v1.balanceAfterDeductions) === 84100 && cents(v1.predictedEndingBalanceTerms.cardRepaymentAdjustment) === -1600,
    'Balance After Deductions agrees: the bills hold the 25 minimum, so the card term is 9 - 25 = -16');
  const p = page(one.rec, one.data, v1.start);
  const printed = ['stackSummary.income.total.amount', 'stackSummary.bills.other', 'budgetHold', 'stackSummary.bills.mortgage',
    'stackSummary.surplus.terms.credit'].map(p.cell);
  ok(printed.every(Number.isFinite) && p.cell('stackSummary.surplus.amount') === printed[0] - printed.slice(1).reduce((a, x) => a + x, 0)
    && p.cell('stackSummary.surplus.amount') === 841, 'the printed waterfall adds up: income less Bills, Budget, Mortgage and Credit is the printed Surplus 841',
    JSON.stringify(printed));
}

console.log('3. A completed period beside a retained current-period reading');
{
  const pay = (amount, date) => [['bills', amount, date, 'cash'], ['card', -amount, date, 'credit']];
  // No card sync, so the current period's own charges are withheld and a retained reading genuinely applies there.
  const rolled = { asOf: '2026-10-05', minimumDate: '2026-09-25', edit: () => {} };
  const base = advise(pay(20, '2026-09-26'), rolled);
  const current = base.rec.payPeriodViews.find(v => v.role === 'active');
  // A retained reading for the current period (invented: Travel 117 charged, nothing paid back), as the memory would serve it.
  const shape = current.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  const fig = amount => ({ amount, trust: 'calculated', reasons: [] });
  const { deduction, ...held } = shape;
  const activity = { start: current.start, end: current.end, cards: [{ ...held, spent: fig(117), target: { ...shape.target, amount: 117 },
    paidBack: fig(0), paidToward: fig(0), stillToPayBack: fig(117), asOf: '2026-10-04', observedAt: '2026-10-04T18:00:00Z' }] };
  const withHeld = advise(pay(20, '2026-09-26'), { ...rolled, opts: { lastKnownCardActivity: activity } });
  for (const [label, r] of [['without', base], ['with', withHeld]]) {
    const v = r.rec.payPeriodViews.find(x => x.start === '2026-09-18');
    const l = v.stackSummary.credit.lines.find(x => x.id === 'travelvisa');
    const b = v.stackSummary.creditBreakdown;
    ok(v.role === 'lookback' && !l.activityObservedAt && l.paidBack.amount === 20 && l.target.amount === 25 && l.stillToPayBack.amount === 5,
      `${label} a retained current reading: the completed Travel line is its own (paid back 20 of 25, 5 still), not retained`);
    ok(b.basis === 'minimums' && cents(b.total) === 2500 && b.rows.length === 1 && b.rows[0].amount === 5 && b.stillToPayBack.amount === 5
      && cents(v.stackSummary.surplus.terms.credit) === 2500,
      `${label}: the completed Credit term stays the 25 minimum, and the dropdown prints the published remainder 5`);
    const p = page(r.rec, r.data, '2026-09-18');
    ok(p.row('travelvisa') === 5 && !/stackSummary\.bills\.cardMinimums/.test(p.wf) && p.line === '− Credit $5 / $25' && p.head === '$20 / $25',
      `${label}: the page prints the 5 remainder (not the 25 minimum), the Credit line $5 / $25 and the head $20 / $25`, p.line);
  }
  // Control: the retained reading did reach the current view, so the completed view's refusal is not vacuous.
  const cur = withHeld.rec.payPeriodViews.find(v => v.role === 'active');
  const curLine = cur.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(cur.stackSummary.creditBreakdown && cur.stackSummary.creditBreakdown.basis === 'targets'
    && curLine.activityObservedAt === '2026-10-04T18:00:00Z' && curLine.stillToPayBack.amount === 117
    && cur.stackSummary.creditBreakdown.rows.find(x => x.debtId === 'travelvisa').amount === 117,
    'control: the retained reading does reach the current view (117 still), so the completed view\'s refusal is not vacuous',
    JSON.stringify([curLine.activityObservedAt, curLine.spent.amount, curLine.stillToPayBack.amount]));
}

console.log(`\nPASS BUILD 7 cross-checks (${checks})`);
