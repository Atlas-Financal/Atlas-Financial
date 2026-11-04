'use strict';

// Budget prerequisite: a carried opening is not the current spending window.
// Synthetic amounts, independently summed over the fixed 14-day calendar.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Assistant = require('../scripts/assistant-packet');

const asOf = '2026-09-30';
const plan = {
  windowDays: 91,
  defaults: { targetBuffer: 0 },
  startingCash: { amount: 10000 },
  opening: { asOf, priorAsOf: '2026-08-19', representedEvents: [] },
  income: [{ id: 'payroll', label: 'Seaspan', frequency: 'biweekly',
    anchor: '2026-08-14', amount: 2000, confidence: 'confirmed' }],
  bills: [{ id: 'older-bill', label: 'Older required bill', frequency: 'once',
    date: '2026-09-10', amount: 75, confidence: 'confirmed' }],
  obligations: [], commitments: [],
  budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
    from: ['Groceries'], plannedPayday: 500 },
  { id: 'fuel', label: 'Fuel', class: 'essential', plannedMonthly: 304.375 }] },
};
const transactions = [
  { date: '2026-08-20', amount: 410, categoryLabel: 'Groceries', accountRole: 'household-cash' },
  { date: '2026-09-24', amount: 140, categoryLabel: 'Groceries', accountRole: 'household-cash' },
  { date: '2026-09-25', amount: 30, categoryLabel: 'Groceries', accountRole: 'household-cash' },
  { date: '2026-09-30', amount: 45, categoryLabel: 'Groceries', accountRole: 'household-cash' },
  { date: '2026-10-01', amount: 90, categoryLabel: 'Groceries', accountRole: 'household-cash' },
].map(tx => Object.assign({ pending: false, displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods' }, tx));
function options(extra) {
  return Object.assign({ debts: [], targetBuffer: 0, weeklyVariable: 0,
    currentPeriodActuals: {
      schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
      coverageStart: '2026-08-19', coverageThrough: asOf,
      pendingCoverage: 'complete', transactionCoverage: 'complete', transactions,
    } }, extra);
}
function checkAction(action) {
  assert.equal(action.periodStart, '2026-09-25', 'current action starts on Seaspan payday, not the 51-day opening');
  assert.equal(action.periodEnd, '2026-10-08', 'cross-month cycle stays whole');
  const groceries = action.categories.find(c => c.id === 'groceries');
  assert.equal(groceries.planned, 500);
  assert.equal(groceries.posted, 30 + 45, 'only current-cycle transactions through as-of count');
  assert.equal(groceries.remaining, 500 - (30 + 45), 'planned and actual compare the same cycle');
  assert.equal(action.categories.find(c => c.id === 'fuel').planned, 14 * 10,
    'monthly targets are scaled to 14 days, never the 51-day opening lookback');
  assert.equal(action.currentShortfall, false, 'older spending cannot fabricate current-cycle overspend');
  assert.equal(action.remainingClaim, 'precise');
  // Correcting the comparison must not release an unresolved earlier bill.
  assert.equal(action.bills.find(b => b.id === 'older-bill').remaining, 75);
}
function checkAllocation(alloc) {
  const groceries = alloc.essentials.items.find(c => c.id === 'groceries');
  const fuel = alloc.essentials.items.find(c => c.id === 'fuel');
  assert.equal(groceries.posted, 30 + 45, 'allocation excludes prior-cycle and future actuals');
  assert.equal(groceries.planned, 500);
  assert.equal(groceries.required, 500 - (30 + 45));
  assert.equal(fuel.planned, 14 * 10, 'allocation monthly scaling uses the same 14 days as action');
  assert.equal(alloc.essentials.allocated, 500 - (30 + 45) + 14 * 10);
  assert.equal(alloc.runningLeftover.afterHouseholdBudget, 10000 - 75 - (425 + 140),
    'posted opening minus earlier bill and remaining consumption is independently $9360');
  assert.equal(alloc.planPeriodStart, '2026-09-25');
  assert.equal(alloc.periodEnd, '2026-10-08');
  assert.equal(alloc.actualsCoverage.remainingClaim, 'precise');
  assert.equal(alloc.obligations.items.find(b => b.id === 'older-bill').allocated, 75);
  assert.equal(alloc.cashBasis.priorAsOf, '2026-08-19', 'cash-opening provenance is not the category window');
}
function assistantPacket(p, opts, day = asOf) {
  return Assistant.buildPacket({
    data: { meta: { asOf: day }, plan: p, debts: [], revolvingExtra: [],
      liveOverlay: { applied: true, effectiveAsOf: day, operatingPlan: 'available',
        currentPeriodActuals: opts.currentPeriodActuals } },
    periods: { asOf: day, periods: { ytd: { months: 1, spending: [] } } },
    questionsMarkdown: '', now: day + 'T19:00:00Z', env: {},
  });
}
function checkPacket(packet) {
  assert.equal(packet.forecast.currentPeriodAction.periodStart, '2026-09-25');
  assert.equal(packet.forecast.currentPeriodAction.remainingClaim, 'precise');
  assert.equal(packet.forecast.currentPeriodAction.essentialRemaining, 425 + 140);
  assert.equal(packet.actuals.currentPeriodCategories.find(c => c.id === 'groceries').remaining, 425);
  assert.equal(packet.actuals.currentPeriodCategories.find(c => c.id === 'fuel').planned, 140);
  assert.equal(packet.forecast.paydayAllocation.essentials.allocated, 425 + 140);
  assert.equal(packet.forecast.paydayAllocation.obligations.allocated, 75);
  assert.equal(packet.forecast.paydayAllocation.runningLeftover.afterHouseholdBudget, 10000 - 75 - 565);
  assert.equal(Assistant.looksSanitized(packet), true);
  assert.equal(packet.writesCanonicalState, false);
}

checkAction(F.currentPeriodAction(plan, asOf, options()));
checkAllocation(F.paydayAllocation(plan, asOf, options()));
const currentOnly = options();
currentOnly.currentPeriodActuals.coverageStart = '2026-09-25';
checkAction(F.currentPeriodAction(plan, asOf, currentOnly));
checkAllocation(F.paydayAllocation(plan, asOf, currentOnly));

const incomplete = options();
incomplete.currentPeriodActuals.coverageStart = '2026-09-26';
const partialAction = F.currentPeriodAction(plan, asOf, incomplete);
assert.equal(partialAction.remainingClaim, 'unavailable');
assert.equal(partialAction.categories.find(c => c.id === 'groceries').posted, null, 'missing cycle coverage stays unknown');

const absent = options({ currentPeriodActuals: null });
assert.equal(F.currentPeriodAction(plan, asOf, absent).categories.find(c => c.id === 'groceries').remaining, null);

const advice = F.recommend(plan, asOf, options());
checkAction(advice.currentPeriodAction);
checkAllocation(advice.paydayAllocation);
checkPacket(assistantPacket(plan, options()));
const currentAdvice = F.recommend(plan, asOf, currentOnly);
checkAction(currentAdvice.currentPeriodAction);
checkAllocation(currentAdvice.paydayAllocation);
checkPacket(assistantPacket(plan, currentOnly));

const groceryOnly = JSON.parse(JSON.stringify(plan));
groceryOnly.budget.categories = groceryOnly.budget.categories.filter(c => c.id === 'groceries');
const groceryAdvice = F.recommend(groceryOnly, asOf, options());
assert.equal(groceryAdvice.currentPeriodAction.categories.find(c => c.id === 'groceries').remaining, 500 - 75);
assert.equal(groceryAdvice.paydayAllocation.essentials.allocated, 500 - 75,
  'without fuel, the old comparison overstated leftover by the full $425 grocery hold');
assert.equal(groceryAdvice.paydayAllocation.runningLeftover.afterHouseholdBudget, 10000 - 75 - 425);

// Missing/stale/partial coverage does not invent actuals, nor release old bills.
for (const opts of [incomplete, absent, (() => {
  const o = options(); o.currentPeriodActuals.coverageThrough = '2026-09-29'; return o;
})()]) {
  const rec = F.recommend(plan, asOf, opts);
  assert.equal(rec.currentPeriodAction.remainingClaim, 'unavailable');
  assert.equal(rec.paydayAllocation.actualsCoverage.remainingClaim, 'unavailable');
  assert.equal(rec.paydayAllocation.essentials.items.find(c => c.id === 'groceries').posted, null);
  assert.equal(rec.paydayAllocation.obligations.items.find(b => b.id === 'older-bill').allocated, 75);
  const packet = assistantPacket(plan, opts);
  assert.equal(packet.forecast.currentPeriodAction.remainingClaim, 'unavailable');
  assert.equal(packet.forecast.currentPeriodAction.essentialRemaining, null);
  assert.equal(packet.actuals.currentPeriodCategories.find(c => c.id === 'groceries').posted, null);
  assert.equal(packet.forecast.paydayAllocation.obligations.allocated, 75);
}
const postedOnly = options();
postedOnly.currentPeriodActuals.pendingCoverage = 'unknown';
const postedAdvice = F.recommend(plan, asOf, postedOnly);
assert.equal(postedAdvice.currentPeriodAction.remainingClaim, 'posted-only');
assert.equal(postedAdvice.paydayAllocation.actualsCoverage.remainingClaim, 'posted-only');
assert.equal(postedAdvice.paydayAllocation.essentials.allocated, 425 + 140);
assert.equal(postedAdvice.paydayAllocation.runningLeftover.afterHouseholdBudget, 9360);

// A debit from an earlier cycle still promises today's cash to the merchant.
// It is not this cycle's consumption and must not be freed by the new origin.
for (const coverageStart of ['2026-08-19', '2026-09-25', '2026-09-26']) {
  const opts = options();
  opts.currentPeriodActuals.coverageStart = coverageStart;
  opts.currentPeriodActuals.transactions = transactions.concat([
    Object.assign({}, transactions[0], { date: '2026-09-24', amount: 300, pending: true }),
  ]);
  const rec = F.recommend(plan, asOf, opts);
  if (coverageStart !== '2026-09-26') checkAllocation(rec.paydayAllocation);
  assert.ok(rec.paydayAllocation.protectedPath.allocated >= 300, 'prior unresolved cash debit remains protected');
  assert.ok(rec.paydayAllocation.movable <= rec.paydayAllocation.runningLeftover.afterHouseholdBudget - 300,
    'the same pending principal cannot be released as movable cash');
  assert.equal(rec.paydayAllocation.obligations.items.find(b => b.id === 'older-bill').allocated, 75);
}
const pendingNow = options();
pendingNow.currentPeriodActuals.transactions = transactions.concat([
  Object.assign({}, transactions[0], { date: '2026-09-24', amount: 300, pending: true }),
  Object.assign({}, transactions[2], { date: '2026-09-29', amount: 20, pending: true }),
]);
const pendingAdvice = F.recommend(plan, asOf, pendingNow);
assert.equal(pendingAdvice.currentPeriodAction.categories.find(c => c.id === 'groceries').pending, 20);
assert.equal(pendingAdvice.paydayAllocation.essentials.items.find(c => c.id === 'groceries').pending, 20);
assert.equal(pendingAdvice.paydayAllocation.essentials.allocated, 500 - 75 - 20 + 140);
assert.equal(pendingAdvice.paydayAllocation.runningLeftover.afterHouseholdBudget, 10000 - 75 - 545);
assert.ok(pendingAdvice.paydayAllocation.protectedPath.allocated >= 300 + 20);
assert.ok(pendingAdvice.paydayAllocation.movable <= 9380 - (300 + 20));

// Cycle transitions stay aligned across both month and year boundaries.
for (const [day, start, end] of [
  ['2026-10-09', '2026-10-09', '2026-10-22'],
  ['2026-10-14', '2026-10-09', '2026-10-22'],
  ['2027-01-03', '2027-01-01', '2027-01-14'],
]) {
  const p = JSON.parse(JSON.stringify(plan));
  p.opening.asOf = day;
  const opts = options();
  opts.currentPeriodActuals.observationAsOf = day;
  opts.currentPeriodActuals.coverageThrough = day;
  const action = F.currentPeriodAction(p, day, opts);
  assert.equal(action.periodStart, start);
  assert.equal(action.periodEnd, end);
  assert.equal(action.categories.find(c => c.id === 'fuel').planned, 140);
  const expectedSpend = transactions.filter(tx => tx.date >= start && tx.date <= day)
    .reduce((sum, tx) => sum + tx.amount, 0);
  assert.equal(action.categories.find(c => c.id === 'groceries').posted, expectedSpend);
  const allocation = F.paydayAllocation(p, day, opts);
  assert.equal(allocation.planPeriodStart, start);
  assert.equal(allocation.essentials.items.find(c => c.id === 'fuel').planned, 140);
  assert.equal(allocation.essentials.items.find(c => c.id === 'groceries').posted, expectedSpend);
}

const over = options();
over.currentPeriodActuals.transactions = [Object.assign({}, transactions[2], { amount: 600 })];
const overAction = F.currentPeriodAction(plan, asOf, over);
assert.equal(overAction.categories.find(c => c.id === 'groceries').remaining, 500 - 600);
assert.equal(overAction.currentShortfall, true, 'real current-cycle overspending remains a shortfall');

console.log('PASS current-cycle actuals use the same 14-day window as payday targets');
