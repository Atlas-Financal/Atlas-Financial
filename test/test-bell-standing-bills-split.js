'use strict';
/* Standing Bell from 2026-10-15 is planned from BILLS ACCOUNT. The proven
 * BILLS two-leg settlement shape still settles one standing occurrence.
 * One posted chequing-a Bell Mobility debit does not. Amount is not
 * identity. The September once keeps its own grace and cannot be reused.
 * One payment's transaction ids cannot settle both occurrences. The
 * Travel Visa single-debit rule remains. Synthetic fixtures and
 * independent arithmetic (L-002 / L-006).
 *
 * `node test/test-bell-standing-bills-split.js`
 */
const fs = require('fs');
const path = require('path');
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

const SEP_ID = 'bell-sep15-2026';
const SEP_DUE = '2026-09-15';
const REC_ID = 'bell';
const REC_DUE = '2026-10-15';
const OCT_AS_OF = '2026-10-16';
const SEP_AS_OF = '2026-09-21';
const LEG_A = 90.4;
const LEG_B = 41.15;
const LEG_SUM = roundCent(LEG_A + LEG_B);
const PLANNED = 160;
const OTHER_TX = 19.17;
const VISA_TX = 159.03;
const TRAVEL_PROVIDER_ID = 2004;
const EARLY_RULE = 'covers-early-or-due-on-or-before-posting';

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
function withoutStandingBillsRule(identity) {
  const next = JSON.parse(JSON.stringify(identity));
  next.rules = (next.rules || []).filter(rule => !(rule
    && rule.eventId === REC_ID && rule.atlasAccountId === 'chequing-a'));
  return next;
}
function payload(asOf, txs) {
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
    transactions: txs || [],
  };
}
function bellTx(id, amount, extra) {
  return Object.assign({
    id,
    account_id: 1001,
    date: REC_DUE,
    amount,
    is_pending: false, currency: 'cad',
    payee: 'Bell Mobility',
    original_name: 'BELLMOBILITY',
  }, extra || {});
}
function otherTx() {
  return {
    id: 89999,
    account_id: 1001,
    date: REC_DUE,
    amount: OTHER_TX,
    is_pending: false, currency: 'cad',
    payee: 'Dollarama',
    original_name: 'Dollarama',
    category_id: 11,
  };
}
function octoberTxs() {
  return [bellTx(89001, LEG_A), bellTx(89002, LEG_B), otherTx()];
}
function observeWith(identity, asOf, txs, plan) {
  return O.observe({
    provider: 'lunchmoney',
    payload: payload(asOf, txs),
    accountMap: fixtureMap(),
    data: plan ? { plan } : liveData(),
    identity,
  });
}
function candidates(report) {
  return (report && report.representedEventCandidates) || [];
}
function standingHit(report, date) {
  return candidates(report).find(c => c && c.id === REC_ID && c.date === (date || REC_DUE)) || null;
}
function septemberHit(report) {
  return candidates(report).find(c => c && c.id === SEP_ID && c.date === SEP_DUE) || null;
}
function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function billRow(p, id) {
  return ((p && p.bills) || []).find(b => b && b.id === id) || null;
}
function actionBill(advice, id) {
  const action = advice && advice.currentPeriodAction;
  const rows = [].concat((action && action.bills) || [], (action && action.obligations) || []);
  return rows.find(b => b && b.id === id) || null;
}
function recommendFromReport(report, asOf) {
  const data = liveData();
  const represented = candidates(report)
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
function txIds(hit) {
  return (hit && hit.providerTransactionIds || [hit && hit.providerTransactionId])
    .filter(id => id != null)
    .map(String)
    .sort();
}

console.log('\n=== independent amounts, before settlement ===');
{
  const data = liveData();
  const standing = (data.plan.bills || []).find(b => b && b.id === REC_ID);
  ok(standing && standing.frequency === 'monthly' && standing.day === 15
      && standing.firstDue === REC_DUE && near(standing.amount, PLANNED)
      && standing.payingAccount === 'chequing-a' && standing.jointCash !== false
      && F.billAffectsJointCash(standing, data.plan) === true
      && F.isCardPaidBill(standing, data.plan) === false,
    'canonical standing bell stays $160 monthly from 2026-10-15 on BILLS ACCOUNT');
  ok(!near(LEG_SUM, PLANNED) && near(roundCent(LEG_A + LEG_B), LEG_SUM),
    'fixture legs sum by hand and that sum is not the planned $160',
    String(LEG_SUM));
  ok(!near(VISA_TX, PLANNED),
    'the Travel Visa fixture debit is not the planned $160');
}

console.log('\n=== both standing identities are explicit ===');
{
  const identity = identityDoc();
  const rules = (identity.rules || []).filter(r => r && r.eventId === REC_ID);
  const visa = rules.find(r => r.atlasAccountId === 'travelvisa');
  const bills = rules.find(r => r.atlasAccountId === 'chequing-a'
    && r.settlesWhen === 'two-leg-sum');
  const single = rules.find(r => r.atlasAccountId === 'chequing-a' && !r.settlesWhen);
  const once = (identity.rules || []).find(r => r && r.eventId === SEP_ID);
  ok(rules.length === 2 && visa && bills && !single && once,
    'standing bell has the Travel Visa rule and one chequing-a two-leg rule; September stays its own rule');
  ok(visa && visa.direction === 'debit' && visa.postingDateRule === EARLY_RULE
      && !visa.settlesWhen && visa.sameAccountSplitLegs !== true
      && (visa.payeePatterns || []).includes('Bell Mobility')
      && (visa.payeePatterns || []).includes('BELLMOBILITY'),
    'Travel Visa standing rule remains a single debit; amount is not on that rule');
  ok(bills && bills.direction === 'debit' && bills.postingDateRule === EARLY_RULE
      && bills.settlesWhen === 'two-leg-sum' && bills.sameAccountSplitLegs === true
      && (bills.payeePatterns || []).includes('Bell Mobility')
      && (bills.payeePatterns || []).includes('BELLMOBILITY'),
    'standing chequing-a rule opts into same-account two-leg settlement');
  ok(once && once.sameAccountSplitLegs === true && once.settlesWhen === 'two-leg-sum'
      && once.atlasAccountId === 'chequing-a',
    'September once keeps its own chequing-a split opt-in');
}

console.log('\n=== BEFORE: two BILLS legs do not settle standing bell ===');
{
  const report = observeWith(withoutStandingBillsRule(identityDoc()), OCT_AS_OF, octoberTxs());
  ok(!standingHit(report) && !septemberHit(report),
    'without the standing BILLS rule the October pair represents neither Bell occurrence');
  const advice = recommendFromReport(report, OCT_AS_OF);
  const active = period(advice.defaultView, 'this-pay-period');
  const bell = actionBill(advice, REC_ID) || billRow(active, REC_ID);
  const other = otherRow(active);
  ok(bell && bell.status !== 'PAID' && bell.settlement !== 'represented'
      && near(bell.planned != null ? bell.planned : bell.amount, PLANNED)
      && (bell.remaining == null || near(bell.remaining, PLANNED)),
    'standing bell stays due at the planned $160');
  const bellRecon = ((other && other.recon) || []).filter(tx =>
    tx && /bell/i.test(String(tx.displayedPayee || tx.originalMerchant || '')));
  const bellSpent = roundCent(bellRecon.reduce((s, tx) => s + Number(tx.amount), 0));
  ok(bellRecon.length === 2 && near(bellSpent, LEG_SUM),
    'both Bell legs sit in Other Spending at the hand-summed legs', String(bellSpent));
}

console.log('\n=== AFTER: two same-day BILLS legs settle one standing occurrence ===');
{
  const report = observeWith(identityDoc(), OCT_AS_OF, octoberTxs());
  const hits = candidates(report).filter(c => c && (c.id === REC_ID || c.id === SEP_ID));
  const hit = standingHit(report);
  ok(hits.length === 1 && hit && hit.identity === 'two-leg-payee+account+date'
      && hit.sameAccountSplitLegs === true
      && hit.amountNotUsed === true
      && hit.atlasAccountId === 'chequing-a'
      && hit.date === REC_DUE
      && txIds(hit).join(',') === '89001,89002'
      && near(hit.observedAmount, LEG_SUM)
      && !septemberHit(report),
    'one standing candidate carries both October legs; September is not reused');
  const packet = report.currentPeriodActuals;
  const actual = ((packet && packet.representedActuals) || [])
    .find(r => r && r.id === REC_ID && r.date === REC_DUE);
  ok(actual && near(actual.actual, LEG_SUM)
      && Array.isArray(actual.transactionIds) && actual.transactionIds.length === 2,
    'represented actual is the hand-summed legs and both local transaction ids');
  const linked = new Set(actual ? actual.transactionIds : []);
  const sources = ((packet && packet.transactions) || []).filter(tx => linked.has(tx.id));
  ok(sources.length === 2 && sources.every(tx => tx.representedBill === true
      && tx.pending !== true && tx.atlasAccountId === 'chequing-a')
      && near(roundCent(sources.reduce((s, tx) => s + Number(tx.amount), 0)), LEG_SUM),
    'both posted chequing-a rows are the represented bill and sum to the legs');
  const before = recommendFromReport(
    observeWith(withoutStandingBillsRule(identityDoc()), OCT_AS_OF, octoberTxs()), OCT_AS_OF);
  const after = recommendFromReport(report, OCT_AS_OF);
  const beforeOther = otherRow(period(before.defaultView, 'this-pay-period'));
  const afterActive = period(after.defaultView, 'this-pay-period');
  const afterOther = otherRow(afterActive);
  const beforeSpent = beforeOther ? Number(beforeOther.spent) : 0;
  const afterSpent = afterOther ? Number(afterOther.spent) : 0;
  ok(near(beforeSpent - afterSpent, LEG_SUM),
    'Other Spending falls by the hand-summed Bell legs',
    `${beforeSpent} → ${afterSpent}`);
  ok(afterOther && !((afterOther.recon) || []).some(tx => linked.has(tx.id))
      && near(afterSpent, OTHER_TX),
    'represented Bell transactions leave Other Spending; Dollarama remains');
  const bell = actionBill(after, REC_ID) || billRow(afterActive, REC_ID);
  ok(bell && (bell.status === 'PAID' || bell.settlement === 'represented')
      && near(bell.remaining, 0)
      && near(bell.planned != null ? bell.planned : bell.amount, PLANNED)
      && near(bell.actual, LEG_SUM),
    'standing bell is represented, remaining $0, planned $160 unchanged, actual is the legs');
}

console.log('\n=== September and October are different payments ===');
{
  const septemberLegs = [
    bellTx(88001, 70, { date: SEP_AS_OF }),
    bellTx(88002, 30, { date: SEP_AS_OF }),
  ];
  const octoberLegs = [bellTx(89001, LEG_A), bellTx(89002, LEG_B)];
  const septemberOnly = observeWith(identityDoc(), SEP_AS_OF, septemberLegs);
  ok(septemberHit(septemberOnly) && !standingHit(septemberOnly)
      && txIds(septemberHit(septemberOnly)).join(',') === '88001,88002',
    'the September pair settles only bell-sep15-2026');
  const octoberOnly = observeWith(identityDoc(), OCT_AS_OF, octoberLegs);
  ok(standingHit(octoberOnly) && !septemberHit(octoberOnly)
      && txIds(standingHit(octoberOnly)).join(',') === '89001,89002',
    'the October pair settles only standing bell@2026-10-15');
  const both = observeWith(identityDoc(), OCT_AS_OF, septemberLegs.concat(octoberLegs));
  const sep = septemberHit(both);
  const oct = standingHit(both);
  const sepIds = new Set(txIds(sep));
  const octIds = new Set(txIds(oct));
  ok(sep && oct && candidates(both).filter(c => c && (c.id === SEP_ID || c.id === REC_ID)).length === 2
      && [...sepIds].every(id => !octIds.has(id))
      && [...octIds].every(id => !sepIds.has(id)),
    'each pair settles its own occurrence; the id sets are disjoint');
  const overlapPlan = JSON.parse(JSON.stringify(liveData().plan));
  const standing = (overlapPlan.bills || []).find(b => b && b.id === REC_ID);
  standing.firstDue = SEP_DUE;
  const overlapEvents = F.expandEvents(overlapPlan, '2026-09-01', '2026-09-30', {})
    .filter(e => e && (e.id === SEP_ID || e.id === REC_ID) && e.date === SEP_DUE);
  ok(overlapEvents.length === 2,
    'synthetic same-day overlap places September once and standing bell on 2026-09-15');
  const overlap = observeWith(identityDoc(), SEP_AS_OF, [
    bellTx(87001, LEG_A, { date: SEP_DUE }),
    bellTx(87002, LEG_B, { date: SEP_DUE }),
  ], overlapPlan);
  ok(!septemberHit(overlap)
      && !candidates(overlap).some(c => c && c.id === REC_ID),
    'one payment whose ids cover both occurrences settles neither');
}

console.log('\n=== fail closed ===');
{
  const identity = identityDoc();
  const one = observeWith(identity, OCT_AS_OF, [bellTx(87001, LEG_A), otherTx()]);
  ok(!standingHit(one) && !septemberHit(one),
    '1. one posted BILLS Bell debit does not settle standing bell or September');
  const oneAdvice = recommendFromReport(one, OCT_AS_OF);
  const oneActive = period(oneAdvice.defaultView, 'this-pay-period');
  const oneOther = otherRow(oneActive);
  const oneBell = actionBill(oneAdvice, REC_ID) || billRow(oneActive, REC_ID);
  ok(oneBell && oneBell.status !== 'PAID' && oneBell.settlement !== 'represented'
      && near(oneBell.planned != null ? oneBell.planned : oneBell.amount, PLANNED)
      && (oneBell.remaining == null || near(oneBell.remaining, PLANNED)),
    'one posted BILLS Bell debit leaves standing bell due at the planned $160');
  const oneBellRecon = ((oneOther && oneOther.recon) || []).filter(tx =>
    tx && /bell/i.test(String(tx.displayedPayee || tx.originalMerchant || '')));
  ok(oneBellRecon.length === 1 && near(Number(oneBellRecon[0].amount), LEG_A)
      && oneOther && near(oneOther.spent, roundCent(LEG_A + OTHER_TX)),
    'the unmatched first BILLS Bell leg stays in Other Spending with Dollarama');

  const three = observeWith(identity, OCT_AS_OF, [
    bellTx(87011, 10), bellTx(87012, 20), bellTx(87013, 30),
  ]);
  ok(!standingHit(three) && !septemberHit(three), '2. three Bell debit legs do not settle');

  const dup = observeWith(identity, OCT_AS_OF, [
    bellTx(87021, LEG_A),
    bellTx(87021, LEG_B),
  ]);
  ok(!standingHit(dup) && !septemberHit(dup), '3. two duplicate transaction ids do not settle');

  const mixed = observeWith(identity, OCT_AS_OF, [
    bellTx(87031, LEG_A),
    bellTx(87032, LEG_B, { payee: 'Dollarama', original_name: 'Dollarama' }),
  ]);
  ok(!standingHit(mixed) && !septemberHit(mixed),
    '4. one Bell debit plus an unrelated merchant does not settle');

  const wrongAccount = observeWith(identity, OCT_AS_OF, [
    bellTx(87041, LEG_A, { account_id: 1002 }),
    bellTx(87042, LEG_B, { account_id: 1002 }),
  ]);
  ok(!standingHit(wrongAccount) && !septemberHit(wrongAccount),
    '5. the same two legs on chequing-b do not settle');

  const wrongDate = observeWith(identity, OCT_AS_OF, [
    bellTx(87051, LEG_A, { date: '2026-10-01' }),
    bellTx(87052, LEG_B, { date: '2026-10-01' }),
  ]);
  ok(!standingHit(wrongDate) && !septemberHit(wrongDate),
    '6. a posting outside the standing early window does not settle October or reuse September');

  const splitDates = observeWith(identity, OCT_AS_OF, [
    bellTx(87061, LEG_A, { date: '2026-10-15' }),
    bellTx(87062, LEG_B, { date: '2026-10-16' }),
  ]);
  ok(!standingHit(splitDates) && !septemberHit(splitDates),
    'two posting dates do not settle');

  const lateSeptember = observeWith(identity, '2026-09-30', [
    bellTx(87071, LEG_A, { date: '2026-09-30' }),
    bellTx(87072, LEG_B, { date: '2026-09-30' }),
  ]);
  ok(!standingHit(lateSeptember) && !septemberHit(lateSeptember),
    'a posting after the September grace and before the October window settles neither');

  const septemberSingle = observeWith(identity, SEP_AS_OF, [
    bellTx(87101, LEG_A, { date: SEP_DUE }),
  ]);
  ok(!standingHit(septemberSingle) && !septemberHit(septemberSingle),
    'one September BILLS debit does not settle September or reuse it for October');

  const wrongSingle = observeWith(identity, OCT_AS_OF, [
    bellTx(87111, LEG_A, { account_id: 1002 }),
  ]);
  ok(!standingHit(wrongSingle) && !septemberHit(wrongSingle),
    'one Bell debit on chequing-b does not settle');

  const amountOnly = observeWith(identity, OCT_AS_OF, [
    bellTx(87081, PLANNED, { payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT' }),
    bellTx(87082, 0.01, { payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT' }),
  ]);
  ok(!standingHit(amountOnly) && !septemberHit(amountOnly),
    'two chequing-a debits that only match by amount do not settle standing bell');

  const pending = observeWith(identity, OCT_AS_OF, [
    bellTx(87091, LEG_A),
    bellTx(87092, LEG_B, { is_pending: true }),
  ]);
  ok(!standingHit(pending) && !septemberHit(pending),
    'a pending leg is not posted settlement evidence; one posted plus one pending does not settle');
}

console.log('\n=== Travel Visa standing behavior remains ===');
{
  const identity = identityDoc();
  const visaOnly = observeWith(identity, OCT_AS_OF, [{
    id: 9711, account_id: TRAVEL_PROVIDER_ID, date: OCT_AS_OF, amount: VISA_TX,
    is_pending: false, currency: 'cad', payee: 'Bell Mobility', original_name: 'BELLMOBILITY',
  }, otherTx()]);
  const visaHit = standingHit(visaOnly);
  ok(visaHit && visaHit.atlasAccountId === 'travelvisa' && visaHit.amountNotUsed === true
      && visaHit.sameAccountSplitLegs !== true
      && near(visaHit.observedAmount, VISA_TX)
      && !septemberHit(visaOnly)
      && candidates(visaOnly).filter(c => c && c.id === REC_ID).length === 1,
    'one Travel Visa Bell debit still settles standing bell and not September');
  const withStrayLeg = observeWith(identity, OCT_AS_OF, [
    {
      id: 9711, account_id: TRAVEL_PROVIDER_ID, date: OCT_AS_OF, amount: VISA_TX,
      is_pending: false, currency: 'cad', payee: 'Bell Mobility', original_name: 'BELLMOBILITY',
    },
    bellTx(9721, LEG_A),
  ]);
  const strayHit = standingHit(withStrayLeg);
  ok(strayHit && strayHit.atlasAccountId === 'travelvisa'
      && near(strayHit.observedAmount, VISA_TX)
      && txIds(strayHit).join(',') === '9711'
      && !septemberHit(withStrayLeg),
    'one BILLS leg does not block or join the Travel Visa debit');
  const bothShapes = observeWith(identity, OCT_AS_OF, [
    {
      id: 9711, account_id: TRAVEL_PROVIDER_ID, date: OCT_AS_OF, amount: VISA_TX,
      is_pending: false, currency: 'cad', payee: 'Bell Mobility', original_name: 'BELLMOBILITY',
    },
    bellTx(9731, LEG_A),
    bellTx(9732, LEG_B),
  ]);
  ok(!standingHit(bothShapes) && !septemberHit(bothShapes),
    'an accepted BILLS pair and a Travel Visa debit for the same occurrence settle neither');
  const advice = recommendFromReport(visaOnly, OCT_AS_OF);
  const active = period(advice.defaultView, 'this-pay-period');
  const bell = actionBill(advice, REC_ID) || billRow(active, REC_ID);
  const other = otherRow(active);
  ok(bell && (bell.status === 'PAID' || bell.settlement === 'represented')
      && near(bell.planned != null ? bell.planned : bell.amount, PLANNED)
      && near(bell.actual, VISA_TX),
    'Travel Visa settlement keeps planned $160 and records the observed debit');
  const bellRecon = ((other && other.recon) || []).filter(tx =>
    tx && /bell/i.test(String(tx.displayedPayee || tx.originalMerchant || '')));
  ok(bellRecon.length === 0 && other && near(other.spent, OTHER_TX),
    'the represented Travel Visa Bell debit is not in Other Spending');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll standing Bell BILLS split checks passed.');
