'use strict';

// One home for how a simulator failure is named. The runner groups and
// shrinks by this signature, and the known-failure gate matches recorded
// entries by the invariant plus this signature, so the two cannot drift.
function effect(f) {
  if (Number.isSafeInteger(f.expected))
    return f.actual == null ? 'withheld' : f.actual < f.expected ? 'too-low' : 'too-high';
  if (Array.isArray(f.expected) && f.cause.startsWith('last-known/'))
    return [
      f.actual[0] == null ? 'unknown' : f.actual[0] === f.expected[0] ? 'same' : 'changed',
      f.actual[1],
    ].join('/');
  return f.check;
}
function signature(f) {
  return [f.cause, f.figure, f.habit, effect(f)].join('|');
}
module.exports = { effect, signature };
