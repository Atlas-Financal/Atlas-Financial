'use strict';
/* The financial publication correctness suite. `npm test`
 *
 * Runs every check that can be made without a password or a network, in
 * dependency order: syntax first (a broken file makes every later result
 * meaningless), then the engine, then the data it is fed, then the
 * contradictions between the two.
 *
 * An invariant failure is a FAILURE, not a warning. A financial plan that
 * disagrees with itself is worse than no plan, because it still looks
 * authoritative.
 *
 * Not run here, because they need something this process does not have:
 *   node test/test-local.js    needs TEST_PASSWORD and a running server
 *   node verify-live.js   needs the deployed site
 *
 * `test-production-live-overlay.js` starts a local server.js with synthetic
 * SITE_PASSWORD / SESSION_SECRET. Those are not production secrets.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
if (process.env.GITHUB_ACTIONS === 'true' || process.env.ATLAS_PUBLIC_CI === '1') {
  const failRunner = error => {
    try {
      const root = process.env.ATLAS_CI_DIAGNOSTICS_DIR || process.env.RUNNER_TEMP || os.tmpdir();
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const dir = fs.mkdtempSync(path.join(root, 'atlas-ci-runner-private-'));
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(path.join(dir, 'error.log'), String(error && error.stack || error), { mode: 0o600 });
    } catch { /* Reporting failure must not expose the original error. */ }
    fs.writeSync(2, JSON.stringify({ type: 'ci-runner-error', identity: 'test.js',
      status: 'fail', category: 'runner-failed', exitCode: 1 }) + '\n');
    process.exit(1);
  };
  process.on('uncaughtException', failRunner);
  process.on('unhandledRejection', failRunner);
}
const CiOutput = require('../scripts/ci-output');

const ROOT = path.join(__dirname, '..');

// Inert data shared with the independent public CI record relay.
const suites = require('./suites.json');


// Every top-level test/*.js file is either in the manifest in suites.json or listed
// here with the reason it is not run by `npm test`. test-ci-split.js compares
// this against the disk, so a new suite that nobody registers fails the
// required run instead of silently never executing. Adding a name here is a
// reviewed decision: a genuine regression suite belongs in the manifest.
// Subdirectories (test/lib, test/acceptance, test/browser, test/fixtures,
// test/proofs) hold helpers, fixtures and separately-run tools, not suites.
const NOT_SUITES = Object.freeze({
  'test.js': 'this runner',
  // Helpers and child-process workers, executed only through a registered suite.
  'test-helpers.js': 'shared helper module (required by registered suites)',
  'test-source-text.js': 'shared helper module (required by registered suites)',
  'app-escape-html.js': 'shared helper module: lifts escapeHtml from public/app.js for registered suites',
  'test-heloc-crossing-guard.js': 'matcher module required by test-heloc-crossing-authority.js and test-invariants.js',
  'test-confirmed-card-payment-transfer.js': 'executed in-process by test-card-purchase-coverage.js (require on line 2)',
  'test-assistant-standing-corrections.js': 'executed in-process by test-assistant-lunchmoney.js (require at its end)',
  'test-assistant-standing-store.js': 'executed in-process by test-assistant-standing-corrections.js (require at its end)',
  'test-assistant-standing-store-worker.js': 'subprocess worker spawned by test-assistant-standing-store.js',
  'atlas069-constructor-failure-driver.js': 'child driver spawned by test-server-observation-memory.js',
  'bills-period-end-legacy-comparison.js': 'helper module required by registered suites',
  'bad-full-load-legacy.js': 'helper module required by registered suites (full-load BAD frozen-engine comparisons)',
  'proof-source-binding.js': 'proof-provenance helper module required by proof and browser scripts',
  'test-savings-consumer-contract.js': 'Savings consumer contract cases module (pinned guard machinery), executed only through test-savings-consumer-contract-part-<n>.js',
  'refresh-concurrent-edit-preload.js': 'preload helper required by the b81 refresh/opening and payday-persist suites (#885), not a standalone suite',
  // Needs something `npm test` deliberately does not have.
  'test-local.js': 'needs TEST_PASSWORD and a running server (see header of this file)',
  'test-private-period-history-postgres-local.js': 'all-skip without ATLAS_PERIOD_HISTORY_LOCAL_PG_BIN; runs in .github/workflows/postgres-proofs.yml',
  'test-settlement-evidence-age-synthetic.js': 'all-skip without a provenance-verified official age binary; not run in CI',
  'test-rollback-qualification-harness.js': 'deliberately unregistered by its author (see its header): pins NOT QUALIFIED on current main, so it must change with the rollback fix (#718)',
  // Manual, argument-driven before/after proofs and optional visual QA.
  'probe-bills-period-end-preservation.js': 'manual comparison against a reviewer-supplied git baseline',
  'profile-refresh-evaluation.js': 'optional timing benchmark, not a correctness check',
  'proof-card-date-cache-latency.js': 'manual timing evidence, not a correctness check',
  'proof-card-purchase-posting.js': 'manual exact-base proof; requires a base SHA argument',
  'proof-savings-card-recipient-before-after.js': 'manual exact-release before/after proof',
  'proof-savings-future-closing-before-after.js': 'manual proof; requires a base checkout argument',
  'proof-savings-latest-known-allocation.js': 'manual exact-base/head proof',
  'proof-savings-observer-contract.js': 'manual proof; requires base SHA arguments',
  'proof-savings-selected-roster-before-after.js': 'manual exact-release before/after proof',
  'proof-travel-visa-annual-estimate.js': 'manual input proof that reads data.json; never part of the public suite',
  'render-budget-v3-browse-comparisons.js': 'optional visual QA renderer (Playwright, capture arguments)',
  'render-budget-v3-comparisons.js': 'optional visual QA renderer (Playwright, capture arguments)',
  'render-budget-v3-funding-month-comparisons.js': 'optional visual QA renderer (Playwright, capture arguments)',
  'render-chronological-savings-comparisons.js': 'optional visual QA renderer (Playwright, capture arguments)',
  'road-ahead-mutation-check.js': 'manual mutation check documented in docs/ROAD_AHEAD_PARTITION_RECONCILIATION.md',
});
// Browser suites need Chromium/Playwright and run outside the node manifest.
const NOT_SUITE_PREFIXES = Object.freeze({
  'browser-': 'Playwright browser suite; not run by the node manifest',
});

// Pure comparison of the top-level test/*.js listing against the manifest and
// the reviewed exclusions. Every list it returns must be empty.
function manifestCompleteness(diskFiles, manifest = suites, notSuites = NOT_SUITES,
  prefixes = NOT_SUITE_PREFIXES) {
  const registered = new Set(manifest.map(([, file]) => file));
  const disk = new Set(diskFiles.filter(file => file.endsWith('.js')));
  const prefixed = file => Object.keys(prefixes).some(prefix => file.startsWith(prefix));
  return {
    unregistered: [...disk].filter(file => !registered.has(file) &&
      !Object.prototype.hasOwnProperty.call(notSuites, file) && !prefixed(file)).sort(),
    staleExclusions: Object.keys(notSuites).filter(file => !disk.has(file)).sort(),
    excludedButRegistered: [...registered].filter(file =>
      Object.prototype.hasOwnProperty.call(notSuites, file) || prefixed(file)).sort(),
    missingReasons: Object.entries({ ...notSuites, ...prefixes })
      .filter(([, reason]) => typeof reason !== 'string' || !reason.trim()).map(([file]) => file).sort(),
  };
}

// One ordered manifest owns both the serial reference and the two CI groups.
// Do not glob: probe-savings-daily-allocation-incumbent.js is also a suite.
const ISOLATION_SUITE = 'test-refresh-isolation.js';
const GROUPS = Object.freeze(['standard', 'refresh-isolation']);
for (const suite of suites) Object.freeze(suite);
Object.freeze(suites);

function validateSuites(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('A suite selection must be nonempty');
  }
  const files = new Set();
  for (const row of manifest) {
    if (!Array.isArray(row) || row.length !== 2 ||
        typeof row[0] !== 'string' || !row[0].trim() ||
        typeof row[1] !== 'string' || !/^[a-z0-9-]+\.js$/.test(row[1])) {
      throw new Error('Invalid suite manifest entry');
    }
    if (files.has(row[1])) throw new Error(`Duplicate suite: ${row[1]}`);
    files.add(row[1]);
  }
}

function selectSuites(group = 'all', manifest = suites) {
  if (group !== 'all' && !GROUPS.includes(group)) {
    throw new Error(`Unknown suite group: ${group}`);
  }
  validateSuites(manifest);
  if (!manifest.some(([, file]) => file === ISOLATION_SUITE)) {
    throw new Error('The manifest must include the refresh-isolation suite');
  }
  const selected = manifest.filter(([, file]) => group === 'all' ||
    (group === 'refresh-isolation' ? file === ISOLATION_SUITE : file !== ISOLATION_SUITE));
  validateSuites(selected);
  return selected;
}

function selectionFromArgs(args) {
  if (args.length === 0) return selectSuites();
  if (args.length !== 2 || args[0] !== '--group') {
    throw new Error('Usage: node test/test.js [--group standard|refresh-isolation|all]');
  }
  return selectSuites(args[1]);
}

// Hosted CI splits the standard group across SHARD_COUNT parallel jobs
// (.github/workflows/test.yml), so the required `standard` check finishes
// sooner. The split is computed, never hand-listed: every standard suite lands
// in exactly one shard, including a suite added tomorrow, and each shard keeps
// manifest order. SHARD_SECONDS holds observed durations in seconds, used
// only to balance the shards; an unlisted suite counts as
// DEFAULT_SHARD_SECONDS. Re-measured 2026-11-09 (issue #821, Next up item 1):
// standalone local runs on Node 24.22.1 for 470 suites, scaled to hosted
// seconds by the hosted/local ratio on suites with trustworthy prior hints,
// plus hosted-log estimates for the four figures-coverage parts, whose old
// hints understated them (they set each shard's floor). A wrong or stale
// hint can only make one shard slower, never drop or repeat a suite
// (test-ci-split.js proves the partition).
const SHARD_COUNT = 6;
// Each shard runs its suites in a 4-way pool (scripts/ci-test.js STANDARD_JOBS).
const SHARD_LANES = 4;
const DEFAULT_SHARD_SECONDS = 5;
const SHARD_SECONDS = Object.freeze({
  'test-figures-coverage-part-4.js': 560,
  'test-figures-coverage-part-1.js': 540,
  'test-figures-coverage-part-2.js': 512,
  'test-figures-coverage-part-3.js': 350,
  'test-savings-consumer-contract-part-5.js': 190,
  'test-savings-consumer-contract-part-1.js': 180,
  'test-savings-consumer-contract-part-3.js': 175,
  'test-savings-consumer-contract-part-4.js': 175,
  'test-figures-snapshot-credit-planning.js': 171,
  'test-savings-capture-roster.js': 168,
  'test-nextmove.js': 165,
  'test-savings-consumer-contract-part-2.js': 160,
  'test-status-band.js': 158,
  'test-bill-settlement-identities.js': 119,
  'test-counterfactuals.js': 107,
  'test-assistant-routine-cleanup.js': 106,
  'test-cardcoverage-probe-reuse.js': 92,
  'test-savings-capture-fidelity.js': 89,
  'test-settlement-evidence-refresh-acquisition.js': 87,
  'test-savings-observer-contract.js': 78,
  'test-settlement-evidence-confirmation.js': 71,
  'test-server-observation-memory.js': 69,
  'test-budget-surface.js': 63,
  'test-salary-diagnostic-occurrences.js': 51,
  'test-invariants.js': 48,
  'test-salary-diagnostic-candidates.js': 34,
  'test-a12-acceptance-host-entry.js': 32,
  'test-ci-output.js': 30,
  'test-phoenix-digital-health-bill.js': 28,
  'test-live-refresh-coalescing.js': 26,
  'test-ci-split.js': 24,
  'test-savings-latest-known-allocation.js': 23,
  'test-assistant-interface.js': 22,
  'test-bill-late-posting-window.js': 22,
  'test-bill-near-due-merchant-identity.js': 22,
  'test-live-plan.js': 22,
  'test-live-unresolved-inbound.js': 22,
  'test-production-live-overlay.js': 22,
  'test-settlement-evidence-postgres-runtime.js': 22,
  'test-settlement-evidence-publication-gating.js': 22,
  'test-live-refresh-deadline.js': 20,
  'test-payment-thank-you-card-minimum.js': 20,
  'test-salary-matcher-diagnostic.js': 19,
  'test-waterfall-trust-unknown-word.js': 19,
  'test-card-minimum-settlement.js': 18,
  'test-dropped-row-category.js': 18,
  'test-bell-travelvisa-classification.js': 17,
  'test-settlement-production-host.js': 17,
  'test-bc-hydro-sep4-classification.js': 16,
  'test-bill-near-due-not-household.js': 16,
  'test-month-end-bill-reconciliation.js': 16,
  'test-savings-link-capture.js': 16,
  'test-atlas-077-malformed-amounts.js': 15,
  'test-card-payment-decisions.js': 15,
  'test-payday-boundary-observation-persist.js': 15,
  'test-running-build.js': 15,
  'test-savings-failed-refresh-evidence.js': 15,
  'test-settlement-evidence-server-seam.js': 14,
  'test-card-coverage-aggregate-rule.js': 13,
  'test-dale-gated-represented-settles.js': 13,
  'test-household-path.js': 13,
  'test-unplanned-bill-label-counted.js': 13,
  'test-dog-food-monthly-cadence.js': 12,
  'test-plan-calendar-waterfalls.js': 12,
  'test-savings-card-recipient.js': 12,
  'test-savings-item-ledger.js': 12,
  'test-savings-owner-confirmed-paid.js': 12,
  'test-settlement-evidence-http.js': 12,
  'test-card-purchase-coverage.js': 11,
  'test-card-refund-goal-allocations.js': 8,
  'test-payday-bank-eod-anchor.js': 11,
  'test-savings-earmarks-integration.js': 11,
  'test-coverage-forecast-withhold.js': 10,
  'test-private-period-history-completeness.js': 10,
  'test-settlement-evidence-resolver.js': 10,
  'test-amazon-prime-membership.js': 9,
  'test-b96-payday.js': 9,
  'test-bills-period-end-native-requirements.js': 9,
  'test-budget-pending-card-funding.js': 9,
  'test-card-backfill-intent.js': 9,
  'test-card-minimum-repair-conservation.js': 9,
  'test-pa4a2b-cash-terms-bridge.js': 9,
  'test-pending-card-bill-exact-amount.js': 9,
  'test-savings-dated-balance-item-liability.js': 9,
  'test-b81-opening-cutover.js': 8,
  'test-card-minimum-category.js': 8,
  'test-paid-actual-display-trust.js': 8,
  'test-savings-a4b-routing.js': 8,
  'test-savings-linked-refund-close.js': 8,
  'test-savings-payday-sweep-s1.js': 8,
  'test-bell-standing-bills-split.js': 7,
  'test-card-payment-diagnostic-dependencies.js': 7,
  'test-mission.js': 7,
  'test-private-period-history.js': 7,
  'test-r1-ready-path-card-protection.js': 7,
  'test-reported-savings-earmarks.js': 7,
  'test-unlinked-item-refund.js': 7,
  'test-automatic-payment-settlement.js': 6,
  'test-bell-same-account-split.js': 6,
  'test-bill-payment-excess.js': 6,
  'test-bills-period-end-negative-controls.js': 6,
  'test-bills-recorded-payment.js': 6,
  'test-budget-timeline-pay-periods.js': 6,
  'test-card-payment-decision-store.js': 6,
  'test-from-today-funding.js': 6,
  'test-from-today-integration.js': 6,
  'test-fuel-effective-target.js': 6,
  'test-planned-savings-clarity.js': 6,
  'test-privacy-guard.js': 6,
  'test-purpose-savings.js': 6,
  'test-savings-evidence.js': 6,
  'test-savings-paid-spend-once.js': 6,
  'test-weekly-cap.js': 6,
});

// A shard's estimated wall clock: its longest suite holds one lane for its
// whole run, and the rest share the other lanes. This keeps the longest
// suites apart and lightly loaded, since they set the floor of the whole check.
function shardEstimate(longest, total) {
  return longest + (total - longest) / (SHARD_LANES - 1);
}

function shardSuites(selection, index, count = SHARD_COUNT, seconds = SHARD_SECONDS) {
  validateSuites(selection);
  if (!Number.isInteger(count) || count < 1 || count > 9 ||
      !Number.isInteger(index) || index < 1 || index > count) {
    throw new Error('Invalid shard');
  }
  const weight = file => Object.prototype.hasOwnProperty.call(seconds, file)
    ? seconds[file] : DEFAULT_SHARD_SECONDS;
  // Longest first, each onto the shard whose estimate grows least; ties keep
  // manifest order and the lowest shard number, so the split is deterministic.
  const longest = new Array(count).fill(0);
  const totals = new Array(count).fill(0);
  const owner = new Map();
  const heaviest = selection.map(([, file], position) => ({ file, position }))
    .sort((a, b) => weight(b.file) - weight(a.file) || a.position - b.position);
  for (const { file } of heaviest) {
    const w = weight(file);
    let best = 0, bestEstimate = Infinity;
    for (let shard = 0; shard < count; shard++) {
      const estimate = shardEstimate(Math.max(longest[shard], w), totals[shard] + w);
      if (estimate < bestEstimate) { best = shard; bestEstimate = estimate; }
    }
    longest[best] = Math.max(longest[best], w);
    totals[best] += w;
    owner.set(file, best + 1);
  }
  const shard = selection.filter(([, file]) => owner.get(file) === index);
  validateSuites(shard); // an empty shard is a configuration error, never a green no-op
  return shard;
}

// `--shard <index>/<count>` is an optional suffix before any `--jobs`.
function shardFromArgs(args) {
  if (args.length >= 2 && args[args.length - 2] === '--shard') {
    const match = /^([1-9])\/([1-9])$/.exec(args[args.length - 1]);
    if (!match || Number(match[1]) > Number(match[2])) {
      throw new Error('Usage: --shard takes <index>/<count> with 1 <= index <= count <= 9');
    }
    return { shard: { index: Number(match[1]), count: Number(match[2]) }, rest: args.slice(0, -2) };
  }
  return { shard: null, rest: args };
}

function shardedSelectionFromArgs(args) {
  const { shard, rest } = shardFromArgs(args);
  const selection = selectionFromArgs(rest);
  if (!shard) return selection;
  if (rest.length !== 2 || rest[1] !== 'standard') throw new Error('--shard applies only to --group standard');
  return shardSuites(selection, shard.index, shard.count);
}

// `--part <index>/<count>` is an optional suffix before any `--jobs`. It
// selects one part of the refresh-isolation suite's own internal suite list
// (test-refresh-isolation.js splits its cases' suites across parallel jobs);
// the manifest selection itself never changes — the group stays exactly one
// suite file. The validated part is handed to that suite alone through
// ATLAS_B92_PART, set here, mirroring how the launcher keeps ATLAS_CI_SHARD
// and ATLAS_CI_PART themselves away from suites.
function partFromArgs(args) {
  if (args.length >= 2 && args[args.length - 2] === '--part') {
    const match = /^([1-9])\/([1-9])$/.exec(args[args.length - 1]);
    if (!match || Number(match[1]) > Number(match[2])) {
      throw new Error('Usage: --part takes <index>/<count> with 1 <= index <= count <= 9');
    }
    return { part: { index: Number(match[1]), count: Number(match[2]) }, rest: args.slice(0, -2) };
  }
  return { part: null, rest: args };
}

function selectionWithPartFromArgs(args) {
  const { part, rest } = partFromArgs(args);
  const selection = shardedSelectionFromArgs(rest);
  if (!part) return selection;
  if (rest.length !== 2 || rest[1] !== 'refresh-isolation') {
    throw new Error('--part applies only to --group refresh-isolation');
  }
  process.env.ATLAS_B92_PART = `${part.index}/${part.count}`;
  return selection;
}

// Synchronous execution is deliberate: suites mutate shared checkout files.
// The injected operations let the runner's failure contract be tested without
// launching financial suites or changing their assertion/cleanup semantics.
function runSuites(suites, { execute = execFileSync, exists = fs.existsSync,
  log = console.log, publicCI = CiOutput.publicMode() } = {}) {
  validateSuites(suites);
  const failed = [];
  let suiteOrdinal = 0;
  for (const [name, file] of suites) {
    const identity = CiOutput.suiteIdentity(file, ++suiteOrdinal);
    if (publicCI && identity.startsWith('suite-')) {
      CiOutput.publish({ identity, status: 'fail', category: 'invalid-configuration',
        exitCode: 1, signal: null, executed: false });
      failed.push(identity);
      continue;
    }
    if (!exists(path.join(__dirname, file))) {
      if (publicCI) {
        CiOutput.publish({ identity, status: 'fail', category: 'missing-suite',
          exitCode: 1, signal: null, executed: false });
        failed.push(file);
        continue;
      }
      log(`\n\x1b[31m✗\x1b[0m ${name} — ${file} is missing`);
      failed.push(name);
      continue;
    }
    if (publicCI) {
      CiOutput.startSuite(identity);
      const result = CiOutput.runCaptured(process.execPath, [path.join(__dirname, file)],
        { cwd: ROOT, identity: file });
      CiOutput.publish(result);
      if (result.status !== 'pass') failed.push(file);
      continue;
    }
    log(`\n\x1b[1m──────── ${name} ────────\x1b[0m`);
    try {
      execute(process.execPath, [path.join(__dirname, file)], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      failed.push(name);
    }
  }

  if (publicCI) {
    log(JSON.stringify({ type: 'ci-suite-summary', total: suites.length,
      passed: suites.length - failed.length, failed: failed.length,
      failedSuites: failed, exitCode: failed.length ? 1 : 0 }));
    return failed.length ? 1 : 0;
  }
  log('\n' + '═'.repeat(60));
  if (failed.length) {
    log(`\x1b[31mFAILED\x1b[0m — ${failed.length} of ${suites.length} suites: ${failed.join(', ')}`);
    return 1;
  }
  log(`\x1b[32mALL ${suites.length} SUITES PASSED\x1b[0m`);
  return 0;
}

// Optional bounded concurrency for the hosted CI record mode only. The serial
// reference above is untouched and remains `npm test`. Same suites, same
// processes, same per-suite capture: each suite still runs through
// scripts/ci-output.js, which keeps its streams in private files and reports
// one closed outcome record. Only the scheduling differs, and the public
// records are still emitted one suite at a time in manifest order, so the
// downstream record validator sees exactly the serial protocol.
//
// Start order is a hint, never a result: the slowest known suites start first
// so the wall clock is not set by one of them starting last.
const START_FIRST = Object.freeze([
  'test-figures-coverage-part-1.js', 'test-figures-coverage-part-2.js',
  'test-figures-coverage-part-3.js', 'test-figures-coverage-part-4.js',
  'test-savings-consumer-contract-part-1.js', 'test-savings-consumer-contract-part-2.js',
  'test-savings-consumer-contract-part-3.js', 'test-savings-consumer-contract-part-4.js',
  'test-savings-consumer-contract-part-5.js',
  'test-savings-capture-roster.js', 'test-figures-snapshot-credit-planning.js',
  'test-live-plan.js', 'test-nextmove.js', 'test-settlement-evidence-confirmation.js',
]);
// Suites that rewrite shared checkout state (found by tracing every suite's
// file writes): they run alone, before the pool starts, never beside another suite.
//  - test-running-build.js replaces the checkout's gitignored .atlas-build.json,
//    which every server.js started from the checkout reads.
const RUN_ALONE_FIRST = Object.freeze(['test-running-build.js']);
const MAX_JOBS = 16;

function jobsFromArgs(args) {
  if (args.length >= 2 && args[args.length - 2] === '--jobs') {
    if (!/^[1-9][0-9]?$/.test(args[args.length - 1]) || Number(args[args.length - 1]) > MAX_JOBS) {
      throw new Error('Usage: --jobs takes an integer from 1 to ' + MAX_JOBS);
    }
    return { jobs: Number(args[args.length - 1]), rest: args.slice(0, -2) };
  }
  return { jobs: 1, rest: args };
}

function spawnOutcomeWorker(file) {
  const { spawn } = require('child_process');
  return new Promise(resolve => {
    let out = '';
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/ci-output.js'),
      '--identity', file, '--cwd', ROOT, '--', process.execPath, path.join(__dirname, file)],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    // The long CPU-bound suites run at lower priority so they cannot starve the
    // short server-starting suites, which have fixed start and keep-alive
    // timeouts. Children inherit it; the suites are still all run, to completion.
    if (START_FIRST.includes(file)) { try { os.setPriority(child.pid, 10); } catch { /* best effort */ } }
    child.stdout.on('data', chunk => { if (out.length < 65536) out += chunk; });
    child.on('error', () => resolve({ out: '', code: null, signal: null }));
    child.on('close', (code, signal) => resolve({ out, code, signal }));
  });
}

// The worker's only stdout is the one outcome record scripts/ci-output.js
// publishes. Rebuild the record through CiOutput.publish's closed schema, and
// never trust a pass that the worker's own exit status contradicts.
function outcomeFromWorker(file, { out, code, signal }) {
  const failed = { identity: file, status: 'fail', category: 'capture-failed',
    exitCode: 1, signal: null, executed: false };
  const lines = out.split('\n').filter(Boolean);
  if (lines.length !== 1) return failed;
  let record;
  try { record = JSON.parse(lines[0]); } catch { return failed; }
  if (!record || record.type !== 'ci-outcome' || record.identity !== file) return failed;
  const result = { identity: file, status: record.status, category: record.category,
    exitCode: record.exitCode, signal: record.signal, executed: record.executed,
    syntheticProofVerified: record.syntheticProof ===
      'stdout-stderr-annotations-formatter-and-exit-canaries' };
  if (record.status === 'pass' && (code !== 0 || signal)) return failed;
  return result;
}

async function runSuitesPooled(suites, { jobs, exists = fs.existsSync, log = console.log,
  work = spawnOutcomeWorker } = {}) {
  validateSuites(suites);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS) throw new Error('Invalid job count');
  const plan = suites.map(([, file], index) => {
    const identity = CiOutput.suiteIdentity(file, index + 1);
    if (identity.startsWith('suite-')) return { file, identity, early: { identity, status: 'fail',
      category: 'invalid-configuration', exitCode: 1, signal: null, executed: false } };
    if (!exists(path.join(__dirname, file))) return { file, identity, early: { identity,
      status: 'fail', category: 'missing-suite', exitCode: 1, signal: null, executed: false } };
    return { file, identity, early: null };
  });
  // Bounded pool: at most `jobs` suite processes in flight, hinted suites first.
  const rank = file => { const i = START_FIRST.indexOf(file); return i < 0 ? START_FIRST.length : i; };
  const order = plan.map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.file) - rank(b.entry.file) || a.index - b.index);
  const done = plan.map(() => null);
  const waiters = plan.map(() => null);
  const finished = plan.map((_, i) => new Promise(resolve => { waiters[i] = resolve; }));
  async function execute({ entry, index }) {
    if (entry.early) { done[index] = entry.early; waiters[index](); return; }
    let result;
    try { result = outcomeFromWorker(entry.file, await work(entry.file)); }
    catch { result = outcomeFromWorker(entry.file, { out: '', code: null, signal: null }); }
    done[index] = result;
    waiters[index]();
  }
  const alone = order.filter(({ entry }) => RUN_ALONE_FIRST.includes(entry.file));
  const pooled = order.filter(({ entry }) => !RUN_ALONE_FIRST.includes(entry.file));
  let cursor = 0;
  async function lane() {
    while (cursor < pooled.length) await execute(pooled[cursor++]);
  }
  const scheduling = (async () => {
    for (const item of alone) await execute(item);
    await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, lane));
  })();
  const failed = [];
  for (let i = 0; i < plan.length; i++) {
    const { file, early } = plan[i];
    if (!early) CiOutput.startSuite(plan[i].identity);
    await finished[i];
    CiOutput.publish(done[i]);
    if (done[i].status !== 'pass') failed.push(file);
  }
  await scheduling;
  log(JSON.stringify({ type: 'ci-suite-summary', total: suites.length,
    passed: suites.length - failed.length, failed: failed.length,
    failedSuites: failed, exitCode: failed.length ? 1 : 0 }));
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  if (CiOutput.publicMode()) {
    // Let the installed privacy boundary handle selection/runner exceptions.
    // Catching and printing their raw message here would bypass that boundary.
    const { jobs, rest } = jobsFromArgs(process.argv.slice(2));
    const selection = selectionWithPartFromArgs(rest);
    if (jobs > 1) {
      runSuitesPooled(selection, { jobs }).then(code => { process.exitCode = code; });
    } else process.exitCode = runSuites(selection);
  } else try {
    const { jobs, rest } = jobsFromArgs(process.argv.slice(2));
    if (jobs > 1) throw new Error('--jobs requires the hosted CI record mode');
    process.exitCode = runSuites(selectionWithPartFromArgs(rest));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { suites, GROUPS, selectSuites, selectionFromArgs, runSuites,
  NOT_SUITES, NOT_SUITE_PREFIXES, manifestCompleteness,
  jobsFromArgs, runSuitesPooled, outcomeFromWorker, RUN_ALONE_FIRST,
  SHARD_COUNT, SHARD_SECONDS, DEFAULT_SHARD_SECONDS, shardSuites, shardFromArgs, shardedSelectionFromArgs,
  partFromArgs, selectionWithPartFromArgs };
