'use strict';
/* Owner 2026-09-23: four exact transactions leave Household Budget Other
 * Spending for their confirmed economic identity.
 *
 *   2026-09-20  7-Eleven  $20.00 pending  Travel Visa  → Fuel
 *   2026-09-22  7-Eleven  $75.00 posted   WEEKLY       → Fuel
 *   2026-09-22  PAYPAL MSP $26.87 posted BILLS        → Spotify, once
 *   2026-09-21  Noble Dispo $95.85 posted WEEKLY      → the existing
 *               noble-garbage bill, not a second purchase
 *
 * Not every 7-Eleven, $20, $75, PAYPAL MSP, or Noble Dispo. A
 * provider-directed posted replacement of the $20 remains one fuel
 * purchase. Spotify day 23 supersedes day 17 without a second September
 * occurrence. Synthetic observe fixtures and independent arithmetic
 * (L-002 / L-006). No Lunch Money write.
 *
 * Amendment (Dale 2026-10-14, superseding the 2026-09-23 rule for
 * generic rows): an exact Lunch Money "Fuel" category is itself fuel
 * evidence, and a 7-Eleven purchase over $30 is Fuel. The generic
 * 7-Eleven Fuel rows below therefore classify as Fuel by their
 * category in BOTH snapshots; what this file pins — the exact
 * owner-confirmed identities (Spotify day 23, the Noble occurrence,
 * the pending→posted replacement) — is unchanged. The owner-rule
 * matrix lives in test-fuel-classification-owner-rules.js.
 *
 * `node test/test-owner-confirmed-september-spend.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const O = require('./fixtures/native-cad-observation')(require('../scripts/provider-observe.js'));

const ROOT = path.join(__dirname, '..');
const AS_OF = '2026-09-23';
const OPENING = '2026-08-19';
const TRAVEL = 2004;
const FUEL_CAT = 41;
const FAST_CAT = 42;
const UNCAT = 43;
const TV_CAT = 44;
const SHOP_CAT = 45;

const FUEL_PENDING = 20;
const FUEL_POSTED = 75;
const REPLACEMENT = 21.5;
const SPOTIFY = 26.87;
const NOBLE = 95.85;
const PITT = 40;
const CORNER = 12.34;
const OTHER_711 = 8.4;
const OTHER_PAYPAL = 14.49;
const OTHER_75 = 75;
const OTHER_20 = 20;
const STRAY_NOBLE = 10;
const FAST_FOOD = 3.22;

const JOINS_FUEL = roundCent(FUEL_PENDING + FUEL_POSTED);
const JOINS_BILLS = roundCent(SPOTIFY + NOBLE);
const LEAVES_OTHER = roundCent(JOINS_FUEL + JOINS_BILLS);
const SHARED_OTHER = roundCent(CORNER + OTHER_PAYPAL + STRAY_NOBLE);
const SHARED_FUEL = roundCent(PITT + OTHER_711 + OTHER_75 + OTHER_20);

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
function roundCent(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const load = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

ok(near(JOINS_FUEL, 95) && near(JOINS_BILLS, 122.72) && near(LEAVES_OTHER, 217.72)
    && near(SHARED_OTHER, 36.83) && near(SHARED_FUEL, 143.40),
  'independent cents: fuel pair $95.00, Spotify+Noble $122.72, shared rows leave $36.83 in Other and $143.40 in Fuel under the 2026-10-14 rules');

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function accountMap() {
  const map = load('docs/connectivity/fixtures/provider-account-map.json');
  map.mappings = (map.mappings || []).concat([{
    providerAccountId: String(TRAVEL),
    canonical: { collection: 'debts', id: 'travelvisa' },
    atlasRole: 'revolving-credit',
  }]);
  return map;
}

function payload(asOf, txs) {
  return {
    provider: 'lunchmoney',
    fetchedAt: asOf + 'T18:00:00.000Z',
    transactionWindow: {
      startDate: OPENING,
      endDate: asOf,
      complete: true,
      hasMore: false,
      truncated: false,
    },
    pendingCoverage: {
      complete: true,
      basis: O.PENDING_COVERAGE_BASIS,
      hasMore: false,
      truncated: false,
    },
    accounts: [
      {
        id: 1001, name: 'Fixture Chequing A', type: 'cash', balance: 1000,
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
      {
        id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 400,
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
      {
        id: TRAVEL, name: 'Fixture Travel Visa', type: 'credit',
        balance: 500, credit_limit: 5000,
        updated_at: asOf + 'T17:55:00.000Z', balance_last_update: asOf + 'T17:55:00.000Z',
      },
    ],
    categories: [
      { id: FUEL_CAT, name: 'Fuel', is_income: false, exclude_from_totals: false },
      { id: FAST_CAT, name: 'Fast Food', is_income: false, exclude_from_totals: false },
      { id: UNCAT, name: 'Uncategorised', is_income: false, exclude_from_totals: false },
      { id: TV_CAT, name: 'Tv and movies', is_income: false, exclude_from_totals: false },
      { id: SHOP_CAT, name: 'Shopping', is_income: false, exclude_from_totals: false },
    ],
    transactions: txs || [],
  };
}

function observeAt(asOf, txs) {
  const calls = [];
  const prior = global.fetch;
  global.fetch = (url, init) => {
    calls.push({ url: String(url), method: init && init.method });
    throw new Error('provider request');
  };
  try {
    const report = O.observe({
      provider: 'lunchmoney',
      payload: payload(asOf, txs),
      accountMap: accountMap(),
      data: liveData(),
      identity: identityDoc(),
    });
    ok(calls.length === 0, 'fixture observation performs no provider request');
    return report;
  } finally {
    global.fetch = prior;
  }
}

function tx(id, fields) {
  return Object.assign({
    id,
    account_id: 1002,
    date: '2026-09-13',
    amount: CORNER,
    is_pending: false,
    payee: 'CORNER MARKET',
    original_name: 'CORNER MARKET',
    category_id: UNCAT,
    status: 'cleared',
  }, fields || {});
}

function sharedRows() {
  return [
    tx(61001, {
      date: '2026-09-14', amount: PITT, account_id: 1002,
      payee: 'PITT MEADOWS CE', original_name: 'PITT MEADOWS CE',
      // H1 (lead decision 2026-11-07): the merchant identity applies only
      // to a row Lunch Money left uncategorised.
      category_id: UNCAT,
    }),
    tx(61002, { date: '2026-09-13', amount: CORNER }),
    tx(61003, {
      date: '2026-09-14', amount: OTHER_711, account_id: 1002,
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FUEL_CAT,
    }),
    tx(61004, {
      date: '2026-09-15', amount: OTHER_PAYPAL, account_id: 1001,
      payee: 'PAYPAL MSP', original_name: 'PAYPAL MSP', category_id: TV_CAT,
    }),
    tx(61005, {
      date: '2026-09-16', amount: OTHER_75, account_id: 1002,
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FUEL_CAT,
    }),
    tx(61006, {
      date: '2026-09-18', amount: OTHER_20, account_id: TRAVEL,
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FUEL_CAT,
    }),
    tx(61007, {
      date: '2026-09-19', amount: STRAY_NOBLE, account_id: 1002,
      payee: 'Noble Dispo', original_name: 'NOBLE DISPO _V', category_id: UNCAT,
    }),
    tx(61008, {
      date: '2026-09-12', amount: FAST_FOOD, account_id: 1002,
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FAST_CAT,
    }),
    tx(61009, {
      date: '2026-09-18', amount: NOBLE, account_id: 1002,
      payee: 'Noble Dispo', original_name: 'Noble Dispo', category_id: UNCAT,
    }),
  ];
}

function ownerRows(exact) {
  return [
    tx(62001, {
      date: exact ? '2026-09-20' : '2026-09-19',
      amount: FUEL_PENDING,
      account_id: TRAVEL,
      is_pending: true,
      status: 'pending',
      payee: '7-Eleven',
      original_name: '7-Eleven',
      category_id: FUEL_CAT,
    }),
    tx(62002, {
      date: exact ? '2026-09-22' : '2026-09-21',
      amount: FUEL_POSTED,
      account_id: 1002,
      payee: '7-Eleven',
      original_name: '7-Eleven',
      category_id: FUEL_CAT,
    }),
    tx(62003, {
      date: exact ? '2026-09-22' : '2026-09-21',
      amount: SPOTIFY,
      account_id: 1001,
      payee: 'PAYPAL MSP',
      original_name: 'PAYPAL MSP',
      category_id: TV_CAT,
    }),
    tx(62004, {
      date: exact ? '2026-09-21' : '2026-09-20',
      amount: NOBLE,
      account_id: 1002,
      payee: 'Noble Dispo',
      original_name: 'NOBLE DISPO _V',
      category_id: UNCAT,
    }),
  ];
}

function representedFrom(report) {
  return ((report && report.representedEventCandidates) || [])
    .filter(row => row && row.id && row.date)
    .map(row => ({ id: row.id, date: row.date }));
}

function recommendFrom(report, asOf) {
  const data = liveData();
  const plan = clone(data.plan);
  const represented = representedFrom(report);
  plan.opening = Object.assign({}, plan.opening, {
    asOf,
    priorAsOf: (data.plan.opening && data.plan.opening.asOf) || OPENING,
    representedEvents: represented,
  });
  return F.recommend(plan, asOf, {
    debts: data.debts,
    currentPeriodActuals: report.currentPeriodActuals,
    representedEvents: represented,
    preservePaydayPeriodOrigin: true,
  });
}

function activePeriod(advice) {
  const periods = (advice && advice.defaultView && advice.defaultView.calendarPeriods) || [];
  return periods.find(p => p && p.id === 'this-pay-period')
    || periods.find(p => p && p.role === 'active')
    || null;
}

function budgetRow(period, id) {
  return ((period && period.householdBudget) || []).find(row => row && row.id === id) || null;
}

function otherRow(period) {
  return ((period && period.householdBudget) || []).find(row => row && row.otherSpending) || null;
}

function spentOf(row) {
  return roundCent(Number(row && row.spent) || 0);
}

function householdSpent(period) {
  return roundCent(((period && period.householdBudget) || []).reduce((sum, row) => {
    return sum + (Number(row && row.spent) || 0);
  }, 0));
}

function reconRows(row) {
  return (row && row.recon) || [];
}

function reconAmounts(row) {
  return reconRows(row).map(item => Number(item && item.amount))
    .filter(amount => isFinite(amount));
}

function countDated(rows, date, amount) {
  return (rows || []).filter(item => item && item.date === date && near(item.amount, amount)).length;
}

function packetTxs(report, pred) {
  const txs = (report && report.currentPeriodActuals && report.currentPeriodActuals.transactions) || [];
  return txs.filter(row => row && (!pred || pred(row)));
}

function classify(row, report) {
  return F.classifyCurrentPeriodTransaction(row, liveData().plan, {
    currentPeriodActuals: report.currentPeriodActuals,
  });
}

function spotifyActuals(report) {
  return ((report.currentPeriodActuals && report.currentPeriodActuals.representedActuals) || [])
    .filter(row => row && row.id === 'spotify');
}

function nobleCandidates(report) {
  return ((report.representedEventCandidates) || [])
    .filter(row => row && row.id === 'noble-garbage');
}

console.log('\n=== canonical Spotify schedule is day 23 from 2026-09-23 ===');
{
  const data = liveData();
  const bill = (data.plan.bills || []).find(row => row && row.id === 'spotify');
  ok(bill && bill.day === 23 && bill.firstDue === '2026-09-23'
      && bill.frequency === 'monthly' && near(bill.amount, SPOTIFY)
      && bill.payingAccount === 'chequing-a',
    'canonical Spotify is $26.87 monthly on the 23rd, first due 2026-09-23');
  const dates = F.expandEvents(data.plan, OPENING, '2026-11-17')
    .filter(event => event && event.id === 'spotify')
    .map(event => event.date);
  ok(dates.join(',') === '2026-09-23,2026-10-23',
    'September Spotify is only 2026-09-23 and October is the 23rd',
    dates.join(','));
  ok(!dates.includes('2026-09-17') && !dates.includes('2026-08-23'),
    'day 23 does not keep 17 September or invent 23 August');
  const rule = (identityDoc().rules || []).find(row => row && row.eventId === 'spotify');
  ok(rule && rule.settlesWhen === 'schedule-trust-on-due' && !rule.payeePattern
      && !/PAYPAL MSP/.test(String(rule.payeePattern || '') + String((rule.payeePatterns || []).join('|'))),
    'Spotify stays schedule-trust; PAYPAL MSP is not a payee alias');
}

console.log('\n=== exact tuples are fuel / Spotify / this Noble row, and nothing wider ===');
{
  const fuel = F.classifyCurrentPeriodTransaction.ownerConfirmedFuel;
  const spotify = F.classifyCurrentPeriodTransaction.ownerConfirmedSpotify;
  const noble = F.classifyCurrentPeriodTransaction.ownerConfirmedNoble;
  ok(fuel({ date: '2026-09-20', amount: 20, payee: '7-Eleven', atlasAccountId: 'travelvisa' })
      && fuel({ date: '2026-09-22', amount: 75, payee: '7-Eleven', account: 'chequing-b' }),
    'the two owner 7-Eleven transactions are fuel');
  ok(!fuel({ date: '2026-09-20', amount: 20, payee: '7-Eleven', atlasAccountId: 'chequing-b' })
      && !fuel({ date: '2026-09-18', amount: 20, payee: '7-Eleven', atlasAccountId: 'travelvisa' })
      && !fuel({ date: '2026-09-16', amount: 75, payee: '7-Eleven', atlasAccountId: 'chequing-b' })
      && !fuel({ date: '2026-09-22', amount: 8.4, payee: '7-Eleven', atlasAccountId: 'chequing-b' }),
    'a different account, date, or amount is not those fuel transactions');
  ok(spotify({
    date: '2026-09-22', amount: 26.87, payee: 'PAYPAL MSP', atlasAccountId: 'chequing-a',
  }), 'the 22 Sep PAYPAL MSP $26.87 on BILLS is the Spotify transaction');
  ok(!spotify({
    date: '2026-09-15', amount: 14.49, payee: 'PAYPAL MSP', atlasAccountId: 'chequing-a',
  }) && !spotify({
    date: '2026-09-22', amount: 26.87, payee: 'PAYPAL MSP', atlasAccountId: 'chequing-b',
  }) && !spotify({
    date: '2026-09-22', amount: 26.87, payee: 'SPOTIFY', atlasAccountId: 'chequing-a',
  }), 'another PAYPAL MSP row, account, or merchant is not Spotify');
  ok(noble({
    date: '2026-09-21', amount: 95.85, originalName: 'NOBLE DISPO _V',
    atlasAccountId: 'chequing-b',
  }), 'the 21 Sep NOBLE DISPO _V $95.85 on WEEKLY is the owner Noble row');
  ok(!noble({
    date: '2026-09-21', amount: 10, payee: 'Noble Dispo', atlasAccountId: 'chequing-b',
  }) && !noble({
    date: '2026-09-20', amount: 95.85, payee: 'Noble Dispo', atlasAccountId: 'chequing-b',
  }) && !noble({
    date: '2026-09-21', amount: 95.85, payee: 'Noble Disposal', atlasAccountId: 'chequing-b',
  }), 'a different Noble amount, date, or merchant key is not that occurrence');
}

function budgetSnapshot(report, asOf) {
  const advice = recommendFrom(report, asOf);
  const period = activePeriod(advice);
  const fuel = budgetRow(period, 'fuel');
  const restaurants = budgetRow(period, 'restaurants');
  const other = otherRow(period);
  return {
    advice,
    period,
    fuelSpent: spentOf(fuel),
    otherSpent: spentOf(other),
    restaurantSpent: spentOf(restaurants),
    household: householdSpent(period),
    fuelRecon: reconRows(fuel),
    otherRecon: reconRows(other),
    restaurantRecon: reconRows(restaurants),
  };
}

console.log('\n=== shifted control vs exact tuples: Other Spending and Fuel ===');
const controlReport = observeAt(AS_OF, sharedRows().concat(ownerRows(false)));
const exactReport = observeAt(AS_OF, sharedRows().concat(ownerRows(true)));
const control = budgetSnapshot(controlReport, AS_OF);
const exact = budgetSnapshot(exactReport, AS_OF);
console.log(`  before Other Spending ${control.otherSpent.toFixed(2)}`);
console.log(`  after Other Spending ${exact.otherSpent.toFixed(2)}`);
console.log(`  before Fuel ${control.fuelSpent.toFixed(2)}`);
console.log(`  after Fuel ${exact.fuelSpent.toFixed(2)}`);
console.log(`  before household ${control.household.toFixed(2)}`);
console.log(`  after household ${exact.household.toFixed(2)}`);

ok(near(control.otherSpent, roundCent(SHARED_OTHER + JOINS_BILLS))
    && near(exact.otherSpent, SHARED_OTHER)
    && near(roundCent(control.otherSpent - exact.otherSpent), JOINS_BILLS),
  'Other Spending falls by $122.72 when the Spotify and Noble rows take their identities (the 7-Eleven Fuel rows are Fuel by category in both snapshots)',
  `before=${control.otherSpent} after=${exact.otherSpent}`);
ok(near(control.fuelSpent, roundCent(SHARED_FUEL + JOINS_FUEL))
    && near(exact.fuelSpent, roundCent(SHARED_FUEL + JOINS_FUEL)),
  'Fuel carries the generic 7-Eleven Fuel rows plus the $95.00 owner pair in both snapshots',
  `before=${control.fuelSpent} after=${exact.fuelSpent}`);
ok(countDated(exact.fuelRecon, '2026-09-20', FUEL_PENDING) === 1
    && countDated(exact.fuelRecon, '2026-09-22', FUEL_POSTED) === 1
    && countDated(exact.fuelRecon, '2026-09-14', PITT) === 1
    && countDated(exact.otherRecon, '2026-09-20', FUEL_PENDING) === 0
    && countDated(exact.otherRecon, '2026-09-22', FUEL_POSTED) === 0,
  'each owner 7-Eleven row is in Fuel once and absent from Other');
ok(countDated(exact.fuelRecon, '2026-09-14', OTHER_711) === 1
    && countDated(exact.fuelRecon, '2026-09-16', OTHER_75) === 1
    && countDated(exact.fuelRecon, '2026-09-18', OTHER_20) === 1
    && countDated(exact.otherRecon, '2026-09-14', OTHER_711) === 0
    && countDated(exact.otherRecon, '2026-09-16', OTHER_75) === 0
    && countDated(exact.otherRecon, '2026-09-18', OTHER_20) === 0,
  'generic 7-Eleven Fuel rows classify as Fuel by their category (Dale 2026-10-14), not by owner identity');
ok(near(control.restaurantSpent, FAST_FOOD) && near(exact.restaurantSpent, FAST_FOOD)
    && countDated(exact.restaurantRecon, '2026-09-12', FAST_FOOD) === 1,
  'the Fast Food 7-Eleven stays eating out');
ok(near(roundCent((control.otherSpent + control.fuelSpent) - (exact.otherSpent + exact.fuelSpent)), JOINS_BILLS)
    && near(roundCent(exact.household + JOINS_BILLS), control.household),
  'household outflow is unchanged: $122.72 moves from Household Budget into the two bills',
  `household before=${control.household} after=${exact.household}`);

console.log('\n=== Spotify is one 23 Sep occurrence, attached to the exact debit ===');
{
  const actuals = spotifyActuals(exactReport);
  const paypal = packetTxs(exactReport, row => near(row.amount, SPOTIFY) && row.date === '2026-09-22');
  const generic = packetTxs(exactReport, row => near(row.amount, OTHER_PAYPAL));
  ok(actuals.length === 1 && actuals[0].date === '2026-09-23'
      && actuals[0].postedOn === '2026-09-22'
      && !actuals.some(row => row && row.date === '2026-09-17'),
    'one Spotify represented actual on 2026-09-23, posted 2026-09-22',
    JSON.stringify(actuals));
  ok(paypal.length === 1 && paypal[0].representedBill === true
      && paypal[0].ownerConfirmedSpotify === true
      && actuals[0].transactionId === paypal[0].id,
    'the exact PAYPAL MSP debit is that one Spotify actual');
  const cls = classify(paypal[0], exactReport);
  ok(cls && cls.kind === 'bill' && cls.householdSpending === false
      && countDated(exact.otherRecon, '2026-09-22', SPOTIFY) === 0,
    'the Spotify debit is a bill and is not Other Spending',
    cls && cls.reason);
  const genericCls = classify(generic[0], exactReport);
  ok(generic.length === 1 && generic[0].ownerConfirmedSpotify !== true
      && generic[0].id !== actuals[0].transactionId
      && genericCls && genericCls.kind !== 'bill'
      && countDated(exact.otherRecon, '2026-09-15', OTHER_PAYPAL) === 1,
    'the other PAYPAL MSP debit stays unresolved and is not attached to Spotify',
    genericCls && genericCls.reason);
  const early = observeAt('2026-09-22', sharedRows().concat(ownerRows(true))
    .filter(row => row.date <= '2026-09-22'));
  const earlyActuals = spotifyActuals(early);
  const earlyPaypal = packetTxs(early, row => near(row.amount, SPOTIFY) && row.date === '2026-09-22');
  const earlyCls = classify(earlyPaypal[0], early);
  const earlyOther = reconRows(otherRow(activePeriod(recommendFrom(early, '2026-09-22'))));
  ok(earlyActuals.length === 0
      && earlyCls && earlyCls.kind === 'bill' && earlyCls.householdSpending === false
      && countDated(earlyOther, '2026-09-22', SPOTIFY) === 0,
    'before the 23rd the debit is already Spotify and the schedule has not emitted a second occurrence',
    `actuals=${earlyActuals.length} reason=${earlyCls && earlyCls.reason}`);
}

console.log('\n=== Noble 21 Sep is the existing bill, counted once ===');
{
  const hits = nobleCandidates(exactReport);
  const posted18 = packetTxs(exactReport, row => near(row.amount, NOBLE) && row.date === '2026-09-18');
  const posted21 = packetTxs(exactReport, row => near(row.amount, NOBLE) && row.date === '2026-09-21');
  const stray = packetTxs(exactReport, row => near(row.amount, STRAY_NOBLE));
  ok(hits.length === 1 && hits[0].date === '2026-09-18' && near(hits[0].observedAmount, NOBLE),
    'noble-garbage still has one settlement candidate, the 18 Sep debit',
    hits.map(hit => `${hit.date}:${hit.observedAmount}`).join(','));
  ok(posted18.length === 1 && posted18[0].representedBill === true,
    'the 18 Sep Noble debit remains the represented bill');
  const cls21 = classify(posted21[0], exactReport);
  ok(posted21.length === 1 && posted21[0].representedBill !== true
      && posted21[0].ownerConfirmedNobleOccurrence === true
      && cls21 && cls21.kind === 'bill' && cls21.reason === 'owner-confirmed-noble-occurrence'
      && cls21.householdSpending === false
      && countDated(exact.otherRecon, '2026-09-21', NOBLE) === 0
      && countDated(exact.otherRecon, '2026-09-18', NOBLE) === 0,
    'the 21 Sep Noble debit is that bill and is not a second settlement or Other Spending',
    cls21 && `${cls21.kind}:${cls21.reason}`);
  const strayCls = classify(stray[0], exactReport);
  ok(strayCls && strayCls.kind !== 'bill'
      && countDated(exact.otherRecon, '2026-09-19', STRAY_NOBLE) === 1
      && nobleCandidates(exactReport).every(hit => hit.date !== '2026-09-19'),
    'a different Noble debit stays Other Spending');
  const next = F.expandEvents(liveData().plan, '2026-12-18', '2026-12-18', { keepRepresented: true })
    .some(event => event && event.id === 'noble-garbage' && event.date === '2026-12-18');
  ok(next, 'the December noble-garbage occurrence is unchanged');
}

console.log('\n=== posted replacement of the $20 pending fuel purchase counts once ===');
{
  function fuelPair(linked) {
    const pending = tx(63001, {
      date: '2026-09-20', amount: FUEL_PENDING, account_id: TRAVEL,
      is_pending: true, status: 'pending',
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FUEL_CAT,
      plaid_metadata: { transaction_id: 'plaid-fuel-pending' },
    });
    const posted = tx(63002, {
      date: '2026-09-22', amount: REPLACEMENT, account_id: TRAVEL,
      payee: '7-ELEVEN 4451', original_name: '7-ELEVEN 4451', category_id: FUEL_CAT,
      plaid_metadata: linked ? {
        transaction_id: 'plaid-fuel-posted',
        pending_transaction_id: 'plaid-fuel-pending',
      } : { transaction_id: 'plaid-fuel-posted-unlinked' },
    });
    return [pending, posted, tx(63003, { date: '2026-09-13', amount: CORNER })];
  }
  const linked = observeAt(AS_OF, fuelPair(true));
  const linkedSnap = budgetSnapshot(linked, AS_OF);
  const survivors = packetTxs(linked, row => near(row.amount, REPLACEMENT) || near(row.amount, FUEL_PENDING));
  ok(survivors.length === 1 && survivors[0].pending !== true
      && near(survivors[0].amount, REPLACEMENT)
      && survivors[0].ownerConfirmedFuel === true
      && countDated(linkedSnap.fuelRecon, '2026-09-22', REPLACEMENT) === 1
      && countDated(linkedSnap.fuelRecon, '2026-09-20', FUEL_PENDING) === 0
      && near(linkedSnap.fuelSpent, REPLACEMENT),
    'the provider-linked posted replacement is one fuel purchase of $21.50',
    `fuel=${linkedSnap.fuelSpent} rows=${survivors.map(row => row.amount + ':' + row.pending).join(',')}`);
  const loose = observeAt(AS_OF, fuelPair(false));
  const looseSnap = budgetSnapshot(loose, AS_OF);
  const looseRows = packetTxs(loose, row => near(row.amount, REPLACEMENT) || near(row.amount, FUEL_PENDING));
  ok(looseRows.length === 2
      && near(looseSnap.fuelSpent, roundCent(FUEL_PENDING + REPLACEMENT))
      && countDated(looseSnap.fuelRecon, '2026-09-22', REPLACEMENT) === 1
      && countDated(looseSnap.otherRecon, '2026-09-22', REPLACEMENT) === 0,
    'without a provider link both rows remain two rows (identity unchanged); each classifies as Fuel by its category under Dale 2026-10-14',
    `fuel=${looseSnap.fuelSpent} fuelHasReplacement=${countDated(looseSnap.fuelRecon, '2026-09-22', REPLACEMENT)}`);
}

console.log('\n=== a $20 7-Eleven on WEEKLY is not the Travel Visa fuel transaction ===');
{
  const report = observeAt(AS_OF, [
    tx(64001, {
      date: '2026-09-20', amount: FUEL_PENDING, account_id: 1002,
      payee: '7-Eleven', original_name: '7-Eleven', category_id: FUEL_CAT,
    }),
  ]);
  const snap = budgetSnapshot(report, AS_OF);
  const row = packetTxs(report, item => near(item.amount, FUEL_PENDING))[0];
  const cls = classify(row, report);
  ok(row && row.ownerConfirmedFuel !== true
      && cls && cls.kind === 'spend' && cls.categoryId === 'fuel'
      && cls.includeReason === 'fuel-category'
      && near(snap.fuelSpent, FUEL_PENDING)
      && near(snap.otherSpent, 0),
    'same day and amount on WEEKLY carries no owner identity, but its Fuel category classifies it as Fuel (Dale 2026-10-14)',
    cls && cls.includeReason);
}

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nowner-confirmed September spend: ok');
