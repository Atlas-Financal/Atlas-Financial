'use strict';
// H2-3: a card statement's due date moved later (weekend or holiday shift)
// keeps its own statement. The close is the latest close day at least 7 days
// before the due date, so a payment inside that cycle still confirms the
// minimum. Invented values only.
//
// Card closes on the 28th; the 2026-03-27 due date belongs to the 2026-02-28
// statement. Shifted to 2026-03-30, it still does: 2026-03-28 is 2 days
// before, far inside any grace period.
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}
function run(dueDate, shifted, txDate = '2026-03-18', closeDay = 28) {
  const obs = Live.fromObservation({
    asOf: '2026-03-20',
    data: {
      meta: { asOf: '2026-03-01' },
      debts: [{ id: 'triangle', label: 'Invented Card', structure: 'Revolving', secured: false, balance: 400, pending: 0, rate: 0.2, limit: 2000, statementCloseDay: closeDay }],
      plan: {
        opening: { asOf: '2026-03-01' },
        startingCash: { asOf: '2026-03-01', breakdown: [
          { id: 'chequing-a', value: 1000, confidence: 'confirmed', evidenceDate: '2026-03-01' },
          { id: 'chequing-b', value: 0, confidence: 'confirmed', evidenceDate: '2026-03-01' },
          { id: 'savings', value: 0, confidence: 'confirmed', evidenceDate: '2026-03-01' },
        ] },
        income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-03-06', amount: 2000, confidence: 'confirmed' }],
        obligations: [{
          id: 'triangle', debtId: 'triangle', effect: 'payment', label: 'Card Min',
          frequency: 'monthly', day: 27, firstDue: '2026-03-27', amount: 100, confidence: 'confirmed', payingAccount: 'chequing-a',
          ...(shifted ? { statementOccurrences: [{ scheduledDate: '2026-03-27', dueDate, minimum: 100, currency: 'cad', confidence: 'confirmed' }] } : {}),
        }],
        bills: [], commitments: [], budget: { categories: [] },
      },
    },
    accountMap: {
      version: 1, provider: 'lunchmoney',
      mappings: [
        { providerAccountId: '3001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
        { providerAccountId: '3002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
        { providerAccountId: '3003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
        { providerAccountId: '3004', canonical: { collection: 'debts', id: 'triangle' }, atlasRole: 'revolving-credit' },
      ],
    },
    identity: {
      version: 1,
      rules: [{ eventId: 'triangle', payeePatterns: ['CAN TIRE MC'], atlasAccountId: 'chequing-a', direction: 'debit', requiredCurrency: 'cad', requiredPostingEvidence: 'posted', postingDateRule: 'covers-statement-cycle-or-latest-due', settlesWhen: 'amount-at-least' }],
    },
    payload: {
      provider: 'lunchmoney', fetchedAt: '2026-03-20T18:00:00Z',
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, startDate: null, endDate: null },
      transactionWindow: { startDate: '2026-02-15', endDate: '2026-03-20', complete: true, hasMore: false, truncated: false },
      categories: [{ id: 88, name: 'Minimum payment - Triangle Mastercard', is_income: false, is_group: false, archived: false, exclude_from_budget: true, exclude_from_totals: true }],
      accounts: [
        { id: 3001, name: 'Bills', type: 'cash', subtype: 'checking', currency: 'cad', balance: 900, updated_at: '2026-03-20T17:00:00Z', balance_last_update: '2026-03-20T17:00:00Z' },
        { id: 3002, name: 'Weekly', type: 'cash', subtype: 'checking', currency: 'cad', balance: 0, updated_at: '2026-03-20T17:00:00Z', balance_last_update: '2026-03-20T17:00:00Z' },
        { id: 3003, name: 'Savings', type: 'cash', subtype: 'savings', currency: 'cad', balance: 0, updated_at: '2026-03-20T17:00:00Z', balance_last_update: '2026-03-20T17:00:00Z' },
        { id: 3004, name: 'Card', type: 'credit', subtype: 'credit_card', currency: 'cad', balance: 300, credit_limit: 2000, updated_at: '2026-03-20T17:00:00Z', balance_last_update: '2026-03-20T17:00:00Z' },
      ],
      transactions: [{ id: 95001, account_id: 3001, date: txDate, amount: 100, currency: 'cad', payee: 'Can Tire Mc', original_name: 'CAN TIRE MC 1234', category_id: 88, category_name: 'Minimum payment - Triangle Mastercard', is_pending: false, status: 'reviewed' }],
    },
  });
  const a = F.recommend(obs.data.plan, '2026-03-20', { debts: obs.data.debts, currentPeriodActuals: obs.data.liveOverlay.currentPeriodActuals, weeklyVariable: 0 });
  const row = a.payPeriodViews.find(v => v.start === '2026-03-20').bills.find(b => b.id === 'triangle');
  return { matchedPayments: obs.report.cardMinimumCategoryEvidence.payments.length, row: { date: row.date, status: row.status, remaining: row.remaining, issuerMinimumStatus: row.issuerMinimumStatus } };
}

console.log('\n=== 1. a shifted due date keeps its own statement cycle ===');
{
  const control = run('2026-03-27', false);
  ok(control.matchedPayments === 1 && control.row.status === 'PAID', 'control (due 03-27): the 03-18 payment confirms the minimum', control);
  const shifted = run('2026-03-30', true);
  ok(shifted.matchedPayments === 1, 'shifted (due 03-30): the 03-18 payment is matched', shifted.matchedPayments);
  ok(shifted.row.status === 'PAID' && shifted.row.remaining === 0 && shifted.row.issuerMinimumStatus === 'satisfied',
    'shifted: PAID, nothing remaining, issuer minimum satisfied', shifted.row);
}

console.log('\n=== 2. a payment before the real statement close still does not count ===');
{
  const early = run('2026-03-30', true, '2026-02-26');
  ok(early.matchedPayments === 0 && early.row.status !== 'PAID', 'a 02-26 payment (before the 02-28 close) is not matched', early);
}

console.log('\n=== 3. the known close day always wins; the 7-day gap only picks the month ===');
{
  // Close day 1, due 2026-03-28 (a 27-day gap): this month's 2026-03-01 close
  // stands, so a 2026-02-20 payment belongs to the earlier cycle and does not
  // confirm this minimum. Falling back a month (2026-02-01) would wrongly
  // accept it.
  const kept = run('2026-03-28', true, '2026-02-20', 1);
  ok(kept.matchedPayments === 0 && kept.row.status !== 'PAID', 'close day 1, due 03-28: the 03-01 close stands; a 02-20 payment does not count', kept);
  const inCycle = run('2026-03-28', true, '2026-03-18', 1);
  ok(inCycle.matchedPayments === 1 && inCycle.row.status === 'PAID', 'close day 1, due 03-28: a 03-18 payment confirms it', inCycle);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
