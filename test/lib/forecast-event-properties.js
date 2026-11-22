'use strict';

const assert = require('node:assert/strict');
const fc = require('fast-check');
const Forecast = require('../../public/forecast');

const dayMs = 86400000;
const dayNumber = date => Date.parse(date + 'T00:00:00Z') / dayMs;
const iso = number => new Date(number * dayMs).toISOString().slice(0, 10);
const plus = (date, days) => iso(dayNumber(date) + days);

const cents = fc.integer({ min: 1, max: 99999 });
const dateOffset = fc.oneof(fc.constantFrom(-15, -14, -1, 0, 13, 14, 27, 28, 41),
  fc.integer({ min: -84, max: 41 }));
const household = fc.record({
  // Both weekend weekdays, including a short February and different month lengths.
  asOf: fc.constantFrom('2026-01-31', '2026-02-28', '2026-05-31', '2026-08-15', '2026-11-15'),
  sincePayday: fc.integer({ min: 0, max: 13 }),
  biweeklyPay: cents,
  secondPay: fc.option(cents, { nil: null }),
  earlyReceipt: fc.boolean(),
  minimums: fc.array(fc.record({ cents, day: fc.integer({ min: 1, max: 31 }) }), { maxLength: 2 }),
  purchases: fc.array(fc.record({ cents, daysAgo: fc.integer({ min: 0, max: 70 }), pendingCopy: fc.boolean() }),
    { maxLength: 4 }),
  bills: fc.array(fc.record({
    timing: fc.oneof(
      fc.record({ day: fc.integer({ min: 28, max: 31 }) }),
      fc.record({ biweeklyOffset: dateOffset }),
      fc.record({ onceOffset: dateOffset })),
    cents: fc.option(cents, { nil: null }),
  }), { maxLength: 6 }),
});

function makeCase(input) {
  const payday = plus(input.asOf, -input.sincePayday);
  const row = (id, amount, schedule) => ({
    id, label: 'Invented ' + id, amount: amount === null ? null : amount / 100,
    confidence: 'estimated', ...schedule,
  });
  const income = [row('payroll', input.biweeklyPay, { frequency: 'biweekly', anchor: payday })];
  // In the served plan semi-monthly pay has two monthly streams.
  const representedActuals = [];
  const transactions = [];
  if (input.secondPay !== null) {
    for (const day of [15, 31]) {
      const stream = row('second-wage-' + day, input.secondPay, { frequency: 'monthly', day });
      income.push(stream);
      if (!input.earlyReceipt || day !== (input.asOf.endsWith('-15') ? 15 : 31)) continue;
      const weekday = new Date(input.asOf + 'T00:00:00Z').getUTCDay();
      const friday = plus(input.asOf, weekday === 0 ? -2 : -1);
      const transactionId = 'invented-early-credit';
      representedActuals.push({ id: stream.id, date: input.asOf, postedOn: friday, actual: stream.amount, transactionId });
      transactions.push({ id: transactionId, date: friday, amount: -stream.amount, pending: false, isIncome: true,
        currency: 'CAD', categoryLabel: 'Payroll', accountRole: 'household-cash', atlasAccountId: 'chequing-a' });
    }
  }
  const category = { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'],
    confidence: 'confirmed', plannedPayday: 20 };
  for (const [i, purchase] of input.purchases.entries()) {
    const tx = { id: 'purchase-' + i, date: plus(input.asOf, -purchase.daysAgo), amount: purchase.cents / 100,
      categoryLabel: 'Groceries', accountRole: 'household-cash', atlasAccountId: 'chequing-b', currency: 'CAD',
      pending: false, savingsPostingEvidence: 'posted', displayedPayee: 'Invented grocer ' + i, merchantKnown: true };
    transactions.push(tx);
    if (purchase.pendingCopy) transactions.push({ ...tx, id: tx.id + '-pending', pending: true,
      pendingTreatment: 'pending', savingsPostingEvidence: 'pending' });
  }
  // A one-off on the last day of the previous period has no payment evidence.
  // Its row must survive closing, and no row may re-charge it in a later view.
  const bills = [row('prior-unverified', 731, { frequency: 'once', date: plus(payday, -1) })];
  for (const [i, bill] of input.bills.entries()) {
    const timing = bill.timing;
    const schedule = 'day' in timing ? { frequency: 'monthly', day: timing.day }
      : 'biweeklyOffset' in timing ? { frequency: 'biweekly', anchor: plus(payday, timing.biweeklyOffset) }
      : { frequency: 'once', date: plus(payday, timing.onceOffset) };
    bills.push(row('bill-' + i, bill.cents, schedule));
  }
  const obligations = input.minimums.map((minimum, i) => ({
    ...row('minimum-' + i, minimum.cents, { frequency: 'monthly', day: minimum.day }),
    debtId: i === 0 ? 'invented-card' : 'heloc', effect: 'payment', payingAccount: 'chequing-a',
  }));
  const debts = obligations.map(o => ({ id: o.debtId, label: 'Invented ' + o.debtId, secured: o.debtId === 'heloc',
    balance: 2520, pending: 0, limit: 10000, rate: 4, payment: o.amount, confidence: 'estimated' }));
  const plan = {
    defaults: { targetBuffer: 0 }, budget: { categories: [category] }, income, bills, obligations, commitments: [],
    opening: { asOf: input.asOf, representedEvents: representedActuals.map(({ id, date }) => ({ id, date })) },
    startingCash: { breakdown: [{ id: 'chequing-a', value: 270 }, { id: 'chequing-b', value: 13 }] },
  };
  return { payday, plan, opts: { debts, daleIncomeAuthorityEnd: plus(payday, 41), currentPeriodActuals: {
    observationAsOf: input.asOf, coverageStart: plus(payday, -84), coverageThrough: input.asOf,
    transactionCoverage: 'complete', pendingCoverage: 'complete', representedActuals, transactions,
  } } };
}

// Enumerate days, then ask which authored schedules fall on each day. On the
// last day of a short month all later requested day numbers are due as well.
function dueOn(row, date) {
  if (row.frequency === 'once') return date === row.date;
  if (row.frequency === 'biweekly') return (dayNumber(date) - dayNumber(row.anchor)) % 14 === 0;
  const day = Number(date.slice(8));
  return row.day === day || (row.day > day && plus(date, 1).endsWith('-01'));
}

function published(input) {
  const { payday, plan, opts } = makeCase(input);
  const views = Forecast.recommend(plan, input.asOf, opts).payPeriodViews;
  // Six closed periods and three full periods through the supplied authority end.
  const starts = Array.from({ length: 9 }, (_, i) => plus(payday, 14 * (i - 6)));
  assert.deepEqual(views.map(v => [v.start, v.end]), starts.map(s => [s, plus(s, 13)]), 'complete period timeline');
  return { views, starts, plan, opts };
}

function expectedOccurrences(rows, starts) {
  const entries = [];
  for (const start of starts) {
    for (let offset = 0; offset < 14; offset++) {
      const date = plus(start, offset);
      for (const row of rows) {
        if (dueOn(row, date)) entries.push({ start, id: row.id, date, amount: row.amount });
      }
    }
  }
  return entries;
}

function cashEvents(input) {
  const { views, starts, plan, opts } = published(input);
  // Compare signed movements as a multiset, retaining identical amounts,
  // colliding dates and distinct identities. An unknown bill is a disclosure,
  // not a numeric cash movement.
  const key = (section, start, id, date, movement) => JSON.stringify([section, start, id, date, movement]);
  const expected = [], actual = [];
  for (const section of ['income', 'bills']) {
    const source = section === 'income' ? plan.income : [...plan.bills, ...plan.obligations];
    for (const row of expectedOccurrences(source, starts)) {
      if (row.amount !== null) expected.push(key(section, row.start, row.id, row.date,
        section === 'income' ? row.amount : -row.amount));
    }
    for (const view of views) for (const row of view[section]) {
      if (row.movement !== null) actual.push(key(section, view.start, row.id, row.date, row.movement));
    }
  }
  assert.deepEqual(actual.sort(), expected.sort(), 'signed cash occurrences by period');
  // Each purchase describes one economic event even when both pending and
  // posted rows were supplied. Reconcile Spent directly to the generator.
  for (const view of views.filter(v => v.start <= input.asOf)) {
    const spentCents = input.purchases.reduce((sum, p) => {
      const date = plus(input.asOf, -p.daysAgo);
      return sum + (view.start <= date && date <= view.end ? p.cents : 0);
    }, 0);
    assert.equal(view.householdBudget.find(b => b.id === 'groceries').spent, spentCents / 100,
      'each purchase counted once toward Spent in ' + view.start);
  }
  for (const receipt of opts.currentPeriodActuals.representedActuals) {
    const row = views.flatMap(view => view.income).find(r => r.id === receipt.id && r.date === receipt.date);
    assert.equal(row.actual, receipt.actual, 'Friday posting settles the weekend salary occurrence');
    assert.equal(row.remaining, 0, 'the weekend salary cannot arrive again');
  }
}

function billOwnership(input) {
  const { views, starts, plan } = published(input);
  const key = (owner, id, date, amount) => JSON.stringify([owner, id, date, amount]);
  const expected = expectedOccurrences([...plan.bills, ...plan.obligations], starts).map(r => key(r.start, r.id, r.date, r.amount));
  const actual = views.flatMap(v => v.bills.map(b => key(v.start, b.id, b.date, b.planned)));
  assert.deepEqual(actual.sort(), expected.sort(), 'all bill dates and amounts, including unknowns, in their scheduled period');
  const priorBill = views.flatMap(v => v.bills).find(b => b.id === 'prior-unverified');
  assert.notEqual(priorBill.status, 'PAID', 'no evidence settles the prior one-off');
}

module.exports = { properties: [
  { id: 1, name: 'cash events counted exactly once', arbitrary: household, check: cashEvents },
  { id: 2, name: 'scheduled bill ownership and no rollover', arbitrary: household, check: billOwnership },
] };
