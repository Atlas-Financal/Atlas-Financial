'use strict';
// Authorized change (item 12, lead decision on #1156): a completed (lookback)
// pay period lists an occurrence the current period carries as history
// ("Carried to this pay period") and counts none of it. The current period
// counts it. Older engines counted it in the completed period too.
//
// Frozen-engine parity suites call this on the CURRENT engine's publication:
// it validates every carried copy (counted nowhere in its period), then
// restores the older engine's completed-period numbers for exactly those
// copies, so every other field is still byte-compared.
const assert = require('node:assert/strict');
const cents = n => Math.round(Number(n) * 100);
const add = (node, key, amount) => {
  if (node && typeof node[key] === 'number') node[key] = (cents(node[key]) + amount) / 100;
};
function stripCarriedBills(advice) {
  let validated = 0;
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const carried = Array.isArray(node.bills) ? node.bills.filter(r => r && r.carriedToCurrentPeriod === true) : [];
    if (carried.length) {
      assert.equal(node.lookback, true, 'a carried copy is listed on completed periods only');
      let amount = 0;
      for (const row of carried) {
        assert.deepEqual([row.status, row.settlement, row.remaining, row.actual], ['carried', 'carried', 0, null],
          'a carried copy claims no settlement and no remainder');
        const planned = Math.abs(Number(row.planned != null ? row.planned : row.amount));
        assert.ok(Number.isFinite(planned), 'a carried copy keeps its planned amount for display');
        amount += cents(planned);
        row.remaining = planned; // the older engine's unproven remainder
        validated++;
      }
      add(node, 'totalBillsThisPeriod', amount);
      add(node, 'periodBillLoad', amount);
      add(node.budgetProgress && node.budgetProgress.bills && node.budgetProgress.bills.planned, 'amount', amount);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, validated };
}
module.exports = { stripCarriedBills };
