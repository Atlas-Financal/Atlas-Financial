'use strict';
// Settlement evidence store (ATLAS-080) — synthetic tests only.
//
// The store is the write side pairing the merged read loader: an inactive
// commit/recovery state machine over dependency-injected adapters
// (document / journal / pin / backup / quarantine / lock / clock). It
// implements the ruled spec in state-machine-table-and-contracts.md as
// corrected by Atlas (corrections 1-5, conditions 6-10, F-A..F-E):
//   - the journal carries the COMPLETE frozen preview (F-A) and is
//     re-hashed and verified against the appended operation at promotion;
//   - a manifest hit must carry the same validated revision/digest/
//     artifact binding as a put acknowledgement (F-B);
//   - outcome() speaks committed | unknown only (F-C);
//   - a failed quarantine blocks the overwrite it guards (F-D);
//   - altered input on a known operation id is a conflict (F-E);
//   - C8 CAS compares against the FROZEN candidate base, never a fresh
//     pin substituted as the expected value (correction 1);
//   - no receipt is ever issued for an operation absent from the pinned
//     ledger, however well the journal matches the head (correction 2);
//   - receipts name the operation's ORIGINAL committed revision and
//     digest, derived from the validated immutable prefix (correction 3);
//   - a reused id is compared against the qualified ledger AND a valid
//     resident journal before any pre-pass mutation (correction 4);
//   - a journal-write throw is durable-or-not ambiguity, never assumed
//     absence (correction 5);
//   - injected pin/journal/manifest shapes are validated inside the
//     machine; unknown reads never select a destructive row (cond. 6);
//   - serialization is by the shared injected lock across factory
//     instances sharing adapters (condition 7);
//   - bootstrap requires proven absence of ALL durable traces, staged
//     temp artifacts included (condition 8);
//   - a valid unlanded journal is discarded only after its exact base is
//     proven to be the current pinned head and its operation absent; a
//     torn or unrelated journal is quarantined as invalid (condition 9);
//   - restore verifies household + pin, preserves divergent evidence,
//     installs under the lock with fresh pin checks, and verifies
//     readback before reporting restored (condition 10).
// Round 2 (Systems Review BLOCKING issuecomment-6278199286):
//   - pin advance success requires the literal value true at commit,
//     promotion, and bootstrap; malformed adapter results preserve
//     uncertainty and recovery evidence, never fabricate success (B1);
//   - bootstrap validates readStaged output as bytes-or-null before
//     genesis (B1);
//   - commit deep-copies the complete request at public entry, before
//     waiting on the lock, and a resident journal binds the supplied
//     actor as well as the request digest (B2);
//   - the backup manifest and its entries are validated at read time;
//     an unavailable or malformed manifest never selects a destructive
//     reconciliation row (R6/R7/R8) (B3).
//
// No filesystem, environment, network, or provisioning anywhere: every
// adapter below is an in-memory double with per-method fault injection
// (failNext / crash simulation = discard the store instance, keep the
// durable maps, construct a fresh instance over the same doubles).
//
// Tests first: against unmodified main this suite fails to load (the
// store module does not exist). Every writer-reachable shape is asserted
// through the REAL merged loader, driven end-to-end over the doubles.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = process.env.ATLAS_TEST_APP_ROOT || path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'scripts/planned-obligation-settlement-contract'));
const L = require(path.join(ROOT, 'scripts/settlement-evidence-loader'));
const S = require(path.join(ROOT, 'scripts/settlement-evidence-store'));

const householdId = 'household-' + 'a'.repeat(32);
const actorId = 'session-' + 'c'.repeat(64);
const actor2 = 'session-' + 'd'.repeat(64);
const op = n => 'operation-' + n.toString(16).padStart(32, '0');
const tx = n => 'tx-' + n.toString(16).padStart(32, '0');
const T0 = Date.parse('2026-10-04T12:00:00Z');

// --- Contract command builders (real Phase 1 flow, synthetic facts) -----
const ev = (over = {}) => ({
  accountId: 'acct-main', currency: 'cad', direction: 'debit',
  date: '2026-10-03', cents: 6000, posted: true, ...over,
});
const linkCmd = (over = {}) => {
  const e = ev(over.evidence || {});
  return {
    version: 1, kind: 'link', goalId: over.goalId || 'commitment:near',
    txRef: over.txRef || tx(1), evidence: e, evidenceDigest: C.digest(e),
    assignedCents: over.assignedCents !== undefined ? over.assignedCents : 2500,
    asOf: over.asOf || '2026-10-04',
  };
};
const pinOf = bytes => {
  const s = JSON.parse(bytes.toString('utf8'));
  return { revision: s.revision, digest: s.digest };
};
const stateOf = bytes => JSON.parse(bytes.toString('utf8'));

// --- In-memory adapter doubles with fault injection ----------------------
// Fault modes per method (queued, one-shot unless noted):
//   'throw'         -> throw without durable effect (journal.write and
//                      backup.put default to NOT landed / NOT stored)
//   'throw-landed'  -> apply the durable effect, then throw (lost ack)
//   'false'         -> pin.advance only: return false, no effect
//   'swap-garbage'  -> doc.commitTemp only: install garbage bytes instead
//   'bad-ack-*'     -> backup.put only: store durably, return a bad ack
//   function(perform, ...args) -> custom; perform() runs the default effect
function makeLock() {
  let tail = Promise.resolve();
  return {
    withLock(fn) {
      const run = tail.then(fn, fn);
      tail = run.then(() => {}, () => {});
      return run;
    },
  };
}
function makeWorld() {
  const durable = {
    doc: null, temp: null, journal: null, pin: null, pinRaw: undefined,
    backups: new Map(), quarantine: [], artifactSeq: 0,
  };
  const counts = {
    docRead: 0, docWriteTemp: 0, docCommitTemp: 0, docDiscardTemp: 0, docReadStaged: 0,
    journalRead: 0, journalWrite: 0, journalClear: 0,
    pinRead: 0, pinAdvance: 0, pinAdvanceOk: 0,
    backupPut: 0, backupGet: 0, backupList: 0, quarantinePut: 0,
  };
  const flags = { pinReadThrows: false };
  const faults = new Map();
  const failNext = (method, mode) => {
    if (!faults.has(method)) faults.set(method, []);
    faults.get(method).push(mode);
  };
  const takeFault = method => {
    const q = faults.get(method);
    return q && q.length ? q.shift() : null;
  };
  const writeCounts = () => ({
    docWriteTemp: counts.docWriteTemp, docCommitTemp: counts.docCommitTemp,
    docDiscardTemp: counts.docDiscardTemp, journalWrite: counts.journalWrite,
    journalClear: counts.journalClear, pinAdvance: counts.pinAdvance,
    backupPut: counts.backupPut, quarantinePut: counts.quarantinePut,
  });
  const noWritesSince = snap => {
    const nowCounts = writeCounts();
    for (const k of Object.keys(snap)) {
      assert.equal(nowCounts[k], snap[k], `expected no ${k} since snapshot`);
    }
  };

  const documentStore = {
    async read() {
      counts.docRead++;
      const f = takeFault('doc.read');
      if (f === 'throw') throw new Error('injected doc.read');
      if (typeof f === 'function') return f(() => (durable.doc ? Buffer.from(durable.doc) : null));
      return durable.doc ? Buffer.from(durable.doc) : null;
    },
    async readStaged() {
      counts.docReadStaged++;
      const f = takeFault('doc.readStaged');
      if (f === 'throw') throw new Error('injected doc.readStaged');
      if (typeof f === 'function') return f();
      return durable.temp ? Buffer.from(durable.temp) : null;
    },
    async writeTemp(bytes) {
      counts.docWriteTemp++;
      const f = takeFault('doc.writeTemp');
      if (f === 'throw') throw new Error('injected doc.writeTemp');
      durable.temp = Buffer.from(bytes);
    },
    async commitTemp() {
      counts.docCommitTemp++;
      const f = takeFault('doc.commitTemp');
      if (f === 'throw') throw new Error('injected doc.commitTemp (not landed)');
      if (f === 'throw-landed') {
        durable.doc = durable.temp; durable.temp = null;
        throw new Error('injected doc.commitTemp (landed, ack lost)');
      }
      if (f === 'swap-garbage') {
        durable.doc = Buffer.from('garbage-not-a-document');
        durable.temp = null;
        return;
      }
      durable.doc = durable.temp; durable.temp = null;
    },
    async discardTemp() {
      counts.docDiscardTemp++;
      const f = takeFault('doc.discardTemp');
      if (f === 'throw') throw new Error('injected doc.discardTemp');
      durable.temp = null;
    },
  };
  const journalStore = {
    async read() {
      counts.journalRead++;
      const f = takeFault('journal.read');
      if (f === 'throw') throw new Error('injected journal.read');
      return durable.journal ? Buffer.from(durable.journal) : null;
    },
    async write(record) {
      counts.journalWrite++;
      const f = takeFault('journal.write');
      if (f === 'throw') throw new Error('injected journal.write (not durable)');
      durable.journal = Buffer.from(JSON.stringify(record));
      if (f === 'throw-landed') throw new Error('injected journal.write (durable, ack lost)');
    },
    async clear() {
      counts.journalClear++;
      const f = takeFault('journal.clear');
      if (f === 'throw') throw new Error('injected journal.clear');
      durable.journal = null;
    },
  };
  const pinStore = {
    async read() {
      counts.pinRead++;
      const f = takeFault('pin.read');
      if (f === 'throw' || flags.pinReadThrows) throw new Error('injected pin.read');
      if (durable.pinRaw !== undefined) return durable.pinRaw;
      return durable.pin ? { ...durable.pin } : null;
    },
    async advance(expected, next) {
      counts.pinAdvance++;
      const perform = () => {
        const cur = durable.pin;
        const match = expected === null
          ? cur === null
          : !!cur && cur.revision === expected.revision && cur.digest === expected.digest;
        if (!match) return false;
        durable.pin = { ...next };
        counts.pinAdvanceOk++;
        return true;
      };
      const f = takeFault('pin.advance');
      if (f === 'throw') throw new Error('injected pin.advance');
      if (f === 'false') return false;
      if (typeof f === 'function') return f(perform, expected, next);
      return perform();
    },
  };
  const backupStore = {
    async put(revision, digest, bytes) {
      counts.backupPut++;
      const storeIt = () => {
        const key = revision + ':' + digest;
        if (!durable.backups.has(key)) {
          durable.backups.set(key, {
            revision, digest, artifactId: 'artifact-' + (++durable.artifactSeq),
            bytes: Buffer.from(bytes),
          });
        }
        const e = durable.backups.get(key);
        return { revision: e.revision, digest: e.digest, artifactId: e.artifactId };
      };
      const f = takeFault('backup.put');
      if (typeof f === 'function') return f(storeIt, revision, digest, Buffer.from(bytes));
      if (f === 'throw') throw new Error('injected backup.put (not stored)');
      if (f === 'throw-landed') { storeIt(); throw new Error('injected backup.put (stored, ack lost)'); }
      if (f === 'bad-ack-digest') { const a = storeIt(); return { ...a, digest: '0'.repeat(64) }; }
      if (f === 'bad-ack-no-artifact') { const a = storeIt(); return { revision: a.revision, digest: a.digest }; }
      if (f === 'bad-ack-nonrecord') { storeIt(); return 'stored'; }
      if (f === 'bad-ack-null') { storeIt(); return null; }
      return storeIt();
    },
    async get(revision, digest) {
      counts.backupGet++;
      const f = takeFault('backup.get');
      if (f === 'throw') throw new Error('injected backup.get');
      const e = durable.backups.get(revision + ':' + digest);
      return e ? Buffer.from(e.bytes) : null;
    },
    async list() {
      counts.backupList++;
      const f = takeFault('backup.list');
      if (f === 'throw') throw new Error('injected backup.list');
      if (typeof f === 'function') return f();
      return [...durable.backups.values()].map(e => ({
        revision: e.revision, digest: e.digest, artifactId: e.artifactId,
      }));
    },
  };
  const quarantine = {
    async put(label, bytes) {
      counts.quarantinePut++;
      const f = takeFault('quarantine.put');
      if (f === 'throw') throw new Error('injected quarantine.put');
      durable.quarantine.push({ label, bytes: Buffer.from(bytes) });
    },
  };
  let tick = T0;
  const clock = {
    now: () => tick,
    advance: ms => { tick += ms; },
    set: t => { tick = t; },
  };
  return {
    durable, counts, flags, failNext, writeCounts, noWritesSince,
    documentStore, journalStore, pinStore, backupStore, quarantine, clock,
  };
}
function newStore(world, lock) {
  return S.createSettlementEvidenceStore({
    householdId,
    documentStore: world.documentStore,
    journalStore: world.journalStore,
    pinStore: world.pinStore,
    backupStore: world.backupStore,
    quarantine: world.quarantine,
    lock: lock || makeLock(),
    now: world.clock.now,
  });
}
// End-to-end interop: the REAL merged loader over the doubles' durable
// state. Pin absence/unreadability is presented as a throwing readPin
// (the spec's interop convention -> pin-unavailable).
async function loadFromWorld(world) {
  return await L.loadSettlementEvidence({
    config: { householdId },
    readDocument: () => (world.durable.doc ? Buffer.from(world.durable.doc) : null),
    readPin: () => {
      if (world.flags.pinReadThrows || !world.durable.pin) {
        throw new Error('pin unavailable');
      }
      return { revision: world.durable.pin.revision, digest: world.durable.pin.digest };
    },
  });
}
const seenRows = new Set();
function noteRow(report) { if (report && report.row) seenRows.add(report.row); return report; }

async function bootWorld() {
  const world = makeWorld();
  const store = newStore(world);
  const boot = await store.bootstrap();
  assert.equal(boot.status, 'bootstrapped');
  assert.equal(boot.revision, 0);
  return { world, store };
}
async function prepareLink(store, n, over = {}) {
  const prepared = await store.prepare({
    actorId: over.actorId || actorId, operationId: op(n), command: linkCmd(over),
  });
  assert.ok(prepared.preview, 'prepare returns a contract preview');
  return prepared;
}
async function commitLink(store, n, over = {}) {
  const prepared = await prepareLink(store, n, over);
  const receipt = await store.commit({
    actorId: over.actorId || actorId,
    preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(receipt.status, 'committed', 'synthetic link commits');
  return receipt;
}
function snapshotWorld(world) {
  return {
    doc: world.durable.doc ? world.durable.doc.toString('hex') : null,
    temp: world.durable.temp ? world.durable.temp.toString('hex') : null,
    journal: world.durable.journal ? world.durable.journal.toString('hex') : null,
    pin: world.durable.pin ? { ...world.durable.pin } : null,
    backups: [...world.durable.backups.keys()].sort(),
    quarantine: world.durable.quarantine.length,
  };
}
function assertWorldUnchanged(world, snap, what) {
  assert.deepEqual(snapshotWorld(world), snap, `${what}: store byte-identical`);
}

// B1 confirmation boundary proof includes every retained byte, not only the
// incumbent snapshot's backup keys / quarantine length.
function retainedBytes(world) {
  return {
    ...snapshotWorld(world), artifactSeq: world.durable.artifactSeq,
    backups: [...world.durable.backups.values()].map(entry => ({ ...entry, bytes: entry.bytes.toString('hex') })),
    quarantine: world.durable.quarantine.map(entry => ({ ...entry, bytes: entry.bytes.toString('hex') })),
  };
}
const confirmedRequest = (prepared, actor = actorId) => ({
  actorId: actor, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
});

// === State-table rows =====================================================

test('T1 R0: empty doubles -> unbootstrapped, zero writes; loader unavailable', async () => {
  const world = makeWorld();
  const store = newStore(world);
  const snap = world.writeCounts();
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R0');
  assert.equal(report.disposition, 'unbootstrapped');
  world.noWritesSince(snap);
  const view = await loadFromWorld(world);
  assert.equal(view.status, 'unavailable');
  assert.equal(view.reason, 'pin-unavailable');
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'unknown');
  const c = await store.commit({
    actorId, preview: { operationId: op(1) }, confirmationDigest: 'a'.repeat(64),
  });
  assert.equal(c.status, 'unavailable');
  assert.equal(c.reason, 'unbootstrapped');
});

test('T2 R1: pin unreadable with document/journal/backup-only traces -> recovery-blocked', async () => {
  for (const trace of ['document', 'journal', 'backup']) {
    const world = makeWorld();
    if (trace === 'document') world.durable.doc = C.adopt({ householdId });
    if (trace === 'journal') {
      world.durable.journal = Buffer.from(JSON.stringify({ version: 1, note: 'trace' }));
    }
    if (trace === 'backup') {
      world.durable.backups.set('0:' + 'f'.repeat(64), {
        revision: 0, digest: 'f'.repeat(64), artifactId: 'artifact-x', bytes: Buffer.from('x'),
      });
    }
    world.flags.pinReadThrows = true;
    const store = newStore(world);
    const snap = world.writeCounts();
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R1', trace);
    assert.equal(report.disposition, 'recovery-blocked', trace);
    world.noWritesSince(snap);
    const out = await store.outcome({ actorId, operationId: op(1) });
    assert.equal(out.status, 'unknown', trace);
    const boot = await store.bootstrap();
    assert.notEqual(boot.status, 'bootstrapped', trace + ': bootstrap refused');
    world.noWritesSince(snap);
  }
  // Pin absent (not throwing) while a trace exists is equally R1.
  const world = makeWorld();
  world.durable.doc = C.adopt({ householdId });
  const store = newStore(world);
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R1');
  assert.equal(report.disposition, 'recovery-blocked');
});

test('T3 R2: bootstrapped + one commit -> healthy, no writes', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  const snap = world.writeCounts();
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R2');
  assert.equal(report.disposition, 'healthy');
  world.noWritesSince(snap);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T4 R3: crash after pin advance, before journal clear -> committed receipt, J deleted', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('journal.clear', 'throw');
  const receipt = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(receipt.status, 'committed', 'C9 clear failure is non-fatal');
  assert.equal(receipt.revision, 1);
  assert.ok(world.durable.journal, 'leftover journal = shape W5');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
  // Restart: fresh instance over the same durable maps.
  const store2 = newStore(world);
  const report = noteRow(await store2.reconcile());
  assert.equal(report.row, 'R3');
  assert.equal(report.disposition, 'committed-recovered');
  assert.equal(report.receipt.operationId, op(1));
  assert.equal(report.receipt.revision, 1);
  assert.equal(report.receipt.digest, world.durable.pin.digest);
  assert.equal(world.durable.journal, null, 'journal cleared by R3');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'document revision unchanged');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T5 R4: crash after journal write / temp write / not-landed rename -> not-committed', async () => {
  for (const faultAt of ['doc.writeTemp', 'doc.commitTemp']) {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext(faultAt, 'throw');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown', faultAt);
    assert.ok(world.durable.journal, 'journal resident (W2)');
    assert.equal(stateOf(world.durable.doc).revision, 0, 'candidate never landed');
    assert.equal((await loadFromWorld(world)).status, 'qualified', 'loader serves the pinned base');
    const store2 = newStore(world);
    const report = noteRow(await store2.reconcile());
    assert.equal(report.row, 'R4', faultAt);
    assert.equal(report.disposition, 'not-committed', faultAt);
    assert.equal(report.operationId, op(1), faultAt);
    assert.equal(world.durable.journal, null, 'journal deleted');
    assert.equal(world.durable.temp, null, 'temp discarded');
    assert.equal(world.durable.pin.revision, 0, 'pin untouched');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
});

test('T6 R4-torn: garbage journal bytes, H == P -> journal quarantined as invalid, removed', async () => {
  const { world, store } = await bootWorld();
  world.durable.journal = Buffer.from('this is not a journal record{{{');
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R4');
  assert.equal(report.disposition, 'journal-quarantined');
  assert.equal(world.durable.journal, null, 'journal removed after quarantine');
  assert.equal(world.durable.quarantine.length, 1, 'torn bytes preserved in quarantine');
  assert.equal(world.durable.quarantine[0].label, 'invalid-journal');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T7 R5: crash after rename / after backup -> promote exactly once', async () => {
  for (const faultAt of ['backup.put', 'pin.advance']) {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext(faultAt, 'throw');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown', faultAt);
    assert.equal(stateOf(world.durable.doc).revision, 1, 'candidate landed');
    assert.equal(world.durable.pin.revision, 0, 'pin still at base (W3/W4)');
    assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
    const store2 = newStore(world);
    const report = noteRow(await store2.reconcile());
    assert.equal(report.row, 'R5', faultAt);
    assert.equal(report.disposition, 'promoted', faultAt);
    assert.equal(report.operationId, op(1));
    assert.equal(report.revision, 1);
    assert.equal(world.durable.pin.revision, 1, 'pin CAS-advanced');
    assert.equal(world.durable.journal, null, 'journal deleted');
    const view = await loadFromWorld(world);
    assert.equal(view.status, 'qualified', 'loader flips to qualified at P+1');
    assert.equal(view.evidence.commitments.length, 1);
    const again = noteRow(await store2.reconcile());
    assert.equal(again.row, 'R2', 'second reconcile is a no-op');
    assert.equal(again.disposition, 'healthy');
  }
});

test('T8 R5-blocked: backup keeps failing -> promotion-pending, pin and J untouched', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('backup.put', 'throw');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.equal(res.reason, 'backup-ambiguous');
  world.failNext('backup.put', 'throw');
  const store2 = newStore(world);
  const report = noteRow(await store2.reconcile());
  assert.equal(report.row, 'R5');
  assert.equal(report.disposition, 'promotion-pending');
  assert.equal(report.reason, 'backup-ambiguous');
  assert.equal(world.durable.pin.revision, 0, 'pin untouched');
  assert.ok(world.durable.journal, 'journal untouched');
  assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
});

test('T9 R6: ahead-of-pin forks restore the pinned revision and quarantine', async () => {
  // (i) head two revisions ahead of the pin.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    let forged = world.durable.doc;
    const p2 = C.prepare(forged, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 1,
    });
    forged = C.confirmCandidate(forged, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 2,
    }).document;
    const p3 = C.prepare(forged, {
      householdId, actorId, operationId: op(3), command: linkCmd({ txRef: tx(3) }),
      now: world.clock.now() + 3,
    });
    forged = C.confirmCandidate(forged, {
      householdId, actorId, preview: p3.preview,
      confirmationDigest: p3.confirmationDigest, now: world.clock.now() + 4,
    }).document;
    world.durable.doc = Buffer.from(forged);
    assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R6');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 1, 'pinned revision restored');
    assert.ok(world.durable.quarantine.some(q => q.bytes.equals(forged)), 'divergent head quarantined');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // (ii) one ahead with no journal.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    const p2 = C.prepare(world.durable.doc, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 1,
    });
    const candidate = C.confirmCandidate(world.durable.doc, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 2,
    }).document;
    world.durable.doc = Buffer.from(candidate);
    assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R6');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 1);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // (iii) one ahead with J.baseDigest != pin digest.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    const j = JSON.parse(world.durable.journal.toString('utf8'));
    j.baseDigest = 'e'.repeat(64);
    j.preview = { ...j.preview, expectedDocumentDigest: 'e'.repeat(64) };
    world.durable.journal = Buffer.from(JSON.stringify(j));
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R6');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 0, 'restored to the pinned genesis');
    assert.equal(world.durable.journal, null);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // (iv) one ahead with the journal's operation not the recorded one.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    const base = C.adopt({ householdId });
    const p9 = C.prepare(base, {
      householdId, actorId, operationId: op(9), command: linkCmd({ txRef: tx(9) }),
      now: world.clock.now() + 1,
    });
    const other = C.confirmCandidate(base, {
      householdId, actorId, preview: p9.preview,
      confirmationDigest: p9.confirmationDigest, now: world.clock.now() + 2,
    }).document;
    world.durable.doc = Buffer.from(other);
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R6');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 0);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
});

test('T10 R6-tail: pinned backup corrupted -> recovery-blocked, divergent head left in place', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  const key = '0:' + pinOf(C.adopt({ householdId })).digest;
  const entry = world.durable.backups.get(key);
  assert.ok(entry, 'genesis backup exists');
  entry.bytes = Buffer.from('corrupted-backup-bytes');
  const forged = (() => {
    const p2 = C.prepare(world.durable.doc, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 1,
    });
    return C.confirmCandidate(world.durable.doc, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 2,
    }).document;
  })();
  // Move the pin back to genesis so the pinned backup is the corrupted one,
  // and install a head two revisions past it.
  world.durable.pin = {
    revision: 0, digest: pinOf(C.adopt({ householdId })).digest, timestamp: world.clock.now(),
  };
  world.durable.doc = Buffer.from(forged);
  const before = world.durable.doc;
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R6');
  assert.equal(report.disposition, 'recovery-blocked');
  assert.ok(world.durable.doc.equals(before), 'divergent head left in place, withheld');
  assert.equal(world.durable.quarantine.length, 0, 'nothing quarantined without a verified restore');
  assert.equal((await loadFromWorld(world)).status, 'unavailable');
});

test('T11 R7: behind-pin, same-revision fork, contract-invalid bytes -> restore', async () => {
  // (i) prior-revision bytes (pin ahead).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = C.adopt({ householdId });
    assert.equal((await loadFromWorld(world)).reason, 'revision-mismatch');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R7');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 1);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // (ii) same revision, different digest (a different valid rev-1 document).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    const base = C.adopt({ householdId });
    const p9 = C.prepare(base, {
      householdId, actorId, operationId: op(9), command: linkCmd({ txRef: tx(9) }),
      now: world.clock.now() + 1,
    });
    const fork = C.confirmCandidate(base, {
      householdId, actorId, preview: p9.preview,
      confirmationDigest: p9.confirmationDigest, now: world.clock.now() + 2,
    }).document;
    world.durable.doc = Buffer.from(fork);
    assert.equal((await loadFromWorld(world)).reason, 'digest-mismatch');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R7');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // (iii) contract-invalid bytes at the pinned header (tampered amount).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1, { assignedCents: 2500 });
    const tampered = Buffer.from(
      world.durable.doc.toString('utf8').replace('"assignedCents":2500', '"assignedCents":2000'),
    );
    assert.ok(!tampered.equals(world.durable.doc), 'tamper changed bytes');
    world.durable.doc = tampered;
    assert.equal((await loadFromWorld(world)).reason, 'document-invalid');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R7');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
});

test('T12 R8: document missing with pin present -> restore; backup also missing -> blocked', async () => {
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = null;
    assert.equal((await loadFromWorld(world)).reason, 'document-missing');
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R8');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 1);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  {
    const { world, store } = await bootWorld();
    world.durable.doc = null;
    world.durable.backups.clear();
    const report = noteRow(await store.reconcile());
    assert.equal(report.row, 'R8');
    assert.equal(report.disposition, 'recovery-blocked');
    assert.equal(world.durable.doc, null, 'nothing fabricated');
    assert.equal((await loadFromWorld(world)).reason, 'document-missing');
  }
});

// === Crash points ==========================================================

test('T13: fault injection at each commit pipeline step', async () => {
  // C3 journal write throws (not durable): unknown, nothing else written,
  // retry after the fault commits cleanly.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('journal.write', 'throw');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown');
    assert.equal(res.reason, 'journal-write-ambiguous');
    assert.equal(world.durable.journal, null);
    assert.equal(world.durable.temp, null);
    assert.equal(world.durable.pin.revision, 0);
    const retry = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(retry.status, 'committed');
    assert.equal(retry.revision, 1);
  }
  // C5 rename landed but ack lost: unknown; reconciler promotes (W3).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('doc.commitTemp', 'throw-landed');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown');
    assert.equal(res.reason, 'rename-ambiguous');
    assert.equal(stateOf(world.durable.doc).revision, 1, 'rename had in fact landed');
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R5');
    assert.equal(report.disposition, 'promoted');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // C6 readback: rename installs garbage -> readback fails -> unknown;
  // reconciler classifies the garbage head as divergent and restores.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('doc.commitTemp', 'swap-garbage');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown');
    assert.equal(res.reason, 'readback-failed');
    assert.equal(world.durable.pin.revision, 0, 'never proceeds to backup/pin on failed readback');
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R7');
    assert.equal(report.disposition, 'restored-pinned');
    assert.equal(stateOf(world.durable.doc).revision, 0);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // C8 pin advance throws: unknown; shape W4 promotable by reconcile.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('pin.advance', 'throw');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown');
    assert.equal(res.reason, 'pin-advance-failed');
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R5');
    assert.equal(report.disposition, 'promoted');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // C8 pin advance returns false (spurious): abort, table re-run promotes,
  // commit answers unknown/pin-moved; an identical retry returns the receipt.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('pin.advance', 'false');
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown');
    assert.equal(res.reason, 'pin-moved');
    assert.equal(world.durable.pin.revision, 1, 're-run promoted the candidate');
    assert.equal(world.durable.journal, null);
    const retry = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(retry.status, 'committed');
    assert.equal(retry.revision, 1);
    assert.equal(stateOf(world.durable.doc).revision, 1, 'no second revision');
  }
});

test('correction 1: C8 CAS is against the frozen base — an external winner is never overwritten', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  const prepared = await prepareLink(store, 2, { txRef: tx(2) });
  // An external writer wins between our backup and our pin advance: the
  // advance observes a foreign pin installed over the frozen base, and
  // the CAS against the frozen pair fails honestly.
  const foreign = { revision: 2, digest: 'b'.repeat(64), timestamp: world.clock.now() };
  world.failNext('pin.advance', perform => {
    world.durable.pin = { ...foreign };
    return perform();
  });
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.equal(res.reason, 'pin-moved');
  assert.deepEqual(world.durable.pin, foreign, "the winner's pin was NOT overwritten");
  assert.equal(stateOf(world.durable.doc).revision, 2,
    'candidate bytes remain in place for classification');
  // The foreign pin names no backup this store holds: recovery blocks
  // with the head left in place rather than restoring over it blindly.
  const report = noteRow(await newStore(world).reconcile());
  assert.equal(report.disposition, 'recovery-blocked');
  assert.deepEqual(world.durable.pin, foreign);
  assert.equal((await loadFromWorld(world)).status, 'unavailable');
});

test('T14: identical retry of a committed operation -> already-recorded receipt, reads only', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const first = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(first.status, 'committed');
  const snap = world.writeCounts();
  const worldSnap = snapshotWorld(world);
  const retry = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.operationId, op(1));
  assert.equal(retry.revision, first.revision);
  assert.equal(retry.digest, first.digest);
  world.noWritesSince(snap);
  assertWorldUnchanged(world, worldSnap, 'T14');
});

test('T15: same operation id, altered input -> conflict in pinned / J-resident / landed states', async () => {
  // (a) already pinned.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    const snap = snapshotWorld(world);
    const altered = await prepareLink(store, 1, { assignedCents: 3000 }).catch(e => e);
    // prepare refuses a recorded id through the contract; build the altered
    // preview directly against the genesis bytes instead.
    const alt = C.prepare(C.adopt({ householdId }), {
      householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
      now: world.clock.now(),
    });
    assert.ok(altered instanceof Error, 'store.prepare surfaces the recorded id');
    const res = await store.commit({
      actorId, preview: alt.preview, confirmationDigest: alt.confirmationDigest,
    });
    assert.equal(res.status, 'conflict');
    assertWorldUnchanged(world, snap, 'T15a');
  }
  // (b) J-resident unlanded (crash after journal write).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('doc.writeTemp', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.ok(world.durable.journal, 'journal resident');
    const alt = C.prepare(C.adopt({ householdId }), {
      householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
      now: world.clock.now(),
    });
    const snap = snapshotWorld(world);
    const res = await store.commit({
      actorId, preview: alt.preview, confirmationDigest: alt.confirmationDigest,
    });
    assert.equal(res.status, 'conflict');
    assertWorldUnchanged(world, snap, 'T15b: conflict precedes any pre-pass mutation');
    assert.ok(world.durable.journal, 'journal NOT cleaned up by the refused retry');
  }
  // (c) candidate landed but unpinned (W3).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(stateOf(world.durable.doc).revision, 1);
    const alt = C.prepare(C.adopt({ householdId }), {
      householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
      now: world.clock.now(),
    });
    const res = await store.commit({
      actorId, preview: alt.preview, confirmationDigest: alt.confirmationDigest,
    });
    assert.equal(res.status, 'conflict');
    // The original candidate is promoted by the pre-pass of a later honest
    // retry; the altered input never lands.
    const honest = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(honest.status, 'committed');
    assert.equal(honest.revision, 1);
    const ops = stateOf(world.durable.doc).operations;
    assert.equal(ops.length, 1);
    assert.equal(ops[0].command.assignedCents, 2500, 'original input is what committed');
  }
});

test('T16: two confirms prepared against one base -> exactly one commits; loser re-prepares', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepA = await prepareLink(store, 1);
  const prepB = await prepareLink(store, 2, { txRef: tx(2) });
  const a = await store.commit({
    actorId, preview: prepA.preview, confirmationDigest: prepA.confirmationDigest,
  });
  assert.equal(a.status, 'committed');
  const b = await store.commit({
    actorId, preview: prepB.preview, confirmationDigest: prepB.confirmationDigest,
  });
  assert.equal(b.status, 'conflict', 'revision-changed maps to conflict');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'exactly one winner');
  world.clock.advance(10);
  const prepB2 = await prepareLink(store, 2, { txRef: tx(2) });
  const b2 = await store.commit({
    actorId, preview: prepB2.preview, confirmationDigest: prepB2.confirmationDigest,
  });
  assert.equal(b2.status, 'committed');
  assert.equal(b2.revision, 2);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T17: backup down at C7 -> unknown, commits pause; healed -> promote exactly once', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('backup.put', 'throw');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.equal(res.reason, 'backup-ambiguous');
  assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
  // A different operation cannot commit behind the resident journal.
  const prep2 = C.prepare(C.adopt({ householdId }), {
    householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
    now: world.clock.now(),
  });
  world.failNext('backup.put', 'throw');
  const paused = await store.commit({
    actorId, preview: prep2.preview, confirmationDigest: prep2.confirmationDigest,
  });
  assert.equal(paused.status, 'unavailable', 'new commits pause behind unresolved J');
  // Heal the adapter: the same-id retry promotes exactly once.
  const retry = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, 1);
  assert.equal(stateOf(world.durable.doc).revision, 1, 'exactly one revision ever results');
  assert.equal(world.durable.pin.revision, 1);
  assert.equal(world.durable.journal, null);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T18: preview expired before commit -> rejected/preview-expired, zero durable writes', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const snap = world.writeCounts();
  const worldSnap = snapshotWorld(world);
  world.clock.advance(C.TTL_MS + 1);
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'preview-expired');
  world.noWritesSince(snap);
  assertWorldUnchanged(world, worldSnap, 'T18');
});

test('T19: bootstrap on empty doubles -> consistent genesis; second bootstrap refused', async () => {
  const world = makeWorld();
  const store = newStore(world);
  const boot = await store.bootstrap();
  assert.equal(boot.status, 'bootstrapped');
  assert.equal(boot.revision, 0);
  const genesis = C.adopt({ householdId });
  assert.ok(world.durable.doc.equals(genesis), 'document is the adopted genesis');
  assert.deepEqual(world.durable.pin, {
    revision: 0, digest: pinOf(genesis).digest, timestamp: T0,
  });
  assert.equal(world.durable.backups.size, 1, 'genesis backup stored');
  const view = await loadFromWorld(world);
  assert.equal(view.status, 'qualified');
  assert.deepEqual(view.evidence, { commitments: [] }, 'genuinely empty evidence');
  const snap = snapshotWorld(world);
  const again = await store.bootstrap();
  assert.equal(again.status, 'rejected');
  assert.equal(again.reason, 'already-bootstrapped');
  assertWorldUnchanged(world, snap, 'T19 second bootstrap');
});

test('T20: interrupted bootstrap -> reconcile R1 recovery-blocked; bootstrap still refused', async () => {
  const world = makeWorld();
  world.failNext('pin.advance', 'throw');
  const store = newStore(world);
  const boot = await store.bootstrap();
  assert.equal(boot.status, 'unavailable');
  assert.ok(world.durable.doc, 'genesis document installed before the crash point');
  assert.equal(world.durable.pin, null, 'pin never advanced');
  const report = noteRow(await newStore(world).reconcile());
  assert.equal(report.row, 'R1');
  assert.equal(report.disposition, 'recovery-blocked');
  const again = await newStore(world).bootstrap();
  assert.equal(again.status, 'rejected', 'no silent re-genesis over traces');
  assert.equal((await loadFromWorld(world)).status, 'unavailable');
});

// === Loader-interop matrix ================================================

test('T21: interop sweep — every writer shape through the real loader, before/after reconcile', async () => {
  const cases = [];
  // W1 healthy.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    cases.push(['W1', world, store, ['qualified', null], ['qualified', null]]);
  }
  // W2 journal-resident unlanded.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('doc.writeTemp', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    cases.push(['W2', world, store, ['qualified', null], ['qualified', null]]);
  }
  // W3 promotable and W6 fork share document-ahead-of-pin before reconcile.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    cases.push(['W3', world, store,
      ['unavailable', 'document-ahead-of-pin'], ['qualified', null]]);
  }
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    const p2 = C.prepare(world.durable.doc, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 1,
    });
    world.durable.doc = Buffer.from(C.confirmCandidate(world.durable.doc, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 2,
    }).document);
    cases.push(['W6', world, store,
      ['unavailable', 'document-ahead-of-pin'], ['qualified', null]]);
  }
  // W7 behind pin.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = C.adopt({ householdId });
    cases.push(['W7', world, store,
      ['unavailable', 'revision-mismatch'], ['qualified', null]]);
  }
  // W10 document missing.
  {
    const { world, store } = await bootWorld();
    world.durable.doc = null;
    cases.push(['W10', world, store,
      ['unavailable', 'document-missing'], ['qualified', null]]);
  }
  // W11 pin unreadable with traces.
  {
    const { world, store } = await bootWorld();
    world.flags.pinReadThrows = true;
    cases.push(['W11', world, store,
      ['unavailable', 'pin-unavailable'], ['unavailable', 'pin-unavailable']]);
  }
  // W12 nothing anywhere.
  {
    const world = makeWorld();
    const store = newStore(world);
    cases.push(['W12', world, store,
      ['unavailable', 'pin-unavailable'], ['unavailable', 'pin-unavailable']]);
  }
  // W13 bytes move between the loader's verify and projection reads.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    let reads = 0;
    const view = await L.loadSettlementEvidence({
      config: { householdId },
      readDocument: () => {
        reads++;
        return reads === 1 ? Buffer.from(world.durable.doc) : C.adopt({ householdId });
      },
      readPin: () => ({
        revision: world.durable.pin.revision, digest: world.durable.pin.digest,
      }),
    });
    assert.equal(view.status, 'unavailable');
    assert.equal(view.reason, 'document-changed');
    cases.push(['W13-checked-inline', world, store, ['qualified', null], ['qualified', null]]);
  }
  for (const [name, world, store, before, after] of cases) {
    const b = await loadFromWorld(world);
    assert.equal(b.status, before[0], name + ' before');
    if (before[1]) assert.equal(b.reason, before[1], name + ' before reason');
    if (b.status === 'qualified') {
      // Qualified is only ever served on the pinned bytes.
      assert.equal(b.evidence.commitments.length,
        stateOf(world.durable.doc).operations.filter(o => o.command.kind === 'link').length,
        name + ': qualified evidence comes from the pinned document');
    }
    noteRow(await store.reconcile());
    const a = await loadFromWorld(world);
    assert.equal(a.status, after[0], name + ' after');
    if (after[1]) assert.equal(a.reason, after[1], name + ' after reason');
  }
});

// === Atlas fixtures and named regression pins ==============================

test('T22 lost-acknowledgement: W5 retry and outcome() prove commitment before cleanup', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('journal.clear', 'throw');
  const receipt = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(receipt.status, 'committed');
  assert.ok(world.durable.journal, 'response dropped with J resident (W5)');
  // outcome() returns committed BEFORE any journal cleanup (C1/F4).
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'committed');
  assert.equal(out.revision, 1);
  assert.equal(out.digest, world.durable.pin.digest);
  assert.ok(world.durable.journal, 'outcome() performed no cleanup');
  // An identical retry returns the same receipt with no new revision.
  const snap = world.writeCounts();
  const retry = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, receipt.revision);
  assert.equal(retry.digest, receipt.digest);
  world.noWritesSince(snap);
  // reconcile then applies R3 and deletes J.
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R3');
  assert.equal(world.durable.journal, null);
});

test('T23: concurrent stale reconciler — CAS defeats the stale advance; exactly one promotion', async () => {
  const world = makeWorld();
  const lock = makeLock();
  const storeA = newStore(world, lock);
  assert.equal((await storeA.bootstrap()).status, 'bootstrapped');
  world.clock.advance(10);
  await commitLink(storeA, 1);
  // Build a promotable W3 shape.
  const prepared = await prepareLink(storeA, 2, { txRef: tx(2) });
  world.failNext('backup.put', 'throw');
  const res = await storeA.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  // Instance A observes the pin at revision 1.
  const stale = await world.pinStore.read();
  assert.equal(stale.revision, 1);
  // Instance B promotes to revision 2.
  const storeB = newStore(world, lock);
  const report = noteRow(await storeB.reconcile());
  assert.equal(report.row, 'R5');
  assert.equal(report.disposition, 'promoted');
  assert.equal(world.durable.pin.revision, 2);
  const okCount = world.counts.pinAdvanceOk;
  // A's stale CAS attempt is defeated.
  const ok = await world.pinStore.advance(
    { revision: stale.revision, digest: stale.digest },
    { revision: 2, digest: stale.digest, timestamp: world.clock.now() },
  );
  assert.equal(ok, false, 'stale expected pair loses the CAS');
  assert.equal(world.counts.pinAdvanceOk, okCount, 'no second successful advance');
  const after = noteRow(await storeA.reconcile());
  assert.equal(after.row, 'R2');
  assert.equal(after.disposition, 'healthy');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T24: pin unreachable -> commit refuses with zero writes; reconcile R1; outcome unknown', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.flags.pinReadThrows = true;
  const snap = world.writeCounts();
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unavailable');
  assert.equal(res.reason, 'pin-unavailable');
  world.noWritesSince(snap);
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R1');
  assert.equal(report.disposition, 'recovery-blocked');
  world.noWritesSince(snap);
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'unknown');
});

test('T25: altered-input replay of a committed operation -> conflict, store byte-identical', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  const alt = C.prepare(C.adopt({ householdId }), {
    householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
    now: world.clock.now(),
  });
  const snap = snapshotWorld(world);
  // Variant 1: original confirmationDigest, altered preview.
  const v1 = await store.commit({
    actorId, preview: alt.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(v1.status, 'conflict');
  // Variant 2: altered preview with its OWN self-consistent digest
  // (changed-but-self-consistent replay must still conflict).
  const v2 = await store.commit({
    actorId, preview: alt.preview, confirmationDigest: alt.confirmationDigest,
  });
  assert.equal(v2.status, 'conflict');
  // Variant 3: the original request under a different actor.
  const v3 = await store.commit({
    actorId: actor2, preview: prepared.preview,
    confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(v3.status, 'conflict');
  assertWorldUnchanged(world, snap, 'T25');
});

test('T26: fork-prefix — a rewritten earlier operation defeats promotion; R6 restores', async () => {
  // The fork is built from a LEGITIMATE rev-2 confirmed on the pinned head:
  // same appended operation, same frozen preview (expected base = the pinned
  // revision and digest), same journal. Only the FIRST operation is replaced,
  // so every R5 check except the unchanged-prefix equality passes. A positive
  // control in a second world promotes the unforged twin with the same kind of
  // journal, proving the journal is otherwise acceptable.
  async function scenario({ forge }) {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    const pinned = world.durable.doc;
    const pinnedState = stateOf(pinned);
    const p2 = C.prepare(pinned, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 3,
    });
    const legit = C.confirmCandidate(pinned, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 4,
    }).document;
    const legitState = stateOf(legit);
    let head = legit;
    if (forge) {
      // Rewrite the first operation (a different transaction) and re-seal.
      const forgedBasePrep = C.prepare(C.adopt({ householdId }), {
        householdId, actorId, operationId: op(1), command: linkCmd({ txRef: tx(7) }),
        now: world.clock.now() + 1,
      });
      const forgedBase = stateOf(C.confirmCandidate(C.adopt({ householdId }), {
        householdId, actorId, preview: forgedBasePrep.preview,
        confirmationDigest: forgedBasePrep.confirmationDigest, now: world.clock.now() + 2,
      }).document);
      assert.notEqual(C.digest(forgedBase.operations[0]), C.digest(pinnedState.operations[0]),
        'the first operation really is rewritten');
      const data = { schema: legitState.schema, householdId, revision: 2,
        operations: [forgedBase.operations[0], legitState.operations[1]] };
      head = Buffer.from(JSON.stringify({ ...data, digest: C.digest(data) }));
    }
    const headState = stateOf(head);
    const appended = headState.operations[1];
    const j = {
      version: 1, householdId, operationId: op(2), actorId,
      baseRevision: 1, baseDigest: pinOf(pinned).digest,
      baseBytes: Buffer.from(pinned).toString('base64'),
      preview: p2.preview, requestDigest: C.digest(p2.preview),
      resultingRevision: 2, resultingDigest: headState.digest,
      recordedAt: appended.recordedAt,
    };
    // Every non-prefix R5 input agrees with the journal.
    assert.equal(p2.preview.expectedRevision, 1);
    assert.equal(p2.preview.expectedDocumentDigest, pinOf(pinned).digest);
    assert.equal(appended.requestDigest, j.requestDigest);
    world.durable.doc = Buffer.from(head);
    world.durable.journal = Buffer.from(JSON.stringify(j));
    assert.equal((await loadFromWorld(world)).reason, 'document-ahead-of-pin');
    return { world, store, pinned, head, report: noteRow(await store.reconcile()) };
  }

  const control = await scenario({ forge: false });
  assert.equal(control.report.row, 'R5', 'control: the unforged twin satisfies the full R5 proof');
  assert.equal(control.report.disposition, 'promoted');

  const { world, pinned, head: forged, report } = await scenario({ forge: true });
  assert.equal(report.row, 'R6', 'prefix rewrite fails the R5 proof at the prefix check');
  assert.equal(report.disposition, 'restored-pinned');
  assert.equal(world.durable.pin.revision, 1, 'promotion never occurred');
  assert.ok(world.durable.doc.equals(pinned), 'pinned revision restored');
  assert.ok(world.durable.quarantine.some(q => q.bytes.equals(forged)), 'fork quarantined');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('T27 (condition 7): two factory instances sharing adapters and lock serialize commits', async () => {
  const world = makeWorld();
  const lock = makeLock();
  const storeA = newStore(world, lock);
  const storeB = newStore(world, lock);
  assert.equal((await storeA.bootstrap()).status, 'bootstrapped');
  world.clock.advance(10);
  await commitLink(storeA, 1);
  const prepA = await storeA.prepare({
    actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
  });
  const prepB = await storeB.prepare({
    actorId, operationId: op(3), command: linkCmd({ txRef: tx(3) }),
  });
  const [ra, rb] = await Promise.all([
    storeA.commit({
      actorId, preview: prepA.preview, confirmationDigest: prepA.confirmationDigest,
    }),
    storeB.commit({
      actorId, preview: prepB.preview, confirmationDigest: prepB.confirmationDigest,
    }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, ['committed', 'conflict'],
    'serialized: exactly one winner, the loser sees the moved base');
  assert.equal(stateOf(world.durable.doc).revision, 2, 'no lost update, no fork');
  assert.equal(world.durable.pin.revision, 2);
  assert.equal(world.durable.journal, null);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
  // Alternating instances continue coherently on the shared state.
  world.clock.advance(10);
  const loser = ra.status === 'conflict' ? { store: storeA, n: 2 } : { store: storeB, n: 3 };
  const prep = await loser.store.prepare({
    actorId, operationId: op(loser.n), command: linkCmd({ txRef: tx(loser.n) }),
  });
  const done = await loser.store.commit({
    actorId, preview: prep.preview, confirmationDigest: prep.confirmationDigest,
  });
  assert.equal(done.status, 'committed');
  assert.equal(done.revision, 3);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('correction 2: phantom R3 receipt — journal matching the head cannot invent a receipt', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  const genesis = C.adopt({ householdId });
  const phantomPrep = C.prepare(genesis, {
    householdId, actorId, operationId: op(77), command: linkCmd({ txRef: tx(77) }),
    now: world.clock.now(),
  });
  // The deleted fallback would have fired: resultingDigest == P.digest and
  // baseRevision == P.revision - 1, but op(77) is absent from the ledger.
  const j = {
    version: 1, householdId, operationId: op(77), actorId,
    baseRevision: 0, baseDigest: pinOf(genesis).digest,
    baseBytes: Buffer.from(genesis).toString('base64'),
    preview: phantomPrep.preview, requestDigest: C.digest(phantomPrep.preview),
    resultingRevision: 1, resultingDigest: world.durable.pin.digest,
    recordedAt: world.clock.now(),
  };
  world.durable.journal = Buffer.from(JSON.stringify(j));
  const report = noteRow(await store.reconcile());
  assert.notEqual(report.disposition, 'committed-recovered', 'no phantom receipt');
  assert.equal(report.receipt, undefined, 'no receipt issued');
  assert.equal(report.row, 'R4');
  assert.equal(report.disposition, 'journal-quarantined',
    'base is not the current pinned head -> quarantined as invalid (condition 9)');
  assert.equal(world.durable.journal, null, 'cleared only after quarantine');
  assert.ok(world.durable.quarantine.some(q => q.label === 'invalid-journal'));
  const out = await store.outcome({ actorId, operationId: op(77) });
  assert.equal(out.status, 'unknown');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'ledger untouched');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('correction 3: receipts name the ORIGINAL revision/digest after later commits', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const r1 = await commitLink(store, 1);
  world.clock.advance(10);
  const r2 = await commitLink(store, 2, { txRef: tx(2) });
  assert.equal(r1.revision, 1);
  assert.equal(r2.revision, 2);
  assert.notEqual(r1.digest, r2.digest);
  const out1 = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out1.status, 'committed');
  assert.equal(out1.revision, 1, 'original revision, not the current head');
  assert.equal(out1.digest, r1.digest, 'original digest, not the current head digest');
  const out2 = await store.outcome({ actorId, operationId: op(2) });
  assert.equal(out2.revision, 2);
  assert.equal(out2.digest, r2.digest);
});

test('correction 3 (commit path): retry of an earlier operation reproduces its original receipt', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prep1 = await prepareLink(store, 1);
  const r1 = await store.commit({
    actorId, preview: prep1.preview, confirmationDigest: prep1.confirmationDigest,
  });
  assert.equal(r1.status, 'committed');
  world.clock.advance(10);
  const r2 = await commitLink(store, 2, { txRef: tx(2) });
  assert.equal(r2.revision, 2);
  const snap = world.writeCounts();
  const retry = await store.commit({
    actorId, preview: prep1.preview, confirmationDigest: prep1.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, 1, 'original revision after a later commit');
  assert.equal(retry.digest, r1.digest, 'original digest after a later commit');
  world.noWritesSince(snap);
});

test('correction 5: journal write durable-but-ack-lost -> unknown, resolved from actual state', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('journal.write', 'throw-landed');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.equal(res.reason, 'journal-write-ambiguous');
  assert.ok(world.durable.journal, 'the journal DID land; absence was not assumed');
  assert.equal(stateOf(world.durable.doc).revision, 0, 'no further writes after the ambiguous step');
  assert.equal(world.durable.pin.revision, 0);
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'unknown', 'journal-resident operation stays unknown (F4)');
  // Identical retry: the pre-pass resolves the actual journal state
  // (R4 not-committed) and the commit then executes — the journal is
  // dispositioned by the reconciler, never blindly overwritten.
  const writesBefore = world.counts.journalWrite;
  const retry = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, 1);
  assert.equal(world.counts.journalWrite, writesBefore + 1,
    'exactly one fresh journal write, after the reconciler cleared the old one');
  assert.equal(world.durable.journal, null);
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('F-B/F3: backup ack validation at C7 and manifest-hit binding at promotion', async () => {
  for (const mode of ['bad-ack-digest', 'bad-ack-no-artifact', 'bad-ack-nonrecord', 'bad-ack-null', 'throw-landed']) {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', mode);
    const res = await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    assert.equal(res.status, 'unknown', mode);
    assert.equal(res.reason, 'backup-ambiguous', mode);
    assert.equal(world.durable.pin.revision, 0, mode + ': pin never advances on an ambiguous ack');
    if (mode !== 'throw-landed' && !mode.startsWith('bad-ack')) continue;
    // The artifact WAS stored: promotion completes from the validated
    // manifest hit without a second put.
    const putsBefore = world.counts.backupPut;
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R5', mode);
    assert.equal(report.disposition, 'promoted', mode);
    assert.equal(world.counts.backupPut, putsBefore, mode + ': manifest hit, no re-put');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // A malformed manifest entry is NOT a hit: promotion must put.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    world.failNext('backup.list', () => [{ revision: 1 }]);
    const putsBefore = world.counts.backupPut;
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R5');
    assert.equal(report.disposition, 'promoted');
    assert.equal(world.counts.backupPut, putsBefore + 1,
      'malformed manifest entry ignored -> put performed');
  }
});

test('condition 6: malformed pin shape inside the machine -> blocked, never absence', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  world.durable.pinRaw = { revision: 'one', digest: 42 };
  const snap = world.writeCounts();
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R1');
  assert.equal(report.disposition, 'recovery-blocked');
  world.noWritesSince(snap);
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'unknown');
  const res = await store.commit({
    actorId, preview: { operationId: op(2) }, confirmationDigest: 'a'.repeat(64),
  });
  assert.equal(res.status, 'unavailable');
  world.noWritesSince(snap);
  world.durable.pinRaw = undefined;
  const healed = noteRow(await store.reconcile());
  assert.equal(healed.row, 'R2', 'a readable pin again -> healthy');
});

test('condition 8: bootstrap refuses on staged-temp-only and other single traces', async () => {
  for (const trace of ['temp', 'pin', 'journal', 'backup']) {
    const world = makeWorld();
    if (trace === 'temp') world.durable.temp = Buffer.from('staged-bytes');
    if (trace === 'pin') {
      const g = C.adopt({ householdId });
      world.durable.pin = { revision: 0, digest: pinOf(g).digest, timestamp: T0 };
    }
    if (trace === 'journal') world.durable.journal = Buffer.from('{}');
    if (trace === 'backup') {
      world.durable.backups.set('0:' + 'f'.repeat(64), {
        revision: 0, digest: 'f'.repeat(64), artifactId: 'a', bytes: Buffer.from('x'),
      });
    }
    const store = newStore(world);
    const boot = await store.bootstrap();
    assert.equal(boot.status, 'rejected', trace);
    assert.equal(boot.reason, 'already-bootstrapped', trace);
  }
});

test('condition 10: restore verifies readback — a swapped install is recovery-blocked, not restored', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  world.durable.doc = C.adopt({ householdId }); // behind pin -> R7 restore
  world.failNext('doc.commitTemp', 'swap-garbage');
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R7');
  assert.equal(report.disposition, 'recovery-blocked');
  assert.equal(report.reason, 'restore-readback-failed');
  assert.equal((await loadFromWorld(world)).status, 'unavailable', 'no false restored claim');
});

test('condition 10 / F-D: quarantine failure blocks the overwrite; divergent bytes preserved', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  await commitLink(store, 1);
  const genesis = C.adopt({ householdId });
  world.durable.doc = Buffer.from(genesis); // behind pin -> R7
  world.failNext('quarantine.put', 'throw');
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R7');
  assert.equal(report.disposition, 'recovery-blocked');
  assert.ok(world.durable.doc.equals(genesis), 'document NOT overwritten when quarantine fails');
  // With quarantine healthy again the restore proceeds.
  const healed = noteRow(await store.reconcile());
  assert.equal(healed.disposition, 'restored-pinned');
  assert.equal((await loadFromWorld(world)).status, 'qualified');
});

test('coverage: every reconciler row R0-R8 was exercised', () => {
  assert.deepEqual([...seenRows].sort(),
    ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']);
});

// === Round 2 repair pins (Systems Review BLOCKING issuecomment-6278199286) ==
// B1: pinStore.advance success requires the literal value true at commit,
// promotion, and bootstrap; a malformed staged read refuses genesis.
// B2: commit snapshots the request at public entry (before the lock), and
// a resident journal binds the supplied actor as well as the digest.
// B3: an unavailable or malformed backup manifest never selects a
// destructive reconciliation row (R6/R7/R8).

// B1 caller-boundary repair: a distinct lock-scoped no-recovery capability.
// All incumbent ordinary commit/reconcile controls below remain intact.
test('B1 no-recovery: capability is distinct and ordinary commits remain available', async () => {
  const { store } = await bootWorld();
  assert.equal(typeof store.commitWithoutRecovery, 'function');
  assert.notEqual(store.commitWithoutRecovery, store.commit);
  const prepared = await prepareLink(store, 1);
  assert.equal((await store.commitWithoutRecovery(confirmedRequest(prepared))).status, 'committed');
});

test('B1 no-recovery: recovery policy is private, never a caller request option', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const interrupted = await prepareLink(store, 2, { txRef: tx(2), actorId: actor2 });
  world.failNext('backup.put', 'throw');
  assert.equal((await store.commit(confirmedRequest(interrupted, actor2))).status, 'unknown');
  const before = retainedBytes(world), writes = world.writeCounts();
  assert.deepEqual(await store.commitWithoutRecovery({ ...confirmedRequest(prepared), allowRecovery: true }),
    { status: 'rejected', reason: 'recovery-required' });
  world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before);
  assert.deepEqual(await store.commit({ ...confirmedRequest(prepared), allowRecovery: false }), { status: 'conflict' });
  assert.equal(world.durable.pin.revision, 1, 'ordinary commit still performed R5 despite the ignored caller option');
  assert.equal(world.durable.journal, null);
});

for (const state of ['valid-unlanded-journal', 'valid-landed-journal', 'torn-journal',
  'unrelated-journal', 'missing-head', 'corrupt-head', 'behind-head', 'forked-pin', 'missing-pin']) {
  test('B1 no-recovery: definite pre-write refusal preserves all bytes for ' + state, async () => {
    const { world, store } = await bootWorld();
    const genesis = Buffer.from(world.durable.doc);
    const prepared = await prepareLink(store, 1);
    if (state.startsWith('valid-') || state === 'unrelated-journal') {
      const other = await prepareLink(store, 2, { actorId: actor2, txRef: tx(2) });
      world.failNext(state === 'valid-landed-journal' ? 'backup.put' : 'doc.writeTemp', 'throw');
      assert.equal((await store.commit(confirmedRequest(other, actor2))).status, 'unknown');
      if (state === 'unrelated-journal') {
        const journal = JSON.parse(world.durable.journal);
        journal.baseDigest = 'f'.repeat(64); // valid shape but unrelated base: ordinary R4 would quarantine.
        world.durable.journal = Buffer.from(JSON.stringify(journal));
      }
    } else if (state === 'torn-journal') world.durable.journal = Buffer.from('{');
    else if (state === 'missing-head') world.durable.doc = null;
    else if (state === 'corrupt-head') world.durable.doc = Buffer.from('synthetic-corruption');
    else if (state === 'behind-head') { await commitLink(store, 2); world.durable.doc = genesis; }
    else if (state === 'forked-pin') world.durable.pin.digest = 'f'.repeat(64);
    else if (state === 'missing-pin') world.durable.pin = null;
    world.durable.temp = Buffer.from('synthetic-retained-stage');
    world.durable.quarantine.push({ label: 'synthetic-retained', bytes: Buffer.from('synthetic-quarantine') });
    const before = retainedBytes(world), writes = world.writeCounts();
    assert.deepEqual(await store.commitWithoutRecovery(confirmedRequest(prepared)), { status: 'rejected', reason: 'recovery-required' });
    world.noWritesSince(writes);
    assert.deepEqual(retainedBytes(world), before);
    assert.equal((await store.outcome({ actorId, operationId: op(1) })).status, 'unknown');
  });
}

test('B1 no-recovery: committed receipt precedes expiry/later head/restart and leaves every residual journal untouched', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
  await commitLink(store, 2, { txRef: tx(2) });
  world.clock.advance(C.TTL_MS + 1);
  const restarted = newStore(world);
  for (const residual of [null, Buffer.from('{'), Buffer.from(JSON.stringify({ unrelated: true }))]) {
    world.durable.journal = residual;
    const before = retainedBytes(world), writes = world.writeCounts();
    assert.deepEqual(await restarted.commitWithoutRecovery(confirmedRequest(prepared)), receipt);
    world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before);
  }
  world.failNext('journal.read', 'throw');
  assert.deepEqual(await restarted.commitWithoutRecovery(confirmedRequest(prepared)), receipt,
    'pin and valid ledger prove the original receipt even when journal reads are unavailable');
  assert.notEqual(receipt.digest, stateOf(world.durable.doc).digest);
});

test('B1 no-recovery: C1 pre-write recheck refuses newly divergent bytes without recovery', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  let atChange, writesAtChange;
  world.failNext('doc.read', read => {
    const previous = read();
    world.durable.doc = Buffer.from('synthetic-changed-between-C0-and-C1');
    atChange = retainedBytes(world); writesAtChange = world.writeCounts();
    return previous;
  });
  assert.deepEqual(await store.commitWithoutRecovery(confirmedRequest(prepared)),
    { status: 'rejected', reason: 'recovery-required' });
  world.noWritesSince(writesAtChange); assert.deepEqual(retainedBytes(world), atChange);
});

test('B1 no-recovery: altered previews and foreign actors conflict before any recovery or mutation', async () => {
  for (const committed of [false, true]) {
    const { world, store } = await bootWorld();
    const prepared = await prepareLink(store, 1);
    if (!committed) world.failNext('doc.writeTemp', 'throw');
    await store.commit(confirmedRequest(prepared));
    const changed = JSON.parse(JSON.stringify(prepared));
    changed.preview.command.assignedCents++;
    for (const input of [confirmedRequest(prepared, actor2), confirmedRequest(changed),
      { ...confirmedRequest(changed), confirmationDigest: C.digest(changed.preview) }]) {
      const before = retainedBytes(world), writes = world.writeCounts();
      assert.deepEqual(await store.commitWithoutRecovery(input), { status: 'conflict' });
      world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before);
    }
  }
});

for (const method of ['commitWithoutRecovery', 'commit']) {
  test('B1 C8 fresh-pin mismatch: ' + method + ' keeps its recovery policy', async () => {
    const { world, store } = await bootWorld();
    const prepared = await prepareLink(store, 1);
    let atMovement, writesAtMovement;
    world.failNext('backup.put', (put, revision, digest) => {
      const ack = put();
      world.durable.pin = { revision, digest, timestamp: world.clock.now() };
      atMovement = retainedBytes(world); writesAtMovement = world.writeCounts();
      return ack;
    });
    assert.deepEqual(await store[method](confirmedRequest(prepared)), { status: 'unknown', reason: 'pin-moved' });
    if (method === 'commitWithoutRecovery') {
      world.noWritesSince(writesAtMovement);
      assert.deepEqual(retainedBytes(world), atMovement, 'interrupted bytes survive despite an externally advanced pin');
      const before = retainedBytes(world), writes = world.writeCounts();
      assert.equal((await store.commitWithoutRecovery(confirmedRequest(prepared))).status, 'committed');
      world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before, 'receipt retry does not clear the residual journal');
    } else assert.equal(world.durable.journal, null, 'ordinary commit still executes R3 recovery');
  });

  test('B1 C8 CAS false: ' + method + ' keeps its recovery policy', async () => {
    const { world, store } = await bootWorld();
    const prepared = await prepareLink(store, 1);
    let atFailure, writesAtFailure;
    world.failNext('pin.advance', () => {
      atFailure = retainedBytes(world); writesAtFailure = world.writeCounts(); return false;
    });
    assert.deepEqual(await store[method](confirmedRequest(prepared)), { status: 'unknown', reason: 'pin-moved' });
    if (method === 'commitWithoutRecovery') {
      world.noWritesSince(writesAtFailure); assert.deepEqual(retainedBytes(world), atFailure);
      assert.equal(world.durable.pin.revision, 0);
      assert(world.durable.journal);
      const before = retainedBytes(world), writes = world.writeCounts();
      assert.deepEqual(await store.commitWithoutRecovery(confirmedRequest(prepared)), { status: 'rejected', reason: 'recovery-required' });
      world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before);
      assert.equal((await store.reconcile()).disposition, 'promoted', 'explicit ordinary R5 recovery remains available');
    } else {
      assert.equal(world.durable.pin.revision, 1, 'ordinary commit still promotes via R5');
      assert.equal(world.durable.journal, null);
    }
  });
}

for (const [method, fault, landed] of [
  ['journal.write', 'throw-landed', false], ['doc.commitTemp', 'throw-landed', false],
  ['backup.put', 'throw-landed', false], ['pin.advance', () => ({ ok: true }), false],
  ['pin.advance', perform => { perform(); throw Error('synthetic lost pin ack'); }, true],
  ['pin.advance', perform => { perform(); return { ok: true }; }, true],
]) {
  test('B1 no-recovery: uncertainty from ' + method + ' preserves interrupted state; landed=' + landed, async () => {
    const { world, store } = await bootWorld();
    const prepared = await prepareLink(store, 1);
    world.failNext(method, fault);
    assert.equal((await store.commitWithoutRecovery(confirmedRequest(prepared))).status, 'unknown');
    assert(world.durable.journal);
    const before = retainedBytes(world), writes = world.writeCounts();
    const retry = await newStore(world).commitWithoutRecovery(confirmedRequest(prepared));
    assert.equal(retry.status, landed ? 'committed' : 'rejected');
    if (!landed) assert.equal(retry.reason, 'recovery-required');
    world.noWritesSince(writes); assert.deepEqual(retainedBytes(world), before);
  });
}

test('B1 no-recovery: owns caller input before one shared-lock wait', async () => {
  const world = makeWorld(), baseLock = makeLock();
  let lockCalls = 0;
  const lock = { withLock(fn) { lockCalls++; return baseLock.withLock(fn); } };
  const store = newStore(world, lock);
  await store.bootstrap();
  const prepared = await prepareLink(store, 1);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = baseLock.withLock(async () => { enter(); await gate; });
  await entered;
  const request = confirmedRequest(JSON.parse(JSON.stringify(prepared)));
  const previousLockCalls = lockCalls;
  const pending = store.commitWithoutRecovery(request);
  request.actorId = actor2; request.preview.operationId = op(99);
  request.preview.command.assignedCents = 6000; request.confirmationDigest = 'f'.repeat(64);
  release(); await holding;
  const result = await pending;
  assert.equal(lockCalls, previousLockCalls + 1, 'exactly one lock acquisition, no nested wrapper lock');
  assert.equal(result.status, 'committed'); assert.equal(result.operationId, op(1));
  assert.equal(stateOf(world.durable.doc).operations[0].command.assignedCents, 2500);
});

test('B1 no-recovery: two instances share the same lock for duplicate and stale operations', async () => {
  for (const duplicate of [true, false]) {
    const world = makeWorld(), lock = makeLock();
    const first = newStore(world, lock), second = newStore(world, lock);
    await first.bootstrap();
    const a = await prepareLink(first, 1), b = duplicate ? a : await prepareLink(second, 2);
    const before = world.counts.journalWrite;
    const [ra, rb] = await Promise.all([first.commitWithoutRecovery(confirmedRequest(a)), second.commitWithoutRecovery(confirmedRequest(b))]);
    assert.equal(ra.status, 'committed');
    if (duplicate) assert.deepEqual(rb, ra); else assert.deepEqual(rb, { status: 'conflict' });
    assert.equal(world.counts.journalWrite, before + 1);
    assert.equal(world.durable.pin.revision, 1);
    assert.equal(stateOf(world.durable.doc).operations.length, 1);
  }
});

test('B1 no-recovery: expiry/revision/conservation and successful own finalization remain contract-owned', async () => {
  const { world, store } = await bootWorld();
  const stale = await prepareLink(store, 1), current = await prepareLink(store, 2);
  const receipt = await store.commitWithoutRecovery(confirmedRequest(current));
  assert.equal(receipt.status, 'committed'); assert.equal(world.durable.journal, null);
  const writes = world.writeCounts();
  assert.deepEqual(await store.commitWithoutRecovery(confirmedRequest(stale)), { status: 'conflict' });
  world.noWritesSince(writes);
  // Rule D fixture note: the scenarios below prepare against a state whose
  // (commitment:near, tx(1)) pair is already actively allocated, so each
  // uses a pair that is still free. Expiry is a property of the preview,
  // and conservation is a per-transaction budget that spans goals, so the
  // machinery exercised is unchanged.
  const expired = await prepareLink(store, 3, { txRef: tx(3) });
  world.clock.advance(C.TTL_MS);
  assert.deepEqual(await store.commitWithoutRecovery(confirmedRequest(expired)), { status: 'rejected', reason: 'preview-expired' });
  world.noWritesSince(writes);
  world.clock.advance(1);
  const oversized = await prepareLink(store, 4, { goalId: 'commitment:far' });
  oversized.preview.command.assignedCents = 3501; // 2500 + 3501 > 6000 independently.
  oversized.confirmationDigest = C.digest(oversized.preview);
  assert.equal((await store.commitWithoutRecovery(confirmedRequest(oversized))).status, 'unavailable');
  world.noWritesSince(writes);
});

test('B1 commit: a truthy non-boolean advance ack never commits', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('pin.advance', () => ({ ok: false }));
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown', 'a truthy non-boolean ack is not CAS success');
  assert.equal(world.durable.pin.revision, 0, 'pin never moved');
  assert.ok(world.durable.journal, 'journal resident: recovery evidence preserved');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'candidate landed, unpinned');
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'unknown');
  const report = noteRow(await newStore(world).reconcile());
  assert.equal(report.row, 'R5');
  assert.equal(report.disposition, 'promoted');
  const retry = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, 1);
});

test('B1 commit lost-ack: advance landed, ack malformed -> unknown now, R3 resolves', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('pin.advance', perform => { perform(); return { ok: true }; });
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown', 'success is never fabricated from a malformed ack');
  assert.equal(world.durable.pin.revision, 1, 'the advance had in fact landed');
  assert.ok(world.durable.journal, 'journal resident (W5), not cleared on an ambiguous ack');
  const report = noteRow(await newStore(world).reconcile());
  assert.equal(report.row, 'R3');
  assert.equal(report.disposition, 'committed-recovered');
  assert.equal(report.receipt.operationId, op(1));
  assert.equal(world.durable.journal, null);
});

test('B1 promotion: a truthy non-boolean advance ack neither promotes nor clears J', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('backup.put', 'throw');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  world.failNext('pin.advance', () => ({ ok: false }));
  const blocked = noteRow(await newStore(world).reconcile());
  assert.equal(blocked.row, 'R5');
  assert.equal(blocked.disposition, 'promotion-pending', 'no fabricated promotion');
  assert.equal(world.durable.pin.revision, 0, 'pin untouched');
  assert.ok(world.durable.journal, 'journal NOT cleared on a malformed ack');
  const healed = noteRow(await newStore(world).reconcile());
  assert.equal(healed.disposition, 'promoted');
  assert.equal(world.durable.pin.revision, 1);
  assert.equal(world.durable.journal, null);
});

test('B1 promotion controls: literal false re-runs the table; a landed advance with a lost ack resolves from the observed pin', async () => {
  // Literal false = compare failure: the reconciler re-evaluates and the
  // retry of the CAS promotes.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    world.failNext('pin.advance', 'false');
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.disposition, 'promoted');
    assert.equal(world.durable.pin.revision, 1);
    assert.equal(world.durable.journal, null);
  }
  // Lost ack: the advance landed but returned a non-boolean. Promotion is
  // reported only because the freshly observed pin covers the head.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('backup.put', 'throw');
    await store.commit({
      actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
    });
    world.failNext('pin.advance', perform => { perform(); return { ok: true }; });
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.disposition, 'promoted');
    assert.equal(world.durable.pin.revision, 1);
    assert.equal(world.durable.journal, null);
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
});

test('B1 bootstrap: a truthy non-boolean advance ack is not genesis', async () => {
  const world = makeWorld();
  const store = newStore(world);
  world.failNext('pin.advance', () => ({ ok: false }));
  const boot = await store.bootstrap();
  assert.equal(boot.status, 'unavailable', 'no fabricated bootstrapped result');
  assert.equal(world.durable.pin, null, 'pin never advanced');
  const report = noteRow(await newStore(world).reconcile());
  assert.equal(report.row, 'R1');
  assert.equal(report.disposition, 'recovery-blocked', 'interrupted genesis over traces');
  const again = await newStore(world).bootstrap();
  assert.equal(again.status, 'rejected', 'no re-genesis over traces');
});

test('B1 bootstrap controls: literal false -> pin-moved; landed advance with a lost ack -> healthy state', async () => {
  {
    const world = makeWorld();
    world.failNext('pin.advance', 'false');
    const boot = await newStore(world).bootstrap();
    assert.equal(boot.status, 'unavailable');
    assert.equal(boot.reason, 'pin-moved');
    assert.equal(world.durable.pin, null);
  }
  {
    const world = makeWorld();
    const store = newStore(world);
    world.failNext('pin.advance', perform => { perform(); return { ok: true }; });
    const boot = await store.bootstrap();
    assert.equal(boot.status, 'unavailable',
      'bootstrap does not claim success from a malformed ack');
    assert.equal(world.durable.pin.revision, 0, 'the advance had in fact landed');
    const report = noteRow(await newStore(world).reconcile());
    assert.equal(report.row, 'R2');
    assert.equal(report.disposition, 'healthy');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
});

test('B1 bootstrap: malformed readStaged output refuses genesis with zero writes', async () => {
  for (const bad of [undefined, false, 0, 'staged-string', 42]) {
    const world = makeWorld();
    const store = newStore(world);
    world.failNext('doc.readStaged', () => bad);
    const snap = world.writeCounts();
    const boot = await store.bootstrap();
    assert.equal(boot.status, 'unavailable', 'readStaged -> ' + String(bad));
    world.noWritesSince(snap);
    assert.equal(world.durable.doc, null, 'readStaged -> ' + String(bad));
    assert.equal(world.durable.pin, null, 'readStaged -> ' + String(bad));
    assert.equal(world.durable.backups.size, 0, 'readStaged -> ' + String(bad));
  }
  // Controls: null proves absence (normal genesis proceeds — T19), and
  // real staged bytes are a trace (condition 8 test above).
  const world = makeWorld();
  assert.equal((await newStore(world).bootstrap()).status, 'bootstrapped');
});

test('B2: commit snapshots the request at entry — mutation during C7 / during the lock wait cannot rename the operation', async () => {
  const world = makeWorld();
  const lock = makeLock();
  const store = newStore(world, lock);
  assert.equal((await store.bootstrap()).status, 'bootstrapped');
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const req = {
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  };
  let release;
  const gate = new Promise(r => { release = r; });
  let entered;
  const enteredP = new Promise(r => { entered = r; });
  world.failNext('backup.put', async perform => { entered(); await gate; return perform(); });
  const p1 = store.commit(req); // runs to the C7 pause, holding the lock
  await enteredP;
  const p2 = store.commit(req); // queued on the lock; its snapshot is already taken
  req.preview.operationId = op(99); // the caller mutates the retained object
  release();
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.status, 'committed');
  assert.equal(r1.operationId, op(1), 'receipt names the submitted operation, not the mutation');
  assert.equal(r2.status, 'committed');
  assert.equal(r2.operationId, op(1));
  assert.equal(r2.revision, 1);
  const ops = stateOf(world.durable.doc).operations;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operationId, op(1), 'ledger holds the original operation');
  const out99 = await store.outcome({ actorId, operationId: op(99) });
  assert.equal(out99.status, 'unknown');
});

test('B2: mutation of the retained preview during the C7 backup pause — receipt and ledger keep the original identity', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const req = {
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  };
  world.failNext('backup.put', perform => { req.preview.operationId = op(99); return perform(); });
  const res = await store.commit(req);
  assert.equal(res.status, 'committed');
  assert.equal(res.operationId, op(1));
  const ops = stateOf(world.durable.doc).operations;
  assert.equal(ops[0].operationId, op(1));
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.status, 'committed');
});

test('B2: a foreign actor retrying a resident unlanded journal conflicts BEFORE any pre-pass mutation', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('doc.writeTemp', 'throw');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.ok(world.durable.journal, 'journal resident');
  const snap = snapshotWorld(world);
  // The original preview and digest, retried under a DIFFERENT actor.
  const foreign = await store.commit({
    actorId: actor2, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(foreign.status, 'conflict');
  assertWorldUnchanged(world, snap, 'B2 unlanded foreign retry');
  assert.ok(world.durable.journal, 'the original actor journal survives the foreign retry');
  // A self-consistent altered preview under the foreign actor: same rule.
  const alt = C.prepare(C.adopt({ householdId }), {
    householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
    now: world.clock.now(),
  });
  const foreignAlt = await store.commit({
    actorId: actor2, preview: alt.preview, confirmationDigest: alt.confirmationDigest,
  });
  assert.equal(foreignAlt.status, 'conflict');
  assertWorldUnchanged(world, snap, 'B2 unlanded foreign altered retry');
  // The honest retry by the original actor still commits.
  const honest = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(honest.status, 'committed');
  assert.equal(honest.revision, 1);
});

test('B2: a foreign actor retrying a landed-unpinned journal conflicts without promoting it', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('backup.put', 'throw');
  const res = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(res.status, 'unknown');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'candidate landed');
  assert.equal(world.durable.pin.revision, 0, 'unpinned');
  const snap = snapshotWorld(world);
  const foreign = await store.commit({
    actorId: actor2, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(foreign.status, 'conflict');
  assertWorldUnchanged(world, snap, 'B2 landed foreign retry: no promotion, no journal clear');
  assert.equal(world.durable.pin.revision, 0);
  assert.ok(world.durable.journal);
  const honest = await store.commit({
    actorId, preview: prepared.preview, confirmationDigest: prepared.confirmationDigest,
  });
  assert.equal(honest.status, 'committed');
  assert.equal(honest.revision, 1);
});

test('B3: an unavailable or malformed manifest never selects a destructive row (R6/R7/R8)', async () => {
  // R7 — the review's concrete shape: pin revision 1, document at
  // genesis, a valid revision-1 backup, and the manifest read throws.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = C.adopt({ householdId });
    const snap = world.writeCounts();
    const worldSnap = snapshotWorld(world);
    world.failNext('backup.list', 'throw');
    const report = noteRow(await store.reconcile());
    assert.equal(report.disposition, 'recovery-blocked');
    world.noWritesSince(snap);
    assertWorldUnchanged(world, worldSnap, 'B3 R7: no overwrite, no quarantine, no journal clear');
    assert.equal(stateOf(world.durable.doc).revision, 0, 'divergent head left in place');
    // Healed manifest: the identical state restores normally (control).
    const healed = noteRow(await store.reconcile());
    assert.equal(healed.row, 'R7');
    assert.equal(healed.disposition, 'restored-pinned');
    assert.equal((await loadFromWorld(world)).status, 'qualified');
  }
  // R6 — head ahead of the pin, manifest read throws.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    const p2 = C.prepare(world.durable.doc, {
      householdId, actorId, operationId: op(2), command: linkCmd({ txRef: tx(2) }),
      now: world.clock.now() + 1,
    });
    world.durable.doc = Buffer.from(C.confirmCandidate(world.durable.doc, {
      householdId, actorId, preview: p2.preview,
      confirmationDigest: p2.confirmationDigest, now: world.clock.now() + 2,
    }).document);
    const snap = world.writeCounts();
    const worldSnap = snapshotWorld(world);
    world.failNext('backup.list', 'throw');
    const report = noteRow(await store.reconcile());
    assert.equal(report.disposition, 'recovery-blocked');
    world.noWritesSince(snap);
    assertWorldUnchanged(world, worldSnap, 'B3 R6');
    assert.equal(stateOf(world.durable.doc).revision, 2, 'ahead head left in place');
  }
  // R8 — document missing, manifest read throws.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = null;
    const snap = world.writeCounts();
    world.failNext('backup.list', 'throw');
    const report = noteRow(await store.reconcile());
    assert.equal(report.disposition, 'recovery-blocked');
    world.noWritesSince(snap);
    assert.equal(world.durable.doc, null, 'nothing fabricated or installed');
  }
  // Malformed manifest entries block the destructive row the same way.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    await commitLink(store, 1);
    world.durable.doc = C.adopt({ householdId });
    const snap = world.writeCounts();
    const worldSnap = snapshotWorld(world);
    world.failNext('backup.list', () => [{ revision: 1 }]);
    const report = noteRow(await store.reconcile());
    assert.equal(report.disposition, 'recovery-blocked');
    world.noWritesSince(snap);
    assertWorldUnchanged(world, worldSnap, 'B3 malformed manifest');
  }
});

// === P2 settled-uncertainty inspection (inspectAttempt) ==================
// Trusted read-only inspection for the controller's retained uncertain
// attempt: it establishes only committed / not-committed / unresolved from
// the validated pinned ledger, returns store readiness separately
// (qualified pinned head + successfully read ABSENT journal), snapshots
// its input before the shared lock, and never writes, commits, reconciles,
// promotes, restores or clears a journal.

test('P2 inspect: durable commit -> committed + ready, zero writes by inspection', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
  assert.equal(receipt.status, 'committed');
  const snap = world.writeCounts();
  const worldSnap = snapshotWorld(world);
  const result = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(result, { disposition: 'committed', ready: true });
  world.noWritesSince(snap);
  assertWorldUnchanged(world, worldSnap, 'P2 inspect committed');
});

test('P2 inspect: never-attempted preview at the exact pinned base -> not-committed + ready', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const snap = world.writeCounts();
  const result = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(result, { disposition: 'not-committed', ready: true });
  world.noWritesSince(snap);
  assert.equal(world.durable.journal, null);
  assert.equal(world.durable.pin.revision, 0);
});

test('P2 inspect: journal-resident unlanded attempt is not-committed but NOT ready until explicit R4 cleanup', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('doc.writeTemp', 'throw');
  const res = await store.commitWithoutRecovery(confirmedRequest(prepared));
  assert.equal(res.status, 'unknown');
  assert.ok(world.durable.journal, 'journal resident after temp failure');
  const snap = world.writeCounts();
  const before = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(before, { disposition: 'not-committed', ready: false },
    'inspection alone cannot unlock while the journal is resident');
  world.noWritesSince(snap);
  assert.ok(world.durable.journal, 'inspection never clears a journal');
  // Explicit reconciliation whose journal clear fails: the R4 report says
  // not-committed, but a FRESH inspection still finds the journal resident.
  world.failNext('journal.clear', 'throw');
  const blockedReport = noteRow(await store.reconcile());
  assert.equal(blockedReport.row, 'R4');
  assert.equal(blockedReport.disposition, 'not-committed');
  assert.equal(blockedReport.detail, 'journal-clear-failed');
  assert.ok(world.durable.journal, 'journal survives the failed clear');
  const stillBlocked = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(stillBlocked, { disposition: 'not-committed', ready: false },
    'a cached/caller-supplied R4 report is never trusted: readiness is re-read');
  // Successful explicit R4 cleanup, then a fresh inspection of the pinned
  // base proves the attempt not committed and the store ready.
  const report = noteRow(await store.reconcile());
  assert.equal(report.row, 'R4');
  assert.equal(report.disposition, 'not-committed');
  assert.equal(world.durable.journal, null);
  const after = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(after, { disposition: 'not-committed', ready: true });
});

test('P2 inspect: known disposition is not readiness — resident or unreadable journal after a commit stays not ready', async () => {
  // (a) W5 leftover: commit landed, journal clear failed at C9.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.failNext('journal.clear', 'throw');
    const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
    assert.equal(receipt.status, 'committed');
    assert.ok(world.durable.journal, 'leftover journal resident');
    const result = await store.inspectAttempt(confirmedRequest(prepared));
    assert.deepEqual(result, { disposition: 'committed', ready: false });
    assert.ok(world.durable.journal, 'inspection left the journal in place');
  }
  // (b) Journal read itself fails: disposition still established from the
  // pinned ledger, readiness false.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    assert.equal((await store.commitWithoutRecovery(confirmedRequest(prepared))).status, 'committed');
    world.failNext('journal.read', 'throw');
    const result = await store.inspectAttempt(confirmedRequest(prepared));
    assert.deepEqual(result, { disposition: 'committed', ready: false });
  }
});

test('P2 inspect: unreadable or divergent pin/head -> unresolved + not ready, zero writes', async () => {
  // Pin unreadable.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.flags.pinReadThrows = true;
    const snap = world.writeCounts();
    assert.deepEqual(await store.inspectAttempt(confirmedRequest(prepared)),
      { disposition: 'unresolved', ready: false });
    world.noWritesSince(snap);
  }
  // Corrupt head bytes.
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.durable.doc = Buffer.from('synthetic-corruption');
    assert.deepEqual(await store.inspectAttempt(confirmedRequest(prepared)),
      { disposition: 'unresolved', ready: false });
    assert.equal(world.durable.doc.toString(), 'synthetic-corruption', 'inspection never restores');
  }
  // Forked pin (pin digest names no validated head).
  {
    const { world, store } = await bootWorld();
    world.clock.advance(10);
    const prepared = await prepareLink(store, 1);
    world.durable.pin.digest = 'f'.repeat(64);
    assert.deepEqual(await store.inspectAttempt(confirmedRequest(prepared)),
      { disposition: 'unresolved', ready: false });
  }
  // Unbootstrapped store.
  {
    const world = makeWorld();
    const store = newStore(world);
    const fake = {
      actorId, confirmationDigest: 'a'.repeat(64),
      preview: { operationId: op(1), actorId, householdId, expectedRevision: 0 },
    };
    const result = await store.inspectAttempt(fake);
    assert.equal(result.disposition, 'unresolved');
    assert.equal(result.ready, false);
  }
});

test('P2 inspect: wrong actor/digest/base, same-ID mismatch, advanced-head absence and malformed proof are unresolved', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  assert.equal((await store.commitWithoutRecovery(confirmedRequest(prepared))).status, 'committed');
  const snap = world.writeCounts();
  // Wrong actor for a committed operation (mismatched same-ID record).
  assert.deepEqual(await store.inspectAttempt(confirmedRequest(prepared, actor2)),
    { disposition: 'unresolved', ready: true });
  // Wrong confirmation digest.
  assert.deepEqual(await store.inspectAttempt({ ...confirmedRequest(prepared), confirmationDigest: 'f'.repeat(64) }),
    { disposition: 'unresolved', ready: true });
  // Same operation id, altered preview with its own self-consistent digest.
  const alt = C.prepare(C.adopt({ householdId }), {
    householdId, actorId, operationId: op(1), command: linkCmd({ assignedCents: 3000 }),
    now: world.clock.now(),
  });
  assert.deepEqual(await store.inspectAttempt(confirmedRequest(alt)),
    { disposition: 'unresolved', ready: true });
  // Advanced head without the attempt: a preview minted at revision 0 whose
  // operation is absent from the revision-1 head is NOT not-committed.
  const stale = C.prepare(C.adopt({ householdId }), {
    householdId, actorId, operationId: op(9), command: linkCmd({ txRef: tx(9) }),
    now: world.clock.now(),
  });
  assert.deepEqual(await store.inspectAttempt(confirmedRequest(stale)),
    { disposition: 'unresolved', ready: true },
    'absence at an advanced head proves nothing about the retained base');
  // Malformed proof shapes.
  for (const bad of [null, {}, { actorId, preview: null, confirmationDigest: 'a'.repeat(64) },
    { actorId: 'forged', preview: prepared.preview, confirmationDigest: prepared.confirmationDigest },
    { actorId, preview: { ...prepared.preview, expiresAt: prepared.preview.expiresAt + 1 },
      confirmationDigest: prepared.confirmationDigest },
    { actorId, preview: { ...prepared.preview, extraKey: 1 },
      confirmationDigest: C.digest({ ...prepared.preview, extraKey: 1 }) },
    { actorId, preview: prepared.preview, confirmationDigest: 'not-a-hash' }]) {
    const result = await store.inspectAttempt(bad);
    assert.equal(result.disposition, 'unresolved', JSON.stringify(bad && bad.actorId));
    assert.equal(result.ready, false, 'malformed proof is never ready');
  }
  world.noWritesSince(snap);
});

test('P2 inspect: a promotable landed-unpinned state is reported, never promoted or reconciled by inspection', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  world.failNext('backup.put', 'throw');
  const res = await store.commitWithoutRecovery(confirmedRequest(prepared));
  assert.equal(res.status, 'unknown');
  assert.equal(stateOf(world.durable.doc).revision, 1, 'candidate landed');
  assert.equal(world.durable.pin.revision, 0, 'unpinned');
  const snap = world.writeCounts();
  const worldSnap = snapshotWorld(world);
  const result = await store.inspectAttempt(confirmedRequest(prepared));
  assert.equal(result.disposition, 'unresolved', 'head is not the validated pinned ledger');
  assert.equal(result.ready, false);
  world.noWritesSince(snap);
  assertWorldUnchanged(world, worldSnap, 'P2 inspect W3: no promotion, no restore, no journal clear');
  assert.equal(world.durable.pin.revision, 0);
  assert.ok(world.durable.journal);
});

test('P2 inspect: committed proof survives later commits and names the pinned ledger match', async () => {
  const { world, store } = await bootWorld();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
  assert.equal(receipt.status, 'committed');
  world.clock.advance(10);
  await commitLink(store, 2, { txRef: tx(2) });
  const result = await store.inspectAttempt(confirmedRequest(prepared));
  assert.deepEqual(result, { disposition: 'committed', ready: true });
  const out = await store.outcome({ actorId, operationId: op(1) });
  assert.equal(out.revision, receipt.revision, 'original receipt semantics unchanged');
  assert.equal(out.digest, receipt.digest);
});

test('P2 inspect: input is snapshotted before the single shared-lock acquisition', async () => {
  const world = makeWorld(), baseLock = makeLock();
  let lockCalls = 0;
  const lock = { withLock(fn) { lockCalls++; return baseLock.withLock(fn); } };
  const store = newStore(world, lock);
  await store.bootstrap();
  world.clock.advance(10);
  const prepared = await prepareLink(store, 1);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = baseLock.withLock(async () => { enter(); await gate; });
  await entered;
  const request = confirmedRequest(JSON.parse(JSON.stringify(prepared)));
  const previousLockCalls = lockCalls;
  const pending = store.inspectAttempt(request);
  request.actorId = actor2;
  request.preview.operationId = op(99);
  request.preview.command.assignedCents = 6000;
  request.confirmationDigest = 'f'.repeat(64);
  release(); await holding;
  const result = await pending;
  assert.equal(lockCalls, previousLockCalls + 1, 'exactly one lock acquisition');
  assert.deepEqual(result, { disposition: 'not-committed', ready: true },
    'the snapshot taken at entry, not the caller mutation, is inspected');
  assert.equal(stateOf(world.durable.doc).operations.length, 0, 'inspection wrote nothing');
});

// === Write admission (acquisition-bound freshness fence) ==================
// commitAdmitted is the store's trusted admission capability: the same
// single-lock, no-recovery pipeline as commitWithoutRecovery, except that
// a caller-supplied synchronous freshness witness is invoked exactly
// once — after every prewrite await and the synchronous candidate/journal
// construction, immediately before the journal write — and only its
// literal `true` admits the write. Anything else is a definite no-write
// refusal ('admission-refused') with zero durable mutations. The witness
// is never consulted on paths that produce no new candidate (original
// pinned receipt, conflict, recovery-required, preview-expired), and a
// successful admission is never re-checked while the write completes.

test('WA-S1 commitAdmitted with a fresh witness commits exactly like the no-recovery pipeline', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  let calls = 0;
  const witness = () => {
    calls++;
    assert.equal(world.durable.journal, null, 'witness runs before the journal write lands');
    return true;
  };
  const receipt = await store.commitAdmitted(confirmedRequest(prepared), witness);
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.operationId, op(1));
  assert.equal(calls, 1, 'witness invoked exactly once for the new candidate');
  assert.equal(stateOf(world.durable.doc).operations.length, 1);
  const view = await loadFromWorld(world);
  assert.equal(view.status, 'qualified');
});

for (const [name, makeWitness] of [
  ['returns false', () => () => false],
  ['throws', () => () => { throw new Error('synthetic witness failure'); }],
  ['returns a thenable', () => () => Promise.resolve(true)],
  ['returns a truthy non-true value', () => () => 1],
]) {
  test(`WA-S2 admission refusal (${name}): definite no-write, zero mutations, no poisoning`, async () => {
    const { world, store } = await bootWorld();
    const prepared = await prepareLink(store, 1);
    const snap = snapshotWorld(world);
    const counts = world.writeCounts();
    let calls = 0;
    const base = makeWitness();
    const witness = () => { calls++; return base(); };
    const result = await store.commitAdmitted(confirmedRequest(prepared), witness);
    assert.deepEqual(result, { status: 'rejected', reason: 'admission-refused' });
    assert.equal(calls, 1, 'witness consulted exactly once');
    assertWorldUnchanged(world, snap, 'admission refusal');
    world.noWritesSince(counts);
    // The refusal consumed nothing durable: the same request still commits
    // through the ordinary no-recovery capability.
    const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
    assert.equal(receipt.status, 'committed');
  });
}

test('WA-S3 a non-function witness is refused without invocation or writes', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const snap = snapshotWorld(world);
  for (const bad of [undefined, null, 'witness', 42, {}]) {
    assert.deepEqual(await store.commitAdmitted(confirmedRequest(prepared), bad),
      { status: 'rejected', reason: 'admission-refused' });
  }
  assertWorldUnchanged(world, snap, 'non-function witness');
});

test('WA-S4 original pinned receipt precedes admission: witness never consulted', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const receipt = await store.commitWithoutRecovery(confirmedRequest(prepared));
  assert.equal(receipt.status, 'committed');
  let calls = 0;
  const again = await store.commitAdmitted(confirmedRequest(prepared),
    () => { calls++; return false; });
  assert.deepEqual(again, receipt, 'the original receipt is returned read-only');
  assert.equal(calls, 0, 'no candidate is constructed for a recorded operation');
});

test('WA-S5 conflict precedence: altered input on a recorded operation conflicts before admission', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  await store.commitWithoutRecovery(confirmedRequest(prepared));
  const altered = confirmedRequest(prepared);
  altered.preview = JSON.parse(JSON.stringify(prepared.preview));
  altered.preview.command.assignedCents = 999;
  let calls = 0;
  const result = await store.commitAdmitted(altered, () => { calls++; return false; });
  assert.deepEqual(result, { status: 'conflict' });
  assert.equal(calls, 0);
});

test('WA-S6 recovery-required precedence: a resident journal refuses before admission', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const next = await prepareLink(store, 2, { txRef: tx(2) });
  world.failNext('journal.write', 'throw-landed');
  const crashed = await store.commit(confirmedRequest(prepared));
  assert.equal(crashed.status, 'unknown');
  assert.ok(world.durable.journal, 'journal is resident after the lost ack');
  const journalBefore = world.durable.journal.toString('hex');
  let calls = 0;
  const result = await store.commitAdmitted(confirmedRequest(next), () => { calls++; return true; });
  assert.deepEqual(result, { status: 'rejected', reason: 'recovery-required' });
  assert.equal(calls, 0, 'no candidate is constructed while recovery is required');
  assert.equal(world.durable.journal.toString('hex'), journalBefore, 'resident journal preserved');
});

test('WA-S7 preview expiry is decided by the contract before admission', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  world.clock.advance(C.TTL_MS + 1);
  let calls = 0;
  const result = await store.commitAdmitted(confirmedRequest(prepared), () => { calls++; return true; });
  assert.deepEqual(result, { status: 'rejected', reason: 'preview-expired' });
  assert.equal(calls, 0);
});

test('WA-S8 once admitted, a paused journal write completes without re-checking the witness', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  let enteredWrite, releaseWrite;
  const writeEntered = new Promise(resolve => { enteredWrite = resolve; });
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const originalWrite = world.journalStore.write.bind(world.journalStore);
  world.journalStore.write = async record => {
    await originalWrite(record);
    enteredWrite();
    await writeGate;
  };
  let calls = 0;
  const pending = store.commitAdmitted(confirmedRequest(prepared), () => { calls++; return true; });
  await writeEntered;
  // The admission decision is already made; nothing that changes while the
  // journal I/O completes can convert this operation into a refusal.
  releaseWrite();
  const receipt = await pending;
  assert.equal(receipt.status, 'committed');
  assert.equal(calls, 1, 'witness invoked at most once, at the pre-write moment only');
});

test('WA-S9 commitAdmitted snapshots its input at entry like the incumbent capabilities', async () => {
  const { world, store } = await bootWorld();
  const prepared = await prepareLink(store, 1);
  const input = confirmedRequest(prepared);
  const pending = store.commitAdmitted(input, () => true);
  input.preview.command.assignedCents = 999999;
  input.confirmationDigest = 'f'.repeat(64);
  const receipt = await pending;
  assert.equal(receipt.status, 'committed');
  assert.equal(stateOf(world.durable.doc).operations[0].command.assignedCents, 2500,
    'the entry snapshot, not the caller mutation, was committed');
});

test('D1 seal wins across stores and all three financial commit entry points', async () => {
 const X=require('./test-settlement-evidence-terminal-certificate');
 for(const method of ['commit','commitWithoutRecovery','commitAdmitted']){
  const w=X.makeExclusionWorld(),a=w.newStore(),b=w.newStore({wrap:true}),p=await w.prepare(b);
  assert.equal((await w.seal(a,p)).status,'certified');
  assert.notEqual((await b[method](w.input(p),()=>true)).status,'committed');assert.deepEqual(w.writes,[]);
  assert.equal(w.records().length,1);assert.notEqual((await w.newStore().commit(w.input(p))).status,'committed');
 }
});
const d1X = require('./test-settlement-evidence-terminal-certificate');
const d1Gate = () => { let resolve; const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };
test('D1 canonical domains bind authorities not wrapper objects and reject mixed modes both orders', () => {
 for(const gated of [true,false]){
  const w=d1X.makeExclusionWorld();w.newStore({gated});
  assert.doesNotThrow(()=>w.newStore({gated,wrap:true}));
  assert.throws(()=>w.newStore({gated:!gated,wrap:true}),/domain|mixed/);
  // Addendum A: alternate wrappers are bound by the SAME declared tuple.
  // A different declared namespace hiding physical aliasing is unqualified;
  // known identical surface references still cannot be rebound.
  assert.throws(()=>w.newStore({gated,domain:{ledgerNamespace:'ledger-'+'f'.repeat(32)}}),/domain|aliased/);
  for(const domain of [{serializationAuthority:'authority-'+'f'.repeat(32)},{historyAuthority:'authority-'+'f'.repeat(32)}])
    assert.throws(()=>w.newStore({gated,wrap:true,domain}),/domain|authority/);
 }
 const w=d1X.makeExclusionWorld();S.createSettlementEvidenceStore({householdId,...w.adapters,now:()=>w.time});
 assert.throws(()=>w.newStore(),/mixed/,'registered local legacy surfaces cannot silently join a gated domain');
 const v=d1X.makeExclusionWorld();v.newStore();
 assert.throws(()=>S.createSettlementEvidenceStore({householdId,...v.adapters,now:()=>v.time}),/mixed/);
});
test('D1 seal-first race holds shared serialization before competing financial landing',{timeout:5000},async()=>{
 const w=d1X.makeExclusionWorld(),a=w.newStore(),b=w.newStore({wrap:true}),p=await w.prepare(b),seen=d1Gate(),release=d1Gate();
 w.hooks.append=async perform=>{seen.resolve();await release.promise;return perform();};
 const sealing=w.seal(a,p);await seen.promise;
 let finished=false;const writing=b.commitAdmitted(w.input(p),()=>true).then(r=>{finished=true;return r;});
 try{await Promise.resolve();assert.equal(finished,false);assert.deepEqual(w.writes,[]);
  release.resolve();assert.equal((await sealing).status,'certified');assert.notEqual((await writing).status,'committed');
  assert.deepEqual(w.writes,[]);
 }finally{release.resolve();}
});
test('D1 commit-first race retains lock through pin landing and forbids a later certificate',{timeout:5000},async()=>{
 const w=d1X.makeExclusionWorld(),a=w.newStore(),b=w.newStore({wrap:true}),p=await w.prepare(b),seen=d1Gate(),release=d1Gate();
 w.hooks.journal=async perform=>{seen.resolve();await release.promise;return perform();};
 const writing=b.commitAdmitted(w.input(p),()=>true);await seen.promise;
 let finished=false;const sealing=w.seal(a,p).then(r=>{finished=true;return r;});
 try{await Promise.resolve();assert.equal(finished,false);release.resolve();
  const receipt=await writing;assert.equal(receipt.status,'committed');assert.equal((await sealing).status,'unknown');
  assert.equal(w.appends,0);assert.equal(w.records().length,0);assert.equal(w.writes.filter(x=>x==='pin').length,1);
  assert.deepEqual(await a.outcome({actorId:d1X.actorId,operationId:d1X.op(1)}),{status:'committed',operationId:d1X.op(1),revision:receipt.revision,digest:receipt.digest});
 }finally{release.resolve();}
});
test('D1 resident ambiguous journal forbids sealing without reconciliation or mutations',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
 w.hooks.journal=perform=>{perform();throw Error('synthetic lost journal acknowledgement');};
 assert.equal((await s.commitWithoutRecovery(w.input(p))).status,'unknown');delete w.hooks.journal;
 const before=w.writes.slice(),bytes=Buffer.from(w.journal);
 assert.equal((await w.seal(s,p)).status,'unknown');assert.deepEqual(w.writes,before);assert.ok(w.journal.equals(bytes));assert.equal(w.appends,0);
});
test('D1 old expired previews seal only against their complete validated immutable prefix',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s),q=await w.prepare(s,2);
 assert.equal((await s.commitWithoutRecovery(w.input(q))).status,'committed');w.writes.length=0;w.time=p.preview.expiresAt+1;
 assert.deepEqual(await s.inspectAttempt(w.input(p)),{disposition:'unresolved',ready:true},'P2 absence was not broadened');
 const bad=JSON.parse(JSON.stringify(p));bad.preview.expectedDocumentDigest='f'.repeat(64);bad.confirmationDigest=C.digest(bad.preview);
 assert.equal((await w.seal(s,bad)).status,'unknown');assert.equal(w.appends,0);
 const malformed=JSON.parse(JSON.stringify(p));malformed.preview.extra=true;malformed.confirmationDigest=C.digest(malformed.preview);
 assert.equal((await w.seal(s,malformed)).status,'unknown');assert.equal(w.appends,0);
 assert.equal((await w.seal(s,p)).status,'certified');assert.deepEqual(w.writes,[]);
 assert.deepEqual(await s.inspectAttempt(w.input(p)),{disposition:'unresolved',ready:true});
});
test('D1 missing malformed rollback and unreadable history never authorize writes or P2 readiness',async()=>{
 for(const fault of ['missing','anchor','malformed','throw','rollback']){
  const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
  if(fault==='rollback'){
   assert.equal((await w.seal(s,p)).status,'certified');w.historyBytes=d1X.encoded([],householdId,w.domain.ledgerNamespace).historyBytes;
  }else if(fault==='missing')w.historyBytes=null;
  else if(fault==='anchor')w.checkpoint=null;
  else if(fault==='malformed')w.historyBytes=Buffer.from('{}');
  else w.hooks.historyRead=()=>{throw Error('synthetic unreadable anchor');};
  const before=w.writes.slice();
  assert.equal((await s.inspectAttempt(w.input(p))).ready,false);
  assert.equal((await s.outcome({actorId:d1X.actorId,operationId:d1X.op(1)})).status,'unknown');
  for(const method of ['commit','commitWithoutRecovery','commitAdmitted'])assert.notEqual((await s[method](w.input(p),()=>true)).status,'committed');
  assert.equal((await s.reconcile()).disposition,'recovery-blocked');assert.deepEqual(w.writes,before);
  assert.equal((await w.seal(s,p)).status,'unknown');
 }
});
test('D1 bootstrap needs positively initialized empty history and never auto repairs or resets it',async()=>{
 for(const fault of ['missing','anchor','nonempty']){
  const w=d1X.makeExclusionWorld({empty:true}),s=w.newStore();
  if(fault==='missing')w.historyBytes=null;
  if(fault==='anchor')w.checkpoint=null;
  if(fault==='nonempty'){
   const v=d1X.makeExclusionWorld(),t=v.newStore();await v.seal(t,await v.prepare(t));
   Object.assign(w,d1X.encoded(v.records().map(r=>({...r,ledgerNamespace:w.domain.ledgerNamespace})),householdId,w.domain.ledgerNamespace));
  }
  assert.notEqual((await s.bootstrap()).status,'bootstrapped');assert.deepEqual(w.writes,[]);assert.equal(w.appends,0);
 }
 const w=d1X.makeExclusionWorld({empty:true}),s=w.newStore();assert.equal((await s.bootstrap()).status,'bootstrapped');
 assert.equal(w.records().length,0);assert.equal(w.appends,0);
});
test('D1 final expiry and freshness run after every asynchronous terminal qualification',async()=>{
 for(const mode of ['expiry','freshness']){
  const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);let reads=0,witnesses=0,fresh=true;
  w.hooks.historyRead=perform=>{if(++reads===2){if(mode==='expiry')w.time=p.preview.expiresAt;else fresh=false;}return perform();};
  const r=await s.commitAdmitted(w.input(p),()=>{witnesses++;return fresh;});
  assert.equal(r.reason,mode==='expiry'?'preview-expired':'admission-refused');assert.deepEqual(w.writes,[]);
  assert.equal(witnesses,mode==='expiry'?0:1);
 }
});
test('D1 seal CAS false lost and malformed acknowledgements never retry or manufacture proof',async()=>{
 for(const mode of ['false','throw-before','throw-after','malformed-after']){
  const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
  w.hooks.append=perform=>{if(mode==='false')return false;if(mode==='throw-before')throw Error('synthetic before');
   perform();if(mode==='throw-after')throw Error('synthetic lost seal acknowledgement');return {};};
  assert.equal((await w.seal(s,p)).status,'unknown');assert.equal(w.appends,1);assert.deepEqual(w.writes,[]);
  if(mode.endsWith('after')){assert.equal(w.records().length,1);assert.notEqual((await w.newStore({wrap:true}).commit(w.input(p))).status,'committed');}
  else assert.equal(w.records().length,0);
 }
});
test('D1 R3 R4 R5 and restore cannot mutate across missing history or negative coexistence',async()=>{
 for(const row of ['R3','R4','R5']){
  const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
  if(row==='R3')w.hooks.clear=()=>{throw Error('synthetic cleanup refusal');};
  if(row==='R4')w.hooks.journal=perform=>{perform();throw Error('synthetic journal lost ack');};
  if(row==='R5')w.hooks.pin=()=>false;
  await s.commitWithoutRecovery(w.input(p));delete w.hooks.clear;delete w.hooks.journal;delete w.hooks.pin;
  w.writes.length=0;
  if(row==='R5'){
   const v=d1X.makeExclusionWorld(),t=v.newStore();await v.seal(t,await v.prepare(t));
   Object.assign(w,d1X.encoded(v.records().map(r=>({...r,ledgerNamespace:w.domain.ledgerNamespace})),householdId,w.domain.ledgerNamespace));
  }else w.historyBytes=null;
  assert.equal((await s.reconcile()).disposition,'recovery-blocked',row);assert.deepEqual(w.writes,[],row);
 }
 for(const missing of [false,true]){
  const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);await w.seal(s,p);
  const history=Buffer.from(w.historyBytes),anchor=JSON.stringify(w.checkpoint);w.doc=null;
  if(missing)w.historyBytes=null;
  const result=await s.reconcile();
  assert.equal(result.disposition,missing?'recovery-blocked':'restored-pinned');
  if(missing)assert.deepEqual(w.writes,[]);else{
   assert.ok(w.historyBytes.equals(history));assert.equal(JSON.stringify(w.checkpoint),anchor);
   w.writes.length=0;assert.notEqual((await w.newStore().commit(w.input(p))).status,'committed');assert.deepEqual(w.writes,[]);
  }
 }
});
test('D1 committed-negative coexistence cannot hide behind receipts, readiness or restore',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
 const v=d1X.makeExclusionWorld(),t=v.newStore();await v.seal(t,await v.prepare(t));
 const receipt=await s.commitWithoutRecovery(w.input(p));assert.equal(receipt.status,'committed');
 Object.assign(w,d1X.encoded(v.records().map(r=>({...r,ledgerNamespace:w.domain.ledgerNamespace})),householdId,w.domain.ledgerNamespace));w.writes.length=0;
 assert.equal((await s.outcome({actorId:d1X.actorId,operationId:d1X.op(1)})).status,'unknown');
 assert.equal((await s.inspectAttempt(w.input(p))).ready,false);
 assert.notEqual((await s.commitWithoutRecovery(w.input(p))).status,'committed');
 assert.equal((await s.reconcile()).disposition,'recovery-blocked');assert.deepEqual(w.writes,[]);
 w.doc=null;assert.equal((await s.reconcile()).disposition,'recovery-blocked');assert.deepEqual(w.writes,[]);
});
test('D1 unchanged successful financial bytes receipts and pin semantics with optional gate',async()=>{
 const a=d1X.makeExclusionWorld(),b=d1X.makeExclusionWorld(),x=a.newStore(),y=b.newStore({gated:false});
 const p=await a.prepare(x),q=await b.prepare(y);
 const r=await x.commitAdmitted(a.input(p),()=>true),s=await y.commitAdmitted(b.input(q),()=>true);
 assert.equal(r.status,'committed');assert.deepEqual(r,s);assert.ok(a.doc.equals(b.doc));assert.deepEqual(a.pin,b.pin);
 assert.equal(a.records().length,0);assert.equal(a.appends,0);assert.deepEqual(a.writes,b.writes);
});
test('D1 exclusion is operation-wide across actors and generations but isolates household domains',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s),other=await w.prepare(s,1,d1X.otherActor);
 await w.seal(s,p);assert.notEqual((await s.commitWithoutRecovery(w.input(other))).status,'committed');
 assert.equal((await w.seal(s,p,2)).status,'unknown');assert.equal(w.records().length,1);
 const v=d1X.makeExclusionWorld({householdId:'household-'+'e'.repeat(32),namespace:'ledger-'+'e'.repeat(32)}),t=v.newStore();
 assert.equal((await t.commitWithoutRecovery(v.input(await v.prepare(t)))).status,'committed');assert.deepEqual(w.writes,[]);
});

test('D1 withdrawal seals bind the retract preview and preserve the original financial receipt',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),first=await w.prepare(s);
 const original=await s.commitWithoutRecovery(w.input(first));assert.equal(original.status,'committed');
 const command={version:1,kind:'retract',targetOperationId:d1X.op(1)};
 const p=await s.prepare({actorId:d1X.otherActor,operationId:d1X.op(2),command});assert.ok(p.preview);
 const before=Buffer.from(w.doc),pin=JSON.stringify(w.pin);w.writes.length=0;w.time=p.preview.expiresAt+1;
 const claim={...w.claim(p,2,'assignment-changed'),kind:'withdrawal'};
 assert.equal((await s.terminalExclusion.sealNegative(claim)).status,'certified');
 assert.equal(w.records()[0].kind,'withdrawal');assert.equal(w.records()[0].actorId,d1X.otherActor);
 assert.notEqual((await w.newStore().commitWithoutRecovery(w.input(p))).status,'committed');
 assert.ok(w.doc.equals(before));assert.equal(JSON.stringify(w.pin),pin);assert.deepEqual(w.writes,[]);
 const receipt=await s.outcome({actorId:d1X.actorId,operationId:d1X.op(1)});
 assert.deepEqual(receipt,{status:'committed',operationId:d1X.op(1),revision:original.revision,digest:original.digest});
 const fresh=await s.prepare({actorId:d1X.otherActor,operationId:d1X.op(3),command});
 assert.equal((await s.commitWithoutRecovery(w.input(fresh))).status,'committed','new explicit operation is independent');
 assert.deepEqual(JSON.parse(w.doc).operations.map(o=>o.command.kind),['link','retract']);
});

test('D1 Addendum A C1 canonical household namespace rejects conflicting authorities through fresh wrappers',()=>{
 const w=d1X.makeExclusionWorld();w.newStore({wrap:true});
 const v=d1X.makeExclusionWorld({namespace:w.domain.ledgerNamespace});
 assert.throws(()=>v.newStore({wrap:true}),/domain|authority/);
});
test('D1 Addendum A C3 sealed-operation journal blocks R4 preserving journal temp and evidence',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
 w.hooks.journal=perform=>{perform();throw Error('synthetic journal acknowledgement lost');};
 await s.commitWithoutRecovery(w.input(p));delete w.hooks.journal;
 const v=d1X.makeExclusionWorld(),t=v.newStore();await v.seal(t,await v.prepare(t));
 const records=v.records().map(r=>({...r,ledgerNamespace:w.domain.ledgerNamespace}));
 Object.assign(w,d1X.encoded(records,householdId,w.domain.ledgerNamespace));
 w.temp=Buffer.from('synthetic retained stage');const journal=Buffer.from(w.journal),temp=Buffer.from(w.temp),doc=Buffer.from(w.doc);
 w.writes.length=0;const report=await s.reconcile();
 assert.equal(report.row,'R4');assert.equal(report.disposition,'recovery-blocked');
 assert.deepEqual(w.writes,[]);assert.ok(w.journal.equals(journal));assert.ok(w.temp.equals(temp));assert.ok(w.doc.equals(doc));
});

test('D1 Addendum A C5 identical explicit reseal returns the stored complete decision without append',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);
 const first=await w.seal(s,p);assert.equal(first.status,'certified');
 const bytes=Buffer.from(w.historyBytes),checkpoint=JSON.stringify(w.checkpoint);w.time+=C.TTL_MS;
 const second=await w.seal(w.newStore({wrap:true}),p);assert.deepEqual(second,first);
 assert.equal(w.appends,1);assert.ok(w.historyBytes.equals(bytes));assert.equal(JSON.stringify(w.checkpoint),checkpoint);
 for(const claim of [{...w.claim(p),generation:d1X.generation(2)},{...w.claim(p),reason:'selection-changed'},
  {...w.claim(p),actorId:d1X.otherActor},{...w.claim(p),confirmationDigest:'f'.repeat(64)}]){
   assert.equal((await s.terminalExclusion.sealNegative(claim)).status,'unknown');
 }
 assert.equal(w.appends,1);assert.deepEqual(w.writes,[]);
});
test('D1 Addendum A C6 history outage blocks unrelated operations and every recovery mutation',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s);await w.seal(s,p);
 const q=await w.prepare(s,2);assert.ok(q.preview);w.hooks.historyRead=()=>{throw Error('synthetic authority outage');};
 for(const method of ['commit','commitWithoutRecovery','commitAdmitted']){
  const result=await s[method](w.input(q),()=>true);
  assert.ok(['unavailable','unknown','rejected','conflict'].includes(result.status),'no proof, actionable admission or false commitment');
 }
 assert.equal((await s.reconcile()).disposition,'recovery-blocked');
 assert.equal((await s.inspectAttempt(w.input(q))).ready,false);
 assert.equal((await s.outcome({actorId:d1X.actorId,operationId:d1X.op(2)})).status,'unknown');
 assert.deepEqual(w.writes,[]);assert.equal(w.appends,1);
 delete w.hooks.historyRead;
 assert.equal((await s.commitWithoutRecovery(w.input(q))).status,'committed','fresh read recovery requires no history repair');
});
test('D1 Addendum A C3 unrelated R4 remains incumbent explicit reconciliation after qualification',async()=>{
 const w=d1X.makeExclusionWorld(),s=w.newStore(),p=await w.prepare(s,1),q=await w.prepare(s,2);
 await w.seal(s,p);
 w.hooks.journal=perform=>{perform();throw Error('synthetic unlanded journal');};
 assert.equal((await s.commitWithoutRecovery(w.input(q))).status,'unknown');delete w.hooks.journal;
 w.writes.length=0;const report=await s.reconcile();
 assert.equal(report.row,'R4');assert.equal(report.disposition,'not-committed');
 assert.deepEqual(w.writes,['clear','discard']);assert.equal(w.journal,null);assert.equal(w.records().length,1);
});

test('D1 Addendum B known storage and lock overlap rejects mixed mode both orders before side effects',()=>{
 for(const gated of [true,false])for(const shared of ['documentStore','journalStore','pinStore','lock']){
  const a=d1X.makeExclusionWorld(),b=d1X.makeExclusionWorld();a.newStore({gated});
  const adapters={...b.adapters,[shared]:a.adapters[shared]};
  assert.throws(()=>S.createSettlementEvidenceStore({householdId,...adapters,now:()=>b.time,
   exclusionDomain:b.domain,...(gated?{}:{terminalHistory:b.terminalHistory})}),/mixed|domain/);
  assert.deepEqual(a.writes,[]);assert.deepEqual(b.writes,[]);assert.equal(a.reads+b.reads,0);
 }
 // Undeclared legacy stores still register all known domain-bound identities.
 for(const shared of ['documentStore','journalStore','pinStore','lock']){
  const a=d1X.makeExclusionWorld(),b=d1X.makeExclusionWorld();
  S.createSettlementEvidenceStore({householdId,...a.adapters,now:()=>a.time});
  assert.throws(()=>S.createSettlementEvidenceStore({householdId,...b.adapters,[shared]:a.adapters[shared],
    now:()=>b.time,exclusionDomain:b.domain,terminalHistory:b.terminalHistory}),/mixed|domain/);
 }
 const a=d1X.makeExclusionWorld(),b=d1X.makeExclusionWorld(),clock=()=>a.time;
 assert.doesNotThrow(()=>S.createSettlementEvidenceStore({householdId,...a.adapters,now:clock}));
 assert.doesNotThrow(()=>S.createSettlementEvidenceStore({householdId,...b.adapters,now:clock}),'separate legacy storage sharing only a clock remains valid');
});
test('D1 Addendum B declared serialization authority survives alternate lock wrappers and forbids mixed domains',()=>{
 for(const gated of [true,false]){
  const a=d1X.makeExclusionWorld(),b=d1X.makeExclusionWorld();a.newStore({gated});
  const lock={withLock:fn=>a.adapters.lock.withLock(fn)};
  assert.throws(()=>S.createSettlementEvidenceStore({householdId,...b.adapters,lock,now:()=>b.time,
   exclusionDomain:{...b.domain,serializationAuthority:a.domain.serializationAuthority},
   ...(gated?{}:{terminalHistory:b.terminalHistory})}),/mixed|domain|authority/);
  assert.deepEqual(a.writes,[]);assert.deepEqual(b.writes,[]);assert.equal(a.reads+b.reads,0);
 }
});
test('B4B receipt: the commit receipt stays the exact 5-field receipt (no requestDigest)',async()=>{
 const w=makeWorld(),s=newStore(w);await s.bootstrap();
 const receipt=await commitLink(s,1);
 // The commit return IS receiptForOperation's output. Its shape is shared
 // and strictly constructed: exactly five keys with these values, and the
 // recorded requestDigest never joins it (it lives only in the private
 // recovery bundle).
 assert.deepEqual(Object.keys(receipt).sort(),['actorId','digest','operationId','revision','status']);
 assert.equal(receipt.status,'committed');assert.equal(receipt.operationId,op(1));
 assert.equal(receipt.actorId,actorId);assert.equal(receipt.revision,1);
 assert.match(receipt.digest,/^[a-f0-9]{64}$/);
 assert.equal('requestDigest' in receipt,false);
 // The store outcome projection agrees on revision and prefix digest.
 const viaOutcome=await s.outcome({actorId,operationId:op(1)});
 assert.equal(viaOutcome.revision,receipt.revision);
 assert.equal(viaOutcome.digest,receipt.digest);
});

test('B4N store: recoveryRead negative bundle carries the sealed certificate confirmationDigest',async()=>{
 const w=d1X.makeExclusionWorld();
 const s=S.createSettlementEvidenceStore({householdId,...w.adapters,now:()=>w.time,
  exclusionDomain:w.domain,terminalHistory:w.terminalHistory,recoveryRead:true});
 assert.equal(typeof s.recoveryRead,'function');
 const p=await w.prepare(s);
 assert.equal((await w.seal(s,p)).status,'certified');
 const cert=w.records()[0];
 // Independent computation: the certificate's recorded digest is the
 // contract digest of the sealed preview — exactly what seal validation
 // required (req.confirmationDigest === C.digest(preview)).
 assert.equal(cert.confirmationDigest,C.digest(p.preview));
 assert.equal(cert.confirmationDigest,p.confirmationDigest);
 const bundle=await s.recoveryRead({operationId:d1X.op(1),generation:d1X.generation(1)});
 assert.deepEqual(bundle,{status:'not-applied',operationId:d1X.op(1),generation:d1X.generation(1),
  confirmationDigest:cert.confirmationDigest});
 assert.deepEqual(Object.keys(bundle).sort(),['confirmationDigest','generation','operationId','status']);
});
test('B4N store: certificate digest missing or malformed -> recoveryRead unknown',async()=>{
 const w=d1X.makeExclusionWorld();
 const s=S.createSettlementEvidenceStore({householdId,...w.adapters,now:()=>w.time,
  exclusionDomain:w.domain,terminalHistory:w.terminalHistory,recoveryRead:true});
 const p=await w.prepare(s);assert.equal((await w.seal(s,p)).status,'certified');
 // Control: the genuine certificate proves the exact negative bundle.
 assert.equal((await s.recoveryRead({operationId:d1X.op(1),generation:d1X.generation(1)})).status,'not-applied');
 // Rewriting the durable history without a valid certificate digest —
 // container encoding kept valid — never proves. Shipped history
 // qualification refuses such a record at the gate, and the recovery
 // branch's own hash check keeps the branch fail-closed on its own terms.
 const genuine=w.records();
 const missing=genuine.map(r=>{const c={...r};delete c.confirmationDigest;return c;});
 Object.assign(w,d1X.encoded(missing,householdId,w.domain.ledgerNamespace));
 assert.deepEqual(await s.recoveryRead({operationId:d1X.op(1),generation:d1X.generation(1)}),
  {status:'unknown',operationId:d1X.op(1)});
 const malformed=genuine.map(r=>({...r,confirmationDigest:'not-a-hash'}));
 Object.assign(w,d1X.encoded(malformed,householdId,w.domain.ledgerNamespace));
 assert.deepEqual(await s.recoveryRead({operationId:d1X.op(1),generation:d1X.generation(1)}),
  {status:'unknown',operationId:d1X.op(1)});
});
