'use strict';
// Invented balances, dates and transactions. Exercise the same Forecast packet that feeds Stack.
const assert = require('node:assert/strict');
const test = require('node:test');
const Forecast = require('../public/forecast');
const H = require('./acceptance/harness');

function goal(id, date, amount, extra = {}) {
  return { id, label: 'Invented ' + id, date, amount, confidence: 'confirmed', sinkingFund: true, ...extra };
}

function forecast({ balance, balanceDate, goals, purchases = [], settlementEvidence, grouped = false }) {
  const world = H.baseWorld();
  const account = world.accounts.find(row => row.id === 'savings');
  account.value = balance;
  if (balanceDate) account.balanceDate = balanceDate;
  world.savingsPool = {};
  world.commitments = goals;
  if (grouped) world.groups = [{ id: 'outing', label: 'Invented outing', planSpendSummary: true }];
  if (purchases.length) world.links = [{ categoryId: 106, goalRef: { kind: 'commitment', id: goals[0].id },
    occurrenceDate: goals[0].date, effectiveFrom: '2026-10-01', effectiveThrough: '2026-12-31' }];
  world.transactions = purchases.map(purchase => H.lm({ category: 'Trip', account: 'savings', ...purchase }));
  const { data, error } = H.dataOf(world);
  if (error) throw error;
  return Forecast.recommend(data.plan, world.asOf, { ...data.liveOverlay, debts: data.debts, settlementEvidence });
}

function cards(advice) {
  return ['current', 'next'].map(role => advice.payPeriodViews.find(view => view.timelineRole === role).stackSummary.savings);
}

function checkCard(card, id, saved, needed) {
  const row = card.items.find(item => item.id === id);
  assert.ok(row, `the card shows ${id}`);
  assert.deepEqual([row.saved, row.needed], [saved, needed]);
}

const debit = [{ date: '2026-10-12', amount: 128.35 }];
const canoe = goal('canoe', '2026-11-18', 317.80);

// The remaining cost in BOTH cases is 317.80 - 128.35 = 189.45.
for (const { name, balance, funds, saved, deficit } of [
  { name: 'money already spent', balance: 242.60, funds: 114.25, saved: 114.25, deficit: 0 },
  { name: 'spending beyond stock', balance: 91.10, funds: 0, saved: 0, deficit: 37.25 },
]) test(`dated balance with ${name} publishes the pool once`, () => {
  const advice = forecast({ balance, balanceDate: '2026-10-10', goals: [canoe], purchases: debit });
  const funding = advice.savingsFunding;
  assert.equal(funding.goalAllocation.status, 'ready');
  assert.equal(funding.backing.items.find(item => item.id === 'canoe').saved, saved);
  for (const card of cards(advice)) {
    checkCard(card, 'commitment:canoe', saved, 189.45);
    assert.deepEqual([card.totals.balance, card.totals.held, card.totals.unallocated, card.totals.deficit], [funds, 0, 0, deficit]);
    assert.equal(card.totals.trust, 'estimated');
  }
  assert.equal(funding.backing.deficit, deficit);
});

test('an unknown earlier need withholds shares but preserves a proven pool deficit', () => {
  const advice = forecast({ balance: 91.10, balanceDate: '2026-10-10', purchases: debit,
    goals: [canoe, goal('repair', '2026-10-05', null, { confidence: 'estimated', amountMin: 20, amountMax: 70 })] });
  const funding = advice.savingsFunding;
  assert.equal(funding.goalAllocation.status, 'unavailable');
  // Whatever the repair ultimately costs, the debit already exceeds stock by 37.25.
  assert.equal(funding.backing.deficit, 37.25);
  for (const card of cards(advice)) {
    assert.equal(card.totals.deficit, 37.25);
    assert.equal(card.totals.trust, 'unavailable');
    assert.deepEqual([card.totals.saved, card.totals.held, card.totals.unallocated], [null, null, null]);
  }
});

test('a dated but allocation-ready pool publishes its unallocated cents', () => {
  const advice = forecast({ balance: 247.82, balanceDate: '2026-10-10', goals: [goal('supplies', '2026-11-18', 92.09)] });
  // No intervening payment. The unallocated 155.73 remains visible alongside 92.09 saved.
  assert.equal(advice.savingsFunding.goalAllocation.status, 'ready');
  assert.equal(advice.savingsFunding.backing.unallocated, 155.73);
  for (const card of cards(advice)) {
    checkCard(card, 'commitment:supplies', 92.09, 92.09);
    assert.deepEqual([card.totals.balance, card.totals.held, card.totals.unallocated], [247.82, 0, 155.73]);
  }
});

for (const pending of [false, true]) test(`a settled item's ${pending ? 'pending' : 'posted'} refund uses Forecast's allocation`, () => {
  const goals = [goal('booking', '2026-11-14', 82, { settledOn: '2026-10-12' }), goal('camp', '2026-11-28', 241)];
  const purchases = [{ date: '2026-10-12', amount: 82 }, { date: '2026-10-13', amount: -19, pending }];
  const advice = forecast({ balance: 233, balanceDate: '2026-10-10', goals, purchases });
  const funding = advice.savingsFunding;
  assert.equal(funding.goalAllocation.status, 'ready');
  const share = funding.backing.items.find(item => item.id === 'camp').saved;
  // 233 - 82 + 19 posted = 170. Pending-refund qualification belongs to the allocator
  // (SAV-C). Reusing its actual share here lets that correction reach both cards.
  if (!pending) assert.equal(share, 170);
  for (const card of cards(advice)) {
    checkCard(card, 'commitment:camp', share, 241);
    assert.deepEqual([card.totals.balance, card.totals.saved, card.totals.held, card.totals.unallocated], [share, share, 0, 0]);
  }
});

for (const grouped of [false, true]) test(`an evidence-paid goal preserves ${grouped ? 'its active group member' : 'the active goal'}`, () => {
  const group = grouped ? { group: 'outing' } : {};
  const goals = [goal('pass', '2026-11-15', 46.23, group), goal('supplies', '2026-11-18', 95.04, group)];
  const settlementEvidence = { commitments: [{ goalId: 'commitment:pass', links: [{ assignedCents: 4623, effectiveDate: '2026-10-12' }] }] };
  const advice = forecast({ balance: 187.41, goals, grouped, settlementEvidence });
  const funding = advice.savingsFunding;
  assert.equal(funding.backing.items.find(item => item.id === 'pass').paymentStatus, 'paid');
  assert.equal(funding.goalAllocation.status, 'ready');
  for (const card of cards(advice)) {
    // The paid pass has no claim. 187.41 - 95.04 = 92.37 free.
    checkCard(card, grouped ? 'group:outing' : 'commitment:supplies', 95.04, 95.04);
    assert.equal(card.items.length, 1);
    assert.deepEqual([card.totals.saved, card.totals.held, card.totals.unallocated, card.totals.balance], [95.04, 0, 92.37, 187.41]);
  }
});
