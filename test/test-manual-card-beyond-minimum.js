'use strict';
// Manual-card (MBNA, Triangle) payments beyond the minimum (Grok Bot, Plan #6, 1795043398.586159;
// lead, 2026-11-19). A posted chequing debit with that card's payee identity pays the card's
// minimum first (the card ledger's minimum-first walk, unchanged). The part above the minimum in
// that card's pay period, or the whole payment when no minimum is due there, also left household
// cash: it is deducted once from Balance After Deductions and the planned close as its own term,
// manualCardPaymentBeyondMinimum, never as To confirm. MBNA counts it only in a period whose
// manual account holds no posted purchase (one source per card per period); Triangle always.
// Invented world (fixtures/card-coverage-aggregate-world): income 1,000, the 25 card minimum due
// on the as-of (the period's only bill), groceries 150 hold. Every expected figure is hand-derived:
// remainder before any excess 825 = 1,000 - 25 - 150.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let failures = 0;
function ok(cond, msg, detail) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}${!cond && detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}
const cents = n => Math.round(Number(n) * 100);
const card = (name, rows, extra = {}) => world(rows, { card: name, payDownOnly: ['mbna', 'triangle'], ...extra });
const pay = (amount, payee = 'MBNA M/C', extra = {}) => ['bills', amount, null, 'cash', { payee, category_name: 'DEBT&PAYMENTS', ...extra }];
const term = r => r.period.predictedEndingBalanceTerms && r.period.predictedEndingBalanceTerms.manualCardPaymentBeyondMinimum;
const BEFORE = 825; // 1,000 - 25 - 150

console.log('\n=== MBNA: the part above the minimum is deducted once ===');
const control = run(card('mbna', [pay(25)]));
ok(cents(control.period.balanceAfterDeductions) === cents(BEFORE) && term(control) === undefined,
  'control: a payment equal to the 25 minimum adds no term (remainder 825)', String(control.period.balanceAfterDeductions));
const over = run(card('mbna', [pay(60)]));
ok(term(over) === 35 && cents(over.period.balanceAfterDeductions) === cents(BEFORE - 35)
  && over.period.predictedEndingBalanceTerms.closes === true,
  'a 60 payment against a 25 minimum: 35 beyond, remainder 790, the terms close', JSON.stringify(over.period.predictedEndingBalanceTerms));
ok(over.period.periodBillLoad === control.period.periodBillLoad, 'the minimum stays one bill (bill load unchanged)');
ok(over.coverage.payments[0].minimumPayment === 25 && over.coverage.payments[0].cardPayment === 35,
  'one authority: the card ledger\'s own split (25 minimum, 35 prior debt) is the term');
const rows = over.period.manualCardPaymentsBeyondMinimum;
ok(rows && rows.total === 35 && rows.rows.length === 1 && rows.rows[0].account === 'mbna' && rows.rows[0].amount === 35,
  'its own per-card row, never a To confirm row', JSON.stringify(rows));
ok(!over.period.heldOutflowsToConfirm && !Object.hasOwn(over.period.predictedEndingBalanceTerms, 'heldOutflowSpending'),
  'nothing is held To confirm');
const closeTerms = over.period.plannedPeriodCloseTerms;
ok(closeTerms && closeTerms.manualCardPaymentBeyondMinimum === 35
  && /-and-manual-card-payment-beyond-minimum$/.test(closeTerms.identity),
  'the planned close carries the same term and names it in its identity', JSON.stringify(closeTerms));
if (closeTerms) {
  const rebuilt = closeTerms.opening + closeTerms.incomeAdded - closeTerms.periodBillLoad - closeTerms.budgetHold
    - closeTerms.annualSavingsNeed - (closeTerms.earlierCardPurchaseReserve || 0) - (closeTerms.savingsItemSpending || 0)
    - (closeTerms.heldOutflowSpending || 0) - closeTerms.manualCardPaymentBeyondMinimum;
  ok(cents(rebuilt) === cents(over.period.plannedPeriodClose), 'the planned close is its own published terms, the new one included',
    JSON.stringify([rebuilt, over.period.plannedPeriodClose]));
}

console.log('\n=== Triangle (CAN TIRE MC), and the whole payment when no minimum is due ===');
const tri = run(card('triangle', [pay(60, 'CAN TIRE MC')]));
ok(term(tri) === 35 && cents(tri.period.balanceAfterDeductions) === cents(BEFORE - 35), 'Triangle 60 against 25: 35 beyond, once');
for (const category of ['Pets', 'Credit Card', 'Shopping']) {
  const filed = run(card('triangle', [pay(60, 'CAN TIRE MC', { category_name: category })]));
  ok(term(filed) === 35, 'condition 4: CAN TIRE MC filed as ' + category + ' is still the Triangle payment (payee identity)');
}
// Early payment (lead blocker on #1394): no minimum in the payment's own period, so it first meets
// the card's next minimum occurrence (25, due 2026-10-08 in the next period), which that period still
// reserves; only the rest is beyond it. Across both periods the money counted equals the cash that left.
const early = run(card('mbna', [pay(60)], { minimumDate: '2026-10-08' }));
const nextPeriod = early.advice.payPeriodViews.find(view => view.start === '2026-10-02');
ok(term(early) === 35 && cents(early.period.balanceAfterDeductions) === cents(1000 - 150 - 35),
  'early 60 with the next minimum 25 not yet due: 35 beyond it here (remainder 815 = 1,000 - 150 - 35)',
  JSON.stringify([term(early), early.period.balanceAfterDeductions]));
const earlyControl = run(card('mbna', [], { minimumDate: '2026-10-08' }));
const controlNext = earlyControl.advice.payPeriodViews.find(view => view.start === '2026-10-02');
ok(nextPeriod && controlNext && nextPeriod.periodBillLoad === controlNext.periodBillLoad
  && (controlNext.bills || []).some(bill => bill.id === 'mbna-minimum' && bill.amount === 25),
  'the next period still reserves its 25 minimum exactly as with no payment', JSON.stringify([nextPeriod && nextPeriod.periodBillLoad, controlNext && controlNext.periodBillLoad]));
ok(cents(term(early)) + 2500 === 6000, 'so across both periods 35 + 25 = 60, the payment, counted once');
const small = run(card('mbna', [pay(20)], { minimumDate: '2026-10-08' }));
ok(term(small) === undefined, 'an early payment smaller than the next minimum: no term (it all meets that minimum)');
const twoEarly = run(card('mbna', [pay(20), ['bills', 20, '2026-09-19', 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }]],
  { minimumDate: '2026-10-08' }));
ok(term(twoEarly) === 15, 'two early 20s against the next 25 minimum: the minimum is met once (20 + 5), 15 beyond',
  JSON.stringify(twoEarly.coverage.payDownBeyondMinimum));

console.log('\n=== household chequing only: a Savings-funded payment is not this term (pre-review blocker) ===');
{
  const reserve = { reserveSavings: true, savingsOpening: 1000 };
  for (const [name, payee] of [['mbna', 'MBNA PAYMENT'], ['triangle', 'CAN TIRE MC']]) {
    const fromSavings = run(card(name, [['savings', 60, null, 'cash', { payee, category_name: 'DEBT&PAYMENTS' }]], reserve));
    ok(fromSavings.coverage.payments.some(row => row.minimumPayment === 25 && row.cardPayment === 35) && term(fromSavings) === undefined
      && !(fromSavings.coverage.payDownBeyondMinimum || []).length,
      name + ' paid 60 from Savings: the ledger still pays the 25 minimum, but the 35 never left household chequing, so no term',
      JSON.stringify(fromSavings.coverage.payDownBeyondMinimum));
    const fromBills = run(card(name, [['bills', 60, null, 'cash', { payee, category_name: 'DEBT&PAYMENTS' }]], reserve));
    ok(term(fromBills) === 35, name + ' control: the same payment from Bills is the 35 term');
  }
}

console.log('\n=== the term\'s cycle is the card ledger\'s pay period ===');
{
  // Payday anchor 2026-09-18: periods 09-18..10-01 and 10-02..10-15. A 60 payment on the last day of
  // the first period, with its 25 minimum also there, is that period's 35, never the next period's.
  const boundary = ['bills', 60, '2026-10-01', 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
  const r = run(card('mbna', [boundary], { asOf: '2026-10-03', minimumDate: '2026-10-01' }));
  const first = r.advice.payPeriodViews.find(view => view.start === '2026-09-18');
  ok(first && first.predictedEndingBalanceTerms && first.predictedEndingBalanceTerms.manualCardPaymentBeyondMinimum === 35
    && term(r) === undefined, 'a payment on the period\'s last day counts in that period only',
  JSON.stringify([first && first.predictedEndingBalanceTerms, term(r)]));
}

console.log('\n=== what is not this term ===');
const pendingPay = run(card('mbna', [pay(60, 'MBNA M/C', { is_pending: true })]));
ok(term(pendingPay) === undefined, 'a pending payment: unchanged (posted only)');
const noteOnly = run(card('mbna', [pay(60, 'Invented card bill', { notes: 'card payment: MBNA' })]));
ok(term(noteOnly) === undefined, 'a note-only MBNA payment is not a pay-down pair (coverage pairing unchanged): disclosed, not counted here');
const earlier = ['bills', 60, '2026-09-25', 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
const twoPeriods = run(card('mbna', [earlier], { asOf: '2026-10-03', minimumDate: '2026-09-20' }));
ok(term(twoPeriods) === undefined, 'a payment in an earlier pay period is not this period\'s term',
  JSON.stringify(twoPeriods.coverage.payDownBeyondMinimum));
const past = twoPeriods.advice.payPeriodViews.find(view => view.start === '2026-09-18');
ok(past && past.predictedEndingBalanceTerms && past.predictedEndingBalanceTerms.manualCardPaymentBeyondMinimum === 35,
  'it is the earlier period\'s term, once', JSON.stringify(past && past.predictedEndingBalanceTerms));

console.log('\n=== the Budget page prints the term once ===');
{
  const stub = () => ({ innerHTML: '', value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {}, replaceChildren() {} });
  const context = vm.createContext({ Forecast: F, console, setTimeout, clearTimeout, addEventListener() {},
    document: { getElementById: stub, querySelectorAll() { return []; }, addEventListener() {}, documentElement: { dataset: {}, style: {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, location: { pathname: '/', search: '' } });
  context.window = context; context.matchMedia = () => ({ matches: false, addEventListener() {} });
  const script = name => fs.readFileSync(path.join(__dirname, '../public/' + name + '.js'), 'utf8');
  vm.runInContext(script('app'), context); vm.runInContext('App.boot=()=>{};', context);
  for (const name of ['bill-detail', 'savings-inventory', 'budget-surface', 'plan']) vm.runInContext(script(name), context);
  const render = r => { context.period = r.period; context.plan = r.observed.data.plan; return vm.runInContext('calendarWaterfallHtml(period,null,null,plan,false)', context); };
  const html = render(over);
  const row = (html.match(/data-bad-term="manualCardPaymentBeyondMinimum"[^]*?<span data-bad-term-amount>([^<]*)<\/span>/) || [])[1];
  ok(row === '$35.00' && (html.match(/data-bad-term="manualCardPaymentBeyondMinimum"/g) || []).length === 1
    && /Card payments beyond the minimum \(MBNA, Triangle\)/.test(html), 'the term prints once, labelled, as 35.00', row);
  ok(!/data-bad-term="manualCardPaymentBeyondMinimum"/.test(render(control)), 'no such row when no payment exceeds the minimum');
}

console.log('\n=== the stored period history: the term set grows; an older record still verifies ===');
{
  const Pg = require('../scripts/private-period-history-postgres');
  const History = require('../scripts/private-period-history');
  const { input, capture } = require('./fixtures/private-period-history-input');
  const reseal = candidate => {
    const body = { schema: candidate.schema, capturedAt: candidate.capturedAt, content: candidate.content };
    return { ...body, captureId: History.contract.digest(body) };
  };
  const older = capture(input());
  let projected = null, error = null;
  try { projected = Pg.project(older); } catch (e) { error = e; }
  const bad = projected && projected.content.publication.predictedEndingBalanceTerms;
  ok(projected && bad && !Object.hasOwn(bad, 'manualCardPaymentBeyondMinimum'),
    'an older record without the term projects as before: the term is absent, never 0', error && error.code);
  if (bad) {
    ok(cents(bad.periodIncome - bad.assignedBills - bad.householdBudgetHold - (bad.savingsItemSpending || 0)
      - (bad.heldOutflowSpending || 0)) === cents(bad.balanceAfterDeductions) && bad.closes === true,
    'and its own terms still close without it');
  }
  const forged = JSON.parse(JSON.stringify(older));
  const terms = forged.content.publication.predictedEndingBalanceTerms;
  const close = forged.content.publication.plannedPeriodCloseTerms;
  ok(terms && close, 'the fixture publishes both term sets to forge');
  if (terms && close) {
    terms.manualCardPaymentBeyondMinimum = 35;
    terms.balanceAfterDeductions = Math.round((terms.balanceAfterDeductions - 35) * 100) / 100;
    close.manualCardPaymentBeyondMinimum = 35;
    close.identity += '-and-manual-card-payment-beyond-minimum';
    let kept = null, code = null;
    try { kept = Pg.project(reseal(forged)); } catch (e) { code = e.code; }
    const keptBad = kept && kept.content.publication.predictedEndingBalanceTerms;
    const keptClose = kept && kept.content.publication.plannedPeriodCloseTerms;
    ok(keptBad && keptBad.manualCardPaymentBeyondMinimum === 35 && keptClose && keptClose.manualCardPaymentBeyondMinimum === 35
      && /-and-manual-card-payment-beyond-minimum$/.test(keptClose.identity),
      'a new record keeps the term in both sets, and the close identity names it', String(code));
    if (keptBad) {
      ok(cents(keptBad.periodIncome - keptBad.assignedBills - keptBad.householdBudgetHold - (keptBad.savingsItemSpending || 0)
        - (keptBad.heldOutflowSpending || 0) - keptBad.manualCardPaymentBeyondMinimum) === cents(keptBad.balanceAfterDeductions),
      'the stored BAD terms close with the term');
    }
  }
}

if (failures) { console.log(`\n${failures} CHECK(S) FAILED`); process.exit(1); }
console.log('\nALL CHECKS PASSED');
