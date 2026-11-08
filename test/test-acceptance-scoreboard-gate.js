'use strict';
/* The acceptance scoreboard's advisory gate. `node test/test-acceptance-scoreboard-gate.js`
 *
 * The scoreboard (scripts/acceptance-scoreboard.js) always exited 0 and ran in
 * no workflow, so a regression in an adopted acceptance scenario changed
 * nothing. This suite proves, without launching a browser:
 *   - --gate fails on an unmarked failing scenario, a check that failed to
 *     load, a partial run, an empty run and a bad option, and passes when every
 *     failure is marked expected-to-fail (a marked pass is not a failure);
 *   - --check is labelled a PARTIAL RUN and can never pass the gate;
 *   - the real CLI exits 1 under --gate and 0 without it on a run that finds
 *     nothing, so the default scoreboard behaviour is unchanged;
 *   - the advisory workflow runs the gate, privately, and fails on its result.
 * Synthetic check records only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { args, gateFailures, runLabel } = require('../scripts/acceptance-scoreboard.js');

const ROOT = path.join(__dirname, '..');
let failures = 0, checks = 0;
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (error) { failures++; console.error(`  FAIL  ${label}: ${error.message}`); }
}
const sc = (id, pass, fixedBy = null) => ({ id, name: 'synthetic ' + id, basis: 'spec', pass, fixedBy,
  reason: pass ? null : 'synthetic failure' });
const board = (...scenarios) => [{ check: 1, title: 'synthetic', scenarios }];
const ids = list => list.map(g => g.id);

check('every failure marked expected-to-fail, and a marked pass, keep the gate clear', () => {
  assert.deepEqual(gateFailures(board(sc('1.1', true), sc('1.2', false, 'A6 #726'), sc('1.3', true, 'C7'))), []);
});

check('an unmarked failing scenario fails the gate (a regression)', () => {
  assert.deepEqual(ids(gateFailures(board(sc('1.1', false), sc('1.2', false, 'A6 #726')))), ['1.1']);
});

check('a check that failed to load fails the gate', () => {
  assert.deepEqual(ids(gateFailures(board({ id: '3.?', name: 'check failed to load or run', pass: false,
    fixedBy: null, reason: 'error: synthetic' }))), ['3.?']);
});

check('a partial run, an empty run and an option error never pass the gate', () => {
  assert.deepEqual(ids(gateFailures(board(sc('1.1', true)), { partial: true })), ['run']);
  assert.deepEqual(ids(gateFailures([])), ['run']);
  assert.deepEqual(ids(gateFailures(board(sc('1.1', true)), { errors: ['unknown option --x'] })), ['options']);
});

check('options: --gate, --check n, and malformed or unknown options are reported', () => {
  const ok = args(['--gate', '--check', '2', '--verbose']);
  assert.equal(ok.gate, true); assert.equal(ok.check, 2); assert.deepEqual(ok.errors, []);
  assert.equal(args([]).gate, false); assert.equal(args([]).check, null);
  for (const bad of [['--check'], ['--check', 'x'], ['--check', '0'], ['--check', '-1'], ['--chek', '2']])
    assert(args(bad).errors.length >= 1, bad.join(' '));
});

check('--check is labelled a partial run; a full run carries no label', () => {
  assert.equal(runLabel({ check: null }, true), null);
  assert.match(runLabel({ check: 2 }, true), /^PARTIAL RUN: check 2 only/);
  assert.match(runLabel({ check: 9 }, false), /^PARTIAL RUN: check 9 does not exist/);
});

check('CLI: --gate exits 1 on a run that finds nothing; without --gate the scoreboard still exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoreboard-gate-'));
  try {
    const run = extra => spawnSync(process.execPath, ['scripts/acceptance-scoreboard.js', '--check', '999',
      '--json', path.join(dir, 'r.json'), ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const gated = run(['--gate']);
    assert.equal(gated.status, 1, gated.stdout + gated.stderr);
    assert.match(gated.stdout, /PARTIAL RUN: check 999 does not exist/);
    assert.match(gated.stdout, /Gate: FAIL/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
    assert.equal(report.partial, true);
    assert.deepEqual(report.checksRun, []);
    assert(report.gate.includes('run') && report.gate.includes('options'));
    assert.equal(run([]).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('workflow: the advisory job runs the full gate privately and fails on its result', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/acceptance-scoreboard.yml'), 'utf8')
    .split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(wf, /node scripts\/ci-output\.js --identity acceptance-scoreboard -- \\\n\s+node scripts\/acceptance-scoreboard\.js --gate --json/);
  assert.doesNotMatch(wf, /acceptance-scoreboard\.js[^\n]*--check/, 'the CI run is never partial');
  assert.doesNotMatch(wf, /--verbose|continue-on-error/);
  assert.match(wf, /exit "\$\{status\}"/);
  assert.match(wf, /playwright@\d+\.\d+\.\d+ /, 'Playwright is pinned to an exact version');
});

check('every scenario now marked expected-to-fail is still failing at its mark (no stale C7 mark on 1.10)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'test/acceptance/check-1.js'), 'utf8');
  const block = src.split("id: '1.10'")[1].split('async run')[0];
  assert.doesNotMatch(block, /fixedBy/);
});

console.log(`\n${checks - failures}/${checks} acceptance scoreboard gate checks passed.`);
process.exitCode = failures ? 1 : 0;
