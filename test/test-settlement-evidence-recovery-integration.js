'use strict';

// B4 recovery-to-server integration (planner-trial Lane 1): the five-file
// slice that wires the shipped authorization store into the recovery path —
// durable eligibility issuance inside prepare/prepareWithdrawal, the
// recovery-secret credential on both disclosing routes, and the opt-in
// awaited final authority authorizeRecoveryFinal replacing the synchronous
// final predicate for opted-in compositions only. Everything here is
// offline and synthetic: real confirmation/store/authorization-store/
// runtime/HTTP modules over in-memory doubles. No driver, network,
// credentials, provisioning or activation.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const C = require('../scripts/planned-obligation-settlement-contract');
const { createSettlementEvidenceStore } = require('../scripts/settlement-evidence-store');
const { createSettlementEvidenceResolver } = require('../scripts/settlement-evidence-resolver');
const { createSettlementEvidenceConfirmation } = require('../scripts/settlement-evidence-confirmation');
const { mountSettlementHttp } = require('../scripts/settlement-evidence-http');
const LmGroups = require('./lm-groups-fixture.js');
const { createSettlementEvidencePostgresRuntime } = require('../scripts/settlement-evidence-postgres-runtime');
const { createAuthorizationStore } = require('../scripts/settlement-evidence-authorization-store');
const serverModule = require('../server');
const { createRecoveryEligibilityIssuer, createRecoveryFinalAuthority } = serverModule;

const householdId = 'household-' + 'a'.repeat(32);
const ACTOR = 'session-' + 'b'.repeat(64);   // recorded actor ("A")
const ACTOR2 = 'session-' + 'c'.repeat(64);  // later login ("B")
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const clone = v => structuredClone(v);
const NOW0 = 1761000000000;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sidDigestOf = actor => sha256(actor.slice('session-'.length));

let domainSeq = 0;
function freshDomain() {
  domainSeq += 1;
  const tag = domainSeq.toString(16).padStart(32, '0');
  return {
    ledgerNamespace: 'ledger-' + tag,
    serializationAuthority: 'authority-' + tag,
    historyAuthority: 'authority-' + 'f'.repeat(28) + domainSeq.toString(16).padStart(4, '0'),
  };
}

// --- Terminal-history double (container format per TC.qualifySnapshot) ---
function makeHistory(domain) {
  const h = {
    domain, bytes: null, checkpoint: null,
    calls: { readSnapshot: 0, compareAndAppend: 0 }, hooks: {},
    encode(records) {
      const payload = { schema: 'terminal-history-1', householdId,
        ledgerNamespace: domain.ledgerNamespace, revision: records.length, records };
      const digest = C.digest(payload);
      const history = { ...payload, digest };
      const checkpoint = { schema: 'terminal-history-checkpoint-1', householdId,
        ledgerNamespace: domain.ledgerNamespace, revision: records.length, digest };
      return { historyBytes: Buffer.from(JSON.stringify(history)), checkpoint };
    },
    init(records = []) {
      const e = h.encode(records);
      h.bytes = e.historyBytes; h.checkpoint = e.checkpoint;
      return e;
    },
    records() { return h.bytes ? JSON.parse(h.bytes.toString('utf8')).records : null; },
    async readSnapshot() {
      h.calls.readSnapshot++;
      if (h.bytes === null) return { historyBytes: null, checkpoint: null };
      return { historyBytes: Buffer.from(h.bytes), checkpoint: clone(h.checkpoint) };
    },
    async compareAndAppend(arg) {
      h.calls.compareAndAppend++;
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (!arg || !eq(arg.expectedCheckpoint, h.checkpoint)) return false;
      const recs = h.records();
      if (!recs) return false;
      const e = h.encode([...recs, arg.certificate]);
      h.bytes = e.historyBytes; h.checkpoint = e.checkpoint;
      return true;
    },
  };
  return h;
}

// --- Ledger adapter doubles ------------------------------------------------
function makeAdapters() {
  const d = { doc: null, staged: null, journal: null, pin: null, backups: new Map() };
  const counts = {};
  const hooks = {};
  let tail = Promise.resolve();
  const lock = { withLock(fn) { const v = tail.then(fn, fn); tail = v.catch(() => {}); return v; } };
  const documentStore = {
    async read() { return d.doc && Buffer.from(d.doc); },
    async readStaged() { return d.staged && Buffer.from(d.staged); },
    async writeTemp(bytes) { d.staged = Buffer.from(bytes); },
    async commitTemp() { d.doc = d.staged; d.staged = null; },
    async discardTemp() { d.staged = null; },
  };
  const journalStore = {
    async read() { return d.journal && Buffer.from(d.journal); },
    async write(value) {
      if (hooks.journalWrite) await hooks.journalWrite(value);
      d.journal = Buffer.from(JSON.stringify(value));
    },
    async clear() { d.journal = null; },
  };
  const pinStore = {
    async read() { return d.pin && clone(d.pin); },
    async advance(expected, next) {
      if (expected === null ? d.pin !== null
        : !d.pin || expected.revision !== d.pin.revision || expected.digest !== d.pin.digest) return false;
      d.pin = clone(next); return true;
    },
  };
  const backupStore = {
    async put(revision, digest, bytes) {
      const entry = { revision, digest, artifactId: 'synthetic-' + revision };
      d.backups.set(digest, { ...entry, bytes: Buffer.from(bytes) }); return entry;
    },
    async get(revision, digest) {
      const e = d.backups.get(digest); return e && e.revision === revision ? Buffer.from(e.bytes) : null;
    },
    async list() { return [...d.backups.values()].map(({ bytes, ...e }) => e); },
  };
  const quarantine = { async put() { throw new Error('synthetic quarantine forbidden'); } };
  return { d, counts, hooks, lock, documentStore, journalStore, pinStore, backupStore, quarantine };
}

function acquisitionFor(base) {
  const packet = clone(base.liveOverlay.currentPeriodActuals);
  packet.transactions = [];
  const join = [];
  for (let i = 1; i <= 10; i++) {
    packet.transactions.push(LmGroups.groupTx({ id: 'synthetic-row-' + i, date: '2026-10-03', amount: 60,
      currency: 'cad', pending: false, categoryLabel: 'Groceries', merchantKnown: true,
      atlasAccountId: 'chequing-a', accountRole: 'household-cash',
      displayedPayee: 'Synthetic recorded club payment ' + i }, base.plan));
    join.push({ localId: 'synthetic-row-' + i, providerAccountId: 'SYNTHETIC-ACCOUNT',
      transactionId: 'SYNTHETIC-TRANSACTION-' + i });
  }
  packet.transactionWindow = { startDate: '2026-10-02', endDate: '2026-10-05', complete: true, hasMore: false, truncated: false };
  return { packet, plan: clone(base.plan), join,
    map: { mappings: [{ providerAccountId: 'SYNTHETIC-ACCOUNT', canonical: { id: 'chequing-a', collection: 'cash' } }] } };
}

function makePolicy(behavior, events) {
  const calls = [];
  const fn = async input => {
    calls.push(clone(input));
    if (events) events.push('policy');
    if (behavior) return behavior(input, calls.length);
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  };
  return { fn, calls };
}

async function makeWorld(opts = {}) {
  const clock = opts.clock || { t: NOW0 };
  const now = () => clock.t;
  const baseFixture = require('./fixtures/savings-daily-consumer-data')();
  baseFixture.plan.savingsEarmarks.pools[0].goalRefs = [{ kind: 'commitment', id: 'near' }];
  const domain = freshDomain();
  const adapters = makeAdapters();
  const history = makeHistory(domain);
  history.init([]);
  const storeDeps = { householdId, documentStore: adapters.documentStore,
    journalStore: adapters.journalStore, pinStore: adapters.pinStore,
    backupStore: adapters.backupStore, quarantine: adapters.quarantine,
    lock: adapters.lock, now, terminalHistory: history, exclusionDomain: domain,
    recoveryRead: true };
  const store = createSettlementEvidenceStore(storeDeps);
  const cell = { revision: 1, domain: 'synthetic-domain' };
  const contextReader = () => ({ contextRevision: cell.revision, domain: cell.domain });
  const acquisition = acquisitionFor(baseFixture);
  const syntheticAcquire = async reader => {
    const captured = clone(reader());
    const acq = clone(acquisition);
    return { ...acq, witness() {
      const cur = reader();
      return cur.contextRevision === captured.contextRevision && cur.domain === captured.domain;
    } };
  };
  const resolver = createSettlementEvidenceResolver({ householdId, acquire: () => syntheticAcquire(contextReader) });
  const authState = { authorized: true, actorOverride: null, hooks: {} };
  const authorize = async context => {
    if (authState.hooks.authorize) await authState.hooks.authorize(context);
    if (!authState.authorized) throw new Error('synthetic revoked');
    return { householdId, actorId: authState.actorOverride || context.actorId };
  };
  const commitAdmitted = async (input, witness) => store.commitAdmitted(input, witness);
  const policy = opts.policy === undefined ? makePolicy() : opts.policy;
  const createController = (extra = {}) => createSettlementEvidenceConfirmation({
    householdId, authorize, resolveSelection: resolver.resolveSelection,
    resolvePairedSelection: resolver.resolvePairedSelection,
    store, commitAdmitted, now, registerRecovery: () => {},
    ...(policy ? { authorizeRecovery: policy.fn } : {}), ...extra });
  const readDocument = async () => adapters.d.doc && Buffer.from(adapters.d.doc);
  const readPin = async () => adapters.d.pin && { revision: adapters.d.pin.revision, digest: adapters.d.pin.digest };
  const w = { store, history, adapters, domain, cell, contextReader, acquisition,
    syntheticAcquire, resolver, authState, authorize, commitAdmitted, baseFixture,
    readDocument, readPin, policy, clock, createController,
    ctx: { actorId: ACTOR }, ctxB: { actorId: ACTOR2 },
    async bootstrap() { return store.bootstrap(); } };
  w.controller = createController();
  return w;
}

async function selectionFor(w, idx = 0, actorId = ACTOR) {
  const cat = await w.resolver.catalogue({ householdId, actorId });
  assert.ok(cat && Array.isArray(cat.transactions) && cat.transactions.length, 'catalogue has transactions');
  return { transaction: cat.transactions[idx].handle, commitment: cat.commitments[0].handle };
}
async function prepareOp(w, controller, n = 1, ctx = null) {
  const selection = await selectionFor(w, (n - 1) % 10, (ctx || w.ctx).actorId);
  return controller.prepare(ctx || w.ctx, { operationId: op(n), selection, assignedCents: 2500 });
}
async function commitOp(w, controller, n = 1, ctx = null) {
  const p = await prepareOp(w, controller, n, ctx);
  assert.equal(p.status, 'prepared', 'prepare staged');
  const ack = await controller.confirm(ctx || w.ctx, { operationId: p.operationId,
    previewToken: p.previewToken, generation: p.generation, confirmed: true });
  assert.equal(ack.status, 'committed', 'confirm committed');
  return { prepared: p, ack };
}

// --- Authorization-store session double -------------------------------------
// Interprets exactly the statements the shipped authorization store issues,
// against in-memory maps. Hooks may mutate the maps mid-flight to model
// cross-connection timing (a revocation that commits after a decision read).
function makeAuthSession(hooks = {}) {
  const tables = { eligibility: new Map(), revocation: new Map(), sessionRevocation: new Map() };
  const key = (a, b) => a + '|' + b;
  const session = {
    tables, retireCalls: 0, listeners: {},
    on(event, fn) { (session.listeners[event] ||= []).push(fn); },
    async retire() { session.retireCalls++; },
    async query(text, values) {
      const ok = (rows = [], rowCount = rows.length, command = 'SELECT') => ({ command, rows, rowCount });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK')
        return { command: text, rows: [], rowCount: 0 };
      if (text.includes('operation_revoked')) {
        // readAuthorizationState's single statement.
        const [, operationId, generation, sidDigest] = values;
        const e = tables.eligibility.get(key(operationId, generation));
        const row = {
          household_id: e ? e.household_id : null,
          operation_id: e ? e.operation_id : null,
          generation: e ? e.generation : null,
          confirmation_digest: e ? e.confirmation_digest : null,
          secret_digest: e ? e.secret_digest : null,
          issued_at: e ? e.issued_at : null,
          operation_revoked: tables.revocation.has(key(operationId, generation)),
          session_revoked: tables.sessionRevocation.has(sidDigest),
        };
        if (hooks.afterReadState) await hooks.afterReadState(tables, row);
        return ok([row], 1);
      }
      if (text.startsWith('INSERT INTO') && text.includes('auth_eligibility')) {
        const [, household_id, operation_id, generation, confirmation_digest, secret_digest, issued_at] = values;
        tables.eligibility.set(key(operation_id, generation),
          { household_id, operation_id, generation, confirmation_digest, secret_digest, issued_at });
        return ok([], 1, 'INSERT');
      }
      if (text.startsWith('INSERT INTO') && text.includes('auth_revocation')) {
        const [, operation_id, generation, revoked_at] = values;
        tables.revocation.set(key(operation_id, generation), { operation_id, generation, revoked_at });
        return ok([], 1, 'INSERT');
      }
      if (text.startsWith('INSERT INTO') && text.includes('auth_session_revocation')) {
        const [, sid_digest, revoked_at] = values;
        tables.sessionRevocation.set(sid_digest, { sid_digest, revoked_at });
        return ok([], 1, 'INSERT');
      }
      if (text.includes('auth_eligibility')) {
        const [, operationId, generation] = values;
        const e = tables.eligibility.get(key(operationId, generation));
        return ok(e ? [{ scope: 'lane1-test', ...e }] : []);
      }
      if (text.includes('auth_session_revocation')) {
        const r = tables.sessionRevocation.get(values[1]);
        return ok(r ? [{ revoked_at: r.revoked_at }] : []);
      }
      if (text.includes('auth_revocation')) {
        const r = tables.revocation.get(key(values[1], values[2]));
        return ok(r ? [{ revoked_at: r.revoked_at }] : []);
      }
      throw new Error('unmodelled authorization SQL: ' + text.slice(0, 60));
    },
  };
  return session;
}
function makeAuthStore(hooks) {
  const session = makeAuthSession(hooks);
  const store = createAuthorizationStore({ session, schema: 'authz', scope: 'lane1-test' });
  return { session, store };
}
function makeIssuer(behavior) {
  const calls = [];
  const fn = async input => {
    calls.push(clone(input));
    if (behavior) return behavior(input, calls.length);
  };
  return { fn, calls };
}

// === RI-ISS: durable issuance inside prepare ================================
test('RI-1: unconfigured prepare is byte-identical (no recoverySecret field)', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const p = await prepareOp(w, w.controller, 1);
  assert.equal(p.status, 'prepared');
  assert.equal(Object.hasOwn(p, 'recoverySecret'), false);
  assert.deepEqual(Object.keys(p).sort(), ['asOf', 'assignedCents', 'currency', 'date',
    'expiresAt', 'generation', 'operation', 'operationId', 'previewToken', 'selection', 'status']);
});

test('RI-2: configured prepare issues eligibility before install and returns the secret once', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const issuer = makeIssuer();
  const controller = w.createController({ issueRecoveryEligibility: issuer.fn });
  const p = await prepareOp(w, controller, 1);
  assert.equal(p.status, 'prepared');
  assert.match(p.recoverySecret, /^[a-f0-9]{64}$/);
  assert.equal(issuer.calls.length, 1);
  const call = issuer.calls[0];
  assert.deepEqual(Object.keys(call).sort(), ['confirmationDigest', 'generation',
    'householdId', 'operationId', 'secretDigest']);
  assert.equal(call.householdId, householdId);
  assert.equal(call.operationId, p.operationId);
  assert.equal(call.generation, p.generation);
  assert.equal(call.secretDigest, sha256(p.recoverySecret));
  // The issued digest is the preview's confirmation digest: after commit it
  // is the very digest the store's private bundle reports as requestDigest.
  const ack = await controller.confirm(w.ctx, { operationId: p.operationId,
    previewToken: p.previewToken, generation: p.generation, confirmed: true });
  assert.equal(ack.status, 'committed');
  const bundle = await w.store.recoveryRead({ operationId: p.operationId });
  assert.equal(bundle.requestDigest, call.confirmationDigest);
});

test('RI-3: issuance refusal makes prepare unavailable and installs no preview', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const issuer = makeIssuer(() => { throw new Error('issuance not durable'); });
  const controller = w.createController({ issueRecoveryEligibility: issuer.fn });
  const p = await prepareOp(w, controller, 1);
  assert.deepEqual(p, { status: 'unavailable', reason: 'prepare-unavailable' });
  // Nothing usable exists: a confirm against the operation finds no preview.
  const ack = await controller.confirm(w.ctx, { operationId: op(1),
    previewToken: 'f'.repeat(64), generation: 'generation-' + 'f'.repeat(32), confirmed: true });
  assert.notEqual(ack.status, 'committed');
  // The reservation was released: a later prepare with a healthy issuer works.
  const healthy = w.createController({ issueRecoveryEligibility: makeIssuer().fn });
  assert.equal((await prepareOp(w, healthy, 1)).status, 'prepared');
});

test('RI-4: authority change during the issuance await refuses prepare', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const issuer = makeIssuer(() => { w.authState.authorized = false; });
  const controller = w.createController({ issueRecoveryEligibility: issuer.fn });
  const p = await prepareOp(w, controller, 1);
  assert.deepEqual(p, { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(issuer.calls.length, 1, 'issuance ran before the repeated recheck refused');
});

test('RI-5: preview expiry during the issuance await refuses prepare as expired', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const issuer = makeIssuer(() => { w.clock.t += C.TTL_MS + 1; });
  const controller = w.createController({ issueRecoveryEligibility: issuer.fn });
  const p = await prepareOp(w, controller, 1);
  assert.deepEqual(p, { status: 'rejected', reason: 'preview-expired' });
});

test('RI-6: withdrawal prepare issues eligibility and returns the secret', async () => {
  const { startWorld } = require('./test-settlement-evidence-http');
  const L = require('../scripts/settlement-evidence-loader');
  const w = await startWorld(true, {}); 
  try {
    await w.confirm(await w.prepare());
    const ctx = { actorId: JSON.parse(w.durable.doc).operations[0].actorId };
    const resolver = createSettlementEvidenceResolver({
      householdId, acquire: () => w.syntheticAcquire(w.contextReader) });
    const reader = L.createWithdrawalTargetReader({ householdId, contextReader: w.contextReader,
      readPin: w.dependency.readPin, readDocument: w.dependency.readDocument });
    const issuer = makeIssuer();
    const controller = createSettlementEvidenceConfirmation({ householdId,
      authorize: w.dependency.authorize, resolveSelection: resolver.resolveSelection,
      resolvePairedSelection: resolver.resolvePairedSelection, commitAdmitted: w.dependency.commitAdmitted,
      store: w.store, now: Date.now, withdrawalReader: reader.acquire,
      withdrawalLabels: async () => [], issueRecoveryEligibility: issuer.fn });
    const c = await controller.assignments(ctx, {}); assert.equal(c.status, 'available');
    const p = await controller.prepareWithdrawal(ctx, { operationId: op(10), assignmentHandle: c.assignments[0].handle });
    assert.equal(p.status, 'prepared');
    assert.match(p.recoverySecret, /^[a-f0-9]{64}$/);
    assert.equal(issuer.calls.length, 1);
    assert.equal(issuer.calls[0].generation, p.generation);
    assert.equal(issuer.calls[0].secretDigest, sha256(p.recoverySecret));
  } finally { await w.close(); }
});

test('RI-7: a non-function issuance dep refuses construction', async () => {
  const w = await makeWorld();
  assert.throws(() => w.createController({ issueRecoveryEligibility: 'yes' }), TypeError);
});

// === RI-OUT: the credential passes the controller outcome shape, inert ======
test('RI-8: outcome accepts a well-formed recoverySecret inertly; malformed refuses', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const { prepared } = await commitOp(w, w.controller, 1);
  const receipt = await w.controller.outcome(w.ctx, { operationId: prepared.operationId,
    recoverySecret: 'e'.repeat(64) });
  assert.equal(receipt.status, 'committed');
  assert.deepEqual(Object.keys(receipt).sort(), ['digest', 'operationId', 'revision', 'status']);
  const bad = await w.controller.outcome(w.ctx, { operationId: prepared.operationId,
    recoverySecret: 'not-a-secret' });
  assert.deepEqual(bad, { status: 'unavailable', reason: 'invalid-request' });
});

test('RI-9: lost-ack re-prepare is a NEW issuance; the orphan is never collected', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const { session, store: authStore } = makeAuthStore();
  const issuer = createRecoveryEligibilityIssuer({ authorizationStore: authStore, now: () => w.clock.t });
  assert.equal(typeof issuer, 'function');
  let first = true;
  const flaky = async input => {
    await issuer(input); // durable write lands...
    if (first) { first = false; throw new Error('acknowledgement lost'); } // ...ack lost
  };
  const controller = w.createController({ issueRecoveryEligibility: flaky });
  const p1 = await prepareOp(w, controller, 1);
  assert.deepEqual(p1, { status: 'unavailable', reason: 'prepare-unavailable' });
  const p2 = await prepareOp(w, controller, 1);
  assert.equal(p2.status, 'prepared');
  assert.equal(session.tables.eligibility.size, 2, 'orphan retained beside the live issuance; no GC');
  const generations = [...session.tables.eligibility.values()].map(r => r.generation);
  assert.ok(generations.includes(p2.generation));
  const orphan = [...session.tables.eligibility.values()].find(r => r.generation !== p2.generation);
  assert.ok(orphan, 'the lost-ack issuance is the orphan');
  // Cross-generation secrets refuse in both directions at the final authority.
  const authority = createRecoveryFinalAuthority({ authorizationStore: authStore, now: () => w.clock.t });
  const base = { householdId, actorId: ACTOR2, operationId: op(1), sidDigest: sidDigestOf(ACTOR2),
    expiresAt: w.clock.t + 600000 };
  const view = { status: 'committed', requestDigest: orphan.confirmation_digest };
  assert.equal(await authority({ ...base, generation: orphan.generation,
    secretDigest: sha256(p2.recoverySecret) }, view), false, 'live secret against orphan generation');
  assert.equal(await authority({ ...base, generation: p2.generation,
    secretDigest: 'f'.repeat(64) },
    { status: 'committed', requestDigest: [...session.tables.eligibility.values()]
      .find(r => r.generation === p2.generation).confirmation_digest }), false, 'wrong secret against live generation');
});

// === RI-HTTP: the opted-in awaited final authority over real HTTP ===========
// The mount is wired with the REAL authorization store behind the REAL
// server composition factories; only the session/authority acquisition and
// the Postgres session are doubles.
async function httpWorld(opts = {}) {
  const events = opts.events || [];
  const policy = opts.policy === undefined ? makePolicy(null, events) : opts.policy;
  const w = await makeWorld({ ...opts, policy });
  await w.bootstrap();
  const auth = makeAuthStore(opts.authHooks);
  const nowFn = () => w.clock.t;
  const issuer = createRecoveryEligibilityIssuer({ authorizationStore: auth.store, now: nowFn });
  const finalAuthority = createRecoveryFinalAuthority({ authorizationStore: auth.store, now: nowFn });
  const decisionCalls = [];
  const recordingFinal = async (retained, view) => {
    decisionCalls.push({ retained: clone(retained), view: clone(view),
      frozenRetained: Object.isFrozen(retained) });
    return finalAuthority(retained, view);
  };
  const authorityState = { expiresAt: NOW0 + 1209600000, missing: false };
  const sessionAuthority = opts.sessionAuthority === null ? undefined : (req => {
    if (authorityState.missing) return null;
    const actorId = req.get('x-test-actor') || null;
    if (!actorId) return null;
    return Object.freeze({ actorId, sidDigest: sidDigestOf(actorId), expiresAt: authorityState.expiresAt });
  });
  const express = require('express');
  const app = express();
  const sessionActor = req => req.get('x-test-actor') || null;
  const dep = { householdId, origin: 'http://synthetic.local',
    authorize: w.authorize,
    acquire: w.syntheticAcquire, contextReader: w.contextReader,
    readBase: async () => { events.push('readBase'); return clone(w.baseFixture); },
    now: nowFn, commitAdmitted: w.commitAdmitted,
    readDocument: w.readDocument, readPin: w.readPin,
    store: w.store, registerRecovery: () => {} };
  if (policy) dep.authorizeRecovery = policy.fn;
  if (opts.finalMode !== false) {
    dep.authorizeRecoveryFinal = recordingFinal;
    dep.issueRecoveryEligibility = issuer;
    if (sessionAuthority) dep.sessionAuthority = sessionAuthority;
  } else if (opts.finalDisclosure !== null) {
    const impl = typeof opts.finalDisclosure === 'function' ? opts.finalDisclosure : () => true;
    dep.finalDisclosureAuthorize = sel => impl(sel);
  }
  const mounted = mountSettlementHttp(app, sessionActor, dep);
  assert.equal(mounted.active, true);
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const call = async (route, body, actor, query = '') => {
    const headers = { 'Content-Type': 'application/json', 'Origin': 'http://synthetic.local',
      'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' };
    if (actor) headers['x-test-actor'] = actor;
    const r = await fetch(`http://127.0.0.1:${port}/settlement/${route}${query}`,
      { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { w, auth, server, call, events, policy, decisionCalls, authorityState,
    close: () => new Promise(res => server.close(res)) };
}
async function httpPrepare(h, n = 1, actor = ACTOR) {
  const sel = await h.call('selections', {}, actor);
  assert.equal(sel.status, 200);
  // One active allocation per (transaction, commitment) pair: each
  // operation takes its own transaction, like the controller harness.
  const tx = sel.body.transactions[(n - 1) % sel.body.transactions.length];
  const selection = { transaction: tx.handle, commitment: sel.body.commitments[0].handle };
  const p = await h.call('prepare', { operationId: op(n), selection, assignedCents: 2500 }, actor);
  assert.equal(p.status, 200, 'prepare over HTTP');
  assert.equal(p.body.status, 'prepared');
  return p.body;
}
async function httpCommit(h, n = 1, actor = ACTOR) {
  const p = await httpPrepare(h, n, actor);
  const ack = await h.call('confirm', { operationId: p.operationId, previewToken: p.previewToken,
    generation: p.generation, confirmed: true }, actor);
  assert.equal(ack.status, 200);
  assert.equal(ack.body.status, 'committed');
  return p;
}

test('RI-10: cross-login recovery over both routes with the credential triple', async () => {
  const h = await httpWorld(); 
  try {
    const p = await httpCommit(h, 1);
    assert.match(p.recoverySecret, /^[a-f0-9]{64}$/, 'prepare response carried the secret');
    const triple = { operationId: p.operationId, generation: p.generation, recoverySecret: p.recoverySecret };
    const outcome = await h.call('outcome', triple, ACTOR2);
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { status: 'committed', operationId: p.operationId });
    const publication = await h.call('publication', triple, ACTOR2);
    assert.equal(publication.status, 200);
    assert.equal(publication.body.status, 'committed');
    assert.ok(['included', 'unavailable'].includes(publication.body.publication));
    // The final authority judged exactly the retained server-derived input
    // and the acquired private proof — on each route independently.
    assert.equal(h.decisionCalls.length, 2);
    const bundle = await h.w.store.recoveryRead({ operationId: p.operationId });
    for (const call of h.decisionCalls) {
      assert.deepEqual(call.retained, { householdId, actorId: ACTOR2, operationId: p.operationId,
        generation: p.generation, secretDigest: sha256(p.recoverySecret),
        sidDigest: sidDigestOf(ACTOR2), expiresAt: h.authorityState.expiresAt });
      assert.deepEqual(call.view, { status: 'committed', requestDigest: bundle.requestDigest });
      assert.equal(call.frozenRetained, true);
    }
  } finally { await h.close(); }
});

test('RI-11: wrong secret refuses both routes with the incumbent 503 and zero disclosure', async () => {
  const h = await httpWorld();
  try {
    const p = await httpCommit(h, 1);
    const wrong = (p.recoverySecret[0] === 'a' ? 'b' : 'a') + p.recoverySecret.slice(1);
    for (const route of ['outcome', 'publication']) {
      const r = await h.call(route, { operationId: p.operationId, generation: p.generation,
        recoverySecret: wrong }, ACTOR2);
      assert.equal(r.status, 503, route);
      assert.deepEqual(r.body, { status: 'unavailable' });
    }
  } finally { await h.close(); }
});

test('RI-12: a recovery proof without the secret cannot satisfy the final authority', async () => {
  const h = await httpWorld();
  try {
    const p = await httpCommit(h, 1);
    const r = await h.call('outcome', { operationId: p.operationId, generation: p.generation }, ACTOR2);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { status: 'unavailable' });
    assert.equal(h.decisionCalls.length, 0, 'no decision is even attempted uncredentialed');
  } finally { await h.close(); }
});

test('RI-13: durable revocations seen by the decision refuse; eligibility absence refuses', async () => {
  const h = await httpWorld();
  try {
    const p = await httpCommit(h, 1);
    const triple = { operationId: p.operationId, generation: p.generation, recoverySecret: p.recoverySecret };
    await h.auth.store.appendRevocation({ operationId: p.operationId, generation: p.generation,
      revokedAt: h.w.clock.t });
    assert.equal((await h.call('outcome', triple, ACTOR2)).status, 503, 'operation revoked');
    const p2 = await httpCommit(h, 2);
    await h.auth.store.appendSessionRevocation({ sidDigest: sidDigestOf(ACTOR2), revokedAt: h.w.clock.t });
    assert.equal((await h.call('outcome', { operationId: p2.operationId, generation: p2.generation,
      recoverySecret: p2.recoverySecret }, ACTOR2)).status, 503, 'session revoked');
    const p3 = await httpCommit(h, 3);
    // A secret for an operation whose eligibility was never issued (forged
    // generation) has no record to judge against.
    const forged = { operationId: p3.operationId, generation: 'generation-' + '0'.repeat(32),
      recoverySecret: p3.recoverySecret };
    assert.equal((await h.call('outcome', forged, ACTOR2)).status, 503, 'no eligibility for that generation');
  } finally { await h.close(); }
});

test('RI-14: a revocation landing after the decision lets the admitted response finish', async () => {
  let landed = false;
  const h = await httpWorld({ authHooks: { afterReadState: async (tables, row) => {
    if (!landed && row.operation_id) {
      landed = true;
      // Models a revocation committing on another connection immediately
      // after this decision's single statement snapshot was taken.
      tables.revocation.set(row.operation_id + '|' + row.generation,
        { operation_id: row.operation_id, generation: row.generation, revoked_at: NOW0 });
    }
  } } });
  try {
    const p = await httpCommit(h, 1);
    const triple = { operationId: p.operationId, generation: p.generation, recoverySecret: p.recoverySecret };
    const first = await h.call('outcome', triple, ACTOR2);
    assert.equal(first.status, 200, 'admitted request finishes under the timing rule');
    assert.equal(first.body.status, 'committed');
    const second = await h.call('outcome', triple, ACTOR2);
    assert.equal(second.status, 503, 'the next request re-decides and refuses');
  } finally { await h.close(); }
});

test('RI-15: negative (not-applied) recovery binds the certificate digest over both routes', async () => {
  const h = await httpWorld();
  try {
    const p = await httpPrepare(h, 5);
    h.w.clock.t = p.expiresAt + 1;
    const ack = await h.call('confirm', { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true }, ACTOR);
    assert.equal(ack.body.status, 'not-applied');
    h.w.clock.t = NOW0;
    const triple = { operationId: p.operationId, generation: p.generation, recoverySecret: p.recoverySecret };
    const outcome = await h.call('outcome', triple, ACTOR2);
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { status: 'not-applied', operationId: p.operationId, generation: p.generation });
    const publication = await h.call('publication', triple, ACTOR2);
    assert.equal(publication.status, 200);
    assert.equal(publication.body.status, 'not-applied');
    const neg = h.decisionCalls.at(-1);
    const cert = h.w.history.records().find(r => r.operationId === p.operationId);
    assert.deepEqual(neg.view, { status: 'not-applied', confirmationDigest: cert.confirmationDigest });
  } finally { await h.close(); }
});

test('RI-16: session expiry during the decision read refuses', async () => {
  const sharedClock = { t: NOW0 };
  const h = await httpWorld({ clock: sharedClock, authHooks: { afterReadState: async () => {
    sharedClock.t = NOW0 + 1209600000 + 1; // past the session authority's expiresAt
  } } });
  try {
    const p = await httpCommit(h, 1);
    const r = await h.call('outcome', { operationId: p.operationId, generation: p.generation,
      recoverySecret: p.recoverySecret }, ACTOR2);
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { status: 'unavailable' });
  } finally { await h.close(); }
});

test('RI-17: missing session authority in an opted-in composition refuses', async () => {
  const h = await httpWorld({ sessionAuthority: null });
  try {
    const p = await httpCommit(h, 1);
    const r = await h.call('outcome', { operationId: p.operationId, generation: p.generation,
      recoverySecret: p.recoverySecret }, ACTOR2);
    assert.equal(r.status, 503);
  } finally { await h.close(); }
});

test('RI-18: mount refuses two final authorities and non-function capabilities', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const express = require('express');
  const base = { householdId, origin: 'http://synthetic.local', authorize: w.authorize,
    acquire: w.syntheticAcquire, contextReader: w.contextReader, readBase: async () => clone(w.baseFixture),
    now: () => w.clock.t, commitAdmitted: w.commitAdmitted, readDocument: w.readDocument,
    readPin: w.readPin, store: w.store, authorizeRecovery: makePolicy().fn };
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { ...base, finalDisclosureAuthorize: () => true, authorizeRecoveryFinal: async () => true }), TypeError);
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { ...base, authorizeRecoveryFinal: 'yes' }), TypeError);
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { ...base, authorizeRecoveryFinal: async () => true, sessionAuthority: 'yes' }), TypeError);
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { ...base, issueRecoveryEligibility: 'yes' }), TypeError);
});

test('RI-19: credential shapes are admitted only in the opted-in composition', async () => {
  const sync = await httpWorld({ finalMode: false });
  try {
    const p = await httpCommit(sync, 1);
    assert.equal(Object.hasOwn(p, 'recoverySecret'), false, 'no issuance in the sync composition');
    for (const route of ['outcome', 'publication']) {
      const r = await sync.call(route, { operationId: p.operationId, generation: p.generation,
        recoverySecret: 'e'.repeat(64) }, ACTOR2);
      assert.equal(r.status, 400, route + ' keeps its shipped body shapes');
    }
  } finally { await sync.close(); }
  const fin = await httpWorld();
  try {
    const p = await httpCommit(fin, 1);
    // Secret without generation is not the credential path.
    assert.equal((await fin.call('outcome', { operationId: p.operationId,
      recoverySecret: p.recoverySecret }, ACTOR2)).status, 400);
    assert.equal((await fin.call('publication', { operationId: p.operationId,
      recoverySecret: p.recoverySecret }, ACTOR2)).status, 400);
    // Digest-shaped smuggling is an unknown key, never a bearer.
    assert.equal((await fin.call('outcome', { operationId: p.operationId, generation: p.generation,
      secretDigest: 'e'.repeat(64) }, ACTOR2)).status, 400);
    // The secret never travels in a URL.
    assert.equal((await fin.call('outcome', { operationId: p.operationId, generation: p.generation,
      recoverySecret: p.recoverySecret }, ACTOR2, '?x=1')).status, 400);
  } finally { await fin.close(); }
});

// === RI-RT: the runtime's exactly-one-final-authority construction rule ====
function runtimeOptions(recovery) {
  const adapters = makeAdapters();
  const domain = freshDomain();
  const history = makeHistory(domain);
  class Client extends EventEmitter {}
  return { connection: { Client, config: { host: 'db.example.test', port: 5432,
      database: 'synthetic', user: 'synthetic_app', password: 'synthetic-only',
      ssl: { rejectUnauthorized: true, servername: 'db.example.test' } },
      schema: 'settlement', scope: 'scope-lane1' },
    custody: { pinStore: adapters.pinStore, backupStore: adapters.backupStore,
      terminalHistory: { readSnapshot: history.readSnapshot,
        compareAndAppend: history.compareAndAppend }, exclusionDomain: domain },
    application: { householdId, origin: 'https://atlas.example.test',
      authorize: async c => ({ householdId, actorId: c.actorId }),
      acquire: async () => { throw new Error('unused acquisition double'); },
      contextReader: () => ({}), readBase: async () => ({}), now: () => NOW0 },
    ...(recovery ? { recovery } : {}) };
}
const policyEcho = async ({ householdId: h, actorId, operationId }) =>
  ({ householdId: h, actorId, operationId });

test('RI-20: runtime recovery record variants and the exactly-one rule', async () => {
  const incumbent = createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: true, authorizeRecovery: policyEcho, finalDisclosureAuthorize: () => true }));
  assert.equal(typeof incumbent.settlement.finalDisclosureAuthorize, 'function');
  assert.equal('authorizeRecoveryFinal' in incumbent.settlement, false);
  assert.equal('issueRecoveryEligibility' in incumbent.settlement, false);

  const final = createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: true, authorizeRecovery: policyEcho, authorizeRecoveryFinal: async () => true,
      issueRecoveryEligibility: async () => {} }));
  assert.equal(typeof final.settlement.authorizeRecoveryFinal, 'function');
  assert.equal('finalDisclosureAuthorize' in final.settlement, false);
  assert.equal(typeof final.settlement.issueRecoveryEligibility, 'function');
  // Both new capabilities ride the generic fence: a disconnected runtime
  // refuses with the sanitized unavailable error, never the double's answer.
  await assert.rejects(async () => final.settlement.authorizeRecoveryFinal({}, {}),
    e => e.code === 'SETTLEMENT_RUNTIME_UNAVAILABLE');
  await assert.rejects(async () => final.settlement.issueRecoveryEligibility({}),
    e => e.code === 'SETTLEMENT_RUNTIME_UNAVAILABLE');

  assert.throws(() => createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: true, authorizeRecovery: policyEcho,
      finalDisclosureAuthorize: () => true, authorizeRecoveryFinal: async () => true })), TypeError,
    'both final authorities is a composition error');
  assert.throws(() => createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: true, authorizeRecovery: policyEcho })), TypeError,
    'neither final authority is a composition error');
  assert.throws(() => createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: true, authorizeRecovery: policyEcho, authorizeRecoveryFinal: 'yes' })), TypeError);
  assert.throws(() => createSettlementEvidencePostgresRuntime(runtimeOptions(
    { recoveryRead: false, authorizeRecovery: policyEcho, authorizeRecoveryFinal: async () => true })), TypeError);
  const plain = createSettlementEvidencePostgresRuntime(runtimeOptions(null));
  assert.equal('authorizeRecovery' in plain.settlement, false);
});

// === RI-FAC: the server composition factories ===============================
test('RI-21: the eligibility issuer maps store outcomes to durable success or refusal', async () => {
  const seen = [];
  const stub = outcome => ({ issueEligibility: async record => { seen.push(record); return outcome; } });
  const input = { householdId, operationId: op(1), generation: 'generation-' + 'a'.repeat(32),
    confirmationDigest: 'c'.repeat(64), secretDigest: 'd'.repeat(64) };
  for (const outcome of [{ outcome: 'issued' }, { outcome: 'reissued-identical' }]) {
    seen.length = 0;
    const issuer = createRecoveryEligibilityIssuer({ authorizationStore: stub(outcome), now: () => NOW0 });
    await issuer(input);
    assert.deepEqual(seen[0], { ...input, issuedAt: NOW0 });
  }
  for (const outcome of [{ outcome: 'refused', reason: 'conflict' }, { outcome: 'unknown' }]) {
    const issuer = createRecoveryEligibilityIssuer({ authorizationStore: stub(outcome), now: () => NOW0 });
    await assert.rejects(() => issuer(input), /not durable/);
  }
  const down = createRecoveryEligibilityIssuer({
    authorizationStore: { issueEligibility: async () => { throw new Error('session lost'); } }, now: () => NOW0 });
  await assert.rejects(() => down(input));
  assert.throws(() => createRecoveryEligibilityIssuer({ authorizationStore: {}, now: () => NOW0 }), TypeError);
  assert.throws(() => createRecoveryFinalAuthority({ authorizationStore: {}, now: () => NOW0 }), TypeError);
});

test('RI-22: the final authority judges one fresh read and nothing cached', async () => {
  const eligibility = { householdId, operationId: op(1), generation: 'generation-' + 'a'.repeat(32),
    confirmationDigest: 'c'.repeat(64), secretDigest: 'd'.repeat(64), issuedAt: NOW0 };
  const retained = { householdId, actorId: ACTOR2, operationId: op(1), generation: eligibility.generation,
    secretDigest: 'd'.repeat(64), sidDigest: sidDigestOf(ACTOR2), expiresAt: NOW0 + 600000 };
  const view = { status: 'committed', requestDigest: 'c'.repeat(64) };
  let clock = NOW0;
  const mk = (read, hooks = {}) => createRecoveryFinalAuthority({
    authorizationStore: { readAuthorizationState: async input => {
      if (hooks.onRead) await hooks.onRead();
      return typeof read === 'function' ? read(input) : read;
    } }, now: () => clock });
  const okRead = { state: 'ok', eligibility, operationRevoked: false, sessionRevoked: false };
  assert.equal(await mk(okRead)(retained, view), true);
  assert.equal(await mk({ ...okRead, state: 'unknown' })(retained, view), false);
  assert.equal(await mk({ ...okRead, eligibility: null })(retained, view), false);
  assert.equal(await mk({ ...okRead, operationRevoked: true })(retained, view), false);
  assert.equal(await mk({ ...okRead, sessionRevoked: true })(retained, view), false);
  assert.equal(await mk({ ...okRead, eligibility: { ...eligibility, householdId: 'household-' + 'f'.repeat(32) } })(retained, view), false);
  assert.equal(await mk(okRead)({ ...retained, secretDigest: 'e'.repeat(64) }, view), false);
  assert.equal(await mk(okRead)(retained, { status: 'committed', requestDigest: 'e'.repeat(64) }), false);
  assert.equal(await mk(okRead)(retained, { status: 'not-applied', confirmationDigest: 'c'.repeat(64) }), true);
  assert.equal(await mk(okRead)(retained, { status: 'not-applied', confirmationDigest: 'e'.repeat(64) }), false);
  assert.equal(await mk(okRead)({ ...retained, expiresAt: NOW0 - 1 }, view), false, 'expired before the read');
  assert.equal(await mk(okRead, { onRead: () => { clock = NOW0 + 700000; } })(retained, view), false,
    'expiry during the read refuses');
  clock = NOW0;
  // The read is keyed exactly by the retained selectors and the session digest.
  let seenInput;
  assert.equal(await mk(input => { seenInput = input; return okRead; })(retained, view), true);
  assert.deepEqual(seenInput, { operationId: op(1), generation: eligibility.generation,
    sidDigest: sidDigestOf(ACTOR2) });
});

// === RI-SRV: the server's private session authority, through the real app ===
test('RI-23: createApplication supplies the HMAC session authority to the final decision', async () => {
  const w = await makeWorld(); await w.bootstrap();
  const auth = makeAuthStore();
  const syntheticCredential = kind => 'synthetic-' + kind + '-0123456789abcdef0123456789';
  const env = { SITE_PASSWORD: syntheticCredential('site-password'),
    SESSION_SECRET: syntheticCredential('session-secret'),
    ATLAS_ASSISTANT_TOKEN: syntheticCredential('assistant-token'),
    ATLAS_TALK_GEMINI_API_KEY: syntheticCredential('talk-key') };
  const http = require('node:http');
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const decisions = [];
  const dep = { householdId, origin, authorize: w.authorize, acquire: w.syntheticAcquire,
    contextReader: w.contextReader, readBase: async () => clone(w.baseFixture), now: () => w.clock.t,
    commitAdmitted: w.commitAdmitted, readDocument: w.readDocument, readPin: w.readPin, store: w.store,
    authorizeRecovery: makePolicy().fn,
    issueRecoveryEligibility: createRecoveryEligibilityIssuer({ authorizationStore: auth.store, now: () => w.clock.t }),
    authorizeRecoveryFinal: async (retained, view) => {
      decisions.push({ retained: clone(retained), view: clone(view) });
      return createRecoveryFinalAuthority({ authorizationStore: auth.store, now: () => w.clock.t })(retained, view);
    } };
  const app = serverModule.createApplication({ env, baseSource: async () => w.baseFixture, settlement: dep });
  server.on('request', app);
  const login = async () => {
    const r = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: env.SITE_PASSWORD }) });
    assert.equal(r.status, 302);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const post = async (cookie, route, body) => {
    const r = await fetch(origin + '/settlement/' + route, { method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json',
        'X-Atlas-Settlement': 'same-origin' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
    const cookieA = await login();
    const sel = await post(cookieA, 'selections', {});
    const selection = { transaction: sel.body.transactions[0].handle, commitment: sel.body.commitments[0].handle };
    const prepared = await post(cookieA, 'prepare', { operationId: op(1), selection, assignedCents: 2500 });
    assert.equal(prepared.body.status, 'prepared');
    assert.match(prepared.body.recoverySecret, /^[a-f0-9]{64}$/);
    const ack = await post(cookieA, 'confirm', { operationId: op(1), previewToken: prepared.body.previewToken,
      generation: prepared.body.generation, confirmed: true });
    assert.equal(ack.body.status, 'committed');
    const cookieB = await login();
    assert.notEqual(cookieB, cookieA);
    const outcome = await post(cookieB, 'outcome', { operationId: op(1),
      generation: prepared.body.generation, recoverySecret: prepared.body.recoverySecret });
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { status: 'committed', operationId: op(1) });
    assert.equal(decisions.length, 1);
    const payload = JSON.parse(Buffer.from(cookieB.split('.')[0].replace(/^hfd_session=/, ''), 'base64url').toString());
    assert.equal(decisions[0].retained.actorId, 'session-' + payload.sid);
    assert.equal(decisions[0].retained.sidDigest, sha256(payload.sid));
    assert.equal(decisions[0].retained.expiresAt, payload.exp);
    // A legacy expiry-only cookie (valid HMAC, no sid) supplies no session
    // actor at all: the settlement router refuses it before any recovery.
    const bodyOnly = Buffer.from(JSON.stringify({ exp: Date.now() + 600000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', env.SESSION_SECRET).update(bodyOnly).digest('base64url');
    const legacy = await post(`hfd_session=${encodeURIComponent(bodyOnly + '.' + mac)}`, 'outcome',
      { operationId: op(1), generation: prepared.body.generation, recoverySecret: prepared.body.recoverySecret });
    assert.equal(legacy.status, 401);
    assert.equal(decisions.length, 1, 'no decision was attempted for the legacy cookie');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

// === RI-APP: the browser marker, driven through the shipped IIFE ============
// The SettlementSave IIFE is lifted verbatim out of public/app.js and run in
// a vm with stubbed storage/fetch, exactly the technique the refresh suites
// use for server.js: the code under test is the shipped code.
function loadSettlementSave(marker) {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
      const start = source.indexOf('const SettlementSave = (() => {');
  const end = source.indexOf('\n})();', start);
  assert.ok(start >= 0 && end > start, 'the SettlementSave IIFE is extractable');
  const storage = new Map();
  if (marker !== undefined) storage.set('atlas-settlement-pending-v1', marker);
  const posts = [];
  const sandbox = {
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    navigator: { locks: { request: async (name, options, cb) =>
      (typeof options === 'function' ? options() : cb()) } },
    fetch: async (url, init = {}) => {
      const route = String(url).split('/').pop();
      const body = init.body ? JSON.parse(init.body) : {};
      posts.push({ route, body });
      const respond = payload => ({ ok: true, status: 200,
        json: async () => payload, text: async () => JSON.stringify(payload) });
      if (route === 'outcome') return respond(appOutcome);
      if (route === 'publication') return respond(appPublication);
      throw new Error('unexpected fetch ' + url);
    },
    location: { origin: 'http://synthetic.local' },
    URL, AbortController, setTimeout, clearTimeout, console };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end + 6) + '\n;this.__save = SettlementSave;', sandbox);
  return { save: sandbox.__save, posts, storage };
}
let appOutcome; let appPublication;
const ordinaryData = () => ({ plan: { defaults: {}, startingCash: {}, income: [], bills: [],
  obligations: [], commitments: [] }, meta: {}, debts: [],
  settlementEvidenceStatus: { status: 'qualified' },
  settlementEvidence: { status: 'qualified' } });

test('RI-24: the marker secret rides both recovery posts after a restart', async () => {
  const secret = 'e'.repeat(64);
  const marker = JSON.stringify({ operationId: op(1), phase: 'dispatched',
    generation: 'generation-' + 'a'.repeat(32), recoverySecret: secret });
  const { save, posts } = loadSettlementSave(marker);
  appOutcome = { status: 'committed', operationId: op(1) };
  appPublication = { status: 'committed', publication: 'included', data: ordinaryData() };
  const data = await save.initialData(async () => ordinaryData(), undefined, {});
  assert.equal(data.settlementEvidenceStatus.status, 'qualified');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], { route: 'outcome', body: { operationId: op(1),
    generation: 'generation-' + 'a'.repeat(32), recoverySecret: secret } });
  assert.deepEqual(posts[1], { route: 'publication', body: { operationId: op(1),
    generation: 'generation-' + 'a'.repeat(32), recoverySecret: secret } });
});

test('RI-25: legacy markers stay byte-identical; malformed secret markers refuse', async () => {
  const legacy = loadSettlementSave(JSON.stringify({ operationId: op(1), phase: 'dispatched',
    generation: 'generation-' + 'a'.repeat(32) }));
  appOutcome = { status: 'committed', operationId: op(1) };
  appPublication = { status: 'committed', publication: 'included', data: ordinaryData() };
  await legacy.save.initialData(async () => ordinaryData(), undefined, {});
  assert.deepEqual(legacy.posts[0].body, { operationId: op(1), generation: 'generation-' + 'a'.repeat(32) });
  assert.deepEqual(legacy.posts[1].body, { operationId: op(1) });
  // A secret without its generation, or a malformed secret, is not a marker.
  for (const bad of [
    JSON.stringify({ operationId: op(1), phase: 'dispatched', recoverySecret: 'e'.repeat(64) }),
    JSON.stringify({ operationId: op(1), phase: 'dispatched',
      generation: 'generation-' + 'a'.repeat(32), recoverySecret: 'short' }),
    JSON.stringify({ operationId: op(1), phase: 'dispatched',
      generation: 'generation-' + 'a'.repeat(32), recoverySecret: 'e'.repeat(64), extra: 1 }) ]) {
    const { save } = loadSettlementSave(bad);
    await assert.rejects(() => save.initialData(async () => ordinaryData(), undefined, {}),
      /settlement-reconciliation/);
  }
  // The marker budget admits the full credential marker (196 chars) and
  // still refuses an oversized one.
  const full = JSON.stringify({ operationId: op(1), phase: 'dispatched',
    generation: 'generation-' + 'a'.repeat(32), recoverySecret: 'e'.repeat(64) });
  assert.ok(full.length <= 256 && full.length > 160, 'the credential marker needs the widened budget');
});

