'use strict';
/* Mechanical coverage for live PR-head confirmation after an automation push.
 * `node test/test-github-pr-head-sync.js`
 *
 * Proves the helper, not a shell retry loop: stale previous-SHA reads may be
 * retried; unexpected heads, closed PRs, base/branch/identity changes, and a
 * bounded timeout fail closed; bookkeeping runs only after convergence, and
 * exactly once; replay against an already-live SHA is idempotent.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const sync = require('../scripts/atlas-github-pr-head-sync');
const gate = require('../scripts/atlas-cursor-repair-gate');

const HELPER = path.join(__dirname, '..', 'scripts/atlas-github-pr-head-sync.js');

let failures = 0;

function ok(cond, label, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const PREV = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function identity(overrides = {}) {
  return {
    repository: 'owner/atlas',
    prNumber: 55,
    headRef: 'cursor/example',
    baseRef: 'main',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  const head = overrides.head || {};
  const base = overrides.base || {};
  const rest = { ...overrides };
  delete rest.head;
  delete rest.base;
  return {
    number: 55,
    state: 'open',
    merged: false,
    body: '## 🟦 Atlas Merge Card\n',
    ...rest,
    base: {
      ref: base.ref || 'main',
      repo: { full_name: (base.repo && base.repo.full_name) || 'owner/atlas' },
    },
    head: {
      sha: head.sha || PUSHED,
      ref: head.ref || 'cursor/example',
      repo: { full_name: (head.repo && head.repo.full_name) || 'owner/atlas' },
    },
  };
}

function expected(overrides = {}) {
  return {
    expectedSha: PUSHED,
    previousSha: PREV,
    identity: identity(),
    ...overrides,
  };
}

function queueFetch(reads) {
  let index = 0;
  const fetchPr = () => {
    const current = reads[Math.min(index, reads.length - 1)];
    index += 1;
    fetchPr.calls += 1;
    return typeof current === 'function' ? current() : current;
  };
  fetchPr.calls = 0;
  return fetchPr;
}

function fakeClock(start = 0) {
  const clock = { nowMs: start, slept: [] };
  clock.now = () => clock.nowMs;
  clock.sleep = (ms) => {
    clock.slept.push(ms);
    clock.nowMs += ms;
  };
  return clock;
}

function trackingBookkeeping() {
  const state = {
    reviewPending: 0,
    repairRound: 0,
    readinessHandoff: 0,
    applied: { reviewPending: false, repairRound: false, readinessHandoff: false },
    order: [],
  };
  const bookkeeping = {
    reviewPending() {
      state.order.push('reviewPending');
      if (state.applied.reviewPending) return 'unchanged';
      state.applied.reviewPending = true;
      state.reviewPending += 1;
      return 'applied';
    },
    repairRound() {
      state.order.push('repairRound');
      if (state.applied.repairRound) return 'unchanged';
      state.applied.repairRound = true;
      state.repairRound += 1;
      return 'applied';
    },
    readinessHandoff() {
      state.order.push('readinessHandoff');
      if (state.applied.readinessHandoff) return 'unchanged';
      state.applied.readinessHandoff = true;
      state.readinessHandoff += 1;
      return 'applied';
    },
  };
  return { state, bookkeeping };
}

console.log('=== helper constants stay bounded ===');
ok(sync.DEFAULT_TIMEOUT_MS > 0 && sync.DEFAULT_TIMEOUT_MS <= 30000,
  'default poll window is short and bounded', String(sync.DEFAULT_TIMEOUT_MS));
ok(sync.DEFAULT_INTERVAL_MS > 0 && sync.DEFAULT_INTERVAL_MS < sync.DEFAULT_TIMEOUT_MS,
  'poll interval is positive and shorter than the window');
ok(JSON.stringify(sync.BOOKKEEPING_ACTIONS) === JSON.stringify([
  'reviewPending', 'repairRound', 'readinessHandoff',
]), 'named bookkeeping actions are the three post-push dependents');

console.log('\n=== immediate head convergence succeeds ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const clock = fakeClock();
  const fetchPr = queueFetch([snapshot()]);
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    bookkeeping,
  });
  ok(result.ok && result.code === 'converged', 'first live read of the pushed SHA succeeds', result.code);
  ok(result.attempts === 1, 'converged on the first read');
  ok(clock.slept.length === 0, 'no sleep when the live head is already the pushed SHA');
  ok(result.bookkeeping.invoked === true && result.bookkeeping.count === 1,
    'bookkeeping runs exactly once after immediate convergence');
  ok(state.reviewPending === 1 && state.repairRound === 1 && state.readinessHandoff === 1,
    'all three bookkeeping actions apply once');
  ok(result.mutate === true, 'convergence permits mutation');
}

console.log('\n=== stale old head for several reads then expected SHA succeeds ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const clock = fakeClock();
  const stale = snapshot({ head: { sha: PREV } });
  const live = snapshot({ head: { sha: PUSHED } });
  const fetchPr = queueFetch([stale, stale, stale, live]);
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 5000,
    intervalMs: 250,
    bookkeeping,
  });
  ok(result.ok && result.code === 'converged', 'stale previous SHA then pushed SHA succeeds', result.code);
  ok(fetchPr.calls === 4, 'three stale reads then one matching read', `calls=${fetchPr.calls}`);
  ok(clock.slept.length === 3, 'sleeps only between stale retries');
  ok(state.reviewPending === 1 && state.repairRound === 1 && state.readinessHandoff === 1,
    'bookkeeping still runs exactly once after delayed convergence');
  ok(JSON.stringify(state.order) === JSON.stringify(sync.BOOKKEEPING_ACTIONS),
    'bookkeeping order is review block, repair round, then readiness/handoff');
}

console.log('\n=== bounded timeout fails closed ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const clock = fakeClock();
  const fetchPr = queueFetch([snapshot({ head: { sha: PREV } })]);
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 1000,
    intervalMs: 250,
    bookkeeping,
  });
  ok(!result.ok && result.code === 'timeout', 'stale previous SHA until the deadline fails closed', result.code);
  ok(result.mutate === false, 'timeout does not permit mutation');
  ok(clock.nowMs >= 1000, 'clock reached the bounded deadline', `now=${clock.nowMs}`);
  ok(result.bookkeeping.invoked === false && result.bookkeeping.count === 0,
    'timeout does not invoke bookkeeping');
  ok(state.reviewPending === 0 && state.repairRound === 0 && state.readinessHandoff === 0,
    'timeout leaves review block, repair marker, and readiness untouched');
}

console.log('\n=== each fetch receives the remaining confirmation deadline ===');
{
  const clock = fakeClock();
  const remainings = [];
  const fetchPr = (_attempts, remainingMs) => {
    remainings.push(remainingMs);
    return snapshot({ head: { sha: PREV } });
  };
  const result = sync.waitForLivePrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 1000,
    intervalMs: 250,
  });
  ok(!result.ok && result.code === 'timeout', 'still fails closed at the deadline', result.code);
  ok(JSON.stringify(remainings) === JSON.stringify([1000, 750, 500, 250, 0]),
    'each GitHub fetch is given only the time left in the window', JSON.stringify(remainings));
}

console.log('\n=== fetch timeout is confirmation timeout, not a generic fetch failure ===');
{
  const timedOut = new Error('stalled');
  timedOut.code = 'ETIMEDOUT';
  const timeout = sync.waitForLivePrHead({
    ...expected(),
    fetchPr: () => { throw timedOut; },
    now: () => 0,
    sleep: () => {},
    timeoutMs: 1000,
  });
  ok(timeout.code === 'timeout' && timeout.mutate === false,
    'spawnSync ETIMEDOUT is the bounded confirmation timeout', timeout.code);
  const failed = sync.waitForLivePrHead({
    ...expected(),
    fetchPr: () => { throw new Error('network down'); },
    now: () => 0,
    sleep: () => {},
    timeoutMs: 1000,
  });
  ok(failed.code === 'fetch-failed' && failed.mutate === false,
    'non-timeout fetch errors stay fetch-failed', failed.code);
}

console.log('\n=== stalling gh child is killed at the remaining deadline ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pr-head-gh-'));
  const ghPath = path.join(tmp, 'gh');
  fs.writeFileSync(ghPath, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`);
  fs.chmodSync(ghPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${origPath}`;
  const started = Date.now();
  let result;
  try {
    result = sync.waitForLivePrHead({
      ...expected(),
      fetchPr: (_attempts, remainingMs) => sync.fetchPrViaGh('owner/atlas', 55, remainingMs),
      timeoutMs: 400,
      intervalMs: 50,
    });
  } finally {
    process.env.PATH = origPath;
  }
  const elapsed = Date.now() - started;
  ok(result && result.code === 'timeout',
    'a stalled gh api is classified as confirmation timeout', result && result.code);
  ok(result && result.mutate === false, 'a stalled gh api does not permit mutation');
  ok(elapsed < 5000, 'confirmation returns before the stalled child would have exited',
    `elapsed=${elapsed}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n=== unexpected third SHA fails closed ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const clock = fakeClock();
  const fetchPr = queueFetch([snapshot({ head: { sha: OTHER } })]);
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 5000,
    intervalMs: 250,
    bookkeeping,
  });
  ok(!result.ok && result.code === 'unexpected-head', 'a third SHA fails closed immediately', result.code);
  ok(result.attempts === 1 && clock.slept.length === 0, 'unexpected head is not retried');
  ok(state.reviewPending === 0 && state.repairRound === 0 && state.readinessHandoff === 0,
    'unexpected head does not mutate bookkeeping');
}

console.log('\n=== unexpected SHA after stale reads fails closed immediately ===');
{
  const clock = fakeClock();
  const fetchPr = queueFetch([
    snapshot({ head: { sha: PREV } }),
    snapshot({ head: { sha: OTHER } }),
  ]);
  const result = sync.waitForLivePrHead({
    ...expected(),
    fetchPr,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 5000,
    intervalMs: 250,
  });
  ok(!result.ok && result.code === 'unexpected-head',
    'a later unexpected SHA while waiting fails closed', result.code);
  ok(result.attempts === 2, 'the unexpected read is the second attempt');
  ok(clock.slept.length === 1, 'no further sleep after the unexpected SHA');
}

console.log('\n=== closed PR fails closed ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const clock = fakeClock();
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([snapshot({ state: 'closed', head: { sha: PREV } })]),
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 5000,
    bookkeeping,
  });
  ok(!result.ok && result.code === 'pr-closed', 'a closed PR fails closed immediately', result.code);
  ok(clock.slept.length === 0, 'closed PR is not retried as a stale previous SHA');
  ok(state.reviewPending === 0 && state.repairRound === 0,
    'closed PR does not write PENDING or a repair-round marker');
}

console.log('\n=== changed base fails closed ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([snapshot({ base: { ref: 'develop' }, head: { sha: PREV } })]),
    now: () => 0,
    sleep: () => {},
    timeoutMs: 5000,
    bookkeeping,
  });
  ok(!result.ok && result.code === 'base-changed', 'base moving off main fails closed', result.code);
  ok(state.reviewPending === 0 && state.repairRound === 0 && state.readinessHandoff === 0,
    'changed base does not mutate bookkeeping');
}

console.log('\n=== branch or identity change fails closed ===');
ok(sync.classifyLivePrHeadRead(
  snapshot({ head: { sha: PREV, ref: 'other-branch' } }),
  expected(),
).code === 'branch-changed', 'PR branch change fails closed');
ok(sync.classifyLivePrHeadRead(
  snapshot({ number: 99, head: { sha: PREV } }),
  expected(),
).code === 'identity-changed', 'PR number change fails closed');
ok(sync.classifyLivePrHeadRead(
  snapshot({
    head: { sha: PREV },
    base: { repo: { full_name: 'other/repo' } },
  }),
  expected(),
).code === 'identity-changed', 'repository identity change fails closed');
ok(sync.classifyLivePrHeadRead(
  snapshot({ head: { sha: PREV, repo: { full_name: 'fork/atlas' } } }),
  expected(),
).code === 'identity-changed', 'head repository identity change fails closed');

console.log('\n=== no review-block mutation occurs before convergence ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const fetches = [];
  const fetchPr = () => {
    const live = fetches.length < 2
      ? snapshot({ head: { sha: PREV } })
      : snapshot({ head: { sha: PUSHED } });
    fetches.push({
      sha: live.head.sha,
      pending: state.reviewPending,
      marker: state.repairRound,
      readiness: state.readinessHandoff,
    });
    return live;
  };
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr,
    now: fakeClock().now,
    sleep: () => {},
    timeoutMs: 5000,
    intervalMs: 0,
    bookkeeping,
  });
  ok(result.ok, 'eventually converges after stale reads');
  ok(fetches[0].pending === 0 && fetches[1].pending === 0,
    'review-block PENDING is not written on stale reads');
  ok(fetches.every((read) => read.marker === 0 && read.readiness === 0),
    'repair-round and readiness markers stay unset until convergence');
  ok(state.reviewPending === 1, 'PENDING is written after the matching live head');
}

console.log('\n=== no repair-round marker is persisted before convergence ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([snapshot({ head: { sha: OTHER } })]),
    now: () => 0,
    sleep: () => {},
    bookkeeping,
  });
  ok(state.repairRound === 0, 'unexpected head does not persist a repair-round marker');
  const timeout = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([snapshot({ head: { sha: PREV } })]),
    now: fakeClock().now,
    sleep: fakeClock().sleep,
    timeoutMs: 0,
    intervalMs: 250,
    bookkeeping,
  });
  ok(timeout.code === 'timeout' && state.repairRound === 0,
    'timeout after a stale previous SHA still does not persist the marker');
}

console.log('\n=== after convergence bookkeeping occurs exactly once ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const result = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([
      snapshot({ head: { sha: PREV } }),
      snapshot({ head: { sha: PREV } }),
      snapshot({ head: { sha: PUSHED } }),
    ]),
    now: fakeClock().now,
    sleep: () => {},
    timeoutMs: 5000,
    intervalMs: 0,
    bookkeeping,
  });
  ok(result.ok && result.bookkeeping.count === 1, 'one confirmation invokes bookkeeping once');
  ok(state.reviewPending === 1 && state.repairRound === 1 && state.readinessHandoff === 1,
    'each named action mutates once');
  ok(state.order.filter((name) => name === 'reviewPending').length === 1
    && state.order.filter((name) => name === 'repairRound').length === 1
    && state.order.filter((name) => name === 'readinessHandoff').length === 1,
    'no named action is repeated inside a single confirmation');
}

console.log('\n=== replay after the SHA is already live is idempotent ===');
{
  const { state, bookkeeping } = trackingBookkeeping();
  const live = snapshot({ head: { sha: PUSHED } });
  const first = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([live]),
    now: () => 0,
    sleep: () => {},
    bookkeeping,
  });
  const second = sync.confirmPushedPrHead({
    ...expected(),
    fetchPr: queueFetch([live]),
    now: () => 0,
    sleep: () => {},
    bookkeeping,
  });
  ok(first.ok && second.ok, 'replay against an already-live SHA still succeeds');
  ok(first.bookkeeping.results.reviewPending === 'applied'
    && second.bookkeeping.results.reviewPending === 'unchanged',
    'review-block PENDING is not rewritten on replay');
  ok(first.bookkeeping.results.repairRound === 'applied'
    && second.bookkeeping.results.repairRound === 'unchanged',
    'repair-round marker is not rewritten on replay');
  ok(first.bookkeeping.results.readinessHandoff === 'applied'
    && second.bookkeeping.results.readinessHandoff === 'unchanged',
    'readiness/handoff state is not rewritten on replay');
  ok(state.reviewPending === 1 && state.repairRound === 1 && state.readinessHandoff === 1,
    'replay does not double-apply any bookkeeping mutation');
}

console.log('\n=== classify CLI closed forms ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pr-head-sync-'));
  const snapFile = path.join(tmp, 'snapshot.json');
  const expectedFile = path.join(tmp, 'expected.json');
  fs.writeFileSync(expectedFile, JSON.stringify(expected()));
  const run = (snap) => {
    fs.writeFileSync(snapFile, JSON.stringify(snap));
    return spawnSync(process.execPath, [HELPER, 'classify', snapFile, expectedFile], { encoding: 'utf8' });
  };
  const converged = run(snapshot());
  ok(converged.status === 0 && /"code": "converged"/.test(converged.stdout),
    'classify CLI exits 0 on the pushed SHA');
  const stale = run(snapshot({ head: { sha: PREV } }));
  ok(stale.status === 2 && /"code": "stale-previous"/.test(stale.stdout),
    'classify CLI exits 2 for a retryable previous SHA');
  const unexpected = run(snapshot({ head: { sha: OTHER } }));
  ok(unexpected.status === 1 && /"code": "unexpected-head"/.test(unexpected.stdout),
    'classify CLI exits 1 for an unexpected SHA');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n=== exact-head helper is still the comparison ===');
ok(gate.isExactCurrentHead(PUSHED, PUSHED), 'exact-head equality remains the success predicate');
ok(!gate.isExactCurrentHead(PUSHED, PREV), 'exact-head still distinguishes the previous SHA');
ok(!gate.isExactCurrentHead(PUSHED, OTHER), 'exact-head still distinguishes a third SHA');

console.log('\n=== repair gate script withholds automatic pushes ===');
{
  const privacy = require('../scripts/ci-repair-privacy');
  const review = { id: 9, user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: PUSHED, body: 'Synthetic bounded finding.', submitted_at: '2041-07-09' };
  const calls = [];
  const result = privacy.run('codex-review', { GITHUB_REPOSITORY: 'owner/atlas',
    EVENT_NAME: 'workflow_dispatch', DISPATCH_PR: '55', DEFAULT_BRANCH: 'main' }, {
    api(route, request = {}) {
      calls.push({ route, request });
      if (request.method && request.method !== 'GET') throw new Error('unexpected mutation');
      if (route.endsWith('/pulls/55')) return snapshot();
      if (route.endsWith('/reviews')) return [review];
      if (route.endsWith('/reviews/9')) return review;
      if (route.endsWith('/comments')) return [];
      throw new Error('unexpected synthetic API route');
    },
    dispatch() { throw new Error('unexpected dispatch'); },
  });
  ok(result.exitCode === 78 && result.code === 'private-artifact-blocked',
    'eligible repair is withheld before any automatic push');
  ok(calls.every(call => !call.request.method || call.request.method === 'GET'),
    'withheld repair writes no PENDING, repair-round marker or bookkeeping');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
