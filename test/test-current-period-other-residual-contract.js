'use strict';
/* Current-period classification contract: Other spending is only the final
 * fail-closed residual, and Amazon + canonical travelvisa is Amanda
 * guilt-free (Dale 2026-09-03). Forecast remains the sole classifier.
 * Synthetic fixtures and independent arithmetic / membership (L-002 / L-006).
 *
 * `node test/test-current-period-other-residual-contract.js`
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

const AS_OF = '2026-09-01';
const AMAZON_TRAVEL = 14.00;
const AMAZON_MBNA = 18.25;
const AMAZON_TRIANGLE = 11.40;
const PRIME_TRAVEL = 9.99;
const OPENAI_TRAVEL = 16.00;
const IRON = 18.40;
const MERIDIAN = 19.44;
const WALMART = 41.17;
const PITT = 100.00;
const SURREY = 45.00;
const CURSOR = 20.00;
const CAN_TIRE_MC = 271.00;
const GOOGLE = 3.13;
const CARD_PAY = 500.00;
const TRANSFER = 300.00;
const INCOME = 4264.00;
const REFUND = -12.50;
const OTHER_GIFT = 7.50;
const CONTRADICTION = 8.25;
const GROCERY_KNOWN = roundCent(IRON + MERIDIAN + WALMART);
const AMANDA_AMAZON = roundCent(AMAZON_TRAVEL + PRIME_TRAVEL);
const OTHER_RESIDUAL = roundCent(AMAZON_MBNA + AMAZON_TRIANGLE + OPENAI_TRAVEL + OTHER_GIFT + CONTRADICTION);

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
      amount: GOOGLE,
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
      excluded: [{ from: 'Business', why: 'Amanda coaching, not household' }],
    },
  };
}

const debts = [
  { id: 'tdcc', label: 'TD personal Visa', secured: false, structure: 'Revolving', balance: 90, rate: 24.99, payment: 94.03, pending: 0 },
  { id: 'heloc', label: 'HELOC', secured: true, structure: 'Interest-only revolving', balance: 1000, rate: 4.9, payment: 0, pending: 0, cashPayment: 0, interestTreatment: 'capitalised' },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising', balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

function tx(extra) {
  return Object.assign({
    date: '2026-08-31',
    pending: false,
    accountRole: 'household-cash',
  }, extra);
}

function amazonTravel(extra) {
  return tx(Object.assign({
    id: 'tx-amazon-travel',
    amount: AMAZON_TRAVEL,
    categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    account: 'travelvisa',
    displayedPayee: 'Amazon',
    originalMerchant: 'Amazon',
  }, extra || {}));
}

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
    for (const item of row.recon || []) {
      if (item && item.id) ids.push(item.id);
    }
  }
  return ids;
}
function reconSum(row) {
  return roundCent(((row && row.recon) || []).reduce((s, item) => s + (Number(item.amount) || 0), 0));
}
function rowHas(row, id) {
  return !!((row && row.recon) || []).some(item => item && item.id === id);
}
function recommend(packet, extraPlan) {
  const plan = Object.assign(syntheticPlan(), extraPlan || {});
  const represented = (plan.opening && plan.opening.representedEvents) || [];
  return F.recommend(plan, AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: packet,
    representedEvents: represented,
  });
}

const accountMap = {
  schema: 'atlas-provider-account-map/v1',
  mappings: [
    { providerAccountId: '3006', canonical: { collection: 'debts', id: 'travelvisa' }, atlasRole: 'revolving-credit' },
    { providerAccountId: '3007', canonical: { collection: 'debts', id: 'mbna' }, atlasRole: 'revolving-credit' },
    { providerAccountId: '3008', canonical: { collection: 'debts', id: 'triangle' }, atlasRole: 'revolving-credit' },
    { providerAccountId: '1001', canonical: { collection: 'cash', id: 'chequing-a' }, atlasRole: 'household-cash' },
    { providerAccountId: '1002', canonical: { collection: 'cash', id: 'chequing-b' }, atlasRole: 'household-cash' },
  ],
};

console.log('\n=== independent fixture arithmetic ===');
{
  ok(near(AMAZON_TRAVEL + PRIME_TRAVEL, AMANDA_AMAZON) && near(AMANDA_AMAZON, 23.99),
    'Amanda Amazon fixtures independently sum $14.00+$9.99=$23.99');
  ok(near(IRON + MERIDIAN + WALMART, GROCERY_KNOWN) && near(GROCERY_KNOWN, 79.01),
    'known grocery fixtures independently sum $18.40+$19.44+$41.17=$79.01');
  ok(near(AMAZON_MBNA + AMAZON_TRIANGLE + OPENAI_TRAVEL + OTHER_GIFT + CONTRADICTION, OTHER_RESIDUAL)
      && near(OTHER_RESIDUAL, 61.40),
    'genuine residual fixtures independently sum $18.25+$11.40+$16.00+$7.50+$8.25=$61.40');
}

console.log('\n=== 1–8 Amazon / ownership ===');
{
  const plan = syntheticPlan();
  const travel = amazonTravel();
  const travelCls = F.classifyCurrentPeriodTransaction(travel, plan);
  const travelFlags = F.classifyCurrentPeriodTransaction.derivedFlags(travel);
  ok(travelCls.kind === 'spend' && travelCls.categoryId === 'amanda-guilt-free'
      // H1: an explicit Lunch Money Shopping label wins; the personal-shopping
      // owner evidence still names Amanda.
      && travelCls.needsConfirmation !== true && travelCls.includeReason === 'owner-evidence-amanda'
      && travelFlags.amazonMerchant === true && travelFlags.personalOwner === 'amanda',
    '1. Amazon + Travel Visa → Amanda guilt-free',
    JSON.stringify({ travelCls, travelFlags }));

  const mbna = amazonTravel({
    id: 'tx-amazon-mbna', amount: AMAZON_MBNA,
    atlasAccountId: 'mbna', account: 'mbna',
  });
  const triangle = amazonTravel({
    id: 'tx-amazon-triangle', amount: AMAZON_TRIANGLE,
    displayedPayee: 'AMZN Mktp CA', originalMerchant: 'AMZN Mktp CA',
    atlasAccountId: 'triangle', account: 'triangle',
  });
  const openai = tx({
    id: 'tx-openai-travel', amount: OPENAI_TRAVEL, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
    displayedPayee: 'OpenAI', originalMerchant: 'OpenAI',
  });
  const prime = amazonTravel({
    id: 'tx-prime-travel', amount: PRIME_TRAVEL,
    displayedPayee: 'Amazon Prime', originalMerchant: 'Amazon Prime',
  });
  const noTag = amazonTravel({ id: 'tx-amazon-notag' });
  const daleLabel = amazonTravel({
    id: 'tx-amazon-dale-label',
    personalOwner: 'dale',
    tags: [{ name: 'Dale' }],
    note: 'Dale',
    categoryLabel: 'Personal',
  });
  const amazonian = tx({
    id: 'tx-amazonian', amount: 6, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
    displayedPayee: 'Amazonia Coffee', originalMerchant: 'Amazonia Coffee',
  });

  const mbnaCls = F.classifyCurrentPeriodTransaction(mbna, plan);
  const triangleCls = F.classifyCurrentPeriodTransaction(triangle, plan);
  const openaiCls = F.classifyCurrentPeriodTransaction(openai, plan);
  const primeCls = F.classifyCurrentPeriodTransaction(prime, plan);
  const noTagCls = F.classifyCurrentPeriodTransaction(noTag, plan);
  const daleCls = F.classifyCurrentPeriodTransaction(daleLabel, plan);
  const amazonianCls = F.classifyCurrentPeriodTransaction(amazonian, plan);
  const mbnaFlags = F.classifyCurrentPeriodTransaction.derivedFlags(mbna);
  const triangleFlags = F.classifyCurrentPeriodTransaction.derivedFlags(triangle);

  ok(noTagCls.kind === 'spend' && noTagCls.categoryId === 'amanda-guilt-free'
      && noTagCls.needsConfirmation !== true,
    '4. Amazon + Travel Visa without an Amanda LM tag still follows the standing owner rule');
  ok(daleCls.kind === 'spend' && daleCls.categoryId === 'amanda-guilt-free'
      && daleCls.categoryId !== 'dale-guilt-free' && daleCls.needsConfirmation !== true,
    '5. incidental Dale-style provider label does not override Amazon + Travel Visa',
    JSON.stringify(daleCls));
  ok(mbnaCls.needsConfirmation === true && mbnaCls.categoryId !== 'amanda-guilt-free'
      && mbnaFlags.amazonMerchant === true && mbnaFlags.personalOwner == null,
    '6. Amazon + MBNA does not automatically become Amanda',
    JSON.stringify({ mbnaCls, mbnaFlags }));
  ok(triangleCls.needsConfirmation === true && triangleCls.categoryId !== 'amanda-guilt-free'
      && triangleFlags.amazonMerchant === true,
    '7. Amazon + another card does not automatically become Amanda',
    JSON.stringify({ triangleCls, triangleFlags }));
  ok(openaiCls.needsConfirmation === true && openaiCls.categoryId !== 'amanda-guilt-free'
      && amazonianCls.needsConfirmation === true && amazonianCls.categoryId !== 'amanda-guilt-free',
    '8. unrelated software / Amazonia on Travel Visa do not become Amanda');
  ok(primeCls.kind === 'spend' && primeCls.categoryId === 'amanda-guilt-free'
      && primeCls.kind !== 'bill' && primeCls.needsConfirmation !== true,
    'Amazon Prime on Travel Visa is Amanda ownership, not a bill',
    JSON.stringify(primeCls));

  const packet = actualsPacket([
    travel, prime, mbna, triangle, openai, otherGift(), contradictionTx(),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  ok(amanda && near(amanda.spent, AMANDA_AMAZON) && near(reconSum(amanda), AMANDA_AMAZON)
      && rowHas(amanda, 'tx-amazon-travel') && rowHas(amanda, 'tx-prime-travel')
      && !rowHas(other, 'tx-amazon-travel') && !rowHas(other, 'tx-prime-travel'),
    '2–3. Amazon + Travel Visa is in Amanda Spent once and not in Other');
  ok(other && rowHas(other, 'tx-amazon-mbna') && rowHas(other, 'tx-amazon-triangle')
      && rowHas(other, 'tx-openai-travel') && !rowHas(amanda, 'tx-amazon-mbna'),
    'MBNA / Triangle Amazon and unrelated Travel Visa software remain outside Amanda');
}

function otherGift() {
  return tx({
    id: 'tx-other-gift', amount: OTHER_GIFT, categoryLabel: 'Gifts',
    displayedPayee: 'Gift Shop', originalMerchant: 'Gift Shop',
  });
}
function contradictionTx() {
  return tx({
    id: 'tx-google-pets', amount: CONTRADICTION, categoryLabel: 'Pets',
    displayedPayee: 'Google', originalMerchant: 'Google',
  });
}

console.log('\n=== 9–16 known rules beat Other ===');
{
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  // H1 (lead decision 2026-11-07): merchant identity rules apply only to
  // rows Lunch Money left uncategorised, so the merchant rows here are.
  const known = [
    tx({ id: 'tx-iron', amount: IRON, categoryLabel: null, displayedPayee: 'Iron Butcher', originalMerchant: 'Iron Butcher' }),
    tx({ id: 'tx-meridian', amount: MERIDIAN, categoryLabel: null, displayedPayee: 'Meridian Farm', originalMerchant: 'Meridian Farm' }),
    tx({ id: 'tx-walmart', amount: WALMART, categoryLabel: null, displayedPayee: 'Walmart', originalMerchant: 'Walmart' }),
    tx({ id: 'tx-pitt', amount: PITT, categoryLabel: null, displayedPayee: 'PITT MEADOWS CE', originalMerchant: 'PITT MEADOWS CE' }),
    tx({ id: 'tx-surrey', amount: SURREY, categoryLabel: null, displayedPayee: 'SURREY MEAT MARKET', originalMerchant: 'SURREY MEAT MARKET' }),
    tx({
      id: 'tx-cursor', amount: CURSOR, categoryLabel: 'Shopping',
      accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
      displayedPayee: 'Cursor', originalMerchant: 'Cursor',
    }),
    tx({ id: 'tx-can-tire-mc', amount: CAN_TIRE_MC, categoryLabel: 'Pets', displayedPayee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC' }),
    tx({
      id: 'tx-google-bill', amount: GOOGLE, categoryLabel: 'Shopping',
      displayedPayee: 'Google', originalMerchant: 'SERVICE _V', representedBill: true,
    }),
  ];
  const expect = {
    'tx-iron': 'groceries',
    'tx-meridian': 'groceries',
    'tx-walmart': 'groceries',
    'tx-pitt': 'fuel',
    'tx-surrey': 'pets',
    'tx-cursor': 'dale-guilt-free',
  };
  for (const row of known) {
    const cls = F.classifyCurrentPeriodTransaction(row, plan, {
      currentPeriodActuals: actualsPacket(known, {
        representedActuals: [{
          id: 'google-storage-100gb', date: '2026-08-31', actual: GOOGLE,
          transactionId: 'tx-google-bill',
        }],
      }),
    });
    if (row.id === 'tx-can-tire-mc') {
      ok(cls.kind === 'card-payment' && cls.householdSpending === false
          && cls.needsConfirmation !== true,
        '15. CAN TIRE MC is card/debt payment, not Household Budget / Other',
        JSON.stringify(cls));
    } else if (row.id === 'tx-google-bill') {
      ok(cls.kind === 'bill' && cls.householdSpending === false
          && cls.reason === 'represented-bill',
        '16. represented Google Storage is a bill, not Other',
        JSON.stringify(cls));
    } else {
      ok(cls.kind === 'spend' && cls.categoryId === expect[row.id]
          && cls.needsConfirmation !== true,
        row.id + ' classifies to ' + expect[row.id] + ', not Other',
        JSON.stringify(cls));
    }
  }

  const packet = actualsPacket(known.concat([otherGift()]), {
    representedActuals: [{
      id: 'google-storage-100gb', date: '2026-08-31', actual: GOOGLE,
      transactionId: 'tx-google-bill',
    }],
  });
  const advice = recommend(packet, { opening: plan.opening });
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const fuel = budgetRow(active, 'fuel');
  const pets = budgetRow(active, 'pets');
  const dale = budgetRow(active, 'dale-guilt-free');
  const other = otherRow(active);
  const ids = reconIds(active);
  ok(groceries && near(groceries.spent, GROCERY_KNOWN) && near(reconSum(groceries), GROCERY_KNOWN)
      && rowHas(groceries, 'tx-iron') && rowHas(groceries, 'tx-meridian') && rowHas(groceries, 'tx-walmart'),
    '9–11. Iron Butcher, Meridian Farm, and Walmart enter Groceries, not Other');
  ok(fuel && near(fuel.spent, PITT) && rowHas(fuel, 'tx-pitt') && !rowHas(other, 'tx-pitt'),
    '12. PITT MEADOWS CE enters Fuel, not Other');
  ok(pets && near(pets.spent, SURREY) && rowHas(pets, 'tx-surrey') && !rowHas(other, 'tx-surrey'),
    '13. Surrey Meat enters Dog food, not Other');
  ok(dale && near(dale.spent, CURSOR) && rowHas(dale, 'tx-cursor') && !rowHas(other, 'tx-cursor'),
    '14. Cursor enters Dale guilt-free, not Other');
  ok(!ids.includes('tx-can-tire-mc') && !ids.includes('tx-google-bill'),
    '15–16. CAN TIRE MC and represented Google appear on no Household Budget row');
  ok(other && near(other.spent, OTHER_GIFT) && rowHas(other, 'tx-other-gift'),
    'genuine Gift Shop residual remains Other');
}

console.log('\n=== 17–21 financial non-consumption ===');
{
  const plan = syntheticPlan();
  const rows = [
    tx({ id: 'tx-card', amount: CARD_PAY, categoryLabel: 'Payment', kindHint: 'card-payment' }),
    tx({ id: 'tx-transfer', amount: TRANSFER, categoryLabel: 'Transfer', kindHint: 'transfer', excludeFromTotals: true }),
    tx({ id: 'tx-income', amount: INCOME, categoryLabel: 'Income', isIncome: true }),
    tx({ id: 'tx-refund', amount: REFUND, categoryLabel: 'Shopping', displayedPayee: 'Amazon', originalMerchant: 'Amazon' }),
    tx({
      id: 'tx-bill', amount: GOOGLE, categoryLabel: 'Shopping',
      displayedPayee: 'Google', originalMerchant: 'Google', representedBill: true,
    }),
  ];
  const kinds = ['card-payment', 'transfer', 'income', 'refund', 'bill'];
  rows.forEach((row, i) => {
    const cls = F.classifyCurrentPeriodTransaction(row, plan);
    ok(cls.kind === kinds[i] && cls.householdSpending === false
        && cls.needsConfirmation !== true,
      (17 + i) + '. ' + kinds[i] + ' is excluded from Household Budget / Other',
      JSON.stringify(cls));
  });
  const packet = actualsPacket(rows.concat([otherGift()]));
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const ids = reconIds(active);
  ok(!ids.includes('tx-card') && !ids.includes('tx-transfer') && !ids.includes('tx-income')
      && !ids.includes('tx-refund') && !ids.includes('tx-bill') && ids.includes('tx-other-gift'),
    '29. debt/bill/transfer/income/refund appear on no Household Budget spending row');
}

console.log('\n=== 22–25 genuine residual / hold / next period ===');
{
  const packet = actualsPacket([otherGift(), contradictionTx()]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const next = period(advice.defaultView, 'next-pay-period');
  const other = otherRow(active);
  const groceries = budgetRow(active, 'groceries');
  ok(other && near(other.hold, roundCent(OTHER_GIFT + CONTRADICTION))
      && near(other.spent, roundCent(OTHER_GIFT + CONTRADICTION))
      && rowHas(other, 'tx-other-gift') && rowHas(other, 'tx-google-pets'),
    '22–24. unrecognized Gifts and a merchant/category contradiction stay Other; hold equals actual');
  ok(!(groceries && (groceries.recon || []).length),
    '23. Google + Pets is not guessed into Dog food or Groceries');
  const namedHold = ['groceries', 'fuel', 'household', 'pets', 'restaurants',
    'dale-guilt-free', 'amanda-guilt-free'].reduce((s, id) => {
    const row = budgetRow(active, id);
    return roundCent(s + (row && Number(row.hold) || 0));
  }, 0);
  const expectedHold = roundCent(900 + 325 + 37.5 + 100 + 200 + 150 + 150);
  ok(near(namedHold, expectedHold)
      && near(other.hold, roundCent(OTHER_GIFT + CONTRADICTION))
      && near(active.budgetHold, roundCent(expectedHold + OTHER_GIFT + CONTRADICTION)),
    '24. Other does not alter named planned reserves; its actual is added once',
    JSON.stringify({ namedHold, expectedHold, otherHold: other.hold }));
  const nextOther = otherRow(next);
  ok(!nextOther,
    '25. Next Pay Period does not forecast unknown Other spending');
}

console.log('\n=== 26–29 one-treatment invariant ===');
{
  const plan = syntheticPlan();
  plan.opening.representedEvents = [{ id: 'google-storage-100gb', date: '2026-08-31' }];
  const txs = [
    amazonTravel(),
    amazonTravel({
      id: 'tx-amazon-mbna', amount: AMAZON_MBNA,
      atlasAccountId: 'mbna', account: 'mbna',
    }),
    tx({ id: 'tx-iron', amount: IRON, categoryLabel: null, displayedPayee: 'Iron Butcher', originalMerchant: 'Iron Butcher' }),
    tx({ id: 'tx-can-tire-mc', amount: CAN_TIRE_MC, categoryLabel: 'Pets', displayedPayee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC' }),
    tx({
      id: 'tx-google-bill', amount: GOOGLE, categoryLabel: 'Shopping',
      displayedPayee: 'Google', originalMerchant: 'SERVICE _V', representedBill: true,
    }),
    tx({ id: 'tx-card', amount: CARD_PAY, categoryLabel: 'Payment', kindHint: 'card-payment' }),
    tx({ id: 'tx-transfer', amount: TRANSFER, categoryLabel: 'Transfer', kindHint: 'transfer', excludeFromTotals: true }),
    otherGift(),
  ];
  const packet = actualsPacket(txs, {
    representedActuals: [{
      id: 'google-storage-100gb', date: '2026-08-31', actual: GOOGLE,
      transactionId: 'tx-google-bill',
    }],
  });
  const advice = recommend(packet, { opening: plan.opening });
  const active = period(advice.defaultView, 'this-pay-period');
  const ids = reconIds(active);
  const unique = new Set(ids);
  ok(ids.length === unique.size,
    '26. no transaction appears in two Household Budget reconciliation rows');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const groceries = budgetRow(active, 'groceries');
  const other = otherRow(active);
  ok(rowHas(amanda, 'tx-amazon-travel') && !rowHas(other, 'tx-amazon-travel')
      && rowHas(groceries, 'tx-iron') && !rowHas(other, 'tx-iron'),
    '27. a known-category transaction cannot simultaneously appear in Other');
  ok((amanda.recon || []).filter(item => item && item.id === 'tx-amazon-travel').length === 1
      && near(amanda.spent, AMAZON_TRAVEL),
    '28. Amanda Amazon appears exactly once');
  ok(!ids.includes('tx-can-tire-mc') && !ids.includes('tx-google-bill')
      && !ids.includes('tx-card') && !ids.includes('tx-transfer'),
    '29. debt/bill/transfer transactions appear on no Household Budget spending row');
}

console.log('\n=== sanitized live-overlay Amazon + Travel Visa ===');
{
  const plan = syntheticPlan();
  const forecastSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8'));
  const observeSrc = sourceText(fs.readFileSync(path.join(__dirname, '..', 'scripts/provider-observe.js'), 'utf8'));
  ok(/function isAmazonMerchant\(/.test(forecastSrc)
      && /function isAmandaAmazonTravelVisa\(/.test(forecastSrc)
      && /amanda-amazon-travelvisa/.test(forecastSrc),
    'Forecast names Amazon merchant identity and the Amazon+travelvisa standing rule');
  ok(!/isAmazonPrimeMerchant|amazon-prime-bill|amazon-owner-card/.test(forecastSrc),
    'Forecast does not invent Prime-as-bill or all-Amazon / all-card ownership');
  ok(/amazonMerchant: flags\.amazonMerchant/.test(observeSrc)
      && !/spendResult\('amanda-guilt-free'/.test(observeSrc),
    'observer stamps amazonMerchant evidence and does not become the Amanda classifier');

  const published = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-03T18:13:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-01', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    tags: [{ id: 88, name: 'Dale' }],
    collapsedTransactions: [
      {
        date: '2026-08-31', amount: AMAZON_TRAVEL, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'AMZN Mktp CA',
        providerAccountId: '3006', providerTransactionId: 'raw-amzn-travel-1',
      },
      {
        date: '2026-08-31', amount: PRIME_TRAVEL, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Shopping',
        payee: 'Amazon Prime', originalName: 'Amazon Prime',
        tag_ids: [88],
        providerAccountId: '3006', providerTransactionId: 'raw-prime-travel',
      },
      {
        date: '2026-08-31', amount: AMAZON_MBNA, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Shopping',
        payee: 'Amazon', originalName: 'Amazon',
        providerAccountId: '3007', providerTransactionId: 'raw-amzn-mbna',
      },
      {
        date: '2026-08-31', amount: OPENAI_TRAVEL, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Shopping',
        payee: 'OpenAI', originalName: 'OpenAI',
        providerAccountId: '3006', providerTransactionId: 'raw-openai-travel',
      },
      {
        date: '2026-08-31', amount: OTHER_GIFT, pending: false, savingsPostingEvidence: 'posted', currency: 'cad', categoryLabel: 'Gifts',
        payee: 'Gift Shop', originalName: 'Gift Shop',
        providerAccountId: '1001', providerTransactionId: 'raw-gift',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan, accountMap });
  const blob = JSON.stringify(published);
  ok(O.currentPeriodActualsLooksSanitized(published)
      && !/"payee"\s*:/.test(blob) && !/"notes"\s*:/.test(blob)
      && !/"tags"\s*:/.test(blob) && !/"tag_ids"\s*:/.test(blob)
      && !/"providerTransactionId"\s*:/.test(blob)
      && !/"externalId"\s*:/.test(blob)
      && !/raw-amzn-travel-1/.test(blob),
    'sanitizer keeps no raw merchant tags, notes, or provider ids');
  const byAmt = amt => (published.transactions || []).find(row => row && near(row.amount, amt));
  const travelPub = byAmt(AMAZON_TRAVEL);
  const primePub = byAmt(PRIME_TRAVEL);
  const mbnaPub = byAmt(AMAZON_MBNA);
  const openaiPub = byAmt(OPENAI_TRAVEL);
  ok(travelPub && travelPub.amazonMerchant === true
      && travelPub.atlasAccountId === 'travelvisa'
      && travelPub.personalOwner === 'amanda'
      && !Object.prototype.hasOwnProperty.call(travelPub, 'payee'),
    'Travel Visa Amazon keeps derived amazonMerchant + canonical account after strip');
  ok(primePub && primePub.amazonMerchant === true && primePub.personalOwner === 'amanda'
      && primePub.kindHint !== 'bill',
    'Prime on Travel Visa stamps Amanda ownership evidence, not a bill flag');
  ok(mbnaPub && mbnaPub.amazonMerchant === true && mbnaPub.atlasAccountId === 'mbna'
      && mbnaPub.personalOwner == null,
    'MBNA Amazon keeps amazonMerchant and does not stamp Amanda');
  ok(openaiPub && openaiPub.amazonMerchant !== true && openaiPub.personalOwner == null
      && openaiPub.atlasAccountId === 'travelvisa',
    'OpenAI on Travel Visa is not Amazon merchant identity');

  const strippedNoText = {
    id: travelPub.id,
    date: travelPub.date,
    amount: travelPub.amount,
    pending: false,
    categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    atlasAccountId: 'travelvisa',
    amazonMerchant: true,
    personalOwner: null,
  };
  const strippedCls = F.classifyCurrentPeriodTransaction(strippedNoText, plan);
  ok(strippedCls.kind === 'spend' && strippedCls.categoryId === 'amanda-guilt-free'
      && strippedCls.includeReason === 'owner-evidence-amanda'
      && strippedCls.needsConfirmation !== true,
    'Forecast classifies stripped amazonMerchant + travelvisa as Amanda without raw merchant text',
    JSON.stringify(strippedCls));

  const advice = recommend(published);
  const active = period(advice.defaultView, 'this-pay-period');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  ok(amanda && near(amanda.spent, AMANDA_AMAZON) && near(reconSum(amanda), AMANDA_AMAZON)
      && (amanda.recon || []).length === 2,
    'sanitized overlay Amazon + Prime on Travel Visa contribute once each to Amanda Spent');
  ok(other && !((other.recon || []).some(item => near(item.amount, AMAZON_TRAVEL)))
      && !((other.recon || []).some(item => near(item.amount, PRIME_TRAVEL)))
      && (other.recon || []).some(item => near(item.amount, AMAZON_MBNA))
      && (other.recon || []).some(item => near(item.amount, OPENAI_TRAVEL))
      && (other.recon || []).some(item => near(item.amount, OTHER_GIFT)),
    'sanitized overlay keeps MBNA Amazon, OpenAI, and Gift Shop in Other, not Travel Visa Amazon');
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAll current-period Other-residual contract checks passed.');
