'use strict';

// First slice of the invented habits household. Exercise the same ledger across
// four refreshes through the observer and Forecast. Expected amounts come from
// the ledger below, independently of the implementation's totals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = fs.readFileSync;
fs.readFileSync = function (file, ...options) {
  if (typeof file === 'string') {
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join('/').toLowerCase();
    if (relative === 'public/periods.json') return '{"monthly":[]}';
    if (relative === 'data.json' || /^(snapshots|raw|derived)\//.test(relative)) {
      throw new Error('Habits test requires invented data');
    }
  }
  return read.call(this, file, ...options);
};

try {
  const { world } = require('./fixtures/card-coverage-aggregate-world');
  const Forecast = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const Memory = require('../scripts/server-observation-memory');
  const charges = [
    ['card', 80, '2026-09-19', 'purchase', { id: 81001 }],
    ['card', 37, '2026-09-20', 'purchase', { id: 81002, is_pending: true }],
    ['card', 37, '2026-09-21', 'purchase', { id: 81003, pending_transaction_id: 81002 }],
    ['card', 52, '2026-10-03', 'purchase', { id: 81004 }],
    ['card', 31, '2026-10-18', 'purchase', { id: 81005 }],
  ];
  const views = [
    { date: '2026-09-20', start: '2026-09-18', spent: 117, posted: 480 },
    { date: '2026-09-21', start: '2026-09-18', spent: 117, posted: 517 },
    { date: '2026-10-03', start: '2026-10-02', spent: 52, posted: 569 },
    { date: '2026-10-18', start: '2026-10-16', spent: 31, posted: 600 },
  ];

  function observeHeloc(amount, notes, { receipt = false, minimum = true } = {}) {
    const day = '2026-09-20';
    const debit = ['bills', amount, day, 'cash', { id: 81008, payee: 'EF789 TFR-TO 7654321',
      original_name: 'EF789 TFR-TO 7654321', category_name: 'Payment, Transfer', notes }];
    return observe(day, [debit], input => {
      input.data.debts.push({ id: 'heloc', label: 'Invented HELOC', structure: 'Revolving',
        secured: true, balance: 6000, pending: 0, rate: 0, limit: 9000 });
      if (minimum) input.data.plan.obligations.push({ id: 'heloc-minimum', debtId: 'heloc',
        label: 'Invented HELOC interest', effect: 'capitalise', nonCash: true, amount: 20,
        frequency: 'monthly', day: 31, cashDay: 20, cashFirstDue: day, cashPayment: 70,
        cashLabel: 'Invented HELOC minimum', payingAccount: 'chequing-a', confidence: 'confirmed' });
      input.accountMap.mappings.push({ providerAccountId: '3007',
        canonical: { collection: 'debts', id: 'heloc' }, atlasRole: 'heloc' });
      input.payload.accounts.push({ ...input.payload.accounts[3], id: 3007, name: 'Invented HELOC',
        type: 'loan', subtype: 'line_of_credit', balance: 6000 - (receipt ? amount : 0) });
      if (receipt) input.payload.transactions.push({ ...input.payload.transactions[0], id: 81009, account_id: 3007,
        payee: 'EF789 TFR-FR 1111111', original_name: 'EF789 TFR-FR 1111111', amount: -amount, notes: null });
    });
  }

  function observe(day, rows, change = () => {}, memory) {
    const input = world(rows, {
      asOf: day,
      edit(candidate) {
        candidate.identity = { rules: [], billPaymentPayees: [] };
        candidate.payload.categories = [];
        candidate.payload.tags = [];
        candidate.payload.pendingCoverage.truncated = false;
        const posted = rows.filter(row => row[0] === 'card' && row[4]?.is_pending !== true);
        candidate.payload.accounts[3].balance = 400 + posted.reduce((sum, row) => sum + row[1], 0);
        for (const account of candidate.payload.accounts) account.last_fetch = day + 'T17:00:00Z';
        change(candidate);
      },
    });
    let observed = Live.fromObservation(input).data;
    if (memory) {
      const context = 'invented-habits';
      const householdAccountId = 'invented-household';
      const checkedAt = input.payload.fetchedAt;
      memory.publish('invented-latest', { schema: Memory.SCHEMA, payload: input.payload }, {
        context, householdAccountId, lastBudgetAccountId: householdAccountId, credentialSource: 'env',
        data: observed, checkedAt,
      }, undefined, Forecast.cardActivityForDisplay(observed));
      observed = memory.withLastKnownCardActivity(context, householdAccountId, checkedAt, observed);
    }
    const advice = Forecast.recommend(observed.plan, day, Forecast.budgetRecommendInputs(observed));
    return {
      observed, advice,
      period: advice.payPeriodViews.find(view => view.role === 'active'),
      coverage: advice.cardPurchaseCoverage,
    };
  }

  function creditLine(result) {
    return result.period.stackSummary.credit.lines.find(line => line.id === 'travelvisa');
  }

  function spent(result) {
    return creditLine(result).spent.amount;
  }

  for (const view of views) {
    const rows = charges.filter(row => row[2] <= view.date);
    const result = observe(view.date, rows);
    assert.equal(result.period.start, view.start, view.date + ' uses its own pay period');
    assert.equal(result.observed.debts[0].balance, view.posted, view.date + ' observes posted balance');
    assert.equal(spent(result), view.spent, view.date + ' counts one charge across pending and settlement');
    assert.equal(result.period.householdBudget.find(row => row.id === 'groceries').spent, view.spent,
      view.date + ' reconciles independent groceries and card totals');
  }

  // Reuse the same retained-refresh context. Advance the Bills sibling while
  // the card is thin so replaying the prior whole view cannot pass.
  const cashPurchase = ['bills', 12, '2026-09-20', 'purchase', { id: 81006 }];
  const sameDay = charges.slice(0, 2);
  const memory = Memory.create();
  const healthy = observe('2026-09-20', sameDay, () => {}, memory);
  const damaged = input => {
    input.payload.fetchedAt = '2026-09-20T19:00:00Z';
    delete input.payload.accounts[3].last_fetch;
  };
  const thinRows = [...sameDay, cashPurchase];
  const cold = observe('2026-09-20', thinRows, damaged, Memory.create());
  const warm = observe('2026-09-20', thinRows, damaged, memory);
  const newCardCharge = ['card', 11, '2026-09-20', 'purchase', { id: 81007 }];
  const repaired = observe('2026-09-20', [...thinRows, newCardCharge], input => {
    input.payload.fetchedAt = '2026-09-20T20:00:00Z';
  }, memory);

  assert.equal(healthy.period.liveCurrentBalance, 500);
  assert.equal(spent(cold), null, 'cold damaged view has no past amount to display');
  assert.equal(spent(warm), 117, 'warm damaged view keeps the same-period card amount');
  assert.equal(creditLine(warm).spent.trust, 'estimated', 'retained amount earns no stronger trust');
  assert.equal(warm.period.liveCurrentBalance, 488, 'warm view still publishes the newer Bills balance');
  assert.equal(creditLine(warm).activityObservedAt, '2026-09-20T18:00:00Z');
  assert.equal(warm.period.householdBudget.find(row => row.id === 'groceries').spent, 129,
    'independent budget spending includes the fresh Bills purchase');
  assert.deepEqual(warm.advice.currentPeriodAction, cold.advice.currentPeriodAction,
    'the retained figure does not release any new actions');
  assert.deepEqual(warm.advice.paydayAllocation.extraDebt, cold.advice.paydayAllocation.extraDebt,
    'retained card display never drives extra-debt advice');
  assert.equal(spent(repaired), 128, 'a repaired refresh supersedes the held amount');
  assert.equal(creditLine(repaired).activityObservedAt, undefined);

  const noted = observeHeloc(70, 'card payment: HELOC', { receipt: true });
  const { period } = noted;
  // Bank ledger: $500 opening less one $70 debit. The receiving credit
  // reduces HELOC principal by $70 and creates no second Bills movement.
  assert.equal(period.liveCurrentBalance, 430);
  assert.equal(noted.observed.debts.find(debt => debt.id === 'heloc').balance, 5930);
  assert.equal(period.postedBillsAccountMovements.complete, true);
  assert.deepEqual(period.postedBillsAccountMovements.movements.map(row => row.amount), [-70]);
  const paidBack = period.stackSummary.credit.lines.find(line => line.id === 'heloc').paidBack;
  assert.deepEqual([paidBack.amount, paidBack.trust], [70, 'calculated']);
  const bill = noted.advice.currentPeriodAction.bills.filter(row => row.id === 'heloc-minimum');
  assert.equal(bill.length, 1);
  assert.deepEqual([bill[0].actual, bill[0].remaining, bill[0].settlement], [70, 0, 'represented']);
  // Plan ledger: $1,000 payroll minus the $25 card minimum, $70 HELOC
  // minimum and $150 groceries hold. Add $500 for the planned close.
  assert.equal(period.predictedEndingBalance, 755, 'the HELOC payment adds no duplicate transfer deduction');
  assert.equal(period.plannedPeriodClose, 1255);
  assert.equal(period.predictedEndingBalanceTerms.heldOutflowSpending, undefined);
  assert.equal(period.plannedPeriodCloseTerms.heldOutflowSpending, undefined);
  assert.equal(period.heldOutflowsToConfirm, undefined);

  const partial = observeHeloc(50, 'card payment: HELOC (by amount)');
  const partialBill = partial.advice.currentPeriodAction.bills.find(row => row.id === 'heloc-minimum');
  assert.deepEqual([partialBill.actual, partialBill.remaining, partialBill.minimumCoverage.trust], [50, 20, 'estimated']);
  assert.equal(partial.period.predictedEndingBalanceTerms.heldOutflowSpending, undefined);

  const unmatched = observeHeloc(43, null);
  assert.equal(unmatched.advice.currentPeriodAction.bills.find(row => row.id === 'heloc-minimum').remaining, 70);
  assert.equal(unmatched.period.predictedEndingBalanceTerms.heldOutflowSpending, 43);
  assert.deepEqual(unmatched.period.heldOutflowsToConfirm.recon.map(row => row.amount), [43]);
  const conflicting = observeHeloc(43, 'card payment: HELOC\ncard payment: Travel Visa');
  assert.equal(conflicting.period.predictedEndingBalanceTerms.heldOutflowSpending, 43);
  const noMinimum = observeHeloc(70, 'card payment: HELOC', { minimum: false });
  assert.equal(noMinimum.period.predictedEndingBalanceTerms.heldOutflowSpending, 70);

  // The Bills shortfall split follows #1676. A clean card ledger can currently
  // be withheld by a known negative Bills balance. When that fix lands, turn
  // this characterization into the positive independent-publication assertion.
  const noCharges = observe('2026-09-20', []);
  const shortfall = observe('2026-09-20', [], input => {
    input.payload.accounts[0].balance = -4;
  });
  assert.equal(noCharges.coverage.status, 'ready');
  assert.equal(shortfall.period.liveCurrentBalance, -4, 'known bank balance survives');
  assert(shortfall.coverage.issues.some(issue => issue.code === 'coverage-bills-backing-unconfirmed'),
    'Known gap: split a known Bills shortfall from unreadable backing evidence');

  console.log('Habits household: four dates, warm and cold issuer-sync recovery, and the known Bills shortfall gap passed.');
  console.log('Habits household: qualified and unresolved HELOC debits reconcile through Forecast.');
} finally {
  fs.readFileSync = read;
}
