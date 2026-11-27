'use strict';
/* Forecast keeps a pending possible-replacement row visible in recon and
 * counts the posted side once (PR #252), tagged estimated while the pair is
 * unresolved; pending exposure and Forecast recon membership stay on the
 * incumbent PR #252 / #250 semantics. No page script may infer identity
 * (L-001). Independent arithmetic (L-002 / L-006).
 *
 * The classic Possible duplicate mark and its disclosure markup retired with
 * the classic page (C1 S4 batch B1, owner ruling: V1-only behaviour retires).
 * The property that mark protected, a pending twin of a posted row never
 * counted twice, is held on the Stack page by hiding the pending twin (Dale,
 * 2026-11-20) and is proved by test-stack-budget-transactions.js (list = recon
 * less the twin, summing to published Spent; fails if the twin is listed) and
 * test-stack-trust.js (estimated treatment incl. possible duplicate). Here:
 * Forecast still flags the pair and confirms the spend once.
 *
 * `node test/test-household-budget-spent-possible-replacement-drilldown.js`
 */
const fs = require('fs');
// The "never" assertions read every page script, the Stack page included; positive "the classic page reads X" assertions
// stay on plan.js and retire with it (C1 S7, docs/C1_TEST_DISPOSITIONS.md).
const { neverRaw } = require('./lib/page-scripts');
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
const clone = x => JSON.parse(JSON.stringify(x));
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }, { id: 'chequing-b', value: 0 }],
    },
    opening: { asOf: '2026-08-28', representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4264, confidence: 'confirmed',
    }],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 450, ownerLine: 'Groceries' },
        { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedPayday: 325, ownerLine: 'Fuel' },
        { id: 'household', label: 'Household', class: 'essential', plannedPayday: 37.5, ownerLine: 'Household' },
        { id: 'pets', label: 'Pets', class: 'essential', plannedPayday: 100, ownerLine: 'Dog food' },
        { id: 'restaurants', label: 'Dining', class: 'discretionary', from: ['Restaurants', 'Dining', 'Fast Food', 'Food Delivery'], plannedPayday: 200, ownerLine: 'Eating out' },
        { id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Dale guilt-free spending' },
        { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary', plannedPayday: 150, ownerLine: 'Amanda guilt-free spending' },
        { id: 'shopping', label: 'Shopping', class: 'discretionary', from: ['Shopping', 'Personal'] },
      ],
    },
  };
}

const debts = [
  { id: 'tdcc', label: 'TD personal Visa', secured: false, structure: 'Revolving', balance: 90, rate: 24.99, payment: 94.03, pending: 0 },
  { id: 'heloc', label: 'HELOC', secured: true, structure: 'Interest-only revolving', balance: 1000, rate: 4.9, payment: 0, pending: 0, cashPayment: 0, interestTreatment: 'capitalised' },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

const map = {
  schema: 'atlas-provider-account-map/v1',
  mappings: [
    {
      providerAccountId: '3006',
      canonical: { collection: 'debts', id: 'travelvisa' },
      atlasRole: 'revolving-credit',
    },
    {
      providerAccountId: '1001',
      canonical: { collection: 'cash', id: 'chequing-a' },
      atlasRole: 'household-cash',
    },
  ],
};

const AS_OF = '2026-09-01';
const AICHAT_AMT = 44.99;
const CALENDLY_AMT = 19.17;
const AMAZON_AMT = 39.99;
const GENERIC_AMT = 23.41;
const SHOPIFY_AMT = 54.88;
const AMAZON_NEAR_AMT = 29.99;
const PLAID_PENDING_AMT = 100.00;
const PLAID_POSTED_AMT = 97.50;
const PLAID_UNRELATED_AMT = 42.00;

const LIVE_CONFIRMED = roundCent(AICHAT_AMT + CALENDLY_AMT);
const LIVE_DOUBLE = roundCent(AICHAT_AMT + AICHAT_AMT + CALENDLY_AMT + CALENDLY_AMT);
const TWO_SHOPIFY = roundCent(SHOPIFY_AMT + SHOPIFY_AMT);
const AMAZON_NEAR_TOTAL = roundCent(AMAZON_NEAR_AMT + AMAZON_NEAR_AMT);
const PLAID_SETTLED = roundCent(PLAID_POSTED_AMT + PLAID_UNRELATED_AMT);
const PLAID_DOUBLE = roundCent(PLAID_PENDING_AMT + PLAID_POSTED_AMT + PLAID_UNRELATED_AMT);

function actualsPacket(txs, extra) {
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: AS_OF,
    coverageStart: '2026-07-01',
    coverageThrough: AS_OF,
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    representedActuals: [],
    transactions: txs,
  }, extra || {});
}

function recommend(packet) {
  return F.recommend(syntheticPlan(), AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: packet,
    representedEvents: [],
  });
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r.id === id) || null;
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function householdSpent(p) {
  return roundCent(((p && p.householdBudget) || []).reduce((s, row) => {
    return s + (Number(row && row.spent) || 0);
  }, 0));
}
function confirmedFromRecon(row) {
  return roundCent(((row && row.recon) || []).reduce((s, tx) => {
    if (tx && tx.pendingPostedDuplicate === true && tx.pending === true) return s;
    return s + (Number(tx && tx.amount) || 0);
  }, 0));
}
function twin(id, merchant, amount, pending, extra) {
  return Object.assign({
    id,
    date: '2026-09-01',
    amount,
    pending,
    pendingTreatment: pending ? 'unresolved' : 'confirmed-settled',
    categoryLabel: null,
    accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    account: 'travelvisa',
    displayedPayee: merchant,
    originalMerchant: merchant,
  }, extra || {});
}
function sanitizedFrom(collapsed, extra) {
  return O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-01T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-01', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: collapsed,
    representedEventCandidates: [],
  }, Object.assign({ asOf: AS_OF, plan: syntheticPlan(), accountMap: map }, extra || {}));
}
ok(near(LIVE_CONFIRMED, 64.16) && near(LIVE_DOUBLE, 128.32)
    && near(TWO_SHOPIFY, 109.76) && near(AMAZON_NEAR_TOTAL, 59.98)
    && near(PLAID_SETTLED, 139.50) && near(PLAID_DOUBLE, 239.50)
    && near(GENERIC_AMT, 23.41) && near(AMAZON_AMT, 39.99),
  'independent fixture arithmetic: posted-only $64.16 vs double $128.32; two Shopify $109.76; nearby Amazon $59.98; Plaid settled $139.50 vs $239.50; generic $23.41; Amanda Amazon $39.99');


console.log('\n=== 1–5. flagged pending omitted from drill-down; Forecast evidence intact ===');
{
  const txs = [
    twin('tx-ai-post', 'AICHATAPP', AICHAT_AMT, false),
    twin('tx-ai-pend', 'AICHATAPP', AICHAT_AMT, true),
    twin('tx-cal-post', 'Calendly', CALENDLY_AMT, false),
    twin('tx-cal-pend', 'Calendly', CALENDLY_AMT, true),
  ];
  const packet = actualsPacket(txs);
  const advice = recommend(packet);
  const p = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(p);
  const recon = (other && other.recon) || [];
  const pendingRecon = (other && other.pendingRecon) || [];
  ok(other && recon.length === 4
      && recon.every(r => r.pendingPostedDuplicate === true)
      && recon.some(r => r.id === 'tx-ai-pend' && r.pending === true)
      && recon.some(r => r.id === 'tx-cal-pend' && r.pending === true)
      && pendingRecon.some(r => r.id === 'tx-ai-pend')
      && pendingRecon.some(r => r.id === 'tx-cal-pend'),
    'Forecast recon and pendingRecon still retain both unresolved pairs');
  ok(near(other.spent, LIVE_CONFIRMED)
      && near(confirmedFromRecon(other), LIVE_CONFIRMED)
      && near(householdSpent(p), LIVE_CONFIRMED)
      && !near(other.spent, LIVE_DOUBLE),
    'confirmed Spent stays PR #252 posted-only $44.99+$19.17=$64.16',
    String(other.spent));

  const fixture = load('docs/connectivity/fixtures/lunchmoney-pending-acceptance.json');
  const accountMap = load('docs/connectivity/fixtures/pending-account-map.json');
  const identity = load('docs/connectivity/transaction-identity.json');
  const data = load('data.json');
  const extra = clone(fixture);
  extra.transactions.push(
    {
      id: 91001, account_id: 3006, date: '2026-08-16', amount: AICHAT_AMT,
      payee: 'AICHATAPP', is_pending: false, status: 'reviewed',
    },
    {
      id: 91002, account_id: 3006, date: '2026-08-16', amount: AICHAT_AMT,
      payee: 'AICHATAPP', is_pending: true, status: 'unreviewed',
    }
  );
  const independentPending = roundCent(250 + AICHAT_AMT);
  ok(near(independentPending, 294.99),
    'independent Travel Visa pending exposure is Bell $250 + unresolved $44.99');
  const report = O.observe({
    provider: 'lunchmoney',
    payload: extra,
    accountMap,
    data,
    identity,
    fetchedAt: extra.fetchedAt,
  });
  const pending = (report.observations || []).find(o => o.observationId === 'lm-3006-pending');
  const aiPend = pending && (pending.components || []).find(c => c.providerTransactionId === '91002');
  // No provider link ties the unresolved twin to the posted row, so the card's
  // pending exposure is unknown rather than the exact sum above; the row is
  // still kept in the exposure's components, flagged as a possible replacement.
  ok(pending && pending.unknown === true && pending.evidenceValue === null
      && pending.unknownReason === 'pending-replacement-unresolved'
      && aiPend && aiPend.contributesToCurrentPending === true
      && aiPend.settlementTreatment === 'unresolved'
      && aiPend.possibleReplacement === true,
    'revolving pending exposure is unknown; the unresolved row is kept and flagged',
    pending && String(pending.evidenceValue));
}

console.log('\n=== 6. generic merchant uses the same incumbent mark, not a name ===');
{
  const txs = [
    twin('tx-gen-post', 'ZEPHYR WIDGETS LLC', GENERIC_AMT, false),
    twin('tx-gen-pend', 'ZEPHYR WIDGETS LLC', GENERIC_AMT, true),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(p);
  const recon = (other && other.recon) || [];
  ok(other && recon.length === 2
      && recon.every(r => r.pendingPostedDuplicate === true)
      && recon.some(r => r.id === 'tx-gen-pend' && r.pending === true)
      && near(other.spent, GENERIC_AMT)
      && near(confirmedFromRecon(other), GENERIC_AMT),
    'Forecast flags the generic pair and confirms spend once at $23.41');
}

console.log('\n=== 7. two genuine posted Shopify rows stay two visible rows ===');
{
  const txs = [
    twin('tx-shop-a', 'SHOPIFY INC/999001', SHOPIFY_AMT, false, { date: '2026-08-31' }),
    twin('tx-shop-b', 'SHOPIFY INC/999001', SHOPIFY_AMT, false, { date: '2026-08-31' }),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(p);
  const recon = (other && other.recon) || [];
  ok(other && recon.length === 2
      && recon.every(r => r.pendingPostedDuplicate !== true)
      && near(other.spent, TWO_SHOPIFY),
    'Forecast still treats two posted Shopify $54.88 as $109.76 confirmed');
}

console.log('\n=== 8. different-date Amazon not flagged stays two visible rows ===');
{
  const txs = [
    twin('tx-amz-post', 'Amazon', AMAZON_NEAR_AMT, false, {
      date: '2026-08-30', categoryLabel: 'Shopping',
    }),
    twin('tx-amz-pend', 'Amazon', AMAZON_NEAR_AMT, true, {
      date: '2026-09-01', categoryLabel: 'Shopping',
    }),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(p, 'amanda-guilt-free');
  const recon = (amanda && amanda.recon) || [];
  ok(amanda && recon.length === 2
      && recon.every(r => r.pendingPostedDuplicate !== true)
      && recon.some(r => r.pending === true)
      && recon.some(r => r.pending === false)
      && near(amanda.spent, AMAZON_NEAR_TOTAL),
    'Forecast does not flag different-date Amazon $29.99 as possible replacement');
}

console.log('\n=== 8b. same-day flagged Amazon pending is omitted; posted remains ===');
{
  const txs = [
    twin('tx-amz39-post', 'Amazon', AMAZON_AMT, false, { categoryLabel: 'Shopping' }),
    twin('tx-amz39-pend', 'Amazon', AMAZON_AMT, true, { categoryLabel: 'Shopping' }),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(p, 'amanda-guilt-free');
  const recon = (amanda && amanda.recon) || [];
  ok(amanda && recon.length === 2
      && recon.every(r => r.pendingPostedDuplicate === true)
      && near(amanda.spent, AMAZON_AMT)
      && (amanda.pendingRecon || []).some(r => r.id === 'tx-amz39-pend'),
    'Forecast flags the same-day Amazon $39.99 pair and confirms spend once');
}

console.log('\n=== 9. proven directed Plaid collapse from PR #250 remains intact ===');
{
  const packet = sanitizedFrom([
    {
      date: '2026-08-31', amount: PLAID_PENDING_AMT, pending: true, categoryLabel: 'Shopping',
      payee: 'AMZN Mktp CA', originalName: 'AMZN Mktp CA',
      providerAccountId: '3006', providerTransactionId: 'lm-pending-101',
      plaidMetadata: { transaction_id: 'plaid-pending-abc' },
    },
    {
      date: '2026-08-31', amount: PLAID_POSTED_AMT, pending: false, categoryLabel: 'Shopping',
      payee: 'AMZN Mktp CA', originalName: 'AMZN Mktp CA',
      providerAccountId: '3006', providerTransactionId: 'lm-posted-202',
      plaidMetadata: {
        transaction_id: 'plaid-posted-def',
        pending_transaction_id: 'plaid-pending-abc',
      },
    },
    {
      date: '2026-08-31', amount: PLAID_UNRELATED_AMT, pending: false, categoryLabel: 'Gifts',
      payee: 'Gift Shop', originalName: 'Gift Shop',
      providerAccountId: '1001', providerTransactionId: 'lm-posted-unrelated',
    },
  ]);
  const txs = packet.transactions || [];
  const pendingLeft = txs.some(tx => tx.pending === true && near(tx.amount, PLAID_PENDING_AMT));
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  ok(!pendingLeft && near(householdSpent(p), PLAID_SETTLED)
      && !near(householdSpent(p), PLAID_DOUBLE),
    'directed Plaid pair still collapses; household spent is $97.50+$42.00=$139.50',
    String(householdSpent(p)));
}

console.log('\n=== 10–11. no page script grows a second duplicate detector; Forecast helpers remain ===');
{
  ok(neverRaw(/spendDuplicateKey|pendingPostedDuplicateIdSet|isPossibleReplacementPending|confirmedHouseholdAmount|normalizeMerchantKey|spendIdentityKey|skipDuplicatePending/).length === 0,
  'no page script (classic or Stack) introduces a Forecast duplicate-identity helper');
  const forecastHelpers = [
    'function spendDuplicateKey(',
    'function pendingPostedDuplicateIdSet(',
    'function isPossibleReplacementPending(',
    'function confirmedHouseholdAmount(',
  ];
  const forecastSrc = sourceText(read('public/forecast.js'));
  for (const name of forecastHelpers) {
    ok(forecastSrc.indexOf(name) >= 0, 'Forecast authority helper remains: ' + name.trim());
  }
  ok(/function directedPlaidSettlementMate\(/.test(sourceText(read('scripts/provider-observe.js'))),
    'observer still owns directed Plaid collapse');
}

console.log('\n=== 12. output is deterministic ===');
{
  const txs = [
    twin('tx-ai-post', 'AICHATAPP', AICHAT_AMT, false),
    twin('tx-ai-pend', 'AICHATAPP', AICHAT_AMT, true),
    twin('tx-cal-post', 'Calendly', CALENDLY_AMT, false),
    twin('tx-cal-pend', 'Calendly', CALENDLY_AMT, true),
    twin('tx-gen-post', 'ZEPHYR WIDGETS LLC', GENERIC_AMT, false),
    twin('tx-gen-pend', 'ZEPHYR WIDGETS LLC', GENERIC_AMT, true),
  ];
  const packet = actualsPacket(txs);
  const first = recommend(packet);
  const second = recommend(packet);
  const a = otherRow(period(first.defaultView, 'this-pay-period'));
  const b = otherRow(period(second.defaultView, 'this-pay-period'));
  ok(a && b && near(a.spent, b.spent) && JSON.stringify(a.recon) === JSON.stringify(b.recon),
    'two recommend calls yield identical Other Spending recon and spent');
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll household Spent possible-replacement drill-down checks passed.');
