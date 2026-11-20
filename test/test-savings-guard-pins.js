'use strict';
/* Savings guard pin generator (scripts/savings-guard-pins.js).
 * `node test/test-savings-guard-pins.js`
 *
 * Fast: runs the script's main() on a temporary tree of a tiny invented module, with the
 * contract's own sourceGuard standing in for the page-capture reach (the real computeGuard
 * is the slow contract test's job). Invented values only; nothing is written outside a
 * temporary directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Contract = require('./lib/savings-consumer-contract.js');
const Pins = require('../scripts/savings-guard-pins.js');

const ROOT = path.join(__dirname, '..');
const TINY = [
  'const TABLE = 1;',
  'function alpha(x) { return x + TABLE; }',
  'function unpinned(x) { return x - 1; }',
  'function beta(x) { return x * 2; }',
  'const EXPORTS = {',
  '  alpha,',
  '  beta,',
  '  unpinned,',
  '};',
  '',
].join('\n');
const MDIR = dir => path.join(dir, Pins.MANIFEST_REL);
const PIN = (dir, name) => path.join(MDIR(dir), 'guard/modules/public/tiny.js.guard/pins', name + '.sha256');
const RESIDUAL = dir => path.join(MDIR(dir), 'guard/modules/public/tiny.js.guard/residual.sha256');
const load = dir => Contract.loadManifest(MDIR(dir));

// Reach = alpha and beta only; the same sourceGuard the contract uses builds the guard.
const tinyCompute = async root => {
  const file = 'public/tiny.js';
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const at = name => text.indexOf('function ' + name) + 12;
  const reach = { reached: new Map([[file, [[at('alpha'), at('alpha') + 4], [at('beta'), at('beta') + 4]]]]), deferred: new Map() };
  return Contract.sourceGuard(reach, { [file]: text }, { selectorRegion: [], pages: {}, machinery: {} });
};

async function tinyTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-pins-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public/tiny.js'), TINY);
  fs.writeFileSync(path.join(dir, 'public/other.js'), 'function never() { return 0; }\n');
  const guard = await tinyCompute(dir);
  Pins.writeManifest(MDIR(dir), { version: 'invented', note: 'keep me', guard });
  return dir;
}
const edit = (dir, file, find, replace) => {
  const p = path.join(dir, file), t = fs.readFileSync(p, 'utf8');
  assert.ok(t.includes(find), 'edit anchor exists');
  fs.writeFileSync(p, t.replace(find, replace));
};
const run = async (dir, args) => {
  const lines = [];
  const code = await Pins.main(args, { root: dir, computeGuard: tinyCompute, inputs: () => [] }, l => lines.push(l));
  return { code, out: lines.join('\n') };
};

test('--check passes on an unchanged tree (and is the default mode)', async () => {
  const dir = await tinyTree();
  for (const args of [[], ['--check']]) {
    const r = await run(dir, args);
    assert.equal(r.code, 0);
    assert.match(r.out, /no differences/);
  }
});

test('--check fails and names only the entry and short hashes after a one-line edit to a pinned function', async () => {
  const dir = await tinyTree();
  const before = load(dir).guard.modules['public/tiny.js'].pins.find(p => p.id === 'public/tiny.js#beta#1').sha256;
  edit(dir, 'public/tiny.js', 'return x * 2;', 'return x * 3;');
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Savings guard pins: differences\./);
  assert.match(r.out, /CHANGED {2}public\/tiny\.js#beta#1/);
  assert.ok(r.out.includes(before.slice(0, 12)), 'old hash printed');
  assert.match(r.out, /CHANGED  public\/tiny\.js#beta#1  [a-f0-9]{12} -> [a-f0-9]{12}/);
  assert.doesNotMatch(r.out, /covers:|return x/);
  assert.doesNotMatch(r.out, /alpha/);
  const after = load(dir).guard.modules['public/tiny.js'].pins.find(p => p.id === 'public/tiny.js#beta#1').sha256;
  assert.equal(after, before, '--check never writes');
});

test('--write updates only the differing entry, keeps the rest of the manifest, and then --check passes', async () => {
  const dir = await tinyTree();
  const was = load(dir);
  edit(dir, 'public/tiny.js', 'return x * 2;', 'return x * 3;');
  const w = await run(dir, ['--write']);
  assert.equal(w.code, 0);
  assert.match(w.out, /CHANGED {2}public\/tiny\.js#beta#1/);
  assert.match(w.out, /Wrote 1 file under/, 'only the one pin file is written');
  const now = load(dir);
  assert.equal(now.note, 'keep me');
  assert.deepEqual(Pins.diff(was.guard, now.guard).map(r => r.key), ['public/tiny.js#beta#1']);
  assert.equal((await run(dir, ['--check'])).code, 0);
});

test('a structural change (a newly reached function) is reported and written', async () => {
  const dir = await tinyTree();
  fs.rmSync(PIN(dir, 'beta#1'));
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /ADDED {2}public\/tiny\.js#beta#1/);
  assert.equal((await run(dir, ['--write'])).code, 0);
  assert.equal((await run(dir, ['--check'])).code, 0);
});

test('an edit to an unpinned function or an unreached file causes no diff', async () => {
  const dir = await tinyTree();
  edit(dir, 'public/tiny.js', 'return x - 1;', 'return x - 99;');
  edit(dir, 'public/other.js', 'return 0;', 'return 12345;');
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 0, r.out);
});

test('a reordered selector region is a difference --check reports and --write repairs (the contract compares it as an ordered list)', async () => {
  const dir = await tinyTree();
  const m = load(dir);
  m.guard.selectorRegion = [{ id: 'public/forecast.js#a#1', sha256: 'a'.repeat(64) }, { id: 'public/forecast.js#b#1', sha256: 'b'.repeat(64) }];
  Pins.writeManifest(MDIR(dir), m);
  const reordered = { ...m.guard, selectorRegion: [...m.guard.selectorRegion].reverse() };
  const rows = Pins.diff(m.guard, reordered);
  assert.deepEqual(rows.map(r => r.key), ['selector region [order]']);
  const compute = async () => reordered;
  const lines = [];
  assert.equal(await Pins.main(['--check'], { root: dir, computeGuard: compute, inputs: () => [] }, l => lines.push(l)), 1);
  assert.equal(await Pins.main(['--write'], { root: dir, computeGuard: compute, inputs: () => [] }, l => lines.push(l)), 0);
  assert.equal(await Pins.main(['--check'], { root: dir, computeGuard: compute, inputs: () => [] }, l => lines.push(l)), 0);
});

test('the existing contract stays intact and CI invokes only the read-only check through private capture', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/savings-guard-pins.js'), 'utf8');
  assert.match(script, /require\('\.\.\/test\/lib\/savings-consumer-contract\.js'\)\.computeGuard/);
  assert.doesNotMatch(script, /function (sourceGuard|observeReach|computeGuard)\b/, 'no second guard implementation');
  assert.ok(!Contract.MACHINERY.includes('scripts/savings-guard-pins.js'));
  const contractTest = fs.readFileSync(path.join(ROOT, 'test/test-savings-consumer-contract.js'), 'utf8');
  assert.doesNotMatch(contractTest, /savings-guard-pins/, 'the contract test compares the committed manifest only');
  const wfDir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(wfDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(wfDir, f), 'utf8'), /savings-guard-pins.*--write/, f + ' must not write pins');
  }
  const wrapper = fs.readFileSync(path.join(ROOT, 'scripts/ci-savings-guard.sh'), 'utf8');
  assert.match(wrapper, /node scripts\/savings-guard-pins\.js --check/);
  assert.doesNotMatch(wrapper, /--write/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), /savings-guard-pins/);
});

// Mutation tests: each mechanical defect in the per-entry files fails --check.
test('--check fails on a stale pin, a deleted pin file, a stray pin file, a changed residual and an unpinned consumer change', async () => {
  const cases = [
    ['unpinned consumer change', dir => edit(dir, 'public/tiny.js', 'return x + TABLE;', 'return x + TABLE + 1;'), /CHANGED {2}public\/tiny\.js#alpha#1/],
    ['stale pin', dir => fs.writeFileSync(PIN(dir, 'alpha#1'), 'f'.repeat(64) + '\n'), /CHANGED {2}public\/tiny\.js#alpha#1/],
    ['deleted pin file', dir => fs.rmSync(PIN(dir, 'alpha#1')), /ADDED {2}public\/tiny\.js#alpha#1/],
    ['stray pin file', dir => fs.writeFileSync(PIN(dir, 'gone#1'), 'a'.repeat(64) + '\n'), /REMOVED {2}public\/tiny\.js#gone#1/],
    ['changed residual (source)', dir => edit(dir, 'public/tiny.js', '  beta,', '  beta: alpha,'), /CHANGED {2}public\/tiny\.js#residual/],
    ['changed residual (stored line)', dir => fs.writeFileSync(RESIDUAL(dir), fs.readFileSync(RESIDUAL(dir), 'utf8').replace(/^[0-9a-f]{64}/, 'e'.repeat(64))), /CHANGED {2}public\/tiny\.js#residual/],
    ['reordered residual lines', dir => { const l = fs.readFileSync(RESIDUAL(dir), 'utf8').split('\n'); [l[1], l[2]] = [l[2], l[1]]; fs.writeFileSync(RESIDUAL(dir), l.join('\n')); }, /CHANGED {2}public\/tiny\.js#residual/],
  ];
  for (const [name, mutate, expect] of cases) {
    const dir = await tinyTree();
    mutate(dir);
    const r = await run(dir, ['--check']);
    assert.equal(r.code, 1, name + ': ' + r.out);
    assert.match(r.out, expect, name);
    assert.equal((await run(dir, ['--write'])).code, 0, name + ': --write repairs');
    assert.equal((await run(dir, ['--check'])).code, 0, name + ': then --check passes');
    assert.ok(!fs.existsSync(PIN(dir, 'gone#1')), name + ': --write removes a stray pin file');
  }
  // An unrecognised file is a load error, never ignored.
  const dir = await tinyTree();
  fs.writeFileSync(path.join(MDIR(dir), 'guard/extra.txt'), 'x\n');
  await assert.rejects(run(dir, ['--check']), /unrecognised file guard\/extra\.txt/);
});

// Two simulated pull requests from one base, each editing and re-pinning a
// different consumer and adding a different module-scope (residual) line:
// git merges them without a textual conflict, and the merged manifest is
// exactly the guard of the merged source.
test('two changes pinning different consumers merge in git without a conflict, and the merge passes --check', async () => {
  const { execFileSync } = require('child_process');
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[k];
  const dir = await tinyTree();
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const pr = async (branch, find, replace, exportAfter, exportLine) => {
    git('checkout', '-q', '-b', branch, 'main');
    edit(dir, 'public/tiny.js', find, replace);
    edit(dir, 'public/tiny.js', exportAfter, exportAfter + '\n' + exportLine);
    assert.equal((await run(dir, ['--check'])).code, 1, branch + ': unpinned change fails');
    assert.equal((await run(dir, ['--write'])).code, 0);
    git('add', '-A'); git('commit', '-q', '-m', branch);
  };
  await pr('pr-a', 'return x + TABLE;', 'return x + TABLE + 1;', '  alpha,', '  alphaAlias: alpha,');
  await pr('pr-b', 'return x * 2;', 'return x * 4;', '  unpinned,', '  betaAlias: beta,');
  git('checkout', '-q', 'pr-a');
  git('merge', '-q', '--no-edit', 'pr-b'); // throws on a conflict
  assert.equal(git('diff', '--name-only', '--diff-filter=U'), '');
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 0, 'merged manifest equals the merged source guard: ' + r.out);
  const lines = load(dir).guard.modules['public/tiny.js'].residual;
  assert.ok(lines.length > 2, 'the residual is stored line by line');
});

test('all structural fields and reasons are digests, never public values', () => {
  const canary = 'SYNTHETIC_PRIVATE_VALUE_8123';
  const guard = { modules: { 'public/tiny.js': { mode: 'module', reason: canary,
    sha256: 'a'.repeat(64), deferred: [canary] } },
  selectorRegion: [{ id: 'public/forecast.js#sample#1', sha256: 'b'.repeat(64) }],
  pages: { budget: { scripts: [canary], html: 'c'.repeat(64) } }, machinery: {} };
  const text = Pins.format(Pins.diff({}, guard));
  assert.ok(!text.includes(canary));
  assert.doesNotMatch(text, /covers:|[a-f0-9]{13}/);
  assert.match(text, /public\/tiny\.js#deferred  - -> [0-9a-f]{12}/);
  assert.match(text, /public\/forecast\.js#sample#1#selector/);
  assert.match(text, /public\/index\.html#scripts/);
  assert.equal(Pins.format([{ key: 'public/tiny.js#alpha#1', old: 'a'.repeat(64),
    new: 'b'.repeat(64), change: 'changed' }]),
  'CHANGED  public/tiny.js#alpha#1  aaaaaaaaaaaa -> bbbbbbbbbbbb');
});

test('malformed public identifiers fail before printing any part of a report', async () => {
  const bad = ['public/tiny.js#bad\n::error::PRIVATE#1', 'public/tiny.js#alpha#1\n',
    'public/tiny.js#alpha\r#1', 'public/tiny.js#\u001b[31m#1', 'public/tiny.js#\u202ealpha#1',
    'public/tiny.js#alpha\u0000#1', '../private.js#alpha#1', 'public/../tiny.js#alpha#1',
    'public/tiny.js#x;echo_PRIVATE#1', 'public/tiny.js#alpha#0',
    'public/tiny.js#' + 'a'.repeat(250) + '#1', 'page PRIVATE [html]', 'machinery: private.js'];
  for (const key of bad) assert.throws(() => Pins.format([
    { key: 'public/tiny.js#alpha#1', old: null, new: 'a'.repeat(64), change: 'added' },
    { key, old: null, new: 'a'.repeat(64), change: 'added' },
  ]), /invalid diagnostic identifier/);
  const dir = await tinyTree();
  const malformed = { ...load(dir).guard, modules: { [bad[0]]: { mode: 'module', sha256: 'a'.repeat(64) } } };
  const lines = [];
  await assert.rejects(Pins.main(['--check'], { root: dir, computeGuard: async () => malformed, inputs: () => [] },
    line => lines.push(line)), /invalid diagnostic identifier/);
  assert.deepEqual(lines, [], 'format validates the complete report before log');
});

test('real CLI loader errors with malformed JSON, hashes and identifiers publish no raw error', async () => {
  for (const fault of ['json', 'hash', 'identifier']) {
    const dir = await tinyTree();
    for (const file of ['scripts/savings-guard-pins.js', 'scripts/js-scan.js', 'test/lib/savings-consumer-contract.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    const canary = 'SYNTHETIC_PRIVATE_LOADER_9283';
    if (fault === 'json') fs.writeFileSync(path.join(MDIR(dir), 'manifest.json'), '{' + canary);
    if (fault === 'hash') fs.writeFileSync(PIN(dir, 'alpha#1'), canary + '\n');
    if (fault === 'identifier') fs.writeFileSync(path.join(MDIR(dir), 'guard', canary + '.txt'), canary);
    const child = spawnSync(process.execPath, ['scripts/savings-guard-pins.js', '--check'],
      { cwd: dir, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, 'Savings guard pins: check failed; diagnostic details withheld.\n');
  }
});

test('exact CI bootstrap keeps malformed reports, Node failures and every runner channel private', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-ci-'));
  const scripts = path.join(dir, 'scripts');
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.join(ROOT, 'scripts/ci-savings-guard.sh'), path.join(scripts, 'ci-savings-guard.sh'));
  const canary = 'SYNTHETIC_PRIVATE_CANARY_8173';
  const channels = ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE'];
  const clean = 'Savings guard pins: no differences from the committed manifest.\n';
  const row = 'CHANGED  public/tiny.js#alpha#1  aaaaaaaaaaaa -> bbbbbbbbbbbb\n';
  const changed = 'Savings guard pins: differences.\n' + row + 'Savings guard pins: check complete.\n';
  const failed = 'Savings guard pins: check failed; diagnostic details withheld.\n';
  const worker = (text, status) => 'process.stdout.write(' + JSON.stringify(text) + '); process.exitCode=' + status + ';';
  const run = (source, env = {}, args = []) => {
    fs.writeFileSync(path.join(scripts, 'savings-guard-pins.js'), source);
    const official = Object.fromEntries(channels.map(key => [key, path.join(dir, key + '.official')]));
    for (const file of Object.values(official)) fs.writeFileSync(file, '');
    const child = spawnSync('bash', ['scripts/ci-savings-guard.sh', ...args], { cwd: dir,
      env: { ...process.env, ...official, RUNNER_TEMP: dir, ...env }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.stderr, '', 'no bootstrap/relay error reaches public stderr');
    assert.ok(!child.stdout.includes(canary), 'no public canary, including annotations');
    assert.ok(!child.stdout.includes('::'), 'no workflow-command annotation');
    for (const file of Object.values(official)) assert.equal(fs.readFileSync(file, 'utf8'), '');
    return child;
  };
  try {
    assert.equal(run(worker(clean, 0)).stdout, clean);
    const diff = run(worker(changed, 1));
    assert.equal(diff.status, 1); assert.equal(diff.stdout, changed);
    for (const report of [changed.replace('#alpha#1', '#bad\n::error::' + canary),
      changed.replace('#alpha#1', '#\u202ealpha#1'), changed.replace('#alpha#1', '#alpha\u0000#1'),
      changed.replace('public/tiny.js', '../private.js'), changed.replace('aaaaaaaaaaaa', canary),
      changed.replace('aaaaaaaaaaaa', 'a'.repeat(64)), changed.replace(row, row + row),
      changed.replace('Savings guard pins: check complete.\n', ''), changed + canary,
      changed.replace('CHANGED', 'ADDED'), clean + changed, '', canary]) {
      const child = run(worker(report, 1));
      assert.equal(child.status, 2); assert.equal(child.stdout, failed);
    }
    for (const source of [worker(changed, 0), worker(clean, 1), worker(changed, 7),
      'const broken = [' + JSON.stringify(canary) + ', );',
      'throw new Error(' + JSON.stringify(canary) + ');',
      worker(clean, 0) + 'process.stderr.write(' + JSON.stringify(canary) + ');',
      'process.stdout.write(' + JSON.stringify('::error::' + canary) + ');',
      ...channels.map(key => 'require("fs").writeFileSync(process.env.' + key + ',' + JSON.stringify(canary) + ');' + worker(clean, 0))]) {
      const child = run(source); assert.equal(child.status, 2); assert.equal(child.stdout, failed);
    }
    const preload = run(worker(clean, 0), { NODE_OPTIONS: '--require=./' + canary, NODE_PATH: canary });
    assert.equal(preload.status, 0); assert.equal(preload.stdout, clean);
    assert.equal(run(worker(clean, 0), { RUNNER_TEMP: path.join(dir, canary, 'absent') }).stdout, failed);
    assert.equal(run(worker(clean, 0), {}, ['--write']).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---- Machinery pins: one stored hash per line, in order --------------------
 * The machinery (scripts/figures-comment.js, the workflow, …) is pinned byte for
 * byte, as the ordered list of its line hashes, so two pull requests that change
 * different lines of one machinery file write different manifest lines and git
 * merges the pin files as cleanly as it merges the sources. Proved here:
 *   1. every change a whole-file hash caught still fails --check: an edited, added,
 *      deleted, reordered or duplicated line, and a dropped final newline;
 *   2. two non-adjacent edits merge with git without a conflict, in the source and
 *      in the pin file alike, and the merged pin file is exactly the pins of the
 *      merged source, which is the same as one combined edit;
 *   3. the old one-hash storage conflicts on the same merge (the reason for this),
 *      and adjacent edits still conflict, in the source as in the pins. */
const MACHINE = 'scripts/js-scan.js';   // a real machinery name, with invented content
const MACHINE_TEXT = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).concat(['', '// end', '']).join('\n');
const machineCompute = async root => {
  const guard = await tinyCompute(root);
  return { ...guard, machinery: { [MACHINE]: Contract.machineryLines(fs.readFileSync(path.join(root, MACHINE), 'utf8')) } };
};
async function machineTree() {
  const dir = await tinyTree();
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, MACHINE), MACHINE_TEXT);
  Pins.writeManifest(MDIR(dir), { ...load(dir), guard: await machineCompute(dir) });
  return dir;
}
const runMachine = async (dir, args) => {
  const lines = [];
  const code = await Pins.main(args, { root: dir, computeGuard: machineCompute, inputs: () => [] }, l => lines.push(l));
  return { code, out: lines.join('\n') };
};

test('machinery pins are stored one hash per line and round-trip', async () => {
  const dir = await machineTree();
  try {
    const stored = fs.readFileSync(path.join(MDIR(dir), 'guard/machinery', MACHINE + '.sha256'), 'utf8');
    const lines = MACHINE_TEXT.split('\n');
    assert.equal(stored.split('\n').length - 1, lines.length, 'one stored line per source line, the final empty line included');
    assert.deepEqual(stored.slice(0, -1).split('\n'), lines.map(Contract.sha), 'each stored line is that source line\'s sha256, in order');
    assert.deepEqual(load(dir).guard.machinery[MACHINE], Contract.machineryLines(MACHINE_TEXT));
    assert.equal((await runMachine(dir, ['--check'])).code, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every machinery change a whole-file hash caught still fails --check', async () => {
  const lines = MACHINE_TEXT.split('\n');
  const swap = (i, j) => { const l = [...lines]; [l[i], l[j]] = [l[j], l[i]]; return l.join('\n'); };
  const cases = [
    ['edited line', MACHINE_TEXT.replace('const line7 = 7;', 'const line7 = 8;')],
    ['added line', MACHINE_TEXT.replace('const line7 = 7;\n', 'const line7 = 7;\nvoid 0;\n')],
    ['deleted line', MACHINE_TEXT.replace('const line7 = 7;\n', '')],
    ['reordered lines', swap(3, 4)],
    ['duplicated line', MACHINE_TEXT.replace('const line7 = 7;\n', 'const line7 = 7;\nconst line7 = 7;\n')],
    ['dropped final newline', MACHINE_TEXT.slice(0, -1)],
    ['whitespace only', MACHINE_TEXT.replace('const line7 = 7;', 'const line7 =  7;')],
  ];
  for (const [name, text] of cases) {
    assert.notEqual(text, MACHINE_TEXT, name + ': the case changes the file');
    const dir = await machineTree();
    try {
      fs.writeFileSync(path.join(dir, MACHINE), text);
      const r = await runMachine(dir, ['--check']);
      assert.equal(r.code, 1, name + ': ' + r.out);
      assert.match(r.out, /CHANGED {2}scripts\/js-scan\.js#machinery {2}[a-f0-9]{12} -> [a-f0-9]{12}/, name);
      assert.doesNotMatch(r.out, /const line/, name + ': no source text is printed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// A throwaway git repository: the base, two branches with one edit each, then a
// merge. Each branch commits the source and its pin file, as a builder does.
function mergeTwoEdits(source, editA, editB, store) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savings-pins-merge-'));
  const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=invented', '-c', 'user.email=invented@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=base', ...args], { cwd: dir, encoding: 'utf8' });
  const commit = (text, message) => {
    fs.writeFileSync(path.join(dir, 'source.js'), text);
    fs.writeFileSync(path.join(dir, 'source.js.sha256'), store(text));
    assert.equal(git('add', '-A').status, 0);
    assert.equal(git('commit', '-q', '-m', message).status, 0);
  };
  try {
    assert.equal(git('init', '-q').status, 0);
    commit(source, 'base');
    assert.equal(git('checkout', '-q', '-b', 'a').status, 0);
    commit(editA(source), 'a');
    assert.equal(git('checkout', '-q', '-b', 'b', 'base').status, 0);
    commit(editB(source), 'b');
    assert.equal(git('checkout', '-q', 'a').status, 0);
    const merge = git('merge', '-q', '--no-edit', 'b');
    const conflicted = git('diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean).sort();
    const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
    return { clean: merge.status === 0, conflicted, source: merge.status === 0 ? read('source.js') : null, pins: merge.status === 0 ? read('source.js.sha256') : null };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const perLine = text => Contract.machineryLines(text).join('\n') + '\n';
const wholeFile = text => Contract.sha(text) + '\n';

test('two non-adjacent edits to one machinery file merge cleanly and re-pin exactly as one combined edit', () => {
  // The real figures registry, as two figures pull requests change it: one adds a class
  // row near the top of FIELD_CLASSES, the other edits a line far below it.
  const source = fs.readFileSync(path.join(ROOT, 'scripts/figures-comment.js'), 'utf8');
  const lines = source.split('\n');
  const top = lines.findIndex(l => /^\s+\['[a-z-]+', '[A-Z][a-z]+', '[^']+', '(money|tag)'\],$/.test(l));
  assert.ok(top > 0 && lines.length - top > 200, 'the registry has a class row well above the end of the file');
  const far = lines.length - 20;
  const editA = text => { const l = text.split('\n'); l.splice(top + 1, 0, "  ['invented-class-a', 'Other', 'inventedA.*.amount', 'money'],"); return l.join('\n'); };
  const editB = text => { const l = text.split('\n'); l[far] = l[far] + ' // invented edit b'; return l.join('\n'); };
  // The combined edit, made by hand: edit b's line index moves down by the one line a inserts above it.
  const combined = (() => { const l = editA(source).split('\n'); l[far + 1] = l[far + 1] + ' // invented edit b'; return l.join('\n'); })();

  const r = mergeTwoEdits(source, editA, editB, perLine);
  assert.ok(r.clean, 'per-line pins: the merge is clean; conflicts in ' + r.conflicted.join(', '));
  assert.equal(r.source, combined, 'the merged source is the combined edit');
  assert.equal(r.pins, perLine(combined), 'the merged pin file is exactly the pins of the combined edit: no re-pin needed');

  const old = mergeTwoEdits(source, editA, editB, wholeFile);
  assert.ok(!old.clean && old.conflicted.length === 1 && old.conflicted[0] === 'source.js.sha256',
    'control: the old one-hash storage conflicts on the pin file alone: ' + JSON.stringify(old.conflicted));
});

test('adjacent edits still conflict, in the source and the pins alike, and keeping either side\'s pin file does not match the resolved source', () => {
  const editA = text => text.replace('const line7 = 7;\n', 'const line7 = 7;\nconst a = 1;\n');
  const editB = text => text.replace('const line7 = 7;\n', 'const line7 = 7;\nconst b = 2;\n');
  const r = mergeTwoEdits(MACHINE_TEXT, editA, editB, perLine);
  assert.ok(!r.clean, 'two insertions at one place conflict');
  assert.deepEqual(r.conflicted, ['source.js', 'source.js.sha256'], 'the pins conflict exactly where the source does');
  // Resolving the source by hand and keeping either side's pin file leaves the
  // guard red until --write: the stored list is not the resolved source's.
  const resolved = MACHINE_TEXT.replace('const line7 = 7;\n', 'const line7 = 7;\nconst a = 1;\nconst b = 2;\n');
  for (const side of [editA(MACHINE_TEXT), editB(MACHINE_TEXT)]) {
    assert.notDeepEqual(Contract.machineryLines(resolved), Contract.machineryLines(side), 'a kept side does not match the resolved source');
  }
});
