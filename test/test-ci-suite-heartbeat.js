'use strict';
// A long suite shows it is still running in public CI, and says nothing else.
// `node test/test-ci-suite-heartbeat.js`
//
// On 2026-11-22 a merge-group shard was cancelled by hand while
// test-figures-coverage-part-4.js ran for 12 to 15 minutes with no public
// output: it looked hung. The pooled runner (test/test.js runSuitesPooled) now
// writes a heartbeat record while a suite's outcome is awaited, carrying only
// the suite's manifest identity and the whole seconds since its start record
// (scripts/ci-output.js heartbeat). The independent records sink
// (scripts/ci-test-records.js) accepts it only for the running suite, with
// strictly increasing seconds, and rebuilds it from those two fields alone. The
// standard shard job also has a timeout, so a truly hung shard fails on its own.
//
// Failure it detects: a heartbeat that carries any field beyond identity and
// seconds, or child text; a heartbeat for a suite that is not running, or out
// of order, passing the sink; a long suite with no heartbeat; a shard job
// without a timeout. Release decision: any failure blocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CANARY = 'SYNTHETIC_HEARTBEAT_PRIVATE_7731.29';
let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('  ok ' + name); }
const records = text => String(text).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
// A real manifest suite, so the identity is one the sink and the module accept.
const SUITE = 'test-ci-suite-heartbeat.js';
const OTHER = 'test-ci-output.js';

console.log('=== CI suite heartbeat: progress without content ===');

check('the module writes exactly { type, identity, elapsedSeconds } and refuses anything else', () => {
  const run = args => spawnSync(process.execPath, ['-e',
    `const C=require(${JSON.stringify(path.join(ROOT, 'scripts/ci-output.js'))});try{C.heartbeat(...${JSON.stringify(args)});}catch(e){process.stdout.write('REFUSED '+e.message+'\\n');}`],
  { cwd: ROOT, encoding: 'utf8' });
  const good = run([SUITE, 120]);
  assert.deepEqual(records(good.stdout), [{ type: 'ci-suite-heartbeat', identity: SUITE, elapsedSeconds: 120 }]);
  for (const bad of [[SUITE, 0], [SUITE, 1.5], [SUITE, -3], [SUITE, 86401], [SUITE, '120'],
    ['test-not-a-real-suite.js', 120], ['../package.json', 120], [CANARY, 120], [SUITE, null]]) {
    const out = run(bad).stdout;
    assert.match(out, /^REFUSED invalid-ci-(heartbeat|identity)\n$/, JSON.stringify(bad));
    assert.ok(!out.includes(CANARY));
  }
});

// The independent sink, fed records on stdin as the launcher would.
function sink(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-heartbeat-sink-'));
  try {
    return spawnSync(process.execPath, ['scripts/ci-test-records.js', 'standard'], { cwd: ROOT,
      env: { ...process.env, ATLAS_CI_BOOTSTRAP_DIR: dir },
      input: input.map(r => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8', timeout: 10000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const start = id => ({ type: 'ci-suite-start', identity: id });
const beat = (id, s, extra) => ({ type: 'ci-suite-heartbeat', identity: id, elapsedSeconds: s, ...extra });
const outcome = id => ({ type: 'ci-outcome', identity: id, status: 'pass', category: 'none', exitCode: 0,
  signal: null, executed: true, counts: { total: 1, passed: 1, failed: 0 } });
const summary = n => ({ type: 'ci-suite-summary', total: n, passed: n, failed: 0, failedSuites: [], exitCode: 0 });
const worker = { type: 'ci-worker-outcome', identity: 'standard', status: 'pass', category: 'none', exitCode: 0, signal: null };
const terminal = out => records(out.stdout).at(-1);

check('the sink republishes a running suite\'s heartbeats from identity and seconds alone', () => {
  const out = sink([start(SUITE), beat(SUITE, 120), beat(SUITE, 240, { message: CANARY, stdout: CANARY, value: 5521.47 }),
    outcome(SUITE), summary(1), worker]);
  const beats = records(out.stdout).filter(r => r.type === 'ci-suite-heartbeat');
  assert.deepEqual(beats, [beat(SUITE, 120), beat(SUITE, 240)], 'extra fields are dropped, never relayed');
  assert.ok(!out.stdout.includes(CANARY) && !out.stdout.includes('5521'), 'no smuggled text or value reaches public output');
  assert.equal(terminal(out).status, 'pass', 'a well-formed run with heartbeats stays green');
});

check('a heartbeat for a suite that is not running, or out of order, turns the run red', () => {
  const cases = {
    'before any start': [beat(SUITE, 120), start(SUITE), outcome(SUITE), summary(1), worker],
    'for another suite': [start(SUITE), beat(OTHER, 120), outcome(SUITE), summary(1), worker],
    'after its outcome': [start(SUITE), outcome(SUITE), beat(SUITE, 120), summary(1), worker],
    'seconds not increasing': [start(SUITE), beat(SUITE, 240), beat(SUITE, 240), outcome(SUITE), summary(1), worker],
    'seconds going back': [start(SUITE), beat(SUITE, 240), beat(SUITE, 120), outcome(SUITE), summary(1), worker],
    'zero seconds': [start(SUITE), beat(SUITE, 0), outcome(SUITE), summary(1), worker],
    'fractional seconds': [start(SUITE), beat(SUITE, 1.5), outcome(SUITE), summary(1), worker],
    'beyond a day': [start(SUITE), beat(SUITE, 86401), outcome(SUITE), summary(1), worker],
  };
  for (const [label, input] of Object.entries(cases)) {
    const last = terminal(sink(input));
    assert.deepEqual([last.type, last.status, last.category], ['ci-worker-outcome', 'fail', 'invalid-record'], label);
  }
});

check('the pooled runner writes heartbeats while a slow suite runs, then its outcome', () => {
  // runSuitesPooled with an injected 2.3 s worker and a 0.25 s beat, in a
  // child so its public records can be read.
  const script = `
    const T = require(${JSON.stringify(path.join(ROOT, 'test/test.js'))});
    const pass = ${JSON.stringify(outcome(SUITE))};
    const work = () => new Promise(r => setTimeout(() => r({ out: JSON.stringify(pass) + '\\n', code: 0, signal: null }), 2300));
    T.runSuitesPooled([['slow', ${JSON.stringify(SUITE)}]], { jobs: 1, work, heartbeatMs: 250, log: s => process.stdout.write(s + '\\n') })
      .then(code => { process.exitCode = code; });`;
  const out = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ATLAS_PUBLIC_CI: '1' } });
  assert.equal(out.status, 0);
  const rs = records(out.stdout);
  const types = rs.map(r => r.type);
  assert.equal(types[0], 'ci-suite-start');
  assert.equal(types.at(-2), 'ci-outcome');
  const beats = rs.filter(r => r.type === 'ci-suite-heartbeat');
  assert.deepEqual(beats.map(r => r.elapsedSeconds), [1, 2], 'one record per new whole second, strictly increasing');
  assert.ok(beats.every(r => r.identity === SUITE && Object.keys(r).join() === 'type,identity,elapsedSeconds'));
  assert.ok(types.indexOf('ci-outcome') > types.lastIndexOf('ci-suite-heartbeat'), 'no heartbeat after the outcome');
  // The same records pass the independent sink.
  const relayed = sink([...rs.filter(r => r.type !== 'ci-suite-summary'), summary(1), worker]);
  assert.equal(terminal(relayed).status, 'pass');
});

check('the standard shard job has a timeout, so a hung shard fails on its own', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const job = /\n  standard-shard:\n([\s\S]*?)\n  [a-z-]+:\n/.exec(yml);
  assert.ok(job, 'the standard-shard job exists');
  assert.match(job[1], /^ {4}timeout-minutes: 45$/m, 'timeout-minutes: 45 on the job');
});

console.log(`ci suite heartbeat: ${passed} checks passed`);
