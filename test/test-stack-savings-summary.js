'use strict';
// Invented public-path proofs for the current and next Stack Savings card.
const assert = require('node:assert/strict');
const test = require('node:test');
const Forecast = require('../public/forecast.js');
const H = require('./acceptance/harness.js');
const Snap = require('../scripts/figures-snapshot.js');

const goal = (id, date, amount, extra) => ({
  id, label: 'Invented ' + id, date, amount, confidence: 'confirmed', sinkingFund: true, ...extra,
});

function world(commitments, balance, { groups = [], patch } = {}) {
  const w = H.baseWorld();
  w.savingsPool = {};
  w.accounts.find(a => a.id === 'savings').value = balance;
  w.accounts.find(a => a.id === 'savings-dont-touch').value = 0;
  w.commitments = commitments;
  w.groups = groups;
  w.planPatch = patch;
  const { data, error } = H.dataOf(w);
  if (error) throw error;
  return Forecast.recommend(data.plan, w.asOf, Snap.pageOptions(data, null));
}
const card = (result, role) => result.payPeriodViews.find(v => v.timelineRole === role).stackSummary.savings;
const item = (card, id) => card.items.find(i => i.id === id);
const held = row => row.heldMembers.map(m => [m.key, m.label, m.date, m.saved, m.needed, m.overdue]);
function amounts(s) {
  const { balance, saved, held, unallocated, deficit } = s.totals;
  return [balance, saved, held, unallocated, deficit];
}

test('known overdue claim keeps first priority, and stays visible in both views', () => {
  // 62.73 minus the unpaid 27.31 leaves 35.42 for the later 50 claim.
  const r = world([goal('apron', '2026-10-06', 27.31), goal('stool', '2026-11-13', 50)], 62.73);
  for (const role of ['current', 'next']) {
    const s = card(r, role);
    assert.deepEqual(amounts(s), [62.73, 35.42, 27.31, 0, 0]);
    assert.deepEqual(held(item(s, 'commitment:apron')),
      [['apron@2026-10-06', 'Invented apron', '2026-10-06', 27.31, 27.31, true]]);
    assert.equal(item(s, 'commitment:stool').saved, 35.42);
  }
});

for (const [kind, extra] of [['unknown', {}], ['ranged', { amountMin: 18, amountMax: 49 }]]) {
  test(kind + ' overdue cost keeps the entire allocation unavailable', () => {
    const r = world([goal('apron', '2026-10-06', null, { confidence: 'estimated', ...extra }),
      goal('stool', '2026-11-13', 50)], 62.73);
    assert.equal(r.savingsFunding.goalAllocation.status, 'unavailable');
    for (const role of ['current', 'next']) {
      const s = card(r, role);
      assert.equal(s.totals.reportedBalance, 62.73);
      assert.equal(s.totals.trust, 'unavailable');
      assert.deepEqual([s.totals.saved, s.totals.held, s.totals.unallocated], [null, null, null]);
      assert.equal(item(s, 'commitment:stool').saved, null);
      assert.deepEqual(held(item(s, 'commitment:apron')),
        [['apron@2026-10-06', 'Invented apron', '2026-10-06', null, null, true]]);
    }
  });
}

test('current and next classify held shares through their respective last days', () => {
  // At Oct 14, a 12.36 claim on the current period end and a 7.29 claim
  // on the next period end are both unpaid. 42.50 - 12.36 - 7.29 - 14 = 8.85.
  const r = world([goal('fabric', '2026-10-22', 12.36), goal('chalk', '2026-11-05', 7.29),
    goal('frame', '2026-11-19', 14)], 42.50);
  const now = card(r, 'current'), next = card(r, 'next');
  assert.deepEqual(amounts(now), [42.50, 21.29, 12.36, 8.85, 0]);
  assert.deepEqual(amounts(next), [42.50, 14, 19.65, 8.85, 0]);
  for (const s of [now, next]) {
    assert.deepEqual(held(item(s, 'commitment:fabric')),
      [['fabric@2026-10-22', 'Invented fabric', '2026-10-22', 12.36, 12.36, false]]);
  }
  assert.deepEqual(held(item(now, 'commitment:chalk')), []);
  assert.deepEqual(held(item(next, 'commitment:chalk')),
    [['chalk@2026-11-05', 'Invented chalk', '2026-11-05', 7.29, 7.29, false]]);
});

test('all-held, including a short claim, publishes zero saved and keeps the row', () => {
  const r = world([goal('ink', '2026-10-15', 55)], 43.21);
  for (const role of ['current', 'next']) {
    const s = card(r, role), row = item(s, 'commitment:ink');
    assert.deepEqual(amounts(s), [43.21, 0, 43.21, 0, 0]);
    assert.deepEqual([row.saved, row.needed, row.held], [0, 0, 43.21]);
    assert.deepEqual(held(row), [['ink@2026-10-15', 'Invented ink', '2026-10-15', 43.21, 55, false]]);
  }
});

test('a mixed group discloses the held member and splits its share from future savings', () => {
  const r = world([goal('wheel', '2026-10-11', 17.25, { group: 'studio' }),
    goal('kiln', '2026-11-13', 26.40, { group: 'studio' })], 50, {
    groups: [{ id: 'studio', label: 'Invented studio', planSpendSummary: true }],
  });
  for (const role of ['current', 'next']) {
    const s = card(r, role);
    assert.deepEqual(amounts(s), [50, 26.4, 17.25, 6.35, 0]);
    const row = item(s, 'group:studio');
    assert.equal(s.items.length, 1);
    assert.deepEqual([row.saved, row.needed, row.held], [26.4, 26.4, 17.25]);
    assert.deepEqual(held(row), [['wheel@2026-10-11', 'Invented wheel', '2026-10-11', 17.25, 17.25, true]]);
  }
});

test('a missing display name keeps its funded row and held member visible by key', () => {
  const result = world([goal('paint', '2026-10-15', 3.45, { label: '' }),
    goal('wood', '2026-11-20', 5.67, { label: '' })], 10);
  const s = card(result, 'current');
  assert.deepEqual(amounts(s), [10, 5.67, 3.45, 0.88, 0]);
  assert.equal(item(s, 'commitment:wood').label, 'commitment:wood');
  assert.equal(item(s, 'commitment:paint').heldMembers[0].label, 'paint@2026-10-15');
});

test('a known balance with no goals is entirely unallocated, including an actual zero', () => {
  for (const balance of [33.70, 0]) {
    const r = world([], balance);
    for (const role of ['current', 'next']) {
      const s = card(r, role);
      assert.deepEqual(s.items, []);
      assert.deepEqual(amounts(s), [balance, 0, 0, balance, 0]);
      assert.equal(s.totals.trust, 'calculated');
    }
  }
});

test('a reported balance still draws before the combined allocation policy takes effect', () => {
  const result = world([], 18.25, { patch(plan) {
    plan.savingsEarmarks.allocationPolicy.effectiveFrom = '2026-12-01';
  } });
  assert.equal(result.savingsInventory.reportedStock.amount, 18.25);
  for (const role of ['current', 'next']) {
    const s = card(result, role);
    assert.equal(s.totals.reportedBalance, 18.25);
    assert.equal(s.totals.reportedBalanceTrust, 'calculated');
    assert.equal(s.totals.trust, 'unavailable');
    assert.deepEqual(amounts(s), [null, null, null, null, null]);
  }
});

test('double-counted transfer evidence withholds allocations while retaining the reported balance and names', () => {
  const { plan, asOf, opts } = require('./fixtures/savings-transfer-cutoffs')('double-count');
  const r = Forecast.recommend(plan, asOf, opts);
  assert.equal(r.savingsFunding.goalAllocation.status, 'unavailable');
  for (const role of ['current', 'next']) {
    const s = card(r, role);
    assert.equal(s.totals.reportedBalance, 200);
    assert.equal(s.totals.trust, 'unavailable');
    assert.deepEqual(amounts(s), [null, null, null, null, null]);
    assert.deepEqual(s.items.map(i => i.id).sort(), ['group:club', 'yearly-bill:home-cost']);
    assert.ok(s.items.every(i => i.trust === 'unavailable' && i.saved === null));
  }
});

test('row trust follows earlier estimated claims, and an actual zero share stays numeric', () => {
  const r = world([goal('brush', '2026-11-18', 9, { confidence: 'estimated' }),
    goal('stand', '2026-11-21', 17), goal('mat', '2026-11-22', 8)], 15);
  const s = card(r, 'current');
  assert.deepEqual(s.items.map(i => [i.saved, i.needed, i.trust]),
    [[9, 9, 'estimated'], [6, 17, 'estimated'], [0, 8, 'estimated']]);
});

const corpus = Snap.loadInventedInputs();
const base = corpus.find(i => i.id === 'savings-live-ready').doc;
function fromDoc(doc, F = Forecast, shift = 0) {
  const { data, periods } = structuredClone(doc);
  return F.recommend(data.plan, F.addDays(data.meta.asOf, shift), Snap.pageOptions(data, periods));
}

test('missing account evidence withholds all values while keeping the goal names', () => {
  const doc = structuredClone(base);
  doc.data.plan.savingsPoolObservation.accounts.pop();
  for (const role of ['current', 'next']) {
    const s = card(fromDoc(doc), role);
    assert.deepEqual(s.items.map(i => i.id).sort(), ['group:club', 'yearly-bill:home-cost']);
    assert.ok(s.items.every(i => i.trust === 'unavailable' && i.saved === null && i.held === null));
    assert.deepEqual(amounts(s), [null, null, null, null, null]);
  }
});

test('both account values contribute; the weaker valid date tags every share as estimated', () => {
  const doc = structuredClone(base);
  doc.data.plan.savingsPoolObservation.accounts[0].evidenceDate = '2026-10-01';
  const s = card(fromDoc(doc), 'current');
  assert.deepEqual(amounts(s), [119, 119, 0, 0, 0]);
  assert.deepEqual(s.items.map(i => [i.id, i.saved, i.needed, i.trust]),
    [['group:club', 95, 230, 'estimated'], ['yearly-bill:home-cost', 24, 24, 'estimated']]);
  assert.equal(s.totals.trust, 'estimated');
});

test('every figure, held member and trust tag reaches the private figures snapshot', () => {
  const { data, periods } = structuredClone(base);
  const snap = Snap.buildFiguresSnapshot(data, periods);
  const r = fromDoc(base);
  let members = 0;
  for (const view of r.payPeriodViews.filter(v => ['current', 'next'].includes(v.timelineRole))) {
    const s = view.stackSummary.savings, p = 'period.' + view.start;
    for (const field of ['balance', 'reportedBalance', 'reportedBalanceTrust', 'saved', 'needed', 'held', 'unallocated', 'deficit', 'trust']) {
      const key = p + '.stackSavings' + field[0].toUpperCase() + field.slice(1);
      assert.ok(Object.hasOwn(snap, key), key);
      assert.equal(snap[key], s.totals[field], key);
    }
    for (const row of s.items) {
      const prefix = p + '.stackSavingsGoal.' + row.id;
      for (const field of ['saved', 'held', 'heldOnly', 'needed', 'trust']) {
        assert.ok(Object.hasOwn(snap, prefix + '.' + field));
        assert.equal(snap[prefix + '.' + field], row[field]);
      }
      for (const member of row.heldMembers) {
        members++;
        for (const field of ['date', 'saved', 'needed', 'overdue']) {
          const key = prefix + '.heldMember.' + member.key + '.' + field;
          assert.ok(Object.hasOwn(snap, key), key);
          assert.equal(snap[key], member[field], key);
        }
      }
    }
  }
  assert.equal(members, 3, 'all three goals are held on the second card');
});

// Inject malformed upstream allocations at the existing consumer boundary.
// Each copy runs recommend(), including the real publication of stackSummary.
const fs = require('node:fs');
const Module = require('node:module');
function withEditedCardCall(replacement) {
  const file = require.resolve('../public/forecast.js'), mod = new Module(file, module);
  mod.filename = file;
  mod.paths = module.paths;
  const source = fs.readFileSync(file, 'utf8');
  const anchor = 'savings: stackSavings(view, result)';
  assert.equal(source.split(anchor).length, 2);
  mod._compile(source.replace(anchor, replacement), file);
  return mod.exports;
}

test('orphaned, duplicated or unreconciled shares withhold allocation amounts', () => {
  for (const change of [
    'funding.rows[0].members.pop()',
    'funding.rows[0].members.push(funding.rows[0].members[0])',
    'funding.backing.items[0].saved -= 1',
  ]) {
    const malformed = withEditedCardCall(`savings: (() => {
      if (!result.savingsFunding?.goalAllocation) return stackSavings(view, result);
      const funding = structuredClone(result.savingsFunding);
      ${change};
      return stackSavings(view, { ...result, savingsFunding: funding });
    })()`);
    const s = card(fromDoc(base, malformed), 'current');
    assert.equal(s.totals.reportedBalance, 119);
    assert.equal(s.totals.trust, 'unavailable', change);
    assert.deepEqual(amounts(s), [null, null, null, null, null], change);
    assert.ok(s.items.every(i => i.saved === null && i.held === null), change);
  }
});

test('invented corpus reconciles in cents and publishes only on current and next views', () => {
  const cents = value => Math.round(value * 100);
  const total = (rows, key) => rows.reduce((sum, row) => sum + cents(row[key]), 0);
  let calculated = 0, periods = 0;
  for (const inp of corpus) for (const shift of [0, 3, 7, 14]) {
    const advice = fromDoc(inp.doc, Forecast, shift), funding = advice.savingsFunding;
    for (const view of advice.payPeriodViews) {
      periods++;
      const s = view.stackSummary.savings;
      if (!['current', 'next'].includes(view.timelineRole)) {
        assert.equal(s, null, inp.id);
        continue;
      }
      const t = s.totals;
      if (t.trust === 'unavailable') {
        assert.deepEqual(amounts(s), [null, null, null, null, null], inp.id);
        continue;
      }
      calculated++;
      assert.equal(funding.goalAllocation.status, 'ready');
      assert.equal(t.reportedBalance, funding.stock.reportedStock.amount);
      assert.equal(cents(t.balance), cents(t.saved) + cents(t.held) + cents(t.unallocated), inp.id);
      assert.equal(cents(t.balance) - cents(t.deficit), cents(funding.goalAllocation.funds), inp.id);
      for (const field of ['saved', 'needed', 'held']) assert.equal(cents(t[field]), total(s.items, field), inp.id);
      for (const row of s.items) {
        assert.ok(row.saved >= 0 && row.saved <= row.needed, inp.id);
        assert.equal(total(row.heldMembers, 'saved'), cents(row.held), inp.id);
      }
    }
  }
  assert.ok(calculated > 4 && periods > 100);
});

test('publishing the Stack Savings card leaves every other Forecast result intact', () => {
  const without = withEditedCardCall('savings: null');
  const strip = r => {
    for (const view of r.payPeriodViews) delete view.stackSummary.savings;
    return JSON.stringify(r);
  };
  for (const { id, doc } of corpus) assert.equal(strip(fromDoc(doc)), strip(fromDoc(doc, without)), id);
});

test('a yearly card fee explicitly excluded from savings stays a bill and leaves both Savings cards', () => {
  function fee(flagged) {
    const w = H.baseWorld();
    w.commitments = [goal('trip', '2026-11-20', 60)];
    w.savingsPool = {};
    w.accounts.push({ id: 'travelvisa', providerId: 9004, role: 'revolving-credit',
      collection: 'debts', label: 'Invented card', value: 0 });
    w.debts = [{ id: 'travelvisa', label: 'Invented card', structure: 'Revolving', secured: false,
      balance: 0, pending: 0, rate: 0, limit: 2000, statementCloseDay: 17 }];
    w.bills.push({ id: 'annual', label: 'Invented annual fee', frequency: 'yearly', month: 11, day: 27,
      firstDue: '2026-11-27', amount: 30, confidence: 'estimated', budgetCategory: null,
      jointCash: false, payingAccount: 'travelvisa', ...(flagged ? { savingsGoal: false } : {}) });
    const { data, error } = H.dataOf(w);
    if (error) throw error;
    assert.ok(data.plan.bills.some(b => b.id === 'annual'));
    return Forecast.recommend(data.plan, w.asOf, Snap.pageOptions(data, null));
  }
  for (const flagged of [false, true]) {
    const r = fee(flagged);
    for (const role of ['current', 'next']) {
      const ids = card(r, role).items.map(i => i.id);
      assert.equal(ids.includes('yearly-bill:annual'), !flagged);
      assert.ok(ids.includes('commitment:trip'));
    }
  }
});
