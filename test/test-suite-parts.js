'use strict';
/* A long suite split into parts (test/lib/suite-parts.js) still runs every
 * case exactly once, and a split that would drop a case cannot turn green.
 * `node test/test-suite-parts.js`
 *
 * Failure this guards: the G1 figures-coverage cases now run as four part
 * files so the standard shards can run them at once. If a case were assigned
 * to no part, to two parts, or a part file were left out of the manifest, a
 * protected check would silently stop running. Synthetic cases modules prove
 * the helper fails closed; the real assignment is read in list mode (no
 * figures are built) and checked against the part files and the manifest.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suites } = require('./test');

const HELPER = path.join(__dirname, 'lib/suite-parts.js');
let checks = 0;
let failures = 0;
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  PASS  ${label}`); } catch (error) {
    failures++;
    console.log(`  FAIL  ${label}  — ${error.message}`);
  }
}

// Run a snippet in a fresh process, so each run gets its own helper state.
function run(code, cwd = __dirname) {
  const result = spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8', timeout: 60000 });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

console.log('=== suite parts: every case in exactly one part, fail closed ===');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suite-parts-'));
try {
  // A synthetic cases module: each case appends its name to a log file.
  const casesModule = (assignment, names) => {
    const file = path.join(dir, `cases-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, [
      `const fs = require('fs');`,
      `const test = require(${JSON.stringify(HELPER)}).testFor('synthetic', 3, ${JSON.stringify(assignment)});`,
      ...names.map(name => `test(${JSON.stringify(name)}, () => { fs.appendFileSync(process.env.LOG, ${JSON.stringify(name)} + '\\n'); });`),
    ].join('\n'));
    return file;
  };
  const partRun = (file, part) => {
    const log = path.join(dir, `log-${part}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(log, '');
    const code = `process.env.LOG = ${JSON.stringify(log)};
      const p = require(${JSON.stringify(HELPER)}); p.select('synthetic', ${JSON.stringify(part)});
      require(${JSON.stringify(file)}); p.verify();`;
    const result = run(code);
    return { ...result, ran: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  const good = { a: 1, b: 2, c: 3, d: 1 };

  check('each part runs exactly its own cases; together they run every case once', () => {
    const file = casesModule(good, ['a', 'b', 'c', 'd']);
    const ran = [1, 2, 3].map(part => partRun(file, part));
    for (const r of ran) assert.strictEqual(r.status, 0, r.err);
    assert.deepStrictEqual(ran.map(r => r.ran), [['a', 'd'], ['b'], ['c']]);
    assert.deepStrictEqual(ran.flatMap(r => r.ran).sort(), ['a', 'b', 'c', 'd']);
  });

  check('a case assigned to no part fails every part before any case runs', () => {
    const file = casesModule(good, ['a', 'b', 'c', 'd', 'new case']);
    for (const part of [1, 2, 3]) {
      const r = partRun(file, part);
      assert.notStrictEqual(r.status, 0);
      assert.match(r.err, /case is assigned to no part: new case/);
      assert.deepStrictEqual(r.ran, []);
    }
  });

  check('an assigned case that is never registered fails the part', () => {
    const r = partRun(casesModule(good, ['a', 'b', 'c']), 2);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.err, /assigned case never registered: d/);
  });

  check('a case registered twice fails the part', () => {
    const r = partRun(casesModule(good, ['a', 'b', 'c', 'd', 'a']), 3);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.err, /registered twice/);
  });

  check('a part with no case, an out-of-range part, or no selected part is refused', () => {
    const empty = partRun(casesModule({ a: 1, b: 1, c: 2 }, ['a', 'b', 'c']), 1);
    assert.notStrictEqual(empty.status, 0);
    assert.match(empty.err, /part 3 has no case/);
    const outOfRange = partRun(casesModule(good, ['a', 'b', 'c', 'd']), 4);
    assert.notStrictEqual(outOfRange.status, 0);
    assert.match(outOfRange.err, /invalid part count/);
    const badPart = run(`const p = require(${JSON.stringify(HELPER)}); p.select('synthetic', 1);
      require(${JSON.stringify(casesModule({ a: 1, b: 2, c: 9 }, ['a', 'b', 'c']))});`);
    assert.notStrictEqual(badPart.status, 0);
    assert.match(badPart.err, /invalid part for case: c/);
    const direct = run(`require(${JSON.stringify(casesModule(good, ['a']))});`);
    assert.notStrictEqual(direct.status, 0);
    assert.match(direct.err, /run only through their part files/);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

check('the real figures-coverage split: every case in one part, every part file registered', () => {
  const listed = run(`const p = require('./lib/suite-parts'); p.select('figures-coverage', 'list');
    require('./lib/figures-coverage-cases.js'); process.stdout.write(JSON.stringify(p.verify()));`);
  assert.strictEqual(listed.status, 0, listed.err);
  const { parts, registered, assignment } = JSON.parse(listed.out);
  assert.deepStrictEqual([...registered].sort(), Object.keys(assignment).sort(), 'assignment is exactly the registered cases');
  assert.ok(registered.length >= 22, 'no case was lost from the cases module');
  const manifest = suites.map(([, file]) => file);
  const partFiles = fs.readdirSync(__dirname).filter(file => /^test-figures-coverage-part-\d+\.js$/.test(file)).sort();
  assert.deepStrictEqual(partFiles, Array.from({ length: parts }, (_, i) => `test-figures-coverage-part-${i + 1}.js`));
  for (let part = 1; part <= parts; part++) {
    const file = `test-figures-coverage-part-${part}.js`;
    assert.ok(manifest.includes(file), `${file} is in the npm test manifest`);
    assert.ok(Object.values(assignment).includes(part), `part ${part} has a case`);
    assert.strictEqual(fs.readFileSync(path.join(__dirname, file), 'utf8'), [
      `'use strict';`,
      `// Part ${part} of the G1 figures-check coverage cases (test/lib/figures-coverage-cases.js).`,
      `const parts = require('./lib/suite-parts');`,
      `parts.select('figures-coverage', ${part});`,
      `require('./lib/figures-coverage-cases.js');`,
      `parts.verify();`, ''].join('\n'), `${file} selects only its own part and verifies the split`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, 'test-figures-coverage.js')), 'no unsplit copy runs the cases twice');
});

console.log(`\n${checks - failures}/${checks} suite-part checks passed.`);
process.exitCode = failures ? 1 : 0;
