'use strict';
// Invented independently balanced ledger, not copied household cents.
// Failing-first: advancing live refreshes must not drop qualified issuer proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const F = require('../public/forecast');
const Live = require('../scripts/live-plan');
const source = require('./fixtures/card-backfill-data');
const canonical = fs.readFileSync(require.resolve('../data.json'), 'utf8');
let checks = 0;
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }

function fixture(moved, firstAsOf) {
  const x = source('triangle', 'triangle');
  x.asOf = firstAsOf;
  x.data.meta.asOf = '2026-10-02';
  x.data.plan.opening.asOf = '2026-10-02';
  x.data.plan.windowDays = 28;
  x.data.plan.income[0].anchor = '2026-10-02';
  x.data.plan.startingCash.breakdown[1].value = 100;
  const statement = moved ? [{
    scheduledDate: '2026-10-07', dueDate: '2026-10-08',
    minimum: 91.23, currency: 'cad', confidence: 'confirmed',
  }] : undefined;
  x.data.plan.obligations[0] = {
    id: 'triangle', debtId: 'triangle', effect: 'payment',
    label: 'Invented card minimum', frequency: 'monthly', day: 7,
    firstDue: '2026-10-07', amount: 91.23,
    confidence: moved ? 'estimated' : 'confirmed',
    payingAccount: 'chequing-a',
    ...(statement ? { statementOccurrences: statement } : {}),
    sentPayments: [{
      scheduledDate: '2026-10-07', confirmed: true, intent: 'minimum',
      debitId: 'invented-bank-debit', postedOn: '2026-10-05', amount: 91.23,
      currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
      cashIncludedAsOf: '2026-10-05',
    }],
  };
  x.data.plan.opening.representedEvents = [
    { id: 'triangle', date: '2026-10-07', effectiveAsOf: '2026-10-05' },
  ];
  x.payload.fetchedAt = firstAsOf + 'T18:00:00Z';
  x.payload.transactionWindow = {
    startDate: '2026-10-02', endDate: firstAsOf,
    complete: true, hasMore: false, truncated: false,
  };
  x.payload.transactions = [];
  x.payload.accounts.forEach(a => { a.updated_at = firstAsOf + 'T17:00:00Z'; a.balance_last_update = firstAsOf + 'T17:00:00Z'; });
  x.payload.accounts[0].balance = 400;
  x.payload.accounts[1].balance = 64.30;
  x.payload.accounts[3].balance = 400;
  return x;
}

function presentBill(row) {
  const src = fs.readFileSync(require.resolve('../public/plan.js'), 'utf8');
  const fn = /function budgetBillPresentation\(row\) \{[\s\S]*?\n\}/.exec(src)[0];
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.out = budgetBillPresentation;', ctx);
  return ctx.out(row);
}

function renderedBillHtml(row) {
  const state = presentBill(row);
  return {
    desktop: `<article class="bill-glance is-${state.kind}" data-bill-status="${state.label}">`
      + `<strong>${state.label}</strong></article>`,
    mobile: `<button type="button" class="budget-bill-row is-${state.kind}">`
      + `<span class="budget-bill-state">${state.label}</span></button>`,
    state,
  };
}

function inspect(data, asOf) {
  const advice = F.recommend(data.plan, asOf, {
    debts: data.debts,
    currentPeriodActuals: data.liveOverlay && data.liveOverlay.currentPeriodActuals,
  });
  const bills = [advice.defaultView.bills, ...(advice.payPeriodViews || []).map(v => v.bills || [])]
    .flat()
    .filter(row => row && row.id === 'triangle'
      && (row.scheduledDate === '2026-10-07' || row.date === '2026-10-07' || row.date === '2026-10-08'));
  const bill = bills[0];
  const proof = (data.plan.opening.representedEvents || []).filter(row => row.id === 'triangle');
  const state = F.cardMinimumState(data.plan, asOf);
  return { advice, bill, bills, proof, state };
}

function refresh(seed, data, asOf) {
  const next = structuredClone(seed);
  next.asOf = asOf;
  next.data = data;
  next.payload.fetchedAt = asOf + 'T18:00:00Z';
  next.payload.transactionWindow.endDate = asOf;
  next.payload.accounts.forEach(a => { a.updated_at = asOf + 'T17:00:00Z'; a.balance_last_update = asOf + 'T17:00:00Z'; });
  return Live.fromObservation(next);
}

function expectPaid(data, view, label) {
  eq([view.bill.status, view.bill.issuerMinimumStatus, view.bill.settlement],
    ['PAID', 'satisfied', 'represented'], label + ' Forecast status');
  eq(view.proof.map(row => [row.id,
    F.statementOccurrenceIdentity(data.plan, row.id, row.date), row.effectiveAsOf]),
    [['triangle', '2026-10-07', '2026-10-05']], label + ' original identity retained');
  eq(view.state.payments.filter(row => row.scheduledDate === '2026-10-07')
    .map(row => row.issuerMinimumStatus), ['satisfied'], label + ' issuer state');
  const rendered = renderedBillHtml(view.bill);
  eq(rendered.state.label, 'Paid', label + ' presentation');
  eq(/Not confirmed/.test(rendered.desktop + rendered.mobile), false,
    label + ' desktop/mobile do not render Not confirmed');
  eq(/Paid/.test(rendered.desktop) && /Paid/.test(rendered.mobile), true,
    label + ' desktop/mobile render Paid');
  eq(view.bills.every(row => row.status === 'PAID'), true,
    label + ' every published bill row stays Paid');
}

function walk(moved, firstAsOf, days) {
  const seed = fixture(moved, firstAsOf);
  const first = Live.fromObservation(seed);
  eq(first.data.liveOverlay.applied, true, (moved ? 'moved' : 'unmoved') + ' first overlay');
  let data = first.data;
  expectPaid(data, inspect(data, firstAsOf), (moved ? 'moved' : 'unmoved') + ' ' + firstAsOf);
  const sameDay = refresh(seed, data, firstAsOf);
  expectPaid(sameDay.data, inspect(sameDay.data, firstAsOf),
    (moved ? 'moved' : 'unmoved') + ' repeated same-day refresh');
  data = sameDay.data;
  for (const day of days) {
    const step = refresh(seed, data, day);
    expectPaid(step.data, inspect(step.data, day),
      (moved ? 'moved due-date' : 'unmoved following-day') + ' ' + day);
    data = step.data;
  }
  return data;
}

walk(true, '2026-10-05', ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
walk(false, '2026-10-07', ['2026-10-08']);

// Later-opening proof stays attached but cannot satisfy an earlier as-of.
const laterSeed = fixture(true, '2026-10-05');
laterSeed.data.plan.opening.representedEvents = [
  { id: 'triangle', date: '2026-10-07', effectiveAsOf: '2026-10-20' },
];
const laterFirst = Live.fromObservation(laterSeed);
const laterAdvanced = refresh(laterSeed, laterFirst.data, '2026-10-08');
eq(laterAdvanced.data.plan.opening.representedEvents
  .filter(row => row.id === 'triangle')
  .map(row => row.effectiveAsOf), ['2026-10-20'],
  'deferred later-opening proof is not stripped by an advancing refresh');
eq(inspect(laterAdvanced.data, '2026-10-08').bill.issuerMinimumStatus, 'unconfirmed',
  'later-opening proof still cannot satisfy the earlier live as-of');

// One issuer proof still satisfies exactly one original occurrence after advances.
const two = fixture(true, '2026-10-05');
two.data.plan.obligations[0].firstDue = '2026-09-07';
two.data.plan.obligations[0].sentPayments.push({
  ...two.data.plan.obligations[0].sentPayments[0],
  scheduledDate: '2026-09-07', debitId: 'invented-sep-debit',
  postedOn: '2026-09-05', cashIncludedAsOf: '2026-09-05',
});
const twoFirst = Live.fromObservation(two);
const twoAdvanced = refresh(two, twoFirst.data, '2026-10-08');
eq(F.cardMinimumState(twoAdvanced.data.plan, '2026-10-08').payments
  .map(row => [row.scheduledDate, row.issuerMinimumStatus])
  .sort((a, b) => a[0].localeCompare(b[0])), [
  ['2026-09-07', 'unconfirmed'],
  ['2026-10-07', 'satisfied'],
], 'one original proof does not satisfy another cycle after live advance');

eq(fs.readFileSync(require.resolve('../data.json'), 'utf8'), canonical, 'no canonical writes');
console.log(`PASS card minimum issuer lifecycle: ${checks} independent checks`);
