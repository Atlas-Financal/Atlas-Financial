'use strict';
/* Public CI names the failing node:test subtests of a failing suite, and
 * nothing else from its output.
 *
 * Invented fixture suites only, in a temporary copy of the CI scripts. The
 * planted values (PLANTED_FIGURE, the 4-digit literal) stand in for figures
 * a real assertion message or a runtime-built name could carry; none may
 * reach the public stream.
 *
 *   node test/test-ci-failing-subtest-names.js
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Capture = require('../scripts/ci-output');

const ROOT = path.join(__dirname, '..');
const PLANTED = 'PLANTED_FIGURE 947.31';
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (c, label) => { assert.ok(c, label); checks++; };
const lines = text => text.trim().split('\n').filter(Boolean);
const records = text => lines(text).filter(l => l.startsWith('{')).map(l => JSON.parse(l));

// 1. The name rule, on hand-written TAP. A name is kept only when it is a
// literal in the suite source and has no amount-, date- or time-like digits.
{
  const source = "test('RA-1 literal name fails'); test('literal 1234 amount'); test('at 10:30');"
    + " test('rate .5 off'); test('" + 'x'.repeat(90) + "');";
  const tap = ['TAP version 13', 'not ok 1 - RA-1 literal name fails', '  ---',
    "  error: '" + PLANTED + "'", '  stack: |-', '    at Object.<anonymous> (/x/test.js:1:1)', '  ...',
    'not ok 2 - built 947.31 at runtime', 'not ok 3 - literal 1234 amount', 'not ok 4 - at 10:30',
    'not ok 5 - rate .5 off', 'not ok 6 - todo case # TODO later', 'ok 7 - passes',
    '    not ok 1 - RA-1 literal name fails', 'not ok 8 - ' + 'x'.repeat(90)].join('\n');
  eq(Capture.failedSubtestNames(tap, source), ['RA-1 literal name fails', '[redacted]', 'x'.repeat(80)],
    'literal names kept once, runtime or digit-bearing names redacted, TODO skipped, long names clipped');
  eq(Capture.failedSubtestNames('not ok 1 - a\n', ''), ['[redacted]'], 'a name absent from source is redacted');
  const many = Array.from({ length: 15 }, (_, i) => 'not ok ' + (i + 1) + ' - n' + String.fromCharCode(97 + i)).join('\n');
  const manySource = Array.from({ length: 15 }, (_, i) => "'n" + String.fromCharCode(97 + i) + "'").join(' ');
  eq(Capture.failedSubtestNames(many, manySource).length, 10, 'at most ten names');
  eq(Capture.failedSubtestNames('ok 1 - fine\n', "'fine'"), [], 'a passing run yields no names');
}

// 2. End to end, through the exact CI entry point (ci-test.sh: launcher, pooled
// runner, capture, independent records sink), on invented fixture suites.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ci-names-'));
try {
  const root = path.join(dir, 'fixture'), diagnostics = path.join(dir, 'private');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['ci-output.js', 'ci-test.js', 'ci-test-records.js', 'ci-test.sh'])
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(root, 'scripts', file));
  fs.copyFileSync(path.join(__dirname, 'test.js'), path.join(root, 'test/test.js'));
  const failing = [
    "const test = require('node:test'); const assert = require('assert');",
    'const amount = ' + JSON.stringify(PLANTED) + ';',
    "test('RA-1 literal name fails', () => { assert.strictEqual(1, 2, amount); });",
    'test(`built ${amount}`, () => { throw new Error(amount); });',
    "test('literal 1234 amount', () => { assert.deepEqual({ v: 1234 }, { v: amount }); });",
    "test('a passing neighbour', () => {});",
  ].join('\n');
  const passing = "const test = require('node:test'); test('all fine', () => { console.log("
    + JSON.stringify(PLANTED) + '); });';
  fs.writeFileSync(path.join(root, 'test/test-fixture-names-fail.js'), failing);
  fs.writeFileSync(path.join(root, 'test/test-fixture-names-pass.js'), passing);
  fs.writeFileSync(path.join(root, 'test/test-refresh-isolation.js'), passing);
  fs.writeFileSync(path.join(root, 'test/suites.json'), JSON.stringify([
    ['invented failing', 'test-fixture-names-fail.js'], ['invented passing', 'test-fixture-names-pass.js'],
    ['invented isolation', 'test-refresh-isolation.js']]));
  const env = { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: diagnostics, GITHUB_ACTIONS: 'true' };
  delete env.ATLAS_CI_SHARD; delete env.ATLAS_CI_PART;
  const forbidden = out => !out.includes('947') && !out.includes('PLANTED') && !out.includes('1234')
    && !/AssertionError|Error:|\bat .*\.js|expected|actual/.test(out);

  const shell = spawnSync('bash', ['--noprofile', '--norc', 'scripts/ci-test.sh', 'standard'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.ifError(shell.error);
  eq(shell.status, 1, 'the failing suite keeps the job red');
  eq(shell.stderr, '', 'nothing reaches public stderr');
  ok(forbidden(shell.stdout), 'no assertion message, value, diff or stack reaches public stdout');
  const outcomes = records(shell.stdout).filter(r => r.type === 'ci-outcome');
  const fail = outcomes.find(r => r.identity === 'test-fixture-names-fail.js');
  const pass = outcomes.find(r => r.identity === 'test-fixture-names-pass.js');
  eq(fail.status, 'fail', 'failing suite reported as failing');
  eq(fail.failedSubtests, ['RA-1 literal name fails', '[redacted]'],
    'the literal failing name is shown; the runtime-built and digit-bearing names are redacted');
  ok(!fail.failedSubtests.includes('a passing neighbour'), 'passing subtests are not named');
  eq(Object.keys(pass).sort(), ['category', 'counts', 'executed', 'exitCode', 'identity', 'signal', 'status', 'type'],
    'a passing suite publishes nothing new');
  ok(lines(shell.stdout).every(l => l.startsWith('{') || l.startsWith('::error title=Failed suites::')),
    'every public line is a record or the incumbent suite-name annotation');

  // The serial runner path (no --jobs) carries the same names.
  const serial = spawnSync(process.execPath, ['test/test.js', '--group', 'standard'],
    { cwd: root, env: { ...env, ATLAS_PUBLIC_CI: '1' }, encoding: 'utf8', timeout: 60000 });
  ok(forbidden(serial.stdout) && forbidden(serial.stderr), 'serial path: nothing private reaches the streams');
  eq(records(serial.stdout).find(r => r.identity === 'test-fixture-names-fail.js' && r.type === 'ci-outcome').failedSubtests,
    ['RA-1 literal name fails', '[redacted]'], 'serial path: same names');

  // 3. The records sink re-checks names on its own: a name not in the suite
  // source becomes [redacted]; names on a passing record are refused.
  const sink = input => spawnSync(process.execPath, ['scripts/ci-test-records.js', 'standard'], { cwd: root,
    env: { ...process.env, ATLAS_CI_BOOTSTRAP_DIR: fs.mkdtempSync(path.join(dir, 'sink-')) },
    input: input.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 10000 });
  const start = { type: 'ci-suite-start', identity: 'test-fixture-names-fail.js' };
  const base = { type: 'ci-outcome', identity: 'test-fixture-names-fail.js', status: 'fail',
    category: 'assertion-failed', exitCode: 1, signal: null, executed: true, counts: { total: 1, passed: 0, failed: 1 } };
  const forged = sink([start, { ...base, failedSubtests: ['RA-1 literal name fails', 'smuggled name', 'smuggled 947', PLANTED, 7] }]);
  ok(forbidden(forged.stdout), 'sink: a forged name never passes through');
  eq(records(forged.stdout).find(r => r.type === 'ci-outcome').failedSubtests,
    ['RA-1 literal name fails', '[redacted]', '[redacted]', '[redacted]', '[redacted]'], 'sink: only source literals survive');
  const onPass = sink([start, { ...base, status: 'pass', category: 'none', exitCode: 0,
    counts: { total: 1, passed: 1, failed: 0 }, failedSubtests: ['RA-1 literal name fails'] }]);
  ok(!records(onPass.stdout).some(r => r.type === 'ci-outcome'), 'sink: names on a passing record are refused');
  eq(records(onPass.stdout).at(-1).category, 'invalid-record', 'sink: the refusal turns the run red');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(`test-ci-failing-subtest-names: ${checks} checks passed`);
