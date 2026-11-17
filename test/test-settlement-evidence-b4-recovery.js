'use strict';
// B4 re-login recovery acceptance (ATLAS-080) — frozen expectations
// B4R-1..29 from ~/workspace/atlas-b4-relogin/build-freeze/SPEC.md.
// B4R-30 (B4S-1..17 harness re-run) and B4R-31 (test-static + full standard
// group on the pushed tree) are external proofs reported on the PR, not
// encoded here.
// Addendum A (Rev 2) rows B4R-A1..A8 are encoded at the end of this file;
// B4R-A9 is the external non-regression proof (this file's rows + B4S
// re-run + test-static + standard group on the pushed tree).
//
// The slice under test: a default-disabled, policy-gated recovery READ.
// A later household-authorized session (a different actor than the one
// recorded) may learn {status, operationId} for a committed operation, or
// the exact {status:'not-applied', operationId, generation} negative, only
// when the composition injects BOTH halves of the capability: the store's
// opt-in recoveryRead (which takes no actor input at all) and an
// authorizeRecovery policy that judges the named operation for the
// current session. Tests inject a synthetic policy; no production policy
// exists in this slice and every default stays unconnected.
//
// Worlds compose the REAL store / resolver / confirmation controller /
// HTTP mount over in-memory adapter doubles and a terminal-history double
// (the B4S harness pattern). Faults live only at double seams.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../scripts/planned-obligation-settlement-contract');
const { createSettlementEvidenceStore } = require('../scripts/settlement-evidence-store');
const { createSettlementEvidenceResolver } = require('../scripts/settlement-evidence-resolver');
const { createSettlementEvidenceConfirmation } = require('../scripts/settlement-evidence-confirmation');
const { mountSettlementHttp } = require('../scripts/settlement-evidence-http');
const LmGroups = require('./lm-groups-fixture.js');

const householdId = 'household-' + 'a'.repeat(32);
const ACTOR = 'session-' + 'b'.repeat(64);   // recorded actor ("A")
const ACTOR2 = 'session-' + 'c'.repeat(64);  // later login ("B")
const ACTOR3 = 'session-' + 'd'.repeat(64);  // third actor
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const clone = v => structuredClone(v);
const NOW0 = 1761000000000;

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
    calls: { readSnapshot: 0, compareAndAppend: 0 },
    appendArgs: [], hooks: {},
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
    appendRaw(certificate) {
      const e = h.encode([...h.records(), certificate]);
      h.bytes = e.historyBytes; h.checkpoint = e.checkpoint;
    },
    async readSnapshot() {
      h.calls.readSnapshot++;
      if (h.hooks.readSnapshot) return h.hooks.readSnapshot();
      if (h.bytes === null) return { historyBytes: null, checkpoint: null };
      return { historyBytes: Buffer.from(h.bytes), checkpoint: clone(h.checkpoint) };
    },
    async compareAndAppend(arg) {
      h.calls.compareAndAppend++;
      h.appendArgs.push(clone({ expectedCheckpoint: arg && arg.expectedCheckpoint,
        certificate: arg && arg.certificate }));
      if (h.hooks.compareAndAppend) return h.hooks.compareAndAppend(arg, () => h.performAppend(arg));
      return h.performAppend(arg);
    },
    performAppend(arg) {
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

// --- Ledger adapter doubles ----------------------------------------------
const MUTATORS = ['docWriteTemp', 'docCommitTemp', 'docDiscardTemp', 'journalWrite',
  'journalClear', 'pinAdvance', 'backupPut', 'quarantinePut'];
function makeAdapters() {
  const d = { doc: null, staged: null, journal: null, pin: null, backups: new Map() };
  const counts = {}; for (const m of MUTATORS) counts[m] = 0;
  const hooks = {};
  let tail = Promise.resolve();
  const lock = { withLock(fn) { const v = tail.then(fn, fn); tail = v.catch(() => {}); return v; } };
  const documentStore = {
    async read() { return d.doc && Buffer.from(d.doc); },
    async readStaged() { return d.staged && Buffer.from(d.staged); },
    async writeTemp(bytes) { counts.docWriteTemp++; d.staged = Buffer.from(bytes); },
    async commitTemp() { counts.docCommitTemp++; d.doc = d.staged; d.staged = null; },
    async discardTemp() { counts.docDiscardTemp++; d.staged = null; },
  };
  const journalStore = {
    async read() { return d.journal && Buffer.from(d.journal); },
    async write(value) {
      counts.journalWrite++;
      if (hooks.journalWrite) await hooks.journalWrite(value);
      d.journal = Buffer.from(JSON.stringify(value));
    },
    async clear() { counts.journalClear++; d.journal = null; },
  };
  const pinStore = {
    async read() { return d.pin && clone(d.pin); },
    async advance(expected, next) {
      counts.pinAdvance++;
      if (expected === null ? d.pin !== null
        : !d.pin || expected.revision !== d.pin.revision || expected.digest !== d.pin.digest) return false;
      d.pin = clone(next); return true;
    },
  };
  const backupStore = {
    async put(revision, digest, bytes) {
      counts.backupPut++;
      const entry = { revision, digest, artifactId: 'synthetic-' + revision };
      d.backups.set(digest, { ...entry, bytes: Buffer.from(bytes) }); return entry;
    },
    async get(revision, digest) {
      const e = d.backups.get(digest); return e && e.revision === revision ? Buffer.from(e.bytes) : null;
    },
    async list() { return [...d.backups.values()].map(({ bytes, ...e }) => e); },
  };
  const quarantine = { async put() { counts.quarantinePut++; throw new Error('synthetic quarantine forbidden'); } };
  const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
  const stateHash = () => sha256(JSON.stringify({
    doc: d.doc && d.doc.toString('base64'), journal: d.journal && d.journal.toString('base64'),
    pin: d.pin, backups: [...d.backups.keys()].sort(),
  }));
  return { d, counts, hooks, lock, documentStore, journalStore, pinStore, backupStore, quarantine,
    stateHash, mutatorTotal() { return MUTATORS.reduce((n, m) => n + counts[m], 0); } };
}

// --- Acquisition fixture (mirrors the shipped suites) ----------------------
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

// --- Synthetic authorizeRecovery policy double ------------------------------
// Default behaviour is the A.2 conforming answer: exactly
// {householdId, actorId, operationId} copied from the (server-derived)
// input fields. `behavior(input, callNumber)` may override per test.
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

// --- World -------------------------------------------------------------------
// opts: { recovery = true (store opt-in), policy = makePolicy() | null,
//         clock = { t: NOW0 } }
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
    lock: adapters.lock, now, terminalHistory: history, exclusionDomain: domain };
  if (opts.recovery !== false) storeDeps.recoveryRead = true;
  const store = createSettlementEvidenceStore(storeDeps);
  const spies = { recovery: [] };
  const wrappedStore = { ...store,
    ...(typeof store.recoveryRead === 'function'
      ? { recoveryRead: async input => { spies.recovery.push(clone(input)); return store.recoveryRead(input); } }
      : {}) };
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
    store: wrappedStore, commitAdmitted, now, registerRecovery: () => {},
    ...(policy ? { authorizeRecovery: policy.fn } : {}), ...extra });
  const readDocument = async () => adapters.d.doc && Buffer.from(adapters.d.doc);
  const readPin = async () => adapters.d.pin && { revision: adapters.d.pin.revision, digest: adapters.d.pin.digest };
  const w = { store, wrappedStore, history, adapters, domain, spies, cell, contextReader,
    acquisition, syntheticAcquire, resolver, authState, authorize, commitAdmitted,
    baseFixture, readDocument, readPin, policy, clock, createController,
    ctx: { actorId: ACTOR }, ctxB: { actorId: ACTOR2 }, ctxC: { actorId: ACTOR3 },
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
async function sealViaExpiry(w, controller, n = 1, ctx = null) {
  const p = await prepareOp(w, controller, n, ctx);
  assert.equal(p.status, 'prepared', 'prepare staged');
  w.clock.t = p.expiresAt + 1;
  const ack = await controller.confirm(ctx || w.ctx, { operationId: p.operationId,
    previewToken: p.previewToken, generation: p.generation, confirmed: true });
  assert.equal(ack.status, 'not-applied', 'funnel produced the confirm proof');
  assert.equal(Object.keys(ack).length, 4, 'confirm proof has 4 keys');
  return { prepared: p, ack };
}
function durableSnapshot(w) {
  return { state: w.adapters.stateHash(),
    historyBytes: w.history.bytes && w.history.bytes.toString('base64'),
    checkpoint: clone(w.history.checkpoint),
    mutators: { ...w.adapters.counts },
    appends: w.history.calls.compareAndAppend };
}
function assertUnchanged(before, after, what) {
  assert.equal(after.state, before.state, what + ': ledger state bytes changed');
  assert.equal(after.historyBytes, before.historyBytes, what + ': history bytes changed');
  assert.deepEqual(after.checkpoint, before.checkpoint, what + ': checkpoint changed');
  assert.equal(after.appends, before.appends, what + ': compareAndAppend count changed');
  for (const k of Object.keys(before.mutators))
    assert.equal(after.mutators[k], before.mutators[k], what + ': mutator ' + k + ' invoked');
}

// --- HTTP world --------------------------------------------------------------
// opts: { recovery, policy, httpPolicy = true (mount receives the policy),
//         events = [] (ordering log), hooks = {} (readBase etc.) }
async function httpWorld(opts = {}) {
  const events = opts.events || [];
  const policy = opts.policy === undefined ? makePolicy(null, events) : opts.policy;
  const w = await makeWorld({ ...opts, policy });
  await w.bootstrap();
  const express = require('express');
  const app = express();
  const sessionActor = opts.sessionActor || (req => req.get('x-test-actor') || null);
  const readers = { current: { readDocument: w.readDocument, readPin: w.readPin } };
  const dep = { householdId, origin: 'http://synthetic.local',
    authorize: w.authorize,
    acquire: w.syntheticAcquire, contextReader: w.contextReader,
    readBase: async () => {
      events.push('readBase');
      if (opts.hooks && opts.hooks.readBase) await opts.hooks.readBase();
      return clone(w.baseFixture);
    },
    now: () => w.clock.t, commitAdmitted: w.commitAdmitted,
    readDocument: async () => { events.push('readDocument'); return readers.current.readDocument(); },
    readPin: async () => { events.push('readPin'); return readers.current.readPin(); },
    store: w.wrappedStore, registerRecovery: () => {} };
  if (opts.httpPolicy !== false && policy) dep.authorizeRecovery = policy.fn;
  // Addendum A: the synchronous final-disclosure capability. The default is
  // a healthy recording double (the amended contract requires the
  // capability for any recovery disclosure); opts.finalDisclosure may
  // supply a custom implementation, or null to omit the capability
  // entirely (B4R-A7). The double never writes to the events log.
  const finalDisclosureCalls = [];
  if (opts.finalDisclosure !== null) {
    const impl = typeof opts.finalDisclosure === 'function' ? opts.finalDisclosure : () => true;
    dep.finalDisclosureAuthorize = sel => { finalDisclosureCalls.push(clone(sel)); return impl(sel); };
  }
  const mounted = mountSettlementHttp(app, sessionActor, dep);
  assert.equal(mounted.active, true);
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const call = async (route, body, actor) => {
    const headers = { 'Content-Type': 'application/json', 'Origin': 'http://synthetic.local',
      'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' };
    if (actor) headers['x-test-actor'] = actor;
    const r = await fetch(`http://127.0.0.1:${port}/settlement/${route}`,
      { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { w, server, call, readers, events, policy, finalDisclosureCalls,
    close: () => new Promise(res => server.close(res)) };
}

// === B4R-1: capability surface is opt-in on both seams =====================
test('B4R-1: recovery capability exists only where opted in', async () => {
  // Store: no opt-in -> no recoveryRead property at all.
  const plain = await makeWorld({ recovery: false, policy: null });
  assert.equal('recoveryRead' in plain.store, false);
  assert.equal(plain.store.recoveryRead, undefined);
  // Store: opt-in without the terminal gate -> still unexposed. (Fresh
  // adapters: the TC registry treats adapter objects as domain surfaces,
  // so reusing another store's adapters is itself an aliasing error.)
  const fresh = makeAdapters();
  const ungatedDeps = { householdId, documentStore: fresh.documentStore,
    journalStore: fresh.journalStore, pinStore: fresh.pinStore,
    backupStore: fresh.backupStore, quarantine: fresh.quarantine,
    lock: fresh.lock, now: () => NOW0, recoveryRead: true };
  const ungated = createSettlementEvidenceStore(ungatedDeps);
  assert.equal('recoveryRead' in ungated, false);
  // Store: malformed opt-in value is a construction error, never a default.
  assert.throws(() => createSettlementEvidenceStore({ ...ungatedDeps, recoveryRead: 'yes' }),
    TypeError);
  // Store: opt-in on a gated store -> the capability exists.
  const opted = await makeWorld({ policy: null });
  assert.equal(typeof opted.store.recoveryRead, 'function');
  // Controller: policy supplied but store not opted in -> branch unreachable,
  // the policy is never consulted.
  const noStore = await makeWorld({ recovery: false });
  await noStore.bootstrap();
  await commitOp(noStore, noStore.controller, 1);
  assert.deepEqual(await noStore.controller.outcome(noStore.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  assert.equal(noStore.policy.calls.length, 0);
  // Controller: store opted in but no policy -> cross-login stays unknown.
  const noPolicy = await makeWorld({ policy: null });
  await noPolicy.bootstrap();
  await commitOp(noPolicy, noPolicy.controller, 1);
  assert.deepEqual(await noPolicy.controller.outcome(noPolicy.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  // The controller's public object keeps its exact shipped key set even in
  // a fully configured world: the publication evaluation is a private
  // registered capability, never a public method (incumbent surface pin).
  const configured = await makeWorld({});
  assert.deepEqual(Object.keys(configured.controller).sort(), ['confirm', 'outcome', 'prepare']);
  assert.equal('publicationOutcome' in configured.controller, false);
  // HTTP mount: a non-function authorizeRecovery dep is malformed.
  const express = require('express');
  const w = await makeWorld({});
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { householdId, origin: 'http://synthetic.local', authorize: w.authorize,
      acquire: w.syntheticAcquire, contextReader: w.contextReader,
      readBase: async () => clone(w.baseFixture), now: () => NOW0,
      commitAdmitted: w.commitAdmitted, readDocument: w.readDocument,
      readPin: w.readPin, store: w.wrappedStore, authorizeRecovery: 'yes' }), TypeError);
});

// === B4R-2: defaults unchanged (spot checks; full proof is B4R-30) =========
test('B4R-2: unconfigured worlds keep the shipped refusal behaviour', async () => {
  const w = await makeWorld({ recovery: false, policy: null });
  await w.bootstrap();
  const { ack } = await commitOp(w, w.controller, 1);
  assert.equal(ack.operationId, op(1));
  // Recorded actor: full same-actor receipt contract, unchanged.
  const receiptA = await w.controller.outcome(w.ctx, { operationId: op(1) });
  assert.deepEqual(receiptA, { status: 'committed', operationId: op(1),
    revision: 1, digest: ack.digest });
  // Different actor: unknown on both controller surfaces.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  // Same-actor negative contract unchanged: seal, then the exact 3 keys.
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  assert.deepEqual(await w.controller.outcome(w.ctx, { operationId: op(5), generation: prepared.generation }),
    { status: 'not-applied', operationId: op(5), generation: prepared.generation });
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5), generation: prepared.generation }),
    { status: 'unknown', operationId: op(5) });
});

// === B4R-3: cross-login committed proof, exact 2-key projection ============
test('B4R-3: approved cross-login outcome is exactly {status, operationId}', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const out = await w.controller.outcome(w.ctxB, { operationId: op(1) });
  assert.deepEqual(out, { status: 'committed', operationId: op(1) });
  assert.deepEqual(Object.keys(out).sort(), ['operationId', 'status']);
  // Same-actor path is untouched and never consults the recovery policy.
  const callsBefore = w.policy.calls.length;
  const receiptA = await w.controller.outcome(w.ctx, { operationId: op(1) });
  assert.equal(receiptA.status, 'committed');
  assert.equal(receiptA.revision, 1);
  assert.equal(w.policy.calls.length, callsBefore, 'same-actor proof must not consult the policy');
});

// === B4R-4: private qualified bundle at store level ========================
test('B4R-4: store recoveryRead returns the private bundle (receipt fields + requestDigest)', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const receipt = await w.store.outcome({ actorId: ACTOR, operationId: op(1) });
  assert.equal(receipt.status, 'committed');
  // The private sixth field is the recorded requestDigest, read from the
  // durable document record itself — never part of the receipt.
  const doc = JSON.parse(w.adapters.d.doc.toString('utf8'));
  const recorded = doc.operations.find(o => o.operationId === op(1));
  // Operation-only request: the positive rule needs no generation.
  const bundle = await w.store.recoveryRead({ operationId: op(1) });
  assert.deepEqual(bundle, { status: 'committed', operationId: op(1), actorId: ACTOR,
    revision: receipt.revision, digest: receipt.digest, requestDigest: recorded.requestDigest });
  // A generation selector does not disturb the positive rule.
  const bundle2 = await w.store.recoveryRead({ operationId: op(1),
    generation: 'generation-' + 'e'.repeat(32) });
  assert.deepEqual(bundle2, bundle);
});

// === B4B: private committed-request binding (requestDigest) ================
// The recovery bundle gains the recorded requestDigest as a private sixth
// field; the confirmation boundary requires it; it is never disclosed.

// === B4B-1 (i): the private bundle carries the stored requestDigest ========
test('B4B-1: recoveryRead committed bundle gains the recorded requestDigest', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  // Prepare manually and capture the journal at its durable write during
  // confirm — an independent source. The expected digest is computed from
  // the journal's own frozen preview with the contract digest, not taken
  // from any store return value.
  const p = await prepareOp(w, w.controller, 1);
  assert.equal(p.status, 'prepared');
  let journal = null;
  w.adapters.hooks.journalWrite = async value => { journal = value; };
  const ack = await w.controller.confirm(w.ctx, { operationId: p.operationId,
    previewToken: p.previewToken, generation: p.generation, confirmed: true });
  assert.equal(ack.status, 'committed');
  assert.ok(journal && journal.preview, 'the commit wrote its journal first');
  const expected = C.digest(journal.preview);
  assert.equal(journal.requestDigest, expected, 'journal binds the preview digest');
  const bundle = await w.store.recoveryRead({ operationId: op(1) });
  assert.equal(bundle.status, 'committed');
  assert.equal(bundle.requestDigest, expected);
  assert.deepEqual(Object.keys(bundle).sort(),
    ['actorId', 'digest', 'operationId', 'requestDigest', 'revision', 'status']);
  // The durable document record itself carries the same digest.
  const doc = JSON.parse(w.adapters.d.doc.toString('utf8'));
  assert.equal(doc.operations.find(o => o.operationId === op(1)).requestDigest, expected);
});

// === B4B-2 (ii): a stored record without requestDigest proves nothing ======
test('B4B-2: missing stored requestDigest -> recoveryRead unknown', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  // Rewrite the durable document without the recorded digest, keeping the
  // document digest and pin in agreement with the tampered bytes.
  const doc = JSON.parse(w.adapters.d.doc.toString('utf8'));
  delete doc.operations[0].requestDigest;
  doc.digest = C.digest({ schema: C.SCHEMA, householdId,
    revision: doc.revision, operations: doc.operations });
  w.adapters.d.doc = Buffer.from(JSON.stringify(doc));
  w.adapters.d.pin = { ...w.adapters.d.pin, digest: doc.digest };
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  // And the controller discloses nothing for the new login either.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
});

// === B4B-3 (iii): a malformed stored requestDigest proves nothing ==========
test('B4B-3: malformed stored requestDigest -> recoveryRead unknown', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const doc = JSON.parse(w.adapters.d.doc.toString('utf8'));
  doc.operations[0].requestDigest = 'not-a-hash';
  doc.digest = C.digest({ schema: C.SCHEMA, householdId,
    revision: doc.revision, operations: doc.operations });
  w.adapters.d.doc = Buffer.from(JSON.stringify(doc));
  w.adapters.d.pin = { ...w.adapters.d.pin, digest: doc.digest };
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
});

// === B4B-4 (iv): the confirmation boundary refuses an under-bound bundle ===
test('B4B-4: a 5-field or malformed-digest bundle no longer proves committed', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const real = w.store.recoveryRead.bind(w.store);
  const variants = {
    'requestDigest missing (the pre-change 5-field bundle)': b => {
      const { requestDigest, ...rest } = b; return rest; },
    'requestDigest malformed': b => ({ ...b, requestDigest: 'not-a-hash' }),
    'requestDigest non-hex': b => ({ ...b, requestDigest: 'z'.repeat(64) }),
    'requestDigest uppercase': b => ({ ...b, requestDigest: 'A'.repeat(64) }),
  };
  for (const [label, tamper] of Object.entries(variants)) {
    const store = { ...w.store, recoveryRead: async input => tamper(await real(input)) };
    const c = w.createController({ store });
    const out = await c.outcome(w.ctxB, { operationId: op(1) });
    assert.deepEqual(out, { status: 'unknown', operationId: op(1) }, label);
  }
  // Control: the untampered bundle still proves committed for the new login.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(1) }),
    { status: 'committed', operationId: op(1) });
});

// === B4B-5 (v): canary — the requestDigest never reaches a disclosure ======
test('B4B-5: the stored requestDigest appears in no outcome or publication', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    const doc = JSON.parse(h.w.adapters.d.doc.toString('utf8'));
    const secret = doc.operations.find(o => o.operationId === op(1)).requestDigest;
    assert.match(secret, /^[a-f0-9]{64}$/);
    // The digest is present in the private bundle — and only there.
    const bundle = await h.w.store.recoveryRead({ operationId: op(1) });
    assert.equal(bundle.requestDigest, secret);
    const direct = await h.w.controller.outcome(h.w.ctxB, { operationId: op(1) });
    assert.deepEqual(direct, { status: 'committed', operationId: op(1) });
    assert.ok(!JSON.stringify(direct).includes(secret), 'controller outcome leaks requestDigest');
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.deepEqual(out.body, { status: 'committed', operationId: op(1) });
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.body.publication, 'included');
    for (const [label, body] of [['outcome', out.body], ['publication', pub.body]]) {
      const wire = JSON.stringify(body);
      assert.ok(!wire.includes(secret), label + ' leaks the requestDigest');
      assert.ok(!wire.includes('requestDigest'), label + ' names the requestDigest');
    }
  } finally { await h.close(); }
});

// === B4B-6 (vii): negative + unconfigured behaviour non-regressed ==========
test('B4B-6: negative proof and unconfigured behaviour are unchanged by the binding', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  // Exact-generation negative proof: the public result keeps the exact
  // 3-key shape; the private bundle now also carries the certificate's
  // confirmationDigest (B4N-1) without changing the disclosure.
  const neg = await w.controller.outcome(w.ctxB, { operationId: op(5), generation: prepared.generation });
  assert.deepEqual(neg, { status: 'not-applied', operationId: op(5), generation: prepared.generation });
  const certNeg = w.history.records().find(r => r.operationId === op(5));
  const bundleNeg = await w.store.recoveryRead({ operationId: op(5), generation: prepared.generation });
  assert.deepEqual(bundleNeg, { status: 'not-applied', operationId: op(5), generation: prepared.generation,
    confirmationDigest: certNeg.confirmationDigest });
  // A wrong generation stays unknown.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5),
    generation: 'generation-' + '0'.repeat(32) }), { status: 'unknown', operationId: op(5) });
  // Unconfigured world: no recovery capability; cross-login stays unknown.
  const plain = await makeWorld({ recovery: false });
  await plain.bootstrap();
  await commitOp(plain, plain.controller, 1);
  assert.equal('recoveryRead' in plain.store, false);
  assert.deepEqual(await plain.controller.outcome(plain.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
});

// === B4N: combined negative private binding (confirmationDigest) ===========
// The recovery negative bundle gains the terminal certificate's recorded
// confirmationDigest as a private fourth field; the confirmation boundary
// requires it and retains it in the private binding; the public negative
// result is explicitly projected back to exactly
// {status, operationId, generation} and the digest is never disclosed.

// === B4N-1 (i): the private bundle carries the certificate's digest ========
test('B4N-1: recoveryRead negative bundle gains the certificate confirmationDigest', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  // The durable certificate record, read straight from the history bytes —
  // independent of the recovery read under test. The append capture is a
  // second independent source for the same record.
  const cert = w.history.records().find(r => r.operationId === op(5));
  assert.ok(cert, 'durable certificate exists');
  assert.match(cert.confirmationDigest, /^[a-f0-9]{64}$/);
  const appended = w.history.appendArgs.map(a => a.certificate).find(c => c && c.operationId === op(5));
  assert.equal(appended.confirmationDigest, cert.confirmationDigest, 'append capture agrees');
  const bundle = await w.store.recoveryRead({ operationId: op(5), generation: gen });
  assert.deepEqual(bundle, { status: 'not-applied', operationId: op(5), generation: gen,
    confirmationDigest: cert.confirmationDigest });
  assert.deepEqual(Object.keys(bundle).sort(),
    ['confirmationDigest', 'generation', 'operationId', 'status']);
});

// === B4N-2 (ii): a certificate without a valid digest proves nothing =======
test('B4N-2: missing or malformed certificate confirmationDigest -> recoveryRead unknown', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  // Control: the genuine certificate proves.
  assert.equal((await w.store.recoveryRead({ operationId: op(5), generation: gen })).status, 'not-applied');
  // Rewrite the durable history with the certificate's digest removed,
  // keeping the container encoding valid. Shipped history qualification
  // already refuses such a record at the gate; the branch's own hash
  // check keeps the branch fail-closed on its own terms — either way the
  // observable read is unknown and the controller discloses nothing.
  const genuine = w.history.records();
  const missing = genuine.map(r => { const c = { ...r }; delete c.confirmationDigest; return c; });
  let e = w.history.encode(missing);
  w.history.bytes = e.historyBytes; w.history.checkpoint = e.checkpoint;
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
    { status: 'unknown', operationId: op(5) });
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5), generation: gen }),
    { status: 'unknown', operationId: op(5) });
  const malformed = genuine.map(r => ({ ...r, confirmationDigest: 'not-a-hash' }));
  e = w.history.encode(malformed);
  w.history.bytes = e.historyBytes; w.history.checkpoint = e.checkpoint;
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
    { status: 'unknown', operationId: op(5) });
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5), generation: gen }),
    { status: 'unknown', operationId: op(5) });
});

// === B4N-3 (iii): the confirmation boundary refuses an under-bound bundle ==
test('B4N-3: a 3-field or malformed-digest negative bundle no longer proves not-applied', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  const real = w.store.recoveryRead.bind(w.store);
  const variants = {
    'confirmationDigest missing (the pre-change 3-field bundle)': b => {
      if (b.status !== 'not-applied') return b;
      const { confirmationDigest, ...rest } = b; return rest; },
    'confirmationDigest malformed': b => b.status === 'not-applied'
      ? { ...b, confirmationDigest: 'not-a-hash' } : b,
    'confirmationDigest non-hex': b => b.status === 'not-applied'
      ? { ...b, confirmationDigest: 'z'.repeat(64) } : b,
    'confirmationDigest uppercase': b => b.status === 'not-applied'
      ? { ...b, confirmationDigest: 'A'.repeat(64) } : b,
    'extra field added': b => b.status === 'not-applied' ? { ...b, extra: 'x' } : b,
  };
  for (const [label, tamper] of Object.entries(variants)) {
    const store = { ...w.store, recoveryRead: async input => tamper(await real(input)) };
    const c = w.createController({ store });
    const out = await c.outcome(w.ctxB, { operationId: op(5), generation: gen });
    assert.deepEqual(out, { status: 'unknown', operationId: op(5) }, label);
  }
  // Control: the untampered bundle still proves the exact negative.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5), generation: gen }),
    { status: 'not-applied', operationId: op(5), generation: gen });
});

// === B4N-4 (iv): retention — the digest lives only in the private binding ==
test('B4N-4: the negative evaluation retains confirmationDigest in its private binding only', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  const cert = w.history.records().find(r => r.operationId === op(5));
  let publicationOutcome = null;
  const c = w.createController({ registerPublicationOutcome: fn => { publicationOutcome = fn; } });
  assert.equal(typeof publicationOutcome, 'function');
  const evaluation = await publicationOutcome(w.ctxB, { operationId: op(5), generation: gen });
  // The public result is the explicit projection: exactly three keys.
  assert.deepEqual(evaluation.result, { status: 'not-applied', operationId: op(5), generation: gen });
  assert.deepEqual(Object.keys(evaluation.result).sort(), ['generation', 'operationId', 'status']);
  // The digest is retained in the private binding — its own frozen field,
  // mirroring the committed branch's requestDigest retention — and nowhere
  // else in the evaluation.
  assert.deepEqual(evaluation.binding, { confirmationDigest: cert.confirmationDigest });
  assert.ok(Object.isFrozen(evaluation.binding), 'the retained binding is frozen');
  assert.ok(!JSON.stringify(evaluation.result).includes(cert.confirmationDigest),
    'the public result carries the digest');
  assert.equal(evaluation.recoveryRefused, false);
  assert.equal(typeof evaluation.recheckRecovery, 'function');
});

// === B4N-5 (v): canary — the certificate digest never reaches a disclosure ==
test('B4N-5: the certificate confirmationDigest appears in no outcome or publication', async () => {
  const h = await httpWorld({});
  try {
    const { prepared } = await sealViaExpiry(h.w, h.w.controller, 5);
    const gen = prepared.generation;
    const cert = h.w.history.records().find(r => r.operationId === op(5));
    const secret = cert.confirmationDigest;
    assert.match(secret, /^[a-f0-9]{64}$/);
    // The digest is present in the private bundle — and only there.
    const bundle = await h.w.store.recoveryRead({ operationId: op(5), generation: gen });
    assert.equal(bundle.confirmationDigest, secret);
    const direct = await h.w.controller.outcome(h.w.ctxB, { operationId: op(5), generation: gen });
    assert.deepEqual(direct, { status: 'not-applied', operationId: op(5), generation: gen });
    assert.ok(!JSON.stringify(direct).includes(secret), 'controller outcome leaks confirmationDigest');
    const out = await h.call('outcome', { operationId: op(5), generation: gen }, ACTOR2);
    assert.deepEqual(out.body, { status: 'not-applied', operationId: op(5), generation: gen });
    // The incumbent publication route takes operationId only: no negative
    // proof is available to it and nothing about the digest leaks there.
    const pub = await h.call('publication', { operationId: op(5) }, ACTOR2);
    assert.deepEqual(pub.body, { status: 'unknown', operationId: op(5) });
    for (const [label, body] of [['outcome', out.body], ['publication', pub.body]]) {
      const wire = JSON.stringify(body);
      assert.ok(!wire.includes(secret), label + ' leaks the confirmationDigest');
      assert.ok(!wire.includes('confirmationDigest'), label + ' names the confirmationDigest');
    }
  } finally { await h.close(); }
});

// === B4N-6 (vi): non-regression around the negative binding =================
test('B4N-6: committed branch, exact generation, same-actor and unconfigured paths unchanged', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  // Committed branch: the 6-field bundle and the 2-key public projection.
  const bundleC = await w.store.recoveryRead({ operationId: op(1) });
  assert.deepEqual(Object.keys(bundleC).sort(),
    ['actorId', 'digest', 'operationId', 'requestDigest', 'revision', 'status']);
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(1) }),
    { status: 'committed', operationId: op(1) });
  // Exact generation equality still binds the negative at both layers.
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: 'generation-' + '0'.repeat(32) }),
    { status: 'unknown', operationId: op(5) });
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5), generation: 'generation-' + '0'.repeat(32) }),
    { status: 'unknown', operationId: op(5) });
  // An operation-only recovery request still cannot take the negative branch.
  assert.deepEqual(await w.controller.outcome(w.ctxB, { operationId: op(5) }),
    { status: 'unknown', operationId: op(5) });
  // Same-actor negative (certificate lookup) keeps its exact 3-key shape.
  assert.deepEqual(await w.controller.outcome(w.ctx, { operationId: op(5), generation: gen }),
    { status: 'not-applied', operationId: op(5), generation: gen });
  // Unconfigured world: no recovery capability; cross-login stays unknown.
  const plain = await makeWorld({ recovery: false });
  await plain.bootstrap();
  const s5 = await sealViaExpiry(plain, plain.controller, 5);
  assert.equal('recoveryRead' in plain.store, false);
  assert.deepEqual(await plain.controller.outcome(plain.ctxB, { operationId: op(5), generation: s5.prepared.generation }),
    { status: 'unknown', operationId: op(5) });
});

// === B4R-5: policy input/output contract ===================================
test('B4R-5: policy sees the full server-derived input; 3-field output accepted', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const out = await w.controller.outcome(w.ctxB, { operationId: op(1) });
  assert.equal(out.status, 'committed');
  assert.ok(w.policy.calls.length >= 1);
  assert.deepEqual(w.policy.calls[0], { householdId, actorId: ACTOR2, operationId: op(1) });
  // Generation-carrying request: the retained input carries generation,
  // the (3-key) output is still accepted — no whole-input equality.
  const neg = await w.controller.outcome(w.ctxB, { operationId: op(5), generation: prepared.generation });
  assert.deepEqual(neg, { status: 'not-applied', operationId: op(5), generation: prepared.generation });
  const genCall = w.policy.calls.find(c => c.operationId === op(5));
  assert.deepEqual(genCall, { householdId, actorId: ACTOR2, operationId: op(5),
    generation: prepared.generation });
  // The recorded actor never appears in any policy input.
  for (const c of w.policy.calls) assert.equal(c.actorId, ACTOR2);
});

// === B4R-6: policy refusal precedes any read ===============================
test('B4R-6: a refusing policy is consulted before the store read', async () => {
  const policy = makePolicy(() => { throw new Error('policy refuses'); });
  const w = await makeWorld({ policy });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const out = await w.controller.outcome(w.ctxB, { operationId: op(1) });
  assert.deepEqual(out, { status: 'unknown', operationId: op(1) });
  assert.equal(policy.calls.length, 1, 'exactly the fresh decision ran');
  // The pinned observable is the recovery read itself: it never ran. (The
  // incumbent same-actor outcome evaluation reads history first by design;
  // that is not the recovery read and discloses nothing.)
  assert.equal(w.spies.recovery.length, 0, 'the store recovery read was never invoked');
  // A malformed (extra-key) policy output refuses the same way.
  const policy2 = makePolicy(input => ({ householdId: input.householdId,
    actorId: input.actorId, operationId: input.operationId, generation: 'generation-' + '0'.repeat(32) }));
  const w2 = await makeWorld({ policy: policy2 });
  await w2.bootstrap();
  await commitOp(w2, w2.controller, 1);
  assert.deepEqual(await w2.controller.outcome(w2.ctxB, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  assert.equal(w2.spies.recovery.length, 0);
});

// === B4R-7: negative readiness — journal discipline ========================
test('B4R-7: a present or unreadable journal is never negative proof', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  // Control: absent journal + qualified history -> exact negative bundle.
  const cert7 = w.history.records().find(r => r.operationId === op(5));
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
    { status: 'not-applied', operationId: op(5), generation: gen,
      confirmationDigest: cert7.confirmationDigest });
  // Journal bytes present (unparseable resident bytes) -> unknown.
  w.adapters.d.journal = Buffer.from('{"synthetic":"resident"}');
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
    { status: 'unknown', operationId: op(5) });
  w.adapters.d.journal = null;
  // Journal read throws -> unknown.
  const originalRead = w.adapters.journalStore.read;
  w.adapters.journalStore.read = async () => { throw new Error('synthetic journal fault'); };
  try {
    assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
      { status: 'unknown', operationId: op(5) });
  } finally { w.adapters.journalStore.read = originalRead; }
  // Positive rule is journal-independent: a recorded commit still proves.
  await commitOp(w, w.controller, 1);
  w.adapters.d.journal = Buffer.from('{"synthetic":"resident"}');
  const bundle = await w.store.recoveryRead({ operationId: op(1) });
  assert.equal(bundle.status, 'committed');
  assert.equal(bundle.actorId, ACTOR);
});

// === B4R-8: coexistence is never negative proof ============================
test('B4R-8: operation recorded AND certified -> unknown, never not-applied', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const cert = { schema: 'terminal-certificate-2', householdId,
    ledgerNamespace: w.domain.ledgerNamespace, operationId: op(1), actorId: ACTOR,
    kind: 'link', generation: 'generation-' + 'e'.repeat(32), reason: 'preview-expired',
    expectedRevision: 0, expectedDocumentDigest: 'f'.repeat(64),
    confirmationDigest: 'd'.repeat(64), decidedAt: NOW0 };
  w.history.appendRaw(cert);
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1), generation: cert.generation }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
});

// === B4R-9: divergence anywhere -> unknown =================================
test('B4R-9: pin/document/history divergence yields unknown for both proofs', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const { prepared } = await sealViaExpiry(w, w.controller, 5);
  const gen = prepared.generation;
  const pin0 = clone(w.adapters.d.pin), doc0 = Buffer.from(w.adapters.d.doc),
    hist0 = Buffer.from(w.history.bytes), check0 = clone(w.history.checkpoint);
  const expectUnknown = async label => {
    assert.deepEqual(await w.store.recoveryRead({ operationId: op(1) }),
      { status: 'unknown', operationId: op(1) }, label + ' (positive)');
    assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: gen }),
      { status: 'unknown', operationId: op(5) }, label + ' (negative)');
  };
  w.adapters.d.pin = { ...pin0, digest: 'f'.repeat(64) };
  await expectUnknown('pin digest corrupted');
  w.adapters.d.pin = pin0;
  w.adapters.d.doc = Buffer.from('not a ledger document');
  await expectUnknown('document bytes corrupted');
  w.adapters.d.doc = doc0;
  w.history.bytes = Buffer.from('not a history');
  await expectUnknown('history bytes corrupted');
  w.history.bytes = hist0; w.history.checkpoint = check0;
  // Control: restored state proves again.
  assert.equal((await w.store.recoveryRead({ operationId: op(1) })).status, 'committed');
  assert.equal((await w.store.recoveryRead({ operationId: op(5), generation: gen })).status, 'not-applied');
});

// === B4R-10: no actor slot at the store seam ===============================
test('B4R-10: the recovery read refuses any actor-shaped input', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1), actorId: ACTOR2 }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1), actorId: ACTOR }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1), extra: true }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(1), generation: 42 }),
    { status: 'unknown', operationId: op(1) });
  const noId = await w.store.recoveryRead(null);
  assert.equal(noId.status, 'unknown');
  // The controller only ever passes the selector pair to the store.
  const w2 = await makeWorld({});
  await w2.bootstrap();
  await commitOp(w2, w2.controller, 1);
  await w2.controller.outcome(w2.ctxB, { operationId: op(1) });
  assert.ok(w2.spies.recovery.length >= 1);
  for (const input of w2.spies.recovery) {
    assert.deepEqual(Object.keys(input).sort(), ['operationId']);
    assert.equal(input.operationId, op(1));
  }
});

// === B4R-11: negative proof binds the exact generation =====================
test('B4R-11: negative proof requires the exact supplied generation', async () => {
  const w = await makeWorld({ policy: null });
  await w.bootstrap();
  const s5 = await sealViaExpiry(w, w.controller, 5);
  const s6 = await sealViaExpiry(w, w.controller, 6);
  // No generation supplied -> unknown.
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5) }),
    { status: 'unknown', operationId: op(5) });
  // Another operation's genuine generation -> unknown.
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: s6.prepared.generation }),
    { status: 'unknown', operationId: op(5) });
  // Fabricated generation -> unknown.
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: 'generation-' + '9'.repeat(32) }),
    { status: 'unknown', operationId: op(5) });
  // The exact generation -> the exact 4-key private negative bundle.
  const cert11 = w.history.records().find(r => r.operationId === op(5));
  assert.deepEqual(await w.store.recoveryRead({ operationId: op(5), generation: s5.prepared.generation }),
    { status: 'not-applied', operationId: op(5), generation: s5.prepared.generation,
      confirmationDigest: cert11.confirmationDigest });
});

// === B4R-12: terminalizing latch suppresses recovery =======================
test('B4R-12: live terminalizing ownership suppresses the recovery branch', async () => {
  const w = await makeWorld({});
  await w.bootstrap();
  const sealing = w.createController();
  const p = await prepareOp(w, sealing, 5);
  assert.equal(p.status, 'prepared');
  w.clock.t = p.expiresAt + 1;
  // Lost seal acknowledgement: the append lands, the ack throws.
  w.history.hooks.compareAndAppend = async (arg, perform) => {
    const done = perform();
    if (done) throw new Error('synthetic lost seal ack');
    return done;
  };
  await sealing.confirm(w.ctx, { operationId: p.operationId, previewToken: p.previewToken,
    generation: p.generation, confirmed: true });
  w.history.hooks.compareAndAppend = null;
  assert.ok(w.history.records().some(r => r.operationId === op(5)), 'durable certificate exists');
  const policyCalls = w.policy.calls.length;
  // The evaluating (sealing) controller: unknown for BOTH actors, and the
  // recovery policy is never consulted under live latch ownership.
  assert.deepEqual(await sealing.outcome(w.ctxB, { operationId: op(5), generation: p.generation }),
    { status: 'unknown', operationId: op(5) });
  const aOut = await sealing.outcome(w.ctx, { operationId: op(5), generation: p.generation });
  assert.equal(aOut.status, 'unknown');
  assert.equal(w.policy.calls.length, policyCalls, 'policy consulted under latch ownership');
  // A fresh controller over the same store has no latch: the durable
  // certificate proves the negative through the recovery branch.
  const fresh = w.createController();
  assert.deepEqual(await fresh.outcome(w.ctxB, { operationId: op(5), generation: p.generation }),
    { status: 'not-applied', operationId: op(5), generation: p.generation });
});

// === B4R-13: authority/policy revocation during the recovery read ==========
test('B4R-13: revocation during the recovery read suppresses the proof', async () => {
  // (a) The ordinary authorize flips to a different actor DURING the read
  // (armed to fire on the recovery read's own history snapshot, after the
  // same-actor outcome's snapshot already passed).
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  let snapshots = 0;
  w.history.hooks.readSnapshot = async () => {
    snapshots++;
    if (snapshots >= 2) w.authState.actorOverride = ACTOR;
    return { historyBytes: Buffer.from(w.history.bytes), checkpoint: clone(w.history.checkpoint) };
  };
  const out = await w.controller.outcome(w.ctxB, { operationId: op(1) });
  assert.ok(snapshots >= 2, 'the recovery read was reached');
  assert.ok(['unknown', 'unavailable'].includes(out.status),
    'revoked authority must not disclose, got ' + out.status);
  assert.notEqual(out.status, 'committed');
  // (b) authorizeRecovery approves the fresh decision, then throws at the
  // post-read recheck -> unknown, never the proof.
  const policy = makePolicy((input, n) => {
    if (n >= 2) throw new Error('policy revoked mid-read');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const w2 = await makeWorld({ policy });
  await w2.bootstrap();
  await commitOp(w2, w2.controller, 1);
  const out2 = await w2.controller.outcome(w2.ctxB, { operationId: op(1) });
  assert.deepEqual(out2, { status: 'unknown', operationId: op(1) });
  assert.equal(policy.calls.length, 2);
});

// === B4R-14: unknown operations stay unknown ===============================
test('B4R-14: an unrecorded, uncertified operation is unknown even with approval', async () => {
  const h = await httpWorld({});
  try {
    const out = await h.call('outcome', { operationId: op(9) }, ACTOR2);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { status: 'unknown', operationId: op(9) });
    const pub = await h.call('publication', { operationId: op(9) }, ACTOR2);
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body, { status: 'unknown', operationId: op(9) });
    assert.ok(h.policy.calls.length >= 1, 'the policy was consulted; it is not the proof');
  } finally { await h.close(); }
});

// === B4R-15: policy approval is per named operation ========================
test('B4R-15: approval for one operation never covers another', async () => {
  const policy = makePolicy(input => {
    if (input.operationId !== op(1)) throw new Error('not approved');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const h = await httpWorld({ policy });
  try {
    await commitOp(h.w, h.w.controller, 1);
    await commitOp(h.w, h.w.controller, 2);
    // Controller surface: unknown. HTTP surface: the incumbent 503 refusal.
    assert.deepEqual(await h.w.controller.outcome(h.w.ctxB, { operationId: op(2) }),
      { status: 'unknown', operationId: op(2) });
    const refused = await h.call('outcome', { operationId: op(2) }, ACTOR2);
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.body, { status: 'unavailable' });
    const refusedPub = await h.call('publication', { operationId: op(2) }, ACTOR2);
    assert.equal(refusedPub.status, 503);
    assert.deepEqual(refusedPub.body, { status: 'unavailable' });
    // Control: the approved operation discloses normally.
    const ok = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { status: 'committed', operationId: op(1) });
  } finally { await h.close(); }
});

// === B4R-16: cross-login publication included ==============================
test('B4R-16: publication binds through the private bundle for a new login', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.status, 'committed');
    assert.equal(pub.body.publication, 'included');
    assert.equal(pub.body.data.settlementEvidenceStatus.status, 'qualified');
    assert.ok(JSON.stringify(pub.body.data).includes(op(1)), 'the judged link is present');
    // Same-actor publication is unchanged.
    const pubA = await h.call('publication', { operationId: op(1) }, ACTOR);
    assert.equal(pubA.status, 200);
    assert.equal(pubA.body.publication, 'included');
  } finally { await h.close(); }
});

// === B4R-17: independent final rechecks on /outcome ========================
test('B4R-17: revocation at the controller recheck and at the HTTP recheck both refuse', async () => {
  // Policy revoked at call 2 = the controller's post-read recheck.
  const policyCtl = makePolicy((input, n) => {
    if (n >= 2) throw new Error('revoked at controller recheck');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const h1 = await httpWorld({ policy: policyCtl });
  try {
    await commitOp(h1.w, h1.w.controller, 1);
    const res = await h1.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: 'unavailable' });
    assert.equal(policyCtl.calls.length, 2, 'refusal happened at the controller recheck');
  } finally { await h1.close(); }
  // Policy revoked at call 3 = the HTTP seam's final recheck, AFTER the
  // controller fully approved — proves the seam recheck is independent,
  // not a re-test of the controller's decision.
  const policyHttp = makePolicy((input, n) => {
    if (n >= 3) throw new Error('revoked at HTTP recheck');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const h2 = await httpWorld({ policy: policyHttp });
  try {
    await commitOp(h2.w, h2.w.controller, 1);
    const res = await h2.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: 'unavailable' });
    assert.equal(policyHttp.calls.length, 3, 'the HTTP-level recheck ran and refused');
  } finally { await h2.close(); }
});

// === B4R-18: revocation during publication acquisition =====================
test('B4R-18: policy revoked during base/loader acquisition suppresses publication', async () => {
  const events2 = [];
  let revoked = false;
  const switchable = makePolicy((input) => {
    if (revoked) throw new Error('revoked during acquisition');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  }, events2);
  const h2 = await httpWorld({ policy: switchable, events: events2, hooks: {
    readBase: async () => { revoked = true; },
  } });
  try {
    await commitOp(h2.w, h2.w.controller, 1);
    events2.length = 0;
    const res = await h2.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: 'unavailable' });
    // Ordering: the final policy recheck ran AFTER the last acquisition
    // event, and no acquisition follows it.
    const lastPolicy = events2.lastIndexOf('policy');
    const lastAcquire = Math.max(events2.lastIndexOf('readBase'),
      events2.lastIndexOf('readDocument'), events2.lastIndexOf('readPin'));
    assert.ok(lastAcquire >= 0, 'acquisition happened');
    assert.ok(lastPolicy > lastAcquire, 'final recheck follows all acquisition');
    assert.ok(events2.slice(lastPolicy + 1).every(e => e === 'policy' || e === 'authorize'),
      'no acquisition after the final recheck');
  } finally { await h2.close(); }
});

// === BLOCK-FIX (Atlas provisional BLOCK, ts 1792947464, on head 7ba9207a) ==
// The seam recheck must be the FINAL check before serialization: the post
// helper's own final authorization await follows the route handler, so a
// recovery-policy revocation landing during THAT await used to serialize
// unchecked. Pinned here: revocation armed to land inside the LAST
// authorize call of the request (the helper's final authorization await,
// after every route-level check has completed) suppresses disclosure on
// BOTH routes.
test('BLOCK-FIX: revocation during the helper final authorization await suppresses disclosure', async () => {
  let authorizeCalls = 0, flipAt = Infinity, revoked = false;
  const policy = makePolicy(input => {
    if (revoked) throw new Error('revoked during final authorization await');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const h = await httpWorld({ policy });
  try {
    await commitOp(h.w, h.w.controller, 1);
    h.w.authState.hooks.authorize = async () => {
      authorizeCalls++;
      if (authorizeCalls >= flipAt) revoked = true;
    };
    // Measure each route's approving-path authorize-call count, then arm
    // the revocation to land inside that final call.
    authorizeCalls = 0;
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    assert.deepEqual(control.body, { status: 'committed', operationId: op(1) });
    const outcomeCalls = authorizeCalls;
    authorizeCalls = 0; flipAt = outcomeCalls;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503, 'outcome must refuse when revocation lands in the final await');
    assert.deepEqual(out.body, { status: 'unavailable' });
    assert.equal(policy.calls.length, 6, 'two approving decisions + the final recheck that refused');
    flipAt = Infinity; revoked = false; authorizeCalls = 0; policy.calls.length = 0;
    const controlPub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(controlPub.body.publication, 'included');
    const pubCalls = authorizeCalls;
    authorizeCalls = 0; flipAt = pubCalls; policy.calls.length = 0;
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503, 'publication must refuse when revocation lands in the final await');
    assert.deepEqual(pub.body, { status: 'unavailable' });
    assert.equal(policy.calls.length, 3, 'the final recheck ran after the final authorization');
  } finally { await h.close(); }
});

// === B4R-19: malformed policy outputs refuse at the seam ===================
test('B4R-19: extra-key / wrong-operation / wrong-actor policy outputs -> 503', async () => {
  const variants = [
    ['extra key', input => ({ householdId: input.householdId, actorId: input.actorId,
      operationId: input.operationId, generation: 'generation-' + '0'.repeat(32) })],
    ['wrong operation', input => ({ householdId: input.householdId, actorId: input.actorId,
      operationId: op(2) })],
    ['wrong actor (the recorded actor)', input => ({ householdId: input.householdId,
      actorId: ACTOR, operationId: input.operationId })],
    ['wrong household', input => ({ householdId: 'household-' + 'f'.repeat(32),
      actorId: input.actorId, operationId: input.operationId })],
  ];
  for (const [label, behavior] of variants) {
    const policy = makePolicy(behavior);
    const h = await httpWorld({ policy });
    try {
      await commitOp(h.w, h.w.controller, 1);
      const res = await h.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(res.status, 503, label);
      assert.deepEqual(res.body, { status: 'unavailable' }, label);
      const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503, label + ' (publication)');
    } finally { await h.close(); }
  }
});

// === B4R-20: HTTP default unchanged ========================================
test('B4R-20: mount without authorizeRecovery keeps cross-login unknown', async () => {
  const h = await httpWorld({ httpPolicy: false });
  try {
    await commitOp(h.w, h.w.controller, 1);
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { status: 'unknown', operationId: op(1) });
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body, { status: 'unknown', operationId: op(1) });
    // The recorded actor's routes behave exactly as shipped.
    const outA = await h.call('outcome', { operationId: op(1) }, ACTOR);
    assert.equal(outA.body.status, 'committed');
    assert.equal(outA.body.revision, 1);
  } finally { await h.close(); }
});

// === B4R-21: incumbent outer authorization gate untouched ==================
test('B4R-21: authorize output naming a foreign actor refuses every route', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    h.w.authState.actorOverride = ACTOR2; // policy now names B for session A
    const sel = { transaction: 'selection-' + 'a'.repeat(32), commitment: 'choice-' + 'b'.repeat(32) };
    const prep = await h.call('prepare', { operationId: op(3), selection: sel, assignedCents: 2500 }, ACTOR);
    assert.equal(prep.status, 503);
    assert.deepEqual(prep.body, { status: 'unavailable' });
    const conf = await h.call('confirm', { operationId: op(1), previewToken: 'a'.repeat(64), confirmed: true }, ACTOR);
    assert.equal(conf.status, 503);
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR);
    assert.equal(out.status, 503);
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR);
    assert.equal(pub.status, 503);
  } finally { await h.close(); }
});

// === B4R-22: prefix binding at an intermediate revision ====================
test('B4R-22: publication binds an operation recorded at an earlier revision', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);       // op1 lands at revision 1
    await commitOp(h.w, h.w.controller, 2);       // op2 advances head to 2
    const receipt = await h.w.store.outcome({ actorId: ACTOR, operationId: op(1) });
    assert.equal(receipt.revision, 1, 'op1 receipt is the revision-1 prefix');
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.publication, 'included');
    assert.ok(JSON.stringify(pub.body.data).includes(op(1)));
    const pub2 = await h.call('publication', { operationId: op(2) }, ACTOR2);
    assert.equal(pub2.body.publication, 'included');
  } finally { await h.close(); }
});

// === B4R-23: retraction history does not defeat binding ====================
test('B4R-23: an operation later retracted still binds for its own publication', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    // Retract op1 through the store's own no-recovery commit path (the
    // shipped P2 withdrawal mechanism), as the recorded actor.
    const prep = await h.w.store.prepare({ actorId: ACTOR, operationId: op(9),
      command: { version: 1, kind: 'retract', targetOperationId: op(1) } });
    assert.ok(prep && prep.preview, 'retract preview staged');
    const ack = await h.w.store.commitWithoutRecovery({ actorId: ACTOR,
      preview: prep.preview, confirmationDigest: prep.confirmationDigest });
    assert.equal(ack.status, 'committed', 'retraction committed');
    // The operation is judged in its full history: link + reversal.
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.deepEqual(out.body, { status: 'committed', operationId: op(1) });
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.publication, 'included');
    assert.equal(pub.body.data.settlementEvidenceStatus.status, 'qualified');
    // Judged in its FULL history: the link's relief is reversed out, so no
    // unreversed relief for the retracted operation remains in the view.
    const links = (pub.body.data.settlementEvidence?.commitments || [])
      .flatMap(c => c.links || []);
    const link = links.find(l => l.operationId === op(1));
    assert.ok(!link || link.reversals.reduce((s, r) => s + r.cents, 0) >= link.assignedCents,
      'the retracted link carries no unreversed relief');
  } finally { await h.close(); }
});

// === B4R-24: wrong serving state never binds ===============================
test('B4R-24: serving state without the operation (or with a foreign one) -> unavailable', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    // (a) Serving readers over a genesis-only world: the operation is absent.
    const genesis = await makeWorld({ policy: null });
    await genesis.bootstrap();
    h.readers.current = { readDocument: genesis.readDocument, readPin: genesis.readPin };
    const absent = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(absent.status, 200);
    assert.equal(absent.body.status, 'committed');
    assert.equal(absent.body.publication, 'unavailable');
    assert.ok(!Object.hasOwn(absent.body.data, 'settlementEvidence'),
      'no settlement evidence is attached on an unavailable publication');
    // (b) Serving readers over a world where the SAME operationId was
    // recorded by a DIFFERENT actor at revision 1: the prefix digest under
    // the binding actor does not reproduce -> excluded.
    const foreign = await makeWorld({ policy: null });
    await foreign.bootstrap();
    await commitOp(foreign, foreign.controller, 1, foreign.ctxB);
    h.readers.current = { readDocument: foreign.readDocument, readPin: foreign.readPin };
    const mismatched = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(mismatched.status, 200);
    assert.equal(mismatched.body.publication, 'unavailable');
    // Control: the world's own readers bind again.
    h.readers.current = { readDocument: h.w.readDocument, readPin: h.w.readPin };
    const own = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(own.body.publication, 'included');
  } finally { await h.close(); }
});

// === B4R-25: concurrent publications keep request-local bindings ===========
test('B4R-25: concurrent cross-login publications do not cross bindings', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);                 // op1 by A, rev 1
    await commitOp(h.w, h.w.controller, 2, h.w.ctxC);       // op2 by C, rev 2
    const [p1, p2] = await Promise.all([
      h.call('publication', { operationId: op(1) }, ACTOR2),
      h.call('publication', { operationId: op(2) }, ACTOR2),
    ]);
    assert.equal(p1.body.publication, 'included');
    assert.ok(JSON.stringify(p1.body.data).includes(op(1)));
    assert.equal(p2.body.publication, 'included');
    assert.ok(JSON.stringify(p2.body.data).includes(op(2)));
    // No residue: a later request for an absent operation gets no bundle.
    const absent = await h.call('publication', { operationId: op(9) }, ACTOR2);
    assert.deepEqual(absent.body, { status: 'unknown', operationId: op(9) });
    const out1 = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.deepEqual(out1.body, { status: 'committed', operationId: op(1) });
  } finally { await h.close(); }
});

// === B4R-26: disclosure canaries ===========================================
test('B4R-26: neither the recorded actor nor the prefix digest is disclosed', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    await commitOp(h.w, h.w.controller, 2);
    const receipt = await h.w.store.outcome({ actorId: ACTOR, operationId: op(1) });
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.deepEqual(out.body, { status: 'committed', operationId: op(1) });
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.body.publication, 'included');
    for (const [label, body] of [['outcome', out.body], ['publication', pub.body]]) {
      const wire = JSON.stringify(body);
      assert.ok(!wire.includes(ACTOR), label + ' leaks the recorded actor');
      assert.ok(!wire.includes(receipt.digest), label + ' leaks the prefix digest');
    }
    // Negative disclosure is exactly the 3 keys, canary-free as well.
    const s5 = await sealViaExpiry(h.w, h.w.controller, 5);
    const neg = await h.call('outcome', { operationId: op(5), generation: s5.prepared.generation }, ACTOR2);
    assert.deepEqual(neg.body, { status: 'not-applied', operationId: op(5),
      generation: s5.prepared.generation });
    assert.ok(!JSON.stringify(neg.body).includes(ACTOR));
  } finally { await h.close(); }
});

// === B4R-27: the recovery path never logs ==================================
test('B4R-27: recovery flows produce no console output', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {}; let count = 0;
    for (const m of methods) { originals[m] = console[m]; console[m] = () => { count++; }; }
    try {
      const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.body.status, 'committed');
      const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.body.publication, 'included');
      const direct = await h.w.controller.outcome(h.w.ctxB, { operationId: op(1) });
      assert.equal(direct.status, 'committed');
    } finally { for (const m of methods) console[m] = originals[m]; }
    assert.equal(count, 0, 'console output during recovery flows');
  } finally { await h.close(); }
});

// === B4R-28: recovery performs no writes ===================================
test('B4R-28: full recovery flows leave durable state byte-identical', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    const s5 = await sealViaExpiry(h.w, h.w.controller, 5);
    const before = durableSnapshot(h.w);
    await h.call('outcome', { operationId: op(1) }, ACTOR2);
    await h.call('publication', { operationId: op(1) }, ACTOR2);
    await h.call('outcome', { operationId: op(5), generation: s5.prepared.generation }, ACTOR2);
    await h.call('publication', { operationId: op(5) }, ACTOR2);
    await h.w.controller.outcome(h.w.ctxB, { operationId: op(1) });
    await h.w.store.recoveryRead({ operationId: op(1) });
    assertUnchanged(before, durableSnapshot(h.w), 'recovery flows');
  } finally { await h.close(); }
});

// === B4R-29: recovery is repeatable; nothing is sealed or recorded =========
test('B4R-29: repeated recovery reads are identical and side-effect free', async () => {
  const h = await httpWorld({});
  try {
    await commitOp(h.w, h.w.controller, 1);
    const s5 = await sealViaExpiry(h.w, h.w.controller, 5);
    const appendsBefore = h.w.history.calls.compareAndAppend;
    const opsBefore = JSON.parse(h.w.adapters.d.doc.toString('utf8')).operations.length;
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await h.call('outcome', { operationId: op(1) }, ACTOR2));
    for (const o of outs) assert.deepEqual(o.body, { status: 'committed', operationId: op(1) });
    const pubs = [];
    for (let i = 0; i < 2; i++) pubs.push(await h.call('publication', { operationId: op(1) }, ACTOR2));
    assert.deepEqual(pubs[1].body, pubs[0].body);
    assert.equal(pubs[0].body.publication, 'included');
    const negs = [];
    for (let i = 0; i < 2; i++) negs.push(await h.call('outcome',
      { operationId: op(5), generation: s5.prepared.generation }, ACTOR2));
    for (const n of negs) assert.deepEqual(n.body, { status: 'not-applied',
      operationId: op(5), generation: s5.prepared.generation });
    assert.equal(h.w.history.calls.compareAndAppend, appendsBefore, 'no new seals');
    assert.equal(JSON.parse(h.w.adapters.d.doc.toString('utf8')).operations.length, opsBefore,
      'no new operations');
  } finally { await h.close(); }
});

// === Addendum A (Rev 2): the synchronous final-disclosure boundary =========
// Atlas Systems Review BLOCKING on head d98a7ef4 (comment 6401273769): the
// BLOCK-FIX recovery recheck is itself an await, so a session expiry or
// replacement, or an ordinary-authority revocation, landing DURING that
// final recovery await still serialized on both routes. The amendment
// makes disclosure require a synchronous final predicate — the factory
// option finalDisclosureAuthorize({householdId, actorId, operationId,
// generation?}) -> boolean — invoked in ONE synchronous continuation
// after the last await: predicate FIRST on the retained frozen selectors,
// then the sessionActor re-read, then serialization. Rows A1–A3 are the
// defect-repair rows (they fail against the d98a7ef4 tree). A4 is the
// retained BLOCK-FIX direction — a control, green on both trees. A5–A8
// exercise the new seam, which does not exist at d98a7ef4.

// A world whose HTTP session identity lives in a mutable holder and whose
// recovery policy runs `flip(session)` inside the request's FINAL
// recovery await (authorizeRecovery call 3 for the request: fresh
// decision, controller post-read recheck, HTTP final recheck), while
// still returning its approval — so the flip is invisible to every check
// that has already run. Tests reset policy.calls between requests so each
// request's final await is call 3 again.
async function seamWorld(opts = {}) {
  const session = { current: ACTOR2 };
  const policy = makePolicy((input, n) => {
    if (n === 3 && opts.flip) opts.flip(session);
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const httpOpts = { policy, sessionActor: () => session.current };
  if (opts.finalDisclosure !== undefined) httpOpts.finalDisclosure = opts.finalDisclosure;
  const h = await httpWorld(httpOpts);
  return { h, session };
}

// === B4R-A1: session expiry during the final recovery await ================
test('B4R-A1: session expiry during the final recovery await refuses on both routes', async () => {
  let flipOn = false;
  const { h, session } = await seamWorld({ flip: s => { if (flipOn) s.current = null; } });
  try {
    await commitOp(h.w, h.w.controller, 1);
    // Control: a healthy cross-login request discloses.
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    assert.deepEqual(control.body, { status: 'committed', operationId: op(1) });
    flipOn = true;
    h.policy.calls.length = 0;
    const fdBefore = h.finalDisclosureCalls.length;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503, 'an expired session must not receive the outcome disclosure');
    assert.deepEqual(out.body, { status: 'unavailable' });
    assert.ok(h.finalDisclosureCalls.length > fdBefore,
      'the synchronous final predicate ran before the session re-read refused');
    session.current = ACTOR2; // the next request arrives on a fresh login
    h.policy.calls.length = 0;
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503, 'an expired session must not receive the publication disclosure');
    assert.deepEqual(pub.body, { status: 'unavailable' });
  } finally { await h.close(); }
});

// === B4R-A2: session replacement during the final recovery await ===========
test('B4R-A2: session replacement during the final recovery await refuses on both routes', async () => {
  let flipOn = false;
  const { h, session } = await seamWorld({ flip: s => { if (flipOn) s.current = ACTOR3; } });
  try {
    await commitOp(h.w, h.w.controller, 1);
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    assert.deepEqual(control.body, { status: 'committed', operationId: op(1) });
    flipOn = true;
    h.policy.calls.length = 0;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503, 'a replaced session must not receive the outcome disclosure');
    assert.deepEqual(out.body, { status: 'unavailable' });
    session.current = ACTOR2;
    h.policy.calls.length = 0;
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503, 'a replaced session must not receive the publication disclosure');
    assert.deepEqual(pub.body, { status: 'unavailable' });
  } finally { await h.close(); }
});

// === B4R-A3: ordinary-authority revocation during the final recovery await =
test('B4R-A3: ordinary-authority revocation during the final recovery await refuses on both routes', async () => {
  // The authoritative current state the synchronous predicate consults:
  // ordinary household authority AND the named recovery grant.
  const liveAuth = { ordinary: true, grant: true };
  let flipOn = false;
  const { h } = await seamWorld({
    flip: () => { if (flipOn) liveAuth.ordinary = false; },
    finalDisclosure: () => liveAuth.ordinary && liveAuth.grant,
  });
  try {
    await commitOp(h.w, h.w.controller, 1);
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    assert.deepEqual(control.body, { status: 'committed', operationId: op(1) });
    flipOn = true;
    h.policy.calls.length = 0;
    const fdBefore = h.finalDisclosureCalls.length;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503, 'revoked ordinary authority must not receive the outcome disclosure');
    assert.deepEqual(out.body, { status: 'unavailable' });
    assert.equal(h.finalDisclosureCalls.length, fdBefore + 1,
      'the synchronous final predicate was the refusing check');
    liveAuth.ordinary = true; flipOn = false;
    const controlPub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(controlPub.status, 200);
    assert.equal(controlPub.body.publication, 'included');
    flipOn = true;
    h.policy.calls.length = 0;
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503, 'revoked ordinary authority must not receive the publication disclosure');
    assert.deepEqual(pub.body, { status: 'unavailable' });
  } finally { await h.close(); }
});

// === B4R-A4 (CONTROL): revocation during the final ordinary-authorization ==
// await — the original BLOCK-FIX direction — still refuses, and refuses at
// the async recheck, before the synchronous final predicate is consulted.
// Green on d98a7ef4 and on the repaired tree.
test('B4R-A4 (control): revocation during the final authorization await refuses before the sync predicate', async () => {
  let authorizeCalls = 0, flipAt = Infinity, revoked = false;
  const policy = makePolicy(input => {
    if (revoked) throw new Error('revoked during final authorization await');
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const h = await httpWorld({ policy });
  try {
    await commitOp(h.w, h.w.controller, 1);
    h.w.authState.hooks.authorize = async () => {
      authorizeCalls++;
      if (authorizeCalls >= flipAt) revoked = true;
    };
    authorizeCalls = 0;
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    assert.deepEqual(control.body, { status: 'committed', operationId: op(1) });
    const outcomeCalls = authorizeCalls;
    const fdBefore = h.finalDisclosureCalls.length;
    authorizeCalls = 0; flipAt = outcomeCalls;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503);
    assert.deepEqual(out.body, { status: 'unavailable' });
    assert.equal(h.finalDisclosureCalls.length, fdBefore,
      'the async recheck refused before the synchronous final predicate ran');
    flipAt = Infinity; revoked = false; authorizeCalls = 0; policy.calls.length = 0;
    const controlPub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(controlPub.body.publication, 'included');
    const pubCalls = authorizeCalls;
    const fdBeforePub = h.finalDisclosureCalls.length;
    authorizeCalls = 0; flipAt = pubCalls;
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503);
    assert.deepEqual(pub.body, { status: 'unavailable' });
    assert.equal(h.finalDisclosureCalls.length, fdBeforePub,
      'publication: the async recheck refused before the synchronous final predicate ran');
  } finally { await h.close(); }
});

// === B4R-A5: stale revision witness / captured-true predicate ==============
test('B4R-A5: a witness-validating final predicate refuses after revocation; a captured-true predicate cannot', async () => {
  // The authoritative state the synchronous predicate consults, with a
  // revision witness covering BOTH permissions and the revocation path.
  const authz = { revision: 1, ordinary: true, grant: true };
  const witness = { admittedRevision: null };
  const mkPolicy = state => makePolicy((input, n) => {
    if (n === 1) witness.admittedRevision = authz.revision;
    if (n === 3 && state.flipOn) { authz.revision = 2; authz.grant = false; }
    return { householdId: input.householdId, actorId: input.actorId, operationId: input.operationId };
  });
  const state = { flipOn: false };
  const h = await httpWorld({ policy: mkPolicy(state),
    finalDisclosure: () => authz.ordinary && authz.grant && authz.revision === witness.admittedRevision });
  try {
    await commitOp(h.w, h.w.controller, 1);
    const control = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(control.status, 200);
    // The predicate was consulted with the retained frozen selectors of
    // the request — no generation is fabricated for an operation-only call.
    assert.deepEqual(h.finalDisclosureCalls.at(-1),
      { householdId, actorId: ACTOR2, operationId: op(1) });
    state.flipOn = true; h.policy.calls.length = 0;
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503, 'a stale witness must refuse after revocation');
    assert.deepEqual(out.body, { status: 'unavailable' });
  } finally { await h.close(); }
  // Present-generation semantics: the retained selector carries the exact
  // supplied generation, and the negative proof discloses when healthy.
  const h2 = await httpWorld({});
  try {
    const s5 = await sealViaExpiry(h2.w, h2.w.controller, 5);
    const neg = await h2.call('outcome',
      { operationId: op(5), generation: s5.prepared.generation }, ACTOR2);
    assert.equal(neg.status, 200);
    assert.deepEqual(neg.body, { status: 'not-applied', operationId: op(5),
      generation: s5.prepared.generation });
    assert.deepEqual(h2.finalDisclosureCalls.at(-1),
      { householdId, actorId: ACTOR2, operationId: op(5), generation: s5.prepared.generation });
  } finally { await h2.close(); }
  // Control demonstrating Addendum A §5: in the SAME revoked state, a
  // captured-true predicate (it returns the admission-time answer without
  // consulting current state) discloses — the seam trusts the predicate,
  // which is exactly why the contract forbids captured-true predicates.
  authz.revision = 1; authz.ordinary = true; authz.grant = true;
  const state2 = { flipOn: true };
  const h3 = await httpWorld({ policy: mkPolicy(state2), finalDisclosure: () => true });
  try {
    await commitOp(h3.w, h3.w.controller, 1);
    const out = await h3.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 200, 'a captured-true predicate discloses despite revocation (why §5 forbids it)');
    assert.deepEqual(out.body, { status: 'committed', operationId: op(1) });
    assert.equal(authz.grant, false, 'the revocation really landed during the request');
  } finally { await h3.close(); }
});

// === B4R-A6: predicate throws / thenable / malformed =======================
test('B4R-A6: a throwing, thenable, or malformed final predicate refuses with zero disclosure', async () => {
  const variants = [
    ['throws', () => { throw new Error('predicate fault'); }],
    ['returns a promise', () => Promise.resolve(true)],
    ['returns a thenable', () => ({ then() {} })],
    ['returns 1', () => 1],
    ['returns "true"', () => 'true'],
    ['returns null', () => null],
    ['returns undefined', () => undefined],
  ];
  for (const [label, impl] of variants) {
    const h = await httpWorld({ finalDisclosure: impl });
    try {
      await commitOp(h.w, h.w.controller, 1);
      const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, label + ' (outcome)');
      assert.deepEqual(out.body, { status: 'unavailable' }, label + ' (outcome)');
      const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503, label + ' (publication)');
      assert.deepEqual(pub.body, { status: 'unavailable' }, label + ' (publication)');
      assert.equal(h.finalDisclosureCalls.length, 2, label + ': exactly one predicate call per disclosure');
    } finally { await h.close(); }
  }
});

// === B4R-A7: missing capability fails closed; incumbents unchanged =========
test('B4R-A7: missing final-disclosure capability refuses recovery; incumbents unchanged', async () => {
  const h = await httpWorld({ finalDisclosure: null });
  try {
    await commitOp(h.w, h.w.controller, 1);
    const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 503);
    assert.deepEqual(out.body, { status: 'unavailable' });
    const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub.status, 503);
    assert.deepEqual(pub.body, { status: 'unavailable' });
    // Incumbent same-actor surfaces never needed the capability.
    const outA = await h.call('outcome', { operationId: op(1) }, ACTOR);
    assert.equal(outA.status, 200);
    assert.equal(outA.body.status, 'committed');
    assert.equal(outA.body.revision, 1);
    const pubA = await h.call('publication', { operationId: op(1) }, ACTOR);
    assert.equal(pubA.status, 200);
    assert.equal(pubA.body.publication, 'included');
  } finally { await h.close(); }
  // A recovery negative proof is a disclosure too: it refuses as well,
  // while the same-actor negative contract is untouched.
  const h2 = await httpWorld({ finalDisclosure: null });
  try {
    const s5 = await sealViaExpiry(h2.w, h2.w.controller, 5);
    const neg = await h2.call('outcome',
      { operationId: op(5), generation: s5.prepared.generation }, ACTOR2);
    assert.equal(neg.status, 503);
    assert.deepEqual(neg.body, { status: 'unavailable' });
    const negA = await h2.call('outcome',
      { operationId: op(5), generation: s5.prepared.generation }, ACTOR);
    assert.equal(negA.status, 200);
    assert.deepEqual(negA.body, { status: 'not-applied', operationId: op(5),
      generation: s5.prepared.generation });
  } finally { await h2.close(); }
  // A non-function capability value is a construction error.
  const express = require('express');
  const w = await makeWorld({});
  assert.throws(() => mountSettlementHttp(express(), req => null,
    { householdId, origin: 'http://synthetic.local', authorize: w.authorize,
      acquire: w.syntheticAcquire, contextReader: w.contextReader,
      readBase: async () => clone(w.baseFixture), now: () => NOW0,
      commitAdmitted: w.commitAdmitted, readDocument: w.readDocument,
      readPin: w.readPin, store: w.wrappedStore, finalDisclosureAuthorize: 'yes' }), TypeError);
  // Where the recovery branch itself is absent, the capability is never
  // consulted and behaviour is the shipped unknown.
  const h3 = await httpWorld({ httpPolicy: false });
  try {
    await commitOp(h3.w, h3.w.controller, 1);
    const out = await h3.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { status: 'unknown', operationId: op(1) });
    assert.equal(h3.finalDisclosureCalls.length, 0);
  } finally { await h3.close(); }
});

// === B4R-A8: concurrent requests keep request-local final predicates =======
test('B4R-A8: concurrent recovery disclosures keep request-local final predicates', async () => {
  const h = await httpWorld({ finalDisclosure: sel => sel.operationId !== op(2) });
  try {
    await commitOp(h.w, h.w.controller, 1);            // op1 recorded by A
    await commitOp(h.w, h.w.controller, 2, h.w.ctxC);  // op2 recorded by C
    const [o1, o2] = await Promise.all([
      h.call('outcome', { operationId: op(1) }, ACTOR2),
      h.call('outcome', { operationId: op(2) }, ACTOR2),
    ]);
    assert.equal(o1.status, 200);
    assert.deepEqual(o1.body, { status: 'committed', operationId: op(1) });
    assert.equal(o2.status, 503, 'the request whose grant the predicate refuses must refuse');
    assert.deepEqual(o2.body, { status: 'unavailable' });
    // Each evaluation carried its own request's retained selectors.
    assert.deepEqual(h.finalDisclosureCalls.map(c => c.operationId).sort(), [op(1), op(2)].sort());
    // No residue leaks into later requests either way.
    const again = await h.call('outcome', { operationId: op(1) }, ACTOR2);
    assert.equal(again.status, 200);
    const pub2 = await h.call('publication', { operationId: op(2) }, ACTOR2);
    assert.equal(pub2.status, 503);
    const pub1 = await h.call('publication', { operationId: op(1) }, ACTOR2);
    assert.equal(pub1.status, 200);
    assert.equal(pub1.body.publication, 'included');
  } finally { await h.close(); }
});

// === Provisional-BLOCK repair rows (Atlas ts 1792954819, on head c6626dfa) =
// Atlas's source-seam probes confirmed the named recovery ordering is
// repaired but found two regressions in the repair itself:
// (1) the helper awaited the (for incumbent paths, no-op) recovery gate
//     AFTER its final session check, reopening a post-check expiry window
//     on incumbent same-actor/unconfigured paths, which get no final
//     session re-read — the shipped incumbent boundary is check-then-
//     serialize in one synchronous continuation;
// (2) a native rejected Promise returned by the final predicate was
//     refused (503) but its rejection was left unhandled.

// === B4R-A6b: rejected-promise verdict — refused, rejection handled ========
test('B4R-A6b: a rejected-promise final verdict refuses with no unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = reason => { seen.push(String(reason)); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = await httpWorld({
      finalDisclosure: () => Promise.reject(new Error('predicate verdict rejected')),
    });
    try {
      await commitOp(h.w, h.w.controller, 1);
      const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503);
      assert.deepEqual(out.body, { status: 'unavailable' });
      const pub = await h.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503);
      assert.deepEqual(pub.body, { status: 'unavailable' });
    } finally { await h.close(); }
    // The arbitrary-thenable case under the same listener: refused, and
    // its `then` is never invoked (no assimilation).
    let thenCalled = false;
    const h2 = await httpWorld({
      finalDisclosure: () => ({ then() { thenCalled = true; } }),
    });
    try {
      await commitOp(h2.w, h2.w.controller, 1);
      const out = await h2.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503);
      assert.deepEqual(out.body, { status: 'unavailable' });
      assert.equal(thenCalled, false, 'the seam must not invoke an arbitrary thenable');
    } finally { await h2.close(); }
    // Give any unhandled rejection its chance to fire.
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(seen, [], 'no unhandled rejection may escape a refused verdict');
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

// === B4R-A10: incumbent paths keep the shipped disclosure boundary =========
test('B4R-A10: incumbent paths serialize in the same continuation as the final session check', async () => {
  // A fully configured world, but the requests below are the RECORDED
  // actor's own (incumbent) ones: no recovery proof is in play, the gate
  // stays empty, and the shipped boundary — final session check, then
  // serialize, with no await between — must hold exactly. The session
  // double arms an expiry microtask at the helper's final check (its
  // second read of the request): if any await intervenes before
  // serialization, the expiry lands first and the res.json wrapper
  // observes serialization against an expired session.
  const w = await makeWorld({});
  await w.bootstrap();
  await commitOp(w, w.controller, 1);
  const express = require('express');
  const app = express();
  const state = { calls: 0, expired: false, serializedExpired: null };
  const sessionActor = () => {
    state.calls++;
    if (state.calls === 2) queueMicrotask(() => { state.expired = true; });
    return state.expired ? null : ACTOR;
  };
  app.use((req, res, next) => {
    const orig = res.json.bind(res);
    res.json = body => { state.serializedExpired = state.expired; return orig(body); };
    next();
  });
  mountSettlementHttp(app, sessionActor, { householdId, origin: 'http://synthetic.local',
    authorize: w.authorize, acquire: w.syntheticAcquire, contextReader: w.contextReader,
    readBase: async () => clone(w.baseFixture), now: () => w.clock.t,
    commitAdmitted: w.commitAdmitted, readDocument: w.readDocument, readPin: w.readPin,
    store: w.wrappedStore, registerRecovery: () => {},
    authorizeRecovery: w.policy.fn, finalDisclosureAuthorize: () => true });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;
  const call = async (route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/settlement/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://synthetic.local',
        'X-Atlas-Settlement': 'same-origin', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const out = await call('outcome', { operationId: op(1) });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'committed');
    assert.equal(out.body.revision, 1);
    assert.equal(state.serializedExpired, false,
      'outcome serialized after the session expired: an await intervened on the incumbent path');
    await new Promise(res => setTimeout(res, 10));
    assert.equal(state.expired, true, 'the armed expiry really landed during the outcome request');
    state.calls = 0; state.expired = false; state.serializedExpired = null;
    const pub = await call('publication', { operationId: op(1) });
    assert.equal(pub.status, 200);
    assert.equal(pub.body.publication, 'included');
    assert.equal(state.serializedExpired, false,
      'publication serialized after the session expired: an await intervened on the incumbent path');
    await new Promise(res => setTimeout(res, 10));
    assert.equal(state.expired, true, 'the armed expiry really landed during the publication request');
  } finally { await new Promise(res => server.close(res)); }
});

// === Residual correction rows (Atlas review of feb989bb, ts 1792957095) ====
// The feb989bb refusal handler recognized verdict Promises with
// `instanceof Promise` and called the value's own `.catch`: a
// foreign-realm native Promise bypassed recognition, and a native
// Promise with a shadowed `.catch`/`.then` property had that supplied
// method invoked — both still left unhandled rejections. The correction
// recognizes genuine native Promises across realms (util.types.isPromise)
// and attaches nonthrowing handlers through a CAPTURED
// Promise.prototype.then via Reflect.apply, never reading the value's
// own properties; arbitrary thenables stay completely untouched.

// === B4R-A6c: foreign-realm / shadowed rejected promises are contained =====
test('B4R-A6c: foreign-realm and shadowed rejected promises refuse contained, supplied methods untouched', async () => {
  const vm = require('node:vm');
  const seen = [];
  const onUnhandled = reason => { seen.push(String(reason)); };
  process.on('unhandledRejection', onUnhandled);
  try {
    // (1) Foreign-realm native rejected Promise, both routes.
    const h1 = await httpWorld({
      finalDisclosure: () => vm.runInNewContext('Promise.reject(new Error("foreign realm rejection"))'),
    });
    try {
      await commitOp(h1.w, h1.w.controller, 1);
      const out = await h1.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, 'foreign-realm rejected verdict (outcome)');
      assert.deepEqual(out.body, { status: 'unavailable' });
      const pub = await h1.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503, 'foreign-realm rejected verdict (publication)');
      assert.deepEqual(pub.body, { status: 'unavailable' });
    } finally { await h1.close(); }
    // (2) Native rejected Promise with a shadowed `.catch`, both routes:
    // the supplied method must never be invoked.
    let catchInvoked = false;
    const h2 = await httpWorld({
      finalDisclosure: () => {
        const p = Promise.reject(new Error('shadowed catch rejection'));
        p.catch = () => { catchInvoked = true; };
        return p;
      },
    });
    try {
      await commitOp(h2.w, h2.w.controller, 1);
      const out = await h2.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, 'shadowed-catch rejected verdict (outcome)');
      assert.deepEqual(out.body, { status: 'unavailable' });
      const pub = await h2.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503, 'shadowed-catch rejected verdict (publication)');
      assert.deepEqual(pub.body, { status: 'unavailable' });
      assert.equal(catchInvoked, false, 'the supplied .catch must never be invoked');
    } finally { await h2.close(); }
    // (3) Native rejected Promise with a shadowed `.then`, both routes.
    let thenInvoked = false;
    const h3 = await httpWorld({
      finalDisclosure: () => {
        const p = Promise.reject(new Error('shadowed then rejection'));
        p.then = () => { thenInvoked = true; };
        return p;
      },
    });
    try {
      await commitOp(h3.w, h3.w.controller, 1);
      const out = await h3.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, 'shadowed-then rejected verdict (outcome)');
      assert.deepEqual(out.body, { status: 'unavailable' });
      const pub = await h3.call('publication', { operationId: op(1) }, ACTOR2);
      assert.equal(pub.status, 503, 'shadowed-then rejected verdict (publication)');
      assert.deepEqual(pub.body, { status: 'unavailable' });
      assert.equal(thenInvoked, false, 'the supplied .then must never be invoked');
    } finally { await h3.close(); }
    // Give any unhandled rejection its chance to fire.
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(seen, [], 'no unhandled rejection may escape any refused verdict');
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});

// === B4R-A6d (controls): resolved verdict refused; getter-thenable untouched
// Both limbs already hold at feb989bb (the instanceof check never touches
// non-Promises); they pin the correction against over-eager recognition.
test('B4R-A6d (controls): a resolved Promise still refuses; a throwing-then-getter thenable refuses untouched', async () => {
  const seen = [];
  const onUnhandled = reason => { seen.push(String(reason)); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = await httpWorld({ finalDisclosure: () => Promise.resolve(true) });
    try {
      await commitOp(h.w, h.w.controller, 1);
      const out = await h.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, 'a resolved Promise verdict is still not boolean true');
      assert.deepEqual(out.body, { status: 'unavailable' });
    } finally { await h.close(); }
    let getterAccessed = false;
    const evil = {};
    Object.defineProperty(evil, 'then', { get() { getterAccessed = true; throw new Error('getter trap'); } });
    const h2 = await httpWorld({ finalDisclosure: () => evil });
    try {
      await commitOp(h2.w, h2.w.controller, 1);
      const out = await h2.call('outcome', { operationId: op(1) }, ACTOR2);
      assert.equal(out.status, 503, 'a non-Promise thenable verdict refuses');
      assert.deepEqual(out.body, { status: 'unavailable' });
      assert.equal(getterAccessed, false, 'the seam must not access any property of a thenable verdict');
    } finally { await h2.close(); }
    await new Promise(res => setTimeout(res, 50));
    assert.deepEqual(seen, [], 'no unhandled rejection in the control limbs');
  } finally { process.removeListener('unhandledRejection', onUnhandled); }
});
