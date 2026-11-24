'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readCanonical, reconcile } = require('../scripts/reconcile');
const { proposeOverlay } = require('../scripts/live-plan');

const day = '2032-04-15';
const cash = { collection: 'cash', id: 'chequing-a' };
const card = { collection: 'debts', id: 'card-x' };

function fixture(value) {
  return {
    meta: { asOf: day },
    debts: [{ id: card.id, balance: value, pending: value, limit: value }],
    plan: {
      startingCash: { breakdown: [{ id: cash.id, value }], heldElsewhere: [{ id: 'held-x', value }] },
      commitments: [{ id: 'cost-x', amount: value, settledOn: day }],
      bills: [{ id: 'bill-x', amount: value, date: day, payingAccount: cash.id }],
      obligations: [{ id: 'minimum-x', amount: value, debtId: card.id }],
      income: [{ id: 'pay-x', amount: value }, { id: 'scenario-x', scenarioMonthly: { expected: value } }],
    },
  };
}

const targets = [cash, { collection: 'cash', id: 'held-x' }, card,
  { collection: 'commitments', id: 'cost-x' }, { collection: 'bills', id: 'bill-x' },
  { collection: 'obligations', id: 'minimum-x' }, { collection: 'income', id: 'pay-x' },
  { collection: 'income', id: 'scenario-x' }];

function compare(data, evidenceValue, observation) {
  const evidence = { observationId: 'invented-observation', evidenceDate: day, evidenceValue, ...observation };
  const reconciliation = reconcile({ data, observations: [evidence] });
  const { proposed } = proposeOverlay({ reconciliation }, day, day);
  assert.equal(reconciliation.rows.length, 1);
  return { row: reconciliation.rows[0], proposed };
}

function assertMissing(data, observed, observation) {
  const { row, proposed } = compare(data, observed, observation);
  assert.deepEqual([row.status, row.canonicalValue, row.difference], ['MISSING', null, null],
    row.canonicalTarget + ' with observation ' + observed);
  assert.deepEqual(proposed, []);
}

for (const [description, value] of [['null', null], ['empty', ''], ['whitespace', ' \t ']]) {
  test('canonical readers with ' + description + ' numeric fields', () => {
    for (const target of targets) {
      const result = readCanonical(fixture(value), target);
      assert.deepEqual([result.found, result.value], [false, null], target.collection + ':' + target.id);
    }
  });
  test('cash and debt with ' + description + ' baselines never match or propose a change', () => {
    for (const target of [cash, card]) {
      for (const observed of [0, 450]) assertMissing(fixture(value), observed, { canonical: target });
    }
  });
  test('card posted, pending and limit with ' + description + ' baselines', () => {
    for (const fact of ['posted-balance', 'pending', 'limit']) {
      for (const observed of [0, 450]) assertMissing(fixture(value), observed, { fact, cardId: card.id });
    }
  });
}

test('real zero, nonzero, and their numeric strings remain comparable', () => {
  for (const [raw, amount] of [[0, 0], ['0', 0], [28.75, 28.75], [' 28.75 ', 28.75]]) {
    const data = fixture(raw);
    for (const target of targets) {
      const result = readCanonical(data, target);
      assert.equal(result.found, true);
      assert.equal(result.value, amount, target.collection + ':' + target.id);
    }
    for (const observation of [{ canonical: cash }, { canonical: card }, { fact: 'posted-balance', cardId: card.id },
      { fact: 'pending', cardId: card.id }, { fact: 'limit', cardId: card.id }]) {
      const { row, proposed } = compare(data, amount, observation);
      assert.deepEqual([row.status, row.canonicalValue, row.difference, proposed], ['MATCH', amount, 0, []]);
      const change = compare(data, amount + 15, observation);
      assert.deepEqual([change.row.status, change.row.canonicalValue, change.row.difference], ['CHANGE', amount, 15]);
      if (observation.fact === 'limit') {
        assert.deepEqual(change.proposed, [], 'a credit limit is never a posted overlay');
      } else {
        assert.deepEqual(change.proposed.map(p => [p.locator, p.currentValue, p.proposedValue]),
          [[row.canonicalTarget, amount, amount + 15]], 'a genuine eligible change is still proposed');
      }
    }
  }
});

test('a blank card balance leaves known pending and limit fields readable', () => {
  const data = fixture(25);
  data.debts[0].balance = null;
  assertMissing(data, 0, { fact: 'posted-balance', cardId: card.id });
  for (const fact of ['pending', 'limit']) {
    const { row } = compare(data, 25, { fact, cardId: card.id });
    assert.deepEqual([row.status, row.canonicalValue, row.difference], ['MATCH', 25, 0]);
  }
});

test('amount-dependent bill, settlement and obligation comparisons with no canonical amount', () => {
  const data = fixture('  ');
  for (const observed of [0, 450]) {
    assertMissing(data, observed, { fact: 'dated-due', canonical: { collection: 'bills', id: 'bill-x' }, dueDate: day });
    assertMissing(data, observed, { fact: 'settlement', commitmentId: 'cost-x', settledOn: day });
    assertMissing(data, observed, { fact: 'scheduled-payment', obligationId: 'minimum-x', cardId: card.id });
  }
});

test('an unknown utility bill cannot establish whether an account balance was scheduled', () => {
  const observation = { fact: 'account-balance', forbiddenBillIds: ['bill-x'] };
  for (const observed of [0, 450]) assertMissing(fixture(' '), observed, observation);
  const scheduled = compare(fixture('0'), 0, observation);
  assert.equal(scheduled.row.status, 'CONFLICT');
  assert.deepEqual(scheduled.row.scheduledIds, ['bill-x']);
  assert.equal(compare(fixture('25'), 0, observation).row.status, 'MATCH');
});

test('a household-available balance requires a known canonical amount', () => {
  const observation = { fact: 'household-available', landingAccount: 'held-x', established: true };
  for (const observedBalance of [0, 450]) {
    assertMissing(fixture(null), 15, { ...observation, observedBalance });
  }
  const { row } = compare(fixture('0'), 15, { ...observation, observedBalance: 0 });
  assert.deepEqual([row.status, row.canonicalValue, row.difference], ['MATCH', 0, 0]);
});

test('household transfer comparisons require known scenario amounts', () => {
  const data = fixture(null);
  const canonical = { collection: 'income', id: 'scenario-x' };
  const scenarioMonthly = { conservative: 0, expected: 25, optimistic: 50 };
  const observation = { fact: 'household-transfer', canonical, scenarioMonthly, independentlyObserved: true };
  const income = data.plan.income.find(row => row.id === canonical.id);
  for (const key of Object.keys(scenarioMonthly)) {
    income.scenarioMonthly = { ...scenarioMonthly, [key]: ' ' };
    const { row, proposed } = compare(data, 25, observation);
    assert.equal(row.status, 'MISSING', key);
    assert.deepEqual(proposed, []);
    if (key === 'expected') {
      assert.deepEqual([row.canonicalValue, row.difference], [null, null]);
      assertMissing(data, 25, { ...observation, independentlyObserved: false });
    }
  }
  income.scenarioMonthly = { conservative: '0', expected: '25', optimistic: 50 };
  assert.equal(compare(data, 25, observation).row.status, 'MATCH');
});

test('a missing salary installment leaves its deposit and the combined salary unknown', () => {
  const data = fixture(0);
  const first = { id: 'tennisbc-fixture-a', day: 15, amount: ' ' };
  data.plan.income = [first, { id: 'tennisbc-fixture-b', day: 31, amount: 30 }];
  const deposit = { fact: 'employment-deposit', cadenceHint: 'semi-monthly-15th' };
  for (const observed of [0, 450]) assertMissing(data, observed, deposit);
  const authority = () => reconcile({ data, observations: [] }).amandaTransferAuthority;
  const incomplete = authority();
  assert.equal(incomplete.canonicalExpected, null);
  assert.equal(incomplete.independentlyVerifiedByPaydayEvidence, false);
  first.amount = '0';
  const complete = authority();
  assert.equal(complete.canonicalExpected, 30);
  assert.equal(complete.independentlyVerifiedByPaydayEvidence, true);
  const { row } = compare(data, 0, deposit);
  assert.deepEqual([row.status, row.canonicalValue, row.difference], ['MATCH', 0, 0]);
});
