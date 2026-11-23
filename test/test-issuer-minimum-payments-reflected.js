'use strict';
/* An issuer minimum still owing is not credited again by payments it already reflects.
 *
 * Owner 2026-11-23 (Dale): the issuer's own minimum still owing, read after two
 * payments had posted, is recorded as a statement occurrence carrying
 * `paymentsReflectedThrough` (the read date). Grok Bot's condition (Plan #6):
 * "Neither November payment gets counted against the Nov 30 row's window."
 * A payment dated on or before that day was already taken off by the issuer,
 * so neither the categorized ledger matcher (scripts/card-minimum-category.js)
 * nor card coverage (Forecast.reconcileCardPurchases minimumCoverage) may
 * credit it to that occurrence. A later payment still counts.
 *
 * Invented ledgers only; every expected figure is written by hand and no
 * household figure is read or printed.
 *
 * `node test/test-issuer-minimum-payments-reflected.js`
 */
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Category = require('../scripts/card-minimum-category');
const source = require('./fixtures/card-backfill-data');
const { world, run } = require('./fixtures/card-coverage-aggregate-world');

let checks = 0, failures = 0;
const ok = (cond, label) => { checks++; if (cond) console.log('  PASS  ' + label); else { failures++; console.log('  FAIL  ' + label); } };
const safe = fn => { try { return fn(); } catch (e) { return e; } };

// 1. Categorized matcher. Invented: $1,000 cash and $800 debt, one 49.37 categorized
// payment against a confirmed 43.19 minimum (as in test-card-minimum-category.js).
const NOW = '2035-10-06', ORIGINAL = '2035-10-07', DUE = '2035-10-08';
function categorized(reflectedThrough, txDate) {
  const card = 'mbna', id = 'mbna-auto30';
  const x = source(card, id), name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === card);
  x.data.meta.asOf = x.data.plan.opening.asOf = '2035-10-01';
  x.data.plan.opening.representedEvents = [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id, debtId: card, effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: ORIGINAL, payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 43.19, currency: 'cad', confidence: 'confirmed',
      ...(reflectedThrough ? { paymentsReflectedThrough: reflectedThrough } : {}) }] }];
  x.data.plan.startingCash.breakdown[0].value = 1000;
  x.data.debts[0].balance = 800;
  x.payload.accounts[0].balance = 950.63; x.payload.accounts[3].balance = 750.63;
  x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
  x.payload.fetchedAt = NOW + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2035-10-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
  x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false, exclude_from_totals: true, exclude_from_budget: true }];
  x.payload.transactions = [{ id: 98001, account_id: 3001, date: txDate, amount: 49.37, currency: 'cad',
    payee: 'MBNA M/C', category_id: 9001, is_pending: false, status: 'reviewed' }];
  x.asOf = NOW;
  return x;
}
function outcome(x) {
  const linked = O.observe({ ...x, provider: 'lunchmoney' }).cardMinimumCategoryEvidence.payments.length;
  const live = Live.fromObservation(x);
  const advice = F.recommend(live.data.plan, NOW, { debts: live.data.debts, currentPeriodActuals: live.report.currentPeriodActuals });
  const bill = advice.defaultView.bills.find(b => b.id === 'mbna-auto30' && b.date === DUE);
  return { linked, bill, state: F.cardMinimumState(live.data.plan, NOW) };
}
console.log('Categorized ledger matcher');
{
  const base = outcome(categorized(null, '2035-10-05'));
  ok(base.linked === 1 && base.bill && base.bill.householdPaymentStatus === 'paid',
    'control: with no read date, the 10-05 payment links and the minimum reads paid');
  const on = outcome(categorized('2035-10-05', '2035-10-05'));
  ok(on.linked === 0, 'a payment dated on the read date is not credited to the occurrence');
  ok(on.bill && on.bill.householdPaymentStatus !== 'paid' && on.bill.status !== 'PAID'
    && Math.round(on.bill.remaining * 100) === 4319, 'the occurrence stays still due at its 43.19 minimum');
  ok(on.state.status !== 'unavailable', 'the card minimum state stays available');
  const before = outcome(categorized('2035-10-06', '2035-10-05'));
  ok(before.linked === 0 && Math.round(before.bill.remaining * 100) === 4319,
    'a payment dated before the read date is not credited either');
  const after = outcome(categorized('2035-10-04', '2035-10-05'));
  ok(after.linked === 1 && after.bill.householdPaymentStatus === 'paid',
    'a payment dated after the read date still links and pays the minimum');
}

// 2. Card coverage. Invented world (card-coverage-aggregate-world): Bills 500, card 400,
// a 25 card minimum due 2026-09-20, one 80 purchase, the 25 paid by a card payment.
console.log('Card coverage (minimumCoverage)');
const withStatement = reflectedThrough => x => {
  const row = x.data.plan.obligations[0];
  row.statementOccurrences = [{ scheduledDate: '2026-09-20', dueDate: '2026-09-20', minimum: 25, currency: 'cad',
    confidence: 'confirmed', ...(reflectedThrough ? { paymentsReflectedThrough: reflectedThrough } : {}) }];
};
const coverage = (reflectedThrough, payDate) => {
  const rows = [['card', 80, null, 'purchase'], ['bills', 25, payDate, 'cash'], ['card', -25, payDate, 'credit']];
  return run(world(rows, { edit: withStatement(reflectedThrough) })).coverage.minimumCoverage
    .filter(m => m.obligationId === 'travel');
};
{
  const base = coverage(null, '2026-09-19');
  ok(base.length === 1 && base[0].status === 'covered-by-payment' && Math.round(base[0].covered * 100) === 2500,
    'control: with no read date, the 09-19 payment covers the 25 minimum');
  const on = coverage('2026-09-19', '2026-09-19');
  ok(on.length === 1 && on[0].status === 'to-confirm' && Math.round(on[0].covered * 100) === 0,
    'a payment dated on the read date covers none of the minimum');
  const after = coverage('2026-09-18', '2026-09-19');
  ok(after.length === 1 && after[0].status === 'covered-by-payment',
    'a payment dated after the read date still covers it');
}

// 3. The field fails closed: a malformed or post-due read date is not a statement.
console.log('Input contract');
{
  const plan = { obligations: [{ id: 'c', debtId: 'card', effect: 'payment', frequency: 'monthly', day: 7, firstDue: ORIGINAL,
    payingAccount: 'chequing-a', amount: 10, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 10, currency: 'cad', confidence: 'confirmed' }] }] };
  const set = v => { plan.obligations[0].statementOccurrences[0].paymentsReflectedThrough = v; };
  set('2035-10-08');
  ok(F.statementPaymentsReflectedThrough(plan, 'c', ORIGINAL) === '2035-10-08', 'a read date on the due date is kept');
  for (const bad of ['2035-10-09', '2035-13-01', 'soon', 20351001]) {
    set(bad);
    ok(safe(() => F.statementPaymentsReflectedThrough(plan, 'c', ORIGINAL)) instanceof Error,
      `a read date of ${JSON.stringify(bad)} is refused`);
  }
  delete plan.obligations[0].statementOccurrences[0].paymentsReflectedThrough;
  ok(F.statementPaymentsReflectedThrough(plan, 'c', ORIGINAL) === null, 'no read date: null');
  ok(F.statementPaymentsReflectedThrough(plan, 'c', '2035-11-07') === null, 'another occurrence: null');
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
