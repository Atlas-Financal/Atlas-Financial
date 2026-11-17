'use strict';
/* Registered node suites must not depend on Playwright being installed.
 *
 * The hosted `npm test` jobs install no browser library. A registered suite
 * that reaches Playwright without a skip guard passes in a local session that
 * has Playwright, and fails only on the hosted runner (#930's savings suite,
 * #870). This is a static check, so it fails locally too.
 *
 * Predicate (text only, deterministic). For every suite in suites.json, walk
 * its relative `require(...)` graph. The suite reaches the browser when any
 * file in that graph requires `playwright` / `playwright-core`, or calls the
 * acceptance harness's browser entry points (`withBudget(` / `openBudget(`
 * called as a property, e.g. `H.withBudget(`). Such a suite must itself carry
 * one of the two recognised skip guards: `require.resolve('playwright')`, or
 * a `process.env.CHROME_PATH &&` gate. The harness itself may require
 * Playwright only lazily, inside its `function browser()`, so requiring the
 * harness for invented worlds never loads it.
 *
 * Known limit: the check sees that a guard is present, not that it wraps
 * every browser call. A suite whose guard is present but unused still fails
 * on the hosted runner, where it is caught as a red required check.
 *
 * `node test/test-suites-playwright-reach.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join('test', 'acceptance', 'harness.js');
const REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const PLAYWRIGHT = /require\(\s*['"]playwright(?:-core)?(?:\/[^'"]*)?['"]\s*\)/;
const BROWSER_CALL = /\.(?:withBudget|openBudget)\(/;
const GUARD = /require\.resolve\(\s*['"]playwright['"]\s*\)|process\.env\.CHROME_PATH\s*&&/;

function localDeps(file, read) {
  const out = [];
  for (const m of read(file).matchAll(REQUIRE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), spec);
    for (const c of [base, base + '.js', base + '.cjs', path.join(base, 'index.js')]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) { out.push(c); break; }
    }
  }
  return out;
}

// The harness's own Playwright require must sit inside `function browser()`.
function harnessLazy(text) {
  const start = text.indexOf('function browser() {');
  if (start < 0) return !PLAYWRIGHT.test(text);
  const end = text.indexOf('\n}', start);
  const outside = text.slice(0, start) + (end < 0 ? '' : text.slice(end));
  return !PLAYWRIGHT.test(outside);
}

function reachReport(root, suiteFiles, read = f => fs.readFileSync(f, 'utf8')) {
  const harness = path.join(root, HARNESS);
  const problems = [];
  const reaching = [];
  if (fs.existsSync(harness) && !harnessLazy(read(harness))) {
    problems.push(`${HARNESS}: requires playwright outside function browser()`);
  }
  for (const suite of suiteFiles) {
    const start = path.join(root, 'test', suite);
    const seen = new Set();
    const stack = [start];
    let via = null;
    while (stack.length && !via) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const text = read(file);
      const own = file === harness ? false : PLAYWRIGHT.test(text);
      if (own || BROWSER_CALL.test(text)) via = path.relative(root, file);
      else stack.push(...localDeps(file, read));
    }
    if (!via) continue;
    reaching.push(suite);
    if (!GUARD.test(read(start))) {
      problems.push(`${suite}: reaches playwright (${via}) with no skip guard`);
    }
  }
  return { problems, reaching };
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); } catch (err) { failures++; console.log(`  FAIL  ${label} — ${err.message}`); }
}

// Synthetic trees prove the predicate fails on each mechanical defect.
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pw-reach-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}
const LAZY_HARNESS = "function browser() {\n  const { chromium } = require('playwright');\n}\nmodule.exports = { withBudget() {} };\n";
const run = (files, suites) => {
  const dir = tree(files);
  try { return reachReport(dir, suites); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

console.log('Predicate on synthetic trees');
check('a suite that only uses the harness for invented worlds passes', () => {
  const r = run({ 'test/acceptance/harness.js': LAZY_HARNESS,
    'test/test-a.js': "const H = require('./acceptance/harness');\nH.observe();\n" }, ['test-a.js']);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.reaching, []);
});
check('an unguarded H.withBudget call is reported', () => {
  const r = run({ 'test/acceptance/harness.js': LAZY_HARNESS,
    'test/test-a.js': "const H = require('./acceptance/harness');\nH.withBudget(w, p => p);\n" }, ['test-a.js']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^test-a\.js: reaches playwright \(test\/test-a\.js\)/);
});
check('a guarded H.withBudget call passes (require.resolve guard)', () => {
  const r = run({ 'test/acceptance/harness.js': LAZY_HARNESS,
    'test/test-a.js': "const H = require('./acceptance/harness');\n"
      + "try { require.resolve('playwright'); H.withBudget(w, p => p); } catch {}\n" }, ['test-a.js']);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.reaching, ['test-a.js']);
});
check('a guarded direct require passes (CHROME_PATH gate)', () => {
  const r = run({ 'test/test-a.js': "if (process.env.CHROME_PATH && ok) { require('playwright'); }\n" }, ['test-a.js']);
  assert.deepEqual(r.problems, []);
});
check('a transitive require through a helper is reported', () => {
  const r = run({ 'test/lib/page.js': "const { chromium } = require('playwright');\n",
    'test/test-a.js': "require('./lib/page');\n" }, ['test-a.js']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /test\/lib\/page\.js/);
});
check('a transitive browser call through a fixture is reported', () => {
  const r = run({ 'test/acceptance/harness.js': LAZY_HARNESS,
    'test/fixtures/w.js': "const H = require('../acceptance/harness');\nmodule.exports = () => H.openBudget([]);\n",
    'test/test-a.js': "require('./fixtures/w');\n" }, ['test-a.js']);
  assert.equal(r.problems.length, 1);
});
check('playwright-core and subpaths count', () => {
  for (const spec of ['playwright-core', 'playwright/test']) {
    const r = run({ 'test/test-a.js': `require('${spec}');\n` }, ['test-a.js']);
    assert.equal(r.problems.length, 1, spec);
  }
});
check('a harness that requires playwright at load time is reported', () => {
  const r = run({ 'test/acceptance/harness.js': "const { chromium } = require('playwright');\nfunction browser() {\n}\n",
    'test/test-a.js': "require('./acceptance/harness');\n" }, ['test-a.js']);
  assert.ok(r.problems.some(p => p.startsWith('test/acceptance/harness.js')), JSON.stringify(r.problems));
});

console.log('Registered suites on this checkout');
const suites = require('./suites.json').map(row => row[1]);
const real = reachReport(ROOT, suites);
check('every registered suite that reaches playwright carries a skip guard', () => {
  assert.deepEqual(real.problems, []);
});
check('positive control: the known guarded browser suites are seen as reaching playwright', () => {
  for (const s of ['test-running-build.js', 'test-unplanned-bill-label-counted.js', 'test-pending-card-bill-exact-amount.js']) {
    if (suites.includes(s)) assert.ok(real.reaching.includes(s), s);
  }
});

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nAll playwright-reach checks passed (${real.reaching.length} guarded suite(s) reach playwright).`);
