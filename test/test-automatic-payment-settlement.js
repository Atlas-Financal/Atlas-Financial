'use strict';

// Focused production-trust proof for automatic-payment settlement. The
// fixture contains synthetic provider ids and sanitized payee shapes only.

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures',
  'automatic-payment-settlement.json');
const MAP_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures',
  'provider-account-map.json');
const IDENTITY_PATH = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const DATA_PATH = path.join(ROOT, 'data.json');
const IDS = [
  'bcaa-aug15-outstanding',
  'icbc-aug15-outstanding',
  'resp-aug15-outstanding',
];
const SCHEDULE_TRUST = 'schedule-trust-on-due';
const NAMED_SCHEDULE_TRUST_IDS = new Set([
  'youtube-premium',
  'spotify',
  'chatgpt-plus-dale',
  'chatgpt-plus-amanda',
  'icloud-storage',
]);
const EXPECTED = 176.82;
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
// Independent invented bill amounts, not values copied from the household.
// The three receipt amounts sum to 176.82 by hand.
function withInventedAutoBills(data) {
  const x = JSON.parse(JSON.stringify(data));
  const amounts = { bcaa: 41.37, icbc: 62.19, resp: 73.26,
    'bcaa-aug15-outstanding': 41.37, 'icbc-aug15-outstanding': 62.19,
    'resp-aug15-outstanding': 73.26 };
  for (const bill of x.plan.bills || []) if (Object.hasOwn(amounts, bill.id)) bill.amount = amounts[bill.id];
  return x;
}
const canonical = withInventedAutoBills(JSON.parse(canonicalFileBefore));
const canonicalBefore = JSON.stringify(canonical);
const fixture = load(FIXTURE_PATH);
const accountMap = load(MAP_PATH);
const identity = load(IDENTITY_PATH);

function observe(payload) {
  return O.observe({
    provider: 'lunchmoney',
    payload,
    accountMap,
    data: canonical,
    identity,
  });
}

function relevantReserve(plan) {
  const asOf = plan.opening.asOf;
  return Forecast.expandEvents(plan, asOf, asOf, {})
    .filter(event => IDS.includes(event.id))
    .reduce((sum, event) => sum - Number(event.amount), 0);
}

function candidatesFor(transactions) {
  const payload = clone(fixture);
  payload.transactions = transactions;
  return observe(payload).representedEventCandidates || [];
}

function isScheduleTrust(candidate) {
  return !!(candidate && (candidate.settlesWhen === SCHEDULE_TRUST
    || candidate.identity === SCHEDULE_TRUST
    || candidate.postingDateRelation === SCHEDULE_TRUST));
}

function isNamedScheduleTrustId(candidate) {
  return !!(candidate && NAMED_SCHEDULE_TRUST_IDS.has(candidate.id));
}

function bankPayeeCandidates(candidates) {
  return (candidates || []).filter(candidate => !isScheduleTrust(candidate));
}

console.log('=== automatic-payment settlement success ===');
const report = observe(fixture);
const candidates = report.representedEventCandidates || [];
const beforeReserve = relevantReserve(canonical.plan);
const result = Live.overlayLiveState({ data: canonical, report });
const afterReserve = relevantReserve(result.data.plan);

ok(near(beforeReserve, EXPECTED),
  'the three unresolved occurrences reserve the fixture amount before trusted posting evidence',
  String(beforeReserve));
const bankHits = bankPayeeCandidates(candidates);
ok(bankHits.length === 3 && IDS.every(id => bankHits.some(candidate => candidate.id === id)),
  'all three sanitized posted transactions identify their exact reserved occurrence',
  bankHits.map(candidate => candidate.id).join(', '));
ok(bankHits.every(candidate => candidate.date === '2026-08-16'
    && candidate.postingDate === '2026-08-17'
    && candidate.postingDateRelation === 'weekend-next-business-day'
    && candidate.direction === 'debit'
    && candidate.amountNotUsed === true),
  'each identity uses debit direction and the bounded weekend-to-next-business-day relation');
ok((candidates || []).filter(isScheduleTrust).every(candidate =>
      candidate.providerTransactionId == null
      && candidate.direction == null
      && isNamedScheduleTrustId(candidate)),
  'named schedule-trust exceptions are not bank-payee automatic-payment identities');
ok(near(afterReserve, 0) && near(beforeReserve - afterReserve, EXPECTED),
  'the live Forecast releases exactly the fixture amount and does not reserve the three obligations again',
  `${beforeReserve} -> ${afterReserve}`);
ok(IDS.every(id => (result.data.plan.opening.representedEvents || [])
    .some(item => item.id === id && item.date === '2026-08-16')),
  'the in-memory opening names each settled id+scheduled-date occurrence');
ok(JSON.stringify(result.data.plan.bills) === JSON.stringify(canonical.plan.bills),
  'settlement leaves the incumbent bill schedule unchanged');
ok(JSON.stringify(canonical) === canonicalBefore
    && fs.readFileSync(DATA_PATH, 'utf8') === canonicalFileBefore,
  'the observer and live overlay do not mutate canonical input');

const expectedById = new Map([
  ['bcaa-aug15-outstanding', 41.37],
  ['icbc-aug15-outstanding', 62.19],
  ['resp-aug15-outstanding', 73.26],
]);
for (const eventId of IDS) {
  const canonicalBill = canonical.plan.bills.find(bill => bill.id === eventId);
  ok(canonicalBill && near(canonicalBill.amount, expectedById.get(eventId))
      && !Forecast.expandEvents(result.data.plan, '2026-08-19', '2026-08-19', {})
        .some(event => event.id === eventId),
    `${eventId} settles its exact reserved amount`);
}

console.log('\n=== automatic-payment settlement fails closed ===');
const bcaa = fixture.transactions.find(tx => tx.id === 8101);
function rejectsBcaa(transactions, label) {
  const hits = candidatesFor(transactions);
  ok(!hits.some(candidate => candidate.id === 'bcaa-aug15-outstanding'), label,
    hits.map(candidate => `${candidate.id}@${candidate.date}`).join(', '));
}

rejectsBcaa([Object.assign({}, bcaa, { is_pending: true })],
  'pending evidence does not settle');
rejectsBcaa([Object.assign({}, bcaa, { contradictoryEvidence: true })],
  'contradictory/untrusted evidence does not settle');
const incompleteWindow = clone(fixture);
incompleteWindow.transactionWindow.complete = false;
incompleteWindow.transactionWindow.truncated = true;
ok(!(observe(incompleteWindow).representedEventCandidates || []).length,
  'an incomplete/truncated posted-transaction window does not settle');
rejectsBcaa([Object.assign({}, bcaa, { account_id: 1002 })],
  'the right alias on the wrong mapped account does not settle');
rejectsBcaa([Object.assign({}, bcaa, { payee: 'Fixture unknown debit' })],
  'the right amount on an unknown payee does not settle');
rejectsBcaa([Object.assign({}, bcaa, { date: '2026-08-18' })],
  'a posting outside same-day or weekend-next-business-day does not settle');
rejectsBcaa([Object.assign({}, bcaa, { amount: -41.37 })],
  'the wrong transaction direction does not settle');
rejectsBcaa([
  Object.assign({}, bcaa, { id: 8201 }),
  Object.assign({}, bcaa, { id: 8202 }),
], 'duplicate candidates for one occurrence do not settle');

const amountOnly = candidatesFor([{
  id: 8203,
  account_id: 1001,
  date: '2026-08-17',
  amount: 41.37,
  is_pending: false,
  payee: 'Fixture amount-only debit',
}]);
ok(bankPayeeCandidates(amountOnly).length === 0,
  'amount and date alone never establish identity');
ok(amountOnly.filter(isScheduleTrust).every(candidate =>
      candidate.providerTransactionId == null
      && isNamedScheduleTrustId(candidate)),
  'schedule-trust on a due date is not amount-and-date bank-payee identity');

const changedAmount = candidatesFor([Object.assign({}, bcaa, { id: 8204, amount: 103 })]);
ok(changedAmount.some(candidate => candidate.id === 'bcaa-aug15-outstanding'
    && near(candidate.observedAmount, 103) && candidate.amountNotUsed === true),
  'a different observed amount still matches only after non-amount identity is complete');

const genericHistorical = Live.overlayLiveState({
  data: canonical,
  report: {
    writesCanonicalState: false,
    fetchedAt: fixture.fetchedAt,
    representedEventCandidates: [{ id: 'bcaa', date: '2026-08-15' }],
    reconciliation: { rows: [] },
  },
});
ok(!(genericHistorical.data.plan.opening.representedEvents || [])
    .some(item => item.id === 'bcaa' && item.date === '2026-08-15')
    && genericHistorical.refused.some(item => item.reason === 'historical-opening-backfill'),
  'generic historical recurring backfill remains refused');

console.log('\n=== aged current-state window still settles a carried once bill ===');
const NOW = '2026-09-01T23:00:00.000Z';
const LIVE_AS_OF = '2026-09-01';
const SCHEDULED = '2026-08-16';
const POSTED = '2026-08-17';
const SYNTHETIC_ID = 'synthetic-auto-aug15';
const SYNTHETIC_AMOUNT = 40;
const livePlanSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'live-plan.js'), 'utf8');
ok(!/CURRENT_STATE_HISTORY_DAYS/.test(livePlanSrc)
    && /postedHistoryDaysForCarriedSettlement/.test(livePlanSrc)
    && /livePostedHistoryDays/.test(livePlanSrc),
  'production live overlay derives posted history from carried settlement, not a hardcoded 14-day fetch');

// Independent window arithmetic. Do not ask postedHistoryDaysForCarriedSettlement
// for the expected ordinary start: 2026-09-01T23:00:00.000Z is 16:00 in
// America/Vancouver, and 14 * 86400000 ms earlier is 2026-08-18 16:00 there.
const ordinaryStartMs = Date.parse(NOW) - 14 * 86400000;
const ordinaryStart = Forecast.financialDate(new Date(ordinaryStartMs).toISOString());
ok(ordinaryStart === '2026-08-18',
  'hand-computed ordinary 14-day start on 1 Sep is 18 August', ordinaryStart);
ok(POSTED < ordinaryStart,
  'the 17 August posting is outside the ordinary 14-day current-state window');
const ordinaryUrl = O.lunchMoneyTransactionsUrl(NOW, 14);
ok(ordinaryUrl.startDate === ordinaryStart && ordinaryUrl.endDate === LIVE_AS_OF,
  'incumbent 14-day URL helper agrees with the hand-computed start');

// Sunday 16 August + weekend-next-business-day = Monday 17 August.
// Earliest permitted posting is the scheduled date itself. 1 Sep minus
// 16 Aug is 16 calendar days.
ok(new Date(`${SCHEDULED}T00:00:00Z`).getUTCDay() === 0
    && Forecast.addDays(SCHEDULED, 1) === POSTED
    && Forecast.diffDays(SCHEDULED, LIVE_AS_OF) === 16,
  'hand-computed weekend posting relation and 16-day lookup span');
const repairedUrl = O.lunchMoneyTransactionsUrl(NOW, 16);
ok(repairedUrl.startDate === SCHEDULED && repairedUrl.startDate <= POSTED,
  'a 16-day posted window independently includes 16 and 17 August');

const historicalOpening = clone(canonical);
historicalOpening.meta.asOf = '2026-08-01';
historicalOpening.plan.opening = Object.assign({}, historicalOpening.plan.opening, {
  asOf: '2026-08-01',
  representedEvents: [],
});
historicalOpening.plan.bills = (historicalOpening.plan.bills || [])
  .filter(bill => !IDS.includes(bill.id))
  .concat([{
    id: SYNTHETIC_ID,
    label: 'Synthetic automatic PAD — 15 August',
    frequency: 'once',
    date: SCHEDULED,
    amount: SYNTHETIC_AMOUNT,
    confidence: 'confirmed',
    payingAccount: 'chequing-a',
  }]);
const syntheticIdentity = {
  schema: identity.schema,
  owns: identity.owns,
  rules: (identity.rules || []).concat([{
    eventId: SYNTHETIC_ID,
    payeePattern: 'SYNTHETIC AUTO PAD',
    payeePatterns: ['SYNTHETIC AUTO PAD'],
    atlasAccountId: 'chequing-a',
    direction: 'debit',
    postingDateRule: 'same-day-or-weekend-next-business-day',
    note: 'Synthetic weekend automatic-payment identity for aged-window settlement.',
  }]),
};
ok(Forecast.carriedOnceJointCashOutflow(
    historicalOpening.plan, SYNTHETIC_ID, SCHEDULED, LIVE_AS_OF),
  'Forecast still carries the synthetic Aug 16 once bill on 1 Sep');
ok(near(Forecast.expandEvents(historicalOpening.plan, LIVE_AS_OF, LIVE_AS_OF, {})
    .filter(event => event.id === SYNTHETIC_ID)
    .reduce((sum, event) => sum - Number(event.amount), 0), SYNTHETIC_AMOUNT),
  'the carried synthetic reserve on 1 Sep is the fixture amount');

const helperDays = O.postedHistoryDaysForCarriedSettlement({
  now: NOW,
  plan: historicalOpening.plan,
  identity: syntheticIdentity,
});
const helperCurrent = Forecast.spendingCycle(historicalOpening.plan, LIVE_AS_OF);
const helperPrevious = Forecast.spendingCycle(
  historicalOpening.plan, Forecast.addDays(helperCurrent.start, -1));
const helperEarliest = helperPrevious && helperPrevious.start < SCHEDULED
  ? helperPrevious.start : SCHEDULED;
let helperSpan = 14;
while (O.lunchMoneyTransactionsUrl(NOW, helperSpan).startDate > helperEarliest
    && helperSpan < 120) {
  helperSpan += 1;
}
ok(helperDays === helperSpan && helperSpan > 16,
  'carried settlement lookup reaches the earlier of the Aug 16 bill and the previous Seaspan cycle',
  String(helperDays) + ' vs ' + helperSpan);
const helperWithDebts = O.postedHistoryDaysForCarriedSettlement({
  now: NOW,
  plan: historicalOpening.plan,
  debts: historicalOpening.debts,
  identity: syntheticIdentity,
});
const liveDays = Live.livePostedHistoryDays(historicalOpening, NOW, syntheticIdentity);
ok(liveDays === helperWithDebts,
  'live overlay uses that same carried-settlement span, including debts.statementCloseDay');
// Independent: carried mbna-aug31 due 2026-08-31, issuer close the 6th, as-of 1 Sep.
ok(liveDays === 26,
  'Triangle/MBNA cycle lookback independently reaches 6 Aug from 1 Sep',
  String(liveDays));
ok(O.lunchMoneyTransactionsUrl(NOW, liveDays).startDate === '2026-08-06'
    && O.lunchMoneyTransactionsUrl(NOW, liveDays).startDate <= POSTED,
  'cycle-aware live fetch still includes the 17 August PAD posting');
const helperUrl = O.lunchMoneyTransactionsUrl(NOW, helperDays);
ok(helperUrl.startDate <= SCHEDULED && helperUrl.startDate <= POSTED
    && helperUrl.startDate <= helperPrevious.start,
  'repaired observation path still considers the 17 August posting and the previous Seaspan start');

const futureOnly = clone(historicalOpening);
futureOnly.plan.bills = (futureOnly.plan.bills || [])
  .filter(bill => bill.id !== SYNTHETIC_ID)
  .concat([{
    id: 'synthetic-future-once',
    frequency: 'once',
    date: '2026-09-15',
    amount: 10,
    payingAccount: 'chequing-a',
  }]);
const futureCurrent = Forecast.spendingCycle(futureOnly.plan, LIVE_AS_OF);
const futurePrevious = Forecast.spendingCycle(
  futureOnly.plan, Forecast.addDays(futureCurrent.start, -1));
ok(futurePrevious && futurePrevious.start === '2026-08-14',
  'on 1 Sep the previous Seaspan cycle starts 14 Aug',
  futurePrevious && futurePrevious.start);
let futureSpan = 14;
while (O.lunchMoneyTransactionsUrl(NOW, futureSpan).startDate > futurePrevious.start
    && futureSpan < 120) {
  futureSpan += 1;
}
ok(futureSpan > 14
    && O.lunchMoneyTransactionsUrl(NOW, futureSpan).startDate <= '2026-08-14'
    && O.lunchMoneyTransactionsUrl(NOW, futureSpan - 1).startDate > '2026-08-14',
  'the previous Seaspan start is outside the ordinary 14-day window and inside the next span',
  String(futureSpan));
ok(O.postedHistoryDaysForCarriedSettlement({
    now: NOW,
    plan: futureOnly.plan,
    identity: syntheticIdentity,
  }) === futureSpan,
  'nothing old is carried, and the read-only window still reaches the previous Seaspan cycle',
  String(futureSpan));
const noPayroll = clone(futureOnly);
noPayroll.plan.income = (noPayroll.plan.income || [])
  .filter(row => !(row && (row.id === 'payroll' || /seaspan/i.test(row.label || ''))));
ok(O.postedHistoryDaysForCarriedSettlement({
    now: NOW,
    plan: noPayroll.plan,
    identity: syntheticIdentity,
  }) === 14,
  'ordinary 14-day current-state fetch remains when no Seaspan cycle and nothing old is carried');

const ancient = clone(historicalOpening);
ancient.plan.bills = (ancient.plan.bills || [])
  .filter(bill => bill.id !== SYNTHETIC_ID)
  .concat([{
    id: SYNTHETIC_ID,
    frequency: 'once',
    date: '2025-12-01',
    amount: SYNTHETIC_AMOUNT,
    payingAccount: 'chequing-a',
  }]);
ok(O.postedHistoryDaysForCarriedSettlement({
    now: NOW,
    plan: ancient.plan,
    identity: syntheticIdentity,
  }) === 120,
  'carried settlement lookup is capped at the incumbent 120-day reconcile horizon');

const settlementMap = {
  schema: 'atlas-provider-account-map/v1',
  provider: 'lunchmoney',
  scope: 'fixture',
  mappings: [
    {
      providerAccountId: '1001',
      canonical: { collection: 'cash', id: 'chequing-a' },
      atlasRole: 'household-cash',
    },
    {
      providerAccountId: '1002',
      canonical: { collection: 'cash', id: 'chequing-b' },
      atlasRole: 'household-cash',
    },
    {
      providerAccountId: '1003',
      canonical: { collection: 'cash', id: 'savings' },
      atlasRole: 'household-cash',
    },
  ],
};
function agedPayload(transactions, windowStart) {
  const cashAt = '2026-09-01T22:00:00.000Z';
  return {
    provider: 'lunchmoney',
    fetchedAt: NOW,
    transactionWindow: {
      startDate: windowStart,
      endDate: LIVE_AS_OF,
      complete: true,
      hasMore: false,
      truncated: false,
    },
    pendingCoverage: {
      complete: true,
      basis: 'is_pending-unbounded',
      hasMore: false,
      truncated: false,
    },
    accounts: [
      {
        id: 1001, name: 'Fixture Chequing A', type: 'cash',
        balance: 1000, updated_at: cashAt, balance_as_of: cashAt,
      },
      {
        id: 1002, name: 'Fixture Chequing B', type: 'cash',
        balance: 200, updated_at: cashAt, balance_as_of: cashAt,
      },
      {
        id: 1003, name: 'Fixture Savings', type: 'cash',
        balance: 300, updated_at: cashAt, balance_as_of: cashAt,
      },
    ],
    transactions,
  };
}
const syntheticTx = { currency: 'cad',
  id: 9101,
  account_id: 1001,
  date: POSTED,
  amount: SYNTHETIC_AMOUNT,
  is_pending: false,
  payee: 'SYNTHETIC AUTO PAD',
};
const unrelatedHistoricalTx = {
  id: 9199,
  account_id: 1001,
  date: '2026-08-10',
  amount: 25,
  is_pending: false,
  payee: 'Fixture unrelated historical debit',
};

function observeAged(payload) {
  return O.observe({
    provider: 'lunchmoney',
    payload,
    accountMap: settlementMap,
    data: historicalOpening,
    identity: syntheticIdentity,
  });
}

const inWindowDecoy = { currency: 'cad',
  id: 9102,
  account_id: 1001,
  date: '2026-08-20',
  amount: SYNTHETIC_AMOUNT,
  is_pending: false,
  payee: 'SYNTHETIC AUTO PAD',
};

const missed = observeAged(agedPayload([inWindowDecoy], ordinaryStart));
ok(!(missed.representedEventCandidates || []).some(candidate => candidate.id === SYNTHETIC_ID),
  'the ordinary 14-day window alone does not discover the 17 August posting');

const agedReport = observeAged(agedPayload(
  [syntheticTx, unrelatedHistoricalTx], SCHEDULED));
// Schedule-trust occurrences after the Aug 1 opening are owner-trusted from the
// schedule, not transaction identity; this check is about the aged posting.
const agedHits = (agedReport.representedEventCandidates || [])
  .filter(candidate => candidate.identity !== 'schedule-trust-on-due');
ok(agedHits.length === 1 && agedHits[0].id === SYNTHETIC_ID
    && agedHits[0].date === SCHEDULED
    && agedHits[0].postingDate === POSTED
    && agedHits[0].postingDateRelation === 'weekend-next-business-day'
    && agedHits[0].amountNotUsed === true,
  'transaction identity names the exact carried occurrence from the aged posting');

const historicalBeforeOverlay = JSON.stringify(historicalOpening);
const agedResult = Live.overlayLiveState({ data: historicalOpening, report: agedReport });
const agedReserve = Forecast.expandEvents(agedResult.data.plan, LIVE_AS_OF, LIVE_AS_OF, {})
  .filter(event => event.id === SYNTHETIC_ID)
  .reduce((sum, event) => sum - Number(event.amount), 0);
ok(agedResult.data.liveOverlay && agedResult.data.liveOverlay.applied === true,
  'aged-window overlay applies in memory');
ok((agedResult.data.plan.opening.representedEvents || [])
    .some(item => item.id === SYNTHETIC_ID && item.date === SCHEDULED),
  'live overlay records the carried occurrence as represented in memory');
ok(near(agedReserve, 0),
  'the carried synthetic reserve becomes the fixture amount after trusted settlement');
ok(!Forecast.expandEvents(agedResult.data.plan, LIVE_AS_OF, LIVE_AS_OF, {})
    .some(event => event.id === SYNTHETIC_ID),
  'no second subtraction of the represented synthetic occurrence');
ok(!(agedResult.data.plan.opening.representedEvents || [])
    .some(item => item.date === '2026-08-10'),
  'unrelated historical transactions do not backfill the opening');
ok(JSON.stringify(historicalOpening) === historicalBeforeOverlay
    && fs.readFileSync(DATA_PATH, 'utf8') === canonicalFileBefore
    && JSON.stringify(canonical) === canonicalBefore,
  'the aged-window path does not mutate canonical data.json');

const productionDays = O.postedHistoryDaysForCarriedSettlement({
  now: NOW,
  plan: canonical.plan,
  identity,
});
const productionCurrent = Forecast.spendingCycle(canonical.plan, LIVE_AS_OF);
const productionPrevious = Forecast.spendingCycle(
  canonical.plan, Forecast.addDays(productionCurrent.start, -1));
let productionSpan = 14;
const productionEarliest = productionPrevious && productionPrevious.start < '2026-08-16'
  ? productionPrevious.start : '2026-08-16';
while (O.lunchMoneyTransactionsUrl(NOW, productionSpan).startDate > productionEarliest
    && productionSpan < 120) {
  productionSpan += 1;
}
ok(productionDays === productionSpan && productionSpan >= 16,
  'production lookup reaches the earlier of the Aug 15 once-bill posting and the previous Seaspan cycle',
  String(productionDays) + ' vs ' + productionSpan);
const productionWithDebts = O.postedHistoryDaysForCarriedSettlement({
  now: NOW,
  plan: canonical.plan,
  debts: canonical.debts,
  identity,
});
ok(productionWithDebts === 26
    && Live.livePostedHistoryDays(canonical, NOW, identity) === 26,
  'production live overlay with debts.statementCloseDay independently looks back to 6 Aug');
const ordinaryProduction = observe(Object.assign(clone(fixture), {
  fetchedAt: NOW,
  transactions: fixture.transactions.filter(tx => tx.date >= ordinaryStart),
  transactionWindow: {
    startDate: ordinaryStart,
    endDate: LIVE_AS_OF,
    complete: true,
    hasMore: false,
    truncated: false,
  },
})).representedEventCandidates || [];
ok(!IDS.some(id => ordinaryProduction.some(candidate => candidate.id === id)),
  'ordinary 14-day transactions alone cannot identify the three Aug 15 occurrences');
const repairedProduction = observe(Object.assign(clone(fixture), {
  fetchedAt: NOW,
  transactionWindow: {
    startDate: SCHEDULED,
    endDate: LIVE_AS_OF,
    complete: true,
    hasMore: false,
    truncated: false,
  },
})).representedEventCandidates || [];
ok(IDS.every(id => repairedProduction.some(candidate => candidate.id === id
    && candidate.date === SCHEDULED && candidate.postingDate === POSTED)),
  'the repaired window still identifies BCAA, ICBC, and RESP from the 17 August postings');


if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAutomatic-payment settlement proofs passed.');
