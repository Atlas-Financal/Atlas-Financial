'use strict';
/* #823: one-off income entered for a specific future pay period, and the
 * double-count guard beside the modelled 2027 bonus.
 *
 * Invented data only. Every expected figure below is literal arithmetic on
 * the fixture, written out by hand; none is read back from Forecast.
 *
 * Part A (2026, no payroll regime). Payroll anchor 2026-08-14, +14 days.
 * As-of 2026-10-09. Every period: Dale 1000, synthetic rent 400 (biweekly,
 * same anchor), household budget 300 → BAD 1000 − 400 − 300 = 300.
 * A one-off 250 dated 2026-11-10 lands in Nov 6–19 only:
 *   income 1250, BAD 1250 − 400 − 300 = 550. Every other period stays 300.
 * Road Ahead November 2026: paydays Nov 6 + Nov 20 = 2000; with the one-off
 *   2000 + 250 = 2250.
 *
 * The double-count guard beside the modelled 2027 bonus
 * (supersedesOccurrence) is proved in test-budget-timeline-pay-periods.js,
 * section "#823 one-off replacement of the modelled 2027 bonus", on that
 * file's existing 2027 fixture.
 *
 * `node test/test-one-off-income-period.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => a != null && b != null
  && Math.abs(Number(a) - Number(b)) <= eps;
const clone = v => JSON.parse(JSON.stringify(v));

function rowByStart(advice, start) {
  return (advice.payPeriodViews || []).find(p => p && p.start === start) || null;
}
function incomeRows(period) {
  return ((period && period.income) || []).filter(Boolean);
}
function rowsWithId(advice, id) {
  const hits = [];
  for (const period of advice.payPeriodViews || []) {
    for (const row of incomeRows(period)) if (row.id === id) hits.push({ start: period.start, row });
  }
  return hits;
}
// The figures a period publishes for itself. Opening and closing cash are
// downstream carry and may legitimately move after a one-off; they are not
// part of a neighbour's own figures.
function ownFigures(period) {
  if (!period) return null;
  return JSON.stringify({
    start: period.start,
    end: period.end,
    incomeTotal: period.incomeTotal,
    incomeTrust: period.incomeTrust,
    periodBillLoad: period.periodBillLoad,
    budgetHold: period.budgetHold,
    bad: period.balanceAfterDeductions,
    income: incomeRows(period).map(r => [r.id, r.date, r.amount, r.confidence, r.status]),
  });
}

// ---------------------------------------------------------------- Part A
const A_ANCHOR = '2026-08-14';
const A_AS_OF = '2026-10-09';
const A_DALE = 1000;
const A_RENT = 400;
const A_HOUSEHOLD = 300;
const A_ONE_OFF = 250;

function planA(extraIncome) {
  return {
    defaults: { targetBuffer: 0 },
    windowDays: 91,
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 2000, class: 'spendable' }],
    },
    opening: { asOf: A_AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [{
      id: 'payroll', label: 'Invented employer payroll', frequency: 'biweekly',
      anchor: A_ANCHOR, amount: A_DALE, confidence: 'confirmed',
    }].concat(extraIncome || []),
    bills: [{
      id: 'synthetic-rent', label: 'Synthetic rent', amount: A_RENT,
      frequency: 'biweekly', anchor: A_ANCHOR, confidence: 'confirmed',
      payingAccount: 'chequing-a',
    }],
    obligations: [],
    commitments: [],
    budget: {
      categories: [{ id: 'groceries', label: 'Groceries', plannedPayday: A_HOUSEHOLD }],
    },
  };
}
function oneOffA(date, extra) {
  return Object.assign({
    id: 'synthetic-one-off', label: 'Synthetic one-off income', frequency: 'once',
    date, amount: A_ONE_OFF, confidence: 'estimated', incomeClass: 'other',
  }, extra || {});
}
const runA = plan => F.recommend(plan, A_AS_OF, { targetBuffer: 0, debts: [] });
const A_STARTS = ['2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20', '2026-12-04', '2026-12-18'];

console.log('=== A1. baseline: every period is 1000 − 400 − 300 = 300 ===');
const baseA = runA(planA());
for (const start of A_STARTS) {
  const p = rowByStart(baseA, start);
  ok(p && near(p.incomeTotal, A_DALE) && near(p.periodBillLoad, A_RENT)
      && near(p.budgetHold, A_HOUSEHOLD) && near(p.balanceAfterDeductions, 300),
    start + ' baseline income 1000, bills 400, household 300, BAD 300',
    p && `${p.incomeTotal}/${p.periodBillLoad}/${p.budgetHold}/${p.balanceAfterDeductions}`);
}

console.log('\n=== A2. a one-off 250 on 2026-11-10 lands in Nov 6–19 only ===');
{
  const advice = runA(planA([oneOffA('2026-11-10')]));
  const nov6 = rowByStart(advice, '2026-11-06');
  ok(nov6 && near(nov6.incomeTotal, 1250), 'Nov 6–19 income is 1000 + 250 = 1250',
    nov6 && String(nov6.incomeTotal));
  ok(nov6 && near(nov6.balanceAfterDeductions, 550), 'Nov 6–19 BAD is 1250 − 400 − 300 = 550',
    nov6 && String(nov6.balanceAfterDeductions));
  const hits = rowsWithId(advice, 'synthetic-one-off');
  ok(hits.length === 1 && hits[0].start === '2026-11-06' && near(hits[0].row.amount, 250),
    'the one-off appears once, in Nov 6–19, at 250 (no recurrence)',
    hits.map(h => h.start + ':' + h.row.amount).join(','));
  ok(hits[0] && hits[0].row.confidence === 'estimated' && hits[0].row.status !== 'received',
    'the one-off stays estimated and is not received without evidence',
    hits[0] && `${hits[0].row.confidence}/${hits[0].row.status}`);
  ok(nov6 && nov6.incomeTrust === 'estimated',
    'the period income carries the estimate, not calculated', nov6 && nov6.incomeTrust);
  for (const start of A_STARTS) {
    if (start === '2026-11-06') continue;
    ok(ownFigures(rowByStart(advice, start)) === ownFigures(rowByStart(baseA, start)),
      start + ' neighbour figures are unchanged');
  }
}

console.log('\n=== A3. payday boundary: payday belongs to the new period ===');
{
  const onPayday = runA(planA([oneOffA('2026-11-20')]));
  const dayBefore = runA(planA([oneOffA('2026-11-19')]));
  const a = rowsWithId(onPayday, 'synthetic-one-off');
  const b = rowsWithId(dayBefore, 'synthetic-one-off');
  ok(a.length === 1 && a[0].start === '2026-11-20', 'a 2026-11-20 one-off is in Nov 20 – Dec 3',
    a.map(h => h.start).join(','));
  ok(b.length === 1 && b[0].start === '2026-11-06', 'a 2026-11-19 one-off is in Nov 6–19',
    b.map(h => h.start).join(','));
  ok(near(rowByStart(onPayday, '2026-11-20').balanceAfterDeductions, 550)
      && near(rowByStart(onPayday, '2026-11-06').balanceAfterDeductions, 300),
    'payday case: Nov 20 BAD 550, Nov 6 BAD 300');
}

console.log('\n=== A4. removing the entry restores every figure exactly ===');
{
  const plan = planA([oneOffA('2026-11-10')]);
  const before = clone(plan);
  runA(plan);
  ok(JSON.stringify(plan) === JSON.stringify(before), 'Forecast does not mutate the plan input');
  plan.income = plan.income.filter(r => r.id !== 'synthetic-one-off');
  const restored = runA(plan);
  ok(JSON.stringify(restored.payPeriodViews) === JSON.stringify(baseA.payPeriodViews),
    'every published pay-period view equals the baseline after removal');
}

console.log('\n=== A5. Road Ahead November counts the one-off once ===');
{
  const periods = { periods: { ytd: { label: 'YTD', months: 1, spending: [{ label: 'Groceries', total: 1000 }] } } };
  const nov = traj => ((traj.months || []).find(m => m && m.month === '2026-11') || {}).income || {};
  const base = F.baselineTrajectory(planA(), [], A_AS_OF, { periods });
  const withOne = F.baselineTrajectory(planA([oneOffA('2026-11-10')]), [], A_AS_OF, { periods });
  ok(near(nov(base).amount, 2000), 'Road Ahead November baseline is 1000 + 1000 = 2000', String(nov(base).amount));
  ok(near(nov(withOne).amount, 2250), 'Road Ahead November with the one-off is 2250', String(nov(withOne).amount));
}

console.log('\n=== A6. a real receipt of the one-off is counted once ===');
{
  // Current-period fixture: the one-off is expected inside the active
  // period and the same money arrives as a posted household-cash credit.
  const PAYDAY = '2026-09-11';
  const planOn = oneOffDate => ({
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 1000, breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: 1000 }] },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    opening: { asOf: PAYDAY, representedEvents: [] },
    income: [
      { id: 'payroll', label: 'Invented employer payroll', frequency: 'biweekly', anchor: A_ANCHOR,
        amount: A_DALE, confidence: 'confirmed' },
      oneOffA(oneOffDate),
    ],
    bills: [], obligations: [], commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential',
      plannedMonthly: 450, ownerLine: 'Groceries' }] },
  });
  const packet = txs => ({
    schema: 'atlas-current-period-actuals/v1', observationAsOf: PAYDAY,
    coverageStart: PAYDAY, coverageThrough: PAYDAY, pendingCoverage: 'complete',
    transactions: txs, representedActuals: [],
  });
  const active = (txs, oneOffDate) => (F.recommend(planOn(oneOffDate || PAYDAY), PAYDAY, { targetBuffer: 0, debts: [],
    currentPeriodActuals: packet(txs) }).defaultView.calendarPeriods || [])
    .find(p => p && p.id === 'this-pay-period');
  const credit = (id, extra) => Object.assign({ id, date: PAYDAY, amount: -A_ONE_OFF, pending: false,
    accountRole: 'household-cash', displayedPayee: 'Synthetic payer', originalMerchant: 'Synthetic payer' }, extra);
  // Same-day, same-amount receipts settle the expected row (C3 rule 2).
  for (const [label, tx] of [
    ['a credit flagged income', credit('tx-flagged', { categoryLabel: 'Gifts', isIncome: true })],
    ['an unflagged exact-amount credit', credit('tx-unflagged', { categoryLabel: 'Reimbursement' })],
  ]) {
    const p = active([tx]);
    const items = (p && p.otherIncome && p.otherIncome.items) || [];
    const row = items.find(r => r && r.id === 'synthetic-one-off');
    ok(p && near(p.incomeTotal, 1250),
      label + ': period income is 1000 + 250 = 1250, not 1500', p && String(p.incomeTotal));
    ok(row && row.status === 'received' && items.length === 1,
      label + ': the expected row is received and no second item is added',
      JSON.stringify(items.map(r => [r.id, r.status])));
  }
  // A flagged receipt on another date: whether or not the receipt-matching
  // rule settles the expectation by date, the money counts once.
  // Here the one-off is expected on Sep 15 and the money posts early, Sep 11.
  {
    const p = active([credit('tx-early', { categoryLabel: 'Gifts', isIncome: true })], '2026-09-15');
    ok(p && near(p.incomeTotal, 1250),
      'a flagged receipt on another date: period income is still 1250, not 1500', p && String(p.incomeTotal));
  }
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll one-off income period checks passed.');
