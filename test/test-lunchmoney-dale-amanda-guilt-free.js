'use strict';
/* Lunch Money categories named Dale / Amanda are the authoritative input
 * for Dale / Amanda guilt-free spending. Forecast classifies; pages do
 * not recompute. Synthetic fixtures and independent arithmetic
 * (L-002 / L-006).
 *
 * `node test/test-lunchmoney-dale-amanda-guilt-free.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const O = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;

const AS_OF = '2026-09-01';
const DALE_AMT = 42.11;
const AMANDA_AMT = 17.89;
const OTHER_AMT = 8.00;
const GROCERY_AMT = 30.25;
const FUEL_AMT = 12.40;
const CURSOR_AMT = 20.00;
const AMAZON_TRAVEL_AMT = 14.00;
const OPENAI_AMT = 16.00;
const DALE_PLANNED = 150;
const AMANDA_PLANNED = 150;
const DALE_REMAINING = roundCent(DALE_PLANNED - DALE_AMT);
const AMANDA_REMAINING = roundCent(AMANDA_PLANNED - AMANDA_AMT);
const BOTH_SPENT = roundCent(DALE_AMT + AMANDA_AMT);

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
        { id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary', from: ['Dale'], plannedPayday: 150, ownerLine: 'Dale guilt-free spending' },
        { id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary', from: ['Amanda'], plannedPayday: 150, ownerLine: 'Amanda guilt-free spending' },
        { id: 'shopping', label: 'Shopping', class: 'discretionary', from: ['Shopping', 'Personal'] },
        { id: 'health', label: 'Health', class: 'essential', from: ['Health'] },
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

function tx(extra) {
  return Object.assign({
    date: '2026-08-31',
    pending: false,
    accountRole: 'household-cash',
    displayedPayee: 'Store',
    originalMerchant: 'Store',
  }, extra);
}

function recommend(packet) {
  return F.recommend(syntheticPlan(), AS_OF, {
    targetBuffer: 500,
    debts,
    currentPeriodActuals: packet,
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
function reconSum(row) {
  return roundCent(((row && row.recon) || []).reduce((s, r) => s + (Number(r && r.amount) || 0), 0));
}
function rowHas(row, id) {
  return ((row && row.recon) || []).some(r => r && r.id === id);
}

const accountMap = {
  schema: 'atlas-provider-account-map/v1',
  mappings: [
    {
      providerAccountId: '1001',
      canonical: { collection: 'cash', id: 'chequing-a' },
      atlasRole: 'household-cash',
    },
  ],
};

function overlayPacket(categoryLabel, extraTx) {
  return O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-01T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-01', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      Object.assign({
        date: '2026-08-31',
        amount: DALE_AMT,
        pending: false,
        savingsPostingEvidence: 'posted',
        currency: 'cad',
        categoryLabel,
        payee: 'Some Store',
        originalName: 'Some Store',
        notes: 'Dale',
        tags: [{ name: 'Dale' }],
        providerAccountId: '1001',
        providerTransactionId: 'same-tx-1',
      }, extraTx || {}),
    ],
    representedEventCandidates: [],
  }, { asOf: AS_OF, plan: syntheticPlan(), accountMap });
}

console.log('\n=== independent fixture arithmetic ===');
ok(near(DALE_AMT + AMANDA_AMT, BOTH_SPENT)
    && near(DALE_PLANNED - DALE_AMT, DALE_REMAINING)
    && near(AMANDA_PLANNED - AMANDA_AMT, AMANDA_REMAINING)
    && !near(DALE_REMAINING, roundCent(DALE_PLANNED - BOTH_SPENT))
    && !near(AMANDA_REMAINING, roundCent(AMANDA_PLANNED - BOTH_SPENT)),
  'Dale remaining $107.89 and Amanda remaining $132.11 are independent of each other');

console.log('\n=== 1. Lunch Money category Dale is Dale guilt-free ===');
{
  const plan = syntheticPlan();
  const daleTx = tx({
    id: 'tx-lm-dale', amount: DALE_AMT, categoryLabel: 'Dale',
    displayedPayee: 'Bookstore', originalMerchant: 'Bookstore',
  });
  const cls = F.classifyCurrentPeriodTransaction(daleTx, plan);
  ok(cls.kind === 'spend' && cls.categoryId === 'dale-guilt-free'
      && cls.atlasRow === 'dale-guilt-free'
      && cls.needsConfirmation !== true
      && cls.householdSpending === true
      && cls.includeReason === 'lunchmoney-category-dale'
      && cls.categoryId !== 'amanda-guilt-free',
    'category Dale classifies as dale-guilt-free without tag/note evidence',
    JSON.stringify(cls));
}

console.log('\n=== 2. Lunch Money category Amanda is Amanda guilt-free ===');
{
  const plan = syntheticPlan();
  const amandaTx = tx({
    id: 'tx-lm-amanda', amount: AMANDA_AMT, categoryLabel: 'Amanda',
    displayedPayee: 'Boutique', originalMerchant: 'Boutique',
  });
  const cls = F.classifyCurrentPeriodTransaction(amandaTx, plan);
  ok(cls.kind === 'spend' && cls.categoryId === 'amanda-guilt-free'
      && cls.atlasRow === 'amanda-guilt-free'
      && cls.needsConfirmation !== true
      && cls.householdSpending === true
      && cls.includeReason === 'lunchmoney-category-amanda'
      && cls.categoryId !== 'dale-guilt-free',
    'category Amanda classifies as amanda-guilt-free without tag/note evidence',
    JSON.stringify(cls));
}

console.log('\n=== 3–4. calendar spent, not Other, and owners stay separate ===');
{
  const packet = actualsPacket([
    tx({
      id: 'tx-lm-dale', amount: DALE_AMT, categoryLabel: 'Dale',
      displayedPayee: 'Bookstore', originalMerchant: 'Bookstore',
    }),
    tx({
      id: 'tx-lm-amanda', amount: AMANDA_AMT, categoryLabel: 'Amanda',
      displayedPayee: 'Boutique', originalMerchant: 'Boutique',
    }),
    tx({
      id: 'tx-other', amount: OTHER_AMT, categoryLabel: 'Gifts',
      displayedPayee: 'Gift Shop', originalMerchant: 'Gift Shop',
    }),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const dale = budgetRow(active, 'dale-guilt-free');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  ok(dale && near(dale.spent, DALE_AMT) && near(reconSum(dale), DALE_AMT)
      && rowHas(dale, 'tx-lm-dale') && !rowHas(dale, 'tx-lm-amanda')
      && near(dale.remaining, DALE_REMAINING)
      && near(dale.planned, DALE_PLANNED),
    'Dale guilt-free spent is the Dale-categorized tx only');
  ok(amanda && near(amanda.spent, AMANDA_AMT) && near(reconSum(amanda), AMANDA_AMT)
      && rowHas(amanda, 'tx-lm-amanda') && !rowHas(amanda, 'tx-lm-dale')
      && near(amanda.remaining, AMANDA_REMAINING)
      && near(amanda.planned, AMANDA_PLANNED),
    'Amanda guilt-free spent is the Amanda-categorized tx only');
  ok(other && near(other.spent, OTHER_AMT) && rowHas(other, 'tx-other')
      && !rowHas(other, 'tx-lm-dale') && !rowHas(other, 'tx-lm-amanda'),
    'Dale/Amanda categorized txs are not in Other spending');
  ok(!near(dale.spent, BOTH_SPENT) && !near(amanda.spent, BOTH_SPENT)
      && !near(dale.remaining, roundCent(DALE_PLANNED - BOTH_SPENT))
      && !near(amanda.remaining, roundCent(AMANDA_PLANNED - BOTH_SPENT)),
    'one person\'s Dale/Amanda tx does not reduce the other\'s allowance');
}

console.log('\n=== 5. existing unrelated classifications stay unchanged ===');
{
  const plan = syntheticPlan();
  const grocery = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-grocery', amount: GROCERY_AMT, categoryLabel: 'Groceries',
    displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    note: 'Dale',
  }), plan);
  const fuel = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-fuel', amount: FUEL_AMT, categoryLabel: 'Fuel',
    displayedPayee: 'Shell', originalMerchant: 'Shell',
  }), plan);
  const cursor = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-cursor', amount: CURSOR_AMT, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'Cursor', originalMerchant: 'Cursor',
  }), plan);
  const amazonTravel = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-amazon-travel', amount: AMAZON_TRAVEL_AMT, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
    displayedPayee: 'Amazon', originalMerchant: 'Amazon',
  }), plan);
  const openai = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-openai', amount: OPENAI_AMT, categoryLabel: 'Shopping',
    accountRole: 'revolving-credit',
    displayedPayee: 'OpenAI', originalMerchant: 'OpenAI',
  }), plan);
  const canTire = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-ctmc', amount: 271, categoryLabel: 'Dale',
    displayedPayee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC',
  }), plan);
  ok(grocery.kind === 'spend' && grocery.categoryId === 'groceries'
      && grocery.categoryId !== 'dale-guilt-free',
    'Groceries stays Groceries even with a Dale note');
  ok(fuel.kind === 'spend' && fuel.categoryId === 'fuel',
    'Fuel category stays Fuel');
  ok(cursor.kind === 'spend' && cursor.categoryId === 'dale-guilt-free'
      && cursor.includeReason === 'owner-evidence-dale', // H1: Shopping label wins; owner evidence names Dale
    'Cursor on Shopping is still Dale via merchant identity');
  ok(amazonTravel.kind === 'spend' && amazonTravel.categoryId === 'amanda-guilt-free'
      && amazonTravel.includeReason === 'owner-evidence-amanda', // H1
    'Amazon + travelvisa on Shopping is still Amanda via standing merchant rule');
  ok(openai.needsConfirmation === true && openai.reason === 'personal-unassigned'
      && openai.categoryId !== 'dale-guilt-free' && openai.categoryId !== 'amanda-guilt-free',
    'OpenAI on Shopping stays unassigned, not Dale/Amanda');
  ok(canTire.kind === 'card-payment' && canTire.householdSpending === false
      && canTire.categoryId == null,
    'CAN TIRE MC debt identity still wins over a Dale Lunch Money category');

  const packet = actualsPacket([
    tx({
      id: 'tx-grocery', amount: GROCERY_AMT, categoryLabel: 'Groceries',
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
    }),
    tx({
      id: 'tx-fuel', amount: FUEL_AMT, categoryLabel: 'Fuel',
      displayedPayee: 'Shell', originalMerchant: 'Shell',
    }),
    tx({
      id: 'tx-cursor', amount: CURSOR_AMT, categoryLabel: 'Shopping',
      accountRole: 'revolving-credit',
      displayedPayee: 'Cursor', originalMerchant: 'Cursor',
    }),
    tx({
      id: 'tx-amazon-travel', amount: AMAZON_TRAVEL_AMT, categoryLabel: 'Shopping',
      accountRole: 'revolving-credit', atlasAccountId: 'travelvisa', account: 'travelvisa',
      displayedPayee: 'Amazon', originalMerchant: 'Amazon',
    }),
    tx({
      id: 'tx-openai', amount: OPENAI_AMT, categoryLabel: 'Shopping',
      accountRole: 'revolving-credit',
      displayedPayee: 'OpenAI', originalMerchant: 'OpenAI',
    }),
    tx({
      id: 'tx-lm-dale', amount: DALE_AMT, categoryLabel: 'Dale',
      displayedPayee: 'Bookstore', originalMerchant: 'Bookstore',
    }),
  ]);
  const advice = recommend(packet);
  const active = period(advice.defaultView, 'this-pay-period');
  const groceries = budgetRow(active, 'groceries');
  const fuelRow = budgetRow(active, 'fuel');
  const dale = budgetRow(active, 'dale-guilt-free');
  const amanda = budgetRow(active, 'amanda-guilt-free');
  const other = otherRow(active);
  ok(groceries && near(groceries.spent, GROCERY_AMT) && rowHas(groceries, 'tx-grocery'),
    'Groceries spent is only the Groceries tx');
  ok(fuelRow && near(fuelRow.spent, FUEL_AMT) && rowHas(fuelRow, 'tx-fuel'),
    'Fuel spent is only the Fuel tx');
  ok(dale && rowHas(dale, 'tx-lm-dale') && rowHas(dale, 'tx-cursor')
      && near(dale.spent, roundCent(DALE_AMT + CURSOR_AMT))
      && !rowHas(dale, 'tx-grocery') && !rowHas(dale, 'tx-openai'),
    'Dale spent is Lunch Money Dale plus Cursor, not Groceries or OpenAI');
  ok(amanda && rowHas(amanda, 'tx-amazon-travel') && !rowHas(amanda, 'tx-lm-dale')
      && near(amanda.spent, AMAZON_TRAVEL_AMT),
    'Amanda spent is still Amazon+travelvisa, not the Dale-categorized tx');
  ok(other && rowHas(other, 'tx-openai') && !rowHas(other, 'tx-lm-dale')
      && !rowHas(other, 'tx-cursor') && !rowHas(other, 'tx-amazon-travel'),
    'OpenAI remains Other; classified Dale/Amanda/Cursor/Amazon do not');
}

console.log('\n=== 6. fresh Lunch Money category wins over stale local owner mapping ===');
{
  const plan = syntheticPlan();
  const staleAmanda = F.classifyCurrentPeriodTransaction(tx({
    id: 'tx-reclass', amount: DALE_AMT, categoryLabel: 'Amanda',
    displayedPayee: 'Bookstore', originalMerchant: 'Bookstore',
    note: 'Dale', tags: [{ name: 'Dale' }], personalOwner: 'dale',
  }), plan);
  ok(staleAmanda.kind === 'spend' && staleAmanda.categoryId === 'amanda-guilt-free'
      && staleAmanda.categoryId !== 'dale-guilt-free'
      && staleAmanda.needsConfirmation !== true
      && staleAmanda.includeReason === 'lunchmoney-category-amanda',
    'Lunch Money Amanda wins over stale Dale note/tag/personalOwner',
    JSON.stringify(staleAmanda));

  const first = overlayPacket('Dale');
  const firstTx = (first.transactions || [])[0];
  const firstCls = firstTx ? F.classifyCurrentPeriodTransaction(firstTx, plan) : null;
  ok(O.currentPeriodActualsLooksSanitized(first)
      && firstTx && firstTx.categoryLabel === 'Dale'
      && firstCls && firstCls.categoryId === 'dale-guilt-free'
      && firstCls.includeReason === 'lunchmoney-category-dale',
    'first ingest of Lunch Money Dale classifies Dale guilt-free after overlay strip',
    JSON.stringify({ firstTx, firstCls }));

  const second = overlayPacket('Amanda');
  const secondTx = (second.transactions || [])[0];
  const secondCls = secondTx ? F.classifyCurrentPeriodTransaction(secondTx, plan) : null;
  ok(secondTx && secondTx.categoryLabel === 'Amanda'
      && secondCls && secondCls.categoryId === 'amanda-guilt-free'
      && secondCls.categoryId !== 'dale-guilt-free'
      && secondCls.includeReason === 'lunchmoney-category-amanda',
    'same provider tx recategorized Amanda on a fresh ingest is Amanda, not stale Dale',
    JSON.stringify({ secondTx, secondCls }));

  const firstAdvice = recommend(first);
  const secondAdvice = recommend(second);
  const firstActive = period(firstAdvice.defaultView, 'this-pay-period');
  const secondActive = period(secondAdvice.defaultView, 'this-pay-period');
  const firstDale = budgetRow(firstActive, 'dale-guilt-free');
  const firstAmanda = budgetRow(firstActive, 'amanda-guilt-free');
  const secondDale = budgetRow(secondActive, 'dale-guilt-free');
  const secondAmanda = budgetRow(secondActive, 'amanda-guilt-free');
  const firstOther = otherRow(firstActive);
  const secondOther = otherRow(secondActive);
  ok(firstDale && near(firstDale.spent, DALE_AMT)
      && (!firstAmanda || near(firstAmanda.spent, 0))
      && (!firstOther || !near(firstOther.spent, DALE_AMT)),
    'first ingest puts the amount on Dale, not Other or Amanda');
  ok(secondAmanda && near(secondAmanda.spent, DALE_AMT)
      && (!secondDale || near(secondDale.spent, 0))
      && (!secondOther || !near(secondOther.spent, DALE_AMT)),
    'reclassified ingest moves the amount to Amanda and off Dale/Other');
}

console.log('\n=== live plan maps Lunch Money Dale/Amanda onto existing guilt-free rows ===');
{
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const cats = ((live.plan && live.plan.budget && live.plan.budget.categories) || []);
  const dale = cats.find(c => c && c.id === 'dale-guilt-free');
  const amanda = cats.find(c => c && c.id === 'amanda-guilt-free');
  const shopping = cats.find(c => c && c.id === 'shopping');
  const aliases = row => (row && row.from || []).map(a => String(a || '').trim().toLowerCase());
  ok(dale && aliases(dale).includes('dale') && !aliases(dale).includes('amanda'),
    'live dale-guilt-free from includes Dale and not Amanda');
  ok(amanda && aliases(amanda).includes('amanda') && !aliases(amanda).includes('dale'),
    'live amanda-guilt-free from includes Amanda and not Dale');
  ok(shopping && !aliases(shopping).includes('dale') && !aliases(shopping).includes('amanda'),
    'live Shopping/Personal from does not absorb Dale or Amanda');
}

console.log('\n=== Lunch Money Dale/Amanda does not invent a second planner ===');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/forecast.js'), 'utf8');
  ok(/function lunchMoneyGuiltFreeCategoryOwner\(/.test(src)
      && /lunchmoney-category-dale/.test(src)
      && /lunchmoney-category-amanda/.test(src),
    'Forecast owns the Lunch Money Dale/Amanda mapping');
  const planSrc = fs.readFileSync(path.join(__dirname, '..', 'public/plan.js'), 'utf8');
  ok(!/lunchMoneyGuiltFreeCategoryOwner/.test(planSrc)
      && !/lunchmoney-category-dale/.test(planSrc),
    'Plan page does not reimplement the Dale/Amanda category mapping');
}

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nAll Lunch Money Dale/Amanda guilt-free proofs passed.');
