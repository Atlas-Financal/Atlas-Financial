'use strict';
/* Current-period Household Budget classification: represented bills are
 * bills only, and owner-confirmed Walmart / Meridian Farm / Iron Butcher
 * purchases are Groceries. Cursor is Dale guilt-free (Dale 2026-09-02).
 * CAN TIRE MC is the Canadian Tire Mastercard payment and PITT MEADOWS CE
 * is Fuel (Dale 2026-09-02). Synthetic fixtures and independent arithmetic
 * (L-002 / L-006).
 *
 * `node test/test-current-period-household-budget-classification.js`
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

const AS_OF = '2026-09-01';
const GOOGLE_AMT = 3.13;
const WALMART_AMT = 41.17;
const MERIDIAN_AMT = 19.44;
const OTHER_AMT = 7.50;
const NATURAL_GAS_AMT = 21;
const BANK_FEE_AMT = 8.5;
const AMAZON_AMT = 14;
const BUSINESS_WALMART_AMT = 22.11;
const BUSINESS_MERIDIAN_AMT = 14.07;
const IRON_BUTCHER_AMT = 18.40;
const OTHER_MEAT_AMT = 11.25;
const CURSOR_AMT = 20.00;
const OTHER_AI_AMT = 16.00;
// Dale 2026-09-02 screenshot-style fixtures. The amounts are regression
// fixtures only; neither identity rule reads amount or date.
const CAN_TIRE_MC_AMT = 271.00;
const CANADIAN_TIRE_RETAIL_AMT = 78.38;
const PITT_MEADOWS_CE_AMT = 100.00;
const PITT_MEADOWS_ARENA_AMT = 30.00;
// Dale 2026-09-09 Sep 8 cashback INTEREST CHARGE -PURCHASE style.
// Amount is a regression fixture only; the identity does not read it.
const CASHBACK_PURCHASE_INTEREST_AMT = 130.36;
const SURREY_MEAT_AMT = 45.00;
const GROCERY_INDEPENDENT = roundCent(WALMART_AMT + MERIDIAN_AMT);
const GROCERY_WITH_IRON = roundCent(GROCERY_INDEPENDENT + IRON_BUTCHER_AMT);
const EXCLUDED_BUSINESS_INDEPENDENT = roundCent(BUSINESS_WALMART_AMT + BUSINESS_MERIDIAN_AMT);
const SPENT_WITH_BILL = roundCent(GROCERY_INDEPENDENT + OTHER_AMT + GOOGLE_AMT);
const SPENT_WITHOUT_BILL = roundCent(GROCERY_INDEPENDENT + OTHER_AMT);

function syntheticPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 8000 }],
    },
    opening: { asOf: AS_OF, priorAsOf: '2026-08-28', representedEvents: [] },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
      anchor: '2026-08-14', amount: 4264, confidence: 'confirmed',
    }],
    bills: [{
      id: 'google-storage-100gb',
      label: 'Google storage — 100 GB',
      frequency: 'monthly',
      day: 31,
      amount: GOOGLE_AMT,
      confidence: 'confirmed',
      budgetCategory: 'subscriptions',
      payingAccount: 'chequing-a',
    }],
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
        { id: 'subscriptions', label: 'Subscriptions', class: 'essential', from: ['Subscriptions'] },
      ],
      excluded: [{
        from: 'Business',
        why: 'Amanda coaching, not household',
      }],
    },
  };
}

const debts = [
  { id: 'tdcc', label: 'TD personal Visa', secured: false, structure: 'Revolving', balance: 90, rate: 24.99, payment: 94.03, pending: 0 },
  { id: 'heloc', label: 'HELOC', secured: true, structure: 'Interest-only revolving', balance: 1000, rate: 4.9, payment: 0, pending: 0, cashPayment: 0, interestTreatment: 'capitalised' },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

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

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function budgetRow(p, id) {
  return ((p && p.householdBudget) || []).find(r => r.id === id) || null;
}
function otherRow(p) {
  return ((p && p.householdBudget) || []).find(r => r && r.otherSpending) || null;
}
function reconIds(p) {
  const ids = [];
  for (const row of (p && p.householdBudget) || []) {
    for (const tx of row.recon || []) {
      if (tx && tx.id) ids.push(tx.id);
    }
  }
  return ids;
}
function reconSum(row) {
  return roundCent(((row && row.recon) || []).reduce((s, tx) => s + (Number(tx.amount) || 0), 0));
}
function householdSpent(p) {
  return roundCent(((p && p.householdBudget) || []).reduce((s, row) => {
    return s + (Number(row && row.spent) || 0);
  }, 0));
}

function googleTx(extra) {
  return Object.assign({
    id: 'tx-google',
    date: '2026-08-31',
    amount: GOOGLE_AMT,
    pending: false,
    categoryLabel: 'Shopping',
    accountRole: 'household-cash',
    displayedPayee: 'Google',
    originalMerchant: 'Google',
    representedBill: false,
  }, extra || {});
}
function walmartTx(extra) {
  return Object.assign({
    id: 'tx-walmart',
    date: '2026-08-31',
    amount: WALMART_AMT,
    pending: false,
    categoryLabel: null, // H1: merchant rules apply to uncategorised rows only
    accountRole: 'household-cash',
    displayedPayee: 'Walmart',
    originalMerchant: 'Walmart',
  }, extra || {});
}
function meridianTx(extra) {
  return Object.assign({
    id: 'tx-meridian',
    date: '2026-08-31',
    amount: MERIDIAN_AMT,
    pending: false,
    categoryLabel: 'Groceries',
    accountRole: 'household-cash',
    displayedPayee: 'Meridian Farm',
    originalMerchant: 'Meridian Farm',
  }, extra || {});
}
function otherTx() {
  return {
    id: 'tx-other',
    date: '2026-08-31',
    amount: OTHER_AMT,
    pending: false,
    categoryLabel: 'Gifts',
    accountRole: 'household-cash',
    displayedPayee: 'Gift Shop',
    originalMerchant: 'Gift Shop',
  };
}
function naturalGasTx(extra) {
  return Object.assign({
    id: 'tx-natural-gas',
    date: '2026-09-01',
    amount: NATURAL_GAS_AMT,
    pending: false,
    categoryLabel: 'Natural Gas',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'FortisBC Energy BPY',
    originalMerchant: 'FortisBC Energy BPY',
  }, extra || {});
}
function bankFeeTx(extra) {
  return Object.assign({
    id: 'tx-bank-fee',
    date: '2026-08-31',
    amount: BANK_FEE_AMT,
    pending: false,
    categoryLabel: 'Other bank fees',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'MONTHLY ACCOUNT FEE',
    originalMerchant: 'MONTHLY ACCOUNT FEE',
  }, extra || {});
}
function amazonTx(extra) {
  return Object.assign({
    id: 'tx-amazon',
    date: '2026-08-31',
    amount: AMAZON_AMT,
    pending: false,
    categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'Amazon',
    originalMerchant: 'Amazon',
  }, extra || {});
}
function ironButcherTx(extra) {
  return Object.assign({
    id: 'tx-iron-butcher',
    date: '2026-08-31',
    amount: IRON_BUTCHER_AMT,
    pending: false,
    categoryLabel: 'Groceries',
    accountRole: 'household-cash',
    displayedPayee: 'Iron Butcher',
    originalMerchant: 'Iron Butcher',
  }, extra || {});
}
function otherMeatTx(extra) {
  return Object.assign({
    id: 'tx-other-meat',
    date: '2026-08-31',
    amount: OTHER_MEAT_AMT,
    pending: false,
    categoryLabel: 'Pets',
    accountRole: 'household-cash',
    displayedPayee: 'Local Butcher',
    originalMerchant: 'Local Butcher',
  }, extra || {});
}
function cursorTx(extra) {
  return Object.assign({
    id: 'tx-cursor',
    date: '2026-08-31',
    amount: CURSOR_AMT,
    pending: false,
    categoryLabel: null, // H1: merchant rules apply to uncategorised rows only
    accountRole: 'revolving-credit',
    displayedPayee: 'Cursor',
    originalMerchant: 'Cursor',
  }, extra || {});
}
function otherAiTx(extra) {
  return Object.assign({
    id: 'tx-other-ai',
    date: '2026-08-31',
    amount: OTHER_AI_AMT,
    pending: false,
    categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'OpenAI',
    originalMerchant: 'OpenAI',
  }, extra || {});
}
function amazonPrimeTx(extra) {
  return Object.assign({
    id: 'tx-amazon-prime',
    date: '2026-08-31',
    amount: 9.99,
    pending: false,
    categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'Amazon Prime',
    originalMerchant: 'Amazon Prime',
  }, extra || {});
}

function canTireMcTx(extra) {
  return Object.assign({
    id: 'tx-can-tire-mc',
    date: '2026-08-31',
    amount: CAN_TIRE_MC_AMT,
    pending: false,
    // Lunch Money's Pets label is the known misclassification on this payee.
    categoryLabel: 'Pets',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'CAN TIRE MC',
    originalMerchant: 'CAN TIRE MC',
  }, extra || {});
}
function canadianTireRetailTx(extra) {
  return Object.assign({
    id: 'tx-canadian-tire-retail',
    date: '2026-08-31',
    amount: CANADIAN_TIRE_RETAIL_AMT,
    pending: false,
    categoryLabel: 'Household',
    accountRole: 'household-cash',
    displayedPayee: 'Canadian Tire',
    originalMerchant: 'CANADIAN TIRE #322',
  }, extra || {});
}
function pittMeadowsCeTx(extra) {
  return Object.assign({
    id: 'tx-pitt-meadows-ce',
    date: '2026-08-31',
    amount: PITT_MEADOWS_CE_AMT,
    pending: false,
    // H1 (lead decision 2026-11-07): the merchant rule applies only to a
    // row Lunch Money left uncategorised, so the fixture is uncategorised.
    categoryLabel: null,
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    displayedPayee: 'PITT MEADOWS CE',
    originalMerchant: 'PITT MEADOWS CE',
  }, extra || {});
}
function pittMeadowsArenaTx(extra) {
  return Object.assign({
    id: 'tx-pitt-meadows-arena',
    date: '2026-08-31',
    amount: PITT_MEADOWS_ARENA_AMT,
    pending: false,
    categoryLabel: 'Sport & fitness',
    accountRole: 'household-cash',
    displayedPayee: 'PITT MEADOWS AR',
    originalMerchant: 'PITT MEADOWS AR',
  }, extra || {});
}
function surreyMeatTx(extra) {
  return Object.assign({
    id: 'tx-surrey-meat',
    date: '2026-08-31',
    amount: SURREY_MEAT_AMT,
    pending: false,
    categoryLabel: null, // H1: merchant rule applies to uncategorised rows only
    accountRole: 'household-cash',
    displayedPayee: 'Surrey Meat',
    originalMerchant: 'SURREY MEAT MARKET',
  }, extra || {});
}
function allReconRows(p) {
  const rows = [];
  for (const row of (p && p.householdBudget) || []) {
    for (const tx of row.recon || []) rows.push({ rowId: row.id, tx });
  }
  return rows;
}

function recommend(packet, extraPlan, extraOpts) {
  const plan = Object.assign(syntheticPlan(), extraPlan || {});
  const represented = (plan.opening && plan.opening.representedEvents) || [];
  return F.recommend(plan, AS_OF, Object.assign({
    targetBuffer: 500,
    debts,
    currentPeriodActuals: packet,
    representedEvents: represented,
  }, extraOpts || {}));
}

console.log('\n=== 1. unique represented Google bill is a bill, never Household Budget ===');
{
  ok(near(GOOGLE_AMT, 3.13) && near(WALMART_AMT + MERIDIAN_AMT, GROCERY_INDEPENDENT),
    'independent fixture arithmetic: Google $3.13; Groceries $41.17+$19.44=$60.61');
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  const packet = actualsPacket([
    googleTx({ representedBill: true }),
    walmartTx(),
    meridianTx(),
    otherTx(),
  ], {
    representedActuals: [{
      id: 'google-storage-100gb',
      date: '2026-08-31',
      actual: GOOGLE_AMT,
      postedOn: '2026-08-31',
      transactionId: 'tx-google',
    }],
  });
  const googleCls = F.classifyCurrentPeriodTransaction(packet.transactions[0], plan, {
    currentPeriodActuals: packet,
  });
  ok(googleCls.kind === 'bill' && googleCls.householdSpending === false
      && googleCls.reason === 'represented-bill',
    'linked Google storage classifies as bill, householdSpending false',
    JSON.stringify(googleCls));
  const advice = recommend(packet, { opening: plan.opening });
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const pets = budgetRow(active, 'pets');
  const other = otherRow(active);
  const ids = reconIds(active);
  ok(groceries && near(groceries.spent, GROCERY_INDEPENDENT)
      && near(reconSum(groceries), GROCERY_INDEPENDENT),
    'Groceries spent independently equals Walmart+Meridian Farm');
  ok(other && near(other.spent, OTHER_AMT) && near(reconSum(other), OTHER_AMT),
    'Other spending is the constructed $7.50 residual only');
  ok(!ids.includes('tx-google'),
    'Google transaction id is absent from every Household Budget recon row');
  ok(!(groceries.recon || []).some(tx => tx && tx.id === 'tx-google')
      && !(other.recon || []).some(tx => tx && tx.id === 'tx-google'),
    'Google is in neither Groceries nor Other spending');
  ok(pets && near(pets.spent, 0)
      && !(pets.recon || []).some(tx => tx && tx.id === 'tx-meridian'),
    'Meridian Farm does not enter Dog food');
  const googlePaid = (active.bills || []).find(row => row && row.id === 'google-storage-100gb');
  ok(googlePaid && googlePaid.status === 'PAID'
      && (googlePaid.settlement === 'represented' || googlePaid.remaining === 0),
    'modeled Google storage occurrence is settled/represented',
    JSON.stringify(googlePaid || null));
}

console.log('\n=== 2. date + amount without unique linkage is not the Google bill ===');
{
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  const decoy = googleTx({
    id: 'tx-decoy',
    representedBill: false,
    displayedPayee: 'UNRELATED DEBIT',
    originalMerchant: 'UNRELATED DEBIT',
    categoryLabel: 'Gifts',
  });
  const packet = actualsPacket([decoy], {
    representedActuals: [{
      id: 'google-storage-100gb',
      date: '2026-08-31',
      actual: GOOGLE_AMT,
      postedOn: '2026-08-31',
    }],
  });
  const cls = F.classifyCurrentPeriodTransaction(decoy, plan, {
    currentPeriodActuals: packet,
  });
  ok(cls.kind !== 'bill' && cls.reason !== 'represented-bill',
    'same date and amount without transactionId linkage is not treated as the Google bill',
    JSON.stringify(cls));
  ok(cls.householdSpending === true,
    'unlinked same-cents debit remains household spending, fail closed');
  const advice = recommend(packet, { opening: plan.opening });
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  ok(other && (other.recon || []).some(tx => tx && tx.id === 'tx-decoy'),
    'unlinked same-cents debit still appears in Other spending');
}

console.log('\n=== Telephone is the Telecom bill category, not a broad merchant rule ===');
{
  const L = require('../scripts/live-plan');
  function telephoneCase(category) {
    const x = require('./fixtures/card-backfill-data')();
    x.data.debts = []; x.data.plan.obligations = []; x.data.plan.bills = [];
    x.data.plan.budget.categories = [{ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 0 }];
    x.accountMap.mappings = x.accountMap.mappings.slice(0, 3);
    x.payload.accounts = x.payload.accounts.slice(0, 3);
    x.payload.accounts[0].balance = 481; x.payload.accounts[1].balance = -7;
    x.payload.transactions = [
      { id: 92001, account_id: 3001, amount: 19, payee: 'Invented phone company', category_name: category },
      { id: 92002, account_id: 3002, amount: 7, payee: 'Invented unrelated store', category_name: 'Shopping' },
    ].map(tx => ({ ...tx, date: x.asOf, is_pending: false, currency: 'cad' }));
    const before = JSON.stringify(x);
    const r = L.fromObservation(x);
    const packet = r.report.currentPeriodActuals;
    const advice = F.recommend(r.data.plan, x.asOf, { debts: [], currentPeriodActuals: packet });
    const active = period(advice.defaultView, 'this-pay-period');
    ok(JSON.stringify(x) === before, 'Telephone observation leaves its invented inputs unchanged');
    return { r, packet, active, other: otherRow(active) };
  }
  const telecom = telephoneCase('Telecom');
  const telephone = telephoneCase('Telephone');
  // No planned phone bill exists here, so the phone charge is not a bill:
  // both it (19) and the unrelated purchase (7) stay in Other, 26 for
  // either label (Budget audit: a bill label alone is not a bill).
  ok(telephone.other.spent === 26 && telephone.other.recon.length === 2
      && telephone.other.spent === telecom.other.spent,
    'independent ledger: with no planned phone bill, phone 19 + unrelated 7 = 26 is Other for either category');
  ok(telephone.r.data.plan.startingCash.breakdown.reduce((n, row) => n + row.value, 0) === 474,
    'independent cash: opening 500 minus phone 19 minus unrelated purchase 7, no extra deduction');
  const reference = F.classifyCurrentPeriodTransaction({ categoryLabel: 'Telecom', amount: 19 }, syntheticPlan());
  for (const label of ['Telephone', 'telephone', ' TELEPHONE ']) {
    const cls = F.classifyCurrentPeriodTransaction({ categoryLabel: label, amount: 19 }, syntheticPlan());
    ok(JSON.stringify(cls) === JSON.stringify(reference) && cls.kind !== 'bill' && cls.householdSpending === true
        && cls.needsConfirmation === true,
      'exact normalized Telephone classification equals Telecom (unmatched: Other, needs confirmation)');
  }
  for (const categoryLabel of ['Telephone accessories', 'Telecommunications shop', 'Shopping']) {
    const cls = F.classifyCurrentPeriodTransaction({ categoryLabel, payee: 'Telephone', amount: 19 }, syntheticPlan());
    ok(cls.householdSpending === true, 'category substrings and a telephone payee do not become bills');
  }
  ok(F.classifyCurrentPeriodTransaction({ categoryLabel: 'Telephone', accountRole: 'household-external', amount: 19 }, syntheticPlan()).kind === 'external',
    'Telephone preserves the external-account boundary');
}

console.log('\n=== 3. Walmart is Groceries, never Other spending ===');
{
  const plan = syntheticPlan();
  const tx = walmartTx();
  const cls = F.classifyCurrentPeriodTransaction(tx, plan);
  ok(cls.kind === 'spend' && cls.categoryId === 'groceries'
      && cls.needsConfirmation !== true && cls.householdSpending === true,
    'Walmart with Shopping label classifies as Groceries',
    JSON.stringify(cls));
  const walmartCa = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: WALMART_AMT, categoryLabel: 'Shopping',
    displayedPayee: 'WALMARTCA', originalMerchant: 'WALMARTCA',
    accountRole: 'household-cash',
  }, plan);
  // H1 (lead decision 2026-11-07): the explicit Shopping label wins.
  ok(walmartCa.needsConfirmation === true && walmartCa.reason === 'personal-unassigned',
    'H1: the grocery merchant (no-space key) labelled Shopping follows its Lunch Money category');
  const packet = actualsPacket([tx, otherTx()]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const other = otherRow(active);
  ok(groceries && (groceries.recon || []).some(row => row.id === 'tx-walmart')
      && near(groceries.spent, WALMART_AMT),
    'Walmart enters Groceries recon');
  ok(other && !(other.recon || []).some(row => row.id === 'tx-walmart')
      && near(other.spent, OTHER_AMT),
    'Walmart does not enter Other spending');
}

console.log('\n=== 4. Meridian Farm is Groceries, not Dog food, not confirmation ===');
{
  const plan = syntheticPlan();
  const tx = meridianTx();
  const cls = F.classifyCurrentPeriodTransaction(tx, plan);
  ok(cls.kind === 'spend' && cls.categoryId === 'groceries'
      && cls.needsConfirmation !== true,
    'Meridian Farm classifies as Groceries without needsConfirmation',
    JSON.stringify(cls));
  ok(cls.categoryId !== 'pets' && cls.atlasRow === 'groceries',
    'Meridian Farm is not Dog food');
  const petsLabel = F.classifyCurrentPeriodTransaction(Object.assign({}, tx, {
    categoryLabel: 'Pets',
  }), plan);
  ok(petsLabel.needsConfirmation === true && petsLabel.reason === 'payee-category-contradiction',
    'H1: a grocery merchant labelled Pets is not turned into Groceries');
  const truncated = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: MERIDIAN_AMT, categoryLabel: 'Shopping',
    displayedPayee: 'MERIDIANFARM', originalMerchant: 'MERIDIANFARM',
    accountRole: 'household-cash',
  }, plan);
  ok(truncated.needsConfirmation === true && truncated.reason === 'personal-unassigned',
    'H1: a truncated grocery-merchant key labelled Shopping follows its Lunch Money category');
  const packet = actualsPacket([tx, otherTx()]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const pets = budgetRow(active, 'pets');
  const other = otherRow(active);
  ok(groceries && (groceries.recon || []).some(row => row.id === 'tx-meridian')
      && near(groceries.spent, MERIDIAN_AMT),
    'Meridian Farm enters Groceries recon');
  ok(other && !(other.recon || []).some(row => row.id === 'tx-meridian'),
    'Meridian Farm does not enter Other spending');
  ok(pets && !(pets.recon || []).some(row => row.id === 'tx-meridian')
      && near(pets.spent, 0),
    'Meridian Farm does not enter Dog food');
}

console.log('\n=== 5. recon rows sum to Household Budget Spent; ids appear once ===');
{
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  const packet = actualsPacket([
    googleTx({ representedBill: true }),
    walmartTx(),
    meridianTx(),
    otherTx(),
  ], {
    representedActuals: [{
      id: 'google-storage-100gb',
      date: '2026-08-31',
      actual: GOOGLE_AMT,
      transactionId: 'tx-google',
    }],
  });
  const advice = recommend(packet, { opening: plan.opening });
  const active = period(advice.defaultView, 'this-pay-period');
  const independentReconTotal = roundCent(((active && active.householdBudget) || [])
    .reduce((s, row) => s + reconSum(row), 0));
  ok(near(independentReconTotal, SPENT_WITHOUT_BILL)
      && near(householdSpent(active), SPENT_WITHOUT_BILL)
      && near(independentReconTotal, householdSpent(active)),
    'independent recon-row sum equals Household Budget Spent ($60.61+$7.50=$68.11)');
  const ids = reconIds(active);
  ok(ids.length === new Set(ids).size,
    'no supporting transaction id appears on two Household Budget rows');
  ok(ids.includes('tx-walmart') && ids.includes('tx-meridian') && ids.includes('tx-other')
      && !ids.includes('tx-google'),
    'grocery and residual ids appear once; Google is absent');
}

console.log('\n=== 6. removing a represented bill from Household Budget avoids a second cash effect ===');
{
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  const unlinked = actualsPacket([
    googleTx({ representedBill: false }),
    walmartTx(),
    meridianTx(),
    otherTx(),
  ], {
    representedActuals: [{
      id: 'google-storage-100gb',
      date: '2026-08-31',
      actual: GOOGLE_AMT,
    }],
  });
  const linked = actualsPacket([
    googleTx({ representedBill: true }),
    walmartTx(),
    meridianTx(),
    otherTx(),
  ], {
    representedActuals: [{
      id: 'google-storage-100gb',
      date: '2026-08-31',
      actual: GOOGLE_AMT,
      transactionId: 'tx-google',
    }],
  });
  const before = recommend(unlinked, { opening: plan.opening });
  const after = recommend(linked, { opening: plan.opening });
  const beforeActive = period(before.defaultView, 'this-pay-period');
  const afterActive = period(after.defaultView, 'this-pay-period');
  const beforeSpent = householdSpent(beforeActive);
  const afterSpent = householdSpent(afterActive);
  const beforeOther = otherRow(beforeActive);
  const afterOther = otherRow(afterActive);
  ok(near(SPENT_WITH_BILL - SPENT_WITHOUT_BILL, GOOGLE_AMT),
    'independent arithmetic: $71.24 − $68.11 = $3.13');
  ok(near(beforeSpent, SPENT_WITH_BILL) && near(afterSpent, SPENT_WITHOUT_BILL)
      && near(beforeSpent - afterSpent, GOOGLE_AMT),
    'Household Budget Spent falls by the represented $3.13 once the tx is linked');
  ok(beforeOther && near(beforeOther.spent, roundCent(OTHER_AMT + GOOGLE_AMT)),
    'unlinked Google sits in Other spending');
  ok(afterOther && near(afterOther.spent, OTHER_AMT)
      && !(afterOther.recon || []).some(tx => tx.id === 'tx-google'),
    'linked Google leaves Other spending');
  const billRemainingUnlinked = 0;
  const secondHit = GOOGLE_AMT;
  const duplicateClaim = roundCent(billRemainingUnlinked + secondHit);
  const trueClaim = GOOGLE_AMT;
  ok(near(duplicateClaim, 6.26) === false && near(duplicateClaim, trueClaim)
      && near(beforeSpent - afterSpent, secondHit),
    'bill remaining is already $0 when represented; counting the same $3.13 in Household Budget is a second cash effect');
  const groceryBefore = budgetRow(beforeActive, 'groceries');
  const groceryAfter = budgetRow(afterActive, 'groceries');
  ok(groceryBefore && groceryAfter
      && near(groceryBefore.spent, GROCERY_INDEPENDENT)
      && near(groceryAfter.spent, GROCERY_INDEPENDENT)
      && near(groceryBefore.remaining, groceryAfter.remaining),
    'Groceries Spent/Remaining are unchanged by the Google bill linkage');
}

console.log('\n=== 7. provider identity uniquely links Google storage; amount is not identity ===');
{
  const identity = load('docs/connectivity/transaction-identity.json');
  const map = load('docs/connectivity/fixtures/provider-account-map.json');
  const data = load('data.json');
  const rule = (identity.rules || []).find(r => r && r.eventId === 'google-storage-100gb');
  ok(rule && rule.atlasAccountId === 'chequing-b' && rule.direction === 'debit'
      && (rule.payeePatterns || []).includes('Google')
      && (rule.originalNamePatterns || []).includes('SERVICE _V')
      && !rule.settlesWhen,
    'Google storage identity is payee + Chequing B + original SERVICE _V + date; amount is not identity');
  const payload = {
    provider: 'lunchmoney',
    fetchedAt: '2026-09-01T18:00:00.000Z',
    transactionWindow: {
      startDate: '2026-08-18', endDate: '2026-09-01',
      complete: true, hasMore: false, truncated: false,
    },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    accounts: [
      {
        id: 1001, name: 'Fixture Chequing A', type: 'cash', balance: 1000,
        updated_at: '2026-09-01T17:55:00.000Z', balance_last_update: '2026-09-01T17:55:00.000Z',
      },
      {
        id: 1002, name: 'Fixture Chequing B', type: 'cash', balance: 400,
        updated_at: '2026-09-01T17:55:00.000Z', balance_last_update: '2026-09-01T17:55:00.000Z',
      },
    ],
    categories: [
      { id: 11, name: 'Shopping', is_income: false, exclude_from_totals: false },
      { id: 22, name: 'Groceries', is_income: false, exclude_from_totals: false },
      { id: 33, name: 'Pets', is_income: false, exclude_from_totals: false },
    ],
    transactions: [
      {
        id: 83, account_id: 1002, date: '2026-08-31', amount: GOOGLE_AMT,
        is_pending: false, currency: 'cad', payee: 'Google', original_name: 'SERVICE _V',
        category_id: 33,
      },
      {
        id: 3102, account_id: 1002, date: '2026-08-31', amount: GOOGLE_AMT,
        is_pending: false, payee: 'UNRELATED DEBIT', original_name: 'UNRELATED DEBIT',
        category_id: 11,
      },
    ],
  };
  const report = O.observe({
    provider: 'lunchmoney', payload, accountMap: map, data, identity,
  });
  const candidates = report.representedEventCandidates || [];
  const googleHit = candidates.find(c => c.id === 'google-storage-100gb' && c.date === '2026-08-31');
  ok(googleHit && googleHit.amountNotUsed === true && googleHit.direction === 'debit'
      && googleHit.providerTransactionId != null
      && googleHit.atlasAccountId === 'chequing-b',
    'unique Google / SERVICE _V debit on Chequing B settles the Aug 31 occurrence',
    JSON.stringify(candidates));
  const packet = report.currentPeriodActuals;
  ok(packet && O.currentPeriodActualsLooksSanitized(packet),
    'current-period packet remains sanitized');
  const billRow = (packet.representedActuals || []).find(r => r.id === 'google-storage-100gb');
  ok(billRow && billRow.transactionId,
    'representedActuals carries the unique local transactionId');
  const billTx = (packet.transactions || []).find(tx => tx && tx.id === billRow.transactionId);
  const decoyTx = (packet.transactions || []).find(tx => tx && tx.id !== (billRow && billRow.transactionId)
    && Number(tx.amount) === GOOGLE_AMT);
  ok(billTx && billTx.representedBill === true,
    'only the unique identity hit is flagged representedBill');
  ok(decoyTx && decoyTx.representedBill !== true,
    'same-date same-amount decoy is not flagged representedBill');
  const billCls = F.classifyCurrentPeriodTransaction(billTx, data.plan, {
    currentPeriodActuals: packet,
  });
  const decoyCls = F.classifyCurrentPeriodTransaction(decoyTx, data.plan, {
    currentPeriodActuals: packet,
  });
  ok(billCls.kind === 'bill' && billCls.householdSpending === false
      && billCls.reason === 'represented-bill'
      && billCls.reason !== 'pets-not-dog-food',
    'observe-linked Google / SERVICE _V on Chequing B classifies as represented bill, not Pets',
    JSON.stringify(billCls));
  ok(decoyCls.kind !== 'bill' || decoyCls.reason !== 'represented-bill',
    'decoy does not inherit bill classification from date+amount');
  const observeAdvice = recommend(packet, {
    opening: {
      asOf: AS_OF,
      priorAsOf: '2026-08-28',
      representedEvents: [{ id: 'google-storage-100gb', date: '2026-08-31' }],
    },
  });
  const observePeriod = period(observeAdvice.defaultView, 'this-pay-period');
  const observeOther = otherRow(observePeriod);
  const observeIds = reconIds(observePeriod);
  ok(!(observeOther && (observeOther.recon || []).some(row => row && row.id === billTx.id))
      && !observeIds.includes(billTx.id),
    'represented Google storage debit does not enter Other or Household Budget spend');

  const amountOnly = JSON.parse(JSON.stringify(payload));
  amountOnly.transactions = [{
    id: 3103, account_id: 1002, date: '2026-08-31', amount: GOOGLE_AMT,
    is_pending: false, payee: 'UNKNOWN DEBIT', original_name: 'UNKNOWN DEBIT',
  }];
  const rejected = O.observe({
    provider: 'lunchmoney', payload: amountOnly, accountMap: map, data, identity,
  });
  ok(!(rejected.representedEventCandidates || []).some(c => c.id === 'google-storage-100gb'),
    'date + $3.13 without the Google payee does not settle the bill');

  const chequingA = JSON.parse(JSON.stringify(payload));
  chequingA.transactions = [{
    id: 3104, account_id: 1001, date: '2026-08-31', amount: GOOGLE_AMT,
    is_pending: false, currency: 'cad', payee: 'Google', original_name: 'SERVICE _V',
    category_id: 33,
  }];
  const wrongAccount = O.observe({
    provider: 'lunchmoney', payload: chequingA, accountMap: map, data, identity,
  });
  ok(!(wrongAccount.representedEventCandidates || []).some(c => c.id === 'google-storage-100gb'),
    'same Google / SERVICE _V debit on Chequing A does not settle the bill');

  const noOriginal = JSON.parse(JSON.stringify(payload));
  noOriginal.transactions = [{
    id: 3105, account_id: 1002, date: '2026-08-31', amount: GOOGLE_AMT,
    is_pending: false, payee: 'Google', original_name: 'Google',
    category_id: 33,
  }];
  const wrongOriginal = O.observe({
    provider: 'lunchmoney', payload: noOriginal, accountMap: map, data, identity,
  });
  ok(!(wrongOriginal.representedEventCandidates || []).some(c => c.id === 'google-storage-100gb'),
    'Chequing B Google without original SERVICE _V does not settle the bill');
}

console.log('\n=== 8. Dale 2026-09-02 Iron Butcher groceries; Surrey Meat stays Dog food ===');
{
  const plan = syntheticPlan();
  const iron = F.classifyCurrentPeriodTransaction(ironButcherTx(), plan);
  ok(iron.kind === 'spend' && iron.categoryId === 'groceries'
      && iron.needsConfirmation !== true && iron.householdSpending === true
      && iron.categoryId !== 'pets',
    'Iron Butcher classifies Groceries, not uncertain, not Dog food, no confirmation',
    JSON.stringify(iron));
  const ironPets = F.classifyCurrentPeriodTransaction(
    ironButcherTx({ categoryLabel: 'Pets' }), plan);
  ok(ironPets.needsConfirmation === true && ironPets.reason === 'payee-category-contradiction',
    'H1: a grocery merchant labelled Pets is not turned into Groceries',
    JSON.stringify(ironPets));
  const ironOther = F.classifyCurrentPeriodTransaction(
    ironButcherTx({ categoryLabel: 'Gifts', id: 'tx-iron-gifts' }), plan);
  ok(ironOther.needsConfirmation === true && ironOther.reason === 'unmapped-label',
    'H1: a grocery merchant labelled Gifts follows its Lunch Money category',
    JSON.stringify(ironOther));
  const ironFlags = F.classifyCurrentPeriodTransaction.derivedFlags(ironButcherTx());
  ok(ironFlags.confirmedGrocery === true && ironFlags.groceryUncertain !== true
      && ironFlags.dogFood !== true,
    'Iron Butcher derived flags are confirmed grocery, not uncertain, not dog food',
    JSON.stringify(ironFlags));
  const localMeatPets = F.classifyCurrentPeriodTransaction(otherMeatTx(), plan);
  ok(localMeatPets.needsConfirmation === true && localMeatPets.kind !== 'spend'
      && localMeatPets.categoryId !== 'groceries'
      && (localMeatPets.reason === 'payee-category-contradiction'
        || localMeatPets.reason === 'pets-not-dog-food'),
    'Local Butcher is not the Iron Butcher rule; Pets stays confirmation, not Groceries',
    JSON.stringify(localMeatPets));
  const localMeatGroc = F.classifyCurrentPeriodTransaction(
    otherMeatTx({ categoryLabel: 'Groceries', id: 'tx-other-meat-groc' }), plan);
  ok(localMeatGroc.kind === 'spend' && localMeatGroc.categoryId === 'groceries'
      && localMeatGroc.includeReason === 'groceries-category',
    'Local Butcher labelled Groceries still uses the category path, not Iron Butcher identity',
    JSON.stringify(localMeatGroc));
  const meridian = F.classifyCurrentPeriodTransaction(meridianTx(), plan);
  ok(meridian.kind === 'spend' && meridian.categoryId === 'groceries'
      && meridian.needsConfirmation !== true,
    'Meridian Farm stays confirmed Groceries; Iron Butcher rule does not replace it');
  const surrey = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: 12, categoryLabel: 'Groceries',
    originalMerchant: 'SURREY MEAT PKR _F', displayedPayee: 'SURREY MEAT PKR _F',
  }, plan);
  // H1 (lead decision 2026-11-07): the explicit Lunch Money Groceries
  // category wins over the dog-food merchant rule.
  ok(surrey.kind === 'spend' && surrey.categoryId === 'groceries',
    'H1: an explicit Groceries label at the dog-food merchant stays Groceries');

  ok(near(WALMART_AMT + MERIDIAN_AMT + IRON_BUTCHER_AMT, GROCERY_WITH_IRON)
      && near(GROCERY_WITH_IRON, 79.01),
    'independent fixture arithmetic: Groceries $41.17+$19.44+$18.40=$79.01');
  const packet = actualsPacket([
    walmartTx(),
    meridianTx(),
    ironButcherTx(),
    otherMeatTx(),
    otherTx(),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const pets = budgetRow(active, 'pets');
  const other = otherRow(active);
  const ids = reconIds(active);
  ok(groceries && near(groceries.spent, GROCERY_WITH_IRON)
      && near(reconSum(groceries), GROCERY_WITH_IRON)
      && (groceries.recon || []).some(row => row && row.id === 'tx-iron-butcher'),
    'Iron Butcher enters Groceries Spent with Walmart + Meridian Farm');
  ok(!(pets && (pets.recon || []).some(row => row && row.id === 'tx-iron-butcher'))
      && !(other && (other.recon || []).some(row => row && row.id === 'tx-iron-butcher')),
    'Iron Butcher is in neither Dog food nor Other spending');
  ok(ids.includes('tx-other-meat') && !((groceries.recon || []).some(row => row && row.id === 'tx-other-meat')),
    'Local Butcher Pets confirmation does not enter Groceries');
}

console.log('\n=== 9. excluded Business Walmart / Meridian Farm stay out of Household Budget ===');
{
  ok(near(BUSINESS_WALMART_AMT + BUSINESS_MERIDIAN_AMT, EXCLUDED_BUSINESS_INDEPENDENT)
      && near(EXCLUDED_BUSINESS_INDEPENDENT, 36.18)
      && near(SPENT_WITHOUT_BILL + EXCLUDED_BUSINESS_INDEPENDENT, 104.29),
    'independent fixture arithmetic: excluded Business $22.11+$14.07=$36.18; leak would make Spent $104.29');
  const plan = syntheticPlan();
  ok((plan.budget.excluded || []).some(row => row && row.from === 'Business'),
    'synthetic plan carries the incumbent excluded Business category');
  const businessWalmart = walmartTx({
    id: 'tx-walmart-business',
    amount: BUSINESS_WALMART_AMT,
    categoryLabel: 'Business',
  });
  const businessMeridian = meridianTx({
    id: 'tx-meridian-business',
    amount: BUSINESS_MERIDIAN_AMT,
    categoryLabel: 'Business',
  });
  const householdWalmart = walmartTx();
  const householdMeridian = meridianTx();
  const walmartCls = F.classifyCurrentPeriodTransaction(businessWalmart, plan);
  const meridianCls = F.classifyCurrentPeriodTransaction(businessMeridian, plan);
  ok(walmartCls.kind === 'business' && walmartCls.householdSpending === false
      && walmartCls.reason === 'excluded' && walmartCls.categoryId !== 'groceries',
    'Business-category Walmart remains kind business, householdSpending false',
    JSON.stringify(walmartCls));
  ok(meridianCls.kind === 'business' && meridianCls.householdSpending === false
      && meridianCls.reason === 'excluded' && meridianCls.categoryId !== 'groceries',
    'Business-category Meridian Farm remains kind business, householdSpending false',
    JSON.stringify(meridianCls));
  const walmartCaBiz = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: BUSINESS_WALMART_AMT, categoryLabel: 'Business',
    displayedPayee: 'WALMARTCA', originalMerchant: 'WALMARTCA',
    accountRole: 'household-cash',
  }, plan);
  ok(walmartCaBiz.kind === 'business' && walmartCaBiz.householdSpending === false,
    'Business-category WALMARTCA remains excluded non-household');
  const eligibleWalmart = F.classifyCurrentPeriodTransaction(householdWalmart, plan);
  const eligibleMeridian = F.classifyCurrentPeriodTransaction(householdMeridian, plan);
  ok(eligibleWalmart.kind === 'spend' && eligibleWalmart.categoryId === 'groceries'
      && eligibleWalmart.householdSpending === true && eligibleWalmart.needsConfirmation !== true,
    'eligible household Walmart still classifies as Groceries',
    JSON.stringify(eligibleWalmart));
  ok(eligibleMeridian.kind === 'spend' && eligibleMeridian.categoryId === 'groceries'
      && eligibleMeridian.householdSpending === true && eligibleMeridian.needsConfirmation !== true,
    'eligible household Meridian Farm still classifies as Groceries',
    JSON.stringify(eligibleMeridian));
  const packet = actualsPacket([
    businessWalmart,
    businessMeridian,
    householdWalmart,
    householdMeridian,
    otherTx(),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const other = otherRow(active);
  const ids = reconIds(active);
  ok(groceries && near(groceries.spent, GROCERY_INDEPENDENT)
      && near(reconSum(groceries), GROCERY_INDEPENDENT)
      && (groceries.recon || []).some(row => row && row.id === 'tx-walmart')
      && (groceries.recon || []).some(row => row && row.id === 'tx-meridian'),
    'eligible household Walmart and Meridian Farm still enter Groceries recon');
  ok(!ids.includes('tx-walmart-business') && !ids.includes('tx-meridian-business'),
    'Business Walmart and Business Meridian Farm appear in no Household Budget recon row');
  ok(!(groceries.recon || []).some(row => row && (row.id === 'tx-walmart-business' || row.id === 'tx-meridian-business'))
      && !(other && (other.recon || []).some(row => row && (row.id === 'tx-walmart-business' || row.id === 'tx-meridian-business'))),
    'Business grocery merchants are in neither Groceries nor Other spending');
  ok(near(householdSpent(active), SPENT_WITHOUT_BILL)
      && !near(householdSpent(active), roundCent(SPENT_WITHOUT_BILL + EXCLUDED_BUSINESS_INDEPENDENT)),
    'Household Budget Spent stays $68.11; excluded $36.18 does not leak into spent');
}

console.log('\n=== 10. Unmatched fees stay visible; Amazon + travelvisa is Amanda ===');
{
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8'));
  const billSetStart = forecastSrc.indexOf('const BILL_CATEGORY_LABELS = new Set([');
  const billSetEnd = forecastSrc.indexOf(']);', billSetStart);
  const billSet = forecastSrc.slice(billSetStart, billSetEnd + 3);
  ok(/'natural gas'/.test(billSet) && !/'other bank fees'/.test(billSet),
    'Other bank fees requires represented transaction linkage, not a blanket label exclusion');
  ok(!/'interest charge'/.test(billSet) && !/'overdraft fees'/.test(billSet)
      && !/'google pets'/.test(billSet),
    'BILL_CATEGORY_LABELS source does not add Interest charge / Overdraft fees / Google Pets');
  ok(/function isRevolvingCardFinanceCharge\(/.test(forecastSrc)
      && /revolving-finance-charge/.test(forecastSrc)
      && /INTEREST CHARGE/.test(forecastSrc),
    'Forecast source names revolving finance-charge identity, not a bill-label fold');
  ok(/function isAmazonMerchant\(/.test(forecastSrc)
      && /function isAmandaAmazonTravelVisa\(/.test(forecastSrc)
      && /amanda-amazon-travelvisa/.test(forecastSrc),
    'Forecast source names Amazon merchant identity and the Amazon+travelvisa standing rule');
  ok(!/isAmazonPrimeMerchant|amazon-prime-bill|amazon-owner-card/.test(forecastSrc),
    'Forecast source does not invent Prime-as-bill or all-Amazon / all-card ownership');
  ok(!/spendIdentityKey|skipDuplicatePending|pendingPostedDuplicatePending/.test(forecastSrc),
    'Forecast source does not restore a general pending+posted identity key');
  ok(/function isPossibleReplacementPending\(/.test(forecastSrc)
      && /function confirmedHouseholdAmount\(/.test(forecastSrc),
    'Forecast names the incumbent possible-replacement pending spend treatment');

  const PRIME_AMT = 9.99;
  const SHOPIFY_AMT = 54.88;
  const AMANDA_TRAVEL_AMAZON = roundCent(AMAZON_AMT + PRIME_AMT);
  const OTHER_AMAZON_MBNA = AMAZON_AMT;
  const DISTINCT_SAME_DAY = roundCent(SHOPIFY_AMT + SHOPIFY_AMT);
  const SHOPIFY_ONCE_PLUS_OTHER = roundCent(SHOPIFY_AMT + OTHER_AMT);
  ok(near(NATURAL_GAS_AMT + BANK_FEE_AMT, 29.5)
      && near(AMANDA_TRAVEL_AMAZON, 23.99)
      && near(OTHER_AMAZON_MBNA + OTHER_AMT, 21.5)
      && near(DISTINCT_SAME_DAY + OTHER_AMT, 117.26)
      && near(SHOPIFY_ONCE_PLUS_OTHER, 62.38),
    'independent fixture arithmetic: bills $29.50; Travel Visa Amazon/Prime $23.99; MBNA Amazon+Other $21.50; two Shopify $117.26; one Shopify $62.38');

  const plan = syntheticPlan();
  const gas = naturalGasTx();
  const fee = bankFeeTx();
  const gasCls = F.classifyCurrentPeriodTransaction(gas, plan);
  const feeCls = F.classifyCurrentPeriodTransaction(fee, plan);
  // Budget audit: a bill-type label alone is not a bill. With no planned
  // bill match, Natural Gas stays household spending that needs
  // confirmation; matched to a planned bill it is that bill.
  ok(gasCls.kind === 'unclassified' && gasCls.householdSpending === true
      && gasCls.needsConfirmation === true,
    'unmatched Natural Gas stays visible in Other spending (needs confirmation), not a bill',
    JSON.stringify(gasCls));
  const gasBillCls = F.classifyCurrentPeriodTransaction(naturalGasTx({ representedBill: true }), plan);
  ok(gasBillCls.kind === 'bill' && gasBillCls.householdSpending === false
      && gasBillCls.reason === 'represented-bill',
    'Natural Gas matched to a planned bill is that bill, not household spending',
    JSON.stringify(gasBillCls));
  ok(feeCls.kind === 'unclassified' && feeCls.householdSpending === true
      && feeCls.reason === 'unmapped-label' && feeCls.needsConfirmation === true,
    'unlinked Other bank fees stays visible in Other spending',
    JSON.stringify(feeCls));

  function failClosedAmazon(cls, flags, label) {
    ok(cls.kind !== 'bill' && cls.reason === 'personal-unassigned'
        && cls.needsConfirmation === true && cls.householdSpending === true
        && cls.categoryId !== 'amanda-guilt-free' && cls.categoryId !== 'dale-guilt-free'
        && flags.personalOwner == null,
      label,
      JSON.stringify({ cls, personalOwner: flags.personalOwner }));
  }
  function amandaTravelAmazon(cls, flags, label) {
    ok(cls.kind === 'spend' && cls.categoryId === 'amanda-guilt-free'
        && cls.needsConfirmation !== true && cls.kind !== 'bill'
        && cls.includeReason === 'owner-evidence-amanda' // H1: Shopping label wins
        && flags.amazonMerchant === true && flags.personalOwner === 'amanda',
      label,
      JSON.stringify({ cls, flags }));
  }

  const amazonTravel = amazonTx({ atlasAccountId: 'travelvisa', account: 'TRAVEL VISA' });
  const amazonMbna = amazonTx({
    id: 'tx-amazon-mbna',
    atlasAccountId: 'mbna', account: 'mana',
  });
  const amazonTriangle = amazonTx({
    id: 'tx-amazon-triangle',
    displayedPayee: 'AMZN Mktp CA', originalMerchant: 'AMZN Mktp CA',
    atlasAccountId: 'triangle', account: 'TRIANGLE MASTERCARD',
  });
  const primeTravel = amazonPrimeTx({ atlasAccountId: 'travelvisa', account: 'TRAVEL VISA' });
  const primeMbna = amazonPrimeTx({
    id: 'tx-prime-video',
    displayedPayee: 'Amazon Prime Video', originalMerchant: 'Amazon Prime Video',
    atlasAccountId: 'mbna', account: 'mana',
  });
  const amazonWithAmanda = amazonTx({
    id: 'tx-amazon-amanda-note',
    atlasAccountId: 'travelvisa', account: 'TRAVEL VISA',
    note: 'Amanda',
  });
  const mbnaPayment = {
    id: 'tx-mbna-payment', date: '2026-08-31', amount: 300,
    pending: false, categoryLabel: 'Credit Card Payment',
    accountRole: 'household-cash', atlasAccountId: 'chequing-a',
    displayedPayee: 'MBNA', originalMerchant: 'MBNA', payee: 'MBNA',
    excludeFromTotals: true, kindHint: 'card-payment',
  };

  const travelCls = F.classifyCurrentPeriodTransaction(amazonTravel, plan);
  const mbnaCls = F.classifyCurrentPeriodTransaction(amazonMbna, plan);
  const triangleCls = F.classifyCurrentPeriodTransaction(amazonTriangle, plan);
  const primeTravelCls = F.classifyCurrentPeriodTransaction(primeTravel, plan);
  const primeMbnaCls = F.classifyCurrentPeriodTransaction(primeMbna, plan);
  const amandaNoteCls = F.classifyCurrentPeriodTransaction(amazonWithAmanda, plan);
  const mbnaPayCls = F.classifyCurrentPeriodTransaction(mbnaPayment, plan);
  const travelFlags = F.classifyCurrentPeriodTransaction.derivedFlags(amazonTravel);
  const mbnaFlags = F.classifyCurrentPeriodTransaction.derivedFlags(amazonMbna);
  const triangleFlags = F.classifyCurrentPeriodTransaction.derivedFlags(amazonTriangle);
  const primeTravelFlags = F.classifyCurrentPeriodTransaction.derivedFlags(primeTravel);
  const primeMbnaFlags = F.classifyCurrentPeriodTransaction.derivedFlags(primeMbna);
  const amandaNoteFlags = F.classifyCurrentPeriodTransaction.derivedFlags(amazonWithAmanda);

  amandaTravelAmazon(travelCls, travelFlags,
    'Amazon shopping on Travel Visa is Amanda guilt-free without a per-tx Amanda tag');
  failClosedAmazon(mbnaCls, mbnaFlags,
    'Amazon shopping on MBNA without owner evidence stays personal-unassigned');
  failClosedAmazon(triangleCls, triangleFlags,
    'AMZN shopping on Triangle without owner evidence stays personal-unassigned');
  amandaTravelAmazon(primeTravelCls, primeTravelFlags,
    'Amazon Prime on Travel Visa is Amanda guilt-free, not a bill');
  failClosedAmazon(primeMbnaCls, primeMbnaFlags,
    'Amazon Prime Video on MBNA is not a bill and stays personal-unassigned');
  ok(amandaNoteCls.kind === 'spend' && amandaNoteCls.categoryId === 'amanda-guilt-free'
      && amandaNoteCls.includeReason === 'owner-evidence-amanda' // H1: Shopping label wins
      && amandaNoteFlags.personalOwner === 'amanda',
    'explicit Amanda note on Travel Visa Amazon still lands Amanda via the standing owner rule',
    JSON.stringify(amandaNoteCls));
  ok(mbnaPayCls.kind === 'card-payment',
    'MBNA payment is card-payment, not Amazon spend',
    JSON.stringify(mbnaPayCls));

  const interestCls = F.classifyCurrentPeriodTransaction({
    date: '2026-09-08', amount: CASHBACK_PURCHASE_INTEREST_AMT,
    categoryLabel: 'Interest charge',
    displayedPayee: 'INTEREST CHARGE -PURCHASE',
    originalMerchant: 'INTEREST CHARGE -PURCHASE',
    atlasAccountId: 'cashback', accountRole: 'revolving-credit',
  }, plan);
  const chequingInterestCls = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: 5, categoryLabel: 'Interest charge',
    displayedPayee: 'INTEREST CHARGE', originalMerchant: 'INTEREST CHARGE',
    atlasAccountId: 'chequing-b', accountRole: 'household-cash',
  }, plan);
  const overdraftCls = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: 5, categoryLabel: 'Overdraft fees',
    displayedPayee: 'OVERDRAFT FEE', originalMerchant: 'OVERDRAFT FEE',
    atlasAccountId: 'chequing-b', accountRole: 'household-cash',
  }, plan);
  const googlePetsCls = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: 3.13, categoryLabel: 'Pets',
    displayedPayee: 'Google', originalMerchant: 'Google',
    atlasAccountId: 'chequing-a', accountRole: 'household-cash',
  }, plan);
  ok(interestCls.kind === 'interest' && interestCls.householdSpending === false
      && interestCls.reason === 'revolving-finance-charge'
      && interestCls.needsConfirmation !== true
      && interestCls.kind !== 'bill' && interestCls.kind !== 'spend',
    'Sep 8 cashback INTEREST CHARGE -PURCHASE is debt/interest cost, not a bill or household spend',
    JSON.stringify(interestCls));
  ok(chequingInterestCls.kind !== 'interest' && chequingInterestCls.kind !== 'bill'
      && chequingInterestCls.reason === 'unmapped-label'
      && chequingInterestCls.householdSpending === true,
    'chequing Interest charge is not this revolving finance-charge path and is not a bill');
  ok(overdraftCls.kind !== 'bill' && overdraftCls.kind !== 'interest'
      && overdraftCls.reason === 'unmapped-label'
      && overdraftCls.householdSpending === true,
    'Overdraft fees remains unmapped-label, not a bill and not revolving finance charge');
  ok(googlePetsCls.kind !== 'bill'
      && googlePetsCls.reason === 'payee-category-contradiction'
      && googlePetsCls.needsConfirmation === true
      && googlePetsCls.householdSpending === true,
    'Google + Pets is a payee/category contradiction, not silent Pets');

  const billPacket = actualsPacket([gas, fee, otherTx()]);
  const billAdvice = recommend(billPacket);
  const billPeriod = period(billAdvice.defaultView, 'this-pay-period');
  const billOther = otherRow(billPeriod);
  const billIds = reconIds(billPeriod);
  const household = budgetRow(billPeriod, 'household');
  const OTHER_FEE_GAS = roundCent(OTHER_AMT + BANK_FEE_AMT + NATURAL_GAS_AMT);
  ok(billOther && near(billOther.spent, OTHER_FEE_GAS)
      && near(reconSum(billOther), OTHER_FEE_GAS)
      && (billOther.recon || []).some(row => row && row.id === 'tx-natural-gas')
      && (billOther.recon || []).some(row => row && row.id === 'tx-bank-fee'),
    'unlinked fee and unmatched Natural Gas both stay in Other');
  ok(billIds.includes('tx-natural-gas') && billIds.includes('tx-bank-fee'),
    'the unlinked fee and unmatched Natural Gas appear in Household Budget recon');
  ok(near(householdSpent(billPeriod), OTHER_FEE_GAS),
    'Household Budget Spent includes the unlinked fee and unmatched Natural Gas once each');
  const matchedGasPacket = actualsPacket([naturalGasTx({ representedBill: true }), fee, otherTx()]);
  const matchedGasPeriod = period(recommend(matchedGasPacket).defaultView, 'this-pay-period');
  ok(!reconIds(matchedGasPeriod).includes('tx-natural-gas')
      && near(householdSpent(matchedGasPeriod), OTHER_AMT + BANK_FEE_AMT),
    'Natural Gas matched to a planned bill does not enter Household spend');

  const amazonPacket = actualsPacket([
    amazonTravel, amazonMbna, primeTravel, otherTx(),
  ]);
  const amazonAdvice = recommend(amazonPacket);
  const amazonPeriod = period(amazonAdvice.defaultView, 'this-pay-period');
  const amanda = budgetRow(amazonPeriod, 'amanda-guilt-free');
  const amazonOther = otherRow(amazonPeriod);
  const amazonIds = reconIds(amazonPeriod);
  const otherAmazonIds = ((amazonOther && amazonOther.recon) || [])
    .filter(row => row && row.id)
    .map(row => row.id);
  ok(amanda && (amanda.recon || []).some(row => row && row.id === 'tx-amazon')
      && (amanda.recon || []).some(row => row && row.id === 'tx-amazon-prime')
      && !(amanda.recon || []).some(row => row && row.id === 'tx-amazon-mbna')
      && near(amanda.spent, AMANDA_TRAVEL_AMAZON)
      && near(reconSum(amanda), AMANDA_TRAVEL_AMAZON),
    'Travel Visa Amazon/Prime enter Amanda guilt-free recon once');
  ok(amazonOther && !otherAmazonIds.includes('tx-amazon')
      && !otherAmazonIds.includes('tx-amazon-prime')
      && otherAmazonIds.includes('tx-amazon-mbna')
      && otherAmazonIds.includes('tx-other')
      && near(amazonOther.spent, roundCent(OTHER_AMAZON_MBNA + OTHER_AMT))
      && near(reconSum(amazonOther), roundCent(OTHER_AMAZON_MBNA + OTHER_AMT)),
    'MBNA Amazon without owner evidence remains in Other with the $7.50 residual; Travel Visa Amazon does not');
  ok(amazonIds.includes('tx-amazon') && amazonIds.includes('tx-amazon-prime')
      && amazonIds.includes('tx-amazon-mbna'),
    'Amazon/Prime still appear in Household Budget recon, Travel Visa on Amanda and MBNA on Other');

  const shopifyPending = {
    id: 'tx-shopify-pending', date: '2026-08-31', amount: SHOPIFY_AMT,
    pending: true, pendingTreatment: 'unresolved', categoryLabel: null,
    accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
    displayedPayee: 'SHOPIFY INC/578523914', originalMerchant: 'SHOPIFY INC/578523914',
  };
  const shopifyPosted = {
    id: 'tx-shopify-posted', date: '2026-08-31', amount: SHOPIFY_AMT,
    pending: false, pendingTreatment: 'confirmed-settled', categoryLabel: null,
    accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
    displayedPayee: 'SHOPIFY INC/578523914', originalMerchant: 'SHOPIFY INC/578523914',
  };
  const distinctPacket = actualsPacket([shopifyPending, shopifyPosted, otherTx()]);
  const distinctAdvice = recommend(distinctPacket);
  const distinctPeriod = period(distinctAdvice.defaultView, 'this-pay-period');
  const distinctOther = otherRow(distinctPeriod);
  const distinctIds = ((distinctOther && distinctOther.recon) || [])
    .filter(row => row && row.id).map(row => row.id);
  const shopifyDupRows = ((distinctOther && distinctOther.recon) || [])
    .filter(row => row && (row.id === 'tx-shopify-pending' || row.id === 'tx-shopify-posted'));
  ok(distinctOther && distinctIds.includes('tx-shopify-pending')
      && distinctIds.includes('tx-shopify-posted') && distinctIds.includes('tx-other')
      && shopifyDupRows.length === 2
      && shopifyDupRows.every(row => row.pendingPostedDuplicate === true)
      && shopifyDupRows.some(row => row.pending === true)
      && shopifyDupRows.some(row => row.pending === false)
      && near(distinctOther.spent, SHOPIFY_ONCE_PLUS_OTHER)
      && near(reconSum(distinctOther), roundCent(DISTINCT_SAME_DAY + OTHER_AMT))
      && !near(distinctOther.spent, roundCent(DISTINCT_SAME_DAY + OTHER_AMT)),
    'Forecast-only pending+posted 4-tuple keeps both rows, flags possible replacement, and counts posted only in Spent');

  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      {
        providerAccountId: '3006',
        canonical: { collection: 'debts', id: 'travelvisa' },
        atlasRole: 'revolving-credit',
      },
      {
        providerAccountId: '3007',
        canonical: { collection: 'debts', id: 'mbna' },
        atlasRole: 'revolving-credit',
      },
      {
        providerAccountId: '1001',
        canonical: { collection: 'cash', id: 'chequing-a' },
        atlasRole: 'household-cash',
      },
    ],
  };
  const published = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    tags: [{ id: 77, name: 'Amanda' }],
    collapsedTransactions: [
      {
        date: '2026-09-01', amount: 19.14, pending: true, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3006', providerTransactionId: '126',
      },
      {
        date: '2026-08-31', amount: 33.59, pending: true, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon', notes: null,
        tags: [{ name: 'Amanda' }],
        providerAccountId: '3006', providerTransactionId: '125',
      },
      {
        date: '2026-08-31', amount: 29.10, pending: true, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        tag_ids: [77],
        providerAccountId: '3006', providerTransactionId: 'tag-ids-amzn',
      },
      {
        date: '2026-08-31', amount: PRIME_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'Amazon Prime', originalName: 'Amazon Prime',
        providerAccountId: '3006', providerTransactionId: 'prime-1',
      },
      {
        date: '2026-08-31', amount: AMAZON_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3007', providerTransactionId: 'mbna-amzn',
      },
      {
        date: '2026-08-31', amount: 300, pending: false, categoryLabel: 'Credit Card Payment',
        payee: 'MBNA', originalName: 'MBNA', excludeFromTotals: true,
        providerAccountId: '1001', providerTransactionId: 'mbna-pmt',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const pubBlob = JSON.stringify(published);
  ok(O.currentPeriodActualsLooksSanitized(published)
      && !/"payee"\s*:/.test(pubBlob) && !/"notes"\s*:/.test(pubBlob)
      && !/"tags"\s*:/.test(pubBlob) && !/"tag_ids"\s*:/.test(pubBlob)
      && !/"providerTransactionId"\s*:/.test(pubBlob)
      && !/"externalId"\s*:/.test(pubBlob),
    'overlay packet keeps no raw payee, notes, tags, or provider ids');
  const byAmt = amt => (published.transactions || []).find(tx => tx && near(tx.amount, amt));
  const strippedTravel = byAmt(19.14);
  const taggedTravel = byAmt(33.59);
  const taggedViaIds = byAmt(29.10);
  const publishedPrime = byAmt(PRIME_AMT);
  const publishedMbna = byAmt(AMAZON_AMT);
  const publishedMbnaPay = byAmt(300);
  ok(strippedTravel && strippedTravel.personalOwner === 'amanda'
      && strippedTravel.amazonMerchant === true
      && strippedTravel.atlasAccountId === 'travelvisa'
      && !Object.prototype.hasOwnProperty.call(strippedTravel, 'tags')
      && !Object.prototype.hasOwnProperty.call(strippedTravel, 'notes')
      && !Object.prototype.hasOwnProperty.call(strippedTravel, 'payee'),
    'Travel Visa Amazon stamps amazonMerchant and Amanda before overlay strip');
  ok(taggedTravel && taggedTravel.personalOwner === 'amanda'
      && !Object.prototype.hasOwnProperty.call(taggedTravel, 'tags'),
    'LM Amanda tag is stamped onto personalOwner before tags are stripped');
  ok(taggedViaIds && taggedViaIds.personalOwner === 'amanda'
      && !Object.prototype.hasOwnProperty.call(taggedViaIds, 'tags')
      && !Object.prototype.hasOwnProperty.call(taggedViaIds, 'tag_ids'),
    'v2 tag_ids resolve to Amanda and stamp personalOwner before strip');
  const taggedCls = F.classifyCurrentPeriodTransaction({
    id: taggedTravel.id, date: taggedTravel.date, amount: taggedTravel.amount,
    pending: true, categoryLabel: 'Shopping', accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa', personalOwner: taggedTravel.personalOwner,
  }, plan);
  ok(taggedCls.kind === 'spend' && taggedCls.categoryId === 'amanda-guilt-free'
      && taggedCls.includeReason === 'owner-evidence-amanda',
    'explicit Amanda tag that survived strip still classifies amanda-guilt-free',
    JSON.stringify(taggedCls));
  const strippedCls = F.classifyCurrentPeriodTransaction({
    id: strippedTravel.id, date: strippedTravel.date, amount: strippedTravel.amount,
    pending: true, categoryLabel: 'Shopping', accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    amazonMerchant: strippedTravel.amazonMerchant,
    personalOwner: null,
  }, plan);
  ok(strippedCls.kind === 'spend' && strippedCls.categoryId === 'amanda-guilt-free'
      && strippedCls.includeReason === 'owner-evidence-amanda', // H1: Shopping label wins
    'Travel Visa Amazon after overlay strip still classifies Amanda guilt-free from amazonMerchant + account',
    JSON.stringify(strippedCls));
  ok(publishedPrime && publishedPrime.personalOwner === 'amanda'
      && publishedPrime.amazonMerchant === true
      && publishedPrime.subscriptionBill !== true && publishedPrime.kind !== 'bill',
    'Prime on Travel Visa stamps Amanda ownership, not a derived bill flag');
  const primeStrippedCls = F.classifyCurrentPeriodTransaction({
    id: publishedPrime.id, date: publishedPrime.date, amount: publishedPrime.amount,
    pending: false, categoryLabel: 'Shopping', accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    amazonMerchant: publishedPrime.amazonMerchant,
    personalOwner: null,
  }, plan);
  ok(primeStrippedCls.kind !== 'bill' && primeStrippedCls.kind === 'spend'
      && primeStrippedCls.categoryId === 'amanda-guilt-free'
      && primeStrippedCls.includeReason === 'owner-evidence-amanda', // H1
    'Prime on Travel Visa classifies Amanda after merchant/tags are stripped, and is not a bill',
    JSON.stringify(primeStrippedCls));
  ok(publishedMbna && publishedMbna.personalOwner == null
      && F.classifyCurrentPeriodTransaction(publishedMbna, plan).reason === 'personal-unassigned',
    'MBNA Amazon without owner evidence does not stamp Amanda after overlay sanitizer');
  ok(publishedMbnaPay && publishedMbnaPay.kindHint === 'card-payment'
      && publishedMbnaPay.personalOwner == null
      && F.classifyCurrentPeriodTransaction(publishedMbnaPay, plan).kind === 'card-payment',
    'MBNA payment is card-payment after overlay strip',
    JSON.stringify(publishedMbnaPay));

  const shopifyOverlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: true, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'lm-shop-pend',
        plaidMetadata: { transaction_id: 'plaid-shop-pend' },
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'lm-shop-post',
        plaidMetadata: {
          transaction_id: 'plaid-shop-post',
          pending_transaction_id: 'plaid-shop-pend',
        },
      },
      {
        date: '2026-08-31', amount: OTHER_AMT, pending: false, categoryLabel: 'Gifts',
        payee: 'Gift Shop', originalName: 'Gift Shop',
        providerAccountId: '1001', providerTransactionId: 'gift-1',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const shopifyTxs = shopifyOverlay.transactions || [];
  const shopifyIds = shopifyTxs.filter(tx => near(tx.amount, SHOPIFY_AMT)).map(tx => tx.id);
  const shopifyPacket = actualsPacket(shopifyTxs);
  const shopifyAdvice = recommend(shopifyPacket);
  const shopifyPeriod = period(shopifyAdvice.defaultView, 'this-pay-period');
  const shopifyOther = otherRow(shopifyPeriod);
  ok(shopifyIds.length === 1
      && shopifyTxs.some(tx => near(tx.amount, SHOPIFY_AMT) && tx.pending === false)
      && !shopifyTxs.some(tx => near(tx.amount, SHOPIFY_AMT) && tx.pending === true)
      && shopifyOther && near(shopifyOther.spent, roundCent(SHOPIFY_AMT + OTHER_AMT))
      && near(reconSum(shopifyOther), roundCent(SHOPIFY_AMT + OTHER_AMT)),
    'pending→posted Shopify with directed Plaid pending_transaction_id linkage counts once',
    JSON.stringify({ shopifyIds, spent: shopifyOther && shopifyOther.spent }));

  const observeSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/provider-observe.js'), 'utf8'));
  ok(observeSrc.includes('SHOPIFY INC/578523914'),
    'observer names the owner-confirmed Shopify originalMerchant exactly');
  ok(!/skipPendingPostedDuplicate|spendIdentityKey/.test(observeSrc),
    'observer does not restore a general pending+posted 4-tuple identity key');

  const shopifyByIdentity = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: true, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: '103',
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: false, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: '113',
      },
      {
        date: '2026-08-31', amount: OTHER_AMT, pending: false, categoryLabel: 'Gifts',
        payee: 'Gift Shop', originalName: 'Gift Shop',
        providerAccountId: '1001', providerTransactionId: 'gift-identity',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const identityTxs = shopifyByIdentity.transactions || [];
  const identityShopify = identityTxs.filter(tx => near(tx.amount, SHOPIFY_AMT));
  const identityPacket = actualsPacket(identityTxs);
  const identityAdvice = recommend(identityPacket);
  const identityPeriod = period(identityAdvice.defaultView, 'this-pay-period');
  const identityOther = otherRow(identityPeriod);
  ok(identityShopify.length === 1
      && identityShopify[0].pending === false
      && !identityTxs.some(tx => near(tx.amount, SHOPIFY_AMT) && tx.pending === true)
      && identityOther && near(identityOther.spent, SHOPIFY_ONCE_PLUS_OTHER)
      && near(reconSum(identityOther), SHOPIFY_ONCE_PLUS_OTHER)
      && !near(identityOther.spent, roundCent(DISTINCT_SAME_DAY + OTHER_AMT)),
    'owner-confirmed Shopify pending+posted pair without pendingTransactionId counts once',
    JSON.stringify({
      ids: identityShopify.map(tx => tx.id),
      spent: identityOther && identityOther.spent,
    }));

  const otherShopify = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: true, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523915', originalName: 'SHOPIFY INC/578523915',
        providerAccountId: '3006', providerTransactionId: 'other-shop-pend',
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523915', originalName: 'SHOPIFY INC/578523915',
        providerAccountId: '3006', providerTransactionId: 'other-shop-post',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const otherShopifyTwins = (otherShopify.transactions || [])
    .filter(tx => near(tx.amount, SHOPIFY_AMT));
  ok(otherShopifyTwins.length === 2
      && otherShopifyTwins.some(tx => tx.pending === true)
      && otherShopifyTwins.some(tx => tx.pending === false),
    'a different Shopify originalMerchant still publishes both pending and posted');

  const otherAmount = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 54.89, pending: true, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'amt-pend',
      },
      {
        date: '2026-08-31', amount: 54.89, pending: false, categoryLabel: 'Shopping',
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'amt-post',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const otherAmountTwins = (otherAmount.transactions || [])
    .filter(tx => near(tx.amount, 54.89));
  ok(otherAmountTwins.length === 2
      && otherAmountTwins.some(tx => tx.pending === true)
      && otherAmountTwins.some(tx => tx.pending === false),
    'the same Shopify merchant at a different amount still publishes both rows');

  const twoExactPairs = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: true, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'pair-a-pend',
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: false, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'pair-a-post',
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: true, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'pair-b-pend',
      },
      {
        date: '2026-08-31', amount: SHOPIFY_AMT, pending: false, categoryLabel: null,
        payee: 'SHOPIFY INC/578523914', originalName: 'SHOPIFY INC/578523914',
        providerAccountId: '3006', providerTransactionId: 'pair-b-post',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const twoPairTwins = (twoExactPairs.transactions || [])
    .filter(tx => near(tx.amount, SHOPIFY_AMT));
  ok(twoPairTwins.length === 4
      && twoPairTwins.filter(tx => tx.pending === true).length === 2
      && twoPairTwins.filter(tx => tx.pending === false).length === 2,
    'two owner-confirmed 4-tuples stay uncollapsed; the exception is this one pair only');

  const digitTwin = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 19.14, pending: true, categoryLabel: 'Shopping',
        payee: 'STORE 57852', originalName: 'STORE 57852 DOWNTOWN',
        providerAccountId: '3006', providerTransactionId: 'digit-pend-a',
      },
      {
        date: '2026-08-31', amount: 19.14, pending: false, categoryLabel: 'Shopping',
        payee: 'STORE 57852', originalName: 'STORE 57852 DOWNTOWN',
        providerAccountId: '3006', providerTransactionId: 'digit-post-b',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const digitTwins = (digitTwin.transactions || []).filter(tx => near(tx.amount, 19.14));
  ok(digitTwins.length === 2
      && digitTwins.some(tx => tx.pending === true)
      && digitTwins.some(tx => tx.pending === false),
    'two same-account same-amount purchases with the same digit-bearing original_name both survive without a directed settlement link');
  const digitPacket = actualsPacket(digitTwin.transactions || []);
  const digitAdvice = recommend(digitPacket);
  const digitPeriod = period(digitAdvice.defaultView, 'this-pay-period');
  const digitOther = otherRow(digitPeriod);
  const digitRecon = ((digitOther && digitOther.recon) || [])
    .filter(row => row && near(row.amount, 19.14));
  ok(digitRecon.length === 2
      && digitRecon.every(row => row.pendingPostedDuplicate === true)
      && digitRecon.some(row => row.pending === true)
      && digitOther && near(digitOther.spent, 19.14)
      && near(reconSum(digitOther), 38.28)
      && !near(digitOther.spent, 38.28),
    'digit-bearing same 4-tuple stays both visible; confirmed Spent is the posted $19.14 only');

  const genericTwin = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 19.14, pending: true, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3006', providerTransactionId: 'amz-pend',
      },
      {
        date: '2026-08-31', amount: 19.14, pending: false, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3006', providerTransactionId: 'amz-post',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const genericTwins = (genericTwin.transactions || [])
    .filter(tx => near(tx.amount, 19.14));
  ok(genericTwins.length === 2
      && genericTwins.every(tx => tx.pendingPostedDuplicate === true)
      && genericTwins.some(tx => tx.pending === true)
      && genericTwins.some(tx => tx.pending === false),
    'pending+posted without pendingTransactionId keeps both rows and surfaces a duplicate');
  const genericPacket = actualsPacket(genericTwin.transactions || []);
  const genericAdvice = recommend(genericPacket);
  const genericPeriod = period(genericAdvice.defaultView, 'this-pay-period');
  const genericAmanda = budgetRow(genericPeriod, 'amanda-guilt-free');
  const genericOther = otherRow(genericPeriod);
  const genericRecon = ((genericAmanda && genericAmanda.recon) || [])
    .filter(row => row && near(row.amount, 19.14));
  ok(genericRecon.length === 2
      && genericRecon.every(row => row.pendingPostedDuplicate === true)
      && genericRecon.some(row => row.pending === true)
      && genericRecon.some(row => row.pending === false)
      && genericAmanda && near(genericAmanda.spent, 19.14)
      && near(reconSum(genericAmanda), 38.28)
      && !near(genericAmanda.spent, 38.28)
      && !(genericOther && (genericOther.recon || []).some(row => near(row.amount, 19.14))),
    'posted $19.14 + pending $19.14 Amazon Travel Visa stay visible on Amanda, flagged possible replacement, and confirmed Spent is $19.14');

  const PLAID_PENDING_AMT = 100.00;
  const PLAID_POSTED_AMT = 97.50;
  const PLAID_UNRELATED_AMT = 42.00;
  const PLAID_SETTLED_TOTAL = roundCent(PLAID_POSTED_AMT + PLAID_UNRELATED_AMT);
  ok(near(PLAID_SETTLED_TOTAL, 139.50)
      && near(roundCent(PLAID_PENDING_AMT + PLAID_POSTED_AMT + PLAID_UNRELATED_AMT), 239.50),
    'independent fixture arithmetic: settled Plaid pair $97.50+$42.00=$139.50; double-count would be $239.50');

  const plaidLinked = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
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
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const plaidTxs = plaidLinked.transactions || [];
  const plaidBlob = JSON.stringify(plaidLinked);
  const plaidPacket = actualsPacket(plaidTxs);
  const plaidAdvice = recommend(plaidPacket);
  const plaidPeriod = period(plaidAdvice.defaultView, 'this-pay-period');
  const plaidAmanda = budgetRow(plaidPeriod, 'amanda-guilt-free');
  const plaidOther = otherRow(plaidPeriod);
  ok(plaidTxs.filter(tx => near(tx.amount, PLAID_PENDING_AMT) && tx.pending === true).length === 0
      && plaidTxs.filter(tx => near(tx.amount, PLAID_POSTED_AMT) && tx.pending === false).length === 1
      && plaidTxs.filter(tx => near(tx.amount, PLAID_UNRELATED_AMT) && tx.pending === false).length === 1,
    'Plaid-directed pending $100 is replaced; posted $97.50 and unrelated $42.00 remain');
  ok(plaidAmanda && near(plaidAmanda.spent, PLAID_POSTED_AMT)
      && plaidOther && near(plaidOther.spent, PLAID_UNRELATED_AMT)
      && near(householdSpent(plaidPeriod), PLAID_SETTLED_TOTAL)
      && near(reconSum(plaidAmanda) + reconSum(plaidOther), PLAID_SETTLED_TOTAL)
      && !near(householdSpent(plaidPeriod), 239.50),
    'independent household total after Plaid settlement is $139.50, not $239.50');
  ok(!/plaid-pending-abc|plaid-posted-def|plaid_metadata|plaidTransactionId|pending_transaction_id/.test(plaidBlob)
      && !/"providerTransactionId"\s*:/.test(plaidBlob)
      && !/lm-pending-101|lm-posted-202|lm-posted-unrelated/.test(plaidBlob),
    'Plaid transaction ids, pending_transaction_id, plaid_metadata, and Lunch Money ids stay out of sanitized actuals');

  const falseLmLink = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 19.14, pending: true, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3006', providerTransactionId: 'shop-pend',
        pendingTransactionId: null,
      },
      {
        date: '2026-08-31', amount: 19.14, pending: false, categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3006', providerTransactionId: 'shop-post',
        pendingTransactionId: 'shop-pend',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const falseLmTwins = (falseLmLink.transactions || []).filter(tx => near(tx.amount, 19.14));
  ok(falseLmTwins.length === 2
      && falseLmTwins.some(tx => tx.pending === true)
      && falseLmTwins.some(tx => tx.pending === false),
    'posted pendingTransactionId pointing at a Lunch Money id is not Plaid identity and does not collapse');

  const ambiguousPlaid = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: PLAID_PENDING_AMT, pending: true, categoryLabel: 'Shopping',
        payee: 'AMZN Mktp CA', originalName: 'AMZN Mktp CA',
        providerAccountId: '3006', providerTransactionId: 'lm-amb-pend',
        plaidMetadata: { transaction_id: 'plaid-pending-amb' },
      },
      {
        date: '2026-08-31', amount: 61.00, pending: false, categoryLabel: 'Shopping',
        payee: 'AMZN Mktp CA', originalName: 'AMZN Mktp CA',
        providerAccountId: '3006', providerTransactionId: 'lm-amb-post-a',
        plaidMetadata: {
          transaction_id: 'plaid-posted-amb-a',
          pending_transaction_id: 'plaid-pending-amb',
        },
      },
      {
        date: '2026-08-31', amount: 39.00, pending: false, categoryLabel: 'Shopping',
        payee: 'AMZN Mktp CA', originalName: 'AMZN Mktp CA',
        providerAccountId: '3006', providerTransactionId: 'lm-amb-post-b',
        plaidMetadata: {
          transaction_id: 'plaid-posted-amb-b',
          pending_transaction_id: 'plaid-pending-amb',
        },
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const ambTxs = ambiguousPlaid.transactions || [];
  const ambPending = ambTxs.filter(tx => near(tx.amount, PLAID_PENDING_AMT) && tx.pending === true);
  const ambPosted = ambTxs.filter(tx => tx.pending === false);
  const ambPacket = actualsPacket(ambTxs);
  const ambAdvice = recommend(ambPacket);
  const ambPeriod = period(ambAdvice.defaultView, 'this-pay-period');
  const ambAmanda = budgetRow(ambPeriod, 'amanda-guilt-free');
  const ambIndependent = roundCent(PLAID_PENDING_AMT + 61 + 39);
  ok(near(ambIndependent, 200),
    'independent ambiguous total is $100+$61+$39=$200.00');
  ok(ambPending.length === 1 && ambPosted.length === 2
      && ambTxs.every(tx => tx.pendingPostedAmbiguous === true)
      && ambAmanda && near(ambAmanda.spent, ambIndependent)
      && near(reconSum(ambAmanda), ambIndependent),
    'two posted rows claiming one pending Plaid id fail closed: pending stays and both posted amounts remain');

  const twoPosted = actualsPacket([
    {
      id: 'tx-posted-a', date: '2026-08-31', amount: 19.14,
      pending: false, pendingTreatment: 'confirmed-settled', categoryLabel: 'Shopping',
      accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
      displayedPayee: 'STORE A', originalMerchant: 'STORE A',
    },
    {
      id: 'tx-posted-b', date: '2026-08-31', amount: 19.14,
      pending: false, pendingTreatment: 'confirmed-settled', categoryLabel: 'Shopping',
      accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
      displayedPayee: 'STORE B', originalMerchant: 'STORE B',
    },
  ]);
  const twoPostedAdvice = recommend(twoPosted);
  const twoPostedPeriod = period(twoPostedAdvice.defaultView, 'this-pay-period');
  const twoPostedOther = otherRow(twoPostedPeriod);
  const twoPostedIds = ((twoPostedOther && twoPostedOther.recon) || [])
    .filter(row => row && row.id).map(row => row.id);
  ok(twoPostedOther && twoPostedIds.includes('tx-posted-a')
      && twoPostedIds.includes('tx-posted-b')
      && near(twoPostedOther.spent, 38.28)
      && !((twoPostedOther.recon || []).some(row => row && row.pendingPostedDuplicate === true)),
    'two genuine posted same-amount purchases both count');

  const googlePetsOverlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: GOOGLE_AMT, pending: false, categoryLabel: 'Pets',
        payee: 'Google', originalName: 'Google',
        providerAccountId: '1001', providerTransactionId: 'google-pets-not-storage',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const googlePetsTx = (googlePetsOverlay.transactions || [])
    .find(tx => tx && near(tx.amount, GOOGLE_AMT));
  const googlePetsOverlayCls = googlePetsTx
    ? F.classifyCurrentPeriodTransaction(googlePetsTx, plan) : null;
  ok(googlePetsTx && googlePetsOverlayCls
      && googlePetsOverlayCls.kind !== 'bill'
      && googlePetsOverlayCls.reason === 'payee-category-contradiction'
      && googlePetsOverlayCls.needsConfirmation === true
      && googlePetsOverlayCls.householdSpending === true,
    'Google + Pets without storage identity is confirmation, not silent Pets/Other-as-Pets',
    JSON.stringify(googlePetsOverlayCls));

  const otherPetsOverlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: 12, pending: false, categoryLabel: 'Pets',
        payee: 'PET VALU', originalName: 'PET VALU',
        providerAccountId: '1001', providerTransactionId: 'pets-other',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const otherPetsTx = (otherPetsOverlay.transactions || [])
    .find(tx => tx && near(tx.amount, 12));
  const otherPetsCls = otherPetsTx
    ? F.classifyCurrentPeriodTransaction(otherPetsTx, plan) : null;
  ok(otherPetsTx && otherPetsCls
      && otherPetsCls.kind !== 'bill'
      && otherPetsCls.reason === 'pets-not-dog-food'
      && otherPetsCls.householdSpending === true,
    'other Pets txs stay pets-not-dog-food; no Pets mapping was invented',
    JSON.stringify(otherPetsCls));
}

console.log('\n=== 11. Dale 2026-09-02 Cursor is Dale guilt-free; other AI is not ===');
{
  const plan = syntheticPlan();
  const cursor = F.classifyCurrentPeriodTransaction(cursorTx(), plan);
  ok(cursor.kind === 'spend' && cursor.categoryId === 'dale-guilt-free'
      && cursor.needsConfirmation !== true && cursor.householdSpending === true
      && cursor.categoryId !== 'amanda-guilt-free',
    'Cursor classifies Dale guilt-free, not Other, not Amanda, no confirmation',
    JSON.stringify(cursor));
  const cursorGifts = F.classifyCurrentPeriodTransaction(
    cursorTx({ categoryLabel: 'Gifts', id: 'tx-cursor-gifts' }), plan);
  ok(cursorGifts.needsConfirmation === true && cursorGifts.reason === 'unmapped-label',
    'H1: the Dale guilt-free merchant labelled Gifts follows its Lunch Money category',
    JSON.stringify(cursorGifts));
  const cursorAmanda = F.classifyCurrentPeriodTransaction(
    cursorTx({
      id: 'tx-cursor-amanda-tag',
      personalOwner: 'amanda',
      tags: [{ name: 'Amanda' }],
      note: 'Amanda',
    }), plan);
  ok(cursorAmanda.kind === 'spend' && cursorAmanda.categoryId === 'dale-guilt-free'
      && cursorAmanda.categoryId !== 'amanda-guilt-free',
    'Cursor merchant wins over Amanda tag/note; never Amanda',
    JSON.stringify(cursorAmanda));
  const cursorFlags = F.classifyCurrentPeriodTransaction.derivedFlags(cursorTx());
  ok(cursorFlags.daleGuiltFreeMerchant === true && cursorFlags.personalOwner === 'dale',
    'Cursor derived flags stamp daleGuiltFreeMerchant and personalOwner dale',
    JSON.stringify(cursorFlags));
  const openai = F.classifyCurrentPeriodTransaction(otherAiTx(), plan);
  const openaiFlags = F.classifyCurrentPeriodTransaction.derivedFlags(otherAiTx());
  ok(openai.reason === 'personal-unassigned' && openai.needsConfirmation === true
      && openai.categoryId !== 'dale-guilt-free' && openai.categoryId !== 'amanda-guilt-free'
      && openaiFlags.personalOwner == null && openaiFlags.daleGuiltFreeMerchant !== true,
    'OpenAI does not gain Dale from the Cursor rule',
    JSON.stringify({ openai, openaiFlags }));
  const chatgpt = F.classifyCurrentPeriodTransaction({
    id: 'tx-chatgpt',
    date: '2026-08-31', amount: OTHER_AI_AMT, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'ChatGPT', originalMerchant: 'ChatGPT',
  }, plan);
  ok(chatgpt.reason === 'personal-unassigned' && chatgpt.categoryId !== 'dale-guilt-free',
    'ChatGPT merchant is not the Cursor rule');

  ok(near(CURSOR_AMT, 20) && near(OTHER_AMT, 7.50)
      && near(CURSOR_AMT + OTHER_AMT, 27.50),
    'independent fixture arithmetic: Cursor $20.00; Other residual $7.50');
  const packet = actualsPacket([
    cursorTx(),
    otherAiTx(),
    otherTx(),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const dale = budgetRow(active, 'dale-guilt-free');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  ok(dale && near(dale.spent, CURSOR_AMT) && near(reconSum(dale), CURSOR_AMT)
      && (dale.recon || []).some(row => row && row.id === 'tx-cursor'),
    'Cursor enters Dale guilt-free Spent');
  ok(!(amanda && (amanda.recon || []).some(row => row && row.id === 'tx-cursor')),
    'Cursor is absent from Amanda guilt-free');
  ok(!(other && (other.recon || []).some(row => row && row.id === 'tx-cursor')),
    'Cursor is excluded from Other spending');
  ok(other && (other.recon || []).some(row => row && row.id === 'tx-other-ai')
      && (other.recon || []).some(row => row && row.id === 'tx-other'),
    'OpenAI and the Gifts residual remain Other / unassigned, not Dale');

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
  const overlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    tags: [{ id: 77, name: 'Amanda' }],
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: IRON_BUTCHER_AMT, pending: false, categoryLabel: 'Groceries',
        payee: 'Iron Butcher', originalName: 'Iron Butcher',
        providerAccountId: '1001', providerTransactionId: 'iron-1',
      },
      {
        date: '2026-08-31', amount: CURSOR_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'Cursor', originalName: 'Cursor',
        tags: [{ name: 'Amanda' }],
        providerAccountId: '3006', providerTransactionId: 'cursor-1',
      },
      {
        date: '2026-08-31', amount: OTHER_AI_AMT, pending: false, categoryLabel: 'Shopping',
        payee: 'OpenAI', originalName: 'OpenAI',
        providerAccountId: '3006', providerTransactionId: 'openai-1',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const overlayBlob = JSON.stringify(overlay);
  ok(O.currentPeriodActualsLooksSanitized(overlay)
      && !/"payee"\s*:/.test(overlayBlob) && !/"notes"\s*:/.test(overlayBlob)
      && !/"tags"\s*:/.test(overlayBlob),
    'owner-rule overlay packet keeps no raw payee, notes, or tags');
  const byAmt = amt => (overlay.transactions || []).find(tx => tx && near(tx.amount, amt));
  const ironPub = byAmt(IRON_BUTCHER_AMT);
  const cursorPub = byAmt(CURSOR_AMT);
  const openaiPub = byAmt(OTHER_AI_AMT);
  ok(ironPub && ironPub.confirmedGrocery === true && ironPub.groceryUncertain !== true
      && ironPub.dogFood !== true,
    'overlay stamps Iron Butcher confirmedGrocery before strip; not uncertain');
  const ironPubCls = F.classifyCurrentPeriodTransaction(ironPub, plan);
  ok(ironPubCls.kind === 'spend' && ironPubCls.categoryId === 'groceries'
      && ironPubCls.needsConfirmation !== true,
    'stripped Iron Butcher packet still classifies Groceries');
  ok(cursorPub && cursorPub.personalOwner === 'dale'
      && cursorPub.daleGuiltFreeMerchant === true
      && !Object.prototype.hasOwnProperty.call(cursorPub, 'tags'),
    'overlay stamps Cursor personalOwner dale before Amanda tags are stripped');
  const cursorPubCls = F.classifyCurrentPeriodTransaction(cursorPub, plan);
  ok(cursorPubCls.kind === 'spend' && cursorPubCls.categoryId === 'dale-guilt-free'
      && cursorPubCls.categoryId !== 'amanda-guilt-free',
    'stripped Cursor packet still classifies Dale guilt-free');
  ok(openaiPub && openaiPub.personalOwner == null
      && openaiPub.daleGuiltFreeMerchant !== true,
    'overlay does not stamp Dale onto OpenAI');
}

console.log('\n=== 12. Dale 2026-09-02 CAN TIRE MC is the Canadian Tire Mastercard payment, never Household Budget ===');
{
  const plan = syntheticPlan();
  const isCardPayment = cls => cls && cls.kind === 'card-payment'
    && cls.householdSpending === false && cls.needsConfirmation !== true
    && cls.categoryId == null;

  // 1. Exact identity -> debt / card payment, whatever the provider label says.
  for (const label of ['Pets', 'Shopping', 'Household', 'Groceries', 'Credit Card Payment', null]) {
    const cls = F.classifyCurrentPeriodTransaction(
      canTireMcTx({ id: 'tx-ctmc-' + String(label), categoryLabel: label }), plan);
    ok(isCardPayment(cls) && cls.reason === 'debt-payment-identity',
      'CAN TIRE MC labelled ' + JSON.stringify(label) + ' is card-payment / debt servicing',
      JSON.stringify(cls));
  }
  for (const payee of ['Can Tire Mc', 'CAN TIRE MC _V', 'can tire mc']) {
    const cls = F.classifyCurrentPeriodTransaction(
      canTireMcTx({ id: 'tx-ctmc-' + payee, displayedPayee: payee, originalMerchant: payee }), plan);
    ok(isCardPayment(cls), 'payee casing / TD type code ' + JSON.stringify(payee) + ' is still the CAN TIRE MC identity');
  }

  // Amount and date are not part of the rule.
  const otherAmount = F.classifyCurrentPeriodTransaction(
    canTireMcTx({ id: 'tx-ctmc-other-amount', amount: 5.55, date: '2026-08-29' }), plan);
  ok(isCardPayment(otherAmount), 'CAN TIRE MC at another amount and date is the same identity');

  // 4. The $271 screenshot-style fixture.
  const fixture = F.classifyCurrentPeriodTransaction(canTireMcTx(), plan);
  ok(near(CAN_TIRE_MC_AMT, 271) && isCardPayment(fixture),
    'the $271 CAN TIRE MC fixture is debt servicing, not household consumption', JSON.stringify(fixture));
  ok(F.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible(fixture) === false,
    'CAN TIRE MC is not eligible for any Household Budget supporting row');

  // 5. Ordinary Canadian Tire retail is NOT debt servicing.
  const retail = F.classifyCurrentPeriodTransaction(canadianTireRetailTx(), plan);
  ok(retail.kind !== 'card-payment' && retail.reason === 'canadian-tire-unconfirmed'
      && retail.needsConfirmation === true,
    'ordinary Canadian Tire retail stays canadian-tire-unconfirmed, never card-payment', JSON.stringify(retail));
  const retailStore = F.classifyCurrentPeriodTransaction(canadianTireRetailTx({
    id: 'tx-canadian-tire-store', displayedPayee: 'Canadian Tire Store #322',
    originalMerchant: 'Canadian Tire Store #322', categoryLabel: 'Shopping',
  }), plan);
  ok(retailStore.kind !== 'card-payment' && retailStore.needsConfirmation === true,
    'a Canadian Tire retail store labelled Shopping is not the card payment either');
  const mastercardNote = F.classifyCurrentPeriodTransaction(canadianTireRetailTx({
    id: 'tx-canadian-tire-note', note: 'Canadian Tire Mastercard',
  }), plan);
  ok(mastercardNote.kind !== 'card-payment',
    'a Canadian Tire retail purchase with a Mastercard note is not the CAN TIRE MC identity');

  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(canTireMcTx());
  ok(flags.cardPaymentIdentity === true && flags.canadianTire !== true,
    'derived flags stamp cardPaymentIdentity on CAN TIRE MC and do not call it Canadian Tire retail',
    JSON.stringify(flags));
  const retailFlags = F.classifyCurrentPeriodTransaction.derivedFlags(canadianTireRetailTx());
  ok(retailFlags.cardPaymentIdentity !== true && retailFlags.canadianTire === true,
    'derived flags keep Canadian Tire retail as canadianTire, not cardPaymentIdentity',
    JSON.stringify(retailFlags));
  const stripped = F.classifyCurrentPeriodTransaction({
    id: 'tx-ctmc-stripped', date: '2026-08-31', amount: CAN_TIRE_MC_AMT,
    categoryLabel: 'Pets', accountRole: 'household-cash', cardPaymentIdentity: true,
  }, plan);
  ok(isCardPayment(stripped), 'a stripped tx carrying only cardPaymentIdentity is still card-payment');

  // 2 / 3. Not Household Budget spending, absent from Other.
  ok(near(WALMART_AMT + OTHER_AMT + CANADIAN_TIRE_RETAIL_AMT, 127.05)
      && near(OTHER_AMT + CANADIAN_TIRE_RETAIL_AMT, 85.88),
    'independent fixture arithmetic: Household Budget $127.05 without the $271; Other $85.88');
  const advice = recommend(actualsPacket([
    canTireMcTx(),
    canadianTireRetailTx(),
    walmartTx(),
    otherTx(),
  ]));
  const active = period(advice.defaultView, 'this-pay-period');
  const other = otherRow(active);
  ok(active && near(householdSpent(active), 127.05),
    'Household Budget Spent excludes the $271 CAN TIRE MC payment',
    String(householdSpent(active)));
  ok(!reconIds(active).includes('tx-can-tire-mc'),
    'CAN TIRE MC appears in no Household Budget recon row');
  ok(other && !(other.recon || []).some(r => r && r.id === 'tx-can-tire-mc')
      && near(other.spent, 85.88),
    'CAN TIRE MC is absent from Other spending; Other is the Gifts residual plus Canadian Tire retail',
    JSON.stringify(other && other.recon.map(r => r.id)));
  ok(other && (other.recon || []).some(r => r && r.id === 'tx-canadian-tire-retail'),
    'ordinary Canadian Tire retail still sits on Other / confirmation');
}

console.log('\n=== 13. Dale 2026-09-02 PITT MEADOWS CE is Fuel, never Other; other Pitt Meadows merchants are not ===');
{
  const plan = syntheticPlan();
  const isFuel = cls => cls && cls.kind === 'spend' && cls.categoryId === 'fuel'
    && cls.householdSpending === true && cls.needsConfirmation !== true;

  // 6. H1 (lead decision 2026-11-07, the 2026-10-14 owner rule wins):
  // the identity is Fuel only when Lunch Money left the row uncategorised.
  // An explicit Lunch Money category classifies exactly as it would at a
  // merchant with no identity rule.
  const neutral = extra => pittMeadowsCeTx(Object.assign({
    displayedPayee: 'Invented Neutral Merchant', originalMerchant: 'INVENTED NEUTRAL MERCHANT',
  }, extra));
  const shapeOf = cls => JSON.stringify({ kind: cls.kind, categoryId: cls.categoryId,
    needs: cls.needsConfirmation === true });
  for (const label of ['Sport & fitness', 'Shopping', 'Fuel', 'Groceries']) {
    const cls = F.classifyCurrentPeriodTransaction(
      pittMeadowsCeTx({ id: 'tx-pmce-' + String(label), categoryLabel: label }), plan);
    const base = F.classifyCurrentPeriodTransaction(
      neutral({ id: 'tx-neutral-' + String(label), categoryLabel: label }), plan);
    ok(cls.includeReason !== 'fuel-merchant' && shapeOf(cls) === shapeOf(base),
      'H1: the fuel identity labelled ' + JSON.stringify(label) + ' follows its Lunch Money category',
      shapeOf(cls) + ' vs ' + shapeOf(base));
  }
  // H1 repair (Atlas blocker 1): a bill label with no represented bill
  // would drop the identity row from the household deduction, so it is held
  // for confirmation instead (the label still decides it is not Fuel).
  for (const label of ['Bills', 'Subscriptions', 'Bill']) {
    const cls = F.classifyCurrentPeriodTransaction(
      pittMeadowsCeTx({ id: 'tx-pmce-' + String(label), categoryLabel: label }), plan);
    // With #922 the classifier core already holds an unmatched bill label
    // for confirmation (unmapped-label / bills-only-unmatched), so H1's
    // rewrite to lunchmoney-label-unbudgeted-merchant-row is not needed for
    // these labels. The protected outcome is the same: held, counted, not Fuel.
    ok(cls.needsConfirmation === true && cls.householdSpending === true && cls.kind !== 'bill'
        && ['lunchmoney-label-unbudgeted-merchant-row', 'unmapped-label', 'bills-only-unmatched'].includes(cls.reason)
        && cls.categoryId !== 'fuel',
      'H1: the fuel identity labelled ' + JSON.stringify(label) + ' is held for confirmation, not dropped', shapeOf(cls));
  }
  for (const label of [null, 'Uncategorised']) {
    const cls = F.classifyCurrentPeriodTransaction(
      pittMeadowsCeTx({ id: 'tx-pmce-' + String(label), categoryLabel: label }), plan);
    ok(isFuel(cls) && cls.includeReason === 'fuel-merchant',
      'H1: the fuel identity left ' + JSON.stringify(label) + ' by Lunch Money is Fuel', JSON.stringify(cls));
  }
  for (const payee of ['PITTMEADOWSCE', 'Pitt Meadows CE', 'PITT MEADOWS CE _V']) {
    const cls = F.classifyCurrentPeriodTransaction(
      pittMeadowsCeTx({ id: 'tx-pmce-' + payee, displayedPayee: payee, originalMerchant: payee }), plan);
    ok(isFuel(cls), 'normalized identity ' + JSON.stringify(payee) + ' is Fuel');
  }
  const otherAmount = F.classifyCurrentPeriodTransaction(
    pittMeadowsCeTx({ id: 'tx-pmce-other-amount', amount: 42.10, date: '2026-08-29' }), plan);
  ok(isFuel(otherAmount), 'PITT MEADOWS CE at another amount and date is still Fuel');

  // 9. The $100 screenshot-style fixture.
  const fixture = F.classifyCurrentPeriodTransaction(pittMeadowsCeTx(), plan);
  ok(near(PITT_MEADOWS_CE_AMT, 100) && isFuel(fixture),
    'the $100 PITT MEADOWS CE fixture is Fuel', JSON.stringify(fixture));

  // 10. Unrelated Pitt Meadows merchants do not inherit the rule.
  const arena = F.classifyCurrentPeriodTransaction(pittMeadowsArenaTx(), plan);
  ok(arena.categoryId !== 'fuel' && arena.includeReason !== 'fuel-merchant',
    'PITT MEADOWS AR does not inherit Fuel', JSON.stringify(arena));
  const arenaBills = F.classifyCurrentPeriodTransaction(
    pittMeadowsArenaTx({ id: 'tx-pmar-bills', categoryLabel: 'Bills' }), plan);
  ok(arenaBills.kind !== 'bill' && arenaBills.categoryId !== 'fuel'
      && arenaBills.includeReason !== 'fuel-merchant' && arenaBills.needsConfirmation === true,
    'PITT MEADOWS AR labelled Bills is not Fuel and, matching no planned bill, needs confirmation', JSON.stringify(arenaBills));
  const gasBarSubs = F.classifyCurrentPeriodTransaction(pittMeadowsCeTx({
    id: 'tx-pitt-meadows-gas-bar-subs', displayedPayee: 'Pitt Meadows Gas Bar',
    originalMerchant: 'PITT MEADOWS GAS BAR', categoryLabel: 'Subscriptions',
  }), plan);
  ok(gasBarSubs.kind !== 'bill' && gasBarSubs.categoryId !== 'fuel' && gasBarSubs.needsConfirmation === true,
    'an unrelated Pitt Meadows merchant labelled Subscriptions is not Fuel and, matching no planned bill, needs confirmation',
    JSON.stringify(gasBarSubs));
  const generic = F.classifyCurrentPeriodTransaction(pittMeadowsCeTx({
    id: 'tx-pitt-meadows-generic', displayedPayee: 'Pitt Meadows Gas Bar',
    originalMerchant: 'PITT MEADOWS GAS BAR', categoryLabel: null,
  }), plan);
  ok(generic.categoryId !== 'fuel' && generic.needsConfirmation === true,
    'a generic Pitt Meadows merchant without the exact identity still fails closed', JSON.stringify(generic));
  const centre = F.classifyCurrentPeriodTransaction(pittMeadowsCeTx({
    id: 'tx-pitt-meadows-centre', displayedPayee: 'Pitt Meadows Central',
    originalMerchant: 'PITT MEADOWS CENTRAL', categoryLabel: null,
  }), plan);
  ok(centre.categoryId !== 'fuel',
    'a longer Pitt Meadows name is not the truncated PITT MEADOWS CE key');

  // Incumbent Business exclusion still wins over the merchant identity.
  const business = F.classifyCurrentPeriodTransaction(
    pittMeadowsCeTx({ id: 'tx-pmce-business', categoryLabel: 'Business' }), plan);
  ok(business.kind === 'business' && business.householdSpending === false,
    'excluded Business PITT MEADOWS CE stays out of Household Budget');

  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(pittMeadowsCeTx());
  ok(flags.confirmedFuel === true && flags.cardPaymentIdentity !== true,
    'derived flags stamp confirmedFuel on PITT MEADOWS CE', JSON.stringify(flags));
  const arenaFlags = F.classifyCurrentPeriodTransaction.derivedFlags(pittMeadowsArenaTx());
  ok(arenaFlags.confirmedFuel !== true, 'derived flags do not stamp confirmedFuel on PITT MEADOWS AR');
  const stripped = F.classifyCurrentPeriodTransaction({
    id: 'tx-pmce-stripped', date: '2026-08-31', amount: PITT_MEADOWS_CE_AMT,
    categoryLabel: null, accountRole: 'household-cash', confirmedFuel: true,
  }, plan);
  ok(isFuel(stripped), 'an uncategorised stripped tx carrying only confirmedFuel is still Fuel');
  const strippedLabelled = F.classifyCurrentPeriodTransaction({
    id: 'tx-pmce-stripped-labelled', date: '2026-08-31', amount: 100,
    categoryLabel: 'Sport & fitness', accountRole: 'household-cash', confirmedFuel: true,
  }, plan);
  ok(!isFuel(strippedLabelled), 'H1: the confirmedFuel flag does not override an explicit Lunch Money category');

  // 7 / 8. Fuel Spent includes it; Other does not.
  ok(near(PITT_MEADOWS_CE_AMT + PITT_MEADOWS_ARENA_AMT + OTHER_AMT + WALMART_AMT, 178.67)
      && near(PITT_MEADOWS_ARENA_AMT + OTHER_AMT, 37.50),
    'independent fixture arithmetic: Household Budget $178.67; Fuel $100.00; Other $37.50');
  const advice = recommend(actualsPacket([
    pittMeadowsCeTx(),
    pittMeadowsArenaTx(),
    walmartTx(),
    otherTx(),
  ]));
  const active = period(advice.defaultView, 'this-pay-period');
  const fuel = budgetRow(active, 'fuel');
  const other = otherRow(active);
  ok(fuel && near(fuel.spent, PITT_MEADOWS_CE_AMT) && near(reconSum(fuel), PITT_MEADOWS_CE_AMT)
      && (fuel.recon || []).some(r => r && r.id === 'tx-pitt-meadows-ce'),
    'PITT MEADOWS CE enters Fuel Spent; Fuel spent equals its recon', JSON.stringify(fuel && fuel.spent));
  ok(fuel && near(fuel.remaining, 325 - PITT_MEADOWS_CE_AMT),
    'Fuel remaining is the $325 payday target less the $100');
  ok(other && !(other.recon || []).some(r => r && r.id === 'tx-pitt-meadows-ce')
      && near(other.spent, 37.50),
    'PITT MEADOWS CE is absent from Other; Other is the arena plus the Gifts residual',
    JSON.stringify(other && other.recon.map(r => r.id)));
  ok(other && (other.recon || []).some(r => r && r.id === 'tx-pitt-meadows-arena'),
    'PITT MEADOWS AR stays on Other / confirmation in this plan');
  ok(near(householdSpent(active), 178.67), 'Household Budget Spent totals the independent arithmetic');

  // H1: a Bills label from Lunch Money now wins over the fuel identity.
  ok(near(PITT_MEADOWS_CE_AMT, 100),
    'independent fixture arithmetic: the Bills-labelled fuel identity is $100, Fuel stays at $325 remaining');
  const billAdvice = recommend(actualsPacket([
    pittMeadowsCeTx({ id: 'tx-pmce-bills-packet', categoryLabel: 'Bills' }),
    pittMeadowsArenaTx({ id: 'tx-pmar-subs-packet', categoryLabel: 'Subscriptions' }),
  ]));
  const billActive = period(billAdvice.defaultView, 'this-pay-period');
  const billFuel = budgetRow(billActive, 'fuel');
  const billOther = otherRow(billActive);
  ok(billFuel && near(billFuel.spent, 0)
      && !(billFuel.recon || []).some(r => r && r.id === 'tx-pmce-bills-packet'),
    'H1: the Bills-labelled fuel identity is a bill, not Fuel Spent');
  ok(billFuel && near(billFuel.remaining, 325),
    'H1: Fuel remaining is the full $325 payday target');
  // H1 repair keeps the Bills-labelled fuel identity deducted in Other.
  // Budget audit (#922): the Subscriptions-labelled non-identity row
  // matches no planned bill, so it is not silently a bill either; it also
  // stays on Other (needs confirmation).
  ok(billOther && (billOther.recon || []).some(r => r && r.id === 'tx-pmce-bills-packet')
      && (billOther.recon || []).some(r => r && r.id === 'tx-pmar-subs-packet'),
    'H1 repair + #922: the Bills-labelled fuel identity and the unmatched Subscriptions-labelled row both stay deducted in Other / confirmation');
}

console.log('\n=== 14. historical authority agrees; preserved rules; one bucket per transaction; sanitized overlay ===');
{
  const plan = syntheticPlan();

  // 11. Historical merchant classification no longer says PITTMEADOWSCE = Sport & fitness.
  const chequingSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/categorise-chequing.js'), 'utf8'));
  ok(/\['PITTMEADOWSCE',\s*'Fuel & transport',\s*'essential'\]/.test(chequingSrc)
      && !/\['PITTMEADOWSCE',\s*'Sport & fitness'/.test(chequingSrc),
    'categorise-chequing.js carries PITTMEADOWSCE as Fuel & transport, not Sport & fitness');
  ok(/\['PITTMEADOWSAR',\s*'Sport & fitness',\s*'discretionary'\]/.test(chequingSrc),
    'categorise-chequing.js keeps PITTMEADOWSAR as Sport & fitness (no Pitt Meadows broadening)');
  ok(/const DEBT\s*=\s*\/[^\n]*CAN TIRE MC/.test(chequingSrc),
    'categorise-chequing.js DEBT pattern still treats CAN TIRE MC as debt servicing (the incumbent invariant)');
  const periodsSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/periods.js'), 'utf8'));
  ok(/const DEBT\s*=\s*\/[^\n]*CAN TIRE MC/.test(periodsSrc),
    'periods.js DEBT pattern still excludes CAN TIRE MC from historical spending');
  const libraryRows = sourceText(fs.readFileSync(path.join(__dirname, '..', 'docs/merchant-library.csv'), 'utf8'))
    .split('\n').filter(Boolean).slice(1).map(line => line.split(','));
  const pmce = libraryRows.filter(cols => cols[0] === 'PITTMEADOWSCE');
  ok(pmce.length === 1 && pmce[0][1] === 'Fuel & transport' && pmce[0][2] === 'essential',
    'merchant-library.csv has exactly one PITTMEADOWSCE row and it is Fuel & transport / essential',
    JSON.stringify(pmce));
  const pmar = libraryRows.filter(cols => cols[0] === 'PITTMEADOWSAR');
  ok(pmar.length === 1 && pmar[0][1] === 'Sport & fitness',
    'merchant-library.csv keeps PITTMEADOWSAR as Sport & fitness');
  ok(!libraryRows.some(cols => /^PITTMEADOWS/.test(cols[0]) && cols[1] === 'Fuel & transport' && cols[0] !== 'PITTMEADOWSCE'),
    'no other Pitt Meadows library pattern became Fuel');
  const archSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'ARCHITECTURE.md'), 'utf8'));
  ok(/CAN TIRE MC[^\n]*Canadian Tire Mastercard payment/.test(archSrc)
      && /PITT MEADOWS CE[^|]*is Fuel/.test(archSrc)
      && !/Iron Butcher is not confirmed Groceries/.test(archSrc),
    'ARCHITECTURE.md Plan-surface row states both standing identities and no longer contradicts the Iron Butcher rule');
  const dataDoc = load('data.json');
  const fuelCat = dataDoc.plan.budget.categories.find(c => c.id === 'fuel');
  ok(fuelCat && /PITT MEADOWS CE/.test(fuelCat.why || '') && /2026-09-02/.test(fuelCat.why || ''),
    'data.json fuel owner target records the Dale 2026-09-02 PITT MEADOWS CE rule');

  // 12–15. Preserved standing rules and fail-closed unresolved merchants.
  const iron = F.classifyCurrentPeriodTransaction(ironButcherTx(), plan);
  ok(iron.kind === 'spend' && iron.categoryId === 'groceries' && iron.needsConfirmation !== true,
    'Iron Butcher is still Groceries');
  const cursor = F.classifyCurrentPeriodTransaction(cursorTx(), plan);
  ok(cursor.kind === 'spend' && cursor.categoryId === 'dale-guilt-free',
    'Cursor is still Dale guilt-free');
  const surrey = F.classifyCurrentPeriodTransaction(surreyMeatTx(), plan);
  ok(surrey.kind === 'spend' && surrey.categoryId === 'pets' && surrey.includeReason === 'dog-food-merchant',
    'Surrey Meat is still Dog food, never Groceries');
  const meridian = F.classifyCurrentPeriodTransaction(meridianTx(), plan);
  ok(meridian.kind === 'spend' && meridian.categoryId === 'groceries', 'Meridian Farm is still Groceries');
  const unresolved = F.classifyCurrentPeriodTransaction(otherTx(), plan);
  ok(unresolved.needsConfirmation === true && unresolved.kind === 'unclassified',
    'an unresolved merchant still fails closed to confirmation / Other');
  const noMerchantFuel = F.classifyCurrentPeriodTransaction({
    id: 'tx-fuel-no-merchant', date: '2026-08-31', amount: 40, categoryLabel: 'Fuel',
    accountRole: 'household-cash',
  }, plan);
  ok(noMerchantFuel.kind === 'spend' && noMerchantFuel.categoryId === 'fuel',
    'a Fuel-labelled tx classifies as Fuel by its category even with no merchant identity (Dale 2026-10-14: the exact category is the evidence; supersedes the fuel-merchant-missing hold)');

  // 16. One transaction cannot sit in its correct bucket and Other at once.
  const packet = actualsPacket([
    canTireMcTx(),
    canadianTireRetailTx(),
    pittMeadowsCeTx(),
    pittMeadowsArenaTx(),
    ironButcherTx(),
    cursorTx(),
    surreyMeatTx(),
    meridianTx(),
    otherTx(),
  ]);
  const expectedSpent = roundCent(
    CANADIAN_TIRE_RETAIL_AMT + PITT_MEADOWS_CE_AMT + PITT_MEADOWS_ARENA_AMT
    + IRON_BUTCHER_AMT + CURSOR_AMT + SURREY_MEAT_AMT + MERIDIAN_AMT + OTHER_AMT);
  // 78.38 + 100.00 + 30.00 + 18.40 + 20.00 + 45.00 + 19.44 + 7.50 = 318.72
  ok(near(expectedSpent, 318.72),
    'independent fixture arithmetic: eligible Household Budget total $318.72 excludes the $271');
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const rows = allReconRows(active);
  const seen = new Map();
  for (const { rowId, tx } of rows) {
    if (!tx || !tx.id) continue;
    seen.set(tx.id, (seen.get(tx.id) || []).concat(rowId));
  }
  const dup = [...seen.entries()].filter(([, ids]) => ids.length > 1);
  ok(dup.length === 0, 'no transaction id appears in more than one Household Budget row', JSON.stringify(dup));
  const bucketOf = id => (seen.get(id) || [])[0] || null;
  ok(bucketOf('tx-can-tire-mc') == null, 'CAN TIRE MC is in no row at all');
  ok(bucketOf('tx-pitt-meadows-ce') === 'fuel', 'PITT MEADOWS CE is in Fuel only');
  ok(bucketOf('tx-iron-butcher') === 'groceries', 'Iron Butcher is in Groceries only');
  ok(bucketOf('tx-meridian') === 'groceries', 'Meridian Farm is in Groceries only');
  ok(bucketOf('tx-cursor') === 'dale-guilt-free', 'Cursor is in Dale guilt-free only');
  ok(bucketOf('tx-surrey-meat') === 'pets', 'Surrey Meat is in Dog food only');
  ok(bucketOf('tx-canadian-tire-retail') === 'other-spending', 'Canadian Tire retail is Other only');
  ok(bucketOf('tx-pitt-meadows-arena') === 'other-spending', 'PITT MEADOWS AR is Other only');
  ok(bucketOf('tx-other') === 'other-spending', 'the Gifts residual is Other only');
  const other = otherRow(active);
  ok(other && near(other.spent, roundCent(CANADIAN_TIRE_RETAIL_AMT + PITT_MEADOWS_ARENA_AMT + OTHER_AMT)),
    'Other spending is exactly the three fail-closed rows', String(other && other.spent));
  ok(near(householdSpent(active), expectedSpent),
    'Household Budget Spent equals the independent eligible total', String(householdSpent(active)));

  // End-to-end: the rules survive the sanitized live-overlay path.
  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
      { providerAccountId: '3006', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
    ],
  };
  const overlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    tags: [{ id: 77, name: 'Amanda' }],
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: CAN_TIRE_MC_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Pets',
        payee: 'CAN TIRE MC', originalName: 'CAN TIRE MC', notes: 'Canadian Tire Mastercard payment',
        providerAccountId: '1001', providerTransactionId: 'ctmc-1',
      },
      {
        date: '2026-08-31', amount: CANADIAN_TIRE_RETAIL_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Household',
        payee: 'Canadian Tire', originalName: 'CANADIAN TIRE #322',
        providerAccountId: '1001', providerTransactionId: 'ct-retail-1',
      },
      {
        date: '2026-08-31', amount: PITT_MEADOWS_CE_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: null,
        payee: 'PITT MEADOWS CE', originalName: 'PITT MEADOWS CE',
        providerAccountId: '1001', providerTransactionId: 'pmce-1',
      },
      {
        date: '2026-08-31', amount: PITT_MEADOWS_ARENA_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Sport & fitness',
        payee: 'PITT MEADOWS AR', originalName: 'PITT MEADOWS AR',
        providerAccountId: '1001', providerTransactionId: 'pmar-1',
      },
      {
        date: '2026-08-31', amount: IRON_BUTCHER_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Groceries',
        payee: 'Iron Butcher', originalName: 'Iron Butcher',
        providerAccountId: '1001', providerTransactionId: 'iron-1',
      },
      {
        date: '2026-08-31', amount: CURSOR_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Shopping',
        payee: 'Cursor', originalName: 'Cursor', tags: [{ name: 'Amanda' }],
        providerAccountId: '3006', providerTransactionId: 'cursor-1',
      },
      {
        date: '2026-08-31', amount: SURREY_MEAT_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: null,
        payee: 'Surrey Meat', originalName: 'SURREY MEAT MARKET',
        providerAccountId: '1001', providerTransactionId: 'surrey-1',
      },
      {
        date: '2026-08-31', amount: MERIDIAN_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Groceries',
        payee: 'Meridian Farm', originalName: 'Meridian Farm',
        providerAccountId: '1001', providerTransactionId: 'meridian-1',
      },
      {
        date: '2026-08-31', amount: OTHER_AMT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Gifts',
        payee: 'Gift Shop', originalName: 'Gift Shop',
        providerAccountId: '1001', providerTransactionId: 'gift-1',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap: map });
  const overlayBlob = JSON.stringify(overlay);
  ok(O.currentPeriodActualsLooksSanitized(overlay)
      && !/"payee"\s*:/.test(overlayBlob) && !/"notes"\s*:/.test(overlayBlob)
      && !/"tags"\s*:/.test(overlayBlob) && !/providerTransactionId/.test(overlayBlob),
    'identity overlay packet keeps no raw payee, notes, tags, or provider ids');
  ok(!/CAN TIRE MC/.test(overlayBlob),
    'the card-payment payee text does not travel on the served packet; only the derived flag does');
  const byAmt = amt => (overlay.transactions || []).find(tx => tx && near(tx.amount, amt));
  const ctmcPub = byAmt(CAN_TIRE_MC_AMT);
  ok(ctmcPub && ctmcPub.cardPaymentIdentity === true && ctmcPub.canadianTire !== true
      && !Object.prototype.hasOwnProperty.call(ctmcPub, 'displayedPayee')
      && !Object.prototype.hasOwnProperty.call(ctmcPub, 'originalMerchant'),
    'overlay stamps cardPaymentIdentity on CAN TIRE MC before strip and drops its merchant text',
    JSON.stringify(ctmcPub));
  const ctmcPubCls = F.classifyCurrentPeriodTransaction(ctmcPub, plan);
  ok(ctmcPubCls.kind === 'card-payment' && ctmcPubCls.householdSpending === false,
    'stripped CAN TIRE MC packet still classifies card-payment');
  const retailPub = byAmt(CANADIAN_TIRE_RETAIL_AMT);
  ok(retailPub && retailPub.cardPaymentIdentity !== true && retailPub.canadianTire === true,
    'overlay does not stamp cardPaymentIdentity on Canadian Tire retail');
  const pmcePub = byAmt(PITT_MEADOWS_CE_AMT);
  ok(pmcePub && pmcePub.confirmedFuel === true,
    'overlay stamps confirmedFuel on PITT MEADOWS CE before strip', JSON.stringify(pmcePub));
  const pmcePubCls = F.classifyCurrentPeriodTransaction(pmcePub, plan);
  ok(pmcePubCls.kind === 'spend' && pmcePubCls.categoryId === 'fuel',
    'stripped PITT MEADOWS CE packet still classifies Fuel');
  const pmarPub = byAmt(PITT_MEADOWS_ARENA_AMT);
  ok(pmarPub && pmarPub.confirmedFuel !== true, 'overlay does not stamp confirmedFuel on PITT MEADOWS AR');
  const withoutFlags = Object.assign({}, ctmcPub, { cardPaymentIdentity: false });
  ok(F.classifyCurrentPeriodTransaction(withoutFlags, plan).kind !== 'card-payment',
    'control: without the derived flag the stripped CAN TIRE MC row would not be recognised, so the flag is load-bearing');

  const overlayAdvice = recommend(overlay);
  const overlayActive = period(overlayAdvice.defaultView, 'this-pay-period');
  const overlayFuel = budgetRow(overlayActive, 'fuel');
  const overlayOther = otherRow(overlayActive);
  const overlayGroceries = budgetRow(overlayActive, 'groceries');
  const overlayDale = budgetRow(overlayActive, 'dale-guilt-free');
  const overlayPets = budgetRow(overlayActive, 'pets');
  ok(overlayActive && near(householdSpent(overlayActive), expectedSpent),
    'served overlay Household Budget Spent equals the independent eligible total (no $271)',
    String(householdSpent(overlayActive)));
  ok(overlayFuel && near(overlayFuel.spent, PITT_MEADOWS_CE_AMT),
    'served overlay Fuel Spent is the $100 PITT MEADOWS CE');
  ok(overlayOther && near(overlayOther.spent, roundCent(CANADIAN_TIRE_RETAIL_AMT + PITT_MEADOWS_ARENA_AMT + OTHER_AMT)),
    'served overlay Other is Canadian Tire retail + PITT MEADOWS AR + Gifts only',
    String(overlayOther && overlayOther.spent));
  ok(overlayGroceries && near(overlayGroceries.spent, roundCent(IRON_BUTCHER_AMT + MERIDIAN_AMT))
      && overlayDale && near(overlayDale.spent, CURSOR_AMT)
      && overlayPets && near(overlayPets.spent, SURREY_MEAT_AMT),
    'served overlay keeps Iron Butcher Groceries, Cursor Dale, Surrey Meat Dog food');
  const overlayIds = allReconRows(overlayActive).map(r => r.tx && r.tx.id);
  ok(overlayIds.length === new Set(overlayIds).size,
    'served overlay: each transaction appears in at most one Household Budget row');
}

console.log('\n=== 15. CAN TIRE MC card-payment identity reaches unmatched-household-cash reconciliation ===');
{
  const plan = syntheticPlan();
  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    ],
  };
  const unresolvedAmt = 12.34;
  const observeSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/provider-observe.js'), 'utf8'));
  ok(/function unmatchedHouseholdCash[\s\S]*cardPaymentIdentity/.test(observeSrc),
    'unmatchedHouseholdCash carries Forecast cardPaymentIdentity into classify');
  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(canTireMcTx());
  const viaFlag = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: CAN_TIRE_MC_AMT, pending: false,
    categoryLabel: 'Pets', accountRole: 'household-cash',
    cardPaymentIdentity: flags.cardPaymentIdentity,
  }, plan);
  ok(flags.cardPaymentIdentity === true && viaFlag.kind === 'card-payment'
      && viaFlag.householdSpending === false,
    'independent Forecast authority: derived cardPaymentIdentity classifies the $271 fixture as card-payment');
  const unresolvedCls = F.classifyCurrentPeriodTransaction({
    date: '2026-08-31', amount: unresolvedAmt, pending: false,
    categoryLabel: 'Gifts', accountRole: 'household-cash',
    displayedPayee: 'Unknown Shop', originalMerchant: 'Unknown Shop',
  }, plan);
  ok(unresolvedCls.kind !== 'card-payment' && unresolvedCls.kind !== 'transfer'
      && unresolvedCls.kind !== 'business' && unresolvedCls.kind !== 'income',
    'independent Forecast authority: the unresolved household-cash debit is not a skipped kind',
    JSON.stringify(unresolvedCls));

  const receipt = O.reconciliationReceipt({
    fetchedAt: '2026-09-02T18:13:00.000Z',
    observationReceipt: {
      readyForReconciliation: true,
      fingerprintDigest: 'test-can-tire-mc-unmatched',
      observedAt: '2026-09-02T18:13:00.000Z',
      householdDate: '2026-09-02',
    },
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-02', complete: true },
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: CAN_TIRE_MC_AMT, pending: false, categoryLabel: 'Pets',
        payee: 'CAN TIRE MC', originalName: 'CAN TIRE MC',
        providerAccountId: '1001', providerTransactionId: 'ctmc-unmatched-1',
      },
      {
        date: '2026-08-31', amount: unresolvedAmt, pending: false, categoryLabel: 'Gifts',
        payee: 'Unknown Shop', originalName: 'Unknown Shop',
        providerAccountId: '1001', providerTransactionId: 'unresolved-cash-1',
      },
    ],
  }, { data: { plan }, accountMap: map, identityRules: [] });
  const unmatched = receipt.unmatchedCashEvidence || [];
  ok(!unmatched.some(row => near(row.amount, CAN_TIRE_MC_AMT)),
    'the $271 CAN TIRE MC fixture is not unmatched household cash',
    JSON.stringify(unmatched));
  ok(unmatched.some(row => near(row.amount, unresolvedAmt) && row.accountRole === 'household-cash'),
    'an actually unresolved household-cash debit is still unmatched cash evidence',
    JSON.stringify(unmatched));
  ok(receipt.counts && receipt.counts.unmatchedCashEvidence === unmatched.length
      && unmatched.length === 1,
    'receipt unmatched count is exactly the one unresolved debit');
}

function cashbackPurchaseInterestTx(extra) {
  return Object.assign({
    id: 'tx-cashback-purchase-interest',
    date: '2026-09-08',
    amount: CASHBACK_PURCHASE_INTEREST_AMT,
    pending: false,
    categoryLabel: 'Interest charge',
    accountRole: 'revolving-credit',
    atlasAccountId: 'cashback',
    account: 'cashback',
    displayedPayee: 'INTEREST CHARGE -PURCHASE',
    originalMerchant: 'INTEREST CHARGE -PURCHASE',
  }, extra || {});
}

console.log('\n=== 16. Issuer revolving finance charges are debt/interest cost once (Dale 2026-09-09) ===');
{
  const INTEREST_AS_OF = '2026-09-08';
  const CHEQUING_A = 8000;
  const CHEQUING_B = 200;
  const INDEPENDENT_CB = roundCent(CHEQUING_A + CHEQUING_B);
  const INDEPENDENT_HUB = CHEQUING_A;
  const CASHBACK_BAL = 4800;
  const CASHBACK_LIMIT = 5000;
  const CASHBACK_ANNUAL_INTEREST = 1200;
  const plan = syntheticPlan();
  plan.startingCash.breakdown = [
    { id: 'chequing-a', label: 'BILLS ACCOUNT', value: CHEQUING_A },
    { id: 'chequing-b', label: 'WEEKLY SPENDING', value: CHEQUING_B },
    { id: 'savings', label: 'EMERGENCY SAVING', value: 40.58 },
  ];
  const cashbackDebt = {
    id: 'cashback', label: 'TD Cash Back Visa', secured: false,
    structure: 'Revolving', balance: CASHBACK_BAL, limit: CASHBACK_LIMIT,
    rate: 26.99, payment: 170, pending: 0, annualInterest: CASHBACK_ANNUAL_INTEREST,
  };
  const caseDebts = debts.concat([cashbackDebt]);
  const purchase = walmartTx({
    id: 'tx-cashback-grocery', date: '2026-09-08',
    accountRole: 'revolving-credit', atlasAccountId: 'cashback', account: 'cashback',
    categoryLabel: 'Groceries',
  });
  const cardPay = {
    id: 'tx-cashback-payment', date: '2026-09-08', amount: 170,
    pending: false, categoryLabel: 'Credit Card Payment',
    accountRole: 'household-cash', atlasAccountId: 'chequing-a',
    displayedPayee: 'PAYMENT-THANKYOU', originalMerchant: 'PAYMENT-THANKYOU',
    excludeFromTotals: true, kindHint: 'card-payment',
  };
  const merchantInterestName = {
    id: 'tx-interest-free-furniture', date: '2026-09-08', amount: 22.50,
    pending: false, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit', atlasAccountId: 'tdcc', account: 'tdcc',
    displayedPayee: 'Interest Free Furniture', originalMerchant: 'Interest Free Furniture',
  };
  const cashAdvanceInterest = {
    id: 'tx-tdcc-cash-interest', date: '2026-09-08', amount: 18.20,
    pending: false, categoryLabel: 'Interest charge',
    accountRole: 'revolving-credit', atlasAccountId: 'tdcc', account: 'tdcc',
    displayedPayee: 'INTEREST CHARGE -CASH ADVANCE',
    originalMerchant: 'INTEREST CHARGE -CASH ADVANCE',
  };
  const btInterest = {
    id: 'tx-mbna-bt-interest', date: '2026-09-08', amount: 9.11,
    pending: false, categoryLabel: 'BT interest',
    accountRole: 'revolving-credit', atlasAccountId: 'mbna', account: 'mbna',
    displayedPayee: 'BT INTEREST', originalMerchant: 'BT INTEREST',
  };
  const annualFee = {
    id: 'tx-tdcc-annual-fee', date: '2026-09-08', amount: 25,
    pending: false, categoryLabel: 'Fees',
    accountRole: 'revolving-credit', atlasAccountId: 'tdcc', account: 'tdcc',
    displayedPayee: 'ANNUAL FEE', originalMerchant: 'ANNUAL FEE',
  };
  const interest = cashbackPurchaseInterestTx();
  const cls = F.classifyCurrentPeriodTransaction(interest, plan);
  const flags = F.classifyCurrentPeriodTransaction.derivedFlags(interest);
  const viaFlag = F.classifyCurrentPeriodTransaction({
    date: '2026-09-08', amount: CASHBACK_PURCHASE_INTEREST_AMT,
    pending: false, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit', atlasAccountId: 'cashback',
    cardFinanceChargeIdentity: true,
  }, plan);
  ok(cls.kind === 'interest' && cls.householdSpending === false
      && cls.reason === 'revolving-finance-charge'
      && !F.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible(cls),
    'Sep 8 cashback purchase interest classifies as interest and is not Household Budget eligible',
    JSON.stringify(cls));
  ok(flags.cardFinanceChargeIdentity === true && viaFlag.kind === 'interest'
      && viaFlag.householdSpending === false,
    'derived cardFinanceChargeIdentity reclassifies after merchant strip');
  ok(F.classifyCurrentPeriodTransaction(cashAdvanceInterest, plan).kind === 'interest'
      && F.classifyCurrentPeriodTransaction(btInterest, plan).kind === 'interest',
    'cash-advance and BT issuer interest on revolving cards are the same finance-charge path');
  ok(F.classifyCurrentPeriodTransaction(purchase, plan).kind === 'spend'
      && F.classifyCurrentPeriodTransaction(purchase, plan).categoryId === 'groceries'
      && F.classifyCurrentPeriodTransaction(purchase, plan).householdSpending === true,
    'a real cashback grocery purchase is still Groceries spend');
  ok(F.classifyCurrentPeriodTransaction(cardPay, plan).kind === 'card-payment'
      && F.classifyCurrentPeriodTransaction(cardPay, plan).householdSpending === false,
    'card payments remain card-payment');
  const furnitureCls = F.classifyCurrentPeriodTransaction(merchantInterestName, plan);
  ok(furnitureCls.kind !== 'interest' && furnitureCls.householdSpending === true,
    'a merchant whose name contains Interest is not a finance charge',
    JSON.stringify(furnitureCls));
  const feeCls = F.classifyCurrentPeriodTransaction(annualFee, plan);
  ok(feeCls.kind !== 'interest',
    'annual card fee is not folded into this finance-charge path',
    JSON.stringify(feeCls));

  const packet = actualsPacket([
    interest, cashAdvanceInterest, btInterest, purchase, cardPay,
    merchantInterestName, otherTx(),
  ], {
    observationAsOf: INTEREST_AS_OF,
    coverageThrough: INTEREST_AS_OF,
  });
  const advice = F.recommend(plan, INTEREST_AS_OF, {
    targetBuffer: 500,
    debts: caseDebts,
    currentPeriodActuals: packet,
  });
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const other = otherRow(active);
  const ids = reconIds(active);
  const independentHousehold = roundCent(WALMART_AMT + OTHER_AMT + 22.50);
  const leaked = roundCent(independentHousehold + CASHBACK_PURCHASE_INTEREST_AMT + 18.20 + 9.11);
  ok(groceries && near(groceries.spent, WALMART_AMT)
      && (groceries.recon || []).some(row => row && row.id === 'tx-cashback-grocery'),
    'cashback grocery still enters Groceries recon once');
  ok(!ids.includes('tx-cashback-purchase-interest')
      && !ids.includes('tx-tdcc-cash-interest')
      && !ids.includes('tx-mbna-bt-interest')
      && !ids.includes('tx-cashback-payment'),
    'issuer interest and the card payment appear in no Household Budget recon row');
  ok(other && (other.recon || []).some(row => row && row.id === 'tx-other')
      && (other.recon || []).some(row => row && row.id === 'tx-interest-free-furniture')
      && !(other.recon || []).some(row => row && row.id === 'tx-cashback-purchase-interest'),
    'Other keeps the residual gift and Interest Free Furniture; Sep 8 interest is not Other');
  ok(other && near(other.spent, roundCent(OTHER_AMT + 22.50))
      && near(other.hold, other.spent),
    'Other Spending actual/hold is gift + Interest Free Furniture only');
  ok(near(householdSpent(active), independentHousehold)
      && !near(householdSpent(active), leaked),
    'Household Budget Spent is grocery + gift + furniture only; finance charges do not leak',
    String(householdSpent(active)));
  ok(ids.filter(id => id === 'tx-cashback-grocery').length === 1
      && ids.filter(id => id === 'tx-cashback-purchase-interest').length === 0,
    'no double-count: grocery once, interest in no budget row');

  const action = F.currentPeriodAction(plan, INTEREST_AS_OF, {
    debts: caseDebts,
    currentPeriodActuals: packet,
  });
  const independentInterest = roundCent(CASHBACK_PURCHASE_INTEREST_AMT + 18.20 + 9.11);
  ok(near(action.excluded.interest, independentInterest)
      && !(action.unclassified && action.unclassified.posted > 0
        && near(action.unclassified.posted, CASHBACK_PURCHASE_INTEREST_AMT)),
    'currentPeriodAction excludes finance charges as interest, not unclassified Other',
    JSON.stringify(action.excluded));

  const cbBefore = F.postedHouseholdChequingCash(plan);
  const liveCb = advice.paydayAllocation && advice.paydayAllocation.liveCurrentBalance;
  const viewCb = advice.defaultView && advice.defaultView.liveCurrentBalance;
  ok(near(cbBefore, INDEPENDENT_CB) && near(liveCb, INDEPENDENT_HUB) && near(viewCb, INDEPENDENT_HUB),
    'Current Balance is hub only and unchanged by the interest post',
    String(liveCb));

  const util = F.utilisation(caseDebts);
  const cashbackUtil = (util.rows || []).find(r => r && r.id === 'cashback');
  const independentUsed = CASHBACK_BAL;
  ok(cashbackUtil && near(cashbackUtil.used, independentUsed)
      && near(cashbackUtil.used, cashbackDebt.balance + (cashbackDebt.pending || 0)),
    'card debt / utilisation still uses the posted cashback opening; interest tx is not a second walk',
    JSON.stringify(cashbackUtil));
  // The other invented debts carry no interest figure; that is Unknown, not
  // $0, so they are given an explicit known $0 here. Only the cashback
  // annual twelfth is under test.
  const interestDebts = caseDebts.map(d => d.annualInterest == null ? Object.assign({}, d, { annualInterest: 0 }) : d);
  const snap = F.compactSnapshot(interestDebts, []);
  const independentAnnual = interestDebts.reduce((s, d) => s + Number(d.annualInterest), 0);
  ok(independentAnnual === CASHBACK_ANNUAL_INTEREST && CASHBACK_ANNUAL_INTEREST / 12 === 100,
    'independent interest twelfth: $1,200 / 12 = $100');
  ok(snap && snap.monthlyInterest === 100,
    'interest reporting path still includes the cashback annual twelfth',
    JSON.stringify({ monthlyInterest: snap.monthlyInterest }));
}

console.log('\n=== 16b. Exact plural issuer INTEREST CHARGES keeps the revolving-account gate ===');
{
  // Invented cents only. No category or kindHint supplies the identity.
  const plan = syntheticPlan();
  const plural = cashbackPurchaseInterestTx({
    id: 'tx-plural-interest', amount: 17,
    categoryLabel: null, kindHint: null,
    displayedPayee: 'INTEREST CHARGES', originalMerchant: 'INTEREST CHARGES',
  });
  for (const account of ['cashback', 'tdcc', 'mbna', 'travelvisa', 'triangle']) {
    const tx = { ...plural, accountRole: null, atlasAccountId: account, account };
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    ok(cls.kind === 'interest' && cls.householdSpending === false
        && F.classifyCurrentPeriodTransaction.derivedFlags(tx).cardFinanceChargeIdentity === true,
      `exact plural without category/hint is finance cost on canonical ${account}`);
  }
  const normalized = {
    ...plural, account: null, atlasAccountId: null,
    originalMerchant: null, displayedPayee: '  interest   charges  ',
  };
  ok(F.classifyCurrentPeriodTransaction(normalized, plan).kind === 'interest',
    'revolving-credit role and normalized displayed-payee fallback recognize exact plural');
  for (const account of ['chequing-a', 'heloc', 'mortgage', 'unknown-account', null]) {
    const tx = { ...plural, accountRole: null, atlasAccountId: account, account };
    ok(F.classifyCurrentPeriodTransaction(tx, plan).kind !== 'interest'
        && F.classifyCurrentPeriodTransaction.derivedFlags(tx).cardFinanceChargeIdentity === false,
      `exact plural does not create revolving identity for ${account || 'missing account'}`);
  }
  for (const merchant of ['INTEREST CHARGES BOOKSHOP', 'LOCAL INTEREST CHARGES', 'Interest Free Furniture']) {
    const tx = { ...plural, displayedPayee: merchant, originalMerchant: merchant };
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    ok(cls.kind !== 'interest' && cls.householdSpending === true,
      `ordinary merchant stays household spending: ${merchant}`);
  }
  const annualFee = {
    ...plural, displayedPayee: 'ANNUAL FEE', originalMerchant: 'ANNUAL FEE', representedBill: true,
  };
  ok(F.classifyCurrentPeriodTransaction(annualFee, plan).kind === 'bill',
    'represented planned annual fee remains a bill');
  for (const merchant of ['OVERDRAFT INTEREST', 'OVERLIMIT FEE']) {
    const tx = {
      ...plural, accountRole: 'household-cash', atlasAccountId: 'chequing-a', account: 'chequing-a',
      categoryLabel: 'Household', displayedPayee: merchant, originalMerchant: merchant,
    };
    const cls = F.classifyCurrentPeriodTransaction(tx, plan);
    ok(cls.kind === 'spend' && cls.categoryId === 'household',
      `${merchant} remains Household`);
  }
  const purchase = walmartTx({ date: '2026-09-08' });
  const without = actualsPacket([purchase, otherTx()], {
    observationAsOf: '2026-09-08', coverageThrough: '2026-09-08',
  });
  const withPlural = { ...without, transactions: [...without.transactions, plural] };
  const advice = packet => F.recommend(plan, '2026-09-08', {
    debts, targetBuffer: 500, currentPeriodActuals: packet,
  });
  const before = advice(without);
  const after = advice(withPlural);
  const active = period(after.defaultView, 'this-pay-period');
  const action = F.currentPeriodAction(plan, '2026-09-08', { debts, currentPeriodActuals: withPlural });
  // Independent reconciliation: only $41.17 grocery + $7.50 gift = $48.67
  // is consumption; the invented $17 issuer charge is debt cost, not $65.67 spend.
  ok(near(householdSpent(active), 48.67) && near(otherRow(active).spent, 7.50)
      && !reconIds(active).includes(plural.id) && near(action.excluded.interest, 17),
    'plural issuer $17 is excluded once; published Household spent is $48.67 and Other is $7.50',
    JSON.stringify({ householdSpent: householdSpent(active), otherSpent: otherRow(active).spent,
      excludedInterest: action.excluded.interest }));
  ok(near(after.defaultView.liveCurrentBalance, 8000)
      && near(after.defaultView.liveCurrentBalance, before.defaultView.liveCurrentBalance)
      && near(active.afterHouseholdBudget, period(before.defaultView, 'this-pay-period').afterHouseholdBudget),
    'plural issuer charge neither replays posted cash nor consumes the Household waterfall');
}

console.log('\n=== 17. Overlay stamps revolving finance-charge identity before merchant strip ===');
{
  const plan = syntheticPlan();
  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      {
        providerAccountId: '3005',
        canonical: { collection: 'debts', id: 'cashback' },
        atlasRole: 'revolving-credit',
      },
      {
        providerAccountId: '1001',
        canonical: { collection: 'cash', id: 'chequing-a' },
        atlasRole: 'household-cash',
      },
    ],
  };
  const overlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-08T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-10', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-09-08', amount: CASHBACK_PURCHASE_INTEREST_AMT, pending: false,
        categoryLabel: 'Interest charge',
        payee: 'INTEREST CHARGE -PURCHASE', originalName: 'INTEREST CHARGE -PURCHASE',
        providerAccountId: '3005', providerTransactionId: 'cb-interest-1',
      },
      {
        date: '2026-09-08', amount: 17, pending: false,
        payee: 'INTEREST CHARGES', originalName: 'INTEREST CHARGES',
        providerAccountId: '3005', providerTransactionId: 'cb-plural-interest-1',
      },
      {
        date: '2026-09-08', amount: WALMART_AMT, pending: false,
        categoryLabel: 'Groceries',
        payee: 'Walmart', originalName: 'Walmart',
        providerAccountId: '3005', providerTransactionId: 'cb-walmart-1',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: '2026-09-08', plan, accountMap: map });
  const interestPub = (overlay.transactions || []).find(tx => tx && near(tx.amount, CASHBACK_PURCHASE_INTEREST_AMT));
  const groceryPub = (overlay.transactions || []).find(tx => tx && near(tx.amount, WALMART_AMT));
  const pluralPub = (overlay.transactions || []).find(tx => tx && near(tx.amount, 17));
  ok(pluralPub && pluralPub.cardFinanceChargeIdentity === true
      && !pluralPub.displayedPayee && !pluralPub.originalMerchant
      && F.classifyCurrentPeriodTransaction(pluralPub, plan).kind === 'interest',
    'uncategorized exact plural survives sanitization as finance-charge identity');
  ok(interestPub && interestPub.cardFinanceChargeIdentity === true
      && !interestPub.displayedPayee && !interestPub.originalMerchant,
    'overlay stamps cardFinanceChargeIdentity and strips issuer interest merchant text',
    JSON.stringify(interestPub && {
      cardFinanceChargeIdentity: interestPub.cardFinanceChargeIdentity,
      displayedPayee: interestPub.displayedPayee,
      categoryLabel: interestPub.categoryLabel,
      accountRole: interestPub.accountRole,
    }));
  ok(groceryPub && groceryPub.cardFinanceChargeIdentity !== true
      && groceryPub.displayedPayee,
    'overlay keeps merchant text on a real cashback grocery');
  const strippedCls = F.classifyCurrentPeriodTransaction(interestPub, plan);
  ok(strippedCls.kind === 'interest' && strippedCls.householdSpending === false,
    'sanitized overlay interest row still classifies as finance charge',
    JSON.stringify(strippedCls));
}

console.log('\n=== overlay stamps ATM deposit / TFR identity before merchant strip ===');
{
  const ATM_AMT = -350;
  const TFR_AMT = -350;
  const TFR_OUT = 350;
  const plan = syntheticPlan();
  const map = {
    schema: 'atlas-provider-account-map/v1',
    mappings: [
      {
        providerAccountId: '1001',
        canonical: { collection: 'cash', id: 'chequing-a' },
        atlasRole: 'household-cash',
      },
      {
        providerAccountId: '1002',
        canonical: { collection: 'cash', id: 'chequing-b' },
        atlasRole: 'household-cash',
      },
    ],
  };
  const overlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-08T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-10', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: '2026-09-08', amount: ATM_AMT, pending: false,
        categoryLabel: 'Payment, Transfer', excludeFromTotals: true,
        payee: 'TD ATM DEP 100001', originalName: 'TD ATM DEP 100001',
        providerAccountId: '1002', providerTransactionId: 'atm-dep-1',
      },
      {
        date: '2026-09-08', amount: TFR_OUT, pending: false,
        categoryLabel: 'Payment, Transfer', excludeFromTotals: true, kind: 'transfer',
        payee: 'SY001 TFR-TO BILLSA', originalName: 'SY001 TFR-TO BILLSA',
        providerAccountId: '1002', providerTransactionId: 'tfr-to-1',
      },
      {
        date: '2026-09-08', amount: TFR_AMT, pending: false,
        categoryLabel: 'Payment, Transfer', excludeFromTotals: true, kind: 'transfer',
        payee: 'SY001 TFR-FR CASHB', originalName: 'SY001 TFR-FR CASHB',
        providerAccountId: '1001', providerTransactionId: 'tfr-fr-1',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: '2026-09-08', plan, accountMap: map });
  const blob = JSON.stringify(overlay);
  ok(O.currentPeriodActualsLooksSanitized(overlay)
      && !/"payee"\s*:/.test(blob) && !/"originalName"\s*:/.test(blob),
    'ATM/TFR overlay packet keeps no raw payee');
  const atm = (overlay.transactions || []).find(tx => tx && tx.atlasAccountId === 'chequing-b'
    && near(tx.amount, ATM_AMT));
  const tfrFr = (overlay.transactions || []).find(tx => tx && tx.atlasAccountId === 'chequing-a'
    && near(tx.amount, TFR_AMT));
  const tfrTo = (overlay.transactions || []).find(tx => tx && tx.atlasAccountId === 'chequing-b'
    && near(tx.amount, TFR_OUT));
  ok(atm && atm.externalCashDeposit === true && atm.internalTransferIdentity !== true
      && !atm.displayedPayee && !atm.originalMerchant,
    'ATM DEP stamps externalCashDeposit and strips merchant text',
    JSON.stringify(atm && {
      externalCashDeposit: atm.externalCashDeposit,
      internalTransferIdentity: atm.internalTransferIdentity,
      displayedPayee: atm.displayedPayee,
      originalMerchant: atm.originalMerchant,
    }));
  ok(tfrFr && tfrFr.internalTransferIdentity === true && tfrFr.externalCashDeposit !== true
      && tfrTo && tfrTo.internalTransferIdentity === true,
    'TFR-TO/TFR-FR stamp internalTransferIdentity, not externalCashDeposit');
}

console.log('\n=== Native HELOC interest is liability cost; its Bills payment stays separate ===');
{
  const assert = require('node:assert/strict');
  const L = require('../scripts/live-plan');
  const x = require('./fixtures/card-backfill-data')('heloc');
  Object.assign(x.data.debts[0], { balance: 1000, secured: true });
  x.accountMap.mappings[3].atlasRole = 'heloc';
  x.data.plan.budget.categories = [{ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 0 }];
  x.data.plan.obligations = [{ id: 'heloc', debtId: 'heloc', label: 'Invented line interest',
    effect: 'capitalise', nonCash: true, frequency: 'monthly', day: 30, amount: 83,
    confidence: 'confirmed', payingAccount: 'chequing-a', cashPayment: 85,
    cashDay: 20, cashFirstDue: x.asOf, cashConfidence: 'confirmed' }];
  x.payload.accounts.forEach((a, i) => { a.balance = [409, -7, 0, 992][i]; });
  x.payload.transactions = [
    { id: 93001, account_id: 3004, amount: 83, payee: 'INTEREST' },
    { id: 93002, account_id: 3001, amount: 91, payee: 'IP470 TFR-TO INVENTED LINE', category_name: 'Payment, Transfer' },
    { id: 93003, account_id: 3004, amount: -91, payee: 'Invented payment receipt', category_name: 'Payment, Transfer' },
    { id: 93004, account_id: 3002, amount: 7, payee: 'Invented unrelated store', category_name: 'Shopping' },
  ].map(tx => ({ ...tx, date: x.asOf, currency: 'cad', is_pending: false }));
  const before = JSON.stringify(x);
  const r = L.fromObservation(x), packet = r.report.currentPeriodActuals;
  const action = F.currentPeriodAction(r.data.plan, x.asOf, { debts: r.data.debts, currentPeriodActuals: packet });
  const advice = F.recommend(r.data.plan, x.asOf, { debts: r.data.debts, currentPeriodActuals: packet });
  const active = period(advice.defaultView, 'this-pay-period');
  const interest = packet.transactions.find(tx => tx.amount === 83);
  const cls = F.classifyCurrentPeriodTransaction(interest, r.data.plan);
  ok(cls.kind === 'interest' && !cls.householdSpending && cls.reason === 'heloc-capitalised-interest'
      && !F.classifyCurrentPeriodTransaction.householdBudgetSupportingSpendEligible(cls),
    'native HELOC payee-only evidence survives sanitization and is not Other-eligible');
  ok(interest.helocFinanceChargeIdentity === true && interest.cardFinanceChargeIdentity === false
      && !interest.displayedPayee && !interest.originalMerchant && !interest.payee && !interest.originalName,
    'HELOC interest carries only its derived identity, without merchant text or card identity');
  ok(action.excluded.interest === 83 && otherRow(active).spent === 7
      && otherRow(active).recon.length === 1,
    'independent consumption ledger: issuer interest excluded once, only unrelated purchase remains');
  const hits = r.report.representedEventCandidates.filter(c => c.id === 'heloc');
  const lineBill = advice.defaultView.bills.find(b => b.id === 'heloc');
  ok(hits.length === 1 && hits[0].atlasAccountId === 'chequing-a' && hits[0].observedAmount === 91
      && lineBill.actual === 91 && lineBill.planned === 85 && lineBill.remaining === 0,
    'only the Bills debit settles the original cash minimum, without changing its planned amount');
  ok(r.data.plan.startingCash.breakdown.reduce((n, row) => n + row.value, 0) === 402
      && r.data.debts[0].balance === 992 && JSON.stringify(x) === before,
    'independent stocks: cash 500 minus 91 minus 7; line 1000 plus 83 minus 91; inputs untouched');
  const noPayment = structuredClone(x);
  noPayment.payload.transactions = noPayment.payload.transactions.filter(tx => tx.id !== 93002 && tx.id !== 93003);
  ok(!L.fromObservation(noPayment).report.representedEventCandidates.some(c => c.id === 'heloc'),
    'a line-side interest charge alone never settles the cash bill');
  const raw = { accountRole: 'heloc', atlasAccountId: 'heloc', categoryLabel: 'Interest charge',
    displayedPayee: 'INTEREST', amount: 83 };
  for (const accountRole of ['household-cash', 'mortgage', 'unknown', null]) {
    ok(F.classifyCurrentPeriodTransaction({ ...raw, accountRole }, x.data.plan).kind !== 'interest',
      'HELOC canonical id without the exact native role does not earn interest exclusion');
  }
  for (const tx of [
    { ...raw, categoryLabel: 'Shopping', displayedPayee: 'Invented store' },
    { ...raw, accountRole: 'household-cash', atlasAccountId: 'chequing-b', displayedPayee: 'OVERDRAFT INTEREST' },
  ]) ok(F.classifyCurrentPeriodTransaction(tx, x.data.plan).reason === 'unmapped-label',
    'non-interest HELOC purchase and household overdraft interest retain Other treatment');
  ok(F.classifyCurrentPeriodTransaction({ ...raw, amount: -83, isIncome: true }, x.data.plan).kind === 'income'
      && F.classifyCurrentPeriodTransaction({ ...raw, amount: -83 }, x.data.plan).kind === 'refund',
    'income and refund precedence is unchanged');
  // Compare the unchanged schedule against the independently loaded main engine.
  const Module = require('node:module');
  const filename = path.join(__dirname, '../public/forecast-base-proof.js');
  const base = new Module(filename, module); base.filename = filename; base.paths = module.paths;
  base._compile(require('node:child_process').execFileSync('git',
    ['show', 'ce9ab5193d3c173f8a74c969a08f38f3ce4d7af5:public/forecast.js'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }), filename);
  const canonical = load('data.json').plan;
  const payment = { ...raw, amount: 91, categoryLabel: 'Payment, Transfer', displayedPayee: 'Invented payment' };
  assert.deepEqual(F.classifyCurrentPeriodTransaction(payment, x.data.plan),
    base.exports.classifyCurrentPeriodTransaction(payment, x.data.plan));
  const start = canonical.opening.asOf, end = F.addDays(start, 91);
  assert.deepEqual(F.expandEvents(canonical, start, end), base.exports.expandEvents(canonical, start, end));
  ok(true, 'canonical cash, bill and obligation events are byte-for-byte unchanged from main');
}

console.log('\n=== HELOC finance-charge evidence survives the privacy boundary narrowly ===');
{
  const plan = { bills: [], obligations: [], budget: { categories: [] } };
  const makePacket = (atlasRole, change = {}) => O.sanitizedCurrentPeriodActuals({
    transactionWindow: { startDate: '2030-03-01', endDate: '2030-03-20', complete: true },
    pendingCoverage: { complete: true }, representedEventCandidates: [],
    collapsedTransactions: [{ providerAccountId: 'invented-line', providerTransactionId: 'invented-charge',
      date: '2030-03-20', amount: 83, pending: false, currency: 'cad',
      payee: 'INTEREST', originalName: 'INTEREST', categoryLabel: null, ...change }],
  }, { asOf: '2030-03-20', plan, accountMap: { schema: 'atlas-provider-account-map/v1',
    mappings: [{ providerAccountId: 'invented-line', canonical: { collection: 'debts', id: 'heloc' },
      atlasRole }] } });
  for (const change of [
    {}, { payee: null, originalName: 'INTEREST' },
    { payee: null, originalName: null, categoryLabel: 'Interest charge' },
  ]) {
    const packet = makePacket('heloc', change), row = packet.transactions[0];
    const cls = F.classifyCurrentPeriodTransaction(row, plan);
    ok(cls.reason === 'heloc-capitalised-interest' && row.helocFinanceChargeIdentity === true
        && row.cardFinanceChargeIdentity === false && !row.displayedPayee && !row.originalMerchant,
      'closed payee, original descriptor or category evidence survives without raw merchant publication');
  }
  for (const role of ['household-cash', 'mortgage', 'unknown', null]) {
    const row = makePacket(role).transactions[0];
    ok(row.helocFinanceChargeIdentity !== true
        && F.classifyCurrentPeriodTransaction(row, plan).kind !== 'interest'
        && F.classifyCurrentPeriodTransaction({ ...row, helocFinanceChargeIdentity: true }, plan).kind !== 'interest',
      'canonical HELOC id and a misplaced derived fact never substitute for native HELOC role');
  }
  for (const payee of ['Invented store', 'Invented interest bookshop', 'OVERDRAFT INTEREST']) {
    const row = makePacket('heloc', { payee, originalName: payee }).transactions[0];
    const cls = F.classifyCurrentPeriodTransaction(row, plan);
    ok(row.helocFinanceChargeIdentity !== true
        && cls.kind === 'unclassified' && cls.householdSpending === true,
      'unrelated purchases and non-closed interest descriptors remain Other');
  }
  for (const [change, kind] of [
    [{ amount: -83, isIncome: true }, 'income'], [{ amount: -83 }, 'refund'],
    [{ kind: 'payment' }, 'card-payment'],
  ]) {
    const row = makePacket('heloc', change).transactions[0];
    ok(F.classifyCurrentPeriodTransaction(row, plan).kind === kind,
      'income, refund and explicit payment keep precedence over preserved HELOC evidence');
  }
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nOK');
