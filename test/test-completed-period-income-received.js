'use strict';
// A completed pay period's scheduled income takes the observer's own
// identity-matched receipt (the representedActuals the current period
// already reads), one to one, only when the window's posted coverage is
// complete. Then the real History.capture closing is complete-at-capture.
// Entirely invented finances and identities; no data.json, no credentials.
const assert = require('node:assert/strict');
const History = require('../scripts/private-period-history');
const Forecast = require('../public/forecast');
const Live = require('../scripts/live-plan');
const Operating = require('../scripts/operating-answer');

// Biweekly payroll anchored 2030-02-01: cycles 02-01..02-14 and 02-15..02-28.
// A closing capture on 02-15 closes cycle 1.
const START = '2030-02-01', END = '2030-02-14', NEXT_START = '2030-02-15';
const clone = value => JSON.parse(JSON.stringify(value));
// Hand ledger for the closed cycle: payroll 200 received on 02-01 from the
// identified employer into chequing-a; one 12.34 grocery purchase. Income
// actual 200, household actual 12.34.
function input({ receipt = {}, extra = [], window = {}, rules } = {}) {
  const day = NEXT_START;
  const ids = ['chequing-a', 'chequing-b', 'savings'];
  const cash = ids.map((id, i) => ({ id, label: 'Invented cash ' + i, value: [1000, 500, 100][i], evidenceDate: day, confidence: 'confirmed' }));
  const tx = (id, account, date, amount, payee, more = {}) => ({ id, account_id: account, date, amount, currency: 'cad',
    payee, original_name: payee.toUpperCase(), is_pending: false, updated_at: day + 'T17:58:00Z', ...more });
  return {
    periods: [],
    data: { meta: { asOf: day }, accounts: [], debts: [], revolvingExtra: [], plan: {
      opening: { asOf: day, representedEvents: [] }, startingCash: { breakdown: cash },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      income: [{ id: 'payroll', label: 'Invented income', frequency: 'biweekly', anchor: START, amount: 200, confidence: 'confirmed' }],
      bills: [], commitments: [], obligations: [], groups: [], funding: { options: [] },
      budget: { categories: [['groceries', 40], ['fuel', 15], ['restaurants', 10], ['dale-guilt-free', 5],
        ['amanda-guilt-free', 5], ['pets', 5], ['other-spend', 20]].map(([id, plannedPayday]) =>
        ({ id, label: 'Invented ' + id, plannedPayday, class: 'essential', confidence: 'confirmed', from: id === 'groceries' ? ['Groceries'] : [] })) },
    } },
    accountMap: { provider: 'lunchmoney', schema: 'atlas-provider-account-map/v1', scope: 'owner-observed', mappings: ids.map((id, i) =>
      ({ providerAccountId: 'invented-account-' + i, atlasRole: 'household-cash', canonical: { id, collection: 'cash' } })) },
    identity: { rules: rules || [{ eventId: 'payroll', payeePattern: 'Invented employer', atlasAccountId: 'chequing-a', direction: 'credit' }],
      billPaymentPayees: [] },
    payload: { provider: 'lunchmoney', fetchedAt: day + 'T18:00:00Z',
      accounts: cash.map((row, i) => ({ id: 'invented-account-' + i, name: 'Invented provider cash ' + i,
        currency: 'cad', balance: row.value, balance_as_of: day + 'T17:59:00Z', updated_at: day + 'T17:59:00Z' })),
      categories: [{ id: 'invented-groceries', name: 'Groceries' }, { id: 'invented-income', name: 'Income', is_income: true }],
      tags: [],
      transactions: [
        tx('invented-pay-1', 'invented-account-0', START, '-200.00', 'Invented employer', { category_id: 'invented-income', ...receipt }),
        tx('invented-market-1', 'invented-account-1', '2030-02-05', '12.34', 'Invented Market', { category_id: 'invented-groceries' }),
        ...extra],
      transactionWindow: { startDate: START, endDate: day, complete: true, hasMore: false, truncated: false, ...window },
      pendingCoverage: { complete: true, basis: 'is_pending-unbounded', hasMore: false },
    },
  };
}
const capture = source => History.captureClosing(clone(source), { now: () => new Date(NEXT_START + 'T18:01:00Z') });
function closedView(source) {
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const advice = Forecast.recommend(refreshed.data.plan, NEXT_START, options);
  return { advice, packet: refreshed.data.liveOverlay.currentPeriodActuals, view: advice.payPeriodViews.find(p => p.start === START) };
}
const incomeActual = candidate => candidate.content.publication.budgetProgress.income.actual;
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };

console.log('\n=== completed-period scheduled income takes its identity-matched receipt ===');
check('closed cycle: payroll received 200 from its identified receipt; closing is complete-at-capture', () => {
  const candidate = capture(input());
  assert.deepEqual(candidate.content.period, { start: START, end: END, timezone: Forecast.HOUSEHOLD_TIMEZONE });
  assert.deepEqual(incomeActual(candidate), { ...incomeActual(candidate), amount: 200, trust: 'calculated', completeness: 'complete' });
  assert.equal(candidate.content.publication.budgetProgress.household.actual.amount, 12.34, 'household actual is the one purchase');
  const row = (candidate.content.publication.income || []).find(r => r.id === 'payroll' && r.date === START);
  assert.ok(row, 'the closed payroll occurrence is published');
  assert.equal(row.status, 'received');
  assert.equal(row.historicalReceipt, 'identity-matched');
  assert.equal(Math.abs(row.actual), 200);
  assert.deepEqual(candidate.content.sourceCompleteness, { status: 'complete', reasons: [] });
  assert.equal(candidate.content.closingState, 'complete-at-capture');
});
check('the current period is untouched: no historical receipt outside a completed window', () => {
  const { advice } = closedView(input({ extra: [{ id: 'invented-pay-2', account_id: 'invented-account-0', date: NEXT_START,
    amount: '-200.00', currency: 'cad', payee: 'Invented employer', original_name: 'INVENTED EMPLOYER', category_id: 'invented-income',
    is_pending: false, updated_at: NEXT_START + 'T17:58:00Z' }] }));
  for (const v of advice.payPeriodViews.filter(p => p.start >= NEXT_START))
    for (const r of v.income || []) assert.equal(r.historicalReceipt, undefined, v.start + ' ' + r.id);
});

console.log('\n=== anything short of one posted identity match leaves income Unknown ===');
const unknownIncome = (name, source, extraReason) => check(name, () => {
  const candidate = capture(source);
  const actual = incomeActual(candidate);
  // Not complete: either Unknown, or (when an unrelated credit is genuine
  // Other Income, as on main) a partial figure that never includes payroll.
  assert.notEqual(actual.completeness, 'complete', 'income is never complete');
  assert.notEqual(candidate.content.sourceCompleteness.status, 'complete');
  if (extraReason) assert.ok(candidate.content.sourceCompleteness.reasons.includes(extraReason), extraReason);
  assert.equal(candidate.content.closingState, 'provisional');
  const row = (candidate.content.publication.income || []).find(r => r.id === 'payroll' && r.date === START);
  assert.ok(!row || row.status !== 'received', 'the payroll occurrence is not received');
  assert.ok(!row || row.historicalReceipt === undefined, 'no historical receipt is attached');
  assert.ok(!(actual.evidence || []).some(e => e.id === 'payroll'), 'payroll is not in the income evidence');
});
unknownIncome('unmatched: no receipt at all',
  (() => { const s = input(); s.payload.transactions = s.payload.transactions.filter(t => t.id !== 'invented-pay-1'); return s; })());
unknownIncome('same amount and date, but the payee is not the identified employer', input({ receipt: { payee: 'Invented stranger', original_name: 'INVENTED STRANGER' } }));
unknownIncome('same amount, identified payee, but the wrong account', input({ receipt: { account_id: 'invented-account-1' } }));
unknownIncome('the receipt is pending', input({ receipt: { is_pending: true } }));
unknownIncome('the window does not cover the period start', input({ window: { startDate: '2030-02-03' } }), 'transport:posted-window-misses-start');
check('ambiguous: two identified receipts for one occurrence leave it Unknown', () => {
  const source = input({ extra: [{ id: 'invented-pay-1b', account_id: 'invented-account-0', date: START, amount: '-200.00',
    currency: 'cad', payee: 'Invented employer', original_name: 'INVENTED EMPLOYER', category_id: 'invented-income',
    is_pending: false, updated_at: NEXT_START + 'T17:58:00Z' }] });
  const candidate = capture(source);
  assert.notEqual(incomeActual(candidate).completeness, 'complete');
  assert.equal(candidate.content.closingState, 'provisional');
  const row = (candidate.content.publication.income || []).find(r => r.id === 'payroll' && r.date === START);
  assert.ok(!row || row.historicalReceipt === undefined, 'no historical receipt is attached');
});
check('ambiguous at the Forecast seam: two represented entries for one occurrence leave it Unknown', () => {
  const source = input();
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const packet = options.currentPeriodActuals;
  const entry = packet.representedActuals.find(r => r.id === 'payroll' && r.date === START);
  assert.ok(entry, 'control: the observer matched the receipt');
  packet.representedActuals = packet.representedActuals.concat([{ ...entry }]);
  const view = Forecast.recommend(refreshed.data.plan, NEXT_START, options).payPeriodViews.find(p => p.start === START);
  assert.equal(view.budgetProgress.income.actual.amount, null);
  const row = view.income.find(r => r.id === 'payroll' && r.date === START);
  assert.notEqual(row.status, 'received');
});
check('a represented entry whose transaction is missing from the packet leaves it Unknown', () => {
  const source = input();
  const refreshed = Live.fromObservation(clone(source));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const packet = options.currentPeriodActuals;
  const entry = packet.representedActuals.find(r => r.id === 'payroll' && r.date === START);
  packet.transactions = packet.transactions.filter(t => String(t.id) !== String(entry.transactionId));
  const view = Forecast.recommend(refreshed.data.plan, NEXT_START, options).payPeriodViews.find(p => p.start === START);
  assert.equal(view.budgetProgress.income.actual.amount, null);
});

// Atlas review 6701320032 (repair): the Forecast seam fails closed on a
// competing claim made only through transactionIds, on a multi-leg selected
// claim, and on absent or invalid completed-window bounds.
function seamView(mutate) {
  const refreshed = Live.fromObservation(clone(input()));
  const options = Operating.recommendOpts(refreshed.data, {});
  options.periods = [];
  const packet = options.currentPeriodActuals;
  const entry = packet.representedActuals.find(r => r.id === 'payroll' && r.date === START);
  assert.ok(entry && entry.transactionId, 'control: the observer matched the receipt');
  mutate(packet, entry);
  const view = Forecast.recommend(refreshed.data.plan, NEXT_START, options).payPeriodViews.find(p => p.start === START);
  return { view, row: view.income.find(r => r.id === 'payroll' && r.date === START) };
}
const unqualified = (name, mutate) => check(name, () => {
  const { view, row } = seamView(mutate);
  assert.equal(row.historicalReceipt, undefined, 'no historical receipt');
  assert.notEqual(row.status, 'received', 'the payroll occurrence is not received');
  assert.notEqual(view.budgetProgress.income.actual.completeness, 'complete');
});
check('control at the seam: the unmodified packet qualifies', () => {
  const { row } = seamView(() => {});
  assert.equal(row.historicalReceipt, 'identity-matched');
  assert.equal(row.status, 'received');
});
unqualified('another entry claims the receipt only through transactionIds (inside the period)', (packet, entry) => {
  packet.representedActuals.push({ id: 'invented-other', date: '2030-02-08', actual: -50, postedOn: '2030-02-08',
    transactionId: 'tx-invented-other', transactionIds: ['tx-invented-other', entry.transactionId] });
});
unqualified('another entry claims the receipt only through transactionIds (outside the period)', (packet, entry) => {
  packet.representedActuals.push({ id: 'invented-other', date: '2030-02-20', actual: -50, postedOn: '2030-02-20',
    transactionId: 'tx-invented-other', transactionIds: ['tx-invented-other', entry.transactionId] });
});
unqualified('the selected entry is a multi-leg receipt', (packet, entry) => {
  entry.transactionIds = [entry.transactionId, 'tx-invented-second-leg'];
});
unqualified('the selected entry has a malformed transactionIds', (packet, entry) => { entry.transactionIds = 'not-an-array'; });
unqualified('coverageStart absent', packet => { delete packet.coverageStart; });
unqualified('coverageStart invalid (2030-02-31)', packet => { packet.coverageStart = '2030-02-31'; });
unqualified('coverageStart after the period start', packet => { packet.coverageStart = '2030-02-03'; });
unqualified('coverageThrough before the period end', packet => { packet.coverageThrough = '2030-02-10'; });

console.log(`\nAll ${passed} completed-period income proofs passed.`);
