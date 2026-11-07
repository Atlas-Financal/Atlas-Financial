'use strict';
/* Live cash dates are not settlement evidence. All amounts below are
 * synthetic; expected totals are direct fixture arithmetic, never a
 * second call to Forecast or a copy of its row-selection algorithm.
 * Run: node test/test-payday-settlement-boundary.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast');
const { sourceText } = require('./test-source-text');

let failures = 0;
let checks = 0;
function ok(condition, label) {
  checks++;
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}`);
}
const near = (actual, expected) => actual != null && Math.abs(actual - expected) < 0.005;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const PAYDAY = '2027-01-08';
const PRIOR = '2027-01-01';
const LIVE = '2027-01-12';
const OPENING = 600;
const PAYROLL = 2000;
const PAST_SALARY = 700;
const FUTURE_SALARY = 800;
const BILL_A = 40;
const BILL_B = 60;
const BUDGET = 250;
const LOAD = BILL_A + BILL_B;
const PROVEN_AVAILABLE = PAYROLL + PAST_SALARY + FUTURE_SALARY;
const PROVEN_AFTER_BUDGET = PROVEN_AVAILABLE - LOAD - BUDGET;

function fixture(asOf = LIVE, represented = []) {
  return {
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 1200 },
    opening: {
      asOf, priorAsOf: PRIOR,
      paydaySnapshot: { periodStart: PAYDAY, asOf: PAYDAY, opening: OPENING },
      representedEvents: [{ id: 'payroll', date: PAYDAY }].concat(represented),
      notReliedUponEvents: [],
    },
    income: [
      { id: 'payroll', label: 'Payroll', frequency: 'biweekly', anchor: PAYDAY, amount: PAYROLL },
      { id: 'past-salary', label: 'Earlier salary', frequency: 'monthly', day: 10, amount: PAST_SALARY },
      { id: 'future-salary', label: 'Later salary', frequency: 'monthly', day: 20, amount: FUTURE_SALARY },
    ],
    bills: [
      { id: 'bill-a', label: 'Bill A', frequency: 'monthly', day: 9, amount: BILL_A },
      { id: 'bill-b', label: 'Bill B', frequency: 'monthly', day: 11, amount: BILL_B },
    ],
    obligations: [], commitments: [],
    budget: { categories: [{ id: 'groceries', label: 'Groceries', class: 'essential', plannedPayday: BUDGET }] },
  };
}
function active(plan) {
  const advice = F.recommend(plan, plan.opening.asOf, { debts: [], targetBuffer: 0 });
  return advice.defaultView.calendarPeriods.find(p => p.role === 'active');
}
const income = (period, id) => period.income.find(row => row.id === id);
const bill = (period, id) => period.bills.find(row => row.id === id);

// Execute the actual public page composers, as existing payday tests do.
// No duplicate renderer or renderer financial arithmetic is introduced.
function loadComposer() {
  const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  const app = read('public/app.js');
  const plan = read('public/plan.js');
  function grab(source, expression) {
    const match = expression.exec(source);
    if (!match) throw new Error(`Missing page dependency: ${expression}`);
    return match[0];
  }
  const functions = [
    'glanceSignedMoney', 'glanceMoney', 'glanceLineLabel', 'periodBillLine',
    'calendarCurrentUnavailableHtml', 'calendarIncomeHtml', 'calendarPeriodBillsHtml',
    'runningLeftoverHtml',
  ];
  const source = ['money', 'money2', 'escapeHtml', 'fmtDate'].map(name =>
    grab(app, new RegExp(`^const ${name} = .*$`, 'm'))
  ).concat(functions.map(name =>
    grab(plan, new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))
  )).join('\n');
  return vm.runInNewContext(`${source}\n({ calendarIncomeHtml, calendarPeriodBillsHtml, runningLeftoverHtml, money2 });`, { Forecast: F });
}

console.log('=== Live advancement cannot manufacture settlement ===');
const unverified = active(fixture());
for (const id of ['bill-a', 'bill-b']) {
  const row = bill(unverified, id);
  ok(row && row.settlement === 'unverified' && row.status !== 'PAID' && row.actual === null,
    `${id}: passed due date without evidence remains unverified`);
}
const past = income(unverified, 'past-salary');
ok(past && past.settlement === 'not-relied-upon' && past.status === 'unresolved'
    && past.alreadyInCash === false && past.actual === null,
  'elapsed salary is unresolved, never received or assumed inside live cash');
ok(near(unverified.paidBills, 0) && near(unverified.remainingBills, LOAD),
  'no payment proof: paid $0, remaining $40 + $60 = $100');
ok(near(unverified.periodBillLoad, LOAD), 'frozen snapshot retains the $100 bill load');
ok(near(unverified.incomeAdded, PAYROLL + PAST_SALARY + FUTURE_SALARY)
    && near(unverified.available, PROVEN_AVAILABLE)
    && near(unverified.available, unverified.incomeTotal),
  'Payday balance is represented $2,000 + unproven $700 + future $800; PEB incomeAdded still includes the unproven period salary; opening cash is not added');
ok(near(unverified.afterBills, roundCent(
      (Number(unverified.incomeTotal) || 0) - LOAD))
    && near(unverified.afterHouseholdBudget, roundCent(unverified.afterBills - BUDGET))
    && near(unverified.afterHouseholdBudget, PROVEN_AFTER_BUDGET),
  'after bills and after budget are incomeTotal − periodBillLoad − hold');
const future = income(unverified, 'future-salary');
ok(future && future.status === 'arriving' && future.settlement === 'upcoming'
    && future.alreadyInCash === false && near(future.remaining, FUTURE_SALARY),
  'ordinary future salary remains forecast income before next payday');

console.log('\n=== The next day does not promote unresolved income ===');
const sameDayPlan = fixture('2027-01-10');
sameDayPlan.opening.notReliedUponEvents = [
  { id: 'past-salary', date: '2027-01-10', reason: 'same-day-inbound-unproven' },
];
const sameDay = active(sameDayPlan);
const nextDay = active(fixture('2027-01-11'));
ok(income(sameDay, 'past-salary').settlement === 'not-relied-upon',
  'same-day unproven salary retains the incumbent not-relied-upon state');
ok(income(nextDay, 'past-salary').settlement === 'not-relied-upon'
    && income(nextDay, 'past-salary').alreadyInCash === false,
  'advancing one day with no new identity cannot turn salary into received');
ok(near(sameDay.available, PROVEN_AVAILABLE) && near(nextDay.available, PROVEN_AVAILABLE)
    && near(nextDay.periodBillLoad, LOAD),
  'date advancement alone cannot raise available cash or release bills');

console.log('\n=== Exact settlement changes disclosure, not frozen bill assignment ===');
const represented = active(fixture(LIVE, [
  { id: 'past-salary', date: '2027-01-10' },
  { id: 'bill-a', date: '2027-01-09' },
  { id: 'bill-b', date: '2027-01-11' },
]));
ok(income(represented, 'past-salary').settlement === 'represented'
    && income(represented, 'past-salary').status === 'received',
  'exact represented income may be called received');
ok(['bill-a', 'bill-b'].every(id => bill(represented, id).settlement === 'represented'
    && bill(represented, id).status === 'PAID'), 'exact represented bills may be called PAID');
ok(near(represented.paidBills, LOAD) && near(represented.remainingBills, 0)
    && near(represented.periodBillLoad, LOAD),
  'all bills paid: disclosure changes, the frozen $100 bill load remains once');
ok(near(represented.available, PROVEN_AVAILABLE)
    && near(represented.afterHouseholdBudget, roundCent(
      (Number(represented.incomeTotal) || 0)
      - represented.periodBillLoad - BUDGET))
    && near(represented.afterHouseholdBudget, PROVEN_AFTER_BUDGET),
  'salary proof leftover is incomeTotal − periodBillLoad − BUDGET; Payday balance already included the $700');

console.log('\n=== Original dated opening remains a valid historical boundary ===');
const historical = fixture();
delete historical.opening.priorAsOf;
delete historical.opening.paydaySnapshot;
historical.opening.representedEvents = [];
const dated = active(historical);
ok(income(dated, 'past-salary').settlement === 'opening'
    && income(dated, 'past-salary').status === 'received',
  'ordinary pre-cutover income remains inside the original non-live opening');
ok(['bill-a', 'bill-b'].every(id => bill(dated, id).settlement === 'opening')
    && near(dated.periodBillLoad, 0), 'pre-cutover recurring bills are not replayed');
ok(near(dated.incomeAdded, FUTURE_SALARY)
    && near(dated.available, dated.incomeTotal),
  'incomeAdded adds only future $800; Payday balance is the displayed income identity');

console.log('\n=== firstDue reconstruction stays in the original opening month ===');
const gapPlan = fixture();
gapPlan.opening.priorAsOf = '2026-12-15';
gapPlan.obligations.push({ id: 'gap-minimum', label: 'Gap minimum', debtId: 'synthetic-card',
  effect: 'payment', frequency: 'monthly', day: 9, amount: 75, firstDue: '2027-02-09' });
gapPlan.income.push({ id: 'gap-income', label: 'Gap income', frequency: 'monthly',
  day: 10, amount: 90, firstDue: '2027-02-10' });
const gap = active(gapPlan);
ok(!bill(gap, 'gap-minimum'), 'live January does not invent a PAID minimum between December opening and February firstDue');
ok(!income(gap, 'gap-income'), 'live January does not invent received income before its February firstDue');
const originalMonth = JSON.parse(JSON.stringify(gapPlan));
delete originalMonth.opening.priorAsOf;
delete originalMonth.opening.paydaySnapshot;
const original = active(originalMonth);
ok(bill(original, 'gap-minimum') && bill(original, 'gap-minimum').settledInOpening === true,
  'a skipped minimum in the original January opening month retains its historical disclosure');
ok(income(original, 'gap-income') && income(original, 'gap-income').settlement === 'opening',
  'a skipped income occurrence preceding the original dated opening remains historical');

console.log('\n=== Actual Plan output preserves financial meaning ===');
const page = loadComposer();
const incomeHtml = page.calendarIncomeHtml(unverified);
const billsHtml = page.calendarPeriodBillsHtml(unverified);
ok(incomeHtml.includes('data-period-income="past-salary" data-income-status="not-relied-upon"')
    && incomeHtml.includes('not relied upon'), 'page prints elapsed salary as not relied upon');
ok(!incomeHtml.includes('data-period-income="past-salary" data-income-status="received"'),
  'page never labels unproven elapsed salary received');
ok(['bill-a', 'bill-b'].every(id => billsHtml.includes(`data-period-bill="${id}" data-bill-status="to confirm"`)),
  'page keeps both unverified bills to confirm without asserting confirmed unpaid');
ok(billsHtml.includes(`<span>Remaining bills to pay</span><span>${page.money2(LOAD)}</span>`),
  'page prints independently expected remaining bills $100');
ok(page.runningLeftoverHtml(unverified.afterHouseholdBudget).includes(
    page.money2(unverified.afterHouseholdBudget)),
  'page prints independently expected leftover from Balance After Deductions');
ok(page.calendarIncomeHtml(represented).includes('data-period-income="past-salary" data-income-status="received"')
    && page.calendarPeriodBillsHtml(represented).includes('data-period-bill="bill-a" data-bill-status="PAID"'),
  'page still prints received and PAID when exact evidence exists');

console.log(`\n${checks - failures}/${checks} checks passed; ${failures} failure(s).`);
if (failures) process.exit(1);
