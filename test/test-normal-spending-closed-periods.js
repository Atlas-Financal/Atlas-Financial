'use strict';
/* Road Ahead normal spending learns from every covered closed pay period.
 *
 * Lead dispatch T3 (2026-11-18): the provisional baseline used one completed
 * actual plus the current-period estimate. It now uses up to the engine's
 * standard six closed pay periods, newest first, while each one's transaction
 * coverage establishes it, with the same method and the same estimated tag:
 *   (sum of closed posted actuals + current full-period estimate) / (closed + 1)
 * With one covered closed period this is exactly the old two-period rule.
 *
 * Invented plan, hand-derived. Seaspan pays every 14 days from 2026-08-14:
 *   closed  2026-07-31..08-13  groceries 100
 *   closed  2026-08-14..08-27  groceries 160
 *   closed  2026-08-28..09-10  groceries 220
 *   current 2026-09-11..09-24  as-of 09-22: 150 posted, 200 planned
 *           -> remaining reserve 50, full-period estimate 200
 *   1 closed covered: (220 + 200) / 2             = 210
 *   2 closed covered: (220 + 160 + 200) / 3       = 193.33
 *   3 closed covered: (220 + 160 + 100 + 200) / 4 = 170
 *
 * `node test/test-normal-spending-closed-periods.js`
 */
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
};

const AS_OF = '2026-09-22';
const plan = () => ({
  opening: { asOf: AS_OF },
  startingCash: { amount: 8000 },
  windowDays: 91,
  defaults: { extraDebtMonthly: 0, targetBuffer: 0, scenario: 'expected' },
  income: [{ id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly', anchor: '2026-08-14',
    amount: 1000, confidence: 'confirmed' }],
  bills: [], commitments: [], obligations: [],
  budget: { basis: 'ytd', categories: [
    { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedPayday: 200, plannedMonthly: null },
  ] },
});
const LEDGER = [
  { id: 'g-1', date: '2026-08-05', amount: 100 },
  { id: 'g-2', date: '2026-08-20', amount: 160 },
  { id: 'g-3', date: '2026-09-01', amount: 220 },
  { id: 'g-now', date: '2026-09-15', amount: 150 },
];
const packet = coverageStart => ({
  schema: 'atlas-current-period-actuals/v1',
  coverageStart, coverageThrough: AS_OF, observationAsOf: AS_OF,
  pendingCoverage: 'complete', transactionCoverage: 'complete',
  transactions: LEDGER.filter(row => row.date >= coverageStart).map(row => ({
    id: row.id, date: row.date, amount: row.amount, account: 'chequing-a', atlasAccountId: 'chequing-a',
    pending: false, categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM',
  })),
  representedActuals: [],
});
const ask = coverageStart => F.baselineTrajectory(plan(), [], AS_OF, {
  periods: { periods: { ytd: { label: 'YTD', months: 1, spending: [] } } },
  currentPeriodActuals: packet(coverageStart),
});

const cases = [
  { label: 'one closed period covered (the old rule)', from: '2026-08-28', closed: [220], amount: 210 },
  { label: 'two closed periods covered', from: '2026-08-14', closed: [220, 160], amount: 193.33 },
  { label: 'three closed periods covered', from: '2026-07-31', closed: [220, 160, 100], amount: 170 },
  // Coverage starts inside 08-14..08-27: that period is not established, so the
  // run stops at the one fully covered closed period. Partial history never counts.
  { label: 'a partly covered older period is not counted', from: '2026-08-20', closed: [220], amount: 210 },
];
for (const c of cases) {
  console.log(`\n=== ${c.label} ===`);
  const traj = ask(c.from);
  const ns = traj.normalSpending;
  ok(traj.status === 'ready' && ns && ns.status === 'ready', `${c.label}: the Road Ahead baseline is ready`, ns && ns.reason);
  if (!ns || ns.status !== 'ready') continue;
  ok(ns.payPeriodAmount === c.amount, `${c.label}: 14-day normal spending is the hand-derived ${c.amount}`, ns.payPeriodAmount);
  ok(Math.abs(ns.weeklyVariable * 2 - ns.payPeriodAmount) < 1e-9, `${c.label}: the weekly walk rate is half of it`);
  ok(ns.currentPeriod.fullPeriodEstimate === 200 && ns.currentPeriod.trust === 'estimated',
    `${c.label}: the current period still contributes its 200 full-period estimate`);
  ok(JSON.stringify((ns.completedPeriods || []).map(p => p.amount)) === JSON.stringify(c.closed),
    `${c.label}: each closed period's posted actual feeds it, newest first`, JSON.stringify((ns.completedPeriods || []).map(p => p.amount)));
  ok(ns.completedPeriod.amount === c.closed[0], `${c.label}: completedPeriod stays the most recent closed period`);
  ok(ns.trust === 'estimated' && ns.establishedHouseholdAverage === false,
    `${c.label}: the baseline stays estimated, never an established average`);
  const n = c.closed.length;
  ok(ns.phrase === `Normal spending estimate based on ${n + 1} pay periods — ${n} completed actual${n === 1 ? '' : 's'} + current-period estimate.`,
    `${c.label}: the phrase names how many closed periods fed it`, ns.phrase);
  const groceries = (ns.categories || []).find(row => row.id === 'groceries');
  ok(!!groceries && groceries.amount === c.amount
    && (ns.categories || []).reduce((s, r) => s + r.amount, 0) === c.amount,
    `${c.label}: the category split averages the same periods and adds up`, JSON.stringify(ns.categories));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll closed-period normal-spending checks passed.');
