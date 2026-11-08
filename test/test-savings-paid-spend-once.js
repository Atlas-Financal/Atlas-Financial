'use strict';
// Savings audit PR 1: an unlinked purchase paid from the Savings account is
// counted exactly once.
//
// No Bills cash moves when the household pays from Savings: the observed
// Savings balance already holds the debit. So the purchase stays visible on
// the Budget as spending, marked "paid from Savings", and it never enters
// the household reserve, Balance After Deductions, the Bills close or the
// current-period sweep into Savings. Before this fix all four deducted it,
// on top of the lower observed Savings balance: a double count.
//
// Every amount is invented. Expected figures are derived by hand in the
// comments; none is computed by calling the code under test.
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'public/forecast'));
const deficitModel = require('./fixtures/savings-deficit-coverage-data');

// Ledger (as of 2026-10-07, current period Oct 2 - Oct 15):
//   Bills payday opening 20; a 100 receipt lands on Oct 6, so Bills holds 120.
//   No budget categories and no bills inside the period, so the reserve is 0.
//   Savings is observed at 500 (control) or 450 after a 50 Savings purchase.
//   The next period (Oct 16 - Oct 29) receives the current period's surplus
//   (Balance After Deductions = 100 - 0 - 0 = 100) on the Oct 16 payday.
function ledger(savingsPurchase) {
  const x = deficitModel(400);
  const t = x.opts.currentPeriodActuals.transactions;
  x.plan.startingCash.breakdown[0].value += 100;
  t.push({ id: 'rcpt-1', date: '2026-10-06', amount: -100, pending: false, currency: 'CAD', savingsPostingEvidence: 'posted',
    isIncome: true, atlasAccountId: 'chequing-a', accountRole: 'household-cash', displayedPayee: 'Invented receipt' });
  if (savingsPurchase) {
    x.plan.savingsPoolObservation.accounts[0].value = x.plan.startingCash.breakdown[2].value = 450;
    t.push({ id: 'sav-1', date: '2026-10-06', amount: 50, pending: false, currency: 'CAD', savingsPostingEvidence: 'posted',
      atlasAccountId: 'savings', accountRole: 'household-reserve', categoryLabel: 'Gifts', displayedPayee: 'Invented giftshop' });
  }
  return x;
}
function read(x) {
  const a = F.recommend(x.plan, x.asOf, { ...x.opts, weeklyVariable: 0, debts: [] });
  const v = a.payPeriodViews.find(p => p.start <= x.asOf && p.end >= x.asOf);
  const sv = a.savingsFunding.periodViews.find(p => p.start === '2026-10-16');
  const closing = F.savingsFundingPublication(a.savingsFunding, { asOf: a.savingsFunding.asOf, advice: a, periodId: sv.id }).forecastClosing;
  assert.equal(closing.status, 'ready', closing.reason);
  return { close: v.plannedPeriodClose, bad: v.balanceAfterDeductions, hold: v.budgetHold,
    paid: v.savingsPaidSpending || null, savingsClose: closing.stock };
}

{
  const control = read(ledger(false));
  const paid = read(ledger(true));
  // Control, by hand: close 20 + 100 = 120; BAD 100; Savings 500 + 100 = 600.
  assert.deepEqual([control.close, control.bad, control.hold, control.savingsClose, control.paid], [120, 100, 0, 600, null]);
  // Savings purchase, by hand: no Bills cash moved, so the close (120), BAD
  // (100) and reserve (0) equal the control. Savings is reduced once, by the
  // observed balance: 450 + 100 = 550 (the bug showed close 70, BAD 50 and
  // Savings 450 + 50 = 500).
  assert.equal(paid.close, 120, 'the Bills close is not reduced by a Savings-paid purchase');
  assert.equal(paid.bad, 100, 'Balance After Deductions is not reduced');
  assert.equal(paid.hold, 0, 'the household reserve does not hold it');
  assert.equal(paid.savingsClose, 550, 'Savings is reduced once, by the observed balance only');
  // Visible once on the Budget, marked paid from Savings.
  assert.equal(paid.paid && paid.paid.total, 50, 'the Budget shows the 50 as paid from Savings');
  assert.deepEqual(paid.paid.recon.map(r => [r.date, r.amount, r.displayedPayee]), [['2026-10-06', 50, 'Invented giftshop']]);
  // Exactly once across Budget, Bills and Savings: total movement versus
  // the control is the single 50, and it sits only in Savings.
  const bills = paid.close - control.close, savings = paid.savingsClose - control.savingsClose;
  assert.equal(bills + savings, -50, 'the 50 leaves household money exactly once');
  assert.equal(savings, -50, 'and it leaves Savings, the account that paid it');
}

// Classification boundaries: only would-be household spending on the
// Savings account changes kind. Movements, refunds and chequing spend keep
// their own classification.
{
  const plan = { budget: { categories: [{ id: 'groceries', label: 'Groceries', plannedPayday: 300 }] } };
  const base = { date: '2026-10-06', currency: 'CAD', pending: false };
  const cls = tx => F.classifyCurrentPeriodTransaction({ ...base, ...tx }, plan, {});
  const reserve = cls({ id: 's1', amount: 40, accountRole: 'household-reserve', atlasAccountId: 'savings', categoryLabel: 'Gifts' });
  assert.equal(reserve.kind, 'savings-paid');
  assert.equal(reserve.householdSpending, false, 'never in the household reserve');
  const pending = cls({ id: 's2', amount: 40, pending: true, accountRole: 'household-reserve', atlasAccountId: 'savings', categoryLabel: 'Gifts' });
  assert.equal(pending.kind, 'savings-paid', 'a pending Savings debit is paid from Savings too');
  const chequing = cls({ id: 'c1', amount: 40, accountRole: 'household-cash', atlasAccountId: 'chequing-a', categoryLabel: 'Gifts' });
  assert.equal(chequing.householdSpending, true, 'the same purchase from chequing is still household spending');
  assert.notEqual(chequing.kind, 'savings-paid');
  const transfer = cls({ id: 's3', amount: 40, kindHint: 'transfer', excludeFromTotals: true, accountRole: 'household-reserve', atlasAccountId: 'savings' });
  assert.equal(transfer.kind, 'transfer', 'a Savings transfer out stays a transfer');
  const refund = cls({ id: 's4', amount: -40, accountRole: 'household-reserve', atlasAccountId: 'savings', categoryLabel: 'Gifts' });
  assert.equal(refund.kind, 'refund', 'a credit to Savings stays a refund, never spending');
  const payment = cls({ id: 's5', amount: 40, accountRole: 'household-reserve', atlasAccountId: 'savings', categoryLabel: 'Credit Card Payment' });
  assert.ok(payment.kind !== 'savings-paid' && payment.householdSpending === false,
    'a card payment from Savings stays a movement, never spending');
}

// Atlas findings on 89fbdff: the Paid from Savings publication never promotes
// incomplete or pending evidence to a settled total, and a Savings debit keeps
// the core classifier's cancelled-service warning.
{
  const H = require('./acceptance/harness.js');
  const AS_OF = '2026-10-14';
  const view = o => {
    const w = H.baseWorld(); w.savingsPool = {};
    w.accounts.find(a => a.id === 'savings').value = 950;
    w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' }),
      H.lm({ date: '2026-10-12', amount: 50, category: 'Gifts', account: 'savings', payee: o.payee || 'Invented giftshop', pending: !!o.pending })];
    if (o.truncated) w.coverage = { complete: false, hasMore: true };
    if (o.cancelled) w.planPatch = plan => { plan.cancelledServices = [{ id: 'inv-svc', label: 'Invented streaming',
      confirmedCancelledAsOf: '2026-10-01', merchantKeys: ['Invented streaming'] }]; };
    const { data } = H.dataOf(w), ov = data.liveOverlay;
    const advice = F.recommend(data.plan, AS_OF, { debts: data.debts, currentPeriodActuals: ov.currentPeriodActuals,
      operatingPlan: ov.operatingPlan, observedCash: ov.observedCash });
    return advice.payPeriodViews.find(v => v.start <= AS_OF && v.end >= AS_OF).savingsPaidSpending;
  };
  // Complete, posted: total 50, nothing pending.
  const posted = view({});
  assert.deepEqual([posted.total, posted.complete, posted.pendingCount], [50, true, 0]);
  // Incomplete transaction coverage: the total is Unavailable (null); the 50
  // observed is a lower bound only.
  const truncated = view({ truncated: true });
  assert.deepEqual([truncated.total, truncated.observedTotal, truncated.complete], [null, 50, false],
    'incomplete evidence never publishes a complete Paid from Savings total');
  // Pending: counted as pending, never as settled.
  assert.equal(view({ pending: true }).pendingCount, 1, 'a pending Savings debit is published as pending');
  // Cancelled-service warning survives the savings-paid classification.
  const row = view({ cancelled: true, payee: 'Invented streaming' }).recon[0];
  assert.deepEqual([row.unexpectedStatus, row.cancelledServiceId], ['cancelled-service-charge', 'inv-svc'],
    'the cancelled-service warning is kept on the Paid from Savings row');
}

console.log('Savings-paid spend: counted once across Budget, Bills close and Savings; classification boundaries hold.');
