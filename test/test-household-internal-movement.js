'use strict';
/* Proven household-internal cash movement.
 *
 * Forecast represents a uniquely proven TD TFR-(TO|FR) pair between
 * household cash locations as one economic movement with source and
 * destination. The movement is not household income and not household
 * consumption. Unpaired transfer-looking transactions stay fail-closed.
 *
 * Independent reconstruction uses the incumbent TD five-character
 * reference pairing rule (ACCOUNT_FACTS / transfer-match.js), not the
 * Forecast function under test (L-002). Synthetic amounts only (L-006).
 *
 * `node test/test-household-internal-movement.js`
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

const PAYDAY = '2026-09-11';
const BILLS_TO_SAVINGS = 80;
const BILLS_TO_WEEKLY = 25;
const UNPAIRED = 40;
const GROCERY = 18.56;
const DALE = 2000;
const AMANDA = 1500;
const HELOC_DRAW = 200;
const TENNIS_CROSSING = 90;
const E_TRANSFER = 55;

const CASH_LOCATIONS = new Set(['chequing-a', 'chequing-b', 'savings']);
const TFR_RE = /\b([A-Z]{2}\d{3})\s+TFR-(TO|FR)\b/i;

function paydayPlan() {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: {
      amount: 1000,
      breakdown: [
        { id: 'chequing-a', label: 'BILLS ACCOUNT', value: 700 },
        { id: 'chequing-b', label: 'WEEKLY SPENDING', value: 200 },
        { id: 'savings', label: 'EMERGENCY SAVING', value: 100 },
      ],
      heldElsewhere: [
        { id: 'amanda-debt-payments', label: 'TENNIS INCOME', value: 4000 },
      ],
    },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [
      {
        id: 'payroll', label: 'Dale income', frequency: 'biweekly',
        anchor: '2026-08-14', amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaPayday', label: 'Amanda income', frequency: 'once',
        date: PAYDAY, amount: AMANDA, confidence: 'confirmed',
      },
    ],
    bills: [],
    obligations: [],
    commitments: [],
    budget: {
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          plannedMonthly: 450, ownerLine: 'Groceries',
        },
      ],
    },
  };
}

function packet(txs) {
  return {
    schema: 'atlas-current-period-actuals/v1',
    observationAsOf: PAYDAY,
    coverageStart: PAYDAY,
    coverageThrough: PAYDAY,
    transactionCoverage: 'complete', pendingCoverage: 'complete',
    transactions: txs,
    representedActuals: [],
  };
}

function classifyOpts(txs) {
  const currentPeriodActuals = packet(txs);
  return { currentPeriodActuals, packet: currentPeriodActuals };
}

function tfrLeg(opts) {
  const dir = opts.dir;
  const amount = dir === 'TO' ? opts.amount : -opts.amount;
  return {
    id: opts.id,
    date: opts.date || PAYDAY,
    amount,
    pending: opts.pending === true,
    categoryLabel: opts.categoryLabel || 'Payment, Transfer',
    accountRole: opts.accountRole || 'household-cash',
    atlasAccountId: opts.atlasAccountId,
    account: opts.atlasAccountId,
    excludeFromTotals: true,
    kindHint: opts.kindHint || 'transfer',
    displayedPayee: opts.payee,
    originalMerchant: opts.payee,
    isIncome: opts.isIncome === true,
  };
}

function parseIndependentTfr(tx) {
  if (!tx) return null;
  if (tx.tfrReference && (tx.tfrDirection === 'TO' || tx.tfrDirection === 'FR')) {
    return {
      ref: String(tx.tfrReference).toUpperCase(),
      dir: String(tx.tfrDirection).toUpperCase(),
    };
  }
  const blob = [tx.displayedPayee, tx.originalMerchant, tx.payee]
    .filter(Boolean).join(' ');
  const match = TFR_RE.exec(blob);
  if (!match) return null;
  return { ref: match[1].toUpperCase(), dir: match[2].toUpperCase() };
}

function independentCashLocation(tx) {
  if (!tx || tx.accountRole !== 'household-cash') return null;
  const id = String(tx.atlasAccountId || tx.account || '').trim();
  return CASH_LOCATIONS.has(id) ? id : null;
}

// Independent of Forecast.householdInternalMovements: unique 5-character
// TFR reference, opposite TO/FR, matching abs amount, two distinct
// household cash locations. Fail closed otherwise.
function independentPairs(txs) {
  const groups = new Map();
  for (const tx of txs || []) {
    if (!tx || tx.pending === true || tx.id == null) continue;
    const parsed = parseIndependentTfr(tx);
    const loc = independentCashLocation(tx);
    if (!parsed || !loc) continue;
    const amt = Number(tx.amount);
    if (parsed.dir === 'TO' && !(amt > 0)) continue;
    if (parsed.dir === 'FR' && !(amt < 0)) continue;
    const list = groups.get(parsed.ref) || [];
    list.push({ tx, parsed, loc, amt });
    groups.set(parsed.ref, list);
  }
  const out = [];
  groups.forEach((legs, ref) => {
    if (legs.length !== 2) return;
    const left = legs[0];
    const right = legs[1];
    if (left.parsed.dir === right.parsed.dir) return;
    if (left.loc === right.loc) return;
    if (roundCent(Math.abs(left.amt)) !== roundCent(Math.abs(right.amt))) return;
    const source = left.parsed.dir === 'TO' ? left : right;
    const dest = left.parsed.dir === 'FR' ? left : right;
    out.push({
      amount: roundCent(Math.abs(source.amt)),
      sourceAccountId: source.loc,
      destinationAccountId: dest.loc,
      sourceTransactionId: String(source.tx.id),
      destinationTransactionId: String(dest.tx.id),
      tfrReference: ref,
      householdAssetDelta: roundCent(source.amt + dest.amt),
    });
  });
  return out;
}

function independentGrocerySpend(txs) {
  return roundCent((txs || []).reduce((sum, tx) => {
    if (!tx || tx.pending === true) return sum;
    if (parseIndependentTfr(tx)) return sum;
    if (String(tx.categoryLabel || '') !== 'Groceries') return sum;
    const amt = Number(tx.amount);
    if (!(amt > 0)) return sum;
    return roundCent(sum + amt);
  }, 0));
}

function recommend(plan, txs) {
  return F.recommend(plan, PAYDAY, {
    targetBuffer: 0,
    debts: [{
      id: 'heloc', label: 'HELOC', secured: true, structure: 'Revolving',
      balance: 10000, rate: 5.45, payment: 50, pending: 0,
    }],
    currentPeriodActuals: packet(txs),
  });
}

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p && p.id === id);
}

console.log('=== A. Bills → Emergency Saving is one internal movement ===');
{
  const txs = [
    tfrLeg({
      id: 'tx-bills-sav-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'chequing-a', payee: 'AB101 TFR-TO SAVE01',
    }),
    tfrLeg({
      id: 'tx-bills-sav-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'savings', payee: 'AB101 TFR-FR BILLSA',
    }),
  ];
  const independent = independentPairs(txs);
  const opts = classifyOpts(txs);
  const plan = paydayPlan();
  const published = F.householdInternalMovements(plan, opts);
  const srcCls = F.classifyCurrentPeriodTransaction(txs[0], plan, opts);
  const dstCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const action = F.currentPeriodAction(plan, PAYDAY, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  const grocery = (action.categories || []).find(c => c && c.id === 'groceries');
  ok(independent.length === 1
      && independent[0].sourceAccountId === 'chequing-a'
      && independent[0].destinationAccountId === 'savings'
      && near(independent[0].amount, BILLS_TO_SAVINGS)
      && near(independent[0].householdAssetDelta, 0),
    'independent reconstruction: one Bills→Savings pair, household assets conserved');
  ok(published.length === 1
      && published[0].sourceAccountId === independent[0].sourceAccountId
      && published[0].destinationAccountId === independent[0].destinationAccountId
      && published[0].sourceTransactionId === independent[0].sourceTransactionId
      && published[0].destinationTransactionId === independent[0].destinationTransactionId
      && near(published[0].amount, independent[0].amount)
      && near(published[0].householdIncome, 0)
      && near(published[0].householdConsumption, 0)
      && near(published[0].householdAssetDelta, 0),
    'Forecast publishes the independently reconstructed Bills→Savings movement');
  ok(srcCls.kind === 'internal-movement' && dstCls.kind === 'internal-movement'
      && srcCls.householdSpending === false && dstCls.householdSpending === false
      && srcCls.sourceAccountId === 'chequing-a'
      && srcCls.destinationAccountId === 'savings'
      && dstCls.sourceAccountId === 'chequing-a'
      && dstCls.destinationAccountId === 'savings'
      && srcCls.direction === 'source' && dstCls.direction === 'destination',
    'both legs classify as one internal movement with source and destination');
  ok(action.internalMovements && action.internalMovements.length === 1
      && action.internalMovements[0].tfrReference === 'AB101',
    'currentPeriodAction exposes the movement to downstream Forecast consumers');
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'paired Bills→Savings is not household income');
  ok(grocery && near(grocery.posted || 0, 0)
      && (!action.unclassified || action.unclassified.count === 0),
    'paired Bills→Savings is not household spending / Other Spending');
}

console.log('=== B. Bills → Weekly is one internal movement, nets to zero ===');
{
  const txs = [
    tfrLeg({
      id: 'tx-bills-week-out', dir: 'TO', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-a', payee: 'CD202 TFR-TO WEEKLY',
    }),
    tfrLeg({
      id: 'tx-bills-week-in', dir: 'FR', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-b', payee: 'CD202 TFR-FR BILLSA',
    }),
  ];
  const independent = independentPairs(txs);
  const opts = classifyOpts(txs);
  const plan = paydayPlan();
  const published = F.householdInternalMovements(plan, opts);
  const srcCls = F.classifyCurrentPeriodTransaction(txs[0], plan, opts);
  const dstCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(independent.length === 1
      && independent[0].sourceAccountId === 'chequing-a'
      && independent[0].destinationAccountId === 'chequing-b'
      && near(independent[0].householdAssetDelta, 0),
    'independent reconstruction: Bills→Weekly nets to zero household assets');
  ok(published.length === 1
      && published[0].sourceAccountId === 'chequing-a'
      && published[0].destinationAccountId === 'chequing-b'
      && near(published[0].householdIncome, 0)
      && near(published[0].householdConsumption, 0),
    'Forecast keeps source/destination and zero income/consumption');
  ok(srcCls.kind === 'internal-movement' && srcCls.householdSpending === false
      && dstCls.kind === 'internal-movement' && dstCls.kind !== 'income'
      && dstCls.reason !== 'income',
    'source is not consumption; destination is not income');
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'Bills→Weekly does not manufacture payday income');
}

console.log('=== C. Unpaired / ambiguous transfer-looking txs are not proven-internal ===');
{
  const unpaired = tfrLeg({
    id: 'tx-unpaired-tfr', dir: 'TO', amount: UNPAIRED,
    atlasAccountId: 'chequing-a', payee: 'EF303 TFR-TO SAVE01',
  });
  const etfr = {
    id: 'tx-send-etfr',
    date: PAYDAY,
    amount: E_TRANSFER,
    pending: false,
    categoryLabel: 'Payment, Transfer',
    accountRole: 'household-cash',
    atlasAccountId: 'chequing-a',
    excludeFromTotals: true,
    kindHint: 'transfer',
    displayedPayee: 'SEND E-TFR',
    originalMerchant: 'SEND E-TFR',
  };
  const cardTfr = tfrLeg({
    id: 'tx-tfr-cc', dir: 'TO', amount: 60,
    atlasAccountId: 'chequing-a', payee: 'GH404 TFR-TO C/C',
  });
  const ambiguous = [
    tfrLeg({
      id: 'tx-amb-a', dir: 'TO', amount: 30,
      atlasAccountId: 'chequing-a', payee: 'IJ505 TFR-TO WEEKLY',
    }),
    tfrLeg({
      id: 'tx-amb-b', dir: 'TO', amount: 30,
      atlasAccountId: 'chequing-b', payee: 'IJ505 TFR-TO BILLSA',
    }),
  ];
  const txs = [unpaired, etfr, cardTfr].concat(ambiguous);
  const independent = independentPairs(txs);
  const opts = classifyOpts(txs);
  const plan = paydayPlan();
  const published = F.householdInternalMovements(plan, opts);
  const unpairedCls = F.classifyCurrentPeriodTransaction(unpaired, plan, opts);
  const etfrCls = F.classifyCurrentPeriodTransaction(etfr, plan, opts);
  const cardCls = F.classifyCurrentPeriodTransaction(cardTfr, plan, opts);
  const ambCls = F.classifyCurrentPeriodTransaction(ambiguous[0], plan, opts);
  ok(independent.length === 0 && published.length === 0,
    'independent reconstruction and Forecast both fail closed: no proven pair');
  ok(unpairedCls.kind !== 'internal-movement' && unpairedCls.internalMovement !== true,
    'unpaired TFR debit is not promoted to proven-internal', unpairedCls.kind);
  ok(etfrCls.kind !== 'internal-movement',
    'SEND E-TFR is not proven household-internal movement', etfrCls.kind);
  ok(cardCls.kind !== 'internal-movement',
    'TFR-TO C/C is not a household-cash internal movement', cardCls.kind);
  ok(ambCls.kind !== 'internal-movement',
    'two TO legs sharing a reference stay fail-closed', ambCls.kind);
  ok(unpairedCls.kind === 'transfer' && etfrCls.kind === 'transfer',
    'unpaired transfer-looking txs remain incumbent transfer, not spend');
}

console.log('=== 4. Transfer classification cannot manufacture income ===');
{
  const txs = [
    tfrLeg({
      id: 'tx-inc-out', dir: 'TO', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-a', payee: 'KL606 TFR-TO WEEKLY',
      categoryLabel: 'Income', isIncome: true,
    }),
    tfrLeg({
      id: 'tx-inc-in', dir: 'FR', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-b', payee: 'KL606 TFR-FR BILLSA',
      categoryLabel: 'Income', isIncome: true,
    }),
  ];
  const plan = paydayPlan();
  const opts = classifyOpts(txs);
  const srcCls = F.classifyCurrentPeriodTransaction(txs[0], plan, opts);
  const dstCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(srcCls.kind === 'internal-movement' && dstCls.kind === 'internal-movement'
      && srcCls.kind !== 'income' && dstCls.kind !== 'income',
    'Income-labeled TFR pair is still an internal movement, not income');
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'Payday income stays Dale + Amanda; TFR cannot manufacture resources');
}

console.log('=== 5. Tennis → Bills is not proven-internal and is not generic income ===');
{
  const txs = [
    {
      id: 'tx-tennis-out',
      date: PAYDAY,
      amount: TENNIS_CROSSING,
      pending: false,
      categoryLabel: 'Payment, Transfer',
      accountRole: 'household-external',
      atlasAccountId: 'amanda-debt-payments',
      excludeFromTotals: true,
      kindHint: 'transfer',
      displayedPayee: 'MN707 TFR-TO BILLSA',
      originalMerchant: 'MN707 TFR-TO BILLSA',
    },
    tfrLeg({
      id: 'tx-tennis-in', dir: 'FR', amount: TENNIS_CROSSING,
      atlasAccountId: 'chequing-a', payee: 'MN707 TFR-FR TENNIS',
    }),
  ];
  const independent = independentPairs(txs);
  const plan = paydayPlan();
  const opts = classifyOpts(txs);
  const published = F.householdInternalMovements(plan, opts);
  const destCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(independent.length === 0 && published.length === 0,
    'Tennis INCOME counterpart is not a household cash location');
  ok(destCls.kind !== 'internal-movement' && destCls.kind !== 'income',
    'Bills credit from Tennis is not proven-internal and not generic income',
    destCls.kind);
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'generic Tennis→Bills movement does not become Other Income or extra salary');
}

console.log('=== 6. HELOC → Bills is not income and not proven household-internal ===');
{
  const txs = [
    {
      id: 'tx-heloc-out',
      date: PAYDAY,
      amount: HELOC_DRAW,
      pending: false,
      categoryLabel: 'Payment, Transfer',
      accountRole: 'heloc',
      atlasAccountId: 'heloc',
      excludeFromTotals: true,
      kindHint: 'transfer',
      displayedPayee: 'OP808 TFR-TO BILLSA',
      originalMerchant: 'OP808 TFR-TO BILLSA',
    },
    tfrLeg({
      id: 'tx-heloc-in', dir: 'FR', amount: HELOC_DRAW,
      atlasAccountId: 'chequing-a', payee: 'OP808 TFR-FR HELOC1',
    }),
  ];
  const independent = independentPairs(txs);
  const plan = paydayPlan();
  const opts = classifyOpts(txs);
  const published = F.householdInternalMovements(plan, opts);
  const destCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(independent.length === 0 && published.length === 0,
    'HELOC counterpart is not a household cash location');
  ok(destCls.kind !== 'income' && destCls.kind !== 'internal-movement',
    'HELOC→Bills credit is not income and not proven-internal', destCls.kind);
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'cash entering Bills from HELOC does not become household income');
}

console.log('=== 7. Savings → Bills is internal movement, not new income ===');
{
  const txs = [
    tfrLeg({
      id: 'tx-sav-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'savings', payee: 'QR909 TFR-TO BILLSA',
    }),
    tfrLeg({
      id: 'tx-sav-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
      atlasAccountId: 'chequing-a', payee: 'QR909 TFR-FR SAVE01',
    }),
  ];
  const independent = independentPairs(txs);
  const plan = paydayPlan();
  const opts = classifyOpts(txs);
  const published = F.householdInternalMovements(plan, opts);
  const destCls = F.classifyCurrentPeriodTransaction(txs[1], plan, opts);
  const advice = recommend(plan, txs);
  const active = period(advice.defaultView, 'this-pay-period');
  ok(independent.length === 1
      && independent[0].sourceAccountId === 'savings'
      && independent[0].destinationAccountId === 'chequing-a'
      && near(independent[0].householdAssetDelta, 0),
    'independent reconstruction: Savings→Bills conserves household assets');
  ok(published.length === 1 && destCls.kind === 'internal-movement'
      && destCls.kind !== 'income',
    'Savings→Bills is proven internal movement, not new income');
  ok(near(active.otherIncome && active.otherIncome.amount, 0)
      && near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'cash entering Bills from Savings is not Other Income');
}

console.log('=== 8. Genuine merchant spending remains Household Budget / Other Spending ===');
{
  const txs = [
    tfrLeg({
      id: 'tx-move-out', dir: 'TO', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-a', payee: 'ST010 TFR-TO WEEKLY',
    }),
    tfrLeg({
      id: 'tx-move-in', dir: 'FR', amount: BILLS_TO_WEEKLY,
      atlasAccountId: 'chequing-b', payee: 'ST010 TFR-FR BILLSA',
    }),
    {
      id: 'tx-grocery',
      date: PAYDAY,
      amount: GROCERY,
      pending: false,
      categoryLabel: 'Groceries',
      accountRole: 'household-cash',
      atlasAccountId: 'chequing-b',
      displayedPayee: 'Save-On-Foods',
      originalMerchant: 'Save-On-Foods',
    },
  ];
  const independentSpend = independentGrocerySpend(txs);
  const independentMove = independentPairs(txs);
  const plan = paydayPlan();
  const opts = classifyOpts(txs);
  const groceryCls = F.classifyCurrentPeriodTransaction(txs[2], plan, opts);
  const action = F.currentPeriodAction(plan, PAYDAY, opts);
  const grocery = (action.categories || []).find(c => c && c.id === 'groceries');
  ok(near(independentSpend, GROCERY) && independentMove.length === 1,
    'independent inventory: grocery spend plus one internal movement');
  ok(groceryCls.kind === 'spend' && groceryCls.categoryId === 'groceries'
      && groceryCls.householdSpending === true,
    'Save-On-Foods still classifies as Groceries spend');
  ok(grocery && near(grocery.posted, GROCERY),
    'Household Budget grocery posted independently equals the merchant debit');
  ok(action.internalMovements && action.internalMovements.length === 1
      && near(action.internalMovements[0].amount, BILLS_TO_WEEKLY),
    'the internal movement remains published beside genuine spend');
}

console.log('=== 9. Overlay-stripped TFR flags still pair; merchant text is gone ===');
{
  const plan = paydayPlan();
  const map = {
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
      {
        providerAccountId: '1003',
        canonical: { collection: 'cash', id: 'savings' },
        atlasRole: 'household-cash',
      },
    ],
  };
  const overlay = O.sanitizedCurrentPeriodActuals({
    fetchedAt: '2026-09-11T18:00:00.000Z',
    transactionWindow: { startDate: '2026-08-28', endDate: '2026-09-11', complete: true },
    pendingCoverage: {
      complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false,
    },
    collapsedTransactions: [
      {
        date: PAYDAY, amount: BILLS_TO_SAVINGS, pending: false,
        categoryLabel: 'Payment, Transfer', excludeFromTotals: true, kind: 'transfer',
        payee: 'UV111 TFR-TO SAVE01', originalName: 'UV111 TFR-TO SAVE01',
        providerAccountId: '1001', providerTransactionId: 'ov-bills-sav-out',
      },
      {
        date: PAYDAY, amount: -BILLS_TO_SAVINGS, pending: false,
        categoryLabel: 'Payment, Transfer', excludeFromTotals: true, kind: 'transfer',
        payee: 'UV111 TFR-FR BILLSA', originalName: 'UV111 TFR-FR BILLSA',
        providerAccountId: '1003', providerTransactionId: 'ov-bills-sav-in',
      },
    ],
    representedEventCandidates: [],
  }, { asOf: PAYDAY, plan, accountMap: map });
  const blob = JSON.stringify(overlay);
  const src = (overlay.transactions || []).find(tx => tx && tx.atlasAccountId === 'chequing-a');
  const dst = (overlay.transactions || []).find(tx => tx && tx.atlasAccountId === 'savings');
  ok(O.currentPeriodActualsLooksSanitized(overlay)
      && !/"payee"\s*:/.test(blob) && !src.displayedPayee && !dst.displayedPayee,
    'overlay packet strips TFR merchant text');
  ok(src && src.tfrReference === 'UV111' && src.tfrDirection === 'TO'
      && dst && dst.tfrReference === 'UV111' && dst.tfrDirection === 'FR'
      && src.internalTransferIdentity === true && dst.internalTransferIdentity === true,
    'overlay stamps tfrReference/tfrDirection before strip');
  const independent = independentPairs(overlay.transactions);
  const published = F.householdInternalMovements(plan, {
    currentPeriodActuals: overlay,
  });
  const srcCls = F.classifyCurrentPeriodTransaction(src, plan, {
    currentPeriodActuals: overlay,
  });
  ok(independent.length === 1 && published.length === 1
      && published[0].sourceAccountId === 'chequing-a'
      && published[0].destinationAccountId === 'savings'
      && srcCls.kind === 'internal-movement',
    'stripped overlay flags still prove Bills→Savings as one internal movement');
}

console.log('=== 10. Existing Amanda salary recognition is unchanged ===');
{
  const plan = paydayPlan();
  plan.opening.representedEvents = [
    { id: 'amandaPayday', date: PAYDAY },
  ];
  const advice = recommend(plan, []);
  const active = period(advice.defaultView, 'this-pay-period');
  const amanda = ((active && active.income) || []).find(r => r && /amanda/i.test(String(r.id || r.label || '')))
    || ((active && active.inflows) || []).find(r => r && /amanda/i.test(String(r.id || r.label || '')));
  ok(near(active.incomeTotal, roundCent(DALE + AMANDA)),
    'Dale + Amanda payday income is unchanged without transfer evidence');
  ok(!amanda || amanda.otherIncome !== true,
    'Amanda salary is not reclassified as Other Income');
}

console.log('=== 10. Proven internal movement carrying the e-transfer boolean stays out of the review list ===');
{
  // The TO leg carries outgoingETransferIdentity: the proven-pair exclusion
  // (and the internal-movement classification) must keep it out of the new
  // outgoing e-transfer publication, and internalMovements is unchanged.
  const src = tfrLeg({
    id: 'tx-etfr-pair-out', dir: 'TO', amount: BILLS_TO_SAVINGS,
    atlasAccountId: 'chequing-a', payee: 'ZZ999 TFR-TO SAVE01',
  });
  src.outgoingETransferIdentity = true;
  const dst = tfrLeg({
    id: 'tx-etfr-pair-in', dir: 'FR', amount: BILLS_TO_SAVINGS,
    atlasAccountId: 'savings', payee: 'ZZ999 TFR-FR BILLSA',
  });
  const txs = [src, dst];
  const plan = paydayPlan();
  const fullPacket = Object.assign(packet(txs), {
    transactionCoverage: 'complete',
    transactionWindow: { startDate: PAYDAY, endDate: PAYDAY, complete: true, hasMore: false, truncated: false },
  });
  const action = F.currentPeriodAction(plan, PAYDAY,
    { currentPeriodActuals: fullPacket, packet: fullPacket });
  ok(action.internalMovements && action.internalMovements.length === 1
    && action.internalMovements[0].tfrReference === 'ZZ999',
    'the proven pair is still published as one internal movement, unchanged');
  ok(action.outgoingETransfers && action.outgoingETransfers.status === 'available-complete'
    && action.outgoingETransfers.count === 0
    && !action.outgoingETransfers.items.some(i => i.id === 'tx-etfr-pair-out'),
    'a proven internal-movement leg carrying the e-transfer boolean is not in the review publication',
    JSON.stringify(action.outgoingETransfers));
}

if (failures) {
  console.log('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nOK');
