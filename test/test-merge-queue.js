'use strict';
/* Merge queue readiness. `node test/test-merge-queue.js`
 *
 * Under GitHub's merge queue the required checks must report on the queue
 * commit (main plus the queued PR). A required job that does not run there
 * leaves the queue waiting; a job that "passes" there without judging anything
 * would be a false green. This suite proves:
 *   - every required check named in docs/RISK_LABELS.md lives in a workflow
 *     that runs on merge_group, with no job-level condition that could skip it;
 *   - the group-ref helper identifies exactly one PR on main or refuses;
 *   - the primary-risk gate re-evaluates the live card and labels in the queue,
 *     read-only, and fails closed on a mismatch, a moved head or a bad ref.
 * The merge-card and privacy-guard queue paths are executed in
 * test-mergecard.js and test-privacy-guard.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseMergeGroupRef } = require('../scripts/merge-group-ref.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failures = 0;
function ok(cond, label, detail = '') {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ref = (n, sha) => `refs/heads/gh-readonly-queue/main/pr-${n}-${sha}`;

console.log('=== group ref identifies exactly one pull request on main ===');
{
  const good = parseMergeGroupRef(ref(870, HEAD), 'refs/heads/main');
  ok(good.ok && good.number === 870 && good.headSha === HEAD, 'a queue ref yields the PR number and head');
  ok(!parseMergeGroupRef(ref(870, HEAD), 'refs/heads/release').ok, 'a base other than main is refused');
  ok(!parseMergeGroupRef(ref(870, HEAD).replace('/main/', '/release/'), 'refs/heads/main').ok,
    'a ref built on another base is refused');
  ok(!parseMergeGroupRef(ref(0, HEAD), 'refs/heads/main').ok, 'PR number 0 is refused');
  ok(!parseMergeGroupRef(ref(870, HEAD.slice(1)), 'refs/heads/main').ok, 'a short SHA is refused');
  ok(!parseMergeGroupRef(ref(870, HEAD.toUpperCase()), 'refs/heads/main').ok, 'a non-canonical SHA is refused');
  ok(!parseMergeGroupRef(ref(870, HEAD) + '-x', 'refs/heads/main').ok, 'trailing text is refused');
  ok(!parseMergeGroupRef('', '').ok && !parseMergeGroupRef(undefined, undefined).ok, 'a missing ref is refused');
  const cli = spawnSync(process.execPath, ['scripts/merge-group-ref.js', ref(12, HEAD), 'refs/heads/main'],
    { cwd: ROOT, encoding: 'utf8' });
  ok(cli.status === 0 && cli.stdout.trim() === `12 ${HEAD}`, 'CLI prints "<number> <sha>"');
  const bad = spawnSync(process.execPath, ['scripts/merge-group-ref.js', 'refs/heads/feature', 'refs/heads/main'],
    { cwd: ROOT, encoding: 'utf8' });
  ok(bad.status === 1, 'CLI exits 1 on an unreadable ref');
}

console.log('\n=== every required check runs on the queue commit ===');
// The required contexts on main's ruleset (docs/RISK_LABELS.md, "Merge queue").
const REQUIRED = {
  'standard': ['test.yml', 'standard'],
  'refresh-isolation': ['test.yml', 'refresh-isolation'],
  'Merge card mechanical fields': ['merge-card-check.yml', 'check'],
  'Exactly one primary risk label': ['risk-label-gate.yml', 'primary-risk-label'],
  'Incumbent privacy guard': ['privacy-guard.yml', 'privacy-guard'],
};
const docs = read('docs/RISK_LABELS.md');
const queueSection = (docs.split(/^### Merge queue$/m)[1] || '').split(/^##+ /m)[0];
ok(queueSection.length > 0, 'docs/RISK_LABELS.md has a "Merge queue" section');
for (const [context, [file, jobId]] of Object.entries(REQUIRED)) {
  const src = read('.github/workflows/' + file);
  ok(/\non:\n[\s\S]*?\n  merge_group:\n    types: \[checks_requested\]\n/.test(src), `${file} runs on merge_group`);
  const job = (src.split(new RegExp(`\\n  ${jobId}:\\n`))[1] || '').split(/\n  [A-Za-z0-9_-]+:\n/)[0];
  ok(job.length > 0, `${file} defines job ${jobId}`);
  const name = /^    name: (.*)$/m.exec(job);
  ok((name ? name[1].trim() : jobId) === context, `job ${jobId} reports the required context "${context}"`);
  ok(!/^    if:/m.test(job), `job ${jobId} has no job-level condition that could skip it in the queue`);
  ok(!/^    needs:/m.test(job), `job ${jobId} does not depend on another job's outcome`);
  ok(queueSection.includes('`' + context + '`'), `the docs name "${context}" as a queue-required check`);
}
{
  // The Setup section must name the same contexts, so an owner following it
  // never requires a PR-only commit status the queue commit cannot report.
  const setup = (docs.split(/^## Setup$/m)[1] || '').split(/^## /m)[0];
  ok(Object.keys(REQUIRED).every(context => setup.includes('`' + context + '`')),
    'the Setup section names every queue-reported required check');
  ok(!/Add `tests`|Add[^.]*`risk-label\/primary`[^.]*required/.test(setup),
    'the Setup section no longer tells the owner to require PR-only commit statuses');
}
{
  const tests = read('.github/workflows/test.yml');
  ok(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(tests),
    'tests: only pull_request runs are cancelled by a newer push; queue runs never are');
  ok(/group: tests-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}/.test(tests),
    'tests: each queue run gets its own concurrency group');
  ok(/group: risk-label-gate-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.merge_group\.head_ref \}\}/
    .test(read('.github/workflows/risk-label-gate.yml')), 'risk-label: each merge group has its own concurrency group');
}

console.log('\n=== primary-risk gate in the queue: read-only re-evaluation ===');
const gateSrc = read('.github/workflows/risk-label-gate.yml');
const shell = gateSrc.split('        run: |\n')[1].split('\n')
  .map(line => line.replace(/^          /, '')).join('\n');
const body = primary => [
  '## Atlas Merge Card', '', '| Field | Value |', '|---|---|',
  '| **Title** | Example |', `| **Primary risk** | ${primary} |`, '',
  '### Atlas Contract / Systems Review', '', '- **Required**: NOT REQUIRED — docs only',
].join('\n');
function runGate({ primary = 'auto-safe', labels = ['auto-safe'], liveHead = HEAD, headRef = ref(42, HEAD),
  baseRef = 'refs/heads/main', eventName = 'merge_group', state = 'open' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-queue-gate-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({
    number: 42, state, merged: false, body: body(primary),
    base: { ref: 'main', repo: { full_name: 'synthetic/fixture' } }, head: { sha: liveHead },
  }));
  fs.writeFileSync(path.join(dir, 'labels.txt'), labels.map(l => l + '\n').join(''));
  // A stub `gh`: records every call; serves the PR and its labels; never writes.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$STUB_DIR/calls"',
    'case "$*" in',
    '  *--method*) exit 0 ;;',
    '  *issues/42/labels*) cat "$STUB_DIR/labels.txt" ;;',
    '  *pulls/42*) cat "$STUB_DIR/pr.json" ;;',
    '  *) exit 9 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o700 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, STUB_DIR: dir,
    RUNNER_TEMP: dir, ATLAS_CI_DIAGNOSTICS_DIR: dir, EVENT_NAME: eventName, EVENT_NUMBER: '', EVENT_HEAD: '',
    GROUP_HEAD_REF: headRef, GROUP_BASE_REF: baseRef,
    GITHUB_REPOSITORY: 'synthetic/fixture', GITHUB_SERVER_URL: 'https://example.test', GITHUB_RUN_ID: '1' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const child = spawnSync('bash', ['-c', shell], { cwd: ROOT, env, encoding: 'utf8' });
  const calls = fs.existsSync(path.join(dir, 'calls'))
    ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: child.status, calls };
}
{
  const pass = runGate();
  ok(pass.status === 0, 'card and label agree: the queue run is green', String(pass.status));
  ok(pass.calls.length > 0 && pass.calls.every(c => !/--method/.test(c)),
    'the queue run reads the live PR and labels and writes nothing', pass.calls.join(' | '));
  const mismatch = runGate({ primary: 'figures-moved', labels: ['auto-safe'] });
  ok(mismatch.status !== 0, 'card says figures-moved, label says auto-safe: the queue run fails');
  ok(mismatch.calls.every(c => !/--method/.test(c)), 'a mismatch is never repaired from the queue');
  ok(runGate({ labels: [] }).status !== 0, 'a missing label fails in the queue');
  ok(runGate({ liveHead: OTHER }).status !== 0, 'the PR head moved after queueing: fails closed');
  ok(runGate({ state: 'closed' }).status !== 0, 'a closed PR fails closed');
  const badRef = runGate({ headRef: 'refs/heads/agent/feature' });
  ok(badRef.status !== 0 && badRef.calls.length === 0, 'an unreadable group ref fails closed before any API call');
  ok(runGate({ baseRef: 'refs/heads/release' }).status !== 0, 'a group on another base fails closed');
  const unsupported = runGate({ eventName: 'push' });
  ok(unsupported.status !== 0 && unsupported.calls.length === 0, 'an unsupported event fails closed and writes nothing');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
