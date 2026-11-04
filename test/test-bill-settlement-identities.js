'use strict';
/* Standing bill-settlement identities: Fortis, Shaw, Netflix, and TD
 * fees are identity-plus-evidence each cycle; YouTube Premium, Spotify,
 * ChatGPT Plus Dale, ChatGPT Plus Amanda, and iCloud Storage are
 * schedule-trust on the due date. Matching confirmed-settled txs create
 * representedActuals and mark PAID. Without matching evidence Fortis,
 * Shaw, Netflix, and TD stay still-due / unverified. YouTube Premium,
 * Spotify, ChatGPT Plus Dale, ChatGPT Plus Amanda, and iCloud Storage
 * do not require an isolated bank tx, Lunch Money OpenAI/ChatGPT,
 * Spotify, Apple, or iCloud payee, or Apple scrape. ChatGPT Plus
 * Amanda is not the Dale identity. Synthetic observe fixtures and
 * independent arithmetic (L-002 / L-006).
 *
 * `node test/test-bill-settlement-identities.js`
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const O = require('./fixtures/native-cad-observation')(require('../scripts/provider-observe.js'));

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const FORTIS_ID = 'fortis';
const FORTIS_DUE = '2026-09-03';
const FORTIS_EARLY = '2026-09-01';
const FORTIS_PLANNED = 124;
// A7a: automatic settlement needs exact scheduled cents; mismatch is pinned in test-bill-payment-state.
const FORTIS_OBSERVED = 124;
const SHAW_ID = 'shaw';
const SHAW_DUE = '2026-09-14';
const SHAW_PLANNED = 78.4;
const SHAW_OBSERVED = 78.4;
const NETFLIX_ID = 'netflix';
const NETFLIX_DUE = '2026-09-17';
const NETFLIX_PLANNED = 26.87;
const NETFLIX_OBSERVED = 26.87;
const SPOTIFY_ID = 'spotify';
const SPOTIFY_DUE = '2026-09-23';
const SPOTIFY_BEFORE = '2026-09-22';
const SPOTIFY_PLANNED = 26.87;
const CHATGPT_DALE_ID = 'chatgpt-plus-dale';
const CHATGPT_AMANDA_ID = 'chatgpt-plus-amanda';
const CHATGPT_DUE = '2026-09-14';
const CHATGPT_BEFORE = '2026-09-13';
const CHATGPT_PLANNED = 28;
const CHATGPT_AMANDA_PLANNED = 24.99;
const ICLOUD_ID = 'icloud-storage';
const ICLOUD_DUE = '2026-09-14';
const ICLOUD_BEFORE = '2026-09-13';
const ICLOUD_PLANNED = 13;
const FEE_ID = 'tdfees';
const FEE_DUE = '2026-08-30';
const FEE_LEG = 17.95;
const FEE_TOTAL = 35.9;
const YOUTUBE_ID = 'youtube-premium';
const YOUTUBE_DUE = '2026-09-02';
const YOUTUBE_BEFORE = '2026-09-01';
const YOUTUBE_PLANNED = 17;
const EARLY_RULE = 'covers-early-or-due-on-or-before-posting';
const TWO_LEG = 'two-leg-sum';
const SCHEDULE_TRUST = 'schedule-trust-on-due';

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function fixtureMap() {
  return load('docs/connectivity/fixtures/provider-account-map.json');
}

function identityWithout(identity, eventIds) {
  const next = JSON.parse(JSON.stringify(identity));
  const skip = new Set(eventIds);
  next.rules = (next.rules || []).filter(r => r && !skip.has(r.eventId));
  return next;
}

function payload(asOf, extraTxs) {
  return {
    provider: 'lunchmoney',
    fetchedAt: asOf + 'T18:00:00.000Z',
    transactionWindow: {
      startDate: '2026-08-19',
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
    ],
    categories: [
      { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
    ],
    transactions: extraTxs || [],
  };
}

function observeWith(identity, asOf, txs) {
  return O.observe({
    provider: 'lunchmoney',
    payload: payload(asOf, txs),
    accountMap: fixtureMap(),
    data: liveData(),
    identity,
  });
}

function readyMap() {
  const map = fixtureMap();
  map.mappings = (map.mappings || []).concat([{
    providerAccountId: '1003',
    canonical: { collection: 'cash', id: 'savings' },
    atlasRole: 'household-cash',
  }]);
  return map;
}

function readyPayload(financialAsOf, fetchedDay, extraTxs) {
  const body = payload(financialAsOf, extraTxs);
  body.fetchedAt = fetchedDay + 'T18:00:00.000Z';
  body.transactionWindow.endDate = fetchedDay;
  body.accounts = (body.accounts || []).concat([
    {
      id: 1003, name: 'Fixture Savings', type: 'cash', balance: 200,
      updated_at: financialAsOf + 'T17:55:00.000Z', balance_last_update: financialAsOf + 'T17:55:00.000Z',
    },
    {
      id: 2001, name: 'Fixture TD Visa', type: 'credit', balance: 100,
      credit_limit: 1000, updated_at: financialAsOf + 'T17:55:00.000Z', balance_last_update: financialAsOf + 'T17:55:00.000Z',
    },
    {
      id: 2002, name: 'Fixture HELOC', type: 'loan', balance: 50,
      updated_at: financialAsOf + 'T17:55:00.000Z', balance_last_update: financialAsOf + 'T17:55:00.000Z',
    },
    {
      id: 2003, name: 'Fixture Mortgage', type: 'loan', balance: 100,
      updated_at: financialAsOf + 'T17:55:00.000Z', balance_last_update: financialAsOf + 'T17:55:00.000Z',
    },
  ]);
  return body;
}

function readyObserve(identity, financialAsOf, fetchedDay, txs) {
  return O.observe({
    provider: 'lunchmoney',
    payload: readyPayload(financialAsOf, fetchedDay, txs),
    accountMap: readyMap(),
    data: liveData(),
    identity,
  });
}

function youtubeRepresented(report) {
  return (report.representedEventCandidates || [])
    .some(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE
      && c.identity === SCHEDULE_TRUST);
}

function youtubeReconciled(report) {
  return ((report.obligationReconciliationReceipt
    && report.obligationReconciliationReceipt.occurrences) || [])
    .some(row => row && row.id === YOUTUBE_ID && row.date === YOUTUBE_DUE
      && row.settlement === 'represented');
}

function spotifyRepresented(report, date) {
  const due = date || SPOTIFY_DUE;
  return (report.representedEventCandidates || [])
    .some(c => c && c.id === SPOTIFY_ID && c.date === due
      && c.identity === SCHEDULE_TRUST
      && c.providerTransactionId == null);
}

function chatgptDaleRepresented(report, date) {
  const due = date || CHATGPT_DUE;
  return (report.representedEventCandidates || [])
    .some(c => c && c.id === CHATGPT_DALE_ID && c.date === due
      && c.identity === SCHEDULE_TRUST
      && c.providerTransactionId == null);
}

function chatgptAmandaRepresented(report, date) {
  const due = date || CHATGPT_DUE;
  return (report.representedEventCandidates || [])
    .some(c => c && c.id === CHATGPT_AMANDA_ID && c.date === due
      && c.identity === SCHEDULE_TRUST
      && c.providerTransactionId == null);
}

function icloudRepresented(report, date) {
  const due = date || ICLOUD_DUE;
  return (report.representedEventCandidates || [])
    .some(c => c && c.id === ICLOUD_ID && c.date === due
      && c.identity === SCHEDULE_TRUST
      && c.providerTransactionId == null);
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}

function recommendFromReport(report, asOf) {
  const data = liveData();
  const represented = ((report && report.representedEventCandidates) || [])
    .filter(c => c && c.id && c.date)
    .map(c => ({ id: c.id, date: c.date }));
  const plan = JSON.parse(JSON.stringify(data.plan));
  plan.opening = Object.assign({}, plan.opening, {
    asOf,
    priorAsOf: (data.plan.opening && data.plan.opening.asOf) || '2026-08-19',
    representedEvents: represented,
  });
  return F.recommend(plan, asOf, {
    debts: data.debts,
    currentPeriodActuals: report.currentPeriodActuals,
    representedEvents: represented,
    preservePaydayPeriodOrigin: true,
  });
}

function actionBill(advice, id, date) {
  return (((advice && advice.currentPeriodAction) || {}).bills || [])
    .find(b => b && b.id === id && (!date || b.date === date)) || null;
}

function calendarBill(advice, id, date) {
  const active = period(advice && advice.defaultView, 'this-pay-period');
  return ((active && active.bills) || []).find(b =>
    b && b.id === id && (!date || b.date === date)) || null;
}

function billPaid(advice, id, date) {
  const row = actionBill(advice, id, date) || calendarBill(advice, id, date);
  return !!(row && (row.settlement === 'represented' || row.status === 'PAID')
    && (row.remaining == null || near(row.remaining, 0)));
}

function billUnpaid(advice, id, date) {
  const row = actionBill(advice, id, date) || calendarBill(advice, id, date);
  if (!row) return false;
  if (row.settlement === 'represented' || row.status === 'PAID') return false;
  return row.remaining == null || Number(row.remaining) > 0;
}

function fortisTx(extra) {
  return Object.assign({
    id: 9601, account_id: 1001, date: FORTIS_EARLY, amount: FORTIS_OBSERVED,
    is_pending: false, payee: 'Fortisbc Energy Bpy', original_name: 'FortisBC Energy BPY',
  }, extra || {});
}

function shawTx(extra) {
  return Object.assign({
    id: 9630, account_id: 1001, date: SHAW_DUE, amount: SHAW_OBSERVED,
    is_pending: false, payee: 'SHAW CABLE TV BPY', original_name: 'SHAW CABLE TV BPY',
  }, extra || {});
}

function netflixTx(extra) {
  return Object.assign({
    id: 9640, account_id: 1002, date: NETFLIX_DUE, amount: NETFLIX_OBSERVED,
    is_pending: false, payee: 'Netflix', original_name: 'Netflix',
  }, extra || {});
}

function spotifyTx(extra) {
  return Object.assign({
    id: 9641, account_id: 1002, date: NETFLIX_DUE, amount: NETFLIX_OBSERVED,
    is_pending: false, payee: 'Spotify', original_name: 'Spotify',
  }, extra || {});
}

function feeTxA(extra) {
  return Object.assign({
    id: 9602, account_id: 1001, date: FEE_DUE, amount: FEE_LEG, currency: 'cad',
    is_pending: false, payee: 'MONTHLY ACCOUNT FEE', original_name: 'MONTHLY ACCOUNT FEE',
  }, extra || {});
}

function feeTxB(extra) {
  return Object.assign({
    id: 9603, account_id: 1002, date: FEE_DUE, amount: FEE_LEG, currency: 'cad',
    is_pending: false, payee: 'MONTHLY ACCOUNT FEE', original_name: 'MONTHLY ACCOUNT FEE',
  }, extra || {});
}

console.log('\n=== 1. standing identities are encoded ===');
{
  const identity = identityDoc();
  const fortis = (identity.rules || []).find(r => r && r.eventId === FORTIS_ID);
  ok(fortis && fortis.atlasAccountId === 'chequing-a' && fortis.direction === 'debit'
      && fortis.postingDateRule === EARLY_RULE
      && (fortis.payeePatterns || []).includes('Fortisbc Energy Bpy')
      && !fortis.settlesWhen,
    'fortis identity is payee + Chequing A + debit + early-or-covers-due; amount is not identity');
  const feeRules = (identity.rules || []).filter(r => r && r.eventId === FEE_ID);
  ok(feeRules.length === 2
      && feeRules.every(r => r.settlesWhen === TWO_LEG
        && r.direction === 'debit'
        && r.postingDateRule === EARLY_RULE && r.earlyPayLookaheadDays === 1
        && (r.payeePatterns || []).includes('MONTHLY ACCOUNT FEE'))
      && feeRules.some(r => r.atlasAccountId === 'chequing-a')
      && feeRules.some(r => r.atlasAccountId === 'chequing-b'),
    'tdfees identity is two MONTHLY ACCOUNT FEE debit legs on chequing-a and chequing-b');
  const youtube = (identity.rules || []).find(r => r && r.eventId === YOUTUBE_ID);
  ok(youtube && youtube.settlesWhen === SCHEDULE_TRUST
      && !youtube.payeePattern
      && !(youtube.payeePatterns || []).length
      && !youtube.atlasAccountId
      && !youtube.originalNamePattern,
    'youtube-premium is schedule-trust-on-due with no bank-payee identity');
  ok(!(identity.rules || []).some(r => r && r.eventId === YOUTUBE_ID
      && ((r.payeePatterns || []).length || r.payeePattern || r.originalNamePattern)),
    'YouTube has no invented Apple, PayPal, or Gmail payee rule');
  const spotify = (identity.rules || []).find(r => r && r.eventId === SPOTIFY_ID);
  ok(spotify && spotify.settlesWhen === SCHEDULE_TRUST
      && !spotify.payeePattern
      && !(spotify.payeePatterns || []).length
      && !spotify.atlasAccountId
      && !spotify.originalNamePattern,
    'spotify is schedule-trust-on-due with no bank-payee identity');
  ok(!(identity.rules || []).some(r => r && r.eventId === SPOTIFY_ID
      && ((r.payeePatterns || []).length || r.payeePattern || r.originalNamePattern)),
    'Spotify has no invented Lunch Money, PayPal, or Gmail payee rule');
  const chatgptDale = (identity.rules || []).find(r => r && r.eventId === CHATGPT_DALE_ID);
  ok(chatgptDale && chatgptDale.settlesWhen === SCHEDULE_TRUST
      && !chatgptDale.payeePattern
      && !(chatgptDale.payeePatterns || []).length
      && !chatgptDale.atlasAccountId
      && !chatgptDale.originalNamePattern,
    'chatgpt-plus-dale is schedule-trust-on-due with no bank-payee identity');
  ok(!(identity.rules || []).some(r => r && r.eventId === CHATGPT_DALE_ID
      && ((r.payeePatterns || []).length || r.payeePattern || r.originalNamePattern)),
    'ChatGPT Plus Dale has no invented Lunch Money OpenAI/ChatGPT, PayPal, or Gmail payee rule');
  const chatgptAmanda = (identity.rules || []).find(r => r && r.eventId === CHATGPT_AMANDA_ID);
  ok(chatgptAmanda && chatgptAmanda.settlesWhen === SCHEDULE_TRUST
      && !chatgptAmanda.payeePattern
      && !(chatgptAmanda.payeePatterns || []).length
      && !chatgptAmanda.atlasAccountId
      && !chatgptAmanda.originalNamePattern,
    'chatgpt-plus-amanda is schedule-trust-on-due with no bank-payee identity');
  ok(!(identity.rules || []).some(r => r && r.eventId === CHATGPT_AMANDA_ID
      && ((r.payeePatterns || []).length || r.payeePattern || r.originalNamePattern)),
    'ChatGPT Plus Amanda has no invented Lunch Money ChatGPT/Apple, exclusive Apple-only, or exclusive PayPal-merchant payee rule');
  ok(/iOS \$24\.99/.test(chatgptAmanda.note || '')
      && /chatgpt-plus-dale/.test(chatgptAmanda.note || '')
      && !/Order ID/i.test(chatgptAmanda.note || '')
      && !/exclusive Apple-only/i.test(chatgptAmanda.note || '')
      && !/OpenAI OpCo/i.test(chatgptAmanda.note || ''),
    'Amanda rail language names confirmed iOS $24.99, isolates Dale, and invents no Order ID or exclusive Apple/PayPal rail');
  const icloud = (identity.rules || []).find(r => r && r.eventId === ICLOUD_ID);
  ok(icloud && icloud.settlesWhen === SCHEDULE_TRUST
      && !icloud.payeePattern
      && !(icloud.payeePatterns || []).length
      && !icloud.atlasAccountId
      && !icloud.originalNamePattern,
    'icloud-storage is schedule-trust-on-due with no bank-payee identity');
  ok(!(identity.rules || []).some(r => r && r.eventId === ICLOUD_ID
      && ((r.payeePatterns || []).length || r.payeePattern || r.originalNamePattern)),
    'iCloud has no invented Lunch Money, exclusive Apple-only, or exclusive PayPal-merchant payee rule');
  ok(/Apple Services \/ PayPal/.test(icloud.note || '')
      && !/Order ID/i.test(icloud.note || '')
      && !/exclusive Apple-only/i.test(icloud.note || ''),
    'iCloud rail language mirrors YouTube Apple Services / PayPal and invents no Order ID');
  ok(/named youtube-premium, named spotify, named chatgpt-plus-dale, named chatgpt-plus-amanda, and named icloud-storage/.test(identity.owns || '')
      && /YouTube Premium, Spotify, ChatGPT Plus Dale, ChatGPT Plus Amanda, and iCloud Storage are the named schedule-trust exceptions/.test(identity.owns || '')
      && /Do not settle chatgpt-plus-amanda from the Dale rule/.test(identity.owns || '')
      && !/youtube-premium only/.test(identity.owns || '')
      && !/YouTube Premium is the only schedule-trust exception/.test(identity.owns || '')
      && !/YouTube Premium and Spotify are the named schedule-trust exceptions/.test(identity.owns || '')
      && !/YouTube Premium, Spotify, and ChatGPT Plus Dale are the named schedule-trust exceptions/.test(identity.owns || '')
      && !/YouTube Premium, Spotify, ChatGPT Plus Dale, and iCloud Storage are the named schedule-trust exceptions/.test(identity.owns || ''),
    'owns names youtube-premium, spotify, chatgpt-plus-dale, chatgpt-plus-amanda, and icloud-storage as the schedule-trust exceptions');
  const shaw = (identity.rules || []).find(r => r && r.eventId === SHAW_ID);
  ok(shaw && shaw.atlasAccountId === 'chequing-a' && shaw.direction === 'debit'
      && shaw.postingDateRule === EARLY_RULE
      && (shaw.payeePatterns || []).includes('SHAW CABLE TV BPY')
      && (shaw.payeePatterns || []).includes('Shaw Cable')
      && !shaw.settlesWhen,
    'shaw identity is payee + Chequing A + debit + early-or-covers-due; amount is not identity');
  const netflix = (identity.rules || []).find(r => r && r.eventId === NETFLIX_ID);
  ok(netflix && netflix.atlasAccountId === 'chequing-b' && netflix.direction === 'debit'
      && netflix.postingDateRule === EARLY_RULE
      && (netflix.payeePatterns || []).includes('Netflix')
      && !netflix.settlesWhen,
    'netflix identity is payee + Chequing B + debit + early-or-covers-due; amount is not identity');
}

console.log('\n=== 2. WITHOUT EVIDENCE Fortis and TD stay still-due; YouTube waits for due date ===');
{
  const identity = identityDoc();
  const empty = observeWith(identity, FORTIS_EARLY, []);
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === FORTIS_ID),
    'no Fortis debit does not represent fortis');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === FEE_ID),
    'no MONTHLY ACCOUNT FEE legs do not represent tdfees');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === YOUTUBE_ID),
    'YouTube is not schedule-trusted before the 2nd');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Spotify is not schedule-trusted before the 23rd');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === CHATGPT_DALE_ID),
    'ChatGPT Plus Dale is not schedule-trusted before the 14th');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === ICLOUD_ID),
    'iCloud Storage is not schedule-trusted before the 14th');
  ok(!(empty.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'ChatGPT Plus Amanda is not schedule-trusted before the 14th');
  const beforeAdvice = recommendFromReport(empty, FORTIS_EARLY);
  ok(billUnpaid(beforeAdvice, FORTIS_ID, FORTIS_DUE),
    'Fortis stays still-due / unverified without matching evidence');
  ok(billUnpaid(beforeAdvice, FEE_ID, FEE_DUE),
    'TD fees stay still-due / unverified without matching evidence');
  ok(billUnpaid(beforeAdvice, YOUTUBE_ID, YOUTUBE_DUE),
    'YouTube stays still-due before its due date');
  const shawEmpty = observeWith(identity, SHAW_DUE, []);
  ok(!(shawEmpty.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'no Shaw debit does not represent shaw');
  ok(billUnpaid(recommendFromReport(shawEmpty, SHAW_DUE), SHAW_ID, SHAW_DUE),
    'Shaw stays still-due / unverified without matching evidence');
  const netflixEmpty = observeWith(identity, NETFLIX_DUE, []);
  ok(!(netflixEmpty.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'no Netflix debit does not represent netflix');
  ok(billUnpaid(recommendFromReport(netflixEmpty, NETFLIX_DUE), NETFLIX_ID, NETFLIX_DUE),
    'Netflix stays still-due / unverified without matching evidence');
}

console.log('\n=== 3. Fortis early pay before due creates representedActuals and PAID ===');
{
  const identity = identityDoc();
  const missing = observeWith(identityWithout(identity, [FORTIS_ID]), FORTIS_EARLY, [fortisTx()]);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === FORTIS_ID),
    'without the fortis rule, Fortisbc Energy Bpy stays unmatched');
  const report = observeWith(identity, FORTIS_EARLY, [fortisTx()]);
  const hit = (report.representedEventCandidates || [])
    .find(c => c && c.id === FORTIS_ID && c.date === FORTIS_DUE);
  ok(hit && hit.postingDate === FORTIS_EARLY
      && hit.postingDateRelation === 'early-pay-before-due'
      && hit.amountNotUsed === true
      && near(hit.observedAmount, FORTIS_OBSERVED),
    'Sep 1 Fortisbc Energy Bpy debit settles the Sep 3 fortis occurrence as early pay');
  const row = ((report.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === FORTIS_ID && r.date === FORTIS_DUE);
  ok(row && row.transactionId && near(row.actual, FORTIS_OBSERVED)
      && row.postedOn === FORTIS_EARLY,
    'representedActuals carries the observed Fortis debit against fortis@Sep 3');
  const advice = recommendFromReport(report, FORTIS_EARLY);
  const bill = actionBill(advice, FORTIS_ID, FORTIS_DUE)
    || calendarBill(advice, FORTIS_ID, FORTIS_DUE);
  ok(billPaid(advice, FORTIS_ID, FORTIS_DUE)
      && bill && near(bill.planned != null ? bill.planned : bill.amount, FORTIS_PLANNED)
      && near(bill.actual != null ? bill.actual : 0, FORTIS_OBSERVED),
    'matching Fortis evidence marks PAID at the observed amount; planned $124 stays');
  const late = observeWith(identity, '2026-09-05', [fortisTx({
    id: 9611, date: '2026-09-05', amount: FORTIS_PLANNED,
  })]);
  const lateHit = (late.representedEventCandidates || [])
    .find(c => c && c.id === FORTIS_ID && c.date === FORTIS_DUE);
  ok(lateHit && lateHit.postingDate === '2026-09-05',
    'a later Fortis debit still covers the Sep 3 due');
  const wrongPayee = observeWith(identity, FORTIS_EARLY, [fortisTx({
    id: 9612, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  })]);
  ok(!(wrongPayee.representedEventCandidates || []).some(c => c && c.id === FORTIS_ID),
    'date + amount without the Fortis alias does not settle fortis');
  const wrongAccount = observeWith(identity, FORTIS_EARLY, [fortisTx({
    id: 9613, account_id: 1002,
  })]);
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c && c.id === FORTIS_ID),
    'the Fortis alias on Chequing B does not settle the BILLS ACCOUNT bill');
}

console.log('\n=== 3b. Shaw same-day SHAW CABLE TV BPY creates representedActuals and PAID ===');
{
  const liveShaw = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === SHAW_ID);
  ok(liveShaw && liveShaw.day === 14 && liveShaw.payingAccount === 'chequing-a'
      && near(liveShaw.amount, SHAW_PLANNED),
    'live plan.bills shaw is $78.40 on the 14th from chequing-a');
  const identity = identityDoc();
  const missing = observeWith(identityWithout(identity, [SHAW_ID]), SHAW_DUE, [shawTx()]);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'without the shaw rule, SHAW CABLE TV BPY stays unmatched');
  ok(billUnpaid(recommendFromReport(missing, SHAW_DUE), SHAW_ID, SHAW_DUE),
    'without the shaw rule the Sep 14 bill stays still-due / PENDING');
  const report = observeWith(identity, SHAW_DUE, [shawTx()]);
  const hit = (report.representedEventCandidates || [])
    .find(c => c && c.id === SHAW_ID && c.date === SHAW_DUE);
  ok(hit && hit.postingDate === SHAW_DUE
      && hit.postingDateRelation === 'same-day'
      && hit.amountNotUsed === true
      && near(hit.observedAmount, SHAW_OBSERVED),
    'Sep 14 SHAW CABLE TV BPY debit settles the Sep 14 shaw occurrence as same-day');
  const row = ((report.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === SHAW_ID && r.date === SHAW_DUE);
  ok(row && row.transactionId && near(row.actual, SHAW_OBSERVED)
      && row.postedOn === SHAW_DUE,
    'representedActuals carries the observed Shaw debit against shaw@Sep 14');
  const advice = recommendFromReport(report, SHAW_DUE);
  const bill = actionBill(advice, SHAW_ID, SHAW_DUE)
    || calendarBill(advice, SHAW_ID, SHAW_DUE);
  ok(billPaid(advice, SHAW_ID, SHAW_DUE)
      && bill && near(bill.planned != null ? bill.planned : bill.amount, SHAW_PLANNED)
      && near(bill.actual != null ? bill.actual : 0, SHAW_OBSERVED),
    'matching Shaw evidence marks PAID at the observed amount; planned $78.40 stays');
  const alias = observeWith(identity, SHAW_DUE, [shawTx({
    id: 9631, payee: 'Shaw Cable', original_name: 'Shaw Cable',
  })]);
  ok((alias.representedEventCandidates || [])
      .some(c => c && c.id === SHAW_ID && c.date === SHAW_DUE),
    'Shaw Cable on Chequing A is the same shaw identity');
  const wrongPayee = observeWith(identity, SHAW_DUE, [shawTx({
    id: 9632, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  })]);
  ok(!(wrongPayee.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'date + amount without the Shaw alias does not settle shaw');
  const wrongAccount = observeWith(identity, SHAW_DUE, [shawTx({
    id: 9633, account_id: 1002,
  })]);
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'the Shaw alias on Chequing B does not settle the BILLS ACCOUNT bill');
  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, SHAW_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), SHAW_PLANNED),
    'matching shaw releases independently the planned $78.40',
    `${beforeRemain} → ${afterRemain} vs ${SHAW_PLANNED}`);
}

console.log('\n=== 3c. Netflix same-day WEEKLY debit creates representedActuals and PAID; Spotify does not ===');
{
  const liveNetflix = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === NETFLIX_ID);
  ok(liveNetflix && liveNetflix.day === 17 && liveNetflix.payingAccount === 'chequing-a'
      && near(liveNetflix.amount, NETFLIX_PLANNED),
    'live plan.bills netflix is $26.87 on the 17th; payingAccount stays chequing-a');
  const liveSpotify = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === SPOTIFY_ID);
  ok(liveSpotify && liveSpotify.day === 23 && liveSpotify.firstDue === '2026-09-23'
      && near(liveSpotify.amount, NETFLIX_PLANNED),
    'live plan.bills spotify is $26.87 on the 23rd from firstDue 2026-09-23; it is a separate bill from Netflix');
  ok(liveSpotify.day !== 17,
    'owner 2026-09-23 moved data.json spotify.day off the 17th');
  ok(near(NETFLIX_PLANNED, 26.87),
    'independent scheduled amount is $26.87, not identity');
  const identity = identityDoc();
  const missing = observeWith(identityWithout(identity, [NETFLIX_ID]), NETFLIX_DUE, [netflixTx()]);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'without the netflix rule, Netflix on chequing-b stays unmatched');
  ok(billUnpaid(recommendFromReport(missing, NETFLIX_DUE), NETFLIX_ID, NETFLIX_DUE),
    'without the netflix rule the Sep 17 bill stays still-due / PENDING');
  const report = observeWith(identity, NETFLIX_DUE, [netflixTx()]);
  const hit = (report.representedEventCandidates || [])
    .find(c => c && c.id === NETFLIX_ID && c.date === NETFLIX_DUE);
  ok(hit && hit.postingDate === NETFLIX_DUE
      && hit.postingDateRelation === 'same-day'
      && hit.amountNotUsed === true
      && hit.atlasAccountId === 'chequing-b'
      && near(hit.observedAmount, NETFLIX_OBSERVED),
    'Sep 17 Netflix debit on chequing-b settles the Sep 17 netflix occurrence as same-day');
  ok(!(report.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'on Sep 17 Spotify is not yet due, and the Netflix debit does not represent it');
  const row = ((report.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === NETFLIX_ID && r.date === NETFLIX_DUE);
  ok(row && row.transactionId && near(row.actual, NETFLIX_OBSERVED)
      && row.postedOn === NETFLIX_DUE,
    'representedActuals carries the observed Netflix debit against netflix@Sep 17');
  ok(!((report.currentPeriodActuals || {}).representedActuals || [])
      .some(r => r && r.id === SPOTIFY_ID),
    'Sep 17 representedActuals do not name Spotify; the 23rd has not arrived');
  const advice = recommendFromReport(report, NETFLIX_DUE);
  const bill = actionBill(advice, NETFLIX_ID, NETFLIX_DUE)
    || calendarBill(advice, NETFLIX_ID, NETFLIX_DUE);
  ok(billPaid(advice, NETFLIX_ID, NETFLIX_DUE)
      && bill && near(bill.planned != null ? bill.planned : bill.amount, NETFLIX_PLANNED)
      && near(bill.actual != null ? bill.actual : 0, NETFLIX_OBSERVED),
    'matching Netflix evidence marks PAID at the observed amount; planned $26.87 stays');
  ok(billUnpaid(advice, SPOTIFY_ID, SPOTIFY_DUE),
    'on Sep 17 Spotify@23 Sep is still due while Netflix settles from its own debit');
  const wrongPayee = observeWith(identity, NETFLIX_DUE, [netflixTx({
    id: 9642, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  })]);
  ok(!(wrongPayee.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'date + amount without the Netflix alias does not settle netflix');
  const spotifyPayee = observeWith(identity, NETFLIX_DUE, [spotifyTx()]);
  ok(!(spotifyPayee.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'Spotify payee on chequing-b does not settle netflix');
  ok(!(spotifyPayee.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'a Lunch Money Spotify payee on Sep 17 is not Spotify identity and does not trust the 23rd early');
  ok(billUnpaid(recommendFromReport(spotifyPayee, NETFLIX_DUE), NETFLIX_ID, NETFLIX_DUE),
    'a Spotify debit leaves Netflix still-due / PENDING');
  const wrongAccount = observeWith(identity, NETFLIX_DUE, [netflixTx({
    id: 9643, account_id: 1001,
  })]);
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'the Netflix alias on Chequing A does not settle the WEEKLY identity');
  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, NETFLIX_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), NETFLIX_PLANNED),
    'matching netflix releases independently the planned $26.87',
    `${beforeRemain} → ${afterRemain} vs ${NETFLIX_PLANNED}`);
}

console.log('\n=== 4. TD two-leg MONTHLY ACCOUNT FEE evidence settles $35.90; one leg does not ===');
{
  ok(near(FEE_LEG + FEE_LEG, FEE_TOTAL),
    'independent arithmetic: $17.95 + $17.95 = $35.90');
  const identity = identityDoc();
  const oneLeg = observeWith(identity, FEE_DUE, [feeTxA()]);
  ok(!(oneLeg.representedEventCandidates || []).some(c => c && c.id === FEE_ID),
    'one MONTHLY ACCOUNT FEE leg does not represent tdfees');
  ok(billUnpaid(recommendFromReport(oneLeg, FEE_DUE), FEE_ID, FEE_DUE),
    'one fee leg leaves tdfees still-due / unverified');
  const sameAccount = observeWith(identity, FEE_DUE, [
    feeTxA(),
    feeTxB({ id: 9620, account_id: 1001 }),
  ]);
  ok(!(sameAccount.representedEventCandidates || []).some(c => c && c.id === FEE_ID),
    'two MONTHLY ACCOUNT FEE debits on the same account are not the two-leg shape');
  const report = observeWith(identity, FEE_DUE, [feeTxA(), feeTxB()]);
  const hit = (report.representedEventCandidates || [])
    .find(c => c && c.id === FEE_ID && c.date === FEE_DUE);
  ok(hit && hit.identity === 'two-leg-payee+account+date'
      && hit.settlesWhen === TWO_LEG
      && near(hit.observedAmount, FEE_TOTAL)
      && Array.isArray(hit.providerTransactionIds)
      && hit.providerTransactionIds.length === 2,
    'both named legs uniquely represent tdfees at the summed observed amount');
  const row = ((report.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === FEE_ID && r.date === FEE_DUE);
  ok(row && near(row.actual, FEE_TOTAL) && row.transactionId
      && Array.isArray(row.transactionIds) && row.transactionIds.length === 2,
    'representedActuals carries both fee legs against the one $35.90 bill');
  const packet = report.currentPeriodActuals || {};
  const linked = (packet.transactions || []).filter(tx =>
    tx && row && row.transactionIds && row.transactionIds.includes(tx.id));
  ok(linked.length === 2 && linked.every(tx => tx.representedBill === true),
    'both posted household-cash fee rows are flagged representedBill');
  const advice = recommendFromReport(report, FEE_DUE);
  const bill = actionBill(advice, FEE_ID, FEE_DUE) || calendarBill(advice, FEE_ID, FEE_DUE);
  ok(billPaid(advice, FEE_ID, FEE_DUE)
      && bill && near(bill.planned != null ? bill.planned : bill.amount, FEE_TOTAL)
      && near(bill.actual != null ? bill.actual : 0, FEE_TOTAL),
    'matching two-leg evidence marks tdfees PAID at $35.90');
}

console.log('\n=== 5. YouTube schedule-trust is paid on the due date without a bank tx ===');
{
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/apple\.com|itunes|gmail|imap|scrape/i.test(observeSrc),
    'provider-observe does not invent Apple scrape or Gmail fetch');
  const before = observeWith(identity, YOUTUBE_BEFORE, []);
  ok(!(before.representedEventCandidates || []).some(c => c && c.id === YOUTUBE_ID),
    'YouTube is not represented the day before it is due');
  const report = observeWith(identity, YOUTUBE_DUE, []);
  const hit = (report.representedEventCandidates || [])
    .find(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST
      && hit.settlesWhen === SCHEDULE_TRUST
      && hit.providerTransactionId == null
      && near(hit.observedAmount, YOUTUBE_PLANNED),
    'on the due date YouTube is represented from the schedule, not a bank tx');
  const row = ((report.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === YOUTUBE_ID && r.date === YOUTUBE_DUE);
  ok(row && near(row.actual, YOUTUBE_PLANNED) && !row.transactionId,
    'representedActuals names youtube-premium@Sep 2 without a transactionId');
  const appleNoise = observeWith(identity, YOUTUBE_DUE, [{
    id: 9701, account_id: 1001, date: YOUTUBE_DUE, amount: YOUTUBE_PLANNED,
    is_pending: false, payee: 'APPLE.COM/BILL', original_name: 'PAYPAL',
  }]);
  const appleHit = (appleNoise.representedEventCandidates || [])
    .find(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE);
  ok(appleHit && appleHit.identity === SCHEDULE_TRUST
      && appleHit.providerTransactionId == null,
    'an Apple/PayPal row is not used as YouTube identity');
  const advice = recommendFromReport(report, YOUTUBE_DUE);
  ok(billPaid(advice, YOUTUBE_ID, YOUTUBE_DUE),
    'schedule-trust on the due date marks YouTube PAID');
  const beforeAdvice = recommendFromReport(before, YOUTUBE_BEFORE);
  ok(billUnpaid(beforeAdvice, YOUTUBE_ID, YOUTUBE_DUE),
    'the day before the due date YouTube remains still-due');
}

console.log('\n=== 5b. Spotify schedule-trust is paid on the due date without an LM Spotify payee ===');
{
  ok(near(SPOTIFY_PLANNED, 26.87) && near(SPOTIFY_PLANNED, NETFLIX_PLANNED),
    'independent scheduled amount is $26.87; amount is not identity');
  const liveSpotify = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === SPOTIFY_ID);
  ok(liveSpotify && liveSpotify.day === 23 && liveSpotify.firstDue === '2026-09-23'
      && near(liveSpotify.amount, SPOTIFY_PLANNED),
    'live plan.bills spotify.day is 23 from firstDue 2026-09-23; schedule-trust uses that Forecast day');
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/apple\.com|itunes|gmail|imap|scrape/i.test(observeSrc),
    'provider-observe does not invent Apple scrape or Gmail fetch for Spotify');
  const missing = observeWith(identityWithout(identity, [SPOTIFY_ID]), SPOTIFY_DUE, []);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'without the spotify rule, due-date observe does not invent a Spotify settlement');
  ok(billUnpaid(recommendFromReport(missing, SPOTIFY_DUE), SPOTIFY_ID, SPOTIFY_DUE),
    'without the spotify rule the Sep 23 bill stays still-due / PENDING');
  const before = observeWith(identity, SPOTIFY_BEFORE, []);
  ok(!spotifyRepresented(before, SPOTIFY_DUE)
      && !(before.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Spotify is not represented the day before it is due');
  ok(billUnpaid(recommendFromReport(before, SPOTIFY_BEFORE), SPOTIFY_ID, SPOTIFY_DUE),
    'the day before the due date Spotify remains still-due');
  const earlyNetflix = observeWith(identity, '2026-09-16', [netflixTx({
    id: 9644, date: '2026-09-16',
  })]);
  ok((earlyNetflix.representedEventCandidates || [])
      .some(c => c && c.id === NETFLIX_ID && c.date === NETFLIX_DUE),
    'Netflix identity-plus-evidence is unchanged: a Sep 16 WEEKLY debit can early-pay netflix');
  ok(!(earlyNetflix.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Netflix early-pay on Sep 16 does not schedule-trust Spotify');
  ok(billUnpaid(recommendFromReport(earlyNetflix, '2026-09-16'), SPOTIFY_ID, SPOTIFY_DUE),
    'Spotify stays still-due on Sep 16 while Netflix may already be evidenced');
  const emptyDue = observeWith(identity, SPOTIFY_DUE, []);
  const hit = (emptyDue.representedEventCandidates || [])
    .find(c => c && c.id === SPOTIFY_ID && c.date === SPOTIFY_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST
      && hit.settlesWhen === SCHEDULE_TRUST
      && hit.providerTransactionId == null
      && near(hit.observedAmount, SPOTIFY_PLANNED),
    'on the due date Spotify is represented from the schedule, not a bank tx');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'empty due-date observe does not settle Netflix; Netflix still needs WEEKLY evidence');
  ok(billUnpaid(recommendFromReport(emptyDue, SPOTIFY_DUE), NETFLIX_ID, NETFLIX_DUE),
    'Netflix stays still-due / unverified without matching evidence when Spotify comes due');
  const row = ((emptyDue.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === SPOTIFY_ID && r.date === SPOTIFY_DUE);
  ok(row && near(row.actual, SPOTIFY_PLANNED) && !row.transactionId,
    'representedActuals names spotify@Sep 23 without a transactionId');
  const paypalNoise = observeWith(identity, SPOTIFY_DUE, [{
    id: 9702, account_id: 1001, date: SPOTIFY_DUE, amount: SPOTIFY_PLANNED,
    is_pending: false, payee: 'PAYPAL', original_name: 'SPOTIFY AB',
  }]);
  const paypalHit = (paypalNoise.representedEventCandidates || [])
    .find(c => c && c.id === SPOTIFY_ID && c.date === SPOTIFY_DUE);
  ok(paypalHit && paypalHit.identity === SCHEDULE_TRUST
      && paypalHit.providerTransactionId == null,
    'a PayPal / Spotify AB row is not used as Spotify identity');
  ok(!(paypalNoise.representedEventCandidates || []).some(c =>
      c && c.id === SPOTIFY_ID && c.providerTransactionId != null),
    'PayPal cadence is trusted without requiring an LM Spotify payee match');
  const afterDue = observeWith(identity, '2026-09-24', []);
  ok((afterDue.representedEventCandidates || [])
      .some(c => c && c.id === SPOTIFY_ID && c.date === SPOTIFY_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'on/after the due date schedule-trust still emits the Sep 23 Spotify settlement');
  const advice = recommendFromReport(emptyDue, SPOTIFY_DUE);
  ok(billPaid(advice, SPOTIFY_ID, SPOTIFY_DUE),
    'schedule-trust on the due date marks Spotify PAID');

  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, SPOTIFY_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), SPOTIFY_PLANNED),
    'matching Spotify schedule-trust releases independently the planned $26.87',
    `${beforeRemain} → ${afterRemain} vs ${SPOTIFY_PLANNED}`);
}

console.log('\n=== 5c. ChatGPT Plus Dale schedule-trust is paid on Forecast day 14 without an LM OpenAI payee ===');
{
  ok(near(CHATGPT_PLANNED, 28),
    'independent scheduled amount is $28; amount is not identity');
  const liveDale = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === CHATGPT_DALE_ID);
  ok(liveDale && liveDale.day === 14 && near(liveDale.amount, CHATGPT_PLANNED),
    'live plan.bills chatgpt-plus-dale.day stays 14; schedule-trust uses the existing Forecast day');
  const liveAmanda = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === CHATGPT_AMANDA_ID);
  ok(liveAmanda && liveAmanda.day === 14 && near(liveAmanda.amount, 24.99)
      && liveAmanda.id !== CHATGPT_DALE_ID,
    'chatgpt-plus-amanda remains a separate $24.99 iOS bill on the 14th');
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/apple\.com|itunes|gmail|imap|scrape/i.test(observeSrc),
    'provider-observe does not invent Apple scrape or Gmail fetch for ChatGPT Plus Dale');
  const missing = observeWith(identityWithout(identity, [CHATGPT_DALE_ID]), CHATGPT_DUE, []);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === CHATGPT_DALE_ID),
    'without the chatgpt-plus-dale rule, due-date observe does not invent a Dale ChatGPT settlement');
  ok(billUnpaid(recommendFromReport(missing, CHATGPT_DUE), CHATGPT_DALE_ID, CHATGPT_DUE),
    'without the chatgpt-plus-dale rule the Sep 14 bill stays still-due / PENDING');
  const before = observeWith(identity, CHATGPT_BEFORE, []);
  ok(!chatgptDaleRepresented(before, CHATGPT_DUE)
      && !(before.representedEventCandidates || []).some(c => c && c.id === CHATGPT_DALE_ID),
    'ChatGPT Plus Dale is not represented the day before it is due');
  ok(billUnpaid(recommendFromReport(before, CHATGPT_BEFORE), CHATGPT_DALE_ID, CHATGPT_DUE),
    'the day before the due date ChatGPT Plus Dale remains still-due');
  ok(!(before.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'before due, ChatGPT Plus Amanda is not schedule-trusted');
  const emptyDue = observeWith(identity, CHATGPT_DUE, []);
  const hit = (emptyDue.representedEventCandidates || [])
    .find(c => c && c.id === CHATGPT_DALE_ID && c.date === CHATGPT_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST
      && hit.settlesWhen === SCHEDULE_TRUST
      && hit.providerTransactionId == null
      && near(hit.observedAmount, CHATGPT_PLANNED),
    'on the due date ChatGPT Plus Dale is represented from the schedule, not a bank tx');
  const withoutAmanda = observeWith(identityWithout(identity, [CHATGPT_AMANDA_ID]), CHATGPT_DUE, []);
  ok(!(withoutAmanda.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'Dale schedule-trust does not represent chatgpt-plus-amanda');
  ok(chatgptDaleRepresented(withoutAmanda, CHATGPT_DUE),
    'stripping Amanda still schedule-trusts ChatGPT Plus Dale on Sep 14');
  ok(billUnpaid(recommendFromReport(withoutAmanda, CHATGPT_DUE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'ChatGPT Plus Amanda stays still-due / PENDING without its own schedule-trust rule');
  ok(chatgptAmandaRepresented(emptyDue, CHATGPT_DUE)
      && chatgptDaleRepresented(emptyDue, CHATGPT_DUE),
    'Sep 14 observe schedule-trusts ChatGPT Plus Dale and Amanda independently');
  const withoutIcloud = observeWith(identityWithout(identity, [ICLOUD_ID]), CHATGPT_DUE, []);
  ok(!(withoutIcloud.representedEventCandidates || []).some(c => c && c.id === ICLOUD_ID),
    'Dale ChatGPT rule does not invent iCloud settlement; iCloud needs its own named rule');
  ok(chatgptDaleRepresented(withoutIcloud, CHATGPT_DUE),
    'stripping iCloud still schedule-trusts ChatGPT Plus Dale on Sep 14');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'empty due-date observe does not settle Shaw; Shaw still needs BILLS evidence');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'empty Sep 14 observe does not settle Netflix; Netflix still needs WEEKLY evidence');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Spotify is not schedule-trusted on Sep 14; its due remains the 17th');
  const youtubeDue = observeWith(identity, YOUTUBE_DUE, []);
  ok((youtubeDue.representedEventCandidates || [])
      .some(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'YouTube Premium schedule-trust on Sep 2 is unchanged');
  ok(!(youtubeDue.representedEventCandidates || []).some(c => c && c.id === CHATGPT_DALE_ID),
    'YouTube due-date observe does not schedule-trust ChatGPT Plus Dale before the 14th');
  const row = ((emptyDue.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === CHATGPT_DALE_ID && r.date === CHATGPT_DUE);
  ok(row && near(row.actual, CHATGPT_PLANNED) && !row.transactionId,
    'representedActuals names chatgpt-plus-dale@Sep 14 without a transactionId');
  ok(!((withoutAmanda.currentPeriodActuals || {}).representedActuals || [])
      .some(r => r && r.id === CHATGPT_AMANDA_ID),
    'representedActuals does not name chatgpt-plus-amanda from the Dale rule');
  const openaiNoise = observeWith(identity, CHATGPT_DUE, [{
    id: 9703, account_id: 1001, date: CHATGPT_DUE, amount: CHATGPT_PLANNED,
    is_pending: false, payee: 'PAYPAL', original_name: 'OPENAI OPCO LLC',
  }]);
  const openaiHit = (openaiNoise.representedEventCandidates || [])
    .find(c => c && c.id === CHATGPT_DALE_ID && c.date === CHATGPT_DUE);
  ok(openaiHit && openaiHit.identity === SCHEDULE_TRUST
      && openaiHit.providerTransactionId == null,
    'a PayPal / OpenAI OpCo row is not used as ChatGPT Plus Dale identity');
  ok(!(openaiNoise.representedEventCandidates || []).some(c =>
      c && c.id === CHATGPT_DALE_ID && c.providerTransactionId != null),
    'PayPal cadence is trusted without requiring an LM OpenAI/ChatGPT payee match');
  ok(!(openaiNoise.representedEventCandidates || []).some(c =>
      c && c.id === CHATGPT_AMANDA_ID && c.providerTransactionId != null),
    'PayPal OpenAI noise does not settle chatgpt-plus-amanda');
  const amandaFromOpenAI = (openaiNoise.representedEventCandidates || [])
    .find(c => c && c.id === CHATGPT_AMANDA_ID && c.date === CHATGPT_DUE);
  ok(amandaFromOpenAI && amandaFromOpenAI.identity === SCHEDULE_TRUST
      && amandaFromOpenAI.providerTransactionId == null
      && near(amandaFromOpenAI.observedAmount, CHATGPT_AMANDA_PLANNED),
    'Amanda on Sep 14 is her own schedule-trust, not Dale PayPal OpenAI identity');
  const afterDue = observeWith(identity, '2026-09-15', []);
  ok((afterDue.representedEventCandidates || [])
      .some(c => c && c.id === CHATGPT_DALE_ID && c.date === CHATGPT_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'on/after the due date schedule-trust still emits the Sep 14 Dale ChatGPT settlement');
  const advice = recommendFromReport(emptyDue, CHATGPT_DUE);
  ok(billPaid(advice, CHATGPT_DALE_ID, CHATGPT_DUE),
    'schedule-trust on the due date marks ChatGPT Plus Dale PAID');
  ok(billUnpaid(advice, NETFLIX_ID, NETFLIX_DUE)
      || !actionBill(advice, NETFLIX_ID, NETFLIX_DUE),
    'Netflix identity-plus-evidence is unchanged: empty Sep 14 observe does not mark Netflix PAID');

  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, CHATGPT_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), CHATGPT_PLANNED),
    'matching ChatGPT Plus Dale schedule-trust releases independently the planned $28',
    `${beforeRemain} → ${afterRemain} vs ${CHATGPT_PLANNED}`);

  const withDale = observeWith(identity, SPOTIFY_DUE, []);
  const withoutDale = observeWith(identityWithout(identity, [CHATGPT_DALE_ID]), SPOTIFY_DUE, []);
  const idsOn = (report, id) => (report.representedEventCandidates || [])
    .filter(c => c && c.id === id)
    .map(c => [c.id, c.date, c.identity, c.providerTransactionId].join('|'))
    .sort()
    .join(';');
  ok(idsOn(withDale, SPOTIFY_ID) === idsOn(withoutDale, SPOTIFY_ID)
      && idsOn(withDale, YOUTUBE_ID) === idsOn(withoutDale, YOUTUBE_ID)
      && idsOn(withDale, NETFLIX_ID) === idsOn(withoutDale, NETFLIX_ID)
      && idsOn(withDale, CHATGPT_AMANDA_ID) === idsOn(withoutDale, CHATGPT_AMANDA_ID)
      && idsOn(withDale, ICLOUD_ID) === idsOn(withoutDale, ICLOUD_ID),
    'adding chatgpt-plus-dale does not change Spotify, YouTube, Netflix, Amanda ChatGPT, or iCloud settlement');
  ok(chatgptDaleRepresented(withDale, CHATGPT_DUE)
      && !chatgptDaleRepresented(withoutDale, CHATGPT_DUE),
    'Sep 17 observe still schedule-trusts the Sep 14 Dale ChatGPT occurrence only when the Dale rule exists');
}

console.log('\n=== 5d. iCloud Storage schedule-trust is paid on Forecast day 14 without an LM iCloud payee ===');
{
  ok(near(ICLOUD_PLANNED, 13),
    'independent scheduled amount is $13; amount is not identity');
  const liveIcloud = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === ICLOUD_ID);
  ok(liveIcloud && liveIcloud.day === 14 && near(liveIcloud.amount, ICLOUD_PLANNED),
    'live plan.bills icloud-storage.day stays 14; schedule-trust uses the existing Forecast day');
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/apple\.com|itunes|gmail|imap|scrape/i.test(observeSrc),
    'provider-observe does not invent Apple scrape or Gmail fetch for iCloud');
  const missing = observeWith(identityWithout(identity, [ICLOUD_ID]), ICLOUD_DUE, []);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === ICLOUD_ID),
    'without the icloud-storage rule, due-date observe does not invent an iCloud settlement');
  ok(billUnpaid(recommendFromReport(missing, ICLOUD_DUE), ICLOUD_ID, ICLOUD_DUE),
    'without the icloud-storage rule the Sep 14 bill stays still-due / PENDING');
  ok(chatgptDaleRepresented(missing, CHATGPT_DUE),
    'stripping iCloud still schedule-trusts ChatGPT Plus Dale on Sep 14');
  const before = observeWith(identity, ICLOUD_BEFORE, []);
  ok(!icloudRepresented(before, ICLOUD_DUE)
      && !(before.representedEventCandidates || []).some(c => c && c.id === ICLOUD_ID),
    'iCloud Storage is not represented the day before it is due');
  ok(billUnpaid(recommendFromReport(before, ICLOUD_BEFORE), ICLOUD_ID, ICLOUD_DUE),
    'the day before the due date iCloud Storage remains still-due');
  const emptyDue = observeWith(identity, ICLOUD_DUE, []);
  const hit = (emptyDue.representedEventCandidates || [])
    .find(c => c && c.id === ICLOUD_ID && c.date === ICLOUD_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST
      && hit.settlesWhen === SCHEDULE_TRUST
      && hit.providerTransactionId == null
      && near(hit.observedAmount, ICLOUD_PLANNED),
    'on the due date iCloud Storage is represented from the schedule, not a bank tx');
  ok(icloudRepresented(emptyDue, ICLOUD_DUE)
      && chatgptDaleRepresented(emptyDue, CHATGPT_DUE)
      && chatgptAmandaRepresented(emptyDue, CHATGPT_DUE),
    'Sep 14 observe schedule-trusts iCloud, ChatGPT Plus Dale, and ChatGPT Plus Amanda independently');
  const withoutAmanda = observeWith(identityWithout(identity, [CHATGPT_AMANDA_ID]), ICLOUD_DUE, []);
  ok(!(withoutAmanda.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'iCloud schedule-trust does not represent chatgpt-plus-amanda');
  ok(icloudRepresented(withoutAmanda, ICLOUD_DUE)
      && chatgptDaleRepresented(withoutAmanda, CHATGPT_DUE),
    'stripping Amanda still schedule-trusts iCloud and ChatGPT Plus Dale on Sep 14');
  ok(billUnpaid(recommendFromReport(withoutAmanda, ICLOUD_DUE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'ChatGPT Plus Amanda stays still-due / PENDING without its own schedule-trust rule');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Spotify is not schedule-trusted on Sep 14; its due remains the 17th');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'empty Sep 14 observe does not settle Netflix; Netflix still needs WEEKLY evidence');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'empty due-date observe does not settle Shaw; Shaw still needs BILLS evidence');
  const youtubeDue = observeWith(identity, YOUTUBE_DUE, []);
  ok((youtubeDue.representedEventCandidates || [])
      .some(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'YouTube Premium schedule-trust on Sep 2 is unchanged');
  ok(!(youtubeDue.representedEventCandidates || []).some(c => c && c.id === ICLOUD_ID),
    'YouTube due-date observe does not schedule-trust iCloud before the 14th');
  const row = ((emptyDue.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === ICLOUD_ID && r.date === ICLOUD_DUE);
  ok(row && near(row.actual, ICLOUD_PLANNED) && !row.transactionId,
    'representedActuals names icloud-storage@Sep 14 without a transactionId');
  const applePaypalNoise = observeWith(identity, ICLOUD_DUE, [{
    id: 9704, account_id: 1001, date: ICLOUD_DUE, amount: ICLOUD_PLANNED,
    is_pending: false, payee: 'PAYPAL', original_name: 'APPLE SERVICES',
  }]);
  const appleHit = (applePaypalNoise.representedEventCandidates || [])
    .find(c => c && c.id === ICLOUD_ID && c.date === ICLOUD_DUE);
  ok(appleHit && appleHit.identity === SCHEDULE_TRUST
      && appleHit.providerTransactionId == null,
    'a PayPal / Apple Services row is not used as iCloud identity');
  ok(!(applePaypalNoise.representedEventCandidates || []).some(c =>
      c && c.id === ICLOUD_ID && c.providerTransactionId != null),
    'Apple Services / PayPal cadence is trusted without requiring an LM iCloud payee match');
  const afterDue = observeWith(identity, '2026-09-15', []);
  ok((afterDue.representedEventCandidates || [])
      .some(c => c && c.id === ICLOUD_ID && c.date === ICLOUD_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'on/after the due date schedule-trust still emits the Sep 14 iCloud settlement');
  const advice = recommendFromReport(emptyDue, ICLOUD_DUE);
  ok(billPaid(advice, ICLOUD_ID, ICLOUD_DUE),
    'schedule-trust on the due date marks iCloud Storage PAID');
  ok(billUnpaid(advice, NETFLIX_ID, NETFLIX_DUE)
      || !actionBill(advice, NETFLIX_ID, NETFLIX_DUE),
    'Netflix identity-plus-evidence is unchanged: empty Sep 14 observe does not mark Netflix PAID');

  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, ICLOUD_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), ICLOUD_PLANNED),
    'matching iCloud schedule-trust releases independently the planned $13',
    `${beforeRemain} → ${afterRemain} vs ${ICLOUD_PLANNED}`);

  const withIcloud = observeWith(identity, SPOTIFY_DUE, []);
  const withoutIcloud = observeWith(identityWithout(identity, [ICLOUD_ID]), SPOTIFY_DUE, []);
  const idsOn = (report, id) => (report.representedEventCandidates || [])
    .filter(c => c && c.id === id)
    .map(c => [c.id, c.date, c.identity, c.providerTransactionId].join('|'))
    .sort()
    .join(';');
  ok(idsOn(withIcloud, SPOTIFY_ID) === idsOn(withoutIcloud, SPOTIFY_ID)
      && idsOn(withIcloud, YOUTUBE_ID) === idsOn(withoutIcloud, YOUTUBE_ID)
      && idsOn(withIcloud, CHATGPT_DALE_ID) === idsOn(withoutIcloud, CHATGPT_DALE_ID)
      && idsOn(withIcloud, CHATGPT_AMANDA_ID) === idsOn(withoutIcloud, CHATGPT_AMANDA_ID)
      && idsOn(withIcloud, NETFLIX_ID) === idsOn(withoutIcloud, NETFLIX_ID),
    'adding icloud-storage does not change Spotify, YouTube, ChatGPT Plus Dale/Amanda, or Netflix settlement');
  ok(icloudRepresented(withIcloud, ICLOUD_DUE)
      && !icloudRepresented(withoutIcloud, ICLOUD_DUE),
    'Sep 17 observe still schedule-trusts the Sep 14 iCloud occurrence only when the iCloud rule exists');
}

console.log('\n=== 5e. ChatGPT Plus Amanda schedule-trust is paid on Forecast day 14 without an LM ChatGPT/Apple payee ===');
{
  ok(near(CHATGPT_AMANDA_PLANNED, 24.99),
    'independent scheduled amount is $24.99; amount is not identity');
  const liveAmanda = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === CHATGPT_AMANDA_ID);
  ok(liveAmanda && liveAmanda.day === 14 && near(liveAmanda.amount, CHATGPT_AMANDA_PLANNED)
      && liveAmanda.id !== CHATGPT_DALE_ID,
    'live plan.bills chatgpt-plus-amanda.day stays 14; schedule-trust uses the existing Forecast day');
  const liveDale = ((liveData().plan && liveData().plan.bills) || [])
    .find(b => b && b.id === CHATGPT_DALE_ID);
  ok(liveDale && liveDale.day === 14 && near(liveDale.amount, CHATGPT_PLANNED),
    'chatgpt-plus-dale remains a separate $28 PayPal OpenAI bill on the 14th');
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/apple\.com|itunes|gmail|imap|scrape/i.test(observeSrc),
    'provider-observe does not invent Apple scrape or Gmail fetch for ChatGPT Plus Amanda');
  const missing = observeWith(identityWithout(identity, [CHATGPT_AMANDA_ID]), CHATGPT_DUE, []);
  ok(!(missing.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'without the chatgpt-plus-amanda rule, due-date observe does not invent an Amanda ChatGPT settlement');
  ok(billUnpaid(recommendFromReport(missing, CHATGPT_DUE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'without the chatgpt-plus-amanda rule the Sep 14 bill stays still-due / PENDING');
  ok(chatgptDaleRepresented(missing, CHATGPT_DUE)
      && icloudRepresented(missing, ICLOUD_DUE),
    'stripping Amanda still schedule-trusts ChatGPT Plus Dale and iCloud on Sep 14');
  const before = observeWith(identity, CHATGPT_BEFORE, []);
  ok(!chatgptAmandaRepresented(before, CHATGPT_DUE)
      && !(before.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'ChatGPT Plus Amanda is not represented the day before it is due');
  ok(billUnpaid(recommendFromReport(before, CHATGPT_BEFORE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'the day before the due date ChatGPT Plus Amanda remains still-due');
  const emptyDue = observeWith(identity, CHATGPT_DUE, []);
  const hit = (emptyDue.representedEventCandidates || [])
    .find(c => c && c.id === CHATGPT_AMANDA_ID && c.date === CHATGPT_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST
      && hit.settlesWhen === SCHEDULE_TRUST
      && hit.providerTransactionId == null
      && near(hit.observedAmount, CHATGPT_AMANDA_PLANNED),
    'on the due date ChatGPT Plus Amanda is represented from the schedule, not a bank tx');
  ok(chatgptAmandaRepresented(emptyDue, CHATGPT_DUE)
      && chatgptDaleRepresented(emptyDue, CHATGPT_DUE)
      && icloudRepresented(emptyDue, ICLOUD_DUE),
    'Sep 14 observe schedule-trusts Amanda, Dale ChatGPT, and iCloud independently');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SHAW_ID),
    'empty due-date observe does not settle Shaw; Shaw still needs BILLS evidence');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === NETFLIX_ID),
    'empty Sep 14 observe does not settle Netflix; Netflix still needs WEEKLY evidence');
  ok(!(emptyDue.representedEventCandidates || []).some(c => c && c.id === SPOTIFY_ID),
    'Spotify is not schedule-trusted on Sep 14; its due remains the 17th');
  const youtubeDue = observeWith(identity, YOUTUBE_DUE, []);
  ok((youtubeDue.representedEventCandidates || [])
      .some(c => c && c.id === YOUTUBE_ID && c.date === YOUTUBE_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'YouTube Premium schedule-trust on Sep 2 is unchanged');
  ok(!(youtubeDue.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'YouTube due-date observe does not schedule-trust ChatGPT Plus Amanda before the 14th');
  const row = ((emptyDue.currentPeriodActuals || {}).representedActuals || [])
    .find(r => r && r.id === CHATGPT_AMANDA_ID && r.date === CHATGPT_DUE);
  ok(row && near(row.actual, CHATGPT_AMANDA_PLANNED) && !row.transactionId,
    'representedActuals names chatgpt-plus-amanda@Sep 14 without a transactionId');
  const appleNoise = observeWith(identity, CHATGPT_DUE, [{
    id: 9705, account_id: 1001, date: CHATGPT_DUE, amount: CHATGPT_AMANDA_PLANNED,
    is_pending: false, payee: 'APPLE', original_name: 'APPLE.COM/BILL',
  }]);
  const appleHit = (appleNoise.representedEventCandidates || [])
    .find(c => c && c.id === CHATGPT_AMANDA_ID && c.date === CHATGPT_DUE);
  ok(appleHit && appleHit.identity === SCHEDULE_TRUST
      && appleHit.providerTransactionId == null,
    'an Apple.com/Bill row is not used as ChatGPT Plus Amanda identity');
  ok(!(appleNoise.representedEventCandidates || []).some(c =>
      c && c.id === CHATGPT_AMANDA_ID && c.providerTransactionId != null),
    'iOS cadence is trusted without requiring an LM ChatGPT or Apple payee match');
  ok(chatgptDaleRepresented(appleNoise, CHATGPT_DUE)
      && !(appleNoise.representedEventCandidates || []).some(c =>
        c && c.id === CHATGPT_DALE_ID && c.providerTransactionId != null),
    'Apple noise does not settle chatgpt-plus-dale; Dale stays its own schedule-trust');
  const afterDue = observeWith(identity, '2026-09-15', []);
  ok((afterDue.representedEventCandidates || [])
      .some(c => c && c.id === CHATGPT_AMANDA_ID && c.date === CHATGPT_DUE
        && c.identity === SCHEDULE_TRUST && c.providerTransactionId == null),
    'on/after the due date schedule-trust still emits the Sep 14 Amanda ChatGPT settlement');
  const advice = recommendFromReport(emptyDue, CHATGPT_DUE);
  ok(billPaid(advice, CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'schedule-trust on the due date marks ChatGPT Plus Amanda PAID');
  ok(billPaid(advice, CHATGPT_DALE_ID, CHATGPT_DUE)
      && billPaid(advice, ICLOUD_ID, ICLOUD_DUE),
    'Dale ChatGPT and iCloud schedule-trust on Sep 14 remain PAID independently');
  ok(billUnpaid(advice, NETFLIX_ID, NETFLIX_DUE)
      || !actionBill(advice, NETFLIX_ID, NETFLIX_DUE),
    'Netflix identity-plus-evidence is unchanged: empty Sep 14 observe does not mark Netflix PAID');

  const remaining = adviceRow => {
    const bills = (((adviceRow && adviceRow.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(recommendFromReport(missing, CHATGPT_DUE));
  const afterRemain = remaining(advice);
  ok(near(roundCent(beforeRemain - afterRemain), CHATGPT_AMANDA_PLANNED),
    'matching ChatGPT Plus Amanda schedule-trust releases independently the planned $24.99',
    `${beforeRemain} → ${afterRemain} vs ${CHATGPT_AMANDA_PLANNED}`);

  const withAmanda = observeWith(identity, SPOTIFY_DUE, []);
  const withoutAmanda = observeWith(identityWithout(identity, [CHATGPT_AMANDA_ID]), SPOTIFY_DUE, []);
  const idsOn = (report, id) => (report.representedEventCandidates || [])
    .filter(c => c && c.id === id)
    .map(c => [c.id, c.date, c.identity, c.providerTransactionId].join('|'))
    .sort()
    .join(';');
  ok(idsOn(withAmanda, SPOTIFY_ID) === idsOn(withoutAmanda, SPOTIFY_ID)
      && idsOn(withAmanda, YOUTUBE_ID) === idsOn(withoutAmanda, YOUTUBE_ID)
      && idsOn(withAmanda, CHATGPT_DALE_ID) === idsOn(withoutAmanda, CHATGPT_DALE_ID)
      && idsOn(withAmanda, ICLOUD_ID) === idsOn(withoutAmanda, ICLOUD_ID)
      && idsOn(withAmanda, NETFLIX_ID) === idsOn(withoutAmanda, NETFLIX_ID),
    'adding chatgpt-plus-amanda does not change Spotify, YouTube, ChatGPT Plus Dale, iCloud, or Netflix settlement');
  ok(chatgptAmandaRepresented(withAmanda, CHATGPT_DUE)
      && !chatgptAmandaRepresented(withoutAmanda, CHATGPT_DUE),
    'Sep 17 observe still schedule-trusts the Sep 14 Amanda ChatGPT occurrence only when the Amanda rule exists');
}

console.log('\n=== 6. independent remaining-bill deltas ===');
{
  const identity = identityDoc();
  const stripped = identityWithout(identity, [FORTIS_ID, FEE_ID, YOUTUBE_ID]);
  const asOf = '2026-09-03';
  const txs = [fortisTx({ date: asOf, amount: FORTIS_PLANNED }), feeTxA(), feeTxB()];
  const before = recommendFromReport(observeWith(stripped, asOf, txs), asOf);
  const after = recommendFromReport(observeWith(identity, asOf, txs), asOf);
  const remaining = advice => {
    const bills = (((advice && advice.currentPeriodAction) || {}).bills) || [];
    return bills
      .filter(row => row && row.settlement !== 'represented')
      .reduce((sum, row) => sum + Math.abs(Number(row.remaining != null
        ? row.remaining : row.planned) || 0), 0);
  };
  const beforeRemain = remaining(before);
  const afterRemain = remaining(after);
  const independent = roundCent(FORTIS_PLANNED + FEE_TOTAL + YOUTUBE_PLANNED);
  ok(near(roundCent(beforeRemain - afterRemain), independent),
    'matching the three identities releases independently $124 + $35.90 + $17',
    `${beforeRemain} → ${afterRemain} vs ${independent}`);
  ok(billPaid(after, FORTIS_ID, FORTIS_DUE)
      && billPaid(after, FEE_ID, FEE_DUE)
      && billPaid(after, YOUTUBE_ID, YOUTUBE_DUE),
    'on Sep 3, Fortis evidence + TD two-leg evidence + YouTube due-date trust are all PAID');
}

console.log('\n=== 7. pages do not special-case these merchants ===');
{
  const planSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'plan.js'), 'utf8'));
  ok(!/Fortisbc Energy|MONTHLY ACCOUNT FEE|YouTube Premium|SHAW CABLE TV BPY/.test(planSrc)
      && !/\bNetflix\b/.test(planSrc)
      && !/\bSpotify\b/.test(planSrc)
      && !/ChatGPT Plus/.test(planSrc)
      && !/\biCloud\b/.test(planSrc),
    'plan.js only prints; it does not special-case these identities');
}

console.log('\n=== 8. schedule-trust uses the financial as-of, never fetchedAt ===');
{
  const identity = identityDoc();
  const observeSrc = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(!/representedEventHitGroups\([\s\S]{0,500}dateOnly\(normalized\.fetchedAt\)/.test(observeSrc),
    'representedEventHitGroups is never keyed from fetchedAt');
  ok((observeSrc.match(/asOf:\s*scheduleTrustAsOf/g) || []).length >= 2,
    'observe and reconciliation both pass the same schedule-trust financial as-of');

  const FETCH_AFTER_DUE = '2026-09-03';
  const stale = readyObserve(identity, YOUTUBE_BEFORE, FETCH_AFTER_DUE, []);
  const staleReceipt = stale.observationReceipt || {};
  ok(staleReceipt.readyForReconciliation === true,
    'ready stale packet can run obligation reconciliation');
  ok(O.householdFinancialDate({}, stale.observations) === YOUTUBE_BEFORE,
    'provider cash evidence independently dates the financial as-of as Sep 1');
  ok(!youtubeRepresented(stale) && !youtubeReconciled(stale),
    'financial as-of before the 2nd leaves YouTube unrepresented on both surfaces');
  ok(!((stale.currentPeriodActuals || {}).representedActuals || [])
      .some(r => r && r.id === YOUTUBE_ID),
    'stale fetch after the 2nd does not write YouTube representedActuals');
  ok(billUnpaid(recommendFromReport(stale, YOUTUBE_BEFORE), YOUTUBE_ID, YOUTUBE_DUE),
    'Budget still shows YouTube still-due when the financial date is Sep 1');

  const due = readyObserve(identity, YOUTUBE_DUE, FETCH_AFTER_DUE, []);
  const dueReceipt = due.observationReceipt || {};
  ok(O.householdFinancialDate({}, due.observations) === YOUTUBE_DUE,
    'provider cash evidence independently dates the financial as-of as Sep 2');
  ok(dueReceipt.readyForReconciliation === true
      && youtubeRepresented(due) && youtubeReconciled(due),
    'both observe and reconciliation settle YouTube when the financial date reaches the due date');
  ok(((due.currentPeriodActuals || {}).representedActuals || [])
      .some(r => r && r.id === YOUTUBE_ID && r.date === YOUTUBE_DUE && !r.transactionId),
    'representedActuals names youtube-premium@Sep 2 from schedule-trust, not a bank tx');
  ok(billPaid(recommendFromReport(due, YOUTUBE_DUE), YOUTUBE_ID, YOUTUBE_DUE),
    'schedule-trust on the financial due date marks YouTube PAID');

  const spotifyStale = readyObserve(identity, SPOTIFY_BEFORE, '2026-09-24', []);
  ok(O.householdFinancialDate({}, spotifyStale.observations) === SPOTIFY_BEFORE,
    'provider cash evidence independently dates the Spotify financial as-of as Sep 22');
  ok(!spotifyRepresented(spotifyStale, SPOTIFY_DUE)
      && !((spotifyStale.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === SPOTIFY_ID),
    'financial as-of before the 23rd leaves Spotify unrepresented even if fetchedAt is later');
  ok(billUnpaid(recommendFromReport(spotifyStale, SPOTIFY_BEFORE), SPOTIFY_ID, SPOTIFY_DUE),
    'Budget still shows Spotify still-due when the financial date is Sep 22');
  const spotifyDue = readyObserve(identity, SPOTIFY_DUE, '2026-09-24', []);
  ok(O.householdFinancialDate({}, spotifyDue.observations) === SPOTIFY_DUE,
    'provider cash evidence independently dates the Spotify financial as-of as Sep 23');
  ok(spotifyRepresented(spotifyDue, SPOTIFY_DUE)
      && ((spotifyDue.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === SPOTIFY_ID && r.date === SPOTIFY_DUE && !r.transactionId),
    'both observe surfaces settle Spotify when the financial date reaches the due date');
  ok(billPaid(recommendFromReport(spotifyDue, SPOTIFY_DUE), SPOTIFY_ID, SPOTIFY_DUE),
    'schedule-trust on the financial due date marks Spotify PAID');

  const chatgptStale = readyObserve(identity, CHATGPT_BEFORE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, chatgptStale.observations) === CHATGPT_BEFORE,
    'provider cash evidence independently dates the Dale ChatGPT financial as-of as Sep 13');
  ok(!chatgptDaleRepresented(chatgptStale, CHATGPT_DUE)
      && !((chatgptStale.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === CHATGPT_DALE_ID),
    'financial as-of before the 14th leaves ChatGPT Plus Dale unrepresented even if fetchedAt is later');
  ok(billUnpaid(recommendFromReport(chatgptStale, CHATGPT_BEFORE), CHATGPT_DALE_ID, CHATGPT_DUE),
    'Budget still shows ChatGPT Plus Dale still-due when the financial date is Sep 13');
  ok(!(chatgptStale.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'stale fetch does not represent chatgpt-plus-amanda from the Dale rule');
  const chatgptDue = readyObserve(identity, CHATGPT_DUE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, chatgptDue.observations) === CHATGPT_DUE,
    'provider cash evidence independently dates the Dale ChatGPT financial as-of as Sep 14');
  ok(chatgptDaleRepresented(chatgptDue, CHATGPT_DUE)
      && ((chatgptDue.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === CHATGPT_DALE_ID && r.date === CHATGPT_DUE && !r.transactionId),
    'both observe surfaces settle ChatGPT Plus Dale when the financial date reaches the due date');
  ok(billPaid(recommendFromReport(chatgptDue, CHATGPT_DUE), CHATGPT_DALE_ID, CHATGPT_DUE),
    'schedule-trust on the financial due date marks ChatGPT Plus Dale PAID');
  const chatgptDueWithoutAmanda = readyObserve(
    identityWithout(identity, [CHATGPT_AMANDA_ID]), CHATGPT_DUE, '2026-09-18', []);
  ok(chatgptDaleRepresented(chatgptDueWithoutAmanda, CHATGPT_DUE)
      && !(chatgptDueWithoutAmanda.representedEventCandidates || []).some(c => c && c.id === CHATGPT_AMANDA_ID),
    'financial due-date observe still does not settle chatgpt-plus-amanda from the Dale rule');

  const amandaStale = readyObserve(identity, CHATGPT_BEFORE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, amandaStale.observations) === CHATGPT_BEFORE,
    'provider cash evidence independently dates the Amanda ChatGPT financial as-of as Sep 13');
  ok(!chatgptAmandaRepresented(amandaStale, CHATGPT_DUE)
      && !((amandaStale.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === CHATGPT_AMANDA_ID),
    'financial as-of before the 14th leaves ChatGPT Plus Amanda unrepresented even if fetchedAt is later');
  ok(billUnpaid(recommendFromReport(amandaStale, CHATGPT_BEFORE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'Budget still shows ChatGPT Plus Amanda still-due when the financial date is Sep 13');
  const amandaDue = readyObserve(identity, CHATGPT_DUE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, amandaDue.observations) === CHATGPT_DUE,
    'provider cash evidence independently dates the Amanda ChatGPT financial as-of as Sep 14');
  ok(chatgptAmandaRepresented(amandaDue, CHATGPT_DUE)
      && ((amandaDue.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === CHATGPT_AMANDA_ID && r.date === CHATGPT_DUE && !r.transactionId),
    'both observe surfaces settle ChatGPT Plus Amanda when the financial date reaches the due date');
  ok(billPaid(recommendFromReport(amandaDue, CHATGPT_DUE), CHATGPT_AMANDA_ID, CHATGPT_DUE),
    'schedule-trust on the financial due date marks ChatGPT Plus Amanda PAID');
  ok(chatgptDaleRepresented(amandaDue, CHATGPT_DUE)
      && icloudRepresented(amandaDue, ICLOUD_DUE),
    'financial due-date observe still schedule-trusts Dale ChatGPT and iCloud independently of Amanda');

  const icloudStale = readyObserve(identity, ICLOUD_BEFORE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, icloudStale.observations) === ICLOUD_BEFORE,
    'provider cash evidence independently dates the iCloud financial as-of as Sep 13');
  ok(!icloudRepresented(icloudStale, ICLOUD_DUE)
      && !((icloudStale.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === ICLOUD_ID),
    'financial as-of before the 14th leaves iCloud unrepresented even if fetchedAt is later');
  ok(billUnpaid(recommendFromReport(icloudStale, ICLOUD_BEFORE), ICLOUD_ID, ICLOUD_DUE),
    'Budget still shows iCloud still-due when the financial date is Sep 13');
  const icloudDue = readyObserve(identity, ICLOUD_DUE, '2026-09-18', []);
  ok(O.householdFinancialDate({}, icloudDue.observations) === ICLOUD_DUE,
    'provider cash evidence independently dates the iCloud financial as-of as Sep 14');
  ok(icloudRepresented(icloudDue, ICLOUD_DUE)
      && ((icloudDue.currentPeriodActuals || {}).representedActuals || [])
        .some(r => r && r.id === ICLOUD_ID && r.date === ICLOUD_DUE && !r.transactionId),
    'both observe surfaces settle iCloud when the financial date reaches the due date');
  ok(billPaid(recommendFromReport(icloudDue, ICLOUD_DUE), ICLOUD_ID, ICLOUD_DUE),
    'schedule-trust on the financial due date marks iCloud Storage PAID');
}

console.log('\n=== 9. Schedule-trust stays paid after its pay period rolls (YouTube Oct 2) ===');
{
  // Owner 2026-09-09: YouTube Premium is schedule-trust paid on its due date.
  // On Oct 9 (Seaspan payday) Oct 2 sits in the prior period Sep 25 - Oct 8.
  const identity = identityDoc();
  const OCT_DUE = '2026-10-02';
  const ROLLED = '2026-10-09';
  const cycle = F.spendingCycle(liveData().plan, ROLLED);
  ok(cycle && cycle.start === ROLLED && OCT_DUE < cycle.start,
    'Oct 2 is before the Oct 9 cycle start, so it falls in a prior pay period');
  const rolled = observeWith(identity, ROLLED, []);
  const hit = (rolled.representedEventCandidates || [])
    .find(c => c && c.id === YOUTUBE_ID && c.date === OCT_DUE);
  ok(hit && hit.identity === SCHEDULE_TRUST && hit.providerTransactionId == null
      && near(hit.observedAmount, YOUTUBE_PLANNED),
    'after the period rolls, youtube-premium@Oct 2 is still represented from the schedule');
  ok(((rolled.currentPeriodActuals || {}).representedActuals || [])
      .some(r => r && r.id === YOUTUBE_ID && r.date === OCT_DUE && near(r.actual, YOUTUBE_PLANNED)),
    'representedActuals still names youtube-premium@Oct 2 after the period rolls');
  const advice = recommendFromReport(rolled, ROLLED);
  const prior = (advice.payPeriodViews || []).find(v => v && v.timelineRole === 'past'
    && (v.bills || []).some(b => b && b.id === YOUTUBE_ID && b.date === OCT_DUE));
  const row = prior && prior.bills.find(b => b.id === YOUTUBE_ID && b.date === OCT_DUE);
  ok(row && row.status === 'PAID' && row.settlement === 'represented' && near(row.remaining, 0),
    'the prior-period YouTube Oct 2 row prints PAID, not unverified');
  ok(!(rolled.representedEventCandidates || []).some(c => c && c.id === YOUTUBE_ID && c.date === '2026-11-02'),
    'the next YouTube occurrence is not schedule-trusted before its due date');
  const beforeOpening = (rolled.representedEventCandidates || []).filter(c => c
    && c.identity === SCHEDULE_TRUST && c.date <= liveData().plan.opening.asOf);
  ok(beforeOpening.length === 0,
    'schedule-trust does not reach back past the canonical opening');
  const sameCycle = observeWith(identity, '2026-10-08', []);
  ok((sameCycle.representedEventCandidates || [])
      .some(c => c && c.id === YOUTUBE_ID && c.date === OCT_DUE && c.identity === SCHEDULE_TRUST),
    'inside its own period (Oct 8) youtube-premium@Oct 2 is represented as before');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll standing bill-settlement identity checks passed.');
