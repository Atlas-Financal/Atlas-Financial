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
})).concat(
  { providerAccountId: 'fake-external', atlasRole: 'household-external' },
  { providerAccountId: 'fake-travelvisa', atlasRole: 'revolving-credit', canonical: { collection: 'debts', id: 'travelvisa' } },
  { providerAccountId: 'fake-heloc', atlasRole: 'heloc', canonical: { collection: 'debts', id: 'heloc' } },
) };
const ledger = (id, account, date, amount, originalName, fields = {}) => ({
  providerTransactionId: id, providerAccountId: 'fake-' + account, date, amount,
  originalName, payee: originalName, pending: false, currency: 'cad',
  savingsPostingEvidence: 'posted', categoryLabel: 'Payment, Transfer', ...fields,
});
const learningPair = [
  ledger('history-out', BILLS, EARLIER, 41, 'AA101 TFR-TO FAKE-WEEK-5274'),
  ledger('history-in', WEEKLY, EARLIER, -41, 'AA101 TFR-FR FAKE-BILLS-1063'),
];
const debit = ledger('new-out', BILLS, DAY, 26, 'AA101 TFR-TO FAKE-WEEK-5274');
const credit = ledger('new-in', WEEKLY, DAY, -26, 'AA101 TFR-FR FAKE-BILLS-1063', {
  isIncome: true, categoryLabel: 'Income',
});
const grocery = ledger('food', BILLS, DAY, 12, 'Invented Market', { categoryLabel: 'Groceries' });
const bill = ledger('required', BILLS, DAY, 17.23, 'Invented Required Payment', { categoryLabel: 'Loan Payment' });
const externalIncome = ledger('external-income', BILLS, DAY, -9, 'Invented External Income', { isIncome: true });

function observe(rows, options = {}) {
  const data = fx.requirementsServed();
  data.plan.bills[0].date = DAY;
  const addPosted = (id, value) => {
    data.plan.startingCash.breakdown.find(row => row.id === id).value = value;
    data.liveOverlay.observedCash.accounts.find(row => row.id === id).value = value;
  };
  // Both snapshots include the source debit. Weekly receives $26 only
  // after the provider reports its receiving leg as posted.
  const postedNewLeg = (id, account) => rows.find(row => row.providerTransactionId === id
    && row.providerAccountId === 'fake-' + account && row.savingsPostingEvidence === 'posted')?.amount || 0;
  addPosted(BILLS, 621 - 12 - 17.23 + 9 - postedNewLeg('new-out', BILLS));
  addPosted(WEEKLY, 100 - postedNewLeg('new-in', WEEKLY));
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
  const packet = O.sanitizedCurrentPeriodActuals(report, { asOf: fx.AS_OF, plan: data.plan, accountMap, ...options });
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
  assert.ok(!/FAKE-WEEK-5274|FAKE-BILLS-1063/.test(JSON.stringify(packet)));
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
const renamedCredit = { ...credit, originalName: 'Invented unrelated credit' };
const withRenamedCredit = observe([...learningPair, debit, renamedCredit]);
assert.equal(withRenamedCredit.movements.length, 1);
assert.equal(withRenamedCredit.movements[0].destinationTransactionId, null,
  'a displayed transfer descriptor alone cannot join a bank-proved outgoing leg');
assert.equal(observe([debit, credit]).movements.length, 1, 'first-seen suffix needs its matching receipt');
for (const originalName of [null, undefined, '  ']) {
  const onlyPayees = [{ ...debit, originalName }, { ...credit, originalName }];
  assert.ok(observe(onlyPayees).movements[0]?.destinationTransactionId, 'a legacy two-leg pair survives missing bank text');
}
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
    ledger('conflict-out', BILLS, fx.START, 42, 'BB102 TFR-TO FAKE-WEEK-5274'),
    ledger('conflict-in', SAVINGS, fx.START, -42, 'BB102 TFR-FR FAKE-BILLS-1063'), debit]],
  ['generic card transfer', [...learningPair, { ...debit, originalName: 'AA101 TFR-TO C/C' }]],
  ['e-transfer', [...learningPair, { ...debit, originalName: 'SEND E-TFR FAKE-WEEK-5274' }]],
  ['cheque', [...learningPair, { ...debit, originalName: 'CHEQUE FAKE-WEEK-5274' }]],
  ['brokerage', [...learningPair, { ...debit, originalName: 'INVESTMENT BROKERAGE FAKE-WEEK-5274' }]],
]) {
  const result = observe(rows);
  assert.equal(result.movements.filter(row => row.date === DAY).length, 0, label);
  assert.equal(result.view.otherIncome.amount, 9, label);
}

const sourceRow = result => result.packet.transactions.find(tx => tx.atlasAccountId === BILLS && tx.date === DAY && tx.amount === 26);
for (const account of ['external', 'unknown', 'travelvisa', 'heloc']) {
  const result = observe([...learningPair, debit, { ...credit, providerAccountId: 'fake-' + account }]);
  assert.equal(result.movements.length, 0, account + ' vetoes the learned destination');
  assert.equal(sourceRow(result).tfrCounterpartyAccountId, undefined, account + ' invalidates the suffix');
}

const conflictingDate = '2026-08-15';
const conflictOut = ledger('conflict-out', BILLS, conflictingDate, 30, 'CC500 TFR-TO FAKE-WEEK-5274');
const conflictIn = ledger('conflict-in', SAVINGS, conflictingDate, -30, 'CC500 TFR-FR FAKE-BILLS-1063');
const conflictingReceipt = observe([...learningPair, conflictOut,
  { ...conflictIn, providerAccountId: 'fake-heloc' }, debit]);
assert.equal(conflictingReceipt.movements.length, 0, 'a historical non-cash receipt invalidates later suffix reuse');
assert.equal(sourceRow(conflictingReceipt).tfrCounterpartyAccountId, undefined);
for (const invalidReceipt of [
  { ...conflictIn, amount: null },
  { ...conflictIn, currencySettlementUnconfirmed: true },
  { ...conflictIn, currency: 'usd' },
]) {
  const incomplete = observe([...learningPair, conflictOut, invalidReceipt, debit]);
  assert.equal(incomplete.packet.transactionCoverage, 'incomplete');
  assert.equal(sourceRow(incomplete).tfrCounterpartyAccountId, undefined, 'an incomplete window cannot teach or reuse a suffix');
  assert.ok(!incomplete.movements.some(movement => movement.date === DAY));
}

const carriedProof = {
  coverageRef: sourceRow(single).coverageRef, account: BILLS, amountCents: 2600,
  cardId: 'travelvisa', trust: 'calculated',
};
for (const [row, field, options] of [
  [{ ...debit, minimumCategoryDebt: 'travelvisa', categoryLabel: 'Minimum payment - Travel Visa' }, 'minimumCategoryDebt'],
  [debit, 'provedPayerReceipt', { provedPayerReceipts: [carriedProof] }],
  [{ ...debit, payee: 'MBNA PAYMENT' }, 'cardPaymentDestination'],
  [{ ...debit, kind: 'card-payment', categoryLabel: 'Utilities' }, 'payingSideCardPaymentKind'],
  [{ ...debit, notes: 'card payment: Travel Visa' }, 'cardPaymentNoteDestination'],
]) {
  const protectedPayment = observe([...learningPair, row], options);
  assert.ok(sourceRow(protectedPayment)[field], field + ' must exercise incumbent card evidence');
  assert.equal(sourceRow(protectedPayment).tfrCounterpartyAccountId, undefined, field);
  assert.equal(protectedPayment.movements.length, 0, field);
  if (field === 'provedPayerReceipt') {
    assert.equal(protectedPayment.classify(sourceRow(protectedPayment)).reason, 'proved-payer-receipt');
  }
}
// The issuer and transfer descriptions cannot both be the original bank
// description. Exercise contradictory persisted flags at the Forecast reader.
for (const cardEvidence of [{ cardPaymentIdentity: true }, { kindHint: 'card-payment' }]) {
  const packet = structuredClone(single.packet);
  const source = sourceRow({ packet });
  Object.assign(source, cardEvidence);
  const action = F.currentPeriodAction(single.data.plan, fx.AS_OF, { currentPeriodActuals: packet });
  assert.ok(!action.internalMovements.some(movement => movement.date === DAY));
  assert.equal(F.classifyCurrentPeriodTransaction(source, single.data.plan, { currentPeriodActuals: packet }).kind, 'card-payment');
}

for (const generic of ['SAVINGS', 'ACCT', 'CHQ', 'LOC', 'CC', 'SAVINGS-ACCOUNT']) {
  const outgoing = ledger('history-out', BILLS, EARLIER, 41, 'AA101 TFR-TO ' + generic);
  const inbound = ledger('history-in', SAVINGS, EARLIER, -41, 'AA101 TFR-FR FAKE-BILLS-1063');
  const current = { ...debit, originalName: 'AA101 TFR-TO ' + generic };
  const unproved = observe([outgoing, inbound, current]);
  assert.equal(sourceRow(unproved).tfrCounterpartyAccountId, undefined, generic);
  assert.equal(unproved.movements.length, 0, generic);
}

const reservePrior = { ...learningPair[0], originalName: 'AA101 TFR-TO FAKE-RESERVE-4285' };
const reserveReceipt = { ...learningPair[1], providerAccountId: 'fake-' + SAVINGS };
const reserveDebit = { ...debit, originalName: 'AA101 TFR-TO FAKE-RESERVE-4285' };
const reserveCredit = { ...credit, providerAccountId: 'fake-' + SAVINGS };
for (const [rows, posted] of [[[reservePrior, reserveReceipt, reserveDebit], false],
  [[reservePrior, reserveReceipt, reserveDebit, reserveCredit], true]]) {
  const result = observe(rows);
  assert.equal(result.movements.length, 1);
  assert.equal(result.movements[0].destinationAccountId, SAVINGS);
  assert.equal(Boolean(result.movements[0].destinationTransactionId), posted);
  assert.equal(result.view.billsAccountPeriodBalance.household.weeklyFunding, 0);
  assert.equal(result.view.billsAccountPeriodBalance.amount, 740.15);
  assert.equal(result.view.otherIncome.amount, 9);
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
