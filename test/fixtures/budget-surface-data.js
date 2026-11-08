'use strict';
// One invented household for the active Budget surface: no captured values,
// provider IDs, merchants or balances. Every dollar below is made up so the
// surface's figures can be reconciled against these inputs independently.
//
// Pay period Aug 14-27, 2026; household date Aug 20.
//   Received pay Aug 14: 2,600 (payroll, confirmed).
//   Expected partner pay Aug 25: 1,450 (estimated).
//   Bills in the period: mortgage 1,400 (Aug 15, paid), hydro 120 (Aug 18,
//   estimated, no payment linked), internet 85 (Aug 24), card minimum 60
//   (Aug 22). Floor: 300.
//   Spending: groceries 212.40 + 96.15, fuel 74.20, dining 38.75,
//   unassigned 22.99.
// Canonical opening Aug 13; the live overlay advances it to Aug 20.
// Opening balances follow independently from the Aug 20 observation:
//   bills account   1,215 - 2,600 pay + 1,400 mortgage            = 15
//   spending account  160 + 212.40 + 74.20 + 38.75 + 96.15 + 22.99 = 604.49
const AS_OF = '2026-08-20';
const OPENING = '2026-08-13';

function canonical() {
  return {
    meta: { asOf: OPENING, title: 'Synthetic Budget surface' },
    accounts: [], revolvingExtra: [],
    debts: [{ id: 'travelvisa', label: 'Synthetic card', structure: 'Revolving',
      secured: false, balance: 2000, pending: 0, limit: 5000, rate: 19.99 }],
    plan: {
      windowDays: 91,
      opening: { asOf: OPENING },
      cardPurchaseCoverage: require('./card-coverage-opening')(OPENING),
      startingCash: { breakdown: [
        { id: 'chequing-a', label: 'Synthetic bills account', value: 15 },
        { id: 'chequing-b', label: 'Synthetic spending account', value: 604.49 },
        { id: 'savings', label: 'Synthetic savings', value: 0 },
      ] },
      defaults: { targetBuffer: 300, extraDebtMonthly: 0, scenario: 'expected' },
      income: [
        { id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
          anchor: '2026-08-14', amount: 2600, confidence: 'confirmed' },
        { id: 'partner', label: 'Partner salary', frequency: 'monthly',
          day: 25, amount: 1450, confidence: 'estimated' },
      ],
      bills: [
        { id: 'mortgage', label: 'Mortgage', frequency: 'monthly', day: 15,
          amount: 1400, confidence: 'confirmed', payingAccount: 'chequing-a' },
        { id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 18,
          amount: 120, confidence: 'estimated', payingAccount: 'chequing-a' },
        { id: 'internet', label: 'Internet', frequency: 'monthly', day: 24,
          amount: 85, confidence: 'confirmed', payingAccount: 'chequing-a' },
      ],
      obligations: [
        { id: 'card-minimum', label: 'Synthetic card minimum', debtId: 'travelvisa',
          effect: 'payment', frequency: 'monthly', day: 22, amount: 60, confidence: 'confirmed',
          payingAccount: 'chequing-a' },
      ],
      budget: { categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'],
          plannedPayday: 450, confidence: 'confirmed' },
        { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Gas'],
          plannedPayday: 160, confidence: 'confirmed' },
        { id: 'restaurants', label: 'Eating out', class: 'discretionary', from: ['Restaurants'],
          plannedPayday: 120, confidence: 'confirmed' },
      ] },
      commitments: [
        { id: 'school-trip', label: 'School trip', date: '2026-09-12',
          amount: 400, confidence: 'confirmed' },
        { id: 'winter-tires', label: 'Winter tires', date: '2026-10-15',
          amount: 900, confidence: 'estimated' },
      ],
    },
  };
}

const map = { schema: 'atlas-provider-account-map/v1', provider: 'lunchmoney', scope: 'fixture',
  mappings: [
    { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
    { providerAccountId: '1003', canonical: { collection: 'cash', id: 'savings' }, atlasRole: 'household-cash' },
    { providerAccountId: '2001', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
  ] };

const tx = (id, account, date, amount, payee, category, extra = {}) => ({
  id, account_id: account, date, amount, currency: 'cad', payee, category_id: category,
  is_pending: false, status: 'cleared', ...extra,
});

function payload() {
  return { provider: 'lunchmoney', fetchedAt: AS_OF + 'T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-13', endDate: AS_OF, complete: true, hasMore: false, truncated: false },
    pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false, truncated: false },
    accounts: [
      { id: 1001, type: 'cash', balance: 1215 }, { id: 1002, type: 'cash', balance: 160 },
      { id: 1003, type: 'cash', balance: 0 }, { id: 2001, type: 'credit', balance: 2000, credit_limit: 5000 },
    ].map(a => ({ ...a, currency: 'cad', updated_at: AS_OF + 'T17:55:00.000Z', balance_last_update: AS_OF + 'T17:55:00.000Z' })),
    categories: [
      { id: 11, name: 'Groceries', is_income: false, exclude_from_totals: false },
      { id: 12, name: 'Gas', is_income: false, exclude_from_totals: false },
      { id: 13, name: 'Restaurants', is_income: false, exclude_from_totals: false },
      { id: 14, name: 'Shopping', is_income: false, exclude_from_totals: false },
      { id: 15, name: 'Income', is_income: true, exclude_from_totals: false },
      { id: 16, name: 'Housing', is_income: false, exclude_from_totals: false },
    ],
    transactions: [
      tx(92001, 1001, '2026-08-14', -2600, 'Synthetic payroll', 15),
      tx(92002, 1001, '2026-08-15', 1400, 'Synthetic mortgage', 16),
      tx(92003, 1002, '2026-08-16', 212.40, 'Synthetic grocer', 11),
      tx(92004, 1002, '2026-08-17', 74.20, 'Synthetic fuel stop', 12),
      tx(92005, 1002, '2026-08-18', 38.75, 'Synthetic diner', 13),
      tx(92006, 1002, '2026-08-19', 96.15, 'Synthetic market', 11),
      tx(92007, 1002, '2026-08-19', 22.99, 'Synthetic general store', 14),
    ],
  };
}

const identity = { schema: 'atlas-provider-transaction-identity/v1', rules: [
  { eventId: 'payroll', payeePattern: 'Synthetic payroll', atlasAccountId: 'chequing-a', direction: 'credit' },
  { eventId: 'mortgage', payeePattern: 'Synthetic mortgage', atlasAccountId: 'chequing-a', direction: 'debit' },
] };

// Savings accounts configured, starting allocations not yet confirmed: the
// state in which Forecast withholds new savings proposals.
function withheldSavings(data) {
  data.plan.savingsEarmarks = { version: 1, currency: 'CAD', pools: [
    { id: 'reserve-a', accountId: 'savings', label: 'Synthetic reserve A' },
    { id: 'reserve-b', accountId: 'synthetic-reserve-b', label: 'Synthetic reserve B' },
  ], history: [] };
  return data;
}

// The served /data.json packet, through the real observation and overlay.
// opts.unavailablePlan: the server's fail-closed packet for a refresh it
// could not trust — the dated Aug 13 opening, observed Aug 20.
function deficitPeriod(data) {
  data.plan.bills.push({ id: 'levy', label: 'Synthetic levy', frequency: 'monthly',
    day: 16, amount: 5000, confidence: 'confirmed', payingAccount: 'chequing-a' });
  return data;
}

// Keep the scheduled income rows and their anchors; set both amounts to
// zero so Forecast publishes known $0 income and known deficits without a
// positive percentage scale.
function zeroIncome(data) {
  data.plan.income.forEach(row => { row.amount = 0; });
  return data;
}

function served(opts = {}) {
  const Live = require('../../scripts/live-plan');
  if (opts.zeroIncomeWithoutSpend) {
    // Observation actuals include the invented $2,600 payroll and would
    // restore a positive income scale. This packet keeps the zeroed
    // schedule so Forecast can publish known $0 income.
    const data = zeroIncome(canonical());
    data.meta = Object.assign({}, data.meta, { asOf: AS_OF });
    return data;
  }
  if (typeof opts.estimatedBills === 'number') {
    // C5: the bank feed returns no Bills account, so live-plan refuses the
    // overlay (missing-live-cash-evidence) and the household is served the
    // canonical document, whose Bills row is the owner-entered estimate.
    // Invented amount, tagged estimated.
    const data = canonical();
    data.meta = Object.assign({}, data.meta, { asOf: OPENING });
    Object.assign(data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a'),
      { value: opts.estimatedBills, confidence: opts.billsConfidence || 'estimated' });
    return data;
  }
  const data = opts.withheldSavings ? withheldSavings(canonical())
    : opts.deficitPeriod ? deficitPeriod(canonical()) : canonical();
  const observed = payload();
  const observationIdentity = opts.fundingHistory ? { ...identity, rules: [...identity.rules,
    { eventId: 'historical-service', payeePattern: 'Synthetic historical service', atlasAccountId: 'chequing-a', direction: 'debit' }] } : identity;
  if (opts.fundingHistory) {
    data.plan.bills.push({ id: 'historical-service', label: 'Synthetic historical service', frequency: 'once',
      date: '2026-08-07', amount: 105, confidence: 'confirmed', payingAccount: 'chequing-a' });
    observed.transactionWindow.startDate = '2026-07-31';
    observed.transactions.push(tx(92101, 1002, '2026-08-04', 47.25, 'Synthetic historical grocer', 11),
      tx(92102, 1002, '2026-08-05', 19.50, 'Synthetic historical fuel', 12));
    if (opts.fundingHistory === 'paid') observed.transactions.push(tx(92103, 1001, '2026-08-07', 105, 'Synthetic historical service', 16));
  }
  if (opts.withUndatedCost) data.plan.commitments.push({ id: 'fixture-undated', label: 'Synthetic undated cost',
    amount: 275, confidence: 'confirmed' });
  if (typeof opts.periodInternet === 'number') {
    data.plan.bills.find(row => row.id === 'internet').amount = opts.periodInternet;
  }
  if (typeof opts.historicalHydroDay === 'number') {
    data.plan.bills.find(row => row.id === 'hydro').day = opts.historicalHydroDay;
  }
  if (opts.zeroIncome) {
    data.plan.income.forEach(row => { row.amount = 0; });
    observed.transactions = observed.transactions.filter(row => row.id !== 92001);
    // No salary occurred: 1,215 closing + 1,400 paid mortgage = 2,615 opening.
    data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 2615;
  }
  if (opts.etransfer) {
    // One invented outgoing e-transfer: provider descriptor SEND E-TFR on
    // the raw row only, Lunch Money category Transfer. The opening for the
    // spending account rises by the same $75 so the observed closing
    // balance stays 160, exactly like the groceriesExtra pattern above.
    observed.categories.push({ id: 17, name: 'Transfer', is_income: false, exclude_from_totals: true });
    observed.transactions.push(tx(92009, 1002, '2026-08-19', 75, 'Synthetic recipient', 17,
      { original_name: 'SEND E-TFR SYNTHETIC RECIPIENT' }));
    data.plan.startingCash.breakdown.find(row => row.id === 'chequing-b').value += 75;
  }
  if (Array.isArray(opts.budgetCategories)) data.plan.budget.categories = opts.budgetCategories;
  if (typeof opts.groceriesExtra === 'number' && opts.groceriesExtra > 0) {
    observed.transactions.push(tx(92008, 1002, '2026-08-19', opts.groceriesExtra, 'Synthetic extra grocer', 11));
    // Independent higher opening finances this extra observed purchase;
    // the observation's closing spending balance remains 160.
    data.plan.startingCash.breakdown.find(row => row.id === 'chequing-b').value += opts.groceriesExtra;
  }
  // Independent observation variants for the account-identity contract.
  for (const [key, providerId, canonicalId, original] of [
    ['spendingCash', 1002, 'chequing-b', 160], ['savingsCash', 1003, 'savings', 0],
  ]) {
    if (typeof opts[key] !== 'number') continue;
    observed.accounts.find(row => row.id === providerId).balance = opts[key];
    data.plan.startingCash.breakdown.find(row => row.id === canonicalId).value += opts[key] - original;
  }
  if (opts.observedEstimatedBills) {
    // C5 follow-up: the canonical Bills row still carries the owner's earlier
    // estimate tag, but this refresh's bank feed DOES return the account
    // (provider 1001, the normal observation). The overlay must treat the
    // fresh observation as provider evidence, not keep the stale estimate.
    data.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').confidence = 'estimated';
  }
  const overlay = Live.fromObservation({ data, payload: observed, accountMap: map, identity: observationIdentity });
  if (opts.earlyInternet) {
    // Typed occurrence-receipt boundary fixture, not a provider-matcher or
    // current-cash reconciliation test. Forecast earns its native PAID row
    // from this observed receipt before Budget consumes that publication.
    const packet=overlay.data.liveOverlay.currentPeriodActuals;
    packet.representedActuals.push({id:'internet',date:'2026-08-24',actual:85,
      postedOn:'2026-08-19',transactionId:'invented-early-service'});
    packet.transactions.push({id:'invented-early-service',date:'2026-08-19',amount:85,
      pending:false,representedBill:true,categoryLabel:'Bills',accountRole:'household-cash',
      atlasAccountId:'chequing-a',displayedPayee:'Invented early service payment'});
  }
  if (opts.unavailablePlan) {
    return Live.failedOverlay(canonical(), 'Synthetic refresh could not be trusted.', { report: overlay.report });
  }
  return overlay.data;
}

// Completed Jul 31-Aug 13 period: independently invented groceries $47.25,
// fuel $19.50 and a $105 bill on Aug 7. Current Aug 14-27 inputs stay unchanged.
// Coverage variants are observation evidence, not renderer fault injections.
function historical(coverage = 'missing', settlement = 'unverified') {
  const data = served();
  data.plan.bills.push({ id: 'historical-service', label: 'Synthetic historical service',
    frequency: 'once', date: '2026-08-07', amount: 105, confidence: 'confirmed', payingAccount: 'chequing-a' });
  const packet = data.liveOverlay.currentPeriodActuals;
  packet.transactions.push(
    { id: 'history-grocery', date: '2026-08-04', amount: 47.25, pending: false,
      categoryLabel: 'Groceries', accountRole: 'household-cash', atlasAccountId: 'chequing-b',
      displayedPayee: 'Synthetic historical grocer' },
    { id: 'history-fuel', date: '2026-08-05', amount: 19.50, pending: false,
      categoryLabel: 'Gas', accountRole: 'household-cash', atlasAccountId: 'chequing-b',
      displayedPayee: 'Synthetic historical fuel' });
  if (coverage === 'full' || coverage === 'truncated' || coverage === 'posted-only') packet.coverageStart = '2026-07-31';
  if (coverage === 'partial') packet.coverageStart = '2026-08-04';
  if (coverage === 'truncated') packet.transactionCoverage = 'truncated';
  if (coverage === 'posted-only') packet.pendingCoverage = 'unknown';
  if (settlement === 'paid') {
    packet.representedActuals.push({ id: 'historical-service', date: '2026-08-07', actual: 105,
      postedOn: '2026-08-07', transactionId: 'history-service-payment' });
    packet.transactions.push({ id: 'history-service-payment', date: '2026-08-07', amount: 105,
      pending: false, representedBill: true, categoryLabel: 'Bills', accountRole: 'household-cash',
      atlasAccountId: 'chequing-a', displayedPayee: 'Synthetic historical service payment' });
  }
  return data;
}

// The funding walk also consumes Live's operating plan. Earn the historical
// payment through that observation boundary before adjusting coverage, so its
// settlement agrees across lookback and current-cash publications.
function fundingHistorical(coverage = 'missing', settlement = 'unverified') {
  const data = served({ fundingHistory: settlement });
  const packet = data.liveOverlay.currentPeriodActuals;
  if (coverage === 'missing') packet.coverageStart = '2026-08-13';
  if (coverage === 'partial') packet.coverageStart = '2026-08-04';
  if (coverage === 'truncated') packet.transactionCoverage = 'truncated';
  if (coverage === 'posted-only') packet.pendingCoverage = 'unknown';
  return data;
}

module.exports = { AS_OF, OPENING, canonical, payload, map, identity, served, historical, fundingHistorical };
