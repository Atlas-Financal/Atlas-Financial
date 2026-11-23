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
  const minimumCredit = sumKnown(minimums.map(row => row.cents));
  const billLoad = sumKnown([bills, mortgage, minimumCredit]);
  // Desk ruling (E) (#1573): each card's repayment target adds the amount that brings it back under its limit (OD-028),
  // as of today, so in the as-of period. The generated card has no card-account ledger, so no charge is counted above:
  // its deduction is its whole target, and the Credit term is the minimums plus the amount over the limit. Worked here
  // from the generated debt alone: over = max(0, balance + pending − limit), in cents.
  const overLimit = sumKnown((opts.debts || []).filter(debt => debt.id !== 'heloc' && debt.limit != null)
    .map(debt => Math.max(0, cents(debt.balance) + cents(debt.pending || 0) - cents(debt.limit))));
  const credit = minimumCredit === null || overLimit === null ? null : minimumCredit + overLimit;
  const listed = occurrences.bills.concat(minimums)
    .map(row => ({ id: row.id, date: row.date, amount: row.cents })).sort(orderOccurrences);
  const assigned = billLoad === null ? null : listed;
  const terms = { income, bills, household, mortgage, credit };
  const complete = Object.values(terms).every(value => value !== null);
  const surplus = complete ? income - bills - household - mortgage - credit : null;
  // The generated plan has no held outflows, savings-item spending or
  // above-minimum payments. These can otherwise distinguish the two figures.
  const balanceAfterDeductions = complete ? income - billLoad - household - overLimit : null;
  return { start, end, nextPayday, income, billLoad, household, balanceAfterDeductions, assigned, listed,
    stack: { amount: surplus, terms: complete ? terms : null } };
}

module.exports = { expectedPeriod };
