'use strict';
// G1 compatibility for the enabled PR1 foundation, invented input only.
// G1's fixed root grammar and validators remain unchanged.
const assert = require('node:assert/strict');
const { fixture, observe } = require('./test-savings-link-foundation');
const consumer = require('./fixtures/savings-daily-consumer-data');
const Snapshot = require('../scripts/figures-snapshot');
const Comment = require('../scripts/figures-comment');
const x = fixture(), data = consumer();
data.plan = x.plan; data.meta.asOf = x.asOf;
data.liveOverlay.currentPeriodActuals = observe(x);
const without = structuredClone(data);
delete without.liveOverlay.currentPeriodActuals.savingsLinks;
const financial = value => Snapshot.buildFiguresSnapshot(value, null);
const capture = value => ({ ...financial(value), ...Snapshot.captureEvidence(value, null) });
assert.equal(Comment.captureEvidenceProblems(capture(without), ['']), 0, 'unchanged no-link capture remains valid');
assert.equal(Comment.captureEvidenceProblems(capture(data), ['']), 0,
  'enabled foundation must fit the existing G1 publication grammar without a validator change');
assert.deepEqual(financial(data), financial(without), 'all itemized financial fields are identical with links enabled');
console.log('Enabled savings link foundation: G1 capture valid; itemized financial fields unchanged.');
