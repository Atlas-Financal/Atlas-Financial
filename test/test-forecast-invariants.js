'use strict';

// All counterexamples are invented household specifications. Replay the first
// failing run with its seed and path, including shrinking decisions.
const fc = require('fast-check');
const assert = require('node:assert/strict');
const { properties: events } = require('./lib/forecast-event-properties');
const { properties: arithmetic } = require('./lib/forecast-arithmetic-properties');
const { properties: transformations } = require('./lib/forecast-metamorphic-properties');

const properties = [...events, ...arithmetic, ...transformations];
assert.deepEqual(properties.map(p => p.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
const { values } = require('node:util').parseArgs({
  options: {
    invariant: { type: 'string' },
    seed: { type: 'string' },
    path: { type: 'string' },
    runs: { type: 'string' },
  },
});

const seed = Number(values.seed ?? 20261122);
const runs = Number(values.runs ?? (values.seed === undefined ? 48 : 1));
assert(Number.isInteger(seed) && seed >= -2147483648 && seed <= 2147483647, 'signed 32-bit seed required');
assert(Number.isSafeInteger(runs) && runs > 0, 'positive run count required');
const selected = properties.filter(p => values.invariant === undefined || p.id === Number(values.invariant));
assert(selected.length, 'unknown invariant');
for (const { id, name, arbitrary, check } of selected) {
  const result = fc.check(fc.property(arbitrary, input => { check(input); }), {
    seed, numRuns: runs, path: values.path,
  });
  if (result.failed) {
    console.error(`FAIL invariant ${id} (${name}), seed ${seed}, shrunk invented input ${fc.stringify(result.counterexample[0])}`);
    console.error(`Replay: node test/test-forecast-invariants.js --invariant ${id} --seed=${seed} --path ${result.counterexamplePath}`);
    console.error(result.errorInstance);
    process.exitCode = 1;
  } else {
    console.log(`PASS invariant ${id} (${name}, ${runs} generated households, seed ${seed})`);
  }
}
