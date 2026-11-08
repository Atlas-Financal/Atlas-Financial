'use strict';
/* Forecast-owned provisional recent-pay-period normal spending.
 *
 * Road Ahead replaces only the normal-spending walk input. The proof
 * ledger below is hand-reconciled. It does not call the producer to
 * obtain the expected cents (L-002 / L-006). Live data.json targets are
 * not the specification.
 *
 * `node test/test-provisional-normal-spending-baseline.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, tol = 0.001) => Math.abs(Number(a) - Number(b)) <= tol;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const AS_OF = '2026-09-22';
const PREV_START = '2026-08-28';
const PREV_END = '2026-09-10';
const CUR_START = '2026-09-11';
const CUR_END = '2026-09-24';
const MONTH_DAYS = 365.25 / 12;
const WEEKS_PER_MONTH = MONTH_DAYS / 7;

const liveHashBefore = hashFile(DATA);
const liveTargetsBefore = JSON.stringify(require(DATA).plan.budget.categories.map(row => ({
  id: row.id,
  plannedPayday: row.plannedPayday == null ? null : row.plannedPayday,
  plannedMonthly: row.plannedMonthly == null ? null : row.plannedMonthly,
  paydayCadence: row.paydayCadence || null,
  paydayCadenceAnchor: row.paydayCadenceAnchor || null,
})));

function planFixture() {
  return {
    opening: { asOf: AS_OF },
    startingCash: { amount: 8000 },
    windowDays: 91,
    defaults: { extraDebtMonthly: 0, targetBuffer: 0, scenario: 'expected' },
    income: [{
      id: 'payroll',
      label: 'Payroll — Seaspan',
      frequency: 'biweekly',
      anchor: '2026-08-14',
      amount: 1000,
      confidence: 'confirmed',
    }],
    bills: [{
      id: 'hydro',
      label: 'Hydro',
      frequency: 'monthly',
      day: 5,
      amount: 80,
      confidence: 'confirmed',
    }],
    commitments: [
      {
        id: 'christmas',
        label: 'Christmas',
        date: '2026-12-15',
        amount: 250,
        confidence: 'confirmed',
        flexibility: 'required',
      },
      {
        id: 'vacation-tbd',
        label: 'Vacation',
        when: 'TBD',
        amountMin: 400,
        amountMax: 900,
        flexibility: 'bounded-flex',
      },
    ],
    obligations: [],
    budget: {
      basis: 'ytd',
      excluded: [{ from: 'Business' }],
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: 200, plannedMonthly: null,
        },
        {
          id: 'fuel', label: 'Fuel & transport', class: 'essential',
          from: ['Fuel & transport'], plannedPayday: 40, plannedMonthly: null,
        },
        {
          id: 'household', label: 'Household supplies & utilities', class: 'essential',
          from: ['Household'], plannedMonthly: 0,
        },
        {
          id: 'pets', label: 'Pets', class: 'essential',
          from: ['Pets'], plannedPayday: 100, plannedMonthly: null,
          paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-08-28',
        },
        {
          id: 'other-spend', label: 'Other spend', class: 'essential',
          from: [], plannedMonthly: 800,
        },
      ],
    },
  };
}

function periodsFixture() {
  return { periods: { ytd: { label: 'YTD', months: 1, spending: [] } } };
}

// Hand ledger. `count` is this file's membership decision, not Forecast's.
// Completed window counts posted rows only. Current window counts posted
// rows plus the one pending purchase, because pending coverage is precise.
const LEDGER = [
  { id: 'g-done', date: '2026-09-01', amount: 120, count: 'completed', note: 'posted groceries' },
  { id: 'f-done', date: '2026-09-02', amount: 30, count: 'completed', note: 'posted fuel' },
  { id: 'o-done', date: '2026-09-03', amount: 50, count: 'completed', note: 'posted other spending' },
  { id: 'h-done', date: '2026-09-04', amount: 15, count: 'completed', note: 'posted household, no payday hold' },
  { id: 'income-1', date: '2026-09-01', amount: -4000, count: null, note: 'income (a credit)' },
  { id: 'refund-1', date: '2026-09-02', amount: -20, count: null, note: 'refund' },
  { id: 'xfer-1', date: '2026-09-02', amount: 300, count: null, note: 'transfer' },
  { id: 'card-1', date: '2026-09-03', amount: 150, count: null, note: 'card payment' },
  { id: 'bill-1', date: '2026-09-05', amount: 88, count: null, note: 'represented bill' },
  { id: 'xmas-1', date: '2026-09-06', amount: 250, count: null, note: 'named commitment settlement' },
  { id: 'pend-old', date: '2026-09-07', amount: 40, count: null, note: 'pending-only in the completed period' },
  { id: 'fin-1', date: '2026-09-08', amount: 19, count: null, note: 'revolving finance charge' },
  { id: 'ext-1', date: '2026-09-09', amount: 70, count: null, note: 'external' },
  { id: 'biz-1', date: '2026-09-09', amount: 33, count: null, note: 'business' },
  { id: 'g-now', date: '2026-09-12', amount: 250, count: 'current', note: 'groceries above the 200 target' },
  { id: 'f-now', date: '2026-09-13', amount: 10, count: 'current', note: 'fuel under the 40 target' },
  { id: 'o-now', date: '2026-09-14', amount: 20, count: 'current', note: 'current other spending' },
  { id: 'pend-now', date: '2026-09-15', amount: 8, count: 'current', note: 'pending-only current groceries' },
  { id: 'pet-now', date: '2026-09-16', amount: 100, count: 'current', note: 'dog food on an OFF pets cycle' },
  { id: 'split-parent', date: '2026-09-17', amount: 50, count: null, note: 'split parent' },
  { id: 'split-a', date: '2026-09-17', amount: 25, count: 'current', note: 'split child' },
  { id: 'split-b', date: '2026-09-17', amount: 25, count: 'current', note: 'split child' },
  { id: 'twin-posted', date: '2026-09-18', amount: 12, count: 'current', note: 'posted twin' },
  { id: 'twin-pending', date: '2026-09-18', amount: 12, count: null, note: 'pending twin' },
  { id: 'xfer-now', date: '2026-09-12', amount: 500, count: null, note: 'current transfer' },
  { id: 'card-now', date: '2026-09-12', amount: 75, count: null, note: 'current card payment' },
];

function sumCounted(which) {
  return roundCent(LEDGER.filter(row => row.count === which)
    .reduce((sum, row) => sum + row.amount, 0));
}

const COMPLETED_ACTUAL = sumCounted('completed');
const CURRENT_ACTUAL = sumCounted('current');
// Current reserves: groceries planned 200 is already exceeded; fuel 40 − 10.
// Pets is OFF this cycle. other-spend $800/month is not a reserve for
// unassigned Other Spending. Household's explicit $0 is not a reserve.
const CURRENT_REMAINING = roundCent(Math.max(0, 40 - 10));
const CURRENT_FULL = roundCent(CURRENT_ACTUAL + CURRENT_REMAINING);
const PAY_PERIOD_BASELINE = roundCent((COMPLETED_ACTUAL + CURRENT_FULL) / 2);
const WEEKLY = roundCent(PAY_PERIOD_BASELINE / 2);

function tx(row, extra) {
  return Object.assign({
    id: row.id,
    date: row.date,
    amount: row.amount,
    account: 'chequing-a',
    atlasAccountId: 'chequing-a',
    pending: false,
  }, extra || {});
}

function packetFrom(rows, coverage) {
  const transactions = rows.map(row => {
    if (row.id === 'income-1') {
      return tx(row, { isIncome: true, payee: 'PAYROLL' });
    }
    if (row.id === 'refund-1') {
      return tx(row, { categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM' });
    }
    if (row.id === 'xfer-1' || row.id === 'xfer-now') {
      return tx(row, { categoryLabel: 'Transfer', payee: 'TFR' });
    }
    if (row.id === 'card-1' || row.id === 'card-now') {
      return tx(row, { categoryLabel: 'Credit Card Payment', payee: 'CAN TIRE MC', originalMerchant: 'CAN TIRE MC' });
    }
    if (row.id === 'bill-1') {
      return tx(row, { categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM' });
    }
    if (row.id === 'xmas-1') {
      return tx(row, { categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM' });
    }
    if (row.id === 'pend-old' || row.id === 'pend-now' || row.id === 'twin-pending') {
      return tx(row, {
        pending: true,
        categoryLabel: 'Groceries',
        payee: 'MERIDIAN FARM',
        originalMerchant: 'MERIDIAN FARM',
      });
    }
    if (row.id === 'fin-1') {
      return tx(row, {
        atlasAccountId: 'cashback',
        account: 'cashback',
        accountRole: 'revolving-credit',
        categoryLabel: 'Interest charge',
        payee: 'INTEREST CHARGE',
        originalMerchant: 'INTEREST CHARGE',
      });
    }
    if (row.id === 'ext-1') {
      return tx(row, { accountRole: 'household-external', categoryLabel: 'Groceries', payee: 'OUTSIDE' });
    }
    if (row.id === 'biz-1') {
      return tx(row, { categoryLabel: 'Business', payee: 'VENDOR' });
    }
    if (row.id === 'f-done' || row.id === 'f-now') {
      return tx(row, { categoryLabel: 'Fuel & transport', payee: 'PITT MEADOWS CE', originalMerchant: 'PITT MEADOWS CE' });
    }
    if (row.id === 'o-done' || row.id === 'o-now') {
      return tx(row, { categoryLabel: 'Misc shop', payee: 'CORNER STORE' });
    }
    if (row.id === 'h-done') {
      return tx(row, { categoryLabel: 'Household', payee: 'STORE' });
    }
    if (row.id === 'pet-now') {
      return tx(row, { categoryLabel: 'Pets', payee: 'SURREY MEAT PKR', originalMerchant: 'SURREY MEAT PKR' });
    }
    if (row.id === 'split-parent') {
      return tx(row, { isGroup: true, categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM' });
    }
    if (row.id === 'split-a' || row.id === 'split-b') {
      return tx(row, {
        parentId: 'split-parent',
        categoryLabel: 'Groceries',
        payee: 'MERIDIAN FARM',
        originalMerchant: 'MERIDIAN FARM',
      });
    }
    return tx(row, { categoryLabel: 'Groceries', payee: 'MERIDIAN FARM', originalMerchant: 'MERIDIAN FARM' });
  });
  return Object.assign({
    schema: 'atlas-current-period-actuals/v1',
    coverageStart: PREV_START,
    coverageThrough: AS_OF,
    observationAsOf: AS_OF,
    pendingCoverage: 'complete',
    transactionCoverage: 'complete',
    transactions,
    representedActuals: [
      { id: 'hydro', date: '2026-09-05', transactionId: 'bill-1', actual: 88 },
      { id: 'christmas', date: '2026-12-15', transactionId: 'xmas-1', actual: 250 },
    ],
  }, coverage || {});
}

function ask(plan, packet, extra) {
  return F.baselineTrajectory(plan, [], AS_OF, Object.assign({
    periods: periodsFixture(),
    currentPeriodActuals: packet,
  }, extra || {}));
}

function independentPlannedWeekly(plan) {
  const month = amount => roundCent(amount);
  const groceries = month(200 * MONTH_DAYS / 14);
  const fuel = month(40 * MONTH_DAYS / 14);
  const pets = 100;
  const otherSpend = 800;
  const household = 0;
  return roundCent((groceries + fuel + pets + otherSpend + household) / WEEKS_PER_MONTH);
}

function payPeriodByPayday(traj, payday) {
  return (traj.payPeriods || []).find(row => row && (row.payday === payday || row.cycleStart === payday));
}

function commitmentLine(period, id) {
  const lines = period && period.stage2 && period.stage2.commitments
    && period.stage2.commitments.lines || [];
  return lines.find(row => row && row.id === id) || null;
}

console.log('=== windows and hand ledger ===');
{
  const plan = planFixture();
  const current = F.spendingCycle(plan, AS_OF);
  const previous = F.spendingCycle(plan, F.addDays(current.start, -1));
  ok(current.start === CUR_START && current.end === CUR_END,
    'current Seaspan cycle is derived, not hard-coded as the only window',
    current.start + '–' + current.end);
  ok(previous.start === PREV_START && previous.end === PREV_END,
    'previous Seaspan cycle is the completed window',
    previous.start + '–' + previous.end);
  ok(COMPLETED_ACTUAL === 215, 'hand completed posted normal spend is 215', String(COMPLETED_ACTUAL));
  ok(CURRENT_ACTUAL === 450, 'hand current eligible actual-to-date is 450', String(CURRENT_ACTUAL));
  ok(CURRENT_REMAINING === 30, 'hand remaining fuel reserve is 30', String(CURRENT_REMAINING));
  ok(CURRENT_FULL === 480, 'hand current full-period estimate is 480', String(CURRENT_FULL));
  ok(PAY_PERIOD_BASELINE === 347.5, 'hand two-period combination is 347.50', String(PAY_PERIOD_BASELINE));
  ok(near(WEEKLY * 2, PAY_PERIOD_BASELINE), 'weekly walk rate is the 14-day baseline once');
}

console.log('\n=== provisional baseline feeds one walk ===');
{
  const plan = planFixture();
  const budgetBefore = JSON.stringify(plan.budget);
  const incomeBefore = JSON.stringify(plan.income);
  const billsBefore = JSON.stringify(plan.bills);
  const commitmentsBefore = JSON.stringify(plan.commitments);
  const packet = packetFrom(LEDGER);
  const traj = ask(plan, packet);
  const fallback = ask(plan, null);
  ok(JSON.stringify(plan.budget) === budgetBefore, 'owner budget targets are unchanged on the plan');
  ok(JSON.stringify(plan.income) === incomeBefore, 'income schedule is unchanged');
  ok(JSON.stringify(plan.bills) === billsBefore, 'bill schedule is unchanged');
  ok(JSON.stringify(plan.commitments) === commitmentsBefore, 'commitment rows are unchanged');
  ok(traj.status === 'ready', 'trajectory is ready when both windows are covered', traj.reason);
  const ns = traj.normalSpending;
  ok(ns && ns.status === 'ready', 'recent baseline is ready');
  ok(ns.completedPeriod && ns.completedPeriod.amount === COMPLETED_ACTUAL
      && ns.completedPeriod.start === PREV_START && ns.completedPeriod.end === PREV_END
      && ns.completedPeriod.evidence === 'posted-actual' && ns.completedPeriod.provisional === false,
    'completed component is the posted actual for the previous cycle',
    ns && ns.completedPeriod && String(ns.completedPeriod.amount));
  ok(ns.currentPeriod && ns.currentPeriod.actualToDate === CURRENT_ACTUAL
      && ns.currentPeriod.remainingExpected === CURRENT_REMAINING
      && ns.currentPeriod.fullPeriodEstimate === CURRENT_FULL
      && ns.currentPeriod.start === CUR_START && ns.currentPeriod.end === CUR_END
      && ns.currentPeriod.provisional === true
      && ns.currentPeriod.completedHistoricalPeriod === false
      && ns.currentPeriod.trust === 'estimated',
    'current component is a provisional full-period estimate',
    ns && ns.currentPeriod && String(ns.currentPeriod.fullPeriodEstimate));
  ok(ns.payPeriodAmount === PAY_PERIOD_BASELINE && near(ns.weeklyVariable, WEEKLY),
    'published combination matches the hand mean and one weekly conversion');
  ok(ns.phrase === 'Normal spending estimate based on 2 pay periods — 1 completed actual + current-period estimate.',
    'phrase names one completed actual and the current-period estimate');
  ok(ns.rule.indexOf('(completed posted actual + current full-period estimate) / 2') >= 0,
    'the combination rule is published');
  ok(!/average/i.test(ns.phrase) && ns.establishedHouseholdAverage === false,
    'the estimate does not call itself an established household average');
  ok(traj.weeklyVariable.source === 'provisional-recent-pay-period'
      && traj.weeklyVariable.status === 'estimated'
      && traj.weeklyVariable.historicalActuals === 'recent-two-period-baseline'
      && near(traj.weeklyVariable.amount, WEEKLY),
    'the walk input is the provisional baseline, not the owner-target smear');
  ok(traj.months.every(row => row.spend && row.spend.source === 'provisional-recent-pay-period'
      && near(row.spend.weeklyVariable, WEEKLY))
      && traj.payPeriods.every(row => row.spend && near(row.spend.weeklyVariable, WEEKLY)),
    'Month and Pay Period publish the same walk weekly');

  const next = payPeriodByPayday(traj, '2026-09-25');
  const blendSum = roundCent((ns.categories || []).reduce((s, row) => s + row.amount, 0));
  const blend = id => (ns.categories || []).find(row => row && row.id === id);
  ok(ns.categories && blendSum === PAY_PERIOD_BASELINE
      && blend('groceries') && blend('groceries').amount === 220
      && blend('fuel') && blend('fuel').amount === 35
      && blend('pets') && blend('pets').amount === 50
      && blend('household') && blend('household').amount === 7.5
      && blend('other-spending') && blend('other-spending').amount === 35
      && !ns.categories.some(row => row.id === 'other-spend' || row.id === 'travel' || row.id === 'propertytax'),
    'the baseline names the same category cents that sum to the 14-day amount',
    ns.categories && ns.categories.map(row => row.id + ':' + row.amount).join(', '));
  const nextLines = next && next.stage1 && next.stage1.householdBudget.lines || [];
  const nextLineSum = roundCent(nextLines.reduce((s, row) => s + row.amount, 0));
  ok(next && next.stage1 && next.stage1.householdBudget
      && next.stage1.householdBudget.walkDays === 14
      && near(next.stage1.householdBudget.amount, PAY_PERIOD_BASELINE)
      && next.stage1.householdBudget.status === 'estimated'
      && nextLines.length > 1
      && nextLineSum === next.stage1.householdBudget.amount
      && !nextLines.some(row => row.label === 'Normal spending estimate')
      && nextLines.every(row => row.status === 'estimated'),
    'a future 14-day pay period applies the baseline once, split by those categories',
    next && next.stage1 && String(next.stage1.householdBudget.amount));
  const stage1 = roundCent(1000 - 80 - 0 - PAY_PERIOD_BASELINE);
  ok(next.stage1.income && near(next.stage1.income.amount, 1000)
      && next.stage1.bills && near(next.stage1.bills.amount, 80)
      && next.stage1.obligations && near(next.stage1.obligations.amount, 0)
      && near(next.stage1.result.amount, stage1)
      && near(next.stage2.result.amount, stage1)
      && near(next.stage3.result.amount, stage1),
    'Stage 1 on the next pay period is income − bills − obligations − the baseline',
    String(next.stage1.result.amount));

  const december = payPeriodByPayday(traj, '2026-12-04');
  const christmas = commitmentLine(december, 'christmas');
  const fallbackDecember = payPeriodByPayday(fallback, '2026-12-04');
  const fallbackChristmas = commitmentLine(fallbackDecember, 'christmas');
  ok(christmas && christmas.amount === 250 && christmas.date === '2026-12-15'
      && fallbackChristmas && fallbackChristmas.amount === 250
      && fallbackChristmas.date === '2026-12-15',
    'Christmas stays 250 on 15 Dec in the same pay period');
  ok(near(december.stage2.result.amount, roundCent(stage1 - 250)),
    'Stage 2 subtracts the named commitment from Stage 1',
    String(december.stage2.result.amount));
  ok(!(traj.payPeriods || []).some(period => commitmentLine(period, 'vacation-tbd')),
    'the range-only TBD vacation is not assigned to a payday');
  const fallbackNext = payPeriodByPayday(fallback, '2026-09-25');
  ok(fallbackNext && near(fallbackNext.stage1.income.amount, next.stage1.income.amount)
      && near(fallbackNext.stage1.bills.amount, next.stage1.bills.amount)
      && !near(fallbackNext.stage1.householdBudget.amount, next.stage1.householdBudget.amount),
    'income and bills stay on the schedule while normal spending changes');

  const october = (traj.months || []).find(row => row.month === '2026-10');
  // Sep 22–30 has nine spending days before October's 31. Keep one
  // cent allocation on the walk; do not restart rounding on October 1.
  ok(october && october.roadAheadMonthFunding === 'pay-period-close'
      && near(october.spend.weeklyVariable, next.spend.weeklyVariable),
    'October uses the same weekly rate as the pay-period walk');
}

console.log('\n=== incomplete coverage falls back, never to $0 ===');
{
  const plan = planFixture();
  const narrow = packetFrom(LEDGER, { coverageStart: CUR_START });
  const traj = ask(plan, narrow);
  const expected = independentPlannedWeekly(plan);
  ok(traj.status === 'ready', 'Road Ahead still publishes on the planned fallback');
  ok(traj.normalSpending && traj.normalSpending.status === 'unavailable'
      && traj.normalSpending.payPeriodAmount == null
      && traj.normalSpending.fallback === 'planned-household-budget'
      && /Not \$0/.test(traj.normalSpending.reason)
      && /completed Seaspan pay period/.test(traj.normalSpending.reason),
    'the recent baseline is withheld with a reason and no amount');
  ok(traj.weeklyVariable.source === 'budgetBreakdown.planned'
      && traj.weeklyVariable.historicalActuals === 'excluded'
      && near(traj.weeklyVariable.amount, expected)
      && traj.weeklyVariable.amount !== 0,
    'fallback weekly equals the independent planned Household Budget rate',
    String(traj.weeklyVariable.amount) + ' vs ' + expected);
  const unmapped = packetFrom(LEDGER.concat([{
    id: 'unmapped-1', date: '2026-09-02', amount: 10, count: null,
  }]));
  unmapped.transactions.push({
    id: 'unmapped-1', date: '2026-09-02', amount: 10, accountRole: 'unmapped', pending: false,
  });
  const withheld = ask(plan, unmapped);
  ok(withheld.normalSpending && withheld.normalSpending.status === 'unavailable'
      && withheld.normalSpending.payPeriodAmount == null
      && withheld.weeklyVariable.amount !== 0,
    'an unmapped account withholds the recent baseline instead of publishing $0');
}

console.log('\n=== odd-cent 14-day identity ===');
{
  // Independent hand totals on the same membership as the main ledger.
  // One extra posted completed grocery of $0.02 makes the published
  // 14-day baseline an odd-cent amount. The second weekly rounding
  // (roundCent(baseline / 2) * 2) is the defect; a full Seaspan cycle
  // must apply the published baseline, not that drifted weekly * 2.
  const ODD_COMPLETED = 215.02;
  const ODD_CURRENT_FULL = 480;
  const ODD_BASELINE = roundCent((ODD_COMPLETED + ODD_CURRENT_FULL) / 2);
  const DOUBLE_ROUNDED_APPLY = roundCent(roundCent(ODD_BASELINE / 2) * 2);
  const ODD_STAGE1 = roundCent(1000 - 80 - 0 - ODD_BASELINE);
  ok(ODD_COMPLETED === 215.02 && ODD_CURRENT_FULL === 480,
    'hand odd-cent inputs are 215.02 completed and 480 current-full');
  ok(ODD_BASELINE === 347.51, 'hand two-period combination is 347.51', String(ODD_BASELINE));
  ok(DOUBLE_ROUNDED_APPLY === 347.52 && DOUBLE_ROUNDED_APPLY !== ODD_BASELINE,
    'hand proof: a second weekly rounding would apply 347.52, not 347.51');
  ok(ODD_STAGE1 === 572.49, 'hand Stage 1 is 1000 − 80 − 347.51 = 572.49', String(ODD_STAGE1));

  const plan = planFixture();
  const packet = packetFrom(LEDGER.concat([{
    id: 'g-odd', date: '2026-09-01', amount: 0.02, count: 'completed',
    note: 'odd-cent posted groceries',
  }]));
  const traj = ask(plan, packet);
  const ns = traj.normalSpending;
  ok(ns && ns.status === 'ready' && ns.completedPeriod
      && ns.completedPeriod.amount === ODD_COMPLETED
      && ns.currentPeriod && ns.currentPeriod.fullPeriodEstimate === ODD_CURRENT_FULL
      && ns.payPeriodAmount === ODD_BASELINE,
    'published baseline is the odd-cent hand mean 347.51',
    ns && String(ns.payPeriodAmount));
  const next = payPeriodByPayday(traj, '2026-09-25');
  ok(next && next.stage1 && next.stage1.householdBudget
      && next.stage1.householdBudget.walkDays === 14
      && next.stage1.householdBudget.amount === ODD_BASELINE
      && next.stage1.householdBudget.amount !== DOUBLE_ROUNDED_APPLY,
    'a full Seaspan cycle applies exactly the published 347.51, not 347.52',
    next && next.stage1 && String(next.stage1.householdBudget.amount));
  ok(next.stage1.result && next.stage1.result.amount === ODD_STAGE1
      && next.stage2.result.amount === ODD_STAGE1
      && next.stage3.result.amount === ODD_STAGE1,
    'Stage 1 on that cycle is income − bills − the published 347.51',
    next && next.stage1 && String(next.stage1.result.amount));
}

console.log('\n=== posted-only current coverage does not treat pending as complete ===');
{
  const plan = planFixture();
  const postedOnly = packetFrom(LEDGER, { pendingCoverage: 'unknown' });
  const traj = ask(plan, postedOnly);
  const actual = roundCent(CURRENT_ACTUAL - 8);
  const full = roundCent(actual + CURRENT_REMAINING);
  const mean = roundCent((COMPLETED_ACTUAL + full) / 2);
  ok(traj.normalSpending && traj.normalSpending.currentPeriod.actualToDate === actual
      && traj.normalSpending.currentPeriod.fullPeriodEstimate === full
      && traj.normalSpending.payPeriodAmount === mean
      && traj.normalSpending.currentPeriod.provisional === true,
    'the pending-only current purchase is omitted when pending coverage is not precise',
    traj.normalSpending && String(traj.normalSpending.currentPeriod.actualToDate));
}

console.log('\n=== live targets and page wiring ===');
{
  ok(hashFile(DATA) === liveHashBefore, 'data.json bytes are unchanged');
  const liveTargetsAfter = JSON.stringify(require(DATA).plan.budget.categories.map(row => ({
    id: row.id,
    plannedPayday: row.plannedPayday == null ? null : row.plannedPayday,
    plannedMonthly: row.plannedMonthly == null ? null : row.plannedMonthly,
    paydayCadence: row.paydayCadence || null,
    paydayCadenceAnchor: row.paydayCadenceAnchor || null,
  })));
  ok(liveTargetsAfter === liveTargetsBefore,
    'live owner payday and monthly targets are byte-for-byte unchanged');
  const planning = fs.readFileSync(path.join(ROOT, 'public/planning.js'), 'utf8');
  ok(/function planningTrajectory\(/.test(planning)
      && /currentPeriodActuals: actuals/.test(planning)
      && !/payPeriodAmount\s*\+|fullPeriodEstimate\s*\/\s*2/.test(planning),
    'the Planning page passes Forecast the actuals packet and does not combine the baseline');
  const architecture = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  ok(/provisional recent pay-period baseline/.test(architecture),
    'ARCHITECTURE names the Road Ahead normal-spending authority');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll provisional normal-spending checks passed.');
