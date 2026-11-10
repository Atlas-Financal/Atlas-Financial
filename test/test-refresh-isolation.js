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
const { SHARD_SECONDS, DEFAULT_SHARD_SECONDS } = require('./test');
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

// Hosted CI runs this suite as PART_COUNT parallel part jobs
// (.github/workflows/test.yml). The split is over the suite list, never over
// the cases: every case still runs in every part, against its own fixture,
// but each part runs only its share of the suites inside the case. A case's
// wall is the serial sum of its suites, so balancing the shares by the same
// observed durations the standard shards use (SHARD_SECONDS) is what halves
// the check's wall. The parts are computed, never hand-listed: together they
// run every suite exactly once in every case (test-ci-split.js proves it),
// and each part asserts the expected-failure bites for exactly the allowed
// suites it ran — the union over the parts is the full assertion set. A bare
// run (npm test, a local proof) selects no part and runs everything, as before.
const PART_COUNT = 2;

function partSuites(files, index, count = PART_COUNT, seconds = SHARD_SECONDS) {
  if (!Number.isInteger(count) || count < 1 || count > 9 ||
      !Number.isInteger(index) || index < 1 || index > count) {
    throw new Error('Invalid part');
  }
  const weight = file => Object.prototype.hasOwnProperty.call(seconds, file)
    ? seconds[file] : DEFAULT_SHARD_SECONDS;
  // Longest first, each onto the part whose serial total grows least; ties
  // keep list order and the lowest part number, so the split is deterministic.
  const totals = new Array(count).fill(0);
  const owner = new Map();
  const heaviest = files.map((file, position) => ({ file, position }))
    .sort((a, b) => weight(b.file) - weight(a.file) || a.position - b.position);
  for (const { file } of heaviest) {
    let best = 0;
    for (let part = 1; part < count; part++) if (totals[part] < totals[best]) best = part;
    totals[best] += weight(file);
    owner.set(file, best + 1);
  }
  const part = files.filter(file => owner.get(file) === index);
  if (!part.length) throw new Error('Invalid part: empty part');
  return part;
}

// The part choice arrives as ATLAS_B92_PART ("<index>/<count>"), set only by
// test/test.js from the CI launcher's validated --part, so no other suite
// ever sees a selection. Unset runs everything; malformed fails closed.
function partFromEnv(env = process.env) {
  const raw = env.ATLAS_B92_PART;
  if (raw === undefined) return null;
  const match = /^([1-9])\/([1-9])$/.exec(raw);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`Invalid ATLAS_B92_PART: ${JSON.stringify(raw)}`);
  }
  return { index: Number(match[1]), count: Number(match[2]) };
}

function runCase(c, active = SUITES) {
  console.log(`\n--- ${c.label} ---`);
  const original = fs.readFileSync(DATA);
  const result = withMutatedFixture(ROOT, c.mutate, fixture => {
    const failed = [];
    let asserts = 0;
    for (const file of active) {
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
  for (const name of c.allow.filter(name => active.includes(name))) {
    ok(expected.some(f => f.file === name),
      `${c.id}: live recon ${name} still bites when that fact moves`);
  }
  return { id: c.id, failed: result.failed.map(failureSummary), asserts: result.asserts };
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

const report = [];

// Execution happens only when this file is run (directly, or by test/test.js
// as the refresh-isolation group). Requiring it — as test-ci-split.js does to
// prove the parts cover every suite and case — must run nothing.
if (require.main === module) {
  let part = null;
  try { part = partFromEnv(); } catch (error) {
    console.log(`  FAIL  ${error.message}`);
    process.exit(1);
  }
  const active = part ? partSuites(SUITES, part.index, part.count) : SUITES;

  // A case child: run exactly one case, then report its own id, check count
  // and blast radius on one final line. Nothing else runs in the child.
  if (process.argv[2] === '--case') {
    const c = process.argv.length === 4 && CASES.find(x => x.id === process.argv[3]);
    if (!c) { console.log('  FAIL  unknown refresh-isolation case'); process.exit(1); }
    const entry = runCase(c, active);
    console.log(CASE_RESULT + JSON.stringify({ ...entry, failures }));
    process.exit(failures === 0 ? 0 : 1);
  }

  console.log(part
    ? `=== B92 refresh isolation — part ${part.index}/${part.count} (${active.length} of ${SUITES.length} suites per case) ===`
    : '=== B92 refresh isolation ===');
  const original = fs.readFileSync(DATA);
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
}

module.exports = { SUITES, CASES, PART_COUNT, partSuites, partFromEnv };

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
