'use strict';
// The Forecast output behind test/browser-pending-lookalike.js, without a
// browser: a pending row that only looks like a posted one (same date,
// account, amount and merchant) leaves its category's spent at the posted
// side counted once but tags it estimated (trust 'estimated', plannedTrust
// 'calculated', estimateReason 'possible-duplicate'), with both rows in the
// category's listing; a lone pending row, two posted purchases and an
// unrelated category are unchanged. Invented household from
// test/acceptance/harness.js; no household figure.
//
//   node test/test-pending-lookalike.js
const assert = require('node:assert/strict');
const H = require('./acceptance/harness.js');
const F = require('../public/forecast.js');

function rows(extra) {
  const w = H.baseWorld();
  w.transactions = [H.lm({ date: '2026-10-09', amount: -1400, category: 'Payroll', account: 'chequing-a', payee: 'Invented employer' })]
    .concat(extra.map(H.lm));
  const { data, packet, error } = H.dataOf(w);
  assert.equal(error, null);
  const view = F.recommend(data.plan, data.meta.asOf, { currentPeriodActuals: packet, debts: data.debts }).defaultView;
  const period = (view.calendarPeriods || []).find(p => p.id === 'this-pay-period');
  assert.ok(period, 'positive control: the current pay period is published');
  return id => period.householdBudget.find(r => r.id === id);
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (err) { failures++; console.log('  FAIL  ' + name + ' -- ' + String(err && err.message || err).split('\n')[0]); }
}

const cafe = { date: '2026-10-11', amount: 6.5, category: 'Restaurants', payee: 'Invented cafe' };
check('a pending look-alike tags its category spent estimated and keeps both rows listed', () => {
  const row = rows([cafe, { ...cafe, pending: true }]);
  const eating = row('restaurants');
  assert.equal(eating.spent, 6.5, 'the posted side counts once');
  assert.equal(eating.remaining, 93.5);
  assert.equal(eating.trust, 'estimated');
  assert.equal(eating.plannedTrust, 'calculated', 'the plan keeps its own trust');
  assert.equal(eating.estimateReason, 'possible-duplicate');
  assert.equal(eating.hold, 100, 'the hold keeps the plan');
  assert.deepEqual(eating.recon.map(r => [r.amount, r.pending === true, r.pendingPostedDuplicate === true]),
    [[6.5, false, true], [6.5, true, true]]);
  const groceries = row('groceries');
  assert.equal(groceries.spent, 0, 'an unrelated category keeps its precise spent');
  assert.equal(groceries.trust, undefined);
});
check('control: a lone pending purchase is counted as before', () => {
  const eating = rows([{ ...cafe, pending: true }])('restaurants');
  assert.equal(eating.spent, 6.5);
  assert.equal(eating.remaining, 93.5);
  assert.equal(eating.trust, undefined);
});
check('control: two posted purchases at the same merchant are counted, not estimated', () => {
  const eating = rows([cafe, { ...cafe }])('restaurants');
  assert.equal(eating.spent, 13);
  assert.equal(eating.trust, undefined);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall cases pass');
process.exit(failures ? 1 : 0);
