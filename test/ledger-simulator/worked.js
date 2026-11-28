'use strict';

const assert = require('node:assert/strict');
const { replay } = require('./replay');
const { inspect, checks } = require('./oracle');
const { build } = require('./habits');
const { date } = require('./household');

async function workedControls() {
  const seed = 37,
    day = 5,
    prior = await replay(seed, 4, []),
    clean = await replay(seed, day, []);
  assert.ok(prior.raw.qualified && clean.raw.qualified);
  assert.equal(prior.raw.payload.fetchedAt, date(4) + 'T18:00:00.000Z');
  // Two opening card purchases (211 + 212), daily fruit 151..156.
  assert.equal(prior.view.amounts.groceries, 1188);
  assert.equal(clean.view.amounts.groceries, 1344);
  assert.equal(clean.view.amounts.cardSpent, 211);
  const cold = await replay(seed, day, [], 'thin-card'),
    warm = await replay(seed, day, [], 'thin-card', prior.raw);
  assert.equal(cold.view.amounts.cardSpent, null, 'never observed');
  assert.deepEqual(
    [warm.view.amounts.cardSpent, warm.view.cardTrust, warm.view.cardObservedAt],
    [211, 'estimated', prior.raw.payload.fetchedAt]
  );
  assert.equal(warm.view.amounts.groceries, 1344, 'fresh sibling advances from yesterday');
  const stable = await replay(seed, day, [], 'stable-pages', prior.raw);
  const edited = await replay(seed, day, [], 'edit-between-pages', prior.raw);
  assert.deepEqual(
    stable.view.amounts,
    clean.view.amounts,
    'byte-identical overlap retains exactly one purchase'
  );
  assert.ok(!edited.raw.qualified && edited.view.retained, 'one real edit prevents qualified publication');
  assert.deepEqual(
    edited.raw.payload.transactions.filter((r) => r.id !== 410000 + day),
    stable.raw.payload.transactions.filter((r) => r.id !== 410000 + day),
    'the edit cannot add or drop another row'
  );
  const hit = new Set();
  function probe(check, alter, extra = {}) {
    const view = structuredClone(clean.view);
    const input = { seed, day, events: [], view, clean: clean.view, prior: prior.view, ...extra };
    alter(view, input);
    assert.ok(
      inspect(input).failures.some((f) => f.check === check),
      'silent oracle for ' + check
    );
    hit.add(check);
  }
  const noFailures = inspect({ seed, day, events: [], view: clean.view }).failures;
  assert.deepEqual(noFailures, [], 'hand-worked healthy ledger');
  probe('purchase-once', (v) => v.buys.push({ ...v.buys.find((r) => r.id === 410005) }));
  const own = build(seed, 'topup', day);
  probe('internal-neutral', (v) => v.incomeRows.push({ id: own.transfers[0].receipt, cents: -141 }), {
    events: [own],
  });
  probe('lists', (v) => {
    v.budgets.find((b) => b.id === 'groceries').spent = 1337;
  });
  probe('figures', (v) => {
    v.amounts.surplus = v.amounts.bad - 1;
  });
  probe(
    'fault-isolation',
    (v) => {
      v.amounts.groceries = null;
    },
    { fault: 'thin-card' }
  );
  probe(
    'last-known',
    (v) => {
      v.amounts.cardSpent = null;
      v.cardTrust = 'unavailable';
    },
    { fault: 'thin-card' }
  );
  probe('refresh', (v) => {
    v.exception = { code: 'TypeError', message: 'invented refresh exception' };
  });
  probe('no-move', (v) => {
    v.unresolved = true;
    v.moves = [{ kind: 'pay', cents: 701 }];
  });
  assert.equal(hit.size, checks.length);
  return {
    invariants: [...hit],
    priorQualified: true,
    coldCardSpent: null,
    warmCardSpent: 211,
    warmTrust: 'estimated',
    freshGroceries: 1344,
  };
}
module.exports = { workedControls };
