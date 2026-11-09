'use strict';
/* Run one long node:test suite as several smaller suites, so the standard
 * shards can run its parts at the same time on different runners.
 *
 * The suite's cases live in one cases module. Each part file names its part
 * and then loads that module; the module asks `testFor` for its `test`
 * function. Every case is assigned to exactly one part by name, in the cases
 * module itself, and each part fails closed:
 *
 *   - a case whose name is not assigned throws at registration (a new case
 *     can never be silently left out of every part);
 *   - `verify` fails the part unless the names the module registered are
 *     exactly the assigned names, each once, and every part has a case.
 *
 * Every part loads the whole module, so each part independently proves the
 * whole assignment; a part runs only its own cases. Assertions are untouched.
 */
const nodeTest = require('node:test');

let selected = null;

// `part` is a part number, or 'list' to register nothing and only record the
// case names and the assignment (test/test-suite-parts.js uses it to prove the
// real assignment without building any figures).
function select(suite, part) {
  if (selected) throw new Error('suite part already selected');
  if (typeof suite !== 'string' || !(part === 'list' || (Number.isInteger(part) && part >= 1))) {
    throw new Error('invalid suite part');
  }
  selected = { suite, part, registered: [], assignment: null, parts: 0 };
}

function testFor(suite, parts, assignment) {
  if (!selected || selected.suite !== suite) {
    throw new Error(`${suite} cases run only through their part files (test/test-${suite}-part-<n>.js)`);
  }
  if (selected.assignment) throw new Error('cases module loaded twice');
  if (!Number.isInteger(parts) || parts < 2 || (selected.part !== 'list' && selected.part > parts)) throw new Error('invalid part count');
  for (const [name, part] of Object.entries(assignment)) {
    if (!Number.isInteger(part) || part < 1 || part > parts) throw new Error(`invalid part for case: ${name}`);
  }
  selected.assignment = assignment;
  selected.parts = parts;
  return function test(name, ...rest) {
    if (!Object.prototype.hasOwnProperty.call(assignment, name)) {
      throw new Error(`case is assigned to no part: ${name}`);
    }
    selected.registered.push(name);
    if (assignment[name] === selected.part) return nodeTest(name, ...rest);
    return undefined;
  };
}

// Called by the part file after the cases module has loaded.
function verify() {
  const s = selected;
  if (!s || !s.assignment) throw new Error('no cases module was loaded');
  const assigned = Object.keys(s.assignment);
  const seen = new Set(s.registered);
  const problems = [];
  if (seen.size !== s.registered.length) problems.push('a case name is registered twice');
  for (const name of assigned) if (!seen.has(name)) problems.push(`assigned case never registered: ${name}`);
  for (let part = 1; part <= s.parts; part++) {
    if (!assigned.some(name => s.assignment[name] === part)) problems.push(`part ${part} has no case`);
  }
  if (problems.length) throw new Error(problems.join('; '));
  return { parts: s.parts, registered: [...s.registered], assignment: { ...s.assignment } };
}

module.exports = { select, testFor, verify };
