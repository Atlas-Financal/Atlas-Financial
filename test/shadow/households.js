'use strict';

const fc = require('fast-check');

// Generate the source facts in cents. fast-check can delete an entire account,
// bill or purchase before shrinking its individual fields. The constructor
// below supplies native plan inputs only, never an expected result.
const positive = fc.integer({ min: 1, max: 9000 });
const signed = fc.integer({ min: -9000, max: 9000 });
const monthDay = fc.oneof(fc.constantFrom(1, 15, 28, 29, 30, 31), fc.integer({ min: 1, max: 31 }));
const offset = fc.oneof(fc.constantFrom(0, 1, 12, 13, 14, 15, 27, 28), fc.integer({ min: 0, max: 35 }));
const monthly = fc.record({ day: monthDay, cents: positive });
const optional = arb => fc.option(arb, { nil: null, freq: 2 });
const purchases = fc.array(fc.record({
  daysAgo: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 15 })), cents: positive, pending: fc.boolean(),
}), { maxLength: 3 });
const household = fc.record({
  // Month end, Canadian holidays on different weekdays and both leap/non-leap Februaries.
  payday: fc.constantFrom('2028-02-29', '2027-02-28', '2028-02-16', '2028-06-30',
    '2028-07-01', '2027-12-25', '2028-12-31', '2027-01-01', '2028-03-10'),
  semiMonthlyOnly: fc.oneof({ weight: 5, arbitrary: fc.constant(false) }, fc.constant(true)),
  anchorCycles: fc.oneof(fc.constantFrom(-4, 0, 4), fc.integer({ min: -12, max: 12 })),
  elapsed: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 13 })),
  horizonDays: fc.oneof(fc.constantFrom(1, 7, 13, 14, 15, 28, 32, 42), fc.integer({ min: 1, max: 42 })),
  cash: signed, weeklyCash: signed, pay: positive, secondPay: optional(positive),
  weeklyAllowanceCents: fc.oneof(fc.constantFrom(0, 1, 6, 7, 8), fc.integer({ min: 1, max: 14000 })),
  groceries: fc.integer({ min: 0, max: 9000 }),
  purchases, fuel: optional(fc.record({ target: positive, purchases })),
  bills: fc.array(fc.record({
    timing: fc.oneof(fc.record({ day: monthDay }), fc.record({ offset })),
    cents: fc.oneof(positive, fc.constant(0), fc.constant(null)),
  }), { maxLength: 4 }),
  mortgage: optional(monthly), heloc: optional(monthly),
  card: optional(fc.record({
    day: monthDay, cents: positive, balancePad: positive, pending: positive,
    limitDelta: fc.constantFrom(0, -1, 1),
    fixed: optional(fc.oneof(
      fc.constant({ balanceCents: 120000, rateBasisPoints: 100 }),
      fc.record({ balanceCents: fc.integer({ min: 1, max: 120000 }), rateBasisPoints: fc.integer({ min: 1, max: 2999 }) })
    )),
    statement: optional(fc.record({ cents: fc.oneof(positive, fc.constantFrom(99, 100, 101)), daysFromScheduled: fc.integer({ min: -2, max: 2 }) })),
  })),
});

const dateOffset = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const money = cents => cents === null ? null : cents / 100;

// Supply the issuer's first scheduled occurrence as an explicit native date.
// Generate it inside the following calendar month: it always exists even for
// an observation at month end. Day 31 means the last day in a short month.
function nextMonthDate(asOf, day) {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last))).toISOString().slice(0, 10);
}

function makeHousehold(input) {
  const asOf = dateOffset(input.payday, input.elapsed);
  const row = (id, cents, fields) => ({ id, label: 'Invented ' + id, amount: money(cents),
    confidence: cents === null ? 'unknown' : 'confirmed', ...fields });
  // A recurrence anchor may be many complete cycles before or after this period.
  const anchor = dateOffset(input.payday, 14 * (input.anchorCycles ?? 0));
  const income = input.semiMonthlyOnly ? [] : [row('payroll', input.pay, { frequency: 'biweekly', anchor })];
  const secondPay = input.semiMonthlyOnly ? input.pay : input.secondPay;
  if (secondPay !== null) {
    for (const day of [15, 31]) income.push(row('second-pay-' + day, secondPay, { frequency: 'monthly', day }));
  }
  const bills = input.bills.map(({ cents, timing }, i) => row('bill-' + i, cents,
    timing.day === undefined ? { frequency: 'once', date: dateOffset(asOf, timing.offset) }
      : { frequency: 'monthly', day: timing.day }));
  const obligations = [], debts = [];
  for (const id of ['mortgage', 'mbna']) {
    const source = id === 'mbna' ? input.card : input.mortgage;
    if (!source) continue;
    const firstDue = nextMonthDate(asOf, source.day);
    const obligation = row(id + '-payment', source.cents, { debtId: id, effect: 'payment', currency: 'cad',
      frequency: 'monthly', payingAccount: 'chequing-a', day: source.day });
    if (source.fixed) {
      obligation.fixedInterestMinimum = { balance: money(source.fixed.balanceCents),
        rate: source.fixed.rateBasisPoints / 100, asOf };
    }
    if (source.statement) {
      obligation.statementOccurrences = [{ scheduledDate: firstDue,
        dueDate: dateOffset(firstDue, source.statement.daysFromScheduled), minimum: money(source.statement.cents),
        confidence: 'confirmed', currency: 'cad' }];
    }
    obligations.push(obligation);
    const balance = id === 'mbna' ? Math.max(source.cents * 4, (source.statement?.cents || 0) * 4,
      source.fixed?.balanceCents || 0) + source.balancePad : source.cents * 8;
    const pending = source.pending || 0;
    debts.push({ id, label: 'Invented ' + id, balance: money(balance), pending: money(pending),
      ...(id === 'mbna' ? { limit: money(balance + pending + source.limitDelta) } : {}),
      secured: id === 'mortgage', rate: 0,
      payment: obligation.amount, confidence: 'confirmed' });
  }
  if (input.heloc) {
    const { day, cents } = input.heloc;
    obligations.push(row('line', 1, { debtId: 'heloc', effect: 'capitalise', nonCash: true,
      frequency: 'monthly', day: 31, cashDay: day, cashPayment: money(cents),
      cashConfidence: 'estimated', cashFirstDue: nextMonthDate(asOf, day), payingAccount: 'chequing-a' }));
    debts.push({ id: 'heloc', label: 'Invented line', balance: money(cents * 8), pending: 0,
      limit: money(cents * 9), secured: true, rate: 0, confidence: 'confirmed' });
  }
  const targets = [{ label: 'Groceries', target: input.groceries, purchases: input.purchases }];
  if (input.fuel) targets.push({ label: 'Fuel', ...input.fuel });
  const categories = targets.map(({ label, target }) => ({ id: label.toLowerCase(), label, class: 'essential',
    plannedPayday: money(target), from: [label], confidence: 'confirmed' }));
  const transactions = targets.flatMap(({ label, purchases }) => purchases.map(({ daysAgo, cents, pending }, i) => ({
    id: label + '-purchase-' + i, date: dateOffset(asOf, -daysAgo), amount: money(cents), pending,
    currency: 'CAD', categoryLabel: label, accountRole: 'household-cash', atlasAccountId: 'chequing-b',
    displayedPayee: 'Invented ' + label + ' retailer ' + i, merchantKnown: true,
    pendingTreatment: pending ? 'pending' : 'confirmed-settled', savingsPostingEvidence: pending ? 'pending' : 'posted',
  })));
  const opening = (id, cents) => ({ id, value: money(cents), evidenceDate: asOf, confidence: 'confirmed' });
  return { asOf, horizonDays: input.horizonDays, weeklyVariable: money(input.weeklyAllowanceCents), plan: {
    opening: { asOf, representedEvents: [] },
    startingCash: { breakdown: [opening('chequing-a', input.cash), opening('chequing-b', input.weeklyCash)] },
    income, bills, obligations, budget: { categories }, commitments: [], groups: [],
    defaults: { targetBuffer: 0, extraDebtMonthly: 0 }, funding: { options: [] },
  }, opts: {
    debts, daleIncomeAuthorityEnd: dateOffset(input.payday, 55),
    currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
      coverageStart: dateOffset(input.payday, -28), coverageThrough: asOf, transactionCoverage: 'complete',
      pendingCoverage: 'complete', representedActuals: [], transactions },
  } };
}

module.exports = { household, makeHousehold };
