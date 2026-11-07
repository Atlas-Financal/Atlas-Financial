'use strict';
/* B92 — ordinary household-value refresh must not rewrite unrelated suites.
 *
 * Runs the other npm test suites against a complete temporary repository
 * fixture. Only the fixture's data.json is mutated; canonical bytes are never
 * written. Normal completion and exceptions remove the fixture. A forced kill
 * may leave a temporary copy, but cannot leave a household figure changed.
 *
 * Live-reconciliation suites are allowed to fail when the mutated fact is
 * the thing they reconcile. Behaviour suites are not.
 */
const fs = require('fs');
const path = require('path');
const { withMutatedFixture, runSuite, isExpectedFailure, failureSummary, failureOutput } =
  require('./lib/refresh-isolation-runner');
const F = require('../public/forecast.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data.json');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

const SUITES = [
  'test-static.js',
  'test-line-endings.js',
  'test-forecast.js',
  'test-income-deadline.js',
  'test-next-due.js',
  'test-next-payment-out.js',
  'test-schedule-authority.js',
  'test-question-status.js',
  'test-unallocated-cash.js',
  'test-compact-snapshot.js',
  'test-publication-totals.js',
  'test-mission.js',
  'test-status-band.js',
  'test-nextmove.js',
  'test-counterfactuals.js',
  'test-renewal.js',
  'test-payoff.js',
  'test-budget.js',
  'test-classification.js',
  'test-weekly-cap.js',
  'test-food-fuel.js',
  'test-plan-phases.js',
  'test-deepdive.js',
  'test-debt.js',
  'test-invariants.js',
  'test-authority-coverage.js',
  'test-evidence-use-register.js',
  'test-mergecard.js',
  'test-live-household.js',
  'test-dedup-facts.js',
  'test-reconcile.js',
  'test-cutover.js',
  'test-b20-history.js',
  'test-fusion-warriors-plan-commitments.js',
  'test-major-future-costs.js',
];

// Each allowed suite names its own completion line (printed only after every
// check ran) and the assertions the mutated fact is expected to fail. A crash
// after an expected FAIL, or any unnamed FAIL, is an unexpected failure.
const COMPLETION = {
  checksUpper: /^\d+ CHECK\(S\) FAILED$/,
  checksLower: /^\d+ check\(s\) failed$/,
  b20: /^FAILED — \d+ B20 history check\(s\)$/,
};
const NET_WORTH = [
  /^Household net worth = owner home estimate \+ canonical assets − canonical debt$/,
  /^and financial-account net worth, which still excludes the home$/,
  /^positions\.csv computed rows reconcile with data\.json$/,
];
const CASES = [
  {
    id: 'cash',
    label: 'CASE A — Chequing A / starting cash +$1,000',
    allow: {
      'test-invariants.js': { completion: COMPLETION.checksUpper,
        expected: [...NET_WORTH, /^the CSV asset total equals data\.json$/] },
      'test-b20-history.js': { completion: COMPLETION.b20, expected: [
        /^current snapshot chequing-a agrees with live data\.json$/,
        /^current canonical Chequing A reading agrees with same-date positions\.csv$/] },
    },
    mutate(d) {
      const row = d.plan.startingCash.breakdown.find(b => /Chequing A/.test(b.label));
      row.value += 1000;
    },
  },
  {
    id: 'card',
    label: 'CASE B — MBNA posted and current balance +$500',
    allow: {
      'test-invariants.js': { completion: COMPLETION.checksUpper, expected: [...NET_WORTH,
        /^and the debt total$/, /^debt ".+" has a matching position row$/] },
      'test-b20-history.js': { completion: COMPLETION.b20, expected: [
        /^current canonical MBNA reading agrees with same-date positions\.csv$/] },
    },
    mutate(d) {
      const mb = d.debts.find(x => x.id === 'mbna');
      mb.balance += 500;
    },
  },
  {
    id: 'payrollBill',
    label: 'CASE C — payroll +$200 and Shaw +$20',
    allow: {
      'test-live-household.js': { completion: COMPLETION.checksUpper,
        expected: [/^canonical payroll net sits inside the .+ observed deposit range$/] },
    },
    mutate(d) {
      d.plan.income.find(s => s.id === 'payroll').amount += 200;
      d.plan.bills.find(b => b.id === 'shaw').amount += 20;
    },
  },
  {
    id: 'commitment',
    label: 'CASE D — remove Fusion household paid commitment from the input',
    allow: {
      'test-fusion-warriors-plan-commitments.js': { completion: COMPLETION.checksLower, expected: [
        /^paid row is .+ settledOn .+$/, /^note cites live LM id .+ and Interac ref\/memo$/,
        /chain context cites coaching LM id and tennis remainder only in note$/,
        /^coaching and tennis remainder are not plan income$/, /^LM ids live in note only — no schema field on commitment row$/] },
      'test-major-future-costs.js': { completion: COMPLETION.checksLower, expected: [
        /^Fusion paid is settled on .+ Interac evidence date$/,
        /^Fusion paid row settledOn matches Interac evidence date$/,
        /paid row is not yet settledOn-relative/, /^hand total at .+ opening includes Warriors/] },
    },
    mutate(d) {
      d.plan.commitments = d.plan.commitments.filter(c => c.id !== 'fusion-household-paid');
    },
  },
];

console.log('=== B92 refresh isolation ===');
const original = fs.readFileSync(DATA);
const report = [];

for (const c of CASES) {
  console.log(`\n--- ${c.label} ---`);
  const result = withMutatedFixture(ROOT, c.mutate, fixture => {
    const failed = [];
    let asserts = 0;
    for (const file of SUITES) {
      const r = runSuite(file, fixture);
      if (!r.ok) {
        failed.push(r);
        asserts += r.fails;
        console.log(failureOutput(r));
      }
    }
    return { failed, asserts };
  });
  const after = fs.readFileSync(DATA);
  ok(Buffer.compare(original, after) === 0,
    `${c.id}: canonical data.json bytes unchanged by the mutation`);
  const unexpected = result.failed.filter(f => !isExpectedFailure(f, c.allow));
  const expected = result.failed.filter(f => isExpectedFailure(f, c.allow));
  ok(unexpected.length === 0,
    `${c.id}: no unrelated behaviour suite fails`,
    unexpected.length
      ? unexpected.map(failureSummary).join(', ')
      : 'none');
  for (const name of Object.keys(c.allow)) {
    ok(expected.some(f => f.file === name),
      `${c.id}: live recon ${name} still bites when that fact moves`);
  }
  report.push({
    id: c.id,
    failed: result.failed.map(failureSummary),
    asserts: result.asserts,
  });
}

console.log('\n=== anti-mutation: financial truth still bites ===');
{
  const fixture = {
    windowDays: 14,
    defaults: { targetBuffer: 0 },
    startingCash: { amount: 500 },
    income: [{ id: 'p', label: 'Pay', frequency: 'once', date: '2026-01-04',
      amount: 1000, confidence: 'confirmed' }],
    obligations: [{ id: 'b', label: 'Bill', frequency: 'once', date: '2026-01-06',
      amount: 400, confidence: 'confirmed' }],
    commitments: [],
  };
  const sim = F.simulate(fixture, '2026-01-01', { weeklyVariable: 70, targetBuffer: 0 });
  const independent = 500 + 1000 - 400 - 140;
  ok(near(sim.ending, independent),
    'synthetic ending matches hand-computed start + in − bill − variable');
  ok(!near(sim.ending, 500 + 1000 - 140),
    'omitting the bill from that identity disagrees — conservation still bites');

  const rec = F.recommendWeekly(fixture, '2026-01-01', { targetBuffer: 100 });
  const days = F.knowledgeHorizon(fixture, '2026-01-01', {}).days;
  const over = F.simulate(fixture, '2026-01-01', {
    weeklyVariable: rec + 10, targetBuffer: 100, horizonDays: days,
  });
  ok(over.min.balance < 100, 'one $10 step above the cap still breaches the floor');

  const live = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = F.publicationTotals(live);
  const parent = live.debts.find(d => d.id === 'mbna');
  parent.balance += 500;
  const after = F.publicationTotals(live);
  ok(near(after.totalDebt, before.totalDebt + 500),
    'publication total debt follows a parent balance mutation');
  ok(!near(after.totalDebt, before.totalDebt),
    'and does not stay pinned to the pre-mutation total');

  const monthEnd = F.occurrences(
    { frequency: 'monthly', day: 31 }, '2026-08-09', '2026-11-07');
  ok(monthEnd.join(',') === '2026-08-31,2026-09-30,2026-10-31',
    'monthly day-31 still clamps to 30 Sep — a 31 Sep answer would fail');
  ok(!monthEnd.includes('2026-09-31'), 'September has no 31st');
}

console.log('\n=== blast-radius report ===');
for (const r of report) {
  console.log(`  ${r.id}: ${r.failed.length ? r.failed.join('; ') : 'no suite failures'} (${r.asserts} asserts)`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
