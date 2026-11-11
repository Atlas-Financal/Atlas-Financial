'use strict';

// Render the production Budget composer against synthetic published fields.
// Deliberately different detail sums prove the page cannot reconstruct totals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const F = require('../public/forecast');
const { sourceText } = require('./test-source-text');

const root = process.env.ATLAS_TEST_APP_ROOT || path.join(__dirname, '..');
const source = sourceText(fs.readFileSync(path.join(root, 'public/plan.js'), 'utf8'));
const state = { scenario: null, targetBuffer: 0, extraDebtMonthly: 0,
  incomeOverrides: {}, disabled: [], debts: [], extraDebtTarget: null, extraFacilities: null };
const f = vm.createContext({ escapeHtml: require('./app-escape-html'), Forecast: F, state,
  money2: value => '$' + Number(value).toFixed(2),
  fmtDate: value => value, fmtDateLong: value => value });
vm.runInContext(source, f);

function period(id, start, end, role) {
  const label = date => new Date(date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  return {
    id, start, end, rangeLabel: `${label(start)} – ${label(end)}`, timelineRole: role,
    role: role === 'current' ? 'active' : role === 'past' ? 'lookback' : 'future',
    projected: role !== 'current' && role !== 'past', openingKnown: true, opening: 600,
    available: 1800, periodBillLoad: 300, afterBills: 1500, budgetHold: 200,
    incomeTrust: 'calculated', periodBillLoadTrust: 'calculated', afterBillsTrust: 'calculated',
    budgetHoldTrust: 'calculated', balanceAfterDeductionsTrust: 'calculated',
    predictedEndingBalance: 1300, totalBillsThisPeriod: 390, paidBills: 90, remainingBills: 300,
    income: [{ id: 'payroll', incomeClass: 'dale', label: 'Salary', amount: 999,
      date: start, status: 'received' }],
    otherIncome: { amount: 0, items: [] },
    bills: [{ id: 'required', label: 'Required payment', amount: -123, movement: -123,
      date: end, status: role === 'current' ? 'still due' : 'planned' }],
    householdBudget: [{ id: 'groceries', label: 'Groceries', planned: 301, spent: 40, remaining: 261 }],
  };
}
const rows = [period('past', '2026-09-11', '2026-09-24', 'past'),
  period('current', '2026-09-25', '2026-10-08', 'current'),
  period('next', '2026-10-09', '2026-10-22', 'next'),
  period('nov', '2026-10-23', '2026-11-05', 'future'),
  period('dec', '2026-12-18', '2026-12-31', 'future'),
  period('jan', '2027-01-01', '2027-01-14', 'future')];
const plan = { defaults: { targetBuffer: 0 }, opening: { asOf: '2026-09-30' },
  startingCash: { amount: 777 }, income: [], bills: [], obligations: [], commitments: [],
  budget: { categories: [] } };
const advice = { defaultView: { asOf: '2026-09-30', liveCurrentBalance: 777 },
  payPeriodViews: rows, paydayAllocation: { available: 777, liveCurrentBalance: 777,
    asOf: '2026-09-30', lines: [], obligations: { shortfall: 0 }, essentials: { shortfall: 0 } } };
const ctx = { advice, plan, asOf: '2026-09-30', weekly: 0, debts: [] };
const before = JSON.stringify(ctx);
const html = f.operatingSurfaceHtml(ctx);
assert.ok(html.indexOf('data-live-current-balance') < html.indexOf('data-pay-period-navigator'));
assert.ok(html.indexOf('data-live-current-balance') < html.indexOf('data-current-payday-details'));
assert.match(html, /Bills account only/);
assert.equal((html.match(/class="budget-step-details"/g) || []).length, 6);
assert.doesNotMatch(html, /<details class="budget-step-details"[^>]* open/);
assert.match(html, /data-budget-more-views/);
assert.ok(html.indexOf('data-current-payday-details') > html.indexOf('data-calendar-waterfall='));

const summary = (markup, number) => markup.split(`data-operating-question="${number}"`)[1].split('</summary>')[0];
for (const [id, amount] of [['02', 1800], ['04', 300], ['05', 1500], ['06', 200], ['07', 1300]]) {
  assert.match(summary(html, id), new RegExp(`\\$${amount}\\.00`));
}
assert.doesNotMatch(summary(html, '02'), /777\.00|999\.00/);
assert.doesNotMatch(summary(html, '04'), /123\.00|390\.00/);
assert.doesNotMatch(summary(html, '06'), /301\.00/);
assert.match(html, /datetime="2026-09-25">2026-09-25 · received/);
assert.doesNotMatch(html, /not permission to spend/);

for (const amount of [undefined, null, false, '', '1800', NaN, Infinity]) {
  const p = Object.assign({}, rows[1], { available: amount });
  const unknown = f.calendarWaterfallHtml(p, null, null, plan);
  assert.match(summary(unknown, '02'), /Unavailable/);
  assert.doesNotMatch(summary(unknown, '02'), /\$0\.00/);
  assert.match(unknown, /Unavailable\./);
  assert.doesNotMatch(unknown, /Forecast did not publish a valid total/);
}
const zero = f.calendarWaterfallHtml(Object.assign({}, rows[1], { available: 0 }), null, null, plan);
assert.match(summary(zero, '02'), /\$0\.00/);
assert.match(summary(zero, '02'), /is-noscale/);
assert.doesNotMatch(summary(zero, '02'), /is-unknown|is-deficit|style="left:/);
const estimated = f.calendarWaterfallHtml(Object.assign({}, rows[2], {
  budgetHoldTrust: 'estimated', balanceAfterDeductionsTrust: 'estimated' }), null, null, plan);
assert.match(summary(estimated, '06'), /≈ estimated/);
assert.match(summary(estimated, '07'), /≈ estimated/);
for (const trust of ['unavailable', 'unknown']) {
  const withheld = f.calendarWaterfallHtml(Object.assign({}, rows[1], {
    budgetHoldTrust: trust, balanceAfterDeductionsTrust: trust }), null, null, plan);
  assert.match(summary(withheld, '06'), /Unavailable/);
  assert.match(summary(withheld, '07'), /Unavailable/);
}
const unavailable = f.calendarWaterfallHtml(Object.assign({}, rows[1], { operatingPlanUnavailable: true }), null, null, plan);
assert.doesNotMatch(unavailable, /class="budget-step-details"/);
assert.match(unavailable, /data-current-waterfall="unavailable"/);

const deficitInputs = require('./fixtures/budget-layout-data')();
deficitInputs.meta.asOf = deficitInputs.plan.opening.asOf = '2026-08-20';
deficitInputs.plan.income[0].amount = 3100;
deficitInputs.plan.income[0].confidence = 'estimated';
deficitInputs.plan.bills[0].amount = 5000;
const deficitPeriod = F.recommend(deficitInputs.plan, deficitInputs.meta.asOf, { debts: [] })
  .payPeriodViews.find(p => p.start === '2026-08-28');
assert.ok(deficitPeriod);
// Independently invented income, levy, hydro and grocery target. No copied
// household payroll policy amount enters this new deficit regression.
const independentIncome = 3100;
const independentBills = 5000 + 199;
const independentHold = 100;
assert.equal(deficitPeriod.available, independentIncome);
assert.equal(deficitPeriod.periodBillLoad, independentBills);
assert.equal(deficitPeriod.afterBills, Math.round((independentIncome - independentBills) * 100) / 100);
assert.equal(deficitPeriod.afterHouseholdBudget,
  Math.round((independentIncome - independentBills - independentHold) * 100) / 100);
assert.ok(deficitPeriod.afterBills < 0 && deficitPeriod.afterHouseholdBudget < 0);
const deficitHtml = f.calendarWaterfallHtml(deficitPeriod, null, null, deficitInputs.plan);
assert.match(summary(deficitHtml, '06'), /is-deficit/);
assert.doesNotMatch(summary(deficitHtml, '06'), /is-unknown/);
assert.match(summary(deficitHtml, '07'), /is-deficit/);
assert.doesNotMatch(summary(deficitHtml, '07'), /is-unknown/);
assert.match(summary(deficitHtml, '07'), /\$\-2199\.00/);
assert.match(summary(deficitHtml, '07'), /≈ estimated/);
assert.match(summary(deficitHtml, 'savings'), /is-unknown/);
assert.doesNotMatch(summary(deficitHtml, 'savings'), /is-deficit|style="left:/);

const zeroInputs = require('./fixtures/budget-surface-data').canonical();
zeroInputs.plan.income.forEach(row => { row.amount = 0; });
const zeroPeriod = F.recommend(zeroInputs.plan, '2026-08-20', { debts: zeroInputs.debts || [] })
  .payPeriodViews.find(p => p.start === '2026-08-14');
assert.ok(zeroPeriod);
// Independent fixture arithmetic: both scheduled amounts stay 0; bills and
// household targets are the canonical invented figures, not Forecast leftovers.
const zeroIncome = 0;
const zeroBills = 1400 + 120 + 60 + 85;
const zeroHold = 450 + 160 + 120;
assert.equal(zeroPeriod.available, zeroIncome);
assert.equal(zeroPeriod.incomeTrust, 'calculated');
assert.equal(zeroPeriod.periodBillLoad, zeroBills);
assert.equal(zeroPeriod.afterBills, zeroIncome - zeroBills);
assert.equal(zeroPeriod.budgetHold, zeroHold);
assert.equal(zeroPeriod.afterHouseholdBudget, zeroIncome - zeroBills - zeroHold);
assert.equal(zeroPeriod.balanceAfterDeductions, -2395);
assert.equal(zeroPeriod.balanceAfterDeductionsTrust, 'estimated');
const zeroHtml = f.calendarWaterfallHtml(zeroPeriod, null, null, zeroInputs.plan);
assert.match(summary(zeroHtml, '02'), /\$0\.00/);
assert.match(summary(zeroHtml, '02'), /is-noscale/);
assert.doesNotMatch(summary(zeroHtml, '02'), /is-unknown|is-deficit|style="left:/);
assert.match(summary(zeroHtml, '04'), /is-deficit/);
assert.doesNotMatch(summary(zeroHtml, '04'), /is-unknown|style="left:/);
assert.match(summary(zeroHtml, '05'), /is-deficit/);
assert.match(summary(zeroHtml, '05'), /\$\-1665\.00/);
assert.doesNotMatch(summary(zeroHtml, '05'), /is-unknown|style="left:/);
assert.match(summary(zeroHtml, '06'), /is-deficit/);
assert.doesNotMatch(summary(zeroHtml, '06'), /is-unknown|style="left:/);
assert.match(summary(zeroHtml, '07'), /is-deficit/);
assert.match(summary(zeroHtml, '07'), /\$\-2395\.00/);
assert.match(summary(zeroHtml, '07'), /≈ estimated/);
assert.doesNotMatch(summary(zeroHtml, '07'), /is-unknown|style="left:/);
assert.match(summary(zeroHtml, 'savings'), /is-unknown/);
assert.doesNotMatch(summary(zeroHtml, 'savings'), /is-deficit|is-noscale|style="left:/);

// Exercise the incumbent 2027 payroll regime, rather than stamping a mock row.
const financialData = require('./fixtures/budget-layout-data')();
const financialAdvice = F.recommend(financialData.plan, financialData.meta.asOf, { debts: [] });
const projected = financialAdvice.payPeriodViews.find(p => p.start === '2027-01-01');
assert.equal(projected.income[0].incomeRegime, '2027-estimated');
assert.equal(projected.incomeTotal, 3849.40);
assert.equal(projected.periodBillLoad, 1600 + 199);
assert.equal(projected.afterBills, 2050.40);
assert.equal(projected.balanceAfterDeductions, 1950.40);
const projectedHtml = f.calendarWaterfallHtml(projected, null, null, financialData.plan);
for (const id of ['02', '05', '07']) {
  assert.match(summary(projectedHtml, id), /≈ estimated/,
    `collapsed ${id} must disclose the Forecast payroll estimate`);
}
assert.doesNotMatch(summary(projectedHtml, '04'), /≈ estimated/);
const estimatedBillData = require('./fixtures/budget-layout-data')();
estimatedBillData.plan.bills[1].confidence = 'estimated';
estimatedBillData.plan.opening.asOf = '2026-11-20';
// Use a period containing that bill while retaining confirmed 2026 income.
const billPeriod = F.recommend(estimatedBillData.plan, '2026-11-20', { debts: [] })
  .payPeriodViews.find(p => p.start === '2026-11-20');
assert.ok(billPeriod);
const billHtml = f.calendarWaterfallHtml(billPeriod, null, null, estimatedBillData.plan);
assert.match(summary(billHtml, '04'), /≈ estimated/);
assert.match(summary(billHtml, '05'), /≈ estimated/);
assert.match(summary(billHtml, '07'), /≈ estimated/);
assert.doesNotMatch(summary(billHtml, '02'), /≈ estimated/);
assert.equal(billPeriod.periodBillLoad, 1799);
assert.equal(billPeriod.afterBills, 2465);
for (const trust of [undefined, null, 'unknown', 'unavailable', 'verified', 'nonsense']) {
  const withheld = f.calendarWaterfallHtml(Object.assign({}, rows[1], {
    incomeTrust: trust, periodBillLoadTrust: trust, afterBillsTrust: trust }), null, null, plan);
  for (const id of ['02', '04', '05']) assert.match(summary(withheld, id), /Unavailable/);
}
const unknownInputs = require('./fixtures/budget-layout-data')();
unknownInputs.plan.bills[1].confidence = 'unknown';
const unknownPeriod = F.recommend(unknownInputs.plan, unknownInputs.meta.asOf, { debts: [] })
  .payPeriodViews.find(p => p.start === '2027-01-01');
assert.equal(unknownPeriod.periodBillLoadTrust, 'unavailable');
assert.equal(unknownPeriod.afterBillsTrust, 'unavailable');
assert.equal(unknownPeriod.balanceAfterDeductionsTrust, 'unavailable');
const unknownHtml = f.calendarWaterfallHtml(unknownPeriod, null, null, unknownInputs.plan);
for (const id of ['04', '05', '07']) assert.match(summary(unknownHtml, id), /Unavailable/);
const missingConfidence = require('./fixtures/budget-layout-data')();
delete missingConfidence.plan.bills[1].confidence;
assert.equal(F.recommend(missingConfidence.plan, missingConfidence.meta.asOf, { debts: [] })
  .payPeriodViews.find(p => p.start === '2027-01-01').periodBillLoadTrust, 'estimated');

// Deliberately inconsistent item sums prove this renderer only reprints the
// Forecast totals. No second contribution/final-balance calculator lives here.
const funding = { status: 'ready', start: rows[1].start, end: rows[1].end, trust: 'estimated',
  contribution: 123.45, afterProposedFunding: 456.78, proposedFundingForBillPayments: 0,
  items: [{ id: 'cost', label: '<Named cost>', contribution: 99, cumulativeProposed: 101,
    cost: 600, remainingGap: 499, confidence: 'confirmed', date: '2026-10-08' }] };
const fundedHtml = f.calendarWaterfallHtml(Object.assign({}, rows[1], { plannedCostFunding: funding }), null, null, plan);
assert.match(summary(fundedHtml, 'savings'), /\$123\.45/);
assert.match(summary(fundedHtml, 'savings'), /≈ estimated/);
assert.match(summary(fundedHtml, '07'), /\$456\.78/);
assert.doesNotMatch(summary(fundedHtml, '07'), /1300\.00|1176\.55/);
assert.match(fundedHtml, /&lt;Named cost&gt;/);
assert.match(fundedHtml, /Actual saved: unavailable/);
for (const patch of [{ contribution: '123.45' }, { contribution: null }, { trust: null },
  { trust: 'unknown' }, { end: '2026-10-09' }, { afterProposedFunding: '456.78' }]) {
  const html = f.calendarWaterfallHtml(Object.assign({}, rows[1], {
    plannedCostFunding: Object.assign({}, funding, patch) }), null, null, plan);
  assert.match(summary(html, 'savings'), /Unavailable/);
  assert.match(summary(html, '07'), /Before savings/);
  assert.doesNotMatch(html, /\$123\.45|\$456\.78/);
  assert.match(html, /&lt;Named cost&gt;/);
}
const withConsumption = f.calendarWaterfallHtml(Object.assign({}, rows[1], {
  plannedCostFunding: Object.assign({}, funding, { proposedFundingForBillPayments: 600 }) }), null, null, plan);
assert.match(summary(withConsumption, 'reserve-use'), /\$600\.00/);
assert.match(summary(withConsumption, "reserve-use"), /Earlier proposed funding for bills/);
assert.doesNotMatch(withConsumption, /not extra income, observed saved cash or an actual withdrawal/);

for (const bucket of ['obligations', 'essentials']) {
  const short = JSON.parse(JSON.stringify(ctx));
  short.advice.paydayAllocation[bucket].shortfall = 50;
  const original = JSON.stringify(short);
  const printed = f.operatingSurfaceHtml(short);
  assert.doesNotMatch(printed, /<details[^>]*data-current-payday-details[^>]*\bopen\b/);
  assert.match(printed, /data-current-payday-details data-shortfall-reported/);
  assert.match(printed, /<summary>Current payday details<span class="budget-shortfall-summary"> — shortfall reported<\/span><\/summary>/);
  assert.equal(JSON.stringify(short), original, 'the closed warning must not mutate Forecast output');
}
assert.doesNotMatch(f.operatingSurfaceHtml(ctx), /data-shortfall-reported|budget-shortfall-summary/);
const year = f.payPeriodNavigatorHtml(f.payPeriodSelection(advice, 'jan'));
assert.match(year, /Jan 1, 2027 – Jan 14, 2027/);
assert.equal(JSON.stringify(ctx), before, 'rendering must not mutate published data');
console.log('PASS stepped Budget layout: publication identity, unavailable values, trust, disclosures and dates');

module.exports = { ctx, rows, source, state, html };
