'use strict';
/* September Bell settlement — owner-directed 2026-09-21 live Bills audit.
 *
 * Two posted Bell Mobility debits on canonical chequing-a are one
 * settlement of bell-sep15-2026. The incumbent two-leg-sum shape still
 * requires two distinct accounts (TD fees). This occurrence opts in
 * with sameAccountSplitLegs. Amount is not identity.
 *
 * The Sep 11–24 sheet is a synthetic fixture shaped from that audit.
 * Expected remaining and Balance After Deductions are reconstructed
 * from plan amounts and the two fixture legs, not from the grouper.
 *
 * `node test/test-bell-same-account-split.js`
 */
const fs = require('fs');
const path = require('path');
const { sourceText } = require('./test-source-text');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');

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
const AFFIRM_ID = 'affirm-final';
const FEE_ID = 'tdfees';
const PAYDAY = '2026-09-11';
const AS_OF = '2026-09-21';
const POSTED = '2026-09-21';
const LEG_A = 265.65;
const LEG_B = 18.29;
const LEG_SUM = roundCent(LEG_A + LEG_B);
const AFFIRM = 32.53;
const PLANNED_BELL = 283.94;
const PRIME_ID = 'amazon-prime';
const PRIME = 11.19;
const GROCERY_PAYDAY = 900;
const PRIOR_GROCERY_PAYDAY = 450;
const GROCERY_RESERVE_DELTA = GROCERY_PAYDAY - PRIOR_GROCERY_PAYDAY;
const PLANNED_HOLD = roundCent(GROCERY_PAYDAY + 325 + 200 + 150 + 150);
const AUDITED_HOLD_BEFORE = roundCent(2287.17 + GROCERY_RESERVE_DELTA);
const UNRELATED = roundCent(AUDITED_HOLD_BEFORE - PLANNED_HOLD - LEG_SUM);
const DALE = 4264;
const AMANDA = 2168.85;
const CHILD = 219.45;
const INCOME = roundCent(DALE + AMANDA + CHILD);
const REMAINING_BEFORE = roundCent(PLANNED_BELL + AFFIRM + PRIME);
const REMAINING_AFTER = roundCent(AFFIRM + PRIME);
const LOAD_PARTS = [
  ['fit4less', 'bills', 'amount', 11.54],
  ['mortgage', 'obligations', 'amount', 1600],
  ['chatgpt-plus-amanda', 'bills', 'amount', 24.99],
  ['chatgpt-plus-dale', 'bills', 'amount', 28],
  ['icloud-storage', 'bills', 'amount', 13],
  ['shaw', 'bills', 'amount', 78.4],
  ['bcaa', 'bills', 'amount', 82.96],
  [SEP_ID, 'bills', 'amount', PLANNED_BELL],
  ['icbc', 'bills', 'amount', 99.91],
  ['resp', 'bills', 'amount', 100],
  ['netflix', 'bills', 'amount', 26.87],
  ['spotify', 'bills', 'amount', 26.87],
  ['tdcc', 'obligations', 'amount', 94.03],
  ['noble-garbage', 'bills', 'amount', 95.85],
  [PRIME_ID, 'bills', 'amount', PRIME],
  [AFFIRM_ID, 'bills', 'amount', AFFIRM],
  ['heloc', 'obligations', 'cashPayment', 814.18],
];
const PERIOD_BILL_LOAD = roundCent(LOAD_PARTS.reduce((sum, row) => sum + row[3], 0));
const BAD_BEFORE_FULL = roundCent(INCOME - PERIOD_BILL_LOAD - AUDITED_HOLD_BEFORE);
const HOLD_AFTER = roundCent(PLANNED_HOLD + UNRELATED);
const BAD_AFTER = roundCent(INCOME - PERIOD_BILL_LOAD - HOLD_AFTER);

const ALREADY = [
  { id: 'bcaa-aug15-outstanding', date: '2026-08-16' },
  { id: 'icbc-aug15-outstanding', date: '2026-08-16' },
  { id: 'resp-aug15-outstanding', date: '2026-08-16' },
  { id: 'mbna-aug31', date: '2026-08-31' },
  { id: 'hydro-due-sep1', date: '2026-09-01' },
  { id: 'mortgage', date: '2026-09-11' },
  { id: 'fit4less', date: '2026-09-11' },
  { id: 'shaw', date: '2026-09-14' },
  { id: 'icloud-storage', date: '2026-09-14' },
  { id: 'chatgpt-plus-dale', date: '2026-09-14' },
  { id: 'chatgpt-plus-amanda', date: '2026-09-14' },
  { id: 'bcaa', date: '2026-09-15' },
  { id: 'icbc', date: '2026-09-15' },
  { id: 'resp', date: '2026-09-15' },
  { id: 'netflix', date: '2026-09-17' },
  { id: 'spotify', date: '2026-09-23' },
];

function liveData() {
  const data = load('data.json');
  // The invented September Bell ledger owns its calculated cash premise;
  // later carried-card sender evidence is outside this settlement fixture.
  delete data.plan.obligations.find(row => row.id === 'mbna-aug31').sentPayments;
  return data;
}
function identityDoc() {
  return load('docs/connectivity/transaction-identity.json');
}
function fixtureMap() {
  return load('docs/connectivity/fixtures/provider-account-map.json');
}
function withoutSplitOptIn(identity) {
  const next = JSON.parse(JSON.stringify(identity));
  for (const rule of next.rules || []) {
    if (rule && rule.eventId === SEP_ID) delete rule.sameAccountSplitLegs;
  }
  return next;
}
function planField(plan, collection, id, field) {
  const row = ((plan && plan[collection]) || []).find(item => item && item.id === id);
  return row ? Number(row[field]) : null;
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
    date: POSTED,
    amount,
    currency: 'cad',
    is_pending: false,
    payee: 'Bell Mobility',
    original_name: 'BELLMOBILITY',
  }, extra || {});
}
function feeTx(id, accountId) {
  return {
    id,
    account_id: accountId,
    date: '2026-08-30',
    amount: 17.95,
    currency: 'cad',
    is_pending: false,
    payee: 'MONTHLY ACCOUNT FEE',
    original_name: 'MONTHLY ACCOUNT FEE',
  };
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
function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function billRow(p, id) {
  return ((p && p.bills) || []).find(b => b && b.id === id) || null;
}
function recommendAudited(report) {
  const data = liveData();
  const plan = JSON.parse(JSON.stringify(data.plan));
  plan.opening = Object.assign({}, plan.opening, {
    asOf: AS_OF,
    priorAsOf: '2026-08-19',
    paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: 310.47 },
  });
  const fromReport = ((report && report.representedEventCandidates) || [])
    .filter(c => c && c.id && c.date)
    .map(c => ({ id: c.id, date: c.date }));
  return F.recommend(plan, AS_OF, {
    debts: data.debts,
    currentPeriodActuals: report.currentPeriodActuals,
    representedEvents: ALREADY.concat(fromReport),
    preservePaydayPeriodOrigin: true,
  });
}
function auditedTxs() {
  return [
    bellTx(88001, LEG_A),
    bellTx(88002, LEG_B),
    {
      id: 88099, account_id: 1001, date: POSTED, amount: UNRELATED,
      is_pending: false, payee: 'Dollarama', original_name: 'Dollarama',
      category_id: 11,
    },
  ];
}
function bellCandidate(report) {
  return ((report && report.representedEventCandidates) || [])
    .find(c => c && c.id === SEP_ID && c.date === SEP_DUE) || null;
}
function reconHasId(row, id) {
  return ((row && row.recon) || []).some(tx => tx && tx.id === id);
}

console.log('\n=== independent Sep 11–24 reconstruction, before any settlement function ===');
{
  const plan = liveData().plan;
  ok(LOAD_PARTS.every(row => near(planField(plan, row[1], row[0], row[2]), row[3])),
    'each period-load part is the plan field, not a Forecast result');
  ok(near(PERIOD_BILL_LOAD, roundCent(3413.07 + PRIME)),
    'hand sum is the prior $3,413.07 Sep 11–24 load plus Amazon Prime $11.19',
    String(PERIOD_BILL_LOAD));
  ok(near(LEG_SUM, PLANNED_BELL) && near(LEG_A + LEG_B, 283.94),
    'fixture legs sum to $283.94; that sum is evidence, not an identity key',
    String(LEG_SUM));
  ok(near(REMAINING_BEFORE, roundCent(316.47 + PRIME))
      && near(roundCent(REMAINING_BEFORE - PLANNED_BELL - PRIME), AFFIRM),
    'prior remaining $316.47 plus Prime $11.19; Bell and Prime leave Affirm');
  ok(near(INCOME, 6652.30),
    'period income is Dale 4264 + Amanda 2168.85 + child 219.45', String(INCOME));
  ok(near(PLANNED_HOLD, 1725) && near(UNRELATED, 728.23),
    'audited hold is the $1,725 payday targets plus $728.23 other plus the Bell legs');
  ok(near(BAD_BEFORE_FULL, roundCent(952.06 - PRIME - GROCERY_RESERVE_DELTA)),
    'prior $952.06 falls by the Prime bill and by the $450 groceries reserve increase',
    String(BAD_BEFORE_FULL));
  ok(near(BAD_AFTER, roundCent(1236 - PRIME - GROCERY_RESERVE_DELTA))
      && near(roundCent(BAD_BEFORE_FULL + LEG_SUM), BAD_AFTER),
    'settling Bell still raises BAD by the legs; Prime stays in the load',
    String(BAD_AFTER));
  const pets = ((plan.budget && plan.budget.categories) || [])
    .find(c => c && c.id === 'pets');
  ok(pets && pets.paydayCadence === 'every-other-seaspan'
      && pets.paydayCadenceAnchor === '2026-08-28'
      && near(pets.plannedPayday, 100),
    'dog-food cadence record is unchanged');
  const heloc = (plan.obligations || []).find(o => o && o.id === 'heloc');
  ok(heloc && near(heloc.cashPayment, 814.18),
    'HELOC planned cash minimum stays $814.18');
}

console.log('\n=== rule is explicit and TD fees do not opt in ===');
{
  const identity = identityDoc();
  const once = (identity.rules || []).find(r => r && r.eventId === SEP_ID);
  const standingVisa = (identity.rules || []).find(r => r && r.eventId === 'bell'
    && r.atlasAccountId === 'travelvisa');
  const fees = (identity.rules || []).filter(r => r && r.eventId === FEE_ID);
  ok(once && once.atlasAccountId === 'chequing-a' && once.direction === 'debit'
      && once.postingDateRule === 'covers-early-or-due-on-or-before-posting'
      && once.settlesWhen === 'two-leg-sum'
      && once.sameAccountSplitLegs === true
      && (once.payeePatterns || []).includes('Bell Mobility')
      && (once.payeePatterns || []).includes('BELLMOBILITY'),
    'bell-sep15-2026 opts into same-account two-leg settlement on chequing-a');
  ok(standingVisa && !standingVisa.settlesWhen && standingVisa.sameAccountSplitLegs !== true,
    'the Travel Visa standing rule stays a single debit and does not itself opt into same-account splits');
  ok(fees.length === 2 && fees.every(r => r.settlesWhen === 'two-leg-sum'
      && r.sameAccountSplitLegs !== true)
      && fees.some(r => r.atlasAccountId === 'chequing-a')
      && fees.some(r => r.atlasAccountId === 'chequing-b'),
    'tdfees stays two accounts and does not opt into same-account combining');
  const src = sourceText(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'provider-observe.js'), 'utf8'));
  ok(/accounts\.size === 2/.test(src) && /sameAccountSplitLegs === true/.test(src),
    'the two-account gate remains; same-account combining requires the explicit flag');
}

console.log('\n=== BEFORE: without the split opt-in the two BILLS legs do not settle Bell ===');
{
  const report = observeWith(withoutSplitOptIn(identityDoc()), AS_OF, auditedTxs());
  ok(!bellCandidate(report),
    'two same-account Bell legs do not represent bell-sep15-2026 without the opt-in');
  const advice = recommendAudited(report);
  const active = period(advice.defaultView, 'this-pay-period');
  const bell = billRow(active, SEP_ID);
  const affirm = billRow(active, AFFIRM_ID);
  const other = otherRow(active);
  ok(bell && bell.status !== 'PAID' && bell.settlement !== 'represented'
      && near(bell.remaining, PLANNED_BELL),
    'Bell remains $283.94 remaining');
  ok(affirm && affirm.status !== 'PAID' && near(affirm.remaining, AFFIRM),
    'Affirm remains the other unsettled bill');
  ok(active && near(active.remainingBills, REMAINING_BEFORE),
    'remaining bills stay Bell + Affirm + Prime',
    String(active && active.remainingBills));
  const primeBefore = billRow(active, PRIME_ID);
  ok(primeBefore && primeBefore.status !== 'PAID' && near(primeBefore.remaining, PRIME),
    'Amazon Prime stays $11.19 remaining before Bell settlement');
  ok(active && near(active.periodBillLoad, PERIOD_BILL_LOAD),
    'period bill load includes Amazon Prime before settlement',
    String(active && active.periodBillLoad));
  const bellRecon = ((other && other.recon) || []).filter(tx =>
    tx && /bell/i.test(String(tx.displayedPayee || tx.originalMerchant || '')));
  const bellSpent = roundCent(bellRecon.reduce((s, tx) => s + Number(tx.amount), 0));
  ok(bellRecon.length === 2 && near(bellSpent, LEG_SUM),
    'both Bell legs total $283.94 inside Other Spending', String(bellSpent));
  ok(active && near(active.budgetHold, AUDITED_HOLD_BEFORE),
    'Household Budget hold includes the duplicate Bell spending',
    String(active && active.budgetHold));
  ok(active && near(active.balanceAfterDeductions, BAD_BEFORE_FULL),
    'Balance After Deductions subtracts the Prime bill',
    String(active && active.balanceAfterDeductions));
}

console.log('\n=== AFTER: the explicit split settles Bell once ===');
{
  const report = observeWith(identityDoc(), AS_OF, auditedTxs());
  const hits = (report.representedEventCandidates || []).filter(c => c && c.id === SEP_ID);
  const hit = bellCandidate(report);
  ok(hits.length === 1 && hit && hit.identity === 'two-leg-payee+account+date'
      && hit.sameAccountSplitLegs === true
      && hit.amountNotUsed === true
      && hit.atlasAccountId === 'chequing-a'
      && Array.isArray(hit.providerTransactionIds)
      && hit.providerTransactionIds.map(String).sort().join(',') === '88001,88002'
      && near(hit.observedAmount, LEG_SUM),
    'exactly one represented candidate carries both source transactions at the summed legs');
  const packet = report.currentPeriodActuals;
  const actual = ((packet && packet.representedActuals) || [])
    .find(r => r && r.id === SEP_ID && r.date === SEP_DUE);
  ok(actual && near(actual.actual, LEG_SUM)
      && Array.isArray(actual.transactionIds) && actual.transactionIds.length === 2,
    'represented actual is the independently summed legs and both local transaction ids');
  const linked = new Set(actual ? actual.transactionIds : []);
  const sources = ((packet && packet.transactions) || []).filter(tx => linked.has(tx.id));
  ok(sources.length === 2 && sources.every(tx => tx.representedBill === true
      && tx.pending !== true && tx.atlasAccountId === 'chequing-a'),
    'both posted chequing-a source rows are the represented bill');
  const advice = recommendAudited(report);
  const active = period(advice.defaultView, 'this-pay-period');
  const bell = billRow(active, SEP_ID);
  const affirm = billRow(active, AFFIRM_ID);
  const other = otherRow(active);
  const heloc = billRow(active, 'heloc');
  ok(bell && (bell.status === 'PAID' || bell.settlement === 'represented')
      && near(bell.remaining, 0)
      && near(bell.planned != null ? bell.planned : bell.amount, PLANNED_BELL)
      && near(bell.actual, LEG_SUM),
    'Bell is PAID / represented, remaining $0, planned amount unchanged');
  ok(affirm && affirm.status !== 'PAID' && near(affirm.remaining, AFFIRM),
    'Affirm remains $32.53 and is not settled by the Bell legs');
  ok(active && near(active.remainingBills, REMAINING_AFTER),
    'remaining bills is Affirm + Prime', String(active && active.remainingBills));
  const prime = billRow(active, PRIME_ID);
  ok(prime && prime.status !== 'PAID' && near(prime.remaining, PRIME),
    'Amazon Prime stays $11.19 remaining and is not settled by the Bell legs');
  ok(active && near(active.periodBillLoad, PERIOD_BILL_LOAD),
    'period bill load stays the hand sum, including Prime',
    String(active && active.periodBillLoad));
  ok(other && !((other.recon) || []).some(tx => linked.has(tx.id))
      && near(other.spent, UNRELATED),
    'neither Bell source transaction remains in Other Spending');
  ok(!(active.householdBudget || []).some(row =>
    row && !row.otherSpending && ((row.recon) || []).some(tx => linked.has(tx.id))),
    'neither Bell source transaction is in a named Household Budget category');
  ok(!(active.householdBudget || []).some(row => row && row.id === 'pets'),
    'Sep 11–24 still has no Dog food hold');
  ok(heloc && near(heloc.planned != null ? heloc.planned : heloc.amount, 814.18)
      && !near(heloc.actual, 900),
    'HELOC planned $814.18 is not rewritten as an observed $900');
  ok(active && near(active.budgetHold, HOLD_AFTER)
      && near(roundCent(AUDITED_HOLD_BEFORE - active.budgetHold), LEG_SUM),
    'Household Budget hold falls exactly $283.94',
    String(active && active.budgetHold));
  ok(active && near(active.balanceAfterDeductions, BAD_AFTER)
      && near(roundCent(active.balanceAfterDeductions - BAD_BEFORE_FULL), LEG_SUM),
    'Balance After Deductions rises exactly $283.94 when Bell settles',
    String(active && active.balanceAfterDeductions));
}

console.log('\n=== amount is not identity: unequal legs still settle by the rule ===');
{
  const oddA = 100;
  const oddB = 40;
  const oddSum = roundCent(oddA + oddB);
  ok(!near(oddSum, PLANNED_BELL),
    'this pair does not sum to the planned $283.94');
  const report = observeWith(identityDoc(), AS_OF, [
    bellTx(88111, oddA),
    bellTx(88112, oddB),
  ]);
  const hit = bellCandidate(report);
  ok(hit && hit.amountNotUsed === true && near(hit.observedAmount, oddSum)
      && hit.providerTransactionIds.map(String).sort().join(',') === '88111,88112',
    'identity settles; the represented actual is the sum of these other amounts');
  const stripped = observeWith(identityDoc(), AS_OF, [
    bellTx(88121, PLANNED_BELL, { payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT' }),
    bellTx(88122, 0.01, { payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT' }),
  ]);
  ok(!bellCandidate(stripped),
    'two chequing-a debits that only match by amount do not settle Bell');
}

console.log('\n=== fail closed ===');
{
  const identity = identityDoc();
  const one = observeWith(identity, AS_OF, [bellTx(87001, LEG_A)]);
  ok(!bellCandidate(one), '1. one Bell debit leg does not settle');

  const three = observeWith(identity, AS_OF, [
    bellTx(87011, 10), bellTx(87012, 20), bellTx(87013, 30),
  ]);
  ok(!bellCandidate(three), '2. three Bell debit legs do not settle');

  const dup = observeWith(identity, AS_OF, [
    bellTx(87021, LEG_A),
    bellTx(87021, LEG_B),
  ]);
  ok(!bellCandidate(dup), '3. two duplicate transaction ids do not settle');

  const mixed = observeWith(identity, AS_OF, [
    bellTx(87031, LEG_A),
    bellTx(87032, LEG_B, { payee: 'Dollarama', original_name: 'Dollarama' }),
  ]);
  ok(!bellCandidate(mixed), '4. one Bell debit plus an unrelated merchant does not settle');

  const wrongAccount = observeWith(identity, AS_OF, [
    bellTx(87041, LEG_A, { account_id: 1002 }),
    bellTx(87042, LEG_B, { account_id: 1002 }),
  ]);
  ok(!bellCandidate(wrongAccount), '5. the same two legs on chequing-b do not settle');

  const late = observeWith(identity, '2026-09-30', [
    bellTx(87051, LEG_A, { date: '2026-09-30' }),
    bellTx(87052, LEG_B, { date: '2026-09-30' }),
  ]);
  ok(!bellCandidate(late) && !((late.representedEventCandidates || [])
    .some(c => c && c.id === 'bell')),
    '6. a posting outside the once grace does not settle September or standing bell');

  const shadowPlan = JSON.parse(JSON.stringify(liveData().plan));
  shadowPlan.bills.push({
    id: 'bell-shadow',
    label: 'Bell shadow',
    frequency: 'once',
    date: SEP_DUE,
    amount: 10,
    confidence: 'confirmed',
    payingAccount: 'chequing-a',
  });
  const shadowIdentity = JSON.parse(JSON.stringify(identity));
  const onceRule = (shadowIdentity.rules || []).find(r => r && r.eventId === SEP_ID);
  shadowIdentity.rules.push(Object.assign({}, onceRule, { eventId: 'bell-shadow' }));
  const ambiguous = observeWith(shadowIdentity, AS_OF, [
    bellTx(87061, LEG_A),
    bellTx(87062, LEG_B),
  ], shadowPlan);
  ok(!bellCandidate(ambiguous)
      && !((ambiguous.representedEventCandidates || []).some(c => c && c.id === 'bell-shadow')),
    '7. two occurrences that both claim the same legs do not settle Bell');

  const splitDates = observeWith(identity, AS_OF, [
    bellTx(87071, LEG_A, { date: '2026-09-15' }),
    bellTx(87072, LEG_B, { date: '2026-09-16' }),
  ]);
  ok(!bellCandidate(splitDates),
    'same-account legs on different posting dates do not settle');

  const pending = observeWith(identity, AS_OF, [
    bellTx(87081, LEG_A),
    bellTx(87082, LEG_B, { is_pending: true }),
  ]);
  ok(!bellCandidate(pending), 'a pending leg is not posted settlement evidence');
}

console.log('\n=== TD fee two-account behavior stays intact ===');
{
  const identity = identityDoc();
  const same = observeWith(identity, '2026-08-30', [
    feeTx(86001, 1001),
    feeTx(86002, 1001),
  ]);
  ok(!((same.representedEventCandidates || []).some(c => c && c.id === FEE_ID)),
    '9. two same-account TD fee legs do not settle tdfees');
  const split = observeWith(identity, '2026-08-30', [
    feeTx(86011, 1001),
    feeTx(86012, 1002),
  ]);
  const hit = ((split.representedEventCandidates || [])
    .find(c => c && c.id === FEE_ID));
  ok(hit && hit.sameAccountSplitLegs !== true
      && Array.isArray(hit.atlasAccountIds)
      && new Set(hit.atlasAccountIds).size === 2
      && near(hit.observedAmount, 35.9),
    'two different named account legs still settle tdfees');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Bell same-account split checks passed.');
