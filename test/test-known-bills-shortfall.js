'use strict';

// Invented receipts through the normal observer and Budget recommendation.
// The card reserve and the Bills ledger balance are reconciled independently.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const periodsPath = path.resolve(__dirname, '../public/periods.json');
const dataPath = path.resolve(__dirname, '../data.json');
const read = fs.readFileSync;
fs.readFileSync = function (file, ...opts) {
  const absolute = typeof file === 'string' ? path.resolve(file) : file;
  if (absolute === periodsPath) return '{"monthly":[]}';
  if (absolute === dataPath) throw new Error('This test uses invented observations');
  return read.call(this, file, ...opts);
};

try {
  const Forecast = require('../public/forecast');
  const Live = require('../scripts/live-plan');
  const Refresh = require('../scripts/refresh-trust');
  const History = require('../scripts/private-period-history');
  const Assistant = require('../scripts/assistant-packet');
  const { world } = require('./fixtures/card-coverage-aggregate-world');

  function scenario(balance, charges, {
    editBills = rows => rows, editObservation = observation => observation, editInput = () => {}, extraRows = [], reserveSavings = false,
  } = {}) {
    const rows = charges ? [['card', charges, null, 'purchase']] : [];
    const input = world([...rows, ...extraRows], { reserveSavings, edit(candidate) {
      candidate.identity = { rules: [], billPaymentPayees: [] };
      candidate.payload.accounts[0].balance = balance;
      for (const account of candidate.payload.accounts) {
        account.last_fetch = candidate.asOf + 'T17:00:00Z';
      }
      editInput(candidate);
    } });
    const { data, report } = Live.fromObservation(input);
    const cash = data.plan.startingCash;
    cash.breakdown = editBills(cash.breakdown);
    data.liveOverlay.observedCash = editObservation(data.liveOverlay.observedCash);
    const advice = Forecast.recommend(data.plan, input.asOf, Forecast.budgetRecommendInputs(data));
    const active = advice.payPeriodViews.find(view => view.role === 'active');
    return { coverage: advice.cardPurchaseCoverage, active, advice, data, report, input };
  }

  const controls = [
    ['missing', rows => rows.filter(row => row.id !== 'chequing-a')],
    ['duplicated', rows => rows.concat(rows.find(row => row.id === 'chequing-a'))],
    ['unknown', rows => rows.map(row => row.id === 'chequing-a' ? { ...row, unknown: true } : row)],
    ['nonfinite', rows => rows.map(row => row.id === 'chequing-a' ? { ...row, value: Infinity } : row)],
  ];
  for (const [name, edit] of controls) {
    const refused = scenario(5, 10, { editBills: edit });
    assert.equal(refused.coverage.status, 'unavailable', name + ' backing fails closed');
    assert.equal(refused.coverage.reservedCash, null);
    assert.equal(refused.active.fromTodayFunding.availableNow, null);
    assert(refused.coverage.issues.some(row => row.code === 'coverage-bills-backing-unconfirmed'));
  }
  // A finite figure in the plan does not make a stale, missing or conflicting
  // bank observation safe to use as the basis of a current funding result.
  const evidenceControls = [
    ['missing', () => null],
    ['incomplete', observation => ({ ...observation, complete: false })],
    ['stale', observation => ({
      ...observation,
      accounts: observation.accounts.map(row => row.id === 'chequing-a' ? { ...row, evidenceDate: '2026-09-19' } : row),
    })],
    ['duplicate Bills', observation => ({
      ...observation, accounts: [...observation.accounts, observation.accounts.find(row => row.id === 'chequing-a')],
    })],
    ['estimated Bills', observation => ({
      ...observation,
      accounts: observation.accounts.map(row => row.id === 'chequing-a' ? { ...row, confidence: 'estimated' } : row),
    })],
    ['conflicting', observation => ({
      ...observation,
      accounts: observation.accounts.map(row => row.id === 'chequing-a' ? { ...row, value: 4 } : row),
    })],
  ];
  for (const [name, edit] of evidenceControls) {
    const refused = scenario(5, 10, { editObservation: edit });
    assert.equal(refused.coverage.status, 'unavailable', name + ' bank evidence cannot qualify the shortfall');
    assert.equal(refused.active.fromTodayFunding.availableNow, null, name + ' evidence creates no available cash');
  }
  const ambiguous = scenario(5, 10, { extraRows: [['bills', 20, null, 'cash']] });
  assert.equal(ambiguous.coverage.status, 'unavailable', 'an unrelated unconfirmed payment still holds coverage');
  assert(ambiguous.coverage.issues.some(row => row.code === 'coverage-payment-destination-unconfirmed'));
  assert.equal(ambiguous.active.fromTodayFunding.availableNow, null);

  const legacy = scenario(5, 10, { editInput(input) { delete input.data.plan.cardPurchaseCoverage.rule; } });
  assert.equal(legacy.coverage.status, 'unavailable', 'explicit-record coverage keeps its gate');
  assert(legacy.coverage.issues.some(row => row.code === 'coverage-bills-backing-unconfirmed'));

  const noCharges = scenario(12, 0);
  const enough = scenario(12, 10);
  assert.equal(enough.coverage.status, 'ready');
  assert.equal(enough.coverage.reservedCash, 10);
  assert.equal(enough.coverage.estimateBasis, undefined, 'a sufficient balance clears the shortfall');
  assert.equal(Refresh.fromIncumbent(enough).exactFiguresAvailable, true);
  for (const [balance, reserve] of [[-4, 0], [5, 10]]) {
    const observed = scenario(balance, reserve);
    assert.equal(observed.active.liveCurrentBalance, balance, 'posted Bills cash remains independently visible');
    assert.equal(observed.coverage.status, 'ready', 'known Bills shortfall keeps qualified card coverage visible');
    assert.equal(observed.coverage.reservedCash, reserve, 'full uncovered reserve remains set aside');
    assert.equal(observed.coverage.trust, 'estimated', 'amounts derived from the shortfall stay conservative');
    assert.equal(observed.coverage.estimateBasis, 'card-bills-backing-shortfall');
    assert.deepEqual(observed.coverage.issues, []);
    assert.equal(observed.coverage.toConfirm, undefined, 'a known stock gap is not a transaction to confirm');

    const { advice, active, input, report } = observed;
    const funding = active.fromTodayFunding;
    assert.equal(funding.availableNow, 0, 'no available cash is invented');
    // The purchase is already inside the groceries reserve. It enters the Bills floor once.
    assert.equal(active.billsAccountPeriodBalance.amount, balance - 25 - 150);
    assert.equal(active.billsAccountPeriodBalance.household.requiredCashFloor, reserve);
    assert.equal(active.billsAccountPeriodBalance.additionalCardCash, 0);
    assert.equal(active.billsAccountPeriodBalance.trust, 'estimated');
    assert.equal(active.billsAccountPeriodBalance.grantsSpendPermission, false);
    assert.equal(active.plannedPeriodCloseTrust, 'estimated');
    assert(active.plannedPeriodCloseReason.includes(observed.coverage.estimateReason));
    assert.equal(funding.contribution, null);
    assert.equal(funding.estimateCause, undefined);
    assert.equal(advice.paydayShellEstimateCause?.available, undefined);
    assert.equal(advice.paydayShellEstimateCause?.household, undefined);
    assert.equal(funding.cashAfterProposal, null);
    assert(funding.periods.every(period => period.status === 'unavailable' && period.contribution === null));
    assert.equal(advice.planSpendPaydayFunding.status, 'unavailable');
    assert.equal(advice.paydayAllocation.extraDebt.allocated, null);
    assert.equal(advice.paydayAllocation.extraDebt.absorbable, null);
    assert.equal(advice.weekly, null);
    assert.equal(advice.sim.endingSurplus, null);
    assert.equal(advice.sim.extraDebtCapacity, null);
    assert.equal(advice.currentPeriodAction.spendPermission, null);
    assert.equal(advice.currentPeriodAction.moneyMovementRequired, null);
    assert.equal(advice.currentPeriodAction.noMovementToday, null);
    assert.deepEqual(advice.currentPeriodAction.todayActions, []);
    assert(advice.currentPeriodAction.bills.some(bill => bill.id === 'travel' && bill.remaining === 25),
      'the scheduled minimum is still an independent fact');

    // The card purchase, Budget and Credit offset reconcile without using the
    // Bills shortfall or available cash. The waterfall keeps the same terms.
    const stack = active.stackSummary;
    const cardSpent = view => view.stackSummary.credit.lines.find(row => row.id === 'travelvisa').spent.amount;
    assert.equal(cardSpent(active), reserve > 0 ? reserve : cardSpent(noCharges.active));
    assert.equal(active.householdBudget.find(row => row.id === 'groceries').spent, reserve);
    assert.equal(stack.surplus.amount, 1000 - 150 - (25 - reserve));
    const page = { URLSearchParams, location: { search: '?view=classic' },
      document: { addEventListener() {}, getElementById() { return null; } } };
    page.window = page;
    vm.createContext(page);
    for (const asset of ['stack-shell.js', 'stack-waterfall.js']) {
      vm.runInContext(read(path.join(__dirname, '../public', asset), 'utf8'), page);
    }
    const html = page.StackWaterfall.html({
      data: observed.data, plan: observed.data.plan, recommendation: advice, selectedPeriodKey: active.start,
    }, { creditOpen: true });
    assert(html.includes('$' + stack.surplus.amount), 'the real Stack renders the independent surplus');
    assert(!html.includes('card-bills-backing-shortfall'), 'the internal reason is not a page label');

    assert.equal(Refresh.fromIncumbent(observed).exactFiguresAvailable, false);
    const history = History.sourceCompletenessFor({
      period: active, fetchedAt: input.payload.fetchedAt, transactionWindow: input.payload.transactionWindow,
      pendingCoverage: input.payload.pendingCoverage, report, publication: active,
    });
    assert.equal(history.status, 'incomplete');
    assert(history.reasons.includes('publication:card-bills-backing-shortfall'));
  }
  const outsideBills = scenario(5, 10, {
    reserveSavings: true,
    editInput(input) {
      input.payload.accounts[1].balance = 3000;
      input.data.plan.startingCash.breakdown[0].value = 5;
      input.data.plan.startingCash.breakdown[1].value = 3000;
    },
  });
  assert.equal(outsideBills.coverage.reservedCash, 10);
  assert.equal(outsideBills.coverage.estimateBasis, 'card-bills-backing-shortfall');
  assert.equal(outsideBills.advice.savingsFunding.backing.status, 'ready');
  assert.equal(outsideBills.advice.savingsFunding.period.reason, outsideBills.coverage.estimateReason);
  assert.equal(outsideBills.advice.savingsFunding.period.proposal, null, 'other cash cannot release a Savings proposal');
  assert.equal(outsideBills.advice.currentPeriodAction.spendPermission, null);
  assert.deepEqual(outsideBills.advice.currentPeriodAction.todayActions, []);
  const allocation = outsideBills.advice.paydayAllocation;
  const essentialsLine = allocation.lines.find(row => row.kind === 'essentials');
  assert(essentialsLine.amount > 0, 'fixture funds an essentials reserve from other cash');
  for (const candidate of [allocation, allocation.essentials, essentialsLine]) {
    assert.equal(candidate.weeklyCap, null);
    assert.equal(candidate.spendPermission, null);
  }

  const packet = Assistant.buildPacket({ data: outsideBills.data, periods: null, questionsMarkdown: '',
    env: {}, now: outsideBills.input.payload.fetchedAt });
  const estimate = packet.forecast.cardCoverageEstimate;
  assert.deepEqual(estimate, { basis: outsideBills.coverage.estimateBasis,
    reason: outsideBills.coverage.estimateReason, toConfirmCount: 0 });
  assert.equal(packet.forecast.horizon.minBalance, null);
  assert.equal(packet.forecast.horizon.minReason, estimate.reason);
  for (const projection of [packet.forecast.facilityCrossings, packet.planning.trajectory]) {
    assert.equal(projection.status, 'unavailable');
    assert.equal(projection.reason, estimate.reason);
  }

  console.log('PASS known Bills shortfall is distinct from unreadable backing');
} finally {
  fs.readFileSync = read;
}
