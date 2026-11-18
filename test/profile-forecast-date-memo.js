'use strict';
/* Optional diagnostic for the Forecast date-arithmetic memos (LEAD 10).
 * Not part of npm test and not a timing threshold.
 *
 * `node test/profile-forecast-date-memo.js <base-tree>`
 *
 * <base-tree> is a checkout of the revision to compare against (for example
 * `git worktree add /tmp/base origin/main`). Each sample is a cold process.
 * For every invented figures input (test/fixtures/figures-inputs), at its own
 * as-of date and at +3, +7, +14 and +30 days, it runs Forecast.recommend with
 * the Budget page's default options (scripts/figures-snapshot.js pageOptions)
 * and hashes the complete JSON advice. The base and this tree must produce the
 * same hash for every input and date; elapsed Forecast time is reported only.
 * Invented inputs only: no data.json, periods.json or provider access.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHIFTS = [0, 3, 7, 14, 30];

if (process.argv[2] === '--sample') {
  const root = path.resolve(process.argv[3]);
  const { performance } = require('node:perf_hooks');
  const crypto = require('node:crypto');
  const F = require(path.join(root, 'public/forecast.js'));
  const Snap = require(path.join(root, 'scripts/figures-snapshot.js'));
  const hashes = [];
  let forecastMs = 0;
  for (const input of Snap.loadInventedInputs()) {
    for (const shift of SHIFTS) {
      const data = structuredClone(input.doc.data);
      const asOf = F.addDays(data.meta.asOf, shift);
      const options = Snap.pageOptions(data, input.doc.periods == null ? null : structuredClone(input.doc.periods));
      const start = performance.now();
      const advice = F.recommend(data.plan, asOf, options);
      forecastMs += performance.now() - start;
      hashes.push(input.id + '@+' + shift + ':' + crypto.createHash('sha256').update(JSON.stringify(advice)).digest('hex'));
    }
  }
  process.stdout.write(JSON.stringify({ forecastMs, hashes }) + '\n');
} else {
  const base = process.argv[2];
  assert.ok(base, 'usage: node test/profile-forecast-date-memo.js <base-tree>');
  const head = path.join(__dirname, '..');
  const sample = root => {
    const child = spawnSync(process.execPath, [__filename, '--sample', root], { encoding: 'utf8', timeout: 300000 });
    assert.equal(child.status, 0, child.stderr || 'sample failed');
    return JSON.parse(child.stdout.trim().split('\n').pop());
  };
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push({ tree: 'base', ...sample(base) }, { tree: 'head', ...sample(head) });
  const reference = runs[0].hashes;
  for (const run of runs) assert.deepEqual(run.hashes, reference, run.tree + ' advice differs');
  const mean = tree => runs.filter(run => run.tree === tree).reduce((sum, run) => sum + run.forecastMs, 0) / 3;
  console.log(JSON.stringify({ schema: 'atlas-forecast-date-memo-profile/v1', runtime: process.version,
    input: 'invented figures inputs x ' + SHIFTS.length + ' as-of dates', coldProcesses: runs.length,
    evaluations: reference.length, identicalAdvice: true,
    baseMeanForecastMs: +mean('base').toFixed(1), headMeanForecastMs: +mean('head').toFixed(1),
    improvementPercent: +((1 - mean('head') / mean('base')) * 100).toFixed(1) }, null, 2));
}
