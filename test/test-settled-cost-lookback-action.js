'use strict';

// Invented amounts: settlement satisfies a requirement, without asserting a
// bank transaction or changing the correctly protected current cash walk.
const assert = require('node:assert/strict');
const F = require('../public/forecast');
const Assistant = require('../scripts/assistant-packet');
const asOf = '2026-08-20';
function fixture() {
  return { meta: { asOf }, debts: [], revolvingExtra: [], plan: {
    windowDays: 42, defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
    opening: { asOf, priorAsOf: '2026-08-14',
      representedEvents: [{ id: 'represented-bill', date: '2026-08-17' }] },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 5000 }] },
    income: [{ id: 'payroll', label: 'Seaspan synthetic', amount: 1000,
      frequency: 'biweekly', anchor: '2026-08-14', confidence: 'confirmed' }],
    bills: [{ id: 'represented-bill', label: 'Represented bill', amount: 80,
      frequency: 'once', date: '2026-08-17', confidence: 'confirmed' },
    { id: 'unresolved-bill', label: 'Unresolved bill', amount: 90,
      frequency: 'once', date: '2026-08-18', confidence: 'confirmed' }],
    obligations: [], budget: { categories: [{ id: 'groceries', label: 'Groceries',
      class: 'essential', from: ['Groceries'], plannedPayday: 300 }] },
    commitments: [
      { id: 'settled-cost', date: '2026-08-16', amount: 40, settledOn: '2026-08-17' },
      { id: 'settled-today', date: asOf, amount: 55, settledOn: asOf },
      { id: 'prepaid-cost', date: '2026-08-25', amount: 65, settledOn: '2026-08-19' },
      { id: 'unresolved-sibling', date: '2026-08-16', amount: 75 },
      { id: 'future-settlement', date: '2026-08-16', amount: 90, settledOn: '2026-08-22' },
      { id: 'invalid-settlement', date: '2026-08-18', amount: 30, settledOn: 'not-a-date' },
      { id: 'upcoming-sibling', date: '2026-08-25', amount: 60 },
    ].map(c => Object.assign({ label: c.id, confidence: 'confirmed' }, c)),
  } };
}
function opts() {
  return { debts: [], targetBuffer: 0, currentPeriodActuals: {
    schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
    coverageStart: '2026-08-14', coverageThrough: asOf, pendingCoverage: 'complete', transactionCoverage: 'complete',
    representedActuals: [{ id: 'represented-bill', date: '2026-08-17', actual: 80 }],
    transactions: [{ id: 'synthetic-spend', date: '2026-08-19', amount: 50,
      categoryLabel: 'Groceries', account: 'chequing-a', accountRole: 'household-cash',
      displayedPayee: 'Save-On-Foods', originalMerchant: 'Save-On-Foods',
      pending: false }],
  } };
}
const satisfied = ['settled-cost', 'settled-today', 'prepaid-cost'];
const remaining = ['unresolved-sibling', 'future-settlement', 'invalid-settlement', 'upcoming-sibling'];
function checkBills(bills) {
  for (const id of satisfied) assert.equal(bills.some(b => b.id === id), false,
    id + ' is already satisfied at financial as-of, despite the earlier lookback');
  for (const id of remaining) assert.ok(bills.some(b => b.id === id), id + ' remains required');
  const commitmentRows = bills.filter(b => remaining.includes(b.id));
  // Separate method: only the four unsatisfied requirements contribute.
  assert.equal(commitmentRows.reduce((s, b) => s + b.remaining, 0), 75 + 90 + 30 + 60);
  for (const id of remaining.slice(0, 3)) {
    assert.equal(bills.find(b => b.id === id).settlement, 'unverified');
  }
  assert.equal(bills.find(b => b.id === 'upcoming-sibling').settlement, 'upcoming');
  assert.equal(bills.find(b => b.id === 'unresolved-bill').remaining, 90);
  assert.equal(bills.find(b => b.id === 'represented-bill').settlement, 'represented');
  assert.equal(bills.find(b => b.id === 'represented-bill').remaining, 0);
  assert.equal(bills.reduce((s, b) => s + b.remaining, 0), 75 + 90 + 30 + 60 + 90);
}
function checkCash(plan, options) {
  const events = F.expandEvents(plan, asOf, '2026-08-27', options);
  for (const id of satisfied) assert.equal(events.some(e => e.id === id), false);
  const obligations = events.filter(e => remaining.includes(e.id) || e.id === 'unresolved-bill');
  assert.equal(obligations.reduce((s, e) => s - e.amount, 0), 75 + 90 + 30 + 60 + 90);
  const alloc = F.paydayAllocation(plan, asOf, options);
  assert.equal(alloc.obligations.allocated, 75 + 90 + 30 + 60 + 90);
  assert.equal(alloc.essentials.allocated, 300 - 50);
  assert.equal(alloc.runningLeftover.afterHouseholdBudget,
    5000 - (75 + 90 + 30 + 60 + 90) - (300 - 50));
}
const data = fixture();
const original = JSON.stringify(data);
checkBills(F.currentPeriodAction(data.plan, asOf, opts()).bills);
checkBills(F.currentPeriodObligationStates(data.plan, asOf, opts()).bills);
checkCash(data.plan, opts());
const advice = F.recommend(data.plan, asOf, opts());
checkBills(advice.currentPeriodAction.bills);
assert.equal(advice.paydayAllocation.runningLeftover.afterHouseholdBudget, 4405);
const packet = Assistant.buildPacket({ data: Object.assign({}, data, {
  liveOverlay: { applied: true, effectiveAsOf: asOf, operatingPlan: 'available',
    currentPeriodActuals: opts().currentPeriodActuals },
}), periods: { asOf, periods: { ytd: { months: 1, spending: [] } } },
questionsMarkdown: '', now: asOf + 'T19:00:00Z', env: {} });
checkBills(packet.forecast.currentPeriodAction.bills);
assert.equal(packet.forecast.paydayAllocation.runningLeftover.afterHouseholdBudget, 4405);
assert.equal(packet.writesCanonicalState, false);
assert.equal(Assistant.looksSanitized(packet), true);
assert.equal(JSON.stringify(data), original, 'history and input settlement remain untouched');

// Missing, malformed, and later settlement do not erase a requirement.
for (const settledOn of [undefined, null, '', 0, 42, 'not-a-date',
  '2026-08-19T00:00:00Z', '2026-08-21']) {
  const d = fixture(); d.plan.commitments[0].settledOn = settledOn;
  const row = F.currentPeriodAction(d.plan, asOf, opts()).bills.find(b => b.id === 'settled-cost');
  assert.equal(row.remaining, 40);
  assert.equal(row.settlement, 'unverified');
  assert.equal(F.paydayAllocation(d.plan, asOf, opts()).obligations.allocated, 345 + 40);
}
const noPrior = fixture(); delete noPrior.plan.opening.priorAsOf;
const noPriorBills = F.currentPeriodAction(noPrior.plan, asOf, opts()).bills;
for (const id of satisfied) assert.equal(noPriorBills.some(b => b.id === id), false);
assert.equal(noPriorBills.find(b => b.id === 'upcoming-sibling').remaining, 60);
const disabled = F.currentPeriodAction(data.plan, asOf,
  Object.assign(opts(), { disabled: ['unresolved-sibling'] }));
assert.equal(disabled.bills.some(b => b.id === 'unresolved-sibling'), false);
assert.equal(F.paydayAllocation(data.plan, asOf,
  Object.assign(opts(), { disabled: ['unresolved-sibling'] })).obligations.allocated, 345 - 75);
console.log('PASS settled-cost action lookback: independent remaining/cash arithmetic, current/recommend/assistant publications, siblings and invalid/future settlement controls; no history mutation');
