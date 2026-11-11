'use strict';
/* Household-facing Spent drill-down keeps a pending possible-replacement
 * row that Forecast has already marked visible, labelled "Possible
 * duplicate" (it may be a second real purchase; Budget audit, lead
 * dispatch). Confirmed spend still counts the posted side once (PR #252),
 * now tagged estimated while the pair is unresolved; pending exposure and
 * Forecast recon membership stay on the incumbent PR #252 / #250
 * semantics. plan.js must not infer identity (L-001). Independent
 * arithmetic (L-002 / L-006).
 *
 * `node test/test-household-budget-spent-possible-replacement-drilldown.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function loadComposer() {
  const appSrc = read('public/app.js');
  const planSrc = read('public/plan.js');
  const source = [
    grab(appSrc, /^const money = .*$/m, 'money'),
    grab(appSrc, /^const money2 = .*$/m, 'money2'),
    grab(appSrc, /^const escapeHtml = .*$/m, 'escapeHtml'),
    grab(appSrc, /^const fmtDate = .*$/m, 'fmtDate'),
    grab(appSrc, /^const fmtDateLong = .*$/m, 'fmtDateLong'),
    grab(planSrc, /^function paydayBucketRow\([\s\S]*?\n\}$/m, 'paydayBucketRow'),
    grab(planSrc, /^function householdBudgetCycleText\([\s\S]*?\n\}$/m, 'householdBudgetCycleText'),
    grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric'),
    grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml'),
    grab(planSrc, /^function calendarCurrentUnavailableHtml\([\s\S]*?\n\}$/m, 'calendarCurrentUnavailableHtml'),
    grab(planSrc, /^function calendarBudgetHtml\([\s\S]*?\n\}$/m, 'calendarBudgetHtml'),
  ].join('\n');
  return vm.runInNewContext(`${source}\n({ calendarBudgetHtml, householdBudgetMetric, money2 });`, {
    Forecast: F,
  });
}

const composer = loadComposer();

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
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
function block(html, id) {
  const marker = `data-budget-category="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const from = html.lastIndexOf('<div', at);
  const next = html.indexOf('data-budget-category="', at + marker.length);
  if (next < 0) return html.slice(from);
  const to = html.lastIndexOf('<div', next);
  return html.slice(from, to > from ? to : next);
}
function txIds(html) {
  return [...html.matchAll(/data-tx-id="([^"]+)"/g)].map(m => m[1]);
}
function visibleAmountSum(html) {
  return roundCent([...html.matchAll(/household-budget-tx-amount">([^<]*)/g)]
    .map(m => Number(String(m[1]).replace(/[$,]/g, '')))
    .reduce((s, n) => s + (isFinite(n) ? n : 0), 0));
}
// One listed transaction row by its id, or '' when it is not listed.
function txRow(html, id) {
  const m = html.match(new RegExp('<li[^>]*data-tx-id="' + id + '"[\\s\\S]*?</li>'));
  return m ? m[0] : '';
}
// The rows not marked Possible duplicate: the posted side counted once.
function unmarkedRows(html) {
  return (html.match(/<li[\s\S]*?<\/li>/g) || []).filter(row => !/Possible duplicate/.test(row)).join('');
}
const estimatedTotal = (id, amount) => `data-budget-spent-total="${id}"><span class="est">≈ estimated</span> ${composer.money2(amount)}`;

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

  const html = composer.calendarBudgetHtml(p);
  const otherHtml = block(html, 'other-spending');
  const ids = txIds(otherHtml);
  ok(ids.includes('tx-ai-post') && ids.includes('tx-cal-post'),
    'posted AICHATAPP and Calendly mates remain visible');
  ok(ids.includes('tx-ai-pend') && ids.includes('tx-cal-pend'),
    'pending possible-replacement rows stay listed in the household drill-down');
  ok(/Possible duplicate/.test(txRow(otherHtml, 'tx-ai-pend')) && /Possible duplicate/.test(txRow(otherHtml, 'tx-cal-pend'))
      && !/Possible duplicate/.test(txRow(otherHtml, 'tx-ai-post')) && !/Possible duplicate/.test(txRow(otherHtml, 'tx-cal-post'))
      && (otherHtml.match(/Possible duplicate/g) || []).length === 2,
    'exactly the two pending rows are labelled Possible duplicate; the posted mates are not');
  ok(near(visibleAmountSum(unmarkedRows(otherHtml)), LIVE_CONFIRMED)
      && near(visibleAmountSum(otherHtml), LIVE_DOUBLE)
      && otherHtml.includes(estimatedTotal('other-spending', LIVE_CONFIRMED)),
    'unmarked rows sum to the unchanged Spent total, shown estimated; all listed rows sum to the double');

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
  ok(pending && near(pending.evidenceValue, independentPending)
      && aiPend && aiPend.contributesToCurrentPending === true
      && aiPend.settlementTreatment === 'unresolved',
    'revolving pending exposure still contains the unresolved $44.99',
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
  const otherHtml = block(composer.calendarBudgetHtml(p), 'other-spending');
  const ids = txIds(otherHtml);
  ok(ids.includes('tx-gen-post') && ids.includes('tx-gen-pend')
      && /Possible duplicate/.test(txRow(otherHtml, 'tx-gen-pend')) && !/Possible duplicate/.test(txRow(otherHtml, 'tx-gen-post'))
      && near(visibleAmountSum(unmarkedRows(otherHtml)), GENERIC_AMT)
      && otherHtml.includes(estimatedTotal('other-spending', GENERIC_AMT))
      && otherHtml.includes('ZEPHYR WIDGETS LLC'),
    'generic pending possible-replacement stays listed and labelled; posted $23.41 is the estimated Spent');
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
  const otherHtml = block(composer.calendarBudgetHtml(p), 'other-spending');
  const ids = txIds(otherHtml);
  ok(ids.includes('tx-shop-a') && ids.includes('tx-shop-b') && ids.length === 2
      && near(visibleAmountSum(otherHtml), TWO_SHOPIFY),
    'both posted Shopify rows remain visible');
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
  const amandaHtml = block(composer.calendarBudgetHtml(p), 'amanda-guilt-free');
  const ids = txIds(amandaHtml);
  ok(ids.includes('tx-amz-post') && ids.includes('tx-amz-pend') && ids.length === 2
      && /data-tx-id="tx-amz-pend"[^>]*data-tx-pending="true"/.test(amandaHtml)
      && near(visibleAmountSum(amandaHtml), AMAZON_NEAR_TOTAL),
    'unflagged different-date Amazon pending and posted both remain visible');
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
  const amandaHtml = block(composer.calendarBudgetHtml(p), 'amanda-guilt-free');
  const ids = txIds(amandaHtml);
  ok(ids.includes('tx-amz39-post') && ids.includes('tx-amz39-pend')
      && /Possible duplicate/.test(txRow(amandaHtml, 'tx-amz39-pend')) && !/Possible duplicate/.test(txRow(amandaHtml, 'tx-amz39-post'))
      && near(visibleAmountSum(unmarkedRows(amandaHtml)), AMAZON_AMT)
      && amandaHtml.includes(estimatedTotal('amanda-guilt-free', AMAZON_AMT)),
    'household Amanda drill-down lists both, labels the pending one, and shows the posted $39.99 as estimated Spent');
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
  const html = composer.calendarBudgetHtml(p);
  const allIds = txIds(html);
  ok(!allIds.some(id => /pending-101|plaid-pending/.test(id))
      && near(householdSpent(p), PLAID_SETTLED),
    'household drill-down never resurrects the collapsed Plaid pending authorization');
}

console.log('\n=== 10–11. page remains render-only; no second detector in plan.js ===');
{
  const planSrc = sourceText(read('public/plan.js'));
  const metricSrc = grab(planSrc, /^function householdBudgetMetric\([\s\S]*?\n\}$/m, 'householdBudgetMetric');
  const categorySrc = grab(planSrc, /^function householdBudgetCategoryHtml\([\s\S]*?\n\}$/m, 'householdBudgetCategoryHtml');
  ok(!/spendDuplicateKey|pendingPostedDuplicateIdSet|isPossibleReplacementPending|confirmedHouseholdAmount|normalizeMerchantKey|spendIdentityKey|skipDuplicatePending/.test(planSrc),
    'plan.js introduces no Forecast duplicate-identity helper');
  ok(!/AICHATAPP|Calendly|Mailchimp|Shopify|ZEPHYR WIDGETS/.test(metricSrc),
    'household Spent renderer names no merchant special case');
  ok(!/classifyCurrentPeriodTransaction|sumCategoryActuals|spendDuplicateKey/.test(metricSrc + categorySrc)
      && /row\.recon/.test(categorySrc)
      && /tx\.pendingPostedDuplicate === true && tx\.pending === true\s*\?\s*'<span[^']*>Possible duplicate<\/span>'/.test(metricSrc),
    'renderer consumes incumbent recon flags only and prints Possible duplicate only on a flagged pending row');
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
  const htmlA = composer.calendarBudgetHtml(period(first.defaultView, 'this-pay-period'));
  const htmlB = composer.calendarBudgetHtml(period(second.defaultView, 'this-pay-period'));
  ok(a && b && near(a.spent, b.spent) && JSON.stringify(a.recon) === JSON.stringify(b.recon),
    'two recommend calls yield identical Other Spending recon and spent');
  ok(htmlA === htmlB, 'two household Budget renders of the same Forecast result are identical');
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll household Spent possible-replacement drill-down checks passed.');
