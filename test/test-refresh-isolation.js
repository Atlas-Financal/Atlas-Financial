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

const CASES = [
  {
    id: 'cash',
    label: 'CASE A — Chequing A / starting cash +$1,000',
    allow: ['test-invariants.js', 'test-b20-history.js'],
    mutate(d) {
      const row = d.plan.startingCash.breakdown.find(b => /Chequing A/.test(b.label));
      row.value += 1000;
    },
  },
  {
    id: 'card',
    label: 'CASE B — MBNA posted and current balance +$500',
    allow: ['test-invariants.js', 'test-b20-history.js'],
    mutate(d) {
      const mb = d.debts.find(x => x.id === 'mbna');
      mb.balance += 500;
    },
  },
  {
    id: 'payrollBill',
    label: 'CASE C — payroll +$200 and Shaw +$20',
    allow: ['test-live-household.js'],
    mutate(d) {
      d.plan.income.find(s => s.id === 'payroll').amount += 200;
      d.plan.bills.find(b => b.id === 'shaw').amount += 20;
    },
  },
  {
    id: 'commitment',
    label: 'CASE D — remove Fusion household paid commitment from the input',
    allow: ['test-fusion-warriors-plan-commitments.js', 'test-major-future-costs.js'],
    mutate(d) {
      d.plan.commitments = d.plan.commitments.filter(c => c.id !== 'fusion-household-paid');
    },
  },
];

// The four cases are independent: each mutates its own temporary clone, and
// none writes the canonical checkout. Each case therefore runs in its own
// child process (`--case <id>`), all four at once, so the check takes about
// as long as its slowest case instead of the sum of all four. Within a case
// the suites still run serially against that case's one fixture, exactly as
// before. The parent prints each case's output in CASES order and fails
// closed on any case that does not report back its own result.
const CASE_RESULT = 'B92-CASE-RESULT ';

function runCase(c) {
  console.log(`\n--- ${c.label} ---`);
  const original = fs.readFileSync(DATA);
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
  for (const name of c.allow) {
    ok(expected.some(f => f.file === name),
      `${c.id}: live recon ${name} still bites when that fact moves`);
  }
  return { id: c.id, failed: result.failed.map(failureSummary), asserts: result.asserts };
}

// A case child: run exactly one case, then report its own id, check count and
// blast radius on one final line. Nothing else runs in the child.
if (process.argv[2] === '--case') {
  const c = process.argv.length === 4 && CASES.find(x => x.id === process.argv[3]);
  if (!c) { console.log('  FAIL  unknown refresh-isolation case'); process.exit(1); }
  const entry = runCase(c);
  console.log(CASE_RESULT + JSON.stringify({ ...entry, failures }));
  process.exit(failures === 0 ? 0 : 1);
}

function spawnCase(c) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '';
    const child = spawn(process.execPath, [__filename, '--case', c.id],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('error', error => resolve({ out: out + `spawn error: ${error.message}\n`, code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ out, code, signal }));
  });
}

// The result line must be the child's last line, name this case, and agree
// with the child's exit status; anything else is a failed case, never a pass.
function caseOutcome(c, { out, code, signal }) {
  const lines = out.replace(/\n+$/, '').split('\n');
  const last = lines[lines.length - 1] || '';
  let entry = null;
  if (last.startsWith(CASE_RESULT)) {
    try { entry = JSON.parse(last.slice(CASE_RESULT.length)); } catch { entry = null; }
  }
  const valid = entry && entry.id === c.id && Number.isInteger(entry.failures) &&
    entry.failures >= 0 && Array.isArray(entry.failed) && Number.isInteger(entry.asserts) &&
    !signal && code === (entry.failures === 0 ? 0 : 1);
  return { text: (valid ? lines.slice(0, -1) : lines).join('\n'), entry: valid ? entry : null,
    detail: `exit=${code}; signal=${signal}` };
}

console.log('=== B92 refresh isolation ===');
const original = fs.readFileSync(DATA);
const report = [];

(async () => {
  const outcomes = await Promise.all(CASES.map(spawnCase));
  CASES.forEach((c, i) => {
    const { text, entry, detail } = caseOutcome(c, outcomes[i]);
    if (text) console.log(text);
    // The child's own PASS/FAIL lines are printed above; count its failures here.
    failures += entry ? entry.failures : 0;
    ok(entry !== null, `${c.id}: case child reported its own result`, entry ? '' : detail);
    if (entry) report.push({ id: entry.id, failed: entry.failed, asserts: entry.asserts });
  });
  ok(Buffer.compare(original, fs.readFileSync(DATA)) === 0,
    'canonical data.json bytes unchanged after every case');
  finish();
})();

function finish() {
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
}
