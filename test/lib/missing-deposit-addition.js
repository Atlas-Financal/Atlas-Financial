'use strict';
// Authorized addition (missing current-period paycheque, audit finding 5b): a scheduled income of the
// current pay period with no posted deposit publishes `depositStatus: 'to-confirm'` (and
// `businessDaysLate`) after two business days, or `depositStatus: 'pending'`, and the period's
// income / after-bills / balance-after-deductions trust read estimated. Frozen-engine parity suites
// validate each such row concretely here (a current-period income row, planned amount counted,
// no actual, never received, at least two business days late), remove exactly those two row fields, and
// leave out the three trust words of exactly the periods that carry one, on BOTH sides. Every amount,
// and every other period and field, still compares exactly.
const assert = require('node:assert/strict');
const TRUST_KEYS = ['incomeTrust', 'afterBillsTrust', 'balanceAfterDeductionsTrust'];

function stripMissingDeposit(advice) {
  const held = new Set();
  let validated = 0;
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.income) && node.income.some(row => row && Object.hasOwn(row, 'depositStatus'))) {
      assert.ok(node.start && node.timelineRole !== 'past' && node.lookback !== true, 'a deposit status is published on a current-period row only');
      for (const row of node.income) {
        if (!row || !Object.hasOwn(row, 'depositStatus')) continue;
        assert.ok(['to-confirm', 'pending'].includes(row.depositStatus), 'a published deposit status word');
        assert.ok(row.actual == null && row.status !== 'received' && row.amount === row.planned, 'a held deposit is planned, never received');
        if (row.depositStatus === 'to-confirm') {
          assert.ok(Number.isInteger(row.businessDaysLate) && row.businessDaysLate >= 2, 'to confirm only after two business days');
          held.add(node.start);
        }
        delete row.depositStatus; delete row.businessDaysLate;
        validated++;
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return { advice, held, validated };
}

// The same three words left out of the periods that carry a held row, in either engine's output.
function omitTrustOnPeriods(advice, starts) {
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (typeof node.start === 'string' && starts.has(node.start) && Array.isArray(node.income)) {
      for (const key of TRUST_KEYS) delete node[key];
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(advice);
  return advice;
}

module.exports = { stripMissingDeposit, omitTrustOnPeriods };
