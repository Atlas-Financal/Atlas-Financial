'use strict';
// Independent invented costs. $743 required, with $350 next-period capacity,
// leaves $393 proposed now. No household or provider observations.
module.exports = function plannedSavingsClarityData(mode = 'ready') {
  if (mode.startsWith('stock-')) {
    const data = module.exports('backed-ready');
    if (mode === 'stock-zero') data.plan.savingsPoolObservation.accounts.forEach(row => { row.value = 0; });
    if (mode === 'stock-missing') data.plan.savingsPoolObservation.accounts.pop();
    if (mode === 'stock-duplicate') data.plan.savingsPoolObservation.accounts.push({ ...data.plan.savingsPoolObservation.accounts[0] });
    if (mode === 'stock-pending') data.plan.savingsPoolObservation.accounts[0].pendingState = 'unknown';
    return data;
  }
  if (mode.startsWith('projection')) {
    const fx = require('./savings-funding-timeline'), data = require('./budget-funding-data')();
    data.plan = mode === 'projection-undated' ? fx.fixture() : fx.datedFixture(); data.meta.asOf = fx.AS_OF;
    data.meta.title = 'Synthetic Savings projection review';
    if (mode === 'projection-remaining') {
      data.meta.asOf = data.plan.opening.asOf = '2026-09-11';
      data.plan.savingsPoolObservation.asOf = data.meta.asOf;
      data.plan.savingsPoolObservation.accounts.forEach(row => { row.evidenceDate = data.meta.asOf; });
    }
    if (mode === 'projection-missing-cash') delete data.plan.startingCash.breakdown[0].value;
    if (mode === 'projection-stale') data.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-09-09';
    return data;
  }
  if (['backed', 'pool-deficit', 'stale', 'range'].includes(mode)) {
    const fx = require('./savings-earmarks'), data = fx.fixture().data;
    data.plan = fx.observedPlan(); data.meta.asOf = fx.AS_OF;
    data.meta.title = 'Synthetic Planned Savings clarity';
    delete data.plan.cardPurchaseCoverage;
    data.plan.savingsEarmarks.history[0].pools[1].allocations.push({ goalRef: { kind: 'commitment', id: 'trip-a' }, amount: 45.67 });
    data.plan.savingsPoolObservation.accounts[1].value = 190.12;
    if (mode === 'pool-deficit') data.plan.savingsPoolObservation.accounts[0].value = 100;
    if (mode === 'stale') data.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-08-19';
    if (mode === 'range') {
      const trip = data.plan.commitments.find(c => c.id === 'trip-a');
      delete trip.amount; trip.amountMin = 403.21; trip.amountMax = 500; trip.confidence = 'estimated';
    }
    return data;
  }
  const data = require('./budget-funding-data')();
  data.meta.title = 'Synthetic Planned Savings clarity';
  for (let i = 1; i <= 13; i++) data.plan.commitments.push({
    id: 'invented-cost-' + i,
    label: i === 13 ? 'Invented goal with a deliberately long name for narrow screens' : 'Invented goal ' + i,
    date: '2026-09-10', amount: 11, confidence: 'confirmed', group: 'invented-course',
  });
  if (mode === 'unconfirmed') {
    data.plan.groups = [{ id: 'invented-course', label: 'Invented classes' }];
    data.plan.startingCash.heldElsewhere = [{ id: 'savings-dont-touch', label: 'Invented home reserve', value: 0, class: 'purpose-reserve' }];
    data.plan.bills.push({ id: 'invented-insurance', label: 'Invented home insurance', frequency: 'yearly', month: 12, day: 11,
      firstDue: '2026-12-11', amount: 181.23, confidence: 'estimated' });
    data.plan.budget.categories.push({ id: 'invented-tax', label: 'Invented property tax', class: 'reserve',
      plannedAmount: 487.63, planningDate: '2026-10-21', confidence: 'estimated' });
    data.plan.savingsEarmarks = { version: 1, currency: 'CAD', pools: [
      { id: 'sports', accountId: 'savings', label: 'Invented sports reserve', role: 'purpose-reserve', purpose: 'Invented sports',
        goalRefs: [{ kind: 'commitment', id: 'named-cost' }, { kind: 'group', id: 'invented-course' }] },
      { id: 'home', accountId: 'savings-dont-touch', label: 'Invented home reserve', role: 'purpose-reserve', purpose: 'Invented home costs',
        reconciledOn: '2026-08-14', goalRefs: [{ kind: 'budget-reserve', id: 'invented-tax' }, { kind: 'yearly-bill', id: 'invented-insurance' }] },
    ], history: [] };
  }
  if (mode === 'gap') data.plan.commitments[0].amount = 857;
  if (mode === 'backed-ready') {
    data.plan.startingCash.heldElsewhere = [{ id: 'savings-dont-touch', label: 'Invented home reserve', value: 0, class: 'purpose-reserve' }];
    data.plan.savingsEarmarks = { version: 1, currency: 'CAD', pools: [
      { id: 'sports', accountId: 'savings', label: 'Invented sports reserve', role: 'purpose-reserve', purpose: 'Invented costs' },
      { id: 'home', accountId: 'savings-dont-touch', label: 'Invented home reserve', role: 'purpose-reserve', purpose: 'Invented costs', reconciledOn: data.meta.asOf },
    ], history: [{ revision: 1, confirmedAt: data.meta.asOf, source: 'Invented owner confirmation', pools: [
      { poolId: 'sports', allocations: [{ goalRef: { kind: 'commitment', id: 'named-cost' }, amount: 169.37 }] },
      { poolId: 'home', allocations: [{ goalRef: { kind: 'commitment', id: 'named-cost' }, amount: 45.67 }] },
    ] }] };
    data.plan.savingsPoolObservation = { asOf: data.meta.asOf, accounts: [
      { accountId: 'savings', value: 300.01, currency: 'CAD', evidenceDate: data.meta.asOf, pendingState: 'clear', source: 'provider-observe:lunchmoney' },
      { accountId: 'savings-dont-touch', value: 200.02, currency: 'CAD', evidenceDate: data.meta.asOf, pendingState: 'clear', source: 'provider-observe:lunchmoney' },
    ] };
  }
  return data;
};
