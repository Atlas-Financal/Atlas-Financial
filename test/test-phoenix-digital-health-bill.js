'use strict';
/* Phoenix Digital Health is one card-paid Travel Visa bill (owner 2026-10-06).
 * The matching charge represents the occurrence once; it is then card spend
 * awaiting backfill, not also a reserved bill and not Other spending.
 *
 * `node test/test-phoenix-digital-health-bill.js`
 * Synthetic live-overlay fixtures and independent arithmetic (L-002 / L-006).
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const Live = require('../scripts/live-plan.js');
const O = require('../scripts/provider-observe.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const ID = 'phoenix-digital-health';
const AMOUNT = 174.99;
const DUE = '2026-10-03'; // Saturday
const POSTED = '2026-10-05'; // next business day
const LIVE = '2026-10-06';
const OPENING = '2026-08-19';

function live(txs) {
  const data = load('data.json');
  const observed = LIVE + 'T17:55:00.000Z';
  const debt = id => data.debts.find(d => d.id === id) || {};
  const cash = id => (data.plan.startingCash.breakdown.find(r => r.id === id) || {}).value;
  const card = (id, name, debtId) => ({ id, name, type: 'credit', subtype: 'credit_card',
    institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt(debtId).balance || 0),
    credit_limit: debt(debtId).limit, updated_at: observed, balance_last_update: observed });
  return Live.fromObservation({
    data, accountMap: load('docs/connectivity/fixtures/b81-account-map.json'), identity: load('docs/connectivity/transaction-identity.json'),
    payload: {
      provider: 'lunchmoney', fetchedAt: LIVE + 'T18:00:00.000Z',
      source: 'Synthetic Phoenix Digital Health live fixture. Not a live institution pull.',
      pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
      transactionWindow: { startDate: OPENING, endDate: LIVE, complete: true, hasMore: false, truncated: false },
      accounts: [
        { id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('chequing-a'), updated_at: observed, balance_last_update: observed },
        { id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('chequing-b'), updated_at: observed, balance_last_update: observed },
        { id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('savings'), updated_at: observed, balance_last_update: observed },
        card(3004, 'PERSONAL CREDIT CARD', 'tdcc'), card(3005, 'TD CASH BACK VISA* CARD', 'cashback'), card(3006, 'TRAVEL VISA', 'travelvisa'),
        { id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit', institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt('heloc').balance), updated_at: observed, balance_last_update: observed },
        { id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage', institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt('mortgage').balance), updated_at: observed, balance_last_update: observed },
        card(3010, 'TRIANGLE MASTERCARD', 'triangle'),
      ],
      categories: [{ id: 11, name: 'Personal Care', is_income: false, exclude_from_totals: false }],
      transactions: txs,
    },
  });
}
const tx = (id, amount, payee, extra) => Object.assign({ id, account_id: 3006, currency: 'cad', date: POSTED,
  amount, is_pending: false, payee, original_name: 'Phoenix Digital Health', category_id: 11 }, extra || {});
const withoutBill = plan => Object.assign({}, plan, { bills: plan.bills.filter(b => b.id !== ID) });
function reservedDelta(plan, asOf = LIVE) {
  const opts = { weeklyVariable: 0, viewDays: 1, horizonDays: 1, targetBuffer: 0 };
  return Math.round(((F.simulate(plan, asOf, opts).totals.reserved || 0)
    - (F.simulate(withoutBill(plan), asOf, opts).totals.reserved || 0)) * 100) / 100;
}
function coverageRemaining(plan, packet, asOf, amount) {
  const purchases = F.visaPaymentReconciliation(packet.transactions, { plan, asOf, packet }).purchases
    .filter(p => near(p.amount, amount));
  return purchases.reduce((sum, p) => sum + Number(p.remaining || 0), 0);
}
function protectedMatching(plan, packet, asOf, amount) {
  return Math.round((reservedDelta(plan, asOf) + coverageRemaining(plan, packet, asOf, amount)) * 100) / 100;
}
function liveSynth(txs, extra = {}) {
  const data = load('data.json');
  if (extra.omitBill) {
    data.plan.bills = data.plan.bills.filter(b => !b || b.id !== ID);
  } else if (extra.amount != null) {
    data.plan.bills = data.plan.bills.map(b => (
      b && b.id === ID ? Object.assign({}, b, { amount: extra.amount }) : b
    ));
  }
  data.plan.cardPurchaseCoverage = {
    opening: { asOf: OPENING, confirmed: true, currency: 'cad',
      fundingAccountId: 'chequing-a', purchases: [] },
    payments: [], refunds: [], reversals: [],
  };
  const observed = LIVE + 'T17:55:00.000Z';
  const debt = id => data.debts.find(d => d.id === id) || {};
  const cash = id => (data.plan.startingCash.breakdown.find(r => r.id === id) || {}).value;
  const card = (id, name, debtId) => ({ id, name, type: 'credit', subtype: 'credit_card',
    institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt(debtId).balance || 0),
    credit_limit: debt(debtId).limit, updated_at: observed, balance_last_update: observed });
  return Live.fromObservation({
    data, accountMap: load('docs/connectivity/fixtures/b81-account-map.json'), identity: load('docs/connectivity/transaction-identity.json'),
    payload: {
      provider: 'lunchmoney', fetchedAt: LIVE + 'T18:00:00.000Z',
      source: 'Synthetic Phoenix Digital Health pending/posted fixture. Not a live institution pull.',
      pendingCoverage: { complete: true, basis: O.PENDING_COVERAGE_BASIS, hasMore: false, truncated: false },
      transactionWindow: { startDate: OPENING, endDate: LIVE, complete: true, hasMore: false, truncated: false },
      accounts: [
        { id: 3001, name: 'BILLS ACCOUNT', type: 'cash', subtype: 'checking', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('chequing-a'), updated_at: observed, balance_last_update: observed },
        { id: 3002, name: 'WEEKLY SPENDING', type: 'cash', subtype: 'checking', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('chequing-b'), updated_at: observed, balance_last_update: observed },
        { id: 3003, name: 'EMERGENCY SAVING', type: 'cash', subtype: 'savings', institution_name: 'TD Canada Trust', currency: 'cad', balance: cash('savings'), updated_at: observed, balance_last_update: observed },
        card(3004, 'PERSONAL CREDIT CARD', 'tdcc'), card(3005, 'TD CASH BACK VISA* CARD', 'cashback'), card(3006, 'TRAVEL VISA', 'travelvisa'),
        { id: 3007, name: 'LINE OF CREDIT - HOME EQUITY', type: 'loan', subtype: 'line_of_credit', institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt('heloc').balance), updated_at: observed, balance_last_update: observed },
        { id: 3008, name: 'MORTGAGE', type: 'loan', subtype: 'mortgage', institution_name: 'TD Canada Trust', currency: 'cad', balance: Number(debt('mortgage').balance), updated_at: observed, balance_last_update: observed },
        card(3010, 'TRIANGLE MASTERCARD', 'triangle'),
      ],
      categories: [
        { id: 11, name: 'Personal Care', is_income: false, exclude_from_totals: false },
        { id: 12, name: 'Groceries', is_income: false, exclude_from_totals: false },
      ],
      transactions: txs,
    },
  });
}

console.log('=== one card-paid monthly bill ===');
{
  const rows = load('data.json').plan.bills.filter(b => b.id === ID);
  const r = rows[0] || {};
  ok(rows.length === 1 && r.frequency === 'monthly' && r.day === 3 && r.firstDue === DUE
      && r.amount === AMOUNT && r.payingAccount === 'travelvisa' && r.jointCash === false
      && r.budgetCategory === null, 'monthly $174.99 on day 3, Travel Visa, not a BILLS withdrawal, category open');
  ok(new Date(DUE + 'T00:00:00Z').getUTCDay() === 6 && new Date(POSTED + 'T00:00:00Z').getUTCDay() === 1,
    'hand dates: due Saturday 3 Oct, charge Monday 5 Oct');
}

console.log('\n=== matching charge represents the occurrence once ===');
{
  const settled = live([tx(9701, AMOUNT, 'Phoenix Digital Corp'), tx(9702, 1, 'Phoenix Digital Corp')]);
  const plan = settled.data.plan;
  ok((plan.opening.representedEvents || []).filter(e => e.id === ID && e.date === DUE).length === 1,
    'the posted $174.99 Monday charge represents the Saturday occurrence once');
  ok(!F.expandEvents(plan, LIVE, '2026-10-31').some(e => e.id === ID && e.date === DUE),
    'the represented occurrence is not carried');
  ok(near(reservedDelta(plan), 0), 'no Bills reserve remains for the represented charge', `Δ=${reservedDelta(plan)}`);
  const packet = settled.data.liveOverlay.currentPeriodActuals;
  const charge = packet.transactions.find(t => near(t.amount, AMOUNT));
  const cls = F.classifyCurrentPeriodTransaction(charge, plan, { currentPeriodActuals: packet });
  ok(cls.kind === 'bill' && cls.householdSpending === false, 'the charge is a represented bill, not Other spending', JSON.stringify(cls));
  // The canonical aggregate-rule opening (2026-11-06) makes this October
  // charge existing card debt. Holding-once is checked under an opening on the
  // 2026-09-25 payday, before the charge, so the ledger sees it as a purchase.
  const coveragePlan = { ...plan, cardPurchaseCoverage: { ...plan.cardPurchaseCoverage,
    opening: { ...plan.cardPurchaseCoverage.opening, asOf: '2026-09-25' } } };
  const purchases = F.visaPaymentReconciliation(packet.transactions, { plan: coveragePlan, asOf: LIVE, packet }).purchases
    .filter(p => near(p.amount, AMOUNT));
  ok(purchases.length === 1 && near(purchases[0].remaining, AMOUNT),
    'card coverage holds the charge once, awaiting a confirmed backfill');
}

console.log('\n=== unmatched evidence keeps one reserve ===');
for (const [label, txs] of [
  ['pending charge', [tx(9711, AMOUNT, 'Phoenix Digital Corp', { is_pending: true })]],
  ['$1.00 authorization only', [tx(9712, 1, 'Phoenix Digital Corp')]],
  ['different amount', [tx(9713, 175.99, 'Phoenix Digital Health')]],
  ['previous month charge', [tx(9714, AMOUNT, 'Phoenix Digital Health', { date: '2026-09-03' })]],
]) {
  const plan = live(txs).data.plan;
  ok(!(plan.opening.representedEvents || []).some(e => e.id === ID), `${label} does not settle`);
  ok(near(reservedDelta(plan), AMOUNT), `${label}: exactly one $174.99 reserve`, `Δ=${reservedDelta(plan)}`);
}

console.log('\n=== pending matching card-paid bill is reserved once ===');
{
  const SYNTH = 73.21;
  const GROCERY = 40;
  const DOUBLE = Math.round((SYNTH + SYNTH) * 100) / 100;
  const pendingTxs = [
    tx(9801, SYNTH, 'Phoenix Digital Corp', { is_pending: true }),
    tx(9802, GROCERY, 'Synthetic Grocer', {
      is_pending: true, category_id: 12, original_name: 'Synthetic Grocer',
    }),
    tx(9803, 1, 'Phoenix Digital Corp'),
  ];
  const pending = liveSynth(pendingTxs, { amount: SYNTH });
  const pendingPlan = pending.data.plan;
  const pendingPacket = pending.data.liveOverlay.currentPeriodActuals;
  const asOf = pendingPlan.opening.asOf;
  const pendingCharge = pendingPacket.transactions.find(t => near(t.amount, SYNTH) && t.pending === true);
  const grocery = pendingPacket.transactions.find(t => near(t.amount, GROCERY));
  const auth = pendingPacket.transactions.find(t => near(t.amount, 1) && t.pending !== true);
  const pendingCls = F.classifyCurrentPeriodTransaction(pendingCharge, pendingPlan, {
    currentPeriodActuals: pendingPacket,
  });
  const groceryCls = F.classifyCurrentPeriodTransaction(grocery, pendingPlan, {
    currentPeriodActuals: pendingPacket,
  });
  const coverage = F.visaPaymentReconciliation(pendingPacket.transactions, {
    plan: pendingPlan, asOf, packet: pendingPacket,
  });
  ok(asOf === LIVE, 'synthetic overlay uses the live as-of', asOf);
  ok(coverage.status === 'ready', 'complete card coverage is ready', coverage.status);
  ok(pendingCharge && pendingCharge.pendingMatchingCardPaidBill === true
      && pendingCharge.representedBill !== true, 'pending match is tagged, not representedBill');
  ok(!(pendingPlan.opening.representedEvents || []).some(e => e.id === ID),
    'pending does not allocate representedEvents');
  ok(!(pendingPacket.representedActuals || []).some(r => r.id === ID),
    'pending is not representedActuals, so the calendar stays unpaid');
  ok(!(pendingPlan.opening.representedEvents || []).some(e => e && e.transactionId === pendingCharge.id),
    'the pending local id is not cash-omit evidence');
  ok(F.expandEvents(pendingPlan, asOf, '2026-10-31').some(e => e.id === ID && e.date === DUE),
    'the occurrence stays still-due until posted');
  ok(pendingCls.kind === 'bill' && pendingCls.householdSpending === false
      && pendingCls.reason === 'pending-matching-card-paid-bill',
    'pending match is the bill, not a Budget spending deduction', JSON.stringify(pendingCls));
  ok(groceryCls.householdSpending === true, 'unrelated pending grocery remains household spending');
  ok(auth && auth.pendingMatchingCardPaidBill !== true, '$1 authorization is not the bill');
  ok(near(reservedDelta(pendingPlan, asOf), SYNTH),
    'still-due card-paid bill reserves 73.21 once', `Δ=${reservedDelta(pendingPlan, asOf)}`);
  ok(near(coverageRemaining(pendingPlan, pendingPacket, asOf, SYNTH), 0),
    'coverage does not also hold the matching pending authorization');
  ok(near(coverageRemaining(pendingPlan, pendingPacket, asOf, GROCERY), GROCERY),
    'unrelated pending grocery stays in card coverage');
  ok(near(protectedMatching(pendingPlan, pendingPacket, asOf, SYNTH), SYNTH)
      && !near(protectedMatching(pendingPlan, pendingPacket, asOf, SYNTH), DOUBLE),
    'pending protected is 73.21, not 146.42',
    `protected=${protectedMatching(pendingPlan, pendingPacket, asOf, SYNTH)}`);

  const posted = liveSynth([
    tx(9811, SYNTH, 'Phoenix Digital Corp'),
    tx(9812, GROCERY, 'Synthetic Grocer', { is_pending: true, category_id: 12, original_name: 'Synthetic Grocer' }),
    tx(9813, 1, 'Phoenix Digital Corp'),
  ], { amount: SYNTH });
  const postedPlan = posted.data.plan;
  const postedPacket = posted.data.liveOverlay.currentPeriodActuals;
  const postedAsOf = postedPlan.opening.asOf;
  const postedCharge = postedPacket.transactions.find(t => near(t.amount, SYNTH) && t.pending !== true);
  const postedCls = F.classifyCurrentPeriodTransaction(postedCharge, postedPlan, {
    currentPeriodActuals: postedPacket,
  });
  ok((postedPlan.opening.representedEvents || []).filter(e => e.id === ID && e.date === DUE).length === 1,
    'posting represents the occurrence once');
  ok(postedCharge && postedCharge.representedBill === true
      && postedCharge.pendingMatchingCardPaidBill !== true,
    'posted match is representedBill, not a pending tag');
  ok(postedCls.kind === 'bill' && postedCls.householdSpending === false,
    'posted match is the bill, not Other spending', JSON.stringify(postedCls));
  ok(near(reservedDelta(postedPlan, postedAsOf), 0),
    'posting drops the bill reserve', `Δ=${reservedDelta(postedPlan, postedAsOf)}`);
  ok(near(coverageRemaining(postedPlan, postedPacket, postedAsOf, SYNTH), SYNTH),
    'coverage holds the posted charge once, awaiting backfill');
  ok(near(protectedMatching(postedPlan, postedPacket, postedAsOf, SYNTH), SYNTH),
    'posted protected is still 73.21 once',
    `protected=${protectedMatching(postedPlan, postedPacket, postedAsOf, SYNTH)}`);
  ok(near(coverageRemaining(postedPlan, postedPacket, postedAsOf, GROCERY), GROCERY),
    'posting the bill does not discard unrelated pending coverage');

  const removed = liveSynth(pendingTxs, { omitBill: true });
  const removedPlan = removed.data.plan;
  const removedPacket = removed.data.liveOverlay.currentPeriodActuals;
  const removedAsOf = removedPlan.opening.asOf;
  const removedCharge = removedPacket.transactions.find(t => near(t.amount, SYNTH) && t.pending === true);
  const removedCls = F.classifyCurrentPeriodTransaction(removedCharge, removedPlan, {
    currentPeriodActuals: removedPacket,
  });
  ok(removedCharge && removedCharge.pendingMatchingCardPaidBill !== true,
    'without the bill, the pending purchase is not tagged as a match');
  ok(removedCls.householdSpending === true,
    'removing the bill restores ordinary pending spending classification', JSON.stringify(removedCls));
  ok(near(reservedDelta(removedPlan, removedAsOf), 0),
    'removing the bill leaves no card-paid reserve');
  ok(near(coverageRemaining(removedPlan, removedPacket, removedAsOf, SYNTH), SYNTH),
    'without the bill, coverage holds the pending 73.21 once');
  ok(near(protectedMatching(removedPlan, removedPacket, removedAsOf, SYNTH), SYNTH),
    'removing the bill restores single counting',
    `protected=${protectedMatching(removedPlan, removedPacket, removedAsOf, SYNTH)}`);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll proofs passed.');
