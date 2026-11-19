'use strict';
// A card minimum whose household-categorized payment is still pending reads
// "Payment pending" and stays fully owed (BACKLOG, card minimum Payment
// pending / Partly paid; lead ruling C, 2026-11-19). Label plus reserve:
// nothing is sent, satisfied or allocated; no figure moves from the world
// with no payment at all. Invented ledger (test/fixtures/card-backfill-data):
// $1,000 cash, $800 card debt, a $43.19 confirmed statement minimum due
// 2035-10-08, a $49.37 payment on 2035-10-05.
//
// `node test/test-card-minimum-payment-pending.js`
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const Live = require('../scripts/live-plan');
const Category = require('../scripts/card-minimum-category');
const source = require('./fixtures/card-backfill-data');
const NOW = '2035-10-06', ORIGINAL = '2035-10-07', DUE = '2035-10-08';

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };

function fixture(tx) {
  const card = 'triangle', id = card;
  const x = source(card, id), name = Object.keys(Category.CATEGORIES).find(k => Category.CATEGORIES[k] === card);
  x.data.meta.asOf = x.data.plan.opening.asOf = '2035-10-01';
  x.data.plan.opening.representedEvents = [];
  x.data.plan.income[0].anchor = '2035-10-01'; x.data.plan.income[0].amount = 0;
  x.data.plan.budget = { categories: [] };
  x.data.plan.obligations = [{ id, debtId: card, effect: 'payment', frequency: 'monthly', day: 7,
    firstDue: ORIGINAL, payingAccount: 'chequing-a', amount: 41.13, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: ORIGINAL, dueDate: DUE, minimum: 43.19,
      currency: 'cad', confidence: 'confirmed' }] }];
  x.data.plan.startingCash.breakdown[0].value = 1000;
  x.data.debts[0].balance = 800;
  x.payload.accounts[0].balance = 1000; x.payload.accounts[3].balance = 800;
  x.payload.accounts.forEach(a => { a.updated_at = NOW + 'T17:00:00Z'; a.balance_last_update = NOW + 'T17:00:00Z'; });
  x.payload.fetchedAt = NOW + 'T18:00:00Z';
  x.payload.transactionWindow = { startDate: '2035-10-01', endDate: NOW, complete: true, hasMore: false, truncated: false };
  x.payload.categories = [{ id: 9001, name, is_income: false, is_group: false,
    exclude_from_totals: true, exclude_from_budget: true }];
  x.payload.transactions = tx.map(t => ({ account_id: 3001, date: '2035-10-05', amount: 49.37,
    currency: 'cad', payee: 'CAN TIRE MC', category_id: 9001, status: 'reviewed', ...t }));
  x.asOf = NOW;
  return x;
}
function run(tx) {
  const x = fixture(tx), live = Live.fromObservation(x);
  const advice = F.recommend(live.data.plan, NOW, { debts: live.data.debts,
    currentPeriodActuals: live.report.currentPeriodActuals });
  const row = advice.defaultView.bills.find(b => b.id === x.eventId && b.date === DUE);
  return { x, live, advice, row, evidence: live.data.plan.cardMinimumCategoryEvidence };
}

// Control: no payment at all. The $43.19 minimum is still due.
const none = run([]);
ok(none.row && none.row.status !== 'PAID' && none.row.status !== 'pending' && none.row.remaining === 43.19,
  'control: with no payment the $43.19 minimum is still due');
ok(!Object.hasOwn(none.evidence, 'pendingPayments'), 'control: a packet with nothing pending keeps its shape (no pendingPayments)');

// P1 a pending categorized payment: Payment pending, fully owed.
const pending = run([{ id: 98001, is_pending: true }]);
eq(pending.evidence.pendingPayments, [{ id: 'triangle', scheduledDate: ORIGINAL, pendingOn: '2035-10-05' }],
  'P1 the observer lists the pending minimum by card row and occurrence only');
ok(!JSON.stringify(pending.evidence.pendingPayments).includes('49.37') && pending.evidence.payments.length === 0,
  'P1 no amount and no payment record: label only');
eq([pending.row.status, pending.row.paymentPending, pending.row.remaining], ['pending', true, 43.19],
  'P1 the row reads pending, with the full $43.19 still owed');
ok(pending.row.status !== 'PAID' && pending.row.settlement !== 'represented' && pending.row.cashPaymentStatus === undefined,
  'P1 never Paid, never sent');
eq(F.cardMinimumState(pending.live.data.plan, NOW).status, 'incumbent', 'P1 no card-minimum issue is raised');
for (const key of ['balanceAfterDeductions', 'periodBillLoad', 'remainingBills', 'afterBills']) {
  eq(pending.advice.defaultView[key], none.advice.defaultView[key], `P1 ${key} equals the no-payment world (the minimum stays reserved)`);
}
eq(pending.advice.weekly, none.advice.weekly, 'P1 the weekly cap equals the no-payment world');
eq(F.simulate(pending.live.data.plan, NOW, { horizonDays: 5, weeklyVariable: 0 }).ending,
  F.simulate(none.live.data.plan, NOW, { horizonDays: 5, weeklyVariable: 0 }).ending, 'P1 the cash walk equals the no-payment world');

// P2 the same payment posted: Paid as before (control).
const posted = run([{ id: 98001, is_pending: false }]);
ok(!Object.hasOwn(posted.evidence, 'pendingPayments') && posted.evidence.payments.length === 1,
  'P2 a posted payment is a payment record, never pending');
eq([posted.row.status, posted.row.householdPaymentStatus], ['PAID', 'paid'], 'P2 the posted payment reads Paid, as on main');

// P3 a pending and a posted payment for the same occurrence: posted wins.
const both = run([{ id: 98001, is_pending: false }, { id: 98002, is_pending: true }]);
ok(!Object.hasOwn(both.evidence, 'pendingPayments') && both.row.status === 'PAID',
  'P3 posted wins: no pending entry, the row reads Paid');

// P4 a pending debit with no minimum category (a note only) is not listed.
const noted = run([{ id: 98001, is_pending: true, category_id: null, notes: 'Triangle minimum' }]);
ok(!Object.hasOwn(noted.evidence, 'pendingPayments') && noted.row.status !== 'pending',
  'P4 a pending debit without the minimum category is not Payment pending');

// P5 two pending debits for one occurrence are ambiguous: neither is listed.
const twice = run([{ id: 98001, is_pending: true }, { id: 98002, is_pending: true }]);
ok(!Object.hasOwn(twice.evidence, 'pendingPayments') && twice.row.status !== 'pending',
  'P5 two pending debits for one occurrence: not listed');

console.log(`All ${checks} card-minimum Payment pending checks passed`);
