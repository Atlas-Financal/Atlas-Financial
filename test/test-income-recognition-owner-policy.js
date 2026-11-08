'use strict';
/* Owner income-recognition policy, 2026-09-11.
 *
 * This is Forecast recognition policy, not Lunch Money deposit evidence
 * and not a data.json invent. Independent dates are constructed from
 * calendar arithmetic (L-002). Amounts are synthetic (L-006).
 *
 *   Dale / Seaspan: on a Seaspan payday (as-of in America/Vancouver),
 *   the salary is relied upon for planning at 00:00 PT that day even
 *   when Lunch Money has not posted the deposit.
 *   Amanda / Tennis BC: received only when confirmed; payday date
 *   alone does not make it relied-upon or received.
 *
 * Child benefit is out of scope.
 *
 * `node test/test-income-recognition-owner-policy.js`
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../public/forecast.js');
const { sourceText } = require('./test-source-text');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
};
const near = (a, b, eps = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= eps;
const roundCent = n => Math.round((Number(n) || 0) * 100) / 100;
const read = file => sourceText(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));

function grab(src, re, label) {
  const match = re.exec(src);
  if (!match) throw new Error('missing ' + label);
  return match[0];
}

function addCalendarDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
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
const INDEPENDENT_SEASPAN = stepBiweekly(SEASPAN_ANCHOR, '2027-01-15');
const SEP11 = '2026-09-11';
const JAN15 = '2027-01-15';
const OPENING = 220.49;
const DALE = 3100;
const AMANDA = 1800;

ok(INDEPENDENT_SEASPAN.includes(SEP11) && INDEPENDENT_SEASPAN.includes(JAN15),
  'independent +14 steps from 2026-08-14 include Sep 11 2026 and Jan 15 2027');

const debts = [
  {
    id: 'triangle', label: 'Synthetic card', secured: false,
    structure: 'Revolving — test', balance: 100, rate: 21.99, payment: 20, pending: 0,
  },
];

function policyPlan(asOf, extras) {
  extras = extras || {};
  return {
    defaults: { targetBuffer: 500 },
    startingCash: {
      amount: OPENING,
      breakdown: [{ id: 'chequing-a', label: 'BILLS ACCOUNT', value: OPENING, class: 'spendable' }],
    },
    opening: {
      asOf,
      representedEvents: extras.representedEvents || [],
      notReliedUponEvents: extras.notReliedUponEvents || [],
    },
    nextDollar: { policy: 'true-surplus-highest-interest', provenance: 'owner-stated' },
    income: [
      {
        id: 'payroll', label: 'Payroll — Seaspan', frequency: 'biweekly',
        anchor: SEASPAN_ANCHOR, amount: DALE, confidence: 'confirmed',
      },
      {
        id: 'amandaSalary15', label: 'Amanda salary — Tennis BC — 15th',
        frequency: 'monthly', day: 15, amount: AMANDA, confidence: 'confirmed',
        firstDue: '2026-09-15',
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

function recommend(asOf, extras) {
  const plan = policyPlan(asOf, extras);
  return F.recommend(plan, asOf, {
    targetBuffer: 500,
    debts,
    notReliedUponEvents: (plan.opening && plan.opening.notReliedUponEvents) || [],
    representedEvents: (plan.opening && plan.opening.representedEvents) || [],
  });
}

function active(advice) {
  return ((advice && advice.defaultView && advice.defaultView.calendarPeriods) || [])
    .find(row => row && row.id === 'this-pay-period');
}
function income(period, id, date) {
  return ((period && period.income) || []).find(row =>
    row && row.id === id && (!date || row.date === date));
}

function loadComposer() {
  const app = read('public/app.js');
  const plan = read('public/plan.js');
  const functions = [
    'glanceSignedMoney', 'glanceMoney', 'glanceLineLabel',
    'calendarCurrentUnavailableHtml', 'calendarIncomeHtml',
  ];
  const source = ['money', 'money2', 'escapeHtml', 'fmtDate'].map(name =>
    grab(app, new RegExp(`^const ${name} = .*$`, 'm'))
  ).concat(functions.map(name =>
    grab(plan, new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))
  )).join('\n');
  return vm.runInNewContext(
    `${source}\n({ calendarIncomeHtml });`,
    { Forecast: F }
  );
}

function unconfirmed(row) {
  if (!row) return false;
  if (row.status === 'received' || row.status === 'relied-upon') return false;
  if (row.settlement === 'represented' || row.settlement === 'relied-upon') return false;
  if (row.alreadyInCash === true) return false;
  return row.status === 'arriving'
    || row.status === 'unresolved'
    || row.notReliedUpon === true
    || row.settlement === 'not-relied-upon';
}

console.log('=== 1. Household date, not a UTC prefix, decides the Seaspan payday ===');
{
  ok(F.HOUSEHOLD_TIMEZONE === 'America/Vancouver',
    'household timezone is America/Vancouver');
  ok(F.financialDate('2026-09-11T00:00:00-07:00') === SEP11
      && F.financialDate('2026-09-11T05:08:00-07:00') === SEP11,
    '00:00 PT and the 05:08 PT live symptom instant are household 2026-09-11');
  ok(F.financialDate('2026-09-10T23:59:00-07:00') === '2026-09-10',
    '23:59 PT on Sep 10 is still household Sep 10');
  ok(F.financialDate('2026-09-11T06:59:00Z') === '2026-09-10',
    'UTC prefix 2026-09-11T06:59Z is still Sep 10 in Vancouver');
}

console.log('\n=== 2. Sep 11 Seaspan payday morning: Dale relied-upon without an LM deposit ===');
{
  const extras = {
    notReliedUponEvents: [
      { id: 'payroll', date: SEP11, reason: 'same-day-inbound-unproven' },
    ],
  };
  const advice = recommend(SEP11, extras);
  const period = active(advice);
  const dale = income(period, 'payroll', SEP11);
  const amanda = income(period, 'amandaSalary15', '2026-09-15');
  ok(period && period.start === SEP11,
    'This Pay Period starts on the independent Sep 11 Seaspan payday');
  ok(dale && dale.status === 'relied-upon' && dale.settlement === 'relied-upon'
      && dale.notReliedUpon !== true && dale.alreadyInCash !== true
      && dale.actual == null
      && dale.incomeRecognition === 'owner-policy-2026-09-11-seaspan-payday'
      && near(dale.amount, DALE),
    'Dale is relied upon for planning with no represented deposit and no actual',
    dale && `${dale.status}/${dale.settlement} actual=${dale.actual}`);
  ok(unconfirmed(amanda) && amanda.status !== 'relied-upon'
      && amanda.status !== 'received' && near(amanda.amount, AMANDA),
    'future Amanda in the same period stays unconfirmed/arriving',
    amanda && `${amanda.status}/${amanda.settlement}`);
  ok(near(period.incomeTotal, roundCent(DALE + AMANDA))
      && near(period.available, roundCent(DALE + AMANDA)),
    'Payday balance still includes both salaries; recognition is status, not a new dollar');
  ok(near(period.currentBalance, OPENING),
    'Current Balance stays the synthetic opening; no deposit was invented');
  const page = loadComposer();
  const html = page.calendarIncomeHtml(period);
  ok(html.includes('data-period-income="payroll" data-income-status="relied-upon"')
      && /Dale salary/.test(html),
    'page prints Forecast Dale status as relied upon');
  ok(html.includes('data-period-income="amandaSalary15"')
      && !html.includes('data-period-income="amandaSalary15" data-income-status="relied-upon"')
      && !html.includes('data-period-income="amandaSalary15" data-income-status="received"'),
    'page does not print Amanda as relied upon or received');
}

console.log('\n=== 3. Same-day Jan 15: Dale recognized, Amanda unconfirmed until evidence ===');
{
  const extras = {
    notReliedUponEvents: [
      { id: 'payroll', date: JAN15, reason: 'same-day-inbound-unproven' },
      { id: 'amandaSalary15', date: JAN15, reason: 'same-day-inbound-unproven' },
    ],
  };
  const advice = recommend(JAN15, extras);
  const period = active(advice);
  const dale = income(period, 'payroll', JAN15);
  const amanda = income(period, 'amandaSalary15', JAN15);
  ok(dale && dale.status === 'relied-upon' && dale.notReliedUpon !== true
      && dale.actual == null && near(dale.amount, DALE),
    'on a coinciding Seaspan payday, Dale is relied upon without LM');
  ok(unconfirmed(amanda) && amanda.status !== 'relied-upon'
      && amanda.settlement !== 'relied-upon'
      && (amanda.notReliedUpon === true || amanda.status === 'arriving'
        || amanda.status === 'unresolved'),
    'Amanda on her payday stays unconfirmed until settlement evidence',
    amanda && `${amanda.status}/${amanda.settlement}`);
  ok(near(period.currentBalance, OPENING),
    'Amanda unconfirmed path also invents no deposit');
}

console.log('\n=== 4. Confirmed Amanda settlement is still received; Dale proof stays represented ===');
{
  const extras = {
    representedEvents: [
      { id: 'payroll', date: JAN15 },
      { id: 'amandaSalary15', date: JAN15 },
    ],
  };
  const advice = recommend(JAN15, extras);
  const period = active(advice);
  const dale = income(period, 'payroll', JAN15);
  const amanda = income(period, 'amandaSalary15', JAN15);
  ok(dale && dale.settlement === 'represented' && dale.status === 'received',
    'represented Dale remains received settlement, not a second recognition path');
  ok(amanda && amanda.settlement === 'represented' && amanda.status === 'received'
      && amanda.alreadyInCash === true,
    'confirmed Amanda settlement is received');
}

console.log('\n=== 5. The day before a Seaspan payday does not recognize Dale ===');
{
  const extras = {
    notReliedUponEvents: [
      { id: 'payroll', date: SEP11, reason: 'same-day-inbound-unproven' },
    ],
  };
  const advice = recommend('2026-09-10', extras);
  const period = active(advice);
  ok(period && period.end === '2026-09-10',
    'Sep 10 is still the prior Seaspan cycle');
  ok(!income(period, 'payroll', SEP11),
    'Sep 11 Dale is absent from the still-current period');
}

console.log('\n=== 6. Pages print Forecast; they do not own income recognition ===');
{
  const src = read('public/plan.js');
  const incomeFn = grab(src, /^function calendarIncomeHtml\([\s\S]*?\n\}$/m, 'calendarIncomeHtml');
  ok(/row\.status === 'relied-upon'/.test(incomeFn),
    'plan.js prints Forecast relied-upon status');
  ok(!/isDaleSeaspanPaydayRecognition|Seaspan payday/.test(src),
    'plan.js does not decide Seaspan payday recognition');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures ? 1 : 0;
