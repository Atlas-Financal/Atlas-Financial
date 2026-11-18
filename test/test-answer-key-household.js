'use strict';

// One invented household, October and November. Forecast uses the first
// earner's biweekly dates as the Budget boundaries. There are two of those
// dates in each month of this ledger. The second earner is paid on the 16th
// and 28th. All expected amounts below are reconciled from the ledger by hand.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness');
const Live = require('../scripts/live-plan');
const Forecast = require('../public/forecast');
const emptyCardOpening = require('./fixtures/card-coverage-opening');

const START = '2026-10-09';
const OPENING = '2026-10-01';
const AS_OF = '2026-11-30';
const world = H.baseWorld(AS_OF);
world.windowStart = OPENING;
world.pendingCoverage.truncated = false;
world.coverage.truncated = false;
// Bills cash: 1000 + 7320 wages - 314.50 paid bills - (35 + 26.25)
// card transfers = 7944.25. Weekly cash: 200 - (12 + 9.25 + 22 + 8.20
// + 19.35 + 5.65 + 6.75) = 116.80. Each card closes at zero.
world.accounts = [
  { id: 'chequing-a', providerId: 9001, label: 'Invented Bills', value: 7944.25, collection: 'cash', role: 'household-cash' },
  { id: 'chequing-b', providerId: 9002, label: 'Invented Weekly', value: 116.80, collection: 'cash', role: 'household-cash' },
  { id: 'savings', providerId: 9003, label: 'Invented Reserve', value: 0, collection: 'cash', role: 'household-cash' },
  { id: 'travelvisa', providerId: 9104, label: 'Invented Travel Card', value: 0, collection: 'debts', role: 'revolving-credit' },
  { id: 'cashback', providerId: 9105, label: 'Invented Cash Back Card', value: 0, collection: 'debts', role: 'revolving-credit' },
];
world.debts = ['travelvisa', 'cashback'].map(id => ({
  id, label: world.accounts.find(account => account.id === id).label, structure: 'Revolving',
  secured: false, balance: 0, pending: 0, rate: 0, limit: 900, statementCloseDay: 17,
}));
world.income = [
  { id: 'payroll', label: 'Ari wages', frequency: 'biweekly', anchor: START, amount: 1200, confidence: 'confirmed' },
  { id: 'bo-16', label: 'Bo wages (16th)', frequency: 'monthly', day: 16, firstDue: '2026-10-16', amount: 630, confidence: 'confirmed' },
  { id: 'bo-28', label: 'Bo wages (28th)', frequency: 'monthly', day: 28, firstDue: '2026-10-28', amount: 630, confidence: 'confirmed' },
];
world.identityRules = [
  { eventId: 'payroll', payeePattern: 'Invented Ari employer', atlasAccountId: 'chequing-a', direction: 'credit' },
  ...['bo-16', 'bo-28'].map(eventId => ({
    eventId, payeePattern: 'Invented Bo employer', atlasAccountId: 'chequing-a', direction: 'credit',
  })),
];
world.bills = [
  { id: 'studio', label: 'Studio fee', payee: 'Invented studio', day: 25, firstDue: '2026-10-25', amount: 89.75,
    rule: { postingDateRule: 'covers-early-or-due-on-or-before-posting' } },
  { id: 'internet', label: 'Internet', payee: 'Invented internet', day: 12, firstDue: '2026-10-12', amount: 50,
    rule: { postingDateRule: 'due-or-up-to-two-days-after' } },
  { id: 'water', label: 'Water', payee: 'Invented water', day: 27, firstDue: '2026-10-27', amount: 35 },
].map(bill => ({ ...bill, frequency: 'monthly', confidence: 'confirmed', payingAccount: 'chequing-a' }));
world.budget = [
  { id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: 100, confidence: 'confirmed', from: ['Groceries'] },
];

function tx(id, date, amount, account, category, payee, more = {}) {
  return H.lm({ id, date, amount, account, category, payee,
    providerAccountId: world.accounts.find(row => row.id === account).providerId, ...more });
}

world.transactions = [
  tx('ari-oct-first', '2026-10-09', -1200, 'chequing-a', 'Payroll', 'Invented Ari employer'),
  tx('internet-oct', '2026-10-12', 50, 'chequing-a', 'Internet', 'Invented internet'),
  tx('food-card', '2026-10-12', 42.5, 'travelvisa', 'Groceries', 'Invented market'),
  // The provider's group-parent form is affirmative linkage for the refund.
  tx('food-return', '2026-10-13', -7.5, 'travelvisa', 'Groceries', 'Invented market',
    { raw: { is_group_parent: true } }),
  tx('food-oct-first', '2026-10-14', 12, 'chequing-b', 'Groceries', 'Invented produce stall'),
  tx('bo-oct-first', '2026-10-16', -630, 'chequing-a', 'Payroll', 'Invented Bo employer'),
  tx('misc-oct-first', '2026-10-19', 9.25, 'chequing-b', null, 'Invented repair stand'),
  tx('travel-payment-debit', '2026-10-20', 35, 'chequing-a', 'Transfer', 'EX101 TFR-TO C/C',
    { notes: 'card payment: Travel Visa' }),
  tx('travel-payment-credit', '2026-10-20', -35, 'travelvisa', 'Transfer', 'PAYMENT - THANK YOU'),
  tx('studio-oct', '2026-10-22', 89.75, 'chequing-a', 'Utilities', 'Invented studio'),
  // Due October 23. The credit arrives a day later.
  tx('ari-oct-second', '2026-10-24', -1200, 'chequing-a', 'Payroll', 'Invented Ari employer'),
  tx('water-oct', '2026-10-27', 35, 'chequing-a', 'Utilities', 'Invented water'),
  tx('bo-oct-second', '2026-10-28', -630, 'chequing-a', 'Payroll', 'Invented Bo employer'),
  tx('food-oct-second', '2026-10-29', 22, 'chequing-b', 'Groceries', 'Invented market'),
  tx('misc-oct-second', '2026-10-30', 8.2, 'chequing-b', null, 'Invented used books'),
  tx('ari-nov-first', '2026-11-06', -1200, 'chequing-a', 'Payroll', 'Invented Ari employer'),
  tx('food-nov-first', '2026-11-09', 19.35, 'chequing-b', 'Groceries', 'Invented market'),
  tx('misc-nov-first', '2026-11-11', 5.65, 'chequing-b', null, 'Invented cobbler'),
  tx('internet-nov-late', '2026-11-14', 50, 'chequing-a', 'Internet', 'Invented internet'),
  tx('bo-nov-first', '2026-11-16', -630, 'chequing-a', 'Payroll', 'Invented Bo employer'),
  tx('ari-nov-second', '2026-11-20', -1200, 'chequing-a', 'Payroll', 'Invented Ari employer'),
  tx('studio-nov', '2026-11-25', 89.75, 'chequing-a', 'Utilities', 'Invented studio'),
  tx('card-repriced', '2026-11-26', 23.5, 'cashback', 'Groceries', 'Invented deli', { pending: true }),
  tx('card-repriced', '2026-11-27', 26.25, 'cashback', 'Groceries', 'Invented deli'),
  // No posted water payment for November 27.
  tx('bo-nov-second', '2026-11-28', -630, 'chequing-a', 'Payroll', 'Invented Bo employer'),
  tx('misc-nov-second', '2026-11-29', 6.75, 'chequing-b', null, 'Invented key cutter'),
  tx('cashback-payment-debit', '2026-11-30', 26.25, 'chequing-a', 'Transfer', 'EX102 TFR-TO C/C'),
  tx('cashback-payment-credit', '2026-11-30', -26.25, 'cashback', 'Transfer', 'PAYMENT - THANK YOU'),
];

const plan = H.planOf(world);
plan.opening = { asOf: OPENING, representedEvents: [] };
plan.startingCash.breakdown = [
  { id: 'chequing-a', label: 'Invented Bills', value: 1000, evidenceDate: OPENING, confidence: 'confirmed' },
  { id: 'chequing-b', label: 'Invented Weekly', value: 200, evidenceDate: OPENING, confidence: 'confirmed' },
  { id: 'savings', label: 'Invented Reserve', value: 0, evidenceDate: OPENING, confidence: 'confirmed' },
];
plan.cardPurchaseCoverage = { ...emptyCardOpening(START), rule: 'aggregate-per-card-per-pay-period' };
const canonical = H.canonicalOf({ ...world, canonicalAsOf: OPENING }, plan);
const { data } = Live.fromObservation({ data: canonical, payload: H.rawPayload(world),
  accountMap: H.accountMapOf(world), identity: H.identityOf(world) });
const packet = data.liveOverlay.currentPeriodActuals;
assert.equal(data.liveOverlay.applied, true, 'the invented provider opening is served');
const advice = Forecast.recommend(data.plan, AS_OF, { debts: data.debts, currentPeriodActuals: packet, weeklyVariable: 0 });

// Every period gets Ari 1200 + Bo 630 = 1830. For the two months that is
// 4 x 1830 = 7320. The late October credit is Ari's second pay, not extra pay.
// P1 bills 50. P2 early studio 89.75 + water 35 = 124.75. P3 late
// internet 50. P4 studio paid 89.75 + water still due 35 = 124.75 planned.
// P1 groceries 42.50 - 7.50 + 12 = 47; plus Other 9.25 = 56.25.
// P2 groceries 22 + Other 8.20 = 30.20. P3 19.35 + 5.65 = 25.
// P4 use the posted 26.25 once, plus Other 6.75 = 33. Neither funding
// transfer is another purchase. Two-month household spending is 144.45.
const answer = [
  { start: '2026-10-09', income: 1830, billsPlanned: 50, billsPaid: 50, groceries: 47, other: 9.25, spending: 56.25 },
  { start: '2026-10-23', income: 1830, billsPlanned: 124.75, billsPaid: 124.75, groceries: 22, other: 8.2, spending: 30.2 },
  { start: '2026-11-06', income: 1830, billsPlanned: 50, billsPaid: 50, groceries: 19.35, other: 5.65, spending: 25 },
  { start: '2026-11-20', income: 1830, billsPlanned: 124.75, billsPaid: 89.75, groceries: 26.25, other: 6.75, spending: 33 },
];

const selected = [];
for (const row of answer) {
  const matching = advice.payPeriodViews.filter(view => view.start === row.start);
  assert.equal(matching.length, 1, row.start + ' has exactly one Budget period');
  const [view] = matching;
  selected.push(view);
  const progress = view.budgetProgress;
  const amount = category => view.householdBudget.find(item => item.id === category)?.spent;
  assert.deepEqual([progress.income.planned.amount, view.incomeTotal], [row.income, row.income], row.start + ' income plan and headline');
  if (row.start === '2026-10-23') {
    const pay = view.income.find(item => item.id === 'payroll');
    // The unique posted employer credit a day late (Sat Oct 24) settles the
    // Fri Oct 23 payday once at its actual amount: it is Ari's second pay, not
    // Other income, and the period's income is complete (formerly a known gap).
    assert.deepEqual([pay.status, pay.actual, progress.income.actual.amount, progress.income.actual.completeness,
      view.income.filter(item => item.id.startsWith('other-income:')).length],
    ['received', -1200, 1830, 'complete', 0], 'late October pay settles the Oct 23 payday once');
  } else {
    assert.deepEqual([progress.income.actual.amount, progress.income.actual.completeness], [row.income, 'complete'],
      row.start + ' confirmed income');
    assert.equal(view.income.filter(item => item.status === 'received').length, 2, row.start + ' received one pay from each earner');
  }
  assert.deepEqual([progress.bills.planned.amount, progress.bills.actual.amount],
    [row.billsPlanned, row.billsPaid], row.start + ' planned and paid bills');
  assert.deepEqual([amount('groceries'), amount('other-spending'), progress.household.actual.amount],
    [row.groceries, row.other, row.spending], row.start + ' posted household spending by bucket');
  assert.equal(progress.household.actual.completeness, 'complete', row.start + ' spending evidence complete');
}

assert.equal(selected.reduce((sum, view) => sum + view.incomeTotal, 0), 7320, 'four Budget income headlines at 1830');
assert.equal(selected.reduce((sum, view) => sum + Math.round(view.budgetProgress.bills.actual.amount * 100), 0),
  31450, 'paid bills: 50 + 124.75 + 50 + 89.75');
assert.equal(selected.reduce((sum, view) => sum + Math.round(view.budgetProgress.household.actual.amount * 100), 0),
  14445, 'household spending: 56.25 + 30.20 + 25 + 33');
assert.equal(selected[0].bills.some(row => row.id === 'studio'), false, 'early payment does not move the October studio bill into the prior period');
assert.deepEqual(selected[1].bills.filter(row => row.id === 'studio').map(row => [row.date, row.status, row.actual]),
  [['2026-10-25', 'PAID', 89.75]], 'early payment settles the planned October studio bill once');
assert.deepEqual(selected[2].bills.filter(row => row.id === 'internet').map(row => [row.date, row.status, row.actual]),
  [['2026-11-12', 'PAID', 50]], 'late internet payment settles the November occurrence once');
assert.deepEqual(packet.representedActuals.filter(row => ['studio', 'internet'].includes(row.id)).map(row => [row.id, row.date, row.postedOn]),
  [['internet', '2026-10-12', '2026-10-12'], ['studio', '2026-10-25', '2026-10-22'],
    ['internet', '2026-11-12', '2026-11-14'], ['studio', '2026-11-25', '2026-11-25']],
  'the served Budget inputs retain the posting dates separately from the due dates');

const current = selected[3];
const skipped = current.bills.find(row => row.id === 'water');
assert.deepEqual([skipped.date, skipped.status, skipped.remaining, current.budgetProgress.bills.actual.completeness],
  ['2026-11-27', 'still due', 35, 'partial'], 'the skipped bill still needs 35 and earns no paid actual');
assert.equal(current.budgetProgress.household.planned.amount, 100, 'current groceries plan is 100');
assert.equal(current.budgetProgress.household.delta.amount, 67, 'current combined budget: 100 - 33 = 67 left');

assert.deepEqual(packet.transactions.filter(tx => tx.tdCardPaymentIdentity === true)
  .map(tx => [tx.date, tx.cardPaymentNoteDestination ?? null]),
[['2026-10-20', 'travelvisa'], ['2026-11-30', null]], 'the first transfer names its card and the second is unnoted');
const coverage = advice.cardPurchaseCoverage;
assert.equal(coverage.status, 'ready', 'both transfers reconcile to their card credits');
assert.deepEqual(coverage.payments.map(payment => [payment.date, payment.accountLabel, payment.status, payment.amount, payment.backfill]).sort(),
  [['2026-10-20', 'Invented Travel Card', 'reconciled', 35, 35],
    ['2026-11-30', 'Invented Cash Back Card', 'reconciled', 26.25, 26.25]],
  '35 covers 42.50 - 7.50 on Travel. Cash Back covers the repriced 26.25 once.');
assert.equal(coverage.reservedCash, 0, 'each purchase is fully covered after its payment');
assert.equal(Forecast.spendableHouseholdCash(data.plan), 8061.05,
  '7944.25 + 116.80 = 8061.05, also 1200 + 7320 - 314.50 - 144.45');
console.log('Invented two-month Budget answer key checked.');
