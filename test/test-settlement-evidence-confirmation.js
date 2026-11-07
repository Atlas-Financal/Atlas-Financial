'use strict';

// ATLAS-080: standalone, strictly synthetic caller-boundary proof. The real
// contract/store/POSIX adapter write only into disposable private OS temp
// directories. Authorization, identity mappings, independent pin and backups
// are deterministic fixtures; none is a production identity implementation.
// Registered through the shared manifest; no production controller consumer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const C = require('../scripts/planned-obligation-settlement-contract');
const S = require('../scripts/settlement-evidence-store');
const A = require('../scripts/settlement-evidence-file-adapter');
const L = require('../scripts/settlement-evidence-loader');
const { createSettlementEvidenceConfirmation } = require('../scripts/settlement-evidence-confirmation');

const householdId = 'household-' + 'a'.repeat(32);
const actorId = 'session-' + 'b'.repeat(64);
const otherActor = 'session-' + 'c'.repeat(64);
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const tx = n => 'tx-' + n.toString(16).padStart(32, '0');
const selection = { transaction: 'selection-' + '1'.repeat(32), commitment: 'choice-' + '2'.repeat(32) };
const context = { ticket: 'synthetic-session-a' };
const otherContext = { ticket: 'synthetic-session-b' };
const T0 = Date.parse('2026-10-20T12:00:00Z');
const clone = x => JSON.parse(JSON.stringify(x));

// Terminal-proof tests use the existing labelled durable-memory fixture;
// no file adapter, provider, real household authority or storage trial.
async function terminalWorld(t) {
  let clock = Date.now();
  const w = await require('./test-settlement-evidence-http').startWorld(true, { now: () => clock }); t.after(w.close);
  const R = require('../scripts/settlement-evidence-resolver');
  const resolver = R.createSettlementEvidenceResolver({ householdId, acquire: () => w.syntheticAcquire(w.contextReader) });
  const ctx = { actorId };
  const create = extra => createSettlementEvidenceConfirmation({ householdId, authorize: w.dependency.authorize,
    resolveSelection: resolver.resolveSelection, resolvePairedSelection: resolver.resolvePairedSelection,
    store: w.store, commitAdmitted: w.dependency.commitAdmitted, now: () => clock, ...extra });
  const controller = create();
  const selection = await w.selection();
  return { w, ctx, create, controller, resolver, advance: () => { clock += C.TTL_MS; }, rewind: () => { clock -= C.TTL_MS; },
    prepare: (n = 1) => controller.prepare(ctx, { operationId: op(n), selection, assignedCents: 2500 }) };
}
test('probe mismatch retired generation excludes a suspended old successful probe', async t => {
  const a = await terminalWorld(t), { w, ctx, controller } = a;
  const p = await a.prepare(); const prepare = w.store.prepare;
  const seen = deferred(), gate = deferred(); let probes = 0, competing;
  w.store.prepare = async input => {
    if (++probes === 1) { const result = await prepare(input); seen.resolve(); await gate.promise; return result; }
    competing = await require('./test-settlement-evidence-http').appendCompetingRecord(w, input, {}, prepare);
    return prepare(input);
  };
  const input = { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true };
  const paused = controller.confirm(ctx, input); await seen.promise;
  try {
    const proof = await controller.confirm(ctx, input);
    assert.equal(proof.status, 'not-applied'); gate.resolve();
    assert.notEqual((await paused).status, 'committed');
    assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 1); assert.ok(w.durable.doc.equals(competing.doc));
    assert.equal((await a.prepare()).status, 'unavailable', 'retired operation is not recycled');
  } finally { gate.resolve(); }
});
test('probe mismatch final authorization wait cannot overtake another in-flight or uncertain writer', async t => {
  for (const mode of ['in-flight', 'uncertain']) {
    const a = await terminalWorld(t), first = await a.prepare(1);
    const control = require('./test-settlement-evidence-http').armProbeCompetition(a.w, first.operationId);
    const seen = deferred(), gate = deferred(), writing = deferred(), finish = deferred(); let hold = true;
    a.w.hooks.authorize = async () => {
      if (control.successfulProbe && hold) { hold = false; seen.resolve(); await gate.promise; }
    };
    const refused = a.controller.confirm(a.ctx, { operationId: first.operationId, previewToken: first.previewToken,
      generation: first.generation, confirmed: true });
    await seen.promise;
    try {
      const next = await a.prepare(2); assert.equal(next.status, 'prepared');
      a.w.hooks.admission = async () => { writing.resolve(); await finish.promise;
        if (mode === 'uncertain') throw new Error('synthetic ambiguous admission transport'); };
      const competing = a.controller.confirm(a.ctx, { operationId: next.operationId, previewToken: next.previewToken,
        generation: next.generation, confirmed: true });
      await writing.promise;
      if (mode === 'uncertain') { finish.resolve(); assert.equal((await competing).status, 'unknown'); }
      gate.resolve(); assert.equal((await refused).status, 'unknown', 'no proof may cross another write exclusion');
      assert.equal(a.w.calls.journal, 1, 'only the explicit initial synthetic competitor has written so far');
      if (mode === 'in-flight') { finish.resolve(); assert.equal((await competing).status, 'committed'); }
      else assert.deepEqual(await a.prepare(3), { status: 'unavailable', reason: 'outcome-unresolved' });
      assert.equal(a.w.calls.commit, 1);
    } finally { gate.resolve(); finish.resolve(); }
  }
});
test('probe mismatch postauthorization failure and malformed successful probes never emit proof', async t => {
  for (const mode of ['authorization', 'malformed']) {
    const a = await terminalWorld(t), p = await a.prepare(), prepare = a.w.store.prepare;
    let probed = false;
    a.w.store.prepare = async input => {
      await require('./test-settlement-evidence-http').appendCompetingRecord(a.w, input, {}, prepare);
      const result = await prepare(input); probed = true;
      return mode === 'malformed' ? { ...result, confirmationDigest: '0'.repeat(64) } : result;
    };
    if (mode === 'authorization') a.w.hooks.authorize = async () => { if (probed) a.w.authorized = false; };
    const result = await a.controller.confirm(a.ctx, { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true });
    assert.notEqual(result.status, 'not-applied'); assert.notEqual(result.status, 'committed');
    assert.equal(a.w.calls.commit, 0); assert.equal(a.w.calls.journal, 1);
  }
});
test('probe mismatch terminal capacity exhaustion stays unknown with no refused write', { timeout: 30000 }, async t => {
  const a = await terminalWorld(t);
  for (let n = 1; n <= 999; n++) {
    const p = await a.prepare(n); a.advance();
    assert.equal((await a.controller.confirm(a.ctx, { operationId: p.operationId, previewToken: p.previewToken,
      generation: p.generation, confirmed: true })).status, 'not-applied');
  }
  const target = await a.prepare(2000), last = await a.prepare(2001);
  const original = a.w.acquisition.packet.observationAsOf;
  a.w.acquisition.packet.observationAsOf = '2026-10-06';
  assert.equal((await a.controller.confirm(a.ctx, { operationId: last.operationId, previewToken: last.previewToken,
    generation: last.generation, confirmed: true })).status, 'not-applied');
  a.w.acquisition.packet.observationAsOf = original;
  const control = require('./test-settlement-evidence-http').armProbeCompetition(a.w, target.operationId,
    { competingOperationId: op(9000) });
  const result = await a.controller.confirm(a.ctx, { operationId: target.operationId, previewToken: target.previewToken,
    generation: target.generation, confirmed: true });
  assert.equal(control.successfulProbe, true); assert.equal(result.status, 'unknown');
  assert.equal(a.w.calls.commit, 0); assert.equal(a.w.calls.journal, 1);
});
test('terminal proof controller retirement prevents a suspended confirm from later admitting', async t => {
  const a = await terminalWorld(t); const { w, ctx, resolver } = a;
  let calls = 0; const gate = deferred(), seen = deferred();
  const controller = a.create({ resolvePairedSelection: async input => {
    const value = await resolver.resolvePairedSelection(input);
    if (++calls === 2) { seen.resolve(); await gate.promise; }
    return value;
  } });
  const p = await controller.prepare(ctx, { operationId: op(1), selection: await w.selection(), assignedCents: 2500 });
  assert.match(p.generation, /^generation-[a-f0-9]{32}$/);
  const input = { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true };
  const paused = controller.confirm(ctx, input); await seen.promise;
  a.advance(); const ack = await controller.confirm(ctx, input);
  assert.deepEqual(ack, { status: 'not-applied', operationId: p.operationId, previewToken: p.previewToken, generation: p.generation });
  a.rewind(); gate.resolve();
  assert.notEqual((await paused).status, 'committed'); assert.equal(w.calls.commit, 0); assert.equal(w.calls.journal, 0);
  assert.equal((await controller.prepare(ctx, { operationId: op(1), selection: await w.selection(), assignedCents: 2500 })).status, 'unavailable');
});
test('terminal proof controller never upgrades ambiguous store conflicts or uncertainty into negative proof', async t => {
  for (const result of [{ status: 'conflict' }, { status: 'rejected', reason: 'recovery-required' }, { status: 'unknown' },
    { status: 'rejected', reason: 'admission-refused', untrusted: true },
    { status: 'rejected', reason: 'preview-expired', untrusted: true }]) {
    const a = await terminalWorld(t);
    const controller = a.create({ commitAdmitted: async () => result });
    const p = await controller.prepare(a.ctx, { operationId: op(1), selection: await a.w.selection(), assignedCents: 2500 });
    const r = await controller.confirm(a.ctx, { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true });
    assert.notEqual(r.status, 'not-applied');
  }
});
test('terminal proof controller requires exact token/generation and fresh authorization', async t => {
  const a = await terminalWorld(t); const p = await a.prepare();
  const input = { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true };
  a.advance();
  assert.notEqual((await a.controller.confirm(a.ctx, { ...input, generation: 'generation-' + 'f'.repeat(32) })).status, 'not-applied');
  assert.notEqual((await a.controller.confirm(a.ctx, { ...input, previewToken: 'f'.repeat(64) })).status, 'not-applied');
  a.w.authorized = false;
  assert.notEqual((await a.controller.confirm(a.ctx, input)).status, 'not-applied');
  assert.equal(a.w.calls.commit, 0); assert.equal(a.w.calls.journal, 0);
});
// New withdrawal controller tests use the existing durable-MEMORY HTTP
// fixture, never a file adapter, provider or production authority.
async function withdrawalWorld(t, extra = {}) {
  const w = await require('./test-settlement-evidence-http').startWorld(true,
    extra.now ? { now: extra.now } : {}); t.after(w.close);
  await w.confirm(await w.prepare());
  const ctx = { actorId: JSON.parse(w.durable.doc).operations[0].actorId };
  const resolver = require('../scripts/settlement-evidence-resolver').createSettlementEvidenceResolver({
    householdId, acquire: () => w.syntheticAcquire(w.contextReader) });
  const reader = L.createWithdrawalTargetReader({ householdId, contextReader: w.contextReader,
    readPin: w.dependency.readPin, readDocument: w.dependency.readDocument });
  const controller = createSettlementEvidenceConfirmation({ householdId,
    authorize: w.dependency.authorize, resolveSelection: resolver.resolveSelection,
    resolvePairedSelection: resolver.resolvePairedSelection, commitAdmitted: w.dependency.commitAdmitted,
    store: w.store, now: Date.now, withdrawalReader: reader.acquire, ...extra });
  return { w, ctx, controller, reader };
}
test('withdrawal controller rejects a later store.prepare stamp instead of rebasing an acquired target', async t => {
  const { w, ctx, controller } = await withdrawalWorld(t);
  const c = await controller.assignments(ctx, {}); assert.equal(c.status, 'available');
  const original = w.store.prepare;
  w.store.prepare = async input => {
    const doc = JSON.parse(w.durable.doc), first = doc.operations[0];
    const other = await original({ actorId: ctx.actorId, operationId: op(30),
      command: { ...first.command, goalId: 'commitment:sibling', assignedCents: 1 } });
    await w.store.commitWithoutRecovery({ actorId: ctx.actorId, preview: other.preview, confirmationDigest: other.confirmationDigest });
    return original(input);
  };
  const result = await controller.prepareWithdrawal(ctx, { operationId: op(10), assignmentHandle: c.assignments[0].handle });
  assert.deepEqual(result, { status: 'rejected', reason: 'store-conflict' });
  assert.equal(JSON.parse(w.durable.doc).operations.length, 2, 'only explicit competing sibling wrote');
});
test('withdrawal controller shares uncertainty with links and never clears another actor operation', async t => {
  const { w, ctx, controller } = await withdrawalWorld(t);
  const c = await controller.assignments(ctx, {});
  const p = await controller.prepareWithdrawal(ctx, { operationId: op(10), assignmentHandle: c.assignments[0].handle });
  w.hooks.admission = async () => { throw new Error('synthetic ambiguous commit transport'); };
  const confirm = { operationId: p.operationId, previewToken: p.previewToken, confirmed: true };
  assert.equal((await controller.confirm(ctx, confirm)).status, 'unknown');
  const other = { actorId: otherActor };
  assert.equal((await controller.outcome(other, { operationId: p.operationId })).status, 'unknown');
  const choices = await w.selection();
  assert.deepEqual(await controller.prepare(ctx, { operationId: op(11), selection: choices, assignedCents: 1 }),
    { status: 'unavailable', reason: 'outcome-unresolved' });
  assert.deepEqual(await controller.prepareWithdrawal(other, { operationId: op(12), assignmentHandle: c.assignments[0].handle }),
    { status: 'unavailable', reason: 'outcome-unresolved' });
  assert.equal(w.calls.commit, 2, 'one attempted withdrawal; neither outcome nor blocked work retries it');
});
test('withdrawal suspended confirm cannot write after exact terminal retirement despite catalogue replacement', async t => {
  let acquire, calls = 0, clock = Date.now();
  const seen = deferred(), gate = deferred();
  const { w, ctx, controller, reader } = await withdrawalWorld(t, { now: () => clock,
    withdrawalReader: async () => {
      const result = await acquire();
      if (++calls === 3) { seen.resolve(); await gate.promise; }
      return result;
    } });
  acquire = reader.acquire;
  const c = await controller.assignments(ctx, {});
  const p = await controller.prepareWithdrawal(ctx, { operationId: op(10), assignmentHandle: c.assignments[0].handle });
  const input = { operationId: p.operationId, previewToken: p.previewToken, generation: p.generation, confirmed: true };
  const paused = controller.confirm(ctx, input); await seen.promise;
  try {
    const replacement = await controller.assignments(ctx, {});
    assert.notEqual(replacement.assignments[0].handle, c.assignments[0].handle);
    clock = p.expiresAt;
    assert.deepEqual(await controller.confirm(ctx, input), { status: 'not-applied', operationId: p.operationId,
      previewToken: p.previewToken, generation: p.generation });
    clock = Date.now(); gate.resolve();
    assert.notEqual((await paused).status, 'committed');
    assert.equal(w.calls.commit, 1); assert.equal(w.calls.journal, 1, 'only original assignment exists');
  } finally { gate.resolve(); }
});
test('withdrawal controller refuses malformed or async witness envelopes without a commit', async t => {
  for (const witness of [null, async () => true, 'true']) {
    const { w, ctx, controller } = await withdrawalWorld(t, { withdrawalReader: async () => ({
      status: 'qualified', stamp: { revision: 1, documentDigest: 'a'.repeat(64) },
      contextStamp: { domain: 'synthetic-domain', contextRevision: 1 }, targets: [], witness }) });
    assert.equal((await controller.assignments(ctx, {})).status, 'unavailable');
    assert.equal(w.calls.commit, 1);
  }
});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function resolved() {
  return {
    matchCount: 1,
    identity: { householdId, source: 'lunchmoney', providerAccountId: 'synthetic-provider-account', transactionId: 'synthetic-provider-transaction' },
    txRef: tx(1), selectionBinding: 'synthetic-private-selection-v1',
    goalId: 'commitment:synthetic-trip', goalBinding: 'synthetic-plan-goal-v1',
    asOf: '2026-10-20',
    evidence: { accountId: 'synthetic-cash', currency: 'cad', direction: 'debit', date: '2026-10-19', cents: 6000, posted: true },
  };
}
const request = (n = 1, cents = 2500) => ({ operationId: op(n), selection: clone(selection), assignedCents: cents });

// Fixture-consistency observation (Rule D B1): the controller's resolver
// contract requires one provider identity to retain a stable txRef, so a
// fixture cycle only represents a distinct provider transaction when its
// identity.transactionId, classifier transaction id, txRef and selection
// binding move together. fixtureTriple observes the live fixture state;
// assertDistinctTriples fails if the cycles merely re-key one transaction.
function fixtureTriple(w) {
  return { transactionId: w.source.identity.transactionId, classifierId: w.classification.tx.id,
    txRef: w.source.txRef, selectionBinding: w.source.selectionBinding };
}
function assertDistinctTriples(triples, count) {
  assert.equal(new Set(triples.map(x => x.transactionId)).size, count, 'each cycle must be a distinct provider transaction');
  assert.equal(new Set(triples.map(x => x.txRef)).size, count, 'each cycle must carry a distinct txRef');
  assert.equal(new Set(triples.map(x => x.selectionBinding)).size, count, 'each cycle must carry its own selection binding');
  const txRefByIdentity = new Map(), identityByTxRef = new Map();
  for (const x of triples) {
    assert.equal(x.classifierId, x.transactionId, 'classifier transaction id must match the provider identity');
    if (txRefByIdentity.has(x.transactionId)) assert.equal(txRefByIdentity.get(x.transactionId), x.txRef, 'one provider identity must retain a stable txRef');
    if (identityByTxRef.has(x.txRef)) assert.equal(identityByTxRef.get(x.txRef), x.transactionId, 'one txRef must not name two provider transactions');
    txRefByIdentity.set(x.transactionId, x.txRef); identityByTxRef.set(x.txRef, x.transactionId);
  }
  assert.equal(txRefByIdentity.size, count, 'provider identities and txRefs must be in one-to-one correspondence');
}

// Consistent distinct-transaction generation (Rule D B1): transaction n
// is a genuinely different provider transaction end-to-end — a new
// provider identity.transactionId, the classifier fixture built for that
// same transaction id, its own selection binding, and tx(n) are minted
// together, so no provider identity ever carries two txRefs.
function distinctTransaction(n) {
  const transactionId = 'synthetic-provider-transaction-' + n;
  const source = resolved();
  source.identity = { ...source.identity, transactionId };
  source.txRef = tx(n);
  source.selectionBinding = 'synthetic-private-selection-v' + n;
  return { source, classification: classificationFixture('spend-groceries', transactionId) };
}

// Rule E classification fixtures: a synthetic provider transaction, plan and
// current-period packet whose verdicts come from the REAL Forecast
// classifier, invoked by the fixture resolver through the controller-owned
// classify closure (never a copied label set). Amounts are dollars, the
// classifier's convention. The default is E2: a Groceries spend with
// merchant identity against a plan whose categories match it.
function classificationFixture(kind = 'spend-groceries', transactionId = 'synthetic-provider-transaction') {
  const plan = { budget: { categories: [
    { id: 'groceries', label: 'Groceries' },
    { id: 'restaurants', label: 'Restaurants' },
    { id: 'insurance', label: 'Home Insurance' },
  ], excluded: [] } };
  const packet = { representedActuals: [], transactions: [] };
  const base = { id: transactionId, date: '2026-10-19' };
  const txs = {
    'spend-groceries': { ...base, amount: 60, categoryLabel: 'Groceries', merchantKnown: true },
    'spend-restaurants': { ...base, amount: 60, categoryLabel: 'Restaurants', merchantKnown: true },
    'transfer': { ...base, amount: 500, categoryLabel: 'Credit Card Payment' },
    'card-payment-td': { ...base, amount: 500, categoryLabel: 'Groceries', merchantKnown: true, tfrReference: 'AB123', tfrDirection: 'TO', tdCardPaymentIdentity: true },
    'internal-movement': { ...base, amount: -200, atlasAccountId: 'chequing-a', accountRole: 'household-cash', tfrReference: 'AB123', tfrDirection: 'FR' },
    'unclassified': { ...base, amount: 25, categoryLabel: 'Lottery Winnings' },
    'cancelled-service': { ...base, amount: 30, payee: 'OLD GYM' },
    'refund': { ...base, amount: 40, categoryLabel: 'Refund' },
    'bill-represented': { ...base, amount: 120, categoryLabel: 'Groceries', merchantKnown: true },
    'bill-label': { ...base, amount: 120, categoryLabel: 'Insurance' },
    'bill-bills-only': { ...base, amount: 90, categoryLabel: 'Home Insurance' },
    'income': { ...base, amount: 900, isIncome: true },
  };
  const opts = { currentPeriodActuals: packet };
  if (kind === 'internal-movement') {
    packet.transactions = [txs[kind], { id: 'synthetic-provider-counterpart', amount: 200,
      atlasAccountId: 'chequing-b', accountRole: 'household-cash', tfrReference: 'AB123', tfrDirection: 'TO', date: '2026-10-19' }];
  }
  if (kind === 'bill-represented') packet.representedActuals = [{ transactionId: base.id }];
  if (kind === 'cancelled-service') {
    plan.cancelledServices = [{ id: 'synthetic-cancelled-service', label: 'Old Gym', confirmedCancelledAsOf: '2026-10-01', merchantKeys: ['old gym'] }];
  }
  return { tx: txs[kind], plan, opts };
}

async function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-confirmation-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = {
    dir, time: T0, pin: null, backups: new Map(), writes: [], calls: [], tokens: new Map(),
    authority: { householdId, actorId }, source: resolved(),
    authHook: null, resolveHook: null, prepareHook: null, commitHook: null, outcomeHook: null, inspectHook: null,
    lostPinAck: false, unreadablePin: false, failBackup: false,
  };
  const pinStore = {
    async read() { if (w.unreadablePin) throw Error('synthetic secret failure'); return clone(w.pin); },
    async advance(expected, next) {
      w.writes.push('pin');
      const ok = expected === null ? w.pin === null
        : w.pin && expected.revision === w.pin.revision && expected.digest === w.pin.digest;
      if (!ok) return false;
      w.pin = clone(next);
      if (w.lostPinAck) { w.lostPinAck = false; throw Error('synthetic lost acknowledgement'); }
      return true;
    },
  };
  const backupStore = {
    async put(revision, digest, bytes) {
      w.writes.push('backup');
      if (w.failBackup) throw Error('synthetic backup failure');
      const entry = { revision, digest, artifactId: 'synthetic-backup-' + revision };
      w.backups.set(digest, { ...entry, bytes: Buffer.from(bytes) });
      return clone(entry);
    },
    async get(revision, digest) {
      const value = w.backups.get(digest);
      return value && value.revision === revision ? Buffer.from(value.bytes) : null;
    },
    async list() { return [...w.backups.values()].map(({ bytes, ...entry }) => clone(entry)); },
  };
  w.openStore = () => {
    const a = A.createSettlementEvidenceFileAdapter(dir);
    for (const [adapter, methods] of [[a.documentStore, ['writeTemp', 'commitTemp', 'discardTemp']],
      [a.journalStore, ['write', 'clear']], [a.quarantine, ['put']]]) {
      for (const method of methods) {
        const original = adapter[method].bind(adapter);
        adapter[method] = async (...args) => { w.writes.push(method); return original(...args); };
      }
    }
    return S.createSettlementEvidenceStore({ householdId, ...a, pinStore, backupStore, now: () => w.time });
  };
  w.store = w.openStore();
  assert.equal((await w.store.bootstrap()).status, 'bootstrapped');
  w.writes.length = 0;
  w.authorize = async ctx => {
    w.calls.push('authorize');
    if (w.authHook) return w.authHook(ctx);
    if (ctx.ticket === otherContext.ticket) return { householdId, actorId: otherActor };
    if (ctx.ticket !== context.ticket) return null;
    return w.authority;
  };
  w.classification = classificationFixture();
  w.classifyCalls = [];
  // The fixture resolver honours the extended contract: exactly one classify
  // invocation per resolve, on the fixture tx/plan/packet, through the
  // controller-owned closure. Against a controller that supplies no classify
  // closure this is a no-op, which is what makes the Rule E pins fail (not
  // crash) when the suite runs against the base controller.
  w.classifyOnce = input => {
    if (typeof input.classify !== 'function') return null;
    const { tx, plan, opts } = w.classification;
    const verdict = input.classify(clone(tx), clone(plan), clone(opts));
    w.classifyCalls.push(verdict);
    return verdict;
  };
  w.resolve = async input => {
    w.calls.push('resolve');
    assert.equal(input.authority.householdId, householdId);
    assert([actorId, otherActor].includes(input.authority.actorId));
    assert.deepEqual(input.selection, selection);
    // Exact fixture mapping only: content never participates in txRef identity.
    if (w.resolveHook) return w.resolveHook(input);
    w.classifyOnce(input);
    return w.source;
  };
  w.newController = (store = w.store, extraDeps = {}) => createSettlementEvidenceConfirmation({
    householdId, authorize: w.authorize, resolveSelection: w.resolve, now: () => w.time, ...extraDeps,
    store: {
      async prepare(input) {
        w.calls.push('prepare');
        return w.prepareHook ? w.prepareHook(input, store) : store.prepare(input);
      },
      async commitWithoutRecovery(input) {
        w.calls.push('commitWithoutRecovery');
        return w.commitHook ? w.commitHook(input, store) : store.commitWithoutRecovery(input);
      },
      commit() { assert.fail('controller must never fall back to ordinary recovering commit'); },
      async outcome(input) {
        w.calls.push('outcome');
        return w.outcomeHook ? w.outcomeHook(input, store) : store.outcome(input);
      },
      async inspectAttempt(input) {
        w.calls.push('inspectAttempt');
        return w.inspectHook ? w.inspectHook(input, store) : store.inspectAttempt(input);
      },
      bootstrap() { assert.fail('controller must never bootstrap'); },
      reconcile() { assert.fail('controller must never reconcile'); },
    },
  });
  w.controller = w.newController();
  w.prepare = async (n = 1, cents = 2500, ctx = context) => {
    const result = await w.controller.prepare(ctx, request(n, cents));
    if (result.status === 'prepared') w.tokens.set(op(n), result.previewToken);
    return result;
  };
  w.confirm = (n = 1, confirmed = true, ctx = context) => {
    const previewToken = w.tokens.get(op(n));
    return w.controller.confirm(ctx, { operationId: op(n), confirmed,
      ...(previewToken === undefined ? {} : { previewToken }) });
  };
  w.outcome = (n = 1, ctx = context) => w.controller.outcome(ctx, { operationId: op(n) });
  w.document = () => JSON.parse(fs.readFileSync(path.join(dir, 'document.json'), 'utf8'));
  w.load = async () => L.loadSettlementEvidence({ config: { householdId },
    readPin: () => clone(w.pin), readDocument: () => fs.readFileSync(path.join(dir, 'document.json')) });
  w.count = name => w.calls.filter(x => x === name).length;
  return w;
}

function privateFree(value) {
  const text = JSON.stringify(value);
  for (const raw of [householdId, actorId, otherActor, 'synthetic-provider', 'synthetic-session',
    'synthetic-private', 'synthetic-plan-goal', 'synthetic-cash', 'confirmationDigest', 'expectedDocumentDigest', 'txRef']) {
    assert.equal(text.includes(raw), false, 'private field escaped: ' + raw);
  }
}

test('B2 capacity: 200 live previews block 201, but expiry admits new work', async t => {
  const w = await world(t);
  for (let n = 1; n <= 200; n++) assert.equal((await w.prepare(n, 1)).status, 'prepared', 'live preview ' + n);
  assert.equal((await w.prepare(201, 1)).status, 'unavailable');
  w.time += C.TTL_MS;
  assert.equal((await w.prepare(201, 1)).status, 'prepared', 'expired never-attempted previews must not consume lifetime capacity');
  assert.deepEqual(w.writes, []);
});

test('B2 capacity: more than 200 real successful operations reclaim committed previews', async t => {
  const w = await world(t), tokens = new Set(), triples = [];
  let first;
  for (let n = 1; n <= 205; n++) {
    // Rule D fixture note: each successful operation allocates a distinct
    // transaction to the same goal, generated consistently per cycle —
    // provider identity.transactionId, the classifier transaction id, the
    // selection binding and the txRef are minted together
    // (distinctTransaction), so no provider identity ever carries two
    // txRefs. The capacity under test is the controller's
    // preview/operation accounting, which is pair-independent.
    const fixture = distinctTransaction(n);
    w.source = fixture.source; w.classification = fixture.classification;
    triples.push(fixtureTriple(w));
    const prepared = await w.prepare(n, 1);
    assert.equal(prepared.status, 'prepared', 'success cycle ' + n);
    assert.match(prepared.previewToken, /^[a-f0-9]{64}$/);
    assert(!tokens.has(prepared.previewToken)); tokens.add(prepared.previewToken);
    const result = await w.confirm(n);
    assert.equal(result.status, 'committed', 'success cycle ' + n);
    first ||= result;
  }
  assertDistinctTriples(triples, 205);
  assert.equal(w.document().operations.length, 205);
  assert.equal(w.count('commitWithoutRecovery'), 205);
  w.time += C.TTL_MS;
  assert.deepEqual(await w.controller.confirm(context, { operationId: op(1) }), first);
  assert.deepEqual(await w.outcome(1), first);
});

test('B2 terminal refusal: over 200 no-write cycles can reuse an operation without retaining old generations', async t => {
  const w = await world(t), tokens = new Set();
  for (let n = 0; n < 205; n++) {
    const prepared = await w.prepare(1, 1);
    assert.equal(prepared.status, 'prepared', 'refusal cycle ' + n);
    assert(!tokens.has(prepared.previewToken)); tokens.add(prepared.previewToken);
    const mode = n % 4;
    if (mode === 0) w.source.goalBinding = 'synthetic-changed-goal';
    if (mode === 1) w.commitHook = async () => ({ status: 'conflict' });
    if (mode === 2) w.commitHook = async () => ({ status: 'rejected', reason: 'recovery-required' });
    if (mode === 3) w.time += C.TTL_MS;
    const result = await w.confirm();
    assert.deepEqual(result, { status: 'rejected', reason: ['selection-changed', 'store-conflict', 'recovery-required', 'preview-expired'][mode] });
    w.source = resolved(); w.commitHook = null;
  }
  assert.deepEqual(w.writes, []);
  assert.equal((await w.prepare(1, 1)).status, 'prepared');
});

test('B2 generation: expired ID reuse requires the new token and wrong tokens do not retire it', async t => {
  const w = await world(t);
  const old = await w.prepare();
  w.time += C.TTL_MS;
  const next = await w.prepare();
  assert.equal(next.status, 'prepared');
  assert.notEqual(next.previewToken, old.previewToken);
  for (const previewToken of [undefined, old.previewToken, 'f'.repeat(64), 42]) {
    const result = await w.controller.confirm(context, { operationId: op(1), confirmed: true,
      ...(previewToken === undefined ? {} : { previewToken }) });
    assert.equal(result.status, 'rejected');
    assert.equal(w.count('commitWithoutRecovery'), 0);
    assert.deepEqual(w.writes, []);
  }
  assert.equal((await w.prepare()).status, 'unavailable', 'bad tokens must not retire the current live generation');
  assert.equal((await w.confirm()).status, 'committed');
});

test('B2 generation: identical command, frozen clock and rejected ID reuse still get a fresh random token', async t => {
  const w = await world(t), privatePreviews = [];
  w.prepareHook = async (input, store) => {
    const result = await store.prepare(input); privatePreviews.push(clone(result.preview)); return result;
  };
  const old = await w.prepare();
  w.source.goalBinding = 'synthetic-changed-goal';
  assert.equal((await w.confirm()).reason, 'selection-changed');
  w.source = resolved();
  const next = await w.prepare();
  assert.equal(next.status, 'prepared');
  assert.deepEqual(privatePreviews[0], privatePreviews[1], 'store preview/digest/clock are identical across generations');
  assert.equal(w.time, T0);
  assert.match(old.previewToken, /^[a-f0-9]{64}$/); assert.match(next.previewToken, /^[a-f0-9]{64}$/);
  assert.notEqual(next.previewToken, old.previewToken);
  assert.notEqual(next.previewToken, C.digest(privatePreviews[1]));
  assert.notEqual((await w.controller.confirm(context, { operationId: op(1), previewToken: old.previewToken, confirmed: true })).status, 'committed');
  assert.equal((await w.confirm()).status, 'committed');
});

test('B2 tokens: operation and actor swaps fail without committing or retiring either live generation', async t => {
  const w = await world(t);
  const a = await w.prepare(1), b = await w.prepare(2, 1, otherContext);
  assert.equal(a.status, 'prepared'); assert.equal(b.status, 'prepared');
  for (const [ctx, operationId, previewToken] of [
    [context, op(1), b.previewToken], [otherContext, op(2), a.previewToken],
    [context, op(2), b.previewToken], [otherContext, op(1), a.previewToken],
  ]) assert.notEqual((await w.controller.confirm(ctx, { operationId, previewToken, confirmed: true })).status, 'committed');
  assert.deepEqual(w.writes, []);
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.equal((await w.confirm(1, false)).reason, 'confirmation-required');
  assert.equal((await w.confirm(2, false, otherContext)).reason, 'confirmation-required');
  assert.equal((await w.confirm(2, true, otherContext)).status, 'committed');
});

test('B2 nonterminal: confirmation-required and temporarily unavailable selection keep the same generation', async t => {
  const w = await world(t);
  await w.prepare();
  assert.equal((await w.confirm(1, false)).reason, 'confirmation-required');
  assert.equal((await w.prepare()).status, 'unavailable');
  w.resolveHook = async () => { throw Error('synthetic temporarily unavailable'); };
  assert.equal((await w.confirm()).reason, 'selection-unavailable');
  assert.equal((await w.prepare()).status, 'unavailable');
  w.resolveHook = null;
  assert.equal((await w.confirm()).status, 'committed');
});

test('B2 generation race: a paused old confirmation cannot commit after cleanup/reprepare even after clock rollback', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  const old = await w.prepare();
  let pause = true;
  w.resolveHook = async input => {
    if (pause) { pause = false; entered.resolve(); await release.promise; }
    w.classifyOnce(input);
    return resolved();
  };
  const pending = w.controller.confirm(context, { operationId: op(1), previewToken: old.previewToken, confirmed: true });
  await entered.promise;
  w.time += C.TTL_MS;
  const next = await w.prepare(); assert.equal(next.status, 'prepared');
  // Adversarial injected-clock rollback ensures expiry cannot mask a missing
  // final generation-identity check. Restore the new generation's time later.
  w.time = T0;
  release.resolve();
  assert.notEqual((await pending).status, 'committed');
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.deepEqual(w.writes, []);
  w.time = T0 + C.TTL_MS;
  assert.equal((await w.prepare()).status, 'unavailable', 'old cleanup must not delete the replacement');
  assert.equal((await w.confirm()).status, 'committed');
});

test('B2 cleanup race: a terminal result from an old generation cannot delete its replacement', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  await w.prepare();
  let pause = true;
  w.resolveHook = async input => {
    if (pause) {
      pause = false; entered.resolve(); await release.promise;
      w.classifyOnce(input);
      return { ...resolved(), goalBinding: 'synthetic-old-selection-changed' };
    }
    w.classifyOnce(input);
    return resolved();
  };
  const pending = w.confirm(); await entered.promise;
  w.time += C.TTL_MS;
  assert.equal((await w.prepare()).status, 'prepared');
  release.resolve(); assert.equal((await pending).reason, 'selection-changed');
  assert.equal((await w.prepare()).status, 'unavailable');
  assert.deepEqual(w.writes, []);
  assert.equal((await w.confirm()).status, 'committed');
});

test('B2 unknown: past TTL never retries or permits reprepare; only a verified receipt releases it', async t => {
  const w = await world(t);
  const firstTriple = fixtureTriple(w);
  const prepared = await w.prepare();
  w.commitHook = async (input, store) => { await store.commitWithoutRecovery(input); throw Error('synthetic lost controller reply'); };
  assert.equal((await w.confirm()).status, 'unknown');
  w.unreadablePin = true; w.time += C.TTL_MS * 2;
  const writes = clone(w.writes);
  assert.equal((await w.prepare()).status, 'unavailable');
  assert.equal((await w.prepare(2, 1)).status, 'unavailable');
  assert.equal((await w.confirm()).status, 'unknown');
  assert.deepEqual(w.writes, writes);
  assert.equal(w.count('commitWithoutRecovery'), 1);
  w.unreadablePin = false;
  const receipt = await w.outcome(); assert.equal(receipt.status, 'committed');
  assert.deepEqual(await w.controller.confirm(context, { operationId: op(1) }), receipt);
  assert.deepEqual(await w.controller.confirm(context, { operationId: op(1), previewToken: 'wrong', confirmed: false }), receipt);
  w.commitHook = null;
  // Rule D fixture note: op2 allocates a distinct transaction, generated
  // consistently — a new provider identity with its matching classifier
  // transaction id, its own selection binding, and txRef tx(2). What is
  // under test is the verified-receipt release of op1's retained
  // generation, not the pair op2 allocates.
  const fixture2 = distinctTransaction(2);
  w.source = fixture2.source; w.classification = fixture2.classification;
  const secondTriple = fixtureTriple(w);
  assert.equal((await w.prepare(2, 1)).status, 'prepared');
  assert.equal((await w.confirm(2)).status, 'committed');
  assertDistinctTriples([firstTriple, secondTriple], 2);
  assert.deepEqual(await w.controller.confirm(context, { operationId: op(1) }), receipt);
  assert.equal(w.document().operations.length, 2);
  assert.equal(typeof prepared.previewToken, 'string');
});

test('B2 unknown race: stale selection refusal cannot retire a generation whose other confirmation attempted a write', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  await w.prepare();
  let pause = true;
  w.resolveHook = async input => {
    if (pause) {
      pause = false; entered.resolve(); await release.promise;
      w.classifyOnce(input);
      return { ...resolved(), goalBinding: 'synthetic-stale-goal' };
    }
    w.classifyOnce(input);
    return resolved();
  };
  const old = w.confirm(); await entered.promise;
  w.commitHook = async () => ({ status: 'unknown' });
  assert.equal((await w.confirm()).status, 'unknown');
  release.resolve(); assert.equal((await old).status, 'unknown');
  w.time += C.TTL_MS * 2;
  assert.equal((await w.prepare()).status, 'unavailable');
  assert.equal((await w.confirm()).status, 'unknown');
  assert.equal(w.count('commitWithoutRecovery'), 1);
  assert.deepEqual(w.writes, []);
});

test('B2 in-flight: TTL cannot evict an attempted generation while the sole commit awaits', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  const old = await w.prepare();
  w.commitHook = async (input, store) => { entered.resolve(); await release.promise; return store.commitWithoutRecovery(input); };
  const pending = w.confirm(); await entered.promise;
  w.time += C.TTL_MS;
  assert.equal((await w.prepare()).status, 'unavailable');
  assert.equal((await w.prepare(2, 1)).status, 'unavailable');
  release.resolve(); assert.equal((await pending).reason, 'preview-expired');
  assert.deepEqual(w.writes, []);
  w.commitHook = null;
  const next = await w.prepare(); assert.equal(next.status, 'prepared');
  assert.notEqual(next.previewToken, old.previewToken);
});

test('B2 reservation cap: 200 concurrent preparing reservations block a 201st before awaiting', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  // This POSIX adapter refuses overlapping lock acquisitions. Schedule the
  // fixture's read-only probes serially so the test isolates controller slots.
  let probes = Promise.resolve();
  w.prepareHook = (input, store) => {
    const result = probes.then(() => store.prepare(input));
    probes = result.catch(() => {});
    return result;
  };
  let count = 0;
  w.authHook = async () => {
    if (++count === 200) entered.resolve();
    await release.promise; return { householdId, actorId };
  };
  const pending = Array.from({ length: 200 }, (_, i) => w.prepare(i + 1, 1));
  await entered.promise;
  assert.equal((await w.prepare(201, 1)).status, 'unavailable');
  assert.equal(count, 200);
  release.resolve();
  const results = await Promise.all(pending);
  assert(results.every(result => result.status === 'prepared'));
  assert.equal(new Set(results.map(result => result.previewToken)).size, 200);
  assert.equal((await w.prepare(201, 1)).status, 'unavailable');
  assert.deepEqual(w.writes, []);
});

test('B2 reservation cap: active previews and failing reservations share the same 200 slots', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  for (let n = 1; n <= 199; n++) assert.equal((await w.prepare(n, 1)).status, 'prepared');
  w.authHook = async () => { entered.resolve(); await release.promise; return null; };
  const pending = w.prepare(200, 1); await entered.promise;
  assert.equal((await w.prepare(201, 1)).status, 'unavailable');
  release.resolve(); assert.equal((await pending).status, 'unavailable');
  w.authHook = null;
  assert.equal((await w.prepare(201, 1)).status, 'prepared', 'failed reservation releases only its own slot');
  assert.deepEqual(w.writes, []);
});

test('B2 token boundary: nonce is never accepted at prepare or forwarded to store/document/journal', async t => {
  const w = await world(t), storeInputs = [];
  assert.equal((await w.controller.prepare(context, { ...request(), previewToken: 'f'.repeat(64) })).status, 'unavailable');
  w.prepareHook = async (input, store) => { storeInputs.push(clone(input)); return store.prepare(input); };
  w.commitHook = async (input, store) => { storeInputs.push(clone(input)); return store.commitWithoutRecovery(input); };
  const prepared = await w.prepare();
  w.failBackup = true;
  assert.equal((await w.confirm()).status, 'unknown');
  const privateState = JSON.stringify(storeInputs) + fs.readFileSync(path.join(w.dir, 'document.json'), 'utf8')
    + fs.readFileSync(path.join(w.dir, 'journal.json'), 'utf8')
    + [...w.backups.values()].map(entry => entry.bytes.toString('utf8')).join('');
  assert(!privateState.includes('previewToken'));
  assert(!privateState.includes(prepared.previewToken));
  assert.equal(w.count('commitWithoutRecovery'), 1);
});

test('prepare is read-only and returns only the exact sanitized selection/amount/date/operation/expiry', async t => {
  const w = await world(t);
  const before = fs.readFileSync(path.join(w.dir, 'document.json'));
  const result = await w.prepare();
  const { previewToken, generation, ...shown } = result;
  assert.match(previewToken, /^[a-f0-9]{64}$/);
  assert.match(generation, /^generation-[a-f0-9]{32}$/);
  assert.deepEqual(shown, { status: 'prepared', operationId: op(1), selection,
    assignedCents: 2500, currency: 'cad', date: '2026-10-19', asOf: '2026-10-20',
    operation: { version: 1, kind: 'link' }, expiresAt: T0 + C.TTL_MS });
  privateFree(result);
  assert(Object.isFrozen(result) && Object.isFrozen(result.selection));
  assert.deepEqual(w.writes, []);
  assert.deepEqual(fs.readFileSync(path.join(w.dir, 'document.json')), before);
  assert.equal((await w.load()).evidence.commitments.length, 0);
  assert.deepEqual(await w.outcome(), { status: 'unknown', operationId: op(1) });
  assert.notEqual((await w.confirm(1, false)).status, 'committed');
  assert.notEqual((await w.controller.confirm(context, { operationId: op(1) })).status, 'committed');
  assert.deepEqual(w.writes, []);
  assert.equal(w.count('commitWithoutRecovery'), 0);
});

test('explicit confirmation lands one original receipt and the independent loader sees household evidence', async t => {
  const w = await world(t);
  await w.prepare();
  const receipt = await w.confirm();
  const doc = w.document();
  assert.deepEqual(receipt, { status: 'committed', operationId: op(1), revision: 1, digest: doc.digest });
  privateFree(receipt);
  assert.equal(doc.operations.length, 1);
  assert.equal(doc.operations[0].actorId, actorId);
  assert.deepEqual((await w.load()).evidence.commitments[0], { goalId: 'commitment:synthetic-trip', links: [{
    operationId: op(1), txRef: tx(1), assignedCents: 2500, effectiveDate: '2026-10-19', asOf: '2026-10-20',
    evidenceDigest: C.digest(resolved().evidence), reversals: [],
  }] });
  const frozen = clone(w.writes);
  assert.deepEqual(await w.confirm(), receipt);
  assert.deepEqual(await w.outcome(), receipt);
  assert.deepEqual(w.writes, frozen);
  assert.equal(w.count('commitWithoutRecovery'), 1);
});

for (const field of ['actorId', 'householdId', 'command', 'evidence', 'evidenceDigest', 'txRef', 'goalId', 'asOf', 'preview', 'confirmationDigest', 'classification', 'verdict']) {
  test('caller cannot submit authority/evidence field ' + field, async t => {
    const w = await world(t);
    assert.equal((await w.controller.prepare(context, { ...request(), [field]: 'forged' })).status, 'unavailable');
    await w.prepare();
    assert.equal((await w.controller.confirm(context, { operationId: op(1), confirmed: true, [field]: 'forged' })).status, 'unavailable');
    assert.equal((await w.controller.outcome(context, { operationId: op(1), [field]: 'forged' })).status, 'unavailable');
    assert.deepEqual(w.writes, []);
  });
}

test('unrecognized session and caller-supplied identities do not establish authority', async t => {
  const w = await world(t);
  const forged = { ticket: 'forged', householdId, actorId };
  for (const call of [() => w.controller.prepare(forged, request()),
    () => w.controller.confirm(forged, { operationId: op(1), confirmed: true }),
    () => w.controller.outcome(forged, { operationId: op(1) })]) {
    const result = await call();
    assert.equal(result.status, 'unavailable'); privateFree(result);
  }
  assert.deepEqual(w.writes, []);
  assert.equal(w.count('resolve'), 0);
});

for (const authority of [null, { householdId, actorId: 'session-old-cookie-expiry' },
  { householdId: 'household-' + 'd'.repeat(32), actorId }, { householdId, actorId: otherActor }]) {
  test('prepare/confirm/outcome reauthorize and reject changed or malformed authority: ' + JSON.stringify(authority), async t => {
    const w = await world(t);
    await w.prepare(); w.authority = authority;
    const result = await w.confirm();
    assert.notEqual(result.status, 'committed'); privateFree(result);
    assert.notEqual((await w.outcome()).status, 'committed');
    assert.deepEqual(w.writes, []);
  });
}

for (const [name, change] of [
  ['ambiguous', r => { r.matchCount = 2; }], ['missing', r => { r.matchCount = 0; }],
  ['pending', r => { r.evidence.posted = false; }], ['credit', r => { r.evidence.direction = 'credit'; }],
  ['USD', r => { r.evidence.currency = 'usd'; }], ['zero debit', r => { r.evidence.cents = 0; }],
  ['invalid date', r => { r.evidence.date = '2026-02-30'; }],
  ['future date', r => { r.evidence.date = '2026-10-21'; }],
  ['unqualified source', r => { r.identity.source = 'plaid'; }],
  ['foreign household', r => { r.identity.householdId = 'household-' + 'd'.repeat(32); }],
  ['tx-N alias', r => { r.txRef = 'tx-1'; }], ['pc alias', r => { r.txRef = 'pc-pending'; }],
  ['provider ID missing', r => { r.identity.transactionId = ''; }],
  ['evidence changed', r => { r.evidence.cents++; }], ['date changed', r => { r.evidence.date = '2026-10-18'; }],
  ['account changed', r => { r.identity.providerAccountId += '-other'; }],
  ['transaction changed', r => { r.identity.transactionId += '-other'; }],
  ['binding changed', r => { r.selectionBinding += '-other'; }],
  ['goal changed', r => { r.goalId = 'commitment:synthetic-other'; }],
  ['goal content changed', r => { r.goalBinding += '-other'; }],
  ['financial as-of changed', r => { r.asOf = '2026-10-21'; }],
  ['stable ref changed', r => { r.txRef = tx(2); }],
]) {
  test('fresh confirmation refuses ' + name + ' without any durable write', async t => {
    const w = await world(t);
    await w.prepare(); change(w.source);
    const result = await w.confirm();
    assert.notEqual(result.status, 'committed'); privateFree(result);
    assert.deepEqual(w.writes, []);
    assert.equal(w.count('commitWithoutRecovery'), 0);
  });
}

test('prepare refuses pending/ambiguous/aliases and never synthesizes posted lineage', async t => {
  const w = await world(t);
  for (const mutate of [r => { r.matchCount = 2; }, r => { r.evidence.posted = false; },
    r => { r.txRef = 'tx-1'; }, r => { r.txRef = 'pc-1'; }]) {
    w.source = resolved(); mutate(w.source);
    assert.equal((await w.prepare()).status, 'unavailable');
  }
  for (const kind of ['retract', 'reverse', 'lineage']) {
    assert.equal((await w.controller.prepare(context, { ...request(), command: { version: 1, kind } })).status, 'unavailable');
  }
  assert.deepEqual(w.writes, []);
});

test('uncommitted expiry and concurrent ledger revision refuse without rebasing', async t => {
  const w = await world(t);
  await w.prepare(); w.time += C.TTL_MS;
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'preview-expired' });
  assert.deepEqual(w.writes, []);
  w.time = T0; await w.prepare(2); await w.prepare(3);
  assert.equal((await w.confirm(2)).status, 'committed');
  const writes = clone(w.writes);
  assert.notEqual((await w.confirm(3)).status, 'committed');
  assert.equal(w.document().operations.length, 1);
  assert.deepEqual(w.writes, writes);
});

test('same stable tuple cannot gain fresh capacity from content changes or an allocation to another goal', async t => {
  const w = await world(t);
  await w.prepare(1, 4000); assert.equal((await w.confirm()).status, 'committed');
  w.source.goalId = 'commitment:synthetic-second';
  assert.equal((await w.prepare(2, 2001)).status, 'unavailable'); // 4000 + 2001 > 6000 independently.
  w.source.evidence.cents = 9000;
  assert.equal((await w.prepare(3, 1)).status, 'unavailable'); // changed evidence is not another transaction.
  assert.equal(w.document().operations.length, 1);
});

test('original receipt survives expiry, changed current evidence, later commit and a new controller', async t => {
  const w = await world(t);
  await w.prepare(); const first = await w.confirm();
  // Rule D fixture note: the later commit allocates the same transaction
  // to a second goal (2500 + 3500 still exactly fills its 6000 budget);
  // the original receipt under test belongs to op1 either way.
  w.source = { ...resolved(), goalId: 'commitment:synthetic-second' };
  await w.prepare(2, 3500); assert.equal((await w.confirm(2)).revision, 2);
  w.source.matchCount = 0; w.time += C.TTL_MS + 1;
  const writes = clone(w.writes), resolves = w.count('resolve');
  w.controller = w.newController(w.openStore());
  assert.deepEqual(await w.confirm(1, false), first);
  assert.deepEqual(await w.outcome(), first);
  assert.equal(w.count('resolve'), resolves);
  assert.deepEqual(w.writes, writes);
  assert.notEqual(first.digest, w.document().digest);
});

test('new sessions cannot confirm previews or retrieve former receipts; household read evidence remains', async t => {
  const w = await world(t);
  await w.prepare();
  assert.notEqual((await w.confirm(1, true, otherContext)).status, 'committed');
  assert.deepEqual(w.writes, []);
  const receipt = await w.confirm();
  const writes = clone(w.writes);
  w.controller = w.newController(w.openStore());
  assert.deepEqual(await w.outcome(1, otherContext), { status: 'unknown', operationId: op(1) });
  assert.notEqual((await w.confirm(1, true, otherContext)).status, 'committed');
  assert.deepEqual(await w.outcome(), receipt);
  assert.equal((await w.load()).evidence.commitments[0].links.length, 1);
  assert.deepEqual(w.writes, writes);
});

test('lost pin acknowledgement remains unknown until explicit read; no retry or new operation', async t => {
  const w = await world(t);
  await w.prepare(); w.lostPinAck = true;
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  assert.equal(w.document().operations.length, 1);
  const writes = clone(w.writes);
  const receipt = await w.outcome();
  assert.equal(receipt.status, 'committed');
  assert.deepEqual(await w.confirm(), receipt);
  assert.deepEqual(w.writes, writes);
  assert.equal(w.count('commitWithoutRecovery'), 1);
});

test('a lost controller acknowledgement recovers the same receipt, including after a later commit', async t => {
  const w = await world(t);
  await w.prepare();
  w.commitHook = async (input, store) => { await store.commitWithoutRecovery(input); throw Error('synthetic lost reply'); };
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  const first = await w.outcome();
  assert.equal(first.status, 'committed');
  w.commitHook = null;
  // Rule D fixture note: as in the receipt test above, the later commit
  // allocates the same transaction to a second goal; op1's receipt is
  // what must be recovered.
  w.source = { ...resolved(), goalId: 'commitment:synthetic-second' };
  await w.prepare(2, 3500); assert.equal((await w.confirm(2)).revision, 2);
  const writes = clone(w.writes);
  w.time += C.TTL_MS;
  assert.deepEqual(await w.confirm(), first);
  assert.deepEqual(w.writes, writes);
  assert.equal(w.document().operations.length, 2);
});

test('unresolved write uncertainty never auto-retries, recovers or replaces its retained operation', async t => {
  const w = await world(t);
  await w.prepare(); await w.prepare(2); w.failBackup = true;
  assert.equal((await w.confirm()).status, 'unknown');
  assert.equal((await w.load()).status, 'unavailable');
  const writes = clone(w.writes), calls = w.count('commitWithoutRecovery');
  w.failBackup = false;
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await w.confirm(2), { status: 'unknown', operationId: op(2) });
  assert.deepEqual(await w.outcome(), { status: 'unknown', operationId: op(1) });
  assert.equal((await w.prepare()).status, 'unavailable');
  assert.equal((await w.prepare(3)).status, 'unavailable');
  assert.deepEqual(w.writes, writes);
  assert.equal(w.count('commitWithoutRecovery'), calls);
  w.controller = w.newController(w.openStore());
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  assert.deepEqual(w.writes, writes);
});

test('concurrent explicit confirmations issue at most one store commit', async t => {
  const w = await world(t);
  await w.prepare();
  const entered = deferred(), release = deferred();
  w.commitHook = async (input, store) => { entered.resolve(); await release.promise; return store.commitWithoutRecovery(input); };
  const first = w.confirm(); await entered.promise;
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  release.resolve(); assert.equal((await first).status, 'committed');
  assert.equal(w.count('commitWithoutRecovery'), 1);
  assert.equal(w.document().operations.length, 1);
});

test('snapshot caller context and selection before the first authorization await', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  w.authHook = async ctx => { entered.resolve(); await release.promise; return ctx.ticket === context.ticket ? { householdId, actorId } : null; };
  const ctx = clone(context), input = request();
  const pending = w.controller.prepare(ctx, input); await entered.promise;
  ctx.ticket = 'forged'; input.assignedCents = 6000; input.selection.transaction = 'pc-1'; input.operationId = op(99);
  release.resolve();
  const prepared = await pending;
  assert.equal(prepared.operationId, op(1)); w.tokens.set(op(1), prepared.previewToken);
  assert.equal((await w.confirm()).status, 'committed');
  assert.equal(w.document().operations[0].command.assignedCents, 2500);
});

test('snapshot trusted authorization, resolution and exact store preview across subsequent awaits', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  let externalPreview;
  w.prepareHook = async (input, store) => {
    entered.resolve(); await release.promise;
    const result = await store.prepare(input); externalPreview = result.preview;
    return result;
  };
  const pending = w.prepare(); await entered.promise;
  w.authority.actorId = otherActor; w.source.evidence.cents = 9000;
  release.resolve();
  assert.notEqual((await pending).status, 'prepared'); // authority revoked during prepare.
  assert.deepEqual(w.writes, []);
  w.authority = { householdId, actorId }; w.source = resolved(); w.prepareHook = null;
  await w.prepare(2);
  assert(externalPreview); // foreign objects never become writable retained previews.
  assert.equal((await w.confirm(2)).status, 'committed');
  assert.equal(w.document().operations[0].command.evidence.cents, 6000);
});

test('owned resolution remains exact while the store awaits and foreign source changes', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  w.prepareHook = async (input, store) => { entered.resolve(); await release.promise; return store.prepare(input); };
  const pending = w.prepare(); await entered.promise;
  w.source.identity.transactionId += '-mutated'; w.source.evidence.cents = 9000;
  release.resolve(); assert.equal((await pending).status, 'prepared');
  w.source = resolved(); w.prepareHook = null;
  assert.equal((await w.confirm()).status, 'committed');
  assert.equal(w.document().operations[0].command.evidence.cents, 6000);
});

test('foreign store preview/digest mutations during authorization await cannot alter the retained request', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  let external, authCalls = 0;
  w.prepareHook = async (input, store) => { external = await store.prepare(input); return external; };
  w.authHook = async () => {
    if (++authCalls === 2) { entered.resolve(); await release.promise; }
    return { householdId, actorId };
  };
  const pending = w.prepare(); await entered.promise;
  external.preview.command.assignedCents = 6000;
  external.preview.operationId = op(99); external.preview.expiresAt = T0 + 1;
  external.confirmationDigest = 'f'.repeat(64);
  release.resolve(); assert.equal((await pending).status, 'prepared');
  w.prepareHook = null; w.authHook = null;
  assert.equal((await w.confirm()).status, 'committed');
  assert.equal(w.document().operations[0].operationId, op(1));
  assert.equal(w.document().operations[0].command.assignedCents, 2500);
});

test('authorization snapshot cannot change inside resolver; prepare reauthorizes the current session', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  let passedAuthority;
  w.resolveHook = async input => { passedAuthority = input.authority; entered.resolve(); await release.promise; w.classifyOnce(input); return resolved(); };
  const pending = w.prepare(); await entered.promise;
  w.authority.actorId = otherActor;
  assert.equal(passedAuthority.actorId, actorId);
  assert(Object.isFrozen(passedAuthority));
  release.resolve(); assert.equal((await pending).status, 'unavailable');
  assert.deepEqual(w.writes, []);
});

test('confirmation request is owned before authorization awaits, including its explicit true value', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  await w.prepare();
  w.authHook = async () => { entered.resolve(); await release.promise; return { householdId, actorId }; };
  const input = { operationId: op(1), previewToken: w.tokens.get(op(1)), confirmed: true }, ctx = clone(context);
  const pending = w.controller.confirm(ctx, input); await entered.promise;
  input.operationId = op(99); input.confirmed = false; ctx.ticket = 'forged';
  release.resolve();
  assert.equal((await pending).operationId, op(1));
  assert.equal(w.document().operations.length, 1);
});

test('outcome snapshots request/result and reauthorizes after the store read', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  await w.prepare(); const receipt = await w.confirm();
  w.outcomeHook = async (input, store) => { entered.resolve(); await release.promise; return store.outcome(input); };
  const input = { operationId: op(1) }, ctx = clone(context);
  const pending = w.controller.outcome(ctx, input); await entered.promise;
  input.operationId = op(99); ctx.ticket = 'forged'; release.resolve();
  assert.deepEqual(await pending, receipt);
  w.authority = null;
  assert.equal((await w.outcome()).status, 'unavailable');
  const writes = clone(w.writes);
  w.authority = { householdId, actorId };
  w.outcomeHook = async (request, store) => {
    const result = await store.outcome(request); w.authority = null; return result;
  };
  assert.equal((await w.outcome()).status, 'unavailable');
  assert.deepEqual(w.writes, writes);
});

test('fresh store qualification refuses resident journals or divergence without initiating recovery', async t => {
  const w = await world(t);
  await w.prepare();
  // An independent interrupted operation must not be recovered by this caller.
  fs.writeFileSync(path.join(w.dir, 'journal.json'), 'synthetic-torn-journal', { mode: 0o600 });
  const before = fs.readFileSync(path.join(w.dir, 'document.json'));
  assert.equal((await w.confirm()).status, 'unavailable');
  assert.deepEqual(w.writes, []);
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.deepEqual(fs.readFileSync(path.join(w.dir, 'document.json')), before);
  assert.equal(fs.readFileSync(path.join(w.dir, 'journal.json'), 'utf8'), 'synthetic-torn-journal');
});

test('B1 race: a journal arriving after the probe cannot be recovered by confirmation', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  let prepares = 0, pauseNextAuthorization = false;
  w.prepareHook = async (input, store) => {
    const result = await store.prepare(input);
    if (++prepares === 2) pauseNextAuthorization = true;
    return result;
  };
  w.authHook = async () => {
    if (pauseNextAuthorization) {
      pauseNextAuthorization = false; entered.resolve(); await release.promise;
    }
    return { householdId, actorId };
  };
  await w.prepare();
  const pendingA = w.confirm();
  await entered.promise; // A's probe released the real shared file lock at revision 0.
  assert.equal(w.pin.revision, 0);
  const source = resolved();
  const commandB = { version: 1, kind: 'link', goalId: 'commitment:synthetic-b', txRef: tx(2),
    evidence: source.evidence, evidenceDigest: C.digest(source.evidence), assignedCents: 3000, asOf: source.asOf };
  const previewB = await w.store.prepare({ actorId: otherActor, operationId: op(2), command: commandB });
  w.failBackup = true;
  assert.deepEqual(await w.store.commit({ actorId: otherActor, preview: previewB.preview,
    confirmationDigest: previewB.confirmationDigest }), { status: 'unknown', reason: 'backup-ambiguous' });
  // Retained staged/quarantine bytes must survive the refusal as well.
  await A.createSettlementEvidenceFileAdapter(w.dir).documentStore.writeTemp(Buffer.from('synthetic-retained-stage'));
  fs.mkdirSync(path.join(w.dir, 'quarantine'), { mode: 0o700 });
  fs.writeFileSync(path.join(w.dir, 'quarantine', 'synthetic-retained'), 'synthetic-quarantine', { mode: 0o600 });
  const files = (dir = w.dir) => fs.readdirSync(dir).sort().map(name => {
    const target = path.join(dir, name);
    return [name, fs.statSync(target).isDirectory() ? files(target) : fs.readFileSync(target).toString('hex')];
  });
  const durable = () => ({ files: files(), pin: clone(w.pin), backups: [...w.backups.values()]
    .map(({ bytes, ...entry }) => ({ ...entry, bytes: bytes.toString('hex') })) });
  const before = durable(), writes = clone(w.writes);
  assert.equal((await w.load()).reason, 'document-ahead-of-pin');
  w.failBackup = false;
  release.resolve();
  const result = await pendingA;
  assert.deepEqual(w.writes.slice(writes.length), [], 'A must add zero durable mutations after the healthy probe');
  assert.deepEqual(result, { status: 'rejected', reason: 'recovery-required' });
  assert.deepEqual(durable(), before, 'B document/journal/staged/pin/backups/quarantine preserved byte-for-byte');
  assert.equal(w.pin.revision, 0);
  assert.equal((await w.load()).reason, 'document-ahead-of-pin');
  assert.equal((await w.outcome()).status, 'unknown');
  assert.equal((await w.store.outcome({ actorId: otherActor, operationId: op(2) })).status, 'unknown');
  assert.deepEqual(await w.confirm(), { status: 'unknown', operationId: op(1) });
  assert.deepEqual(durable(), before, 'a repeated confirmation still cannot retry or recover B');
  assert.deepEqual(w.writes, writes);
  assert.equal(w.count('commitWithoutRecovery'), 1, 'no retry or rebase');
  assert.equal((await w.store.reconcile()).disposition, 'promoted', 'explicit ordinary recovery remains a separate control');
  assert.equal(w.pin.revision, 1);
  assert.equal((await w.load()).status, 'qualified');
  assert.equal((await w.store.outcome({ actorId: otherActor, operationId: op(2) })).status, 'committed');
  assert.equal((await w.outcome()).status, 'unknown', 'A was never appended');
});

test('B1 capability: ordinary commit alone is refused; the controller cannot fall back', () => {
  let ordinaryCalls = 0;
  assert.throws(() => createSettlementEvidenceConfirmation({ householdId,
    authorize: async () => ({ householdId, actorId }), resolveSelection: async () => resolved(), now: () => T0,
    store: { prepare: async () => ({}), outcome: async () => ({ status: 'unknown' }),
      commit: async () => { ordinaryCalls++; return { status: 'committed' }; } },
  }), /incomplete trusted dependencies/);
  assert.equal(ordinaryCalls, 0);
});

test('malformed/throwing authorization, resolver and store paths cannot issue a false receipt', async t => {
  const w = await world(t);
  for (const invalid of [null, {}, { matchCount: 1 }, { ...resolved(), goalId: 'forged' },
    { ...resolved(), asOf: '2026-02-30' }, { ...resolved(), pendingTxRef: tx(2) }]) {
    w.resolveHook = async () => invalid;
    assert.equal((await w.prepare()).status, 'unavailable');
  }
  w.resolveHook = null;
  w.prepareHook = async () => ({ preview: { actorId }, confirmationDigest: 'f'.repeat(64) });
  assert.equal((await w.prepare()).status, 'unavailable');
  w.prepareHook = null; await w.prepare();
  w.outcomeHook = async () => ({ status: 'committed', operationId: op(99), revision: 1, digest: 'f'.repeat(64) });
  const invalidReceipt = await w.confirm();
  assert.equal(invalidReceipt.status, 'unavailable'); privateFree(invalidReceipt);
  assert.deepEqual(w.writes, []);
  assert.equal(w.count('commitWithoutRecovery'), 0);
});

test('accessors, toJSON and non-data inputs cannot smuggle caller authority across an await', async t => {
  const w = await world(t);
  let getterCalls = 0;
  const input = request();
  Object.defineProperty(input, 'actorId', { enumerable: true, get() { getterCalls++; return actorId; } });
  assert.equal((await w.controller.prepare(context, input)).status, 'unavailable');
  assert.equal(getterCalls, 0);
  assert.equal((await w.controller.prepare(context, { ...request(), toJSON() { return request(); } })).status, 'unavailable');
  const circular = request(); circular.selection.circular = circular;
  assert.equal((await w.controller.prepare(context, circular)).status, 'unavailable');
  assert.equal(w.count('authorize'), 0);
  assert.deepEqual(w.writes, []);
});

test('confirmation snapshots explicit confirmation and rechecks authority/expiry after fresh resolution', async t => {
  const w = await world(t);
  await w.prepare();
  const entered = deferred(), release = deferred();
  w.resolveHook = async input => { entered.resolve(); await release.promise; w.classifyOnce(input); return resolved(); };
  const input = { operationId: op(1), previewToken: w.tokens.get(op(1)), confirmed: false };
  const denied = w.controller.confirm(context, input); input.confirmed = true;
  assert.notEqual((await denied).status, 'committed');
  const pending = w.confirm(); await entered.promise;
  w.authority = { householdId, actorId: otherActor }; release.resolve();
  assert.notEqual((await pending).status, 'committed');
  assert.deepEqual(w.writes, []);
  w.authority = { householdId, actorId }; w.resolveHook = async input => { w.time = T0 + C.TTL_MS; w.classifyOnce(input); return resolved(); };
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'preview-expired' });
  assert.deepEqual(w.writes, []);
});

test('returned preview cannot supply a changed command or confirmation digest', async t => {
  const w = await world(t);
  const preview = await w.prepare();
  assert.throws(() => { preview.assignedCents = 6000; }, TypeError);
  assert.throws(() => { preview.selection.transaction = 'pc-1'; }, TypeError);
  const original = await w.prepare();
  assert.equal(original.status, 'unavailable'); // cannot overwrite an operation's retained preview.
  assert.equal((await w.confirm()).status, 'committed');
  assert.equal(w.document().operations[0].command.assignedCents, 2500);
});

test('errors and malformed store results never leak identities or report success', async t => {
  const w = await world(t);
  w.resolveHook = async () => { throw Error(householdId + actorId); };
  const unavailable = await w.prepare(); privateFree(unavailable); assert.equal(unavailable.status, 'unavailable');
  w.resolveHook = null; await w.prepare();
  w.commitHook = async () => ({ status: 'committed', operationId: op(99), revision: 0, digest: 'forged', actorId });
  const result = await w.confirm(); privateFree(result); assert.equal(result.status, 'unknown');
  assert.equal(w.document().operations.length, 0);
});

test('real process restart recovers only committed outcome and cannot fabricate a preview', async t => {
  const w = await world(t);
  await w.prepare(1); const receipt = await w.confirm(1);
  await w.prepare(2);
  const root = path.resolve(__dirname, '..');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const A = require(input.root + '/scripts/settlement-evidence-file-adapter');
    const S = require(input.root + '/scripts/settlement-evidence-store');
    const F = require(input.root + '/scripts/settlement-evidence-confirmation');
    const deny = () => { throw Error('restart must not write or recover'); };
    const store = S.createSettlementEvidenceStore({ householdId: input.householdId,
      ...A.createSettlementEvidenceFileAdapter(input.dir), now: () => input.time,
      pinStore: { read: async () => input.pin, advance: deny },
      backupStore: { put: deny, get: deny, list: deny } });
    const c = F.createSettlementEvidenceConfirmation({ householdId: input.householdId, store,
      authorize: async ctx => ({ householdId: input.householdId, actorId: ctx.actor }),
      resolveSelection: deny, now: () => input.time });
    (async () => {
      const a = { actor: input.actorId }, b = { actor: input.otherActor };
      process.stdout.write(JSON.stringify([
        await c.confirm(a, { operationId: input.committed, confirmed: false }),
        await c.confirm(a, { operationId: input.uncommitted, confirmed: true }),
        await c.outcome(b, { operationId: input.committed })
      ]));
    })().catch(() => process.exit(7));
  `], { input: JSON.stringify({ root, dir: w.dir, pin: w.pin, time: T0 + C.TTL_MS + 1,
    householdId, actorId, otherActor, committed: op(1), uncommitted: op(2) }), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [receipt,
    { status: 'unknown', operationId: op(2) }, { status: 'unknown', operationId: op(1) }]);
  assert.equal(w.document().operations.length, 1);
});

// ---------------------------------------------------------------------------
// Rule E (ATLAS-080 foundation qualification): admission is judged by
// Forecast's classifier, called through the controller-owned classify
// closure during the resolver's own resolve call. The verdict is projected
// to {kind, categoryId, householdSpending, reason, needsConfirmation},
// retained with the prepared selection, and re-derived at confirm. It is
// never persisted, never enters the command, and is never read from data
// supplied by the caller or the resolver.

test('Rule E E1: transfer verdict is rejected selection-ineligible at prepare before any store call', async t => {
  const w = await world(t);
  w.classification = classificationFixture('transfer');
  assert.deepEqual(await w.prepare(), { status: 'rejected', reason: 'selection-ineligible' });
  assert.equal(w.classifyCalls[0].kind, 'transfer');
  assert.equal(w.count('prepare'), 0, 'store.prepare must never be called for an ineligible selection');
  assert.deepEqual(w.writes, []);
  assert.deepEqual(await w.outcome(), { status: 'unknown', operationId: op(1) });
  // No preview is retained: the same operation prepares once eligible.
  w.classification = classificationFixture('spend-groceries');
  assert.equal((await w.prepare()).status, 'prepared');
  assert.equal((await w.confirm()).status, 'committed');
});

test('Rule E E2: eligible spend is admitted byte-identical, classified exactly once per resolve', async t => {
  const w = await world(t);
  assert.equal((await w.prepare()).status, 'prepared');
  assert.equal(w.classifyCalls.length, 1, 'exactly one classify invocation during prepare resolve');
  const verdict = w.classifyCalls[0];
  assert.deepEqual({ kind: verdict.kind, categoryId: verdict.categoryId,
    householdSpending: verdict.householdSpending, reason: verdict.reason,
    needsConfirmation: verdict.needsConfirmation },
    { kind: 'spend', categoryId: 'groceries', householdSpending: true, reason: null, needsConfirmation: false });
  assert.equal((await w.confirm()).status, 'committed');
  assert.equal(w.classifyCalls.length, 2, 'confirm re-resolves and classifies exactly once more');
  assert.deepEqual(w.document().operations[0].command, { version: 1, kind: 'link',
    goalId: 'commitment:synthetic-trip', txRef: tx(1), evidence: resolved().evidence,
    evidenceDigest: C.digest(resolved().evidence), assignedCents: 2500, asOf: '2026-10-20' },
    'the verdict adds no field to the command: digest and bytes are exactly as before Rule E');
});

test('Rule E E3: TD card-payment identity under a spending label is rejected selection-ineligible', async t => {
  const w = await world(t);
  w.classification = classificationFixture('card-payment-td');
  assert.deepEqual(await w.prepare(), { status: 'rejected', reason: 'selection-ineligible' });
  assert.equal(w.classifyCalls[0].kind, 'card-payment');
  assert.equal(w.classifyCalls[0].reason, 'td-card-recipient-identity', 'identity beats the Groceries label');
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E: internal-movement verdict is rejected selection-ineligible', async t => {
  const w = await world(t);
  w.classification = classificationFixture('internal-movement');
  assert.deepEqual(await w.prepare(), { status: 'rejected', reason: 'selection-ineligible' });
  assert.equal(w.classifyCalls[0].kind, 'internal-movement');
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E E4: unclassified needs-confirmation is selection-eligibility-unresolved, never permanent', async t => {
  const w = await world(t);
  w.classification = classificationFixture('unclassified');
  assert.deepEqual(await w.prepare(), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls[0].kind, 'unclassified');
  assert.equal(w.classifyCalls[0].needsConfirmation, true);
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
  // A cancelled-service charge lands on the same unresolved surface.
  w.classification = classificationFixture('cancelled-service');
  assert.deepEqual(await w.prepare(2), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls[1].reason, 'cancelled-service-charge');
  // Unresolved is not permanent ineligibility: once Forecast judges the
  // transaction an eligible spend, the same operation prepares and commits.
  w.classification = classificationFixture('spend-groceries');
  assert.equal((await w.prepare()).status, 'prepared');
  assert.equal((await w.confirm()).status, 'committed');
});

test('Rule E E7 corrected: bills are selection-eligibility-unresolved, not ineligible and not admitted', async t => {
  const w = await world(t);
  // A represented bill is a plan commitment row's own payment; the GO
  // corrects the clarification packet here: bill has no established
  // settlement policy yet, so the surface is unresolved, not ineligible.
  w.classification = classificationFixture('bill-represented');
  assert.deepEqual(await w.prepare(1), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls[0].reason, 'represented-bill');
  // A bill-type label, or a bills-only budget category it maps to, is not
  // a bill without a planned-bill match (Budget audit #922): it is
  // household spending that needs confirmation, the same unresolved surface.
  w.classification = classificationFixture('bill-label');
  assert.deepEqual(await w.prepare(2), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls[1].reason, 'bills-only-unmatched');
  assert.equal(w.classifyCalls[1].needsConfirmation, true);
  // Bills-only matched-category control.
  w.classification = classificationFixture('bill-bills-only');
  assert.deepEqual(await w.prepare(3), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls[2].reason, 'bills-only-unmatched');
  assert.equal(w.classifyCalls[2].needsConfirmation, true);
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E E6: credit evidence is refused by existing validation; a refund verdict is unresolved', async t => {
  const w = await world(t);
  // E6a: credit-direction evidence never reaches an eligibility answer —
  // the existing evidence validation refuses it as prepare-unavailable.
  const credit = resolved(); credit.evidence.direction = 'credit'; w.source = credit;
  assert.deepEqual(await w.prepare(1), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(w.count('prepare'), 0);
  // E6b: a debit-shaped row whose verdict is refund is unresolved.
  w.source = resolved();
  w.classification = classificationFixture('refund');
  assert.deepEqual(await w.prepare(2), { status: 'unavailable', reason: 'selection-eligibility-unresolved' });
  assert.equal(w.classifyCalls.at(-1).kind, 'refund');
  assert.deepEqual(w.writes, []);
});

test('Rule E E5: label drift to transfer with all six evidence fields unchanged is selection-changed', async t => {
  const w = await world(t);
  await w.prepare();
  // Only the provider category label moves (Groceries -> Credit Card
  // Payment). The evidence sextuple, bindings, goal and asOf are untouched;
  // categoryLabel is not one of the six evidence fields.
  w.classification = classificationFixture('transfer');
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E: groceries to restaurants category drift changes the projection and is selection-changed', async t => {
  const w = await world(t);
  await w.prepare();
  // Still an eligible spend class at confirm — but the retained projection
  // (categoryId groceries) is not the fresh one (restaurants), so the owner
  // is no longer confirming the selection that was prepared. This corrects
  // the clarification packet's claim that any differing fresh verdict is
  // necessarily a class change.
  w.classification = classificationFixture('spend-restaurants');
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E: classification-context drift with unchanged transaction, evidence and bindings is selection-changed', async t => {
  const w = await world(t);
  await w.prepare();
  // The transaction object, the six evidence fields, selectionBinding and
  // goalBinding are all identical; only the classification context changes:
  // the current-period packet now represents this transaction as a bill.
  const drifted = classificationFixture('spend-groceries');
  drifted.opts.currentPeriodActuals.representedActuals = [{ transactionId: drifted.tx.id }];
  w.classification = drifted;
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'selection-changed' });
  assert.equal(w.classifyCalls.at(-1).kind, 'bill');
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: zero classify invocations fail prepare as prepare-unavailable', async t => {
  const w = await world(t);
  w.resolveHook = async () => resolved();
  assert.deepEqual(await w.prepare(), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: a second classify invocation is latched ambiguous even when the resolver swallows it', async t => {
  const w = await world(t);
  w.resolveHook = async input => {
    if (typeof input.classify === 'function') {
      w.classifyOnce(input);
      try { input.classify(clone(w.classification.tx), clone(w.classification.plan), clone(w.classification.opts)); }
      catch { /* resolver swallows the refusal; the latch must still fail the attempt */ }
    }
    return resolved();
  };
  assert.deepEqual(await w.prepare(), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: a classifier error swallowed by the resolver still fails prepare', async t => {
  const w = await world(t);
  const evilTx = {};
  Object.defineProperty(evilTx, 'accountRole', { enumerable: true,
    get() { throw Error('synthetic classifier failure'); } });
  w.resolveHook = async input => {
    if (typeof input.classify === 'function') {
      try { input.classify(evilTx, w.classification.plan, w.classification.opts); }
      catch { /* resolver swallows the classifier error; the closure recorded it */ }
    }
    return resolved();
  };
  assert.deepEqual(await w.prepare(), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: classifying a missing transaction is a protocol failure, not an eligibility answer', async t => {
  const w = await world(t);
  w.resolveHook = async input => {
    if (typeof input.classify === 'function') input.classify(null, w.classification.plan, w.classification.opts);
    return resolved();
  };
  assert.deepEqual(await w.prepare(), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: a late classify invocation after settlement refuses and cannot affect another attempt', async t => {
  const w = await world(t);
  let stashed = null;
  w.resolveHook = async input => {
    if (typeof input.classify === 'function') { stashed = input.classify; w.classifyOnce(input); }
    return resolved();
  };
  assert.equal((await w.prepare()).status, 'prepared');
  assert.equal(typeof stashed, 'function', 'the resolver received the closure during its resolve window');
  assert.throws(() => stashed(clone(w.classification.tx), clone(w.classification.plan), clone(w.classification.opts)),
    /settlement-confirmation-unavailable/);
  w.resolveHook = null;
  const calls = w.classifyCalls.length;
  assert.equal((await w.prepare(2)).status, 'prepared', 'the dead closure cannot mutate a later attempt');
  assert.equal(w.classifyCalls.length, calls + 1, 'the later attempt classified exactly once, through its own closure');
  assert.equal((await w.confirm()).status, 'committed');
});

test('Rule E protocol: concurrent prepares keep their classify closures isolated', async t => {
  const w = await world(t), entered = deferred(), release = deferred();
  let resolves = 0;
  w.resolveHook = async input => {
    resolves++;
    if (resolves === 1) {
      entered.resolve(); await release.promise;
      w.classification = classificationFixture('spend-groceries');
    } else {
      w.classification = classificationFixture('transfer');
    }
    w.classifyOnce(input);
    return resolved();
  };
  const first = w.prepare(1);
  await entered.promise;
  assert.deepEqual(await w.prepare(2), { status: 'rejected', reason: 'selection-ineligible' },
    'the second attempt is judged by its own verdict, not the paused first attempt');
  release.resolve();
  assert.equal((await first).status, 'prepared');
  w.resolveHook = null;
  w.classification = classificationFixture('spend-groceries');
  assert.equal((await w.confirm()).status, 'committed');
});

test('Rule E protocol: resolver-returned verdict fields fail qualification', async t => {
  const w = await world(t);
  w.resolveHook = async input => {
    w.classifyOnce(input);
    return { ...resolved(), classification: { kind: 'spend', categoryId: 'groceries',
      householdSpending: true, reason: null, needsConfirmation: false } };
  };
  assert.deepEqual(await w.prepare(1), { status: 'unavailable', reason: 'prepare-unavailable' });
  w.resolveHook = async input => {
    w.classifyOnce(input);
    return { ...resolved(), verdict: w.classifyCalls.at(-1) };
  };
  assert.deepEqual(await w.prepare(2), { status: 'unavailable', reason: 'prepare-unavailable' },
    'even the genuine verdict, handed back as data, is a shape violation: no code path reads a supplied verdict');
  assert.equal(w.count('prepare'), 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E protocol: confirm re-resolve without classification is selection-unavailable and keeps the preview', async t => {
  const w = await world(t);
  await w.prepare();
  w.resolveHook = async () => resolved();
  assert.deepEqual(await w.confirm(), { status: 'rejected', reason: 'selection-unavailable' });
  w.resolveHook = null;
  assert.equal((await w.confirm()).status, 'committed', 'a protocol refusal does not retire the preview');
});

test('Rule E: the original committed receipt takes precedence over later ineligibility', async t => {
  const w = await world(t);
  await w.prepare();
  const receipt = await w.confirm();
  assert.equal(receipt.status, 'committed');
  // Classification later drifts to a class that would be refused at prepare.
  w.classification = classificationFixture('transfer');
  const calls = w.classifyCalls.length, resolves = w.count('resolve');
  assert.deepEqual(await w.confirm(), receipt);
  assert.deepEqual(await w.outcome(), receipt);
  assert.equal(w.classifyCalls.length, calls, 'the original receipt is read before any re-classification');
  assert.equal(w.count('resolve'), resolves, 'the original receipt is read before any re-resolution');
});

// Repair pins for Systems Review BLOCKING B1 on PR #665 head cadfb7cc
// (comment 6310824501): resolveClassified must snapshot and qualify the
// resolved selection inside its own continuation, immediately after the
// resolver await — the base acquired+snapshotted in one continuation, and
// only owned data (the frozen snapshot and the owned projection) may cross
// the helper-to-caller await. Both tests inject a SYNCHRONOUS resolver
// directly into the controller, not through the suite's async wrapper: an
// async wrapper would absorb the very suspension under test. The existing
// later-mutation tests cover the store/authorization awaits, not this gap.

test('Rule E repair (PR #665 B1): synchronous-resolver mutation across the resolve boundary cannot defeat confirm drift detection', async t => {
  const w = await world(t);
  let commits = 0;
  const countingStore = {
    prepare: input => w.store.prepare(input),
    commitWithoutRecovery: input => { commits++; return w.store.commitWithoutRecovery(input); },
    outcome: input => w.store.outcome(input),
  };
  let mutateOnConfirm = false;
  const syncResolve = input => {
    w.classifyOnce(input);
    const fresh = resolved();
    if (mutateOnConfirm) {
      fresh.goalBinding = 'synthetic-changed-goal';
      // Two chained microtasks. The first runs before the helper's await
      // continuation, which must observe the changed binding in its own
      // snapshot; the second runs only after that continuation, restoring
      // the prepared value before any outer continuation could snapshot.
      Promise.resolve().then(() => { Promise.resolve().then(() => { fresh.goalBinding = 'synthetic-plan-goal-v1'; }); });
    }
    return fresh;
  };
  const controller = createSettlementEvidenceConfirmation({ householdId,
    authorize: w.authorize, resolveSelection: syncResolve, now: () => w.time, store: countingStore });
  const prepared = await controller.prepare(context, request());
  assert.equal(prepared.status, 'prepared');
  mutateOnConfirm = true;
  const result = await controller.confirm(context, { operationId: op(1), previewToken: prepared.previewToken, confirmed: true });
  assert.deepEqual(result, { status: 'rejected', reason: 'selection-changed' },
    'the selection observed at resolver completion is the one compared, not the later-restored foreign object');
  assert.equal(commits, 0, 'no commit may be attempted against the restored foreign object');
  assert.deepEqual(w.writes, []);
});

test('Rule E repair (PR #665 B1): synchronous-resolver mutation across the resolve boundary cannot rewrite a prepared selection', async t => {
  const w = await world(t);
  let commits = 0;
  const countingStore = {
    prepare: input => w.store.prepare(input),
    commitWithoutRecovery: input => { commits++; return w.store.commitWithoutRecovery(input); },
    outcome: input => w.store.outcome(input),
  };
  let mutate = true;
  const syncResolve = input => {
    w.classifyOnce(input);
    const fresh = resolved();
    if (mutate) {
      // Same chained-microtask restoration, aimed at prepare: the values
      // land only after the helper's continuation, so a snapshot taken in
      // that continuation retains the originally acquired selection.
      Promise.resolve().then(() => { Promise.resolve().then(() => {
        fresh.evidence.cents = 9000;
        fresh.selectionBinding = 'synthetic-mutated-binding';
      }); });
    }
    return fresh;
  };
  const controller = createSettlementEvidenceConfirmation({ householdId,
    authorize: w.authorize, resolveSelection: syncResolve, now: () => w.time, store: countingStore });
  const prepared = await controller.prepare(context, request());
  assert.equal(prepared.status, 'prepared');
  mutate = false;
  const receipt = await controller.confirm(context, { operationId: op(1), previewToken: prepared.previewToken, confirmed: true });
  assert.equal(receipt.status, 'committed',
    'the retained selection is the one acquired at prepare; a post-return mutation must not rewrite it');
  assert.equal(w.document().operations[0].command.evidence.cents, 6000, 'the committed command carries the acquired evidence, not the mutation');
  assert.equal(commits, 1);
});

// Rule E classify-lifetime regression coverage (follow-up to the accepted
// PR #665 finding). These pin CURRENT behavior; none is a runtime fix. The
// capability closes in the controller's resolution continuation/finally,
// after it acquires its owned selection, not at the exact instant the
// resolver's value or Promise fulfils. Ordering is proven with explicit
// order logs and deferred barriers only: no promise-state inspection, no
// timers or sleeps. classifyWith calls a captured closure on the fixture.
function classifyWith(w, classify) {
  return w.classifyOnce({ classify });
}

test('Rule E lifetime: sync resolver return — a microtask queued before return still runs inside the open window', async t => {
  const w = await world(t);
  const order = [];
  let stashed = null;
  const syncResolve = input => {
    stashed = input.classify;
    // Not classified synchronously: the only invocation is queued ahead of
    // the controller's await continuation, which is where closure happens.
    queueMicrotask(() => { order.push('queued-classify'); classifyWith(w, stashed); });
    order.push('resolver-returned');
    return resolved();
  };
  const controller = createSettlementEvidenceConfirmation({ householdId,
    authorize: w.authorize, resolveSelection: syncResolve, now: () => w.time,
    store: { ...w.store, prepare: input => { order.push('store-prepare'); return w.store.prepare(input); } } });
  const prepared = await controller.prepare(context, request());
  assert.equal(prepared.status, 'prepared', 'current behavior: the queued call is the single counted invocation');
  assert.deepEqual(order, ['resolver-returned', 'queued-classify', 'store-prepare']);
  assert.equal(w.classifyCalls.length, 1);
  assert.throws(() => classifyWith(w, stashed), /settlement-confirmation-unavailable/, 'closed once prepare has settled');
  assert.equal(w.classifyCalls.length, 1, 'the refused call recorded no verdict');
});

test('Rule E lifetime: already-fulfilled async resolver — a queued second call is still inside the window and latches the attempt', async t => {
  const w = await world(t);
  const order = [];
  // Directly injected async resolver (no world wrapper or hook adoption
  // ticks): the controller awaits this function's own already-fulfilled
  // promise, so only that single await separates return from closure.
  const asyncResolve = async input => {
    classifyWith(w, input.classify); order.push('first-classify');
    queueMicrotask(() => {
      order.push('queued-second');
      try { classifyWith(w, input.classify); } catch { order.push('second-refused'); }
    });
    order.push('resolver-returned');
    return resolved();
  };
  let storeCalls = 0;
  const controller = createSettlementEvidenceConfirmation({ householdId,
    authorize: w.authorize, resolveSelection: asyncResolve, now: () => w.time,
    store: { ...w.store, prepare: input => { storeCalls++; order.push('store-prepare'); return w.store.prepare(input); },
      commitWithoutRecovery: input => { storeCalls++; return w.store.commitWithoutRecovery(input); } } });
  assert.deepEqual(await controller.prepare(context, request()), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.deepEqual(order, ['first-classify', 'resolver-returned', 'queued-second', 'second-refused'],
    'the queued call ran before closure, was counted as a second invocation and no store call followed');
  assert.equal(storeCalls, 0);
  assert.deepEqual(w.writes, []);
});

test('Rule E lifetime: genuinely pending resolver — the window stays open until the barrier releases, then closes', async t => {
  const w = await world(t);
  const order = [];
  const entered = deferred(), release = deferred();
  let stashed = null;
  w.resolveHook = async input => {
    stashed = input.classify; entered.resolve();
    await release.promise;
    order.push('resolver-resumed');
    return resolved();
  };
  const pending = w.prepare();
  await entered.promise;
  // Control: the resolve call is genuinely pending, so this external call
  // is the attempt's single invocation, not a post-closure call.
  classifyWith(w, stashed); order.push('classified-while-pending');
  release.resolve();
  const prepared = await pending;
  order.push('prepare-settled');
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(order, ['classified-while-pending', 'resolver-resumed', 'prepare-settled']);
  assert.throws(() => classifyWith(w, stashed), /settlement-confirmation-unavailable/);
  assert.equal(w.classifyCalls.length, 1);
});

test('Rule E lifetime: post-closure calls throw, record nothing and preserve prepared and committed state', async t => {
  const w = await world(t);
  const stashed = [];
  w.resolveHook = async input => { stashed.push(input.classify); classifyWith(w, input.classify); return w.source; };
  assert.equal((await w.prepare()).status, 'prepared');
  const verdicts = w.classifyCalls.length;
  for (let i = 0; i < 3; i++) {
    assert.throws(() => classifyWith(w, stashed[0]), /settlement-confirmation-unavailable/, 'every repeated post-closure call refuses');
  }
  assert.equal(w.classifyCalls.length, verdicts, 'refused calls recorded no verdict');
  assert.deepEqual(w.writes, [], 'post-closure calls never reach the store');
  const receipt = await w.confirm();
  assert.equal(receipt.status, 'committed', 'the retained preview and token are unaffected');
  assert.equal(stashed.length, 2, 'confirm re-resolved through its own fresh closure');
  const before = w.document();
  for (const dead of stashed) assert.throws(() => classifyWith(w, dead), /settlement-confirmation-unavailable/);
  assert.deepEqual(w.document(), before, 'a post-closure call does not retroactively undo a completed attempt');
  assert.deepEqual(await w.outcome(), receipt, 'the original receipt is still read back unchanged');
});

test('Rule E lifetime: multiple in-window calls fail the attempt regardless of count; a later clean attempt is unaffected', async t => {
  const w = await world(t);
  for (const extra of [1, 2]) {
    w.resolveHook = async input => {
      classifyWith(w, input.classify);
      for (let i = 0; i < extra; i++) assert.throws(() => classifyWith(w, input.classify), /settlement-confirmation-unavailable/);
      return resolved();
    };
    assert.deepEqual(await w.prepare(extra), { status: 'unavailable', reason: 'prepare-unavailable' });
  }
  assert.equal(w.count('prepare'), 0);
  w.resolveHook = null;
  assert.equal((await w.prepare(3)).status, 'prepared');
  assert.equal((await w.confirm(3)).status, 'committed');
});

test('Rule E lifetime: swallowed-error controls — a dead closure refused inside a new window cannot taint that attempt', async t => {
  const w = await world(t);
  const order = [];
  let dead = null;
  w.resolveHook = async input => { dead = input.classify; classifyWith(w, input.classify); return resolved(); };
  assert.equal((await w.prepare()).status, 'prepared');
  w.resolveHook = async input => {
    // The resolver swallows the dead closure's refusal. That refusal belongs
    // to the closed session only; this attempt's own closure is untouched.
    try { classifyWith(w, dead); } catch { order.push('dead-refused-and-swallowed'); }
    classifyWith(w, input.classify); order.push('own-classify');
    return resolved();
  };
  const second = await w.prepare(2);
  assert.equal(second.status, 'prepared', 'control: swallowing a foreign refusal is not a protocol failure for this attempt');
  assert.deepEqual(order, ['dead-refused-and-swallowed', 'own-classify']);
  // Contrast: swallowing a refusal of this attempt's OWN second call still fails.
  w.resolveHook = async input => {
    classifyWith(w, input.classify);
    try { classifyWith(w, input.classify); } catch { order.push('own-second-swallowed'); }
    return resolved();
  };
  assert.deepEqual(await w.prepare(3), { status: 'unavailable', reason: 'prepare-unavailable' });
  assert.equal(order.at(-1), 'own-second-swallowed');
});

// ---------------------------------------------------------------------------
// P2 settled-uncertainty recovery (ATLAS-080): a private NO-ARGUMENT
// recovery capability is exposed only through an optional trusted
// construction-time registration callback. It captures the retained
// uncertain attempt itself (no caller context, operation ID, proof, reset
// flag or authority override), refuses while the commit/postauthorization
// invocation is in flight, and clears only that latch + attempted entry on
// exact committed/not-committed inspection proof AND store readiness. It
// returns only a maintenance acknowledgement and never retries the commit.

function captureRecovery(w, extraDeps = {}) {
  let recovery = null;
  const controller = w.newController(w.store, {
    ...extraDeps,
    registerRecovery: fn => { recovery = fn; },
  });
  return { controller, recovery: () => recovery };
}
const defaultAuth = w => async ctx => {
  if (ctx.ticket === otherContext.ticket) return { householdId, actorId: otherActor };
  if (ctx.ticket !== context.ticket) return null;
  return w.authority;
};

test('P2 recovery: public shape is unchanged and the capability arrives only via the registration callback', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  assert.equal(typeof recovery(), 'function', 'registration callback received the private capability');
  assert.equal(recovery().length, 0, 'the capability takes no arguments');
  assert.deepEqual(Object.keys(controller).sort(), ['confirm', 'outcome', 'prepare'],
    'public {prepare, confirm, outcome} shape preserved');
  assert.equal(controller.recover, undefined);
  assert.equal(controller.recoverSettledUncertainty, undefined);
  assert.equal(controller.reset, undefined);
  assert.deepEqual(await recovery()(), { status: 'idle' }, 'no uncertainty -> idle acknowledgement');
  privateFree(await recovery()());
  // Without the optional callback nothing is exposed and nothing breaks.
  const plain = w.newController();
  assert.deepEqual(Object.keys(plain).sort(), ['confirm', 'outcome', 'prepare']);
  assert.equal((await plain.prepare(context, request(9))).status, 'prepared');
});

test('P2 recovery acceptance 1: durable commit + postcommit authorization failure -> recovery releases, receipt stays actor-bound, next save works, commit called once', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  const prepared = await controller.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  let landed = false;
  w.commitHook = async (input, store) => {
    const result = await store.commitWithoutRecovery(input);
    landed = true;
    return result;
  };
  const auth = defaultAuth(w);
  w.authHook = async ctx => (landed && ctx.ticket === context.ticket ? null : auth(ctx));
  const unknownResult = await controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true });
  assert.deepEqual(unknownResult, { status: 'unknown', operationId: op(1) },
    'postcommit authorization failure surfaces unknown even though the commit is durable');
  assert.equal(w.document().operations.length, 1, 'the commit landed exactly once');
  assert.equal(w.count('commitWithoutRecovery'), 1);
  // Actor B still cannot read actor A's receipt, and B cannot clear the latch.
  assert.deepEqual(await controller.outcome(otherContext, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  assert.deepEqual(await controller.prepare(context, request(3)),
    { status: 'unavailable', reason: 'outcome-unresolved' }, 'latch still set after B probe');
  // TTL passing does not defeat the durable proof.
  w.time += C.TTL_MS + 1;
  // Recovery needs no caller context and no re-authorization (A auth is
  // still failing): it inspects the retained attempt itself.
  const ack = await recovery()();
  assert.deepEqual(ack, { status: 'resolved' });
  assert.deepEqual(Object.keys(ack), ['status'], 'acknowledgement carries no receipt/actor/financial data');
  privateFree(ack);
  assert.equal(w.count('commitWithoutRecovery'), 1, 'recovery never retries the original commit');
  assert.equal(w.document().operations.length, 1);
  // The original receipt is readable again by its owner only.
  w.authHook = null; w.commitHook = null;
  const receipt = await controller.outcome(context, { operationId: op(1) });
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.revision, 1);
  assert.deepEqual(await controller.outcome(otherContext, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) });
  // The next unrelated save works.
  const fixture2 = distinctTransaction(2);
  w.source = fixture2.source; w.classification = fixture2.classification;
  const prep2 = await controller.prepare(context, request(2, 1));
  assert.equal(prep2.status, 'prepared');
  const second = await controller.confirm(context,
    { operationId: op(2), previewToken: prep2.previewToken, confirmed: true });
  assert.equal(second.status, 'committed');
  assert.equal(second.revision, 2);
  assert.equal(w.count('commitWithoutRecovery'), 2);
});

test('P2 recovery acceptance 2+3: journal-resident attempt cannot unlock before explicit reconcile; R4 cleanup + fresh inspection retires it; no auto resubmission', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  const prepared = await controller.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  // Simulate journal landed / temp failed: a journal is resident in the
  // store and the commit invocation settled unknown.
  w.commitHook = async () => {
    fs.writeFileSync(path.join(w.dir, 'journal.json'),
      JSON.stringify({ version: 1, note: 'synthetic resident journal' }), { mode: 0o600 });
    return { status: 'unknown', reason: 'temp-write-failed' };
  };
  assert.deepEqual(await controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true }),
    { status: 'unknown', operationId: op(1) });
  assert.equal(w.count('commitWithoutRecovery'), 1);
  // Inspection sees the disposition (not committed at the exact base) but
  // the resident journal means the store is not ready: blocked.
  assert.deepEqual(await recovery()(), { status: 'blocked' });
  assert.ok(fs.existsSync(path.join(w.dir, 'journal.json')), 'recovery never clears a journal');
  assert.equal(w.document().operations.length, 0);
  assert.deepEqual(await controller.prepare(context, request(2)),
    { status: 'unavailable', reason: 'outcome-unresolved' });
  // Explicit reconciliation remains the separate path that cleans up.
  const report = await w.store.reconcile();
  assert.equal(report.row, 'R4');
  assert.equal(fs.existsSync(path.join(w.dir, 'journal.json')), false, 'R4 removed the journal');
  // Only now does a FRESH inspection retire the attempt.
  assert.deepEqual(await recovery()(), { status: 'resolved' });
  assert.equal(w.document().operations.length, 0, 'no auto resubmission of the retired attempt');
  assert.equal(w.count('commitWithoutRecovery'), 1, 'the original commit was never retried');
  // The old token cannot confirm fresh work; a fresh prepare + explicit
  // confirm is required.
  assert.notEqual((await controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true })).status, 'committed');
  assert.equal(w.count('commitWithoutRecovery'), 1);
  w.commitHook = null;
  const fresh = await controller.prepare(context, request(1));
  assert.equal(fresh.status, 'prepared');
  assert.notEqual(fresh.previewToken, prepared.previewToken);
  assert.equal((await controller.confirm(context,
    { operationId: op(1), previewToken: fresh.previewToken, confirmed: true })).status, 'committed');
});

test('P2 recovery acceptance 3: divergent or unreadable pin remains blocked even with a known base disposition', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  const prepared = await controller.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  w.commitHook = async () => ({ status: 'unknown', reason: 'lost-reply' });
  assert.equal((await controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true })).status, 'unknown');
  // Divergent pin: head no longer validates against the pin.
  const realPin = clone(w.pin);
  w.pin = { ...realPin, digest: 'f'.repeat(64) };
  assert.deepEqual(await recovery()(), { status: 'blocked' });
  assert.deepEqual(await controller.prepare(context, request(2)),
    { status: 'unavailable', reason: 'outcome-unresolved' }, 'latch preserved while blocked');
  // Unreadable pin.
  w.pin = realPin;
  w.unreadablePin = true;
  assert.deepEqual(await recovery()(), { status: 'blocked' });
  // Healed: exact-base not-committed proof + readiness resolves.
  w.unreadablePin = false;
  assert.deepEqual(await recovery()(), { status: 'resolved' });
  assert.equal(w.count('commitWithoutRecovery'), 1);
});

test('P2 recovery acceptance 4: a paused commit or postauthorization invocation blocks recovery; a waiter timeout is not settlement', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  // Paused commit.
  const prepared = await controller.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  const entered = deferred(), release = deferred();
  w.commitHook = async (input, store) => {
    entered.resolve(); await release.promise;
    return store.commitWithoutRecovery(input);
  };
  const pending = controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true });
  await entered.promise;
  assert.deepEqual(await recovery()(), { status: 'blocked' },
    'recovery refuses while the commit invocation is in flight');
  assert.deepEqual(await controller.prepare(context, request(2)),
    { status: 'unavailable', reason: 'outcome-unresolved' });
  release.resolve();
  assert.equal((await pending).status, 'committed');
  assert.deepEqual(await recovery()(), { status: 'idle' }, 'the settled invocation resolved itself');
  // Paused postauthorization (commit already returned, confirm not settled).
  const fixture2 = distinctTransaction(2);
  w.source = fixture2.source; w.classification = fixture2.classification;
  const prep2 = await controller.prepare(context, request(2, 1));
  assert.equal(prep2.status, 'prepared');
  const enteredAuth = deferred(), releaseAuth = deferred();
  let pauseArmed = false;
  w.commitHook = async (input, store) => {
    const result = await store.commitWithoutRecovery(input);
    pauseArmed = true;
    return result;
  };
  const auth = defaultAuth(w);
  w.authHook = async ctx => {
    if (pauseArmed) { pauseArmed = false; enteredAuth.resolve(); await releaseAuth.promise; }
    return auth(ctx);
  };
  const pending2 = controller.confirm(context,
    { operationId: op(2), previewToken: prep2.previewToken, confirmed: true });
  await enteredAuth.promise;
  assert.deepEqual(await recovery()(), { status: 'blocked' },
    'recovery refuses while the postauthorization phase is in flight');
  releaseAuth.resolve();
  assert.equal((await pending2).status, 'committed');
  assert.equal(w.count('commitWithoutRecovery'), 2, 'exactly one commit per operation');
});

test('P2 recovery acceptance 5+7: caller arguments are not proof — recovery captures only the retained attempt and leaves other generations untouched', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  const prep1 = await controller.prepare(context, request(1));
  const prep2 = await controller.prepare(context, request(2, 1));
  assert.equal(prep1.status, 'prepared');
  assert.equal(prep2.status, 'prepared');
  w.commitHook = async () => ({ status: 'unknown', reason: 'lost-reply' });
  assert.equal((await controller.confirm(context,
    { operationId: op(1), previewToken: prep1.previewToken, confirmed: true })).status, 'unknown');
  w.commitHook = null;
  // Forged caller context/proof/reset aimed at operation 2 changes nothing:
  // the capability is no-argument and acts only on the retained attempt.
  const ack = await recovery()({ operationId: op(2), actorId: otherActor, proof: 'forged', reset: true });
  assert.deepEqual(ack, { status: 'resolved' });
  assert.deepEqual(Object.keys(ack), ['status']);
  // Operation 2's generation survived: it still confirms with its own token.
  const second = await controller.confirm(context,
    { operationId: op(2), previewToken: prep2.previewToken, confirmed: true });
  assert.equal(second.status, 'committed');
  assert.equal(w.document().operations.length, 1, 'only operation 2 ever landed; operation 1 was not resubmitted');
  assert.equal(w.count('commitWithoutRecovery'), 2);
});

test('P2 recovery acceptance 6: a delayed inspection cannot clear a replaced generation or a newer uncertainty', async t => {
  const w = await world(t);
  const { controller, recovery } = captureRecovery(w);
  const prepared = await controller.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  let landed = false;
  w.commitHook = async (input, store) => {
    const result = await store.commitWithoutRecovery(input);
    landed = true;
    return result;
  };
  const auth = defaultAuth(w);
  w.authHook = async ctx => (landed && ctx.ticket === context.ticket ? null : auth(ctx));
  assert.equal((await controller.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true })).status, 'unknown');
  w.authHook = null; w.commitHook = null;
  // Recovery starts; its inspection is delayed and will return a stale
  // committed+ready verdict for operation 1.
  const entered = deferred(), release = deferred();
  w.inspectHook = async () => {
    entered.resolve(); await release.promise;
    return { disposition: 'committed', ready: true };
  };
  const pendingRecovery = recovery()();
  await entered.promise;
  // A legitimate resolution happens first: the owner's outcome read finds
  // the durable receipt, clearing the latch and retiring the entry.
  const receipt = await controller.outcome(context, { operationId: op(1) });
  assert.equal(receipt.status, 'committed');
  // A NEW uncertainty is latched for a different operation/generation.
  const fixture2 = distinctTransaction(2);
  w.source = fixture2.source; w.classification = fixture2.classification;
  const prep2 = await controller.prepare(context, request(2, 1));
  assert.equal(prep2.status, 'prepared');
  w.commitHook = async () => ({ status: 'unknown', reason: 'lost-reply' });
  assert.equal((await controller.confirm(context,
    { operationId: op(2), previewToken: prep2.previewToken, confirmed: true })).status, 'unknown');
  const commitsForOp2 = w.count('commitWithoutRecovery');
  release.resolve();
  assert.deepEqual(await pendingRecovery, { status: 'obsolete' },
    'the delayed stale proof must not clear the newer uncertainty');
  assert.deepEqual(await controller.prepare(context, request(3)),
    { status: 'unavailable', reason: 'outcome-unresolved' }, 'new latch preserved');
  assert.equal((await controller.confirm(context,
    { operationId: op(2), previewToken: prep2.previewToken, confirmed: true })).status, 'unknown');
  assert.equal(w.count('commitWithoutRecovery'), commitsForOp2, 'no retry of the newer attempt');
  // A fresh recovery (real inspection) resolves the newer attempt on its
  // own proof: it never landed, at the exact current base, journal absent.
  w.inspectHook = null; w.commitHook = null;
  assert.deepEqual(await recovery()(), { status: 'resolved' });
});

test('P2 recovery: a store without inspectAttempt cannot prove anything — blocked, latch preserved', async t => {
  const w = await world(t);
  let bareRecovery = null;
  const bare = createSettlementEvidenceConfirmation({
    householdId, authorize: w.authorize, resolveSelection: w.resolve, now: () => w.time,
    registerRecovery: fn => { bareRecovery = fn; },
    store: {
      prepare: input => w.store.prepare(input),
      commitWithoutRecovery: async () => ({ status: 'unknown', reason: 'lost-reply' }),
      outcome: input => w.store.outcome(input),
    },
  });
  const prepared = await bare.prepare(context, request(1));
  assert.equal(prepared.status, 'prepared');
  assert.equal((await bare.confirm(context,
    { operationId: op(1), previewToken: prepared.previewToken, confirmed: true })).status, 'unknown');
  assert.equal(typeof bareRecovery, 'function');
  assert.deepEqual(await bareRecovery(), { status: 'blocked' });
  assert.deepEqual(await bare.prepare(context, request(2)),
    { status: 'unavailable', reason: 'outcome-unresolved' });
  assert.equal(w.document().operations.length, 0);
});

// === Write admission (fenced resolver/store pair) =========================
// A controller constructed with BOTH trusted capabilities — a paired
// resolver (resolvePairedSelection) and the store's admission capability
// (commitAdmitted) — runs fenced for its whole lifetime: confirm carries
// the witness paired with its FRESH confirm-time resolution (never
// prepare's) through the probe and authorization waits into commitAdmitted,
// and never touches commitWithoutRecovery. A definite admission refusal
// retires the attempted preview and clears the uncertainty latch through
// the same postauthorization discipline as every other definitive outcome.
// Exactly one capability present (or a non-function value) refuses
// construction: there is no partial or fallback mode.
function fencedController(w, extra = {}) {
  const resolvePairedSelection = async input => {
    if (w.pairedHook) return w.pairedHook(input);
    const selection = await w.resolve(input);
    if (!selection || typeof selection !== 'object') return selection;
    const witness = typeof w.mintWitness === 'function' ? w.mintWitness() : w.currentWitness;
    return { selection, witness };
  };
  return w.newController(w.store, {
    resolvePairedSelection,
    commitAdmitted: async (input, witness) => {
      w.calls.push('commitAdmitted');
      w.admittedWitness = witness;
      if (w.admissionHook) return w.admissionHook(input, witness, w.store);
      return w.store.commitAdmitted(input, witness);
    },
    ...extra,
  });
}
const fencedPrepare = async (w, controller, n = 1, cents = 2500) => {
  const result = await controller.prepare(context, request(n, cents));
  if (result.status === 'prepared') w.tokens.set(op(n), result.previewToken);
  return result;
};
const fencedConfirm = (w, controller, n = 1) => controller.confirm(context,
  { operationId: op(n), confirmed: true, previewToken: w.tokens.get(op(n)) });

test('WA-C1 the fenced pair is selected whole at construction; partial setup refuses', async t => {
  const w = await world(t);
  const base = { householdId, authorize: w.authorize, resolveSelection: w.resolve, now: () => w.time, store: w.store };
  assert.throws(() => createSettlementEvidenceConfirmation({ ...base,
    resolvePairedSelection: async () => null }), /incomplete trusted dependencies/,
    'paired resolver without the admission capability refuses');
  assert.throws(() => createSettlementEvidenceConfirmation({ ...base,
    commitAdmitted: async () => ({}) }), /incomplete trusted dependencies/,
    'admission capability without the paired resolver refuses');
  assert.throws(() => createSettlementEvidenceConfirmation({ ...base,
    resolvePairedSelection: 'paired', commitAdmitted: async () => ({}) }), /incomplete trusted dependencies/);
  assert.throws(() => createSettlementEvidenceConfirmation({ ...base,
    resolvePairedSelection: async () => null, commitAdmitted: 42 }), /incomplete trusted dependencies/);
  const fenced = createSettlementEvidenceConfirmation({ ...base,
    resolvePairedSelection: async () => null, commitAdmitted: async () => ({}) });
  assert.deepEqual(Object.keys(fenced).sort(), ['confirm', 'outcome', 'prepare'],
    'the fenced controller exposes the same public surface');
});

test('WA-C2 fenced confirm commits through commitAdmitted with the confirm-time witness only', async t => {
  const w = await world(t);
  const issued = [];
  w.mintWitness = () => { const witness = () => true; issued.push(witness); return witness; };
  const controller = fencedController(w);
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  const receipt = await fencedConfirm(w, controller);
  assert.equal(receipt.status, 'committed');
  assert.equal(issued.length, 2, 'one paired resolution at prepare, one at confirm');
  assert.equal(w.admittedWitness, issued[1],
    'the witness carried into admission is the fresh confirm-time one, not prepare\u2019s');
  assert.notEqual(w.admittedWitness, issued[0]);
  assert.equal(w.count('commitAdmitted'), 1);
  assert.equal(w.count('commitWithoutRecovery'), 0, 'fenced mode never falls back');
  assert.equal(w.document().operations.length, 1);
});

test('WA-C3 a definite admission refusal retires the preview and clears the latch', async t => {
  const w = await world(t);
  let admit = false;
  w.currentWitness = () => admit;
  const controller = fencedController(w);
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  const refused = await fencedConfirm(w, controller);
  assert.deepEqual(refused, { status: 'rejected', reason: 'admission-refused' });
  assert.equal(w.document().operations.length, 0, 'nothing was written');
  assert.deepEqual(await fencedConfirm(w, controller), { status: 'unknown', operationId: op(1) },
    'the attempted preview is retired; no second admission is possible');
  // Fresh work needs a fresh prepare and an explicit confirm.
  admit = true;
  assert.equal((await fencedPrepare(w, controller, 2)).status, 'prepared',
    'the uncertainty latch was cleared by the definite refusal');
  assert.equal((await fencedConfirm(w, controller, 2)).status, 'committed');
  assert.equal(w.document().operations.length, 1);
});

test('WA-C4 the witness is carried through the confirm probe wait unchanged', async t => {
  const w = await world(t);
  const issued = [];
  w.mintWitness = () => { const witness = () => true; issued.push(witness); return witness; };
  const controller = fencedController(w);
  // Gate the confirm-time store.prepare probe (the second prepare call —
  // the first is prepare()'s own): admission must not happen until the
  // probe releases, and the witness that finally reaches commitAdmitted
  // is still the confirm-time one.
  let releaseProbe, probeEntered;
  const gate = new Promise(resolve => { releaseProbe = resolve; });
  const entered = new Promise(resolve => { probeEntered = resolve; });
  let prepareCalls = 0;
  w.prepareHook = async (input, store) => {
    prepareCalls++;
    if (prepareCalls === 2) { probeEntered(); await gate; }
    return store.prepare(input);
  };
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  const pending = fencedConfirm(w, controller);
  await entered;
  assert.equal(w.count('commitAdmitted'), 0, 'no admission while the probe is held');
  releaseProbe();
  const receipt = await pending;
  assert.equal(receipt.status, 'committed');
  assert.equal(issued.length, 2, 'one paired resolution at prepare, one at confirm');
  assert.equal(w.admittedWitness, issued[1]);
});

test('WA-C5 postauthorization failure after an admission refusal preserves the P2 latch', async t => {
  const w = await world(t);
  w.currentWitness = () => false;
  let recover;
  const controller = fencedController(w, { registerRecovery: fn => { recover = fn; } });
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  // The store refuses admission definitely, but the post-commit
  // authorization re-check then fails: uncertainty is NOT cleared.
  w.admissionHook = async (input, witness, store) => {
    const result = await store.commitAdmitted(input, witness);
    w.authHook = async () => ({ householdId, actorId: otherActor });
    return result;
  };
  const result = await fencedConfirm(w, controller);
  assert.deepEqual(result, { status: 'unknown', operationId: op(1) });
  w.authHook = null;
  assert.deepEqual(await controller.outcome(context, { operationId: op(1) }),
    { status: 'unknown', operationId: op(1) }, 'the latch is retained');
  assert.equal((await controller.prepare(context, request(2))).status, 'unavailable',
    'new work is blocked while the latch holds');
  // P2 resolves it on the store's read-only proof: nothing was written and
  // the pinned head is exactly the preview's base.
  assert.deepEqual(await recover(), { status: 'resolved' });
  w.currentWitness = () => true;
  assert.equal((await fencedPrepare(w, controller, 2)).status, 'prepared');
});

test('WA-C6 fenced mode never falls back when admission is unavailable or unknown', async t => {
  const w = await world(t);
  w.currentWitness = () => true;
  const controller = fencedController(w);
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  w.admissionHook = async () => ({ status: 'unavailable', reason: 'synthetic-store-busy' });
  const result = await fencedConfirm(w, controller);
  assert.deepEqual(result, { status: 'unknown', operationId: op(1) });
  assert.equal(w.count('commitWithoutRecovery'), 0);
  assert.equal(w.document().operations.length, 0);
});

test('WA-C7 a caller cannot inject a witness through the confirm request or context', async t => {
  const w = await world(t);
  w.currentWitness = () => true;
  const controller = fencedController(w);
  const prepared = await fencedPrepare(w, controller);
  assert.equal(prepared.status, 'prepared');
  const injected = await controller.confirm(context, { operationId: op(1), confirmed: true,
    previewToken: prepared.previewToken, witness: () => false });
  assert.equal(injected.status, 'unavailable', 'request shapes are unchanged; extra keys refuse');
  const injectedContext = await controller.confirm({ ticket: context.ticket, witness: () => false },
    { operationId: op(1), confirmed: true, previewToken: prepared.previewToken });
  assert.equal(injectedContext.status, 'unavailable');
  assert.equal(w.count('commitAdmitted'), 0, 'no admission was attempted');
  assert.equal((await fencedConfirm(w, controller)).status, 'committed',
    'the retained preview is untouched by the refused injections');
});

test('WA-C8 the original receipt precedes fenced resolution despite a broken paired path', async t => {
  const w = await world(t);
  w.currentWitness = () => true;
  const controller = fencedController(w);
  assert.equal((await fencedPrepare(w, controller)).status, 'prepared');
  assert.equal((await fencedConfirm(w, controller)).status, 'committed');
  const resolveCalls = w.count('resolve'), admittedCalls = w.count('commitAdmitted');
  w.pairedHook = async () => { throw new Error('synthetic paired resolver failure'); };
  const again = await fencedConfirm(w, controller);
  assert.equal(again.status, 'committed', 'the durable receipt is read before any re-resolution');
  assert.equal(again.operationId, op(1));
  assert.equal(w.count('resolve'), resolveCalls, 'no fresh resolution was needed');
  assert.equal(w.count('commitAdmitted'), admittedCalls, 'no second admission was attempted');
});

test('WA-C9 malformed paired results fail closed before any store call', async t => {
  const w = await world(t);
  for (const [name, paired] of [
    ['missing witness', async input => ({ selection: await w.resolve(input) })],
    ['non-function witness', async input => ({ selection: await w.resolve(input), witness: 'fresh' })],
    ['null result', async () => null],
  ]) {
    w.pairedHook = paired;
    const controller = fencedController(w);
    const result = await controller.prepare(context, request(1));
    assert.equal(result.status, 'unavailable', name + ': prepare fails closed');
    assert.equal(w.count('prepare'), 0, name + ': the store was never called');
    w.pairedHook = null;
  }
  // An accessor witness is never invoked: the pairing is read by descriptor.
  let getterCalls = 0;
  w.pairedHook = async input => {
    const pair = { selection: await w.resolve(input) };
    Object.defineProperty(pair, 'witness', { enumerable: true,
      get() { getterCalls++; return () => true; } });
    return pair;
  };
  const controller = fencedController(w);
  assert.equal((await controller.prepare(context, request(1))).status, 'unavailable');
  assert.equal(getterCalls, 0, 'the witness accessor was not invoked');
});

test('D1 controller negative excludes a second live controller with a valid prepared generation', async () => {
 const X=require('./test-settlement-evidence-terminal-certificate'),w=X.makeExclusionWorld();
 let drift=false;
 const create=(change=false)=>{const store=w.newStore({wrap:true});
  const resolve=async input=>{const f=classificationFixture();input.classify(f.tx,f.plan,f.opts);const value=resolved();if(change&&drift)value.selectionBinding+='-changed';return value;};
  return createSettlementEvidenceConfirmation({householdId,store,now:()=>w.time,authorize:async()=>({householdId,actorId}),resolveSelection:resolve});
 };
 const a=create(true),b=create(),r=request(1),p=await a.prepare(context,r),q=await b.prepare(context,r);
 assert.equal(p.status,'prepared');assert.equal(q.status,'prepared');drift=true;
 assert.equal((await a.confirm(context,{operationId:op(1),previewToken:p.previewToken,generation:p.generation,confirmed:true})).status,'not-applied');
 const result=await b.confirm(context,{operationId:op(1),previewToken:q.previewToken,generation:q.generation,confirmed:true});
 assert.notEqual(result.status,'committed','process-local negative must become store-wide exclusion');
 assert.deepEqual(w.writes,[]);assert.equal(w.records().length,1);
});

test('D1 native controller terminalizing ownership survives revocation sweep P2 and duplicate confirms',{timeout:5000},async()=>{
 const w=d1ControllerWorld(),a=w.create(),b=w.create(),p=await a.controller.prepare(context,request(1));
 const q=await b.controller.prepare(context,request(1)),seen=deferred(),gate=deferred();
 w.hooks.append=async perform=>{seen.resolve();await gate.promise;return perform();};
 w.drift=true;
 const pending=a.controller.confirm(context,d1Confirm(p));await seen.promise;
 try{
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown');
  assert.equal((await a.recovery()).status,'blocked');
  w.time+=C.TTL_MS;
  assert.equal((await a.controller.prepare(context,request(2))).reason,'outcome-unresolved');
  w.authorized=false;gate.resolve();assert.equal((await pending).status,'unknown');
  w.authorized=true;
  assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown');
  assert.equal((await a.recovery()).status,'blocked');
  assert.equal((await a.controller.prepare(context,request(3))).reason,'outcome-unresolved');
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  assert.notEqual((await b.controller.confirm(context,d1Confirm(q))).status,'committed');
  assert.equal(w.appends,1);assert.equal(w.records().length,1);assert.deepEqual(w.writes,[]);
 }finally{gate.resolve();}
});
test('D1 native controller lost or failed seal acknowledgement never cleans up or retries',async()=>{
 for(const landed of [false,true]){
  const w=d1ControllerWorld(),a=w.create(),b=w.create(),p=await a.controller.prepare(context,request(1));
  const q=await b.controller.prepare(context,request(1));w.drift=true;
  w.hooks.append=perform=>{if(landed)perform();throw Error('synthetic lost seal acknowledgement');};
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  assert.equal(w.records().length,landed?1:0);assert.equal(w.appends,1);w.drift=false;
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  assert.equal((await a.recovery()).status,'blocked');
  w.time+=C.TTL_MS;assert.equal((await a.controller.prepare(context,request(2))).reason,'outcome-unresolved');
  w.time-=C.TTL_MS;
  const r=await b.controller.confirm(context,d1Confirm(q));
  if(landed)assert.notEqual(r.status,'committed');else assert.equal(r.status,'committed','no landed seal means no durable negative is claimed');
  assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown','even a positive read cannot steal terminalizing ownership');
  assert.equal((await a.recovery()).status,'blocked');assert.equal(w.appends,1);
 }
});
test('D1 suspended confirmation cannot write after native terminalization even after clock restoration',{timeout:5000},async()=>{
 const w=d1ControllerWorld(),seen=deferred(),gate=deferred();let hold=false;
 const a=w.create({resolveHook:async()=>{if(hold){hold=false;seen.resolve();await gate.promise;}}});
 const p=await a.controller.prepare(context,request(1));hold=true;
 const pending=a.controller.confirm(context,d1Confirm(p));await seen.promise;
 try{
  w.time+=C.TTL_MS;assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'not-applied');
  w.time-=C.TTL_MS;gate.resolve();assert.notEqual((await pending).status,'committed');
  assert.equal(w.records().length,1);assert.deepEqual(w.writes,[]);
 }finally{gate.resolve();}
});
test('D1 native controller funnels only proven terminal reasons and keeps postjournal uncertainty',async()=>{
 for(const mode of ['expiry','selection','admission','store-expiry','journal']){
  const w=d1ControllerWorld(),a=w.create({fenced:true,commitHook:()=>{if(mode==='store-expiry')w.time+=C.TTL_MS;}});
  const p=await a.controller.prepare(context,request(1));assert.equal(p.status,'prepared');
  if(mode==='expiry')w.time+=C.TTL_MS;if(mode==='selection')w.drift=true;if(mode==='admission')w.fresh=false;
  if(mode==='journal')w.hooks.journal=perform=>{perform();throw Error('synthetic journal lost acknowledgement');};
  const r=await a.controller.confirm(context,d1Confirm(p));
  assert.equal(r.status,mode==='journal'?'unknown':'not-applied',mode);
  assert.equal(w.records().length,mode==='journal'?0:1);
  if(mode==='journal'){assert.equal((await a.recovery()).status,'blocked');assert.equal(w.appends,0);}
  else{assert.deepEqual(w.writes,[]);assert.equal((await a.recovery()).status,'idle');
   assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown','no negative outcome/browser integration');}
 }
});
function d1Confirm(p){return {operationId:p.operationId,previewToken:p.previewToken,generation:p.generation,confirmed:true};}
function d1ControllerWorld(){
 const X=require('./test-settlement-evidence-terminal-certificate'),w=X.makeExclusionWorld();
 w.authorized=true;w.drift=false;w.fresh=true;
 w.create=(options={})=>{
  const store=w.newStore({wrap:true});let recovery;
  if(options.lookup)store.terminalExclusion={...store.terminalExclusion,lookupCertificate:options.lookup};
  const resolve=async input=>{
   const f=classificationFixture();input.classify(f.tx,f.plan,f.opts);
   if(options.resolveHook)await options.resolveHook();
   const value=resolved();if(w.drift)value.selectionBinding+='-changed';return value;
  };
  const controller=createSettlementEvidenceConfirmation({householdId,store,now:()=>w.time,
   authorize:async ctx=>{if(!w.authorized)throw Error('synthetic revoked');return {householdId,actorId:ctx.ticket===otherContext.ticket?otherActor:actorId};},
   resolveSelection:resolve,registerRecovery:cap=>{recovery=cap;},
   ...(options.fenced?{resolvePairedSelection:async input=>({selection:await resolve(input),witness:()=>w.fresh}),
    commitAdmitted:async(input,witness)=>{if(options.commitHook)options.commitHook();return store.commitAdmitted(input,witness);}}:{})});
  return {controller,recovery,store};
 };return w;
}

test('D1 Addendum A C7 gated history has no old terminal lifetime quota',{timeout:120000},async()=>{
 const w=d1ControllerWorld(),a=w.create();
 for(let n=1;n<=1001;n++){
  const p=await a.controller.prepare(context,request(n));assert.equal(p.status,'prepared','gated prepare '+n);
  w.time+=C.TTL_MS;
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'not-applied','gated seal '+n);
 }
 assert.equal(w.records().length,1001);assert.equal(w.appends,1001);assert.deepEqual(w.writes,[]);
 const p=await a.controller.prepare(context,request(2000));assert.equal(p.status,'prepared');
 w.historyBytes=null;w.time+=C.TTL_MS;
 assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown','cache can never bypass missing durable authority');
 assert.equal((await a.recovery()).status,'blocked');
});

test('D1 late real committed outcome cannot steal a terminalizing entry',{timeout:5000},async()=>{
 const w=d1ControllerWorld(),a=w.create(),b=w.create(),p=await a.controller.prepare(context,request(1)),q=await b.controller.prepare(context,request(1));
 assert.equal((await b.controller.confirm(context,d1Confirm(q))).status,'committed');
 const actual=a.store.outcome,seen=deferred(),gate=deferred();let reads=0;
 a.store.outcome=async input=>{
  const n=++reads;
  if(n===2){w.hooks.pinRead=()=>{throw Error('synthetic transient pin read failure');};
   try{return await actual(input);}finally{delete w.hooks.pinRead;}}
  const result=await actual(input);
  if(n===1){assert.equal(result.status,'committed');seen.resolve();await gate.promise;}return result;
 };
 const pending=a.controller.outcome(context,{operationId:op(1)});await seen.promise;
 try{
  w.time=p.expiresAt;
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown','commit winner cannot be sealed negative');
  gate.resolve();assert.equal((await pending).status,'unknown','captured positive cannot clear newer terminalizing ownership');
  assert.equal((await a.recovery()).status,'blocked');
  assert.equal((await a.controller.prepare(context,request(2))).reason,'outcome-unresolved');
  assert.equal(w.records().length,0);assert.equal(w.appends,0);
  assert.equal((await b.controller.outcome(context,{operationId:op(1)})).status,'committed','real receipt remains authoritative at its unlatched reader');
 }finally{gate.resolve();}
});
test('D1 attempted prejournal terminal uncertainty cannot be cleared by exact-base P2 inspection',async()=>{
 for(const mode of ['admission','expiry','revocation']){
  const w=d1ControllerWorld(),a=w.create({fenced:true,commitHook:()=>{if(mode==='expiry')w.time+=C.TTL_MS;}});
  const p=await a.controller.prepare(context,request(1));if(mode!=='expiry')w.fresh=false;
  w.hooks.append=perform=>{perform();if(mode==='revocation'){w.authorized=false;return true;}throw Error('synthetic lost terminal acknowledgement');};
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown',mode);w.authorized=true;
  assert.equal(w.records().length,1);let inspections=0;const inspect=a.store.inspectAttempt;
  a.store.inspectAttempt=async input=>{inspections++;return inspect(input);};
  assert.equal((await a.recovery()).status,'blocked');assert.equal(inspections,0,'terminal ownership precedes P2 proof');
  assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown');
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  w.time+=C.TTL_MS;assert.equal((await a.controller.prepare(context,request(2))).reason,'outcome-unresolved');
  assert.equal(w.appends,1);assert.deepEqual(w.writes,[]);
 }
});

test('B3 native negative read requires exact actor generation and never releases held terminal ownership',async()=>{
 for(const lostAck of [false,true]){
  const w=d1ControllerWorld(),a=w.create(),p=await a.controller.prepare(context,request(1));
  w.time=p.expiresAt;
  if(lostAck)w.hooks.append=perform=>{perform();throw Error('synthetic lost seal acknowledgement');};
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,lostAck?'unknown':'not-applied');
  const before={doc:Buffer.from(w.doc),history:Buffer.from(w.historyBytes),appends:w.appends,writes:[...w.writes]};
  assert.equal((await a.controller.outcome(context,{operationId:p.operationId})).status,'unknown');
  for(const [ctx,gen] of [[otherContext,p.generation],[context,'generation-'+'f'.repeat(32)]]){
   assert.notEqual((await a.controller.outcome(ctx,{operationId:p.operationId,generation:gen})).status,'not-applied');
  }
  const expected={status:'not-applied',operationId:p.operationId,generation:p.generation};
  const reads=w.reads;
  assert.deepEqual(await a.controller.outcome(context,{operationId:p.operationId,generation:p.generation}),
    lostAck?{status:'unknown',operationId:p.operationId}:expected);
  if(lostAck)assert.equal(w.reads,reads,'held terminal owner never enters negative lookup');
  const b=w.create();
  assert.deepEqual(await b.controller.outcome(context,{operationId:p.operationId,generation:p.generation}),expected);
  if(lostAck){
   assert.equal((await a.recovery()).status,'blocked');
   assert.equal((await a.controller.prepare(context,request(2))).reason,'outcome-unresolved');
   assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  }
  assert.ok(w.doc.equals(before.doc));assert.ok(w.historyBytes.equals(before.history));
  assert.equal(w.appends,before.appends);assert.deepEqual(w.writes,before.writes);
 }
});
test('B3 negative lookup owns request and reauthorizes after awaited history read',async()=>{
 const w=d1ControllerWorld(),a=w.create(),p=await a.controller.prepare(context,request(1));
 w.time=p.expiresAt;assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'not-applied');
 const seen=deferred(),gate=deferred();w.hooks.historyRead=async perform=>{seen.resolve();await gate.promise;return perform();};
 const input={operationId:p.operationId,generation:p.generation};
 const pending=a.controller.outcome(context,input);await seen.promise;
 input.operationId=op(2);input.generation='generation-'+'f'.repeat(32);w.authorized=false;
 gate.resolve();assert.notEqual((await pending).status,'not-applied');w.authorized=true;delete w.hooks.historyRead;
 assert.deepEqual(await a.controller.outcome(context,{operationId:p.operationId,generation:p.generation}),
  {status:'not-applied',operationId:p.operationId,generation:p.generation});
 assert.equal(w.records().length,1);assert.deepEqual(w.writes,[]);
});

test('B3 public negative outcome never infers absence or accepts malformed lower proof',async()=>{
 for(const mode of ['unknown','null','extra','wrong-generation','wrong-operation','throw']){
  const w=d1ControllerWorld();let calls=0,received;
  const a=w.create({lookup:async input=>{
   calls++;received=input;
   const proof={status:'not-applied',operationId:op(1),generation:'generation-'+'1'.repeat(32)};
   if(mode==='throw')throw Error('synthetic unknown');
   if(mode==='unknown')return {status:'unknown',operationId:op(1)};
   if(mode==='null')return null;if(mode==='extra')proof.extra=true;
   if(mode==='wrong-generation')proof.generation='generation-'+'2'.repeat(32);
   if(mode==='wrong-operation')proof.operationId=op(2);return proof;
  }});
  assert.equal((await a.controller.outcome(context,{operationId:op(1)})).status,'unknown');assert.equal(calls,0);
  const input={operationId:op(1),generation:'generation-'+'1'.repeat(32)};
  assert.notEqual((await a.controller.outcome(context,input)).status,'not-applied',mode);
  assert.deepEqual(received,{...input,actorId});assert.equal(calls,1);assert.deepEqual(w.writes,[]);assert.equal(w.appends,0);
 }
});

test('B3 Addendum A terminalizing ownership acquired during lookup suppresses a delayed proof',async()=>{
 const w=d1ControllerWorld(),seen=deferred(),gate=deferred();
 // Deliberate delayed trusted-capability reply isolates the controller's
 // ownership recheck; real native qualification is covered separately.
 const a=w.create({lookup:async input=>{seen.resolve();await gate.promise;
  return {status:'not-applied',operationId:input.operationId,generation:input.generation};}});
 const p=await a.controller.prepare(context,request(1));
 const pending=a.controller.outcome(context,{operationId:p.operationId,generation:p.generation});await seen.promise;
 try{
  w.time=p.expiresAt;w.hooks.append=perform=>{perform();throw Error('synthetic lost seal acknowledgement');};
  assert.equal((await a.controller.confirm(context,d1Confirm(p))).status,'unknown');
  gate.resolve();assert.equal((await pending).status,'unknown');
  assert.equal((await a.recovery()).status,'blocked');assert.deepEqual(w.writes,[]);assert.equal(w.appends,1);
 }finally{gate.resolve();}
});
