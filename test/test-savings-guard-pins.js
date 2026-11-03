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
  'function beta(x) { return x * 2; }',
  'function unpinned(x) { return x - 1; }',
  '',
].join('\n');

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
  fs.mkdirSync(path.join(dir, path.dirname(Pins.MANIFEST_REL)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public/tiny.js'), TINY);
  fs.writeFileSync(path.join(dir, 'public/other.js'), 'function never() { return 0; }\n');
  const guard = await tinyCompute(dir);
  fs.writeFileSync(path.join(dir, Pins.MANIFEST_REL), JSON.stringify({ version: 'invented', note: 'keep me', guard }, null, 1) + '\n');
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
  const before = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8')).guard.modules['public/tiny.js'].pins
    .find(p => p.id === 'public/tiny.js#beta#1').sha256;
  edit(dir, 'public/tiny.js', 'return x * 2;', 'return x * 3;');
  const r = await run(dir, ['--check']);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 differing entry/);
  assert.match(r.out, /CHANGED {2}public\/tiny\.js#beta#1/);
  assert.ok(r.out.includes(before.slice(0, 12)), 'old hash printed');
  assert.match(r.out, /covers: function or data binding beta in public\/tiny\.js/);
  assert.doesNotMatch(r.out, /alpha/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8')).guard.modules['public/tiny.js'].pins
    .find(p => p.id === 'public/tiny.js#beta#1').sha256;
  assert.equal(after, before, '--check never writes');
});

test('--write updates only the differing entry, keeps the rest of the manifest, and then --check passes', async () => {
  const dir = await tinyTree();
  const was = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8'));
  edit(dir, 'public/tiny.js', 'return x * 2;', 'return x * 3;');
  const w = await run(dir, ['--write']);
  assert.equal(w.code, 0);
  assert.match(w.out, /CHANGED {2}public\/tiny\.js#beta#1/);
  const now = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8'));
  assert.equal(now.note, 'keep me');
  assert.deepEqual(Pins.diff(was.guard, now.guard).map(r => r.key), ['public/tiny.js#beta#1']);
  assert.equal((await run(dir, ['--check'])).code, 0);
});

test('a structural change (a newly reached function) is reported and written', async () => {
  const dir = await tinyTree();
  const r0 = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8'));
  const mod = r0.guard.modules['public/tiny.js'];
  mod.pins = mod.pins.filter(p => p.id !== 'public/tiny.js#beta#1');
  fs.writeFileSync(path.join(dir, Pins.MANIFEST_REL), JSON.stringify(r0, null, 1) + '\n');
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
  const m = JSON.parse(fs.readFileSync(path.join(dir, Pins.MANIFEST_REL), 'utf8'));
  m.guard.selectorRegion = [{ id: 'public/forecast.js#a#1', sha256: 'a'.repeat(64) }, { id: 'public/forecast.js#b#1', sha256: 'b'.repeat(64) }];
  fs.writeFileSync(path.join(dir, Pins.MANIFEST_REL), JSON.stringify(m, null, 1) + '\n');
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
