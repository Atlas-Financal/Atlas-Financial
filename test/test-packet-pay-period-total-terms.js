'use strict';
// The assistant packet's pay-period totals reconcile to the cent from their
// published terms. `node test/test-packet-pay-period-total-terms.js`
//
// forecast.payPeriodTotals carries, for the current pay period and the next
// two, Balance After Deductions, the Stack surplus and the Bills ending
// balance, each with the terms Forecast already computed for it. The packet
// adds no calculation. A reader rebuilds every total from its terms with the
// formulas written out below, in this file, not read from the packet:
//   Balance After Deductions = periodIncome - assignedBills - householdBudgetHold
//     - savingsItemSpending - heldOutflowSpending - manualCardPaymentBeyondMinimum
//   Stack surplus = income - bills - household - mortgage - credit - savingsItemSpending
//   Bills ending balance = observedCash + futureIncome - remainingBills
//     - householdRemaining - otherOutflows - additionalCardCash
// An absent term is 0.
//
// Failure it detects: a published total a reader cannot rebuild from its
// terms; a live adjustment (held outflows, linked savings spending, a manual
// card payment beyond the minimum) left out of the terms; a figure more
// certain than the lead's ruling allows (new rows at most 'estimated'); the
// Bills ending balance published under an unconfirmed card payment; the
// current period's total disagreeing with forecast.predictedEndingBalance.
// Release decision: any failure blocks.
//
// Invented worlds only (test/acceptance/harness.js and
// test/fixtures/card-coverage-aggregate-world.js). Every amount is written by
// hand. No household figure enters.
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const Live = require('../scripts/live-plan.js');
const Assistant = require('../scripts/assistant-packet.js');
const { world: cardWorld } = require('./fixtures/card-coverage-aggregate-world');

const cents = n => Math.round(Number(n) * 100);
const t = (terms, k) => cents(terms[k] || 0);
const READER = {
  balanceAfterDeductions: x => t(x, 'periodIncome') - t(x, 'assignedBills') - t(x, 'householdBudgetHold')
    - t(x, 'savingsItemSpending') - t(x, 'heldOutflowSpending') - t(x, 'manualCardPaymentBeyondMinimum'),
  stackSurplus: x => t(x, 'income') - t(x, 'bills') - t(x, 'household') - t(x, 'mortgage') - t(x, 'credit')
    - t(x, 'savingsItemSpending'),
  billsEndingBalance: x => t(x, 'observedCash') + t(x, 'futureIncome') - t(x, 'remainingBills')
    - t(x, 'householdRemaining') - t(x, 'otherOutflows') - t(x, 'additionalCardCash'),
};

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }

// The harness household: pay 1,400 on Oct 9, Groceries 300 + Eating out 100
// (hold 400), as of Oct 14. Optional: a 400 debit in a Mortgage category with
// no mortgage bill (held To confirm), and a 200 debit in a category linked to
// a Savings item (linked savings spending).
const MORTGAGE = 116;
function householdWorld({ held = false, item = false } = {}) {
  const w = H.baseWorld();
  w.categories.push({ id: MORTGAGE, name: 'Mortgage' });
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })];
  if (held) w.transactions.push(H.lm({ date: '2026-10-12', amount: 400, category: MORTGAGE, account: 'chequing-a', payee: 'Invented lender' }));
  if (item) {
    w.commitments = [{ id: 'trip', label: 'Invented trip', date: '2026-11-20', amount: 600, confidence: 'confirmed', sinkingFund: true }];
    w.savingsPool = { value: 1000 };
    w.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: 'trip' }, occurrenceDate: '2026-11-20',
      effectiveFrom: '2026-09-01', effectiveThrough: '2026-12-31' }];
    w.transactions.push(H.lm({ date: '2026-10-12', amount: 200, category: 106, account: 'chequing-a', payee: 'Invented outfitter' }));
  }
  return w;
}
const packetOfHousehold = w => Assistant.buildPacket({ data: H.dataOf(w).data, periods: null, questionsMarkdown: '' });
const packetOfCard = (rows, opts) => Assistant.buildPacket({
  data: Live.fromObservation(cardWorld(rows, opts)).data, periods: null, questionsMarkdown: '' });
const MBNA = { card: 'mbna', payDownOnly: ['mbna', 'triangle'] };
const totals = p => p.forecast.payPeriodTotals;

// Every published figure in every period rebuilds from its own terms, carries
// at most 'estimated', and every withheld one names a reason.
function reconciles(p) {
  const section = totals(p);
  assert.equal(section.status, 'ok');
  assert.equal(section.source, 'Forecast.payPeriodViews');
  assert.deepEqual(section.periods.map(row => row.offset), [0, 1, 2], 'the current and the next two pay periods');
  let published = 0;
  for (const period of section.periods) {
    for (const key of Object.keys(READER)) {
      const fig = period[key];
      if (fig.status !== 'ok') { assert.ok(typeof fig.reason === 'string' && fig.reason, `${key} withheld with a reason`); continue; }
      published++;
      assert.equal(READER[key](fig.terms), cents(fig.amount), `offset ${period.offset} ${key} rebuilds from its terms to the cent`);
      assert.equal(fig.trust, 'estimated', `offset ${period.offset} ${key} is at most estimated`);
    }
  }
  assert.ok(published >= 7, 'the check reached the published figures');
  assert.ok(!/"trust":"calculated"/.test(JSON.stringify(section)), 'no new row reads calculated');
  return section;
}

console.log('=== packet pay-period totals: every total rebuilds from its published terms ===');

check('control household: three periods, each total from income, bills and the household budget', () => {
  const p = packetOfHousehold(householdWorld());
  const s = reconciles(p);
  const [now, next, after] = s.periods;
  assert.deepEqual([now.role, now.periodStart, now.periodEnd, now.projected], ['current', '2026-10-09', '2026-10-22', false]);
  assert.deepEqual([next.role, next.periodStart, next.projected], ['next', '2026-10-23', true]);
  assert.deepEqual([after.periodStart, after.projected], ['2026-11-06', true]);
  // 1,400 - 0 - 400 = 1,000 in each period.
  for (const period of s.periods) {
    assert.equal(period.balanceAfterDeductions.amount, 1000);
    assert.deepEqual(period.balanceAfterDeductions.terms, { periodIncome: 1400, assignedBills: 0, householdBudgetHold: 400 });
    assert.equal(period.stackSurplus.amount, 1000);
  }
  // Forecast publishes the Bills ending balance for the current period only.
  assert.equal(now.billsEndingBalance.status, 'ok');
  for (const period of [next, after]) {
    assert.deepEqual(period.billsEndingBalance, { status: 'unavailable', reason: 'bills-ending-balance-current-period-only' });
  }
  // One figure, one home: the current period's total is the packet's own
  // forecast.predictedEndingBalance (only its tag is capped here).
  assert.equal(p.forecast.predictedEndingBalance.amount, now.balanceAfterDeductions.amount);
});

check('held outflows and linked savings spending are named terms of the current period', () => {
  const s = reconciles(packetOfHousehold(householdWorld({ held: true, item: true })));
  const bad = s.periods[0].balanceAfterDeductions;
  // 1,400 - 0 - 400 - 200 (linked savings) - 400 (held To confirm) = 400.
  assert.equal(bad.amount, 400);
  assert.deepEqual(bad.terms, { periodIncome: 1400, assignedBills: 0, householdBudgetHold: 400,
    savingsItemSpending: 200, heldOutflowSpending: 400 });
  // The surplus subtracts the linked savings spending but not the held
  // outflow (owner rule): 1,400 - 400 - 200 = 800, which is 400 + 400.
  const surplus = s.periods[0].stackSurplus;
  assert.equal(surplus.amount, 800);
  assert.deepEqual(surplus.terms, { income: 1400, bills: 0, household: 400, mortgage: 0, credit: 0, savingsItemSpending: 200 });
  // Bills ending balance: 2,000 observed - 400 household still to come = 1,600.
  const ending = s.periods[0].billsEndingBalance;
  assert.equal(ending.amount, 1600);
  assert.deepEqual(ending.terms, { observedCash: 2000, futureIncome: 0, remainingBills: 0, householdRemaining: 400,
    otherOutflows: 0, additionalCardCash: 0 });
});

check('a manual card payment beyond the minimum is its own term', () => {
  const pay = amount => ['bills', amount, null, 'cash', { payee: 'MBNA M/C', category_name: 'DEBT&PAYMENTS' }];
  const p = packetOfCard([pay(60)], MBNA);
  const s = reconciles(p);
  const bad = s.periods[0].balanceAfterDeductions;
  // 1,000 - 25 (the minimum) - 150 (groceries) - 35 (paid beyond it) = 790.
  assert.equal(bad.amount, 790);
  assert.deepEqual(bad.terms, { periodIncome: 1000, assignedBills: 25, householdBudgetHold: 150, manualCardPaymentBeyondMinimum: 35 });
  // The surplus does not subtract the payment beyond the minimum (owner
  // rule): 1,000 - 150 - 25 = 825, which is 790 + 35.
  assert.equal(s.periods[0].stackSurplus.amount, 825);
  assert.deepEqual(s.periods[0].stackSurplus.terms, { income: 1000, bills: 0, household: 150, mortgage: 0, credit: 25 });
  assert.equal(p.forecast.predictedEndingBalance.amount, 790);
});

check('an unconfirmed card payment withholds the Bills ending balance, with the disclosure', () => {
  const purchase = ['card', 80, null, 'purchase'];
  const unconfirmedLeg = ['bills', 105, null, 'cash', { payee: 'AB123 TFR-TO C/C', original_name: 'AB123 TFR-TO C/C', category_name: 'Transfer' }];
  const s = totals(packetOfCard([purchase, unconfirmedLeg]));
  assert.equal(s.status, 'ok');
  assert.equal(s.trust, 'estimated');
  assert.equal(s.cardCoverageEstimate.basis, 'card-payment-destination-unconfirmed');
  const ending = s.periods[0].billsEndingBalance;
  assert.equal(ending.status, 'unavailable');
  assert.equal(ending.source, 'Forecast.billsAccountPeriodBalance');
  assert.equal(ending.cardCoverageEstimate.basis, 'card-payment-destination-unconfirmed');
  assert.ok(!('amount' in ending) && !('terms' in ending), 'no amount and no terms');
  // The other totals stay published, estimated, and still rebuild.
  for (const period of s.periods) {
    for (const key of ['balanceAfterDeductions', 'stackSurplus']) {
      const fig = period[key];
      assert.equal(fig.status, 'ok');
      assert.equal(fig.trust, 'estimated');
      assert.equal(READER[key](fig.terms), cents(fig.amount));
    }
  }
});

console.log(`packet pay-period total terms: ${passed} checks passed`);
