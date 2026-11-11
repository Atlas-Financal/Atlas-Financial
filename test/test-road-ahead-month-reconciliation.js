'use strict';
// Month reconciliation reprints Forecast close-period Stage 1 lines.
// Expected cents are integer sums of those published pay-period components
// and of expandEvents occurrences. They do not call the month merge helper.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast');

const AS_OF = '2026-01-01';
let checks = 0;
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
function cents(n) {
  return Math.round(Number(n) * 100);
}

function plan(extra) {
  return Object.assign({
    windowDays: 120,
    startingCash: { amount: 4000 },
    defaults: { targetBuffer: 0, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: AS_OF },
    budget: {
      basis: 'ytd',
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', from: ['Groceries'], plannedWeekly: 140 },
        { id: 'fuel', label: 'Fuel', class: 'essential', from: ['Fuel'], plannedWeekly: 60 },
        { id: 'dog-food', label: 'Dog food', class: 'essential', from: ['Pets'], plannedBiweekly: 40, paydayCadence: 'every-other-seaspan', paydayCadenceAnchor: '2026-01-02' },
        { id: 'eating-out', label: 'Eating out', class: 'discretionary', from: ['Eating out'], plannedWeekly: 25 },
        { id: 'dale-guilt-free', label: 'Dale guilt-free', ownerLine: 'Dale guilt-free', class: 'discretionary', from: ['Dale'], plannedWeekly: 20 },
        { id: 'amanda-guilt-free', label: 'Amanda guilt-free', ownerLine: 'Amanda guilt-free', class: 'discretionary', from: ['Amanda'], plannedWeekly: 20 },
        { id: 'other-spend', label: 'Other spend', class: 'essential', from: ['Other'], plannedMonthly: 800, source: 'owner-stated-2026-09-18' },
      ],
    },
    income: [
      { id: 'payroll', label: 'Dale — Seaspan', frequency: 'biweekly', anchor: '2026-01-02', amount: 2000, confidence: 'confirmed' },
      { id: 'amanda', label: 'Amanda — Tennis BC', frequency: 'monthly', day: 15, amount: 1800, confidence: 'confirmed' },
      { id: 'amanda-eom', label: 'Amanda — Tennis BC month end', frequency: 'monthly', day: 31, amount: 900, confidence: 'confirmed' },
      { id: 'ccb', label: 'Child benefit', frequency: 'monthly', day: 20, amount: 200, confidence: 'confirmed' },
    ],
    obligations: [
      { id: 'visa-min', label: 'Travel Visa minimum', frequency: 'monthly', day: 12, amount: 75, confidence: 'confirmed' },
    ],
    bills: [
      { id: 'mortgage', label: 'Mortgage', frequency: 'monthly', day: 1, amount: 900, confidence: 'confirmed' },
      { id: 'rogers', label: 'Rogers', frequency: 'monthly', day: 8, amount: 120, confidence: 'confirmed' },
    ],
    commitments: [],
  }, extra || {});
}

function ask(p) {
  return F.baselineTrajectory(p, [], p.opening.asOf, {
    periods: { periods: { ytd: { months: 1, spending: [] } } },
  });
}


function closingPeriods(traj, month) {
  return (month.closingPayPeriods || []).map(row => {
    const period = (traj.payPeriods || []).find(p => p.payday === row.payday);
    if (!period) throw new Error('missing closing period ' + row.payday);
    return period;
  });
}

function sumComponent(periods, key) {
  return periods.reduce((sum, period) => sum + cents(period.stage1[key].amount), 0);
}

const base = plan();
const other = base.budget.categories.filter(row => row.id === 'other-spend');
eq(other.length, 1, 'one other-spend planning category');
eq(other[0].plannedMonthly, 800, 'other-spend planning target stays 800 per month');
const budgetBefore = F.budgetBreakdown(base, { periods: { ytd: { months: 1, spending: [] } } });
const traj = ask(base);
const budgetAfter = F.budgetBreakdown(base, { periods: { ytd: { months: 1, spending: [] } } });
eq(budgetAfter.categories.map(row => [row.id, row.planned]),
  budgetBefore.categories.map(row => [row.id, row.planned]),
  'budget figures are unchanged by the trajectory');

const month = traj.months.find(row => {
  const closes = (row.closingPayPeriods || []).map(item => item.close).sort();
  if (closes.length < 2 || !(closes[0] > row.start)) return false;
  const periods = closingPeriods(traj, row);
  return cents(row.income.amount) !== sumComponent(periods, 'income');
});
eq(!!month, true, 'a month with two closing pay periods exists');
const periods = closingPeriods(traj, month);
eq(periods.length >= 2, true, 'both closing pay periods are on the pay-period series');
eq(new Set(periods.map(row => row.payday)).size, periods.length, 'closing paydays are distinct');

const incomeC = sumComponent(periods, 'income');
const billsC = sumComponent(periods, 'bills');
const obligationsC = sumComponent(periods, 'obligations');
const budgetC = sumComponent(periods, 'householdBudget');
const stage1C = periods.reduce((sum, period) => sum + cents(period.stage1.result.amount), 0);
eq(incomeC - billsC - obligationsC - budgetC, stage1C, 'closing-period components equal Stage 1 to the cent');
eq(cents(month.stage1.income.amount), incomeC, 'month close income is the closing periods, not a second sum');
eq(cents(month.stage1.bills.amount), billsC, 'month bills total equals closing-period bills');
eq(cents(month.stage1.obligations.amount), obligationsC, 'month obligations total equals closing-period obligations');
eq(cents(month.stage1.householdBudget.amount), budgetC, 'month household budget equals closing-period budget');
eq(cents(month.stage1.result.amount), stage1C, 'month Stage 1 result equals the closing-period results');
eq(cents(month.income.amount) === incomeC, false, 'calendar income is not forced to equal close-period income');

const events = F.expandEvents(base, traj.horizon.start, traj.horizon.end);
function inClose(event) {
  return periods.some(period => event.date >= period.start && event.date <= period.end);
}
const billEvents = events.filter(event =>
  event && event.kind === 'bill' && event.jointCash !== false && !event.cardPaid && inClose(event));
const byOccurrence = new Map();
for (const event of billEvents) {
  const key = (event.id || '') + '\n' + event.date;
  byOccurrence.set(key, (byOccurrence.get(key) || 0) + cents(-event.amount));
}
const publishedBills = month.stage1.bills.lines || [];
eq(publishedBills.length, byOccurrence.size, 'each dated bill occurrence is published once');
for (const line of publishedBills) {
  eq(typeof line.date, 'string', 'bill occurrence keeps its Forecast date');
  const key = (line.id || '') + '\n' + line.date;
  eq(byOccurrence.has(key), true, 'published bill occurrence is a real dated event');
  eq(cents(line.amount), byOccurrence.get(key), 'bill occurrence amount matches the dated event');
}
eq(publishedBills.reduce((sum, line) => sum + cents(line.amount), 0), cents(month.stage1.bills.amount),
  'visible bill rows sum to the Forecast bills total');
const mortgageDates = publishedBills.filter(line => line.id === 'mortgage').map(line => line.date);
eq(new Set(mortgageDates).size, mortgageDates.length, 'same-id mortgage dates are not collapsed');

const obligationEvents = events.filter(event => event && event.kind === 'obligation' && inClose(event));
const obligationKeys = new Map();
for (const event of obligationEvents) {
  const key = (event.id || '') + '\n' + event.date;
  obligationKeys.set(key, (obligationKeys.get(key) || 0) + cents(-event.amount));
}
const publishedObligations = month.stage1.obligations.lines || [];
eq(publishedObligations.length, obligationKeys.size, 'each required-payment occurrence is published once');
eq(publishedObligations.reduce((sum, line) => sum + cents(line.amount), 0), cents(month.stage1.obligations.amount),
  'required-payment rows sum to the Forecast obligations total');

const budgetLines = month.stage1.householdBudget.lines || [];
eq(budgetLines.reduce((sum, line) => sum + cents(line.amount), 0), cents(month.stage1.householdBudget.amount),
  'household budget rows sum to the Forecast household budget total');
eq(budgetLines.some(line => line.id === 'groceries' && cents(line.amount) > 0), true, 'Groceries is in the close-period budget');
eq(budgetLines.some(line => line.id === 'fuel' && cents(line.amount) > 0), true, 'Fuel is in the close-period budget');
const otherLine = budgetLines.find(line => line.id === 'other-spend');
eq(!!otherLine, true, 'Other spend is the Forecast line, not a second category');
eq(cents(otherLine.amount), periods.reduce((sum, period) => {
  const line = (period.stage1.householdBudget.lines || []).find(row => row.id === 'other-spend');
  return sum + (line ? cents(line.amount) : 0);
}, 0), 'Other spend row is the close-period Forecast amount, not a forced $800');
const dog = budgetLines.find(line => line.id === 'dog-food');
const dogPeriods = periods.filter(period =>
  (period.stage1.householdBudget.lines || []).some(line => line.id === 'dog-food'));
if (dog) {
  eq(cents(dog.amount), dogPeriods.reduce((sum, period) => {
    const line = period.stage1.householdBudget.lines.find(row => row.id === 'dog-food');
    return sum + cents(line.amount);
  }, 0), 'dog food is only the periods Forecast included');
} else {
  eq(dogPeriods.length, 0, 'dog food is absent when no closing period included it');
}

eq(!month.stage2.dateOrderResult.unavailableByDueDate, true, 'ordinary month publishes no timing plug');
eq(cents(month.stage2.dateOrderResult.amount), cents(month.stage1.result.amount) - cents(month.stage2.commitments.amount),
  'ordinary month date-order result is Stage 1 minus planned spending');

const payBefore = traj.payPeriods.map(row => [row.payday, cents(row.stage1.result.amount), cents(row.stage3.result.amount)]);
const closes = month.closingPayPeriods.map(row => row.close).sort();
const earlyDate = closes[0] > month.start ? month.start : null;
eq(!!earlyDate, true, 'the selected month starts before its first close');
const early = ask(plan({
  commitments: [{
    id: 'early-buy', label: 'Fusion', date: earlyDate, amount: 250,
    flexibility: 'required', confidence: 'confirmed',
  }],
}));
eq(early.payPeriods.map(row => [row.payday, cents(row.stage1.result.amount)]),
  payBefore.map(row => [row[0], row[1]]),
  'pay-period Stage 1 figures are unchanged');
eq(early.payPeriods.filter(row => !(row.start <= earlyDate && row.end >= earlyDate))
  .map(row => cents(row.stage3.result.amount)),
  traj.payPeriods.filter(row => !(row.start <= earlyDate && row.end >= earlyDate))
  .map(row => cents(row.stage3.result.amount)),
  'pay periods that do not contain the purchase keep their Stage 3 result');
const timed = early.months.find(row => row.month === month.month);
const gap = timed.stage2.dateOrderResult.unavailableByDueDate;
eq(!!gap, true, 'a purchase before the closes publishes a timing amount');
eq(gap.identity, 'date-order-unavailable-by-due-date', 'timing amount is Forecast-owned');
eq(cents(gap.amount), cents(timed.stage2.dateOrderResult.amount)
  - (cents(timed.stage1.result.amount) - cents(timed.stage2.commitments.amount)),
  'timing amount is the exact date-order gap');
eq(cents(timed.stage2.dateOrderResult.amount) === cents(timed.stage1.result.amount) - cents(timed.stage2.commitments.amount),
  false, 'date-order result is not the blind subtraction');



const pay = traj.payPeriods[0];

const negative = JSON.parse(JSON.stringify(traj));
const negativeMonth = negative.months.find(row => row.month === month.month);
negativeMonth.stage1.result = Object.assign({}, negativeMonth.stage1.result, { amount: -25 });
negativeMonth.stage1.result = Object.assign({}, negativeMonth.stage1.result, { amount: 0 });

console.log('Road Ahead month reconciliation: ' + checks + ' assertions passed.');
