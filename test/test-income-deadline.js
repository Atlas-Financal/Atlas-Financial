'use strict';
// Focused proof for Forecast.incomeDeadline(). The correctness case is hand
// computed; the real-plan check only proves this authority move preserves the
// page's existing answer while deleting the page-level decision.
const fs = require('fs');
const F = require('../public/forecast.js');
const data = require('../data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

console.log('=== hand-computed income dependency ===');
// Start $500, target buffer $100. A $300 transfer lands Jan 4 and a $500 bill
// leaves Jan 5. With the transfer: $500 + $300 - $500 = $300, safely above the
// buffer. Without it: $500 - $500 = $0, so Jan 5 is the first day below $100.
const fixture = {
  windowDays: 7,
  defaults: { targetBuffer: 100 },
  startingCash: { amount: 500 },
  income: [{ id: 'transfer', label: 'Transfer', frequency: 'once', date: '2026-01-04',
    amount: 300, confidence: 'estimated' }],
  obligations: [{ id: 'bill', label: 'Bill', frequency: 'once', date: '2026-01-05',
    amount: 500, confidence: 'confirmed' }],
  commitments: [],
};
const withIncome = F.simulate(fixture, '2026-01-01', { weeklyVariable: 0, targetBuffer: 100 });
ok(near(withIncome.daily.find(p => p.date === '2026-01-05').balance, 300),
  'the transfer leaves $300 after the bill');
const dep = F.incomeDeadline(fixture, '2026-01-01', 'transfer', {
  weeklyVariable: 0, targetBuffer: 100,
});
ok(dep.amount === 300, 'the engine reports the active transfer amount', String(dep.amount));
ok(dep.neededBy === '2026-01-05',
  'without the transfer the first below-buffer day is Jan 5', dep.neededBy || 'none');
ok(dep.breachesWithout === true && near(dep.endingWithout, 0),
  'the counterfactual ends at $0 and is explicitly a breach', String(dep.endingWithout));

const safeFixture = JSON.parse(JSON.stringify(fixture));
safeFixture.startingCash.amount = 700;
const safe = F.incomeDeadline(safeFixture, '2026-01-01', 'transfer', {
  weeklyVariable: 0, targetBuffer: 100,
});
ok(safe.neededBy === null && safe.breachesWithout === false,
  'no deadline is invented when the plan holds without the income');

console.log('\n=== real-plan migration equivalence ===');
const plan = data.plan;
const asOf = data.meta.asOf;
const opts = {
  scenario: plan.defaults.scenario,
  targetBuffer: plan.defaults.targetBuffer,
  extraDebtMonthly: plan.defaults.extraDebtMonthly,
  incomeOverrides: {},
  disabled: [],
  debts: data.debts,
  extraDebtTarget: plan.nextDollar && plan.nextDollar.target,
  fundingSources: plan.funding && plan.funding.options,
};
const advice = F.recommend(plan, asOf, opts);
const weekly = advice.weekly;
const notBefore = advice.gap ? advice.gap.date : asOf;
const legacyNoAmanda = F.simulate(plan, asOf, Object.assign({}, advice.simOptions, {
  weeklyVariable: weekly,
  incomeOverrides: { amandaSalary15: 0, amandaSalaryMonthEnd: 0 },
}));
const legacyFirstShort = legacyNoAmanda.daily.find(p =>
  p.date >= notBefore && p.balance < legacyNoAmanda.buffer - F.EPSILON);
const moved = F.amandaHouseholdIncomeDeadline(plan, asOf, Object.assign({}, advice.simOptions, {
  weeklyVariable: weekly,
  incomeOverrides: {},
  notBefore,
}));
ok(near(moved.amount, 2168.85 + 2387.99),
  'Amanda household-income deadline reports the combined salary monthly amount',
  String(moved.amount));
ok(moved.neededBy === (legacyFirstShort ? legacyFirstShort.date : null),
  'the engine-owned deadline preserves the no-Amanda-salary real-plan answer',
  `${moved.neededBy || 'none'} vs ${legacyFirstShort ? legacyFirstShort.date : 'none'}`);

console.log('\n=== page is a renderer ===');
const page = fs.readFileSync('public/plan.js', 'utf8');
const { pageScriptsMatching } = require('./lib/page-scripts');
// The positive assertion stays on plan.js and retires with it (C1 S7, Q4); the "never" assertions read every page script.
const never = (...res) => pageScriptsMatching(...res);
ok(/Forecast\.amandaHouseholdIncomeDeadline\(/.test(page),
  'Plan reads the Amanda deadline from Forecast.amandaHouseholdIncomeDeadline');
ok(never(/Forecast\.incomeDeadline\(plan,\s*asOf,\s*'amandaTransfer'/).length === 0,
  'no longer binds the deadline to the retired amandaTransfer stream (no page script, classic or Stack)', never(/Forecast\.incomeDeadline\(plan,\s*asOf,\s*'amandaTransfer'/).join(', ') || 'none');
ok(never(/const\s+noTransfer\s*=\s*Forecast\.simulate/).length === 0,
  'no longer runs its own no-transfer simulation (no page script, classic or Stack)', never(/const\s+noTransfer\s*=\s*Forecast\.simulate/).join(', ') || 'none');
ok(never(/firstShort\s*=\s*noTransfer\.daily\.find/).length === 0,
  'no longer selects the deadline day itself (no page script, classic or Stack)', never(/firstShort\s*=\s*noTransfer\.daily\.find/).join(', ') || 'none');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
