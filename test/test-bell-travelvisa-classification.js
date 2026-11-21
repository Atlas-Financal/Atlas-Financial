'use strict';
/* Standing Bell from 2026-10-15: a posted Travel Visa Bell Mobility
 * debit is that series' actual, not Other spending. September
 * bell-sep15-2026 is not this Travel Visa path — its settlement is the
 * explicit chequing-a same-account split. A Travel Visa debit does not
 * settle the September once. Amount is not identity. Forecast remains
 * the classifier. Synthetic observe fixtures and independent arithmetic
 * (L-002 / L-006).
 *
 * `node test/test-bell-travelvisa-classification.js`
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

const SEP_AS_OF = '2026-09-16';
const SEP_ID = 'bell-sep15-2026';
const SEP_DUE = '2026-09-15';
const SEP_TX = 283.94;
const SEP_PLANNED = 283.94;
const REC_ID = 'bell';
const REC_DUE = '2026-10-15';
const REC_AS_OF = '2026-10-16';
const REC_TX = 159.03;
const REC_PLANNED = 160;
const OTHER_TX = 19.17;
const EARLY_RULE = 'covers-early-or-due-on-or-before-posting';
const TRAVEL_PROVIDER_ID = 2004;
const SEP_OBSERVED_HOUSEHOLD = roundCent(SEP_TX + OTHER_TX);
const REC_OBSERVED_HOUSEHOLD = roundCent(REC_TX + OTHER_TX);

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function fixtureMap() {
  const map = load('docs/connectivity/fixtures/provider-account-map.json');
  map.mappings = (map.mappings || []).concat([{
    providerAccountId: String(TRAVEL_PROVIDER_ID),
    canonical: { collection: 'debts', id: 'travelvisa' },
    atlasRole: 'revolving-credit',
  }]);
  return map;
}

function bellBill(data, id) {
  return ((data && data.plan && data.plan.bills) || [])
    .find(b => b && b.id === id) || null;
}

function identityWithoutBell(identity) {
  const next = JSON.parse(JSON.stringify(identity));
  next.rules = (next.rules || []).filter(r => r
    && r.eventId !== SEP_ID && r.eventId !== REC_ID);
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
        updated_at: asOf + 'T17:55:00.000Z',
      },
      {
        id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 400,
        updated_at: asOf + 'T17:55:00.000Z',
      },
      {
        id: TRAVEL_PROVIDER_ID, name: 'Fixture Travel Visa', type: 'credit',
        balance: 500, credit_limit: 5000,
        updated_at: asOf + 'T17:55:00.000Z',
      },
    ],
    categories: [
      { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
    ],
    transactions: extraTxs || [],
  };
}

function sepTxs() {
  return [
    {
      id: 9701, account_id: TRAVEL_PROVIDER_ID, date: SEP_AS_OF, amount: SEP_TX,
      is_pending: false, payee: 'Bell Mobility', original_name: 'Bell Mobility',
    },
    {
      id: 9702, account_id: 1001, date: SEP_AS_OF, amount: OTHER_TX,
      is_pending: false, payee: 'Dollarama', original_name: 'Dollarama',
      category_id: 11,
    },
  ];
}

function recTxs() {
  return [
    {
      id: 9711, account_id: TRAVEL_PROVIDER_ID, date: REC_AS_OF, amount: REC_TX,
      is_pending: false, payee: 'Bell Mobility', original_name: 'BELLMOBILITY',
    },
    {
      id: 9712, account_id: 1001, date: REC_AS_OF, amount: OTHER_TX,
      is_pending: false, payee: 'Dollarama', original_name: 'Dollarama',
      category_id: 11,
    },
  ];
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

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function budgetSpent(p) {
  return roundCent(((p && p.householdBudget) || []).reduce((s, row) => {
    if (!row || row.otherSpending) return s;
    return s + (Number(row.spent) || 0);
  }, 0));
}
function reconHasBell(row, amount) {
  return ((row && row.recon) || []).some(tx =>
    tx && (Number(tx.amount) === amount
      || /bell\s*mobility/i.test(String(tx.displayedPayee || tx.originalMerchant || ''))));
}
function actionBill(advice, id) {
  return (((advice && advice.currentPeriodAction) || {}).bills || [])
    .find(b => b && b.id === id) || null;
}
function calendarBill(p, id) {
  return ((p && p.bills) || []).find(b =>
    b && (b.id === id || /bell mobility/i.test(String(b.label || '')))) || null;
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

console.log('\n=== 1. incumbent Bell authority is already on main ===');
{
  const data = liveData();
  const once = bellBill(data, SEP_ID);
  const standing = bellBill(data, REC_ID);
  ok(once && once.frequency === 'once' && once.date === SEP_DUE
      && once.payingAccount === 'travelvisa'
      && once.jointCash === false
      && near(once.amount, SEP_PLANNED),
    'canonical bell-sep15-2026 remains the one 15 September Travel Visa due');
  ok(standing && standing.frequency === 'monthly' && standing.day === 15
      && standing.firstDue === REC_DUE
      && standing.payingAccount === 'chequing-a'
      && standing.jointCash !== false
      && near(standing.amount, REC_PLANNED),
    'canonical bell remains standing $160 from 2026-10-15 on BILLS ACCOUNT');
  const bellBills = (data.plan.bills || []).filter(b =>
    b && (b.id === SEP_ID || b.id === REC_ID || /bell/i.test(String(b.id || ''))));
  ok(bellBills.some(b => b.id === SEP_ID)
      && bellBills.some(b => b.id === REC_ID)
      && bellBills.length === 2,
    'exactly two Bell bills: the September once and the standing series');
}

console.log('\n=== 2. BEFORE-DEFECT PATH: missing identity leaves $283.94 in Other spending ===');
{
  const broken = observeWith(identityWithoutBell(identityDoc()), SEP_AS_OF, sepTxs());
  const hits = broken.representedEventCandidates || [];
  ok(!hits.some(c => c && (c.id === SEP_ID || c.id === REC_ID)),
    'without the Bell identity rules, observe does not represent either Bell bill');
  const packet = broken.currentPeriodActuals;
  const bellTx = (packet.transactions || []).find(tx => Number(tx.amount) === SEP_TX);
  ok(bellTx && bellTx.pending !== true
      && bellTx.accountRole === 'revolving-credit'
      && bellTx.atlasAccountId === 'travelvisa'
      && bellTx.representedBill !== true
      && /bell\s*mobility/i.test(String(bellTx.displayedPayee || '')),
    'posted Travel Visa Bell Mobility $283.94 reaches the sanitized packet unclassified as a bill');
  const cls = F.classifyCurrentPeriodTransaction(bellTx, liveData().plan, {
    currentPeriodActuals: packet,
  });
  ok(cls.kind === 'unclassified' && cls.needsConfirmation === true
      && cls.householdSpending === true
      && cls.reason === 'no-category',
    'the unclassified path is no-category, not a new merchant engine');
  const advice = recommendFromReport(broken, SEP_AS_OF);
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  ok(other && reconHasBell(other, SEP_TX) && near(other.spent, SEP_OBSERVED_HOUSEHOLD),
    'Other spending includes the $283.94 plus the unrelated residual');
  const bill = actionBill(advice, SEP_ID) || calendarBill(active, SEP_ID);
  ok(bill && (bill.settlement === 'unverified' || bill.status !== 'PAID')
      && near(bill.planned != null ? bill.planned : bill.amount, SEP_PLANNED)
      && (bill.actual == null || bill.actual === 0 || bill.remaining == null
        || near(bill.remaining, SEP_PLANNED)),
    'bell-sep15-2026 stays still-due at the planned $283.94 when unmatched');
}

console.log('\n=== 3. A Travel Visa Bell debit does not settle September; standing stays Travel Visa ===');
{
  const identity = identityDoc();
  const onceRule = (identity.rules || []).find(r => r && r.eventId === SEP_ID);
  const recRule = (identity.rules || []).find(r => r && r.eventId === REC_ID
    && r.atlasAccountId === 'travelvisa');
  ok(onceRule && onceRule.atlasAccountId === 'chequing-a' && onceRule.direction === 'debit'
      && (onceRule.payeePatterns || []).includes('Bell Mobility')
      && (onceRule.payeePatterns || []).includes('BELLMOBILITY')
      && onceRule.postingDateRule === EARLY_RULE
      && onceRule.settlesWhen === 'two-leg-sum'
      && onceRule.sameAccountSplitLegs === true,
    'Sep Bell identity is the explicit chequing-a same-account split; amount is not identity');
  ok(recRule && recRule.atlasAccountId === 'travelvisa' && recRule.direction === 'debit'
      && recRule.postingDateRule === EARLY_RULE
      && !recRule.settlesWhen
      && !recRule.sameAccountSplitLegs,
    'standing Bell Travel Visa identity stays payee + Travel Visa + debit; amount is not identity');
  const report = observeWith(identity, SEP_AS_OF, sepTxs());
  const hits = report.representedEventCandidates || [];
  ok(!hits.some(c => c && c.id === SEP_ID),
    'one Travel Visa Bell Mobility debit does not settle bell-sep15-2026');
  const packet = report.currentPeriodActuals;
  ok(packet && O.currentPeriodActualsLooksSanitized(packet),
    'current-period packet remains sanitized');
  ok(!(packet.representedActuals || []).some(r => r && r.id === SEP_ID),
    'representedActuals does not carry the Travel Visa debit against September Bell');
  const bellTx = (packet.transactions || []).find(tx => Number(tx.amount) === SEP_TX);
  ok(bellTx && bellTx.representedBill !== true && bellTx.pending !== true
      && bellTx.accountRole === 'revolving-credit'
      && bellTx.atlasAccountId === 'travelvisa',
    'the posted Travel Visa row stays unlinked to the September bill');
  const cls = F.classifyCurrentPeriodTransaction(bellTx, liveData().plan, {
    currentPeriodActuals: packet,
  });
  ok(cls.kind !== 'bill' && cls.reason !== 'represented-bill',
    'Forecast does not classify the Travel Visa debit as the represented September bill');
}

console.log('\n=== 4. A Travel Visa Bell debit stays in Other spending ===');
{
  const before = recommendFromReport(
    observeWith(identityWithoutBell(identityDoc()), SEP_AS_OF, sepTxs()), SEP_AS_OF);
  const after = recommendFromReport(observeWith(identityDoc(), SEP_AS_OF, sepTxs()), SEP_AS_OF);
  const beforeOther = otherRow(period(before.defaultView, 'this-pay-period'));
  const afterOther = otherRow(period(after.defaultView, 'this-pay-period'));
  const beforeSpent = beforeOther ? Number(beforeOther.spent) : 0;
  const afterSpent = afterOther ? Number(afterOther.spent) : 0;
  ok(near(beforeSpent - afterSpent, 0) && near(afterSpent, SEP_OBSERVED_HOUSEHOLD),
    'Other spending does not fall when the only Bell evidence is one Travel Visa debit',
    `${beforeSpent} → ${afterSpent}`);
  ok(afterOther && reconHasBell(afterOther, SEP_TX),
    'the Travel Visa $283.94 remains in Other spending');
}

console.log('\n=== 5. September stays still-due; planned amount is not rewritten ===');
{
  const data = liveData();
  const planned = Number(bellBill(data, SEP_ID).amount);
  const report = observeWith(identityDoc(), SEP_AS_OF, sepTxs());
  const advice = recommendFromReport(report, SEP_AS_OF);
  const active = period(advice.defaultView, 'this-pay-period');
  const action = actionBill(advice, SEP_ID);
  const calendar = calendarBill(active, SEP_ID);
  const bill = action || calendar;
  ok(bill && bill.settlement !== 'represented' && bill.status !== 'PAID'
      && near(bill.planned != null ? bill.planned : bill.amount, planned)
      && (bill.remaining == null || near(bill.remaining, planned)),
    'a Travel Visa debit leaves September Bell still-due at the planned $283.94');
  ok(near(planned, SEP_PLANNED),
    'classification does not rewrite the planned bell-sep15-2026 amount');
  const bellBills = (data.plan.bills || []).filter(b =>
    b && (b.id === SEP_ID || b.id === REC_ID));
  ok(bellBills.length === 2,
    'observe + Forecast keep the Sep once and the standing series');
}

console.log('\n=== 6. The Travel Visa debit is spending, not a September settlement ===');
{
  const report = observeWith(identityDoc(), SEP_AS_OF, sepTxs());
  const advice = recommendFromReport(report, SEP_AS_OF);
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  const categorized = budgetSpent(active);
  const otherSpent = other ? Number(other.spent) : 0;
  const action = actionBill(advice, SEP_ID);
  ok(reconHasBell(other, SEP_TX),
    'the Travel Visa $283.94 stays in Other spending');
  ok(!(active.householdBudget || []).some(row => !row.otherSpending && reconHasBell(row, SEP_TX)),
    'the Travel Visa debit is not moved into a named Household Budget category');
  ok(!action || action.settlement !== 'represented',
    'September Bell is not represented from the Travel Visa debit');
  const householdResidual = roundCent(categorized + otherSpent);
  ok(near(householdResidual, SEP_OBSERVED_HOUSEHOLD),
    'categorized + Other spending still holds the Travel Visa debit and the residual',
    String(householdResidual));
}

console.log('\n=== 7. OTHER TRANSACTIONS UNCHANGED ===');
{
  const after = recommendFromReport(observeWith(identityDoc(), SEP_AS_OF, sepTxs()), SEP_AS_OF);
  const other = otherRow(period(after.defaultView, 'this-pay-period'));
  ok(other && near(other.spent, SEP_OBSERVED_HOUSEHOLD)
      && (other.recon || []).some(tx =>
        tx && Number(tx.amount) === OTHER_TX
        && /dollarama/i.test(String(tx.displayedPayee || tx.originalMerchant || ''))),
    'unrelated Dollarama remains in Other spending beside the unsettled Travel Visa debit');
}

console.log('\n=== 8. amount / account / payee are not guessed; once is not reused ===');
{
  const identity = identityDoc();
  const amountOnly = observeWith(identity, SEP_AS_OF, [{
    id: 9703, account_id: TRAVEL_PROVIDER_ID, date: SEP_AS_OF, amount: SEP_TX,
    is_pending: false, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  }]);
  ok(!(amountOnly.representedEventCandidates || []).some(c => c.id === SEP_ID || c.id === REC_ID),
    'date + $283.94 without the Bell Mobility payee does not settle the bill');

  const wrongAccount = observeWith(identity, SEP_AS_OF, [{
    id: 9704, account_id: 1001, date: SEP_AS_OF, amount: SEP_TX,
    is_pending: false, payee: 'Bell Mobility', original_name: 'Bell Mobility',
  }]);
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c.id === SEP_ID || c.id === REC_ID),
    'one Bell Mobility debit on Chequing A does not settle September');

  const chequingB = observeWith(identity, SEP_AS_OF, [{
    id: 9705, account_id: 1002, date: SEP_AS_OF, amount: SEP_TX,
    is_pending: false, payee: 'Bell Mobility', original_name: 'Bell Mobility',
  }]);
  ok(!(chequingB.representedEventCandidates || []).some(c => c.id === SEP_ID || c.id === REC_ID),
    'one Bell Mobility debit on Chequing B does not settle September');

  const early = observeWith(identity, '2026-09-14', [{
    id: 9706, account_id: TRAVEL_PROVIDER_ID, date: '2026-09-10', amount: 240.11,
    is_pending: false, payee: 'Bell Mobility', original_name: 'BELLMOBILITY',
  }]);
  ok(!(early.representedEventCandidates || []).some(c => c && c.id === SEP_ID),
    'an early Travel Visa Bell Mobility debit does not settle September');

  const later = observeWith(identity, '2026-09-30', [{
    id: 9801, account_id: TRAVEL_PROVIDER_ID, date: '2026-09-30', amount: SEP_TX,
    is_pending: false, payee: 'Bell Mobility', original_name: 'Bell Mobility',
  }]);
  ok(!(later.representedEventCandidates || []).some(c => c.id === SEP_ID
        || c.id === REC_ID),
    'a late-September Travel Visa Bell debit does not reuse the once due or settle the October series');
  const laterPacket = later.currentPeriodActuals;
  const laterTx = ((laterPacket && laterPacket.transactions) || [])
    .find(tx => Number(tx.amount) === SEP_TX);
  ok(laterTx && laterTx.representedBill !== true,
    'the late-September debit is not flagged representedBill');
  const laterCls = F.classifyCurrentPeriodTransaction(laterTx, liveData().plan, {
    currentPeriodActuals: laterPacket,
  });
  ok(laterCls.kind !== 'bill' || laterCls.reason !== 'represented-bill',
    'the late-September debit is not classified as the September bill');
}

console.log('\n=== 9. RECURRING Oct $159.03 settles standing bell, not the once, not Other spending ===');
{
  const report = observeWith(identityDoc(), REC_AS_OF, recTxs());
  const hits = report.representedEventCandidates || [];
  const hit = hits.find(c => c && c.id === REC_ID && c.date === REC_DUE);
  ok(hit && hit.amountNotUsed === true && hit.direction === 'debit'
      && hit.atlasAccountId === 'travelvisa'
      && hit.postingDate === REC_AS_OF
      && near(hit.observedAmount, REC_TX)
      && hits.filter(c => c && c.id === REC_ID).length === 1
      && !hits.some(c => c && c.id === SEP_ID),
    'unique Travel Visa Bell debit on 16 Oct settles standing bell at observed $159.03, not the September once');
  const packet = report.currentPeriodActuals;
  const billRow = (packet.representedActuals || []).find(r => r.id === REC_ID);
  ok(billRow && near(billRow.actual, REC_TX) && billRow.date === REC_DUE,
    'representedActuals carries the observed $159.03 against standing bell');
  const before = recommendFromReport(
    observeWith(identityWithoutBell(identityDoc()), REC_AS_OF, recTxs()), REC_AS_OF);
  const after = recommendFromReport(report, REC_AS_OF);
  const beforeOther = otherRow(period(before.defaultView, 'this-pay-period'));
  const afterOther = otherRow(period(after.defaultView, 'this-pay-period'));
  const beforeSpent = beforeOther ? Number(beforeOther.spent) : 0;
  const afterSpent = afterOther ? Number(afterOther.spent) : 0;
  ok(near(beforeSpent - afterSpent, REC_TX),
    'Other spending falls by independently $159.03 versus the unclassified twin',
    `${beforeSpent} → ${afterSpent}`);
  ok(afterOther && !reconHasBell(afterOther, REC_TX) && near(afterOther.spent, OTHER_TX),
    'the classified $159.03 leaves Other spending');
  const active = period(after.defaultView, 'this-pay-period');
  const calendar = calendarBill(active, REC_ID);
  const action = actionBill(after, REC_ID);
  const bill = action || calendar;
  ok(bill && (bill.settlement === 'represented' || bill.status === 'PAID')
      && near(bill.planned != null ? bill.planned : bill.amount, REC_PLANNED)
      && near(bill.actual != null ? bill.actual : REC_TX, REC_TX),
    'standing bell stays planned $160; observed $159.03 is settlement evidence');
  ok(near(REC_PLANNED, REC_TX) === false,
    'planned-reserve $160 is not the observed $159.03 spend');
  const householdResidual = roundCent(budgetSpent(active)
    + (afterOther ? Number(afterOther.spent) : 0));
  ok(near(householdResidual, OTHER_TX),
    'October categorized + Other spending is the unrelated residual only');
  ok(near(roundCent(householdResidual + REC_TX), REC_OBSERVED_HOUSEHOLD),
    'October categorized + Other + Bell actual = independently summed household spend');
}

console.log('\n=== 10. pages render; no Plan merchant special case ===');
{
  const { pageScriptsMatching } = require('./lib/page-scripts');
  const hits = pageScriptsMatching(/if\s*\(.*Bell Mobility/, /merchant\s*===\s*['\"]Bell Mobility['\"]/, /displayedPayee\s*===\s*['\"]Bell Mobility['\"]/);
  ok(hits.length === 0,
    'no page script (classic or Stack) special-cases the Bell Mobility payee', hits.join(', ') || 'none');
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8'));
  ok(!/function isBellMobility|BELL MOBILITY \| FORTIS/.test(forecastSrc),
    'Forecast does not grow a second Bell Mobility merchant engine');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Bell Travel Visa classification checks passed.');
