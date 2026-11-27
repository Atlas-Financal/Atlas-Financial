'use strict';
/* Unresolved possible pending→posted replacement: household-spend treatment.
 *
 * Directed Plaid identity still collapses (PR #250). A 1:1 pending+posted
 * surface twin without that identity is not collapsed and is not two
 * confirmed household spends. Independent arithmetic (L-002 / L-006).
 *
 * `node test/test-unresolved-pending-posted-spend.js`
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
const clone = x => JSON.parse(JSON.stringify(x));
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

const AS_OF = '2026-09-01';
const AICHAT_AMT = 44.99;
const CALENDLY_AMT = 19.17;
const OVERSTATEMENT = 64.16;
const SHOPIFY_AMT = 54.88;
const AMAZON_NEAR_AMT = 29.99;
const PLAID_PENDING_AMT = 100.00;
const PLAID_POSTED_AMT = 97.50;
const PLAID_UNRELATED_AMT = 42.00;

const AICHAT_DOUBLE = roundCent(AICHAT_AMT + AICHAT_AMT);
const CALENDLY_DOUBLE = roundCent(CALENDLY_AMT + CALENDLY_AMT);
const LIVE_DOUBLE_TOTAL = roundCent(AICHAT_DOUBLE + CALENDLY_DOUBLE);
const LIVE_CONFIRMED = roundCent(AICHAT_AMT + CALENDLY_AMT);
const PLAID_SETTLED = roundCent(PLAID_POSTED_AMT + PLAID_UNRELATED_AMT);
const PLAID_DOUBLE = roundCent(PLAID_PENDING_AMT + PLAID_POSTED_AMT + PLAID_UNRELATED_AMT);
const TWO_SHOPIFY = roundCent(SHOPIFY_AMT + SHOPIFY_AMT);
const AMAZON_NEAR_TOTAL = roundCent(AMAZON_NEAR_AMT + AMAZON_NEAR_AMT);

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }, { id: 'chequing-b', value: 0 }],
    },
    opening: { asOf: AS_OF, priorAsOf: '2026-08-28', representedEvents: [] },
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
  const plan = syntheticPlan();
  return F.recommend(plan, AS_OF, {
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

ok(near(AICHAT_DOUBLE, 89.98) && near(CALENDLY_DOUBLE, 38.34)
    && near(LIVE_DOUBLE_TOTAL, 128.32) && near(LIVE_CONFIRMED, 64.16)
    && near(OVERSTATEMENT, 64.16) && near(PLAID_SETTLED, 139.50)
    && near(PLAID_DOUBLE, 239.50) && near(TWO_SHOPIFY, 109.76)
    && near(AMAZON_NEAR_TOTAL, 59.98),
  'independent fixture arithmetic: AICHATAPP $89.98 / $44.99; Calendly $38.34 / $19.17; live overstatement $64.16; Plaid settled $139.50 vs double $239.50; two Shopify $109.76; Amazon nearby $59.98');

console.log('\n=== 1. proven directed Plaid pending→posted still counts once ===');
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
  const posted = txs.filter(tx => tx.pending === false);
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  ok(!pendingLeft && posted.length === 2 && near(householdSpent(p), PLAID_SETTLED)
      && !near(householdSpent(p), PLAID_DOUBLE),
    'directed Plaid pair collapses; household spent is $97.50+$42.00=$139.50, not $239.50',
    String(householdSpent(p)));
}

console.log('\n=== 2–4. AICHATAPP / Calendly unresolved pairs: not $89.98 / $38.34 confirmed ===');
{
  const txs = [
    twin('tx-ai-post', 'AICHATAPP', AICHAT_AMT, false),
    twin('tx-ai-pend', 'AICHATAPP', AICHAT_AMT, true),
    twin('tx-cal-post', 'Calendly', CALENDLY_AMT, false),
    twin('tx-cal-pend', 'Calendly', CALENDLY_AMT, true),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(p);
  const recon = (other && other.recon) || [];
  const ai = recon.filter(r => r && (r.id === 'tx-ai-post' || r.id === 'tx-ai-pend'));
  const cal = recon.filter(r => r && (r.id === 'tx-cal-post' || r.id === 'tx-cal-pend'));
  ok(other && ai.length === 2 && cal.length === 2
      && ai.every(r => r.pendingPostedDuplicate === true)
      && cal.every(r => r.pendingPostedDuplicate === true)
      && ai.some(r => r.pending === true) && cal.some(r => r.pending === true),
    'both unresolved pairs stay visible and flagged possible replacement');
  ok(near(other.spent, LIVE_CONFIRMED)
      && near(confirmedFromRecon(other), LIVE_CONFIRMED)
      && !near(other.spent, LIVE_DOUBLE_TOTAL)
      && !near(other.spent, AICHAT_DOUBLE)
      && !near(other.spent, CALENDLY_DOUBLE),
    'Other Spending confirmed spent is $44.99+$19.17=$64.16, not $89.98 / $38.34 / $128.32',
    String(other.spent));
  ok(near(householdSpent(p), LIVE_CONFIRMED),
    'Household Budget Spent matches the independent posted-only total');

  const action = F.currentPeriodAction(syntheticPlan(), AS_OF, {
    paydayFloor: 1000,
    currentPeriodActuals: actualsPacket(txs),
  });
  ok(near(action.unclassified.posted, LIVE_CONFIRMED)
      && near(action.unclassified.pending, 0)
      && action.unclassified.count === 2,
    'currentPeriodAction counts posted unclassified once and does not add the replacement pending',
    JSON.stringify(action.unclassified));

  const digest = F.recommend(syntheticPlan(), AS_OF, {
    targetBuffer: 500, debts, currentPeriodActuals: actualsPacket(txs),
  });
  const digestOther = otherRow(period(digest.defaultView, 'this-pay-period'));
  ok(digestOther && near(digestOther.spent, LIVE_CONFIRMED),
    'calendar Household Budget Other stays consistent with current-period actuals');
}

console.log('\n=== 4b. unresolved pending exposure is not discarded ===');
{
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
  // The unresolved twin has no provider link to the posted row, so the card's
  // pending exposure is unknown (never the exact sum above, which may count
  // the one purchase twice). The row is still kept: not collapsed, not zeroed.
  ok(pending && pending.unknown === true && pending.evidenceValue === null
      && pending.unknownReason === 'pending-replacement-unresolved'
      && aiPend && aiPend.contributesToCurrentPending === true
      && aiPend.settlementTreatment === 'unresolved'
      && aiPend.possibleReplacement === true
      && (pending.components || []).some(c => c !== aiPend && near(c.amount, 250)
        && c.possibleReplacement !== true && c.contributesToCurrentPending === true),
    'observer pending exposure is unknown, not an exact sum; the unresolved row is kept and flagged, the other pending row stays listed',
    pending && String(pending.evidenceValue));
  const actuals = report.currentPeriodActuals || {};
  const twins = (actuals.transactions || []).filter(tx => near(tx.amount, AICHAT_AMT));
  ok(twins.length === 2
      && twins.every(tx => tx.pendingPostedDuplicate === true)
      && twins.some(tx => tx.pending === true)
      && twins.some(tx => tx.pending === false),
    'sanitized actuals keep both AICHATAPP rows and flag possible replacement');
}

console.log('\n=== 4c. asymmetric classification keeps $0 Other recon visible ===');
{
  // Posted mate classifies into a named household row; pending twin stays
  // unclassified. Confirmed spend is the posted amount once; the pending
  // remains reconcilable on Other spending at $0 confirmed.
  const ASYM_AMT = 27.41;
  const ASYM_DOUBLE = roundCent(ASYM_AMT + ASYM_AMT);
  ok(near(ASYM_DOUBLE, 54.82),
    'independent asymmetric fixture is $27.41 posted + $27.41 pending = $54.82');
  const postedCls = F.classifyCurrentPeriodTransaction(
    twin('tx-asym-post', 'ACME CAFE', ASYM_AMT, false, { categoryLabel: 'Restaurants' }),
    syntheticPlan()
  );
  const pendingCls = F.classifyCurrentPeriodTransaction(
    twin('tx-asym-pend', 'ACME CAFE', ASYM_AMT, true),
    syntheticPlan()
  );
  ok(postedCls && postedCls.atlasRow === 'restaurants' && postedCls.needsConfirmation !== true,
    'posted mate classifies into Eating out / restaurants');
  ok(pendingCls && (pendingCls.needsConfirmation === true || pendingCls.kind === 'unclassified')
      && pendingCls.atlasRow == null,
    'pending twin stays unclassified');

  const txs = [
    twin('tx-asym-post', 'ACME CAFE', ASYM_AMT, false, { categoryLabel: 'Restaurants' }),
    twin('tx-asym-pend', 'ACME CAFE', ASYM_AMT, true),
  ];
  const advice = recommend(actualsPacket(txs));
  const p = period(advice.defaultView, 'this-pay-period');
  const eating = budgetRow(p, 'restaurants');
  const other = otherRow(p);
  const eatingRecon = (eating && eating.recon) || [];
  const otherRecon = (other && other.recon) || [];
  const pendingRecon = otherRecon.filter(r => r && r.pending === true);
  ok(eating && eatingRecon.length === 1 && eatingRecon[0].id === 'tx-asym-post'
      && eatingRecon[0].pending === false
      && near(eating.spent, ASYM_AMT)
      && !near(eating.spent, ASYM_DOUBLE),
    'posted $27.41 is counted once on Eating out, not $54.82',
    String(eating && eating.spent));
  ok(other && other.otherSpending === true && other.needsConfirmation === true
      && near(other.spent, 0)
      && near(confirmedFromRecon(other), 0)
      && otherRecon.length === 1
      && pendingRecon.length === 1
      && pendingRecon[0].id === 'tx-asym-pend'
      && pendingRecon[0].pending === true
      && pendingRecon[0].pendingPostedDuplicate === true
      && near(pendingRecon[0].amount, ASYM_AMT)
      && Array.isArray(other.pendingRecon)
      && other.pendingRecon.some(r => r && r.id === 'tx-asym-pend'),
    'Other spending stays visible at $0 confirmed with the unresolved pending recon row',
    JSON.stringify({
      spent: other && other.spent,
      recon: otherRecon.map(r => ({ id: r.id, pending: r.pending, dup: r.pendingPostedDuplicate })),
    }));
  ok(near(householdSpent(p), ASYM_AMT) && !near(householdSpent(p), ASYM_DOUBLE),
    'Household Budget Spent is the posted $27.41 only',
    String(householdSpent(p)));
}

console.log('\n=== 5. two genuine posted Shopify $54.88 remain two transactions ===');
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
      && near(other.spent, TWO_SHOPIFY)
      && near(householdSpent(p), TWO_SHOPIFY),
    'two posted Shopify $54.88 stay two confirmed spends ($109.76)',
    String(other && other.spent));
}

console.log('\n=== 6. Amazon nearby without directed identity is not collapsed ===');
{
  const txs = [
    twin('tx-amz-post', 'Amazon', AMAZON_NEAR_AMT, false, {
      date: '2026-08-30', atlasAccountId: 'travelvisa', account: 'travelvisa',
      categoryLabel: 'Shopping',
    }),
    twin('tx-amz-pend', 'Amazon', AMAZON_NEAR_AMT, true, {
      date: '2026-09-01', atlasAccountId: 'travelvisa', account: 'travelvisa',
      categoryLabel: 'Shopping',
    }),
  ];
  const packet = actualsPacket(txs);
  const advice = recommend(packet);
  const p = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(p, 'amanda-guilt-free');
  const recon = (amanda && amanda.recon) || [];
  ok(amanda && recon.length === 2
      && recon.every(r => r.pendingPostedDuplicate !== true)
      && recon.some(r => r.pending === true)
      && recon.some(r => r.pending === false)
      && near(amanda.spent, AMAZON_NEAR_TOTAL)
      && !near(amanda.spent, AMAZON_NEAR_AMT),
    'different-date Amazon $29.99 pending + posted stay two confirmed spends',
    String(amanda && amanda.spent));

  const sameDay = sanitizedFrom([
    {
      date: '2026-08-31', amount: AMAZON_NEAR_AMT, pending: true, categoryLabel: 'Shopping',
      payee: 'Amazon', originalName: 'Amazon',
      providerAccountId: '3006', providerTransactionId: 'amz-near-pend',
    },
    {
      date: '2026-08-30', amount: AMAZON_NEAR_AMT, pending: false, categoryLabel: 'Shopping',
      payee: 'Amazon', originalName: 'Amazon',
      providerAccountId: '3006', providerTransactionId: 'amz-near-post',
    },
  ]);
  const nearby = (sameDay.transactions || []).filter(tx => near(tx.amount, AMAZON_NEAR_AMT));
  ok(nearby.length === 2
      && nearby.every(tx => tx.pendingPostedDuplicate !== true)
      && nearby.some(tx => tx.pending === true)
      && nearby.some(tx => tx.pending === false),
    'observer does not collapse nearby Amazon rows that lack directed identity');
}

console.log('\n=== 7. PR #250 directed Plaid identity remains intact ===');
{
  const observeSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/provider-observe.js'), 'utf8'));
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8'));
  ok(/function directedPlaidSettlementMate\(/.test(observeSrc)
      && /pending_transaction_id/.test(observeSrc)
      && /function collapsePendingPostedBySettlementIdentity\(/.test(observeSrc),
    'observer still owns directed Plaid pending→posted collapse');
  ok(!/AICHATAPP|Calendly|Mailchimp/.test(
      observeSrc.slice(observeSrc.indexOf('function collapsePendingPostedBySettlementIdentity'))
    ),
    'generic observer collapse names no AICHATAPP / Calendly / Mailchimp special case');
  const start = forecastSrc.indexOf('function pendingPostedDuplicateIdSet(');
  const end = forecastSrc.indexOf('function isDogFoodMerchant(', start);
  const generic = forecastSrc.slice(start, end);
  ok(start >= 0 && !/AICHATAPP|Calendly|Mailchimp|Amazon|Shopify/.test(generic),
    'generic possible-replacement helpers name no merchant');
}

console.log('\n=== 8. currentPeriodActuals / Household Budget stay consistent ===');
{
  const txs = [
    twin('tx-ai-post', 'AICHATAPP', AICHAT_AMT, false),
    twin('tx-ai-pend', 'AICHATAPP', AICHAT_AMT, true),
  ];
  const packet = actualsPacket(txs);
  const advice = recommend(packet);
  const p = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(p);
  const action = F.currentPeriodAction(syntheticPlan(), AS_OF, {
    paydayFloor: 1000,
    currentPeriodActuals: packet,
  });
  ok(other && near(other.spent, AICHAT_AMT)
      && near(action.unclassified.posted, AICHAT_AMT)
      && near(action.unclassified.pending, 0)
      && near(householdSpent(p), AICHAT_AMT),
    'Household Budget Spent and currentPeriodAction unclassified agree on posted-only $44.99');
}

console.log('\n=== 9. no merchant-name special case in generic reconciliation ===');
{
  const observeSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/provider-observe.js'), 'utf8'));
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8'));
  const observeHelpers = [
    'function pendingPostedSurfaceKey(',
    'function flagUnresolvedPendingPostedDuplicates(',
    'function directedPlaidSettlementMate(',
  ];
  const forecastHelpers = [
    'function spendDuplicateKey(',
    'function pendingPostedDuplicateIdSet(',
    'function isPossibleReplacementPending(',
    'function confirmedHouseholdAmount(',
  ];
  for (const name of observeHelpers) {
    ok(observeSrc.indexOf(name) >= 0, 'observer helper exists: ' + name.trim());
  }
  for (const name of forecastHelpers) {
    ok(forecastSrc.indexOf(name) >= 0, 'Forecast helper exists: ' + name.trim());
  }
  ok(!/AICHATAPP|Calendly|Mailchimp/.test(forecastSrc),
    'Forecast source does not special-case AICHATAPP / Calendly / Mailchimp');
}

console.log('\n=== 10. output is deterministic ===');
{
  const txs = [
    twin('tx-ai-post', 'AICHATAPP', AICHAT_AMT, false),
    twin('tx-ai-pend', 'AICHATAPP', AICHAT_AMT, true),
    twin('tx-cal-post', 'Calendly', CALENDLY_AMT, false),
    twin('tx-cal-pend', 'Calendly', CALENDLY_AMT, true),
  ];
  const packet = actualsPacket(txs);
  const first = recommend(packet);
  const second = recommend(packet);
  const a = otherRow(period(first.defaultView, 'this-pay-period'));
  const b = otherRow(period(second.defaultView, 'this-pay-period'));
  ok(a && b && near(a.spent, b.spent) && JSON.stringify(a.recon) === JSON.stringify(b.recon),
    'two recommend calls on the same packet yield identical Other Spending');
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll unresolved pending→posted household-spend checks passed.');
