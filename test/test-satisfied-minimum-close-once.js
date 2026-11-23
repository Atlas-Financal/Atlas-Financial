'use strict';
// H2-5 (desk ruling, Plan #6, narrowed to the cash close): a future card
// minimum that Forecast's settlement decision proves the issuer satisfied for
// this exact statement occurrence, with the sent debit already inside the
// cash base, is not deducted again from that period's cash close. The row
// stays Planned with money sent shown separately; remaining and the planned
// bill load keep the full contractual minimum. Invented values only.
//
// Hand-derived expectation: cash 1000 at 2026-10-14 already includes the
// 120 debit (posted 2026-10-12). Two biweekly paydays of 2000 reach the
// 2026-10-23 period close: 1000 + 2000 + 2000 = 5000. Deducting the 120
// again would give 4880.
const F = require('../public/forecast.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
function world({ sent = {}, noSent = false, noIssuer = false } = {}) {
  const plan = {
    opening: { asOf: '2026-10-14', paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 1000 },
      representedEvents: noIssuer ? [] : [{ id: 'card-min', date: '2026-10-25', effectiveAsOf: '2026-10-12' }] },
    startingCash: { asOf: '2026-10-14', breakdown: [
      { id: 'chequing-a', value: 1000, confidence: 'confirmed', evidenceDate: '2026-10-14' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-14' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2000, confidence: 'confirmed' }],
    obligations: [Object.assign({
      id: 'card-min', label: 'Card Min', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 25, amount: 120,
      confidence: 'confirmed', payingAccount: 'chequing-a',
    }, noSent ? {} : { sentPayments: [Object.assign({ scheduledDate: '2026-10-25', postedOn: '2026-10-12', amount: 120, currency: 'cad',
      confirmed: true, pending: false, intent: 'minimum', fundingAccountId: 'chequing-a', debitId: 'a'.repeat(64),
      cashIncludedAsOf: '2026-10-12' }, sent)] })],
    bills: [], commitments: [], budget: { categories: [] },
  };
  const a = F.recommend(plan, '2026-10-14', {
    weeklyVariable: 0,
    debts: [{ id: 'triangle', label: 'Card', structure: 'Revolving', secured: false, balance: 1500, pending: 0, rate: 0.2, limit: 5000 }],
  });
  const next = a.payPeriodViews.find(v => v.start === '2026-10-23');
  return { next, row: next.bills.find(b => b.id === 'card-min' && b.date === '2026-10-25') };
}

console.log('\n=== 1. same cycle, issuer satisfied, cash included: the close deducts it once ===');
{
  const { next, row } = world();
  ok(row.status === 'planned' && row.cashPaymentStatus === 'sent', 'row stays Planned with money sent separate');
  ok(row.planned === 120 && row.amount === 120, 'contractual minimum and gross amount intact', { planned: row.planned, amount: row.amount });
  ok(next.plannedPeriodClose === 5000, 'close 5000 (not 4880)', next.plannedPeriodClose);
  ok(next.paydaySweep === 5000, 'sweep follows the close', next.paydaySweep);
  ok(next.remainingBills === 120 && next.periodBillLoad === 120, 'remaining and planned load keep the full minimum',
    { remainingBills: next.remainingBills, periodBillLoad: next.periodBillLoad });
}

console.log('\n=== 2. controls get no relief (unproven evidence keeps the incumbent withheld close) ===');
{
  const base = world().next.plannedPeriodClose;
  const noProof = world({ noSent: true }).next.plannedPeriodClose;
  ok(noProof === 4880, 'no sent payment: close 4880', noProof);
  const sentOnly = world({ noIssuer: true }).next.plannedPeriodClose;
  ok(sentOnly === null, 'sent alone (issuer unproven): close stays withheld as on main, never 5000', sentOnly);
  const wrongCycle = world({ sent: { scheduledDate: '2026-11-25' } }).next.plannedPeriodClose;
  ok(wrongCycle === null, 'sent for a different cycle: close stays withheld as on main, never 5000', wrongCycle);
  const notIncluded = world({ sent: { cashIncludedAsOf: null } }).next.plannedPeriodClose;
  ok(notIncluded === null, 'cash inclusion unproven: close stays withheld as on main, never 5000', notIncluded);
  ok(base - noProof === 120, 'relief is exactly one minimum', base - noProof);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
