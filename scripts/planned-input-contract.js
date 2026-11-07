'use strict';
// FOUNDATION - NOT COMPLETION. Pure private document transitions only.
// No filesystem, adapter, route, environment switch, provider or Forecast caller.
const crypto = require('node:crypto');
const SCHEMA = 'atlas-private-planned-inputs/v1';
const PREVIEW_SCHEMA = 'atlas-private-planned-input-preview/v1';
const TTL_MS = 10 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const fail = () => { throw new Error('planned-input-unavailable'); };
const check = value => { if (!value) fail(); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
function canonical(value, depth = 0) {
  check(depth < 30);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { check(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    check(Object.keys(value).length === value.length);
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  check(plain(value));
  return '{' + Object.keys(value).sort().map(key => {
    check(!['__proto__', 'constructor', 'prototype'].includes(key));
    return JSON.stringify(key) + ':' + canonical(value[key], depth + 1);
  }).join(',') + '}';
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(canonical(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,95}$/.test(value);
const household = value => typeof value === 'string' && /^household-[a-f0-9]{32}$/.test(value);
const actor = value => typeof value === 'string' && /^session-[a-f0-9]{64}$/.test(value);
const operation = value => typeof value === 'string' && /^operation-[a-f0-9]{32}$/.test(value);
const tick = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 - TTL_MS;
function keys(value, names) {
  check(plain(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k)));
}
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function amount(value) {
  return value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0
    && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
}
function inventory(rows) {
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 200);
  const ids = new Set();
  for (const row of rows) {
    check(plain(row) && identifier(row.id) && !ids.has(row.id));
    ids.add(row.id);
  }
  return clone(rows);
}
function legacyFingerprint(rows) {
  return digest(inventory(rows).sort((a, b) => a.id.localeCompare(b.id)));
}
function commandValid(command) {
  keys(command, ['version', 'kind', 'goalId', 'headOperationId', 'changes']);
  check(command.version === 1 && ['correct', 'remove', 'retract'].includes(command.kind)
    && typeof command.goalId === 'string' && command.goalId.startsWith('commitment:')
    && identifier(command.goalId.slice('commitment:'.length))
    && (command.headOperationId === null || operation(command.headOperationId)));
  if (command.kind === 'correct') {
    check(plain(command.changes) && Object.keys(command.changes).length > 0
      && Object.keys(command.changes).every(k => ['amount', 'date'].includes(k)));
    if (Object.hasOwn(command.changes, 'amount')) check(amount(command.changes.amount));
    if (Object.hasOwn(command.changes, 'date')) check(command.changes.date === null || date(command.changes.date));
  } else check(command.changes === null);
  if (command.kind === 'retract') check(operation(command.headOperationId));
  return command;
}
function changedGoal(current, head, command) {
  check((head?.operationId || null) === command.headOperationId);
  if (command.kind === 'retract') { check(head); return clone(head.before); }
  // An owner's partial payment confirmation (ownerPaid) is settlement
  // metadata too: correcting its amount could silently void it.
  check(current !== null && current.settled !== true && !Object.hasOwn(current, 'settledOn')
    && !Object.hasOwn(current, 'ownerPaid'));
  if (command.kind === 'remove') return null; // Tombstone, not a payment or deletion of evidence.
  // A changed input must not inherit an institution-verified stamp from its predecessor.
  check(['estimated', 'unknown'].includes(current.confidence));
  // Point-input edits only. Ranges, schedules and timing contracts need their own handoff.
  check(!['amountMin', 'amountMax', 'amountSchedule', 'dateWindow', 'paymentTiming']
    .some(k => Object.hasOwn(current, k)));
  // Forecast owns parsing `when`; do not clear a date while retaining a fallback cash date.
  if (Object.hasOwn(command.changes, 'date') && command.changes.date === null) {
    check(current.when == null || current.when === '');
  }
  const next = { ...current, ...clone(command.changes) };
  check(digest(next) !== digest(current));
  return next;
}
function replay(state) {
  const current = new Map(state.legacy.commitments.map(row => ['commitment:' + row.id, clone(row)]));
  const heads = new Map(), ids = new Set();
  for (const [index, event] of state.operations.entries()) {
    keys(event, ['revision', 'operationId', 'actorId', 'recordedAt', 'requestDigest', 'command', 'before', 'after']);
    commandValid(event.command);
    check(event.revision === index + 1 && operation(event.operationId) && !ids.has(event.operationId)
      && actor(event.actorId) && hash(event.requestDigest) && tick(event.recordedAt)
      && (index === 0 || event.recordedAt >= state.operations[index - 1].recordedAt)
      && current.has(event.command.goalId));
    ids.add(event.operationId);
    check(digest(current.get(event.command.goalId)) === digest(event.before));
    const after = changedGoal(event.before, heads.get(event.command.goalId), event.command);
    check(digest(after) === digest(event.after));
    current.set(event.command.goalId, clone(after)); heads.set(event.command.goalId, event);
  }
  return { current, heads };
}
function encode(state) {
  const body = canonical({ schema: SCHEMA, state, digest: digest(state) });
  check(Buffer.byteLength(body) <= MAX_BYTES);
  return body;
}
function decode(body, householdId) {
  check(typeof body === 'string' && Buffer.byteLength(body) <= MAX_BYTES && household(householdId));
  let doc;
  try { doc = JSON.parse(body); } catch { fail(); }
  keys(doc, ['schema', 'state', 'digest']); check(doc.schema === SCHEMA && doc.digest === digest(doc.state));
  const state = doc.state;
  keys(state, ['householdId', 'revision', 'legacy', 'operations']);
  keys(state.legacy, ['fingerprint', 'commitments']);
  check(state.householdId === householdId && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.operations) && state.operations.length <= 1000 && state.revision === state.operations.length
    && state.legacy.fingerprint === legacyFingerprint(state.legacy.commitments));
  replay(state);
  return state;
}
function adoptLegacy({ householdId, legacyCommitments, expectedLegacyFingerprint }) {
  check(household(householdId) && hash(expectedLegacyFingerprint)
    && legacyFingerprint(legacyCommitments) === expectedLegacyFingerprint);
  return encode({ householdId, revision: 0,
    legacy: { fingerprint: expectedLegacyFingerprint, commitments: inventory(legacyCommitments) }, operations: [] });
}
function pin(body, householdId) {
  const state = decode(body, householdId);
  return { householdId, revision: state.revision, documentDigest: digest(body) };
}
function restore(body, expectedPin) {
  keys(expectedPin, ['householdId', 'revision', 'documentDigest']);
  check(hash(expectedPin.documentDigest));
  const actual = pin(body, expectedPin.householdId);
  check(actual.revision === expectedPin.revision && actual.documentDigest === expectedPin.documentDigest);
  return body; // Validation only. Never installs a backup or guesses the latest revision.
}
function compose(body, { householdId, legacyCommitments }) {
  const state = decode(body, householdId);
  check(legacyFingerprint(legacyCommitments) === state.legacy.fingerprint);
  const { current } = replay(state);
  // Preserve native order, metadata and identity; Forecast consumes these inputs later.
  return inventory(legacyCommitments).map(row => clone(current.get('commitment:' + row.id))).filter(row => row !== null);
}
function prepare(body, { householdId, actorId, operationId, command, legacyCommitments, now }) {
  const state = decode(body, householdId);
  check(actor(actorId) && operation(operationId) && tick(now));
  check(!state.operations.some(event => event.operationId === operationId));
  check(legacyFingerprint(legacyCommitments) === state.legacy.fingerprint);
  command = clone(command); commandValid(command);
  const { current, heads } = replay(state); check(current.has(command.goalId));
  const before = current.get(command.goalId), after = changedGoal(before, heads.get(command.goalId), command);
  const preview = { schema: PREVIEW_SCHEMA, householdId, actorId, operationId,
    expectedRevision: state.revision, expectedDocumentDigest: digest(body),
    legacyFingerprint: state.legacy.fingerprint, issuedAt: now, expiresAt: now + TTL_MS, command };
  // Entire return value is private. The caller must retain the preview server-side.
  return { preview, confirmationDigest: digest(preview), before: clone(before), after: clone(after) };
}
function previewValid(preview) {
  keys(preview, ['schema', 'householdId', 'actorId', 'operationId', 'expectedRevision',
    'expectedDocumentDigest', 'legacyFingerprint', 'issuedAt', 'expiresAt', 'command']);
  check(preview.schema === PREVIEW_SCHEMA && household(preview.householdId) && actor(preview.actorId)
    && operation(preview.operationId) && Number.isSafeInteger(preview.expectedRevision) && preview.expectedRevision >= 0
    && hash(preview.expectedDocumentDigest) && hash(preview.legacyFingerprint) && tick(preview.issuedAt)
    && preview.expiresAt === preview.issuedAt + TTL_MS);
  commandValid(preview.command);
}
const receipt = event => ({ status: 'recorded', operationId: event.operationId, revision: event.revision });
function outcome(body, { householdId, actorId, operationId }) {
  check(actor(actorId) && operation(operationId));
  const state = decode(body, householdId);
  const event = state.operations.find(e => e.operationId === operationId && e.actorId === actorId);
  return event ? receipt(event) : { status: 'unknown', operationId };
}
function confirmCandidate(body, { householdId, actorId, preview, confirmationDigest, legacyCommitments, now }) {
  // This creates bytes, NOT a saved result. CAS + durable write + readback belong to a future approved adapter.
  const state = decode(body, householdId);
  preview = clone(preview); previewValid(preview);
  check(actor(actorId) && preview.actorId === actorId && preview.householdId === householdId && tick(now)
    && hash(confirmationDigest) && digest(preview) === confirmationDigest);
  const existing = state.operations.find(event => event.operationId === preview.operationId);
  if (existing) {
    check(existing.actorId === actorId && existing.requestDigest === confirmationDigest);
    return { status: 'already-recorded', receipt: receipt(existing) };
  }
  const reason = now < preview.issuedAt || now >= preview.expiresAt ? 'preview-expired'
    : state.revision !== preview.expectedRevision || digest(body) !== preview.expectedDocumentDigest ? 'revision-changed'
    : legacyFingerprint(legacyCommitments) !== preview.legacyFingerprint ? 'source-changed' : null;
  if (reason) return { status: 'rejected', reason };
  check(state.operations.length < 1000 && (!state.operations.length || now >= state.operations.at(-1).recordedAt));
  const { current, heads } = replay(state); check(current.has(preview.command.goalId));
  const before = current.get(preview.command.goalId);
  const after = changedGoal(before, heads.get(preview.command.goalId), preview.command);
  const event = { revision: ++state.revision, operationId: preview.operationId, actorId,
    recordedAt: now, requestDigest: confirmationDigest, command: preview.command, before, after };
  state.operations.push(event);
  const document = encode(state); decode(document, householdId);
  return { status: 'candidate', expectedPin: pin(body, householdId), nextPin: pin(document, householdId), document };
}
function verifyReadback(body, candidate) {
  check(candidate.status === 'candidate');
  restore(body, candidate.nextPin);
  const state = decode(body, candidate.nextPin.householdId);
  return receipt(state.operations.at(-1));
}
module.exports = { SCHEMA, TTL_MS, digest, legacyFingerprint, adoptLegacy, pin, restore,
  compose, prepare, confirmCandidate, outcome, verifyReadback };

// ---------------------------------------------------------------------------
// Bill amount corrections (#768 Slice 1). FOUNDATION - NOT COMPLETION.
// Additive namespace with its own document and preview schemas; the commitment
// (v1) path above is unchanged and never reads or writes a bill document.
// Amount-only, known-amount-only records. No occurrence applicability, no
// Forecast integration, no caller, storage, route or activation.
const BILL_SCHEMA = 'atlas-private-planned-bill-inputs/v1';
const BILL_PREVIEW_SCHEMA = 'atlas-private-planned-bill-input-preview/v1';
const BILL_FREQUENCIES = Object.freeze(['monthly', 'quarterly', 'yearly', 'biweekly']);
const BILL_UNSUPPORTED = Object.freeze(['amountMin', 'amountMax', 'amountSchedule', 'dateWindow', 'paymentTiming']);
// Known amount only: currency units with exact cents. Never null, never coerced to zero.
const billAmount = value => value !== null && amount(value);
const billTarget = value => typeof value === 'string' && value.startsWith('bill:')
  && identifier(value.slice('bill:'.length));
function billCommandValid(command) {
  keys(command, ['version', 'kind', 'target', 'headOperationId', 'changes']);
  check(command.version === 1 && ['correct', 'reset'].includes(command.kind) && billTarget(command.target)
    && (command.headOperationId === null || operation(command.headOperationId)));
  if (command.kind === 'correct') {
    keys(command.changes, ['amount']);
    check(billAmount(command.changes.amount));
  } else check(command.changes === null);
  return command;
}
function changedBill(current, baselineRow, head, command) {
  check((head?.operationId || null) === command.headOperationId);
  // Incumbent settlement guards: a settled occurrence is never rewritten.
  check(plain(current) && current.settled !== true && !Object.hasOwn(current, 'settledOn'));
  // Reset restores the exact adopted row (still present, never a tombstone).
  if (command.kind === 'reset') { check(digest(current) !== digest(baselineRow)); return clone(baselineRow); }
  // Explicit estimated/unknown only. Missing, null, malformed, unrecognized and
  // confirmed are ineligible; Forecast's display fallback is not edit authority.
  check(Object.hasOwn(current, 'confidence') && ['estimated', 'unknown'].includes(current.confidence));
  check(BILL_FREQUENCIES.includes(current.frequency));
  check(Object.hasOwn(current, 'amount') && amount(current.amount));
  check(!BILL_UNSUPPORTED.some(k => Object.hasOwn(current, k)));
  const next = { ...current, amount: command.changes.amount };
  check(digest(next) !== digest(current));
  return next;
}
function billReplay(state) {
  const baseline = new Map(state.baseline.bills.map(row => ['bill:' + row.id, clone(row)]));
  const current = new Map([...baseline].map(([k, row]) => [k, clone(row)]));
  const heads = new Map(), ids = new Set();
  for (const [index, event] of state.operations.entries()) {
    keys(event, ['revision', 'operationId', 'actorId', 'recordedAt', 'requestDigest', 'command', 'before', 'after']);
    billCommandValid(event.command);
    check(event.revision === index + 1 && operation(event.operationId) && !ids.has(event.operationId)
      && actor(event.actorId) && hash(event.requestDigest) && tick(event.recordedAt)
      && (index === 0 || event.recordedAt >= state.operations[index - 1].recordedAt)
      && current.has(event.command.target));
    ids.add(event.operationId);
    check(digest(current.get(event.command.target)) === digest(event.before));
    const after = changedBill(event.before, baseline.get(event.command.target), heads.get(event.command.target), event.command);
    check(digest(after) === digest(event.after));
    current.set(event.command.target, clone(after)); heads.set(event.command.target, event);
  }
  return { baseline, current, heads };
}
function billEncode(state) {
  const body = canonical({ schema: BILL_SCHEMA, state, digest: digest(state) });
  check(Buffer.byteLength(body) <= MAX_BYTES);
  return body;
}
function billDecode(body, householdId) {
  check(typeof body === 'string' && Buffer.byteLength(body) <= MAX_BYTES && household(householdId));
  let doc;
  try { doc = JSON.parse(body); } catch { fail(); }
  keys(doc, ['schema', 'state', 'digest']); check(doc.schema === BILL_SCHEMA && doc.digest === digest(doc.state));
  const state = doc.state;
  keys(state, ['householdId', 'revision', 'baseline', 'operations']);
  keys(state.baseline, ['fingerprint', 'bills']);
  check(state.householdId === householdId && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.operations) && state.operations.length <= 1000 && state.revision === state.operations.length
    && state.baseline.fingerprint === legacyFingerprint(state.baseline.bills));
  billReplay(state);
  return state;
}
function billAdoptBaseline({ householdId, bills, expectedFingerprint }) {
  // Complete inventory adoption; unsupported rows are retained unchanged.
  check(household(householdId) && hash(expectedFingerprint) && legacyFingerprint(bills) === expectedFingerprint);
  return billEncode({ householdId, revision: 0,
    baseline: { fingerprint: expectedFingerprint, bills: inventory(bills) }, operations: [] });
}
function billPin(body, householdId) {
  const state = billDecode(body, householdId);
  return { householdId, revision: state.revision, documentDigest: digest(body) };
}
function billRestore(body, expectedPin) {
  keys(expectedPin, ['householdId', 'revision', 'documentDigest']);
  check(hash(expectedPin.documentDigest));
  const actual = billPin(body, expectedPin.householdId);
  check(actual.revision === expectedPin.revision && actual.documentDigest === expectedPin.documentDigest);
  return body; // Validation only.
}
function billCompose(body, { householdId, bills }) {
  // Private pure-record projection, not live Forecast integration.
  const state = billDecode(body, householdId);
  check(legacyFingerprint(bills) === state.baseline.fingerprint);
  const { current } = billReplay(state);
  return inventory(bills).map(row => clone(current.get('bill:' + row.id)));
}
function billPrepare(body, { householdId, actorId, operationId, command, bills, now }) {
  const state = billDecode(body, householdId);
  check(actor(actorId) && operation(operationId) && tick(now));
  check(!state.operations.some(event => event.operationId === operationId));
  check(legacyFingerprint(bills) === state.baseline.fingerprint);
  command = clone(command); billCommandValid(command);
  const { baseline, current, heads } = billReplay(state); check(current.has(command.target));
  const before = current.get(command.target);
  const after = changedBill(before, baseline.get(command.target), heads.get(command.target), command);
  const preview = { schema: BILL_PREVIEW_SCHEMA, householdId, actorId, operationId,
    expectedRevision: state.revision, expectedDocumentDigest: digest(body),
    baselineFingerprint: state.baseline.fingerprint, issuedAt: now, expiresAt: now + TTL_MS, command };
  // Entire return value is private. The caller must retain the preview server-side.
  return { preview, confirmationDigest: digest(preview), before: clone(before), after: clone(after) };
}
function billPreviewValid(preview) {
  keys(preview, ['schema', 'householdId', 'actorId', 'operationId', 'expectedRevision',
    'expectedDocumentDigest', 'baselineFingerprint', 'issuedAt', 'expiresAt', 'command']);
  check(preview.schema === BILL_PREVIEW_SCHEMA && household(preview.householdId) && actor(preview.actorId)
    && operation(preview.operationId) && Number.isSafeInteger(preview.expectedRevision) && preview.expectedRevision >= 0
    && hash(preview.expectedDocumentDigest) && hash(preview.baselineFingerprint) && tick(preview.issuedAt)
    && preview.expiresAt === preview.issuedAt + TTL_MS);
  billCommandValid(preview.command);
}
function billOutcome(body, { householdId, actorId, operationId }) {
  check(actor(actorId) && operation(operationId));
  const state = billDecode(body, householdId);
  const event = state.operations.find(e => e.operationId === operationId && e.actorId === actorId);
  return event ? receipt(event) : { status: 'unknown', operationId };
}
function billConfirmCandidate(body, { householdId, actorId, preview, confirmationDigest, bills, now }) {
  // Creates bytes, NOT a saved result. CAS + durable write + readback belong to a future approved adapter.
  const state = billDecode(body, householdId);
  preview = clone(preview); billPreviewValid(preview);
  check(actor(actorId) && preview.actorId === actorId && preview.householdId === householdId && tick(now)
    && hash(confirmationDigest) && digest(preview) === confirmationDigest);
  const existing = state.operations.find(event => event.operationId === preview.operationId);
  if (existing) {
    check(existing.actorId === actorId && existing.requestDigest === confirmationDigest);
    return { status: 'already-recorded', receipt: receipt(existing) };
  }
  const reason = now < preview.issuedAt || now >= preview.expiresAt ? 'preview-expired'
    : state.revision !== preview.expectedRevision || digest(body) !== preview.expectedDocumentDigest ? 'revision-changed'
    : legacyFingerprint(bills) !== preview.baselineFingerprint ? 'source-changed' : null;
  if (reason) return { status: 'rejected', reason };
  check(state.operations.length < 1000 && (!state.operations.length || now >= state.operations.at(-1).recordedAt));
  const { baseline, current, heads } = billReplay(state); check(current.has(preview.command.target));
  const before = current.get(preview.command.target);
  const after = changedBill(before, baseline.get(preview.command.target), heads.get(preview.command.target), preview.command);
  const event = { revision: ++state.revision, operationId: preview.operationId, actorId,
    recordedAt: now, requestDigest: confirmationDigest, command: preview.command, before, after };
  state.operations.push(event);
  const document = billEncode(state); billDecode(document, householdId);
  return { status: 'candidate', expectedPin: billPin(body, householdId), nextPin: billPin(document, householdId), document };
}
function billVerifyReadback(body, candidate) {
  check(candidate.status === 'candidate');
  billRestore(body, candidate.nextPin);
  const state = billDecode(body, candidate.nextPin.householdId);
  return receipt(state.operations.at(-1));
}
module.exports.bills = Object.freeze({ SCHEMA: BILL_SCHEMA, PREVIEW_SCHEMA: BILL_PREVIEW_SCHEMA, TTL_MS,
  fingerprint: legacyFingerprint, adoptBaseline: billAdoptBaseline, pin: billPin, restore: billRestore,
  compose: billCompose, prepare: billPrepare, confirmCandidate: billConfirmCandidate, outcome: billOutcome,
  verifyReadback: billVerifyReadback });
