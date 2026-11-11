'use strict';
/* Financial Trajectory — Stage 1 income named lines.
 *
 * Forecast.baselineTrajectory stage1.income keeps the incumbent rollup
 * amount and publishes attributable Dale / Amanda / remaining lines from
 * the same span income events. Planning reprints those lines and does
 * not invent splits. Independent of the publisher: expandEvents sums by
 * fixture-known stream ids.
 * `node test/test-baseline-trajectory-income-lines.js`
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
const read = file => sourceText(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const liveHash = hashFile(DATA);
const START = '2026-08-19';
const SEP = '2026-09';
const DALE_IDS = new Set(['payroll', 'payrollBonus']);
const AMANDA_IDS = new Set(['amandaSalary15', 'amandaSalaryMonthEnd']);
const DALE_LABEL = 'Dale — Seaspan payroll';
const AMANDA_LABEL = 'Amanda — Tennis BC salary';

function roundCent(n) {
  return Math.round(n * 100) / 100;
}

function periodsFixture() {
  return {
    periods: {
      ytd: {
        label: 'YTD fixture',
        months: 1,
        spending: [
          { label: 'Groceries', total: 50000 },
          { label: 'Travel', total: 18000 },
          { label: 'Phone', total: 9000 },
        ],
      },
    },
  };
}

function liveLikeIncome(extra) {
  return [
    {
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-08-14',
      amount: 2000, confidence: 'estimated',
    },
    {
      id: 'childBenefit', label: 'Child benefit',
      frequency: 'monthly', day: 20,
      amount: 150, confidence: 'confirmed',
    },
    {
      id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
      frequency: 'monthly', day: 15,
      amount: 1000, confidence: 'confirmed',
    },
    {
      id: 'amandaSalaryMonthEnd', label: 'Amanda salary — Tennis BC — month end',
      frequency: 'monthly', day: 31,
      amount: 1100, confidence: 'confirmed',
    },
  ].concat(extra || []);
}

function fixture(extraPlan) {
  const plan = Object.assign({
    windowDays: 91,
    startingCash: { amount: 8000 },
    defaults: { targetBuffer: 200, extraDebtMonthly: 0, scenario: 'expected' },
    opening: { asOf: START },
    nextDollar: {
      policy: 'true-surplus-highest-interest',
      provenance: 'owner-stated',
    },
    budget: {
      basis: 'ytd',
      categories: [{
        id: 'groceries', label: 'Groceries', class: 'essential',
        from: ['Groceries'], plannedWeekly: 140,
      }],
    },
    income: liveLikeIncome(),
    obligations: [],
    bills: [],
    commitments: [],
  }, extraPlan || {});
  const debts = [];
  return { plan, debts };
}

function ask(plan, debts) {
  return F.baselineTrajectory(plan, debts, START, { periods: periodsFixture() });
}

function independentSpanIncome(plan, span) {
  const events = F.expandEvents(plan, span.start, span.end)
    .filter(e => e && e.kind === 'income'
      && e.date >= span.start && e.date <= span.end);
  const sumIds = ids => roundCent(events
    .filter(e => ids.has(e.id))
    .reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const dale = sumIds(DALE_IDS);
  const amanda = sumIds(AMANDA_IDS);
  const total = roundCent(events.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const other = roundCent(total - dale - amanda);
  const byId = new Map();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, 0);
    byId.set(event.id, roundCent(byId.get(event.id) + (Number(event.amount) || 0)));
  }
  return { events, dale, amanda, other, total, byId };
}

function lineByLabel(lines, label) {
  return (lines || []).find(row => row && row.label === label) || null;
}

function lineSum(lines) {
  return roundCent((lines || []).reduce((s, row) => s + (Number(row.amount) || 0), 0));
}

function weaker(events) {
  if (!events.length) return null;
  return events.some(e => e.confidence !== 'confirmed') ? 'estimated' : 'calculated';
}

console.log('=== 1. Publisher is Forecast-owned and unexported ===');
{
  const src = read('public/forecast.js');
  const helper = src.slice(
    src.indexOf('function isCoachingOrGravyIncome('),
    src.indexOf('function baselineTrajectoryWalkVariableDays('));
  ok(/function baselineTrajectoryIncomeLines\(/.test(src),
    'named income lines live inside public/forecast.js');
  ok(typeof F.baselineTrajectoryIncomeLines !== 'function'
    && typeof F.baselineTrajectoryMonthFunding !== 'function',
    'the income-line helper is not a second exported engine');
  ok(/isDalePayrollStream\(/.test(helper) && /isAmandaSalaryStream\(/.test(helper)
    && /incomeStreamFor\(/.test(helper),
    'lines group span income via incomeStreamFor plus Dale/Amanda helpers');
  ok(/coach\|gravy/.test(helper) && /isCoachingOrGravyIncome\(/.test(helper),
    'coaching/gravy is excluded from Dale and Amanda salary lines');
  ok(/Dale — Seaspan payroll/.test(helper)
    && /Amanda — Tennis BC salary/.test(helper),
    'published labels are the attributable Dale and Amanda names');
  const funding = src.slice(
    src.indexOf('function baselineTrajectoryMonthFunding('),
    src.indexOf('function baselineTrajectorySpanPicture('));
  ok(/incomeComponent\(incomeAmount, incomeStatus\)/.test(funding)
    && /row\.lines = lines/.test(funding),
    'MonthFunding attaches income lines via incomeComponent');
  ok(!/bills: incomeComponent/.test(funding)
    && /baselineTrajectoryEventLines\(bills/.test(funding)
    && !/isDalePayrollStream/.test(funding.slice(funding.indexOf('bills:'))),
    'bills do not reuse the Dale/Amanda income splitter');
}

console.log('\n=== 2. Live-like September: Dale + Amanda + child benefit ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  ok(traj.status === 'ready', 'live-like trajectory is ready');
  const sep = traj.months.find(m => m.month === SEP);
  ok(sep && sep.income.status !== 'unavailable' && sep.stage1 && sep.stage1.income,
    'September 2026 publishes Stage 1 income');
  const expected = independentSpanIncome(plan, sep);
  const income = sep.stage1.income;
  const lines = income.lines || [];
  ok(near(income.amount, expected.total) && near(sep.income.amount, expected.total),
    'Stage 1 income rollup still matches independent expandEvents income',
    `${income.amount} vs ${expected.total}`);
  ok(expected.dale > 0 && expected.amanda > 0 && expected.other > 0,
    'independent September includes Dale, Amanda, and remaining income',
    `dale ${expected.dale} amanda ${expected.amanda} other ${expected.other}`);
  const dale = lineByLabel(lines, DALE_LABEL);
  const amanda = lineByLabel(lines, AMANDA_LABEL);
  const child = lineByLabel(lines, 'Child benefit');
  ok(dale && near(dale.amount, expected.dale),
    'Dale line matches independent Seaspan payroll event sum',
    dale ? String(dale.amount) : 'missing');
  ok(amanda && near(amanda.amount, expected.amanda),
    'Amanda line matches independent Tennis BC salary event sum',
    amanda ? String(amanda.amount) : 'missing');
  ok(child && near(child.amount, expected.byId.get('childBenefit') || 0),
    'child benefit is published as its own remaining line, not dropped',
    child ? String(child.amount) : 'missing');
  ok(near(lineSum(lines), income.amount),
    'sum(lines) reconciles to stage1.income.amount',
    `${lineSum(lines)} vs ${income.amount}`);
  ok(dale.status === 'estimated' && weaker(expected.events.filter(e => DALE_IDS.has(e.id))) === 'estimated',
    'Dale line trust follows weaker event confidence (estimated payroll)');
  ok(amanda.status === 'calculated'
    && weaker(expected.events.filter(e => AMANDA_IDS.has(e.id))) === 'calculated',
    'Amanda line stays calculated when Tennis BC salary events are confirmed');
  ok(income.status === 'estimated',
    'rollup stays estimated when any contributing event is estimated — not promoted');
  ok(!lines.some(row => /coach|gravy/i.test(row.label || '')),
    'live-like September does not publish a coaching/gravy salary line');
}

console.log('\n=== 3. Absent Amanda streams do not invent an Amanda line ===');
{
  const { plan, debts } = fixture({
    income: liveLikeIncome().filter(s => !AMANDA_IDS.has(s.id)),
  });
  const traj = ask(plan, debts);
  const sep = traj.months.find(m => m.month === SEP);
  const expected = independentSpanIncome(plan, sep);
  const lines = sep.stage1.income.lines || [];
  ok(expected.amanda === 0 && expected.dale > 0,
    'independent September has Dale and no Amanda salary events');
  ok(lineByLabel(lines, DALE_LABEL) && near(lineByLabel(lines, DALE_LABEL).amount, expected.dale),
    'Dale line remains when Amanda streams are absent');
  ok(!lineByLabel(lines, AMANDA_LABEL)
    && !lines.some(row => /Amanda/i.test(row.label || '')),
    'no Amanda salary line is invented without Amanda streams');
  ok(lineByLabel(lines, 'Child benefit'),
    'child benefit remaining line is still published');
  ok(near(lineSum(lines), sep.stage1.income.amount)
    && near(sep.stage1.income.amount, expected.total),
    'absent-Amanda sum(lines) still reconciles to the rollup');
}

console.log('\n=== 4. Coaching/gravy is not a Dale or Amanda salary line ===');
{
  const { plan, debts } = fixture({
    income: liveLikeIncome([
      {
        id: 'tennisCoaching', label: 'Tennis BC coaching leftover',
        frequency: 'once', date: '2026-09-08',
        amount: 500, confidence: 'estimated',
      },
      {
        id: 'gravy', label: 'Seasonal coaching gravy',
        frequency: 'once', date: '2026-09-09',
        amount: 80, confidence: 'estimated',
      },
    ]),
  });
  const traj = ask(plan, debts);
  const sep = traj.months.find(m => m.month === SEP);
  const expected = independentSpanIncome(plan, sep);
  const lines = sep.stage1.income.lines || [];
  const dale = lineByLabel(lines, DALE_LABEL);
  const amanda = lineByLabel(lines, AMANDA_LABEL);
  ok(expected.byId.get('tennisCoaching') === 500 && expected.byId.get('gravy') === 80,
    'independent expandEvents still emits the coaching/gravy amounts when they are on plan.income');
  ok(dale && near(dale.amount, expected.dale),
    'Dale line is still only Seaspan payroll, not coaching');
  ok(amanda && near(amanda.amount, expected.amanda),
    'Amanda line is still only Tennis BC salary ids, not Tennis BC coaching leftover',
    amanda ? `${amanda.amount} vs ${expected.amanda}` : 'missing');
  ok(!lines.some(row => /coach|gravy/i.test(row.label || '')),
    'coaching/gravy is not published under a coaching or gravy salary label');
  const other = lineByLabel(lines, 'Other income');
  ok(other && near(other.amount, 580),
    'coaching/gravy remaining is an explicit Other income line so the rollup still reconciles',
    other ? String(other.amount) : 'missing');
  ok(near(lineSum(lines), sep.stage1.income.amount)
    && near(sep.stage1.income.amount, expected.total),
    'coaching dollars stay in the income total and in sum(lines)');
}

console.log('\n=== 5. Pay-period Stage 1 income uses the same named lines ===');
{
  const { plan, debts } = fixture();
  const traj = ask(plan, debts);
  const period = (traj.payPeriods || []).find(p =>
    p && p.start <= '2026-09-15' && p.end >= '2026-09-15');
  ok(period && period.stage1 && period.stage1.income
    && period.stage1.income.status !== 'unavailable',
    'the Seaspan pay-period containing 15 Sep publishes Stage 1 income');
  const expected = independentSpanIncome(plan, period);
  const lines = period.stage1.income.lines || [];
  const dale = lineByLabel(lines, DALE_LABEL);
  const amanda = lineByLabel(lines, AMANDA_LABEL);
  ok(expected.dale > 0 && dale && near(dale.amount, expected.dale),
    'pay-period Dale line matches independent Seaspan events in that span',
    dale ? `${dale.amount} vs ${expected.dale}` : 'missing');
  ok(expected.amanda > 0 && amanda && near(amanda.amount, expected.amanda),
    'pay-period Amanda line matches independent Tennis BC events in that span',
    amanda ? `${amanda.amount} vs ${expected.amanda}` : 'missing');
  ok(near(lineSum(lines), period.stage1.income.amount)
    && near(period.stage1.income.amount, expected.total),
    'pay-period sum(lines) reconciles to stage1.income.amount');
  ok(!lineByLabel(lines, AMANDA_LABEL) || expected.byId.get('amandaSalaryMonthEnd') == null
    || expected.byId.get('amandaSalaryMonthEnd') === 0,
    'month-end Tennis BC is not invented into a mid-September pay-period');
}

console.log('\n=== 6. Live household September reconciles by canonical ids, not copied cents ===');
{
  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  ok(hashFile(DATA) === liveHash, 'live data.json was not written');
  const traj = F.baselineTrajectory(live.plan, live.debts, live.meta.asOf, {
    periods: live.periods || periodsFixture(),
    extraFacilities: live.revolvingExtra,
  });
  const sep = (traj.months || []).find(m => m.month === SEP);
  ok(traj.status === 'ready' && sep && sep.stage1 && sep.stage1.income
    && sep.stage1.income.amount != null,
    'live September Stage 1 income is published');
  const expected = independentSpanIncome(live.plan, sep);
  const lines = sep.stage1.income.lines || [];
  const dale = lineByLabel(lines, DALE_LABEL);
  const amanda = lineByLabel(lines, AMANDA_LABEL);
  ok(expected.dale > 0 && dale && near(dale.amount, expected.dale),
    'live Dale line matches independent payroll id sum for September');
  ok(expected.amanda > 0 && amanda && near(amanda.amount, expected.amanda),
    'live Amanda line matches independent Tennis BC salary id sum for September');
  const childAmt = expected.byId.get('childBenefit') || 0;
  if (childAmt > 0) {
    const child = lineByLabel(lines, 'Child benefit');
    ok(child && near(child.amount, childAmt),
      'live child benefit remains a published remaining line');
  }
  ok(near(lineSum(lines), sep.stage1.income.amount)
    && near(sep.stage1.income.amount, expected.total),
    'live September sum(lines) equals rollup and independent income total');
  ok(!lines.some(row => /coach|gravy/i.test(row.label || '')),
    'live September does not publish coaching/gravy as a salary line');
}

console.log('\n=== 7. Unavailable stages still omit income lines rather than $0 ===');
{
  const { plan, debts } = fixture({
    income: [{
      id: 'payroll', label: 'Payroll — Seaspan',
      frequency: 'biweekly', anchor: '2026-08-14',
      amount: 2000, confidence: 'estimated',
    }],
  });
  const traj = ask(plan, debts);
  const jan = traj.months.find(m => m.month === '2027-01');
  ok(jan && jan.stage1 && jan.stage1.status === 'unavailable',
    'synthetic Seaspan without 2027 assumptions still withholds January 2027');
  ok(jan.stage1.income == null,
    'unavailable Stage 1 does not invent Dale/Amanda income lines at $0');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll stage1 income named-line checks passed.');
