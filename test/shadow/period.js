'use strict';

const { periodDates, scheduledRows } = require('./schedule');
const { minimumRows } = require('./cash-card');
const cents = amount => Number.isFinite(amount) ? Math.round(amount * 100) : null;

function sumKnown(values) {
  return values.includes(null) ? null : values.reduce((sum, n) => sum + n, 0);
}

function householdHold(plan, actuals, start, end) {
  // The generator supplies ledger-labelled purchases with distinct identities.
  // Both a pending purchase and a posted purchase use the category the ledger
  // supplied. Recognising transfers or matching a replacement is ledger work.
  return sumKnown(plan.budget.categories.map(category => {
    const spent = sumKnown(actuals.transactions
      .filter(row => row.date >= start && row.date <= end && row.categoryLabel === category.label)
      .map(row => cents(row.amount)));
    // The generated plan has no monthly, weekly or historical fallback.
    // An undeclared target contributes nothing above actual spend (#1088).
    const target = category.plannedPayday;
    if (target != null && (!Number.isFinite(target) || target < 0)) return null;
    const planned = cents(target ?? 0);
    return spent === null ? null : Math.max(spent, planned);
  }));
}

function orderOccurrences(a, b) {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function expectedPeriod({ plan, asOf, opts }) {
  const dates = periodDates(plan, asOf);
  if (!dates) return null;
  const { start, end, nextPayday } = dates;
  const occurrences = scheduledRows(plan, start, end);
  const minimums = minimumRows(plan, start, end);
  const income = sumKnown(occurrences.income.map(row => row.cents));
  const household = householdHold(plan, opts.currentPeriodActuals, start, end);
  const mortgage = sumKnown(occurrences.bills.filter(row => row.kind === 'mortgage').map(row => row.cents));
  const bills = sumKnown(occurrences.bills.filter(row => row.kind === 'bill').map(row => row.cents));
  const credit = sumKnown(minimums.map(row => row.cents));
  const billLoad = sumKnown([bills, mortgage, credit]);
  const listed = occurrences.bills.concat(minimums)
    .map(row => ({ id: row.id, date: row.date, amount: row.cents })).sort(orderOccurrences);
  const assigned = billLoad === null ? null : listed;
  const terms = { income, bills, household, mortgage, credit };
  const complete = Object.values(terms).every(value => value !== null);
  const surplus = complete ? income - bills - household - mortgage - credit : null;
  // The generated plan has no held outflows, savings-item spending or
  // above-minimum payments. These can otherwise distinguish the two figures.
  const balanceAfterDeductions = complete ? income - billLoad - household : null;
  return { start, end, nextPayday, income, billLoad, household, balanceAfterDeductions, assigned, listed,
    stack: { amount: surplus, terms: complete ? terms : null } };
}

module.exports = { expectedPeriod };
