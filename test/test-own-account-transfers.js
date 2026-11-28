'use strict';

// Invented ledger through the observer, Forecast's Budget entry point and
// the shipped Budget renderer. Dollar expectations are from the ledger below.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const O = require('../scripts/provider-observe');
const fx = require('./fixtures/bills-period-end-balance-data');
const { loadBudgetPage, loadStackPage } = require('./lib/budget-page-harness');

const EARLIER = '2026-08-13';
const DAY = '2026-08-18';
const BILLS = 'chequing-a', WEEKLY = 'chequing-b', SAVINGS = 'savings';
const accountMap = { mappings: [BILLS, WEEKLY, SAVINGS].map(id => ({
  providerAccountId: 'fake-' + id, canonical: { collection: 'cash', id },
  atlasRole: id === SAVINGS ? 'household-reserve' : 'household-cash',
})).concat({ providerAccountId: 'fake-external', atlasRole: 'household-external' }) };
const ledger = (id, account, date, amount, originalName, fields = {}) => ({
  providerTransactionId: id, providerAccountId: 'fake-' + account, date, amount,
  originalName, payee: originalName, pending: false, currency: 'cad',
  savingsPostingEvidence: 'posted', categoryLabel: 'Payment, Transfer', ...fields,
});
const learningPair = [
  ledger('history-out', BILLS, EARLIER, 41, 'AA101 TFR-TO FAKE-WEEK'),
  ledger('history-in', WEEKLY, EARLIER, -41, 'AA101 TFR-FR FAKE-BILLS'),
];
const debit = ledger('new-out', BILLS, DAY, 26, 'AA101 TFR-TO FAKE-WEEK');
const credit = ledger('new-in', WEEKLY, DAY, -26, 'AA101 TFR-FR FAKE-BILLS', {
  isIncome: true, categoryLabel: 'Income',
});
const grocery = ledger('food', BILLS, DAY, 12, 'Invented Market', { categoryLabel: 'Groceries' });
const bill = ledger('required', BILLS, DAY, 17.23, 'Invented Required Payment', { categoryLabel: 'Loan Payment' });
const externalIncome = ledger('external-income', BILLS, DAY, -9, 'Invented External Income', { isIncome: true });

function observe(rows) {
  const data = fx.requirementsServed();
  data.plan.bills[0].date = DAY;
  const addPosted = (id, value) => {
    data.plan.startingCash.breakdown.find(row => row.id === id).value = value;
    data.liveOverlay.observedCash.accounts.find(row => row.id === id).value = value;
  };
  // Both snapshots include the source debit. Weekly receives $26 only
  // after the provider reports its receiving leg as posted.
  addPosted(BILLS, 621 - 12 - 17.23 + 9 - (rows.includes(debit) ? 26 : 0));
  addPosted(WEEKLY, rows.includes(credit) ? 126 : 100);
  const transactions = [...rows, grocery, bill, externalIncome];
  const report = {
    fetchedAt: fx.AS_OF + 'T18:00:00Z',
    transactionWindow: { startDate: EARLIER, endDate: fx.AS_OF, complete: true },
    pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, status: 'complete' },
    transactions, collapsedTransactions: transactions,
    representedEventCandidates: [
      { id: 'payroll', date: fx.START, observedAmount: -1077.37 },
      { id: 'service', date: DAY, observedAmount: 17.23, transactionId: 'required' },
    ],
  };
  const packet = O.sanitizedCurrentPeriodActuals(report, { asOf: fx.AS_OF, plan: data.plan, accountMap });
  data.liveOverlay.currentPeriodActuals = packet;
  const opts = F.budgetRecommendInputs(data, {});
  const view = F.recommend(data.plan, fx.AS_OF, opts).payPeriodViews.find(v => v.role === 'active');
  const action = F.currentPeriodAction(data.plan, fx.AS_OF, opts);
  const movements = action.internalMovements.filter(movement => movement.date >= fx.START);
  const classify = tx => F.classifyCurrentPeriodTransaction(tx, data.plan, opts);
  return { data, view, packet, movements, classify };
}

const single = observe([...learningPair, debit]);
const paired = observe([...learningPair, debit, credit]);
for (const { view, packet, movements } of [single, paired]) {
  assert.equal(movements.length, 1);
  assert.equal(movements[0].householdIncome, 0);
  assert.equal(movements[0].householdConsumption, 0);
  assert.equal(movements[0].destinationAccountId, WEEKLY);
  assert.equal(view.otherIncome.amount, 9);
  assert.equal(view.householdBudget.find(row => row.id === 'groceries').spent, 12);
  assert.equal(view.bills.filter(row => row.id === 'service' && row.actual === 17.23).length, 1);
  assert.equal(view.periodBillLoad, 17.23);
  assert.equal(view.predictedEndingBalanceTerms.heldOutflowSpending ?? 0, 0);
  assert.equal(view.billsAccountPeriodBalance.status, 'ready');
  assert.equal(view.billsAccountPeriodBalance.observedCash, 574.77);
  assert.equal(view.billsAccountPeriodBalance.household.weeklyFunding, 26);
  // $574.77 posted + $263.19 remaining income - ($100.40 target - $38
  // funded from Bills) - $9.41 planned commitment.
  assert.equal(view.billsAccountPeriodBalance.amount, 766.15);
  assert.equal(view.postedBillsAccountMovements.movements.filter(row => row.amount === -26).length, 1);
  assert.ok(!/FAKE-WEEK|FAKE-BILLS/.test(JSON.stringify(packet)));
}
assert.equal(single.movements[0].destinationDate, null);
assert.equal(single.movements[0].destinationTransactionId, null);
assert.equal(single.movements[0].householdAssetDelta, null);
assert.equal(single.view.balanceAfterDeductions, paired.view.balanceAfterDeductions);
assert.equal(paired.movements[0].sourceTransactionId, single.movements[0].sourceTransactionId);
assert.ok(paired.movements[0].destinationTransactionId);
assert.equal(paired.movements[0].householdAssetDelta, 0);

const pendingCredit = { ...credit, pending: true, savingsPostingEvidence: 'pending' };
assert.equal(observe([...learningPair, debit, pendingCredit]).movements[0].destinationTransactionId, null);
assert.equal(observe([debit, credit]).movements.length, 1, 'first-seen suffix needs its matching receipt');
for (const [label, rows] of [
  ['first-seen suffix', [debit]],
  ['later dated receipt', [debit, { ...credit, date: fx.AS_OF }]],
  ['unmapped receiving account', [debit, { ...credit, providerAccountId: 'fake-unknown' }]],
  ['external receiving account', [debit, { ...credit, providerAccountId: 'fake-external' }]],
  ['unconfirmed historical posting', [learningPair[0], { ...learningPair[1], savingsPostingEvidence: 'unknown' }, debit]],
  ['pending outgoing leg', [...learningPair, { ...debit, pending: true, savingsPostingEvidence: 'pending' }]],
  ['amount mismatch', [...learningPair, debit, { ...credit, amount: -27 }]],
  ['coincidental second source on same day', [debit, { ...debit, providerTransactionId: 'repeat' }, credit]],
  ['conflicting learned suffix', [...learningPair,
    ledger('conflict-out', BILLS, fx.START, 42, 'BB102 TFR-TO FAKE-WEEK'),
    ledger('conflict-in', SAVINGS, fx.START, -42, 'BB102 TFR-FR FAKE-BILLS'), debit]],
  ['generic card transfer', [...learningPair, { ...debit, originalName: 'AA101 TFR-TO C/C' }]],
  ['e-transfer', [...learningPair, { ...debit, originalName: 'SEND E-TFR FAKE-WEEK' }]],
  ['cheque', [...learningPair, { ...debit, originalName: 'CHEQUE FAKE-WEEK' }]],
  ['brokerage', [...learningPair, { ...debit, originalName: 'INVESTMENT BROKERAGE FAKE-WEEK' }]],
]) {
  const result = observe(rows);
  assert.equal(result.movements.filter(row => row.date === DAY).length, 0, label);
  assert.equal(result.view.otherIncome.amount, 9, label);
}
const rewritten = observe([...learningPair, { ...debit, originalName: 'Invented Shop', categoryLabel: 'Groceries' }]);
assert.equal(rewritten.movements.length, 0);
assert.equal(rewritten.view.householdBudget.find(row => row.id === 'groceries').spent, 38);
const unseenReceipt = observe([credit]);
assert.equal(unseenReceipt.classify(unseenReceipt.packet.transactions.find(row => row.amount === -26)).kind, 'transfer');
assert.equal(unseenReceipt.view.otherIncome.amount, 9);

const renderBudget = loadBudgetPage().get('householdBudgetCategoryHtml');
const category = view => view.householdBudget.find(row => row.id === 'groceries');
for (const { view } of [single, paired]) {
  const html = renderBudget(category(view));
  assert.match(html, /data-budget-spent-total="groceries">\$12\.00/);
  assert.equal((html.match(/household-budget-tx-payee/g) || []).length, 1);
  assert.match(html, /Invented Market/);
}

(async () => {
  for (const { data } of [single, paired]) {
    const page = await loadStackPage({ data });
    assert.equal(page.status(), 'rendered');
    const view = page.context().recommendation.payPeriodViews.find(row => row.role === 'active');
    assert.equal(view.billsAccountPeriodBalance.amount, 766.15);
    assert.equal(view.otherIncome.amount, 9);
    assert.equal(category(view).spent, 12);
  }
  console.log('Own-account transfer proof passed (invented observer, Forecast and rendered Budget).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
