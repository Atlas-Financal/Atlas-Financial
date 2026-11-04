'use strict';

// A posted PAYMENT - THANK YOU credit on the mapped TD, Cash Back, or
// Travel Visa account is a balance movement with unconfirmed minimum intent.
// Synthetic cents (L-006). Fixture account ids 3001–3011 are not live ids.

const fs = require('fs');
const path = require('path');
const Forecast = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');
const Live = require('../scripts/live-plan.js');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const IDENTITY_PATH = path.join(ROOT, 'docs', 'connectivity', 'transaction-identity.json');
const MAP_PATH = path.join(ROOT, 'docs', 'connectivity', 'fixtures', 'b81-account-map.json');

const LIVE_PAYEE = 'PAYMENT - THANK YOU';
const UNRELATED = 12.12;
const CHEQUING_A = 3001;
const CHEQUING_B = 3002;
const SAVINGS = 3003;
const TDCC_CARD = 3004;
const CASHBACK_CARD = 3005;
const TRAVEL_CARD = 3006;

const CARDS = [
  {
    eventId: 'travel',
    atlas: 'travelvisa',
    provider: TRAVEL_CARD,
    due: '2026-08-26',
    laterDue: '2026-09-26',
    beforeDue: '2026-08-25',
    afterCloseBeforeDue: '2026-09-06',
    upcomingAfterClose: '2026-09-26',
    coveredOnOrBeforeClose: '2026-08-26',
    min: 15.15,
    short: 15.14,
    extra: 24.24,
  },
  {
    eventId: 'cashback',
    atlas: 'cashback',
    provider: CASHBACK_CARD,
    due: '2026-10-01',
    laterDue: '2026-11-01',
    beforeDue: '2026-09-30',
    afterCloseBeforeDue: '2026-09-08',
    upcomingAfterClose: '2026-10-01',
    min: 22.22,
    short: 22.21,
    extra: 31.31,
  },
  {
    eventId: 'tdcc',
    atlas: 'tdcc',
    provider: TDCC_CARD,
    due: '2026-09-17',
    laterDue: '2026-10-17',
    beforeDue: '2026-09-16',
    afterCloseBeforeDue: '2026-08-24',
    upcomingAfterClose: '2026-09-17',
    min: 33.33,
    short: 33.32,
    extra: 40.4,
  },
];

let failures = 0;
let seq = 93000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function near(actual, expected) {
  return Math.abs(Number(actual) - Number(expected)) < 0.005;
}

function roundCent(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
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

function obligation(plan, id) {
  return ((plan && plan.obligations) || []).find(row => row && row.id === id) || null;
}

function debt(data, id) {
  return (data.debts || []).find(row => row && row.id === id) || null;
}

function cashValue(data, id) {
  const rows = (data.plan && data.plan.startingCash && data.plan.startingCash.breakdown) || [];
  const row = rows.find(r => r && r.id === id);
  return row ? Number(row.value) : null;
}

function rulesFor(eventId) {
  return (identity.rules || []).filter(rule => rule && rule.eventId === eventId);
}

function planFixture() {
  const data = clone(canonical);
  for (const card of CARDS) {
    const row = obligation(data.plan, card.eventId);
    if (!row) throw new Error('missing obligation ' + card.eventId);
    row.amount = card.min;
  }
  return data;
}

function mapWithMbna() {
  const map = load(MAP_PATH);
  map.mappings = map.mappings.concat([{
    providerAccountId: '3011',
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

function matchingAccounts(data, asOf) {
  const updated = asOf + 'T17:55:00.000Z';
  return [
    {
      id: CHEQUING_A, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-a'), updated_at: updated, balance_last_update: updated,
    },
    {
      id: CHEQUING_B, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'chequing-b'), updated_at: updated, balance_last_update: updated,
    },
    {
      id: SAVINGS, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: cashValue(data, 'savings'), updated_at: updated, balance_last_update: updated,
    },
    {
      id: TDCC_CARD, name: 'PERSONAL CREDIT CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'tdcc').balance, credit_limit: debt(data, 'tdcc').limit,
      updated_at: updated, balance_last_update: updated,
    },
    {
      id: CASHBACK_CARD, name: 'TD CASH BACK VISA* CARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'cashback').balance, credit_limit: debt(data, 'cashback').limit,
      updated_at: updated, balance_last_update: updated,
    },
    {
      id: TRAVEL_CARD, name: 'TRAVEL VISA', type: 'credit', subtype: 'credit_card',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'travelvisa').balance, credit_limit: debt(data, 'travelvisa').limit,
      updated_at: updated, balance_last_update: updated,
    },
    {
      id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'heloc').balance, updated_at: updated, balance_last_update: updated,
    },
    {
      id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage',
      institution_name: 'TD Canada Trust', currency: 'cad',
      balance: debt(data, 'mortgage').balance, updated_at: updated, balance_last_update: updated,
    },
    {
      id: 3010, name: 'TRIANGLE MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'Canadian Tire Bank', currency: 'cad',
      balance: debt(data, 'triangle').balance, credit_limit: debt(data, 'triangle').limit,
      updated_at: updated, balance_last_update: updated,
    },
    {
      id: 3011, name: 'AMAZON MBNA MASTERCARD', type: 'credit', subtype: 'credit_card',
      institution_name: 'MBNA', currency: 'cad',
      balance: debt(data, 'mbna').balance, credit_limit: debt(data, 'mbna').limit,
      updated_at: updated, balance_last_update: updated,
    },
  ];
}

function tx({ account, date, amount, payee, original, category }) {
  seq += 1;
  return {
    id: seq,
    account_id: account,
    date,
    amount,
    payee,
    original_name: original == null ? payee : original,
    category_name: category || null,
    is_pending: false,
    status: 'reviewed',
  };
}

function credit(card, date, amount, payee, original) {
  return tx({
    account: card.provider,
    date,
    amount: -Math.abs(amount),
    payee: payee == null ? LIVE_PAYEE : payee,
    original,
    category: 'Uncategorised',
  });
}

function payload(data, transactions, asOf) {
  return {
    provider: 'lunchmoney',
    fetchedAt: asOf + 'T18:00:00.000Z',
    source: 'Synthetic PAYMENT - THANK YOU card-minimum fixture. Fixture IDs 3001–3011 are not live provider IDs.',
    pendingCoverage: completePendingCoverage(),
    accounts: matchingAccounts(data, asOf),
    transactions: (transactions || []).map(row => ({ currency: 'cad', ...row })),
    transactionWindow: {
      startDate: '2026-07-01',
      endDate: asOf,
      complete: true,
      hasMore: false,
      truncated: false,
    },
  };
}

function observe(data, transactions, asOf) {
  return O.observe({
    provider: 'lunchmoney',
    payload: payload(data, transactions, asOf),
    accountMap: mapWithMbna(),
    data,
    identity,
  });
}

function overlay(data, transactions, asOf) {
  return Live.fromObservation({
    data,
    payload: payload(data, transactions, asOf),
    accountMap: mapWithMbna(),
    identity,
  });
}

function candidates(report) {
  return (report && report.representedEventCandidates) || [];
}

function hitsFor(report, id, date) {
  return candidates(report).filter(row => row && row.id === id && (!date || row.date === date));
}

function representedRows(data, id, date) {
  return ((data.plan && data.plan.opening && data.plan.opening.representedEvents) || [])
    .filter(row => row && row.id === id && (!date || row.date === date));
}

function recommend(data, asOf) {
  return Forecast.recommend(data.plan, asOf, {
    currentPeriodActuals: data.liveOverlay && data.liveOverlay.currentPeriodActuals,
    debts: data.debts,
    revolvingExtra: data.revolvingExtra,
    targetBuffer: data.plan.defaults && data.plan.defaults.targetBuffer,
  });
}

function activePeriod(advice) {
  const periods = (advice && advice.defaultView && advice.defaultView.calendarPeriods) || [];
  return periods.find(row => row && row.id === 'this-pay-period') || null;
}

function otherSpent(advice) {
  const period = activePeriod(advice);
  const other = ((period && period.householdBudget) || []).find(row => row && row.otherSpending);
  return other ? Number(other.spent) : 0;
}

function reconHits(advice, amount) {
  const period = activePeriod(advice);
  const hits = [];
  for (const row of (period && period.householdBudget) || []) {
    for (const txRow of (row && row.recon) || []) {
      if (txRow && near(txRow.amount, amount)) hits.push({ row, tx: txRow });
    }
  }
  return hits;
}

console.log('=== shared incumbent identity, one new posted alias ===');
{
  const patternKey = JSON.stringify(['TFR-TO C/C', 'PAYMENT-THANKYOU', 'PAYMENT THANK YOU', LIVE_PAYEE]);
  ok(CARDS.length === 3, 'the proof covers TD, Cash Back, and Travel Visa');
  for (const card of CARDS) {
    const rules = rulesFor(card.eventId);
    const rule = rules[0];
    ok(rules.length === 1 && rule
        && rule.atlasAccountId === card.atlas
        && rule.direction === 'credit'
        && rule.postingDateRule === 'covers-due-on-or-before-posting'
        && rule.settlesWhen === 'amount-at-least'
        && !rule.payeeMatchMode
        && JSON.stringify(rule.payeePatterns) === patternKey
        && (rule.payeeExcludePatterns || []).includes('REFUND')
        && (rule.payeeExcludePatterns || []).includes('REVERSAL')
        && rules.every(row => row.atlasAccountId !== 'chequing-a'),
      card.eventId + ' keeps account, credit, due-date, and amount-at-least, and adds the live alias');
  }
  const bell = rulesFor('bell')[0];
  const once = rulesFor('bell-sep15-2026')[0];
  ok(bell && bell.atlasAccountId === 'travelvisa' && bell.direction === 'debit'
      && (bell.payeePatterns || []).includes('Bell Mobility')
      && !(bell.payeePatterns || []).includes(LIVE_PAYEE),
    'standing Bell stays a Travel Visa debit and is not this card-payment alias');
  ok(once && once.atlasAccountId === 'chequing-a' && once.settlesWhen === 'two-leg-sum'
      && once.sameAccountSplitLegs === true
      && !(once.payeePatterns || []).includes(LIVE_PAYEE),
    'September Bell stays the two-leg chequing identity');
  const dog = Forecast.classifyCurrentPeriodTransaction({
    date: '2026-09-18',
    amount: 18.18,
    categoryLabel: 'Pets',
    displayedPayee: 'SURREY MEAT',
    originalMerchant: 'SURREY MEAT',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-b',
  }, canonical.plan);
  ok(dog.kind === 'spend' && dog.categoryId === 'pets',
    'Surrey Meat stays Dog food');
}

console.log('\n=== PAYMENT - THANK YOU leaves minimum intent unconfirmed ===');
for (const card of CARDS) {
  const data = planFixture();
  const scheduled = Number(obligation(data.plan, card.eventId).amount);
  ok(near(scheduled, card.min)
      && card.short + 0.005 < scheduled
      && card.min + 0.005 >= scheduled
      && card.extra + 0.005 >= scheduled
      && !near(card.extra, scheduled),
    card.eventId + ' fixture minimum is the scheduled amount; short is below it and extra is above it');
  const posted = credit(card, card.due, card.min);
  const report = observe(data, [posted], card.due);
  const hit = hitsFor(report, card.eventId, card.due);
  const sameTx = candidates(report).filter(row =>
    String(row.providerTransactionId) === String(posted.id));
  ok(hit.length === 0 && sameTx.length === 0,
    card.eventId + ' PAYMENT - THANK YOU credit does not confirm minimum intent');
  ok(!hitsFor(report, card.eventId, card.laterDue).length
      && candidates(report).filter(row => row.id === card.eventId).length === 0,
    card.eventId + ' payment settles neither this nor the next minimum automatically');
  for (const other of CARDS) {
    if (other.eventId === card.eventId) continue;
    ok(!candidates(report).some(row => row.id === other.eventId),
      card.eventId + ' payment does not settle ' + other.eventId);
  }
  const later = credit(card, card.laterDue, card.min);
  const laterReport = observe(data, [later], card.laterDue);
  ok(hitsFor(laterReport, card.eventId, card.laterDue).length === 0
      && !hitsFor(laterReport, card.eventId, card.due).length,
    card.eventId + ' later posting is still unconfirmed minimum intent');
  const pair = [
    credit(card, card.due, card.min),
    credit(card, card.due, card.extra),
  ];
  const paired = observe(data, pair, card.due);
  ok(hitsFor(paired, card.eventId, card.due).length === 0
      && candidates(paired).filter(row => row.id === card.eventId).length === 0,
    'two ' + card.eventId + ' credits on the same due do not establish intent');
}

console.log('\n=== wrong card, wrong direction, wrong date, short payment, amount-only ===');
for (const card of CARDS) {
  const data = planFixture();
  for (const other of CARDS) {
    if (other.eventId === card.eventId) continue;
    const wrong = tx({
      account: other.provider,
      date: card.due,
      amount: -card.min,
      payee: LIVE_PAYEE,
      category: 'Uncategorised',
    });
    const report = observe(data, [wrong], card.due);
    ok(!candidates(report).some(row => row.id === card.eventId),
      LIVE_PAYEE + ' on ' + other.atlas + ' does not settle ' + card.eventId);
  }
  const debit = tx({
    account: card.provider,
    date: card.due,
    amount: card.min,
    payee: LIVE_PAYEE,
    category: 'Uncategorised',
  });
  ok(!hitsFor(observe(data, [debit], card.due), card.eventId, card.due).length,
    'a ' + card.eventId + ' debit of PAYMENT - THANK YOU does not settle the minimum');
  const early = observe(data, [credit(card, card.beforeDue, card.min)], card.beforeDue);
  ok(!hitsFor(early, card.eventId, card.due).length
      && !hitsFor(early, card.eventId, card.laterDue).length,
    card.eventId + ' payment before the due does not settle that minimum');
  const afterClose = observe(data, [credit(card, card.afterCloseBeforeDue, card.extra)], card.afterCloseBeforeDue);
  ok(!hitsFor(afterClose, card.eventId, card.upcomingAfterClose).length,
    card.eventId + ' payment after statement close and before the due does not settle the upcoming minimum');
  if (card.coveredOnOrBeforeClose) {
    ok(hitsFor(afterClose, card.eventId, card.coveredOnOrBeforeClose).length === 0,
      card.eventId + ' previous due is not settlement intent');
  } else {
    ok(!candidates(afterClose).some(row => row.id === card.eventId),
      card.eventId + ' has no earlier due for that posting to cover');
  }
  const short = observe(data, [credit(card, card.due, card.short)], card.due);
  ok(!candidates(short).some(row => row.id === card.eventId),
    card.eventId + ' credit below the scheduled minimum does not settle it');
  const extra = observe(data, [credit(card, card.due, card.extra)], card.due);
  const extraHit = hitsFor(extra, card.eventId, card.due);
  ok(extraHit.length === 0,
    card.eventId + ' credit above the minimum does not confirm minimum intent');
  const amountOnly = tx({
    account: card.provider,
    date: card.due,
    amount: -card.min,
    payee: 'UNKNOWN MERCHANT',
    category: 'Uncategorised',
  });
  ok(!candidates(observe(data, [amountOnly], card.due)).some(row => row.id === card.eventId),
    card.eventId + ' amount and date without the payee do not settle the minimum');
  for (const payee of ['PAYMENT-THANK YOU', 'PAYMENT – THANK YOU']) {
    ok(!candidates(observe(data, [credit(card, card.due, card.min, payee)], card.due))
        .some(row => row.id === card.eventId),
      card.eventId + ' does not treat ' + JSON.stringify(payee) + ' as the live alias');
  }
}

console.log('\n=== refunds and reversals do not settle; chequing TFR-TO C/C does not name a card ===');
{
  const refundPayees = [
    'PAYMENT - THANK YOU REFUND',
    'PAYMENT - THANK YOU REVERSAL',
    'REFUND PAYMENT - THANK YOU',
    'REVERSAL PAYMENT - THANK YOU',
    'PAYMENT REVERSAL',
    'PAYMENT PROTECTION REFUND',
    'REFUND',
    'REVERSAL',
  ];
  for (const card of CARDS) {
    const data = planFixture();
    for (const payee of refundPayees) {
      const report = observe(data, [credit(card, card.due, card.min, payee)], card.due);
      ok(!candidates(report).some(row => row.id === card.eventId),
        card.eventId + ' refuses ' + JSON.stringify(payee));
    }
    const split = credit(card, card.due, card.min, LIVE_PAYEE, 'PAYMENT REVERSAL');
    ok(!candidates(observe(data, [split], card.due)).some(row => row.id === card.eventId),
      card.eventId + ' refuses a live payee whose original name is PAYMENT REVERSAL');
    const chequingTransfer = tx({
      account: CHEQUING_A,
      date: card.due,
      amount: card.min,
      payee: 'TFR-TO C/C',
      category: 'Payment, Transfer',
    });
    const chequingAlias = tx({
      account: CHEQUING_A,
      date: card.due,
      amount: -card.min,
      payee: LIVE_PAYEE,
      category: 'Uncategorised',
    });
    const chequingReport = observe(data, [chequingTransfer, chequingAlias], card.due);
    ok(!candidates(chequingReport).some(row => row.id === card.eventId
        || row.atlasAccountId === 'chequing-a'),
      'chequing TFR-TO C/C and a chequing PAYMENT - THANK YOU do not settle ' + card.eventId);
  }
}

console.log('\n=== existing payment aliases do not establish minimum intent ===');
for (const alias of ['PAYMENT-THANKYOU', 'PAYMENT THANK YOU', 'TFR-TO C/C']) {
  for (const card of CARDS) {
    const data = planFixture();
    const report = observe(data, [credit(card, card.due, card.min, alias)], card.due);
    const hit = hitsFor(report, card.eventId, card.due);
    ok(hit.length === 0,
      alias + ' on ' + card.atlas + ' leaves ' + card.eventId + ' unconfirmed');
  }
}

console.log('\n=== unconfirmed card payments stay out of Other Spending ===');
for (const card of CARDS) {
  const unrelated = tx({
    account: CHEQUING_A,
    date: card.due,
    amount: UNRELATED,
    payee: 'CORNER STORE MISC',
    category: 'Uncategorised',
  });
  const payment = credit(card, card.due, card.min);
  const debitOnly = overlay(planFixture(), [unrelated], card.due);
  const both = overlay(planFixture(), [unrelated, payment], card.due);
  const debitAdvice = recommend(debitOnly.data, card.due);
  const bothAdvice = recommend(both.data, card.due);
  const paymentHits = reconHits(bothAdvice, card.min).concat(reconHits(bothAdvice, -card.min));
  const unrelatedHits = reconHits(bothAdvice, UNRELATED);
  ok(debitOnly.data.liveOverlay && debitOnly.data.liveOverlay.applied === true
      && both.data.liveOverlay && both.data.liveOverlay.applied === true,
    card.eventId + ' overlay applies for the Other Spending comparison');
  ok(!candidates(debitOnly.report).some(row => row.id === card.eventId)
      && hitsFor(both.report, card.eventId, card.due).length === 0,
    card.eventId + ' card credit does not manufacture minimum settlement');
  ok(near(otherSpent(debitAdvice), UNRELATED)
      && near(otherSpent(bothAdvice), UNRELATED)
      && near(roundCent(otherSpent(bothAdvice) - otherSpent(debitAdvice)), 0),
    card.eventId + ' represented payment adds $0 to Other Spending');
  ok(unrelatedHits.length === 1 && unrelatedHits[0].row.otherSpending === true
      && paymentHits.length === 0,
    'the $' + UNRELATED.toFixed(2) + ' debit is the only Other Spending recon row beside ' + card.eventId);
  const packet = both.data.liveOverlay.currentPeriodActuals;
  const published = ((packet && packet.transactions) || []).find(row =>
    row && row.atlasAccountId === card.atlas && near(row.amount, -card.min));
  const cls = published
    ? Forecast.classifyCurrentPeriodTransaction(published, both.data.plan, {
      packet,
      currentPeriodActuals: packet,
    })
    : null;
  ok(published && published.representedBill !== true
      && cls && cls.householdSpending === false
      && cls.kind !== 'spend',
    'the unconfirmed ' + card.eventId + ' credit is not household spend',
    cls && JSON.stringify(cls));
  ok(representedRows(both.data, 'tdcc', '2026-09-17').length === 1,
    'in-memory opening still names tdcc@2026-09-17 once after the ' + card.eventId + ' overlay');
}

console.log('\n=== canonical owner-gated rows are untouched ===');
{
  const opening = canonical.plan.opening.representedEvents;
  ok(opening.filter(row => row.id === 'tdcc' && row.date === '2026-09-17').length === 1
      && opening.some(row => row.id === 'noble-garbage' && row.date === '2026-09-18')
      && opening.some(row => row.id === 'heloc' && row.date === '2026-09-21'),
    'data.json still names tdcc@2026-09-17, noble-garbage, and heloc');
  ok(fs.readFileSync(DATA_PATH, 'utf8') === canonicalFileBefore,
    'observer and overlay do not mutate data.json');
}

if (failures) {
  console.log(`\nFAILED — ${failures} check(s)`);
  process.exit(1);
}
console.log('\ntest-payment-thank-you-card-minimum: all checks passed');
