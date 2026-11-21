'use strict';
/* Live Plan residual: the posted Sep 4 BC Hydro $232.00 debit is the
 * incumbent hydro-due-sep1 actual, not Other spending. Identity is the
 * existing transaction-identity rule (payee + BILLS + debit + covers
 * due on or before posting). Amount is not identity. Forecast remains
 * the classifier. Synthetic observe fixtures and independent arithmetic
 * (L-002 / L-006).
 *
 * `node test/test-bc-hydro-sep4-classification.js`
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

const AS_OF = '2026-09-04';
const HYDRO_TX = 232.00;
const OTHER_TX = 19.17;
const OBSERVED_HOUSEHOLD = roundCent(HYDRO_TX + OTHER_TX);
const HYDRO_ID = 'hydro-due-sep1';
const HYDRO_DUE = '2026-09-01';

function liveData() {
  return load('data.json');
}

function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}

function fixtureMap() {
  return load('docs/connectivity/fixtures/provider-account-map.json');
}

function hydroBill(data) {
  return ((data && data.plan && data.plan.bills) || [])
    .find(b => b && b.id === HYDRO_ID) || null;
}

function identityWithoutHydro(identity) {
  const next = JSON.parse(JSON.stringify(identity));
  next.rules = (next.rules || []).filter(r => r && r.eventId !== HYDRO_ID);
  return next;
}

function payload(extraTxs) {
  return {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-04T18:00:00.000Z',
    transactionWindow: {
      startDate: '2026-08-19',
      endDate: AS_OF,
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
        updated_at: '2026-09-04T17:55:00.000Z',
      },
      {
        id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 400,
        updated_at: '2026-09-04T17:55:00.000Z',
      },
    ],
    categories: [
      { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
    ],
    transactions: extraTxs || [
      {
        id: 9401, account_id: 1001, date: AS_OF, amount: HYDRO_TX,
        is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
      },
      {
        id: 9402, account_id: 1001, date: AS_OF, amount: OTHER_TX,
        is_pending: false, payee: 'Dollarama', original_name: 'Dollarama',
        category_id: 11,
      },
    ],
  };
}

function observeWith(identity, txs) {
  return O.observe({
    provider: 'lunchmoney',
    payload: payload(txs),
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
function reconHasHydro(row) {
  return ((row && row.recon) || []).some(tx =>
    tx && (Number(tx.amount) === HYDRO_TX
      || /bc\s*hydro/i.test(String(tx.displayedPayee || tx.originalMerchant || ''))));
}
function hydroActionBill(advice) {
  return (((advice && advice.currentPeriodAction) || {}).bills || [])
    .find(b => b && b.id === HYDRO_ID) || null;
}
function hydroCalendarBill(p) {
  return ((p && p.bills) || []).find(b =>
    b && (b.id === HYDRO_ID || /bc hydro/i.test(String(b.label || '')))) || null;
}

function recommendFromReport(report) {
  const data = liveData();
  const represented = ((report && report.representedEventCandidates) || [])
    .filter(c => c && c.id && c.date)
    .map(c => ({ id: c.id, date: c.date }));
  const plan = JSON.parse(JSON.stringify(data.plan));
  plan.opening = Object.assign({}, plan.opening, {
    asOf: AS_OF,
    priorAsOf: (data.plan.opening && data.plan.opening.asOf) || '2026-08-19',
    representedEvents: represented,
  });
  return F.recommend(plan, AS_OF, {
    debts: data.debts,
    currentPeriodActuals: report.currentPeriodActuals,
    representedEvents: represented,
    preservePaydayPeriodOrigin: true,
  });
}

console.log('\n=== 1. incumbent hydro-due-sep1 authority is already on main ===');
{
  const data = liveData();
  const hydro = hydroBill(data);
  const hydroBills = (data.plan.bills || []).filter(b =>
    b && (/hydro/i.test(String(b.id || '')) || /bc hydro/i.test(String(b.label || ''))));
  ok(hydro && hydro.frequency === 'once' && hydro.date === HYDRO_DUE
      && hydro.payingAccount === 'chequing-a'
      && hydro.householdObligation === true
      && hydro.budgetCategory == null
      && near(hydro.amount, 237.45),
    'canonical hydro-due-sep1 remains the one 1 September BILLS ACCOUNT due');
  ok(hydroBills.some(b => b.id === HYDRO_ID)
      && hydroBills.some(b => b.id === 'hydro-equal-payment')
      && !hydroBills.some(b => b.id === 'hydro-due-now')
      && hydroBills.length === 2,
    'Sep. 1 once due is preserved; authorized equal-payment series is the only other Hydro bill');
}

console.log('\n=== 2. BEFORE-DEFECT PATH: missing identity leaves $232 in Other spending ===');
{
  const broken = observeWith(identityWithoutHydro(identityDoc()));
  const hits = broken.representedEventCandidates || [];
  ok(!hits.some(c => c && c.id === HYDRO_ID),
    'without the hydro identity rule, observe does not represent hydro-due-sep1');
  const packet = broken.currentPeriodActuals;
  const hydroTx = (packet.transactions || []).find(tx => Number(tx.amount) === HYDRO_TX);
  ok(hydroTx && hydroTx.pending !== true
      && hydroTx.accountRole === 'household-cash'
      && hydroTx.atlasAccountId === 'chequing-a'
      && hydroTx.representedBill !== true
      && /bc hydro/i.test(String(hydroTx.displayedPayee || '')),
    'posted Chequing A BC Hydro $232.00 reaches the sanitized packet unclassified as a bill');
  const cls = F.classifyCurrentPeriodTransaction(hydroTx, liveData().plan, {
    currentPeriodActuals: packet,
  });
  ok(cls.kind === 'unclassified' && cls.needsConfirmation === true
      && cls.householdSpending === true
      && cls.reason === 'no-category',
    'the unclassified path is no-category, not a new merchant engine');
  const advice = recommendFromReport(broken);
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  ok(other && reconHasHydro(other) && near(other.spent, OBSERVED_HOUSEHOLD),
    'Other spending includes the $232 plus the unrelated residual');
  const bill = hydroActionBill(advice) || hydroCalendarBill(active);
  ok(bill && bill.settlement === 'unverified' && near(bill.planned, 237.45)
      && (bill.actual == null || bill.actual === 0)
      && near(bill.remaining, 237.45),
    'hydro-due-sep1 stays unverified at the planned $237.45 when unmatched');
}

console.log('\n=== 3. CLASSIFICATION: observe identity links the $232 as the hydro bill ===');
{
  const identity = identityDoc();
  const rule = (identity.rules || []).find(r => r && r.eventId === HYDRO_ID);
  ok(rule && rule.atlasAccountId === 'chequing-a' && rule.direction === 'debit'
      && (rule.payeePatterns || []).includes('BC Hydro')
      && (rule.payeePatterns || []).includes('BCHYDRO')
      && rule.postingDateRule === 'covers-due-on-or-before-posting'
      && !rule.settlesWhen,
    'hydro identity is payee + Chequing A + debit + covers-due; amount is not identity');
  const report = observeWith(identity);
  const hits = report.representedEventCandidates || [];
  const hit = hits.find(c => c && c.id === HYDRO_ID && c.date === HYDRO_DUE);
  ok(hit && hit.amountNotUsed === true && hit.direction === 'debit'
      && hit.atlasAccountId === 'chequing-a'
      && hit.postingDate === AS_OF
      && near(hit.observedAmount, HYDRO_TX)
      && hits.filter(c => c && c.id === HYDRO_ID).length === 1,
    'unique BC Hydro debit on Chequing A settles the 1 September occurrence at the observed $232');
  const packet = report.currentPeriodActuals;
  ok(packet && O.currentPeriodActualsLooksSanitized(packet),
    'current-period packet remains sanitized');
  const billRow = (packet.representedActuals || []).find(r => r.id === HYDRO_ID);
  ok(billRow && billRow.transactionId && near(billRow.actual, HYDRO_TX)
      && billRow.date === HYDRO_DUE && billRow.postedOn === AS_OF,
    'representedActuals carries the observed $232 against hydro-due-sep1');
  const hydroTx = (packet.transactions || []).find(tx =>
    tx && tx.id === billRow.transactionId);
  ok(hydroTx && hydroTx.representedBill === true && hydroTx.pending !== true
      && hydroTx.accountRole === 'household-cash',
    'the linked posted household-cash row is flagged representedBill');
  const cls = F.classifyCurrentPeriodTransaction(hydroTx, liveData().plan, {
    currentPeriodActuals: packet,
  });
  ok(cls.kind === 'bill' && cls.householdSpending === false
      && cls.reason === 'represented-bill',
    'Forecast classifies the observe-linked row as the represented hydro bill');
}

console.log('\n=== 4. OTHER SPENDING DELTA is independently $232.00 ===');
{
  const before = recommendFromReport(observeWith(identityWithoutHydro(identityDoc())));
  const after = recommendFromReport(observeWith(identityDoc()));
  const beforeOther = otherRow(period(before.defaultView, 'this-pay-period'));
  const afterOther = otherRow(period(after.defaultView, 'this-pay-period'));
  const beforeSpent = beforeOther ? Number(beforeOther.spent) : 0;
  const afterSpent = afterOther ? Number(afterOther.spent) : 0;
  ok(near(beforeSpent - afterSpent, HYDRO_TX),
    'Other spending falls by independently $232.00 versus the unclassified twin',
    `${beforeSpent} → ${afterSpent}`);
  ok(afterOther && !reconHasHydro(afterOther) && near(afterOther.spent, OTHER_TX),
    'the classified $232 leaves Other spending');
}

console.log('\n=== 5. BILL / ACTUAL VISIBILITY and planned amount stay distinct ===');
{
  const data = liveData();
  const planned = Number(hydroBill(data).amount);
  const report = observeWith(identityDoc());
  const advice = recommendFromReport(report);
  const active = period(advice.defaultView, 'this-pay-period');
  const actionBill = hydroActionBill(advice);
  const calendarBill = hydroCalendarBill(active);
  const bill = actionBill || calendarBill;
  ok(bill && (bill.settlement === 'represented' || bill.status === 'PAID')
      && near(bill.planned != null ? bill.planned : bill.amount, planned)
      && near(bill.actual != null ? bill.actual : bill.movement, HYDRO_TX)
      && (bill.remaining == null || near(bill.remaining, 0)),
    'Plan-path bill disclosure shows the observed $232 against the planned $237.45',
    JSON.stringify({
      action: actionBill && {
        settlement: actionBill.settlement, planned: actionBill.planned,
        actual: actionBill.actual, remaining: actionBill.remaining,
      },
      calendar: calendarBill && {
        status: calendarBill.status, amount: calendarBill.amount,
        actual: calendarBill.actual, remaining: calendarBill.remaining,
      },
    }));
  ok(near(planned, 237.45) && near(planned, HYDRO_TX) === false,
    'classification does not rewrite the planned hydro-due-sep1 amount');
  const hydroBills = (data.plan.bills || []).filter(b =>
    b && (/hydro/i.test(String(b.id || '')) || /bc hydro/i.test(String(b.label || ''))));
  ok(hydroBills.some(b => b.id === HYDRO_ID)
      && hydroBills.some(b => b.id === 'hydro-equal-payment')
      && hydroBills.length === 2,
    'observe + Forecast keep the Sep. 1 once due and do not invent hydro-due-now');
}

console.log('\n=== 6. EXACTLY ONCE: $232 is not Other spending and a second spend ===');
{
  const report = observeWith(identityDoc());
  const advice = recommendFromReport(report);
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  const categorized = budgetSpent(active);
  const otherSpent = other ? Number(other.spent) : 0;
  const packet = report.currentPeriodActuals;
  const actionBill = hydroActionBill(advice);
  const excludedBills = Number((advice.currentPeriodAction
    && advice.currentPeriodAction.excluded
    && advice.currentPeriodAction.excluded.bills) || 0);
  const billActual = actionBill && actionBill.actual != null
    ? Number(actionBill.actual)
    : Number(((packet.representedActuals || []).find(r => r.id === HYDRO_ID) || {}).actual);
  ok(!reconHasHydro(other),
    'the $232 is not in Other spending after the identity hit');
  ok(!(active.householdBudget || []).some(row => !row.otherSpending && reconHasHydro(row)),
    'the $232 is not also in a named Household Budget category');
  ok(near(billActual, HYDRO_TX),
    'the $232 appears once as hydro-due-sep1 actual settlement evidence');
  ok(near(excludedBills, HYDRO_TX),
    'sumCategoryActuals excluded.bills is independently the observed $232');
  const householdResidual = roundCent(categorized + otherSpent);
  ok(near(householdResidual, OTHER_TX),
    'categorized + Other spending is the unrelated residual only');
  ok(near(roundCent(householdResidual + billActual), OBSERVED_HOUSEHOLD),
    'categorized + Other + hydro actual = independently summed household-cash spend',
    `${householdResidual} + ${billActual} vs ${OBSERVED_HOUSEHOLD}`);
  ok(near(237.45, HYDRO_TX) === false,
    'planned-reserve relief ($237.45) is not the observed $232 spend');
}

console.log('\n=== 7. OTHER TRANSACTIONS UNCHANGED ===');
{
  const after = recommendFromReport(observeWith(identityDoc()));
  const other = otherRow(period(after.defaultView, 'this-pay-period'));
  ok(other && near(other.spent, OTHER_TX)
      && (other.recon || []).some(tx =>
        tx && Number(tx.amount) === OTHER_TX
        && /dollarama/i.test(String(tx.displayedPayee || tx.originalMerchant || ''))),
    'unrelated Dollarama remains in Other spending');
}

console.log('\n=== 8. amount / account / payee are not guessed ===');
{
  const identity = identityDoc();
  const amountOnly = observeWith(identity, [{
    id: 9403, account_id: 1001, date: AS_OF, amount: HYDRO_TX,
    is_pending: false, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  }]);
  ok(!(amountOnly.representedEventCandidates || []).some(c => c.id === HYDRO_ID),
    'date + $232.00 without the BC Hydro payee does not settle the bill');

  const wrongAccount = observeWith(identity, [{
    id: 9404, account_id: 1002, date: AS_OF, amount: HYDRO_TX,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c.id === HYDRO_ID),
    'same BC Hydro debit on Chequing B does not settle the BILLS ACCOUNT bill');

  const sameDay = observeWith(identity, [{
    id: 9405, account_id: 1001, date: HYDRO_DUE, amount: 240.11,
    is_pending: false, payee: 'BC Hydro', original_name: 'BCHYDRO',
  }]);
  const sameDayHit = (sameDay.representedEventCandidates || [])
    .find(c => c && c.id === HYDRO_ID);
  ok(sameDayHit && near(sameDayHit.observedAmount, 240.11),
    'a same-day Chequing A BC Hydro debit still matches; observed amount is kept');

  const later = observeWith(identity, [{
    id: 9501, account_id: 1001, date: '2026-09-15', amount: HYDRO_TX,
    is_pending: false, payee: 'BC Hydro', original_name: 'BC Hydro',
  }]);
  ok(!(later.representedEventCandidates || []).some(c => c.id === HYDRO_ID
        || c.id === 'hydro-equal-payment'),
    'a mid-September Chequing A BC Hydro debit does not reuse the once due or settle the next-bill series');
  const laterPacket = later.currentPeriodActuals;
  const laterTx = ((laterPacket && laterPacket.transactions) || [])
    .find(tx => Number(tx.amount) === HYDRO_TX);
  ok(laterTx && laterTx.representedBill !== true,
    'the mid-September debit is not flagged representedBill');
  const laterCls = F.classifyCurrentPeriodTransaction(laterTx, liveData().plan, {
    currentPeriodActuals: laterPacket,
  });
  ok(laterCls.kind !== 'bill' || laterCls.reason !== 'represented-bill',
    'the mid-September debit is not classified as the September bill');
}

console.log('\n=== 9. pages render; no Plan merchant special case ===');
{
  const { pageScriptsMatching } = require('./lib/page-scripts');
  const hits = pageScriptsMatching(/if\s*\(.*BC Hydro/, /merchant\s*===\s*['\"]BC Hydro['\"]/, /displayedPayee\s*===\s*['\"]BC Hydro['\"]/);
  ok(hits.length === 0,
    'no page script (classic or Stack) special-cases the BC Hydro payee', hits.join(', ') || 'none');
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public', 'forecast.js'), 'utf8'));
  ok(!/function isBcHydro|BC HYDRO \| FORTIS/.test(forecastSrc),
    'Forecast does not grow a second BC Hydro merchant engine');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll BC Hydro Sep 4 classification checks passed.');
