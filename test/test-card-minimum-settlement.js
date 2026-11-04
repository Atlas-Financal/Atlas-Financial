'use strict';

// Payment aliases and statement-cycle timing cannot establish household
// minimum-payment intent. Explicit occurrence confirmations remain authoritative.
// Synthetic cents (L-006). Fixture account ids only.

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const IDENTITY_PATH = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const MAP_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');
const ACCOUNT_FACTS_PATH = path.join(ROOT, 'docs', 'ACCOUNT_FACTS.md');

const CYCLE = 'covers-statement-cycle-or-latest-due';
const DUE_ON_OR_BEFORE = 'covers-due-on-or-before-posting';
const HISTORICAL_OPENING = '2026-08-19';
const LIVE_AS_OF = '2026-09-03';
const FETCHED_AT = '2026-09-03T18:00:00.000Z';
const OBSERVED_AT = '2026-09-03T17:55:00.000Z';
const TRIANGLE_DUE = '2026-09-07';
const MBNA_AUG31 = '2026-08-31';
const TRAVEL_AUG26 = '2026-08-26';
const TRAVEL_SEP26 = '2026-09-26';
const TRIANGLE_MIN = 88.88;
const MBNA_MIN = 77.77;
const TRAVEL_MIN = 15.15;

const CHEQUING_A = 3001;
const CHEQUING_B = 3002;
const SAVINGS = 3003;
const TRAVEL_CARD = 3006;
const TRIANGLE_CARD = 3010;
const MBNA_CARD = 3011;

let failures = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function near(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.005;
}

function ok(condition, label, detail) {
  if (condition) {
    console.log(`\x1b[32m✓\x1b[0m ${label}`);
    return;
  }
  failures += 1;
  console.log(`\x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
}

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const canonicalFileBefore = fs.readFileSync(DATA_PATH, 'utf8');
const canonical = JSON.parse(canonicalFileBefore);
const identity = load(IDENTITY_PATH);
const accountFacts = fs.readFileSync(ACCOUNT_FACTS_PATH, 'utf8');

function obligation(plan, id) {
  return ((plan && plan.obligations) || []).find(row => row && row.id === id) || null;
}

function debt(data, id) {
  return ((data.debts || []).find(row => row && row.id === id)) || null;
}

function cashValue(data, id) {
  const rows = ((data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || []);
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function planFixture() {
  const data = clone(canonical);
  const triangle = obligation(data.plan, 'triangle');
  const mbna = obligation(data.plan, 'mbna');
  const mbnaOnce = obligation(data.plan, 'mbna-aug31');
  const travel = obligation(data.plan, 'travel');
  const tdcc = obligation(data.plan, 'tdcc');
  const cashback = obligation(data.plan, 'cashback');
  if (!triangle || !mbna || !mbnaOnce || !travel) {
    throw new Error('canonical Triangle/MBNA/Travel obligations missing');
  }
  triangle.amount = TRIANGLE_MIN;
  // This invented minimum fixture owns its cycle; later approved statement
  // and sender evidence on the real incumbent must not leak into it.
  delete triangle.statementOccurrences;
  delete triangle.sentPayments;
  mbna.amount = MBNA_MIN;
  mbnaOnce.amount = MBNA_MIN;
  // This case owns an invented unconfirmed minimum. Canonical owner-approved
  // statement or sender evidence must not silently change that premise.
  delete mbnaOnce.statementOccurrences;
  delete mbnaOnce.sentPayments;
  delete mbna.statementOccurrences;
  delete mbna.sentPayments;
  // This historical synthetic ledger owns an unconfirmed TD minimum; later
  // owner-approved Emerald occurrence evidence must not change that premise.
  delete tdcc.statementOccurrences;
  delete tdcc.sentPayments;
  // This historical invented ledger excludes the later owner-confirmed Cash Back cycle.
  delete cashback.statementOccurrences;
  delete cashback.sentPayments;
  travel.amount = TRAVEL_MIN;
  return data;
}

function mapWithMbna() {
  const map = load(MAP_PATH);
  map.mappings = map.mappings.concat([{
    providerAccountId: String(MBNA_CARD),
    canonical: { collection: 'debts', id: 'mbna' },
    atlasRole: 'revolving-credit',
  }]);
  return map;
}

function completePendingCoverage() {
  return {
    complete: true,
    basis: 'is_pending-unbounded',
    hasMore: false,
    startDate: null,
    endDate: null,
  };
}

function matchingAccounts(data) {
  const accounts = [
    {
      id: CHEQUING_A, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-a'),
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: CHEQUING_B, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-b'),
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: SAVINGS, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'savings'),
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: 3004, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'tdcc').balance,
      credit_limit: debt(data, 'tdcc').limit,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: 3005, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'cashback').balance,
      credit_limit: debt(data, 'cashback').limit,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: TRAVEL_CARD, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'travelvisa').balance,
      credit_limit: debt(data, 'travelvisa').limit,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'heloc').balance,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'mortgage').balance,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: TRIANGLE_CARD, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: debt(data, 'triangle').balance,
      credit_limit: debt(data, 'triangle').limit,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
    {
      id: MBNA_CARD, name: 'AMAZON MBNA MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'MBNA', currency: 'cad',
      balance: debt(data, 'mbna').balance,
      credit_limit: debt(data, 'mbna').limit,
      updated_at: OBSERVED_AT, balance_last_update: OBSERVED_AT,
    },
  ];
  return accounts;
}

function tx({ id, account, date, amount, payee, original, category }) {
  return {
    id: id || Math.abs(hashId(`${account}|${date}|${amount}|${payee}`)),
    account_id: account,
    date,
    amount,
    payee,
    original_name: original || payee,
    category_name: category || null,
    is_pending: false,
    status: 'reviewed',
  };
}

function hashId(value) {
  let n = 0;
  for (let i = 0; i < value.length; i += 1) n = ((n << 5) - n + value.charCodeAt(i)) | 0;
  return 800000 + Math.abs(n % 199999);
}

function triangleChequing(date, amount) {
  return tx({
    account: CHEQUING_A,
    date,
    amount,
    payee: 'Can Tire Mc',
    original: 'CAN TIRE MC 1234',
    category: 'Credit card payment',
  });
}

function mbnaChequing(date, amount) {
  return tx({
    account: CHEQUING_A,
    date,
    amount,
    payee: 'MBNA M/C 5678',
    original: 'MBNA M/C 5678',
    category: 'Credit card payment',
  });
}

function observe(data, transactions, extra) {
  return O.observe({
    provider: 'lunchmoney',
    payload: {
      provider: 'lunchmoney',
      fetchedAt: FETCHED_AT,
      source: 'Synthetic card-minimum settlement fixture. Fixture IDs 3001–3011 are not live provider IDs.',
      pendingCoverage: completePendingCoverage(),
      accounts: matchingAccounts(data),
      transactions: (transactions || []).map(row => ({ currency: 'cad', ...row })),
      transactionWindow: {
        startDate: '2026-08-01',
        endDate: LIVE_AS_OF,
        complete: true,
        hasMore: false,
        truncated: false,
      },
    },
    accountMap: (extra && extra.accountMap) || mapWithMbna(),
    data,
    identity,
  });
}

function overlay(data, transactions, extra) {
  return Live.fromObservation({
    data,
    payload: {
      provider: 'lunchmoney',
      fetchedAt: FETCHED_AT,
      source: 'Synthetic card-minimum settlement fixture. Fixture IDs 3001–3011 are not live provider IDs.',
      pendingCoverage: completePendingCoverage(),
      accounts: matchingAccounts(data),
      transactions: (transactions || []).map(row => ({ currency: 'cad', ...row })),
      transactionWindow: {
        startDate: '2026-08-01',
        endDate: LIVE_AS_OF,
        complete: true,
        hasMore: false,
        truncated: false,
      },
    },
    accountMap: (extra && extra.accountMap) || mapWithMbna(),
    identity,
  });
}

function candidates(report) {
  return report && report.representedEventCandidates || [];
}

function hasCandidate(report, id, date) {
  return candidates(report).some(row => row && row.id === id && row.date === date);
}

function represented(data, id, date) {
  return ((data.plan && data.plan.opening && data.plan.opening.representedEvents) || [])
    .some(row => row && row.id === id && row.date === date
      && (!Object.hasOwn(row, 'effectiveAsOf') || row.effectiveAsOf <= data.plan.opening.asOf));
}

function recommend(data) {
  const asOf = data.plan.opening.asOf;
  return Forecast.recommend(data.plan, asOf, {
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
  });
}

function billRow(data, id, date) {
  const rec = recommend(data);
  const bills = (rec.defaultView && rec.defaultView.bills) || [];
  return bills.find(row => row && row.id === id && row.date === date) || null;
}

function rulesFor(eventId) {
  return (identity.rules || []).filter(rule => rule && rule.eventId === eventId);
}

console.log('=== authority homes ===');
{
  ok(debt(canonical, 'triangle') && debt(canonical, 'triangle').statementCloseDay === 17,
    'Triangle close day lives on debts.statementCloseDay');
  ok(debt(canonical, 'mbna') && debt(canonical, 'mbna').statementCloseDay === 6,
    'MBNA close day lives on debts.statementCloseDay');
  ok(/debts\[\]\.statementCloseDay/.test(accountFacts),
    'ACCOUNT_FACTS names debts.statementCloseDay as the runtime close-day home');
  const triangle = rulesFor('triangle');
  const mbna = rulesFor('mbna');
  const mbnaOnce = rulesFor('mbna-aug31');
  ok(triangle.some(rule => rule.atlasAccountId === 'chequing-a'
      && rule.direction === 'debit'
      && rule.postingDateRule === CYCLE
      && (rule.payeePatterns || []).includes('CAN TIRE MC')),
    'Triangle settlement uses observed chequing CAN TIRE MC debit identity');
  ok(mbna.some(rule => rule.atlasAccountId === 'chequing-a'
      && rule.direction === 'debit'
      && rule.postingDateRule === CYCLE
      && (rule.payeePatterns || []).includes('MBNA M/C')),
    'MBNA settlement uses observed chequing MBNA M/C debit identity');
  ok(mbnaOnce.some(rule => rule.atlasAccountId === 'chequing-a'
      && rule.direction === 'debit'
      && rule.postingDateRule === CYCLE),
    'mbna-aug31 uses the same observed chequing identity');
  ok(mbna.some(rule => rule.atlasAccountId === 'mbna'
      && rule.direction === 'credit'
      && rule.payeeMatchMode === 'exact'
      && (rule.payeePatterns || []).includes('payment')),
    'MBNA card-side identity exact-matches the observed payee payment');
  ok(mbnaOnce.some(rule => rule.atlasAccountId === 'mbna'
      && rule.direction === 'credit'
      && rule.payeeMatchMode === 'exact'
      && (rule.payeePatterns || []).includes('payment')),
    'mbna-aug31 card-side identity exact-matches the observed payee payment');
  ok(mbna.filter(rule => rule.atlasAccountId === 'chequing-a')
      .every(rule => rule.payeeMatchMode !== 'exact'
        && (rule.payeePatterns || []).includes('MBNA M/C')),
    'chequing MBNA M/C identity stays substring and is not exact-only');
  ok(rulesFor('travel').every(rule => rule.postingDateRule === DUE_ON_OR_BEFORE),
    'Travel Visa keeps covers-due-on-or-before-posting');
  ok(rulesFor('cashback').every(rule => rule.postingDateRule === DUE_ON_OR_BEFORE),
    'Cash Back keeps covers-due-on-or-before-posting');
  ok(rulesFor('tdcc').every(rule => rule.postingDateRule === DUE_ON_OR_BEFORE),
    'TD personal keeps covers-due-on-or-before-posting');
}

console.log('\n=== prepaid helper ===');
{
  const data = planFixture();
  ok(Forecast.prepaidJointCashOutflow(data.plan, 'triangle', TRIANGLE_DUE, HISTORICAL_OPENING),
    'upcoming Triangle minimum is a prepaid joint-cash candidate');
  ok(!Forecast.prepaidJointCashOutflow(data.plan, 'triangle', '2026-09-08', HISTORICAL_OPENING),
    'a date that is not a Triangle due is not a prepaid candidate');
  ok(!Forecast.prepaidJointCashOutflow(data.plan, 'netflix', '2026-09-16', HISTORICAL_OPENING),
    'a future commitment is not a prepaid card-minimum candidate');
}

console.log('\n=== Triangle payment after statement close still needs confirmation ===');
{
  const data = planFixture();
  const report = observe(data, [triangleChequing('2026-09-02', TRIANGLE_MIN)]);
  ok(!hasCandidate(report, 'triangle', TRIANGLE_DUE),
    'statement close and payment alias do not confirm Triangle minimum intent');
  const hit = candidates(report).find(row => row.id === 'triangle' && row.date === TRIANGLE_DUE);
  ok(!hit, 'no Triangle settlement is manufactured from statement-cycle timing');
  const result = overlay(data, [triangleChequing('2026-09-02', TRIANGLE_MIN)]);
  ok(result.data.liveOverlay && result.data.liveOverlay.applied === true,
    'live overlay applies on freshness-qualified cash');
  ok(!represented(result.data, 'triangle', TRIANGLE_DUE),
    'overlay does not represent an unconfirmed Triangle minimum');
  const bill = billRow(result.data, 'triangle', TRIANGLE_DUE);
  ok(bill && bill.status !== 'PAID' && near(bill.remaining, TRIANGLE_MIN),
    'Plan Bills retains the existing Triangle reserve pending confirmation',
    bill && JSON.stringify({ status: bill.status, remaining: bill.remaining, settlement: bill.settlement }));
  const reserved = Forecast.expandEvents(result.data.plan, LIVE_AS_OF, '2026-09-10', {})
    .filter(event => event.id === 'triangle' && event.date === TRIANGLE_DUE);
  ok(reserved.length === 1, 'Forecast reserves the existing Triangle minimum once');
  const action = Forecast.currentPeriodAction(result.data.plan, LIVE_AS_OF, {});
  const actionBill = (action.bills || []).find(row => row.id === 'triangle' && row.date === TRIANGLE_DUE);
  ok(actionBill && actionBill.settlement !== 'represented' && near(actionBill.remaining, TRIANGLE_MIN),
    'currentPeriodAction keeps the unconfirmed minimum reserve');
}

console.log('\n=== Triangle payment before statement close does not settle Sep 7 ===');
{
  const data = planFixture();
  const report = observe(data, [triangleChequing('2026-08-10', 300)]);
  ok(!hasCandidate(report, 'triangle', TRIANGLE_DUE),
    'payment before 17 Aug close does not match Sep 7 Triangle');
  const result = overlay(data, [triangleChequing('2026-08-10', 300)]);
  ok(!represented(result.data, 'triangle', TRIANGLE_DUE),
    'overlay does not represent Sep 7 from a pre-statement payment');
  const bill = billRow(result.data, 'triangle', TRIANGLE_DUE);
  ok(bill && bill.status !== 'PAID' && near(bill.remaining, TRIANGLE_MIN),
    'Sep 7 Triangle remains still due after a pre-statement payment',
    bill && JSON.stringify({ status: bill.status, remaining: bill.remaining }));
}

console.log('\n=== wrong card / account does not settle Triangle ===');
{
  const data = planFixture();
  const savingsDebit = observe(data, [tx({
    account: SAVINGS,
    date: '2026-09-02',
    amount: TRIANGLE_MIN,
    payee: 'Can Tire Mc',
    original: 'CAN TIRE MC 1234',
    category: 'Credit card payment',
  })]);
  ok(!hasCandidate(savingsDebit, 'triangle', TRIANGLE_DUE),
    'CAN TIRE MC on savings does not settle Triangle');
  const triangleCardCredit = observe(data, [tx({
    account: TRIANGLE_CARD,
    date: '2026-09-02',
    amount: -TRIANGLE_MIN,
    payee: 'payment',
    original: 'payment',
  })]);
  ok(!hasCandidate(triangleCardCredit, 'triangle', TRIANGLE_DUE),
    'a mapped Triangle card credit is not an invented Triangle identity');
  const unrelatedTransfer = observe(data, [tx({
    account: CHEQUING_A,
    date: '2026-09-02',
    amount: TRIANGLE_MIN,
    payee: 'TFR-TO C/C',
    original: 'TFR-TO C/C',
    category: 'Transfer',
  })]);
  ok(!hasCandidate(unrelatedTransfer, 'triangle', TRIANGLE_DUE),
    'an unrelated TFR-TO C/C debit does not settle Triangle');
}

console.log('\n=== MBNA statement cycle is not payment intent ===');
{
  const data = planFixture();
  const report = observe(data, [mbnaChequing('2026-09-02', MBNA_MIN)]);
  ok(!hasCandidate(report, 'mbna-aug31', MBNA_AUG31),
    'MBNA payment after statement close leaves minimum intent unconfirmed');
  ok(!hasCandidate(report, 'mbna', '2026-09-30'),
    'the same payment does not also consume the Sep 30 recurring minimum');
  const result = overlay(data, [mbnaChequing('2026-09-02', MBNA_MIN)]);
  ok(!represented(result.data, 'mbna-aug31', MBNA_AUG31),
    'overlay does not represent mbna-aug31 without confirmation');
  const bill = billRow(result.data, 'mbna-aug31', MBNA_AUG31);
  ok(bill && bill.status !== 'PAID' && near(bill.remaining, MBNA_MIN),
    'Aug 31 MBNA remains unconfirmed with its existing reserve',
    bill && JSON.stringify({ status: bill.status, remaining: bill.remaining }));
  const reserved = Forecast.expandEvents(result.data.plan, LIVE_AS_OF, LIVE_AS_OF, {})
    .filter(event => event.id === 'mbna-aug31');
  ok(reserved.length === 1, 'Forecast carries the unconfirmed once reserve exactly once');
}

console.log('\n=== Confirmed sender alone keeps issuer receipt and remaining unavailable ===');
{
  const data = planFixture();
  const sentAmount = 90.11;
  obligation(data.plan, 'mbna-aug31').sentPayments = [{
    scheduledDate: MBNA_AUG31,
    confirmed: true,
    intent: 'minimum',
    debitId: 'invented-mbna-sender-only',
    postedOn: '2026-09-02',
    amount: sentAmount,
    currency: 'cad',
    fundingAccountId: 'chequing-a',
    pending: false,
  }];
  const result = overlay(data, [mbnaChequing('2026-09-02', sentAmount)]);
  const bill = billRow(result.data, 'mbna-aug31', MBNA_AUG31);
  const state = Forecast.cardMinimumState(result.data.plan, LIVE_AS_OF);
  const payment = state.payments.find(row => row.id === 'mbna-aug31');
  ok(!represented(result.data, 'mbna-aug31', MBNA_AUG31),
    'confirmed sender does not manufacture an issuer receipt');
  ok(bill && bill.status !== 'PAID' && bill.remaining === null,
    'sender-only uncertainty withholds remaining instead of claiming another full reserve');
  ok(state.status === 'unavailable' && payment
      && payment.issuerMinimumStatus === 'unconfirmed'
      && payment.cashInclusionStatus === 'unconfirmed'
      && payment.additionalCashRequired === null,
    'missing cash inclusion and issuer receipt remain unavailable');
}

console.log('\n=== MBNA on the wrong card does not settle ===');
{
  const data = planFixture();
  const report = observe(data, [tx({
    account: TRIANGLE_CARD,
    date: '2026-09-02',
    amount: -MBNA_MIN,
    payee: 'payment',
    original: 'payment',
  })]);
  ok(!hasCandidate(report, 'mbna', '2026-09-30')
      && !hasCandidate(report, 'mbna-aug31', MBNA_AUG31),
    'a payment credit on the Triangle card does not settle MBNA');
}

console.log('\n=== amount is coverage after identity ===');
{
  const data = planFixture();
  const report = observe(data, [triangleChequing('2026-09-02', 10)]);
  ok(!hasCandidate(report, 'triangle', TRIANGLE_DUE),
    'a $10 Triangle debit does not cover the $88.88 minimum');
}

console.log('\n=== refund / merchant credit is not a payment ===');
{
  const data = planFixture();
  const chequingCredit = observe(data, [tx({
    account: CHEQUING_A,
    date: '2026-09-02',
    amount: -TRIANGLE_MIN,
    payee: 'Can Tire Mc',
    original: 'CAN TIRE MC 1234',
  })]);
  ok(!hasCandidate(chequingCredit, 'triangle', TRIANGLE_DUE),
    'a chequing credit with CAN TIRE MC is not a Triangle payment');
  const merchantCredit = observe(data, [tx({
    account: MBNA_CARD,
    date: '2026-08-20',
    amount: 40,
    payee: 'Amazon.ca',
    original: 'Amazon.ca',
    category: 'Shopping',
  })]);
  ok(!hasCandidate(merchantCredit, 'mbna', '2026-09-30')
      && !hasCandidate(merchantCredit, 'mbna-aug31', MBNA_AUG31),
    'an MBNA merchant debit/credit is not the card-minimum payment');
  const amazonRefund = observe(data, [tx({
    account: MBNA_CARD,
    date: '2026-08-20',
    amount: -40,
    payee: 'Amazon.ca',
    original: 'Amazon.ca',
    category: 'Shopping',
  })]);
  ok(!hasCandidate(amazonRefund, 'mbna-aug31', MBNA_AUG31),
    'an Amazon refund credit is not payee payment identity');
}

console.log('\n=== observed MBNA card alias payment is not intent ===');
{
  const data = planFixture();
  const report = observe(data, [tx({
    account: MBNA_CARD,
    date: '2026-08-20',
    amount: -MBNA_MIN,
    payee: 'payment',
    original: 'payment',
  })]);
  ok(!hasCandidate(report, 'mbna-aug31', MBNA_AUG31),
    'mapped-MBNA payee payment does not establish minimum intent');
}

console.log('\n=== PAYMENT REVERSAL cannot settle MBNA minima ===');
{
  const data = planFixture();
  const reversal = observe(data, [tx({
    account: MBNA_CARD,
    date: '2026-08-20',
    amount: -MBNA_MIN,
    payee: 'PAYMENT REVERSAL',
    original: 'PAYMENT REVERSAL',
  })]);
  ok(!hasCandidate(reversal, 'mbna', '2026-09-30')
      && !hasCandidate(reversal, 'mbna-aug31', MBNA_AUG31),
    'PAYMENT REVERSAL cannot settle mbna or mbna-aug31');
  const protectionRefund = observe(data, [tx({
    account: MBNA_CARD,
    date: '2026-08-20',
    amount: -MBNA_MIN,
    payee: 'PAYMENT PROTECTION REFUND',
    original: 'PAYMENT PROTECTION REFUND',
  })]);
  ok(!hasCandidate(protectionRefund, 'mbna', '2026-09-30')
      && !hasCandidate(protectionRefund, 'mbna-aug31', MBNA_AUG31),
    'PAYMENT PROTECTION REFUND cannot settle mbna or mbna-aug31');
  const chequingStillSettles = observe(data, [mbnaChequing('2026-09-02', MBNA_MIN)]);
  ok(!hasCandidate(chequingStillSettles, 'mbna-aug31', MBNA_AUG31),
    'MBNA M/C chequing alias does not establish minimum intent');
}

console.log('\n=== Travel Visa / Cash Back / TD posting rule unchanged ===');
{
  const data = planFixture();
  const earlyTravel = observe(data, [tx({
    account: TRAVEL_CARD,
    date: '2026-08-28',
    amount: -TRAVEL_MIN,
    payee: 'PAYMENT-THANKYOU',
    original: 'PAYMENT-THANKYOU',
  })]);
  ok(!hasCandidate(earlyTravel, 'travel', TRAVEL_SEP26),
    'Travel Visa payment on 28 Aug still cannot settle the Sep 26 minimum');
  ok(!hasCandidate(earlyTravel, 'travel', TRAVEL_AUG26),
    'Travel Visa payment on 28 Aug leaves the prior minimum unconfirmed');
  const onDueTravel = observe(data, [tx({
    account: TRAVEL_CARD,
    date: TRAVEL_AUG26,
    amount: -TRAVEL_MIN,
    payee: 'PAYMENT-THANKYOU',
    original: 'PAYMENT-THANKYOU',
  })]);
  ok(!hasCandidate(onDueTravel, 'travel', TRAVEL_AUG26),
    'Travel Visa payment on the due date leaves its intent unconfirmed');
  ok(rulesFor('cashback').some(rule => (rule.payeePatterns || []).includes('PAYMENT-THANKYOU')),
    'Cash Back identity aliases are unchanged');
  ok(rulesFor('tdcc').some(rule => (rule.payeePatterns || []).includes('TFR-TO C/C')),
    'TD personal identity aliases are unchanged');
}

console.log('\n=== represented payment is not Household Budget spending ===');
{
  const classified = Forecast.classifyCurrentPeriodTransaction({
    date: '2026-09-02',
    amount: TRIANGLE_MIN,
    payee: 'Can Tire Mc',
    original_name: 'CAN TIRE MC 1234',
    displayedPayee: 'Can Tire Mc',
    originalMerchant: 'CAN TIRE MC 1234',
    category_name: 'Credit card payment',
    atlasAccountId: 'chequing-a',
  });
  ok(classified.kind === 'card-payment' && classified.householdSpending === false,
    'Triangle chequing payment is card-payment, not household spend',
    JSON.stringify(classified));
  const mbnaClassified = Forecast.classifyCurrentPeriodTransaction({
    date: '2026-09-02',
    amount: MBNA_MIN,
    payee: 'MBNA M/C 5678',
    original_name: 'MBNA M/C 5678',
    displayedPayee: 'MBNA M/C 5678',
    originalMerchant: 'MBNA M/C 5678',
    categoryLabel: 'Credit Card Payment',
    atlasAccountId: 'chequing-a',
    accountRole: 'household-cash',
  });
  ok(mbnaClassified.householdSpending === false
      && mbnaClassified.kind !== 'spend'
      && mbnaClassified.kind !== 'unclassified',
    'MBNA chequing payment is not Household Budget spending',
    JSON.stringify(mbnaClassified));
  const data = planFixture();
  const result = overlay(data, [
    triangleChequing('2026-09-02', TRIANGLE_MIN),
    mbnaChequing('2026-09-02', MBNA_MIN),
  ]);
  const actuals = result.data.liveOverlay && result.data.liveOverlay.currentPeriodActuals;
  const txs = (actuals && actuals.transactions) || [];
  ok(txs.length >= 2, 'overlay actuals include the posted Triangle and MBNA payments');
  ok(txs.every(row => {
    const cls = Forecast.classifyCurrentPeriodTransaction(row, result.data.plan, {
      packet: actuals,
      currentPeriodActuals: actuals,
    });
    return cls.householdSpending === false && cls.kind !== 'spend';
  }), 'classified overlay actuals are not Household Budget spending');
}

console.log('\n=== Invented variable minimum preserves the prior occurrence and future estimates ===');
{
  const make = () => {
    const x = require('./fixtures/card-backfill-data')('mbna', 'invented-mbna-minimum');
    x.asOf = '2026-10-06';
    x.data.meta.asOf = x.data.plan.opening.asOf = '2026-08-19';
    x.data.plan.income[0].anchor = '2026-08-21';
    x.data.plan.income[0].amount = 0;
    x.data.plan.opening.representedEvents = [
      { id: 'invented-mbna-august', date: '2026-08-31', effectiveAsOf: '2026-10-05' },
      { id: 'invented-mbna-minimum', date: '2026-09-30', effectiveAsOf: x.asOf },
    ];
    const sender = (scheduledDate, postedOn, amount, debitId, cashIncludedAsOf) => ({
      scheduledDate, confirmed: true, intent: 'minimum', debitId, postedOn,
      amount, currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
      cashIncludedAsOf });
    x.data.plan.obligations = [
      { id: 'invented-mbna-august', label: 'Invented August minimum', debtId: 'mbna',
        effect: 'payment', frequency: 'once', date: '2026-08-31', amount: 11.23,
        payingAccount: 'chequing-a', confidence: 'confirmed',
        sentPayments: [sender('2026-08-31', '2026-09-02', 17.31, 'invented-august-debit', '2026-10-05')] },
      { id: 'invented-mbna-minimum', label: 'Invented monthly minimum', debtId: 'mbna',
        effect: 'payment', frequency: 'monthly', day: 31, firstDue: '2026-09-30',
        amount: 37.89, payingAccount: 'chequing-a', confidence: 'estimated',
        statementOccurrences: [{ scheduledDate: '2026-09-30', dueDate: '2026-09-30',
          minimum: 49.17, currency: 'cad', confidence: 'confirmed' }],
        sentPayments: [sender('2026-09-30', '2026-10-05', 83.41, 'invented-september-debit', x.asOf)] },
    ];
    x.payload.fetchedAt = x.asOf + 'T18:00:00Z';
    x.payload.transactionWindow = { startDate: '2026-08-19', endDate: x.asOf,
      complete: true, hasMore: false, truncated: false };
    x.payload.accounts.forEach(row => { row.updated_at = x.asOf + 'T17:00:00Z'; row.balance_last_update = x.asOf + 'T17:00:00Z'; });
    x.payload.accounts[0].balance = 399.28; // 500 - 17.31 - 83.41.
    x.payload.accounts[3].balance = 326.91; // 400 + 27.63 - 17.31 - 83.41.
    x.payload.transactions = [
      [3004, '2026-10-04', 27.63, 'Invented grocer', 'Groceries'],
      [3001, '2026-09-02', 17.31, 'MBNA M/C', 'Credit Card Payment'],
      [3004, '2026-09-02', -17.31, 'payment', 'Credit Card Payment'],
      [3001, '2026-10-05', 83.41, 'MBNA M/C', 'Credit Card Payment'],
      [3004, '2026-10-05', -83.41, 'payment', 'Credit Card Payment'],
    ].map(([account_id, date, amount, payee, category_name], i) => ({ id: 82001 + i,
      account_id, date, amount, payee, category_name, currency: 'cad',
      is_pending: false, status: 'reviewed', notes: null }));
    return x;
  };
  const x = make(), before = JSON.stringify(x);
  const augustBefore = JSON.stringify(x.data.plan.obligations[0]);
  const early = Forecast.cardMinimumState(x.data.plan, '2026-10-05').payments
    .find(row => row.occurrenceKey === 'invented-mbna-minimum@2026-09-30');
  ok(early && early.issuerMinimumStatus === 'unconfirmed' && early.additionalCashRequired === null,
    'confirmation cannot settle an opening earlier than its qualification');
  const result = Live.fromObservation(x);
  const state = Forecast.cardMinimumState(result.data.plan, x.asOf);
  ok(state.payments.length === 2 && state.payments.every(row => row.issuerMinimumStatus === 'satisfied'
      && row.additionalCashRequired === 0)
      && near(state.payments.find(row => row.occurrenceKey === 'invented-mbna-minimum@2026-09-30').cashPaid, 83.41)
      && near(state.payments.find(row => row.occurrenceKey === 'invented-mbna-august@2026-08-31').cashPaid, 17.31),
    'two separate original occurrences keep their own payments and qualification');
  const events = Forecast.expandEvents(result.data.plan, '2026-10-01', '2026-11-30')
    .filter(row => row.id === 'invented-mbna-minimum');
  ok(events.length === 2 && events.every(row => near(-row.amount, 37.89)
      && row.confidence === 'estimated')
      && events.map(row => row.date).join(',') === '2026-10-31,2026-11-30',
    'one confirmed variable minimum does not change or pay future month-end estimates');
  const unqualified = clone(x.data.plan);
  unqualified.opening.representedEvents = [];
  delete unqualified.obligations[1].sentPayments;
  const original = Forecast.expandEvents(unqualified, '2026-09-30', '2026-09-30')
    .find(row => row.id === 'invented-mbna-minimum');
  ok(original && near(-original.amount, 49.17) && original.confidence === 'confirmed',
    'the independent current minimum replaces its estimate exactly once');
  const actuals = result.data.liveOverlay.currentPeriodActuals;
  const spend = actuals.transactions.reduce((sum, row) => sum
    + (Forecast.classifyCurrentPeriodTransaction(row, result.data.plan, { currentPeriodActuals: actuals })
      .householdSpending ? Number(row.amount) : 0), 0);
  ok(result.data.liveOverlay.applied && near(spend, 27.63)
      && near(cashValue(result.data, 'chequing-a'), 399.28)
      && near(Forecast.projectDebts(result.data.plan, result.data.debts, x.asOf,
        { debtHorizonDays: 2 }).byId.mbna.balance, 326.91),
    'purchase is spending once; both paired transfers and confirmed payments do not replay cash or principal');
  ok(JSON.stringify(x) === before
      && JSON.stringify(result.data.plan.obligations[0]) === augustBefore,
    'input evidence and the prior August occurrence are unchanged');
  const replay = Live.fromObservation(x);
  ok(near(cashValue(replay.data, 'chequing-a'), 399.28)
      && JSON.stringify(replay.data.debts) === JSON.stringify(result.data.debts),
    'replaying the same observation does not deduct either payment again');
  for (const [label, change] of [
    ['purchase backfill', { intent: 'purchase-backfill' }],
    ['unknown payment intent', { intent: 'unconfirmed' }],
    ['pending payment', { pending: true }],
    ['unconfirmed sender', { confirmed: false }],
  ]) {
    const candidate = make();
    candidate.data.plan.opening.representedEvents.pop();
    Object.assign(candidate.data.plan.obligations[1].sentPayments[0], change);
    const candidateBefore = JSON.stringify(candidate);
    const observed = Live.fromObservation(candidate);
    const payments = Forecast.cardMinimumState(observed.data.plan, candidate.asOf).payments;
    ok(!payments.some(row => row.id === 'invented-mbna-minimum'
        && row.issuerMinimumStatus === 'satisfied')
        && !(observed.data.plan.opening.representedEvents || [])
          .some(row => row.id === 'invented-mbna-minimum'),
      label + ': matching posted transfer pairs do not manufacture current-minimum confirmation');
    ok(near(cashValue(observed.data, 'chequing-a'), 399.28)
        && near(observed.data.debts[0].balance, 326.91)
        && JSON.stringify(candidate) === candidateBefore,
      label + ': observed stocks remain conserved and evidence remains immutable');
  }
}

console.log('\n=== cash is not reserved twice; canonical is not rewritten ===');
{
  const data = planFixture();
  const without = Forecast.simulate(data.plan, HISTORICAL_OPENING, { viewDays: 30 });
  const withRep = Forecast.simulate(data.plan, HISTORICAL_OPENING, {
    viewDays: 30,
    representedEvents: [{ id: 'triangle', date: TRIANGLE_DUE }],
  });
  ok(near(withRep.ending - without.ending, TRIANGLE_MIN),
    'representing Triangle releases exactly the synthetic minimum from the cash walk',
    `${without.ending} -> ${withRep.ending}`);
  const result = overlay(data, [triangleChequing('2026-09-02', TRIANGLE_MIN)]);
  ok(JSON.stringify(result.data.plan.obligations) === JSON.stringify(data.plan.obligations),
    'overlay does not rewrite the Triangle/MBNA schedule');
  ok(fs.readFileSync(DATA_PATH, 'utf8') === canonicalFileBefore,
    'observer and overlay do not mutate data.json');
  const overlayBlob = JSON.stringify(result.data.liveOverlay || {});
  ok(O.identityProofLooksSanitized(result.data.liveOverlay)
      && !/"providerTransactionId"\s*:/.test(overlayBlob)
      && !/"lunchMoneyId"\s*:/.test(overlayBlob),
    'live overlay metadata does not leak provider transaction ids');
  const receipt = result.report && result.report.obligationReconciliationReceipt;
  ok(receipt && O.reconciliationReceiptLooksSanitized(receipt),
    'obligation reconciliation receipt stays sanitized');
}

console.log('\n=== Generic transfers and matching card reductions leave minimum allocation unknown ===');
{
  const make = () => {
    const x = require('./fixtures/card-backfill-data')('cashback', 'invented-cashback-minimum');
    const cards = ['cashback', 'travelvisa', 'tdcc'];
    const opening = [700, 400, 300], sends = [93.14, 61.27, 32.08];
    x.data.plan.income[0].amount = 0;
    x.data.plan.budget.categories = [];
    x.data.debts = cards.map((id, i) => ({ ...clone(x.data.debts[0]), id,
      label: 'Invented card ' + i, balance: opening[i] }));
    x.data.plan.obligations = cards.slice(0, 2).map((id, i) => ({
      ...clone(x.data.plan.obligations[0]), id: 'invented-' + id + '-minimum',
      debtId: id, amount: [37.89, 12.34][i] }));
    x.accountMap.mappings.push(...cards.slice(1).map((id, i) => ({
      providerAccountId: String(3005 + i), canonical: { collection: 'debts', id },
      atlasRole: 'revolving-credit' })));
    x.payload.accounts = x.payload.accounts.slice(0, 3).concat(cards.map((id, i) => ({
      ...clone(x.payload.accounts[3]), id: 3004 + i, name: 'Invented card ' + i,
      balance: Math.round((opening[i] - sends[i]) * 100) / 100 })));
    x.payload.accounts[0].balance = 313.51; // 500 - 93.14 - 61.27 - 32.08.
    x.payload.transactions = sends.map((amount, i) => ({ id: 81001 + i,
      account_id: 3001, date: x.asOf, amount, currency: 'cad',
      payee: 'TFR-TO C/C', category_name: 'Credit Card Payment',
      is_pending: false, status: 'reviewed', notes: null }));
    return x;
  };
  for (const [label, alter] of [
    ['matching reductions without receiving rows', () => {}],
    ['free-text minimum purpose without card identity', x => {
      x.payload.transactions[1].notes = 'This is the minimum payment.';
    }],
    ['a receiving card credit without confirmed minimum purpose', x => {
      x.payload.transactions.push({ id: 81004, account_id: 3005, date: x.asOf,
        amount: -61.27, currency: 'cad', payee: 'PAYMENT - THANK YOU',
        category_name: 'Credit Card Payment', is_pending: false, status: 'reviewed' });
    }],
    ['a Phoenix purchase backfill on another card', x => {
      x.data.plan.obligations[1].sentPayments = [{ scheduledDate: x.asOf,
        confirmed: true, intent: 'purchase-backfill', debitId: 'invented-phoenix-transfer',
        postedOn: x.asOf, amount: 61.27, currency: 'cad', fundingAccountId: 'chequing-a',
        pending: false, cashIncludedAsOf: x.asOf }];
    }],
  ]) {
    const x = make();
    alter(x);
    const before = JSON.stringify(x);
    const result = Live.fromObservation(x);
    const advice = Forecast.recommend(result.data.plan, x.asOf, { debts: result.data.debts,
      currentPeriodActuals: result.data.liveOverlay.currentPeriodActuals });
    const rows = advice.defaultView.bills.filter(row => /^invented-/.test(row.id));
    ok(result.data.liveOverlay.applied && rows.length === 2
        && rows.every(row => row.status !== 'PAID')
        && near(rows.find(row => row.id === 'invented-cashback-minimum').remaining, 37.89)
        && near(rows.find(row => row.id === 'invented-travelvisa-minimum').remaining, 12.34),
      label + ': both original household minimum reserves remain unconfirmed');
    ok(!(result.data.plan.opening.representedEvents || []).some(row => /^invented-/.test(row.id))
        && Forecast.cardMinimumState(result.data.plan, x.asOf).payments.length === 0,
      label + ': no minimum receipt or allocation is manufactured');
    ok(near(cashValue(result.data, 'chequing-a'), 313.51)
        && result.data.debts.every((row, i) => near(row.balance, [606.86, 338.73, 267.92][i])),
      label + ': observed cash and each card stock include the transfers exactly once');
    ok(JSON.stringify(x) === before, label + ': evidence remains immutable');
    const replay = Live.fromObservation(x);
    ok(near(cashValue(replay.data, 'chequing-a'), 313.51)
        && JSON.stringify(replay.data.debts) === JSON.stringify(result.data.debts),
      label + ': replay does not deduct cash or card principal again');
  }
  const confirmed = make();
  const min = confirmed.data.plan.obligations[0];
  Object.assign(min, { frequency: 'monthly', day: 20, firstDue: confirmed.asOf,
    amount: 37.89, confidence: 'estimated',
    statementOccurrences: [{ scheduledDate: confirmed.asOf, dueDate: confirmed.asOf,
      minimum: 45.67, currency: 'cad', confidence: 'confirmed' }],
    sentPayments: [{ scheduledDate: confirmed.asOf, confirmed: true, intent: 'minimum',
      debitId: 'invented-confirmed-minimum', postedOn: confirmed.asOf, amount: 93.14,
      currency: 'cad', fundingAccountId: 'chequing-a', pending: false,
      cashIncludedAsOf: confirmed.asOf }] });
  delete min.date;
  confirmed.data.plan.opening.representedEvents = [{ id: min.id, date: confirmed.asOf,
    effectiveAsOf: confirmed.asOf }];
  confirmed.data.plan.obligations[1].sentPayments = [{ scheduledDate: confirmed.asOf,
    confirmed: true, intent: 'purchase-backfill', debitId: 'invented-phoenix-transfer',
    postedOn: confirmed.asOf, amount: 61.27, currency: 'cad', fundingAccountId: 'chequing-a',
    pending: false, cashIncludedAsOf: confirmed.asOf }];
  const result = Live.fromObservation(confirmed);
  const state = Forecast.cardMinimumState(result.data.plan, confirmed.asOf);
  ok(state.payments.length === 1 && state.payments[0].id === min.id
      && state.payments[0].cashPaid === 93.14
      && state.payments[0].issuerMinimumStatus === 'satisfied'
      && state.payments[0].additionalCashRequired === 0,
    'independent minimum confirmation uses its own send; Phoenix cannot substitute for it');
  const early = Forecast.cardMinimumState(confirmed.data.plan, '2026-09-19');
  ok(early.payments.length === 0, 'neither send nor qualified receipt settles an earlier opening');
  const events = Forecast.expandEvents(result.data.plan, confirmed.asOf, '2026-11-20', {})
    .filter(row => row.id === min.id);
  ok(events.filter(row => row.date === confirmed.asOf).length === 0
      && events.filter(row => row.date > confirmed.asOf).every(row => near(-row.amount, 37.89)
        && row.confidence === 'estimated') && events.length === 2,
    'one variable minimum is replaced once; later cycles retain the independent estimate');
  ok(near(cashValue(result.data, 'chequing-a'), 313.51)
      && Forecast.projectDebts(result.data.plan, result.data.debts, confirmed.asOf,
        { debtHorizonDays: 2 }).byId.cashback.balance === 606.86,
    'confirmed payment and separate Phoenix backfill do not debit observed cash or principal again');
}

if (failures) {
  console.log(`\nFAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\ntest-card-minimum-settlement: all checks passed');
