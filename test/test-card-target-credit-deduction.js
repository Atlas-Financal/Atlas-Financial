'use strict';
/* Desk ruling (E) for #1573 (Plan #6), quoted: "Forecast owns one card-target publication per view. The Credit tile and the
 * income dropdown read the same per-card targets. The Credit deduction is their sum minus the qualifying charges already
 * counted above, each deducted from that sum only once. The waterfall, snapshot and assistant packet read the same Forecast
 * surplus, and `stackSurplus` still equals `balanceAfterDeductions`. Missing evidence must not become zero or gain trust."
 *
 * Per card (lead, on the ruling):
 *   due       = max(0, target − charges already counted above)          (a refund never hands cash back: floored)
 *   deduction = due − min(paid beyond the minimum, max(0, due − minimum)) (only the part of a beyond-minimum payment that
 *                                                                           pays the target above the minimum is netted)
 * Balance After Deductions takes one named term, cardRepaymentAdjustment = Σ deductions − Σ minimums (the bills already hold
 * the minimums). Surplus keeps its identity: Surplus = BAD + held outflows + cash paid beyond a minimum, the same Credit term
 * in both. Current and upcoming views only; a completed view keeps its remainder.
 *
 * Invented data only; every expected figure is worked by hand. `node test/test-card-target-credit-deduction.js`
 */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const fx = require('./fixtures/stack-card-week');
const { world } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0;
const ok = (cond, label, detail = '') => { assert.ok(cond, label + (detail ? ' — ' + detail : '')); checks++; console.log('  PASS  ' + label); };
const cents = v => Math.round(v * 100);

// The previous engine (main before this change), for the byte-equal controls.
const BASE = '006b2c3b57ffaed2e6ce82ca102dd288f768c6e7';
const show = file => cp.execFileSync('git', ['show', BASE + ':' + file], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const prior = { console };
prior.window = prior;
vm.createContext(prior);
for (const file of ['public/display-name.js', 'public/forecast-card-period.js', 'public/forecast.js']) vm.runInContext(show(file), prior);
const OLD = prior.Forecast;

console.log('1. The per-card deduction, on the invented card week (Forecast.stackCreditLines)');
const MINIMUMS = [{ debtId: 'travelvisa', amount: 25 }, { debtId: 'tdcc', amount: 40 }, { debtId: 'triangle', amount: 30 },
  { debtId: 'heloc', amount: 50 }];
const lines = (x, beyond) => {
  const pub = F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
    { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
  const util = F.utilisation(x.debts, null, x.plan);
  return require('../public/forecast-card-period').stackCreditLines(pub, { cardMinimums: MINIMUMS, trust: 'calculated' },
    util.rows, beyond || new Map());
};
const lineOf = (r, id) => r.lines.find(l => l.id === id);
{
  const r = lines(fx.fixture());
  // Travel: 172.40 + 28.75 + 28.60 (pending) already counted, plus 6.25 interest.
  const t = lineOf(r, 'travelvisa');
  ok(cents(t.deduction.alreadyCounted) === 22975 && t.deduction.amount === 6.25,
    'Travel target 236.00 less purchases 229.75 leaves 6.25 interest', JSON.stringify(t.deduction));
  const c = lineOf(r, 'cashback');
  ok(cents(c.deduction.alreadyCounted) === 11420 && c.deduction.amount === 0,
    'charge counted once: Cash Back 114.20 target, all of it already counted above, deduction 0', JSON.stringify(c.deduction));
  const e = lineOf(r, 'tdcc');
  ok(cents(e.deduction.amount) === 4000 && e.deduction.trust === 'calculated',
    'target equal to the minimum: Emerald, nothing spent, deduction 40.00, its minimum', JSON.stringify(e.deduction));
  const tri = lineOf(r, 'triangle');
  ok(cents(tri.deduction.amount) === 3000 && tri.deduction.trust === 'estimated' && tri.deduction.alreadyCounted === null
    && tri.deduction.reasons.includes('already-counted-unavailable'),
    'counted charges withheld: Triangle deducts its full 30.00 target, estimated with its reason (the cautious side)', JSON.stringify(tri.deduction));
  ok(cents(lineOf(r, 'heloc').deduction.amount) === 5000, 'the HELOC: its 50.00 minimum');
}
{
  // Beyond-minimum netting. (1) Emerald, min 40, nothing spent, 15 paid beyond: due 40, overlap min(15, 0) = 0, deduction 40.
  const r1 = lines(fx.fixture(), new Map([['tdcc', 1500]]));
  ok(cents(lineOf(r1, 'tdcc').deduction.amount) === 4000, 'a payment beyond the target stays cash: Emerald deduction 40.00 beside its 15.00 term');
  // (2) The over-limit amount and the period's charges come from one balance (Neon 7113251603 item 2), so the target is the
  // largest, never the sum. Travel over an 800.00 limit by 127.40 (observed) with 236.00 of new charges: max(25, 236.00,
  // 127.40) = 236.00, never 363.40. Travel's posted 100.00 payment is not added back (desk, Plan #6, on review 7116017401):
  // this world's card balance endpoints reconcile and match in value, but nothing ties them to the exact provider
  // observation behind utilisation's posted balance, so equal values are not proof. The target is estimated.
  const over = fx.fixture(); over.debts.find(d => d.id === 'travelvisa').limit = 800;
  const t2 = lineOf(lines(over), 'travelvisa');
  ok(cents(t2.target.amount) === 23600 && cents(t2.target.overLimitBy) === 12740 && t2.deduction.amount === 6.25
    && t2.target.trust === 'estimated' && t2.target.reasons.includes('over-limit-payments-unproven'),
    'over the limit by less than the new charges: target 236.00 (the larger), not 363.40; deduction 6.25; the payment not added back', JSON.stringify(t2.target));
  // (3) Over a 527.40 limit by 400.00 (observed), more than the charges: target max(25, 236.00, 400.00) = 400.00, a lower
  // bound, estimated (not 500.00 on the unproven payment). Due 400.00 − 229.75 = 170.25; min 25; 100 paid beyond: overlap
  // min(100.00, 145.25) = 100.00; deduction 70.25 (120.25 beside 50.00).
  const x = fx.fixture(); x.debts.find(d => d.id === 'travelvisa').limit = 527.40;
  const t3 = lineOf(lines(x, new Map([['travelvisa', 10000]])), 'travelvisa');
  ok(cents(t3.target.amount) === 40000 && cents(t3.target.overLimitBy) === 40000 && cents(t3.deduction.amount) === 7025
    && t3.target.trust === 'estimated' && t3.deduction.trust === 'estimated' && t3.target.reasons.includes('over-limit-payments-unproven'),
    'equal-value endpoints are not proof: target 400.00, estimated (not 500.00); deduction 70.25 beside the 100.00 term, estimated',
    JSON.stringify([t3.target, t3.deduction]));
  const t3b = lineOf(lines(x, new Map([['travelvisa', 5000]])), 'travelvisa');
  ok(cents(t3b.deduction.amount) === 12025, 'with 50.00 beyond instead: 170.25 − min(50.00, 145.25) = 120.25');
}
{
  // A withheld target withholds the deduction and the total, never 0.
  const x = fx.fixture();
  const pub = F.cardPeriodMovements(x.plan, x.debts, x.asOf, x.window,
    { currentPeriodActuals: x.packet, cardPeriodBalanceEvidence: x.balanceEvidence, liveOverlay: x.overlay });
  // No bills split: every minimum is withheld (bills-split-unavailable), so every target is.
  const r = require('../public/forecast-card-period').stackCreditLines(pub, null, null, new Map());
  const t = lineOf(r, 'travelvisa');
  ok(t.target.amount === null && t.deduction.amount === null && t.deduction.trust === 'unavailable'
    && r.totals.deduction.amount === null && r.totals.deduction.trust === 'unavailable',
    'missing target: the deduction and the Credit total are withheld (null, unavailable), never zero', JSON.stringify(r.totals.deduction));
}

console.log('2. Through recommend, the period Balance After Deductions reads (invented card-coverage world)');
// Income 1,000, the 25 card minimum due on the as-of (the only bill), groceries 150 hold: main's remainder 825.
const synced = x => { x.payload.accounts[3].last_fetch = x.asOf + 'T17:00:00Z'; x.payload.accounts[3].plaid_last_successful_update = x.asOf + 'T17:00:00Z'; };
function advise(rows, engine = F, extra = {}) {
  const x = world(rows, { edit: synced, ...extra });
  const o = Live.fromObservation(x);
  const ov = o.data.liveOverlay;
  return engine.recommend(o.data.plan, x.asOf, { debts: o.data.debts, currentPeriodActuals: ov.currentPeriodActuals,
    cardPeriodBalanceEvidence: ov.cardPeriodBalanceEvidence, cardLiveOverlay: { applied: true, overlays: ov.overlays } });
}
const active = r => r.payPeriodViews.find(p => p.role === 'active') || r.payPeriodViews.find(p => p.evidenceState === 'live');
{
  // An 80 grocery purchase on the card: target max(25, 80) = 80, all already in the groceries hold: deduction 0. The
  // minimum is no longer counted beside the purchase it repays: 1,000 − 25 − 150 + 25 = 850, adjustment −25.
  const r = advise([['card', 80, null, 'purchase']]), v = active(r), old = active(advise([['card', 80, null, 'purchase']], OLD));
  ok(cents(old.balanceAfterDeductions) === 82500, 'main: 825.00 (the 25 minimum and the 80 purchase both deducted)');
  ok(cents(v.balanceAfterDeductions) === 85000 && cents(v.predictedEndingBalanceTerms.cardRepaymentAdjustment) === -2500
    && v.predictedEndingBalanceTerms.closes === true, 'target above the minimum, charge counted once: 850.00, adjustment −25.00, terms close',
    JSON.stringify(v.predictedEndingBalanceTerms));
  const s = v.stackSummary.surplus, b = v.stackSummary.creditBreakdown;
  ok(cents(s.amount) === cents(v.balanceAfterDeductions) && s.terms.credit === 0,
    'Surplus = Balance After Deductions (nothing held, nothing beyond), its Credit term 0.00');
  ok(b && b.rows.length === 1 && cents(b.rows[0].amount) === 8000 && cents(b.alreadyCounted.amount) === -8000 && b.total === 0,
    'the dropdown (OD-033): Travel still to pay back 80.00 (nothing paid back), "Already counted above" −80.00 (the purchase in the hold), Credit 0.00', JSON.stringify(b));
  const line = v.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  ok(cents(line.stillToPayBack.amount) === cents(b.rows[0].amount) && cents(line.target.amount) === 8000 && cents(line.paidToward.amount) === 0,
    'the dropdown row is the Credit tile\'s Still to pay back, one figure: its 80.00 target less 0.00 paid back');
}
{
  // Plus 9.00 of interest (not counted above): target 89, counted 80, deduction 9; 1,000 − 25 − 150 − (9 − 25) = 841.
  const v = active(advise([['card', 80, null, 'purchase'], ['card', 9, null, 'purchase', { payee: 'INTEREST CHARGES', category_name: 'Interest' }]]));
  ok(cents(v.balanceAfterDeductions) === 84100 && cents(v.stackSummary.surplus.terms.credit) === 900,
    'interest is not counted above: Credit 9.00, Balance After Deductions 841.00', JSON.stringify([v.balanceAfterDeductions, v.stackSummary.surplus.terms]));
}
{
  // No card activity: the target is the minimum, so the remainder and its terms are main's exactly.
  const v = active(advise([])), old = active(advise([], OLD));
  ok(cents(v.balanceAfterDeductions) === 82500 && JSON.stringify(v.predictedEndingBalanceTerms) === JSON.stringify(old.predictedEndingBalanceTerms),
    'no card activity: Balance After Deductions and its terms equal main (825.00, no card term)');
  // Review 7106640633: the zero term here is the fall-back of unknown card evidence (the card's Spent is withheld), not
  // proof that the target is the minimum, so the remainder keeps that uncertainty: estimated, never calculated.
  ok(old.balanceAfterDeductionsTrust == null && v.balanceAfterDeductionsTrust === 'estimated' && v.stackSummary.surplus.trust === 'estimated'
    && cents(v.stackSummary.surplus.amount) === cents(old.stackSummary.surplus.amount),
    'a zero term from unknown card evidence keeps its uncertainty: Balance After Deductions and Surplus estimated (main read calculated)',
    JSON.stringify([old.balanceAfterDeductionsTrust, v.balanceAfterDeductionsTrust, v.stackSummary.surplus.trust]));
}
{
  // A completed view keeps its published remainder: every lookback view byte-equal to main.
  const r = advise([['card', 80, null, 'purchase']]), old = advise([['card', 80, null, 'purchase']], OLD);
  const past = r.payPeriodViews.filter(p => p.role === 'lookback' || p.evidenceState === 'historical');
  const pastOld = old.payPeriodViews.filter(p => p.role === 'lookback' || p.evidenceState === 'historical');
  ok(past.length > 0 && past.length === pastOld.length && past.every((v, i) => JSON.stringify([v.balanceAfterDeductions, v.predictedEndingBalanceTerms,
    v.stackSummary.surplus]) === JSON.stringify([pastOld[i].balanceAfterDeductions, pastOld[i].predictedEndingBalanceTerms, pastOld[i].stackSummary.surplus])),
  'a past view\'s Balance After Deductions, terms and Surplus are byte-equal to main', `${past.length} past views`);
}
{
  // A manual-card payment of 60 against the 25 minimum (35 beyond, its own term): target 25, deduction 25, so the card
  // takes 25 + 35 = 60, the cash paid; the remainder is main's 790; Surplus = BAD + 35.
  const pay = ['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
  const opts = { card: 'mbna', payDownOnly: ['mbna', 'triangle'] };
  const v = active(advise([pay], F, opts)), old = active(advise([pay], OLD, opts));
  ok(cents(old.balanceAfterDeductions) === 79000 && cents(v.balanceAfterDeductions) === 79000
    && v.predictedEndingBalanceTerms.manualCardPaymentBeyondMinimum === 35,
    'a payment beyond the target stays cash: 790.00, as main (25 + 35 = the 60 paid)', JSON.stringify(v.predictedEndingBalanceTerms));
  ok(cents(v.stackSummary.surplus.amount) === cents(v.balanceAfterDeductions) + 3500,
    'the identity: Surplus = Balance After Deductions + the 35.00 paid beyond the minimum (owner decision above stackSurplus)');
}

console.log('3. The property, over a grid of invented values: each card\'s total effect is the larger of the cash still needed');
// effect = deduction + cash paid beyond the minimum (its own term) == max(due, min(due, minimum) + beyond): the larger of
// the cash still needed for the target and the cash sent beyond the minimum plus the part of the minimum the counted charges
// do not already cover. Never both added together, never less than either. (Where due >= minimum this is
// max(due, minimum + beyond).) An invented one-card publication, its target max(minimum, charges + interest).
{
  const M = require('../public/forecast-card-period');
  const pub = rows => ({ source: 'Forecast.cardPeriodMovements', currency: 'CAD', role: 'current',
    cards: [{ id: 'inv', label: 'Invented', posted: rows, pending: [], postedMovement: { trust: 'calculated', completeness: 'complete', reasons: [] } }] });
  // A preclassified refund in a publication still cannot turn a deduction negative.
  const floor = M.stackCreditLines(pub([{ kind: 'charge', amount: 80, date: '2031-03-02' }, { kind: 'refund', amount: -30, date: '2031-03-03' }]),
    { cardMinimums: [{ debtId: 'inv', amount: 25 }], trust: 'calculated' }, [], new Map()).lines[0];
  assert.deepEqual([floor.target.amount, floor.deduction.alreadyCounted, floor.deduction.amount], [50, 80, 0]);
  let cases = 0, below = 0, above = 0;
  for (const charges of [0, 30, 80, 150]) for (const interest of [0, 10, 60]) for (const minimum of [25, 60, 100]) for (const beyond of [0, 20, 50, 200]) {
    const rows = [charges && { kind: 'charge', amount: charges, date: '2031-03-02' }, interest && { kind: 'interest', amount: interest, date: '2031-03-03' }].filter(Boolean);
    const line = M.stackCreditLines(pub(rows), { cardMinimums: [{ debtId: 'inv', amount: minimum }], trust: 'calculated' }, [],
      new Map([['inv', beyond * 100]])).lines.find(l => l.id === 'inv');
    const due = Math.max(0, Math.max(minimum, charges + interest) - charges);
    const effect = cents(line.deduction.amount) + beyond * 100;
    assert.equal(effect, Math.max(due, Math.min(due, minimum) + beyond) * 100,
      `charges ${charges}, interest ${interest}, minimum ${minimum}, beyond ${beyond}: effect ${effect / 100}`);
    assert.ok(line.deduction.amount >= 0 && effect >= due * 100 && effect >= beyond * 100, 'never less than either');
    cases++; if (due < minimum) below++; else above++;
  }
  ok(cases === 144 && below > 0 && above > 0, 'effect == max(due, min(due, minimum) + beyond) on every grid point, below and above the minimum',
    `${cases} points, ${below} with due < minimum, ${above} with due >= minimum`);
}

console.log('4. Grok Bot\'s three conditions on the cash paid beyond a minimum (Plan #6), each on its own invented case');
{
  const opts = { card: 'mbna', payDownOnly: ['mbna', 'triangle'] };
  const line = v => v.stackSummary.credit.lines.find(l => l.id === 'mbna');
  // (1) Only a POSTED payment tied to the card counts: a pending 60 payment is not netted (and is no term).
  const pending = ['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS', is_pending: true }];
  const v1 = active(advise([pending], F, opts));
  // Positive control: the same payment posted, in this cycle, is the 35 beyond the minimum, carried to the netting.
  const posted = active(advise([['bills', 60, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]], F, opts));
  ok(cents(line(posted).deduction.beyondMinimumPaid) === 3500, 'control: the same payment posted in this cycle carries its 35.00 beyond the minimum',
    JSON.stringify(line(posted).deduction));
  ok(line(v1).deduction.beyondMinimumPaid === 0 && !v1.predictedEndingBalanceTerms.manualCardPaymentBeyondMinimum,
    'condition 1: a pending payment is not netted against the target', JSON.stringify(line(v1).deduction));
  // (2) Only within the target's own cycle (its pay period): the card ledger opens 09-04 and sees a 60 payment on 09-10
  // against that period's 25 minimum (35 beyond, in the 09-04..09-17 period). It is netted there and never against the
  // 09-18..10-01 period's target.
  const { RULE } = require('./fixtures/card-coverage-aggregate-world');
  const early = ['bills', 60, '2026-09-10', 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
  const r2 = advise([early], F, { ...opts, windowStart: '2026-09-04', minimumDate: '2026-09-10',
    policy: { rule: RULE, opening: { asOf: '2026-09-04', confirmed: true, currency: 'cad', fundingAccountId: 'chequing-a', purchases: [] },
      payDownOnly: ['mbna', 'triangle'] } });
  const seen = (r2.cardPurchaseCoverage.payDownBeyondMinimum || []).filter(row => row.account === 'mbna' && row.date === '2026-09-10');
  const earlier = r2.payPeriodViews.find(v => v.start === '2026-09-04'), v2 = active(r2);
  ok(seen.length === 1 && cents(line(earlier).deduction.beyondMinimumPaid) === 3500 && line(v2).deduction.beyondMinimumPaid === 0,
    'condition 2: the 35.00 beyond is netted in its own cycle (09-04) and not against the next cycle\'s target',
    JSON.stringify([seen, line(earlier).deduction.beyondMinimumPaid, line(v2).deduction]));
  // (3) A payment already counted elsewhere is not netted again: a 25 payment of the 25 minimum is the bill itself, so
  // nothing is beyond it and nothing is netted; the remainder is main's.
  const exact = ['bills', 25, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
  const v3 = active(advise([exact], F, opts)), o3 = active(advise([exact], OLD, opts));
  ok(line(v3).deduction.beyondMinimumPaid === 0 && cents(v3.balanceAfterDeductions) === cents(o3.balanceAfterDeductions),
    'condition 3: the payment of the minimum (counted as the bill) is not netted again; remainder as main', JSON.stringify(line(v3).deduction));
}

console.log('5. Consumers carry the signed card term as published (review 7106640633): the assistant packet and the classic breakdown');
{
  const A = require('../scripts/assistant-packet');
  const fs = require('node:fs');
  // The classic Budget page's terms block, rendered by public/plan.js on the period Forecast published.
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const page = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  page.window = page; page.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '..', 'public', name + '.js'), 'utf8');
  vm.runInContext(script('app'), page); vm.runInContext('App.boot=()=>{};', page);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), page);
  const termsOf = (view, plan) => {
    page.period = view; page.plan = plan;
    const html = vm.runInContext('calendarWaterfallHtml(period,null,null,plan,false)', page);
    const block = html.split(`data-bad-terms-period="${view.id}"`)[1] || '';
    const out = {};
    for (const m of block.matchAll(/data-bad-term="([A-Za-z]+)" data-bad-term-trust="[a-z]+"[^>]*>.*?<span data-bad-term-amount>([^<]*)<\/span>/g)) {
      const t = m[2].match(/^(−|-)?\$([\d,]+)\.(\d\d)$/);
      out[m[1]] = t ? (t[1] ? -1 : 1) * (Number(t[2].replace(/,/g, '')) * 100 + Number(t[3])) : null;
    }
    return out;
  };
  const interest = n => ['card', n, null, 'purchase', { payee: 'INTEREST CHARGES', category_name: 'Interest' }];
  // Invented: income 1,000, the 25 minimum, groceries 150. Purchase 80: term −25, 850. Interest 40: target 40, term +15,
  // 810. Interest 25: target 25 = the minimum, no term, 825.
  for (const [name, rows, term, bad] of [['purchase 80', [['card', 80, null, 'purchase']], -2500, 85000],
    ['interest 40', [interest(40)], 1500, 81000], ['interest 25', [interest(25)], null, 82500]]) {
    const x = world(rows, { edit: synced });
    const o = Live.fromObservation(x);
    const data = { ...o.data, meta: { ...(o.data.meta || {}), asOf: x.asOf } };
    const packet = A.buildPacket({ data, periods: { periods: {} }, questionsMarkdown: '', env: {}, now: x.asOf + 'T19:00:00Z' });
    const p0 = packet.forecast.payPeriodTotals.periods.find(p => p.offset === 0).balanceAfterDeductions;
    ok(p0.status === 'ok' && cents(p0.amount) === bad
      && (term === null ? !Object.hasOwn(p0.terms, 'cardRepaymentAdjustment') : cents(p0.terms.cardRepaymentAdjustment) === term),
    `packet, ${name}: Balance After Deductions ${bad / 100} with its signed card term ${term === null ? 'absent' : term / 100}`, JSON.stringify(p0));
    const advice = F.recommend(o.data.plan, x.asOf, F.budgetRecommendInputs(data, {}));
    const view = active(advice);
    const printed = termsOf(view, o.data.plan);
    const sum = printed.periodIncome - printed.assignedBills - printed.householdBudgetHold - (printed.cardRepaymentAdjustment || 0);
    ok(printed.balanceAfterDeductions === bad && (term === null ? !('cardRepaymentAdjustment' in printed) : printed.cardRepaymentAdjustment === term)
      && sum === bad, `classic breakdown, ${name}: the printed terms (card term ${term === null ? 'absent' : 'printed'}) add up to the printed ${bad / 100}`,
    JSON.stringify(printed));
  }
}

console.log('6. Which card evidence the remainder\'s trust reads (review 7106640633, the lead\'s option (c))');
// Rule: Balance After Deductions and the Surplus take the weakest Credit deduction among the cards the household holds,
// except a manual card with no minimum due (unseen by design, counted $0 in normal font by Dale's decision).
{
  const interest = n => ['card', n, null, 'purchase', { payee: 'INTEREST CHARGES', category_name: 'Interest' }];
  const trustOf = v => v.balanceAfterDeductionsTrust || 'calculated';
  // Complete evidence, target equal to the minimum (interest 25 against the 25 minimum): no term, and calculated, as main.
  const full = active(advise([interest(25)])), fullOld = active(advise([interest(25)], OLD));
  ok(cents(full.balanceAfterDeductions) === 82500 && trustOf(full) === 'calculated' && trustOf(fullOld) === 'calculated'
    && full.stackSummary.surplus.trust === 'calculated', 'complete card evidence, zero term: 825.00, calculated, as main');
  // A held feed card whose sync is not proven: its unknown new charges keep the remainder estimated.
  const unsynced = active(advise([], F, { edit: () => {} }));
  ok(trustOf(unsynced) === 'estimated' && unsynced.stackSummary.surplus.trust === 'estimated',
    'a feed card without a proven sync keeps Balance After Deductions and the Surplus estimated');
  // A manual card the household holds with no minimum due (the second invented card): adds no uncertainty.
  const manual = active(advise([interest(25)], F, { twoCards: true }));
  const mbna = manual.stackSummary.credit.lines.find(l => l.id === 'mbna');
  ok(mbna && mbna.deduction.trust === 'estimated' && mbna.minimum.reasons.includes('no-minimum-due-in-period')
    && trustOf(manual) === 'calculated' && manual.stackSummary.surplus.trust === 'calculated',
    'a manual card with no minimum due (its own deduction estimated) leaves the remainder calculated');
  // The same manual card, no minimum due, but 200.00 over its 1,000 limit (review 7110654511): its deduction is +200.00, so
  // it is not the unseen zero and lends its estimated trust. Balance After Deductions 825.00 - 200.00 = 625.00, estimated,
  // and the Surplus estimated too.
  const over = active(advise([interest(25)], F, { twoCards: true, edit: x => { synced(x);
    const debt = x.data.debts.find(d => d.id === 'mbna'); debt.balance = 1200;
    const acct = x.payload.accounts.find(a => a.name === 'Invented mbna'); if (acct) acct.balance = 1200; } }));
  const overLine = over.stackSummary.credit.lines.find(l => l.id === 'mbna');
  ok(overLine && cents(overLine.deduction.amount) === 20000 && overLine.deduction.trust === 'estimated'
    && overLine.minimum.reasons.includes('no-minimum-due-in-period')
    && cents(over.predictedEndingBalanceTerms.cardRepaymentAdjustment) === 20000 && cents(over.balanceAfterDeductions) === 62500
    && trustOf(over) === 'estimated' && over.stackSummary.surplus.trust === 'estimated',
    'a manual card with no minimum due but 200.00 over its limit: +200.00, 625.00, Balance After Deductions and the Surplus estimated',
    JSON.stringify([overLine && overLine.deduction, over.balanceAfterDeductions, trustOf(over), over.stackSummary.surplus.trust]));
  // The Credit publication keeps its own trust: only what it lends the remainder leaves the manual card out.
  const breakdown = manual.stackSummary.creditBreakdown;
  ok(breakdown && breakdown.trust === 'estimated' && breakdown.alreadyCounted.trust === manual.stackSummary.credit.totals.deduction.trust
    && breakdown.alreadyCounted.trust === 'estimated', 'the Credit breakdown and its "Already counted above" row stay estimated');
  // A fall-back target: the manual card's 25 minimum stands in for its unseen new charges. Estimated.
  const fallback = active(advise([], F, { card: 'mbna', payDownOnly: ['mbna', 'triangle'] }));
  const fm = fallback.stackSummary.credit.lines.find(l => l.id === 'mbna');
  ok(cents(fm.target.amount) === 2500 && fm.target.trust === 'estimated' && trustOf(fallback) === 'estimated'
    && fallback.stackSummary.surplus.trust === 'estimated' && !fallback.predictedEndingBalanceTerms.cardRepaymentAdjustment,
  'a fall-back target (the 25 minimum for unseen charges, zero term) keeps the remainder estimated');
}

console.log('7. Already counted above agrees with what the Household budget hold counted (Neon 7113251603 item 1, desk)');
// The hold nets a refund only as a Lunch Money group-parent row (LEDGER A item 3, Grok rule 17); a standalone refund never
// nets. The card ledger reads a group parent as unqualified coverage, and the live feed marks no card credit a refund, so
// the rows the hold nets and the rows the card counts never overlap: the gross charges counted are what the hold counted.
{
  const holdOf = (v, id) => ((v.householdBudget || []).find(r => r.id === id) || {}).spent;
  const travel = v => v.stackSummary.credit.lines.find(l => l.id === 'travelvisa');
  // A purchase alone: the hold counts 100.00 and the card counts the same 100.00 above.
  const one = active(advise([['card', 100, null, 'purchase']]));
  ok(cents(holdOf(one, 'groceries')) === 10000 && cents(travel(one).deduction.alreadyCounted) === 10000,
    'a purchase: the hold counts 100.00 and the card counts the same 100.00 already counted above');
  // A standalone refund beside it: the hold does not net it (100.00 still held); the card cannot confirm the credit, so it
  // counts nothing above and deducts its whole target, estimated. Never a deduction reduced by a refund the hold kept.
  const ref = active(advise([['card', 100, null, 'purchase'], ['card', -100, null, 'refund']]));
  const rl = travel(ref);
  ok(cents(holdOf(ref, 'groceries')) === 10000 && rl.deduction.alreadyCounted === null
    && cents(rl.deduction.amount) === cents(rl.target.amount) && rl.deduction.trust === 'estimated',
    'a standalone refund: the hold keeps the 100.00; the card counts nothing above and deducts its whole target, estimated',
    JSON.stringify([holdOf(ref, 'groceries'), rl.deduction]));
  // A group-parent row (the one form the hold nets): the card withholds its coverage and deducts its whole target.
  const grp = active(advise([['card', 100, null, 'purchase', { is_group: true }]]));
  const gl = travel(grp);
  ok(gl.spent.amount === null && gl.spent.reasons.includes('parent-coverage-unqualified') && gl.deduction.alreadyCounted === null
    && cents(gl.deduction.amount) === cents(gl.target.amount) && gl.deduction.trust === 'estimated',
    'a group-parent row: the card withholds its coverage and deducts its whole target, estimated', JSON.stringify(gl.deduction));
}

console.log(`\nPASS card target Credit deduction (${checks})`);
