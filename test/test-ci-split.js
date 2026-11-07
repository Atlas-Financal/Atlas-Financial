'use strict';
/* The CI split must schedule the complete serial manifest exactly once and
 * preserve a non-success result all the way to the existing `test` check.
 * Only synthetic runner operations and job results are used here. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { suites, GROUPS, selectSuites, selectionFromArgs, runSuites,
  NOT_SUITES, NOT_SUITE_PREFIXES, manifestCompleteness } = require('./test');
const { sourceText } = require('./test-source-text');
const Capture = require('../scripts/ci-output');
const ROOT = path.join(__dirname, '..');
function assertRuntimeDriver(version, driverVersion, Client) {
  assert.equal(version, 'v24.22.1');
  assert.equal(driverVersion, '8.16.3');
  assert.equal(typeof Client, 'function');
}
const files = rows => rows.map(([, file]) => file);
let failures = 0;
let checks = 0;
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (error) { failures++; console.error(`  FAIL  ${label}: ${error.message}`); }
}

check('installed Node and real pg import match the pinned disconnected runtime', () => {
  // The standard manifest invokes this whole suite behind ci-test.sh, which
  // establishes private capture before Node startup. Never construct a Client.
  assertRuntimeDriver(process.version, require('pg/package.json').version, require('pg').Client);
});

check('runtime import predicate rejects wrong Node, driver and missing Client capability', () => {
  assertRuntimeDriver('v24.22.1', '8.16.3', function Client() {});
  for (const args of [['v20.20.2','8.16.3',()=>{}], ['v24.22.0','8.16.3',()=>{}],
    ['v24.22.1','8.23.1',()=>{}], ['v24.22.1','8.16.3',null]])
    assert.throws(() => assertRuntimeDriver(...args));
});

check('npm test remains the complete ordered serial reference', () => {
  assert.equal(require('../package.json').scripts.test, 'node test/test.js');
  assert.deepEqual(selectionFromArgs([]), suites);
  assert.deepEqual(selectionFromArgs(['--group', 'all']), suites);
  assert(suites.some(([, file]) => file === 'test-ci-split.js'));
  for (const [, file] of suites) assert(fs.existsSync(path.join(__dirname, file)), file);
});

check('every top-level test/*.js on disk is registered or carries a reviewed exclusion reason', () => {
  const result = manifestCompleteness(fs.readdirSync(__dirname));
  assert.deepEqual(result, { unregistered: [], staleExclusions: [], excludedButRegistered: [],
    missingReasons: [] }, JSON.stringify(result));
});

check('the completeness comparison fails on an unregistered suite, a stale or overlapping exclusion and a blank reason', () => {
  const disk = fs.readdirSync(__dirname);
  // An unregistered suite on disk is reported, including one that is merely
  // dropped from the manifest.
  assert.deepEqual(manifestCompleteness([...disk, 'test-synthetic-new-suite.js']).unregistered,
    ['test-synthetic-new-suite.js']);
  const dropped = suites.find(([, file]) => file === 'test-forecast-no-funding-without-sources.js');
  assert(dropped);
  assert.deepEqual(manifestCompleteness(disk, suites.filter(row => row !== dropped)).unregistered,
    ['test-forecast-no-funding-without-sources.js']);
  // Non-.js files are not suites.
  assert.deepEqual(manifestCompleteness([...disk, 'notes.md']).unregistered, []);
  // An exclusion for a file that no longer exists is stale.
  assert.deepEqual(manifestCompleteness(disk.filter(file => file !== 'test-local.js')).staleExclusions,
    ['test-local.js']);
  // A registered suite cannot also be excluded, by name or by prefix.
  assert.deepEqual(manifestCompleteness(disk, suites,
    { ...NOT_SUITES, 'test-forecast.js': 'synthetic overlap' }).excludedButRegistered, ['test-forecast.js']);
  assert.deepEqual(manifestCompleteness(disk, suites, NOT_SUITES,
    { ...NOT_SUITE_PREFIXES, 'test-forecast.': 'synthetic overlap' }).excludedButRegistered, ['test-forecast.js']);
  // Every exclusion states a reason.
  assert.deepEqual(manifestCompleteness([...disk, 'helper-x.js'], suites,
    { ...NOT_SUITES, 'helper-x.js': ' ' }).missingReasons, ['helper-x.js']);
});

check('two groups are a disjoint exact union, retaining manifest order and the non-test probe', () => {
  assert.deepEqual(GROUPS, ['standard', 'refresh-isolation']);
  const standard = files(selectSuites('standard'));
  const isolation = files(selectSuites('refresh-isolation'));
  const all = files(suites);
  assert.deepEqual(isolation, ['test-refresh-isolation.js']);
  assert.deepEqual(standard, all.filter(file => file !== isolation[0]));
  assert(standard.includes('probe-savings-daily-allocation-incumbent.js'));
  const union = [...standard, ...isolation];
  assert.equal(new Set(union).size, all.length);
  assert.equal(union.length, all.length);
  assert.deepEqual(union.sort(), [...all].sort());
});

check('a new explicit non-test-prefixed entry automatically joins the standard group', () => {
  const added = ['synthetic future suite', 'probe-future-suite.js'];
  assert.deepEqual(selectSuites('standard', [...suites, added]).at(-1), added);
});

check('unknown, empty, duplicate and malformed selections fail closed', () => {
  for (const group of ['', 'unknown', 'STANDARD', null, false, []]) {
    assert.throws(() => selectSuites(group), /Unknown suite group/);
  }
  assert.throws(() => selectSuites('all', []), /nonempty/);
  assert.throws(() => selectSuites('standard', [['only', 'test-refresh-isolation.js']]), /nonempty/);
  assert.throws(() => selectSuites('all', [['only', 'probe-example.js']]), /must include/);
  assert.throws(() => selectSuites('all', [...suites, suites[0]]), /Duplicate/);
  assert.throws(() => selectSuites('all', [...suites, ['other label', suites[0][1]]]), /Duplicate/);
  for (const row of [null, [], ['', 'test-example.js'], ['bad', '../test-example.js'],
    ['bad', 'test-*.js'], ['bad', ''], ['bad', 42], ['bad', 'test-example.js', 'extra']]) {
    assert.throws(() => selectSuites('all', [...suites, row]), /Invalid/);
  }
  assert.throws(() => runSuites([]), /nonempty/);
});

check('invalid command lines exit nonzero before executing any suite', () => {
  for (const args of [['--group'], ['--group', ''], ['--group', 'typo'], ['--unknown'],
    ['standard'], ['--group', 'standard', '--group', 'refresh-isolation']]) {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'test.js'), ...args],
      { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1, JSON.stringify(args));
    assert.equal(child.stdout, '', 'a rejected selection must execute nothing');
    if (Capture.publicMode()) {
      assert.equal(JSON.parse(child.stderr).category, 'runner-failed');
    } else assert.match(child.stderr, /Unknown suite group|Usage:/);
  }
});

check('importing the manifest cannot start the full suite', () => {
  const out = execFileSync(process.execPath, ['-e', "require('./test/test.js')"],
    { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  assert.equal(out, '');
});

const synthetic = [['first', 'test-first.js'], ['second', 'test-second.js'], ['last', 'test-last.js']];
check('runner executes each selection serially with the incumbent cwd, Node and inherited output', () => {
  const calls = [];
  const code = runSuites(synthetic, {
    publicCI: false,
    exists: () => true, log: () => {},
    execute(node, args, options) {
      assert.equal(node, process.execPath);
      assert.deepEqual(options, { cwd: ROOT, stdio: 'inherit' });
      assert.equal(args.length, 1);
      calls.push(path.basename(args[0]));
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, files(synthetic));
});

check('assertion, signal, timeout and launch failures stay red while remaining suites still run', () => {
  for (const details of [{ status: 1 }, { signal: 'SIGTERM' }, { code: 'ETIMEDOUT' }, { code: 'ENOENT' }]) {
    const calls = [];
    const logs = [];
    const code = runSuites(synthetic, {
      publicCI: false,
      exists: () => true, log: text => logs.push(text),
      execute(node, args) {
        calls.push(path.basename(args[0]));
        if (calls.length === 2) throw Object.assign(new Error('synthetic child failure'), details);
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, files(synthetic));
    assert(logs.some(text => /1 of 3 suites: second/.test(text)));
  }
});

check('a missing suite is a failure, never a successful empty execution', () => {
  const calls = [];
  const logs = [];
  const code = runSuites(synthetic, {
    publicCI: false,
    exists: file => !file.endsWith('test-second.js'), log: text => logs.push(text),
    execute: (node, args) => calls.push(path.basename(args[0])),
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, ['test-first.js', 'test-last.js']);
  assert(logs.some(text => /test-second.js is missing/.test(text)));
});

const workflow = sourceText(fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8'));
// This intentionally pins this small workflow's wiring. Execute its actual
// aggregation shell below as well: a source-shape check alone cannot prove red.
function workflowContract(src) {
  assert.match(src, /^name: tests$/m);
  // Branch pushes are not a trigger: pull_request covers every PR (merge-ref)
  // and push-to-main covers every merge, so no commit that can merge goes unrun.
  assert.match(src, /^on:\n(?:  #.*\n)*  push:\n    branches: \[main\]\n  pull_request:\n/m);
  assert.doesNotMatch(src, /branches: \['\*\*'\]/);
  assert.match(src, /^concurrency:\n  group: tests-\$\{\{ github\.event\.pull_request\.number \|\| github\.run_id \}\}\n  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m);
  assert.match(src, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(src, /^\s*(?:continue-on-error|strategy):/m);
  const body = src.split('\njobs:\n')[1];
  assert(body, 'jobs are present');
  const headers = [...body.matchAll(/^  ([a-z-]+):\n/gm)];
  assert.deepEqual(headers.map(match => match[1]), ['standard', 'refresh-isolation', 'test']);
  const jobs = Object.fromEntries(headers.map((match, i) =>
    [match[1], body.slice(match.index, headers[i + 1]?.index)]));
  for (const group of ['standard', 'refresh-isolation']) {
    const job = jobs[group];
    assert.match(job, /^    runs-on: ubuntu-latest$/m);
    assert.doesNotMatch(job, /^\s+(?:if|needs|ref):/m);
    assert.equal((job.match(/uses: actions\/checkout@v4/g) || []).length, 1);
    assert.match(job, /^          fetch-depth: 0$/m);
    assert.match(job, /uses: actions\/setup-node@v4\n        with:\n          node-version: '24\.22\.1'/);
    assert.match(job, /^        run: bash scripts\/ci-test.sh install-runtime$/m);
    const commands = [...job.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
    assert.deepEqual(commands, ['bash scripts/ci-test.sh install-runtime', `bash scripts/ci-test.sh ${group}`,
      'test -f .githooks/pre-commit && test -f scripts/privacy-guard.js']);
  }
  const gate = jobs.test;
  assert.match(gate, /^    name: test$/m);
  assert.match(gate, /^    needs: \[standard, refresh-isolation\]$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^    timeout-minutes: 5$/m);
  assert.match(gate, /^          STANDARD_RESULT: \$\{\{ needs.standard.result \}\}$/m);
  assert.match(gate, /^          REFRESH_ISOLATION_RESULT: \$\{\{ needs.refresh-isolation.result \}\}$/m);
  assert.doesNotMatch(gate, /^      (?:if:|  if:)|uses:/m);
  const shell = gate.match(/^        run: \|\n((?:          .*\n)+)/m);
  assert(shell, 'gate has an executable shell body');
  return shell[1].split('\n').map(line => line.slice(10)).join('\n');
}

check('workflow keeps both event identities, isolated Node 24.22.1 jobs, privacy and the always-run test gate', () => {
  workflowContract(workflow);
});

check('workflow verification has no Node startup outside the private shell bootstrap', () => {
  const canary = 'SYNTHETIC_UNCAPTURED_PRELOAD_314159';
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const commands = [...workflow.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
  for (const command of commands.filter(value => /\bnode\b/.test(value))) {
    // Execute the exact proposed workflow entrypoint with public dummy preload
    // input. Its raw output remains in this child capture, never forwarded.
    const probe = spawnSync(bash, ['--noprofile','--norc','-e','-o','pipefail','-c',command], {
      cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '--require=./' + canary + '-missing.cjs' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(probe.error);
    assert(!probe.stdout.includes(canary) && !probe.stderr.includes(canary),
      'workflow entrypoint must not publish a pre-capture preload diagnostic');
    assert.fail('Node verification must be reached through ci-test.sh standard');
  }
});

check('workflow contract rejects omissions, skips, shallow history, changed refs and weakened checks', () => {
  const mutations = [
    ['      - name: Run the correctness suite',
      '      - name: Unsafe direct Node verification\n        run: node scripts/ci-output.js --identity test-ci-split.js -- node test/test-ci-split.js\n\n      - name: Run the correctness suite'],
    ['needs: [standard, refresh-isolation]', 'needs: [standard]'],
    ['    if: ${{ always() }}', '    if: ${{ success() }}'],
    ['  refresh-isolation:', '  missing-isolation:'],
    ['  standard:\n', '  standard:\n    if: false\n'],
    ['fetch-depth: 0', 'fetch-depth: 1'],
    ["node-version: '24.22.1'", "node-version: '24'"],
    ['run: bash scripts/ci-test.sh standard', 'run: bash scripts/ci-test.sh refresh-isolation'],
    ['run: bash scripts/ci-test.sh standard', 'run: node test/test.js --group standard'],
    ['run: bash scripts/ci-test.sh refresh-isolation', 'run: node test/test.js --group refresh-isolation'],
    ['    branches: [main]\n  pull_request:\n', '    branches: [main]\n'],
    ['    branches: [main]\n', '    branches: [\'**\']\n'],
    ['  cancel-in-progress: ${{ github.event_name == \'pull_request\' }}\n', '  cancel-in-progress: true\n'],
    ['  standard:\n', '  standard:\n    continue-on-error: true\n'],
    ['fetch-depth: 0', 'fetch-depth: 0\n          ref: main'],
    ['run: bash scripts/ci-test.sh install-runtime', 'run: npm ci --omit=dev'],
  ];
  for (const [from, to] of mutations) {
    assert(workflow.includes(from), `negative-control anchor: ${from}`);
    assert.throws(() => workflowContract(workflow.replace(from, to)), assert.AssertionError);
  }
});

check('actual gate accepts only two successes across all 100 result combinations', () => {
  const shell = workflowContract(workflow);
  const bash = process.platform === 'win32'
    ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
      '../../..', 'bin/bash.exe') : 'bash';
  const states = ['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral',
    'startup_failure', 'unexpected', '', undefined];
  for (const standard of states) for (const isolation of states) {
    const env = { ...process.env };
    delete env.STANDARD_RESULT;
    delete env.REFRESH_ISOLATION_RESULT;
    if (standard !== undefined) env.STANDARD_RESULT = standard;
    if (isolation !== undefined) env.REFRESH_ISOLATION_RESULT = isolation;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, standard === 'success' && isolation === 'success' ? 0 : 1,
      `standard=${standard}, refresh-isolation=${isolation}: ${result.stderr}`);
  }
});

check('both selected groups keep real child streams and runner errors private without masking failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ci-split-privacy-'));
  assert(dir.startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const root = path.join(dir, 'fixture');
    const diagnostics = path.join(dir, 'private');
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts/ci-output.js'), path.join(root, 'scripts/ci-output.js'));
    const canary = 'SYNTHETIC_SPLIT_PRIVATE_947.31_2041-07-09';
    const rows = [[canary, 'test-fixture-pass.js'], [canary, 'probe-fixture-fail.js'],
      [canary, 'test-refresh-isolation.js']];
    const original = fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8');
    const runnerFile = path.join(root, 'test/test.js');
    const writeManifest = entries => fs.writeFileSync(runnerFile, original.replace(
      /const suites = (\[[\s\S]*?\]);/, 'const suites = ' + JSON.stringify(entries) + ';'));
    const channels = ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'];
    const env = { ...process.env, GITHUB_ACTIONS: 'true', ATLAS_PUBLIC_CI: '1', ATLAS_CI_DIAGNOSTICS_DIR: diagnostics };
    for (const key of channels) env[key] = path.join(dir, 'official-' + key);
    const streams = 'console.log(' + JSON.stringify(canary) + ');console.error("::error::"+' + JSON.stringify(canary)
      + ');const fs=require("fs");for(const key of ' + JSON.stringify(channels)
      + ')fs.writeFileSync(process.env[key],' + JSON.stringify(canary) + ');';
    for (const [, file] of rows) fs.writeFileSync(path.join(root, 'test', file), streams
      + (file === 'probe-fixture-fail.js' ? 'process.exit(7);' : ''));
    writeManifest(rows);
    const child = args => spawnSync(process.execPath, [runnerFile, ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    for (const [group, expected, exit] of [
      ['standard', ['test-fixture-pass.js', 'probe-fixture-fail.js'], 1],
      ['refresh-isolation', ['test-refresh-isolation.js'], 0],
      ['all', files(rows), 1],
    ]) {
      const result = child(['--group', group]);
      assert.ifError(result.error);
      assert.equal(result.status, exit);
      assert(!result.stdout.includes(canary) && !result.stderr.includes(canary));
      assert(!result.stdout.includes('::error') && !result.stderr.includes('::error'));
      const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.filter(row => row.type === 'ci-suite-start').map(row => row.identity), expected);
      assert.deepEqual(records.filter(row => row.type === 'ci-outcome').map(row => [row.identity, row.exitCode]),
        expected.map(file => [file, file === 'probe-fixture-fail.js' ? 7 : 0]));
      const summary = records.at(-1);
      assert.equal(summary.total, expected.length);
      assert.equal(summary.failed, exit);
      assert.equal(summary.exitCode, exit);
      for (const key of channels) assert(!fs.existsSync(env[key]), 'official runner channel stays untouched');
    }
    const rejected = child(['--group', canary]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert(!rejected.stderr.includes(canary));
    assert.equal(JSON.parse(rejected.stderr).category, 'runner-failed');
    writeManifest([[canary, canary], rows[2]]);
    const malformed = child([]);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
    assert(!malformed.stderr.includes(canary));
    assert.equal(JSON.parse(malformed.stderr).category, 'runner-failed');
    writeManifest([[canary, 'test-fixture-missing.js'], rows[2]]);
    const missing = child(['--group', 'standard']);
    assert.equal(missing.status, 1);
    assert(!missing.stdout.includes(canary) && !missing.stderr.includes(canary));
    const missingRecords = missing.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(missingRecords[0].category, 'missing-suite');
    assert.equal(missingRecords[0].executed, false);
    assert.equal(missingRecords.at(-1).failed, 1);
    const retained = fs.readdirSync(diagnostics).flatMap(name => {
      const folder = path.join(diagnostics, name);
      return fs.readdirSync(folder).filter(file => /\.log$/.test(file))
        .map(file => fs.readFileSync(path.join(folder, file), 'utf8'));
    });
    assert(retained.some(text => text.includes(canary)), 'diagnostics remain available only in private files');
    const isolationJob = workflow.slice(workflow.indexOf('  refresh-isolation:'), workflow.indexOf('  test:\n'));
    assert.throws(() => workflowContract(workflow.replace(isolationJob, isolationJob.replace(
      'bash scripts/ci-test.sh install-runtime', 'npm ci --omit=dev'))), assert.AssertionError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('exact worker entrypoints capture parse/load/launcher failures before Node starts and preserve progress', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ci-startup-'));
  assert(dir.startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const root = path.join(dir, 'fixture'), diagnostics = path.join(dir, 'private');
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    const originals = Object.fromEntries(['ci-output.js', 'ci-test.js', 'ci-test-records.js', 'ci-test.sh']
      .map(file => [file, sourceText(fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8'))]));
    const runner = sourceText(fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8'));
    const rows = [['synthetic standard', 'test-fixture-pass.js'], ['synthetic isolation', 'test-refresh-isolation.js']];
    const tiny = runner.replace(/const suites = (\[[\s\S]*?\]);/, 'const suites = ' + JSON.stringify(rows) + ';');
    const canary = 'SYNTHETIC_STARTUP_PRIVATE_2041_947_31';
    const channels = ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'];
    const env = { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: diagnostics.replace(/\\/g, '/'), GITHUB_ACTIONS: 'true' };
    for (const key of channels) env[key] = path.join(dir, 'official-' + key);
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    function reset() {
      for (const [file, source] of Object.entries(originals)) fs.writeFileSync(path.join(root, 'scripts', file), source);
      fs.writeFileSync(path.join(root, 'test/test.js'), tiny);
      for (const [, file] of rows) fs.writeFileSync(path.join(root, 'test', file), 'console.log(' + JSON.stringify(canary) + ');');
    }
    function run(group, extra = {}) {
      const command = workflow.match(new RegExp('        run: (bash scripts/ci-test\\.sh ' + group + ')\\n'))[1];
      const child = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command],
        { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000 });
      assert.ifError(child.error);
      assert.equal(child.stderr, '', 'no raw bootstrap, runner or suite error reaches the public stream');
      assert(!child.stdout.includes(canary) && !/SyntaxError|Error:|at .*\.js|::error::/.test(child.stdout));
      const records = child.stdout.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records[0], { type: 'ci-worker-start', identity: group });
      for (const key of channels) assert(!fs.existsSync(env[key]), 'official file channels stay untouched');
      return { child, records };
    }
    for (const group of GROUPS) {
      reset();
      let result = run(group);
      assert.equal(result.child.status, 0);
      assert.equal(result.records.find(row => row.type === 'ci-worker-outcome').status, 'pass');
      assert.deepEqual(result.records.filter(row => row.type === 'ci-suite-start').map(row => row.identity),
        [group === 'standard' ? rows[0][1] : rows[1][1]]);
      assert.equal(result.records.filter(row => row.type === 'ci-suite-summary').length, 1);
      for (const fault of ['parse', 'pre-handler', 'missing-runner', 'capture-helper', 'launcher-parse', 'launcher-pre-handler', 'missing-launcher', 'launcher-exit']) {
        reset();
        if (fault === 'parse') fs.writeFileSync(path.join(root, 'test/test.js'), tiny.replace(
          'const suites = [', 'const suites = [ [' + JSON.stringify(canary) + ', );'));
        if (fault === 'pre-handler') fs.writeFileSync(path.join(root, 'test/test.js'), 'throw new Error(' + JSON.stringify(canary) + ');\n' + tiny);
        if (fault === 'missing-runner') fs.unlinkSync(path.join(root, 'test/test.js'));
        if (fault === 'capture-helper') fs.writeFileSync(path.join(root, 'scripts/ci-output.js'), 'const broken = [' + JSON.stringify(canary) + ', );');
        if (fault === 'launcher-parse') fs.writeFileSync(path.join(root, 'scripts/ci-test.js'), 'const broken = [' + JSON.stringify(canary) + ', );');
        if (fault === 'launcher-pre-handler') fs.writeFileSync(path.join(root, 'scripts/ci-test.js'),
          'console.log(' + JSON.stringify(canary) + ');console.error(' + JSON.stringify(canary) + ');'
          + 'for(const key of ' + JSON.stringify(channels) + ')require("fs").writeFileSync(process.env[key],'
          + JSON.stringify(canary) + ');throw new Error(' + JSON.stringify(canary) + ');');
        if (fault === 'missing-launcher') fs.unlinkSync(path.join(root, 'scripts/ci-test.js'));
        if (fault === 'launcher-exit') fs.writeFileSync(path.join(root, 'scripts/ci-test.js'), 'process.exit(126);');
        result = run(group);
        assert.equal(result.child.status, fault === 'launcher-exit' ? 126 : 1, fault);
        assert.equal(result.records.filter(row => row.type === 'ci-suite-start').length, 0, fault);
        const preloaded = run(group, { NODE_OPTIONS: '--require=./' + canary + '-missing.cjs' });
        assert.equal(preloaded.child.status, fault === 'launcher-exit' ? 126 : 1,
          'clearing a missing preload must not mask the real ' + fault + ' failure');
      }
      reset();
      fs.writeFileSync(path.join(root, 'test/test.js'), 'console.log(' + JSON.stringify(canary) + ');process.exit(7);');
      result = run(group);
      assert.equal(result.child.status, 7, 'invalid raw progress cannot mask the original failure');
      fs.writeFileSync(path.join(root, 'test/test.js'), 'console.log(' + JSON.stringify(canary) + ');');
      assert.equal(run(group).child.status, 1, 'invalid raw progress cannot turn a protocol failure green');
      for (const fault of ['relay-parse', 'relay-pre-handler', 'missing-relay']) {
        reset();
        const relay = path.join(root, 'scripts/ci-test-records.js');
        if (fault === 'relay-parse') fs.writeFileSync(relay, 'const broken = [' + JSON.stringify(canary) + ', );');
        if (fault === 'relay-pre-handler') fs.writeFileSync(relay, 'throw new Error(' + JSON.stringify(canary) + ');');
        if (fault === 'missing-relay') fs.unlinkSync(relay);
        assert.notEqual(run(group).child.status, 0, 'a failed safe-record sink stays red');
      }
      reset();
      const preload = path.join(root, 'preload.js');
      fs.writeFileSync(preload, 'console.log(' + JSON.stringify(canary) + ');throw new Error(' + JSON.stringify(canary) + ');');
      assert.equal(run(group, { NODE_OPTIONS: '--require="' + preload + '"' }).child.status, 0, 'bootstrap clears optional preloads');
      assert.equal(run(group, { NODE_OPTIONS: '--require=./' + canary + '-missing.cjs' }).child.status, 0,
        'missing optional preload is cleared before Node starts, with no public diagnostic');
      if (process.platform !== 'win32') {
        reset(); fs.writeFileSync(path.join(root, 'test/test.js'), 'process.kill(process.pid,"SIGTERM");');
        result = run(group); assert.equal(result.child.status, 143);
        assert.equal(result.records.find(row => row.type === 'ci-worker-outcome').signal, 'SIGTERM');
      }
    }
    const retained = [];
    for (const exitCode of [0, 7, 126]) {
      reset();
      const outcome = { type: 'ci-outcome', identity: 'install-runtime', status: exitCode ? 'fail' : 'pass',
        category: exitCode ? 'process-failed' : 'none', exitCode, signal: null, executed: true,
        counts: { total: 1, passed: exitCode ? 0 : 1, failed: exitCode ? 1 : 0 } };
      fs.writeFileSync(path.join(root, 'scripts/ci-output.js'),
        'console.log(' + JSON.stringify(JSON.stringify(outcome)) + ');process.exit(' + exitCode + ');');
      assert.equal(run('install-runtime').child.status, exitCode, 'installation preserves original status');
    }
    reset();
    fs.writeFileSync(path.join(root, 'scripts/ci-output.js'), 'const broken = [' + JSON.stringify(canary) + ', );');
    assert.equal(run('install-runtime').child.status, 1, 'installation captures helper bootstrap diagnostics');
    const launcher = originals['ci-test.js'];
    assert(launcher.includes("'--identity', 'install-runtime', '--', 'npm', 'ci', '--omit=dev'"));
    function readPrivate(folder) {
      for (const name of fs.readdirSync(folder)) {
        const file = path.join(folder, name);
        if (fs.statSync(file).isDirectory()) readPrivate(file);
        else if (name.endsWith('.log')) retained.push(fs.readFileSync(file, 'utf8'));
      }
    }
    readPrivate(diagnostics);
    assert(retained.some(text => text.includes(canary)), 'raw synthetic faults stay only in private logs');
    reset();
    const blocked = path.join(dir, 'blocked'); fs.writeFileSync(blocked, 'synthetic');
    const failure = spawnSync(bash, ['scripts/ci-test.sh', 'standard'], { cwd: root,
      env: { ...env, ATLAS_CI_DIAGNOSTICS_DIR: blocked.replace(/\\/g, '/') }, encoding: 'utf8' });
    assert.equal(failure.status, 1); assert.equal(failure.stderr, '');
    assert.equal(JSON.parse(failure.stdout).category, 'capture-failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('record protocol requires complete coherent all-pass evidence and one successful terminal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ci-protocol-'));
  assert(dir.startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const root = path.join(dir, 'fixture');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(root, 'test'));
    for (const file of ['ci-test.sh', 'ci-test.js', 'ci-test-records.js'])
      fs.writeFileSync(path.join(root, 'scripts', file), sourceText(fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8')));
    for (const file of ['test-fixture-first.js', 'test-fixture-second.js', 'test-refresh-isolation.js'])
      fs.writeFileSync(path.join(root, 'test', file), '');
    const canary = 'SYNTHETIC_PROTOCOL_PRIVATE_2041_947_31';
    let ordinal = 0;
    const start = identity => ({ type: 'ci-suite-start', identity });
    const outcome = (identity, failed = false) => ({ type: 'ci-outcome', identity,
      status: failed ? 'fail' : 'pass', category: failed ? 'process-failed' : 'none',
      exitCode: failed ? 7 : 0, signal: null, executed: true,
      counts: { total: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0 } });
    const summary = (files, failed = []) => ({ type: 'ci-suite-summary', total: files.length,
      passed: files.length - failed.length, failed: failed.length, failedSuites: failed,
      exitCode: failed.length ? 1 : 0 });
    const worker = (group, exitCode = 0) => ({ type: 'ci-worker-outcome', identity: group,
      status: exitCode ? 'fail' : 'pass', category: exitCode ? 'process-failed' : 'none', exitCode, signal: null });
    function run(group, records, hook = '') {
      const privateDir = path.join(dir, 'private-' + ++ordinal); fs.mkdirSync(privateDir);
      const args = [];
      if (hook) {
        const preload = path.join(dir, 'storage-' + ordinal + '.js');
        fs.writeFileSync(preload, 'const fs=require("fs"),open=fs.openSync,close=fs.closeSync,write=fs.writeSync;let target;'
          + 'fs.openSync=(file,...args)=>{const fd=open(file,...args);if(String(file).endsWith("bootstrap.stdout.log"))target=fd;return fd;};'
          + (hook === 'close' ? 'fs.closeSync=fd=>{if(fd===target)throw new Error(' + JSON.stringify(canary) + ');return close(fd);};'
            : 'fs.writeSync=(fd,...args)=>{if(fd===target)throw new Error(' + JSON.stringify(canary) + ');return write(fd,...args);};'));
        args.push('--require', preload);
      }
      args.push(path.join(root, 'scripts/ci-test-records.js'), group);
      const child = spawnSync(process.execPath, args,
        { cwd: root, env: { ...process.env, ATLAS_CI_BOOTSTRAP_DIR: privateDir },
          input: records.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n',
          encoding: 'utf8', timeout: 10000 });
      assert.ifError(child.error); assert.equal(child.stderr, '');
      assert(!child.stdout.includes(canary));
      const published = child.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(published.filter(row => row.type === 'ci-worker-outcome').length, 1, 'one terminal, published only after EOF');
      if (child.status !== 0) assert(!published.some(row => row.type === 'ci-worker-outcome' && row.status === 'pass'));
      return child;
    }
    for (const group of GROUPS) {
      const files = group === 'standard' ? ['test-fixture-first.js', 'test-fixture-second.js'] : ['test-refresh-isolation.js'];
      const success = files.flatMap(file => [start(file), outcome(file)]);
      const complete = [...success, summary(files), worker(group)];
      assert.equal(run(group, complete).status, 0);
      const failed = [start(files[0]), outcome(files[0], true), summary([files[0]], [files[0]])];
      assert.equal(run(group, [...failed, worker(group)]).status, 1, 'failed summary plus zero launcher remains red');
      assert.equal(run(group, [...failed, worker(group, 7)]).status, 1, 'valid failing terminal is red');
      assert.equal(run(group, [worker(group, 126)]).status, 1, 'legitimate early startup failure needs no summary');
      const teardown = run(group, [...success, summary(files), worker(group, 7)]);
      assert.equal(teardown.status, 1);
      assert.equal(JSON.parse(teardown.stdout.trim().split('\n').at(-1)).exitCode, 7, 'successful summary may precede a genuine teardown failure');
      const signal = run(group, [{ ...worker(group, 7), category: 'signal-terminated', exitCode: null, signal: 'SIGTERM' }]);
      assert.equal(signal.status, 1);
      assert.equal(JSON.parse(signal.stdout.trim().split('\n').at(-1)).signal, 'SIGTERM', 'early signal failure needs no summary');
      for (const hook of ['close', 'write']) assert.equal(run(group, complete, hook).status, 1,
        'private storage failure cannot publish terminal success');
      const negatives = [
        [...success, worker(group)], // missing summary
        [...success, summary(files)], // missing worker
        [...success, summary(files), summary(files), worker(group)],
        [...complete, worker(group)],
        [worker(group), ...success, summary(files)],
        [...success, worker(group), summary(files)],
        [...complete, start(files[0])],
        [...complete, canary],
        [outcome(files[0]), summary([files[0]]), worker(group)], // missing start
        [{ ...outcome(files[0]), executed: false }, summary([files[0]]), worker(group)],
        [start(files[0]), { ...outcome(files[0]), executed: false }, summary([files[0]]), worker(group)],
        [start(files[0]), start(files[0]), outcome(files[0]), summary([files[0]]), worker(group)],
        [start('test-fixture-first.js'), start('test-fixture-second.js'), outcome('test-fixture-second.js'), worker(group)],
        [start('test-fixture-first.js'), outcome('test-fixture-second.js'), worker(group)],
        [start(files[0]), outcome(files[0]), start(files[0]), summary([files[0]]), worker(group)],
        [start(files[0]), outcome(files[0]), outcome(files[0]), summary([files[0]]), worker(group)],
        [start(files[0]), summary([files[0]]), outcome(files[0]), worker(group)],
        [...success, { ...summary(files), total: files.length + 1 }, worker(group)],
        [...success, { ...summary(files), passed: 0 }, worker(group)],
        [...success, { ...summary(files), failed: 1 }, worker(group)],
        [...success, { ...summary(files), failedSuites: [files[0]] }, worker(group)],
        [...success, { ...summary(files), exitCode: 1 }, worker(group)],
        [...success, { ...summary(files), status: 'fail' }, worker(group)],
        [...success, summary(files), { ...worker(group), category: 'process-failed' }],
        [...success, summary(files), { ...worker(group), exitCode: 7 }],
        [...success, summary(files), { ...worker(group, 7), category: 'none' }],
        [...success, summary(files), { ...worker(group, 7), exitCode: 0 }],
        [...success, summary(files), { ...worker(group, 7), signal: 'SIGTERM' }],
        [...success, summary(files), { ...worker(group, 7), category: 'signal-terminated' }],
        [...success, summary(files), { ...worker(group, 7), category: 'signal-terminated', signal: 'SIGTERM' }],
      ];
      for (const change of [{ category: 'none' }, { exitCode: 0 }, { signal: 'SIGTERM' },
        { category: 'signal-terminated', signal: null },
        { category: 'signal-terminated', signal: 'SIGTERM', exitCode: 7 },
        { category: 'signal-terminated', signal: 'SIGTERM', exitCode: null, executed: false }])
        negatives.push([start(files[0]), { ...outcome(files[0], true), ...change },
          summary([files[0]], [files[0]]), worker(group)]);
      for (const records of negatives) assert.equal(run(group, records).status, 1);
      // Exercise the actual workflow after an exit-propagation regression:
      // valid failed records followed by a zero runner exit must stay red.
      fs.writeFileSync(path.join(root, 'test/test.js'), 'for(const row of ' + JSON.stringify(failed)
        + ')console.log(JSON.stringify(row));');
      const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
      const child = spawnSync(bash, ['scripts/ci-test.sh', group], { cwd: root,
        env: { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: path.join(dir, 'bootstrap').replace(/\\/g, '/') }, encoding: 'utf8' });
      assert.equal(child.status, 1); assert.equal(child.stderr, '');
      assert(!child.stdout.includes('"status":"pass"'));
      for (const exit of [7, 126]) {
        fs.writeFileSync(path.join(root, 'test/test.js'), 'for(const row of ' + JSON.stringify([...success, summary(files)])
          + ')console.log(JSON.stringify(row));process.exit(' + exit + ');');
        const actual = spawnSync(bash, ['scripts/ci-test.sh', group], { cwd: root,
          env: { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: path.join(dir, 'bootstrap').replace(/\\/g, '/') }, encoding: 'utf8' });
        assert.equal(actual.status, exit, 'shell preserves genuine post-summary failure status'); assert.equal(actual.stderr, '');
        const terminal = actual.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'ci-worker-outcome');
        assert.equal(terminal.status, 'fail'); assert.equal(terminal.exitCode, exit); assert.equal(terminal.category, 'process-failed');
      }
    }
    const installed = outcome('install-runtime');
    assert.equal(run('install-runtime', [installed, worker('install-runtime')]).status, 0);
    for (const records of [[worker('install-runtime')], [installed],
      [outcome('install-runtime', true), worker('install-runtime')],
      [{ ...installed, executed: false }, worker('install-runtime')],
      [installed, installed, worker('install-runtime')], [installed, worker('install-runtime'), worker('install-runtime')]])
      assert.equal(run('install-runtime', records).status, 1);
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    for (const [record, exit, expected] of [[outcome('install-runtime', true), 0, 1], [installed, 7, 7], [installed, 126, 126]]) {
      fs.writeFileSync(path.join(root, 'scripts/ci-output.js'), 'console.log(' + JSON.stringify(JSON.stringify(record)) + ');process.exit(' + exit + ');');
      const actual = spawnSync(bash, ['scripts/ci-test.sh', 'install-runtime'], { cwd: root,
        env: { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: path.join(dir, 'bootstrap').replace(/\\/g, '/') }, encoding: 'utf8' });
      assert.equal(actual.status, expected); assert.equal(actual.stderr, '');
      const terminal = actual.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'ci-worker-outcome');
      assert.equal(terminal.status, 'fail');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const { jobsFromArgs, runSuitesPooled, outcomeFromWorker } = require('./test');

check('--jobs is a strict optional suffix and bounded concurrency is CI-record-mode only', () => {
  assert.deepEqual(jobsFromArgs([]), { jobs: 1, rest: [] });
  assert.deepEqual(jobsFromArgs(['--group', 'standard', '--jobs', '4']),
    { jobs: 4, rest: ['--group', 'standard'] });
  for (const bad of ['0', '-1', '17', '4.5', 'x', '', '04', '99']) {
    assert.throws(() => jobsFromArgs(['--group', 'standard', '--jobs', bad]), /--jobs/, bad);
  }
  // Without the hosted record mode the serial reference is the only runner.
  const env = { ...process.env }; delete env.GITHUB_ACTIONS; delete env.ATLAS_PUBLIC_CI;
  const local = spawnSync(process.execPath, [path.join(__dirname, 'test.js'), '--group', 'standard', '--jobs', '2'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(local.status, 1);
  assert.equal(local.stdout, '', 'a rejected selection must execute nothing');
  assert.match(local.stderr, /--jobs requires/);
});

check('pooled worker outcomes cannot turn a contradicted or malformed result green', () => {
  const pass = { type: 'ci-outcome', identity: 'test-x.js', status: 'pass', category: 'none',
    exitCode: 0, signal: null, executed: true, counts: { total: 1, passed: 1, failed: 0 } };
  assert.equal(outcomeFromWorker('test-x.js', { out: JSON.stringify(pass) + '\n', code: 0, signal: null }).status, 'pass');
  for (const worker of [
    { out: JSON.stringify(pass) + '\n', code: 1, signal: null },
    { out: JSON.stringify(pass) + '\n', code: 0, signal: 'SIGTERM' },
    { out: JSON.stringify(pass) + '\n', code: null, signal: null },
    { out: '', code: 0, signal: null },
    { out: 'not json\n', code: 0, signal: null },
    { out: JSON.stringify(pass) + '\n' + JSON.stringify(pass) + '\n', code: 0, signal: null },
    { out: JSON.stringify({ ...pass, identity: 'test-y.js' }) + '\n', code: 0, signal: null },
    { out: JSON.stringify({ ...pass, type: 'ci-suite-summary' }) + '\n', code: 0, signal: null },
  ]) {
    const result = outcomeFromWorker('test-x.js', worker);
    assert.equal(result.status, 'fail', JSON.stringify(worker).slice(0, 80));
    assert.equal(result.category, 'capture-failed');
  }
  const failed = { ...pass, status: 'fail', category: 'process-failed', exitCode: 7 };
  const mapped = outcomeFromWorker('test-x.js', { out: JSON.stringify(failed) + '\n', code: 7, signal: null });
  assert.deepEqual([mapped.status, mapped.exitCode, mapped.category], ['fail', 7, 'process-failed']);
});

check('pooled standard run through ci-test.sh publishes serial manifest-order records and goes red on an injected failing suite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ci-pool-'));
  assert(dir.startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const root = path.join(dir, 'fixture'), diagnostics = path.join(dir, 'private');
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const file of ['ci-output.js', 'ci-test.js', 'ci-test-records.js', 'ci-test.sh'])
      fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(root, 'scripts', file));
    const canary = 'SYNTHETIC_POOL_PRIVATE_5521.47';
    const original = fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8');
    // The first suite finishes last on purpose: publication must still be in
    // manifest order. Every suite records the number running at once in a
    // shared directory so the bound is observed rather than assumed.
    const rows = [
      ['slow first', 'test-pool-slow.js'], ['pass b', 'test-pool-b.js'], ['pass c', 'test-pool-c.js'],
      ['fails', 'probe-pool-fail.js'], ['pass d', 'test-pool-d.js'], ['pass e', 'test-pool-e.js'],
      ['pass f', 'test-pool-f.js'], ['runs alone', 'test-running-build.js'], ['isolation', 'test-refresh-isolation.js'],
    ];
    const gauge = path.join(dir, 'gauge');
    const body = (delay, exit, alone) => 'const fs=require("fs"),p=require("path");const g=' + JSON.stringify(gauge)
      + ';fs.mkdirSync(g,{recursive:true});const me=p.join(g,String(process.pid));fs.writeFileSync(me,"");'
      + 'console.log(' + JSON.stringify(canary) + ');console.error("::error::"+' + JSON.stringify(canary) + ');'
      + 'const n=fs.readdirSync(g).length;' + (alone ? 'if(n!==1)process.exit(9);' : '') + 'fs.appendFileSync(p.join(g,"..","peak.txt"),n+"\\n");'
      + 'setTimeout(()=>{fs.unlinkSync(me);process.exit(' + exit + ');},' + delay + ');';
    const channels = ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'];
    const env = { ...process.env, GITHUB_ACTIONS: 'true', ATLAS_CI_DIAGNOSTICS_DIR: diagnostics.replace(/\\/g, '/') };
    for (const key of channels) env[key] = path.join(dir, 'official-' + key);
    fs.writeFileSync(path.join(root, 'test/test.js'), original.replace(
      /const suites = (\[[\s\S]*?\]);/, 'const suites = ' + JSON.stringify(rows) + ';'));
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    const standard = files(rows).filter(file => file !== 'test-refresh-isolation.js');
    function go(failing, remove) {
      for (const [, file] of rows) fs.writeFileSync(path.join(root, 'test', file),
        body(file === 'test-pool-slow.js' ? 700 : file === 'test-running-build.js' ? 250 : 60,
        file === 'probe-pool-fail.js' && failing ? 7 : 0, file === 'test-running-build.js'));
      if (remove) fs.rmSync(path.join(root, 'test', remove));
      fs.rmSync(path.join(dir, 'peak.txt'), { force: true });
      const child = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        'bash scripts/ci-test.sh standard'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      assert.ifError(child.error);
      assert.equal(child.stderr, '', 'no raw bootstrap, runner or suite error reaches the public stream');
      assert(!child.stdout.includes(canary) && !/::error/.test(child.stdout), 'suite output stays private');
      for (const key of channels) assert(!fs.existsSync(env[key]), 'official runner channels stay untouched');
      const records = child.stdout.trim().split('\n').map(line => JSON.parse(line));
      const peak = Math.max(...fs.readFileSync(path.join(dir, 'peak.txt'), 'utf8').trim().split('\n').map(Number));
      return { child, records, peak };
    }
    const green = go(false);
    assert.equal(green.child.status, 0);
    assert.deepEqual(green.records.filter(r => r.type === 'ci-suite-start').map(r => r.identity), standard);
    assert.deepEqual(green.records.filter(r => r.type === 'ci-outcome').map(r => r.identity), standard);
    const order = green.records.filter(r => r.type === 'ci-suite-start' || r.type === 'ci-outcome')
      .map(r => r.type + ':' + r.identity);
    assert.deepEqual(order, standard.flatMap(file => ['ci-suite-start:' + file, 'ci-outcome:' + file]),
      'records alternate start/outcome in manifest order, as the serial protocol');
    assert(green.peak > 1, 'suites genuinely overlap');
    assert(green.peak <= 4, 'the pool stays within its bound: ' + green.peak);
    assert.equal(green.records.find(r => r.type === 'ci-suite-summary').passed, standard.length);
    assert.equal(green.records.find(r => r.type === 'ci-worker-outcome').status, 'pass');

    const red = go(true);
    assert.equal(red.child.status, 1, 'an injected failing suite turns the group red');
    const summary = red.records.find(r => r.type === 'ci-suite-summary');
    assert.deepEqual([summary.total, summary.passed, summary.failed, summary.failedSuites, summary.exitCode],
      [standard.length, standard.length - 1, 1, ['probe-pool-fail.js'], 1]);
    assert.deepEqual(red.records.filter(r => r.type === 'ci-suite-start').map(r => r.identity), standard,
      'every other suite still ran after the failure');
    const bad = red.records.find(r => r.type === 'ci-outcome' && r.identity === 'probe-pool-fail.js');
    assert.deepEqual([bad.status, bad.exitCode, bad.executed], ['fail', 7, true]);
    assert.equal(red.records.find(r => r.type === 'ci-worker-outcome').status, 'fail');

    // A missing suite is a failure with no execution, never a skip.
    const missing = go(false, 'test-pool-b.js');
    assert.equal(missing.child.status, 1);
    // The record sink refuses an identity that is not a file, so the group is
    // red either way; what matters is that nothing is skipped quietly.
    assert.equal(missing.records.filter(r => r.type === 'ci-suite-start').length, standard.length - 1);
    assert.equal(missing.records.find(r => r.type === 'ci-worker-outcome').status, 'fail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${checks - failures}/${checks} CI split contract checks passed.`);
process.exitCode = failures ? 1 : 0;
