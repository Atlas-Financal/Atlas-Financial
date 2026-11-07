'use strict';
/* The advisory browser-suite runner. `node test/test-browser-suites.js`
 *
 * No browser is launched here. This proves:
 *   - every test/browser-*.js on disk is classified exactly once: run, or not
 *     run with a known category (a new browser suite cannot be left out);
 *   - the runner fails when any listed suite fails, times out or cannot start,
 *     runs every listed suite, and prints only names and pass/fail, never the
 *     suite's own output;
 *   - the advisory workflow runs the runner and cannot swallow its result.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RUN, NOT_RUN, CATEGORIES, classify, runSuites } = require('../scripts/browser-suites.js');

const ROOT = path.join(__dirname, '..');
let failures = 0, checks = 0;
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (error) { failures++; console.error(`  FAIL  ${label}: ${error.message}`); }
}
const empty = { unclassified: [], stale: [], both: [], badCategory: [] };

check('every browser suite on disk is classified exactly once', () => {
  assert.deepEqual(classify(fs.readdirSync(__dirname)), empty);
  assert(RUN.length > 0);
  for (const category of Object.values(NOT_RUN)) assert(CATEGORIES.includes(category));
});

check('classification fails on an unclassified, stale, doubly listed or uncategorised suite', () => {
  const disk = fs.readdirSync(__dirname);
  assert.deepEqual(classify([...disk, 'browser-synthetic-new.js']).unclassified, ['browser-synthetic-new.js']);
  assert.deepEqual(classify(disk.filter(f => f !== RUN[0])).stale, [RUN[0]]);
  // Non-browser files are not classified.
  assert.deepEqual(classify([...disk, 'test-synthetic.js', 'browser-notes.md']), empty);
});

function stubRun(statuses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-suites-test-'));
  const lines = [], ran = [];
  try {
    const failed = runSuites(Object.keys(statuses), {
      root: ROOT, dir, log: line => lines.push(line),
      spawn: (cmd, args, opts) => {
        const file = path.basename(args[0]);
        ran.push(file);
        fs.writeSync(opts.stdio[1], 'SECRET-CANARY output of ' + file + '\n');
        const s = statuses[file];
        if (s === 'throw') throw new Error('spawn failed');
        return s === 'timeout' ? { status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT') }
          : { status: s, signal: null };
      },
    });
    return { failed, lines, ran };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

check('runner: all pass -> no failures; every listed suite runs', () => {
  const r = stubRun({ 'browser-a.js': 0, 'browser-b.js': 0 });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.ran, ['browser-a.js', 'browser-b.js']);
});

check('runner: a failing, timed-out or unstartable suite is a failure, and later suites still run', () => {
  const r = stubRun({ 'browser-a.js': 1, 'browser-b.js': 'timeout', 'browser-c.js': 'throw', 'browser-d.js': 0 });
  assert.deepEqual(r.failed, ['browser-a.js', 'browser-b.js', 'browser-c.js']);
  assert.deepEqual(r.ran, ['browser-a.js', 'browser-b.js', 'browser-c.js', 'browser-d.js']);
});

check('runner: prints only names and pass/fail, never suite output', () => {
  const r = stubRun({ 'browser-a.js': 1, 'browser-b.js': 0 });
  assert.deepEqual(r.lines.slice(0, 2), ['browser-a.js fail', 'browser-b.js pass']);
  assert(!r.lines.join('\n').includes('SECRET-CANARY'));
});

check('workflow: advisory job runs the runner unmasked, on every pull request, with pinned Playwright', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/browser-suites.yml'), 'utf8')
    .split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(wf, /\n        run: node scripts\/browser-suites\.js\n/);
  assert.doesNotMatch(wf, /continue-on-error|\|\| *true|paths(-ignore)?:|\n    if:/);
  assert.match(wf, /playwright@\d+\.\d+\.\d+ /);
});

console.log(`\n${checks - failures}/${checks} browser-suite runner checks passed.`);
process.exitCode = failures ? 1 : 0;
