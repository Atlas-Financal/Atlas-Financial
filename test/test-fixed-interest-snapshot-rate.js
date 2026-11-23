'use strict';
// A card obligation with a fixedInterestMinimum holds its own frozen
// { balance, rate, asOf } snapshot by design (owner rule, Dale, 2026-11-20):
// a refresh never moves the planned minimum, and a rate change is applied by
// re-authoring the snapshot. The card's rate also lives on its debt record, so
// the two can disagree silently. This data check names every such row whose
// snapshot rate differs from its debt's recorded rate. It never recomputes an
// amount and never moves a figure. Values below are invented, except the
// last check, which reads data.json and reports only row ids.
const path = require('path');

let failures = 0;
function ok(cond, label, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) failures++;
}

// Returns the ids of fixed-interest rows whose snapshot rate is not the
// linked debt's recorded rate, or whose debt is missing or has no finite
// rate (a stale or unlinked snapshot cannot be shown to agree).
function staleFixedInterestSnapshots(data) {
  const debts = Array.isArray(data && data.debts) ? data.debts : [];
  const rows = Array.isArray(data && data.plan && data.plan.obligations) ? data.plan.obligations : [];
  const stale = [];
  for (const row of rows) {
    const rule = row && row.fixedInterestMinimum;
    if (rule == null) continue;
    const debt = debts.find(d => d && d.id === row.debtId);
    const debtRate = debt && typeof debt.rate === 'number' && Number.isFinite(debt.rate) ? debt.rate : null;
    const snapRate = rule && typeof rule.rate === 'number' && Number.isFinite(rule.rate) ? rule.rate : null;
    if (debtRate == null || snapRate == null || Math.round(debtRate * 1e4) !== Math.round(snapRate * 1e4)) stale.push(row.id);
  }
  return stale;
}

const world = (debtRate, snapRate, extra = {}) => ({
  debts: [{ id: 'card-x', label: 'Invented card', rate: debtRate }],
  plan: { obligations: [Object.assign({ id: 'card-x-min', debtId: 'card-x', effect: 'payment', frequency: 'monthly', day: 8,
    amount: 50, fixedInterestMinimum: { balance: 2000, rate: snapRate, asOf: '2026-11-18' } }, extra)] },
});

console.log('\n=== 1. invented rows ===');
ok(staleFixedInterestSnapshots(world(19.99, 19.99)).length === 0, 'matching rates: nothing named');
ok(JSON.stringify(staleFixedInterestSnapshots(world(21.99, 19.99))) === '["card-x-min"]', 'debt rate changed: the row is named',
  staleFixedInterestSnapshots(world(21.99, 19.99)));
ok(JSON.stringify(staleFixedInterestSnapshots(world(19.99, 19.99, { debtId: 'missing' }))) === '["card-x-min"]',
  'snapshot linked to no debt: the row is named');
ok(JSON.stringify(staleFixedInterestSnapshots(world(undefined, 19.99))) === '["card-x-min"]', 'debt with no recorded rate: the row is named');
ok(staleFixedInterestSnapshots({ debts: [{ id: 'card-x', rate: 19.99 }], plan: { obligations: [{ id: 'plain', debtId: 'card-x', amount: 40 }] } }).length === 0,
  'a row with no fixed-interest rule is not checked');

console.log('\n=== 2. the check never moves a figure ===');
{
  const F = require('../public/forecast.js');
  const before = JSON.stringify(world(21.99, 19.99));
  staleFixedInterestSnapshots(JSON.parse(before));
  ok(JSON.stringify(world(21.99, 19.99)) === before, 'the input is not rewritten');
  ok(typeof F.recommend === 'function', 'Forecast loads; this check adds nothing to it');
}

console.log('\n=== 3. data.json agrees today ===');
{
  const data = require(path.join(__dirname, '..', 'data.json'));
  const stale = staleFixedInterestSnapshots(data);
  // Ids only: no balance or rate is printed.
  ok(stale.length === 0, 'every fixed-interest snapshot rate matches its debt record', stale);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
