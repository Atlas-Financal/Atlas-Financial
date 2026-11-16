'use strict';
/* The acceptance harness builds invented worlds only, so its results must not
 * depend on the household's monthly periods file (#897 follow-up). The real
 * observation path (live-plan -> operating-answer loadPeriods) looks for
 * public/periods.json; under the harness it must read as absent.
 *
 * A spy is installed on fs before the harness loads, so it sees any read of
 * the household file that gets past the harness. Then an invented world is
 * built through the production path and through operating-answer's own
 * recommendOpts, as the registered harness suites do.
 *
 * `node test/test-acceptance-harness-hermetic-periods.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOUSEHOLD_PERIODS = path.join(ROOT, 'public', 'periods.json');
const seen = [];
const realExists = fs.existsSync;
const realRead = fs.readFileSync;
fs.existsSync = function (file, ...rest) {
  if (typeof file === 'string' && path.resolve(file) === HOUSEHOLD_PERIODS) seen.push('exists');
  return realExists.call(fs, file, ...rest);
};
fs.readFileSync = function (file, ...rest) {
  if (typeof file === 'string' && path.resolve(file) === HOUSEHOLD_PERIODS) seen.push('read');
  return realRead.call(fs, file, ...rest);
};

const H = require('./acceptance/harness.js');
const Op = require('../scripts/operating-answer.js');
const F = require('../public/forecast.js');

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); } catch (err) { failures++; console.log(`  FAIL  ${label} — ${err.message}`); }
}

check('positive control: the household periods file exists in this checkout', () => {
  assert.equal(realExists.call(fs, HOUSEHOLD_PERIODS), true);
});

let built;
check('an invented world builds through the real observation path', () => {
  const w = H.baseWorld();
  w.bills = [{ id: 'hydro', label: 'Invented hydro', amount: 90, frequency: 'monthly', day: 12, confidence: 'confirmed' }];
  built = H.dataOf(w);
  assert.ok(built && built.data && built.data.plan, 'plan built');
  assert.ok(!built.error, String(built.error));
});

check('operating-answer gives Forecast no household periods for an invented world', () => {
  const opts = Op.recommendOpts(built.data, {});
  assert.equal(opts.periods, null);
  const advice = F.recommend(built.data.plan, built.data.plan.opening.asOf, opts);
  assert.ok(advice && advice.paydayAllocation, 'Forecast still answers');
});

check('nothing read the household periods file past the harness', () => {
  assert.deepEqual(seen, []);
});

check('other files still read normally under the harness', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'package.json')), true);
  assert.match(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'), /"name"/);
});

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll harness hermetic-periods checks passed.');
