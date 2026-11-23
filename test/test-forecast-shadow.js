'use strict';

const assert = require('node:assert/strict');
const { isDeepStrictEqual, parseArgs } = require('node:util');
const fc = require('fast-check');
const { household, makeHousehold } = require('./shadow/households');
const { expectedPeriod } = require('./shadow/period');
const { expectedCash } = require('./shadow/cash-card');
const { observedPeriod } = require('./shadow/observed-period');
const { observedCash } = require('./shadow/observed-cash');
const { statementCase, compareStatement } = require('./shadow/statement-crossing');
const { paymentCase, compareOpeningPayments } = require('./shadow/opening-payments');
const { checkLeapHorizon } = require('./shadow/leap-horizon');

const { values } = parseArgs({ options: {
  runs: { type: 'string', default: '2048' }, seed: { type: 'string', default: '20261123' },
  path: { type: 'string' }, field: { type: 'string' }, scan: { type: 'boolean' },
} });
const numRuns = Number(values.runs);
const seed = Number(values.seed);
assert.ok(Number.isSafeInteger(numRuns) && numRuns > 0, 'runs must be a positive integer');
assert.ok((seed | 0) === seed, 'seed must be a signed 32-bit integer');
assert.ok(!values.path || values.field, 'select the failing field or family when replaying a path');

function run(name, arbitrary, check) {
  const result = fc.check(fc.property(arbitrary, check), { seed, numRuns, path: values.path });
  if (result.failed) {
    console.error(`${name}: invented counterexample after ${result.numShrinks} shrinks, seed ${seed}, path ${result.counterexamplePath}`);
    console.error(fc.stringify(result.counterexample));
    console.error(result.errorInstance);
    process.exitCode = 1;
  } else {
    console.log(`${name}: ${result.numRuns} generated cases completed (seed ${seed}).`);
  }
}

// In scan mode visit the whole corpus and group disagreements by publication.
// A field-specific replay shrinks against that field so a different discrepancy
// cannot replace the original failure during shrinking.
const scan = new Map();
let caseNumber = 0;
function compareHousehold(input) {
  const facts = makeHousehold(input);
  let selected = false;
  for (const [group, expected, observed] of [
    ['period', expectedPeriod, observedPeriod], ['cash', expectedCash, observedCash],
  ]) {
    if (values.field && !values.field.startsWith(group + '.')) continue;
    const want = expected(facts);
    const got = observed(facts);
    // A household with only semi-monthly wages has no operating payroll cycle.
    if (want === null || got === null) {
      assert.deepEqual(got, want, group + ' availability');
      selected = true;
      continue;
    }
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), group + ' publication shape');
    for (const [key, expectedValue] of Object.entries(want)) {
      const name = `${group}.${key}`;
      if (values.field && values.field !== name) continue;
      selected = true;
      if (!values.scan) {
        assert.deepEqual(got[key], expectedValue, name);
      } else if (!isDeepStrictEqual(got[key], expectedValue)) {
        const mismatch = scan.get(name) || { count: 0, first: caseNumber };
        mismatch.count++;
        scan.set(name, mismatch);
      }
    }
  }
  assert.ok(selected, 'no such shadow figure: ' + values.field);
  caseNumber++;
}

if (!values.field || /^(period|cash)\./.test(values.field)) {
  run('household', household, compareHousehold);
  for (const [name, { count, first }] of scan) {
    console.error(`${name}: ${count}/${caseNumber} differ. Isolate and shrink with --seed=${seed} --field=${name} --path=${first}`);
    process.exitCode = 1;
  }
}
if (!values.field || values.field === 'statement') run('statement', statementCase, compareStatement);
if (!values.field || values.field === 'opening') run('opening', paymentCase, compareOpeningPayments);
if (!values.field || values.field === 'leap') checkLeapHorizon(seed);
assert.ok(!values.field || /^(period|cash)\./.test(values.field) || ['statement', 'opening', 'leap'].includes(values.field), 'unknown field');
