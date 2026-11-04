'use strict';
// Invented balances/ledger. No household values, scaled data or provider IDs.
const base = require('./budget-surface-data');
const AS_OF = '2026-08-20';
const START = '2026-08-14';
const END = '2026-08-27';
const copy = value => JSON.parse(JSON.stringify(value));
function cardTx(id, account, date, amount, payee, kindHint) {
  return { id, coverageRef: 'invented-' + id, atlasAccountId: account, account,
    accountRole: 'revolving-credit', date, amount, currency: 'cad', displayedPayee: payee,
    categoryLabel: 'Groceries', kindHint, pending: false };
}
function fixture() {
  const plan = base.canonical().plan;
  // Explicit invented funding cutover. This is not a provider balance opening
  // and is never supplied to the movement publisher as one.
  plan.cardPurchaseCoverage.opening.asOf = AS_OF;
  const transactions = [
    cardTx('charge-a', 'travelvisa', '2026-08-16', 172.40, 'Example grocer'),
    cardTx('charge-b', 'travelvisa', '2026-08-18', 63.75, 'Example bookshop'),
    cardTx('payment-a', 'travelvisa', '2026-08-18', -100, 'Payment received', 'payment'),
    { id: 'cash-leg-a', coverageRef: 'invented-cash-leg-a', atlasAccountId: 'chequing-a', account: 'chequing-a',
      accountRole: 'household-cash', date: '2026-08-18', amount: 100, currency: 'cad', kindHint: 'payment', pending: false },
    cardTx('refund-a', 'travelvisa', '2026-08-19', -35, 'Example return', 'refund'),
    cardTx('interest-a', 'travelvisa', '2026-08-19', 6.25, 'Example interest', 'interest'),
    { ...cardTx('pending-a', 'travelvisa', '2026-08-20', 28.60, 'Example café'), pending: true },
    cardTx('cashback-charge', 'cashback', '2026-08-15', 114.20, 'Example market'),
    cardTx('cashback-payment', 'cashback', '2026-08-17', -250, 'Payment received', 'card-payment'),
    { id: 'cash-leg-b', coverageRef: 'invented-cash-leg-b', atlasAccountId: 'chequing-a', account: 'chequing-a',
      accountRole: 'household-cash', date: '2026-08-17', amount: 250, currency: 'cad', kindHint: 'payment', pending: false },
    cardTx('triangle-a', 'triangle', '2026-08-18', 51.30, 'Example hardware shop'),
    cardTx('amazon-a', 'mbna', '2026-08-16', 89, 'Example online store'),
    cardTx('amazon-refund', 'mbna', '2026-08-19', -45, 'Example return', 'refund'),
  ];
  const packet = { schema: 'atlas-current-period-actuals/v1', observationAsOf: AS_OF,
    coverageStart: START, coverageThrough: AS_OF, transactionCoverage: 'complete', pendingCoverage: 'complete',
    cardCoverageRequired: true, cardCoverageUnconfirmed: [], currencyUnconfirmed: [], representedActuals: [], transactions };
  const point = (id, date, amount, temporalClaim) => ({ confirmed: true, currency: 'CAD', date, amount,
    temporalClaim, evidenceRef: 'invented-' + id + '-' + date + '-' + temporalClaim });
  const card = (id, opening, closing) => ({ id,
    opening: point(id, START, opening, 'before-period-posted-movements'),
    closing: point(id, AS_OF, closing, 'through-published-posted-coverage') });
  const balanceEvidence = { schema: 'atlas-card-period-balance-evidence/v1', currency: 'CAD',
    asOf: AS_OF, start: START, through: AS_OF, cards: [card('travelvisa', 820, 927.40),
      card('cashback', 2400, 2264.20), card('tdcc', 1100, 1100)] };
  const debts = [
    { id: 'travelvisa', label: 'Example Travel', balance: 927.40 },
    { id: 'cashback', label: 'Example Cash Back', balance: 2264.20 },
    { id: 'tdcc', label: 'Example Emerald', balance: 1100 },
    { id: 'triangle', label: 'Example Triangle', balance: 1980, evidenceDate: '2026-08-17' },
    { id: 'mbna', label: 'Example Amazon', balance: 760, evidenceDate: '2026-08-08' },
  ].map(row => ({ structure: 'Revolving', secured: false, limit: 5000, pending: 0, rate: 19.99, ...row }));
  return { plan, debts, asOf: AS_OF, window: { start: START, end: END }, packet, balanceEvidence };
}
function served() {
  const data = base.served();
  const x = fixture();
  data.debts = copy(x.debts);
  data.plan.cardPurchaseCoverage.opening.asOf = AS_OF;
  data.liveOverlay.currentPeriodActuals.transactions.push(...copy(x.packet.transactions));
  data.liveOverlay.cardPeriodBalanceEvidence = copy(x.balanceEvidence);
  data.liveOverlay.overlays.push(...x.debts.map(debt => ({ locator: 'debts:' + debt.id, field: 'balance',
    proposedValue: debt.balance, evidenceDate: debt.evidenceDate || AS_OF })));
  // The paired payment cash legs reduce the observed Bills cash once. The
  // original invented $1,215 observation becomes $865, not an extra expense.
  data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 865;
  const observed = data.liveOverlay.observedCash?.accounts?.find(row => row.id === 'chequing-a');
  if (observed) observed.value = 865;
  return data;
}
function withHeloc(x) {
  x.debts.push({ id: 'heloc', label: 'Example HELOC', structure: 'Interest-only revolving — never amortises',
    secured: true, balance: 42025.35, evidenceDate: AS_OF, limit: 60000, pending: 0, rate: 4.9 });
  x.packet.transactions.push(...[
    cardTx('heloc-advance', 'heloc', '2026-08-16', 500, 'Example advance', 'transfer'),
    cardTx('heloc-payment', 'heloc', '2026-08-18', -600, 'Example payment', 'payment'),
    cardTx('heloc-interest', 'heloc', '2026-08-19', 125.35, 'Example interest', 'interest'),
    { ...cardTx('heloc-pending', 'heloc', AS_OF, 900, 'Example pending'), pending: true }]
    .map(tx => ({ ...tx, accountRole: 'heloc' })));
  x.balanceEvidence.cards.push({ id: 'heloc', opening: { confirmed: true, currency: 'CAD', date: START,
    amount: 42000, temporalClaim: 'before-period-posted-movements', evidenceRef: 'invented-heloc-open' },
  closing: { confirmed: true, currency: 'CAD', date: AS_OF, amount: 42025.35,
    temporalClaim: 'through-published-posted-coverage', evidenceRef: 'invented-heloc-close' } });
  return x;
}
function helocFixture() { return withHeloc(fixture()); }
function helocServed() {
  const data = served(), x = helocFixture();
  data.debts = copy(x.debts);
  data.liveOverlay.currentPeriodActuals.transactions.push(...copy(x.packet.transactions.filter(tx => tx.account === 'heloc')));
  data.liveOverlay.cardPeriodBalanceEvidence = copy(x.balanceEvidence);
  return data;
}
function helocObserved(mode = 'complete') {
  const data = base.canonical(), accountMap = copy(base.map), payload = base.payload();
  data.debts.push(copy(helocFixture().debts.find(row => row.id === 'heloc')));
  accountMap.mappings.push({ providerAccountId: '2002', canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' });
  payload.accounts.push({ id: 2002, type: 'credit', balance: 42025.35, currency: 'cad', updated_at: AS_OF + 'T17:55:00.000Z', balance_last_update: AS_OF + 'T17:55:00.000Z' });
  payload.transactions.push(...[
    { id: 93001, date: '2026-08-16', amount: 500, payee: 'Example advance', kind: 'transfer' },
    { id: 93002, date: '2026-08-18', amount: -600, payee: 'Example payment', kind: 'payment' },
    { id: 93003, date: '2026-08-19', amount: 125.35, payee: 'Example interest', kind: 'interest' },
    { id: 93004, date: AS_OF, amount: 900, payee: 'Example pending', is_pending: true },
  ].map(tx => ({ account_id: 2002, currency: 'cad', is_pending: false, status: 'cleared', ...tx })));
  const row = payload.transactions.find(tx => tx.id === 93001);
  if (mode === 'undated') row.date = null;
  if (mode === 'amount-missing') row.amount = null;
  if (mode === 'foreign-currency') row.currency = 'usd';
  if (mode === 'empty' || mode === 'malformed-only') {
    payload.transactions = payload.transactions.filter(tx => tx.account_id !== 2002);
    if (mode === 'malformed-only') payload.transactions.push({ ...row, date: null });
  }
  const next = require('../../scripts/live-plan').fromObservation({ data, payload, accountMap, identity: base.identity }).data;
  const points = copy(helocFixture().balanceEvidence);
  if (mode === 'empty' || mode === 'malformed-only') points.cards.find(row => row.id === 'heloc').closing.amount = 42000;
  next.liveOverlay.cardPeriodBalanceEvidence = points;
  return next;
}
module.exports = { AS_OF, START, END, fixture, served, copy, helocFixture, helocServed, helocObserved };
