'use strict';
// Test-first owner clarification 2026-10-16, 12:57 UTC:
// ownerSentinel_f70d821f734481919f25b706ea7ab1a6.
// Every balance/receipt below is invented. Literal expected cents are a second
// ledger, not outputs copied from Forecast or household data. These tests
// exercise the approved planning boundary; transfer permission is separate.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const F = require(path.join(process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..'), 'public/forecast'));
const futureFixture = require('./fixtures/savings-future-closing-data');
const LmGroups = require('./lm-groups-fixture.js');

function fixture({ asOf = '2026-10-19', state = 'expected', spent = 0,
  budget = 0, primaryPayroll = false, goalDate = null } = {}) {
  const x = futureFixture();
  x.asOf = x.plan.opening.asOf = asOf;
  x.plan.opening.paydaySnapshot = { periodStart: '2026-10-16', asOf: '2026-10-16', opening: 80 };
  x.plan.income = [{ id: 'payroll', label: 'Invented payroll calendar', frequency: 'biweekly',
    anchor: '2026-10-02', amount: primaryPayroll ? 200 : 0, confidence: 'confirmed' },
  ...(!primaryPayroll ? [{ id: 'expected-salary', label: 'Invented expected salary',
    frequency: 'once', date: '2026-10-20', amount: 200, confidence: 'confirmed' }] : [])];
  x.plan.commitments.forEach(row => { row.amount = 50; });
  if (goalDate) x.plan.commitments[0].date = goalDate;
  x.plan.budget.categories = budget ? [{ id: 'groceries', label: 'Invented groceries',
    class: 'essential', from: ['Groceries'], plannedPayday: budget, confidence: 'confirmed' }] : [];
  const cash = state === 'received-operating' ? 280 - spent : 80;
  const observedSavings = ['received-reserve', 'received-transfer'].includes(state) ? 319 : 119;
  x.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = cash;
  x.plan.startingCash.breakdown.find(row => row.id === 'savings').value = observedSavings;
  x.plan.startingCash.heldElsewhere.find(row => row.id === 'savings-dont-touch').value = 0;
  x.plan.savingsPoolObservation = { asOf, accounts: [
    { accountId: 'savings', value: observedSavings, currency: 'CAD', evidenceDate: asOf,
      pendingState: 'clear', source: 'provider-observe:lunchmoney' },
    { accountId: 'savings-dont-touch', value: 0, currency: 'CAD', evidenceDate: asOf,
      pendingState: 'clear', source: 'provider-observe:lunchmoney' },
  ] };
  const transactions = [], representedActuals = [];
  if (state !== 'expected') {
    const receiptAccount = state === 'received-reserve' ? 'savings' : 'chequing-a';
    transactions.push({ id: 'invented-salary-receipt', date: '2026-10-20', amount: -200,
      currency: 'CAD', pending: false, savingsPostingEvidence: 'posted', isIncome: true,
      incomeId: 'expected-salary', atlasAccountId: receiptAccount,
      accountRole: receiptAccount === 'savings' ? 'household-reserve' : 'household-cash',
      displayedPayee: 'Invented employer' });
    representedActuals.push({ id: 'expected-salary', date: '2026-10-20', actual: 200,
      transactionId: 'invented-salary-receipt' });
  }
  if (state === 'received-transfer') transactions.push(
    { id: 'invented-transfer-out', date: '2026-10-21', amount: 200, currency: 'CAD', pending: false,
      savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      kindHint: 'transfer', originalMerchant: 'AA101 TFR-TO Invented reserve', excludeFromTotals: true },
    { id: 'invented-transfer-in', date: '2026-10-21', amount: -200, currency: 'CAD', pending: false,
      savingsPostingEvidence: 'posted', atlasAccountId: 'savings', accountRole: 'household-reserve',
      kindHint: 'transfer', originalMerchant: 'AA101 TFR-FR Invented operating', excludeFromTotals: true });
  if (spent) transactions.push({ id: 'invented-groceries', date: '2026-10-22', amount: spent,
    currency: 'CAD', pending: false, savingsPostingEvidence: 'posted', atlasAccountId: 'chequing-a',
    accountRole: 'household-cash', categoryId: 'groceries', categoryLabel: 'Groceries',
    displayedPayee: 'Invented store' });
  Object.assign(x.opts.currentPeriodActuals, { observationAsOf: asOf, coverageStart: '2026-10-16',
    coverageThrough: asOf, transactions, representedActuals,
    savingsFetchCoverage: { complete: true, startDate: '2026-10-16', endDate: asOf } });
  return x;
}
function advice(x) {
  const before = JSON.stringify(x);
  const plan = LmGroups.groupPlan(x.plan);
  const a = F.recommend(plan, x.asOf, { ...x.opts,
    currentPeriodActuals: LmGroups.groupPacket(x.opts.currentPeriodActuals, plan), weeklyVariable: 0, debts: [] });
  assert.equal(JSON.stringify(x), before, 'no source balances, dates or actuals are rewritten');
  return a;
}

// Independent Systems Review fixture: the live cash overlay legitimately
// withholds an unproved salary from cash while Budget still plans that income.
function liveSalaryFixture({ asOf, marker = false, advanced = false, state = 'expected' }) {
  const x = fixture({ asOf, state });
  x.plan.opening.paydaySnapshot = { periodStart: '2026-10-30', asOf: '2026-10-30', opening: 80 };
  x.plan.income[1] = { id: 'amandaSalaryMonthEnd', label: 'Invented monthly salary',
    frequency: 'monthly', day: 31, amount: 200, confidence: 'confirmed' };
  const p = x.opts.currentPeriodActuals;
  p.coverageStart = p.savingsFetchCoverage.startDate = '2026-10-30';
  for (const row of p.transactions) {
    row.date = row.kindHint === 'transfer' ? '2026-11-01' : '2026-10-31';
    if (row.incomeId) row.incomeId = 'amandaSalaryMonthEnd';
  }
  for (const row of p.representedActuals) { row.id = 'amandaSalaryMonthEnd'; row.date = '2026-10-31'; }
  if (state !== 'expected') x.plan.opening.representedEvents.push({ id: 'amandaSalaryMonthEnd', date: '2026-10-31' });
  if (marker) x.plan.opening.notReliedUponEvents = [{ id: 'amandaSalaryMonthEnd',
    date: '2026-10-31', reason: 'same-day-inbound-unproven' }];
  if (advanced) x.plan.opening.priorAsOf = '2026-10-30';
  x.opts.operatingPlan = 'live';
  x.opts.observedCash = { asOf, complete: true, accounts: x.plan.startingCash.breakdown
    .filter(row => row.id.startsWith('chequing-')).map(row => ({ ...row, evidenceDate: asOf })) };
  return x;
}
function closing(a, start = '2026-10-30') {
  const view = a.savingsFunding.periodViews.find(row => row.start === start);
  assert(view, 'native selected period exists');
  const packet = F.savingsFundingPublication(a.savingsFunding,
    { asOf: a.savingsFunding.asOf, advice: a, periodId: view.id });
  assert(packet, 'the shared publication must validate the selected period');
  const c = packet.forecastClosing;
  assert(c, 'Forecast owns the closing projection');
  assert.equal(c.actualSaved, null);
  assert.equal(c.actionPermission, 'not-granted');
  assert.equal(c.moneyMovementPermission, 'not-granted');
  return c;
}
function assertReady(c, stock, contribution) {
  assert.equal(c.status, 'ready', c.reason);
  assert.equal(c.trust, 'estimated');
  assert.equal(c.nature, 'if-eligible-surplus-saved');
  assert.equal(c.stock, stock);
  assert.equal(c.contribution, contribution);
}

for (const [label, asOf] of [['before', '2026-10-19'], ['on', '2026-10-20'], ['after', '2026-10-21']]) {
  test('expected current-period salary ' + label + ' its date remains projected without a posted receipt', () => {
    const x = fixture({ asOf }), a = advice(x);
    assert.equal(a.savingsInventory.observedStock.status, 'ready');
    assert.equal(a.savingsFunding.backing.status, 'ready', 'current opening evidence is not the missing input');
    assert.equal(x.opts.currentPeriodActuals.transactions.length, 0);
    const current = a.payPeriodViews.find(row => row.timelineRole === 'current');
    assert.equal(current.incomeTotal, 200);
    assert.equal(current.balanceAfterDeductions, 200);
    // Independent ledger: observed119 + forecast200; no cost is due yet.
    const c = closing(a);
    assertReady(c, 319, 200);
    assert.equal(c.operatingCash, 80, 'the same hypothetical salary funds the projected credit once');
    assert.equal(c.stock + c.operatingCash, 119 + 80 + 200, 'conserved scenario total, no invented cash');
  });
}

test('same-day primary payroll planning is independent of transfer-now cash capacity', () => {
  const a = advice(fixture({ asOf: '2026-10-16', primaryPayroll: true }));
  assert.equal(a.savingsFunding.backing.status, 'ready');
  assert.equal(a.savingsFunding.period.nativePeriodSurplus, 200);
  assert.equal(a.savingsFunding.period.availableNow, 60, 'actual cash80 less floor20 is not relaxed');
  assert(a.savingsFunding.period.proposal >= 0 && a.savingsFunding.period.proposal <= 60,
    'actual proposal remains bounded by current cash; fully backed goals need no transfer');
  assertReady(closing(a), 319, 200);
});

for (const [label, asOf, marker, advanced] of [
  ['before salary', '2026-10-30', false, false],
  ['same-day without live marker', '2026-10-31', false, false],
  ['same-day live inbound unproven', '2026-10-31', true, false],
  ['elapsed salary with advanced live opening', '2026-11-01', false, true],
]) test('qualified live planning includes expected salary: ' + label, () => {
  const x = liveSalaryFixture({ asOf, marker, advanced }), a = advice(x);
  const current = a.payPeriodViews.find(row => row.timelineRole === 'current');
  assert.equal(a.savingsFunding.backing.status, 'ready');
  assert.equal(current.balanceAfterDeductions, 200);
  const salary = current.income.find(row => row.id === 'amandaSalaryMonthEnd');
  assert.equal(salary.notReliedUpon === true, marker || advanced);
  assert.equal(x.opts.currentPeriodActuals.transactions.length, 0);
  assert.equal(a.savingsFunding.period.status, 'ready');
  assert(a.savingsFunding.period.availableNow <= 60, 'bank capacity still uses actual cash80 minus floor20');
  const c = closing(a, '2026-11-13');
  assertReady(c, 319, 200); // independent119 + expected200, never actual income.
  assert.equal(c.operatingCash, 80);
  assert.equal(c.stock + c.operatingCash, 119 + 80 + 200);
});

for (const state of ['received-operating', 'received-reserve', 'received-transfer']) {
  test('live matched salary replaces the expected credit once: ' + state, () => {
    const a = advice(liveSalaryFixture({ asOf: '2026-11-02', advanced: true, state }));
    assert.equal(a.savingsFunding.period.status, 'ready');
    assertReady(closing(a, '2026-11-13'), 319, state === 'received-operating' ? 200 : 0);
  });
}

for (const proof of ['missing-receipt-id', 'missing-receipt-row']) {
  test('a live unproven marker does not replace ambiguous claimed receipt evidence: ' + proof, () => {
    const x = liveSalaryFixture({ asOf: '2026-10-31', marker: true });
    x.opts.currentPeriodActuals.representedActuals = [{ id: 'amandaSalaryMonthEnd', date: '2026-10-31', actual: 200,
      ...(proof === 'missing-receipt-row' ? { transactionId: 'missing-receipt' } : {}) }];
    const c = closing(advice(x), '2026-11-13');
    assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
  });
}

test('an unsupported live income marker stays withheld', () => {
  const x = liveSalaryFixture({ asOf: '2026-10-31', marker: true });
  x.plan.opening.notReliedUponEvents[0].reason = 'income-authority-unavailable';
  const c = closing(advice(x), '2026-11-13');
  assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
});

test('unsupported current salary confidence is not promoted to planning authority', () => {
  const x = liveSalaryFixture({ asOf: '2026-11-01', advanced: true });
  x.plan.income[1].confidence = 'unknown';
  const c = closing(advice(x), '2026-11-13');
  assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
});

for (const state of ['received-operating', 'received-reserve', 'received-transfer']) {
  test('a real matched receipt/transfer replaces the forecast without double credit: ' + state, () => {
    const x = fixture({ asOf: '2026-10-23', state }), a = advice(x);
    assert.equal(a.savingsFunding.backing.status, 'ready');
    assert.equal(a.savingsFunding.period.status, 'ready');
    if (state === 'received-reserve') assert.equal(a.savingsFunding.period.alreadySavedIncome, 200);
    if (state === 'received-transfer') {
      assert.equal(F.householdInternalMovements(x.plan, x.opts).length, 1);
      assert.equal(a.savingsFunding.period.transferred, 200);
    }
    // Received in Bills:119 + still-untransferred200. Already in Savings:319 + 0.
    assertReady(closing(a), 319, state === 'received-operating' ? 200 : 0);
  });
}

test('a refreshed next-period observed stock replaces the prior projected contribution once', () => {
  const x = fixture({ asOf: '2026-10-30', state: 'received-transfer' });
  x.plan.opening.paydaySnapshot.periodStart = x.plan.opening.paydaySnapshot.asOf = '2026-10-30';
  x.plan.income.push({ id: 'next-expected-salary', label: 'Invented next expected salary',
    frequency: 'once', date: '2026-11-03', amount: 300, confidence: 'confirmed' });
  const p = x.opts.currentPeriodActuals;
  p.coverageStart = p.savingsFetchCoverage.startDate = '2026-10-30';
  p.transactions = []; p.representedActuals = [];
  const a = advice(x);
  // Observed319 already contains the earlier200; only new projected300 joins.
  assertReady(closing(a, '2026-11-13'), 619, 300);
});

for (const received of [0, 150]) test('incomplete claimed salary receipt withholds overlap instead of inventing a replacement: ' + received, () => {
  const x = fixture({ asOf: '2026-10-23', state: 'received-operating' });
  x.plan.startingCash.breakdown.find(row => row.id === 'chequing-a').value = 80 + received;
  x.opts.currentPeriodActuals.transactions[0].amount = -received;
  x.opts.currentPeriodActuals.representedActuals[0].actual = received;
  const a = advice(x);
  assert.equal(a.payPeriodViews.find(row => row.timelineRole === 'current').incomeTotal, 200,
    'the existing native planned-income publication is unchanged');
  const c = closing(a);
  assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
});

for (const proof of ['represented-event', 'missing-receipt-id', 'missing-receipt-row']) {
  test('unproven claimed receipt inclusion is not replaced by forecast salary: ' + proof, () => {
    const x = fixture({ asOf: '2026-10-20' });
    if (proof === 'represented-event') x.opts.representedEvents = [{ id: 'expected-salary', date: '2026-10-20' }];
    else x.opts.currentPeriodActuals.representedActuals = [{ id: 'expected-salary', date: '2026-10-20', actual: 200,
      ...(proof === 'missing-receipt-row' ? { transactionId: 'missing-row' } : {}) }];
    const c = closing(advice(x));
    assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
  });
}

for (const [spent, expected] of [[0, 219], [50, 219], [125, 194]]) {
  test('within-budget spend fulfils the reserve and overspend alone reduces surplus: ' + spent, () => {
    const x = fixture({ asOf: '2026-10-23', state: 'received-operating', budget: 100, spent });
    const a = advice(x), current = a.payPeriodViews.find(row => row.timelineRole === 'current');
    const row = current.householdBudget.find(item => item.id === 'groceries');
    assert.equal(row.hold, Math.max(100, spent));
    assert.equal(current.balanceAfterDeductions, 200 - Math.max(100, spent));
    // Independent ledger:119 + (salary200 - max(budget100, actual spend)).
    assertReady(closing(a), expected, expected - 119);
  });
}

test('a dated goal cost consumes the rolling Savings projection once', () => {
  const a = advice(fixture({ goalDate: '2026-10-25' }));
  const c = closing(a);
  assertReady(c, 269, 200); // observed119 + forecast200 - due goal50.
  assert.equal(c.projectedDraws, 50);
  assert(!c.items.some(item => item.id === 'a'), 'paid goal leaves only this projection roster');
});

test('the established future surplus timeline remains unchanged', () => {
  const a = advice(futureFixture());
  // Existing S1 path: first future income1000 + inherited80 sweeps1080;
  // next future income1000 sweeps1000. No goal cost is due at these closes.
  assertReady(closing(a, '2026-10-30'), 1199, 1080);
  assertReady(closing(a, '2026-11-13'), 2199, 1000);
  assert.equal(a.payPeriodViews.find(row => row.start === '2026-10-16').paydaySweep, 1080);
  assert.equal(a.payPeriodViews.find(row => row.start === '2026-10-30').paydaySweep, 1000);
});

test('a negative planning surplus stays signed and never invents a Savings transfer', () => {
  const a = advice(fixture({ budget: 300 }));
  const current = a.payPeriodViews.find(row => row.timelineRole === 'current');
  assert.equal(current.balanceAfterDeductions, -100, 'forecast200 minus budget300');
  const c = closing(a);
  assertReady(c, 119, 0);
  assert.equal(c.diagnostics.currentPeriodSurplusDeficit, -100);
  assert(c.operatingCash < 0, 'the signed operating shortage is not clamped to zero');
  assert(c.gap.shortBy > 0 && c.gap.signedOperatingCash < 0);
  assert.equal(c.projectedDeficitCoverage, 0, 'routine Bills deficit cannot silently draw Savings');
});

test('an unaffordable dated goal preserves signed Savings shortage diagnostics', () => {
  const x = fixture({ goalDate: '2026-10-25' });
  x.plan.commitments[0].amount = 500;
  const c = closing(advice(x));
  assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
  assert.equal(c.diagnostics.signedSavings, -181, 'observed119 + forecast200 - goal500');
  assert.equal(c.gap.shortBy, 181); assert.deepEqual(c.items, []);
});

for (const fault of ['stale-reserve', 'missing-reserve', 'pending-reserve', 'missing-payday-opening', 'missing-movement-evidence']) {
  test('missing current opening or overlap evidence remains withheld: ' + fault, () => {
    const x = fixture();
    if (fault === 'stale-reserve') x.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-18';
    if (fault === 'missing-reserve') x.plan.savingsPoolObservation.accounts.pop();
    if (fault === 'pending-reserve') x.plan.savingsPoolObservation.accounts[0].pendingState = 'pending';
    if (fault === 'missing-payday-opening') delete x.plan.opening.paydaySnapshot;
    if (fault === 'missing-movement-evidence') delete x.opts.currentPeriodActuals;
    const c = closing(advice(x));
    assert.equal(c.status, 'unavailable'); assert.equal(c.stock, null);
    assert.deepEqual(c.items, []);
  });
}
