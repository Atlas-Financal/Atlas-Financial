'use strict';
const assert = require('node:assert/strict');

// Bills audit of main 57cb421 (authorized figure movement): Balance After
// Deductions deducts the FULL assigned period bill load, and a row Forecast
// only assumes is inside the opening cash (settlement 'opening') prints
// 'in opening', never PAID. Frozen engines predate both.
//
// For frozen-engine comparisons this helper first PROVES each period
// publication on the current engine by its own identity —
//   periodBillLoad = every dated assigned row once (a settledInOpening
//   firstDue stub is a disclosure, not an assigned occurrence), and
//   balanceAfterDeductions = incomeTotal − periodBillLoad − budgetHold
//   (− the published Savings-item term) —
// then RESTORES the incumbent shape: opening rows back to PAID/remaining 0
// with the matching paid/remaining disclosure, and every BAD-family figure
// shifted back by exactly the bills the old opening exclusion dropped. The
// caller's deepEqual then verifies those restored values to the cent, so a
// wrong full load still fails. Cash closes, seeds and sweeps are not touched.
//
// A completed (lookback) period is the one exception: historical sealing
// rewrites an opening row to planned/unverified before publication, so the
// published rows no longer say which bills the old exclusion dropped. There
// the identity is still proved on the current engine, and the BAD-family
// figures are left out of the comparison on BOTH sides (pass the frozen
// engine's publication through `frozen`).
const PERIOD_PATH = /^\/(payPeriodViews|pastPeriodViews|defaultView\/calendarPeriods)\/\d+$/;
const cents = v => Math.round(Number(v) * 100);
const amountOf = row => Math.abs(Number(row.planned != null ? row.planned : row.amount) || 0);
const sameDayCashSources = new Set(['snapshot', 'cutover-walk', 'carry-forward']);
const BAD_FAMILY = ['periodBillLoad', 'afterBills', 'afterRemainingBills', 'afterHouseholdBudget',
  'balanceAfterDeductions', 'predictedEndingBalance', 'afterDebtRepayment', 'afterBigPurchases', 'projectedEnding'];
const LEFTOVER_FAMILY = ['afterBills', 'afterHouseholdBudget', 'afterDebtRepayment', 'afterBigPurchases'];

function omitLookbackBadFamily(period) {
  for (const key of BAD_FAMILY) delete period[key];
  // A completed period whose spending the observation cannot prove stamps its
  // placeholder household hold Unavailable (never a printed $0.00); frozen
  // engines predate that stamp, so it is left out on both sides like the BAD
  // family. The new stamp is proved in test-past-period-unknown-stays-unknown.js.
  delete period.budgetHoldTrust;
  // Likewise its unobserved Other income publishes amount null with an
  // unavailable stamp (never a printed $0.00); frozen engines predate it.
  // Only the amount and stamp are left out, on both sides; the listed items
  // are still compared. Proved in test-past-other-income-unobserved.js.
  if (period.otherIncome && typeof period.otherIncome === 'object') {
    delete period.otherIncome.amount;
    delete period.otherIncome.unavailable;
  }
  if (period.leftover && typeof period.leftover === 'object') for (const key of LEFTOVER_FAMILY) delete period.leftover[key];
  const terms = period.predictedEndingBalanceTerms;
  if (terms && typeof terms === 'object') { delete terms.assignedBills; delete terms.balanceAfterDeductions; }
  return period;
}

function oldOpeningExcluded(row, period) {
  if (row.settledInOpening === true || row.settlement === 'opening') return true;
  const settled = row.status === 'PAID' || row.settlement === 'represented';
  if (!settled || !period.openingAsOf || !row.date) return false;
  if (row.date < period.openingAsOf) return true;
  return row.date === period.openingAsOf && !sameDayCashSources.has(period.openingSource);
}

function restorePeriod(period) {
  const bills = Array.isArray(period.bills) ? period.bills : [];
  let dropped = 0;
  let assigned = 0;
  for (const row of bills) {
    if (!row || row.needsDate) continue;
    if (row.settledInOpening !== true) assigned += cents(row.scheduledFeeAllowance
      ? row.scheduledFeeAllowance.periodCost : amountOf(row));
    if (row.settledInOpening !== true && oldOpeningExcluded(row, period)) {
      dropped += cents(row.scheduledFeeAllowance ? row.scheduledFeeAllowance.periodCost : amountOf(row));
    }
  }
  if (typeof period.periodBillLoad === 'number') {
    assert.equal(cents(period.periodBillLoad), assigned, 'BAD bill load is every assigned bill once');
    if (typeof period.balanceAfterDeductions === 'number' && typeof period.incomeTotal === 'number'
        && typeof period.budgetHold === 'number') {
      const item = period.predictedEndingBalanceTerms && typeof period.predictedEndingBalanceTerms.savingsItemSpending === 'number'
        ? cents(period.predictedEndingBalanceTerms.savingsItemSpending) : 0;
      assert.equal(cents(period.balanceAfterDeductions),
        cents(period.incomeTotal) - assigned - cents(period.budgetHold) - item,
        'BAD = income − assigned bills − household hold');
    }
  }
  if (period.lookback === true) return omitLookbackBadFamily(period);
  // Opening rows: incumbent printed PAID with remaining 0.
  let openingRemaining = 0;
  let openingPaid = 0;
  for (const row of bills) {
    if (!row || row.settlement !== 'opening' || row.status !== 'in opening') continue;
    assert.notEqual(row.glanceKind, 'paid', 'an opening row is never shown paid');
    openingRemaining += cents(row.remaining || 0);
    openingPaid += cents(row.movement != null ? Math.abs(row.movement) : amountOf(row));
    row.status = 'PAID';
    row.glanceKind = 'paid';
    row.remaining = 0;
  }
  if (typeof period.remainingBills === 'number') period.remainingBills = (cents(period.remainingBills) - openingRemaining) / 100;
  if (typeof period.paidBills === 'number') period.paidBills = (cents(period.paidBills) + openingPaid) / 100;
  if (!dropped) return period;
  const back = v => typeof v === 'number' ? (cents(v) + dropped) / 100 : v;
  if (typeof period.periodBillLoad === 'number') period.periodBillLoad = (cents(period.periodBillLoad) - dropped) / 100;
  for (const key of BAD_FAMILY.filter(k => k !== 'periodBillLoad')) {
    if (Object.hasOwn(period, key)) period[key] = back(period[key]);
  }
  if (period.leftover && typeof period.leftover === 'object') {
    for (const key of LEFTOVER_FAMILY) {
      if (Object.hasOwn(period.leftover, key)) period.leftover[key] = back(period.leftover[key]);
    }
  }
  const terms = period.predictedEndingBalanceTerms;
  if (terms && typeof terms === 'object') {
    if (typeof terms.assignedBills === 'number') terms.assignedBills = (cents(terms.assignedBills) - dropped) / 100;
    if (Object.hasOwn(terms, 'balanceAfterDeductions')) terms.balanceAfterDeductions = back(terms.balanceAfterDeductions);
  }
  return period;
}

function walkPeriods(advice, fn) {
  const copy = JSON.parse(JSON.stringify(advice));
  const visit = (node, path) => {
    if (Array.isArray(node)) { node.forEach((child, i) => visit(child, path + '/' + i)); return; }
    if (!node || typeof node !== 'object') return;
    if (PERIOD_PATH.test(path)) fn(node);
    for (const key of Object.keys(node)) visit(node[key], path + '/' + key);
  };
  visit(copy, '');
  return copy;
}

// Current engine: prove, then restore (returns a deep JSON copy).
module.exports = function restoreLegacyBadFamily(advice) {
  return walkPeriods(advice, restorePeriod);
};
// Frozen engine: only the lookback BAD-family omission (returns a deep copy).
module.exports.frozen = function frozenLegacyBadFamily(advice) {
  return walkPeriods(advice, period => { if (period.lookback === true) omitLookbackBadFamily(period); });
};
