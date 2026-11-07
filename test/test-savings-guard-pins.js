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

test('--check fails and names the entry, old and new hash and what it covers after a one-line edit to a pinned function', async () => {
  const dir = await tinyTree();
  const before = load(dir).guard.modules['public/tiny.js'].pins.find(p => p.id === 'public/tiny.js#beta#1').sha256;
  edit(dir, 'public/tiny.js', 'return x * 2;', 'return x * 3;');
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 differing entry/);
  assert.match(r.out, /CHANGED {2}public\/tiny\.js#beta#1/);
  assert.ok(r.out.includes(before.slice(0, 12)), 'old hash printed');
  assert.match(r.out, /covers: function or data binding beta in public\/tiny\.js/);
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

test('the contract test and CI are unchanged by the script: it reuses computeGuard, is not machinery, and nothing in CI calls it', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/savings-guard-pins.js'), 'utf8');
  assert.match(script, /require\('\.\.\/test\/lib\/savings-consumer-contract\.js'\)\.computeGuard/);
  assert.doesNotMatch(script, /function (sourceGuard|observeReach|computeGuard)\b/, 'no second guard implementation');
  assert.ok(!Contract.MACHINERY.includes('scripts/savings-guard-pins.js'));
  const contractTest = fs.readFileSync(path.join(ROOT, 'test/test-savings-consumer-contract.js'), 'utf8');
  assert.doesNotMatch(contractTest, /savings-guard-pins/, 'the contract test compares the committed manifest only');
  const wfDir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(wfDir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(wfDir, f), 'utf8'), /savings-guard-pins/, f + ' must not call the pin generator');
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), /savings-guard-pins/);
});

// Mutation tests: each mechanical defect in the per-entry files fails --check.
test('--check fails on a stale pin, a deleted pin file, a stray pin file, a changed residual and an unpinned consumer change', async () => {
  const cases = [
    ['unpinned consumer change', dir => edit(dir, 'public/tiny.js', 'return x + TABLE;', 'return x + TABLE + 1;'), /CHANGED {2}public\/tiny\.js#alpha#1/],
    ['stale pin', dir => fs.writeFileSync(PIN(dir, 'alpha#1'), 'f'.repeat(64) + '\n'), /CHANGED {2}public\/tiny\.js#alpha#1/],
    ['deleted pin file', dir => fs.rmSync(PIN(dir, 'alpha#1')), /ADDED {2}public\/tiny\.js#alpha#1/],
    ['stray pin file', dir => fs.writeFileSync(PIN(dir, 'gone#1'), 'a'.repeat(64) + '\n'), /REMOVED {2}public\/tiny\.js#gone#1/],
    ['changed residual (source)', dir => edit(dir, 'public/tiny.js', '  beta,', '  beta: alpha,'), /CHANGED {2}public\/tiny\.js \[residual\]/],
    ['changed residual (stored line)', dir => fs.writeFileSync(RESIDUAL(dir), fs.readFileSync(RESIDUAL(dir), 'utf8').replace(/^[0-9a-f]{64}/, 'e'.repeat(64))), /CHANGED {2}public\/tiny\.js \[residual\]/],
    ['reordered residual lines', dir => { const l = fs.readFileSync(RESIDUAL(dir), 'utf8').split('\n'); [l[1], l[2]] = [l[2], l[1]]; fs.writeFileSync(RESIDUAL(dir), l.join('\n')); }, /CHANGED {2}public\/tiny\.js \[residual\]/],
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
