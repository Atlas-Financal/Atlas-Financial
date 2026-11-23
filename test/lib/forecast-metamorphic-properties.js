'use strict';

const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const fc = require('fast-check');
const Forecast = require('../../public/forecast');

// Small integers/arrays shrink directly to a readable recipe. Each purchase is one
// economic event, even when the feed shows both its pending and posted versions.
const cents = fc.integer({ min: 1, max: 50000 });
const purchases = fc.array(fc.record({
  cents, day: fc.integer({ min: 15, max: 20 }), pending: fc.boolean(),
}), { minLength: 1, maxLength: 5 });
const household = fc.record({
  pay: cents, price: cents, budget: cents, opening: fc.integer({ min: -30000, max: 80000 }),
  goal: cents, purchases,
});
const date = day => new Date(Date.UTC(2026, 7, day)).toISOString().slice(0, 10);

function input(h) {
  const start = date(14), asOf = date(20);
  const transactions = h.purchases.map((purchase, i) => {
    // The first purchase is posted and also has a pending twin. Other purchases
    // have distinct names so equal cents on the same day are still independent.
    const pending = i > 0 && purchase.pending;
    return {
      id: 'purchase-' + i, date: date(purchase.day), amount: purchase.cents / 100,
      displayedPayee: 'Invented shop ' + i, categoryLabel: 'Groceries', atlasAccountId: 'chequing-b',
      account: 'chequing-b', accountRole: 'household-cash', currency: 'cad', pending,
      savingsPostingEvidence: pending ? 'pending' : 'posted',
      pendingTreatment: pending ? 'pending' : 'confirmed-settled',
    };
  });
  transactions.push({ ...transactions[0], id: 'pending-copy', pending: true,
    savingsPostingEvidence: 'pending', pendingTreatment: 'pending' });
  return {
    asOf,
    plan: {
      opening: { asOf, priorAsOf: date(13), representedEvents: [{ id: 'payroll', date: start, effectiveAsOf: asOf }] },
      startingCash: { breakdown: [{ id: 'chequing-a', value: h.opening / 100 }, { id: 'chequing-b', value: 12 }] },
      income: [{ id: 'payroll', label: 'Invented pay', frequency: 'biweekly', anchor: start, amount: h.pay / 100, confidence: 'confirmed' }],
      bills: [{ id: 'utility', label: 'Invented utility', frequency: 'biweekly', anchor: date(22), amount: h.price / 100, confidence: 'estimated' }],
      commitments: [{ id: 'trip', label: 'Invented trip', date: date(43), amount: h.goal / 100, confidence: 'confirmed' }],
      obligations: [], groups: [], funding: { options: [] },
      defaults: { targetBuffer: 0, extraDebtMonthly: 0 },
      budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'],
        plannedPayday: h.budget / 100, confidence: 'confirmed' }] },
    },
    opts: {
      debts: [],
      // Shift the explicit projection boundary along with the plan. Both
      // calendars stay inside the same published payroll-authority regime.
      daleIncomeAuthorityEnd: date(83),
      currentPeriodActuals: { schema: 'atlas-current-period-actuals/v1', observationAsOf: asOf,
        coverageStart: start, coverageThrough: asOf, transactionCoverage: 'complete',
        pendingCoverage: 'complete', paydayGapComplete: true, transactions },
    },
  };
}

function publish({ plan, asOf, opts }) {
  const views = Forecast.recommend(plan, asOf, opts).payPeriodViews;
  assert.ok(views.some(v => v.timelineRole === 'current') && views.some(v => v.timelineRole === 'next'),
    'both current and next period published');
  return views;
}

// Keep errors small enough for the runner's seed and shrunk recipe to be visible.
function sameViews(before, after) {
  assert.equal(after.length, before.length, 'number of pay periods');
  before.forEach((view, i) => {
    for (const key of new Set([...Object.keys(view), ...Object.keys(after[i])])) {
      assert.ok(isDeepStrictEqual(view[key], after[i][key]), view.start + ' differs at ' + key);
    }
  });
}

// Order of the reconciliation receipt follows the incoming feed. Keep every
// row and every field, sorting only the lists where receipt order is immaterial.
function sortedReceipts(views) {
  return JSON.parse(JSON.stringify(views, (key, value) =>
    (key === 'recon' || key === 'pendingRecon') && Array.isArray(value)
      ? value.slice().sort((a, b) => a.id.localeCompare(b.id)) : value));
}

function transactionOrder({ h, permutation }) {
  const original = input(h), changed = structuredClone(original);
  const rows = changed.opts.currentPeriodActuals.transactions;
  const indices = permutation.filter(i => i < rows.length);
  if (indices.every((n, i) => n === i)) indices.reverse();
  changed.opts.currentPeriodActuals.transactions = indices.map(i => rows[i]);
  const expected = h.purchases.reduce((sum, purchase) => sum + purchase.cents, 0) / 100;
  const before = publish(original), after = publish(changed);
  for (const views of [before, after]) {
    const groceries = views.find(v => v.timelineRole === 'current').householdBudget.find(row => row.id === 'groceries');
    assert.equal(groceries.spent, expected, 'published spend counts each invented purchase once');
  }
  sameViews(sortedReceipts(before), sortedReceipts(after));
}

function zeroBill({ h, dueDay }) {
  const original = input(h), waived = structuredClone(original), due = date(dueDay);
  const bill = { id: 'waived', label: 'Invented waiver', frequency: 'once', date: due,
    amount: h.price / 100, confidence: 'confirmed', payingAccount: 'chequing-a' };
  // Atlas #726: noPaymentRequiredOn is explicit evidence of a known zero cash
  // requirement. A bare authored price of 0 means the price is unknown.
  waived.plan.bills.push({ ...bill, amount: 0, noPaymentRequiredOn: [due] });
  const before = publish(original);
  sameViews(before, publish(waived));

  const unpriced = structuredClone(original);
  unpriced.plan.bills.push({ ...bill, amount: 0 });
  const after = publish(unpriced);
  assert.equal(after.length, before.length, 'unknown price preserves period boundaries');
  after.forEach((v, i) => {
    const prior = before[i];
    assert.deepEqual([v.start, v.end, v.incomeTotal, v.budgetHold],
      [prior.start, prior.end, prior.incomeTotal, prior.budgetHold], 'income and budget independent of bill price');
    if (v.start <= due && due <= v.end) {
      assert.equal(v.totalBillsThisPeriod, null, 'literal zero price withholds the bill total');
      assert.equal(v.stackSummary.surplus.amount, null, 'literal zero price withholds dependent surplus');
    } else {
      for (const key of ['totalBillsThisPeriod', 'periodBillLoad', 'balanceAfterDeductions'])
        assert.equal(v[key], prior[key], 'unrelated period ' + key);
      assert.deepEqual(v.stackSummary, prior.stackSummary, 'unrelated period Stack figures');
    }
  });
}

// A 14-day translation preserves weekdays and all recurrences in this family
// (biweekly and one-off). Monthly due days do not share that symmetry.
const monthNames = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const displayedOrIsoDay = /\d{4}-\d{2}-\d{2}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g;
function translated(value, days) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v !== 'string' ? v :
    v.replace(displayedOrIsoDay, (match, month, day) => {
      const time = month ? Date.UTC(2026, monthNames.indexOf(month), Number(day)) : Date.parse(match + 'T00:00:00Z');
      const shifted = new Date(time + days * 86400000);
      return month ? monthNames[shifted.getUTCMonth()] + ' ' + shifted.getUTCDate() : shifted.toISOString().slice(0, 10);
    })));
}

function dateShift({ h, periods }) {
  const original = input(h), days = periods * 14;
  if (periods === -287) {
    // Aug 2015 and Aug 2026 occupy the same Gregorian calendar (the entire
    // test window has matching weekdays and month lengths). This translation
    // is also valid for semimonthly pay and a month-end bill.
    for (const day of [1, 15]) {
      original.plan.income.push({ id: 'second-pay-' + day, label: 'Invented second pay',
        frequency: 'monthly', day, amount: h.pay / 100, confidence: 'estimated' });
    }
    original.plan.bills.push({ id: 'month-end', label: 'Invented month end', frequency: 'monthly',
      day: 31, amount: h.price / 100, confidence: 'confirmed' });
  }
  const expected = translated(publish(original), days);
  const actual = publish(translated(original, days));
  // JSON is the published wire shape. Compare the full view, including every
  // period, event, receipt, amount, trust label and displayed date range.
  sameViews(expected, JSON.parse(JSON.stringify(actual)));
}

module.exports = { properties: [
  { id: 7, name: 'shuffling transactions preserves all period totals', arbitrary: fc.record({ h: household, permutation: fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }) }), check: transactionOrder },
  { id: 8, name: 'adding a zero-due bill preserves all period figures', arbitrary: fc.record({ h: household, dueDay: fc.integer({ min: 21, max: 39 }) }), check: zeroBill },
  { id: 9, name: 'whole-period date translation preserves every pay-period view', arbitrary: fc.record({ h: household, periods: fc.constantFrom(-2, -1, 1, 2, -287) }), check: dateShift },
] };
