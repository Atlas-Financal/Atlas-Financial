'use strict';
const assert = require('node:assert/strict'), test = require('node:test');
const F = require('../public/forecast'), O = require('../scripts/provider-observe'), L = require('../scripts/live-plan');
const observed = require('./fixtures/savings-observer-contract-data');
for (const mode of ['valid', 'valid-transfer', 'undated', 'null-amount', 'malformed-amount', 'undated-pending',
  'foreign-currency', 'missing-currency', 'malformed-date', 'pending', 'incomplete', 'pending-incomplete'])
  test('actual observer -> overlay -> Forecast: ' + mode, () => {
    const { report, advice } = observed(mode), packet = advice.savingsFunding;
    assert.equal(Object.hasOwn(report.currentPeriodActuals, 'currency'), false, 'the actual contract has no packet currency');
    assert.equal(advice.savingsInventory.reportedStock.amount, mode === 'valid-transfer' ? 129 : 119);
    assert.deepEqual(packet.rows.map(row => row.needed), [230, 24]);
    if (mode === 'valid' || mode === 'valid-transfer') {
      assert.equal(report.currentPeriodActuals.transactions.length, mode === 'valid-transfer' ? 2 : 1);
      assert.equal(report.currentPeriodActuals.transactions[0].currency, 'cad');
      if (mode === 'valid-transfer') assert.equal(F.householdInternalMovements(null, { currentPeriodActuals: report.currentPeriodActuals }).length, 1);
      assert.equal(packet.goalAllocation.status, 'ready', 'genuine CAD evidence must remain usable');
      assert.deepEqual(packet.backing.items.map(row => row.saved), mode === 'valid-transfer' ? [60, 24, 45] : [60, 24, 35]);
    } else {
      assert.equal(packet.goalAllocation.status, 'ready', 'valid reported account stock is independent of movement qualification');
      assert.deepEqual(packet.rows.map(row => row.saved), [95, 24]);
      assert.equal(packet.period.proposal, null);
    }
  });

function held(advice) {
  assert.equal(advice.savingsInventory.reportedStock.amount, 119, 'original Savings stock survives');
  assert.equal(advice.savingsFunding.goalAllocation.status, 'ready', 'transaction uncertainty does not erase dated account reports');
  assert.deepEqual(advice.savingsFunding.rows.map(row => row.saved), [95, 24]);
  assert.equal(advice.savingsFunding.period.proposal, null);
  assert.ok(advice.sim.events.every(row => !row.reserveFunding));
}
for (const mode of ['sanitization-fallback', 'collapsed-foreign', 'collapsed-missing-currency'])
  test('discarded movement evidence remains account-scoped: ' + mode, () => {
    const { report, advice } = observed(mode);
    held(advice);
    assert.ok(report.currentPeriodActuals.savingsMovementUnconfirmed.some(row => row.accountId === 'savings'));
    for (const row of report.currentPeriodActuals.savingsMovementUnconfirmed) {
      assert.deepEqual(Object.keys(row).sort(), ['accountId', 'reason']);
      assert.ok(['savings', 'savings-dont-touch'].includes(row.accountId));
      assert.ok(['transaction-amount-or-date-unconfirmed', 'native-plan-currency-unconfirmed',
        'transaction-evidence-sanitization-failed', 'transaction-posting-status-unconfirmed'].includes(row.reason));
    }
    assert.equal(O.currentPeriodActualsLooksSanitized(report.currentPeriodActuals), true);
    if (mode === 'sanitization-fallback') assert.deepEqual(report.currentPeriodActuals.transactions, []);
  });
test('confirmed pending/posted collapse does not manufacture uncertainty', () => {
  const { report, advice } = observed('collapsed-valid');
  assert.equal(report.currentPeriodActuals.transactions.length, 1);
  assert.deepEqual(report.currentPeriodActuals.savingsMovementUnconfirmed, []);
  assert.equal(advice.savingsFunding.goalAllocation.status, 'ready');
  assert.deepEqual(advice.savingsFunding.backing.items.map(row => row.saved), [60, 24, 35]);
});
test('undated unrelated account evidence does not poison Savings provenance', () => {
  const { report, advice } = observed('unrelated-undated');
  assert.deepEqual(report.currentPeriodActuals.savingsMovementUnconfirmed, []);
  assert.equal(advice.savingsFunding.goalAllocation.status, 'ready');
});
for (const [mode, mutate] of Object.entries({
  legacy: p => { delete p.savingsMovementUnconfirmed; },
  null: p => { p.savingsMovementUnconfirmed = null; },
  object: p => { p.savingsMovementUnconfirmed = {}; },
  missingAccount: p => { p.savingsMovementUnconfirmed = [{ reason: 'native-plan-currency-unconfirmed' }]; },
  providerIdentity: p => { p.savingsMovementUnconfirmed = [{ accountId: '9003', reason: 'native-plan-currency-unconfirmed' }]; },
  missingReason: p => { p.savingsMovementUnconfirmed = [{ accountId: 'savings' }]; },
  rawDescriptor: p => { p.savingsMovementUnconfirmed = [{ accountId: 'savings', reason: 'private text' }]; },
  extraField: p => { p.savingsMovementUnconfirmed = [{ accountId: 'savings', reason: 'native-plan-currency-unconfirmed', amount: 1 }]; },
  malformedTransactions: p => { p.transactions = null; },
  incompatiblePacketCurrency: p => { p.currency = 'USD'; },
  malformedPacketCurrency: p => { p.currency = null; },
  missingFetchSource: p => { delete p.savingsFetchCoverage; },
  malformedFetchSource: p => { p.savingsFetchCoverage = { complete: true }; },
  forgedFetchSource: p => { p.savingsFetchCoverage = { ...p.savingsFetchCoverage, rawDescriptor: 'untrusted' }; },
})) test('cloned packet ' + mode + ' cannot silently become clear', () => {
  const { data, report } = observed('valid');
  const before = JSON.stringify(report);
  const packet = JSON.parse(JSON.stringify(report.currentPeriodActuals)); mutate(packet);
  const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay, currentPeriodActuals: packet });
  held(advice);
  if (mode === 'legacy') assert.match(advice.savingsFunding.backing.reason, /legacy or missing/);
  assert.equal(JSON.stringify(report), before, 'negative test never patches the real packet');
});
test('valid uncertainty on an unrelated canonical account is scoped out', () => {
  const { data, report } = observed('valid');
  const packet = JSON.parse(JSON.stringify(report.currentPeriodActuals));
  packet.savingsMovementUnconfirmed = [{ accountId: 'chequing-b', reason: 'transaction-amount-or-date-unconfirmed' }];
  const advice = F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay, currentPeriodActuals: packet });
  assert.equal(advice.savingsFunding.goalAllocation.status, 'ready');
});
test('failed overlay keeps original Savings reports but missing movement evidence fails closed', () => {
  const { input, report } = observed('undated');
  const before = JSON.stringify(report);
  const data = L.failedOverlay(input.data, 'Synthetic overlay failure', { report });
  assert.deepEqual(data.plan.savingsPoolObservation, report.savingsPools);
  assert.equal(data.liveOverlay.applied, false);
  assert.equal(data.liveOverlay.currentPeriodActuals, null);
  held(F.recommend(data.plan, data.meta.asOf, { weeklyVariable: 40, ...data.liveOverlay }));
  assert.equal(JSON.stringify(report), before);
});

const windowPublish = x => F.recommend(x.data.plan, x.data.meta.asOf,
  { weeklyVariable: 40, debts: x.data.debts, ...x.data.liveOverlay, currentPeriodActuals: x.packet });
for (const list of ['empty', 'unrelated', 'zero']) for (const mode of observed.windowModes)
  test('observation/window ' + mode + ' is qualified before ' + list + ' iteration', () => {
    const x = observed.windowObservation(mode, list), advice = windowPublish(x), s = advice.savingsFunding;
    const ready = ['complete', 'unrelatedFlag'].includes(mode);
    assert.equal(s.goalAllocation.status, 'ready');
    assert.deepEqual(s.rows.map(row => row.saved), [95, 24]);
    assert.deepEqual(s.rows.map(row => row.needed), [230, 24]);
    assert.equal(advice.savingsInventory.reportedStock.amount, 119);
    assert.equal(s.goalAllocation.checkedAsOf, '2026-10-05');
    assert.ok(s.goalAllocation.balanceDates.every(row => row.date === '2025-10-05'));
    assert.equal(s.period.proposal, null); assert.ok(advice.sim.events.every(row => !row.reserveFunding));
    assert.equal(JSON.stringify(x.report), x.originalReport);
    if (ready) {
      x.data.meta.asOf = x.data.plan.opening.asOf = '2026-10-06';
      const after = windowPublish(x).savingsFunding;
      assert.equal(after.goalAllocation.status, 'ready');
      assert.deepEqual(after.rows.map(row => row.saved), [95, 24]);
      assert.equal(after.goalAllocation.checkedAsOf, '2026-10-05');
      assert.deepEqual(after.goalAllocation.balanceDates, s.goalAllocation.balanceDates);
    }
  });
for (const mode of observed.sourceWindowModes) for (const list of ['empty', 'unrelated', 'zero'])
  for (const bank of ['prior-year', 'valid-v2']) test('actual original-window ' + mode + ':' + list + ':' + bank, () => {
    const x = observed.windowObservation(mode, list, bank), advice = windowPublish(x), original = x.report.transactionWindow.savingsFetchCoverage;
    assert.strictEqual(x.packet, x.report.currentPeriodActuals);
    assert.deepEqual(x.packet.savingsFetchCoverage, original, 'source facts survive normalization and sanitization unchanged');
    assert.equal(Object.getOwnPropertyDescriptor(x.report.transactionWindow, 'savingsFetchCoverage').enumerable, true,
      'original fetch provenance remains part of the keyed history');
    assert.deepEqual(JSON.parse(JSON.stringify(x.report.transactionWindow)).savingsFetchCoverage, original);
    assert.deepEqual(Object.keys(original).sort(), ['complete', 'endDate', 'startDate']);
    assert.equal(typeof original.complete, 'boolean');
    assert.ok([original.startDate, original.endDate].every(date => date === null || /^\d{4}-\d{2}-\d{2}$/.test(date)));
    held(advice); assert.deepEqual(advice.savingsFunding.rows.map(row => row.needed), [230, 24]);
    assert.equal(JSON.stringify(x.report), x.originalReport);
    if (mode === 'source-missing-completion' || mode === 'source-null-completion') {
      assert.equal(x.report.transactionWindow.complete, null, 'global normalized completion is preserved');
      // A1 rule 1 (#850): no affirmative completion is not positive coverage evidence.
      assert.equal(x.packet.transactionCoverage, 'incomplete', 'global packet withholds without affirmative completion');
      assert.equal(original.complete, false, 'Savings does not infer affirmative completion');
    }
    if (mode === 'source-missing-dates' || mode === 'source-missing-window') {
      assert.equal(original.startDate, null); assert.equal(original.endDate, null);
      if (list !== 'empty') {
        assert.equal(x.packet.coverageStart, x.data.meta.asOf); assert.equal(x.packet.coverageThrough, x.data.meta.asOf);
      }
    }
  });
for (const mode of observed.rawWindowModes) for (const bank of ['prior-year', 'valid-v2'])
  test('actual observer ' + mode + ' holds ' + bank + ' funding without adjusting stock', () => {
    const x = observed.windowObservation(mode, 'empty', bank), advice = windowPublish(x);
    assert.strictEqual(x.packet, x.report.currentPeriodActuals, 'real producer packet is consumed unchanged');
    held(advice); assert.deepEqual(advice.savingsFunding.rows.map(row => row.needed), [230, 24]);
    assert.equal(JSON.stringify(x.report), x.originalReport);
  });
for (const mode of ['unrelated-card', 'unrelated-unmapped', 'card-with-savings-fee'])
  test('actual row incompleteness remains account scoped: ' + mode, () => {
    const x = observed.windowObservation(mode, 'empty', mode === 'card-with-savings-fee' ? 'valid-v2' : 'prior-year');
    assert.equal(x.packet.transactionCoverage, 'incomplete');
    assert.deepEqual(x.packet.savingsMovementUnconfirmed, []);
    assert.ok(x.packet.cardCoverageUnconfirmed.length || x.packet.transactions.some(row => row.accountRole === 'unmapped'));
    const advice = windowPublish(x), s = advice.savingsFunding;
    assert.equal(s.goalAllocation.status, 'ready'); assert.deepEqual(s.rows.map(row => row.saved), [95, 24]);
    assert.deepEqual(s.rows.map(row => row.needed), [230, 24]); assert.equal(s.period.proposal, null);
    assert.equal(s.moneyMovementPermission, 'not-granted'); assert.equal(JSON.stringify(x.report), x.originalReport);
    // Fetch truncation takes precedence over unrelated row uncertainty.
    const truncated = { ...x, packet: { ...x.packet, transactionCoverage: 'truncated' } };
    held(windowPublish(truncated));
  });
test('normalizing a timestamp afterward cannot manufacture original query-date provenance', () => {
  const x = observed.windowObservation('source-timestamp-dates'), normalized = O.normalizeLunchMoneyPayload(x.input.payload);
  assert.equal(normalized.transactionWindow.savingsFetchCoverage.startDate, null);
  assert.equal(normalized.transactionWindow.savingsFetchCoverage.endDate, null);
  normalized.transactionWindow.startDate = '2026-10-02'; normalized.transactionWindow.endDate = x.data.meta.asOf;
  const packet = O.sanitizedCurrentPeriodActuals({ ...x.report, transactionWindow: normalized.transactionWindow },
    { accountMap: x.input.accountMap, plan: x.data.plan, asOf: x.data.meta.asOf });
  assert.equal(packet.coverageThrough, x.data.meta.asOf);
  assert.equal(packet.savingsFetchCoverage.startDate, null); assert.equal(packet.savingsFetchCoverage.endDate, null);
  held(windowPublish({ ...x, packet }));
});
for (const shape of ['direct', 'counterparty', 'savings-leg', 'unrelated', 'dropped', 'collapsed'])
  for (const mode of observed.postingModes) test('actual posting provenance ' + shape + ':' + mode, () => {
    const x = observed.postingObservation(shape, mode), advice = windowPublish(x), s = advice.savingsFunding;
    const raw = x.report.transactions.find(row => row.providerTransactionId === x.rawId);
    assert.equal(raw.pending, mode === 'pending', 'incumbent global pending normalization is unchanged');
    assert.equal(raw.savingsPostingEvidence, mode === 'posted' ? 'posted' : mode === 'pending' ? 'pending' : 'unknown');
    for (const row of x.packet.transactions) assert.ok(['posted', 'pending', 'unknown'].includes(row.savingsPostingEvidence));
    const ready = shape === 'unrelated' || shape === 'collapsed' && mode === 'pending' || mode === 'posted' && shape !== 'dropped';
    assert.equal(s.goalAllocation.status, 'ready');
    assert.deepEqual(s.rows.map(row => row.saved), [95, 24]);
    assert.deepEqual(s.rows.map(row => row.needed), [230, 24]); assert.equal(advice.savingsInventory.reportedStock.amount, 119);
    if (!ready) { assert.equal(s.period.proposal, null); assert.ok(advice.sim.events.every(row => !row.reserveFunding)); }
    if (shape === 'counterparty' && !['posted', 'pending'].includes(mode)) {
      assert.equal(F.householdInternalMovements(x.data.plan, x.data.liveOverlay).length, 1,
        'incumbent pair matching is unchanged; Savings qualifies each source leg independently');
      assert.deepEqual(x.packet.savingsMovementUnconfirmed, [], 'cash counterparty does not become Savings account uncertainty');
      assert.equal(x.packet.transactions[0].savingsPostingEvidence, 'unknown');
    }
    if (shape === 'collapsed' && mode === 'pending') {
      assert.equal(x.packet.transactions.length, 1, 'explicit pending predecessor collapses into explicit posted successor');
      assert.equal(x.packet.transactions[0].savingsPostingEvidence, 'posted');
      assert.deepEqual(x.packet.savingsMovementUnconfirmed, []);
    }
    assert.equal(JSON.stringify(x.report), x.originalReport, 'real returned packets stay unchanged');
  });
assert.equal(observed.sameIdCases.length, 90);
assert.equal(new Set(observed.sameIdCases.map(row => row.name)).size, 90);
for (const row of [...observed.sameIdCases, ...observed.sameIdGuards]) test('actual same-ID posting provenance ' + row.name, () => {
  const x = observed.sameIdObservation(row), advice = windowPublish(x), s = advice.savingsFunding;
  assert.equal(s.goalAllocation.status, 'ready');
  assert.deepEqual(s.rows.map(item => item.saved), [95, 24]);
  assert.deepEqual(s.rows.map(item => item.needed), [230, 24]); assert.equal(advice.savingsInventory.reportedStock.amount, 119);
  if (row.ready) {
    const transition = x.report.identityEvidence.find(item => item.providerTransactionId === x.rawId);
    assert.deepEqual(transition, { providerTransactionId: x.rawId, transition: 'pending-to-posted', pendingCount: 1,
      postedCount: 1, ghostPending: false, doubleCounted: false });
    const survivor = x.report.collapsedTransactions.find(item => item.providerTransactionId === x.rawId);
    assert.equal(survivor.pending, false); assert.equal(survivor.savingsPostingEvidence, 'posted');
    const emitted = x.packet.transactions.find(item => item.atlasAccountId === (row.shape === 'counterparty' ? 'chequing-a' : 'savings'));
    assert.equal(emitted.savingsPostingEvidence, 'posted');
  } else {
    assert.equal(s.period.proposal, null); assert.ok(advice.sim.events.every(item => !item.reserveFunding));
  }
  assert.ok(x.packet.transactions.every(item => ['posted', 'pending', 'unknown'].includes(item.savingsPostingEvidence)));
  assert.equal(JSON.stringify(x.report), x.originalReport);
});
