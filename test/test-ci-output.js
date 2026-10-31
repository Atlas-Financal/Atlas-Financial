'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync, execFileSync } = require('child_process');
const Capture = require('../scripts/ci-output');
const Figures = require('../scripts/figures-comment');
const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts/ci-output.js');
const CANARY = 'CANARY_HOUSEHOLD 947.31 2041-07-09';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-output-canaries-'));
const env = { ...process.env, ATLAS_CI_DIAGNOSTICS_DIR: dir };
function run(code, extra = {}, identity = 'figures-comment') {
  return spawnSync(process.execPath, [HELPER, '--identity', identity, '--',
    process.execPath, '-e', code], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8' });
}
function outcome(result, exit, identity = 'figures-comment') {
  assert.strictEqual(result.status, exit, 'exact child exit code reaches caller');
  assert.ok(!result.stdout.includes(CANARY) && !result.stderr.includes(CANARY));
  assert.ok(!result.stdout.includes('::error') && !result.stderr.includes('::error'));
  const record = JSON.parse(result.stdout);
  assert.strictEqual(record.identity, identity);
  assert.strictEqual(record.exitCode, exit);
  assert.strictEqual(record.status, exit === 0 ? 'pass' : 'fail');
  assert.deepStrictEqual(record.counts, { total: 1, passed: exit === 0 ? 1 : 0, failed: exit === 0 ? 0 : 1 });
  return record;
}
async function posting(body, apiError, sourceBase, sourceHead, existing = false, moved = false) {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/figures-review.yml'), 'utf8');
  const script = workflow.slice(workflow.indexOf('          script: |') + '          script: |'.length)
    .trimStart().split(/\r?\n/).map(line => line.replace(/^            /, '')).join('\n');
  const posted = [], annotations = [], privateWrites = [];
  const fixtureFs = { readFileSync: file => file.endsWith('/base.json') ? JSON.stringify(sourceBase)
    : file.endsWith('/head.json') ? JSON.stringify(sourceHead) : body,
    writeFileSync: (...args) => privateWrites.push(args) };
  const github = { paginate: async () => existing ? [{ id: 42, body: Figures.MARKER }] : [], rest: {
    pulls: { get: async () => ({ data: { head: { sha: (moved === 'head' ? 'c' : 'b').repeat(40) },
      base: { sha: (moved === 'base' ? 'c' : 'a').repeat(40) } } }) }, issues: {
    listComments() {}, updateComment: async args => { if (apiError) throw new Error(CANARY); posted.push(args.body); },
    createComment: async args => { if (apiError) throw new Error(CANARY); posted.push(args.body); },
  } } };
  const ctx = { require: name => { assert.strictEqual(name, 'fs'); return fixtureFs; },
    process: { env: { RUNNER_TEMP: dir } }, github,
    context: { repo: { owner: 'synthetic', repo: 'fixture' }, payload: { pull_request: { number: 42,
      head: { sha: 'b'.repeat(40) }, base: { sha: 'a'.repeat(40) } } } },
    core: { setFailed: text => annotations.push(text) } };
  await vm.runInNewContext('(async () => {' + script + '\n})()', ctx);
  assert.ok(!annotations.join('\n').includes(CANARY), 'annotations never interpolate error text');
  return { posted, annotations, privateWrites };
}
(async () => {
  assert.strictEqual(Capture.publicMode({ GITHUB_ACTIONS: 'true' }), true);
  assert.strictEqual(Capture.publicMode({ ATLAS_PUBLIC_CI: '1' }), true);
  assert.strictEqual(Capture.publicMode({}), false);
  assert.throws(() => Capture.publish({ identity: CANARY }), /invalid-ci-outcome/);
  const token = JSON.stringify(CANARY);
  const streams = 'console.log(' + token + ');console.error("::error::"+' + token + ');';
  outcome(run(streams), 0);
  outcome(run(streams + 'process.exit(7);'), 7);
  outcome(run(streams + 'process.exit(126);'), 126);
  // Older repair heads may still use an uncaptured test runner. The
  // trusted command boundary also captures those success/failure streams.
  outcome(run(streams, {}, 'repair-tests'), 0, 'repair-tests');
  outcome(run(streams + 'process.exit(7);', {}, 'repair-tests'), 7, 'repair-tests');
  const nested = 'require("child_process").execFileSync(process.execPath,["-e",'
    + JSON.stringify(streams) + '],{stdio:"inherit"});';
  outcome(run(nested + 'process.exit(9);'), 9);
  const channels = ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'];
  const official = Object.fromEntries(channels.map(key => [key, path.join(dir, 'official-' + key)]));
  const channelCode = 'const fs=require("fs");for(const k of ' + JSON.stringify(channels)
    + ')fs.writeFileSync(process.env[k],' + token + ');';
  outcome(run(streams + channelCode, official), 0);
  channels.forEach(key => assert.ok(!fs.existsSync(official[key]), 'child file channel stays private'));
  const captured = Capture.runCaptured(process.execPath, ['-e', streams], { identity: 'figures-comment', env });
  assert.ok(fs.readFileSync(captured.stdoutFile, 'utf8').includes(CANARY));
  assert.ok(fs.readFileSync(captured.stderrFile, 'utf8').includes(CANARY));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(captured.stdoutFile).mode & 0o077, 0);
    assert.strictEqual(fs.statSync(captured.stderrFile).mode & 0o077, 0);
  }
  const assertion = outcome(run('throw new (require("assert").AssertionError)({message:' + token + '});'), 1);
  assert.strictEqual(assertion.category, 'assertion-failed');
  assert.strictEqual(outcome(run('throw new Error(' + token + ');'), 1).category, 'process-failed');
  const missing = Capture.runCaptured('nonexistent-ci-canary-command', [], { identity: 'figures-comment', env });
  assert.strictEqual(missing.category, 'spawn-failed');
  assert.strictEqual(missing.executed, false);
  const invalid = spawnSync(process.execPath, [HELPER, '--identity', CANARY, '--', process.execPath, '-e', streams],
    { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(invalid.status, 1);
  assert.ok(!invalid.stdout.includes(CANARY) && !invalid.stderr.includes(CANARY));
  const spoof = spawnSync(process.execPath, [HELPER, '--identity', 'test-ci-output.js', '--', process.execPath, '-e', streams],
    { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(spoof.status, 1, 'canary proof requires the actual registered suite');
  assert.ok(!spoof.stdout.includes('syntheticProof'));
  const probeSpoof = spawnSync(process.execPath, [HELPER, '--identity',
    'probe-savings-daily-allocation-incumbent.js', '--', process.execPath, '-e', streams],
    { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(probeSpoof.status, 1, 'probe identity also requires its actual script');
  assert.strictEqual(JSON.parse(probeSpoof.stdout).executed, false);
  const blockedRoot = path.join(dir, 'not-a-directory'); fs.writeFileSync(blockedRoot, CANARY);
  const blocked = run(streams, { ATLAS_CI_DIAGNOSTICS_DIR: blockedRoot });
  assert.strictEqual(blocked.status, 1);
  assert.strictEqual(JSON.parse(blocked.stdout).executed, false);
  assert.ok(!blocked.stdout.includes(CANARY) && !blocked.stderr.includes(CANARY));

  // Run the real runner control flow with only invented child suites. Every
  // child still runs, a missing module still fails, and the aggregate keeps
  // its incumbent exit 1 while reporting each actual child exit code.
  const fixtureRoot = path.join(dir, 'runner-fixture');
  fs.mkdirSync(path.join(fixtureRoot, 'test'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
  fs.copyFileSync(HELPER, path.join(fixtureRoot, 'scripts/ci-output.js'));
  const runnerSource = fs.readFileSync(path.join(__dirname, 'test.js'), 'utf8');
  const registered = vm.runInNewContext(runnerSource.match(/const suites = (\[[\s\S]*?\]);/)[1]);
  registered.forEach((row, i) => assert.strictEqual(Capture.suiteIdentity(row[1], i + 1), row[1],
    'every incumbent registry identity remains executable'));
  const fixtures = [[CANARY, 'test-fixture-pass.js'], [CANARY, 'test-fixture-fail.js'],
    [CANARY, 'probe-fixture-pass.js'], [CANARY, 'test-fixture-missing.js'], [CANARY, 'test-refresh-isolation.js']];
  fs.writeFileSync(path.join(fixtureRoot, 'test/test.js'), runnerSource.replace(
    /const suites = (\[[\s\S]*?\]);/, 'const suites = ' + JSON.stringify(fixtures) + ';'));
  fs.writeFileSync(path.join(fixtureRoot, 'test/test-fixture-pass.js'), streams);
  fs.writeFileSync(path.join(fixtureRoot, 'test/test-fixture-fail.js'), streams + 'process.exit(7);');
  fs.writeFileSync(path.join(fixtureRoot, 'test/probe-fixture-pass.js'), streams);
  fs.writeFileSync(path.join(fixtureRoot, 'test/test-refresh-isolation.js'), streams);
  const runner = spawnSync(process.execPath, [path.join(fixtureRoot, 'test/test.js')],
    { cwd: fixtureRoot, env: { ...env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
  assert.strictEqual(runner.status, 1);
  assert.ok(!runner.stdout.includes(CANARY) && !runner.stderr.includes(CANARY));
  const allRecords = runner.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepStrictEqual(allRecords.filter(row => row.type === 'ci-suite-start').map(row => row.identity),
    ['test-fixture-pass.js', 'test-fixture-fail.js', 'probe-fixture-pass.js', 'test-refresh-isolation.js']);
  const records = allRecords.filter(row => row.type !== 'ci-suite-start');
  assert.deepStrictEqual(records.slice(0, 4).map(row => [row.identity, row.exitCode]), [
    ['test-fixture-pass.js', 0], ['test-fixture-fail.js', 7], ['probe-fixture-pass.js', 0],
    ['test-fixture-missing.js', 1]]);
  assert.strictEqual(records[4].identity, 'test-refresh-isolation.js');
  assert.strictEqual(records[4].exitCode, 0);
  assert.deepStrictEqual(records[5], { type: 'ci-suite-summary', total: 5, passed: 3, failed: 2,
    failedSuites: ['test-fixture-fail.js', 'test-fixture-missing.js'], exitCode: 1 });
  // Strict split-manifest preflight rejects a malformed identity before any
  // child runs, through the same private runner exception boundary.
  fs.writeFileSync(path.join(fixtureRoot, 'test/test.js'), runnerSource.replace(
    /const suites = (\[[\s\S]*?\]);/, 'const suites = ' + JSON.stringify([[CANARY, CANARY]]) + ';'));
  const invalidManifest = spawnSync(process.execPath, [path.join(fixtureRoot, 'test/test.js')],
    { cwd: fixtureRoot, env: { ...env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
  assert.strictEqual(invalidManifest.status, 1);
  assert.strictEqual(invalidManifest.stdout, '');
  assert.ok(!invalidManifest.stderr.includes(CANARY));
  assert.strictEqual(JSON.parse(invalidManifest.stderr).category, 'runner-failed');
  fs.writeFileSync(path.join(fixtureRoot, 'test/test.js'), runnerSource.replace(
    "const CiOutput = require('../scripts/ci-output');", 'throw new Error(' + token + ');'));
  const failedBoot = spawnSync(process.execPath, [path.join(fixtureRoot, 'test/test.js')],
    { cwd: fixtureRoot, env: { ...env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
  assert.strictEqual(failedBoot.status, 1);
  assert.ok(!failedBoot.stdout.includes(CANARY) && !failedBoot.stderr.includes(CANARY));
  assert.strictEqual(JSON.parse(failedBoot.stderr).category, 'runner-failed');
  const standing = fs.readFileSync(path.join(ROOT, '.github/workflows/standing-correction-test.yml'), 'utf8');
  for (const name of ['standing-corrections', 'standing-store', 'lunchmoney', 'cleanup', 'routine-cleanup', 'interface']) {
    const file = 'test-assistant-' + name + '.js';
    assert.ok(standing.includes('--identity ' + file + ' -- node test/' + file));
  }
  for (const [file, identity] of [['atlas-test-repair.yml', 'atlas-test-repair-gate'],
    ['codex-cursor-repair.yml', 'codex-review-gate']]) {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    assert.ok(workflow.includes('ci-output.js') && workflow.includes('--identity ' + identity + ' --'));
    assert.ok(!/upload-artifact|download-artifact|cursor-agent|git push/.test(workflow),
      'arbitrary repair artifacts are withheld before model execution');
  }
  for (const identity of ['install-runtime', 'privacy-guard', 'risk-label-gate', 'codex-review-gate', 'atlas-test-repair-gate',
    'figures-head-snapshot', 'figures-base-snapshot', 'figures-base-checkout', 'cursor-models', 'cursor-repair']) {
    outcome(run(streams + channelCode, official, identity), 0, identity);
    outcome(run(streams + channelCode + 'process.exit(7);', official, identity), 7, identity);
  }
  for (const identity of ['codex-review-gate', 'atlas-test-repair-gate'])
    assert.strictEqual(outcome(run(streams + 'process.exit(78);', {}, identity), 78, identity).category,
      'private-artifact-blocked');
  assert.strictEqual(outcome(run('process.exit(78);'), 78).category, 'process-failed');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8')
    .split('run: bash scripts/ci-test.sh install-runtime').length - 1, 2);
  assert.ok(fs.readFileSync(path.join(ROOT, '.github/workflows/standing-correction-test.yml'), 'utf8')
    .includes('--identity install-runtime -- npm ci --omit=dev'));
  assert.ok(fs.readFileSync(path.join(ROOT, '.github/workflows/privacy-guard.yml'), 'utf8')
    .includes('--identity privacy-guard -- node trusted/scripts/privacy-guard.js'));

  // Independently specified changed set: material monetary difference,
  // changed date, changed null, and added string. Sub-cent difference stays
  // unchanged under the incumbent comparison threshold.
  const base = { 'planning.CANARY_HOUSEHOLD.remaining': 947.31,
    'planning.CANARY_HOUSEHOLD.date': '2041-07-09', 'credit.CANARY_HOUSEHOLD.rate': 9,
    'cash.CANARY_HOUSEHOLD': 100, 'bills.CANARY_HOUSEHOLD': null };
  const head = { ...base, 'planning.CANARY_HOUSEHOLD.remaining': 960.31,
    'planning.CANARY_HOUSEHOLD.date': '2041-07-10', 'cash.CANARY_HOUSEHOLD': 100.004,
    'bills.CANARY_HOUSEHOLD': 0, 'private.CANARY_HOUSEHOLD': CANARY };
  assert.deepStrictEqual(Figures.compareFigures(base, head).moved, [
    'bills.CANARY_HOUSEHOLD', 'planning.CANARY_HOUSEHOLD.date',
    'planning.CANARY_HOUSEHOLD.remaining', 'private.CANARY_HOUSEHOLD']);
  const safe = Figures.formatPublicFiguresComment(base, head);
  assert.ok(safe.includes('Total: 6 compared; 4 changed.'));
  assert.ok(safe.includes('| Plan | 1 | 0 | 0 | 0 |'));
  assert.ok(!/CANARY_HOUSEHOLD|947\.31|960\.31|2041-|\$|\+13/.test(safe));
  // A synthetic map carries no coverage manifest: it is INCOMPLETE as well as
  // changed, and can never read unchanged and accepted.
  assert.ok(safe.includes('Coverage: INCOMPLETE.'));
  const posted = await posting(safe, false, base, head);
  assert.strictEqual(posted.posted.length, 1); assert.strictEqual(posted.annotations.length, 1);
  assert.ok(posted.annotations[0].includes('acceptance withheld'));
  assert.ok(posted.posted[0].includes('head `' + 'b'.repeat(40) + '`'));
  for (const moved of ['head', 'base']) {
    const stale = await posting(safe, false, base, head, false, moved);
    assert.strictEqual(stale.posted.length, 0); assert.strictEqual(stale.annotations.length, 1);
  }
  assert.strictEqual((await posting(safe, false, undefined, head)).posted.length, 0,
    'missing snapshots cannot produce figures acceptance');
  for (const body of [safe + CANARY, safe.replace('| Plan | 1 | 0 | 0 | 0 |', '| Plan | 1 | 2 | 0 | 0 |'),
    safe.replace('Total: 6 compared; 4 changed.', 'Total: 6 compared; 3 changed.'),
    safe.replace('Coverage: INCOMPLETE.', 'Coverage: complete.'),
    Figures.formatFiguresComment(base, head, CANARY)]) {
    const rejected = await posting(body, false, base, head);
    assert.strictEqual(rejected.posted.length, 0);
    assert.strictEqual(rejected.annotations.length, 1);
  }
  for (const [a, b] of [[base, base], [null, head], [null, {}]]) {
    const result = await posting(Figures.formatPublicFiguresComment(a, b), false, a, b);
    assert.strictEqual(result.posted.length, 1); assert.strictEqual(result.annotations.length, 1);
    assert.strictEqual(result.annotations[0].startsWith('Figures acceptance withheld and coverage incomplete'), a === null);
    assert.strictEqual(result.annotations[0].startsWith('Figures coverage incomplete'), a !== null);
  }
  const forgedCounts = safe.replace('| Plan | 1 | 0 | 0 | 0 |', '| Plan | 947 | 0 | 0 | 0 |')
    .replace('Total: 6 compared; 4 changed.', 'Total: 952 compared; 4 changed.');
  assert.strictEqual((await posting(forgedCounts, false, base, head)).posted.length, 0);
  // A synthetic check snapshot with a reconciled manifest: every declared class
  // observed by one invented input and the household. Unchanged and complete
  // posts green; one moved invented field withholds acceptance.
  const complete = { 'check.schema': Figures.CHECK_SCHEMA, 'check.collector.sha256': 'c'.repeat(64),
    'check.household.input.sha256': 'd'.repeat(64), 'fixture.synthetic.input.sha256': 'e'.repeat(64) };
  for (const cls of Figures.FIELD_CLASSES) {
    const key = cls.pattern.split('.').map(part => (part === '*' ? 'synthetic' : part)).join('.');
    const value = { money: 0, tag: 'synthetic', flag: false, true: true }[cls.kind];
    complete[key] = value; complete['fixture.synthetic.' + key] = value;
    complete['coverage.' + cls.id + '.household'] = 1; complete['coverage.' + cls.id + '.invented'] = 1;
  }
  // The required Savings capture evidence (G1 v3): an input that publishes no
  // Savings funding still carries the version, the required page states and
  // the counts, plus one observation per required route (fourteen compared
  // keys per input, twenty-eight in all).
  for (const prefix of ['', 'fixture.synthetic.']) {
    complete[prefix + 'savings.capture.version'] = Figures.CAPTURE_EVIDENCE;
    Figures.CAPTURE_REQUIRED_STATES.forEach((state, i) => {
      complete[prefix + 'savings.capture.state.' + i] = state + '|calls=0|error=|unfinished=0|load=0';
    });
    complete[prefix + 'savings.capture.states'] = Figures.CAPTURE_REQUIRED_STATES.length;
    // The synthetic class keys publish savings.funding.status, so each
    // required selector route appears once, with a withheld (null) result.
    Figures.CAPTURE_REQUIRED_ROUTES.forEach((route, n) => {
      const [page, where] = route.split('|');
      complete[prefix + 'savings.capture.o' + n] = [page, 'default', where, 'null', 'context:{}', 'null', ''].join('|');
    });
    complete[prefix + 'savings.capture.count'] = Figures.CAPTURE_REQUIRED_ROUTES.length;
    complete[prefix + 'savings.capture.results'] = 0;
  }
  const completeMoved = { ...complete, 'fixture.synthetic.plan.weeklyCap': 1 };
  const green = await posting(Figures.formatPublicFiguresComment(complete, complete), false, complete, complete);
  assert.strictEqual(green.posted.length, 1); assert.deepStrictEqual(green.annotations, []);
  assert.ok(green.posted[0].includes('Figures acceptance: no compared field moved'));
  const withheldOnly = await posting(Figures.formatPublicFiguresComment(complete, completeMoved), false, complete, completeMoved);
  assert.strictEqual(withheldOnly.posted.length, 1);
  assert.ok(withheldOnly.annotations.length === 1 && withheldOnly.annotations[0].startsWith('Figures acceptance withheld:'));
  const postFailure = await posting(safe, true, base, head);
  assert.strictEqual(postFailure.posted.length, 0);
  assert.strictEqual(postFailure.annotations.length, 1);
  assert.ok(postFailure.privateWrites.some(args => String(args[1]).includes(CANARY)));
  const updateFailure = await posting(safe, true, base, head, true);
  assert.strictEqual(updateFailure.annotations.length, 1);
  assert.strictEqual(updateFailure.posted.length, 0);
  assert.strictEqual((await posting(safe, false, base, head, true)).posted.length, 1);

  const baseFile = path.join(dir, 'base.json'), headFile = path.join(dir, 'head.json');
  fs.writeFileSync(baseFile, JSON.stringify(base)); fs.writeFileSync(headFile, JSON.stringify(head));
  const formatted = Capture.runCaptured(process.execPath, [path.join(ROOT, 'scripts/figures-comment.js'),
    baseFile, headFile, CANARY, '--public-summary'], { identity: 'figures-comment', env });
  assert.strictEqual(formatted.exitCode, 0);
  assert.strictEqual(fs.readFileSync(formatted.stdoutFile, 'utf8'), safe);
  // Exercise the shipped workflow's actual --public-summary CLI arguments,
  // independently specified additions/removals/types and the tolerance boundary.
  const declared = Figures.FIELD_CLASSES.length;
  const cases = [
    [base, base, false, true, 'Total: 5 compared; 0 changed.'],
    [null, head, true, true, 'Total: 6 compared; 6 changed.'],
    [null, {}, true, true, 'Total: 0 compared; 0 changed.'],
    [{ 'cash.synthetic': 100 }, { 'cash.synthetic': 100.004 }, false, true, 'Total: 1 compared; 0 changed.'],
    [{ 'cash.synthetic': 100 }, { 'cash.synthetic': 100.006 }, true, true, 'Total: 1 compared; 1 changed.'],
    [{ 'cash.removed': 3, 'credit.synthetic.rate': 9, 'bills.openCount': 1,
      'planning.date': '2041-07-09', 'planning.null': null },
    { 'cash.added': 4, 'credit.synthetic.rate': 10, 'bills.openCount': 2,
      'planning.date': '2041-07-10', 'planning.null': 0 }, true, true, 'Total: 6 compared; 6 changed.'],
    [complete, complete, false, false, `Total: ${declared * 4 + 28} compared; 0 changed.`],
    [complete, completeMoved, true, false, `Total: ${declared * 4 + 28} compared; 1 changed.`],
  ];
  for (const [a, b, withheld, incomplete, total] of cases) {
    fs.writeFileSync(baseFile, JSON.stringify(a)); fs.writeFileSync(headFile, JSON.stringify(b));
    const cli = Capture.runCaptured(process.execPath, [path.join(ROOT, 'scripts/figures-comment.js'),
      baseFile, headFile, 'main', '--public-summary'], { identity: 'figures-comment', env });
    assert.strictEqual(cli.exitCode, 0);
    const body = fs.readFileSync(cli.stdoutFile, 'utf8');
    assert.ok(body.includes(total));
    assert.strictEqual(body.includes('acceptance: WITHHELD'), withheld);
    assert.strictEqual(body.includes('Coverage: INCOMPLETE.'), incomplete);
    const actual = await posting(body, false, a, b);
    assert.strictEqual(actual.posted.length, 1);
    assert.strictEqual(actual.annotations.length, withheld || incomplete ? 1 : 0);
    assert.strictEqual((await posting(body.replace(/Figures acceptance:.*\n/, ''), false, a, b)).posted.length, 0,
      'missing acceptance disposition cannot post');
  }
  const evidence = require('../scripts/figures-private-diff');
  const repo = path.join(dir, 'private-comparison-fixture'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.name', 'Synthetic CI']); git(['config', 'user.email', 'synthetic@example.test']);
  git(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(repo, 'scripts'));
  const snapshot = value => 'if(process.env.GITHUB_TOKEN||process.env.GH_TOKEN)process.exit(9);\n'
    + 'console.log(' + JSON.stringify(JSON.stringify(value)) + ');';
  const a = { 'cash.synthetic': 100, 'credit.synthetic.rate': 9, 'bills.openCount': 1,
    'planning.date': '2041-07-09', 'planning.null': null, 'cash.removed': 3 };
  const b = { 'cash.synthetic': 113, 'credit.synthetic.rate': 10, 'bills.openCount': 2,
    'planning.date': '2041-07-10', 'planning.null': 0, 'cash.added': 4 };
  fs.writeFileSync(path.join(repo, 'scripts/figures-snapshot.js'), snapshot(a));
  git(['add', '.']); git(['commit', '-m', 'Synthetic base']); const baseSha = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'scripts/figures-snapshot.js'), snapshot(b));
  git(['add', '.']); git(['commit', '-m', 'Synthetic head']); const headSha = git(['rev-parse', 'HEAD']);
  const privateDir = path.join(dir, 'private-exact-evidence');
  const receipt = evidence.prepare(privateDir, baseSha, headSha, repo);
  assert.strictEqual(receipt.acceptance, 'withheld'); assert.strictEqual(receipt.ownerReconciliationPerformed, false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(privateDir, 'base.json'))), a);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(privateDir, 'head.json'))), b);
  const detail = fs.readFileSync(path.join(privateDir, 'figures.md'), 'utf8');
  for (const expected of [baseSha, headSha, '`cash.synthetic`', '$100.00', '$113.00', '+$13.00',
    '`cash.added`', '`cash.removed`', 'new', 'removed', '2041-07-09', '2041-07-10', '9%', '10%', '+1', '`null`'])
    assert.ok(detail.includes(expected), 'private detail retains identifiers, revisions, before/after and deltas');
  assert.strictEqual(evidence.verify(privateDir, baseSha, headSha).headSha, headSha);
  assert.throws(() => evidence.verify(privateDir, headSha, baseSha), /stale/);
  assert.throws(() => evidence.prepare(path.join(dir, 'stale-evidence'), headSha, baseSha, repo), /stale/);
  assert.throws(() => evidence.prepare(privateDir, baseSha, headSha, repo));
  fs.appendFileSync(path.join(privateDir, 'figures.md'), 'modified');
  assert.throws(() => evidence.verify(privateDir, baseSha, headSha), /stale/);
  fs.unlinkSync(path.join(privateDir, 'figures.md'));
  assert.throws(() => evidence.verify(privateDir, baseSha, headSha));
  fs.unlinkSync(path.join(repo, 'scripts/figures-snapshot.js'));
  git(['add', '-A']); git(['commit', '-m', 'Synthetic missing snapshot']); const missingSha = git(['rev-parse', 'HEAD']);
  const missingDir = path.join(dir, 'missing-snapshot-evidence');
  assert.throws(() => evidence.prepare(missingDir, baseSha, missingSha, repo));
  assert.ok(!fs.existsSync(path.join(missingDir, 'receipt.json')), 'missing snapshot never prepares acceptance evidence');
  assert.strictEqual(git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1, 'private worktrees cleaned synchronously');
  const blockedDir = path.join(dir, 'storage-blocked'); fs.writeFileSync(blockedDir, 'synthetic');
  assert.throws(() => evidence.prepare(path.join(blockedDir, 'child'), baseSha, missingSha, repo));
  const cliMissing = spawnSync(process.execPath, [path.join(ROOT, 'scripts/figures-private-diff.js'),
    'verify', baseSha, headSha, privateDir], { encoding: 'utf8' });
  assert.strictEqual(cliMissing.status, 78);
  assert.strictEqual(JSON.parse(cliMissing.stdout).acceptance, 'withheld'); assert.strictEqual(cliMissing.stderr, '');
  fs.writeFileSync(headFile, CANARY);
  const malformed = Capture.runCaptured(process.execPath, [path.join(ROOT, 'scripts/figures-comment.js'),
    baseFile, headFile, CANARY, '--public-summary'], { identity: 'figures-comment', env });
  assert.strictEqual(malformed.exitCode, 1);
  assert.ok(fs.readFileSync(malformed.stderrFile, 'utf8').includes(CANARY));
  outcome(run('console.log("x".repeat(1100000));console.error("x".repeat(1100000));process.exit(7);'), 7);
  if (process.platform !== 'win32') {
    const signaled = run('process.kill(process.pid,"SIGTERM");');
    assert.strictEqual(signaled.signal, 'SIGTERM');
    assert.strictEqual(JSON.parse(signaled.stdout).signal, 'SIGTERM');
    assert.strictEqual(JSON.parse(signaled.stdout).exitCode, null);
  }
  console.log('PASS synthetic CI canaries: private stdout/stderr/subprocess/file annotations; exact exit codes; count-only formatter; posting validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
