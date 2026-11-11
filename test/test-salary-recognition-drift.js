'use strict';
/* Salary recognition and payroll-drift regression.
 *
 * Owner contract 2026-09-01: Dale's Seaspan salary is true 14-day biweekly
 * Forecast income; Amanda's Tennis BC salary is semi-monthly via the
 * incumbent 15th + month-end streams; TENNIS INCOME is not Current Balance;
 * a BILLS transfer proves a posted Amanda occurrence and is not a second
 * income line; operating Pay Periods consume actual Forecast events inside
 * Seaspan payday-to-payday windows and do not own payroll cadence.
 *
 * Expected dates are constructed independently of Forecast.occurrences /
 * biweeklyDates / monthlyDates (L-002). Synthetic current cash is used so
 * live bank balances are never the specification (L-006).
 *
 * `node test/test-salary-recognition-drift.js`
 */
const fs = require('fs');
const path = require('path');
const F = require('../public/forecast.js');
const live = require('../data.json');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Independent of Forecast.addDays / biweeklyDates: UTC calendar day + n.
function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function lastCalendarDay(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function stepBiweekly(anchor, through) {
  const out = [];
  let cursor = anchor;
  while (cursor <= through) {
    out.push(cursor);
    cursor = addCalendarDays(cursor, 14);
  }
  return out;
}

const SEASPAN_ANCHOR = '2026-08-14';
const SEASPAN_THROUGH = '2027-01-29';
const INDEPENDENT_SEASPAN = stepBiweekly(SEASPAN_ANCHOR, SEASPAN_THROUGH);
const REQUIRED_SEASPAN = [
  '2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25',
  '2026-10-09', '2026-10-23', '2026-11-06', '2026-11-20',
  '2026-12-04', '2026-12-18', '2027-01-01', '2027-01-15', '2027-01-29',
];
const AMANDA_15_EXPECT = [
  '2026-09-15', '2026-10-15', '2026-11-15', '2027-02-15',
];
const AMANDA_END_EXPECT = [
  '2026-09-30', '2026-10-31', '2026-11-30', '2027-02-28',
];
const FORBIDDEN_AMANDA = ['2026-09-31', '2026-11-31', '2027-02-31'];

const payroll = (live.plan.income || []).find(s => s && s.id === 'payroll');
const amanda15 = (live.plan.income || []).find(s => s && s.id === 'amandaSalary15');
const amandaEnd = (live.plan.income || []).find(s => s && s.id === 'amandaSalaryMonthEnd');
const SEASPAN_AMT = payroll && Number(payroll.amount);
const AMANDA_15_AMT = amanda15 && Number(amanda15.amount);
const AMANDA_END_AMT = amandaEnd && Number(amandaEnd.amount);
const CURRENT_CASH = 8000;
const AS_OF = '2027-01-01';

function salaryPlan() {
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: CURRENT_CASH, class: 'spendable' }],
      heldElsewhere: [{
        id: 'amanda-debt-payments',
        label: 'TENNIS INCOME',
        value: 1234.56,
        class: 'operational',
      }],
    },
    opening: { asOf: AS_OF, representedEvents: [] },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: SEASPAN_ANCHOR, amount: SEASPAN_AMT, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
        frequency: 'monthly', day: 15, amount: AMANDA_15_AMT,
        confidence: 'confirmed', firstDue: '2026-09-15',
      },
      {
        id: 'amandaSalaryMonthEnd', label: 'Amanda salary — Tennis BC — month end',
        frequency: 'monthly', day: 31, amount: AMANDA_END_AMT,
        confidence: 'confirmed',
      },
    ],
    obligations: [],
    bills: [],
    commitments: [],
    groups: [],
    funding: { options: [] },
    budget: {
      weeklyVariable: 0,
      categories: [
        { id: 'groceries', label: 'Groceries', class: 'essential', plannedWeekly: 0 },
      ],
    },
  };
}

const debts = [
  { id: 'triangle', label: 'Triangle', secured: false, structure: 'Revolving',
    balance: 100, rate: 21.99, payment: 250, pending: 0 },
  { id: 'mortgage', label: 'Mortgage', secured: true, structure: 'Amortising',
    balance: 5000, rate: 3.64, payment: 1600, pending: 0 },
];

function period(view, id) {
  return ((view && view.calendarPeriods) || []).find(p => p.id === id);
}
function salaryRows(p) {
  return ((p && p.income) || []).filter(r =>
    r && (r.id === 'payroll' || r.id === 'amandaSalary15' || r.id === 'amandaSalaryMonthEnd'));
}
function rowKey(r) {
  return `${r.id}@${r.date}@${Number(r.amount)}`;
}

console.log('=== 1. Seaspan biweekly drift is true 14-day recurrence ===');
{
  ok(INDEPENDENT_SEASPAN.join(',') === REQUIRED_SEASPAN.join(','),
    'independent +14 calendar steps from 2026-08-14 match the owner date list',
    INDEPENDENT_SEASPAN.join(','));
  ok(payroll && payroll.frequency === 'biweekly' && payroll.anchor === SEASPAN_ANCHOR,
    'live payroll is biweekly from the incumbent 2026-08-14 anchor');
  ok(/not twice per month/i.test(payroll.note || ''),
    'live payroll note states Seaspan is not twice per month');
  ok(!/semi-?monthly/i.test(payroll.note || ''),
    'live payroll note does not call Seaspan semi-monthly');
  const forecastDates = F.occurrences(payroll, SEASPAN_ANCHOR, SEASPAN_THROUGH);
  ok(forecastDates.join(',') === INDEPENDENT_SEASPAN.join(','),
    'Forecast.occurrences agrees with independent +14 dates, not a twice-monthly grid',
    forecastDates.join(','));
  const events = F.expandEvents(live.plan, SEASPAN_ANCHOR, SEASPAN_THROUGH, {})
    .filter(e => e && e.id === 'payroll' && e.kind === 'income');
  ok(events.map(e => e.date).join(',') === INDEPENDENT_SEASPAN.join(','),
    'expandEvents on live payroll emits the same drifting dates');
}

console.log('\n=== 2. Amanda 15th + month-end streams are last-calendar-day semi-monthly ===');
{
  ok(amanda15 && amanda15.frequency === 'monthly' && Number(amanda15.day) === 15,
    'amandaSalary15 is monthly on the 15th');
  ok(amandaEnd && amandaEnd.frequency === 'monthly' && Number(amandaEnd.day) === 31,
    'amandaSalaryMonthEnd is monthly day 31 (last calendar day)');
  const start = '2026-09-01';
  const end = '2027-02-28';
  const got15 = F.occurrences(amanda15, start, end);
  const gotEnd = F.occurrences(amandaEnd, start, end);
  for (const date of AMANDA_15_EXPECT) {
    ok(got15.includes(date), `amandaSalary15 includes independent ${date}`);
  }
  for (const date of AMANDA_END_EXPECT) {
    ok(gotEnd.includes(date), `amandaSalaryMonthEnd includes independent ${date}`);
  }
  ok(iso(2026, 9, lastCalendarDay(2026, 9)) === '2026-09-30'
      && iso(2026, 10, lastCalendarDay(2026, 10)) === '2026-10-31'
      && iso(2026, 11, lastCalendarDay(2026, 11)) === '2026-11-30'
      && iso(2027, 2, lastCalendarDay(2027, 2)) === '2027-02-28',
    'independent last-calendar-day constructor clamps Sep/Nov/Feb');
  for (const bad of FORBIDDEN_AMANDA) {
    ok(!gotEnd.includes(bad) && !got15.includes(bad),
      `no invented ${bad}`);
  }
  ok(!gotEnd.includes('2026-09-31') && gotEnd.includes('2026-09-30'),
    'September month-end is Sep 30, not Sep 31');
}

console.log('\n=== 3. January 2027 payday periods consume actual Forecast salary events ===');
{
  const plan = salaryPlan();
  const advice = F.recommend(plan, AS_OF, { targetBuffer: 500, debts });
  const view = advice.defaultView;
  const p1 = period(view, 'this-pay-period');
  const p2 = period(view, 'next-pay-period');
  ok(p1 && p1.start === '2027-01-01' && p1.end === '2027-01-14'
      && p1.label === 'This Pay Period',
    'This Pay Period is Jan 1–14');
  ok(p2 && p2.start === '2027-01-15' && p2.end === '2027-01-28'
      && p2.label === 'Next Pay Period',
    'Next Pay Period is Jan 15–28');
  const p1Salary = salaryRows(p1);
  const p2Salary = salaryRows(p2);
  ok(p1Salary.length === 1 && p1Salary[0].id === 'payroll' && p1Salary[0].date === '2027-01-01'
      && near(p1Salary[0].amount, SEASPAN_AMT),
    'Jan 1–14 contains Seaspan Jan 1 only',
    p1Salary.map(rowKey).join(', '));
  ok(p2Salary.some(r => r.id === 'payroll' && r.date === '2027-01-15' && near(r.amount, SEASPAN_AMT))
      && p2Salary.some(r => r.id === 'amandaSalary15' && r.date === '2027-01-15'
        && near(r.amount, AMANDA_15_AMT))
      && !p2Salary.some(r => r.date === '2027-01-29'),
    'Jan 15–28 contains Seaspan Jan 15 and Amanda Jan 15, not Jan 29',
    p2Salary.map(rowKey).join(', '));
  ok(!p1Salary.some(r => r.id === 'amandaSalary15' || r.id === 'amandaSalaryMonthEnd')
      && !p2Salary.some(r => r.id === 'amandaSalaryMonthEnd'),
    'Amanda month-end does not leak into Jan 1–28 payday windows');
}

console.log('\n=== 4. Same-day Seaspan and Amanda 15th salaries are distinct events ===');
{
  const plan = salaryPlan();
  const p2 = period(F.recommend(plan, AS_OF, { targetBuffer: 500, debts }).defaultView,
    'next-pay-period');
  const sameDay = salaryRows(p2).filter(r => r.date === '2027-01-15');
  ok(sameDay.length === 2, 'Jan 15 has two salary rows', sameDay.map(rowKey).join(', '));
  ok(sameDay.some(r => r.id === 'payroll' && near(r.amount, SEASPAN_AMT))
      && sameDay.some(r => r.id === 'amandaSalary15' && near(r.amount, AMANDA_15_AMT)),
    'Jan 15 keeps distinct payroll and amandaSalary15 ids and amounts');
  ok(new Set(sameDay.map(r => r.id)).size === 2,
    'same calendar date does not collapse the two salaries into one id');
}

console.log('\n=== 5. Represented current paycheck adds $0; later-cycle salary is not added now ===');
{
  const plan = salaryPlan();
  plan.opening.representedEvents = [{ id: 'payroll', date: '2027-01-01' }];
  const tennisRow = plan.startingCash.heldElsewhere[0];
  const spendable = (plan.startingCash.breakdown || []).reduce(
    (s, r) => s + (Number(r.value) || 0), 0);
  ok(near(spendable, CURRENT_CASH) && !near(spendable, CURRENT_CASH + Number(tennisRow.value)),
    'synthetic Current Balance is household cash only; TENNIS INCOME is not added');
  const advice = F.recommend(plan, AS_OF, {
    targetBuffer: 500, debts,
    representedEvents: [{ id: 'payroll', date: '2027-01-01' }],
  });
  const p1 = period(advice.defaultView, 'this-pay-period');
  const p2 = period(advice.defaultView, 'next-pay-period');
  const jan1 = salaryRows(p1).find(r => r.id === 'payroll' && r.date === '2027-01-01');
  const jan15Pay = salaryRows(p2).find(r => r.id === 'payroll' && r.date === '2027-01-15');
  const jan15Amanda = salaryRows(p2).find(r => r.id === 'amandaSalary15' && r.date === '2027-01-15');
  ok(jan1 && jan1.settlement === 'represented' && jan1.alreadyInCash === true
      && near(jan1.remaining, 0),
    'Jan 1 Seaspan is known represented / already in Current Balance and remaining $0',
    jan1 && `${jan1.settlement} remaining=${jan1.remaining}`);
  ok(near(p1.opening, advice.paydayAllocation.available)
      && near(p1.currentBalance, CURRENT_CASH),
    'active period opens from synthetic current cash, which already contains the represented paycheck');
  ok(!salaryRows(p1).some(r => r.date === '2027-01-15'),
    'still-future Jan 15 salaries are absent from the Jan 1–14 waterfall');
  ok(jan15Pay && jan15Pay.alreadyInCash !== true && near(jan15Pay.remaining, SEASPAN_AMT),
    'still-future Jan 15 Seaspan remains in the next period at its full amount');
  ok(jan15Amanda && jan15Amanda.alreadyInCash !== true
      && near(jan15Amanda.remaining, AMANDA_15_AMT),
    'still-future Jan 15 Amanda salary remains in the next period at its full amount');
  ok(near(p1.incomeAdded, 0),
    'represented Jan 1 paycheck adds $0 again; later-cycle salaries are not added now',
    `incomeAdded=${p1.incomeAdded}`);
  ok(near(p1.available, p1.incomeTotal),
    'Payday balance equals displayed period income, not Current Balance');
}

console.log('\n=== 6. Pay Periods do not own payroll cadence ===');
{
  const planSrc = read('public/plan.js');
  const forecastSrc = read('public/forecast.js');
  const pages = [
    ['public/plan.js', planSrc],
    ['public/app.js', read('public/app.js')],
  ];
  const forbidden = /one\s+(Dale|Amanda)\s+paycheck|one paycheck from each|one payroll per (half|period)|two salary deposits per (half|period)|paychecksPerHalf|PAYCHECKS_PER_(HALF|PERIOD)|each half gets two salaries/i;
  for (const [name, src] of pages) {
    ok(!forbidden.test(src), `${name} does not encode a fixed paycheck count per calendar half`);
  }
  ok(!forbidden.test(forecastSrc),
    'forecast.js does not encode a fixed paycheck count per calendar half');
  const incomeSection = /function calendarIncomeSections\([\s\S]*?\n  \}/.exec(forecastSrc);
  ok(incomeSection && /expandEvents\(plan, span\.start, span\.end/.test(incomeSection[0]),
    'operating Pay Period income is enumerated from Forecast.expandEvents over the payday span');
  ok(incomeSection && /const key = \(row\.id \|\| row\.label \|\| ''\) \+ '@' \+ \(row\.date \|\| ''\)/.test(incomeSection[0]),
    'income rows are keyed by id@date, so two salaries on one date both survive');
  ok(!/income\.length === 2|salaryRows\.length === 2|expectedIncomeCount/.test(incomeSection[0]),
    'calendarIncomeSections does not assume two income deposits per period');
}

console.log('\n=== current authority wording supersedes the Aug-9 tennis-cash reading ===');
{
  const facts = read('docs/ACCOUNT_FACTS.md');
  const arch = read('ARCHITECTURE.md');
  ok(/SUPERSEDED for current spendable-cash authority/.test(facts)
      && /already the household's money/.test(facts),
    'ACCOUNT_FACTS keeps the Aug-9 tennis-account wording as superseded historical evidence');
  ok(/TENNIS INCOME itself is not Current Balance|TENNIS INCOME balance is not Current Balance/i.test(facts),
    'ACCOUNT_FACTS current authority says TENNIS INCOME is not Current Balance');
  ok(/true 14-day|every 14 days/i.test(facts) && /not twice per month/i.test(facts),
    'ACCOUNT_FACTS states Seaspan is 14-day biweekly, not twice per month');
  ok(/Operating Pay Periods|payday-to-payday/i.test(facts)
      && /do not own payroll cadence|not calendar halves/i.test(facts),
    'ACCOUNT_FACTS states operating Pay Periods consume actual events inside Seaspan windows');
  ok(!/Same-day scheduled cash events need\s+posting\/representation evidence or the overlay fails closed/.test(arch),
    'ARCHITECTURE no longer fail-closes the overlay on unresolved inbound');
  ok(/not added on top of a complete trusted current-cash observation/i.test(arch),
    'ARCHITECTURE records the PR #222 inbound split');
  ok(!/month-end\) land in\s+household accounts and are Forecast household income/.test(arch),
    'ARCHITECTURE no longer says Tennis BC deposits land in household accounts');
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll salary-recognition drift checks passed.');
