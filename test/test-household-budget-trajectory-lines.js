'use strict';
/* Road Ahead Household Budget lines.
 *
 * Forecast publishes the categories behind stage1.householdBudget.
 * The rollup stays the walk-applied weeklyVariable. Named lines keep a
 * constant owner-target share of that walk. every-other-seaspan keeps
 * its share only on ON-cycle days; the smoothed OFF-cycle share is an
 * explicit Normal spending estimate residual, not another category.
 * Planning reprints lines and does not split them.
 *
 * `node test/test-household-budget-trajectory-lines.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const lineSum = lines => roundCent((lines || []).reduce((s, row) => s + (Number(row.amount) || 0), 0));
const lineBy = (lines, label) => (lines || []).find(row => row && row.label === label) || null;

const MONTH_DAYS = 365.25 / 12;
const AS_OF = '2026-08-01';
const PETS_ON = '2026-08-28';

function periods() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [
          { label: 'Travel', total: 18000 },
          { label: 'Property tax', total: 5600 },
        ],
      },
    },
  };
}

function plan() {
  return {
    windowDays: 120,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: AS_OF },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    budget: {
      basis: 'ytd',
      categories: [
        {
          id: 'groceries', label: 'Groceries', class: 'essential',
          from: ['Groceries'], plannedPayday: 900, plannedMonthly: null,
          ownerLine: 'Groceries',
        },
        {
          id: 'fuel', label: 'Fuel & transport', class: 'essential',
          from: ['Fuel'], plannedPayday: 325, plannedMonthly: null,
          ownerLine: 'Fuel',
        },
        {
          id: 'pets', label: 'Pets', class: 'essential',
          from: ['Pets'], plannedPayday: 100, plannedMonthly: null,
          paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: PETS_ON,
          ownerLine: 'Dog food',
        },
        {
          id: 'restaurants', label: 'Dining out & takeaway', class: 'discretionary',
          from: ['Restaurants'], plannedPayday: 200, plannedMonthly: null,
          ownerLine: 'Eating out',
        },
        {
          id: 'dale-guilt-free', label: 'Dale guilt-free spending', class: 'discretionary',
          from: ['Dale'], plannedPayday: 150, plannedMonthly: null,
          ownerLine: 'Dale guilt-free spending',
        },
        {
          id: 'amanda-guilt-free', label: 'Amanda guilt-free spending', class: 'discretionary',
          from: ['Amanda'], plannedPayday: 150, plannedMonthly: null,
          ownerLine: 'Amanda guilt-free spending',
        },
        {
          id: 'other-spend', label: 'Other spend', class: 'essential',
          from: [], plannedMonthly: 800, ownerLine: 'Other spend',
        },
        {
          id: 'travel', label: 'Travel', class: 'discretionary', from: ['Travel'],
        },
        {
          id: 'propertytax', label: 'Property tax', class: 'reserve',
          from: ['Property tax'], plannedMonthly: null,
        },
      ],
    },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-08-14',
      amount: 2000, confidence: 'confirmed',
    }],
    obligations: [{
      id: 'card-min', debtId: 'card', effect: 'payment',
      label: 'Card minimum', frequency: 'monthly', day: 20,
      amount: 80, confidence: 'confirmed',
    }],
    bills: [{
      id: 'hydro', label: 'Hydro', frequency: 'monthly', day: 5,
      amount: 120, confidence: 'confirmed',
    }],
    commitments: [{
      id: 'camp', label: 'Camp', date: '2026-09-20',
      amount: 40, confidence: 'confirmed', flexibility: 'required',
    }],
  };
}

const debts = [{
  id: 'card', label: 'Synthetic card',
  balance: 600, pending: 0, rate: 19.99, rateConvention: 'card',
  structure: 'Revolving — synthetic', secured: false, limit: 1500,
}];

function ask(asOf, extra) {
  const p = plan();
  p.opening.asOf = asOf;
  return F.baselineTrajectory(p, debts, asOf, Object.assign({ periods: periods() }, extra || {}));
}

function independentMonthly() {
  const paydayMonthly = amount => roundCent(amount * MONTH_DAYS / 14);
  return roundCent(
    paydayMonthly(900) + paydayMonthly(325) + paydayMonthly(200)
    + paydayMonthly(150) + paydayMonthly(150) + 100 + 800);
}

function cycleOn(payday) {
  const on = Date.parse(PETS_ON);
  const steps = (Date.parse(payday) - on) / 86400000 / 14;
  return steps % 2 === 0;
}

console.log('=== planned lines reconcile and keep cadence ===');
{
  const traj = ask(AS_OF);
  ok(traj.status === 'ready', 'synthetic trajectory is ready');
  const weekly = independentMonthly() / (MONTH_DAYS / 7);
  ok(near(traj.weeklyVariable.amount, roundCent(weekly), 0.02),
    'weeklyVariable is still the planned monthly total, including the every-other monthly equivalent',
    String(traj.weeklyVariable.amount));

  const on = (traj.payPeriods || []).find(p => p.payday === '2026-08-28');
  const off = (traj.payPeriods || []).find(p => p.payday === '2026-09-11');
  ok(on && on.windowKind === 'full-cycle' && cycleOn(on.payday), '28 Aug is a full ON Seaspan cycle');
  ok(off && off.windowKind === 'full-cycle' && !cycleOn(off.payday), '11 Sep is a full OFF Seaspan cycle');

  for (const period of [on, off]) {
    const hb = period.stage1.householdBudget;
    ok(lineSum(hb.lines) === roundCent(hb.amount),
      `${period.payday} line cents equal the Household Budget total`,
      `${lineSum(hb.lines)} vs ${hb.amount}`);
    ok(near(period.stage1.result.amount, roundCent(
      period.stage1.income.amount - period.stage1.bills.amount
      - period.stage1.obligations.amount - hb.amount)),
      `${period.payday} Stage 1 identity is unchanged`);
    ok(near(period.stage2.result.amount, roundCent(
      period.stage1.result.amount - period.stage2.commitments.amount)),
      `${period.payday} Stage 2 identity is unchanged`);
  }

  const onLines = on.stage1.householdBudget.lines;
  const offLines = off.stage1.householdBudget.lines;
  ok(lineBy(onLines, 'Dog food') && !lineBy(offLines, 'Dog food'),
    'Dog food is on the ON cycle and absent from the next OFF cycle');
  ok(!lineBy(onLines, 'Normal spending estimate')
      && lineBy(offLines, 'Normal spending estimate'),
    'the OFF cycle keeps the smoothed Dog food cents as an explicit residual');
  ok(near(lineBy(onLines, 'Fuel').amount, lineBy(offLines, 'Fuel').amount, 0.02)
      && near(lineBy(onLines, 'Other spend').amount, lineBy(offLines, 'Other spend').amount, 0.02),
    'OFF-cycle Fuel and Other spend do not absorb the Dog food smear');
  ok(near(lineBy(onLines, 'Fuel').amount, 325, 0.1)
      && near(lineBy(onLines, 'Groceries').amount, 900, 0.1)
      && near(lineBy(onLines, 'Eating out').amount, 200, 0.1)
      && near(lineBy(onLines, 'Dale guilt-free spending').amount, 150, 0.1)
      && near(lineBy(onLines, 'Amanda guilt-free spending').amount, 150, 0.1),
    'ON-cycle payday lines are the incumbent payday amounts',
    onLines.map(row => row.label + ':' + row.amount).join(', '));
  ok(lineBy(onLines, 'Other spend') && lineBy(offLines, 'Other spend')
      && !near(lineBy(onLines, 'Other spend').amount, 800)
      && lineBy(onLines, 'Other spend').amount > 0,
    'Other spend stays the monthly authority, clipped to the pay period');
  ok(!onLines.some(row => row.label === 'Travel' || row.label === 'Property tax')
      && !offLines.some(row => row.label === 'Travel' || row.label === 'Property tax'),
    'historical Travel and the reserve are not Household Budget lines');
  ok(onLines.filter(row => row.label === 'Groceries').length === 1
      && onLines.filter(row => row.label === 'Other spend').length === 1,
    'payday and monthly categories each appear once');

  const august = (traj.months || []).find(m => m.month === '2026-08');
  ok(august && lineSum(august.stage1.householdBudget.lines) === roundCent(august.stage1.householdBudget.amount),
    'August month lines sum to the month Household Budget total');
  ok(lineBy(august.stage1.householdBudget.lines, 'Groceries')
      && !near(lineBy(august.stage1.householdBudget.lines, 'Groceries').amount, 900),
    'the month Groceries line is the payday annualization, not one stored $900');
  ok(lineBy(august.stage1.householdBudget.lines, 'Dog food'),
    'August shows Dog food because it contains an ON Seaspan cycle');

  const dogMonths = (traj.months || []).reduce((s, row) => {
    const line = lineBy(row.stage1 && row.stage1.householdBudget && row.stage1.householdBudget.lines, 'Dog food');
    return s + (line ? line.amount : 0);
  }, 0);
  const dogPeriods = (traj.payPeriods || []).reduce((s, row) => {
    const line = lineBy(row.stage1 && row.stage1.householdBudget && row.stage1.householdBudget.lines, 'Dog food');
    return s + (line ? line.amount : 0);
  }, 0);
  ok(near(roundCent(dogMonths), roundCent(dogPeriods), 0.02),
    'Dog food cents in the month view equal the pay-period view',
    `${roundCent(dogMonths)} vs ${roundCent(dogPeriods)}`);
}

console.log('\n=== residual pay period stays clipped ===');
{
  const full = ask(AS_OF);
  const on = (full.payPeriods || []).find(p => p.payday === '2026-08-28');
  const clipped = ask('2026-08-30');
  const residual = (clipped.payPeriods || []).find(p => p.payday === '2026-08-28');
  ok(residual && residual.windowKind === 'as-of-residual'
      && residual.stage1.householdBudget.walkDays < 14
      && residual.stage1.householdBudget.walkDays > 0,
    '30 Aug publishes the remaining ON cycle, not a new full cycle',
    residual && String(residual.stage1.householdBudget.walkDays));
  const fullDog = lineBy(on.stage1.householdBudget.lines, 'Dog food');
  const partDog = lineBy(residual.stage1.householdBudget.lines, 'Dog food');
  const fullFuel = lineBy(on.stage1.householdBudget.lines, 'Fuel');
  const partFuel = lineBy(residual.stage1.householdBudget.lines, 'Fuel');
  ok(partDog && fullDog && partDog.amount < fullDog.amount && partDog.amount !== 100,
    'residual Dog food is the clipped ON-cycle share, not the full hold');
  ok(partFuel && fullFuel && partFuel.amount < fullFuel.amount && partFuel.amount !== 325,
    'residual Fuel is not rewritten as the full payday amount');
  ok(lineSum(residual.stage1.householdBudget.lines) === roundCent(residual.stage1.householdBudget.amount),
    'residual lines still sum to the clipped Household Budget total');
}

console.log('\n=== hand-computed sole every-other cycle ===');
{
  // $100 every-other monthly equivalent. Calendar weeks are 365.25/12/7.
  // weekly = round(100 / weeks, 2 cents) = 23.00.
  // Walk pennies use fortnight cents round(23.00 * 200) = 4600.
  // 14 days from a zero prior: floor((4600 * 14 + 7) / 14) = 4600 cents = $46.00.
  // The next 14 days are the same $46.00. No largest-remainder split:
  // the only category either receives the whole rollup or none of it.
  const weeklyCents = Math.round((100 / (MONTH_DAYS / 7)) * 100);
  const fortnightCents = Math.round((weeklyCents / 100) * 200);
  const throughCents = days => Math.floor((fortnightCents * days + 7) / 14);
  ok(weeklyCents === 2300 && fortnightCents === 4600, 'hand weekly rate is $23.00');
  ok(throughCents(14) === 4600 && throughCents(28) - throughCents(14) === 4600,
    'each full cycle from a zero prior is $46.00');
  const only = {
    windowDays: 60,
    startingCash: { amount: 5000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: '2026-08-28' },
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'pets', label: 'Pets', class: 'essential', from: ['Pets'],
        plannedPayday: 100, plannedMonthly: null,
        paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-08-28',
        ownerLine: 'Dog food',
      }],
    },
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-08-28',
      amount: 1000, confidence: 'confirmed',
    }],
    obligations: [], bills: [], commitments: [],
  };
  const traj = F.baselineTrajectory(only, [], '2026-08-28', { periods: periods() });
  const on = (traj.payPeriods || []).find(p => p.payday === '2026-08-28');
  const off = (traj.payPeriods || []).find(p => p.payday === '2026-09-11');
  const onHb = on && on.stage1.householdBudget;
  const offHb = off && off.stage1.householdBudget;
  ok(onHb && onHb.amount === 46 && lineBy(onHb.lines, 'Dog food')
      && lineBy(onHb.lines, 'Dog food').amount === 46
      && !lineBy(onHb.lines, 'Normal spending estimate'),
    'ON cycle publishes Dog food at the hand $46.00 and no residual',
    onHb && onHb.lines.map(row => row.label + ':' + row.amount).join(', '));
  ok(offHb && offHb.amount === 46 && !lineBy(offHb.lines, 'Dog food')
      && lineBy(offHb.lines, 'Normal spending estimate')
      && lineBy(offHb.lines, 'Normal spending estimate').amount === 46
      && offHb.lines.length === 1,
    'OFF cycle publishes the whole $46.00 as Normal spending estimate',
    offHb && offHb.lines.map(row => row.label + ':' + row.amount).join(', '));
  ok(lineSum(onHb.lines) === onHb.amount && lineSum(offHb.lines) === offHb.amount,
    'both cycles reconcile lines to the unchanged rollup');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll Household Budget trajectory line checks passed.');
