'use strict';
// H2-7: a bill paid in an earlier period, with a natively posted transaction
// the ledger ties to this occurrence, is already outside the active period's
// payday opening, so that period's close does not deduct it again. Invented
// values only.
//
// Hand-derived: payday 2026-10-23, 2000 payroll, internet 100 due 2026-10-28.
// Paid 2026-10-20: opening 1900 already net of it, close 1900 + 2000 = 3900.
// Unpaid: opening 2000, close 2000 + 2000 - 100 = 3900. Deducting twice gives 3800.
const F = require('../public/forecast.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
function world({ paid = true, postedOn = '2026-10-20', tx = {} } = {}) {
  const openSnap = paid ? 1900 : 2000;
  const plan = {
    opening: { asOf: '2026-10-23', paydaySnapshot: { periodStart: '2026-10-23', asOf: '2026-10-23', opening: openSnap } },
    startingCash: { asOf: '2026-10-23', breakdown: [
      { id: 'chequing-a', value: openSnap, confidence: 'confirmed', evidenceDate: '2026-10-23' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-23' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2000, confidence: 'confirmed' }],
    bills: [{ id: 'internet', label: 'Internet', frequency: 'monthly', day: 28, amount: 100, confidence: 'confirmed' }],
    obligations: [], commitments: [], budget: { categories: [] },
  };
  const opts = { weeklyVariable: 0, debts: [] };
  if (paid) {
    opts.currentPeriodActuals = {
      schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-23',
      coverageStart: '2026-10-09', coverageThrough: '2026-10-23',
      transactionCoverage: 'complete', pendingCoverage: 'complete',
      transactions: [Object.assign({ id: 'tx-net', date: postedOn, amount: 100, currency: 'CAD', atlasAccountId: 'chequing-a',
        accountRole: 'household-cash', pending: false, savingsPostingEvidence: 'posted' }, tx)],
      representedActuals: [{ id: 'internet', date: '2026-10-28', actual: 100, postedOn, transactionId: 'tx-net' }],
    };
    opts.representedEvents = [{ id: 'internet', date: '2026-10-28', postedOn, effectiveAsOf: postedOn }];
  }
  const a = F.recommend(plan, '2026-10-23', opts);
  const cur = a.payPeriodViews.find(v => v.start === '2026-10-23');
  const nxt = a.payPeriodViews.find(v => v.start === '2026-11-06');
  return { cur, nxt, row: cur.bills.find(b => b.id === 'internet') };
}

console.log('\n=== 1. paid before the payday opening: the active close deducts it once ===');
{
  const paid = world();
  const unpaid = world({ paid: false });
  ok(paid.row.status === 'PAID', 'row stays PAID', paid.row.status);
  ok(paid.cur.plannedPeriodClose === 3900, 'paid early: close 3900 (not 3800)', paid.cur.plannedPeriodClose);
  ok(paid.nxt.opening === 3900, 'next opening 3900', paid.nxt.opening);
  ok(unpaid.cur.plannedPeriodClose === 3900 && unpaid.nxt.opening === 3900, 'unpaid control: close and next opening 3900',
    { close: unpaid.cur.plannedPeriodClose, next: unpaid.nxt.opening });
}

console.log('\n=== 2. without native posted evidence before the opening, it is deducted as before ===');
{
  const pending = world({ tx: { pending: true, savingsPostingEvidence: 'pending' } }).cur;
  ok(pending.plannedPeriodCloseTerms && pending.plannedPeriodCloseTerms.periodBillLoad === 100, 'pending posting: still deducted',
    pending.plannedPeriodCloseTerms && pending.plannedPeriodCloseTerms.periodBillLoad);
  const unknown = world({ tx: { savingsPostingEvidence: undefined } }).cur;
  ok(unknown.plannedPeriodCloseTerms && unknown.plannedPeriodCloseTerms.periodBillLoad === 100, 'unknown posting evidence: still deducted',
    unknown.plannedPeriodCloseTerms && unknown.plannedPeriodCloseTerms.periodBillLoad);
  const sameDay = world({ postedOn: '2026-10-23' }).cur;
  ok(sameDay.plannedPeriodCloseTerms && sameDay.plannedPeriodCloseTerms.periodBillLoad === 100,
    'posted on the payday itself (snapshot is cash before that day): still deducted',
    sameDay.plannedPeriodCloseTerms && sameDay.plannedPeriodCloseTerms.periodBillLoad);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
