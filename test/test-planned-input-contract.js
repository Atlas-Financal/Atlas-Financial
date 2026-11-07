'use strict';
// Synthetic contract evidence only: no filesystem persistence or production adapter.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const C = require('../scripts/planned-input-contract');
const householdId = 'household-' + 'a'.repeat(32);
const otherHousehold = 'household-' + 'b'.repeat(32);
const actorId = 'session-' + 'c'.repeat(64);
const otherActor = 'session-' + 'd'.repeat(64);
const now = Date.parse('2030-01-01T12:00:00.000Z');
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const copy = value => JSON.parse(JSON.stringify(value));
const rows = () => [
  { id: 'synthetic-a', label: 'Synthetic target A', amount: 120, date: '2030-04-10',
    confidence: 'estimated', sinkingFund: true, group: 'synthetic-group', note: 'Invented fixture' },
  { id: 'synthetic-b', label: 'Synthetic target B', amount: null, date: null,
    confidence: 'unknown', sinkingFund: true },
];
const command = (changes = { amount: 150 }, headOperationId = null, kind = 'correct', goalId = 'commitment:synthetic-a') =>
  ({ version: 1, kind, goalId, headOperationId, changes });
const adopt = (source = rows()) => C.adoptLegacy({ householdId, legacyCommitments: source,
  expectedLegacyFingerprint: C.legacyFingerprint(source) });
const prepare = (body, n = 1, edit = command(), source = rows(), overrides = {}) =>
  C.prepare(body, { householdId, actorId, operationId: op(n), command: edit, legacyCommitments: source, now, ...overrides });
const confirm = (body, prepared, overrides = {}) => C.confirmCandidate(body,
  { householdId, actorId, ...prepared, legacyCommitments: rows(), now: now + 1, ...overrides });
const composed = (body, source = rows()) => C.compose(body, { householdId, legacyCommitments: source });
const outcome = (body, n = 1, overrides = {}) => C.outcome(body, { householdId, actorId, operationId: op(n), ...overrides });
let checks = 0;
const eq = (actual, expected, why) => { assert.deepEqual(actual, expected, why); checks++; };
const refuses = (fn, why) => { assert.throws(fn, /planned-input-unavailable/, why); checks++; };
const rejects = async (fn, why) => { await assert.rejects(fn, /synthetic-(?:before|after|cas)/, why); checks++; };

// The test adapter serializes CAS, document and receipt as one transition. It is
// deliberately confined here and proves no deployed or filesystem durability.
function syntheticAdapter(document, independentPin) {
  let body = C.restore(document, independentPin), tail = Promise.resolve();
  return {
    read: () => body,
    pin: () => C.pin(body, householdId),
    install(candidate, fault = null) {
      const result = tail.then(() => {
        assert.equal(candidate.status, 'candidate');
        if (JSON.stringify(C.pin(body, householdId)) !== JSON.stringify(candidate.expectedPin)) throw new Error('synthetic-cas');
        C.restore(candidate.document, candidate.nextPin);
        if (fault === 'before') throw new Error('synthetic-before');
        body = candidate.document;
        if (fault === 'after') throw new Error('synthetic-after');
        return C.verifyReadback(body, candidate);
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

function adoptionAndRestore() {
  const source = rows(), before = JSON.stringify(source), body = adopt(source), initialPin = C.pin(body, householdId);
  eq(initialPin.revision, 0, 'adoption has no correction history');
  eq(composed(body), source, 'adoption preserves the complete native rows');
  eq(C.restore(body, initialPin), body, 'restore accepts the independently pinned exact document');
  eq(JSON.stringify(source), before, 'adoption and composition leave source input untouched');
  eq(C.legacyFingerprint([...source].reverse()), C.legacyFingerprint(source), 'legacy identity ignores native row order');
  eq(composed(body, [...source].reverse()), [...source].reverse(), 'composition preserves caller native order');
  refuses(() => C.adoptLegacy({ householdId, legacyCommitments: source, expectedLegacyFingerprint: '0'.repeat(64) }), 'adoption requires exact expected legacy evidence');
  refuses(() => C.pin(body, otherHousehold), 'document belongs to one household');
  refuses(() => C.restore(body, { ...initialPin, revision: 1 }), 'restore rejects a mismatched revision');
  refuses(() => C.restore(body, { ...initialPin, documentDigest: '0'.repeat(64) }), 'restore rejects a mismatched document pin');
  refuses(() => C.restore(body + '\n', initialPin), 'equivalent JSON bytes are not the exact pinned backup');
  refuses(() => C.restore(body, { ...initialPin, unused: true }), 'restore pin rejects unknown fields');
  for (const invalid of ['', '{', 'null', body.replace(C.SCHEMA, 'atlas-private-planned-inputs/v99')]) {
    refuses(() => C.pin(invalid, householdId), 'missing, corrupt and unknown-schema documents fail closed');
  }
  const tampered = JSON.parse(body); tampered.state.legacy.commitments[0].amount = 999;
  refuses(() => C.pin(JSON.stringify(tampered), householdId), 'document checksum detects changed bytes');
  tampered.digest = C.digest(tampered.state);
  refuses(() => C.pin(JSON.stringify(tampered), householdId), 'recomputed envelope does not bypass legacy fingerprint');
  for (const invalid of [[], [source[0], source[0]], [{ amount: 1 }], [{ id: 'Bad ID' }], [{ id: 'constructor' }]]) {
    if (invalid[0]?.id === 'constructor') {
      // An identifier is a Map key, never an object-property authority.
      eq(composed(adopt(invalid), invalid), invalid, 'prototype-looking native ID remains an inert Map key');
    } else refuses(() => adopt(invalid), 'empty inventory, duplicate and missing/invalid native IDs fail closed');
  }
  const renamed = rows(); renamed[0].label = 'Changed source label';
  refuses(() => composed(body, renamed), 'matching ID does not silently adopt changed source evidence');
}

function strictInputs() {
  const body = adopt();
  for (const changes of [{}, { id: 'replacement' }, { label: 'Replacement' }, { confidence: 'confirmed' },
    { sinkingFund: false }, { amount: 1, arbitrary: true }, { amount: -1 }, { amount: 0.001 },
    { amount: NaN }, { amount: Infinity }, { amount: Number.MAX_SAFE_INTEGER }, { amount: '10' },
    { date: '2030-02-30' }, { date: '2030-1-01' }, { date: '2030-01-01T00:00:00Z' }]) {
    refuses(() => prepare(body, 1, command(changes)), 'only valid point amount/date inputs are admitted');
  }
  for (const edit of [command({ amount: 120 }), { ...command(), version: 2 }, { ...command(), kind: 'append' },
    command({ amount: 150 }, null, 'correct', 'synthetic-a'), command({ amount: 150 }, null, 'correct', 'commitment:absent'),
    command(null, null, 'retract'), command({ amount: 150 }, op(9)), { ...command(), extra: true }]) {
    refuses(() => prepare(body, 1, edit), 'no-op, malformed commands and unknown or obsolete heads fail closed');
  }
  for (const field of ['amountMin', 'amountMax', 'amountSchedule', 'dateWindow', 'paymentTiming']) {
    const source = rows(); source[0][field] = field === 'amountSchedule' ? [] : 1;
    refuses(() => prepare(adopt(source), 1, command(), source), 'complex schedules and ranges are outside this correction slice');
  }
  const settled = rows(); settled[0].settled = true;
  refuses(() => prepare(adopt(settled), 1, command(), settled), 'settled commitments cannot be rewritten');
  for (const settledOn of ['2030-01-10', '', null, 'invalid']) {
    const source = rows(); source[0].settledOn = settledOn;
    for (const edit of [command(), command(null, null, 'remove')]) {
      refuses(() => prepare(adopt(source), 1, edit, source), 'native settlement metadata needs its own qualified lifecycle');
    }
  }
  for (const ownerPaid of [{ amount: 10, confirmedOn: '2030-01-10' }, null, 'invalid']) {
    const source = rows(); source[0].ownerPaid = ownerPaid;
    for (const edit of [command(), command(null, null, 'remove')]) {
      refuses(() => prepare(adopt(source), 1, edit, source), 'an owner partial confirmation is settlement metadata too');
    }
  }
  for (const confidence of ['verified', 'confirmed', undefined]) {
    const source = rows();
    if (confidence === undefined) delete source[0].confidence;
    else source[0].confidence = confidence;
    refuses(() => prepare(adopt(source), 1, command(), source), 'changed input cannot inherit old verified or unsupported trust');
  }
  for (const when of ['Apr 2030', 'by April 2030', 'sometime']) {
    const source = rows(); source[0].when = when;
    refuses(() => prepare(adopt(source), 1, command({ date: null }), source), 'explicit unknown date cannot leave a fallback date');
    eq(prepare(adopt(source), 1, command({ date: '2030-06-01' }), source).after.date, '2030-06-01', 'explicit point date still overrides retained when');
  }
  const mutable = command(), before = copy(mutable), prepared = prepare(body, 1, mutable);
  mutable.changes.amount = 999;
  eq(prepared.preview.command, before, 'preview owns its exact original command');
  const p = prepare(body, 2, command({ amount: null, date: null }));
  eq([p.after.amount, p.after.date, p.after.confidence], [null, null, 'estimated'], 'unknown input remains unknown without promoting trust');
}

function staleAndBinding() {
  const body = adopt(), prepared = prepare(body), original = JSON.stringify(prepared);
  const later = confirm(body, prepare(body, 2));
  eq(confirm(later.document, prepared), { status: 'rejected', reason: 'revision-changed' }, 'stale document never rebases');
  eq(confirm(body + '\n', prepared), { status: 'rejected', reason: 'revision-changed' }, 'preview pins exact original document bytes');
  const source = rows(); source[1].amount = 20;
  eq(confirm(body, prepared, { legacyCommitments: source }), { status: 'rejected', reason: 'source-changed' }, 'changed independent target still invalidates full-source preview');
  for (const clock of [now - 1, now + C.TTL_MS, now + C.TTL_MS + 1]) {
    eq(confirm(body, prepared, { now: clock }), { status: 'rejected', reason: 'preview-expired' }, 'future-issued and expired previews reject');
  }
  refuses(() => confirm(body, prepared, { actorId: otherActor }), 'another session cannot confirm the preview');
  refuses(() => confirm(body, prepared, { householdId: otherHousehold }), 'another household cannot confirm the preview');
  refuses(() => confirm(body, prepared, { confirmationDigest: '0'.repeat(64) }), 'confirmation must bind the exact preview');
  const changed = copy(prepared); changed.preview.command.changes.amount = 900;
  refuses(() => confirm(body, changed), 'changing preview content invalidates original confirmation');
  eq(JSON.stringify(prepared), original, 'candidate creation leaves retained preview unchanged');
  const reordered = confirm(body, prepared, { legacyCommitments: rows().reverse() });
  eq(composed(reordered.document).map(row => [row.id, row.amount]), [['synthetic-a', 150], ['synthetic-b', null]], 'reordering never retargets a correction');
  eq(outcome(body), { status: 'unknown', operationId: op(1) }, 'candidate creation alone is not a saved receipt');
}

async function lineageAndRetry() {
  const source = rows(), original = copy(source), initial = adopt(source), adapter = syntheticAdapter(initial, C.pin(initial, householdId));
  const first = prepare(initial, 1, command({ amount: 150, date: '2030-05-20' }), source), candidate = confirm(initial, first);
  eq(candidate.status, 'candidate', 'confirmation produces an uncommitted candidate');
  refuses(() => C.verifyReadback(initial, candidate), 'old bytes cannot acknowledge a candidate');
  const receipt = await adapter.install(candidate);
  eq(receipt, { status: 'recorded', operationId: op(1), revision: 1 }, 'readback proves the operation and revision together');
  eq(composed(adapter.read()), [{ ...source[0], amount: 150, date: '2030-05-20' }, source[1]], 'correction preserves every other field and native ID');
  eq(source, original, 'the source rows are never mutated');
  eq(confirm(adapter.read(), first, { now: now + C.TTL_MS + 1 }), { status: 'already-recorded', receipt }, 'exact retry recovers receipt even after preview expiry');
  eq(outcome(adapter.read(), 1, { actorId: otherActor }), { status: 'unknown', operationId: op(1) }, 'receipt lookup is actor-scoped');
  refuses(() => prepare(adapter.read(), 1), 'recorded operation ID cannot prepare a new payload');
  const collision = copy(first); collision.preview.command.changes.amount = 800; collision.confirmationDigest = C.digest(collision.preview);
  refuses(() => confirm(adapter.read(), collision), 'same operation with changed exact request conflicts');
  const other = copy(first); other.preview.actorId = otherActor; other.confirmationDigest = C.digest(other.preview);
  refuses(() => confirm(adapter.read(), other, { actorId: otherActor }), 'operation cannot be reused by another actor');
  refuses(() => C.restore(initial, adapter.pin()), 'valid older backup cannot masquerade as the independently pinned head');
  const second = prepare(adapter.read(), 2, command(null, op(1), 'remove'));
  await adapter.install(confirm(adapter.read(), second, { now: now + 2 }));
  eq(composed(adapter.read()), [source[1]], 'remove is an effective tombstone');
  const history = JSON.parse(adapter.read()).state.operations;
  eq([history[0].before, history[0].after, history[1].before, history[1].after],
    [source[0], { ...source[0], amount: 150, date: '2030-05-20' }, { ...source[0], amount: 150, date: '2030-05-20' }, null],
    'tombstone preserves original and corrected predecessor evidence');
  refuses(() => prepare(adapter.read(), 3, command({ amount: 180 }, op(1))), 'superseded head cannot fork lineage');
  const third = prepare(adapter.read(), 3, command(null, op(2), 'retract'));
  await adapter.install(confirm(adapter.read(), third, { now: now + 3 }));
  eq(composed(adapter.read()), [{ ...source[0], amount: 150, date: '2030-05-20' }, source[1]], 'retract restores the immediate predecessor of removal');
  eq(JSON.parse(adapter.read()).state.operations.slice(0, 2), history, 'retraction leaves predecessor events immutable');
  const badHistory = JSON.parse(adapter.read()); badHistory.state.operations[1].before.amount = 123;
  badHistory.digest = C.digest(badHistory.state);
  refuses(() => C.pin(JSON.stringify(badHistory), householdId), 'recomputed checksum cannot conceal a broken predecessor chain');
  const separate = prepare(initial, 4), fixed = confirm(initial, separate);
  const undo = prepare(fixed.document, 5, command(null, op(4), 'retract'));
  eq(composed(confirm(fixed.document, undo, { now: now + 2 }).document), source, 'retract of correction returns the exact native input');
  return { body: adapter.read(), pin: adapter.pin() };
}

async function atomicSyntheticEvidence() {
  const body = adopt(), pin = C.pin(body, householdId), adapter = syntheticAdapter(body, pin);
  const a = confirm(body, prepare(body, 10)), b = confirm(body, prepare(body, 11, command({ amount: 180 })));
  const result = await Promise.allSettled([adapter.install(a), adapter.install(b)]);
  eq(result.map(row => row.status), ['fulfilled', 'rejected'], 'serialized competing candidates admit one writer');
  eq(result[1].reason.message, 'synthetic-cas', 'second candidate fails exact-pin CAS');
  eq([outcome(adapter.read(), 10).status, outcome(adapter.read(), 11).status], ['recorded', 'unknown'], 'no receipt is created for failed candidate');
  eq(C.pin(adapter.read(), householdId).revision, 1, 'only one atomic transition increments the revision');
  for (const fault of ['before', 'after']) {
    const fresh = syntheticAdapter(body, pin), prepared = prepare(body, fault === 'before' ? 20 : 21), candidate = confirm(body, prepared);
    await rejects(() => fresh.install(candidate, fault), 'injected uncertain write interrupts caller acknowledgement');
    const independentPin = fault === 'before' ? pin : candidate.nextPin;
    const restarted = syntheticAdapter(JSON.parse(JSON.stringify(fresh.read())), copy(independentPin));
    eq(outcome(restarted.read(), fault === 'before' ? 20 : 21).status, fault === 'before' ? 'unknown' : 'recorded', 'restart distinguishes pre-commit failure from lost post-commit response');
    eq(C.pin(restarted.read(), householdId).revision, fault === 'before' ? 0 : 1, 'candidate and receipt never survive separately');
    if (fault === 'before') {
      eq((await restarted.install(candidate)).revision, 1, 'verified missing outcome permits one explicit retry');
    } else {
      eq(confirm(restarted.read(), prepared).status, 'already-recorded', 'lost response retries read the original receipt');
      await rejects(() => restarted.install(candidate), 'already committed candidate cannot be written again');
    }
  }
}

function processRoundtrip(saved) {
  const script = "const C=require('./scripts/planned-input-contract');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const x=JSON.parse(s);C.restore(x.body,x.pin);process.stdout.write(JSON.stringify(C.outcome(x.body,x.request)));});";
  const child = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').resolve(__dirname, '..'),
    input: JSON.stringify({ ...saved, request: { householdId, actorId, operationId: op(3) } }), encoding: 'utf8' });
  eq(child.status, 0, 'fresh process validates independently pinned synthetic document over stdin');
  eq(JSON.parse(child.stdout), { status: 'recorded', operationId: op(3), revision: 3 }, 'fresh process recovers immutable synthetic operation outcome');
  eq(child.stderr, '', 'process roundtrip emits no private document or error detail');
}

async function main() {
  adoptionAndRestore(); strictInputs(); staleAndBinding();
  const saved = await lineageAndRetry();
  await atomicSyntheticEvidence(); processRoundtrip(saved);
  console.log('PASS planned-input-contract: ' + checks + ' synthetic checks');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
