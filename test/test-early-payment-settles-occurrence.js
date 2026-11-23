'use strict';
/* An early payment that settles its occurrence in full keeps the occurrence
 * PAID in its planned (future) pay period, owing nothing there.
 *
 * Owner rule (Dale, #821 6961042821): an occurrence paid early counts in the
 * pay period it is planned in. Settled-in-full evidence is any of:
 *   1. an observed actual at or above plan (incumbent);
 *   2. a verified posted payment ("bill verified", Dale 2026-11-20), at the
 *      verified amount even below plan (billAssignedAmount);
 *   3. a sent card minimum whose own state is cashPaymentStatus 'sent' and
 *      issuerMinimumStatus 'satisfied' (the row carries actual null by design).
 * An unverified underpayment and a partial stay demoted (#1301).
 *
 * Invented values only (Gemini hunt 2, H2-4 / H2-5, #821 7091239076),
 * read through Forecast.recommend payPeriodViews.
 *
 * `node test/test-early-payment-settles-occurrence.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const show = x => JSON.stringify(x);

function verifiedBillWorld(note, actual) {
  const plan = {
    opening: { asOf: '2026-10-09', paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 1000 } },
    startingCash: { asOf: '2026-10-09', breakdown: [
      { id: 'chequing-a', value: 1000, confidence: 'confirmed', evidenceDate: '2026-10-09' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-09' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2000, confidence: 'confirmed' }],
    bills: [{ id: 'internet', label: 'Internet', frequency: 'monthly', day: 28, amount: 100, confidence: 'confirmed' }],
    obligations: [], commitments: [], budget: { categories: [] },
  };
  const pkt = {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: '2026-10-21',
    coverageStart: '2026-10-09', coverageThrough: '2026-10-21',
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: [{ id: 'tx-net', date: '2026-10-20', amount: actual, currency: 'CAD', accountId: 'chequing-a',
      accountRole: 'household-cash', pending: false, ...(note ? { notes: note } : {}) }],
    representedActuals: [{ id: 'internet', date: '2026-10-28', actual, postedOn: '2026-10-20', transactionId: 'tx-net' }],
  };
  const a = F.recommend(plan, '2026-10-21', {
    weeklyVariable: 0, debts: [], currentPeriodActuals: pkt,
    representedEvents: [{ id: 'internet', date: '2026-10-28', postedOn: '2026-10-20', effectiveAsOf: '2026-10-20' }],
  });
  const next = a.payPeriodViews.find(v => v.start === '2026-10-23');
  return { next, row: next.bills.find(b => b.id === 'internet') };
}

console.log('=== 1. H2-4: a verified early payment below plan settles its occurrence ===');
{
  // Planned 100, paid 80 on Oct 20 with "bill verified", due Oct 28 (next period).
  // Next period: PAID at 80, owes 0; Stack bills other 80, paid 80; surplus 2000 - 80 = 1920.
  const { next, row } = verifiedBillWorld('bill verified', 80);
  ok(row.status === 'PAID' && row.remaining === 0 && row.stackBillPaid === true,
    'next period: PAID, nothing remaining', show({ status: row.status, remaining: row.remaining, stackBillPaid: row.stackBillPaid }));
  ok(next.stackSummary.bills.other === 80 && next.stackSummary.bills.paid === 80,
    'Stack bills: other 80, paid 80', show(next.stackSummary.bills));
  ok(next.stackSummary.surplus.amount === 1920, 'Stack surplus 1920', show(next.stackSummary.surplus.amount));
}

console.log('\n=== 2. control: an UNVERIFIED early payment below plan stays demoted (#1301) ===');
{
  const { row } = verifiedBillWorld(null, 80);
  ok(row.status === 'planned' && row.remaining === 100 && row.stackBillPaid === false,
    'unverified 80 of 100: next period still owes 100', show({ status: row.status, remaining: row.remaining }));
}

console.log('\n=== 3. control: a covering early payment (incumbent) stays PAID ===');
{
  const { row } = verifiedBillWorld(null, 100);
  ok(row.status === 'PAID' && row.remaining === 0, 'paid 100 of 100 early: PAID, nothing remaining',
    show({ status: row.status, remaining: row.remaining }));
}

function sentMinimumWorld(sent) {
  const plan = {
    opening: { asOf: '2026-10-14', paydaySnapshot: { periodStart: '2026-10-09', asOf: '2026-10-09', opening: 1000 },
      representedEvents: [{ id: 'card-min', date: '2026-10-25', effectiveAsOf: '2026-10-12' }] },
    startingCash: { asOf: '2026-10-14', breakdown: [
      { id: 'chequing-a', value: 1000, confidence: 'confirmed', evidenceDate: '2026-10-14' },
      { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-10-14' },
    ] },
    income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-10-09', amount: 2000, confidence: 'confirmed' }],
    obligations: [Object.assign({
      id: 'card-min', label: 'Card Min', debtId: 'triangle', effect: 'payment', frequency: 'monthly', day: 25, amount: 120,
      confidence: 'confirmed', payingAccount: 'chequing-a',
    }, sent ? { sentPayments: [Object.assign({ scheduledDate: '2026-10-25', postedOn: '2026-10-12', amount: 120, currency: 'cad',
      confirmed: true, pending: false, intent: 'minimum', fundingAccountId: 'chequing-a', debitId: 'a'.repeat(64),
      cashIncludedAsOf: '2026-10-12' }, sent)] } : {})],
    bills: [], commitments: [], budget: { categories: [] },
  };
  const a = F.recommend(plan, '2026-10-14', {
    weeklyVariable: 0,
    debts: [{ id: 'triangle', label: 'Card', structure: 'Revolving', secured: false, balance: 1500, pending: 0, rate: 0.2, limit: 5000 }],
  });
  const next = a.payPeriodViews.find(v => v.start === '2026-10-23');
  return { next, row: next.bills.find(b => b.id === 'card-min') };
}

console.log('\n=== 4. H2-5: a sent, satisfied card minimum paid early settles its occurrence ===');
{
  // 120 minimum due Oct 25 (next period) sent Oct 12, cash included Oct 12. Next period opens at 3000,
  // gets 2000 payroll; the 120 already left cash, so the planned close is 3000 + 2000 = 5000.
  const { next, row } = sentMinimumWorld({});
  ok(row.status === 'PAID' && row.remaining === 0 && row.stackBillPaid === true,
    'next period: PAID, nothing remaining', show({ status: row.status, remaining: row.remaining, stackBillPaid: row.stackBillPaid, paidState: row.paidState }));
  ok(row.paidState === 'paid' && row.status === 'PAID', 'the row does not contradict itself (status agrees with paidState)');
  ok(next.remainingBills === 0 && next.plannedPeriodCloseTerms.periodBillLoad === 0 && next.plannedPeriodClose === 5000,
    'next period: remaining bills 0, close bill load 0, planned close 5000',
    show({ remaining: next.remainingBills, load: next.plannedPeriodCloseTerms.periodBillLoad, close: next.plannedPeriodClose }));
}

console.log('\n=== 5. control: an unsent minimum stays owed in its planned period ===');
{
  const { next, row } = sentMinimumWorld(null);
  ok(row.status !== 'PAID' && row.remaining === 120, 'no sent payment: still owes 120', show({ status: row.status, remaining: row.remaining }));
  ok(next.remainingBills === 120, 'remaining bills 120', show(next.remainingBills));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
